import type { BusGroup, OutputBus, Section, SectionType, Song, Track, TrackKind } from './types';
import { isCombinedClickGuide } from './audio/audioSeparation';

export const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const SECTION_META: Record<SectionType, { label: string; short: string; color: string }> = {
  CONTAGEM: { label: 'Contagem', short: 'Cnt', color: '#4A5568' },
  INTRO: { label: 'Intro', short: 'I', color: '#5C6BC0' },
  VERSO: { label: 'Verso 1', short: 'V1', color: '#2980B9' },
  VERSO_2: { label: 'Verso 2', short: 'V2', color: '#2563EB' },
  PRE: { label: 'Pré-Refrão', short: 'PC', color: '#16A085' },
  REFRAO: { label: 'Refrão', short: 'C', color: '#D35400' },
  POS_REFRAO: { label: 'Pós-Refrão', short: 'PsC', color: '#C0392B' },
  INTERLUDIO: { label: 'Interlúdio', short: 'Int', color: '#8E44AD' },
  PONTE: { label: 'Ponte', short: 'B', color: '#8E44AD' },
  SUBIDA: { label: 'Subida', short: 'Sub', color: '#EC4899' },
  INSTRUMENTAL: { label: 'Instrumental', short: 'Ins', color: '#27AE60' },
  SOLO: { label: 'Solo', short: 'Sol', color: '#2ECC71' },
  VAMP: { label: 'Vamp', short: 'Vmp', color: '#14B8A6' },
  ESPONTANEO: { label: 'Espontâneo', short: 'Esp', color: '#A855F7' },
  MINISTRACAO: { label: 'Ministração', short: 'Min', color: '#6366F1' },
  BREAK: { label: 'Parada / Break', short: 'Brk', color: '#E74C3C' },
  TAG: { label: 'Tag', short: 'T', color: '#27AE60' },
  FINAL: { label: 'Final / Outro', short: 'O', color: '#4A5568' },
};

export const SECTION_TYPES = Object.keys(SECTION_META) as SectionType[];

/** Rich 20-color stage palette for section markers */
export const SECTION_COLORS = [
  '#0EA5E9', // Sky Cyan
  '#2563EB', // Royal Blue
  '#4F46E5', // Indigo
  '#6366F1', // Periwinkle
  '#8B5CF6', // Violet
  '#A855F7', // Purple
  '#D946EF', // Fuchsia
  '#EC4899', // Hot Pink
  '#F43F5E', // Rose Red
  '#EF4444', // Crimson
  '#F97316', // Deep Orange
  '#F59E0B', // Amber
  '#EAB308', // Gold
  '#84CC16', // Lime
  '#22C55E', // Emerald Green
  '#10B981', // Mint Green
  '#14B8A6', // Teal
  '#06B6D4', // Cyan
  '#64748B', // Cool Slate
  '#475569', // Dark Slate
];

export function sectionColor(s: Pick<Section, 'type' | 'color'>): string {
  return s.color || SECTION_META[s.type]?.color || '#2563EB';
}

export const OUTPUT_BUSES: { id: OutputBus; label: string; short: string; desc: string }[] = [
  { id: 'OUT_1_2', label: 'Out 1/2 (Estéreo)', short: 'Out 1/2', desc: 'Canais Físicos 1 e 2 (Estéreo)' },
  { id: 'OUT_1_L', label: 'Out 1 (Mono)', short: 'Out 1', desc: 'Canal Físico 1 (Mono L)' },
  { id: 'OUT_2_R', label: 'Out 2 (Mono)', short: 'Out 2', desc: 'Canal Físico 2 (Mono R)' },
  { id: 'OUT_3_4', label: 'Out 3/4 (Estéreo)', short: 'Out 3/4', desc: 'Canais Físicos 3 e 4 (Estéreo)' },
  { id: 'OUT_3', label: 'Out 3 (Mono)', short: 'Out 3', desc: 'Canal Físico 3 (Mono)' },
  { id: 'OUT_4', label: 'Out 4 (Mono)', short: 'Out 4', desc: 'Canal Físico 4 (Mono)' },
  { id: 'OUT_5_6', label: 'Out 5/6 (Estéreo)', short: 'Out 5/6', desc: 'Canais Físicos 5 e 6 (Estéreo)' },
  { id: 'OUT_5', label: 'Out 5 (Mono)', short: 'Out 5', desc: 'Canal Físico 5 (Mono)' },
  { id: 'OUT_6', label: 'Out 6 (Mono)', short: 'Out 6', desc: 'Canal Físico 6 (Mono)' },
  { id: 'OUT_7_8', label: 'Out 7/8 (Estéreo)', short: 'Out 7/8', desc: 'Canais Físicos 7 e 8 (Estéreo)' },
  { id: 'OUT_7', label: 'Out 7 (Mono)', short: 'Out 7', desc: 'Canal Físico 7 (Mono)' },
  { id: 'OUT_8', label: 'Out 8 (Mono)', short: 'Out 8', desc: 'Canal Físico 8 (Mono)' },
];

