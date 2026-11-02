import { invoke } from '@tauri-apps/api/core';
import JSZip from 'jszip';

export interface ExtractedAudioCandidate {
  name: string;
  data: ArrayBuffer;
  path?: string;
}

/** Check if running inside Tauri desktop app */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
}

/**
 * Extracts a multitrack .zip file using the high-performance native Rust engine.
 * Returns an array of absolute file paths to all valid extracted audio files (.wav, .mp3, .m4a, etc.).
 */
export async function extractMultitrackZipNative(zipPath: string): Promise<string[]> {
  return await invoke<string[]>('extract_multitrack_zip', { zipPath });
}

/**
 * Extracts a multitrack .zip from in-memory bytes using the native Rust engine.
 */
export async function extractMultitrackZipBytesNative(
  zipBytes: Uint8Array | ArrayBuffer,
  zipName?: string,
): Promise<string[]> {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  return await invoke<string[]>('extract_multitrack_zip_bytes', {
    zipBytes: Array.from(bytes),
    zipName,
  });
}

/**
 * Reads an extracted audio file from disk into an ArrayBuffer via native Rust.
 */
export async function readAudioFileNative(filePath: string): Promise<ArrayBuffer> {
  const res: any = await invoke('read_audio_file', { filePath });
  if (res instanceof ArrayBuffer) return res;
  if (ArrayBuffer.isView(res)) {
    return (res.buffer as ArrayBuffer).slice(res.byteOffset, res.byteOffset + res.byteLength);
  }
  if (Array.isArray(res)) {
    return new Uint8Array(res).buffer;
  }
  return res as ArrayBuffer;
}

/**
 * High-level helper: extracts a .zip file (via native Rust if in Tauri, or JSZip fallback)
 * and returns ready-to-use audio candidates with their data and names.
 */
export async function processZipFile(
  file: File | { name: string; path?: string; data?: ArrayBuffer; size?: number },
  onProgress?: (msg: string) => void,
): Promise<ExtractedAudioCandidate[]> {
  onProgress?.('A verificar integridade do ficheiro ZIP…');

  // 1. Verificação prévia de Hidratação / Tamanho Local (Placeholders da Nuvem)
  if (file instanceof File && file.size === 0) {
    throw new Error(
      `O arquivo "${file.name}" possui 0 bytes. Trata-se de um placeholder sob demanda da nuvem (Google Drive / OneDrive). Clique com o botão direito no arquivo no Windows Explorer e selecione "Sempre manter neste dispositivo" antes de importar.`
    );
  }

  const filePath = (file as any).path as string | undefined;

  // 2. Extração nativa em Rust (Zero-Copy, Streaming em Chunks de 64KB, Thread Assíncrona Tokio)
  if (isTauri() && filePath) {
    try {
      onProgress?.('A descompactar pacote multitrack em stream…');
      const audioPaths = await extractMultitrackZipNative(filePath);
      const candidates: ExtractedAudioCandidate[] = [];

      for (let i = 0; i < audioPaths.length; i++) {
        const p = audioPaths[i];
        const baseName = p.split(/[/\\]/).pop() || `track_${i}.wav`;
        onProgress?.(`A carregar faixas de áudio (${i + 1}/${audioPaths.length}): ${baseName}…`);
        try {
          const ab = await readAudioFileNative(p);
          candidates.push({
            name: baseName,
            data: ab,
            path: p,
          });
        } catch (trackErr) {
          console.error(`[ZipExtractor] Falha ao ler track ${i + 1}/${audioPaths.length} (${baseName}):`, trackErr);
        }
      }

      if (candidates.length > 0) {
        return candidates;
      }
    } catch (rustErr: any) {
      console.warn('[ZipExtractor] Erro na extração nativa por path:', rustErr);
      const errMsg = typeof rustErr === 'string' ? rustErr : rustErr?.message || String(rustErr);
      if (
        errMsg.includes('placeholder') ||
        errMsg.includes('0 bytes') ||
        errMsg.includes('Google Drive') ||
        errMsg.includes('não é um arquivo ZIP válido')
      ) {
        throw new Error(errMsg);
      }
    }
  }

  // 3. Se estiver no Tauri mas sem path direto (ex: buffer em memória)
  if (isTauri()) {
    try {
      const arrayBuf = 'data' in file && file.data ? file.data : await (file as File).arrayBuffer();
      if (arrayBuf.byteLength === 0) {
        throw new Error(`O arquivo "${file.name}" está vazio (0 bytes).`);
      }
      onProgress?.('A descompactar dados multitrack em stream nativo…');
      const audioPaths = await extractMultitrackZipBytesNative(arrayBuf, file.name);
      const candidates: ExtractedAudioCandidate[] = [];

      for (let i = 0; i < audioPaths.length; i++) {
        const p = audioPaths[i];
        const baseName = p.split(/[/\\]/).pop() || `track_${i}.wav`;
        onProgress?.(`A carregar faixas de áudio (${i + 1}/${audioPaths.length}): ${baseName}…`);
        try {
          const ab = await readAudioFileNative(p);
          candidates.push({
            name: baseName,
            data: ab,
            path: p,
          });
        } catch (trackErr) {
          console.error(`[ZipExtractor] Falha ao ler track ${i + 1}/${audioPaths.length} (${baseName}):`, trackErr);
        }
      }

      if (candidates.length > 0) {
        return candidates;
      }
    } catch (rustErr: any) {
      console.warn('[ZipExtractor] Erro na extração nativa por bytes:', rustErr);
    }
  }

  // 4. Fallback JSZip (para navegador web ou fallback de contingência)
  onProgress?.('A descompactar arquivo (fallback JSZip)…');
  const arrayBuf = 'data' in file && file.data ? file.data : await (file as File).arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuf);
  const candidates: ExtractedAudioCandidate[] = [];
  const entries = Object.keys(zip.files);

  for (const en of entries) {
    const ze = zip.files[en];
    if (ze.dir) continue;
    const bName = (en.split(/[/\\]/).pop() || en).trim();
    if (bName.startsWith('._') || bName === '.DS_Store' || en.includes('__MACOSX')) continue;
    if (/\.(wav|wave|mp3|m4a|mp4|aac|ogg|flac|aif|aiff|wma|alac|caf|opus|webm|weba)$/i.test(bName)) {
      onProgress?.(`A extrair faixa: ${bName}…`);
      const buf = await ze.async('arraybuffer');
      if (buf.byteLength > 100) {
        candidates.push({ name: bName, data: buf });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error('Nenhum arquivo de áudio compatível (.wav, .mp3, etc.) foi encontrado dentro do pacote ZIP.');
  }

  return candidates;
}
