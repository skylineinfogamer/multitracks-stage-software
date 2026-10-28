import type { StretchRequest, StretchResponse } from './stretch.worker';
import type { SectionType } from '../types';

/**
 * Multi-stem WSOLA Time-Stretch & Pitch-Shift processor + Synthesized Guide Cue AudioBuffer generator.
 *
 * How independent Pitch + Speed works without phase drift between stems:
 * 1. Suppose the user wants pitch shift of `semitones` (pitchRatio = 2^(semitones/12))
 *    and speed factor of `rate`.
 * 2. In the AudioEngine, we play the buffers at `playbackRate = rate * pitchRatio` (which shifts pitch by `semitones`),
 *    and we pre-stretch all stem buffers by `stretch = pitchRatio` so their musical duration stays locked
 *    to the original timeline!
 * 3. Better yet, for pure pitch-shift (semitones != 0), we compute a single WSOLA grain alignment map
 *    across the mono sum of all stems in a background WebWorker, then apply those exact grain positions
 *    to every stem channel — preserving stereo image and multi-mic phase coherence.
 */

let workerInstance: Worker | null = null;
let reqSeq = 1;
const pending = new Map<number, (pos: Int32Array) => void>();

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
    workerInstance.onmessage = (ev: MessageEvent<StretchResponse>) => {
      const cb = pending.get(ev.data.id);
      if (cb) {
        pending.delete(ev.data.id);
        cb(ev.data.positions);
      }
    };
  }
  return workerInstance;
}

/**
 * Pitch-shifts a set of AudioBuffers by `semitones` while preserving their exact duration
 * and inter-stem phase alignment.
 *
 * Works by:
 * 1. Time-stretching all buffers by `pitchRatio = 2^(semitones/12)` using phase-locked WSOLA
 * 2. Resampling (linear/cubic interpolation) back to the original sample count (`inputLength`).
 */
export async function pitchShiftStems(
  ctx: BaseAudioContext,
  stems: Map<string, AudioBuffer>,
  semitones: number,
  onProgress?: (p: number) => void,
): Promise<Map<string, AudioBuffer>> {
  if (semitones === 0 || stems.size === 0) return stems;

  const pitchRatio = Math.pow(2, semitones / 12);
  const entries = Array.from(stems.entries());
  const first = entries[0][1];
  const sr = first.sampleRate;
  const inputLength = first.length;
  const decimation = 8;
  const analysisLen = Math.ceil(inputLength / decimation);
  const analysis = new Float32Array(analysisLen);

  // Build decimated mono sum for WSOLA correlation
  for (const [, buf] of entries) {
    const ch0 = buf.getChannelData(0);
    const lim = Math.min(inputLength, ch0.length);
    for (let i = 0, j = 0; i < lim; i += decimation, j++) {
      analysis[j] += ch0[i];
    }
  }

  const frameSize = 2048;
  const synthHop = frameSize >> 1; // 1024 (50% overlap Hann window)
  const searchRadius = 512;
  const stretch = pitchRatio; // stretch by pitchRatio, then resample by 1/pitchRatio => same length, shifted pitch!

  const id = reqSeq++;
  const req: StretchRequest = {
    id,
    analysis,
    decimation,
    inputLength,
    frameSize,
    synthHop,
    stretch,
    searchRadius,
  };

  const positions = await new Promise<Int32Array>((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage(req, [analysis.buffer]);
  });

  // Hann window
  const hann = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / frameSize));
  }

  const stretchedLen = Math.ceil(inputLength * stretch) + frameSize;
  const tempStretched = new Float32Array(stretchedLen);
  const outMap = new Map<string, AudioBuffer>();

  let done = 0;
  for (const [trackId, buf] of entries) {
    const nCh = buf.numberOfChannels;
    const outBuf = ctx.createBuffer(nCh, buf.length, sr);

    for (let c = 0; c < nCh; c++) {
      const inp = buf.getChannelData(c);
      const out = outBuf.getChannelData(c);
      tempStretched.fill(0);

      // Overlap-add using shared grain positions
      for (let m = 0; m < positions.length; m++) {
        const readPos = positions[m];
        const writePos = m * synthHop;
        if (writePos + frameSize >= stretchedLen) break;
        for (let i = 0; i < frameSize; i++) {
          const idx = readPos + i;
          if (idx < inp.length) {
            tempStretched[writePos + i] += inp[idx] * hann[i];
          }
        }
      }

      // Resample stretched buffer back to exact original length (changes pitch by pitchRatio)
      for (let i = 0; i < out.length; i++) {
        const srcPos = i * pitchRatio;
        const idx = Math.floor(srcPos);
        const frac = srcPos - idx;
        const s0 = tempStretched[idx] ?? 0;
        const s1 = tempStretched[idx + 1] ?? s0;
        out[i] = s0 + frac * (s1 - s0);
      }
    }

    outMap.set(trackId, outBuf);
    done++;
    onProgress?.(done / entries.length);
    // Yield to UI between stems
    await new Promise((r) => setTimeout(r, 0));
  }

  return outMap;
}

/**
 * Generates an AudioBuffer cue for the Guide track so that guide cues flow through
 * the WebAudio mixer / SmartRouting / multichannel bus (Out 5) with real VU metering,
 * in addition to optional speech synthesis.
 */
const CUE_MOTIFS: Partial<Record<SectionType, number[]>> = {
  CONTAGEM: [523.25, 523.25],
  INTRO: [523.25, 659.25], // C5 -> E5
  VERSO: [587.33, 659.25], // D5 -> E5
  VERSO_2: [587.33, 659.25],
  PRE: [659.25, 783.99], // E5 -> G5
  REFRAO: [523.25, 659.25, 783.99, 1046.5], // C5 -> E5 -> G5 -> C6
  POS_REFRAO: [783.99, 880.0],
  PONTE: [587.33, 783.99, 880.0], // D5 -> G5 -> A5
  SUBIDA: [587.33, 659.25, 783.99, 987.77],
  INTERLUDIO: [523.25, 587.33],
  INSTRUMENTAL: [659.25, 783.99, 987.77],
  SOLO: [783.99, 987.77, 1046.5],
  VAMP: [659.25, 783.99],
  ESPONTANEO: [523.25, 783.99],
  MINISTRACAO: [523.25, 659.25],
  BREAK: [880.0],
  TAG: [783.99, 659.25, 783.99],
  FINAL: [783.99, 659.25, 523.25], // G5 -> E5 -> C5
};

export function createGuideCueBuffer(ctx: BaseAudioContext, type: SectionType): AudioBuffer {
  const sr = ctx.sampleRate;
  const notes = CUE_MOTIFS[type] ?? [659.25, 783.99];
  const noteDur = 0.085;
  const totalDur = notes.length * noteDur + 0.12;
  const len = Math.ceil(totalDur * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);

  notes.forEach((freq, idx) => {
    const startSample = Math.floor(idx * noteDur * sr);
    const count = Math.floor((noteDur + 0.06) * sr);
    for (let i = 0; i < count && startSample + i < len; i++) {
      const t = i / sr;
      const env = Math.sin(Math.min(1, i / (0.008 * sr)) * (Math.PI / 2)) * Math.exp(-t * 18);
      // Warm formant-like tone (fundamental + 2nd + 3rd harmonic)
      const sig =
        Math.sin(2 * Math.PI * freq * t) * 0.65 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.25 +
        Math.sin(2 * Math.PI * freq * 3 * t) * 0.1;
      d[startSample + i] += sig * env * 0.45;
    }
  });

  return buf;
}