/**
 * Dynamically filters available output buses based on the exact hardware channel count
 * supported by the selected soundcard, while always keeping any currently assigned bus visible.
 */
export function getAvailableOutputBuses(
  maxChannels = 2,
  currentBus?: OutputBus,
): { id: OutputBus; label: string; short: string; desc: string }[] {
  const ch = Math.max(2, maxChannels);
  return OUTPUT_BUSES.filter((b) => {
    // Always include current assignment if already set
    if (currentBus && b.id === currentBus) return true;
    // Channels 1 and 2 are always available
    if (b.id === 'OUT_1_2' || b.id === 'OUT_1_L' || b.id === 'OUT_2_R') return true;
    // Channels 3 and 4
    if (b.id === 'OUT_3_4' || b.id === 'OUT_3' || b.id === 'OUT_4') return ch >= 4;
    // Channels 5 and 6
    if (b.id === 'OUT_5_6' || b.id === 'OUT_5' || b.id === 'OUT_6') return ch >= 6;
    // Channels 7 and 8
    if (b.id === 'OUT_7_8' || b.id === 'OUT_7' || b.id === 'OUT_8') return ch >= 8;
    return false;
  });
}

export const BUS_GROUPS: { id: BusGroup; label: string; color: string }[] = [
  { id: 'UTILITY', label: 'CLICK & GUIA', color: '#E9B44C' },
  { id: 'DRUMS', label: 'BATERIA & PERC', color: '#E5484D' },
  { id: 'BASS', label: 'BAIXO', color: '#8E5CF6' },
  { id: 'GUITARS', label: 'GUITARRAS & VIOLÃO', color: '#F2994A' },
  { id: 'KEYS', label: 'TECLADOS & PADS', color: '#2F80ED' },
  { id: 'VOCALS', label: 'VOZES / CORO', color: '#EB5FA8' },
];

export const TRACK_COLORS = [
  '#2f80ed', '#e5484d', '#27ae60', '#f2994a', '#8e5cf6', '#00a7c4',
  '#eb5fa8', '#c9a227', '#4fb3a9', '#9b7b5b', '#7a8bff', '#d96c3f',
  '#0ea5e9', '#10b981', '#f43f5e', '#a855f7', '#eab308', '#14b8a6',
];

export function keyIndex(key: string): number {
  const clean = key.trim().replace(/m$/, '');
  let i = KEYS.indexOf(clean);
  if (i < 0) i = NOTES_SHARP.indexOf(clean);
  if (i < 0) i = NOTES_FLAT.indexOf(clean);
  return i < 0 ? 0 : i;
}

export function transposeKey(rootKey: string, semitones: number): string {
  const cleanKey = rootKey.trim();
  const isMinor = cleanKey.endsWith('m');
  const base = isMinor ? cleanKey.slice(0, -1) : cleanKey;

  let index = NOTES_SHARP.indexOf(base);
  let useFlats = false;
  if (index === -1) {
    index = NOTES_FLAT.indexOf(base);
    useFlats = true;
  }
  if (index === -1) return rootKey;

  const targetIndex = (index + semitones + 120) % 12;
  const scale = useFlats || [-1, -3, -5, 5].includes(semitones) ? NOTES_FLAT : KEYS;
  return `${scale[targetIndex]}${isMinor ? 'm' : ''}`;
}

export function relativeMinor(majorKey: string): string {
  return `${transposeKey(majorKey.replace(/m$/, ''), -3)}m`;
}

export function diatonicChords(rootKey: string): {
  I: string;
  ii: string;
  iii: string;
  IV: string;
  V: string;
  vi: string;
  I3: string;
} {
  const k = rootKey.replace(/m$/, '');
  const I = k;
  const ii = `${transposeKey(k, 2)}m7`;
  const iii = `${transposeKey(k, 4)}m`;
  const IV = transposeKey(k, 5);
  const V = transposeKey(k, 7);
  const vi = `${transposeKey(k, 9)}m7`;
  const third = transposeKey(k, 4);
  return { I, ii, iii, IV, V, vi, I3: `${I}/${third}` };
}

