import type { BusGroup, ClickSound, ClickSubdivision, OutputBus, Section, SectionType, Song, Track } from '../types';
import { SECTION_META, keyIndex, midiToFreq } from '../music';

const SR = 44100;

/** Generate a click (metronome) buffer with subdivision (1/4, 1/8, 1/16, 1/3) and timbre selection. */
export function renderClick(
  ctx: BaseAudioContext,
  bpm: number,
  beatsPerBar: number,
  duration: number,
  firstBeat = 0,
  subdivideOrMode: boolean | ClickSubdivision = false,
  sound: ClickSound = 'woodblock',
): AudioBuffer {
  const mode: ClickSubdivision =
    typeof subdivideOrMode === 'boolean' ? (subdivideOrMode ? '1/8' : '1/4') : subdivideOrMode;
  const len = Math.ceil(duration * SR);
  const buf = ctx.createBuffer(1, len, SR);
  const d = buf.getChannelData(0);
  const beat = 60 / bpm;
  const clickLen = Math.floor(0.032 * SR);

  const hit = (startSec: number, kind: 'accent' | 'quarter' | 'sub') => {
    const start = Math.floor(startSec * SR);
    const freq =
      sound === 'woodblock'
        ? kind === 'accent'
          ? 1480
          : kind === 'quarter'
            ? 988
            : 740
        : sound === 'cowbell'
          ? kind === 'accent'
            ? 845
            : kind === 'quarter'
              ? 560
              : 480
          : sound === 'rimshot'
            ? kind === 'accent'
              ? 2100
              : kind === 'quarter'
                ? 1420
                : 1050
            : kind === 'accent'
              ? 1760
              : kind === 'quarter'
                ? 1175
                : 880;
    const amp = kind === 'accent' ? 0.92 : kind === 'quarter' ? 0.64 : 0.32;
    const decayDiv = sound === 'rimshot' ? 8 : sound === 'woodblock' ? 6.2 : 5;
    for (let n = 0; n < clickLen && start + n < len; n++) {
      const env = Math.exp(-n / (clickLen / decayDiv));
      let sample = Math.sin((2 * Math.PI * freq * n) / SR);
      if (sound === 'cowbell') {
        sample = 0.6 * sample + 0.4 * Math.sin((2 * Math.PI * freq * 1.48 * n) / SR);
      } else if (sound === 'rimshot' && n < clickLen * 0.25) {
        sample = 0.55 * sample + 0.45 * (((n * 16807) % 2147483647) / 2147483647 - 0.5);
      }
      d[start + n] += sample * env * amp;
    }
  };

  let i = 0;
  for (let t = firstBeat; t < duration; t += beat, i++) {
    const accent = i % beatsPerBar === 0;
    hit(t, accent ? 'accent' : 'quarter');
    if (mode === '1/8') {
      hit(t + beat * 0.5, 'sub');
    } else if (mode === '1/16') {
      hit(t + beat * 0.25, 'sub');
      hit(t + beat * 0.5, 'sub');
      hit(t + beat * 0.75, 'sub');
    } else if (mode === '1/3') {
      hit(t + beat / 3, 'sub');
      hit(t + (beat * 2) / 3, 'sub');
    }
  }
  return buf;
}

/** Peak data for waveform display (max abs per bucket across buffers). */
export function computePeaks(buffers: AudioBuffer[], buckets: number, duration: number): Float32Array {
  const out = new Float32Array(buckets);
  for (const b of buffers) {
    const per = (duration * b.sampleRate) / buckets;
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let k = 0; k < buckets; k++) {
        const s = Math.floor(k * per);
        const e = Math.min(d.length, Math.floor((k + 1) * per));
        let m = 0;
        for (let i = s; i < e; i += 16) {
          const v = d[i] < 0 ? -d[i] : d[i];
          if (v > m) m = v;
        }
        out[k] += m;
      }
    }
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  return out;
}

// ---------------------------------------------------------------- demo songs

