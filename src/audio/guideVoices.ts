import { invoke } from '@tauri-apps/api/core';
import type { SectionType } from '../types';
import { decodeAudioDataSafe, loadGuideClip, saveGuideClip } from '../storage';

export interface GuideVoicePack {
  id: string;
  name: string;
  lang: 'pt-BR' | 'pt-PT' | 'en';
  badge: string;
  gender: 'female' | 'male';
  /** Independent pitch shift in semitones (-7..+5) applied via SOLA time-domain pitch shifter */
  pitchSemitones: number;
  /** Speaking tempo multiplier (1.0 = normal, 1.18 = brisk stage cue) */
  tempoRate: number;
  /** Low-shelf boost (dB @ 180 Hz) for warm studio body */
  lowShelfDb: number;
  /** Mid formant frequency (Hz) & gain (dB) for vocal clarity in In-Ear Monitors */
  formantFreq: number;
  formantGainDb: number;
  /** High-shelf boost (dB @ 4.2 kHz) for air & articulation */
  highShelfDb: number;
  useNativeSpeech?: boolean;
}

export const GUIDE_VOICE_PACKS: GuideVoicePack[] = [
  {
    id: 'neural_pt_female',
    name: '🎙️ IA Worship Feminina (Suave & Cristalina - PT-BR)',
    lang: 'pt-BR',
    badge: 'IA NEURAL PT-BR',
    gender: 'female',
    pitchSemitones: 0,
    tempoRate: 1.08,
    lowShelfDb: 0,
    formantFreq: 2800,
    formantGainDb: 1.5,
    highShelfDb: 1.5,
  },
  {
    id: 'neural_pt_male',
    name: '🎙️ IA Worship Masculina (Grave Estúdio - PT-BR)',
    lang: 'pt-BR',
    badge: 'IA ESTÚDIO PT-BR',
    gender: 'male',
    pitchSemitones: -2.0,
    tempoRate: 1.08,
    lowShelfDb: 1.5,
    formantFreq: 1100,
    formantGainDb: 1.5,
    highShelfDb: 1.0,
  },
  {
    id: 'neural_pt_energetic',
    name: '⚡ IA Diretor Musical (Ataque Rápido de Palco - PT-BR)',
    lang: 'pt-BR',
    badge: 'PALCO AO VIVO',
    gender: 'male',
    pitchSemitones: 0,
    tempoRate: 1.18,
    lowShelfDb: 0.5,
    formantFreq: 2400,
    formantGainDb: 2.0,
    highShelfDb: 2.0,
  },
  {
    id: 'neural_pt_baritone',
    name: '🔥 IA Locutor Worship Barítono (Voz Profunda - PT-BR)',
    lang: 'pt-BR',
    badge: 'BARÍTONO PRO',
    gender: 'male',
    pitchSemitones: -3.0,
    tempoRate: 1.05,
    lowShelfDb: 2.0,
    formantFreq: 950,
    formantGainDb: 1.8,
    highShelfDb: 1.0,
  },
  {
    id: 'neural_pt_pt_female',
    name: '🇵🇹 IA Estúdio Lusitana (Timbre Europeu Claro - PT)',
    lang: 'pt-PT',
    badge: 'NEURAL PT-EU',
    gender: 'female',
    pitchSemitones: 0,
    tempoRate: 1.08,
    lowShelfDb: 0,
    formantFreq: 2600,
    formantGainDb: 1.2,
    highShelfDb: 1.5,
  },
  {
    id: 'neural_en_female',
    name: '🌎 IA MultiTracks English Female (Intro, Verse, Chorus - EN-US)',
    lang: 'en',
    badge: 'ENGLISH CUES',
    gender: 'female',
    pitchSemitones: 0,
    tempoRate: 1.08,
    lowShelfDb: 0,
    formantFreq: 2750,
    formantGainDb: 1.2,
    highShelfDb: 1.5,
  },
  {
    id: 'neural_en_male',
    name: '🌎 IA MultiTracks English Male (Studio Director - EN-US)',
    lang: 'en',
    badge: 'ENGLISH STUDIO',
    gender: 'male',
    pitchSemitones: -2.2,
    tempoRate: 1.08,
    lowShelfDb: 1.5,
    formantFreq: 1200,
    formantGainDb: 1.5,
    highShelfDb: 1.0,
  },
  {
    id: 'system_native',
    name: '💻 Voz Nativa do Windows / Sistema (SAPI5 Offline)',
    lang: 'pt-BR',
    badge: 'SISTEMA LOCAL',
    gender: 'female',
    pitchSemitones: 0,
    tempoRate: 1.12,
    lowShelfDb: 0,
    formantFreq: 2000,
    formantGainDb: 0,
    highShelfDb: 0,
    useNativeSpeech: true,
  },
];

