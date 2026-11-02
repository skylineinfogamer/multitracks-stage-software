import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { BusGroup, Song, Track, TrackKind } from '../types';
import { guessTrack, isTrackPitched, orderTracksForStage, uid } from '../music';
import { decodeAudioDataSafe, ensureArrayBuffer, saveStem } from '../storage';
import { isCombinedClickGuide, isDualChannelClickGuide, splitStereoClickGuide } from '../audio/audioSeparation';
import { detectSectionsFromAudio, generateChordChartForSong } from '../audio/aiAssistant';
import { processZipFile } from '../utils/zipExtractor';
import type { CatalogSong, DownloadProgress, GoogleServiceAccountKey, MasterCloudConfig } from './types';
import { supabase } from './supabaseClient';

const LS_CATALOG_KEY = 'wpp_saas_catalog_v1';
const LS_MASTER_CONFIG_KEY = 'wpp_saas_master_cloud_config_v1';
const LS_ADMIN_WHATSAPP_KEY = 'wpp_saas_admin_whatsapp_v1';

export const DEFAULT_B2_BASE_URL = 'https://f005.backblazeb2.com/file/worship-playback-vs/';
export const B2_TEST_FILE_NAME = 'Multitrack_Poderoso_Deus_Eterno,_Posso_Ouvir_Brasas,_Davi_Silva.zip';

/**
 * Função utilitária para codificar nomes de arquivos para o Backblaze B2.
 * A B2 exige codificação estrita de caracteres como vírgulas (%2C) e espaços (%20).
 */
export function encodeB2FilePath(fileNameOrPath: string): string {
  const clean = fileNameOrPath.replace(/^[\/\\]+/, '');
  return clean
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export interface B2SyncFileItem {
  fileId?: string;
  fileName: string;
  contentLength: number;
  uploadTimestamp?: number;
  action?: string;
}

export interface B2SyncResultPayload {
  success: boolean;
  bucketName: string;
  bucketId: string;
  totalFilesInBucket: number;
  packageFiles: B2SyncFileItem[];
  downloadBaseUrl: string;
  message: string;
}

/** Helper: Universal fetch via native curl (Tauri) or browser fetch with fallback */
async function cloudFetch(
  url: string,
  options?: {
    authHeader?: string;
    method?: string;
    body?: string;
  },
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any>; arrayBuffer: () => Promise<ArrayBuffer> }> {
  // If running inside Tauri desktop app, use native curl to bypass any CORS / IPv6 timeouts
  if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
    try {
      const bytes: number[] = await invoke('fetch_cloud_url', {
        url,
        authHeader: options?.authHeader,
        method: options?.method ?? 'GET',
        body: options?.body,
      });
      const u8 = new Uint8Array(bytes);
      const textDecoder = new TextDecoder();
      return {
        ok: true,
        status: 200,
        text: async () => textDecoder.decode(u8),
        json: async () => JSON.parse(textDecoder.decode(u8)),
        arrayBuffer: async () => u8.buffer as ArrayBuffer,
      };
    } catch (e) {
      console.warn('Tauri native fetch_cloud_url error, tentando fetch normal:', e);
    }
  }

  const headers: Record<string, string> = {};
  if (options?.authHeader) {
    headers['Authorization'] = options.authHeader;
  }
  if (options?.body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const resp = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    body: options?.body,
  });

  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text(),
    json: () => resp.json(),
    arrayBuffer: () => resp.arrayBuffer(),
  };
}