interface DemoSpec {
  seed: number;
  name: string;
  artist: string;
  bpm: number;
  key: string;
  chordChart: string;
  structure: [SectionType, number, string?][]; // type, bars, label
}

const DEMOS: DemoSpec[] = [
  {
    seed: 1,
    name: 'Leão da Tribo / Santo Pra Sempre',
    artist: 'Ministério Worship Live',
    bpm: 72,
    key: 'G',
    structure: [
      ['INTRO', 4],
      ['VERSO', 8, 'Verso 1'],
      ['PRE', 4, 'Pré-Refrão'],
      ['REFRAO', 8, 'Refrão'],
      ['VERSO', 8, 'Verso 2'],
      ['PRE', 4, 'Pré-Refrão 2'],
      ['REFRAO', 8, 'Refrão 2'],
      ['PONTE', 8, 'Ponte'],
      ['REFRAO', 8, 'Refrão Final'],
      ['FINAL', 4, 'Final'],
    ],
    chordChart: `[Intro]
[G]    [C9]    [Em7]    [C9]

[Verso 1]
Mil [G]gerações se [D/F#]prostram em lou[Em7]vor
Can[C9]tando ao Cor[D]deiro que ven[G]ceu
Os [G]que se foram e [D/F#]os que hão de [Em7]vir
Can[C9]tando ao Cor[D]deiro que ven[G]ceu

[Pré-Refrão]
Teu [C9]nome é o mais [D]alto
Teu [Em7]nome é o ma[D/F#]ior
Teu [C9]nome está so[Am7]bre todos os [D4]nomes [D]

[Refrão]
Cantam [Em7]Santo, [C9]Santo
Todo-Po[G]deroso é o Cor[D/F#]deiro
Cantam [Em7]Santo, [C9]Santo
Tu és [G]Santo pra [D]sempre [G]

[Ponte]
Se tu [C9]foste perdoado, cante [Em7]ao Cordeiro
Se tu [D]és livre, cante [G/B]seu nome
Para [C9]sempre Ele [Em7]reinará
Tu és [D]Santo pra sempre!`,
  },
  {
    seed: 2,
    name: 'Celebração da Graça (Ao Vivo)',
    artist: 'Worship Playback Band',
    bpm: 124,
    key: 'D',
    structure: [
      ['INTRO', 8],
      ['VERSO', 8, 'Verso 1'],
      ['REFRAO', 8, 'Refrão'],
      ['INSTRUMENTAL', 4, 'Turnaround'],
      ['VERSO', 8, 'Verso 2'],
      ['REFRAO', 8, 'Refrão 2'],
      ['PONTE', 8, 'Ponte 1'],
      ['PONTE', 8, 'Ponte 2 (Subindo)'],
      ['REFRAO', 8, 'Refrão Final'],
      ['TAG', 4, 'Tag'],
      ['FINAL', 4, 'Final'],
    ],
    chordChart: `[Intro]
[D]   [G]   [Bm7]   [G]

[Verso 1]
O [D]sol da justiça bri[G]lhou sobre nós
Tra[Bm7]zendo esperança e [A]vida sem fim
Não [D/F#]há mais cadeias, so[G]mos livres enfim
Pra [Bm7]celebrar Teu a[A]mor!

[Refrão]
Cele[Bm7]brai ao Rei da [G]Glória
Ele [D]vivo está, Ele [A]venceu!
Toda [Bm7]terra cante a [G]história
Do Cor[D]deiro que nos resga[A]tou!

[Ponte 1]
[G]Nada pode pa[A]rar o Teu poder
[Bm7]Todo joelho se [D/F#]dobrará
[G]Céus e terra proclamam [A]quem Tu és!`,
  },
  {
    seed: 3,
    name: 'Bondade de Deus / Rendição',
    artist: 'Worship Playback Band',
    bpm: 66,
    key: 'E',
    structure: [
      ['INTRO', 4],
      ['VERSO', 8, 'Verso 1'],
      ['REFRAO', 8, 'Refrão'],
      ['VERSO', 8, 'Verso 2'],
      ['REFRAO', 8, 'Refrão 2'],
      ['PONTE', 8, 'Ponte'],
      ['REFRAO', 8, 'Refrão Final'],
      ['FINAL', 4, 'Final'],
    ],
    chordChart: `[Intro]
[E]    [A9]    [E]    [B4]

[Verso 1]
Te [E]amo, Deus, Tua [A9]graça nunca [E]falha
Todos os [C#m7]dias estou em Tuas [B4]mãos
Desde o [A9]momento em que me le[E/G#]vanto[C#m7]
Até o [F#m7]deitar, eu [B4]cantarei da bondade de [E]Deus

[Refrão]
És fi[A9]el em todo [E]tempo
És fi[A9]el em todo [E]tempo [B/D#]
Com todo [A9]fôlego que [E/G#]há em [C#m7]mim
Eu [F#m7]cantarei da bon[B4]dade de [E]Deus

[Ponte]
Tua bon[E/G#]dade me [A9]perseguirá
Me [B4]perseguirá todos os [E]dias
Eu me [E/G#]rendo a [A9]Ti, entrego [B4]tudo a [C#m7]Ti`,
  },
  {
    seed: 4,
    name: 'Digno de Tudo / Exaltado (Live)',
    artist: 'Ministério Worship Live',
    bpm: 68,
    key: 'A',
    structure: [
      ['INTRO', 4],
      ['VERSO', 8, 'Verso 1'],
      ['PRE', 4, 'Pré-Refrão'],
      ['REFRAO', 8, 'Refrão'],
      ['INTERLUDIO', 4, 'Interlúdio'],
      ['PONTE', 8, 'Ponte'],
      ['REFRAO', 8, 'Refrão Final'],
      ['FINAL', 4, 'Final'],
    ],
    chordChart: `[Intro]
[A9]   [D9]   [F#m7]   [E4]

[Verso 1]
Os [A9]anjos se prostram di[D9]ante do Trono
Can[F#m7]tando ao Cordeiro que [E4]venceu
[A9]Digno é o Senhor de re[D9]ceber a glória
[F#m7]Honra, domínio e po[E]der

[Refrão]
Tu és [D9]Digno, [A/C#]Digno de [E]tudo
Recebe a [F#m7]nossa adora[D9]ção
Toda a [A9]terra proclama o Teu [E]Nome!`,
  },
];

