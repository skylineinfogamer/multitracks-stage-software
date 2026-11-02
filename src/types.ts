export type SectionType =
  | 'CONTAGEM'
  | 'INTRO'
  | 'VERSO'
  | 'VERSO_2'
  | 'PRE'
  | 'REFRAO'
  | 'POS_REFRAO'
  | 'INTERLUDIO'
  | 'PONTE'
  | 'SUBIDA'
  | 'INSTRUMENTAL'
  | 'SOLO'
  | 'VAMP'
  | 'ESPONTANEO'
  | 'MINISTRACAO'
  | 'BREAK'
  | 'TAG'
  | 'FINAL';

export type GuideMode = 'REANNOUNCE' | 'SILENCE_ON_JUMP' | 'NORMAL';

export type OutputBus =
  | 'OUT_1_2'
  | 'OUT_1_L'
  | 'OUT_2_R'
  | 'OUT_3_4'
  | 'OUT_3'
  | 'OUT_4'
  | 'OUT_5_6'
  | 'OUT_5'
  | 'OUT_6'
  | 'OUT_7_8'
  | 'OUT_7'
  | 'OUT_8';

export type BusGroup = 'DRUMS' | 'BASS' | 'GUITARS' | 'KEYS' | 'VOCALS' | 'UTILITY';

export interface Section {
  id: string;
  type: SectionType;
  label: string;
  start: number; // seconds
  end: number; // seconds
  color?: string; // custom section marker color override
}

export type TrackKind = 'audio' | 'click' | 'guide';

export type PitchMode = 'PRO_SOLA' | 'WARM_FORMANT' | 'TIGHT_RHYTHM';

export type ClickSubdivision = '1/4' | '1/8' | '1/16' | '1/3';
export type ClickSound = 'woodblock' | 'digital' | 'rimshot' | 'cowbell';
export type SongTransition = 'STOP' | 'AUTO_ADVANCE' | 'OVERLAP' | 'CROSSFADE';
export type LoopMode = 'off' | 'once' | 'infinite';

export interface MidiCuePin {
  id: string;
  time: number; // seconds
  label: string;
  type: 'PROPRESENTER_SLIDE' | 'DMX_LIGHT' | 'MIDI_NOTE' | 'MIDI_CC';
  channel: number;
  number: number; // Note or CC number
  value: number; // Velocity or CC value (0..127)
  color?: string;
}

export interface AutomationPoint {
  id: string;
  trackId: string; // '__MASTER' or track.id
  time: number; // seconds
  volume: number; // 0..1.2
}

export interface Track {
  id: string;
  name: string;
  color: string;
  kind: TrackKind;
  bus?: BusGroup;
  output: OutputBus;
  volume: number; // 0..1.2
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  pitchShift?: boolean; // true = pitched (Bass/Gtr/Keys/Vocals), false = bypass (Drums/Click/Guide)
  fileName?: string;
}

export interface Song {
  id: string;
  name: string;
  artist: string;
  bpm: number;
  key: string;
  pitchOffset: number; // semitones (-6..+6)
  pitchCents?: number; // fine tuning (-50..+50 cents)
  pitchMode?: PitchMode; // algorithm preset
  formantPreserve?: number; // 0..1 formant/tone preservation
  beatsPerBar: number;
  firstBeat: number; // offset (s) of bar 1 beat 1
  duration: number;
  guideMode: GuideMode;
  transitionAfter?: SongTransition;
  sections: Section[];
  tracks: Track[];
  midiCues?: MidiCuePin[];
  automations?: AutomationPoint[];
  chordChart?: string; // ChordPro / lyrics content
  source: 'demo' | 'import';
  demoSeed?: number;
}

export interface Setlist {
  id: string;
  name: string;
  songIds: string[];
}

export type JumpMode = 'now' | 'bar' | 'section';

export type PadSound = 'warm' | 'shimmer' | 'strings' | 'cathedral' | 'custom_folder';

export interface PadFolderBank {
  id: string;
  name: string;
  keys: string[];
  createdAt?: number;
}

export type TransitionMode = 'MANUAL' | 'AUTOLINK' | 'CROSSFADE';

export interface MidiMapping {
  id: string;
  actionLabel: string;
  actionType: 'PLAY_PAUSE' | 'STOP' | 'LOOP_CURRENT' | 'FADE_OUT' | 'JUMP_NEXT_TYPE' | 'JUMP_SECTION_INDEX';
  targetValue: string;
  keyShortcut?: string;
  channel: number;
  messageType: 'NOTE_ON' | 'CC';
  controllerNumber: number;
}
