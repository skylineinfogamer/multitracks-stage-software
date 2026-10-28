import type { BusGroup, PitchMode } from '../types';

/**
 * Studio Pitch Pro — Real-Time Multi-Bus Phase-Locked SOLA (Synchronized Overlap-Add)
 * AudioWorklet & Fallback DSP Engine.
 *
 * Designed specifically for Worship Multitrack Playback:
 * 1. Separate stereo SOLA processors per harmonic bus (BASS, GUITARS, KEYS, VOCALS),
 *    each tuned with optimal grain size & search radius for its frequency register.
 * 2. 2-Stage Normalized Cross-Correlation (NCC) + Parabolic Subsample Splice Alignment
 *    eliminates comb-filtering, warble, and phase cancellation during grain crossfades.
 * 3. 4-Point 3rd-Order Hermite Cubic Spline Interpolation for ultra-clean high frequencies.
 * 4. Formant Warmth Tilt Compensation filter prevents thin/nasal highs when pitching up
 *    and muddy low-mids when pitching down.
 * 5. Exact Constant-Delay Center Alignment (CENTER_DELAY = 1920 samples) across all buses,
 *    matched with a sample-accurate DelayNode on unpitched Drums/Click/Guide so rhythm
 *    transients remain 100% untouched and microsecond-locked to the harmonic instruments.
 */

export const PITCH_CENTER_DELAY_SAMPLES = 1920; // 40ms @ 48kHz — shared across all buses

const WORKLET_PROCESSOR_NAME = 'studio-pitch-pro-processor';

