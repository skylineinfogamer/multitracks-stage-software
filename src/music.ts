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
  { id: 'OUT_1_2', label: 'Out 1/2 (Main Estéreo)', short: 'Out 1/2', desc: 'Estéreo P.A. Frontal (Canais 1 e 2)' },
  { id: 'OUT_1_L', label: 'Out 1 (L - Esquerda)', short: 'Out 1 (L)', desc: '100% Canal 1 / Esquerda (Fone / Click)' },
  { id: 'OUT_2_R', label: 'Out 2 (R - Direita)', short: 'Out 2 (R)', desc: '100% Canal 2 / Direita (VS Mono P.A.)' },
  { id: 'OUT_3_4', label: 'Out 3/4 (Sub / Aux)', short: 'Out 3/4', desc: 'Saídas 3/4 (Placa Multicanal) ou R (2ch)' },
  { id: 'OUT_5', label: 'Out 5 (Guide In-Ear)', short: 'Out 5 (Fones Guia)', desc: 'Saída 5 (Multicanal) ou Canal R (2ch)' },
  { id: 'OUT_6', label: 'Out 6 (Click In-Ear)', short: 'Out 6 (Fones Click)', desc: 'Saída 6 (Multicanal) ou Canal L (2ch)' },
];

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

  // COMBINED CLICK & GUIDE (Must be handled first so it doesn't get collapsed into just Click!)
  if (isCombinedClickGuide(clean) || isCombinedClickGuide(fileName)) {
    return {
      name: 'CLICK & GUIA (COMBINADO)',
      color: '#F39C12',
      kind: 'click',
      bus: 'UTILITY',
      output: 'OUT_6',
      pitchShift: false,
      isCombinedClickGuide: true,
    };
  }

  // CLICK
  if (
    /\b(click|metr[oô]nomo|clique|bpm|tempo)\b/i.test(norm) ||
    norm.includes('click') ||
    norm.includes('clique') ||
    norm.includes('metronomo')
  ) {
    return { name: 'CLICK', color: '#F39C12', kind: 'click', bus: 'UTILITY', output: 'OUT_6', pitchShift: false };
  }

  // GUIDE / CUING
  if (
    /\b(guide|guia|cues?|count|contagem|voz\s*guia|slate)\b/i.test(norm) ||
    norm.includes('guide') ||
    norm.includes('guia') ||
    norm.includes('cue') ||
    norm.includes('contagem')
  ) {
    return { name: 'GUIA', color: '#0099FF', kind: 'guide', bus: 'UTILITY', output: 'OUT_5', pitchShift: false };
  }

  // DRUMS & PERCUSSION
  if (/\b(kick|bumbo|bd)\b/i.test(low)) {
    return { name: 'BUMBO', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(snare|caixa|sd|snr)\b/i.test(low)) {
    return { name: 'CAIXA', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(hat|hihat|hi[\s_-]*hat|hh|chimbal)\b/i.test(low)) {
    return { name: 'CHIMBAL', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(toms?|tons?|surdo|floor|rack)\b/i.test(low)) {
    return { name: 'TONS', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(cymbal|cymbals|pratos?|overhead|oh|crash|ride)\b/i.test(low)) {
    return { name: 'PRATOS', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(perc|percuss[aã]o|shaker|tamb|pandeiro|conga|bongo|clap|snap)\b/i.test(low)) {
    return { name: 'PERCUSSÃO', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(loop|beat)\b/i.test(low)) {
    return { name: 'LOOP', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(fx|sfx|swell|impact|riser|drop)\b/i.test(low)) {
    return { name: 'EFEITOS (FX)', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }
  if (/\b(drums?|bateria|kit)\b/i.test(low)) {
    return { name: 'BATERIA', color: '#E5484D', kind: 'audio', bus: 'DRUMS', output: 'OUT_1_2', pitchShift: false };
  }

  // BASS
  if (/\b(synth\s*bass|sub\s*bass|moog|sub)\b/i.test(low)) {
    return { name: 'SYNTH BASS', color: '#8E5CF6', kind: 'audio', bus: 'BASS', output: 'OUT_3_4', pitchShift: true };
  }
  if (/\b(bass|baixo|contra\s*baixo|e[\s_-]*bass)\b/i.test(low)) {
    return { name: 'BAIXO', color: '#8E5CF6', kind: 'audio', bus: 'BASS', output: 'OUT_3_4', pitchShift: true };
  }

  // GUITARS
  if (/\b(ag\d*|acoustic|viol[aã]o|ac[uú]stic\s*gtr|ac\s*gtr)\b/i.test(low)) {
    const num = low.match(/\d+/)?.[0];
    return { name: num ? `VIOLÃO ${num}` : 'VIOLÃO', color: '#F2994A', kind: 'audio', bus: 'GUITARS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(eg\s*1|electric\s*1|guitarra\s*1|gtr\s*1|elec\s*gtr\s*1)\b/i.test(low)) {
    return { name: 'GUITARRA 1', color: '#F2994A', kind: 'audio', bus: 'GUITARS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(eg\s*2|electric\s*2|guitarra\s*2|gtr\s*2|elec\s*gtr\s*2)\b/i.test(low)) {
    return { name: 'GUITARRA 2', color: '#F2994A', kind: 'audio', bus: 'GUITARS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(solo|lead\s*gtr|gtr\s*lead|guitarra\s*solo|riff)\b/i.test(low)) {
    return { name: 'GUITARRA SOLO', color: '#F2994A', kind: 'audio', bus: 'GUITARS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(eg\d*|electric|guitarra|gtr|guitarras)\b/i.test(low)) {
    const num = low.match(/\d+/)?.[0];
    return { name: num ? `GUITARRA ${num}` : 'GUITARRA', color: '#F2994A', kind: 'audio', bus: 'GUITARS', output: 'OUT_1_2', pitchShift: true };
  }

  // KEYS, SYNTHS, PADS
  if (/\b(piano|grand|upright|ac\s*piano)\b/i.test(low)) {
    return { name: 'PIANO', color: '#2F80ED', kind: 'audio', bus: 'KEYS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(rhodes|wurlitzer|ep|organ|org[aã]o|b3|hammond)\b/i.test(low)) {
    return { name: 'ÓRGÃO / RHODES', color: '#2F80ED', kind: 'audio', bus: 'KEYS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(pad|pads|ambient|atmosphere|shimmer|atmo)\b/i.test(low)) {
    return { name: 'PAD', color: '#2F80ED', kind: 'audio', bus: 'KEYS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(synth|synths|sint|arp|lead\s*synth|pluck)\b/i.test(low)) {
    return { name: 'SYNTH', color: '#2F80ED', kind: 'audio', bus: 'KEYS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(strings?|cordas|cello|violin|viola|brass|metais|horn|trompete)\b/i.test(low)) {
    return { name: 'CORDAS / METAIS', color: '#2F80ED', kind: 'audio', bus: 'KEYS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(key|keys|teclado)\b/i.test(low)) {
    return { name: 'TECLADO', color: '#2F80ED', kind: 'audio', bus: 'KEYS', output: 'OUT_1_2', pitchShift: true };
  }

  // VOCALS
  if (/\b(lead\s*voc|lead\s*vox|voz\s*principal|lead\s*vocal|vocal\s*principal)\b/i.test(low)) {
    return { name: 'VOZ PRINCIPAL', color: '#EB5FA8', kind: 'audio', bus: 'VOCALS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(bgv\s*1|vocal\s*1|backing\s*1|voz\s*1)\b/i.test(low)) {
    return { name: 'BGV 1', color: '#EB5FA8', kind: 'audio', bus: 'VOCALS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(bgv\s*2|vocal\s*2|backing\s*2|voz\s*2)\b/i.test(low)) {
    return { name: 'BGV 2', color: '#EB5FA8', kind: 'audio', bus: 'VOCALS', output: 'OUT_1_2', pitchShift: true };
  }
  if (/\b(bgv|bgvs|backing|backings|coro|choir|vozes|vocal|vocals)\b/i.test(low)) {
    return { name: 'CORO / BGV', color: '#EB5FA8', kind: 'audio', bus: 'VOCALS', output: 'OUT_1_2', pitchShift: true };
  }

  // Fallback: clean uppercase name
  const prettyName = clean.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase() || `TRACK ${idx + 1}`;
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
    if (a.kind === 'click' && b.kind !== 'click') return -1;
    if (b.kind === 'click' && a.kind !== 'click') return 1;
    // 2. Guide second
    if (a.kind === 'guide' && b.kind !== 'guide') return -1;
    if (b.kind === 'guide' && a.kind !== 'guide') return 1;
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
  if (t.kind === 'click') return '⏱';
  if (t.kind === 'guide') return '🎙';
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
 * Guarantees that every song always has dedicated CLICK and GUIA tracks ready in the mixer,
 * recognizing them as headphone outputs (OUT_6 for Click, OUT_5 for Guide) so they can be
 * adjusted separately (just like the Pads) even when the project tracks don't contain recorded stems.
 */
export function ensureUtilityTracks(song: Song): Song {
  let tracks = [...song.tracks];
  let changed = false;

  let click = tracks.find((t) => t.kind === 'click');
  if (!click) {
    click = {
      id: uid('click'),
      name: 'CLICK',
      color: '#F39C12',
      kind: 'click',
      bus: 'UTILITY',
      output: 'OUT_6', // Reconhecida como saída de fones (In-Ear Click)
      volume: 0.75,
      pan: 0,
      mute: false,
      solo: false,
      pitchShift: false,
    };
    tracks = [click, ...tracks];
    changed = true;
  } else if (!click.output) {
    click.output = 'OUT_6';
    changed = true;
  }

  let guide = tracks.find((t) => t.kind === 'guide');
  if (!guide) {
    guide = {
      id: uid('guide'),
      name: 'GUIA',
      color: '#0099FF',
      kind: 'guide',
      bus: 'UTILITY',
      output: 'OUT_5', // Reconhecida como saída de fones (In-Ear Guia)
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false,
      pitchShift: false,
    };
    const clickIdx = tracks.indexOf(click);
    tracks.splice(clickIdx + 1, 0, guide);
    changed = true;
  } else if (!guide.output) {
    guide.output = 'OUT_5';
    changed = true;
  }

  return changed ? { ...song, tracks } : song;
}