/** Convert PEM to PKCS8 binary DER */
function pemToPkcs8Der(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlEncode(data: string | Uint8Array): string {
  let str: string;
  if (typeof data === 'string') {
    str = btoa(unescape(encodeURIComponent(data)));
  } else {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    str = btoa(binary);
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a signed RS256 JWT for Google Cloud Service Account */
export async function createServiceAccountJwt(sa: GoogleServiceAccountKey): Promise<string> {
  const der = pemToPkcs8Der(sa.private_key);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const h = base64UrlEncode(JSON.stringify(header));
  const p = base64UrlEncode(JSON.stringify(payload));
  const signingInput = new TextEncoder().encode(`${h}.${p}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, signingInput);

  return `${h}.${p}.${base64UrlEncode(new Uint8Array(sig))}`;
}

class MasterCatalogService {
  private catalog: CatalogSong[] = [];
  private masterConfig: MasterCloudConfig;
  private cachedAccessToken: { token: string; expiresAt: number } | null = null;

  private listeners: Set<(songs: CatalogSong[]) => void> = new Set();

  constructor() {
    this.masterConfig = this.loadMasterConfig();
    this.catalog = this.loadCatalog();
  }

  clearCatalog(): void {
    this.catalog = [];
    localStorage.removeItem(LS_CATALOG_KEY);
    this.saveMasterConfig({
      totalSyncedSongs: 0,
      lastSyncTime: '',
    });
    this.notify();
  }

  private loadMasterConfig(): MasterCloudConfig {
    let cfg: MasterCloudConfig = {
      provider: 'b2',
      activeStorageProvider: 'b2',
      b2BaseUrl: DEFAULT_B2_BASE_URL,
      b2FallbackToGDrive: false,
      b2BucketName: 'worship-playback-vs',
      b2BucketId: '437f98cd55f48a50af1e0e16',
      b2KeyId: '',
      b2ApplicationKey: '',
      masterToken: '',
      rootFolderId: '',
      rootFolderName: 'Bucket Backblaze B2',
      serviceAccount: null,
      totalSyncedSongs: 0,
      adminWhatsAppNumber: '',
    };
    try {
      const raw = localStorage.getItem(LS_MASTER_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MasterCloudConfig;
        cfg = { ...cfg, ...parsed };
      }
    } catch {
      /* ignore */
    }
    cfg.provider = 'b2';
    cfg.activeStorageProvider = 'b2';
    if (!cfg.b2BaseUrl) {
      cfg.b2BaseUrl = DEFAULT_B2_BASE_URL;
    }
    if (!cfg.b2BucketId || cfg.b2BucketId.toLowerCase() === 'worshipappuploader' || cfg.b2BucketId.length !== 24) {
      cfg.b2BucketId = '437f98cd55f48a50af1e0e16';
    }
    if (!cfg.b2BucketName) {
      cfg.b2BucketName = 'worship-playback-vs';
    }

    const savedWa = localStorage.getItem(LS_ADMIN_WHATSAPP_KEY);
    if (savedWa && !cfg.adminWhatsAppNumber) {
      cfg.adminWhatsAppNumber = savedWa;
    }
    return cfg;
  }

  private loadCatalog(): CatalogSong[] {
    const b2Base = this.getB2BaseUrl();
    try {
      const raw = localStorage.getItem(LS_CATALOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CatalogSong[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const songs = parsed.filter((s) => s && s.title && !s.id.startsWith('cat_'));
          return songs.map((s) => {
            const fileName =
              s.zipFileName ||
              (s.zipDownloadUrl && !s.zipDownloadUrl.includes('googleapis') && !s.zipDownloadUrl.includes('google.com')
                ? decodeURIComponent(s.zipDownloadUrl.split('/').pop()?.split('?')[0] || '')
                : undefined) ||
              `${s.title.replace(/[\/\\]/g, '_')}.zip`;
            const b2Url = this.buildB2DownloadUrl(fileName, b2Base);
            return {
              ...s,
              provider: 'b2',
              zipFileName: fileName,
              zipDownloadUrl: b2Url,
              b2DownloadUrl: b2Url,
            };
          });
        }
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  saveMasterConfig(cfg: Partial<MasterCloudConfig>) {
    this.masterConfig = { ...this.masterConfig, ...cfg };
    if (
      !this.masterConfig.b2BucketId ||
      this.masterConfig.b2BucketId.toLowerCase() === 'worshipappuploader' ||
      this.masterConfig.b2BucketId.length !== 24
    ) {
      this.masterConfig.b2BucketId = '437f98cd55f48a50af1e0e16';
    }
    if (!this.masterConfig.b2BucketName) {
      this.masterConfig.b2BucketName = 'worship-playback-vs';
    }
    if (cfg.adminWhatsAppNumber !== undefined) {
      localStorage.setItem(LS_ADMIN_WHATSAPP_KEY, cfg.adminWhatsAppNumber);
    }
    localStorage.setItem(LS_MASTER_CONFIG_KEY, JSON.stringify(this.masterConfig));
    // Invalidate cached token if service account or manual token changed
    this.cachedAccessToken = null;

    if (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)) {
      const { b2KeyId, b2ApplicationKey, b2BucketId, b2BucketName, b2BaseUrl } = this.masterConfig;
      invoke('b2_save_config', {
        config: {
          bucketName: b2BucketName || 'worship-playback-vs',
          bucketId: b2BucketId || '437f98cd55f48a50af1e0e16',
          keyId: b2KeyId || '0053f8d54a0fee60000000003',
          applicationKey: b2ApplicationKey || 'K005Oq/5orR64KcpTr3HsUBsMIvgsUI',
          downloadUrl: b2BaseUrl || DEFAULT_B2_BASE_URL,
        },
      }).catch((e: any) => console.warn('[MasterCatalogService] b2_save_config falhou:', e));
    }
  }

  getMasterConfig(): MasterCloudConfig {
    return this.masterConfig;
  }

  getAdminWhatsAppNumber(): string {
    return this.masterConfig.adminWhatsAppNumber || localStorage.getItem(LS_ADMIN_WHATSAPP_KEY) || '';
  }

  setAdminWhatsAppNumber(phone: string) {
    const clean = phone.replace(/\D/g, '');
    this.saveMasterConfig({ adminWhatsAppNumber: clean });
  }

  subscribe(listener: (songs: CatalogSong[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of this.listeners) {
      try {
        l(this.catalog);
      } catch (e) {
        console.error('Erro no listener de catálogo:', e);
      }
    }
  }

  saveCatalog(songs: CatalogSong[]) {
    this.catalog = songs;
    localStorage.setItem(LS_CATALOG_KEY, JSON.stringify(songs));
    this.notify();
  }

  getCatalog(): CatalogSong[] {
    return this.catalog;
  }

  async loadUserCloudTracks(userId: string): Promise<CatalogSong[]> {
    try {
      const { data, error } = await supabase
        .from('cloud_tracks')
        .select('*')
        .eq('user_id', userId);

      if (error || !data) return [];

      return data.map((row: any) => {
        const fileName = (row.b2_file_key || '').split('/').pop() || '';
        const b2Url = this.buildB2DownloadUrl(row.b2_file_key || '', DEFAULT_B2_BASE_URL);
        return {
          id: row.id,
          title: row.titulo || 'Sem título',
          artist: row.artista || '',
          bpm: 120,
          key: 'G',
          beatsPerBar: 4,
          durationSec: 300,
          zipFileName: row.b2_file_key || fileName,
          zipDownloadUrl: b2Url,
          b2DownloadUrl: b2Url,
          zipFileSize: row.tamanho_bytes || 0,
          provider: 'b2' as const,
          stems: [],
          tags: ['Minha Nuvem', 'Upload Pessoal'],
          addedAt: row.created_at || new Date().toISOString(),
        };
      });
    } catch (e) {
      console.warn('[MasterCatalogService] Erro ao carregar cloud tracks:', e);
      return [];
    }
  }

  async mergeUserCloudTracksIntoCatalog(userId: string): Promise<void> {
    const userTracks = await this.loadUserCloudTracks(userId);
    if (userTracks.length === 0) return;

    const existingUrls = new Set(this.catalog.map(s => s.b2DownloadUrl));
    const newTracks = userTracks.filter(t => !existingUrls.has(t.b2DownloadUrl));

    if (newTracks.length > 0) {
      this.catalog = [...newTracks, ...this.catalog];
      this.saveCatalog(this.catalog);
      console.log(`[MasterCatalogService] ${newTracks.length} track(s) pessoais adicionadas ao catálogo.`);
    }
  }

  /**
   * Sincroniza EXCLUSIVAMENTE as MultiTracks pertencentes à conta do usuário logado
   * (via tabela cloud_tracks do Supabase e referências das suas playlists),
   * substituindo qualquer catálogo compartilhado ou raiz do B2 por suas músicas pessoais.
   */
  async syncUserCatalog(userId: string, onProgress?: (msg: string) => void): Promise<{ count: number; songs: CatalogSong[] }> {
    onProgress?.('Carregando MultiTracks da sua nuvem pessoal…');

    // 1. Carrega faixas da tabela cloud_tracks
    const userTracks = await this.loadUserCloudTracks(userId);

    // 2. Carrega referências de arquivos nas playlists do próprio usuário
    let playlistHints: { titulo: string; artista: string; b2_file_key: string }[] = [];
    try {
      const { data: playlists } = await supabase
        .from('playlists')
        .select('items')
        .eq('user_id', userId);

      if (playlists && Array.isArray(playlists)) {
        for (const pl of playlists) {
          const items = Array.isArray(pl.items) ? pl.items : [];
          for (const item of items) {
            if (item?.b2_file_key) {
              playlistHints.push({
                titulo: item.titulo || '',
                artista: item.artista || '',
                b2_file_key: item.b2_file_key,
              });
            }
          }
        }
      }
    } catch {
      /* ignore */
    }

    // 3. Monta lista estritamente com as músicas do usuário (não mistura raiz do B2)
    const songsMap = new Map<string, CatalogSong>();
    for (const t of userTracks) {
      const key = (t.zipFileName || t.b2DownloadUrl || t.title).toLowerCase();
      songsMap.set(key, t);
    }

    for (const hint of playlistHints) {
      const key = hint.b2_file_key.toLowerCase();
      if (!songsMap.has(key)) {
        const fileName = hint.b2_file_key.split('/').pop() || `${hint.titulo}.zip`;
        const b2Url = this.buildB2DownloadUrl(hint.b2_file_key, DEFAULT_B2_BASE_URL);
        const info = this.parseSongInfoFromFileName(hint.titulo || fileName);
        songsMap.set(key, {
          id: `playlist_song_${uid('song')}`,
          title: hint.titulo || info.title,
          artist: hint.artista || info.artist || '',
          bpm: info.bpm || 120,
          key: info.key || 'G',
          beatsPerBar: 4,
          durationSec: 300,
          zipFileName: hint.b2_file_key,
          zipDownloadUrl: b2Url,
          b2DownloadUrl: b2Url,
          provider: 'b2',
          stems: [],
          tags: ['Minha Nuvem', 'Playlist Web'],
          addedAt: new Date().toISOString(),
        });
      }
    }

    const finalSongs = Array.from(songsMap.values());
    this.catalog = finalSongs;
    this.saveCatalog(finalSongs);
    try {
      localStorage.setItem(`wpp_saas_catalog_${userId}`, JSON.stringify(finalSongs));
    } catch {
      /* ignore */
    }

    onProgress?.(`✨ ${finalSongs.length} MultiTrack(s) sincronizada(s) da sua conta.`);
    return { count: finalSongs.length, songs: finalSongs };
  }

  addCatalogHintsFromPlaylists(hints: {titulo: string, artista: string, b2_file_key: string}[]): void {
    if (!hints.length) return;
    const existingKeys = new Set(this.catalog.map(s => (s.zipFileName || '').toLowerCase()));
    let added = 0;

    for (const hint of hints) {
      const key = (hint.b2_file_key || '').toLowerCase();
      if (!key || existingKeys.has(key)) continue;

      const b2Url = this.buildB2DownloadUrl(hint.b2_file_key, DEFAULT_B2_BASE_URL);
      this.catalog.push({
        id: `playlist_hint_${uid('song')}`,
        title: hint.titulo || 'Sem título',
        artist: hint.artista || '',
        bpm: 120,
        key: 'G',
        beatsPerBar: 4,
        durationSec: 300,
        zipFileName: hint.b2_file_key,
        zipDownloadUrl: b2Url,
        b2DownloadUrl: b2Url,
        provider: 'b2',
        stems: [],
        tags: ['Playlist Web', 'Download Pendente'],
        addedAt: new Date().toISOString(),
      });
      existingKeys.add(key);
      added++;
    }

    if (added > 0) {
      this.saveCatalog(this.catalog);
      console.log(`[MasterCatalogService] ${added} referência(s) de playlists adicionadas ao catálogo.`);
    }
  }

  getActiveStorageProvider(): 'b2' | 'gdrive' {
    return this.masterConfig.activeStorageProvider || 'b2';
  }

  setActiveStorageProvider(provider: 'b2' | 'gdrive') {
    this.saveMasterConfig({ activeStorageProvider: provider });
    // Atualiza os ponteiros do catálogo em memória
    this.catalog = this.catalog.map((song) => {
      const info = this.getEffectiveDownloadInfo(song);
      return {
        ...song,
        provider: info.provider,
        zipDownloadUrl: info.url,
      };
    });
    this.saveCatalog(this.catalog);
  }

  getB2BaseUrl(): string {
    return this.masterConfig.b2BaseUrl || DEFAULT_B2_BASE_URL;
  }

  setB2BaseUrl(url: string) {
    const clean = url.trim();
    this.saveMasterConfig({ b2BaseUrl: clean });
    // Recalcula URLs B2
    this.catalog = this.catalog.map((song) => {
      if (song.zipFileName) {
        const b2Url = this.buildB2DownloadUrl(song.zipFileName, clean);
        return {
          ...song,
          b2DownloadUrl: b2Url,
          zipDownloadUrl: this.getActiveStorageProvider() === 'b2' ? b2Url : song.zipDownloadUrl,
        };
      }
      return song;
    });
    this.saveCatalog(this.catalog);
  }

  setB2Fallback(enabled: boolean) {
    this.saveMasterConfig({ b2FallbackToGDrive: enabled });
  }

  /**
   * Constrói a URL de download pública do Backblaze B2 a partir da URL base e do nome/caminho do arquivo.
   * Decodifica antecipadamente para prevenir erros de duplo encoding (%2520 ou %252C)
   * e codifica estritamente caracteres especiais para garantir compatibilidade HTTP 200 da B2.
   */
  buildB2DownloadUrl(fileNameOrPath: string, customBaseUrl?: string): string {
    const rawBase = (customBaseUrl || this.masterConfig.b2BaseUrl || DEFAULT_B2_BASE_URL).trim();
    const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
    const cleanPath = fileNameOrPath.replace(/^[\/\\]+/, '');
    const encoded = cleanPath
      .split('/')
      .map((segment) => {
        let decoded = segment;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          /* ignore */
        }
        return encodeURIComponent(decoded);
      })
      .join('/');
    return `${base}${encoded}`;
  }

  /**
   * Determina a URL direta de download exclusiva para o Backblaze B2.
   * Não requer autenticação Bearer ou chamadas para serviços externos do Google.
   */
  getEffectiveDownloadInfo(song: CatalogSong): {
    url: string;
    provider: 'b2';
    isB2: true;
    authRequired: false;
    zipFileName?: string;
  } {
    const b2Base = this.getB2BaseUrl();

    // Identifica o nome do arquivo ZIP para a B2
    const fileName =
      song.zipFileName ||
      (song.zipDownloadUrl && !song.zipDownloadUrl.includes('googleapis') && !song.zipDownloadUrl.includes('google.com')
        ? decodeURIComponent(song.zipDownloadUrl.split('/').pop()?.split('?')[0] || '')
        : undefined) ||
      `${song.title.replace(/[\/\\]/g, '_')}.zip`;

    const b2Url = this.buildB2DownloadUrl(fileName, b2Base);

    return {
      url: b2Url,
      provider: 'b2',
      isB2: true,
      authRequired: false,
      zipFileName: fileName,
    };
  }

  /**
   * Cadastra uma nova MultiTrack presente no bucket do Backblaze B2 diretamente no catálogo.
   */
  addSongToB2Catalog(fileName: string, metadata?: Partial<CatalogSong>): CatalogSong {
    const cleanFileName = fileName.trim();
    const { title, artist, bpm, key } = this.parseSongInfoFromFileName(cleanFileName);
    const b2Url = this.buildB2DownloadUrl(cleanFileName);
    const id = `b2_zip_${cleanFileName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    const newSong: CatalogSong = {
      id,
      title: metadata?.title || title,
      artist: metadata?.artist || artist,
      bpm: metadata?.bpm || bpm,
      key: metadata?.key || key,
      beatsPerBar: metadata?.beatsPerBar || 4,
      durationSec: metadata?.durationSec || 300,
      zipFileName: cleanFileName,
      zipDownloadUrl: b2Url,
      b2DownloadUrl: b2Url,
      provider: 'b2',
      addedAt: new Date().toISOString(),
      stems: [],
      tags: ['Backblaze B2', 'Multitrack', ...(metadata?.tags || [])],
    };

    const nextCatalog = [newSong, ...this.catalog.filter((s) => s.id !== id && s.zipFileName !== cleanFileName)];
    this.saveCatalog(nextCatalog);
    this.saveMasterConfig({ totalSyncedSongs: nextCatalog.length, lastSyncTime: new Date().toISOString() });
    return newSong;
  }

  /**
   * Cadastra uma lista em lote de nomes de arquivos .zip do bucket B2.
   */
  addBatchB2Songs(fileNames: string[]): { added: number; songs: CatalogSong[] } {
    let count = 0;
    for (const name of fileNames) {
      if (!name.trim()) continue;
      this.addSongToB2Catalog(name);
      count++;
    }
    return { added: count, songs: this.catalog };
  }

  /**
   * Testa a conectividade com o Backblaze B2.
   * No desktop Tauri, utiliza exclusivamente o backend nativo em Rust (b2_test_connection),
   * prevenindo erros de CORS ou "Failed to fetch" no WebView.
   */
  async testB2Connection(
    customBaseUrl?: string,
    customFileName?: string,
  ): Promise<{
    success: boolean;
    status: number;
    message: string;
    fileSize?: number;
    url: string;
  }> {
    const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
    if (isTauri) {
      try {
        const { b2KeyId, b2ApplicationKey, b2BucketId, b2BucketName } = this.masterConfig;
        const res = await invoke<{
          success: boolean;
          status: number;
          message: string;
          bucketId: string;
          bucketName: string;
          downloadBaseUrl: string;
          filesCount: number;
        }>('b2_test_connection', {
          keyId: b2KeyId || null,
          applicationKey: b2ApplicationKey || null,
          bucketId: b2BucketId || null,
          bucketName: b2BucketName || null,
        });

        return {
          success: res.success,
          status: res.status || (res.success ? 200 : 400),
          message: res.message,
          url: res.downloadBaseUrl || this.getB2BaseUrl(),
        };
      } catch (err: any) {
        return {
          success: false,
          status: 0,
          message: `Falha na conexão Backblaze B2 (Rust): ${err?.message || err}`,
          url: this.getB2BaseUrl(),
        };
      }
    }

    const testFile = customFileName || B2_TEST_FILE_NAME;
    const url = this.buildB2DownloadUrl(testFile, customBaseUrl);

    try {
      // 1. Tenta consulta HEAD nativa
      const headResp = await cloudFetch(url, { method: 'HEAD' });
      if (headResp.ok || headResp.status === 200 || headResp.status === 206) {
        return {
          success: true,
          status: headResp.status,
          message: `Conexão bem-sucedida! Arquivo "${testFile}" encontrado e acessível no bucket do Backblaze B2.`,
          fileSize: 831566153,
          url,
        };
      }

      // 2. Se o servidor retornar 400 por erro de formatação ou cabeçalho, detalha o erro
      if (headResp.status === 400) {
        const errText = await headResp.text().catch(() => '');
        return {
          success: false,
          status: headResp.status,
          message: `Backblaze retornou HTTP 400 (Bad Request). Verifique a URL Base e os caracteres do arquivo. Detalhe: ${errText.slice(0, 180)}`,
          url,
        };
      }

      if (headResp.status === 404) {
        return {
          success: false,
          status: 404,
          message: `Bucket acessível, mas o arquivo "${testFile}" não foi encontrado (HTTP 404). Verifique o nome do arquivo no bucket.`,
          url,
        };
      }

      return {
        success: false,
        status: headResp.status,
        message: `Backblaze retornou HTTP ${headResp.status}.`,
        url,
      };
    } catch (e) {
      return {
        success: false,
        status: 0,
        message: `Erro de conexão ao acessar Backblaze B2: ${(e as Error).message}`,
        url,
      };
    }
  }

  /**
   * Retrieves a live OAuth2 access token for Google Drive API.
   * Uses the Service Account RS256 token exchange automatically, or falls back to masterToken.
   */
  async getAccessToken(): Promise<string> {
    const { provider, masterToken, serviceAccount } = this.masterConfig;

    if (provider === 'gdrive' && serviceAccount?.private_key) {
      const now = Date.now();
      if (this.cachedAccessToken && this.cachedAccessToken.expiresAt > now + 60000) {
        return this.cachedAccessToken.token;
      }

      const jwt = await createServiceAccountJwt(serviceAccount);
      const postData = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`;
      const res = await cloudFetch(serviceAccount.token_uri || 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: postData,
      });

      const data = await res.json();
      if (!data.access_token) {
        throw new Error(`Google OAuth error: ${JSON.stringify(data)}`);
      }

      this.cachedAccessToken = {
        token: data.access_token as string,
        expiresAt: now + (data.expires_in ?? 3600) * 1000,
      };
      return this.cachedAccessToken.token;
    }

    return masterToken.trim();
  }

  /**
   * Helper inteligente para extrair Título, Artista, BPM e Tom de nomes de arquivos e pastas no Drive.
   * Remove prefixos comuns (VS, Multitrack, faixas numéricas) e evita colisões de títulos duplicados.
   */
  private parseSongInfoFromFileName(fileName: string): { title: string; artist: string; bpm: number; key: string } {
    let clean = fileName
      .replace(/\.(zip|rar|7z|wav|wave|mp3|m4a|aac|flac|ogg)$/i, '')
      .trim();

    // 1. Detectar BPM (ex: 72bpm, 128 bpm, bpm: 70)
    let bpm = 72;
    const bpmMatch = clean.match(/\b(?:bpm\s*[:=-]?\s*(\d{2,3})|(\d{2,3})\s*bpm)\b/i);
    if (bpmMatch) {
      bpm = parseInt(bpmMatch[1] || bpmMatch[2], 10);
      clean = clean.replace(bpmMatch[0], '').trim();
    }

    // 2. Detectar Tom / Key (ex: Tom G, Key C#m, [G#m])
    let key = 'G';
    const keyExplicit = clean.match(/(?:tom|key)\s*[:=-]?\s*([A-G][#b]?m?)\b/i);
    if (keyExplicit) {
      key = keyExplicit[1];
      clean = clean.replace(keyExplicit[0], '').trim();
    } else {
      const keyMatch = clean.match(/\b([A-G][#b]?m?)\b/);
      if (keyMatch) {
        key = keyMatch[1];
      }
    }

    // 3. Remover prefixos técnicos comuns (ex: "VS - ", "Multitrack - ", "Playback - ", "[VS] ", "01 - ")
    clean = clean
      .replace(/^(?:\[vs\]|\(vs\)|vs|multitrack|playback|stems|tracks)\s*[-_:]\s*/i, '')
      .replace(/^\d{1,3}\s*[-_]\s*/, '')
      .replace(/^[-_:\s]+|[-_:\s]+$/g, '')
      .trim();

    // 4. Separar Título e Artista
    const parts = clean.split(/\s*[-–—]\s*/).map((s) => s.trim()).filter(Boolean);
    let title = clean || fileName;
    let artist = 'Ministério de Louvor';

    if (parts.length >= 2) {
      title = parts[0];
      artist = parts.slice(1).join(' - ');
    } else if (parts.length === 1) {
      title = parts[0];
    }

    return { title, artist, bpm, key };
  }

  /**
   * Sincroniza o catálogo oficial com o bucket do Backblaze B2.
   * Verifica a integridade dos arquivos e atualiza a lista de músicas cadastradas.
   */
  async syncCatalogFromMasterCloud(onProgress?: (msg: string) => void): Promise<{ count: number; songs: CatalogSong[] }> {
    const b2Base = this.getB2BaseUrl();
    const songMap = new Map<string, CatalogSong>();

    // Incorpora músicas atualmente salvas no catálogo local (preserva metadados customizados)
    for (const s of this.catalog) {
      if (s.zipFileName) {
        songMap.set(s.zipFileName.toLowerCase(), s);
      }
    }

    const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
    let syncedViaRust = false;

    if (isTauri) {
      try {
        onProgress?.('Sincronizando catálogo dinamicamente via Backblaze B2 (Rust nativo)…');
        const { b2KeyId, b2ApplicationKey, b2BucketId, b2BucketName } = this.masterConfig;
        const res = await invoke<B2SyncResultPayload>('b2_sync_catalog', {
          keyId: b2KeyId || null,
          applicationKey: b2ApplicationKey || null,
          bucketId: b2BucketId || null,
          bucketName: b2BucketName || null,
        });

        if (res && res.success) {
          syncedViaRust = true;
          const downloadBase = res.downloadBaseUrl || b2Base;
          let newFound = 0;

          // Se a sincronização do B2 foi concluída com sucesso, o catálogo reflete estritamente os pacotes do bucket
          const existingMap = new Map<string, CatalogSong>(songMap);
          songMap.clear();

          for (const f of res.packageFiles || []) {
            const key = f.fileName.toLowerCase();
            const existing = existingMap.get(key);
            const b2Url = this.buildB2DownloadUrl(f.fileName, downloadBase);

            if (existing) {
              songMap.set(key, {
                ...existing,
                provider: 'b2',
                zipFileName: f.fileName,
                zipDownloadUrl: b2Url,
                b2DownloadUrl: b2Url,
                zipFileSize: f.contentLength > 0 ? f.contentLength : existing.zipFileSize,
              });
            } else {
              const info = this.parseSongInfoFromFileName(f.fileName);
              songMap.set(key, {
                id: `b2_zip_${uid('song')}`,
                title: info.title,
                artist: info.artist,
                bpm: info.bpm,
                key: info.key,
                beatsPerBar: 4,
                durationSec: 300,
                zipFileName: f.fileName,
                zipDownloadUrl: b2Url,
                b2DownloadUrl: b2Url,
                zipFileSize: f.contentLength,
                provider: 'b2',
                addedAt: new Date().toISOString(),
                stems: [],
                tags: ['Backblaze B2', 'Multitrack', 'Auto-Sync'],
              });
              newFound++;
            }
          }

          onProgress?.(`✨ Backblaze B2: ${res.packageFiles.length} pacotes encontrados (${newFound} novos).`);
        }
      } catch (err: any) {
        console.warn('[MasterCatalogService] Falha no b2_sync_catalog nativo:', err);
        onProgress?.(`Aviso: Falha na sincronização nativa B2: ${err?.message || err}. Tentando alternativas...`);
      }
    }

    // Se não rodou via Rust nativo (ex: ambiente web puro), tenta via cloudFetch HTTP
    if (!syncedViaRust) {
      // 1. Tenta carregar catalog.json do bucket
      try {
        const resp = await cloudFetch(`${b2Base}catalog.json`);
        if (resp.ok) {
          const json = await resp.json();
          const rawSongs: CatalogSong[] = Array.isArray(json) ? json : json.songs || [];
          if (rawSongs.length > 0) {
            onProgress?.(`Encontrado catalog.json no bucket com ${rawSongs.length} músicas.`);
            for (const s of rawSongs) {
              const fileName = s.zipFileName || `${s.title.replace(/[\\/]/g, '_')}.zip`;
              const b2Url = this.buildB2DownloadUrl(fileName, b2Base);
              songMap.set(fileName.toLowerCase(), {
                ...s,
                provider: 'b2',
                zipFileName: fileName,
                zipDownloadUrl: b2Url,
                b2DownloadUrl: b2Url,
              });
            }
          }
        }
      } catch {
        /* ignore */
      }

      // 2. Se configurou credenciais, consulta via API web B2
      const { b2KeyId, b2ApplicationKey, b2BucketId } = this.masterConfig;
      if (b2KeyId?.trim() && b2ApplicationKey?.trim()) {
        try {
          onProgress?.('Autenticando na API nativa da Backblaze B2 (web)…');
          const basic = btoa(`${b2KeyId.trim()}:${b2ApplicationKey.trim()}`);
          const authResp = await cloudFetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
            authHeader: `Basic ${basic}`,
          });

          if (authResp.ok) {
            const authData = await authResp.json();
            const token = authData.authorizationToken;
            const apiUrl = authData.apiUrl;
            const targetBucketId = b2BucketId?.trim() || authData.allowed?.bucketId || '437f98cd55f48a50af1e0e16';

            onProgress?.(`Buscando lista de arquivos no bucket B2 (${targetBucketId})…`);
            const listResp = await cloudFetch(`${apiUrl}/b2api/v3/b2_list_file_names`, {
              method: 'POST',
              authHeader: token,
              body: JSON.stringify({ bucketId: targetBucketId, maxFileCount: 1000 }),
            });

            if (listResp.ok) {
              const listData = await listResp.json();
              const b2Files: Array<{ fileName: string; contentLength: number }> = listData.files || [];
              let newFound = 0;
              for (const f of b2Files) {
                if (/\.(zip|rar|tar\.gz)$/i.test(f.fileName)) {
                  const key = f.fileName.toLowerCase();
                  if (!songMap.has(key)) {
                    const info = this.parseSongInfoFromFileName(f.fileName);
                    const b2Url = this.buildB2DownloadUrl(f.fileName, b2Base);
                    songMap.set(key, {
                      id: `b2_zip_${uid('song')}`,
                      title: info.title,
                      artist: info.artist,
                      bpm: info.bpm,
                      key: info.key,
                      beatsPerBar: 4,
                      durationSec: 300,
                      zipFileName: f.fileName,
                      zipDownloadUrl: b2Url,
                      b2DownloadUrl: b2Url,
                      zipFileSize: f.contentLength,
                      provider: 'b2',
                      addedAt: new Date().toISOString(),
                      stems: [],
                      tags: ['Backblaze B2', 'Multitrack', 'Auto-Sync'],
                    });
                    newFound++;
                  }
                }
              }
              if (newFound > 0) {
                onProgress?.(`✨ ${newFound} novos arquivos descobertos via API do Backblaze B2!`);
              }
            }
          }
        } catch (apiErr) {
          console.warn('Erro ao consultar API nativa B2:', apiErr);
        }
      }
    }

    // Normaliza e valida todas as URLs no Backblaze B2
    onProgress?.('Configurando URLs para Backblaze B2…');
    const updatedSongs: CatalogSong[] = Array.from(songMap.values()).map((s) => {
      const fileName =
        s.zipFileName ||
        (s.zipDownloadUrl && !s.zipDownloadUrl.includes('googleapis') && !s.zipDownloadUrl.includes('google.com')
          ? decodeURIComponent(s.zipDownloadUrl.split('/').pop()?.split('?')[0] || '')
          : undefined) ||
        `${s.title.replace(/[\\/]/g, '_')}.zip`;
      const b2Url = this.buildB2DownloadUrl(fileName, b2Base);
      return {
        ...s,
        provider: 'b2',
        zipFileName: fileName,
        zipDownloadUrl: b2Url,
        b2DownloadUrl: b2Url,
      };
    });

    this.saveCatalog(updatedSongs);
    this.saveMasterConfig({
      lastSyncTime: new Date().toISOString(),
      totalSyncedSongs: updatedSongs.length,
    });

    onProgress?.(`✅ Catálogo Backblaze B2 sincronizado: ${updatedSongs.length} multitracks ativas.`);
    return { count: updatedSongs.length, songs: updatedSongs };
  }

  /**
   * Exporta a lista completa do catálogo em formato JSON compatível com catalog.json do B2
   */
  exportCatalogJsonString(): string {
    return JSON.stringify(this.catalog, null, 2);
  }

  /**
   * Downloads a song from the central catalog directly into the user's IndexedDB and builds
   * the canonical stage mixer with zero latency.
   */
  /**
   * Baixa e descompacta o pacote de áudios da música (ZIP do Backblaze B2 ou stems individuais).
   * Retorna a lista completa de ficheiros de áudio brutos (.wav, .mp3, etc.) para que o
   * usuário possa revisar, renomear e excluir canais antes de compilar no repertório.
   */
  async downloadAndExtractSongPackage(
    catalogSong: CatalogSong,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ catalogSong: CatalogSong; audioFiles: Array<{ fileName: string; data: ArrayBuffer }> }> {
    const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
    const taskId = uid('dl_task');
    const audioFiles: Array<{ fileName: string; data: ArrayBuffer }> = [];

    // 1. Pacote MultiTrack .ZIP completo direto do Backblaze B2
    const downloadInfo = this.getEffectiveDownloadInfo(catalogSong);
    if (downloadInfo.url) {
      if (isTauri) {
        onProgress({
          statusText: `Transferindo pacote ZIP de "${catalogSong.title}" via Backblaze B2…`,
          percent: 5,
        });

        let unlisten: (() => void) | null = null;
        try {
          unlisten = await listen<{ task_id: string; percent: number; status_text: string; current_track_name?: string }>(
            'download-progress',
            (event) => {
              if (event.payload.task_id === taskId) {
                onProgress({
                  statusText: event.payload.status_text,
                  percent: event.payload.percent,
                  currentTrackName: event.payload.current_track_name,
                });
              }
            },
          );

          console.log('[DOWNLOAD-TRANSITION] Invocando download_and_extract_vs para:', catalogSong.title, downloadInfo.url);
          const rustRes = await invoke<any>('download_and_extract_vs', {
            url: downloadInfo.url,
            authHeader: undefined, // B2 público
            songTitle: catalogSong.title,
            taskId,
          });

          console.log('[DOWNLOAD-TRANSITION] Retorno de download_and_extract_vs:', rustRes);

          const rawAudioList: any[] = rustRes?.audio_files || rustRes?.audioFiles || [];
          if (!rustRes?.success || rawAudioList.length === 0) {
            throw new Error('Nenhum canal de áudio encontrado no pacote descompactado.');
          }

          const totalAudio = rawAudioList.length;
          onProgress({
            statusText: `Lendo ${totalAudio} canais de áudio descompactados…`,
            percent: 85,
          });

          for (let i = 0; i < totalAudio; i++) {
            const f = rawAudioList[i];
            const filePath = f.file_path || f.filePath;
            const fileName = f.file_name || f.fileName || `track_${i + 1}.wav`;
            try {
              const res: any = await invoke('read_audio_file', { filePath });
              const arrayBuf = ensureArrayBuffer(res);
              audioFiles.push({ fileName, data: arrayBuf });
            } catch (err) {
              console.error(`[Track Reader] Faixa ${i + 1}/${totalAudio} (${fileName}) falhou ao ler:`, err);
            }
          }
        } finally {
          if (unlisten) unlisten();
        }
      } else {
        // Fallback navegador web
        onProgress({
          statusText: `Transferindo pacote ZIP de "${catalogSong.title}" via Backblaze B2…`,
          percent: 15,
        });

        const resp = await cloudFetch(downloadInfo.url);
        if (!resp.ok) {
          throw new Error(`Falha ao baixar pacote ZIP do Backblaze B2: HTTP ${resp.status}`);
        }

        onProgress({
          statusText: 'A descompactar ficheiros de áudio…',
          percent: 50,
        });

        const zipBuf = await resp.arrayBuffer();
        const browserExtracted = await processZipFile(
          { name: `${catalogSong.title}.zip`, data: zipBuf },
          (msg) => onProgress({ statusText: msg, percent: 70 }),
        );

        for (const it of browserExtracted) {
          audioFiles.push({ fileName: it.name, data: it.data });
        }
      }

      if (audioFiles.length === 0) {
        throw new Error('Nenhum canal de áudio pôde ser extraído a partir do pacote.');
      }

      return { catalogSong, audioFiles };
    }

    // Fallback stems individuais se não houver pacote .zip
    onProgress({
      statusText: `Iniciando download de "${catalogSong.title}" (${catalogSong.stems.length} faixas)…`,
      percent: 5,
    });

    for (let i = 0; i < catalogSong.stems.length; i++) {
      const stem = catalogSong.stems[i];
      onProgress({
        statusText: `Baixando faixa (${i + 1}/${catalogSong.stems.length}): ${stem.name}…`,
        percent: Math.round(10 + (i / catalogSong.stems.length) * 80),
        currentTrackName: stem.name,
      });

      if (stem.downloadUrl) {
        try {
          const token = await this.getAccessToken();
          let rawArrayBuffer: ArrayBuffer;
          if (isTauri) {
            try {
              const safeName = (stem.fileName || `stem_${stem.fileId || uid('stem')}.wav`).replace(/[\\/:*?"<>|]/g, '_');
              const filePath = await invoke<string>('download_cloud_file_to_cache', {
                url: stem.downloadUrl,
                authHeader: token ? `Bearer ${token.trim()}` : undefined,
                fileName: `${stem.fileId || uid('stem')}_${safeName}`,
              });
              const bytes: number[] = await invoke('read_audio_file', { filePath });
              rawArrayBuffer = new Uint8Array(bytes).buffer;
            } catch {
              const resp = await cloudFetch(stem.downloadUrl, {
                authHeader: token ? `Bearer ${token.trim()}` : undefined,
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              rawArrayBuffer = await resp.arrayBuffer();
            }
          } else {
            const resp = await cloudFetch(stem.downloadUrl, {
              authHeader: token ? `Bearer ${token.trim()}` : undefined,
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            rawArrayBuffer = await resp.arrayBuffer();
          }
          audioFiles.push({ fileName: stem.fileName || stem.name, data: rawArrayBuffer });
        } catch (err) {
          console.warn(`Erro ao baixar stem ${stem.name}:`, err);
        }
      }
    }

    if (audioFiles.length === 0) {
      throw new Error('Nenhum canal de áudio pôde ser baixado a partir do catálogo.');
    }

    return { catalogSong, audioFiles };
  }

  /**
   * Finaliza a decodificação dos canais mapeados e nomeados pelo usuário,
   * salva os stems no IndexedDB com zero latência, detecta seções/cifras e adiciona a música.
   */
  async finalizeSongWithCustomTracks({
    songId = uid('song'),
    catalogSong,
    customTracks,
    ctx,
    onProgress,
  }: {
    songId?: string;
    catalogSong: CatalogSong;
    customTracks: Array<{
      id: string;
      fileName: string;
      name: string;
      kind: TrackKind;
      bus: BusGroup;
      color: string;
      included: boolean;
      data: ArrayBuffer;
    }>;
    ctx: AudioContext;
    onProgress: (p: DownloadProgress) => void;
  }): Promise<Song & { _preloadedBuffers: Map<string, AudioBuffer> }> {
    const selected = customTracks.filter((t) => t.included);
    if (!selected.length) {
      throw new Error('Nenhum canal selecionado para importação.');
    }

    let duration = 0;
    const initialTracks: Track[] = [];
    const preloadedBuffers = new Map<string, AudioBuffer>();

    for (let i = 0; i < selected.length; i++) {
      const it = selected[i];
      onProgress({
        statusText: `Decodificando e salvando canal (${i + 1}/${selected.length}): ${it.name}…`,
        percent: Math.round(10 + (i / selected.length) * 85),
        currentTrackName: it.name,
      });

      // Permite que o loop de renderização do React atualize a interface sem congelar
      await new Promise((r) => setTimeout(r, 0));

      const safeData = ensureArrayBuffer(it.data);

      try {
        const decoded = await decodeAudioDataSafe(ctx, safeData);
        if (isFinite(decoded.duration) && decoded.duration > 0) {
          duration = Math.max(duration, decoded.duration);
        }

        // Se o canal for um Click/Guia estéreo combinado, separa em canais L e R isolados
        if (
          isCombinedClickGuide(it.fileName) ||
          isCombinedClickGuide(it.name) ||
          ((it.kind === 'click' || it.kind === 'guide') && isDualChannelClickGuide(decoded))
        ) {
          const split = splitStereoClickGuide(ctx, decoded);

          const clickId = uid('tr_click');
          await saveStem(songId, clickId, split.clickWav);
          preloadedBuffers.set(clickId, split.clickBuffer);
          initialTracks.push({
            id: clickId,
            name: 'CLICK (Áudio Original)',
            color: '#F39C12',
            kind: 'audio',
            bus: 'UTILITY',
            output: 'OUT_6',
            volume: 0.75,
            pan: 0,
            mute: false,
            solo: false,
            pitchShift: false,
            fileName: it.fileName,
          });

          const guideId = uid('tr_guide');
          await saveStem(songId, guideId, split.guideWav);
          preloadedBuffers.set(guideId, split.guideBuffer);
          initialTracks.push({
            id: guideId,
            name: 'GUIDE (Áudio Original)',
            color: '#0099FF',
            kind: 'audio',
            bus: 'UTILITY',
            output: 'OUT_5',
            volume: 0.9,
            pan: 0,
            mute: false,
            solo: false,
            pitchShift: false,
            fileName: it.fileName,
          });
        } else {
          const isClick = it.kind === 'click' || it.name.includes('CLICK');
          const isGuide = it.kind === 'guide' || it.name.includes('GUIDE') || it.name.includes('GUIA');
          const out = it.bus === 'UTILITY' ? (isGuide ? 'OUT_5' : 'OUT_6') : (it.bus === 'BASS' ? 'OUT_3_4' : 'OUT_1_2');

          await saveStem(songId, it.id, safeData);
          preloadedBuffers.set(it.id, decoded);
          initialTracks.push({
            id: it.id,
            name: it.name,
            color: it.color,
            kind: it.kind,
            bus: it.bus,
            output: out,
            volume: isClick ? 0.75 : 0.85,
            pan: 0,
            mute: false,
            solo: false,
            pitchShift: isTrackPitched({ name: it.name, fileName: it.fileName, kind: it.kind, bus: it.bus }),
            fileName: it.fileName,
          });
        }
      } catch (err) {
        console.error(`[Audio Decoder] Falha ao decodificar "${it.name}", salvando fallback:`, err);
        // Resiliência total: mesmo que a decodificação falhe, salva o stem e garante que a faixa apareça no mixer
        try {
          await saveStem(songId, it.id, safeData);
          const isClick = it.kind === 'click' || it.name.includes('CLICK');
          const isGuide = it.kind === 'guide' || it.name.includes('GUIDE') || it.name.includes('GUIA');
          const out = it.bus === 'UTILITY' ? (isGuide ? 'OUT_5' : 'OUT_6') : (it.bus === 'BASS' ? 'OUT_3_4' : 'OUT_1_2');
          initialTracks.push({
            id: it.id,
            name: it.name,
            color: it.color,
            kind: it.kind,
            bus: it.bus,
            output: out,
            volume: isClick ? 0.75 : 0.85,
            pan: 0,
            mute: false,
            solo: false,
            pitchShift: isTrackPitched({ name: it.name, fileName: it.fileName, kind: it.kind, bus: it.bus }),
            fileName: it.fileName,
          });
        } catch (saveErr) {
          console.error(`[Audio Decoder] Falha crítica ao salvar stem "${it.name}":`, saveErr);
        }
      }
    }

    if (initialTracks.length === 0) {
      throw new Error('Nenhum canal pôde ser decodificado com sucesso.');
    }

    const orderedTracks = orderTracksForStage(initialTracks);
    const finalDuration = Math.round(duration || catalogSong.durationSec || 240);

    const song: Song & { _preloadedBuffers: Map<string, AudioBuffer> } = {
      id: songId,
      name: catalogSong.title,
      artist: catalogSong.artist,
      bpm: catalogSong.bpm,
      key: catalogSong.key,
      pitchOffset: 0,
      pitchCents: 0,
      pitchMode: 'PRO_SOLA',
      formantPreserve: 0.75,
      beatsPerBar: catalogSong.beatsPerBar || 4,
      firstBeat: 0,
      duration: finalDuration,
      guideMode: 'REANNOUNCE',
      transitionAfter: 'AUTO_ADVANCE',
      sections: [],
      tracks: orderedTracks,
      source: 'import',
      _preloadedBuffers: preloadedBuffers,
    };

    song.sections = detectSectionsFromAudio(song);
    song.chordChart = generateChordChartForSong(song, 'modern');

    onProgress({
      statusText: `✅ "${song.name}" adicionada ao Repertório! (${orderedTracks.length} canais prontos)`,
      percent: 100,
    });

    return song;
  }

  /**
   * Mantém compatibilidade com chamadas diretas a downloadSongToRepertoire,
   * executando extração e mapeamento com os nomes detectados.
   */
  async downloadSongToRepertoire(
    catalogSong: CatalogSong,
    ctx: AudioContext,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<Song & { _preloadedBuffers: Map<string, AudioBuffer> }> {
    const pkg = await this.downloadAndExtractSongPackage(catalogSong, onProgress);
    const mapped = pkg.audioFiles.map((f, i) => {
      const g = guessTrack(f.fileName, i, catalogSong.title);
      return {
        id: uid('tr'),
        fileName: f.fileName,
        name: g.name,
        suggestedName: g.name,
        kind: g.kind,
        bus: g.bus,
        color: g.color,
        included: true,
        data: f.data,
      };
    });
    return this.finalizeSongWithCustomTracks({
      catalogSong,
      customTracks: mapped,
      ctx,
      onProgress,
    });
  }
}

export const masterCatalogService = new MasterCatalogService();