const EN_SECTION_LABELS: Partial<Record<SectionType, string>> = {
  CONTAGEM: 'One, two, three, four',
  INTRO: 'Intro',
  VERSO: 'Verse 1',
  VERSO_2: 'Verse 2',
  PRE: 'Pre Chorus',
  REFRAO: 'Chorus',
  POS_REFRAO: 'Post Chorus',
  INTERLUDIO: 'Interlude',
  PONTE: 'Bridge',
  SUBIDA: 'Build up',
  INSTRUMENTAL: 'Instrumental',
  SOLO: 'Solo',
  VAMP: 'Vamp',
  ESPONTANEO: 'Spontaneous',
  MINISTRACAO: 'Ministry',
  BREAK: 'Break',
  TAG: 'Tag',
  FINAL: 'Ending',
};

/** Standard Worship section vocabulary pre-downloaded when the user clicks Download. */
export const STANDARD_GUIDE_PHRASES: { label: string; type: SectionType }[] = [
  { label: 'Um, dois, três, quatro', type: 'CONTAGEM' },
  { label: 'Intro', type: 'INTRO' },
  { label: 'Introdução', type: 'INTRO' },
  { label: 'Verso', type: 'VERSO' },
  { label: 'Verso 1', type: 'VERSO' },
  { label: 'Verso 2', type: 'VERSO_2' },
  { label: 'Verso 3', type: 'VERSO' },
  { label: 'Pré-Refrão', type: 'PRE' },
  { label: 'Refrão', type: 'REFRAO' },
  { label: 'Refrão 1', type: 'REFRAO' },
  { label: 'Refrão 2', type: 'REFRAO' },
  { label: 'Pós-Refrão', type: 'POS_REFRAO' },
  { label: 'Interlúdio', type: 'INTERLUDIO' },
  { label: 'Ponte', type: 'PONTE' },
  { label: 'Ponte 1', type: 'PONTE' },
  { label: 'Ponte 2', type: 'PONTE' },
  { label: 'Subida', type: 'SUBIDA' },
  { label: 'Instrumental', type: 'INSTRUMENTAL' },
  { label: 'Solo', type: 'SOLO' },
  { label: 'Vamp', type: 'VAMP' },
  { label: 'Espontâneo', type: 'ESPONTANEO' },
  { label: 'Ministração', type: 'MINISTRACAO' },
  { label: 'Break', type: 'BREAK' },
  { label: 'Tag', type: 'TAG' },
  { label: 'Final', type: 'FINAL' },
];

const rawLangBufferCache = new Map<string, AudioBuffer>();
const processedPackBufferCache = new Map<string, AudioBuffer>();
let activeGuideSource: AudioBufferSourceNode | null = null;

/** Translate section label when using an English Worship Guide pack. */
export function resolveSpokenText(label: string, type: SectionType, lang: 'pt-BR' | 'pt-PT' | 'en'): string {
  const clean = label.trim();
  if (lang === 'en') {
    if (/^verso\s*1$/i.test(clean)) return 'Verse 1';
    if (/^verso\s*2$/i.test(clean)) return 'Verse 2';
    if (/^verso\s*3$/i.test(clean)) return 'Verse 3';
    if (/^refr[aã]o\s*1$/i.test(clean)) return 'Chorus 1';
    if (/^refr[aã]o\s*2$/i.test(clean)) return 'Chorus 2';
    if (/^ponte\s*1$/i.test(clean)) return 'Bridge 1';
    if (/^ponte\s*2$/i.test(clean)) return 'Bridge 2';
    return EN_SECTION_LABELS[type] ?? clean;
  }
  return clean;
}

/**
 * True WSOLA / Overlap-Add Time-Domain Pitch & Tempo Processor for Vocal Cues.
 * Shifts pitch by `semitones` and tempo by `tempoRate` independently.
 */
