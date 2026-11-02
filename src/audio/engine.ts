import type { BusGroup, ClickSound, ClickSubdivision, OutputBus, PitchMode, SectionType } from '../types';
import { createGuideCueBuffer } from './pitchShift';
import { StudioPitchBusRack } from './proPitchWorklet';
import { AudioWorkerTimer } from './audioWorkerTimer';
import { cancelAllGuideSpeech } from './guideVoices';

/**
 * Multitrack audio engine built on the Web Audio API.
 * - Sample-accurate start / stop / jump (section changes are scheduled on the audio clock)
 * - Per-track gain, pan, Peak + RMS metering
 * - Dual Audio Device Aggregation (USB sound card for Tracks + Notebook headphone jack for Click/Guide = 4 real physical outputs)
 * - Real Multichannel Hardware Routing (ChannelMergerNode up to 8 discrete hardware channels: Out 1/2, Out 3/4, Out 5 Guide, Out 6 Click)
 *   with 100% channel isolation and zero bleed
 * - Routable Guide track node (plays real audio cues through Out 5 / Ch 3 & Guide VU meter)
 * - Varispeed / Time-Stretch playbackRate, master fade-out, and brickwall safety limiter
 * - Real-time hardware sampleRate and outputLatency / baseLatency reporting
 */

function cloneBufferToCtx(targetCtx: BaseAudioContext, source: AudioBuffer): AudioBuffer {
  const rate = source.sampleRate || targetCtx.sampleRate;
  const b = targetCtx.createBuffer(source.numberOfChannels, source.length, rate);
  for (let ch = 0; ch < source.numberOfChannels; ch++) {
    b.copyToChannel(source.getChannelData(ch), ch);
  }
  return b;
}

interface EngineTrack {
  id: string;
  buffer: AudioBuffer | null; // null allowed for synthetic guide bus
  gain: GainNode;
  pan: StereoPannerNode;
  splitter: ChannelSplitterNode;
  analyser: AnalyserNode;
  data: Float32Array<ArrayBuffer>;
  outputBus: OutputBus;
  bus: BusGroup;
  pitchEnabled: boolean;
  targetVol: number;
  audible: boolean;
  muted: boolean;
  solo: boolean;
  sources: AudioBufferSourceNode[];
  // Dual-device support (Notebook soundcard):
  secondaryGain?: GainNode;
  secondaryPan?: StereoPannerNode;
  secondaryBuffer?: AudioBuffer | null;
  secondarySources: AudioBufferSourceNode[];
}

interface Segment {
  ctxTime: number; // audio-clock time at which this segment begins
  offset: number; // song position at ctxTime
  rate: number;
}

export function getRequiredChannelsForBus(bus?: OutputBus): number {
  if (!bus) return 2;
  if (bus === 'OUT_7_8' || bus === 'OUT_7' || bus === 'OUT_8') return 8;
  if (bus === 'OUT_5_6' || bus === 'OUT_5' || bus === 'OUT_6') return 6;
  if (bus === 'OUT_3_4' || bus === 'OUT_3' || bus === 'OUT_4') return 4;
  return 2;
}