const STEMS: { id: string; name: string; color: string; bus: BusGroup; output: OutputBus; pan?: number }[] = [
  { id: 'click', name: 'CLICK', color: '#E9B44C', bus: 'UTILITY', output: 'OUT_6', pan: 0 },
  { id: 'guide', name: 'GUIA', color: '#7A8BFF', bus: 'UTILITY', output: 'OUT_5', pan: 0 },
  { id: 'drums', name: 'DRUMS', color: '#E74C3C', bus: 'DRUMS', output: 'OUT_1_2', pan: 0 },
  { id: 'perc', name: 'PERC', color: '#F39C12', bus: 'DRUMS', output: 'OUT_1_2', pan: 0.12 },
  { id: 'bass', name: 'BASS', color: '#8E44AD', bus: 'BASS', output: 'OUT_3_4', pan: 0 },
  { id: 'ag', name: 'AG', color: '#16A085', bus: 'GUITARS', output: 'OUT_1_2', pan: -0.25 },
  { id: 'eg1', name: 'EG 1', color: '#D35400', bus: 'GUITARS', output: 'OUT_1_2', pan: -0.35 },
  { id: 'eg2', name: 'EG 2', color: '#E67E22', bus: 'GUITARS', output: 'OUT_1_2', pan: 0.35 },
  { id: 'piano', name: 'PIANO', color: '#0099FF', bus: 'KEYS', output: 'OUT_1_2', pan: -0.12 },
  { id: 'keys', name: 'SYNTH', color: '#2ECC71', bus: 'KEYS', output: 'OUT_1_2', pan: 0.2 },
  { id: 'pad', name: 'PADS', color: '#00B8D4', bus: 'KEYS', output: 'OUT_1_2', pan: 0 },
  { id: 'bgv', name: 'BGVS', color: '#EB5FA8', bus: 'VOCALS', output: 'OUT_1_2', pan: 0 },
];