const WORKLET_CODE = `
class StudioPitchProProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.RING_SIZE = 16384;
    this.RING_MASK = 16383;
    this.CENTER_DELAY = ${PITCH_CENTER_DELAY_SAMPLES};

    this.ringL = new Float32Array(this.RING_SIZE);
    this.ringR = new Float32Array(this.RING_SIZE);
    this.ringM = new Float32Array(this.RING_SIZE);
    this.writePos = 0;

    this.baseGrainSize = opts.grainSize || 2048;
    this.searchRadius = opts.searchRadius || 512;
    this.W = this.baseGrainSize;
    this.halfW = this.W >> 1;
    this.win = this.buildHann(this.W);

    this.p0 = 0;
    this.readPos0 = this.RING_SIZE - this.CENTER_DELAY;
    this.readPos1 = this.RING_SIZE - this.CENTER_DELAY;

    this.targetRatio = 1.0;
    this.currentRatio = 1.0;
    this.formantPreserve = 0.75;
    this.lpStateL = 0;
    this.lpStateR = 0;

    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (typeof d.ratio === 'number') {
        this.targetRatio = Math.max(0.5, Math.min(2.0, d.ratio));
      }
      if (typeof d.formantPreserve === 'number') {
        this.formantPreserve = Math.max(0, Math.min(1, d.formantPreserve));
      }
      if (typeof d.grainScale === 'number') {
        const nextW = Math.max(1024, Math.min(3072, Math.round((this.baseGrainSize * d.grainScale) / 64) * 64));
        if (nextW !== this.W) {
          this.W = nextW;
          this.halfW = nextW >> 1;
          this.win = this.buildHann(nextW);
          this.p0 = this.p0 % nextW;
        }
      }
    };
  }

  buildHann(W) {
    const w = new Float32Array(W);
    for (let i = 0; i < W; i++) {
      w[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / W));
    }
    return w;
  }

  readHermite(buf, pos) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const mask = this.RING_MASK;
    const ym1 = buf[(i0 - 1) & mask];
    const y0  = buf[i0 & mask];
    const y1  = buf[(i0 + 1) & mask];
    const y2  = buf[(i0 + 2) & mask];
    const c0 = y0;
    const c1 = 0.5 * (y1 - ym1);
    const c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
    const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }

  findAlignedReadPos(nominalPos, anchorPos) {
    const mask = this.RING_MASK;
    const ringM = this.ringM;
    const anchorInt = Math.floor(anchorPos);
    const nomInt = Math.floor(nominalPos);
    const corrLen = 128;

    let energyAnchor = 0;
    for (let k = 0; k < corrLen; k += 2) {
      const v = ringM[(anchorInt + k) & mask];
      energyAnchor += v * v;
    }
    if (energyAnchor < 1e-7) {
      return nominalPos;
    }

    const rad = this.searchRadius;
    let bestOffset = 0;
    let bestScore = -2.0;

    // Stage 1: Coarse search (step = 4 samples)
    for (let off = -rad; off <= rad; off += 4) {
      let dot = 0;
      let enC = 1e-9;
      const baseC = nomInt + off;
      for (let k = 0; k < corrLen; k += 2) {
        const a = ringM[(anchorInt + k) & mask];
        const c = ringM[(baseC + k) & mask];
        dot += a * c;
        enC += c * c;
      }
      const normRatio = off / rad;
      const bias = 1.0 - 0.1 * normRatio * normRatio;
      const score = (dot / Math.sqrt(energyAnchor * enC)) * bias;
      if (score > bestScore) {
        bestScore = score;
        bestOffset = off;
      }
    }

    if (bestScore < 0.12) {
      return nominalPos;
    }

    // Stage 2: Fine 1-sample search around bestOffset
    const centerOff = bestOffset;
    let fineBest = centerOff;
    let fineBestVal = -2.0;
    const scores = new Float32Array(9);

    for (let d = -4; d <= 4; d++) {
      const off = centerOff + d;
      let dot = 0;
      let enC = 1e-9;
      const baseC = nomInt + off;
      for (let k = 0; k < corrLen; k += 2) {
        const a = ringM[(anchorInt + k) & mask];
        const c = ringM[(baseC + k) & mask];
        dot += a * c;
        enC += c * c;
      }
      const s = dot / Math.sqrt(energyAnchor * enC);
      scores[d + 4] = s;
      if (s > fineBestVal) {
        fineBestVal = s;
        fineBest = off;
      }
    }

    // Stage 3: Parabolic subsample refinement
    const idx = fineBest - centerOff + 4;
    let subDelta = 0;
    if (idx > 0 && idx < 8) {
      const sPrev = scores[idx - 1];
      const sCurr = scores[idx];
      const sNext = scores[idx + 1];
      const denom = sPrev - 2.0 * sCurr + sNext;
      if (Math.abs(denom) > 1e-6) {
        subDelta = Math.max(-0.5, Math.min(0.5, (0.5 * (sPrev - sNext)) / denom));
      }
    }

    return nominalPos + fineBest + subDelta;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output[1] || outL;
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    const nFrames = outL.length;

    const mask = this.RING_MASK;
    const ringL = this.ringL;
    const ringR = this.ringR;
    const ringM = this.ringM;
    const W = this.W;
    const halfW = this.halfW;
    const win = this.win;

    const isBypass = Math.abs(this.targetRatio - 1.0) < 0.0002 && Math.abs(this.currentRatio - 1.0) < 0.0002;

    for (let i = 0; i < nFrames; i++) {
      const xL = inL ? inL[i] : 0;
      const xR = inR ? inR[i] : 0;

      const wp = this.writePos & mask;
      ringL[wp] = xL;
      ringR[wp] = xR;
      ringM[wp] = 0.5 * (xL + xR);

      if (isBypass) {
        outL[i] = xL;
        outR[i] = xR;
        this.readPos0 = this.writePos - this.CENTER_DELAY;
        this.readPos1 = this.writePos - this.CENTER_DELAY;
        this.writePos++;
        this.p0 = (this.p0 + 1) % W;
        continue;
      }

      // Smoothly glide ratio to prevent zipper noise
      this.currentRatio += (this.targetRatio - this.currentRatio) * 0.003;
      const ratio = this.currentRatio;

      const p0 = this.p0;
      const p1 = (p0 + halfW) % W;

      // When a grain wraps to window position 0 (weight = 0.0), align its read pointer via SOLA NCC
      if (p0 === 0) {
        const nomDelay = this.CENTER_DELAY + halfW * (ratio - 1.0);
        const nominalPos = this.writePos - nomDelay;
        this.readPos0 = this.findAlignedReadPos(nominalPos, this.readPos1);
      } else if (p1 === 0) {
        const nomDelay = this.CENTER_DELAY + halfW * (ratio - 1.0);
        const nominalPos = this.writePos - nomDelay;
        this.readPos1 = this.findAlignedReadPos(nominalPos, this.readPos0);
      }

      const w0 = win[p0];
      const w1 = win[p1];

      const s0L = this.readHermite(ringL, this.readPos0);
      const s1L = this.readHermite(ringL, this.readPos1);
      const s0R = this.readHermite(ringR, this.readPos0);
      const s1R = this.readHermite(ringR, this.readPos1);

      let yL = w0 * s0L + w1 * s1L;
      let yR = w0 * s0R + w1 * s1R;

      // Formant / Warmth Spectral Tilt Compensation
      if (this.formantPreserve > 0.01 && Math.abs(ratio - 1.0) > 0.01) {
        // One-pole low-frequency warmth extraction (~380 Hz)
        const alpha = 0.048;
        this.lpStateL += alpha * (yL - this.lpStateL);
        this.lpStateR += alpha * (yR - this.lpStateR);
        const highL = yL - this.lpStateL;
        const highR = yR - this.lpStateR;

        if (ratio > 1.0) {
          // Pitching UP: restore low-mid body and tame shifted high-frequency harshness
          const amt = Math.min(0.45, (ratio - 1.0) * 0.9 * this.formantPreserve);
          yL = this.lpStateL * (1.0 + amt * 0.55) + highL * (1.0 - amt * 0.45);
          yR = this.lpStateR * (1.0 + amt * 0.55) + highR * (1.0 - amt * 0.45);
        } else {
          // Pitching DOWN: tighten low-mid boominess and restore upper presence
          const amt = Math.min(0.45, (1.0 - ratio) * 1.1 * this.formantPreserve);
          yL = this.lpStateL * (1.0 - amt * 0.4) + highL * (1.0 + amt * 0.5);
          yR = this.lpStateR * (1.0 - amt * 0.4) + highR * (1.0 + amt * 0.5);
        }
      }

      outL[i] = yL;
      outR[i] = yR;

      this.readPos0 += ratio;
      this.readPos1 += ratio;
      this.writePos++;
      this.p0 = (p0 + 1) % W;
    }

    return true;
  }
}

registerProcessor('${WORKLET_PROCESSOR_NAME}', StudioPitchProProcessor);
`;

