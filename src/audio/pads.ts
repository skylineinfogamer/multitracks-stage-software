import type { PadSound } from '../types';
import { KEYS, keyIndex, midiToFreq } from '../music';

interface Voice {
  out: GainNode;
  filter: BiquadFilterNode;
  nodes: AudioScheduledSourceNode[];
}

const FLAT_TO_SHARP_KEY: Record<string, string> = {
  C: 'C',
  'C#': 'C#',
  DB: 'C#',
  D: 'D',
  'D#': 'Eb',
  EB: 'Eb',
  E: 'E',
  F: 'F',
  'F#': 'F#',
  GB: 'F#',
  G: 'G',
  'G#': 'Ab',
  AB: 'Ab',
  A: 'A',
  'A#': 'Bb',
  BB: 'Bb',
  B: 'B',
};

/** Parse musical note key (C, C#, D, Eb, E, F, F#, G, Ab, A, Bb, B) from a Pad audio file name. */
export function parsePadKeyFromFileName(fileName: string): string | null {
  const base = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const patterns = [
    /^([A-G][#b]?)(?:m|maj|min)?$/i,
    /\b(?:pad|tom|key|note|ambiente|drone|worship)\s*([A-G][#b]?)(?:m|maj|min)?\b/i,
    /\b([A-G][#b]?)\s*(?:pad|drone|ambient|worship|major|maior)\b/i,
    /(?:^|\s|\()([A-G][#b]?)(?:m)?(?:\s|\)|$)/i,
  ];
  for (const rx of patterns) {
    const m = base.match(rx);
    if (m) {
      const k = FLAT_TO_SHARP_KEY[m[1].toUpperCase()];
      if (k && KEYS.includes(k)) return k;
    }
  }
  return null;
}

/** Continuous ambient pad generator with crossfades between keys, Custom Folder Audio Pads, and Low-Pass Cutoff/Resonance. */
export class PadPlayer {
  private ctx: AudioContext;
  private out: GainNode;
  private voice: Voice | null = null;
  private banks = new Map<string, Map<string, AudioBuffer>>();
  private customBuffers = new Map<string, AudioBuffer>();
  activeBankId: string = 'default';
  activeKey: string | null = null;
  sound: PadSound = 'warm';
  cutoff = 1800;
  resonance = 0.8;
  crossfadeSeconds = 3.0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.6;
    this.out.connect(ctx.destination);
  }

  setBankBuffer(bankId: string, noteKey: string, buf: AudioBuffer) {
    let b = this.banks.get(bankId);
    if (!b) {
      b = new Map<string, AudioBuffer>();
      this.banks.set(bankId, b);
    }
    b.set(noteKey, buf);
    if (bankId === this.activeBankId) {
      this.customBuffers.set(noteKey, buf);
    }
  }

  setCustomBuffer(noteKey: string, buf: AudioBuffer) {
    this.customBuffers.set(noteKey, buf);
    this.setBankBuffer(this.activeBankId || 'default', noteKey, buf);
  }

  setActiveBank(bankId: string) {
    this.activeBankId = bankId;
    const b = this.banks.get(bankId);
    this.customBuffers = b ? new Map(b) : new Map();
    if (this.sound === 'custom_folder' && this.activeKey) {
      this.play(this.activeKey);
    }
  }

  getActiveBankId(): string {
    return this.activeBankId;
  }

  getBankKeys(bankId: string): string[] {
    const b = this.banks.get(bankId);
    return b ? Array.from(b.keys()) : [];
  }

  getCustomKeys(): string[] {
    const b = this.banks.get(this.activeBankId) || this.customBuffers;
    return Array.from(b.keys());
  }

  hasCustomBuffers(bankId?: string): boolean {
    if (bankId) {
      const b = this.banks.get(bankId);
      return !!b && b.size > 0;
    }
    const b = this.banks.get(this.activeBankId) || this.customBuffers;
    return b.size > 0;
  }

  removeBank(bankId: string) {
    this.banks.delete(bankId);
    if (this.activeBankId === bankId) {
      this.customBuffers.clear();
      const first = this.banks.keys().next().value;
      if (first) {
        this.setActiveBank(first);
      }
    }
  }

  setVolume(v: number) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setFilter(cutoff: number, resonance = this.resonance) {
    this.cutoff = Math.max(180, Math.min(8000, cutoff));
    this.resonance = Math.max(0.2, Math.min(8, resonance));
    if (this.voice) {
      const now = this.ctx.currentTime;
      this.voice.filter.frequency.setTargetAtTime(this.cutoff, now, 0.04);
      this.voice.filter.Q.setTargetAtTime(this.resonance, now, 0.04);
    }
  }

  setCrossfade(sec: number) {
    this.crossfadeSeconds = Math.max(0.5, Math.min(10, sec));
  }

  private buildVoice(key: string): Voice {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(1, now + this.crossfadeSeconds);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = this.resonance;
    filter.frequency.value = this.cutoff;
    filter.connect(out);
    out.connect(this.out);

    // Custom Folder Pad Audio playback (exact key buffer or pitch-shifted nearest buffer)
    if (this.sound === 'custom_folder' && this.customBuffers.size > 0) {
      const targetIdx = keyIndex(key);
      let chosenBuf = this.customBuffers.get(key);
      let semitoneShift = 0;

      if (!chosenBuf) {
        let bestDist = 99;
        for (const [k, b] of this.customBuffers.entries()) {
          const idx = keyIndex(k);
          let diff = targetIdx - idx;
          if (diff > 6) diff -= 12;
          if (diff < -6) diff += 12;
          if (Math.abs(diff) < bestDist) {
            bestDist = Math.abs(diff);
            semitoneShift = diff;
            chosenBuf = b;
          }
        }
      }

      if (chosenBuf) {
        const src = ctx.createBufferSource();
        src.buffer = chosenBuf;
        src.loop = true;
        // Trim 0.2s from start/end if long file to avoid silence at file edges during loop
        if (chosenBuf.duration > 6) {
          src.loopStart = 0.25;
          src.loopEnd = chosenBuf.duration - 0.25;
        }
        src.playbackRate.value = Math.pow(2, semitoneShift / 12);
        const g = ctx.createGain();
        g.gain.value = 0.95;
        src.connect(g).connect(filter);
        src.start(now);
        return { out, filter, nodes: [src] };
      }
    }

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = this.sound === 'cathedral' ? 0.05 : 0.08;
    lfoGain.gain.value = filter.frequency.value * 0.25;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    const root = 48 + keyIndex(key); // C3 based
    const notes =
      this.sound === 'shimmer'
        ? [root, root + 7, root + 12, root + 19, root + 24, root + 31]
        : this.sound === 'cathedral'
          ? [root - 12, root - 5, root, root + 7, root + 12, root + 16, root + 24]
          : this.sound === 'strings'
            ? [root - 12, root, root + 7, root + 12, root + 16]
            : [root - 12, root, root + 7, root + 12, root + 14];
    const nodes: AudioScheduledSourceNode[] = [lfo];
    const type: OscillatorType = this.sound === 'shimmer' ? 'triangle' : 'sawtooth';
    notes.forEach((n, i) => {
      for (const det of [-8, 0, 8]) {
        const o = ctx.createOscillator();
        o.type = det === 0 ? 'sine' : type;
        o.frequency.value = midiToFreq(n);
        o.detune.value = det + (i % 2 ? 3 : -3);
        const g = ctx.createGain();
        g.gain.value = (0.04 / notes.length) * (i === 0 ? 1.6 : 1) * (type === 'triangle' ? 2.1 : 1);
        const p = ctx.createStereoPanner();
        p.pan.value = det < 0 ? -0.55 : det > 0 ? 0.55 : 0;
        o.connect(g).connect(p).connect(filter);
        o.start(now);
        nodes.push(o);
      }
    });
    return { out, filter, nodes };
  }

  private release(v: Voice, seconds = this.crossfadeSeconds) {
    const now = this.ctx.currentTime;
    v.out.gain.cancelScheduledValues(now);
    v.out.gain.setValueAtTime(v.out.gain.value, now);
    v.out.gain.linearRampToValueAtTime(0, now + seconds);
    v.nodes.forEach((n) => {
      try {
        n.stop(now + seconds + 0.1);
      } catch {
        /* ignore */
      }
    });
    setTimeout(() => v.out.disconnect(), (seconds + 0.3) * 1000);
  }

  async play(key: string) {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.voice) this.release(this.voice, this.crossfadeSeconds);
    this.voice = this.buildVoice(key);
    this.activeKey = key;
  }

  stop(seconds = this.crossfadeSeconds) {
    if (this.voice) this.release(this.voice, seconds);
    this.voice = null;
    this.activeKey = null;
  }

  setSound(s: PadSound) {
    this.sound = s;
    const defaultCutoff =
      s === 'custom_folder'
        ? 4800
        : s === 'shimmer'
          ? 3400
          : s === 'cathedral'
            ? 2400
            : s === 'strings'
              ? 2000
              : 1200;
    this.cutoff = defaultCutoff;
    if (this.activeKey) this.play(this.activeKey);
  }
}