function sectionsFor(spec: DemoSpec): { sections: Section[]; duration: number } {
  const bar = (60 / spec.bpm) * 4;
  let t = 0;
  const sections: Section[] = spec.structure.map(([type, bars, label], i) => {
    const s: Section = { id: `s${spec.seed}-${i}`, type, label: label ?? SECTION_META[type].label, start: t, end: t + bars * bar };
    t += bars * bar;
    return s;
  });
  return { sections, duration: t + 2 };
}

export function demoSongs(): Song[] {
  const transitions: ('AUTO_ADVANCE' | 'CROSSFADE' | 'OVERLAP' | 'STOP')[] = [
    'AUTO_ADVANCE',
    'CROSSFADE',
    'OVERLAP',
    'STOP',
  ];
  return DEMOS.map((spec, idx) => {
    const { sections, duration } = sectionsFor(spec);
    const tracks: Track[] = STEMS.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      kind: s.id === 'click' ? 'click' : s.id === 'guide' ? 'guide' : 'audio',
      bus: s.bus,
      output: s.output,
      volume: s.id === 'click' ? 0.72 : 0.85,
      pan: s.pan ?? 0,
      mute: false,
      solo: false,
      pitchShift: s.bus !== 'DRUMS' && s.bus !== 'UTILITY',
    }));
    const midiCues = sections.slice(0, 5).map((sec, si) => ({
      id: `mc-${spec.seed}-${si}`,
      time: sec.start,
      label: `Slide: ${sec.label}`,
      type: (si % 2 === 0 ? 'PROPRESENTER_SLIDE' : 'DMX_LIGHT') as 'PROPRESENTER_SLIDE' | 'DMX_LIGHT',
      channel: 1,
      number: 60 + si,
      value: 127,
    }));
    return {
      id: `demo-${spec.seed}`,
      name: spec.name,
      artist: spec.artist,
      bpm: spec.bpm,
      key: spec.key,
      pitchOffset: 0,
      beatsPerBar: 4,
      firstBeat: 0,
      duration,
      guideMode: 'REANNOUNCE',
      transitionAfter: transitions[idx % transitions.length],
      sections,
      tracks,
      midiCues,
      chordChart: spec.chordChart,
      source: 'demo',
      demoSeed: spec.seed,
    };
  });
}

// chord progressions (scale degree semitone, minor?)
const PROG: Partial<Record<SectionType, [number, boolean][]>> = {
  INTRO: [[0, false], [5, false], [9, true], [5, false]],
  VERSO: [[0, false], [7, false], [9, true], [5, false]],
  PRE: [[5, false], [7, false], [9, true], [7, false]],
  REFRAO: [[9, true], [5, false], [0, false], [7, false]],
  PONTE: [[5, false], [9, true], [7, false], [0, false]],
  INTERLUDIO: [[0, false], [5, false], [9, true], [7, false]],
  INSTRUMENTAL: [[0, false], [5, false], [0, false], [7, false]],
  TAG: [[5, false], [7, false], [9, true], [7, false]],
  FINAL: [[5, false], [0, false], [5, false], [0, false]],
};

const INTENSITY: Partial<Record<SectionType, number>> = {
  INTRO: 0,
  VERSO: 1,
  PRE: 2,
  REFRAO: 3,
  PONTE: 2,
  INTERLUDIO: 1,
  INSTRUMENTAL: 3,
  TAG: 2,
  FINAL: 0,
};

interface BarInfo {
  t: number;
  root: number; // midi note of chord root (octave 3)
  minor: boolean;
  intensity: number;
}