const BUS_PITCH_SPECS: Record<
  Exclude<BusGroup, 'DRUMS' | 'UTILITY'>,
  { grainSize: number; searchRadius: number }
> = {
  BASS: { grainSize: 2560, searchRadius: 768 }, // Deep fundamental lock down to 30Hz
  GUITARS: { grainSize: 1792, searchRadius: 512 }, // Crisp pick attack & chord clarity
  KEYS: { grainSize: 2304, searchRadius: 640 }, // Ultra-smooth pads, piano & strings
  VOCALS: { grainSize: 1536, searchRadius: 480 }, // Tight articulation + formant warmth
};

let registeredContexts = new WeakSet<BaseAudioContext>();

export async function ensurePitchWorkletRegistered(ctx: AudioContext): Promise<boolean> {
  if (registeredContexts.has(ctx)) return true;
  if (!ctx.audioWorklet) return false;
  try {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    registeredContexts.add(ctx);
    return true;
  } catch {
    return false;
  }
}

export class StudioPitchBusRack {
  readonly ctx: AudioContext;
  readonly pitchedBuses = new Map<Exclude<BusGroup, 'DRUMS' | 'UTILITY'>, GainNode>();
  readonly unpitchedInput: GainNode;
  readonly unpitchedDelay: DelayNode;
  readonly output: GainNode;

  private workletNodes = new Map<Exclude<BusGroup, 'DRUMS' | 'UTILITY'>, AudioWorkletNode>();
  private semitones = 0;
  private cents = 0;
  private mode: PitchMode = 'PRO_SOLA';
  private formantPreserve = 0.75;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.connect(destination);

    // Unpitched bus (Drums, Percussion, Click, Guide) with sample-accurate delay compensation
    this.unpitchedInput = ctx.createGain();
    this.unpitchedDelay = ctx.createDelay(0.2);
    this.unpitchedDelay.delayTime.value = 0;
    this.unpitchedInput.connect(this.unpitchedDelay);
    this.unpitchedDelay.connect(this.output);

    const busKeys: Exclude<BusGroup, 'DRUMS' | 'UTILITY'>[] = ['BASS', 'GUITARS', 'KEYS', 'VOCALS'];
    for (const b of busKeys) {
      const g = ctx.createGain();
      // Until AudioWorklet finishes registering (~3ms), connect directly to output
      g.connect(this.output);
      this.pitchedBuses.set(b, g);
    }

    void this.initWorklets();
  }

  private async initWorklets() {
    const ok = await ensurePitchWorkletRegistered(this.ctx);
    if (!ok) return;

    const busKeys: Exclude<BusGroup, 'DRUMS' | 'UTILITY'>[] = ['BASS', 'GUITARS', 'KEYS', 'VOCALS'];
    for (const b of busKeys) {
      const inputGain = this.pitchedBuses.get(b)!;
      const spec = BUS_PITCH_SPECS[b];
      try {
        const node = new AudioWorkletNode(this.ctx, WORKLET_PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: spec,
        });
        inputGain.disconnect();
        inputGain.connect(node);
        node.connect(this.output);
        this.workletNodes.set(b, node);
      } catch {
        /* fallback keeps direct connection */
      }
    }
    this.syncParams();
  }

  getBusInput(bus: BusGroup, pitchEnabled: boolean): AudioNode {
    if (!pitchEnabled || bus === 'DRUMS' || bus === 'UTILITY') {
      return this.unpitchedInput;
    }
    return this.pitchedBuses.get(bus) ?? this.pitchedBuses.get('KEYS')!;
  }

  setPitchParams(semitones: number, cents = 0, mode: PitchMode = 'PRO_SOLA', formantPreserve = 0.75) {
    this.semitones = semitones;
    this.cents = cents;
    this.mode = mode;
    this.formantPreserve = formantPreserve;
    this.syncParams();
  }

  private syncParams() {
    const totalSemis = this.semitones + this.cents / 100;
    const ratio = Math.pow(2, totalSemis / 12);
    const isBypass = Math.abs(totalSemis) < 0.001;

    // Delay compensation on unpitched Drums/Click/Guide so transients stay 100% locked with pitched instruments
    const compDelaySec = isBypass ? 0 : PITCH_CENTER_DELAY_SAMPLES / this.ctx.sampleRate;
    this.unpitchedDelay.delayTime.setTargetAtTime(compDelaySec, this.ctx.currentTime, 0.008);

    const grainScale =
      this.mode === 'TIGHT_RHYTHM' ? 0.72 : this.mode === 'WARM_FORMANT' ? 1.18 : 1.0;

    this.workletNodes.forEach((node) => {
      node.port.postMessage({
        ratio,
        formantPreserve: this.formantPreserve,
        grainScale,
      });
    });
  }
}
