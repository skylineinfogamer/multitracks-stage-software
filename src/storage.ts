import type { ClickSound, ClickSubdivision, MidiMapping, OutputBus, PadFolderBank, PadSound, Setlist, Song, TransitionMode } from './types';

const DB_NAME = 'worship-playback-pro';
const STORE = 'stems';
const LS_KEY = 'wpp-state-v2';

let dbInstance: IDBDatabase | null = null;
let dbOpenPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbOpenPromise) return dbOpenPromise;

  dbOpenPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      dbInstance = req.result;
      dbInstance.onclose = () => {
        dbInstance = null;
        dbOpenPromise = null;
      };
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbOpenPromise = null;
      };
      resolve(dbInstance);
    };
    req.onerror = () => {
      dbOpenPromise = null;
      reject(req.error);
    };
  });
  return dbOpenPromise;
}

/**
 * Carrega todos os stems de uma música em uma única transação atômica do IndexedDB.
 * Reduz drasticamente a sobrecarga de I/O e evita travamentos ou canais ausentes.
 * Agora suporta AbortSignal para cancelamento limpo durante navegação rápida.
 */
export async function loadSongStemsMap(
  songId: string,
  trackIds: string[],
  signal?: AbortSignal
): Promise<Map<string, ArrayBuffer>> {
  const db = await openDb();
  const map = new Map<string, ArrayBuffer>();
  if (!trackIds.length) return map;

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return new Promise<Map<string, ArrayBuffer>>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort);

    try {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      let pending = trackIds.length;
      let completed = false;

      const finishOne = () => {
        pending--;
        if (pending <= 0 && !completed) {
          completed = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(map);
        }
      };

      for (const tid of trackIds) {
        if (signal?.aborted) {
          completed = true;
          signal?.removeEventListener('abort', onAbort);
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }

        const req = store.get(`${songId}:${tid}`);
        req.onsuccess = async () => {
          if (signal?.aborted) {
            completed = true;
            signal?.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          const val = req.result;
          if (val) {
            if (val instanceof ArrayBuffer) {
              map.set(tid, val);
            } else if (ArrayBuffer.isView(val)) {
              const v = val as ArrayBufferView;
              map.set(tid, (v.buffer as ArrayBuffer).slice(v.byteOffset, v.byteOffset + v.byteLength));
            } else if (val instanceof Blob) {
              try {
                const ab = await val.arrayBuffer();
                map.set(tid, ab);
              } catch (e) {
                console.warn('Erro ao ler blob de áudio no IndexedDB:', e);
              }
            }
          }
          finishOne();
        };
        req.onerror = () => finishOne();
      }

      tx.onerror = () => {
        if (!completed) {
          completed = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(map);
        }
      };
      tx.onabort = () => {
        if (!completed) {
          completed = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(map);
        }
      };
    } catch (err) {
      console.warn('Falha na transação batch IndexedDB:', err);
      signal?.removeEventListener('abort', onAbort);
      resolve(map);
    }
  });
}

/**
 * Store a single stem as Blob or ArrayBuffer under key `${songId}:${trackId}`.
 */