function processVoiceBufferSOLA(
  ctx: AudioContext,
  input: AudioBuffer,
  semitones: number,
  tempoRate: number,
): AudioBuffer {
  const pitchRatio = Math.pow(2, semitones / 12);
  const safeTempo = Math.max(0.65, Math.min(1.65, tempoRate));

  // If virtually unchanged, return input directly
  if (Math.abs(pitchRatio - 1) < 0.02 && Math.abs(safeTempo - 1) < 0.02) {
    return input;
  }

  const sr = input.sampleRate;
  const src = input.getChannelData(0);
  const inLen = src.length;

  const stretchFactor = pitchRatio / safeTempo;
  const stretchedLen = Math.max(256, Math.round(inLen * stretchFactor));
  const stretched = new Float32Array(stretchedLen);
  const norm = new Float32Array(stretchedLen);

  const winSize = Math.round(sr * 0.032); // 32ms vocal frame
  const halfWin = winSize >> 1;
  const synHop = halfWin; // 50% overlap (16ms)
  const anaHop = synHop / stretchFactor;
  const maxSeek = Math.round(sr * 0.012); // 12ms pitch-period correlation search

  const hann = new Float32Array(winSize);
  for (let i = 0; i < winSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winSize - 1)));
  }

  let synPos = 0;
  let anaPos = 0;

  while (synPos + winSize < stretchedLen && anaPos + winSize < inLen) {
    let bestOffset = 0;
    if (synPos > 0) {
      let bestCorr = -Infinity;
      const searchStart = Math.max(0, Math.round(anaPos) - maxSeek);
      const searchEnd = Math.min(inLen - winSize, Math.round(anaPos) + maxSeek);
      const overlapCheck = Math.min(halfWin, 256);
      for (let cand = searchStart; cand <= searchEnd; cand += 2) {
        let corr = 0;
        for (let k = 0; k < overlapCheck; k += 2) {
          corr += stretched[synPos + k] * src[cand + k];
        }
        if (corr > bestCorr) {
          bestCorr = corr;
          bestOffset = cand - Math.round(anaPos);
        }
      }
    }

    const readBase = Math.max(0, Math.min(inLen - winSize, Math.round(anaPos) + bestOffset));
    for (let i = 0; i < winSize; i++) {
      const w = hann[i];
      stretched[synPos + i] += src[readBase + i] * w;
      norm[synPos + i] += w; // Correct OLA normalization
    }

    synPos += synHop;
    anaPos += anaHop;
  }

  for (let i = 0; i < stretchedLen; i++) {
    if (norm[i] > 0.05) {
      stretched[i] /= norm[i];
    }
  }

  // Step 2: Resample `stretched` by `pitchRatio` using Hermite cubic interpolation
  const outLen = Math.max(128, Math.round(stretchedLen / pitchRatio));
  const outBuf = ctx.createBuffer(1, outLen, sr);
  const out = outBuf.getChannelData(0);

  for (let i = 0; i < outLen; i++) {
    const pos = i * pitchRatio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const xm1 = stretched[Math.max(0, idx - 1)] ?? 0;
    const x0 = stretched[Math.min(stretchedLen - 1, idx)] ?? 0;
    const x1 = stretched[Math.min(stretchedLen - 1, idx + 1)] ?? 0;
    const x2 = stretched[Math.min(stretchedLen - 1, idx + 2)] ?? 0;
    const c0 = x0;
    const c1 = 0.5 * (x1 - xm1);
    const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
    const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    out[i] = Math.max(-0.95, Math.min(0.95, ((c3 * frac + c2) * frac + c1) * frac + c0));
  }

  return outBuf;
}

/**
 * Fetch Neural TTS MP3 bytes using:
 * 1. Tauri v2 official `invoke('fetch_tts_audio')` (uses Windows curl.exe, zero CORS restrictions)
 * 2. Vite dev proxy `/__tts_proxy`
 * 3. Direct browser fetch fallback
 */
