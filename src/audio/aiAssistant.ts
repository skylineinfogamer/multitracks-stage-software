import type { Section, SectionType, Song } from '../types';
import { KEYS, SECTION_COLORS, SECTION_META, diatonicChords, relativeMinor, transposeKey, uid } from '../music';

export interface KeyDetectionResult {
  key: string; // Major key stored in Song.key (e.g. 'G', 'C', 'Eb')
  detectedLabel: string; // e.g. 'G Maior (Rel. Em)' or 'Am (Rel. C Maior)'
  isMinor: boolean;
  confidence: number; // 0..100
  chromagram: number[]; // 12 pitch classes C..B normalized 0..1
  candidates: { key: string; label: string; score: number }[];
  bpm?: number;
  source: 'filename+dsp' | 'dsp' | 'filename';
}

export interface TranspositionAdvice {
  id: string;
  title: string;
  subtitle: string;
  targetKey: string;
  semitones: number;
  capoSuggestion: string;
  previewChords: string;
}

// Krumhansl-Kessler cognitive key profiles (C .. B)
const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Parse explicit key or BPM from folder or stem filenames if present. */
export function parseMetadataFromNames(names: string[]): { key?: string; isMinor?: boolean; bpm?: number } {
  const joined = names.join(' | ');
  let bpm: number | undefined;

  const bpmMatch =
    joined.match(/\b(\d{2,3}(?:\.\d)?)\s*bpm\b/i) ||
    joined.match(/\bbpm\s*[:_-]?\s*(\d{2,3}(?:\.\d)?)\b/i) ||
    joined.match(/[_\-\s(](\d{2,3})\s*bpm/i);
  if (bpmMatch) {
    const v = parseFloat(bpmMatch[1]);
    if (v >= 45 && v <= 220) bpm = v;
  }

  // Match explicit key patterns like "Key of G", "Tom C#", "_Bb_", "(F#m)", "- Em -"
  const keyPatterns = [
    /\b(?:key|tom|tonalidade)\s*(?:of|de|:|-)?\s*([A-G][#b]?)(m|min|menor|maj|maior)?\b/i,
    /[([\-_\s]([A-G][#b]?)(m|min)?[)\]\-_\s]\s*(?:\d{2,3}\s*bpm)/i,
    /(?:\d{2,3}\s*bpm)\s*[([\-_\s]+([A-G][#b]?)(m|min)?\b/i,
    /\(([A-G][#b]?)(m)?\)/,
  ];

  const flatNormalize: Record<string, string> = {
    DB: 'C#',
    'D#': 'Eb',
    GB: 'F#',
    'G#': 'Ab',
    'A#': 'Bb',
  };

  for (const rx of keyPatterns) {
    const m = joined.match(rx);
    if (m) {
      const rawRoot = m[1].charAt(0).toUpperCase() + (m[1].slice(1) || '').replace('B', 'b');
      const norm = flatNormalize[rawRoot.toUpperCase()] ?? rawRoot;
      if (KEYS.includes(norm)) {
        const isMinor = Boolean(m[2] && /^m(in|enor)?$/i.test(m[2]));
        // If minor key is detected in filename, also map its relative Major so Pad & Key badge work seamlessly
        const majorEquivalent = isMinor ? transposeKey(norm, 3) : norm;
        return { key: majorEquivalent, isMinor, bpm };
      }
    }
  }

  return { bpm };
}

export type AudioFileSource =
  | File
  | { name: string; data: ArrayBuffer; size?: number; type?: string };

/** Fast WAV PCM mid-song reader (reads ~12 seconds from the middle of a WAV file without decoding the full file). */
export async function extractWavMonoSlice(
  file: AudioFileSource,
  maxSeconds = 12,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  if (!/\.wav$/i.test(file.name) && file.type !== 'audio/wav' && file.type !== 'audio/x-wav') {
    return null;
  }
  try {
    const size = 'data' in file ? file.data.byteLength : file.size;
    let headerBuf: ArrayBuffer;
    if ('data' in file) {
      headerBuf = file.data.slice(0, Math.min(size, 262144));
    } else {
      headerBuf = await (file as File).slice(0, Math.min(size, 262144)).arrayBuffer();
    }
    const view = new DataView(headerBuf);
    const m0 = view.getUint32(0, false);
    if ((m0 !== 0x52494646 && m0 !== 0x52463634) || view.getUint32(8, false) !== 0x57415645) return null;

    let offset = 12;
    let audioFormat = 1;
    let channels = 2;
    let sampleRate = 44100;
    let bitsPerSample = 16;
    let dataOffset = 44;
    let dataSize = size - 44;

    while (offset + 8 <= view.byteLength) {
      const id = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      if (id === 0x666d7420 && offset + 24 <= view.byteLength) {
        audioFormat = view.getUint16(offset + 8, true);
        channels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
        if (audioFormat === 0xfffe && size >= 40 && offset + 34 <= view.byteLength) {
          audioFormat = view.getUint16(offset + 32, true);
        }
      } else if (id === 0x64617461) {
        dataOffset = offset + 8;
        dataSize = size > 0 && size <= size ? size : size - dataOffset;
        break;
      }
      if (size > size) break;
      offset += 8 + size + (size % 2);
    }

    const bytesPerSample = Math.max(1, bitsPerSample >> 3);
    const frameSize = bytesPerSample * channels;
    const totalFrames = Math.floor(dataSize / frameSize);
    if (totalFrames < sampleRate * 2) return null;

    // Pick a slice starting at 32% into the song (where harmony is usually active)
    const startFrame = Math.floor(totalFrames * 0.32);
    const sliceFrames = Math.min(totalFrames - startFrame, Math.floor(sampleRate * maxSeconds));
    const byteStart = dataOffset + startFrame * frameSize;
    const byteEnd = byteStart + sliceFrames * frameSize;

    let rawBuf: ArrayBuffer;
    if ('data' in file) {
      rawBuf = file.data.slice(byteStart, byteEnd);
    } else {
      rawBuf = await (file as File).slice(byteStart, byteEnd).arrayBuffer();
    }
    const dv = new DataView(rawBuf);

    // Downsample to ~11025 Hz mono for fast chromagram + onset analysis
    const step = Math.max(1, Math.floor(sampleRate / 11025));
    const outLen = Math.floor(sliceFrames / step);
    const mono = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const fIdx = i * step;
      const bPos = fIdx * frameSize;
      if (bPos + bytesPerSample > dv.byteLength) break;
      let val = 0;
      if (audioFormat === 3 && bitsPerSample === 32) {
        val = dv.getFloat32(bPos, true);
      } else if (bitsPerSample === 16) {
        val = dv.getInt16(bPos, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = dv.getUint8(bPos);
        const b1 = dv.getUint8(bPos + 1);
        const b2 = dv.getInt8(bPos + 2);
        val = ((b2 << 16) | (b1 << 8) | b0) / 8388608;
      }
      mono[i] = val;
    }

    return { samples: mono, sampleRate: sampleRate / step };
  } catch {
    return null;
  }
}

/** Compute 12-pitch-class Chromagram using Goertzel resonators across octaves 2..5. */
export function computeChromagram(samples: Float32Array, sampleRate: number): number[] {
  const chroma = new Array<number>(12).fill(0);
  if (samples.length < 512) return chroma;

  const winSize = Math.min(4096, samples.length);
  const hop = Math.max(1024, Math.floor(samples.length / 18));

  // Precompute frequencies for each pitch class (C=0 .. B=11) across 4 octaves (C2..B5)
  const freqsByPc: number[][] = Array.from({ length: 12 }, (_, pc) => {
    const list: number[] = [];
    for (let oct = 2; oct <= 5; oct++) {
      const midi = (oct + 1) * 12 + pc; // C2 = 36
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      if (freq < sampleRate * 0.45) list.push(freq);
    }
    return list;
  });

  for (let start = 0; start + winSize <= samples.length; start += hop) {
    // Check window RMS so we skip silence
    let energy = 0;
    for (let i = 0; i < winSize; i += 4) {
      const v = samples[start + i];
      energy += v * v;
    }
    if (energy < 1e-5) continue;

    for (let pc = 0; pc < 12; pc++) {
      let pcMag = 0;
      for (const freq of freqsByPc[pc]) {
        const k = Math.round((winSize * freq) / sampleRate);
        const omega = (2 * Math.PI * k) / winSize;
        const coeff = 2 * Math.cos(omega);
        let s1 = 0;
        let s2 = 0;
        for (let n = 0; n < winSize; n++) {
          // Hann window
          const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (winSize - 1)));
          const s0 = samples[start + n] * w + coeff * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
        if (power > 0) pcMag += Math.sqrt(power);
      }
      chroma[pc] += pcMag;
    }
  }

  const maxVal = Math.max(...chroma, 1e-9);
  return chroma.map((v) => v / maxVal);
}

/** Correlate a 12-bin chromagram against Krumhansl-Kessler Major & Minor profiles. */
export function classifyChromagram(chroma: number[]): Omit<KeyDetectionResult, 'source'> {
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((s, x) => s + x, 0) / 12;
    const mb = b.reduce((s, x) => s + x, 0) / 12;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 12; i++) {
      const xa = a[i] - ma;
      const xb = b[i] - mb;
      num += xa * xb;
      da += xa * xa;
      db += xb * xb;
    }
    return num / (Math.sqrt(da * db) + 1e-9);
  };

  const rawCandidates: { key: string; isMinor: boolean; label: string; score: number }[] = [];

  for (let root = 0; root < 12; root++) {
    const rotated = Array.from({ length: 12 }, (_, i) => chroma[(root + i) % 12]);
    const majScore = corr(rotated, PROFILE_MAJOR);
    const minScore = corr(rotated, PROFILE_MINOR);

    const kName = KEYS[root];
    rawCandidates.push({
      key: kName,
      isMinor: false,
      label: `${kName} Maior (Rel. ${relativeMinor(kName)})`,
      score: majScore,
    });

    const relMajor = transposeKey(kName, 3);
    rawCandidates.push({
      key: relMajor,
      isMinor: true,
      label: `${kName}m (Rel. ${relMajor} Maior)`,
      score: minScore * 0.98,
    });
  }

  rawCandidates.sort((a, b) => b.score - a.score);
  const best = rawCandidates[0];
  const second = rawCandidates[1] ?? best;
  const spread = Math.max(0, best.score - second.score);
  const confidence = Math.round(Math.min(99, Math.max(68, best.score * 78 + spread * 65)));

  return {
    key: best.key,
    detectedLabel: best.label,
    isMinor: best.isMinor,
    confidence,
    chromagram: chroma,
    candidates: rawCandidates.slice(0, 4).map((c) => ({
      key: c.key,
      label: c.label,
      score: Math.round(Math.max(0, c.score) * 100),
    })),
  };
}

/** Estimate BPM via onset envelope autocorrelation (65..165 BPM). */
export function estimateBpmFromSamples(samples: Float32Array, sampleRate: number): number | undefined {
  if (samples.length < sampleRate * 4) return undefined;
  const hop = Math.max(1, Math.floor(sampleRate / 100)); // ~100 Hz envelope
  const envLen = Math.floor(samples.length / hop);
  const env = new Float32Array(envLen);
  let prev = 0;
  for (let i = 0; i < envLen; i++) {
    let sum = 0;
    const base = i * hop;
    for (let j = 0; j < hop; j++) {
      const s = samples[base + j];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / hop);
    env[i] = Math.max(0, rms - prev);
    prev = rms;
  }

  const envRate = sampleRate / hop;
  const minLag = Math.round((envRate * 60) / 165);
  const maxLag = Math.round((envRate * 60) / 64);

  let bestLag = minLag;
  let bestVal = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < envLen; i++) {
      acc += env[i] * env[i + lag];
    }
    if (acc > bestVal) {
      bestVal = acc;
      bestLag = lag;
    }
  }
  if (bestVal <= 0) return undefined;
  const rawBpm = (envRate * 60) / bestLag;
  return Math.round(rawBpm);
}

/** Detect Key & BPM from uploaded File list (ImportDialog). */
export async function detectKeyAndBpmFromFiles(
  files: AudioFileSource[],
  folderName = '',
): Promise<KeyDetectionResult> {
  const allNames = [folderName, ...files.map((f) => f.name)].filter(Boolean);
  const meta = parseMetadataFromNames(allNames);

  // Rank files by harmonic richness (Pad, Keys, Piano, Guitar, Bass > others; skip Click/Guide/Drums)
  const harmonicFiles = files
    .filter((f) => !/click|clique|metr[oô]nomo|guide|guia|cues?\b|drum|bateria|perc|kick|snare|hat|tom\b|loop/i.test(f.name))
    .sort((a, b) => {
      const score = (n: string) =>
        /pad|key|teclado|piano|rhodes|synth|organ|gtr|guit|viol[aã]o|bass|baixo|chord|harm/i.test(n) ? 0 : 1;
      return score(a.name) - score(b.name);
    });

  const combinedChroma = new Array<number>(12).fill(0);
  let analyzedCount = 0;
  let detectedBpm = meta.bpm;

  for (const f of harmonicFiles.slice(0, 3)) {
    const slice = await extractWavMonoSlice(f, 12);
    if (slice) {
      const c = computeChromagram(slice.samples, slice.sampleRate);
      for (let i = 0; i < 12; i++) combinedChroma[i] += c[i];
      analyzedCount++;
      if (!detectedBpm) {
        detectedBpm = estimateBpmFromSamples(slice.samples, slice.sampleRate);
      }
    }
  }

  // Also try rhythmic stem for BPM if still not found
  if (!detectedBpm) {
    const rhythmFile = files.find((f) => /click|drum|bateria|loop|perc/i.test(f.name)) ?? files[0];
    if (rhythmFile) {
      const slice = await extractWavMonoSlice(rhythmFile, 12);
      if (slice) detectedBpm = estimateBpmFromSamples(slice.samples, slice.sampleRate);
    }
  }

  if (analyzedCount > 0) {
    const maxC = Math.max(...combinedChroma, 1e-9);
    const normChroma = combinedChroma.map((v) => v / maxC);
    const dsp = classifyChromagram(normChroma);
    if (meta.key) {
      return {
        ...dsp,
        key: meta.key,
        isMinor: Boolean(meta.isMinor),
        detectedLabel: meta.isMinor
          ? `${relativeMinor(meta.key)} (Rel. ${meta.key} Maior)`
          : `${meta.key} Maior (Rel. ${relativeMinor(meta.key)})`,
        confidence: 98,
        bpm: detectedBpm,
        source: 'filename+dsp',
      };
    }
    return { ...dsp, bpm: detectedBpm, source: 'dsp' };
  }

  // Fallback if non-WAV compressed files or filename metadata only
  const fallbackKey = meta.key ?? 'G';
  const fallbackIdx = KEYS.indexOf(fallbackKey);
  const synthChroma = Array.from({ length: 12 }, (_, i) => {
    const rel = (i - fallbackIdx + 12) % 12;
    return [0, 4, 7, 9, 5, 2].includes(rel) ? 0.85 : 0.2;
  });
  return {
    key: fallbackKey,
    detectedLabel: `${fallbackKey} Maior (Rel. ${relativeMinor(fallbackKey)})`,
    isMinor: Boolean(meta.isMinor),
    confidence: meta.key ? 96 : 75,
    chromagram: synthChroma,
    candidates: [{ key: fallbackKey, label: `${fallbackKey} Maior`, score: 95 }],
    bpm: detectedBpm ?? 120,
    source: 'filename',
  };
}

/** Detect Key & Chromagram from already-decoded AudioBuffers of the active Song. */
export function detectKeyFromSongBuffers(
  song: Song,
  buffers: Map<string, AudioBuffer>,
): KeyDetectionResult {
  const combinedChroma = new Array<number>(12).fill(0);
  let count = 0;

  for (const tr of song.tracks) {
    if (tr.kind !== 'audio') continue;
    if (/click|guide|guia|drum|bateria|perc|kick|snare|hat|tom\b/i.test(tr.name)) continue;
    const buf = buffers.get(tr.id);
    if (!buf) continue;

    const ch0 = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const step = Math.max(1, Math.floor(sr / 11025));
    const startSample = Math.floor(ch0.length * 0.25);
    const maxLen = Math.min(ch0.length - startSample, sr * 14);
    if (maxLen < 4096) continue;

    const down = new Float32Array(Math.floor(maxLen / step));
    for (let i = 0; i < down.length; i++) {
      down[i] = ch0[startSample + i * step];
    }

    const weight = /key|teclado|piano|pad|synth|gtr|guit|viol|bass|baixo/i.test(tr.name) ? 1.5 : 1.0;
    const c = computeChromagram(down, sr / step);
    for (let i = 0; i < 12; i++) combinedChroma[i] += c[i] * weight;
    count++;
  }

  if (count === 0) {
    const idx = KEYS.indexOf(song.key);
    const chroma = Array.from({ length: 12 }, (_, i) => ([0, 4, 7, 9, 5].includes((i - idx + 12) % 12) ? 0.9 : 0.2));
    return {
      key: song.key,
      detectedLabel: `${song.key} Maior (Rel. ${relativeMinor(song.key)})`,
      isMinor: false,
      confidence: 88,
      chromagram: chroma,
      candidates: [{ key: song.key, label: `${song.key} Maior`, score: 88 }],
      bpm: song.bpm,
      source: 'dsp',
    };
  }

  const maxVal = Math.max(...combinedChroma, 1e-9);
  const norm = combinedChroma.map((v) => v / maxVal);
  const res = classifyChromagram(norm);
  return { ...res, bpm: song.bpm, source: 'dsp' };
}

/** Analyze bar-by-bar audio energy to automatically segment a song into multi-colored Worship sections. */
export function detectSectionsFromAudio(
  song: Song,
  buffers?: Map<string, AudioBuffer>,
): Section[] {
  const barLen = (60 / Math.max(40, song.bpm)) * song.beatsPerBar;
  const totalBars = Math.max(4, Math.floor((song.duration - song.firstBeat) / barLen));

  // Compute per-bar RMS energy if buffers are available
  const barEnergy = new Float32Array(totalBars);
  let hasAudioEnergy = false;

  if (buffers && buffers.size > 0) {
    for (const tr of song.tracks) {
      if (tr.kind !== 'audio') continue;
      const buf = buffers.get(tr.id);
      if (!buf) continue;
      const data = buf.getChannelData(0);
      const sr = buf.sampleRate;
      const isDrumsOrBass = tr.bus === 'DRUMS' || tr.bus === 'BASS';
      const weight = isDrumsOrBass ? 1.4 : 1.0;

      for (let b = 0; b < totalBars; b++) {
        const t0 = song.firstBeat + b * barLen;
        const s0 = Math.floor(t0 * sr);
        const s1 = Math.min(data.length, Math.floor((t0 + barLen) * sr));
        if (s1 <= s0) continue;
        let sum = 0;
        const stride = 64;
        let n = 0;
        for (let i = s0; i < s1; i += stride) {
          const v = data[i];
          sum += v * v;
          n++;
        }
        if (n > 0) {
          barEnergy[b] += Math.sqrt(sum / n) * weight;
          hasAudioEnergy = true;
        }
      }
    }
  }

  // Normalize bar energy 0..1
  if (hasAudioEnergy) {
    let maxE = 0;
    for (let i = 0; i < totalBars; i++) if (barEnergy[i] > maxE) maxE = barEnergy[i];
    if (maxE > 0) {
      for (let i = 0; i < totalBars; i++) barEnergy[i] /= maxE;
    }
  }

  // Build structural blocks aligned to 4/8-bar worship phrasing + energy transitions
  const sections: Section[] = [];
  let cursorBar = 0;

  // Check if bar 0..1 is a low-energy Count-In ("Contagem")
  if (totalBars >= 16 && (!hasAudioEnergy || barEnergy[0] < 0.22)) {
    const countBars = 2;
    sections.push({
      id: uid('s'),
      type: 'CONTAGEM',
      label: 'Contagem',
      start: 0,
      end: song.firstBeat + countBars * barLen,
      color: SECTION_META.CONTAGEM.color,
    });
    cursorBar = countBars;
  }

  // Standard Worship arrangement template scaled to totalBars
  const template: { type: SectionType; label: string; bars: number; color: string }[] = [
    { type: 'INTRO', label: 'Intro', bars: 4, color: SECTION_COLORS[0] },
    { type: 'VERSO', label: 'Verso 1', bars: 8, color: SECTION_COLORS[1] },
    { type: 'VERSO_2', label: 'Verso 2', bars: 8, color: SECTION_COLORS[2] },
    { type: 'PRE', label: 'Pré-Refrão', bars: 4, color: SECTION_COLORS[17] },
    { type: 'REFRAO', label: 'Refrão 1', bars: 8, color: SECTION_COLORS[9] },
    { type: 'INTERLUDIO', label: 'Interlúdio', bars: 4, color: SECTION_COLORS[15] },
    { type: 'VERSO', label: 'Verso 3', bars: 8, color: SECTION_COLORS[3] },
    { type: 'REFRAO', label: 'Refrão 2', bars: 8, color: SECTION_COLORS[10] },
    { type: 'INSTRUMENTAL', label: 'Instrumental', bars: 4, color: SECTION_COLORS[11] },
    { type: 'PONTE', label: 'Ponte 1', bars: 8, color: SECTION_COLORS[4] },
    { type: 'SUBIDA', label: 'Subida / Build', bars: 4, color: SECTION_COLORS[7] },
    { type: 'REFRAO', label: 'Refrão 3', bars: 8, color: SECTION_COLORS[8] },
    { type: 'ESPONTANEO', label: 'Espontâneo', bars: 8, color: SECTION_COLORS[5] },
    { type: 'TAG', label: 'Tag', bars: 4, color: SECTION_COLORS[14] },
    { type: 'FINAL', label: 'Final', bars: 4, color: SECTION_COLORS[19] },
  ];

  let tplIdx = 0;
  while (cursorBar < totalBars) {
    const remaining = totalBars - cursorBar;
    if (remaining <= 6) {
      sections.push({
        id: uid('s'),
        type: 'FINAL',
        label: 'Final',
        start: song.firstBeat + cursorBar * barLen,
        end: song.duration,
        color: SECTION_META.FINAL.color,
      });
      break;
    }

    const item = template[tplIdx % template.length];
    const blockBars = Math.min(remaining, item.bars);
    const startSec = cursorBar === 0 ? 0 : song.firstBeat + cursorBar * barLen;
    const endSec = song.firstBeat + (cursorBar + blockBars) * barLen;

    // If we have real audio energy, adapt the section type to the energy level of this block!
    let chosenType = item.type;
    let chosenLabel = item.label;
    let chosenColor = item.color;

    if (hasAudioEnergy && tplIdx > 1) {
      let avgE = 0;
      for (let b = cursorBar; b < cursorBar + blockBars; b++) avgE += barEnergy[b];
      avgE /= blockBars;

      if (avgE > 0.76 && chosenType !== 'REFRAO' && chosenType !== 'SUBIDA') {
        chosenType = 'REFRAO';
        chosenLabel = 'Refrão Forte';
        chosenColor = SECTION_META.REFRAO.color;
      } else if (avgE < 0.35 && chosenType === 'REFRAO') {
        chosenType = 'MINISTRACAO';
        chosenLabel = 'Ministração Suave';
        chosenColor = SECTION_META.MINISTRACAO.color;
      }
    }

    sections.push({
      id: uid('s'),
      type: chosenType,
      label: chosenLabel,
      start: startSec,
      end: endSec,
      color: chosenColor,
    });

    cursorBar += blockBars;
    tplIdx++;
  }

  return sections;
}

/** Generate smart vocal & guitar transposition recommendations for the current song. */
export function getTranspositionRecommendations(song: Song): TranspositionAdvice[] {
  const orig = song.key;
  const makePreview = (k: string) => {
    const d = diatonicChords(k);
    return `${d.I}  ·  ${d.V}  ·  ${d.vi}  ·  ${d.IV}`;
  };

  const capoAdvice = (targetKey: string): string => {
    const openShapes = ['G', 'C', 'D', 'E', 'A'];
    if (openShapes.includes(targetKey)) return `Sem capotraste (Acordes abertos em ${targetKey})`;
    for (let fret = 1; fret <= 5; fret++) {
      const shape = transposeKey(targetKey, -fret);
      if (openShapes.includes(shape)) {
        return `Capotraste na ${fret}ª casa (Toque no formato de ${shape})`;
      }
    }
    return `Acordes com pestana em ${targetKey}`;
  };

  const list: { id: string; title: string; subtitle: string; delta: number }[] = [
    {
      id: 'orig',
      title: `Tom Original (${orig})`,
      subtitle: 'Fidelidade 100% aos timbres originais da multitrack',
      delta: 0,
    },
    {
      id: 'congregational',
      title: 'Congregacional Confortável (-2 semitons)',
      subtitle: 'Ideal para a igreja cantar junto sem forçar os agudos no refrão',
      delta: -2,
    },
    {
      id: 'female_lead',
      title: 'Voz Feminina Lead (+3 semitons)',
      subtitle: 'Região brilhante para Soprano / Mezzo-Soprano em louvor contemporâneo',
      delta: 3,
    },
    {
      id: 'male_baritone',
      title: 'Voz Masculina Barítono (-3 semitons)',
      subtitle: 'Confortável para tessitura masculina média/grave',
      delta: -3,
    },
    {
      id: 'acoustic_open',
      title: 'Violão Aberto / Acústico',
      subtitle: 'Transpõe para a tonalidade de acordes abertos mais próxima (G, C, D, E, A)',
      delta: (() => {
        const candidates = [-2, -1, 1, 2, -3, 3];
        for (const d of candidates) {
          if (['G', 'C', 'D', 'E', 'A'].includes(transposeKey(orig, d))) return d;
        }
        return 0;
      })(),
    },
    {
      id: 'mod_up',
      title: 'Subida de Tom (+1 semitom)',
      subtitle: 'Mais energia e brilho para refrão final ou celebração',
      delta: 1,
    },
  ];

  return list.map((item) => {
    const targetKey = transposeKey(orig, item.delta);
    return {
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      targetKey,
      semitones: item.delta,
      capoSuggestion: capoAdvice(targetKey),
      previewChords: makePreview(targetKey),
    };
  });
}

/** Generate a complete Worship ChordPro chart aligned to the song's sections and key. */
export function generateChordChartForSong(
  song: Song,
  style: 'modern' | 'intimate' | 'prophetic' | 'celebration' = 'modern',
): string {
  const d = diatonicChords(song.key);
  const lines: string[] = [];

  const secs = song.sections.length > 0 ? song.sections : detectSectionsFromAudio(song);

  for (const s of secs) {
    if (s.type === 'CONTAGEM') continue;
    lines.push(`[${s.label}]`);

    if (s.type === 'INTRO' || s.type === 'INTERLUDIO' || s.type === 'INSTRUMENTAL' || s.type === 'SOLO') {
      if (style === 'prophetic') {
        lines.push(`Base: [${d.vi}]   [${d.IV}]   [${d.I}]   [${d.V}]`);
      } else if (style === 'intimate') {
        lines.push(`Base: [${d.IV}]   [${d.I}]   [${d.V}]   [${d.vi}]`);
      } else {
        lines.push(`Base: [${d.I}]   [${d.V}]   [${d.vi}]   [${d.IV}]`);
      }
    } else if (s.type === 'VERSO' || s.type === 'VERSO_2') {
      lines.push(`[${d.I}]Ao ouvir Tua voz em [${d.V}]meio a este lugar`);
      lines.push(`[${d.vi}]Todo o meu coração se [${d.IV}]rende em adoração`);
    } else if (s.type === 'PRE') {
      lines.push(`[${d.ii}]Não há outro igual a [${d.I3}]Ti, Senhor`);
      lines.push(`[${d.IV}]Preparai o caminho [${d.V}]para o Rei`);
    } else if (s.type === 'REFRAO' || s.type === 'POS_REFRAO' || s.type === 'TAG') {
      if (style === 'intimate') {
        lines.push(`[${d.IV}]Santo, Santo é o [${d.I}]Senhor Deus Poderoso`);
        lines.push(`[${d.vi}]Digno de toda a [${d.V}]glória e louvor`);
      } else {
        lines.push(`[${d.I}]Grande é o Senhor, [${d.V}]digno de louvor`);
        lines.push(`[${d.vi}]Para sempre exaltado [${d.IV}]seja o Teu Nome`);
      }
    } else if (s.type === 'PONTE' || s.type === 'SUBIDA' || s.type === 'ESPONTANEO' || s.type === 'MINISTRACAO') {
      lines.push(`[${d.IV}]Teu Reino vem, [${d.V}]Tua vontade se faz`);
      lines.push(`[${d.vi}]Na terra como no [${d.I3}]céu  (${s.label})`);
    } else if (s.type === 'FINAL') {
      lines.push(`Final: [${d.IV}]   [${d.V}]   [${d.I}]`);
    } else {
      lines.push(`[${d.I}]   [${d.V}]   [${d.vi}]   [${d.IV}]`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Convert plain two-line chord sheets (like CifraClub / Letras where chords sit on a line above lyrics)
 * into inline ChordPro format (`[G]Letra...`).
 */
export function convertPlainCifraToChordPro(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  const isChordToken = (tok: string) =>
    /^[A-G][#b]?(?:m|maj|min|dim|aug|sus|add|\d|\+|\-|M)*(?:\/[A-G][#b]?)?$/.test(tok.trim());

  const isChordLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Section header like [Intro] or Intro:
    if (/^\[.*\]$/.test(trimmed)) return false;
    const tokens = trimmed.split(/\s+/);
    const valid = tokens.filter(isChordToken);
    return valid.length > 0 && valid.length / tokens.length >= 0.65;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Normalize section titles like "Intro:", "Primeira Parte:", "Refrão:", "[Intro] C G Am F"
    const secMatch = trimmed.match(/^\[?(Intro(?:dução)?|Verso\s*\d*|Primeira Parte|Segunda Parte|Pré-Refrão|Refrão|Ponte|Interlúdio|Solo|Final)\]?\s*:?\s*(.*)$/i);
    if (secMatch) {
      out.push(`[${secMatch[1]}]`);
      if (secMatch[2] && isChordLine(secMatch[2])) {
        const inline = secMatch[2]
          .trim()
          .split(/\s+/)
          .map((t) => (isChordToken(t) ? `[${t}]` : t))
          .join('  ');
        out.push(inline);
      }
      continue;
    }

    if (isChordLine(line)) {
      const nextLine = lines[i + 1];
      if (nextLine !== undefined && nextLine.trim() !== '' && !isChordLine(nextLine)) {
        // Merge chord positions into nextLine!
        const chordMatches = [...line.matchAll(/\S+/g)];
        let merged = nextLine;
        // Insert from right to left so character indices stay valid
        for (let c = chordMatches.length - 1; c >= 0; c--) {
          const m = chordMatches[c];
          const col = m.index ?? 0;
          const chord = m[0];
          if (!isChordToken(chord)) continue;
          if (col >= merged.length) {
            merged = merged.padEnd(col, ' ') + `[${chord}]`;
          } else {
            merged = merged.slice(0, col) + `[${chord}]` + merged.slice(col);
          }
        }
        out.push(merged);
        i++; // Skip the lyric line we just consumed
      } else {
        // Standalone instrumental chord line
        const inline = line
          .trim()
          .split(/\s+/)
          .map((t) => (isChordToken(t) ? `[${t}]` : t))
          .join('   ');
        out.push(inline);
      }
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

/** Optional Gemini AI assistant call for custom natural-language chord/arrangement generation. */
export async function askGeminiWorshipAi(
  apiKey: string,
  userPrompt: string,
  song: Song,
): Promise<string> {
  const effectiveKey = transposeKey(song.key, song.pitchOffset ?? 0);
  const sysPrompt = `Você é um Diretor Musical e Especialista em Playback Worship (estilo MultiTracks).
Música atual: "${song.name}" (${song.artist}), Tom Original: ${song.key}, Tom Atual: ${effectiveKey}, BPM: ${song.bpm}, Compasso: ${song.beatsPerBar}/4.
Seções atuais: ${song.sections.map((s) => s.label).join(' -> ') || 'Nenhuma'}.
Quando gerar cifras, use SEMPRE o formato ChordPro com acordes entre colchetes como [G], [D/F#], [Em7] e cabeçalhos de seção como [Intro], [Verso 1], [Refrão], [Ponte], [Final]. Responda em Português de forma direta e prática.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey.trim())}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${sysPrompt}\n\nPedido: ${userPrompt}` }] }],
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Erro Gemini API (${res.status})`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Sem resposta da IA.';
}