export async function saveStem(
  songId: string,
  trackId: string,
  data: Blob | ArrayBuffer | Uint8Array,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const payload = data instanceof Uint8Array ? data.buffer : data;
    tx.objectStore(STORE).put(payload, `${songId}:${trackId}`);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Legacy + per-track stem loader. Returns a Map of trackId -> ArrayBuffer (one at a time). */
export async function loadStemBuffer(songId: string, trackId: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  const val = await new Promise<any>((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).get(`${songId}:${trackId}`);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  if (!val) return undefined;
  if (val instanceof ArrayBuffer) return val;
  if (ArrayBuffer.isView(val)) {
    const v = val as ArrayBufferView;
    const buf = (v.buffer as ArrayBuffer).slice(v.byteOffset, v.byteOffset + v.byteLength);
    return buf;
  }
  if (val instanceof Blob) {
    try {
      return await val.arrayBuffer();
    } catch (e) {
      console.warn('Aviso ao ler Blob do IndexedDB via arrayBuffer():', e);
      return undefined;
    }
  }
  return undefined;
}

export async function loadStems(
  songId: string,
  trackIds?: string[],
): Promise<Record<string, ArrayBuffer> | undefined> {
  const db = await openDb();
  // First check if individual per-track entries exist
  if (trackIds && trackIds.length > 0) {
    const out: Record<string, ArrayBuffer> = {};
    for (const tid of trackIds) {
      const buf = await loadStemBuffer(songId, tid);
      if (buf) out[tid] = buf;
    }
    if (Object.keys(out).length > 0) return out;
  }
  // Fallback for legacy single-record format
  return new Promise<Record<string, ArrayBuffer> | undefined>((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).get(songId);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function deleteStems(songId: string, trackIds: string[] = []) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  store.delete(songId);
  for (const tid of trackIds) {
    store.delete(`${songId}:${tid}`);
  }
}

/** Save a custom user Pad audio file for a musical key (e.g. 'C', 'C#', 'D'...). */
export async function saveCustomPad(noteKey: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, `custom_pad:${noteKey}`);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Load a custom user Pad audio ArrayBuffer for a musical key. */
export async function loadCustomPadBuffer(noteKey: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  const val = await new Promise<Blob | ArrayBuffer | undefined>((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).get(`custom_pad:${noteKey}`);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  if (val instanceof Blob) return await val.arrayBuffer();
  if (val instanceof ArrayBuffer) return val;
  return undefined;
}

/** Save a pad audio file inside a specific named Pad Folder Bank. */
export async function savePadBankFile(bankId: string, noteKey: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, `pad_bank:${bankId}:${noteKey}`);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Load a pad audio ArrayBuffer from a specific named Pad Folder Bank. */
export async function loadPadBankBuffer(bankId: string, noteKey: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  const val = await new Promise<Blob | ArrayBuffer | undefined>((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).get(`pad_bank:${bankId}:${noteKey}`);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  if (val instanceof Blob) return await val.arrayBuffer();
  if (val instanceof ArrayBuffer) return val;
  // Fallback to legacy custom_pad:${noteKey} if bankId is default or not found
  if (bankId === 'default' || !bankId) {
    return loadCustomPadBuffer(noteKey);
  }
  return undefined;
}

/** Delete all audio storage keys associated with a Pad Folder Bank. */
export async function deletePadBankStorage(bankId: string, keys: string[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const k of keys) {
    store.delete(`pad_bank:${bankId}:${k}`);
    if (bankId === 'default') {
      store.delete(`custom_pad:${k}`);
    }
  }
}

/** Save a downloaded Neural Guide Voice audio clip in IndexedDB for permanent offline playback. */
export async function saveGuideClip(clipKey: string, ab: ArrayBuffer): Promise<void> {
  const db = await openDb();
  const blob = new Blob([ab], { type: 'audio/mpeg' });
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, `guide_clip:${clipKey}`);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Load a downloaded Neural Guide Voice audio clip from IndexedDB. */
export async function loadGuideClip(clipKey: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  const val = await new Promise<Blob | ArrayBuffer | undefined>((res, rej) => {
    const req = db.transaction(STORE).objectStore(STORE).get(`guide_clip:${clipKey}`);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  if (val instanceof Blob) return await val.arrayBuffer();
  if (val instanceof ArrayBuffer) return val;
  return undefined;
}

/** Valida se o arquivo é um candidato real de áudio, suportando todos os formatos profissionais de multitracks */
export function isValidAudioCandidate(file: File): boolean {
  const name = file.name.trim();
  // Ignora apenas garfos de recursos do macOS (._*) e arquivos de lixo do sistema
  if (name.startsWith('._') || name === '.DS_Store' || name === '__MACOSX' || name.includes('__MACOSX/')) {
    return false;
  }
  // Se for arquivo oculto do Mac com tamanho mínimo (< 4KB), ignora
  if (name.startsWith('.') && file.size < 4096) return false;
  if (file.size < 100) return false;

  return (
    file.type.startsWith('audio') ||
    /\.(wav|wave|mp3|m4a|mp4|aac|ogg|flac|aif|aiff|wma|alac|caf|opus|webm|weba)$/i.test(name)
  );
}

/**
 * Ensures any buffer, ArrayBufferView, or byte array is returned as a pure ArrayBuffer.
 */
export function ensureArrayBuffer(input: any): ArrayBuffer {
  if (!input) return new ArrayBuffer(0);
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) {
    return (input.buffer as ArrayBuffer).slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  if (Array.isArray(input)) {
    return new Uint8Array(input).buffer;
  }
  return input as ArrayBuffer;
}

/**
 * Pure-JS fallback decoder for WAV / BWF / RF64 / WAVE_FORMAT_EXTENSIBLE (8/16/24/32-bit PCM & 32/64-bit Float)
 * and AIFF / AIFC files when Chromium's native decodeAudioData rejects professional DAW headers.
 */
export function decodePcmContainerFallback(ctx: BaseAudioContext, input: any): AudioBuffer | null {
  try {
    const ab = ensureArrayBuffer(input);
    const view = new DataView(ab);
    if (view.byteLength < 44) return null;
    const magic0 = view.getUint32(0, false);
    const magic8 = view.getUint32(8, false);

    // 1. WAV / BWF / RF64 / BW64 ("RIFF" 0x52494646 or "RF64" 0x52463634 or "BW64" 0x42573634) + "WAVE" (0x57415645)
    if ((magic0 === 0x52494646 || magic0 === 0x52463634 || magic0 === 0x42573634) && magic8 === 0x57415645) {
      let offset = 12;
      let audioFormat = 1; // 1 = PCM, 3 = IEEE Float, 0xFFFE = Extensible
      let channels = 2;
      let sampleRate = 44100;
      let bitsPerSample = 16;
      let blockAlign = 4;
      let dataOffset = -1;
      let dataSize = 0;

      while (offset + 8 <= view.byteLength) {
        const chunkId = view.getUint32(offset, false);
        const chunkSize = view.getUint32(offset + 4, true);
        const payload = offset + 8;

        if (chunkId === 0x666d7420 && payload + 16 <= view.byteLength) {
          // "fmt "
          audioFormat = view.getUint16(payload, true);
          channels = Math.max(1, Math.min(32, view.getUint16(payload + 2, true)));
          sampleRate = view.getUint32(payload + 4, true) || 44100;
          blockAlign = view.getUint16(payload + 12, true);
          bitsPerSample = view.getUint16(payload + 14, true);
          // WAVE_FORMAT_EXTENSIBLE (0xFFFE): subFormat code is at payload + 24
          if (audioFormat === 0xfffe && chunkSize >= 40 && payload + 26 <= view.byteLength) {
            audioFormat = view.getUint16(payload + 24, true);
          }
        } else if (chunkId === 0x64617461) {
          // "data"
          dataOffset = payload;
          const remaining = view.byteLength - payload;
          dataSize = chunkSize > 0 && chunkSize <= remaining ? chunkSize : remaining;
          break;
        }
        if (chunkSize > view.byteLength) break;
        offset = payload + chunkSize + (chunkSize % 2);
      }

      if (dataOffset < 0 || dataSize <= 0) return null;
      const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));
      const frameBytes = blockAlign > 0 ? blockAlign : channels * bytesPerSample;
      const numFrames = Math.floor(dataSize / frameBytes);
      if (numFrames <= 0) return null;

      const outChannels = Math.min(2, channels);
      const audioBuf = ctx.createBuffer(outChannels, numFrames, sampleRate);
      const chData: Float32Array[] = [];
      for (let c = 0; c < outChannels; c++) chData.push(audioBuf.getChannelData(c));

      // Fast path 1: 16-bit PCM (WAV) - 95% of multitracks
      if (audioFormat === 1 && bitsPerSample === 16 && dataOffset % 2 === 0) {
        try {
          const totalSamples = numFrames * channels;
          const i16 = new Int16Array(ab, dataOffset, totalSamples);
          for (let i = 0; i < numFrames; i++) {
            const frameIdx = i * channels;
            for (let c = 0; c < outChannels; c++) {
              chData[c][i] = i16[frameIdx + c] / 32768;
            }
          }
          return audioBuf;
        } catch {
          // Fall through to generic loop
        }
      }

      // Fast path 2: 32-bit Float PCM (WAV)
      if (audioFormat === 3 && bitsPerSample === 32 && dataOffset % 4 === 0) {
        try {
          const totalSamples = numFrames * channels;
          const f32 = new Float32Array(ab, dataOffset, totalSamples);
          for (let i = 0; i < numFrames; i++) {
            const frameIdx = i * channels;
            for (let c = 0; c < outChannels; c++) {
              chData[c][i] = f32[frameIdx + c];
            }
          }
          return audioBuf;
        } catch {
          // Fall through to generic loop
        }
      }

      let ptr = dataOffset;
      for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < outChannels; c++) {
          const samplePos = ptr + c * bytesPerSample;
          if (samplePos + bytesPerSample > view.byteLength) break;
          let val = 0;
          if (audioFormat === 3 && bitsPerSample === 32) {
            val = view.getFloat32(samplePos, true);
          } else if (audioFormat === 3 && bitsPerSample === 64) {
            val = view.getFloat64(samplePos, true);
          } else if (bitsPerSample === 16) {
            val = view.getInt16(samplePos, true) / 32768;
          } else if (bitsPerSample === 24) {
            const b0 = view.getUint8(samplePos);
            const b1 = view.getUint8(samplePos + 1);
            const b2 = view.getUint8(samplePos + 2);
            const i24 = ((b2 << 24) | (b1 << 16) | (b0 << 8)) >> 8;
            val = i24 / 8388608;
          } else if (bitsPerSample === 32) {
            val = view.getInt32(samplePos, true) / 2147483648;
          } else if (bitsPerSample === 8) {
            val = (view.getUint8(samplePos) - 128) / 128;
          }
          chData[c][i] = isFinite(val) ? Math.max(-1, Math.min(1, val)) : 0;
        }
        ptr += frameBytes;
      }
      return audioBuf;
    }

    // 2. AIFF ("FORM" 0x464F524D + "AIFF" 0x41494646)
    if (magic0 === 0x464f524d && magic8 === 0x41494646) {
      let offset = 12;
      let channels = 2;
      let numFrames = 0;
      let bitsPerSample = 16;
      let sampleRate = 44100;
      let ssndOffset = -1;

      while (offset + 8 <= view.byteLength) {
        const chunkId = view.getUint32(offset, false);
        const chunkSize = view.getUint32(offset + 4, false);
        const payload = offset + 8;
        if (chunkId === 0x434f4d4d && payload + 18 <= view.byteLength) {
          // "COMM"
          channels = Math.max(1, view.getUint16(payload, false));
          numFrames = view.getUint32(payload + 2, false);
          bitsPerSample = view.getUint16(payload + 6, false);
          // 80-bit IEEE 754 extended float sample rate
          const exp = (view.getUint16(payload + 8, false) & 0x7fff) - 16383;
          const hi = view.getUint32(payload + 10, false);
          const sr = hi * Math.pow(2, exp - 31);
          if (sr >= 8000 && sr <= 192000) sampleRate = Math.round(sr);
        } else if (chunkId === 0x53534e44 && payload + 8 <= view.byteLength) {
          // "SSND"
          const blockOffset = view.getUint32(payload, false);
          ssndOffset = payload + 8 + blockOffset;
        }
        offset = payload + chunkSize + (chunkSize % 2);
      }

      if (ssndOffset > 0 && numFrames > 0) {
        const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8));
        const frameBytes = channels * bytesPerSample;
        const maxFrames = Math.min(numFrames, Math.floor((view.byteLength - ssndOffset) / frameBytes));
        const outChannels = Math.min(2, channels);
        const audioBuf = ctx.createBuffer(outChannels, maxFrames, sampleRate);
        const chData: Float32Array[] = [];
        for (let c = 0; c < outChannels; c++) chData.push(audioBuf.getChannelData(c));

        let ptr = ssndOffset;
        for (let i = 0; i < maxFrames; i++) {
          for (let c = 0; c < outChannels; c++) {
            const samplePos = ptr + c * bytesPerSample;
            let val = 0;
            if (bitsPerSample === 16) {
              val = view.getInt16(samplePos, false) / 32768;
            } else if (bitsPerSample === 24) {
              const b0 = view.getUint8(samplePos);
              const b1 = view.getUint8(samplePos + 1);
              const b2 = view.getUint8(samplePos + 2);
              const i24 = ((b0 << 24) | (b1 << 16) | (b2 << 8)) >> 8;
              val = i24 / 8388608;
            } else if (bitsPerSample === 32) {
              val = view.getInt32(samplePos, false) / 2147483648;
            }
            chData[c][i] = isFinite(val) ? Math.max(-1, Math.min(1, val)) : 0;
          }
          ptr += frameBytes;
        }
        return audioBuf;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Safe AudioBuffer decoder:
 * 1. Tries native WebAudio `ctx.decodeAudioData`
 * 2. Falls back to our pure-JS WAV / BWF / RF64 / Extensible / AIFF PCM & Float decoder
 */
export async function decodeAudioDataSafe(
  ctx: BaseAudioContext,
  input: ArrayBuffer | ArrayBufferView | number[],
): Promise<AudioBuffer> {
  const ab = ensureArrayBuffer(input);
  try {
    return await ctx.decodeAudioData(ab.slice(0));
  } catch (nativeErr) {
    const fallback = decodePcmContainerFallback(ctx, ab);
    if (fallback) return fallback;
    throw nativeErr;
  }
}

/**
 * Quick header parser to get duration of WAV / BWF / RF64 / AIFF / MP3 / M4A files
 * without decoding full PCM into RAM — and NEVER throws during import!
 */
export async function probeAudioDuration(file: File, ctx: AudioContext): Promise<number> {
  // 1. Fast WAV / BWF / RF64 / AIFF header parse (reads up to 256 KB so `bext` / `iXML` / `JUNK` chunks never hide `fmt `!)
  try {
    const sliceLen = Math.min(file.size, 262144);
    const header = await file.slice(0, sliceLen).arrayBuffer();
    const view = new DataView(header);
    if (view.byteLength >= 44) {
      const magic0 = view.getUint32(0, false);
      const magic8 = view.getUint32(8, false);
      // WAV / RF64 / BW64
      if ((magic0 === 0x52494646 || magic0 === 0x52463634 || magic0 === 0x42573634) && magic8 === 0x57415645) {
        let offset = 12;
        let byteRate = 0;
        let channels = 2;
        let sampleRate = 44100;
        let bitsPerSample = 16;
        while (offset + 8 <= view.byteLength) {
          const chunkId = view.getUint32(offset, false);
          const chunkSize = view.getUint32(offset + 4, true);
          if (chunkId === 0x666d7420 && offset + 24 <= view.byteLength) {
            // "fmt "
            channels = Math.max(1, view.getUint16(offset + 10, true));
            sampleRate = view.getUint32(offset + 12, true) || 44100;
            byteRate = view.getUint32(offset + 16, true);
            bitsPerSample = view.getUint16(offset + 22, true) || 16;
            if (!byteRate) byteRate = sampleRate * channels * Math.max(1, bitsPerSample / 8);
          } else if (chunkId === 0x64617461 && byteRate > 0) {
            // "data"
            const actualBytes = chunkSize > 0 && chunkSize <= file.size ? chunkSize : file.size - (offset + 8);
            const dur = actualBytes / byteRate;
            if (isFinite(dur) && dur > 0.2) return dur;
          }
          if (chunkSize > file.size) break;
          offset += 8 + chunkSize + (chunkSize % 2);
        }
        if (byteRate > 0) {
          const dur = Math.max(1, (file.size - 1024) / byteRate);
          if (isFinite(dur) && dur > 0.2) return dur;
        }
      }
      // AIFF / AIFC
      if (magic0 === 0x464f524d && (magic8 === 0x41494646 || magic8 === 0x41494643)) {
        let offset = 12;
        while (offset + 8 <= view.byteLength) {
          const chunkId = view.getUint32(offset, false);
          const chunkSize = view.getUint32(offset + 4, false);
          if (chunkId === 0x434f4d4d && offset + 26 <= view.byteLength) {
            const numFrames = view.getUint32(offset + 10, false);
            const exp = (view.getUint16(offset + 16, false) & 0x7fff) - 16383;
            const hi = view.getUint32(offset + 18, false);
            const sr = hi * Math.pow(2, exp - 31) || 44100;
            if (numFrames > 0 && sr > 0) return numFrames / sr;
          }
          offset += 8 + chunkSize + (chunkSize % 2);
        }
      }
    }
  } catch {
    /* fallback below */
  }

  // 2. Fast HTMLAudioElement metadata probe with 2.5s timeout
  try {
    const dur = await new Promise<number>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      audio.preload = 'metadata';
      const timer = window.setTimeout(() => {
        URL.revokeObjectURL(url);
        reject(new Error('timeout'));
      }, 2500);
      const cleanup = () => {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      };
      audio.onloadedmetadata = () => {
        const d = audio.duration;
        cleanup();
        if (isFinite(d) && d > 0) resolve(d);
        else reject(new Error('invalid duration'));
      };
      audio.onerror = () => {
        cleanup();
        reject(new Error('metadata error'));
      };
      audio.src = url;
    });
    return dur;
  } catch {
    // 3. Final fallback: decodeAudioDataSafe (and if even that fails, estimate from file size so import NEVER crashes!)
    try {
      const ab = await file.arrayBuffer();
      const decoded = await decodeAudioDataSafe(ctx, ab);
      return decoded.duration;
    } catch {
      const isWavLike = /\.(wav|aif|aiff)$/i.test(file.name);
      const bytesPerSec = isWavLike ? 44100 * 2 * 3 : 24000;
      return Math.max(10, Math.round(file.size / bytesPerSec));
    }
  }
}

export interface Settings {
  jumpMode: 'now' | 'bar' | 'section';
  guideEnabled: boolean;
  guideVoice: string;
  autoGuideVolume: number; // 0..1.2 fader for automatic spoken/cue section announcements
  autoGuideMute: boolean;
  autoAdvance: boolean;
  transitionMode: TransitionMode;
  fadeSeconds: number;
  clickSubdivide: boolean;
  clickSubdivision?: ClickSubdivision;
  clickSound?: ClickSound;
  smartRouting: boolean;
  padVolume: number;
  padSound: PadSound;
  padCutoff?: number; // 200..8000 Hz
  padResonance?: number; // 0.3..8 Q
  padCrossfade?: number; // 1..8 seconds
  outputDevice: string;
  masterVolume: number;
  midiMappings: MidiMapping[];
  geminiApiKey?: string;
  timelineHeight?: number;
  mixerHeight?: number;
  floatingPadOpen?: boolean;
  customPadFolderName?: string;
  customPadKeys?: string[];
  padBanks?: PadFolderBank[];
  activePadBankId?: string;
  guideVoicePack?: string;
  guidePitch?: number;
  guideRate?: number;
  audioDriverType?: 'WASAPI' | 'ASIO';
  asioDriverName?: string;
  asioBufferSize?: number;
  asioSampleRate?: number;
  internalClickVolume?: number;
  internalClickPan?: number;
  internalClickMute?: boolean;
  internalClickOutput?: OutputBus;
  autoGuideOutput?: OutputBus;
  // Dual audio device / ASIO output mapping
  useDualAudioDevices?: boolean;
  secondaryOutputDevice?: string;
  asioOutputMapping?: {
    tracksOutL: number;
    tracksOutR: number;
    guideOut: number;
    clickOut: number;
  };
}

export interface PersistedState {
  songs: Song[];
  setlists: Setlist[];
  activeSetlistId: string;
  settings: Settings;
}

export const DEFAULT_MIDI_MAPPINGS: MidiMapping[] = [
  { id: 'm1', actionLabel: 'Play / Pause', actionType: 'PLAY_PAUSE', targetValue: 'GLOBAL', keyShortcut: 'Space', channel: 1, messageType: 'NOTE_ON', controllerNumber: 60 },
  { id: 'm2', actionLabel: 'Parar Playback', actionType: 'STOP', targetValue: 'GLOBAL', keyShortcut: 'Esc', channel: 1, messageType: 'NOTE_ON', controllerNumber: 61 },
  { id: 'm3', actionLabel: 'Loop Seção Atual', actionType: 'LOOP_CURRENT', targetValue: 'GLOBAL', keyShortcut: 'L', channel: 1, messageType: 'NOTE_ON', controllerNumber: 62 },
  { id: 'm4', actionLabel: 'Smart Jump: Próximo Refrão', actionType: 'JUMP_NEXT_TYPE', targetValue: 'REFRAO', keyShortcut: 'R', channel: 1, messageType: 'NOTE_ON', controllerNumber: 64 },
  { id: 'm5', actionLabel: 'Smart Jump: Próxima Ponte', actionType: 'JUMP_NEXT_TYPE', targetValue: 'PONTE', keyShortcut: 'P', channel: 1, messageType: 'NOTE_ON', controllerNumber: 65 },
  { id: 'm6', actionLabel: 'Smart Jump: Próximo Verso', actionType: 'JUMP_NEXT_TYPE', targetValue: 'VERSO', keyShortcut: 'V', channel: 1, messageType: 'NOTE_ON', controllerNumber: 67 },
];

export const DEFAULT_SETTINGS: Settings = {
  jumpMode: 'section',
  guideEnabled: true,
  guideVoice: '',
  autoGuideVolume: 0.9,
  autoGuideMute: false,
  autoAdvance: false,
  transitionMode: 'AUTOLINK',
  fadeSeconds: 5,
  clickSubdivide: false,
  clickSubdivision: '1/4',
  clickSound: 'woodblock',
  smartRouting: false,
  padVolume: 0.6,
  padSound: 'warm',
  padCutoff: 1800,
  padResonance: 0.8,
  padCrossfade: 3.0,
  outputDevice: '',
  masterVolume: 0.9,
  midiMappings: DEFAULT_MIDI_MAPPINGS,
  geminiApiKey: '',
  timelineHeight: 145,
  mixerHeight: 280,
  floatingPadOpen: false,
  customPadFolderName: '',
  customPadKeys: [],
  padBanks: [],
  activePadBankId: 'default',
  guideVoicePack: 'neural_pt_female',
  guidePitch: 1.0,
  guideRate: 1.12,
  audioDriverType: 'WASAPI',
  asioBufferSize: 128,
  asioSampleRate: 48000,
  internalClickVolume: 0.75,
  internalClickPan: 0,
  internalClickMute: false,
  internalClickOutput: 'OUT_4',
  autoGuideOutput: 'OUT_3',
  useDualAudioDevices: false,
  secondaryOutputDevice: '',
  asioOutputMapping: {
    tracksOutL: 1,
    tracksOutR: 2,
    guideOut: 3,
    clickOut: 4,
  },
};

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

export function saveState(s: PersistedState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* quota */
  }
}