async function fetchNeuralTtsBytes(text: string, lang: string): Promise<ArrayBuffer | null> {
  // 1. Try Tauri v2 official invoke('fetch_tts_audio')
  try {
    const bytes = await invoke<number[]>('fetch_tts_audio', {
      text,
      lang,
      slow: false,
    });
    if (Array.isArray(bytes) && bytes.length > 256) {
      return new Uint8Array(bytes).buffer;
    }
  } catch {
    /* try fallback */
  }

  // 2. Try Vite dev proxy
  try {
    const proxyUrl = `/__tts_proxy?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&ttsspeed=1&client=tw-ob`;
    const resp = await fetch(proxyUrl);
    const ctype = resp.headers.get('content-type') || '';
    if (resp.ok && !ctype.includes('text/html')) {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > 256) return ab;
    }
  } catch {
    /* try fallback */
  }

  // 3. Direct browser fetch
  try {
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&ttsspeed=1&client=tw-ob`;
    const resp = await fetch(url);
    if (resp.ok) {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > 256) return ab;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Get or fetch+decode the base Neural TTS AudioBuffer for `(lang, spokenText)`. */
async function getOrFetchBaseLangBuffer(
  ctx: AudioContext,
  lang: 'pt-BR' | 'pt-PT' | 'en',
  spokenText: string,
): Promise<AudioBuffer | null> {
  const clipKey = `${lang}:${spokenText.toLowerCase()}`;
  const mem = rawLangBufferCache.get(clipKey);
  if (mem) return mem;

  // Check persistent IndexedDB cache
  try {
    const savedAb = await loadGuideClip(clipKey);
    if (savedAb && savedAb.byteLength > 256) {
      const decoded = await decodeAudioDataSafe(ctx, savedAb);
      rawLangBufferCache.set(clipKey, decoded);
      return decoded;
    }
  } catch {
    /* ignore */
  }

  // Fetch on-the-fly from Neural TTS server and save to IndexedDB
  const netAb = await fetchNeuralTtsBytes(spokenText, lang);
  if (netAb && netAb.byteLength > 256) {
    try {
      await saveGuideClip(clipKey, netAb.slice(0));
      const decoded = await decodeAudioDataSafe(ctx, netAb);
      rawLangBufferCache.set(clipKey, decoded);
      return decoded;
    } catch (err) {
      console.warn('Falha ao decodificar voz guia:', err);
    }
  }
  return null;
}

/** Play an AudioBuffer through the Studio Voice Formant & SOLA Pitch DSP chain directly into Out 5 (Guide). */
async function playBufferWithPackDsp(
  ctx: AudioContext,
  dest: AudioNode,
  rawBuf: AudioBuffer,
  spokenText: string,
  pack: GuideVoicePack,
  volume: number,
  userPitchMultiplier: number,
  userRate: number,
) {
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }

  // Stop any currently speaking guide clip so cues never overlap
  if (activeGuideSource) {
    try {
      activeGuideSource.stop();
    } catch {
      /* ignore */
    }
    activeGuideSource = null;
  }
  window.speechSynthesis?.cancel();

  // Compute combined pitch in semitones (Pack character semitones + User slider semitones)
  const userSemitones = 12 * Math.log2(Math.max(0.5, Math.min(2.0, userPitchMultiplier)));
  const totalSemitones = Math.round((pack.pitchSemitones + userSemitones) * 10) / 10;
  const totalTempo = Math.round(pack.tempoRate * (userRate / 1.12) * 100) / 100;

  const src = ctx.createBufferSource();

  // If total semitones is near 0, play pristine Neural buffer directly without SOLA artifacts!
  if (Math.abs(totalSemitones) < 0.1) {
    src.buffer = rawBuf;
    src.playbackRate.value = totalTempo;
  } else {
    const packCacheKey = `${pack.id}:${spokenText.toLowerCase()}:${totalSemitones}:${totalTempo}`;
    let processedBuf = processedPackBufferCache.get(packCacheKey);
    if (!processedBuf) {
      processedBuf = processVoiceBufferSOLA(ctx, rawBuf, totalSemitones, totalTempo);
      processedPackBufferCache.set(packCacheKey, processedBuf);
    }
    src.buffer = processedBuf;
  }

  // High-pass filter at 90 Hz to remove DC rumble and plosives
  const highPass = ctx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = 90;

  // 3-Band Studio Vocal EQ Chain (gentle, unclipped musical tuning)
  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = 'lowshelf';
  lowShelf.frequency.value = 185;
  lowShelf.gain.value = Math.min(3.0, pack.lowShelfDb);

  const formant = ctx.createBiquadFilter();
  formant.type = 'peaking';
  formant.frequency.value = pack.formantFreq;
  formant.Q.value = 1.2;
  formant.gain.value = Math.min(2.5, pack.formantGainDb);

  const highShelf = ctx.createBiquadFilter();
  highShelf.type = 'highshelf';
  highShelf.frequency.value = 4200;
  highShelf.gain.value = Math.min(2.0, pack.highShelfDb);

  // Brickwall safety limiter to completely prevent digital clipping and distortion in monitors
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.0;
  limiter.knee.value = 3.0;
  limiter.ratio.value = 16.0;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.06;

  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.min(1.0, Math.max(0, volume));

  src.connect(highPass);
  highPass.connect(lowShelf);
  lowShelf.connect(formant);
  formant.connect(highShelf);
  highShelf.connect(limiter);
  limiter.connect(gainNode);
  gainNode.connect(dest);

  activeGuideSource = src;
  src.onended = () => {
    if (activeGuideSource === src) activeGuideSource = null;
  };
  src.start(ctx.currentTime);
}

/**
 * Play spoken guide announcement using:
 * 1. Downloaded / Cached Neural TTS AudioBuffer + SOLA Pitch/Formant DSP routed directly to Out 5 (Guide), or
 * 2. Native OS SpeechSynthesis ONLY if the user explicitly chose `system_native`.
 */
export function speakWithGuidePack(
  ctx: AudioContext,
  guideGainNode: AudioNode | undefined,
  text: string,
  sectionType: SectionType,
  packId: string | undefined,
  customVoiceName: string,
  volume: number,
  customPitch = 1.0,
  customRate = 1.12,
) {
  const pack = GUIDE_VOICE_PACKS.find((p) => p.id === packId) ?? GUIDE_VOICE_PACKS[0];
  const spokenText = resolveSpokenText(text, sectionType, pack.lang);
  const dest = guideGainNode ?? ctx.destination;

  if (!pack.useNativeSpeech && !customVoiceName) {
    window.speechSynthesis?.cancel();
    void getOrFetchBaseLangBuffer(ctx, pack.lang, spokenText).then((rawBuf) => {
      if (rawBuf) {
        void playBufferWithPackDsp(ctx, dest, rawBuf, spokenText, pack, volume, customPitch, customRate);
      } else {
        speakNativeFallback(spokenText, pack, customVoiceName, volume, customPitch, customRate);
      }
    });
    return;
  }

  speakNativeFallback(spokenText, pack, customVoiceName, volume, customPitch, customRate);
}

function speakNativeFallback(
  spokenText: string,
  pack: GuideVoicePack,
  customVoiceName: string,
  volume: number,
  customPitch: number,
  customRate: number,
) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(spokenText);
  u.lang = pack.lang === 'en' ? 'en-US' : pack.lang;
  const packPitchFactor = Math.pow(2, pack.pitchSemitones / 12);
  u.pitch = Math.max(0.4, Math.min(1.9, packPitchFactor * customPitch));
  u.rate = Math.max(0.6, Math.min(2.0, (pack.tempoRate * customRate) / 1.12));
  u.volume = Math.min(1, Math.max(0, volume));

  const voices = window.speechSynthesis.getVoices();
  let chosen: SpeechSynthesisVoice | undefined;
  if (customVoiceName) {
    chosen = voices.find((v) => v.name === customVoiceName);
  }
  if (!chosen) {
    const langPrefix = pack.lang.slice(0, 2).toLowerCase();
    const langVoices = voices.filter((v) => v.lang.toLowerCase().startsWith(langPrefix));
    chosen = langVoices[0];
  }
  if (chosen) u.voice = chosen;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/**
 * Pre-download, SOLA-process, and persist in IndexedDB all standard Worship phrases + current song section labels
 * for the selected Neural Voice Pack so it works 100% offline on stage through Out 5!
 */
export async function downloadOnlineGuidePack(
  ctx: AudioContext,
  packId: string,
  sectionLabels: { label: string; type: SectionType }[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const pack = GUIDE_VOICE_PACKS.find((p) => p.id === packId) ?? GUIDE_VOICE_PACKS[0];

  const combined = [...STANDARD_GUIDE_PHRASES, ...sectionLabels];
  const seen = new Set<string>();
  const unique: { label: string; type: SectionType; spokenText: string }[] = [];
  for (const item of combined) {
    const spokenText = resolveSpokenText(item.label, item.type, pack.lang);
    const key = spokenText.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({ ...item, spokenText });
    }
  }

  let downloaded = 0;
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    const rawBuf = await getOrFetchBaseLangBuffer(ctx, pack.lang, item.spokenText);
    if (rawBuf) {
      // Pre-render the SOLA pitch-shifted buffer for this pack into RAM cache as well
      const packCacheKey = `${pack.id}:${item.spokenText.toLowerCase()}:${pack.pitchSemitones}:${pack.tempoRate}`;
      if (!processedPackBufferCache.has(packCacheKey)) {
        processedPackBufferCache.set(
          packCacheKey,
          processVoiceBufferSOLA(ctx, rawBuf, pack.pitchSemitones, pack.tempoRate),
        );
      }
      downloaded++;
    }
    onProgress?.(i + 1, unique.length);
  }
  return downloaded;
}