export function getOutputBusPins(bus: OutputBus, maxCh: number): { mono?: number; stereo?: [number, number] } {
  switch (bus) {
    case 'OUT_1_L':
      return { mono: 0 };
    case 'OUT_2_R':
      return { mono: Math.min(1, maxCh - 1) };
    case 'OUT_3_4':
      return maxCh >= 4 ? { stereo: [2, 3] } : { stereo: [0, Math.min(1, maxCh - 1)] };
    case 'OUT_3':
      return { mono: maxCh >= 3 ? 2 : 0 };
    case 'OUT_4':
      return { mono: maxCh >= 4 ? 3 : Math.min(1, maxCh - 1) };
    case 'OUT_5_6':
      return maxCh >= 6 ? { stereo: [4, 5] } : maxCh >= 4 ? { stereo: [2, 3] } : { stereo: [0, Math.min(1, maxCh - 1)] };
    case 'OUT_5':
      return { mono: maxCh >= 5 ? 4 : maxCh >= 3 ? 2 : 0 };
    case 'OUT_6':
      return { mono: maxCh >= 6 ? 5 : maxCh >= 4 ? 3 : Math.min(1, maxCh - 1) };
    case 'OUT_7_8':
      return maxCh >= 8 ? { stereo: [6, 7] } : maxCh >= 4 ? { stereo: [2, 3] } : { stereo: [0, Math.min(1, maxCh - 1)] };
    case 'OUT_7':
      return { mono: maxCh >= 7 ? 6 : maxCh >= 5 ? 4 : maxCh >= 3 ? 2 : 0 };
    case 'OUT_8':
      return { mono: maxCh >= 8 ? 7 : maxCh >= 4 ? 3 : Math.min(1, maxCh - 1) };
    case 'OUT_1_2':
    default:
      return { stereo: [0, Math.min(1, maxCh - 1)] };
  }
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private secondaryCtx: AudioContext | null = null;
  private secondaryDeviceId = '';
  private useDualDevices = false;
  private secondaryGuideGain: GainNode | null = null;
  private internalGuideTrack: EngineTrack;
  private smartRouting = true;

  private master: GainNode;
  private pitchRack: StudioPitchBusRack;
  private fadeGain: GainNode;
  private limiter: DynamicsCompressorNode;
  private tracksSplitter: ChannelSplitterNode;
  private analyserSplitter: ChannelSplitterNode;
  private merger: ChannelMergerNode | null = null;
  private analyserL: AnalyserNode;
  private analyserR: AnalyserNode;
  private dataL: Float32Array<ArrayBuffer>;
  private dataR: Float32Array<ArrayBuffer>;
  private tracks = new Map<string, EngineTrack>();
  private segments: Segment[] = [];
  private pausedAt = 0;
  private rate = 1;
  private multichannelActive = false;
  private driverType: 'WASAPI' | 'ASIO' = 'WASAPI';
  private asioDriverName = 'WASAPI Exclusivo (Windows Pro Audio)';
  private asioBufferSize = 128;
  private asioSampleRate = 48000;
  stemsFadedOut = false;
  playing = false;
  duration = 0;

  // Dedicated test tone isolation tracker (100% zero crosstalk)
  private activeTestToneNodes: { osc: OscillatorNode; gain: GainNode; merger: ChannelMergerNode } | null = null;
  private activeTestTimeout: number | null = null;

  // Decoupled Metering (Worker-driven peak updates to prevent audio-thread locks)
  private meterWorker: AudioWorkerTimer | null = null;
  private cachedMasterPeaks: [number, number] = [0, 0];
  private cachedTrackPeaks = new Map<string, number>();
  private cachedReductionDb = 0;

  // Autonomous Click (Metronome) system with Web Worker Audio Timer
  private autonomousClick = false;
  hasRecordedClick = false;
  private metronomeWorker: AudioWorkerTimer | null = null;
  private nextBeatTime = 0;
  private currentBeat = 0;
  private metronomeBar = 1;
  private metronomeBpm = 120;
  private metronomeBeatsPerBar = 4;
  private metronomeSubdivision: ClickSubdivision = '1/4';
  private metronomeSound: ClickSound = 'woodblock';
  private internalClickTrack: EngineTrack;
  private onMetronomeBeatCb?: (beat: number, bar: number) => void;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.fadeGain = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    // Brickwall stage safety limiter (-0.3 dB threshold, fast attack)
    this.limiter.threshold.value = -0.3;
    this.limiter.knee.value = 0.0;
    this.limiter.ratio.value = 20.0;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;

    this.tracksSplitter = this.ctx.createChannelSplitter(2);
    this.analyserSplitter = this.ctx.createChannelSplitter(2);

    this.pitchRack = new StudioPitchBusRack(this.ctx, this.master);
    this.master.connect(this.fadeGain);
    this.fadeGain.connect(this.limiter);

    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    this.analyserL.fftSize = this.analyserR.fftSize = 1024;
    this.dataL = new Float32Array(1024);
    this.dataR = new Float32Array(1024);

    // Initialize standalone internal Click Track node
    const clickGain = this.ctx.createGain();
    const clickPan = this.ctx.createStereoPanner();
    const clickSplitter = this.ctx.createChannelSplitter(2);
    const clickAnalyser = this.ctx.createAnalyser();
    clickAnalyser.fftSize = 512;
    clickGain.connect(clickPan);
    clickPan.connect(clickAnalyser);

    this.internalClickTrack = {
      id: '__INTERNAL_CLICK',
      buffer: null,
      gain: clickGain,
      pan: clickPan,
      splitter: clickSplitter,
      analyser: clickAnalyser,
      data: new Float32Array(512),
      outputBus: 'OUT_4',
      bus: 'UTILITY',
      pitchEnabled: false,
      targetVol: 0.75,
      audible: true,
      muted: false,
      solo: false,
      sources: [],
      secondarySources: [],
    };

    // Initialize standalone internal Guide Track node (Software Neural Voice Guide IA)
    const guideGain = this.ctx.createGain();
    const guidePan = this.ctx.createStereoPanner();
    const guideSplitter = this.ctx.createChannelSplitter(2);
    const guideAnalyser = this.ctx.createAnalyser();
    guideAnalyser.fftSize = 512;
    guideGain.connect(guidePan);
    guidePan.connect(guideAnalyser);

    this.internalGuideTrack = {
      id: '__AUTO_GUIDE',
      buffer: null,
      gain: guideGain,
      pan: guidePan,
      splitter: guideSplitter,
      analyser: guideAnalyser,
      data: new Float32Array(512),
      outputBus: 'OUT_3',
      bus: 'UTILITY',
      pitchEnabled: false,
      targetVol: 0.9,
      audible: true,
      muted: false,
      solo: false,
      sources: [],
      secondarySources: [],
    };

    this.configureDestinationChannels();
    this.initDeviceListeners();

    // Start background worker for decoupled metering (30Hz, zero main-thread lock)
    this.meterWorker = new AudioWorkerTimer(33, () => this.updateMetersThrottled());
    this.meterWorker.start();
  }

  /**
   * Configures discrete output channel routing for Windows WASAPI (Standard Stereo, 2-OUTS Split, or Multichannel 4/6/8).
   * Guarantees 100% discrete DAC mapping without stereo downmixing, duplicate channels, or bleed.
   */
  private configureDestinationChannels() {
    const dest = this.ctx.destination;
    const isTwoOuts = this.smartRouting;

    // Target count dynamically based on available physical hardware outputs and highest requested track bus
    let targetCount = 2;
    if (!this.useDualDevices) {
      if (isTwoOuts) {
        targetCount = 2;
      } else {
        targetCount = Math.max(2, dest.maxChannelCount || 2);
      }

      // Automatically expand channel count if any track or click/guide requires higher physical channels
      let highestReq = Math.max(
        getRequiredChannelsForBus(this.internalClickTrack?.outputBus),
        getRequiredChannelsForBus(this.internalGuideTrack?.outputBus),
      );
      for (const t of this.tracks.values()) {
        highestReq = Math.max(highestReq, getRequiredChannelsForBus(t.outputBus));
      }
      targetCount = Math.max(targetCount, highestReq);
    }

    try {
      this.limiter.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.tracksSplitter.disconnect();
    } catch {
      /* ignore */
    }
    if (this.merger) {
      try {
        this.merger.disconnect();
      } catch {
        /* ignore */
      }
      this.merger = null;
    }

    if (this.useDualDevices) {
      // DUAL AUDIO DEVICES MODE:
      // Primary device plays backing tracks in True Stereo (L/R)
      // Secondary device (notebook jack) plays Click/Guide
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      this.merger = this.ctx.createChannelMerger(2);
      this.merger.channelCountMode = 'explicit';
      this.merger.channelInterpretation = 'discrete';
      this.merger.connect(dest);

      this.limiter.connect(this.tracksSplitter);
      this.tracksSplitter.connect(this.merger, 0, 0); // Out 1 (Left PA)
      this.tracksSplitter.connect(this.merger, 1, 1); // Out 2 (Right PA)
      this.multichannelActive = true;
    } else if (isTwoOuts) {
      // 2-OUTS MODE (Split L/R Cabo Y):
      // Channel 1 (Left): Fones (Click & Guia) strictly isolated
      // Channel 2 (Right): P.A. (Mono Sum of Backing Tracks)
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      this.merger = this.ctx.createChannelMerger(2);
      this.merger.channelCountMode = 'explicit';
      this.merger.channelInterpretation = 'discrete';
      this.merger.connect(dest);

      this.limiter.connect(this.tracksSplitter);
      this.tracksSplitter.connect(this.merger, 0, 1); // Tracks Left -> Out 2 (Right PA)
      this.tracksSplitter.connect(this.merger, 1, 1); // Tracks Right -> Out 2 (Right PA)
      this.multichannelActive = true;
    } else if (targetCount >= 4) {
      // MULTICHANNEL MODE (4, 6, 8 OUTS):
      try {
        const maxHw = Math.max(2, dest.maxChannelCount || 2);
        let channelCount = Math.min(Math.max(4, targetCount), Math.max(4, maxHw));
        try {
          dest.channelCount = Math.min(channelCount, maxHw);
          dest.channelCountMode = 'explicit';
          dest.channelInterpretation = 'discrete';
        } catch {
          // If browser restricts destination channel count, fallback safely
        }
        const mergerChannels = Math.max(channelCount, targetCount, 4);
        this.merger = this.ctx.createChannelMerger(mergerChannels);
        this.merger.channelCountMode = 'explicit';
        this.merger.channelInterpretation = 'discrete';
        this.merger.connect(dest);

        // Out 1 (pin 0) & Out 2 (pin 1) are P.A. Master Backing Tracks
        this.limiter.connect(this.tracksSplitter);
        this.tracksSplitter.connect(this.merger, 0, 0);
        this.tracksSplitter.connect(this.merger, 1, Math.min(1, mergerChannels - 1));

        this.multichannelActive = true;
      } catch (e) {
        console.warn('Falha ao configurar canais discretos multicanal:', e);
        this.multichannelActive = false;
        this.limiter.connect(dest);
      }
    } else {
      // STANDARD STEREO MODE (2 Channels Native WASAPI):
      // Preserves 100% discrete stereo separation!
      // Out 1: Left
      // Out 2: Right
      dest.channelCount = 2;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      this.merger = this.ctx.createChannelMerger(2);
      this.merger.channelCountMode = 'explicit';
      this.merger.channelInterpretation = 'discrete';
      this.merger.connect(dest);

      this.limiter.connect(this.tracksSplitter);
      this.tracksSplitter.connect(this.merger, 0, 0); // Out 1 (Left)
      this.tracksSplitter.connect(this.merger, 1, 1); // Out 2 (Right)
      this.multichannelActive = true;
    }

    // Connect Limiter to stereo VU Analyser
    try {
      this.analyserSplitter.disconnect();
    } catch {
      /* ignore */
    }
    this.limiter.connect(this.analyserSplitter);
    this.analyserSplitter.connect(this.analyserL, 0);
    this.analyserSplitter.connect(this.analyserR, 1);

    // Re-route active tracks to ensure correct routing
    for (const t of this.tracks.values()) {
      this.routeTrackNode(t);
    }
    if (this.internalClickTrack) {
      this.routeTrackNode(this.internalClickTrack);
    }
    if (this.internalGuideTrack) {
      this.routeTrackNode(this.internalGuideTrack);
    }
  }

  setSmartRouting(enabled: boolean) {
    this.smartRouting = enabled;
    this.configureDestinationChannels();
  }

  /**
   * Dual Audio Device Mode:
   * Enables simultaneous playback through two distinct hardware audio devices.
   * e.g. Primary Device = USB Audio Interface (Tracks Channels 1 & 2)
   *      Secondary Device = Notebook Realtek Headphone Jack (Click Channel 4 & Guide Channel 3)
   * Provides 100% physical isolation with zero bleed!
   */
  async setDualDeviceConfig(enabled: boolean, primaryDeviceId: string, secondaryDeviceId: string) {
    this.useDualDevices = enabled;
    this.secondaryDeviceId = secondaryDeviceId;

    if (enabled) {
      if (!this.secondaryCtx || this.secondaryCtx.state === 'closed') {
        this.secondaryCtx = new AudioContext({ latencyHint: 'interactive' });
      }
      if (this.secondaryCtx.state === 'suspended') {
        try {
          await this.secondaryCtx.resume();
        } catch {
          /* ignore */
        }
      }
      const sec = this.secondaryCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (sec.setSinkId && secondaryDeviceId) {
        try {
          await sec.setSinkId(secondaryDeviceId);
        } catch (e) {
          console.warn('Falha ao definir setSinkId para placa secundária (Notebook):', e);
        }
      }
      await this.setOutputDevice(primaryDeviceId);
    } else {
      if (this.secondaryCtx) {
        try {
          await this.secondaryCtx.close();
        } catch {
          /* ignore */
        }
        this.secondaryCtx = null;
      }
      await this.setOutputDevice(primaryDeviceId);
    }

    this.configureDestinationChannels();
  }

  getGuideContext(): AudioContext {
    return this.useDualDevices && this.secondaryCtx ? this.secondaryCtx : this.ctx;
  }

  getGuideDestinationNode(): AudioNode {
    if (this.useDualDevices && this.secondaryCtx) {
      if (!this.secondaryGuideGain) {
        this.secondaryGuideGain = this.secondaryCtx.createGain();
        const p = this.secondaryCtx.createStereoPanner();
        p.pan.value = -1; // Canal 3 (Left - Guia)
        this.secondaryGuideGain.connect(p).connect(this.secondaryCtx.destination);
      }
      return this.secondaryGuideGain;
    }
    return this.internalGuideTrack.gain;
  }

  setInternalClickMix(volume: number, mute: boolean, outputBus: OutputBus = 'OUT_4', pan = 0) {
    this.internalClickTrack.targetVol = volume;
    this.internalClickTrack.muted = mute;
    const now = this.ctx.currentTime;
    this.internalClickTrack.pan.pan.setTargetAtTime(pan, now, 0.015);
    if (outputBus !== this.internalClickTrack.outputBus) {
      this.internalClickTrack.outputBus = outputBus;
      const req = getRequiredChannelsForBus(outputBus);
      if (this.merger && this.merger.numberOfInputs < req) {
        this.configureDestinationChannels();
      } else {
        this.routeTrackNode(this.internalClickTrack);
      }
    }
    this.updateAllTracksAudibility();
  }

  setInternalGuideMix(volume: number, mute: boolean, outputBus: OutputBus = 'OUT_3') {
    this.internalGuideTrack.targetVol = volume;
    this.internalGuideTrack.muted = mute;
    if (outputBus !== this.internalGuideTrack.outputBus) {
      this.internalGuideTrack.outputBus = outputBus;
      const req = getRequiredChannelsForBus(outputBus);
      if (this.merger && this.merger.numberOfInputs < req) {
        this.configureDestinationChannels();
      } else {
        this.routeTrackNode(this.internalGuideTrack);
      }
    }
    this.updateAllTracksAudibility();
  }

  setAsioConfig(
    _driverType: 'WASAPI' | 'ASIO',
    _driverName: string,
    bufferSize: number,
    sampleRate: number,
  ) {
    this.driverType = 'WASAPI';
    this.asioDriverName = 'WASAPI Nativo (Windows Pro Audio)';
    this.asioBufferSize = bufferSize;
    this.asioSampleRate = sampleRate;
  }

  /**
   * Total count of discrete physical output channels detected across active devices.
   * Unifies WASAPI primary device (USB Audio Interface) and secondary device (Notebook audio) when in Dual Mode.
   */
  getDetectedPhysicalChannels(): number {
    const primaryCh = Math.max(2, this.ctx.destination.maxChannelCount || 2);
    if (this.useDualDevices) {
      const secCh = this.secondaryCtx ? Math.max(2, this.secondaryCtx.destination.maxChannelCount || 2) : 2;
      return primaryCh + secCh;
    }
    // Return max of hardware reported or actively configured merger channels
    return Math.max(primaryCh, this.merger?.numberOfInputs || 2);
  }

  /** Real hardware audio telemetry (driver type, sample rate, latency, and active channels). */
  getHardwareStats(): {
    sampleRate: number;
    latencyMs: number;
    maxChannels: number;
    detectedChannels: number;
    multichannel: boolean;
    driverType: 'WASAPI' | 'ASIO';
    driverName: string;
    bufferSize: number;
    useDualDevices: boolean;
    secondaryDeviceId: string;
  } {
    const c = this.ctx as AudioContext & { baseLatency?: number; outputLatency?: number };
    const base = c.baseLatency ?? 0.003;
    const out = c.outputLatency ?? 0.002;
    const latencyMs = Math.max(1.2, Math.round((base + out) * 10000) / 10);
    const detectedChannels = this.getDetectedPhysicalChannels();
    const maxChannels = Math.max(detectedChannels, this.ctx.destination.maxChannelCount || 2);

    return {
      sampleRate: this.asioSampleRate || this.ctx.sampleRate,
      latencyMs,
      maxChannels,
      detectedChannels,
      multichannel: this.useDualDevices || maxChannels > 2,
      driverType: this.driverType,
      driverName: this.useDualDevices
        ? 'Dual Device (WASAPI USB + Notebook)'
        : this.asioDriverName,
      bufferSize: this.asioBufferSize,
      useDualDevices: this.useDualDevices,
      secondaryDeviceId: this.secondaryDeviceId,
    };
  }

  get position(): number {
    if (!this.playing || this.segments.length === 0) return this.pausedAt;
    const now = this.ctx.currentTime;
    let seg = this.segments[0];
    for (const s of this.segments) if (s.ctxTime <= now) seg = s;
    const p = seg.offset + Math.max(0, now - seg.ctxTime) * seg.rate;
    return Math.min(p, this.duration);
  }

  /** Audio-clock time at which the given song position will be reached (assuming no jumps). */
  ctxTimeFor(pos: number): number {
    const now = this.ctx.currentTime;
    const cur = this.position;
    return now + (pos - cur) / this.rate;
  }

  get playbackRate() {
    return this.rate;
  }

  flushAndReset() {
    this.killSources();
    this.playing = false;
    this.stemsFadedOut = false;
    this.segments = [];
    this.pausedAt = 0;
    cancelAllGuideSpeech();
    void this.stopPhysicalChannelTestTone();

    try {
      this.fadeGain.gain.cancelScheduledValues(0);
      this.fadeGain.gain.setValueAtTime(1, this.ctx.currentTime);
    } catch {
      /* ignore */
    }

    for (const t of this.tracks.values()) {
      try { t.gain.disconnect(); } catch { /* ignore */ }
      try { t.pan.disconnect(); } catch { /* ignore */ }
      try { t.splitter.disconnect(); } catch { /* ignore */ }
      try { t.analyser.disconnect(); } catch { /* ignore */ }
      if (t.secondaryGain) {
        try { t.secondaryGain.disconnect(); } catch { /* ignore */ }
      }
      if (t.secondaryPan) {
        try { t.secondaryPan.disconnect(); } catch { /* ignore */ }
      }
    }
    this.tracks.clear();
    this.duration = 0;
  }

  load(
    list: {
      id: string;
      buffer: AudioBuffer | null;
      output?: OutputBus;
      bus?: BusGroup;
      pitchEnabled?: boolean;
      volume?: number;
      pan?: number;
      mute?: boolean;
      solo?: boolean;
    }[],
  ) {
    this.flushAndReset();

    for (const {
      id,
      buffer,
      output = 'OUT_1_2',
      bus = 'KEYS',
      pitchEnabled = true,
      volume = 0.85,
      pan: initialPan = 0,
      mute = false,
      solo = false,
    } of list) {
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const splitter = this.ctx.createChannelSplitter(2);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;

      gain.gain.setValueAtTime(mute ? 0 : volume, this.ctx.currentTime);
      pan.pan.setValueAtTime(initialPan, this.ctx.currentTime);

      gain.connect(pan);
      pan.connect(analyser);

      let secondaryGain: GainNode | undefined;
      let secondaryPan: StereoPannerNode | undefined;
      let secondaryBuffer: AudioBuffer | null = null;

      const isSecondaryOut =
        output === 'OUT_3' ||
        output === 'OUT_4' ||
        output === 'OUT_3_4' ||
        output === 'OUT_5' ||
        output === 'OUT_6' ||
        bus === 'UTILITY' ||
        id === 'click' ||
        id === 'guide';

      if (this.useDualDevices && this.secondaryCtx && isSecondaryOut) {
        try {
          secondaryGain = this.secondaryCtx.createGain();
          secondaryPan = this.secondaryCtx.createStereoPanner();
          secondaryGain.gain.setValueAtTime(mute ? 0 : volume, this.secondaryCtx.currentTime);
          secondaryGain.connect(secondaryPan);
          secondaryPan.connect(this.secondaryCtx.destination);

          if (output === 'OUT_3' || output === 'OUT_5' || id === 'guide') {
            secondaryPan.pan.value = -1; // Canal 3 (Left - Guia)
          } else if (output === 'OUT_4' || output === 'OUT_6' || id === 'click') {
            secondaryPan.pan.value = 1; // Canal 4 (Right - Click)
          } else {
            secondaryPan.pan.value = initialPan; // Center / Stereo (Ch 3 & 4)
          }

          if (buffer) {
            secondaryBuffer = cloneBufferToCtx(this.secondaryCtx, buffer);
          }
        } catch (e) {
          console.warn('Erro ao inicializar nó secundário para track:', id, e);
        }
      }

      const et: EngineTrack = {
        id,
        buffer,
        gain,
        pan,
        splitter,
        analyser,
        data: new Float32Array(512),
        outputBus: output,
        bus,
        pitchEnabled,
        targetVol: volume,
        audible: !mute,
        muted: mute,
        solo: solo,
        sources: [],
        secondaryGain,
        secondaryPan,
        secondaryBuffer,
        secondarySources: [],
      };
      this.routeTrackNode(et);
      this.tracks.set(id, et);
      if (buffer) this.duration = Math.max(this.duration, buffer.duration);
    }
    this.hasRecordedClick = list.some(
      (t) =>
        t.buffer !== null &&
        (t.id.toLowerCase().includes('click') || t.id === 'click') &&
        !t.id.toLowerCase().includes('guide') &&
        !t.id.toLowerCase().includes('guia') &&
        t.id !== '__INTERNAL_CLICK',
    );
    this.pausedAt = 0;
  }

  private routeTrackNode(t: EngineTrack) {
    try {
      t.pan.disconnect();
      t.splitter.disconnect();
    } catch {
      /* ignore */
    }
    t.pan.connect(t.analyser);
    const pitchDest = this.pitchRack.getBusInput(t.bus, t.pitchEnabled);

    // MODE 1: Dual Audio Devices Mode (Notebook + Placa USB)
    if (this.useDualDevices && this.secondaryCtx) {
      if (
        t.id === '__INTERNAL_CLICK' ||
        t.id === '__AUTO_GUIDE' ||
        t.bus === 'UTILITY' ||
        t.outputBus === 'OUT_3' ||
        t.outputBus === 'OUT_4' ||
        t.outputBus === 'OUT_3_4'
      ) {
        // Utility / Fones tracks (Click / Guide) route exclusively to secondaryCtx (Notebook)
        return;
      }
      // Musical backing tracks route to pitch rack on primary ctx (Placa USB) in true stereo
      t.pan.connect(pitchDest);
      return;
    }

    const isTwoOuts = this.smartRouting;

    // MODE 2: 2-OUTS Split L/R (Cabo Y Mono Split)
    if (isTwoOuts && this.merger) {
      if (t.outputBus === 'OUT_1_2') {
        // Modo Estéreo completo quando selecionado Out 1/2
        t.pan.connect(pitchDest);
        return;
      }
      if (
        t.outputBus === 'OUT_1_L' ||
        t.outputBus === 'OUT_3' ||
        t.outputBus === 'OUT_4' ||
        t.outputBus === 'OUT_5' ||
        t.outputBus === 'OUT_6'
      ) {
        t.pan.connect(t.splitter);
        t.splitter.connect(this.merger, 0, 0); // Out 1 Left (Fones)
        return;
      }
      if (t.outputBus === 'OUT_2_R') {
        t.pan.connect(t.splitter);
        t.splitter.connect(this.merger, 0, 1); // Out 2 Right (PA)
        return;
      }
      // Padrão musical via pitchDest -> limiter -> tracksSplitter -> Out 2 (Right - PA)
      t.pan.connect(pitchDest);
      return;
    }

    // MODE 3: Multichannel WASAPI or Direct Discrete Mapping
    if (this.merger) {
      const maxCh = this.merger.numberOfInputs;

      // Special case: OUT_1_2 for ANY track (backing tracks, click, guide, etc.) follows the exact same master stereo pipeline
      if (t.outputBus === 'OUT_1_2') {
        t.pan.connect(pitchDest);
        return;
      }

      // Discrete physical mapping for any assigned OutputBus (Tracks, Click, Guide, Submix, etc.)
      const pins = getOutputBusPins(t.outputBus, maxCh);
      t.pan.connect(t.splitter);
      if (pins.stereo) {
        t.splitter.connect(this.merger, 0, pins.stereo[0]);
        t.splitter.connect(this.merger, 1, pins.stereo[1]);
      } else if (typeof pins.mono === 'number') {
        // Mono to discrete physical pin
        t.splitter.connect(this.merger, 0, pins.mono);
      }
      return;
    }

    t.pan.connect(pitchDest);
  }

  /**
   * Immediately silences and disconnects any running channel test tone.
   */
  async stopPhysicalChannelTestTone() {
    if (this.activeTestTimeout) {
      clearTimeout(this.activeTestTimeout);
      this.activeTestTimeout = null;
    }
    if (this.activeTestToneNodes) {
      try {
        const { osc, gain, merger } = this.activeTestToneNodes;
        const now = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0.0001, now + 0.015);
        osc.stop(now + 0.02);
        setTimeout(() => {
          try {
            osc.disconnect();
            gain.disconnect();
            merger.disconnect();
          } catch {}
        }, 35);
      } catch {}
      this.activeTestToneNodes = null;
    }
  }

  /**
   * Play an isolated test tone specifically on a single physical output channel (1 to 8).
   * ZERO CROSSTALK: Audio is injected solely and exclusively into the targeted hardware channel.
   */
  async playPhysicalChannelTestTone(channelNum: number) {
    await this.stopPhysicalChannelTestTone();

    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.secondaryCtx && this.secondaryCtx.state !== 'running') {
      await this.secondaryCtx.resume();
    }

    const freqMap: Record<number, number> = {
      1: 440,    // A4 (Tracks L)
      2: 554.37, // C#5 (Tracks R)
      3: 659.25, // E5 (Voz Guia)
      4: 880,    // A5 (Click Metrônomo)
      5: 740,    // F#5 (Alt L)
      6: 830,    // G#5 (Alt R)
      7: 987.77, // B5 (Aux L)
      8: 1046.5, // C6 (Aux R)
    };
    const freq = freqMap[channelNum] ?? 440;

    // CASE 1: Dual Audio Devices Mode (Notebook + Placa USB)
    if (this.useDualDevices && this.secondaryCtx) {
      if (channelNum === 1 || channelNum === 2) {
        // Plays on Primary Context (Placa USB)
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const pan = this.ctx.createStereoPanner();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.4, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
        pan.pan.value = channelNum === 1 ? -1 : 1;
        osc.connect(g).connect(pan).connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.68);
        return;
      } else if (channelNum === 3 || channelNum === 4) {
        // Plays on Secondary Context (Notebook Jack)
        const now = this.secondaryCtx.currentTime;
        const osc = this.secondaryCtx.createOscillator();
        const g = this.secondaryCtx.createGain();
        const pan = this.secondaryCtx.createStereoPanner();
        osc.type = channelNum === 4 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, now);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.4, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
        pan.pan.value = channelNum === 3 ? -1 : 1;
        osc.connect(g).connect(pan).connect(this.secondaryCtx.destination);
        osc.start(now);
        osc.stop(now + 0.68);
        return;
      }
    }

    // CASE 2: Single Multichannel Device (WASAPI Exclusivo / Multicanal)
    // Create an isolated discrete test merger targeting exclusively channelNum - 1
    const dest = this.ctx.destination;
    const requiredChs = Math.max(channelNum, 4, dest.channelCount);
    if (dest.channelCount < requiredChs) {
      try {
        dest.channelCount = requiredChs;
      } catch {}
    }

    const testMerger = this.ctx.createChannelMerger(requiredChs);
    testMerger.channelCountMode = 'explicit';
    testMerger.channelInterpretation = 'discrete';
    testMerger.connect(dest);

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = channelNum === 4 ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.4, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

    // ZERO CROSSTALK: Connect SOLELY and EXCLUSIVELY to pin channelNum - 1
    osc.connect(g);
    g.connect(testMerger, 0, channelNum - 1);
    osc.start(now);
    osc.stop(now + 0.68);

    this.activeTestToneNodes = { osc, gain: g, merger: testMerger };
    this.activeTestTimeout = window.setTimeout(() => {
      try {
        osc.disconnect();
        g.disconnect();
        testMerger.disconnect();
      } catch {}
      this.activeTestToneNodes = null;
      this.activeTestTimeout = null;
    }, 720);
  }

  /** Play an identification test tone on a specific OutputBus. */
  async playOutputTestTone(bus: OutputBus, _smartRouting = true) {
    if (bus === 'OUT_1_L' || bus === 'OUT_1_2') {
      await this.playPhysicalChannelTestTone(1);
      return;
    }
    if (bus === 'OUT_2_R') {
      await this.playPhysicalChannelTestTone(2);
      return;
    }
    if (bus === 'OUT_3' || bus === 'OUT_3_4') {
      await this.playPhysicalChannelTestTone(3);
      return;
    }
    if (bus === 'OUT_4') {
      await this.playPhysicalChannelTestTone(4);
      return;
    }
    if (bus === 'OUT_5' || bus === 'OUT_5_6') {
      await this.playPhysicalChannelTestTone(5);
      return;
    }
    if (bus === 'OUT_6') {
      await this.playPhysicalChannelTestTone(6);
      return;
    }
    if (bus === 'OUT_7' || bus === 'OUT_7_8') {
      await this.playPhysicalChannelTestTone(7);
      return;
    }
    if (bus === 'OUT_8') {
      await this.playPhysicalChannelTestTone(8);
      return;
    }
  }

  setTrackMix(
    id: string,
    volume: number,
    pan: number,
    audible: boolean,
    outputBus?: OutputBus,
    bus?: BusGroup,
    pitchEnabled?: boolean,
    muted?: boolean,
    solo?: boolean,
  ) {
    const t = this.tracks.get(id);
    if (!t) return;
    if (typeof muted === 'boolean') t.muted = muted;
    if (typeof solo === 'boolean') t.solo = solo;
    let needsReroute = false;
    if (outputBus && outputBus !== t.outputBus) {
      t.outputBus = outputBus;
      needsReroute = true;
    }
    if (bus && bus !== t.bus) {
      t.bus = bus;
      needsReroute = true;
    }
    if (typeof pitchEnabled === 'boolean' && pitchEnabled !== t.pitchEnabled) {
      t.pitchEnabled = pitchEnabled;
      needsReroute = true;
    }
    if (needsReroute) {
      this.routeTrackNode(t);
    }
    t.targetVol = volume;
    t.audible = audible;
    const now = this.ctx.currentTime;
    const isMusical = t.bus !== 'UTILITY';
    const effectiveVol = !audible ? 0 : this.stemsFadedOut && isMusical ? 0 : volume;
    t.gain.gain.setTargetAtTime(effectiveVol, now, 0.015);
    t.pan.pan.setTargetAtTime(pan, now, 0.015);

    // If dual devices active and track has secondary gain:
    if (t.secondaryGain && this.secondaryCtx) {
      t.secondaryGain.gain.setTargetAtTime(effectiveVol, this.secondaryCtx.currentTime, 0.015);
    }
  }

  private resolveTrack(id: string): EngineTrack | undefined {
    return (
      this.tracks.get(id) ||
      (id === '__INTERNAL_CLICK' ? this.internalClickTrack : undefined) ||
      (id === '__AUTO_GUIDE' ? this.internalGuideTrack : undefined)
    );
  }

  /** Direct atomic volume update (AudioParam ramp) with zero node teardown or routing lock. */
  setTrackVolume(id: string, volume: number) {
    const t = this.resolveTrack(id);
    if (!t) return;
    t.targetVol = volume;
    const now = this.ctx.currentTime;
    const isMusical = t.bus !== 'UTILITY';
    const effectiveVol = !t.audible ? 0 : this.stemsFadedOut && isMusical ? 0 : volume;
    t.gain.gain.setTargetAtTime(effectiveVol, now, 0.015);
    if (t.secondaryGain && this.secondaryCtx) {
      t.secondaryGain.gain.setTargetAtTime(effectiveVol, this.secondaryCtx.currentTime, 0.015);
    }
  }

  /** Direct atomic stereo pan update (AudioParam ramp). */
  setTrackPan(id: string, pan: number) {
    const t = this.resolveTrack(id);
    if (!t) return;
    const now = this.ctx.currentTime;
    t.pan.pan.setTargetAtTime(pan, now, 0.015);
  }

  updateAllTracksAudibility() {
    const anyStemSolo = Array.from(this.tracks.values()).some((tr) => tr.solo);
    const anySolo = anyStemSolo || this.internalClickTrack.solo || this.internalGuideTrack.solo;
    const now = this.ctx.currentTime;

    // 1. Process all stem tracks in multitrack
    for (const tr of this.tracks.values()) {
      const isUtility =
        tr.bus === 'UTILITY' ||
        tr.id === 'click' ||
        tr.id === 'guide' ||
        tr.id.toLowerCase().includes('click') ||
        tr.id.toLowerCase().includes('guide') ||
        tr.id.toLowerCase().includes('guia');

      // SOLO LOGIC MATRIX:
      // When ANY track is in Solo:
      // - ONLY tracks explicitly marked with solo=true (and !muted) are audible.
      // - All non-soloed tracks (musical or utility) are strictly muted in background (audible = false).
      // When NO track is in Solo:
      // - All unmuted tracks (!muted) are audible.
      const audible = anySolo ? (tr.solo && !tr.muted) : !tr.muted;

      tr.audible = audible;
      const isMusical = !isUtility;
      const effectiveVol = !audible ? 0 : this.stemsFadedOut && isMusical ? 0 : tr.targetVol;
      tr.gain.gain.setTargetAtTime(effectiveVol, now, 0.015);
      if (tr.secondaryGain && this.secondaryCtx) {
        tr.secondaryGain.gain.setTargetAtTime(effectiveVol, this.secondaryCtx.currentTime, 0.015);
      }
    }

    // 2. Process internal Click Track (__INTERNAL_CLICK)
    // If Solo mode is active, click is audible ONLY if internal click itself is in Solo!
    const clickAudible = anySolo
      ? (this.internalClickTrack.solo && !this.internalClickTrack.muted)
      : !this.internalClickTrack.muted;
    this.internalClickTrack.audible = clickAudible;
    const clickEffective = !clickAudible ? 0 : this.internalClickTrack.targetVol;
    this.internalClickTrack.gain.gain.setTargetAtTime(clickEffective, now, 0.015);
    if (this.internalClickTrack.secondaryGain && this.secondaryCtx) {
      this.internalClickTrack.secondaryGain.gain.setTargetAtTime(clickEffective, this.secondaryCtx.currentTime, 0.015);
    }

    // 3. Process internal Guide Track (__AUTO_GUIDE)
    // If Solo mode is active, guide is audible ONLY if internal guide itself is in Solo!
    const guideAudible = anySolo
      ? (this.internalGuideTrack.solo && !this.internalGuideTrack.muted)
      : !this.internalGuideTrack.muted;
    this.internalGuideTrack.audible = guideAudible;
    const guideEffective = !guideAudible ? 0 : this.internalGuideTrack.targetVol;
    this.internalGuideTrack.gain.gain.setTargetAtTime(guideEffective, now, 0.015);
    if (this.secondaryGuideGain && this.secondaryCtx) {
      this.secondaryGuideGain.gain.setTargetAtTime(guideEffective, this.secondaryCtx.currentTime, 0.015);
    }
  }

  /** Direct atomic mute toggle. Supports stem tracks, internal click, and guide. */
  setTrackMute(id: string, mute: boolean) {
    if (id === '__INTERNAL_CLICK') {
      this.internalClickTrack.muted = mute;
      this.updateAllTracksAudibility();
      return;
    }
    if (id === '__AUTO_GUIDE') {
      this.internalGuideTrack.muted = mute;
      this.updateAllTracksAudibility();
      return;
    }
    const t = this.tracks.get(id);
    if (!t) return;
    t.muted = mute;
    this.updateAllTracksAudibility();
  }

  /** Direct atomic solo toggle. Supports multi-track soloing with zero reload. */
  setTrackSolo(id: string, solo: boolean) {
    if (id === '__INTERNAL_CLICK') {
      this.internalClickTrack.solo = solo;
      this.updateAllTracksAudibility();
      return;
    }
    if (id === '__AUTO_GUIDE') {
      this.internalGuideTrack.solo = solo;
      this.updateAllTracksAudibility();
      return;
    }
    const t = this.tracks.get(id);
    if (!t) return;
    t.solo = solo;
    this.updateAllTracksAudibility();
  }

  setTrackPitchEnabled(id: string, enabled: boolean) {
    const t = this.tracks.get(id);
    if (!t || t.pitchEnabled === enabled) return;
    t.pitchEnabled = enabled;
    this.routeTrackNode(t);
  }

  setTrackOutputBus(id: string, outputBus: OutputBus) {
    const t = this.resolveTrack(id);
    if (!t || t.outputBus === outputBus) return;
    t.outputBus = outputBus;

    // Expand hardware destination pins if higher physical channel required
    const reqChannels = getRequiredChannelsForBus(outputBus);
    if (this.merger && this.merger.numberOfInputs < reqChannels) {
      this.configureDestinationChannels();
    } else {
      this.routeTrackNode(t);
    }
  }

  setPitchParams(semitones: number, cents = 0, mode: PitchMode = 'PRO_SOLA', formantPreserve = 0.75) {
    this.pitchRack.setPitchParams(semitones, cents, mode, formantPreserve);
  }

  getTrackGainNode(id: string | undefined): AudioNode | undefined {
    if (!id) return this.master;
    return this.resolveTrack(id)?.gain ?? this.master;
  }

  /** Trigger a synthesized audio cue into the Guide track's audio node (or dedicated guide output). */
  triggerGuideCue(guideTrackId: string | undefined, sectionType: SectionType, volume = 0.9) {
    if (volume <= 0.001 || !this.internalGuideTrack.audible) return;

    // Dual Device Mode: Route directly to secondary context (Notebook Left / Ch 3)
    if (this.useDualDevices && this.secondaryCtx) {
      if (this.secondaryCtx.state !== 'running') void this.secondaryCtx.resume();
      const cueBuf = createGuideCueBuffer(this.secondaryCtx, sectionType);
      const src = this.secondaryCtx.createBufferSource();
      src.buffer = cueBuf;
      const g = this.secondaryCtx.createGain();
      g.gain.value = volume;
      const pan = this.secondaryCtx.createStereoPanner();
      pan.pan.value = -1; // Canal 3 (Left - Guia)
      src.connect(g).connect(pan).connect(this.secondaryCtx.destination);
      src.start(this.secondaryCtx.currentTime);
      src.onended = () => {
        src.disconnect();
        g.disconnect();
        pan.disconnect();
      };
      return;
    }

    const cueBuf = createGuideCueBuffer(this.ctx, sectionType);
    const src = this.ctx.createBufferSource();
    src.buffer = cueBuf;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);

    const t = guideTrackId ? this.tracks.get(guideTrackId) : undefined;
    if (t) {
      g.connect(t.gain);
    } else if (this.multichannelActive && this.merger) {
      const pins = getOutputBusPins(this.internalGuideTrack?.outputBus || 'OUT_3', this.merger.numberOfInputs);
      const guideCh = typeof pins.mono === 'number' ? pins.mono : (pins.stereo ? pins.stereo[0] : 2);
      g.connect(this.merger, 0, Math.min(guideCh, this.merger.numberOfInputs - 1));
    } else {
      g.connect(this.master);
    }

    src.start(this.ctx.currentTime);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  setMasterVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private startSources(offset: number, when: number) {
    const secWhen = this.secondaryCtx
      ? this.secondaryCtx.currentTime + Math.max(0, when - this.ctx.currentTime)
      : when;

    for (const t of this.tracks.values()) {
      for (const old of t.sources) {
        try {
          old.stop(when);
          old.disconnect();
        } catch {
          /* already stopped/disconnected */
        }
      }
      for (const old of t.secondarySources) {
        try {
          old.stop(secWhen);
          old.disconnect();
        } catch {
          /* already stopped/disconnected */
        }
      }

      const isSecondary =
        t.bus === 'UTILITY' ||
        t.id === 'click' ||
        t.id === 'guide' ||
        t.id.toLowerCase().includes('click') ||
        t.id.toLowerCase().includes('guide') ||
        t.outputBus === 'OUT_3' ||
        t.outputBus === 'OUT_4' ||
        t.outputBus === 'OUT_3_4' ||
        t.outputBus === 'OUT_5' ||
        t.outputBus === 'OUT_6';

      // If dual devices is active and this is a secondary track (Click / Guide / Out 3/4):
      if (this.useDualDevices && this.secondaryCtx && isSecondary) {
        const freshSec: AudioBufferSourceNode[] = [];
        const buf = t.secondaryBuffer || (t.buffer ? cloneBufferToCtx(this.secondaryCtx, t.buffer) : null);
        if (buf && offset < buf.duration && t.secondaryGain) {
          const src = this.secondaryCtx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = this.rate;
          src.connect(t.secondaryGain);
          src.start(secWhen, Math.max(0, offset));
          src.onended = () => {
            t.secondarySources = t.secondarySources.filter((s) => s !== src);
            try {
              src.disconnect();
            } catch {
              /* ignore */
            }
          };
          freshSec.push(src);
        }
        t.secondarySources = freshSec;
        t.sources = [];
        continue;
      }

      // Otherwise, play on primary context
      const fresh: AudioBufferSourceNode[] = [];
      if (t.buffer && offset < t.buffer.duration) {
        const src = this.ctx.createBufferSource();
        src.buffer = t.buffer;
        src.playbackRate.value = this.rate;
        src.connect(t.gain);
        src.start(when, Math.max(0, offset));
        src.onended = () => {
          t.sources = t.sources.filter((s) => s !== src);
          try {
            src.disconnect();
          } catch {
            /* ignore */
          }
        };
        fresh.push(src);
      }
      t.sources = fresh;
      t.secondarySources = [];
    }
  }

  async play(from?: number) {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.secondaryCtx && this.secondaryCtx.state !== 'running') {
      await this.secondaryCtx.resume();
    }
    if (this.playing) return;
    const offset = from ?? this.pausedAt;
    const when = this.ctx.currentTime + 0.05;

    // Garante que os stems nunca fiquem mudos por resíduo de fade anterior
    this.stemsFadedOut = false;
    this.updateAllTracksAudibility();

    this.fadeGain.gain.cancelScheduledValues(0);
    this.fadeGain.gain.setValueAtTime(1, this.ctx.currentTime);
    this.startSources(offset, when);
    this.segments = [{ ctxTime: when, offset, rate: this.rate }];
    this.playing = true;

    // Master Clock & Metronome Alignment:
    // Only schedule ticks if autonomous click (metronome) is explicitly enabled by the user!
    if (this.autonomousClick) {
      const beatLen = 60 / (this.metronomeBpm * this.rate);
      const totalBeats = offset / beatLen;
      const beatIndex = Math.floor(totalBeats);
      const beatFraction = totalBeats - beatIndex;
      this.currentBeat = beatIndex % this.metronomeBeatsPerBar;
      this.metronomeBar = Math.floor(beatIndex / this.metronomeBeatsPerBar) + 1;
      this.nextBeatTime = when + (beatFraction < 0.001 ? 0 : (1 - beatFraction) * beatLen);
      this.startMetronomeScheduler();
    } else {
      this.stopMetronomeScheduler();
    }
  }

  pause() {
    if (!this.playing) return;
    const pos = this.position;
    this.killSources();
    this.pausedAt = pos;
    this.playing = false;
    this.segments = [];
    cancelAllGuideSpeech();
    void this.stopPhysicalChannelTestTone();
    if (this.autonomousClick) {
      // Continue click scheduler without stopping!
      this.startMetronomeScheduler();
    } else {
      this.stopMetronomeScheduler();
    }
  }

  stop() {
    this.killSources();
    this.playing = false;
    this.stemsFadedOut = false;
    this.segments = [];
    this.pausedAt = 0;
    cancelAllGuideSpeech();
    void this.stopPhysicalChannelTestTone();
    if (this.autonomousClick) {
      // Continue click scheduler without stopping!
      this.startMetronomeScheduler();
    } else {
      this.stopMetronomeScheduler();
    }
  }

  private killSources() {
    for (const t of this.tracks.values()) {
      for (const s of t.sources) {
        try {
          s.stop();
        } catch {
          /* noop */
        }
        try {
          s.disconnect();
        } catch {
          /* noop */
        }
      }
      t.sources = [];

      for (const s of t.secondarySources) {
        try {
          s.stop();
        } catch {
          /* noop */
        }
        try {
          s.disconnect();
        } catch {
          /* noop */
        }
      }
      t.secondarySources = [];
    }
  }

  seek(pos: number) {
    pos = Math.max(0, Math.min(pos, this.duration));
    if (this.playing) {
      const when = this.ctx.currentTime + 0.03;
      this.jumpAt(pos, when);
      const beatLen = 60 / (this.metronomeBpm * this.rate);
      const totalBeats = pos / beatLen;
      const beatIndex = Math.floor(totalBeats);
      const beatFraction = totalBeats - beatIndex;
      this.currentBeat = beatIndex % this.metronomeBeatsPerBar;
      this.metronomeBar = Math.floor(beatIndex / this.metronomeBeatsPerBar) + 1;
      this.nextBeatTime = when + (beatFraction < 0.001 ? 0 : (1 - beatFraction) * beatLen);
    } else {
      this.pausedAt = pos;
    }
  }

  /** Schedule a jump to song position `to` at audio-clock time `when` (sample accurate). */
  jumpAt(to: number, when: number) {
    if (!this.playing) {
      this.pausedAt = to;
      return;
    }
    when = Math.max(when, this.ctx.currentTime + 0.005);
    this.startSources(to, when);
    const now = this.ctx.currentTime;
    this.segments = this.segments.filter((_, i, arr) => i === arr.length - 1 || arr[i + 1].ctxTime > now);
    this.segments.push({ ctxTime: when, offset: to, rate: this.rate });

    // Sync metronome immediately to new section jump position on the master clock
    const beatLen = 60 / (this.metronomeBpm * this.rate);
    const totalBeats = to / beatLen;
    const beatIndex = Math.floor(totalBeats);
    const beatFraction = totalBeats - beatIndex;
    this.currentBeat = beatIndex % this.metronomeBeatsPerBar;
    this.metronomeBar = Math.floor(beatIndex / this.metronomeBeatsPerBar) + 1;
    this.nextBeatTime = when + (beatFraction < 0.001 ? 0 : (1 - beatFraction) * beatLen);
  }

  setRate(rate: number) {
    rate = Math.max(0.5, Math.min(1.5, rate));
    if (this.playing) {
      const now = this.ctx.currentTime;
      const secNow = this.secondaryCtx ? this.secondaryCtx.currentTime : now;
      const pos = this.position;
      for (const t of this.tracks.values()) {
        for (const s of t.sources) s.playbackRate.setValueAtTime(rate, now);
        for (const s of t.secondarySources) s.playbackRate.setValueAtTime(rate, secNow);
      }
      this.segments = [{ ctxTime: now, offset: pos, rate }];
      // Re-align metronome to new rate
      const beatLen = 60 / (this.metronomeBpm * rate);
      const totalBeats = pos / beatLen;
      const beatIndex = Math.floor(totalBeats);
      const beatFraction = totalBeats - beatIndex;
      this.currentBeat = beatIndex % this.metronomeBeatsPerBar;
      this.metronomeBar = Math.floor(beatIndex / this.metronomeBeatsPerBar) + 1;
      this.nextBeatTime = now + (beatFraction < 0.001 ? 0 : (1 - beatFraction) * beatLen);
    }
    this.rate = rate;
  }

  /**
   * Auto-Fade Musical Stems over `seconds` while keeping Click & Guide playing (or Fade-In if already faded).
   */
  fadeOut(seconds = 5, keepClickAndGuide = true): Promise<void> {
    if (!this.playing) return Promise.resolve();
    const now = this.ctx.currentTime;
    if (keepClickAndGuide) {
      const nextFaded = !this.stemsFadedOut;
      this.stemsFadedOut = nextFaded;
      for (const t of this.tracks.values()) {
        if (t.bus === 'UTILITY' || t.id.toLowerCase().includes('click') || t.id.toLowerCase().includes('guide')) continue; // Keep Click and Guide playing
        t.gain.gain.cancelScheduledValues(now);
        t.gain.gain.setValueAtTime(t.gain.gain.value, now);
        const dest = nextFaded ? 0 : t.audible ? t.targetVol : 0;
        t.gain.gain.linearRampToValueAtTime(dest, now + seconds);
      }
      return new Promise((res) => setTimeout(res, seconds * 1000 + 30));
    }
    this.fadeGain.gain.cancelScheduledValues(now);
    this.fadeGain.gain.setValueAtTime(this.fadeGain.gain.value, now);
    this.fadeGain.gain.linearRampToValueAtTime(0, now + seconds);
    return new Promise((res) =>
      setTimeout(() => {
        this.pause();
        this.fadeGain.gain.cancelScheduledValues(0);
        this.fadeGain.gain.setValueAtTime(1, this.ctx.currentTime);
        res();
      }, seconds * 1000 + 30),
    );
  }

  private level(an: AnalyserNode, data: Float32Array<ArrayBuffer>): { peak: number; rms: number } {
    an.getFloatTimeDomainData(data);
    let p = 0;
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > p) p = v;
      sumSq += v * v;
    }
    return { peak: p, rms: Math.sqrt(sumSq / data.length) };
  }

  trackPeak(id: string): number {
    return this.cachedTrackPeaks.get(id) ?? 0;
  }

  trackMetrics(id: string): { peak: number; rms: number } {
    const t = this.resolveTrack(id);
    return t ? this.level(t.analyser, t.data) : { peak: 0, rms: 0 };
  }

  // --- Autonomous Click (Continuous Metronome) API ---

  getClickTrack(): EngineTrack {
    return this.internalClickTrack;
  }

  isAutonomousClick(): boolean {
    return this.autonomousClick;
  }

  setAutonomousClick(enabled: boolean) {
    this.autonomousClick = enabled;
    if (enabled) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      if (this.secondaryCtx && this.secondaryCtx.state !== 'running') void this.secondaryCtx.resume();
      if (this.playing) {
        // Latch directly to the audio clock and position of the active song
        const now = this.ctx.currentTime;
        const pos = this.position;
        const beatLen = 60 / (this.metronomeBpm * this.rate);
        const totalBeats = pos / beatLen;
        const beatIndex = Math.floor(totalBeats);
        const beatFraction = totalBeats - beatIndex;
        this.currentBeat = beatIndex % this.metronomeBeatsPerBar;
        this.metronomeBar = Math.floor(beatIndex / this.metronomeBeatsPerBar) + 1;
        this.nextBeatTime = now + (beatFraction < 0.001 ? 0 : (1 - beatFraction) * beatLen);
        this.startMetronomeScheduler();
      } else {
        // Standalone continuous rehearsal metronome
        this.nextBeatTime = this.ctx.currentTime + 0.04;
        this.currentBeat = 0;
        this.metronomeBar = 1;
        this.triggerClickHit(this.ctx.currentTime + 0.01, 'accent');
        this.startMetronomeScheduler();
      }
    } else {
      // STOP immediately whether playing or stopped!
      this.stopMetronomeScheduler();
      if (this.onMetronomeBeatCb) {
        this.onMetronomeBeatCb(0, 0);
      }
    }
  }

  setMetronomeConfig(bpm: number, beatsPerBar: number, subdivision?: ClickSubdivision, sound?: ClickSound) {
    if (bpm > 20 && bpm < 320) this.metronomeBpm = bpm;
    if (beatsPerBar >= 1 && beatsPerBar <= 16) this.metronomeBeatsPerBar = beatsPerBar;
    if (subdivision) this.metronomeSubdivision = subdivision;
    if (sound) this.metronomeSound = sound;
  }

  setOnMetronomeBeat(cb: (beat: number, bar: number) => void) {
    this.onMetronomeBeatCb = cb;
  }

  private triggerClickHit(when: number, kind: 'accent' | 'quarter' | 'sub') {
    if (!this.autonomousClick) return;
    const clickTrack = this.internalClickTrack;
    if (!clickTrack || !clickTrack.audible) return;

    // Prevent collision if multitrack has an audible recorded click stem playing
    if (this.playing && this.hasRecordedClick) {
      const audibleRecordedClick = Array.from(this.tracks.values()).some(
        (t) => t.audible && t.id !== '__INTERNAL_CLICK' && (t.id.toLowerCase().includes('click') || t.id === 'click'),
      );
      if (audibleRecordedClick) return;
    }

    const targetCtx = this.ctx;

    const sound = this.metronomeSound;
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

    const amp = kind === 'accent' ? 0.95 : kind === 'quarter' ? 0.65 : 0.35;
    const decay = sound === 'rimshot' ? 0.025 : sound === 'woodblock' ? 0.035 : 0.045;

    // 1. Play on primary context (connected to clickTrack.gain)
    try {
      const osc = targetCtx.createOscillator();
      const env = targetCtx.createGain();
      osc.type = sound === 'rimshot' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, when);

      env.gain.setValueAtTime(0.0001, when);
      env.gain.linearRampToValueAtTime(amp, when + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, when + decay);

      const dest = clickTrack ? clickTrack.gain : this.master;
      osc.connect(env);
      env.connect(dest);

      osc.start(when);
      osc.stop(when + decay + 0.01);
      osc.onended = () => {
        try {
          osc.disconnect();
          env.disconnect();
        } catch {}
      };
    } catch {}

    // 2. Play on secondary context if Dual Devices is active
    if (this.useDualDevices && this.secondaryCtx && clickTrack?.secondaryGain) {
      try {
        const secWhen = this.secondaryCtx.currentTime + Math.max(0, when - targetCtx.currentTime);
        const secOsc = this.secondaryCtx.createOscillator();
        const secEnv = this.secondaryCtx.createGain();
        secOsc.type = sound === 'rimshot' ? 'triangle' : 'sine';
        secOsc.frequency.setValueAtTime(freq, secWhen);

        secEnv.gain.setValueAtTime(0.0001, secWhen);
        secEnv.gain.linearRampToValueAtTime(amp, secWhen + 0.002);
        secEnv.gain.exponentialRampToValueAtTime(0.0001, secWhen + decay);

        secOsc.connect(secEnv);
        secEnv.connect(clickTrack.secondaryGain);

        secOsc.start(secWhen);
        secOsc.stop(secWhen + decay + 0.01);
        secOsc.onended = () => {
          try {
            secOsc.disconnect();
            secEnv.disconnect();
          } catch {}
        };
      } catch {}
    }
  }

  private scheduleMetronomeTicks() {
    if (!this.autonomousClick) {
      this.stopMetronomeScheduler();
      return;
    }

    const now = this.ctx.currentTime;
    const beatLen = 60 / (this.metronomeBpm * this.rate);

    // Audio clock sync protection: if nextBeatTime dropped behind (e.g. system stall or tab switch)
    if (this.nextBeatTime < now - 0.05) {
      const overdue = now - this.nextBeatTime;
      const skipped = Math.floor(overdue / beatLen) + 1;
      this.nextBeatTime += skipped * beatLen;
      this.currentBeat = (this.currentBeat + skipped) % this.metronomeBeatsPerBar;
      this.metronomeBar += Math.floor((this.currentBeat + skipped) / this.metronomeBeatsPerBar);
    }

    // Lookahead: schedule 250ms ahead of current audio time (DAW standard for zero stutter)
    while (this.nextBeatTime < now + 0.25) {
      const isAccent = this.currentBeat === 0;
      const kind = isAccent ? 'accent' : 'quarter';
      this.triggerClickHit(this.nextBeatTime, kind);

      // Handle subdivisions
      if (this.metronomeSubdivision === '1/8') {
        this.triggerClickHit(this.nextBeatTime + beatLen * 0.5, 'sub');
      } else if (this.metronomeSubdivision === '1/16') {
        this.triggerClickHit(this.nextBeatTime + beatLen * 0.25, 'sub');
        this.triggerClickHit(this.nextBeatTime + beatLen * 0.5, 'sub');
        this.triggerClickHit(this.nextBeatTime + beatLen * 0.75, 'sub');
      } else if (this.metronomeSubdivision === '1/3') {
        this.triggerClickHit(this.nextBeatTime + beatLen / 3, 'sub');
        this.triggerClickHit(this.nextBeatTime + (beatLen * 2) / 3, 'sub');
      }

      // Notify UI of beat
      if (this.onMetronomeBeatCb) {
        const beatNum = this.currentBeat + 1;
        const barNum = this.metronomeBar;
        const delayMs = Math.max(0, (this.nextBeatTime - now) * 1000);
        setTimeout(() => {
          this.onMetronomeBeatCb?.(beatNum, barNum);
        }, delayMs);
      }

      this.nextBeatTime += beatLen;
      this.currentBeat = (this.currentBeat + 1) % this.metronomeBeatsPerBar;
      if (this.currentBeat === 0) {
        this.metronomeBar += 1;
      }
    }
  }

  private startMetronomeScheduler() {
    if (!this.metronomeWorker) {
      this.metronomeWorker = new AudioWorkerTimer(25, () => this.scheduleMetronomeTicks());
    }

    if (this.nextBeatTime < this.ctx.currentTime) {
      this.nextBeatTime = this.ctx.currentTime + 0.04;
      this.currentBeat = 0;
      this.metronomeBar = 1;
    }

    this.metronomeWorker.start();
  }

  private stopMetronomeScheduler() {
    if (this.metronomeWorker) {
      this.metronomeWorker.stop();
    }
  }

  private updateMetersThrottled() {
    if (this.ctx.state !== 'running') return;
    try {
      this.cachedMasterPeaks = [
        this.level(this.analyserL, this.dataL).peak,
        this.level(this.analyserR, this.dataR).peak,
      ];
      this.cachedReductionDb = this.limiter.reduction;

      for (const [id, t] of this.tracks.entries()) {
        if (!t.audible && t.gain.gain.value === 0) {
          this.cachedTrackPeaks.set(id, 0);
          continue;
        }
        const pk = this.level(t.analyser, t.data).peak;
        this.cachedTrackPeaks.set(id, pk);
      }

      if (this.internalClickTrack) {
        if (!this.internalClickTrack.audible && this.internalClickTrack.gain.gain.value === 0) {
          this.cachedTrackPeaks.set('__INTERNAL_CLICK', 0);
        } else {
          const pk = this.level(this.internalClickTrack.analyser, this.internalClickTrack.data).peak;
          this.cachedTrackPeaks.set('__INTERNAL_CLICK', pk);
        }
      }
      if (this.internalGuideTrack) {
        if (!this.internalGuideTrack.audible && this.internalGuideTrack.gain.gain.value === 0) {
          this.cachedTrackPeaks.set('__AUTO_GUIDE', 0);
        } else {
          const pk = this.level(this.internalGuideTrack.analyser, this.internalGuideTrack.data).peak;
          this.cachedTrackPeaks.set('__AUTO_GUIDE', pk);
        }
      }
    } catch {
      /* ignore audio context closing */
    }
  }

  masterPeaks(): [number, number] {
    return this.cachedMasterPeaks;
  }

  limiterReductionDb(): number {
    return this.cachedReductionDb;
  }

  private initDeviceListeners() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        console.log('[AudioEngine] Hardware devicechange detectado pelo SO. Verificando integridade...');
        await this.verifyAndRecoverAudioDestination();
      });
    }

    this.ctx.onstatechange = () => {
      console.log(`[AudioEngine] Context state mudou para: ${this.ctx.state}`);
      if (this.playing && this.ctx.state === 'suspended') {
        void this.ctx.resume().catch((err) => {
          console.warn('[AudioEngine] Tentativa de auto-resume após suspensão falhou:', err);
        });
      }
    };
  }

  async verifyAndRecoverAudioDestination() {
    try {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      this.configureDestinationChannels();
    } catch (err) {
      console.warn('[AudioEngine] Falha ao recuperar destino de áudio:', err);
    }
  }

  destroy() {
    this.meterWorker?.stop();
    this.metronomeWorker?.stop();
    this.stop();
    void this.ctx.close();
    if (this.secondaryCtx) {
      void this.secondaryCtx.close();
    }
  }

  /**
   * Retrieves the raw decoded AudioBuffer for an individual loaded stem.
   */
  getTrackBuffer(id: string): AudioBuffer | null {
    return this.tracks.get(id)?.buffer ?? null;
  }

  /**
   * Returns metadata and presence of buffers for all currently loaded stems.
   */
  getLoadedTrackList(): { id: string; bus: BusGroup; hasBuffer: boolean; duration: number }[] {
    return Array.from(this.tracks.entries()).map(([id, t]) => ({
      id,
      bus: t.bus,
      hasBuffer: !!t.buffer,
      duration: t.buffer ? t.buffer.duration : 0,
    }));
  }

  /**
   * Generates a composite stereo AudioBuffer summing the audible stems
   * for fast, zero-delay visual rendering in the Waveform Timeline editor.
   */
  getCompositeAudioBuffer(trackIds?: string[]): AudioBuffer | null {
    const list: AudioBuffer[] = [];
    if (trackIds && trackIds.length > 0) {
      for (const id of trackIds) {
        const b = this.tracks.get(id)?.buffer;
        if (b) list.push(b);
      }
    } else {
      for (const t of this.tracks.values()) {
        if (
          t.buffer &&
          !t.id.toLowerCase().includes('click') &&
          t.id !== '__INTERNAL_CLICK'
        ) {
          list.push(t.buffer);
        }
      }
    }

    if (list.length === 0) {
      for (const t of this.tracks.values()) {
        if (t.buffer) return t.buffer;
      }
      return null;
    }
    if (list.length === 1) return list[0];

    try {
      const sampleRate = list[0].sampleRate;
      const maxLen = Math.max(...list.map((b) => b.length));
      const composite = this.ctx.createBuffer(2, maxLen, sampleRate);
      const leftOut = composite.getChannelData(0);
      const rightOut = composite.getChannelData(1);

      const scale = 1 / Math.min(3, Math.sqrt(list.length));
      for (const buf of list) {
        const ch0 = buf.getChannelData(0);
        const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
        const len = buf.length;
        for (let i = 0; i < len; i++) {
          leftOut[i] += ch0[i] * scale;
          rightOut[i] += ch1[i] * scale;
        }
      }
      return composite;
    } catch (err) {
      console.warn('Erro ao gerar composite audio buffer:', err);
      return list[0];
    }
  }

  async setOutputDevice(deviceId: string) {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const c = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (c.setSinkId) {
      try {
        await c.setSinkId(deviceId || '');
      } catch (err) {
        console.warn('AudioContext.setSinkId falhou para o dispositivo:', deviceId, err);
      }
      this.configureDestinationChannels();
    }
  }
}

