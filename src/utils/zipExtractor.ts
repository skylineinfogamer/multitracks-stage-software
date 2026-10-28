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
  const bytes = await invoke<number[]>('read_audio_file', { filePath });
  const u8 = new Uint8Array(bytes);
  return u8.buffer as ArrayBuffer;
}

/**
 * High-level helper: extracts a .zip file (via native Rust if in Tauri, or JSZip fallback)
 * and returns ready-to-use audio candidates with their data and names.
 */
export async function processZipFile(
  file: File | { name: string; path?: string; data?: ArrayBuffer },
  onProgress?: (msg: string) => void,
): Promise<ExtractedAudioCandidate[]> {
  onProgress?.('A descompactar ficheiros de áudio…');

  const filePath = (file as any).path as string | undefined;

  // 1. If in Tauri and we have a local file path, use zero-copy native extraction
  if (isTauri() && filePath) {
    try {
      const audioPaths = await extractMultitrackZipNative(filePath);
      const candidates: ExtractedAudioCandidate[] = [];

      for (let i = 0; i < audioPaths.length; i++) {
        const p = audioPaths[i];
        const baseName = p.split(/[/\\]/).pop() || `track_${i}.wav`;
        onProgress?.(`A descompactar ficheiros de áudio (${i + 1}/${audioPaths.length}): ${baseName}…`);
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

      return candidates;
    } catch (rustErr) {
      console.warn('[ZipExtractor] Erro na extração nativa por path, tentando fallback:', rustErr);
    }
  }

  // 2. If in Tauri but file is in memory (or no direct path), use native bytes extraction
  if (isTauri()) {
    try {
      const arrayBuf = 'data' in file && file.data ? file.data : await (file as File).arrayBuffer();
      const audioPaths = await extractMultitrackZipBytesNative(arrayBuf, file.name);
      const candidates: ExtractedAudioCandidate[] = [];

      for (let i = 0; i < audioPaths.length; i++) {
        const p = audioPaths[i];
        const baseName = p.split(/[/\\]/).pop() || `track_${i}.wav`;
        onProgress?.(`A descompactar ficheiros de áudio (${i + 1}/${audioPaths.length}): ${baseName}…`);
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

      return candidates;
    } catch (rustErr) {
      console.warn('[ZipExtractor] Erro na extração nativa por bytes, tentando fallback JSZip:', rustErr);
    }
  }

  // 3. Fallback: JSZip (for browser environment or if native call fails)
  const arrayBuf = 'data' in file && file.data ? file.data : await (file as File).arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuf);
  const candidates: ExtractedAudioCandidate[] = [];
  const entries = Object.keys(zip.files);

  for (const en of entries) {
    const ze = zip.files[en];
    if (ze.dir) continue;
    const bName = en.split('/').pop() || en;
    if (bName.startsWith('.') || en.includes('__MACOSX')) continue;
    if (/\.(wav|wave|mp3|m4a|aac|ogg|flac|aif|aiff)$/i.test(bName)) {
      onProgress?.(`A extrair faixa: ${bName}…`);
      const buf = await ze.async('arraybuffer');
      candidates.push({ name: bName, data: buf });
    }
  }

  return candidates;
}