function barsFor(song: Song): BarInfo[] {
  const bar = (60 / song.bpm) * song.beatsPerBar;
  const bars: BarInfo[] = [];
  const base = 48 + keyIndex(song.key);
  for (const s of song.sections) {
    const n = Math.round((s.end - s.start) / bar);
    const prog = PROG[s.type] ?? PROG.VERSO!;
    for (let i = 0; i < n; i++) {
      const [deg, minor] = prog[i % prog.length];
      let root = base + deg;
      if (root > 56) root -= 12;
      if (root < 43) root += 12;
      bars.push({ t: s.start + i * bar, root, minor, intensity: INTENSITY[s.type] ?? 2 });
    }
  }
  return bars;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const b = ctx.createBuffer(1, SR, SR);
  const d = b.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (s * 16807) % 2147483647;
    d[i] = (s / 2147483647) * 2 - 1;
  }
  return b;
}

function env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

type StemRenderer = (ctx: OfflineAudioContext, out: AudioNode, song: Song, bars: BarInfo[]) => void;

const renderDrums: StemRenderer = (ctx, out, song, bars) => {
  const beat = 60 / song.bpm;
  const noise = noiseBuffer(ctx);
  const kick = (t: number, v: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    env(g, t, v, 0.003, 0.35);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.4);
  };
  const snare = (t: number, v: number) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    env(g, t, v, 0.002, 0.18);
    n.connect(f).connect(g).connect(out);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.25);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.value = 190;
    env(og, t, v * 0.5, 0.002, 0.08);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.12);
  };
  const hat = (t: number, v: number) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const g = ctx.createGain();
    env(g, t, v, 0.001, 0.05);
    n.connect(f).connect(g).connect(out);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.08);
  };
  for (const b of bars) {
    const I = b.intensity;
    if (I === 0) {
      kick(b.t, 0.5);
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const t = b.t + k * beat;
      if (I >= 3 || k === 0 || (I >= 2 && k === 2) || (I === 1 && k === 2)) kick(t, 0.9);
      if (k === 1 || k === 3) snare(t, I >= 2 ? 0.55 : 0.35);
      hat(t, 0.16);
      if (I >= 2) hat(t + beat / 2, 0.1);
    }
  }
};

const renderBass: StemRenderer = (ctx, out, song, bars) => {
  const beat = 60 / song.bpm;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600;
  lp.connect(out);
  for (const b of bars) {
    if (b.intensity === 0) {
      note(b.root, b.t, beat * 4 - 0.05, 0.45);
      continue;
    }
    const step = b.intensity >= 3 ? beat / 2 : beat;
    for (let t = b.t; t < b.t + beat * 4 - 0.01; t += step) note(b.root, t, step * 0.9, 0.5);
  }
  function note(root: number, t: number, dur: number, v: number) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToFreq(root - 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + 0.01);
    g.gain.setValueAtTime(v, t + dur - 0.04);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(lp);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
};

const chordNotes = (b: BarInfo) => [b.root + 12, b.root + 12 + (b.minor ? 3 : 4), b.root + 19];

const renderKeys: StemRenderer = (ctx, out, song, bars) => {
  const beat = 60 / song.bpm;
  for (const b of bars) {
    const hits = b.intensity >= 2 ? [0, 1.5, 2, 3.5] : [0, 2];
    for (const h of hits) {
      const t = b.t + h * beat;
      for (const n of chordNotes(b)) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = midiToFreq(n);
        const g = ctx.createGain();
        env(g, t, 0.12, 0.005, beat * 2.2);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + beat * 2.4);
      }
    }
  }
};

