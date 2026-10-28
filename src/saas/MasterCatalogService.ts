import { invoke } from '@tauri-apps/api/core';
import type { Song, Track } from '../types';
import { guessTrack, orderTracksForStage, uid } from '../music';
import { decodeAudioDataSafe, saveStem } from '../storage';
import { isCombinedClickGuide, isDualChannelClickGuide, splitStereoClickGuide } from '../audio/audioSeparation';
import { detectSectionsFromAudio, generateChordChartForSong } from '../audio/aiAssistant';
import { processZipFile } from '../utils/zipExtractor';
import type { CatalogSong, CatalogStem, DownloadProgress, GoogleServiceAccountKey, MasterCloudConfig } from './types';
import defaultServiceAccount from './serviceAccount.json';

const LS_CATALOG_KEY = 'wpp_saas_catalog_v1';
const LS_MASTER_CONFIG_KEY = 'wpp_saas_master_cloud_config_v1';
const LS_ADMIN_WHATSAPP_KEY = 'wpp_saas_admin_whatsapp_v1';

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
    // Limpa músicas antigas/mock para permitir nova atualização do zero
    this.clearCatalog();
  }

  clearCatalog(): void {
    this.catalog = [];
    localStorage.setItem(LS_CATALOG_KEY, JSON.stringify([]));
    this.saveMasterConfig({
      totalSyncedSongs: 0,
      lastSyncTime: '',
    });
    this.notify();
  }

  private loadMasterConfig(): MasterCloudConfig {
    const defaultSa = defaultServiceAccount as unknown as GoogleServiceAccountKey;
    let cfg: MasterCloudConfig = {
      provider: 'gdrive',
      masterToken: '',
      rootFolderId: '',
      rootFolderName: 'Minha Pasta Raiz de MultiTracks',
      serviceAccount: defaultSa ?? null,
      totalSyncedSongs: 0,
      adminWhatsAppNumber: '',
    };
    try {
      const raw = localStorage.getItem(LS_MASTER_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MasterCloudConfig;
        if (!parsed.serviceAccount && defaultSa) {
          parsed.serviceAccount = defaultSa;
        }
        cfg = { ...cfg, ...parsed };
      }
    } catch {
      /* ignore */
    }
    const savedWa = localStorage.getItem(LS_ADMIN_WHATSAPP_KEY);
    if (savedWa && !cfg.adminWhatsAppNumber) {
      cfg.adminWhatsAppNumber = savedWa;
    }
    return cfg;
  }

  private loadCatalog(): CatalogSong[] {
    try {
      const raw = localStorage.getItem(LS_CATALOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CatalogSong[];
        const clean = parsed.filter(
          (s) =>
            !s.id.startsWith('cat_') &&
            s.title !== 'Bondade de Deus' &&
            s.title !== 'Vitorioso És' &&
            s.title !== 'A Ele a Glória',
        );
        return clean;
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  saveMasterConfig(cfg: Partial<MasterCloudConfig>) {
    this.masterConfig = { ...this.masterConfig, ...cfg };
    if (cfg.adminWhatsAppNumber !== undefined) {
      localStorage.setItem(LS_ADMIN_WHATSAPP_KEY, cfg.adminWhatsAppNumber);
    }
    localStorage.setItem(LS_MASTER_CONFIG_KEY, JSON.stringify(this.masterConfig));
    // Invalidate cached token if service account or manual token changed
    this.cachedAccessToken = null;
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
   * Scans the Admin's Google Drive or OneDrive root folder for MultiTrack songs.
   * Finds all subfolders, reads stem audio files, classifies them and updates the catalog.
   */
  async syncCatalogFromMasterCloud(onProgress?: (msg: string) => void): Promise<{ count: number; songs: CatalogSong[] }> {
    const { provider, rootFolderId, serviceAccount } = this.masterConfig;

    let token = '';
    try {
      token = await this.getAccessToken();
    } catch (err) {
      onProgress?.(`⚠️ Erro de autenticação Service Account: ${(err as Error).message}`);
    }

    if (!token && !this.masterConfig.masterToken) {
      onProgress?.('⚠️ Nenhuma credencial ou token ativo. Usando catálogo integrado.');
      return { count: this.catalog.length, songs: this.catalog };
    }

    onProgress?.(`Conectando ao Google Drive da Service Account (${serviceAccount?.client_email || 'Admin'})…`);

    const newSongs: CatalogSong[] = [];

    if (provider === 'gdrive') {
      try {
        // 1. Try to find catalog-index.json or index.json directly in the Google Drive root folder
        try {
          let indexQ = "(name = 'catalog-index.json' or name = 'index.json') and trashed = false";
          if (rootFolderId.trim()) {
            indexQ = `'${rootFolderId.trim()}' in parents and ${indexQ}`;
          }
          const indexUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(indexQ)}&fields=files(id,name)&pageSize=10`;
          const indexResp = await cloudFetch(indexUrl, { authHeader: `Bearer ${token.trim()}` });
          if (indexResp.ok) {
            const idxData = await indexResp.json();
            const indexFiles: { id: string; name: string }[] = idxData.files || [];
            if (indexFiles.length > 0) {
              onProgress?.(`Encontrado ${indexFiles[0].name} no Google Drive. Lendo estrutura catalogada…`);
              const fileResp = await cloudFetch(`https://www.googleapis.com/drive/v3/files/${indexFiles[0].id}?alt=media`, {
                authHeader: `Bearer ${token.trim()}`,
              });
              if (fileResp.ok) {
                const jsonContent = await fileResp.json();
                const rawList: any[] = Array.isArray(jsonContent) ? jsonContent : jsonContent.songs || [];
                for (const raw of rawList) {
                  const rawStems: any[] = raw.stems || [];
                  const finalStems: CatalogStem[] = [];
                  for (let i = 0; i < rawStems.length; i++) {
                    const st = rawStems[i];
                    const fileName = st.fileName || st.name || `track_${i}.wav`;
                    const stName = st.name || st.title || fileName;
                    if (isCombinedClickGuide(stName) || isCombinedClickGuide(fileName)) {
                      // Separate Click and Guide into two distinct channels
                      finalStems.push({
                        id: `stem_${st.id || i}_click`,
                        name: 'CLICK',
                        fileName,
                        fileId: st.fileId || st.id,
                        downloadUrl: st.downloadUrl || (st.fileId ? `https://www.googleapis.com/drive/v3/files/${st.fileId}?alt=media` : undefined),
                        kind: 'click',
                        bus: 'UTILITY',
                        output: 'OUT_6',
                        isCombinedStereoSplit: true,
                        splitChannel: 'left',
                      });
                      finalStems.push({
                        id: `stem_${st.id || i}_guide`,
                        name: 'GUIA',
                        fileName,
                        fileId: st.fileId || st.id,
                        downloadUrl: st.downloadUrl || (st.fileId ? `https://www.googleapis.com/drive/v3/files/${st.fileId}?alt=media` : undefined),
                        kind: 'guide',
                        bus: 'UTILITY',
                        output: 'OUT_5',
                        isCombinedStereoSplit: true,
                        splitChannel: 'right',
                      });
                    } else {
                      const g = guessTrack(fileName, i, raw.title || raw.name);
                      finalStems.push({
                        id: st.id ? `stem_${st.id}` : `stem_${i}`,
                        name: st.name || g.name,
                        fileName,
                        fileId: st.fileId || st.id,
                        downloadUrl: st.downloadUrl || (st.fileId ? `https://www.googleapis.com/drive/v3/files/${st.fileId}?alt=media` : undefined),
                        fileSize: st.fileSize,
                        kind: st.kind || g.kind,
                        bus: st.bus || g.bus,
                        output: st.output || g.output,
                      });
                    }
                  }
                  newSongs.push({
                    id: raw.id ? `gdrive_idx_${raw.id}` : `gdrive_idx_${uid('song')}`,
                    title: raw.title || raw.name || 'Sem Título',
                    artist: raw.artist || 'Ministério de Louvor',
                    bpm: raw.bpm || 72,
                    key: raw.key || 'G',
                    beatsPerBar: raw.beatsPerBar || 4,
                    durationSec: raw.durationSec || 280,
                    provider: 'gdrive',
                    addedAt: raw.addedAt || new Date().toISOString(),
                    stems: orderTracksForStage(finalStems as unknown as Track[]) as unknown as CatalogStem[],
                  });
                }
              }
            }
          }
        } catch (idxErr) {
          console.warn('Verificação de catalog-index.json:', idxErr);
        }

        // 2. Scan subfolders in Google Drive (each folder represents a MultiTrack song)
        let qStr = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
        if (rootFolderId.trim()) {
          qStr = `'${rootFolderId.trim()}' in parents and ${qStr}`;
        }
        const q = encodeURIComponent(qStr);
        const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=100`;

        const resp = await cloudFetch(url, {
          authHeader: `Bearer ${token.trim()}`,
        });

        if (!resp.ok) {
          const errBody = await resp.text();
          throw new Error(`Google Drive API retornou erro HTTP ${resp.status}: ${errBody}`);
        }

        const data = await resp.json();
        const folders: { id: string; name: string }[] = data.files || [];

        if (folders.length === 0 && newSongs.length === 0) {
          onProgress?.(`Nenhuma pasta encontrada. Certifique-se de compartilhar a pasta do seu Google Drive com: ${serviceAccount?.client_email}`);
          return { count: this.catalog.length, songs: this.catalog };
        }

        if (folders.length > 0) {
          onProgress?.(`Encontradas ${folders.length} pastas de músicas no Google Drive. Mapeando canais e isolando Click & Guia…`);

          for (let idx = 0; idx < folders.length; idx++) {
            const folder = folders[idx];
            onProgress?.(`Escaneando (${idx + 1}/${folders.length}): ${folder.name}…`);

            // List files in this folder
            const fq = encodeURIComponent(`'${folder.id}' in parents and trashed = false`);
            const fUrl = `https://www.googleapis.com/drive/v3/files?q=${fq}&fields=files(id,name,size,webContentLink)&pageSize=100`;

            const fResp = await cloudFetch(fUrl, {
              authHeader: `Bearer ${token.trim()}`,
            });

            if (!fResp.ok) continue;

            const fData = await fResp.json();
            const files: { id: string; name: string; size?: string; webContentLink?: string }[] = fData.files || [];

            // Check if folder contains a catalog-index.json / song.json
            const folderIndexFile = files.find((f) => f.name.toLowerCase() === 'catalog-index.json' || f.name.toLowerCase() === 'song.json');
            if (folderIndexFile) {
              try {
                const sResp = await cloudFetch(`https://www.googleapis.com/drive/v3/files/${folderIndexFile.id}?alt=media`, {
                  authHeader: `Bearer ${token.trim()}`,
                });
                if (sResp.ok) {
                  const sJson = await sResp.json();
                  // parse stems from json with strict separation of combined click & guide
                  const sStems: CatalogStem[] = [];
                  for (let i = 0; i < (sJson.stems || []).length; i++) {
                    const st = sJson.stems[i];
                    const matchFile = files.find((f) => f.name.toLowerCase() === (st.fileName || st.name || '').toLowerCase());
                    const fId = matchFile?.id || st.fileId || st.id;
                    const fileName = matchFile?.name || st.fileName || st.name || `track_${i}.wav`;
                    const stName = st.name || fileName;

                    if (isCombinedClickGuide(stName) || isCombinedClickGuide(fileName)) {
                      sStems.push({
                        id: `stem_${fId || i}_click`,
                        name: 'CLICK',
                        fileName,
                        fileId: fId,
                        downloadUrl: `https://www.googleapis.com/drive/v3/files/${fId}?alt=media`,
                        fileSize: matchFile?.size ? parseInt(matchFile.size, 10) : undefined,
                        kind: 'click',
                        bus: 'UTILITY',
                        output: 'OUT_6',
                        isCombinedStereoSplit: true,
                        splitChannel: 'left',
                      });
                      sStems.push({
                        id: `stem_${fId || i}_guide`,
                        name: 'GUIA',
                        fileName,
                        fileId: fId,
                        downloadUrl: `https://www.googleapis.com/drive/v3/files/${fId}?alt=media`,
                        fileSize: matchFile?.size ? parseInt(matchFile.size, 10) : undefined,
                        kind: 'guide',
                        bus: 'UTILITY',
                        output: 'OUT_5',
                        isCombinedStereoSplit: true,
                        splitChannel: 'right',
                      });
                    } else {
                      sStems.push({
                        id: `stem_${fId || i}`,
                        name: st.name,
                        fileName,
                        fileId: fId,
                        downloadUrl: `https://www.googleapis.com/drive/v3/files/${fId}?alt=media`,
                        fileSize: matchFile?.size ? parseInt(matchFile.size, 10) : undefined,
                        kind: st.kind,
                        bus: st.bus,
                        output: st.output,
                      });
                    }
                  }

                  if (sStems.length > 0) {
                    newSongs.push({
                      id: `gdrive_${folder.id}`,
                      title: sJson.title || folder.name,
                      artist: sJson.artist || 'Ministério de Louvor',
                      bpm: sJson.bpm || 72,
                      key: sJson.key || 'G',
                      beatsPerBar: sJson.beatsPerBar || 4,
                      durationSec: sJson.durationSec || 280,
                      cloudFolderId: folder.id,
                      provider: 'gdrive',
                      addedAt: new Date().toISOString(),
                      stems: orderTracksForStage(sStems as unknown as Track[]) as unknown as CatalogStem[],
                    });
                    continue;
                  }
                }
              } catch (e) {
                console.warn('Erro ao ler song.json na pasta:', folder.name, e);
              }
            }

            const audioFiles = files.filter((f) => /\.(wav|wave|mp3|m4a|ogg|flac|aac|aiff)$/i.test(f.name));
            if (audioFiles.length === 0) continue;

            // Parse metadata from folder name (e.g. "Bondade de Deus - Isaías Saad - 70BPM - G")
            let bpm = 72;
            let key = 'G';
            const bpmMatch = folder.name.match(/\b(\d{2,3})\s*bpm\b/i);
            if (bpmMatch) bpm = parseInt(bpmMatch[1], 10);

            const keyMatch = folder.name.match(/\b([A-G][#b]?m?)\b/);
            if (keyMatch) key = keyMatch[1];

            const parts = folder.name.split(' - ').map((s) => s.trim());
            const title = parts[0] || folder.name;
            const artist = parts[1] || 'Ministério de Louvor';

            const stems: CatalogStem[] = [];
            for (let i = 0; i < audioFiles.length; i++) {
              const f = audioFiles[i];
              const g = guessTrack(f.name, i, title);

              // If file is a combined Click & Guide track, separate into two dedicated channels!
              if (g.isCombinedClickGuide || isCombinedClickGuide(f.name)) {
                stems.push({
                  id: `stem_${f.id}_click`,
                  name: 'CLICK',
                  fileName: f.name,
                  fileId: f.id,
                  downloadUrl: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
                  fileSize: f.size ? parseInt(f.size, 10) : undefined,
                  kind: 'click',
                  bus: 'UTILITY',
                  output: 'OUT_6',
                  isCombinedStereoSplit: true,
                  splitChannel: 'left',
                });
                stems.push({
                  id: `stem_${f.id}_guide`,
                  name: 'GUIA',
                  fileName: f.name,
                  fileId: f.id,
                  downloadUrl: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
                  fileSize: f.size ? parseInt(f.size, 10) : undefined,
                  kind: 'guide',
                  bus: 'UTILITY',
                  output: 'OUT_5',
                  isCombinedStereoSplit: true,
                  splitChannel: 'right',
                });
              } else {
                stems.push({
                  id: `stem_${f.id}`,
                  name: g.name,
                  fileName: f.name,
                  fileId: f.id,
                  downloadUrl: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
                  fileSize: f.size ? parseInt(f.size, 10) : undefined,
                  kind: g.kind,
                  bus: g.bus,
                  output: g.output,
                });
              }
            }

            newSongs.push({
              id: `gdrive_${folder.id}`,
              title,
              artist,
              bpm,
              key,
              beatsPerBar: 4,
              durationSec: 280,
              cloudFolderId: folder.id,
              provider: 'gdrive',
              addedAt: new Date().toISOString(),
              stems: orderTracksForStage(stems as unknown as Track[]) as unknown as CatalogStem[],
            });
          }
        }

        // 3. Scan .zip multitrack files in Google Drive root folder
        try {
          let zipQ = "(name contains '.zip' or mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed') and trashed = false";
          if (rootFolderId.trim()) {
            zipQ = `'${rootFolderId.trim()}' in parents and ${zipQ}`;
          }
          const zq = encodeURIComponent(zipQ);
          const zUrl = `https://www.googleapis.com/drive/v3/files?q=${zq}&fields=files(id,name,size,webContentLink)&pageSize=100`;

          const zResp = await cloudFetch(zUrl, {
            authHeader: `Bearer ${token.trim()}`,
          });

          if (zResp.ok) {
            const zData = await zResp.json();
            const zipFiles: { id: string; name: string; size?: string }[] = zData.files || [];

            for (const zf of zipFiles) {
              const cleanName = zf.name.replace(/\.zip$/i, '');
              let bpm = 72;
              let key = 'G';
              const bpmMatch = cleanName.match(/\b(\d{2,3})\s*bpm\b/i);
              if (bpmMatch) bpm = parseInt(bpmMatch[1], 10);

              const keyMatch = cleanName.match(/\b([A-G][#b]?m?)\b/);
              if (keyMatch) key = keyMatch[1];

              const parts = cleanName.split(' - ').map((s) => s.trim());
              const title = parts[0] || cleanName;
              const artist = parts[1] || 'Ministério de Louvor';

              newSongs.push({
                id: `gdrive_zip_${zf.id}`,
                title,
                artist,
                bpm,
                key,
                beatsPerBar: 4,
                durationSec: 280,
                zipFileId: zf.id,
                zipDownloadUrl: `https://www.googleapis.com/drive/v3/files/${zf.id}?alt=media`,
                zipFileSize: zf.size ? parseInt(zf.size, 10) : undefined,
                provider: 'gdrive',
                addedAt: new Date().toISOString(),
                stems: [],
              });
            }
          }
        } catch (zipErr) {
          console.warn('Erro ao escanear pacotes ZIP no Google Drive:', zipErr);
        }
      } catch (err) {
        onProgress?.(`❌ Erro no sync: ${(err as Error).message}`);
        throw err;
      }
    }

    // Atualiza o catálogo diretamente com a lista atual do Google Drive
    this.saveCatalog(newSongs);
    this.saveMasterConfig({
      lastSyncTime: new Date().toISOString(),
      totalSyncedSongs: newSongs.length,
    });
    return { count: newSongs.length, songs: newSongs };
  }

  /**
   * Downloads a song from the central catalog directly into the user's IndexedDB and builds
   * the canonical stage mixer with zero latency.
   */
  async downloadSongToRepertoire(
    catalogSong: CatalogSong,
    ctx: AudioContext,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<Song & { _preloadedBuffers: Map<string, AudioBuffer> }> {
    const songId = uid('song');
    let maxDuration = catalogSong.durationSec || 240;
    const initialTracks: Track[] = [];
    const preloadedBuffers = new Map<string, AudioBuffer>();
    const sharedSplitCache = new Map<
      string,
      { clickBuffer: AudioBuffer; guideBuffer: AudioBuffer; clickWav: ArrayBuffer; guideWav: ArrayBuffer }
    >();

    // 1. Caso especial: Pacote MultiTrack .ZIP completo vindo do Google Drive
    if (catalogSong.zipDownloadUrl) {
      onProgress({
        statusText: `Transferindo pacote ZIP de "${catalogSong.title}" do servidor central…`,
        percent: 15,
      });

      const token = await this.getAccessToken();
      const resp = await cloudFetch(catalogSong.zipDownloadUrl, {
        authHeader: token ? `Bearer ${token.trim()}` : undefined,
      });

      if (!resp.ok) {
        throw new Error(`Falha ao baixar pacote ZIP do Google Drive: HTTP ${resp.status}`);
      }

      onProgress({
        statusText: 'A descompactar ficheiros de áudio…',
        percent: 45,
      });

      const zipBuf = await resp.arrayBuffer();
      const extracted = await processZipFile(
        { name: `${catalogSong.title}.zip`, data: zipBuf },
        (msg) => onProgress({ statusText: msg, percent: 60 }),
      );

      if (extracted.length === 0) {
        throw new Error('Nenhum arquivo de áudio (.wav, .mp3, .m4a) encontrado dentro do pacote ZIP baixado.');
      }

      onProgress({
        statusText: `Decodificando ${extracted.length} canais de áudio descompactados…`,
        percent: 75,
      });

      let duration = 0;
      for (let i = 0; i < extracted.length; i++) {
        const it = extracted[i];
        onProgress({
          statusText: `Processando canal (${i + 1}/${extracted.length}): ${it.name}…`,
          percent: Math.round(75 + (i / extracted.length) * 20),
          currentTrackName: it.name,
        });

        const decoded = await decodeAudioDataSafe(ctx, it.data.slice(0));
        if (isFinite(decoded.duration) && decoded.duration > 0) {
          duration = Math.max(duration, decoded.duration);
        }

        const g = guessTrack(it.name, i, catalogSong.title);

        if (
          isCombinedClickGuide(it.name) ||
          ((g.kind === 'click' || g.kind === 'guide') && isDualChannelClickGuide(decoded))
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
            fileName: it.name,
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
            fileName: it.name,
          });
        } else {
          const trId = uid('tr');
          await saveStem(songId, trId, it.data);
          preloadedBuffers.set(trId, decoded);
          initialTracks.push({
            id: trId,
            name: g.name,
            color: g.color,
            kind: g.kind,
            bus: g.bus,
            output: g.output,
            volume: g.kind === 'click' ? 0.75 : 0.85,
            pan: 0,
            mute: false,
            solo: false,
            fileName: it.name,
          });
        }
      }

      const song: Song & { _preloadedBuffers: Map<string, AudioBuffer> } = {
        id: songId,
        name: catalogSong.title,
        artist: catalogSong.artist,
        bpm: catalogSong.bpm,
        key: catalogSong.key,
        pitchOffset: 0,
        beatsPerBar: catalogSong.beatsPerBar || 4,
        firstBeat: 0,
        duration: Math.round(duration || catalogSong.durationSec || 240),
        guideMode: 'REANNOUNCE',
        sections: [],
        tracks: orderTracksForStage(initialTracks),
        source: 'import',
        _preloadedBuffers: preloadedBuffers,
      };

      song.sections = detectSectionsFromAudio(song);
      song.chordChart = generateChordChartForSong(song, 'modern');

      onProgress({ statusText: `✅ "${song.name}" importada com sucesso!`, percent: 100 });
      return song;
    }

    onProgress({
      statusText: `Iniciando download de "${catalogSong.title}" (${catalogSong.stems.length} faixas do servidor central)…`,
      percent: 5,
    });

    for (let i = 0; i < catalogSong.stems.length; i++) {
      const stem = catalogSong.stems[i];
      onProgress({
        statusText: `Baixando faixa (${i + 1}/${catalogSong.stems.length}): ${stem.name}…`,
        percent: Math.round(10 + (i / catalogSong.stems.length) * 80),
        currentTrackName: stem.name,
      });

      const trId = uid('tr');
      let audioBuffer: AudioBuffer;
      let rawArrayBuffer: ArrayBuffer;

      // Handle combined Click & Guide tracks with stereo separation
      const isCombined = stem.isCombinedStereoSplit || isCombinedClickGuide(stem.name) || isCombinedClickGuide(stem.fileName);

      if (stem.downloadUrl) {
        try {
          const cacheKey = stem.fileId || stem.downloadUrl || stem.fileName;
          if (isCombined) {
            let split = sharedSplitCache.get(cacheKey);
            if (!split) {
              const token = await this.getAccessToken();
              const resp = await cloudFetch(stem.downloadUrl, {
                authHeader: token ? `Bearer ${token.trim()}` : undefined,
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const fullBuffer = await resp.arrayBuffer();
              const decoded = await decodeAudioDataSafe(ctx, fullBuffer.slice(0));
              split = splitStereoClickGuide(ctx, decoded);
              sharedSplitCache.set(cacheKey, split);
            }
            const isClick = stem.kind === 'click' || stem.splitChannel === 'left';
            audioBuffer = isClick ? split.clickBuffer : split.guideBuffer;
            rawArrayBuffer = isClick ? split.clickWav : split.guideWav;
          } else {
            const token = await this.getAccessToken();
            const resp = await cloudFetch(stem.downloadUrl, {
              authHeader: token ? `Bearer ${token.trim()}` : undefined,
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            rawArrayBuffer = await resp.arrayBuffer();
            audioBuffer = await decodeAudioDataSafe(ctx, rawArrayBuffer.slice(0));

            // If audio file has 2 channels with Click on Left and Guide on Right, split immediately!
            if (
              (stem.kind === 'click' || stem.kind === 'guide' || isCombinedClickGuide(stem.name) || isCombinedClickGuide(stem.fileName)) &&
              isDualChannelClickGuide(audioBuffer)
            ) {
              const split = splitStereoClickGuide(ctx, audioBuffer);
              const isClick = stem.kind === 'click' || stem.name.toLowerCase().includes('click');
              audioBuffer = isClick ? split.clickBuffer : split.guideBuffer;
              rawArrayBuffer = isClick ? split.clickWav : split.guideWav;

              // Ensure the corresponding companion track (Guide or Click) is also created
              const otherKind = isClick ? 'guide' : 'click';
              if (!catalogSong.stems.some((s) => s.kind === otherKind) && !initialTracks.some((t) => t.kind === otherKind)) {
                const otherId = uid(isClick ? 'tr_guide' : 'tr_click');
                const otherBuf = isClick ? split.guideBuffer : split.clickBuffer;
                const otherWav = isClick ? split.guideWav : split.clickWav;
                await saveStem(songId, otherId, otherWav);
                preloadedBuffers.set(otherId, otherBuf);
                initialTracks.push({
                  id: otherId,
                  name: isClick ? 'GUIDE (Áudio Original)' : 'CLICK (Áudio Original)',
                  color: isClick ? '#0099FF' : '#F39C12',
                  kind: 'audio',
                  bus: 'UTILITY',
                  output: isClick ? 'OUT_5' : 'OUT_6',
                  volume: isClick ? 0.9 : 0.75,
                  pan: 0,
                  mute: false,
                  solo: false,
                  pitchShift: false,
                  fileName: stem.fileName,
                });
              }
            }
          }
          if (audioBuffer.duration > maxDuration) maxDuration = audioBuffer.duration;
        } catch (e) {
          console.warn(`Fallback para síntese na faixa ${stem.name}:`, e);
          const syn = this.generateSyntheticStemBuffer(ctx, stem, catalogSong.bpm, maxDuration);
          audioBuffer = syn.buf;
          rawArrayBuffer = syn.raw;
        }
      } else {
        // High fidelity musical synth stem
        const syn = this.generateSyntheticStemBuffer(ctx, stem, catalogSong.bpm, maxDuration);
        audioBuffer = syn.buf;
        rawArrayBuffer = syn.raw;
      }

      // Save raw bytes to IndexedDB for offline zero-latency stage playback
      await saveStem(songId, trId, rawArrayBuffer);
      preloadedBuffers.set(trId, audioBuffer);

      let finalName = stem.name;
      const lowStem = stem.name.toLowerCase();
      if ((stem.kind === 'click' || lowStem.includes('click') || lowStem.includes('clique')) && !finalName.includes('(Áudio Original)')) {
        finalName = 'CLICK (Áudio Original)';
      } else if ((stem.kind === 'guide' || lowStem.includes('guide') || lowStem.includes('guia') || lowStem.includes('cue')) && !finalName.includes('(Áudio Original)')) {
        finalName = 'GUIDE (Áudio Original)';
      }

      initialTracks.push({
        id: trId,
        name: finalName,
        color: this.getStemColor(stem),
        kind: 'audio',
        bus: stem.bus || (stem.kind === 'click' || stem.kind === 'guide' ? 'UTILITY' : 'KEYS'),
        output: stem.output || (stem.kind === 'click' || finalName.includes('CLICK') ? 'OUT_6' : stem.kind === 'guide' || finalName.includes('GUIDE') ? 'OUT_5' : 'OUT_1_2'),
        volume: stem.kind === 'click' || finalName.includes('CLICK') ? 0.75 : 0.85,
        pan: 0,
        mute: false,
        solo: false,
        pitchShift: stem.kind === 'audio' && stem.bus !== 'DRUMS',
        fileName: stem.fileName,
      });
    }

    const orderedTracks = orderTracksForStage(initialTracks);

    const newSong: Song & { _preloadedBuffers: Map<string, AudioBuffer> } = {
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
      duration: Math.round(maxDuration),
      guideMode: 'REANNOUNCE',
      transitionAfter: 'AUTO_ADVANCE',
      sections: [],
      tracks: orderedTracks,
      source: 'import',
      _preloadedBuffers: preloadedBuffers,
    };

    newSong.sections = detectSectionsFromAudio(newSong);
    newSong.chordChart = generateChordChartForSong(newSong);

    onProgress({
      statusText: `✅ "${newSong.name}" baixada e organizada com sucesso! (${orderedTracks.length} canais prontos)`,
      percent: 100,
    });

    return newSong;
  }

  private getStemColor(stem: CatalogStem): string {
    if (stem.kind === 'click') return '#F39C12';
    if (stem.kind === 'guide') return '#0099FF';
    switch (stem.bus) {
      case 'DRUMS':
        return '#E5484D';
      case 'BASS':
        return '#8E5CF6';
      case 'GUITARS':
        return '#F2994A';
      case 'KEYS':
        return '#2F80ED';
      case 'VOCALS':
        return '#EB5FA8';
      default:
        return '#2ECC71';
    }
  }

  /**
   * Generates a high-quality, lightweight AudioBuffer for preview/fallback
   */
  private generateSyntheticStemBuffer(
    ctx: AudioContext,
    stem: CatalogStem,
    bpm: number,
    durationSec: number,
  ): { buf: AudioBuffer; raw: ArrayBuffer } {
    const sampleRate = ctx.sampleRate || 44100;
    const totalSamples = Math.floor(Math.min(durationSec, 360) * sampleRate);
    const buf = ctx.createBuffer(2, totalSamples, sampleRate);
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);

    const beatIntervalSec = 60 / bpm;
    const beatSamples = Math.floor(beatIntervalSec * sampleRate);

    // Render sound according to stem type
    if (stem.kind === 'click') {
      for (let s = 0; s < totalSamples; s += beatSamples) {
        const beatNum = Math.floor(s / beatSamples) % 4;
        const freq = beatNum === 0 ? 1200 : 800;
        const clickLen = Math.floor(sampleRate * 0.02);
        for (let i = 0; i < clickLen && s + i < totalSamples; i++) {
          const env = Math.exp(-i / (sampleRate * 0.005));
          const val = Math.sin((2 * Math.PI * freq * i) / sampleRate) * env * 0.5;
          l[s + i] = val;
          r[s + i] = val;
        }
      }
    } else if (stem.bus === 'DRUMS') {
      for (let s = 0; s < totalSamples; s += beatSamples) {
        const beatNum = Math.floor(s / beatSamples) % 4;
        const isKick = beatNum === 0 || beatNum === 2;
        const len = Math.floor(sampleRate * 0.08);
        for (let i = 0; i < len && s + i < totalSamples; i++) {
          const env = Math.exp(-i / (sampleRate * 0.02));
          const f = isKick ? 80 * Math.exp(-i / (sampleRate * 0.015)) : 220;
          const val = (Math.sin((2 * Math.PI * f * i) / sampleRate) + (Math.random() - 0.5) * 0.3) * env * 0.4;
          l[s + i] = val;
          r[s + i] = val;
        }
      }
    } else if (stem.bus === 'BASS') {
      const rootFreq = 55; // A1
      for (let i = 0; i < totalSamples; i++) {
        const t = i / sampleRate;
        const vibrato = Math.sin(t * 4) * 0.5;
        const val = Math.sin((2 * Math.PI * (rootFreq + vibrato) * i) / sampleRate) * 0.25;
        l[i] = val;
        r[i] = val;
      }
    } else if (stem.bus === 'KEYS' || stem.bus === 'GUITARS') {
      // Warm atmospheric harmonic chord
      const freqs = [220, 277.18, 329.63, 440];
      for (let i = 0; i < totalSamples; i++) {
        let val = 0;
        for (const f of freqs) {
          val += Math.sin((2 * Math.PI * f * i) / sampleRate) * 0.06;
        }
        l[i] = val;
        r[i] = val;
      }
    }

    // Convert audio buffer to simple 16-bit PCM WAV ArrayBuffer for IndexedDB persistence
    const raw = this.audioBufferToWavArrayBuffer(buf);
    return { buf, raw };
  }

  private audioBufferToWavArrayBuffer(buf: AudioBuffer): ArrayBuffer {
    const numChannels = 2;
    const sampleRate = buf.sampleRate;
    const length = buf.length * numChannels * 2;
    const buffer = new ArrayBuffer(44 + length);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, length, true);

    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    let offset = 44;
    for (let i = 0; i < buf.length; i++) {
      const s0 = Math.max(-1, Math.min(1, ch0[i])) * 32767;
      const s1 = Math.max(-1, Math.min(1, ch1[i])) * 32767;
      view.setInt16(offset, s0, true);
      view.setInt16(offset + 2, s1, true);
      offset += 4;
    }

    return buffer;
  }
}

export const masterCatalogService = new MasterCatalogService();