export function transposeChordPro(content: string, semitones: number): string {
  if (!content || semitones === 0) return content;
  return content.replace(/\[([A-G][#b]?[^/\]]*)(?:\/([A-G][#b]?))?\]/g, (_, mainChord, bassNote) => {
    const match = mainChord.match(/^([A-G][#b]?)(.*)$/);
    if (!match) return `[${mainChord}]`;
    const [, root, suffix] = match;
    const transposedRoot = transposeKey(root, semitones);
    const transposedBass = bassNote ? `/${transposeKey(bassNote, semitones)}` : '';
    return `[${transposedRoot}${suffix}${transposedBass}]`;
  });
}

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

const UNPITCHED_STEM_REGEX =
  /\b(click|clique|metr[oô]nomo|guide|guia|cues?|count|contagem|drums?|bateria|bat|kit|perc|percuss[aã]o|shaker|tamb|tambourine|pandeiro|conga|bongo|caj[oó]n|clap|snap|kick|bumbo|snare|caixa|hat|hihat|hi-hat|hh|chimbal|toms?|tons?|surdo|floor|overhead|oh|room|sala|cymbals?|pratos?|crash|ride|loop|beat|fx|sfx|sub\s*drop|impact)\b/i;

/** Determine if a track should be pitch-shifted when changing song key (excludes Drums, Percussion, Click & Guide). */
export function isTrackPitched(
  t: Pick<Track, 'name' | 'fileName' | 'kind' | 'bus' | 'pitchShift'>,
): boolean {
  if (typeof t.pitchShift === 'boolean') return t.pitchShift;
  if (t.kind === 'click' || t.kind === 'guide') return false;
  if (t.bus === 'DRUMS' || t.bus === 'UTILITY') return false;
  const combined = `${t.name} ${t.fileName ?? ''}`
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ');
  if (UNPITCHED_STEM_REGEX.test(combined)) return false;
  return true;
}

/** Infer the best BusGroup for a track (even for already-imported tracks). */
export function inferTrackBus(t: Pick<Track, 'name' | 'fileName' | 'kind' | 'bus'>): BusGroup {
  if (t.kind === 'click' || t.kind === 'guide') return 'UTILITY';
  const combined = `${t.name} ${t.fileName ?? ''}`
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  if (/\b(click|clique|metr[oô]nomo|guide|guia|cues?|count|contagem)\b/.test(combined)) return 'UTILITY';
  if (
    /\b(drums?|bateria|bat|kit|perc|percuss[aã]o|shaker|tamb|pandeiro|conga|bongo|caj[oó]n|clap|snap|kick|bumbo|snare|caixa|hat|hihat|hh|chimbal|toms?|tons?|surdo|floor|overhead|oh|room|sala|cymbals?|pratos?|crash|ride|loop|beat|fx|sfx)\b/.test(
      combined,
    )
  ) {
    return 'DRUMS';
  }
  if (/\b(bass|baixo|sub)\b/.test(combined)) return 'BASS';
  if (/\b(gtr|guit|guitarra|viol[aã]o|acoustic|eg\d*|ag\d*|swell|lead\s*gtr)\b/.test(combined)) return 'GUITARS';
  if (/\b(voc|vocal|voz|vozes|bgv|bv|choir|coro|backing)\b/.test(combined)) return 'VOCALS';
  return t.bus ?? 'KEYS';
}

/** Guess a concise display name, color, kind, bus and output for a stem file name. */
export function guessTrack(
  fileName: string,
  idx: number,
  songContextName = '',
): { name: string; color: string; kind: TrackKind; bus: BusGroup; output: OutputBus; pitchShift: boolean; isCombinedClickGuide?: boolean } {
  // 1. Remove file extension and folder paths
  let clean = fileName.split(/[\\/]/).pop() || fileName;
  clean = clean.replace(/\.[a-z0-9]+$/i, '');

  // 2. Remove songContextName or artist prefix if present (e.g. "Song Name - Drums")
  if (songContextName && clean.toLowerCase().startsWith(songContextName.toLowerCase())) {
    clean = clean.slice(songContextName.length);
  }

  // 3. If there are segments separated by " - ", usually the last segment is the instrument:
  // e.g. "Gabriel Guedes - Vitorioso És - Electric Guitar 1" -> "Electric Guitar 1"
  if (clean.includes(' - ')) {
    const parts = clean.split(' - ').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (/[a-zA-Z]/.test(last)) {
        clean = last;
      }
    }
  }

  // 4. Remove leading numbering patterns: "01. ", "01 - ", "01_", "01 ", "track01 "
  clean = clean.replace(/^[\d\s._-]+/, '').replace(/^track[\s._-]*\d+[\s._-]*/i, '');

  // 5. Remove trailing BPM, Key, Time Sig patterns: " - 128BPM", "_72bpm", " 4-4", " - G"
  clean = clean.replace(/[\s._-]+(\d{2,3}\s*bpm|\d+\s*-\s*\d+|key\s*[a-g][#b]?m?|[a-g][#b]?(maj|min|m)?)+$/i, '');

  const low = clean.toLowerCase();
  const norm = clean.replace(/[_\-.\s+&/\\()]+/g, ' ').toLowerCase();

  // Nome legível formatado preservando descrições específicas (ex: "SNARE TOP", "VIOLÃO 1", "EG LEAD", "SHAKER")
  const formattedClean = clean
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  // 1. COMBINED CLICK & GUIDE (Deve ser verificado antes para não ser categorizado apenas como Click)
  if (isCombinedClickGuide(clean) || isCombinedClickGuide(fileName)) {
    return {
      name: 'CLICK & GUIA (COMBINADO)',
      color: '#F39C12',
      kind: 'audio',
      bus: 'UTILITY',
      output: 'OUT_6',
      pitchShift: false,
      isCombinedClickGuide: true,
    };
  }

  // 2. CLICK (Áudio Original)
  if (
    /\b(click|metr[oô]nomo|clique|bpm|tempo)\b/i.test(norm) ||
    norm.includes('click') ||
    norm.includes('clique') ||
    norm.includes('metronomo')
  ) {
    return { name: 'CLICK (Áudio Original)', color: '#F39C12', kind: 'audio', bus: 'UTILITY', output: 'OUT_6', pitchShift: false };
  }

  // 3. GUIDE / CUING (Áudio Original)
  if (
    /\b(guide|guia|cues?|count|contagem|voz\s*guia|slate)\b/i.test(norm) ||
    norm.includes('guide') ||
    norm.includes('guia') ||
    norm.includes('cue') ||
    norm.includes('contagem')
  ) {
    return { name: 'GUIDE (Áudio Original)', color: '#0099FF', kind: 'audio', bus: 'UTILITY', output: 'OUT_5', pitchShift: false };
  }

  // 4. DRUMS & PERCUSSION
  if (
    /\b(kick|bumbo|bd|snare|caixa|sd|snr|hat|hihat|hi[\s_-]*hat|hh|chimbal|toms?|tons?|surdo|floor|rack|cymbal|cymbals|pratos?|overhead|oh|crash|ride|perc|percuss[aã]o|shaker|tamb|pandeiro|conga|bongo|clap|snap|loop|beat|drums?|bateria|kit)\b/i.test(
      low,
    )
  ) {
    let name = formattedClean;
    if (!name || name.length <= 2) {
      if (/\b(kick|bumbo|bd)\b/i.test(low)) name = 'BUMBO';
      else if (/\b(snare|caixa|sd|snr)\b/i.test(low)) name = 'CAIXA';
      else if (/\b(hat|hihat|hh|chimbal)\b/i.test(low)) name = 'CHIMBAL';
      else if (/\b(toms?|tons?)\b/i.test(low)) name = 'TONS';
      else if (/\b(cymbal|pratos?|overhead|oh|crash|ride)\b/i.test(low)) name = 'PRATOS';
      else if (/\b(loop|beat)\b/i.test(low)) name = 'LOOP';
      else name = 'BATERIA';
    }
    return { name, color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }

  // 5. FX / SFX
  if (/\b(fx|sfx|swell|impact|riser|drop)\b/i.test(low)) {
    return { name: formattedClean || 'EFEITOS (FX)', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }

  // 6. BASS
  if (/\b(synth\s*bass|sub\s*bass|moog|sub|bass|baixo|contra\s*baixo|e[\s_-]*bass)\b/i.test(low)) {
    let name = formattedClean;
    if (!name || name.length <= 2) {
      name = /\b(synth|sub|moog)\b/i.test(low) ? 'SYNTH BASS' : 'BAIXO';
    }
    return { name, color: '#8E5CF6', kind: 'audio', bus: 'BASS', output: 'OUT_3_4', pitchShift: true };
  }

  // 7. GUITARS
  if (/\b(ag\d*|acoustic|viol[aã]o|ac[uú]stic\s*gtr|ac\s*gtr|eg\d*|electric|guitarra|gtr|guitarras|solo|riff|lead\s*gtr)\b/i.test(low)) {
    let name = formattedClean;
    if (!name || name.length <= 2) {
      if (/\b(ag\d*|acoustic|viol[aã]o)\b/i.test(low)) name = 'VIOLÃO';
      else if (/\b(solo|lead)\b/i.test(low)) name = 'GUITARRA SOLO';
      else name = 'GUITARRA';
    }
    return { name, color: '#F2994A', kind: 'audio', bus: 'GUITARS', output: 'OUT_1_2', pitchShift: true };
  }

  // 8. KEYS, SYNTHS, PADS, ORCHESTRA
  if (
    /\b(piano|grand|upright|rhodes|wurlitzer|ep|organ|org[aã]o|b3|hammond|pad|pads|ambient|atmosphere|shimmer|atmo|synth|synths|sint|arp|strings?|cordas|cello|violin|viola|brass|metais|horn|trompete|key|keys|teclado)\b/i.test(
      low,
    )
  ) {
    let name = formattedClean;
    if (!name || name.length <= 2) {
      if (/\b(piano|grand|upright)\b/i.test(low)) name = 'PIANO';
      else if (/\b(rhodes|organ|org[aã]o)\b/i.test(low)) name = 'ÓRGÃO / RHODES';
      else if (/\b(pad|ambient|shimmer)\b/i.test(low)) name = 'PAD';
      else if (/\b(synth|sint|arp)\b/i.test(low)) name = 'SYNTH';
      else if (/\b(strings?|cordas|brass|metais)\b/i.test(low)) name = 'CORDAS / METAIS';
      else name = 'TECLADO';
    }
    return { name, color: '#2F80ED', kind: 'audio', bus: 'KEYS', output: 'OUT_1_2', pitchShift: true };
  }

  // 9. VOCALS
  if (/\b(lead\s*voc|lead\s*vox|voz\s*principal|vocal\s*principal|bgv|bgvs|backing|backings|coro|choir|vozes|vocal|vocals|voz)\b/i.test(low)) {
    let name = formattedClean;
    if (!name || name.length <= 2) {
      if (/\b(lead|principal)\b/i.test(low)) name = 'VOZ PRINCIPAL';
      else name = 'CORO / BGV';
    }
    return { name, color: '#EB5FA8', kind: 'audio', bus: 'VOCALS', output: 'OUT_1_2', pitchShift: true };
  }

  // Fallback: clean uppercase name
  const prettyName = formattedClean || `TRACK ${idx + 1}`;
  return {
    name: prettyName,
    color: TRACK_COLORS[idx % TRACK_COLORS.length],
    kind: 'audio',
    bus: 'KEYS',
    output: 'OUT_1_2',
    pitchShift: true,
  };
}

export const BUS_STAGE_ORDER: Record<BusGroup, number> = {
  UTILITY: 0,
  DRUMS: 1,
  BASS: 2,
  GUITARS: 3,
  KEYS: 4,
  VOCALS: 5,
};

const INSTRUMENT_SUB_ORDER: Record<string, number> = {
  // Drums
  BUMBO: 1,
  CAIXA: 2,
  CHIMBAL: 3,
  TONS: 4,
  PRATOS: 5,
  BATERIA: 6,
  PERCUSSÃO: 7,
  LOOP: 8,
  'EFEITOS (FX)': 9,

  // Bass
  BAIXO: 1,
  'SYNTH BASS': 2,

  // Guitars
  VIOLÃO: 1,
  'GUITARRA 1': 2,
  'GUITARRA 2': 3,
  GUITARRA: 4,
  'GUITARRA SOLO': 5,

  // Keys
  PIANO: 1,
  'ÓRGÃO / RHODES': 2,
  TECLADO: 3,
  SYNTH: 4,
  PAD: 5,
  'CORDAS / METAIS': 6,

  // Vocals
  'VOZ PRINCIPAL': 1,
  'BGV 1': 2,
  'BGV 2': 3,
  'CORO / BGV': 4,
};

/**
 * Organizes tracks into canonical live stage order:
 * 1. Pinned CLICK (OUT 6)
 * 2. Pinned GUIDE (OUT 5)
 * 3. Drums / Percussion (Bumbo, Caixa, Chimbal, Tons, Pratos, Loop, FX)
 * 4. Bass (Baixo, Synth Bass)
 * 5. Guitars (Violão, Guitarras)
 * 6. Keys (Piano, Teclado, Synth, Pad)
 * 7. Vocals (Voz Principal, BGVs, Coro)
 */
export function orderTracksForStage(tracks: Track[]): Track[] {
  return [...tracks].sort((a, b) => {
    // 1. Click first
    const isClickA = a.kind === 'click' || a.name.includes('CLICK');
    const isClickB = b.kind === 'click' || b.name.includes('CLICK');
    if (isClickA && !isClickB) return -1;
    if (isClickB && !isClickA) return 1;
    // 2. Guide second
    const isGuideA = a.kind === 'guide' || a.name.includes('GUIDE') || a.name.includes('GUIA');
    const isGuideB = b.kind === 'guide' || b.name.includes('GUIDE') || b.name.includes('GUIA');
    if (isGuideA && !isGuideB) return -1;
    if (isGuideB && !isGuideA) return 1;
    // 3. Musical bus group order
    const oA = a.bus ? BUS_STAGE_ORDER[a.bus] ?? 99 : 99;
    const oB = b.bus ? BUS_STAGE_ORDER[b.bus] ?? 99 : 99;
    if (oA !== oB) return oA - oB;
    // 4. Instrument sub-order within the same bus
    const subA = INSTRUMENT_SUB_ORDER[a.name] ?? 50;
    const subB = INSTRUMENT_SUB_ORDER[b.name] ?? 50;
    if (subA !== subB) return subA - subB;
    // 5. Natural title order (e.g. Gtr 1, Gtr 2)
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** Minimalist stage icon for a mixer channel strip header. */
export function trackIcon(t: Pick<Track, 'name' | 'kind' | 'bus'>): string {
  if (t.kind === 'click' || t.name.includes('CLICK')) return '⏱';
  if (t.kind === 'guide' || t.name.includes('GUIDE') || t.name.includes('GUIA')) return '🎙';
  const low = t.name.toLowerCase();
  if (/\b(perc|shaker|tamb|conga|loop|beat)\b/.test(low)) return '🪘';
  if (t.bus === 'DRUMS' || /\b(drum|bateria|kick|snare|hat|tom|oh|room)\b/.test(low)) return '🥁';
  if (t.bus === 'BASS' || /\b(bass|baixo|sub)\b/.test(low)) return '🎸';
  if (/\b(ag|viol[aã]o|ac[uú]stic)\b/.test(low)) return '🪕';
  if (t.bus === 'GUITARS' || /\b(eg|gtr|guit)\b/.test(low)) return '⚡';
  if (/\b(pad|ambient|shimmer|atmo)\b/.test(low)) return '🌊';
  if (/\b(fx|sfx|swell|impact)\b/.test(low)) return '✨';
  if (t.bus === 'VOCALS' || /\b(voc|voz|bgv|choir|coro)\b/.test(low)) return '🎤';
  return '🎹';
}


/**
 * Normalizes user stems (naming user-uploaded stems CLICK (Áudio Original) / GUIDE (Áudio Original))
 * and cleans up legacy phantom/dummy tracks without audio files so only real audio stems appear in the mixer.
 */
export function ensureUtilityTracks(song: Song): Song {
  const tracks = song.tracks
    .filter((t) => {
      // Remove apenas faixas fantasmas legadas de voz sintetizada que não tinham áudio
      if (!t.fileName && t.id === 'guide' && t.kind === 'guide') {
        return false;
      }
      return true;
    })
    .map((t) => {
      const low = t.name.toLowerCase();
      // Apenas converte para áudio original se o canal tiver arquivo de áudio real (fileName)
      if (
        Boolean(t.fileName) &&
        (t.kind === 'click' || low === 'click' || low === 'clique' || low === 'metronomo') &&
        !t.name.includes('(Áudio Original)')
      ) {
        return {
          ...t,
          name: 'CLICK (Áudio Original)',
          color: '#F39C12',
          kind: 'audio' as const,
          bus: 'UTILITY' as const,
          output: t.output || 'OUT_6',
          pitchShift: false,
        };
      }
      if (
        Boolean(t.fileName) &&
        (t.kind === 'guide' || low === 'guide' || low === 'guia' || low === 'cue') &&
        !t.name.includes('(Áudio Original)')
      ) {
        return {
          ...t,
          name: 'GUIDE (Áudio Original)',
          color: '#0099FF',
          kind: 'audio' as const,
          bus: 'UTILITY' as const,
          output: t.output || 'OUT_5',
          pitchShift: false,
        };
      }
      return t;
    });

  return { ...song, tracks };
}