const renderPad: StemRenderer = (ctx, out, song, bars) => {
  const barLen = (60 / song.bpm) * 4;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1100;
  lp.connect(out);
  for (const b of bars) {
    for (const n of [...chordNotes(b), b.root]) {
      for (const det of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(n);
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, b.t);
        g.gain.linearRampToValueAtTime(0.03, b.t + 0.4);
        g.gain.setValueAtTime(0.03, b.t + barLen - 0.1);
        g.gain.linearRampToValueAtTime(0.0001, b.t + barLen + 0.3);
        const p = ctx.createStereoPanner();
        p.pan.value = det < 0 ? -0.6 : 0.6;
        o.connect(g).connect(p).connect(lp);
        o.start(b.t);
        o.stop(b.t + barLen + 0.35);
      }
    }
  }
};

const renderArp: StemRenderer = (ctx, out, song, bars) => {
  const beat = 60 / song.bpm;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  const delay = ctx.createDelay(2);
  delay.delayTime.value = beat * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.3;
  lp.connect(out);
  lp.connect(delay);
  delay.connect(fb).connect(delay);
  const wet = ctx.createStereoPanner();
  wet.pan.value = 0.5;
  delay.connect(wet).connect(out);
  for (const b of bars) {
    if (b.intensity < 2) continue;
    const notes = [...chordNotes(b), chordNotes(b)[0] + 12];
    const step = beat / 2;
    for (let i = 0; i < 8; i++) {
      const t = b.t + i * step;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = midiToFreq(notes[i % notes.length] + 12);
      const g = ctx.createGain();
      env(g, t, 0.05, 0.003, step * 0.9);
      o.connect(g).connect(lp);
      o.start(t);
      o.stop(t + step);
    }
  }
};

const RENDERERS: Record<string, StemRenderer> = {
  drums: renderDrums,
  perc: (ctx, out, song, bars) => {
    const beat = 60 / song.bpm;
    const noise = noiseBuffer(ctx);
    for (const b of bars) {
      if (b.intensity < 1) continue;
      for (let k = 0; k < 8; k++) {
        const t = b.t + k * (beat / 2);
        const n = ctx.createBufferSource();
        n.buffer = noise;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = k % 2 === 0 ? 5200 : 6800;
        const g = ctx.createGain();
        env(g, t, k % 2 === 0 ? 0.12 : 0.06, 0.002, 0.045);
        n.connect(f).connect(g).connect(out);
        n.start(t, (k * 0.11) % 0.7);
        n.stop(t + 0.06);
      }
    }
  },
  bass: renderBass,
  ag: renderKeys,
  eg1: renderArp,
  eg2: (ctx, out, song, bars) => {
    const beat = 60 / song.bpm;
    for (const b of bars) {
      if (b.intensity < 2) continue;
      for (const n of chordNotes(b)) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(n + 12);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1800;
        const g = ctx.createGain();
        env(g, b.t, 0.065, 0.08, beat * 3.5);
        o.connect(f).connect(g).connect(out);
        o.start(b.t);
        o.stop(b.t + beat * 3.7);
      }
    }
  },
  piano: renderKeys,
  keys: renderArp,
  pad: renderPad,
  bgv: (ctx, out, song, bars) => {
    const barLen = (60 / song.bpm) * 4;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 950;
    f.Q.value = 1.2;
    f.connect(out);
    for (const b of bars) {
      if (b.intensity < 2) continue;
      for (const n of chordNotes(b)) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiToFreq(n + 12);
        const g = ctx.createGain();
        env(g, b.t, 0.05, 0.25, barLen * 0.85);
        o.connect(g).connect(f);
        o.start(b.t);
        o.stop(b.t + barLen);
      }
    }
  },
  arp: renderArp,
};

/** Render all audio stems for a demo song (offline, fast). */
export async function renderDemo(song: Song, onProgress?: (p: number) => void): Promise<Map<string, AudioBuffer>> {
  const bars = barsFor(song);
  const out = new Map<string, AudioBuffer>();
  const ids = Object.keys(RENDERERS);
  let done = 0;
  for (const id of ids) {
    const ctx = new OfflineAudioContext(2, Math.ceil(song.duration * SR), SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    RENDERERS[id](ctx, bus, song, bars);
    out.set(id, await ctx.startRendering());
    onProgress?.(++done / ids.length);
  }
  return out;
}
