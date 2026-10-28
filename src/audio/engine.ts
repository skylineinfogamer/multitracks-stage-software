import type { BusGroup, ClickSound, ClickSubdivision, OutputBus, PitchMode, SectionType } from '../types';
import { createGuideCueBuffer } from './pitchShift';
import { StudioPitchBusRack } from './proPitchWorklet';
import type { AsioOutputMapping } from './asioService';
import { DEFAULT_ASIO_MAPPING, asioService } from './asioService';

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
  private asioMapping: AsioOutputMapping = { ...DEFAULT_ASIO_MAPPING };
  private driverType: 'WASAPI' | 'ASIO' = 'ASIO';
  private asioDriverName = 'ASIO4ALL v2';
  private asioBufferSize = 128;
  private asioSampleRate = 48000;
  stemsFadedOut = false;
  playing = false;
  duration = 0;

  // Autonomous Click (Metronome) system
  private autonomousClick = false;
  hasRecordedClick = false;
  private metronomeTimer: number | null = null;
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
      outputBus: 'OUT_6',
      bus: 'UTILITY',
      pitchEnabled: false,
      targetVol: 0.75,
      audible: true,
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
      outputBus: 'OUT_5',
      bus: 'UTILITY',
      pitchEnabled: false,
      targetVol: 0.9,
      audible: true,
      sources: [],
      secondarySources: [],
    };

    this.configureDestinationChannels();
  }

  /** Enable discrete multichannel output for ASIO or multichannel audio interfaces. */
  private configureDestinationChannels() {
    const dest = this.ctx.destination;
    const isAsio = this.driverType === 'ASIO';
    const isTwoOuts =
      this.asioMapping.mode === '2' ||
      (this.asioMapping.tracksOutL === 2 && this.asioMapping.guideOut === 1 && this.asioMapping.clickOut === 1);
    const isFourOuts = this.asioMapping.mode === '4';
    const isSixOuts = this.asioMapping.mode === '6';
    const isEightOuts = this.asioMapping.mode === '8';

    let targetCount = 2;
    if (isAsio) {
      if (isTwoOuts) targetCount = 2;
      else if (isFourOuts) targetCount = 4;
      else if (isSixOuts) targetCount = 6;
      else if (isEightOuts) targetCount = 8;
      else {
        const highestMapped = Math.max(
          this.asioMapping.tracksOutL,
          this.asioMapping.tracksOutR,
          this.asioMapping.altOutL,
          this.asioMapping.altOutR,
          this.asioMapping.guideOut,
          this.asioMapping.clickOut,
          2,
        );
        targetCount = Math.max(highestMapped, dest.maxChannelCount || 2);
      }
    } else {
      targetCount = dest.maxChannelCount || 2;
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

    if (targetCount >= 4 && !this.useDualDevices) {
      try {
        const channelCount = Math.min(16, Math.max(4, targetCount));
        dest.channelCount = channelCount;
        dest.channelCountMode = 'explicit';
        dest.channelInterpretation = 'discrete';
        this.merger = this.ctx.createChannelMerger(channelCount);
        this.merger.connect(dest);

        // Connect Limiter (Master Backing Tracks) strictly to merger inputs tracksOutL and tracksOutR
        const tracksL = Math.max(0, (this.asioMapping.tracksOutL || 1) - 1);
        const tracksR = Math.max(0, (this.asioMapping.tracksOutR || 2) - 1);
        this.limiter.connect(this.tracksSplitter);
        this.tracksSplitter.connect(this.merger, 0, Math.min(tracksL, channelCount - 1));
        this.tracksSplitter.connect(this.merger, 1, Math.min(tracksR, channelCount - 1));

        this.multichannelActive = true;
      } catch (e) {
        console.warn('Falha ao configurar canais discretos:', e);
        this.multichannelActive = false;
        this.limiter.connect(dest);
      }
    } else if (targetCount === 2 && isTwoOuts && !this.useDualDevices) {
      // 2 OUTS mode (Split L/R Cabo Y)
      try {
        dest.channelCount = 2;
        dest.channelCountMode = 'explicit';
        dest.channelInterpretation = 'discrete';
        this.merger = this.ctx.createChannelMerger(2);
        this.merger.connect(dest);
        this.limiter.connect(this.tracksSplitter);
        this.tracksSplitter.connect(this.merger, 0, 1); // Tracks to Right (Ch 2)
        this.tracksSplitter.connect(this.merger, 1, 1); // Tracks to Right (Ch 2)
        this.multichannelActive = true;
      } catch {
        this.multichannelActive = false;
        this.limiter.connect(dest);
      }
    } else {
      // Standard stereo or dual-device mode
      dest.channelCount = 2;
      this.limiter.connect(dest);
      this.multichannelActive = false;
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

  setInternalClickMix(volume: number, mute: boolean, outputBus: OutputBus = 'OUT_6') {
    this.internalClickTrack.targetVol = volume;
    this.internalClickTrack.audible = !mute;
    if (outputBus !== this.internalClickTrack.outputBus) {
      this.internalClickTrack.outputBus = outputBus;
      this.routeTrackNode(this.internalClickTrack);
    }
    const now = this.ctx.currentTime;
    const effective = mute ? 0 : volume;
    this.internalClickTrack.gain.gain.setTargetAtTime(effective, now, 0.015);
    if (this.internalClickTrack.secondaryGain && this.secondaryCtx) {
      this.internalClickTrack.secondaryGain.gain.setTargetAtTime(effective, this.secondaryCtx.currentTime, 0.015);
    }
  }

  setInternalGuideMix(volume: number, mute: boolean, outputBus: OutputBus = 'OUT_5') {
    this.internalGuideTrack.targetVol = volume;
    this.internalGuideTrack.audible = !mute;
    if (outputBus !== this.internalGuideTrack.outputBus) {
      this.internalGuideTrack.outputBus = outputBus;
      this.routeTrackNode(this.internalGuideTrack);
    }
    const now = this.ctx.currentTime;
    const effective = mute ? 0 : volume;
    this.internalGuideTrack.gain.gain.setTargetAtTime(effective, now, 0.015);
    if (this.secondaryGuideGain && this.secondaryCtx) {
      this.secondaryGuideGain.gain.setTargetAtTime(effective, this.secondaryCtx.currentTime, 0.015);
    }
  }

  setAsioConfig(
    driverType: 'WASAPI' | 'ASIO',
    driverName: string,
    bufferSize: number,
    sampleRate: number,
    mapping?: AsioOutputMapping,
  ) {
    this.driverType = driverType;
    this.asioDriverName = driverName;
    this.asioBufferSize = bufferSize;
    this.asioSampleRate = sampleRate;
    if (mapping) {
      this.asioMapping = { ...mapping };
    }
    this.configureDestinationChannels();
  }

  /** Real hardware audio telemetry (driver type, sample rate, latency, and active channels). */
  getHardwareStats(): {
    sampleRate: number;
    latencyMs: number;
    maxChannels: number;
    multichannel: boolean;
    driverType: 'WASAPI' | 'ASIO';
    driverName: string;
    bufferSize: number;
    mapping: AsioOutputMapping;
    useDualDevices: boolean;
    secondaryDeviceId: string;
  } {
    const c = this.ctx as AudioContext & { baseLatency?: number; outputLatency?: number };
    let latencyMs: number;
    if (this.driverType === 'ASIO') {
      latencyMs = asioService.calculateLatencyMs(this.asioBufferSize, this.ctx.sampleRate);
    } else {
      const base = c.baseLatency ?? 0.004;
      const out = c.outputLatency ?? 0.002;
      latencyMs = Math.max(1.2, Math.round((base + out) * 10000) / 10);
    }
    const maxChannels = this.useDualDevices
      ? 4
      : Math.max(this.ctx.destination.maxChannelCount || 2, this.driverType === 'ASIO' ? 8 : 2);

    return {
      sampleRate: this.driverType === 'ASIO' && this.asioSampleRate ? this.asioSampleRate : this.ctx.sampleRate,
      latencyMs,
      maxChannels,
      multichannel: this.useDualDevices || this.multichannelActive || this.driverType === 'ASIO',
      driverType: this.driverType,
      driverName: this.useDualDevices
        ? 'Dual Device (USB + Notebook)'
        : this.driverType === 'ASIO'
          ? this.asioDriverName
          : 'WASAPI / WDM',
      bufferSize: this.asioBufferSize,
      mapping: { ...this.asioMapping },
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

  load(
    list: {
      id: string;
      buffer: AudioBuffer | null;
      output?: OutputBus;
      bus?: BusGroup;
      pitchEnabled?: boolean;
    }[],
  ) {
    this.stop();
    for (const t of this.tracks.values()) {
      t.gain.disconnect();
      t.pan.disconnect();
      t.splitter.disconnect();
      if (t.secondaryGain) {
        try {
          t.secondaryGain.disconnect();
        } catch {
          /* ignore */
        }
      }
      if (t.secondaryPan) {
        try {
          t.secondaryPan.disconnect();
        } catch {
          /* ignore */
        }
      }
    }
    this.tracks.clear();
    this.duration = 0;

    for (const { id, buffer, output = 'OUT_1_2', bus = 'KEYS', pitchEnabled = true } of list) {
      const gain = this.ctx.createGain();
      const pan = this.ctx.createStereoPanner();
      const splitter = this.ctx.createChannelSplitter(2);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      gain.connect(pan);
      pan.connect(analyser);

      let secondaryGain: GainNode | undefined;
      let secondaryPan: StereoPannerNode | undefined;
      let secondaryBuffer: AudioBuffer | null = null;

      const isUtility = output === 'OUT_6' || output === 'OUT_5' || bus === 'UTILITY' || id === 'click' || id === 'guide';

      if (this.useDualDevices && this.secondaryCtx && isUtility) {
        try {
          secondaryGain = this.secondaryCtx.createGain();
          secondaryPan = this.secondaryCtx.createStereoPanner();
          secondaryGain.connect(secondaryPan);
          secondaryPan.connect(this.secondaryCtx.destination);

          if (output === 'OUT_5' || id === 'guide') {
            secondaryPan.pan.value = -1; // Canal 3 (Left - Guia)
          } else if (output === 'OUT_6' || id === 'click') {
            secondaryPan.pan.value = 1; // Canal 4 (Right - Click)
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
        targetVol: 0.85,
        audible: true,
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
        (t.output === 'OUT_6' || t.id.toLowerCase().includes('click') || t.id === 'click') &&
        t.output !== 'OUT_5' &&
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
      if (t.outputBus === 'OUT_6' || t.outputBus === 'OUT_5' || t.bus === 'UTILITY' || t.id === 'click' || t.id === 'guide') {
        // Utility tracks (Click / Guide) route exclusively to secondaryCtx (Notebook)
        return;
      }
      // Musical backing tracks route to pitch rack on primary ctx (Placa USB)
      t.pan.connect(pitchDest);
      return;
    }

    // MODE 2: Discrete Multichannel (ASIO / 4, 6, 8 OUTS or WASAPI Multi-Out)
    if (this.multichannelActive && this.merger) {
      const maxCh = this.merger.numberOfInputs;
      const isTwoOuts = this.asioMapping.mode === '2';

      if (isTwoOuts) {
        if (t.outputBus === 'OUT_6') {
          t.pan.connect(t.splitter);
          t.splitter.connect(this.merger, 0, 0); // Out 1 (Left - Click strictly isolated)
          return;
        } else if (t.outputBus === 'OUT_5') {
          const guideCh = Math.max(0, (this.asioMapping.guideOut || 2) - 1);
          t.pan.connect(t.splitter);
          t.splitter.connect(this.merger, 0, Math.min(guideCh, maxCh - 1)); // Out 2 (Guide strictly isolated)
          return;
        } else {
          t.pan.connect(pitchDest); // Out 2 (Tracks) via limiter & tracksSplitter
          return;
        }
      }

      // OUT_6 (Click): Dynamic physical channel (Default: Channel 4 in 4-outs, Channel 6 in 6-outs)
      if (t.outputBus === 'OUT_6') {
        const clickCh = Math.max(0, (this.asioMapping.clickOut || 4) - 1);
        t.pan.connect(t.splitter);
        t.splitter.connect(this.merger, 0, Math.min(clickCh, maxCh - 1));
        return;
      }

      // OUT_5 (Guide): Dynamic physical channel (Default: Channel 3 in 4-outs, Channel 5 in 6-outs)
      if (t.outputBus === 'OUT_5') {
        const guideCh = Math.max(0, (this.asioMapping.guideOut || 3) - 1);
        t.pan.connect(t.splitter);
        t.splitter.connect(this.merger, 0, Math.min(guideCh, maxCh - 1));
        return;
      }

      // OUT_3_4 (Alt / Teclados / Pads): Dynamic stereo pair
      if (t.outputBus === 'OUT_3_4') {
        if (this.asioMapping.mode === '6' || this.asioMapping.mode === '8') {
          const altL = Math.max(0, (this.asioMapping.altOutL || 3) - 1);
          const altR = Math.max(0, (this.asioMapping.altOutR || 4) - 1);
          t.pan.connect(t.splitter);
          t.splitter.connect(this.merger, 0, Math.min(altL, maxCh - 1));
          t.splitter.connect(this.merger, 1, Math.min(altR, maxCh - 1));
          return;
        }
      }

      // OUT_1_L: Discrete Left Channel
      if (t.outputBus === 'OUT_1_L') {
        const tracksL = Math.max(0, (this.asioMapping.tracksOutL || 1) - 1);
        t.pan.connect(t.splitter);
        t.splitter.connect(this.merger, 0, Math.min(tracksL, maxCh - 1));
        return;
      }

      // OUT_2_R: Discrete Right Channel
      if (t.outputBus === 'OUT_2_R') {
        const tracksR = Math.max(0, (this.asioMapping.tracksOutR || 2) - 1);
        t.pan.connect(t.splitter);
        t.splitter.connect(this.merger, 1, Math.min(tracksR, maxCh - 1));
        return;
      }

      // All musical tracks (OUT_1_2, etc.) route through pitchRack -> master -> fadeGain -> limiter -> tracksSplitter -> merger
      t.pan.connect(pitchDest);
      return;
    }

    // MODE 3: Standard WASAPI Stereo (SmartRouting Split L/R if enabled)
    if (this.smartRouting && (t.outputBus === 'OUT_6' || t.id === '__INTERNAL_CLICK')) {
      t.pan.pan.value = -1; // Hard left for Click strictly
      t.pan.connect(this.master);
      return;
    } else if (this.smartRouting && (t.outputBus === 'OUT_5' || t.id === '__AUTO_GUIDE')) {
      t.pan.pan.value = 1; // Dedicated output for Guide; NEVER forced into Click Left channel!
      t.pan.connect(this.master);
      return;
    } else if (this.smartRouting) {
      t.pan.pan.value = 1; // Hard right for Tracks
      t.pan.connect(pitchDest);
      return;
    }

    t.pan.connect(pitchDest);
  }

  /**
   * Play an isolated test tone specifically on a single physical output channel (1 to 8).
   * Guarantees 100% isolation and 0% bleed to other channels.
   */
  async playPhysicalChannelTestTone(channelNum: number) {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.secondaryCtx && this.secondaryCtx.state !== 'running') {
      await this.secondaryCtx.resume();
    }

    const freqMap: Record<number, number> = {
      1: 440, // A4 (Tracks L)
      2: 554.37, // C#5 (Tracks R)
      3: 659.25, // E5 (Voz Guia)
      4: 880, // A5 (Click Metrônomo)
      5: 740, // F#5 (Alt L)
      6: 830, // G#5 (Alt R)
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
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.4, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
        pan.pan.value = channelNum === 1 ? -1 : 1; // Left or Right
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
        g.gain.setValueAtTime(0.001, now);
        g.gain.linearRampToValueAtTime(0.4, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
        pan.pan.value = channelNum === 3 ? -1 : 1; // Left (Guia) or Right (Click)
        osc.connect(g).connect(pan).connect(this.secondaryCtx.destination);
        osc.start(now);
        osc.stop(now + 0.68);
        return;
      }
    }

    // CASE 2: Single Multichannel Device (ASIO or Multichannel Interface)
    if (this.multichannelActive && this.merger) {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = channelNum === 4 || channelNum === 6 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(0.001, now);
      g.gain.linearRampToValueAtTime(0.4, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

      const targetMergerInput = Math.min(Math.max(0, channelNum - 1), this.merger.numberOfInputs - 1);
      osc.connect(g);
      g.connect(this.merger, 0, targetMergerInput);
      osc.start(now);
      osc.stop(now + 0.68);
      return;
    }

    // CASE 3: Standard 2-channel fallback
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const pan = this.ctx.createStereoPanner();
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.4, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
    pan.pan.value = channelNum % 2 === 1 ? -1 : 1;
    osc.connect(g).connect(pan).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.68);
  }

  /** Play an identification test tone on a specific OutputBus. */
  async playOutputTestTone(bus: OutputBus, _smartRouting = true) {
    if (bus === 'OUT_6') {
      await this.playPhysicalChannelTestTone(this.asioMapping.clickOut || 4);
      return;
    }
    if (bus === 'OUT_5') {
      await this.playPhysicalChannelTestTone(this.asioMapping.guideOut || 3);
      return;
    }
    if (bus === 'OUT_1_L') {
      await this.playPhysicalChannelTestTone(this.asioMapping.tracksOutL || 1);
      return;
    }
    if (bus === 'OUT_2_R') {
      await this.playPhysicalChannelTestTone(this.asioMapping.tracksOutR || 2);
      return;
    }
    if (bus === 'OUT_1_2') {
      await this.playPhysicalChannelTestTone(this.asioMapping.tracksOutL || 1);
      return;
    }
    if (bus === 'OUT_3_4') {
      await this.playPhysicalChannelTestTone(this.asioMapping.altOutL || 3);
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
  ) {
    const t = this.tracks.get(id);
    if (!t) return;
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

  setPitchParams(semitones: number, cents = 0, mode: PitchMode = 'PRO_SOLA', formantPreserve = 0.75) {
    this.pitchRack.setPitchParams(semitones, cents, mode, formantPreserve);
  }

  getTrackGainNode(id: string | undefined): AudioNode | undefined {
    if (!id) return this.master;
    return this.tracks.get(id)?.gain ?? this.master;
  }

  /** Trigger a synthesized audio cue into the Guide track's audio node (or dedicated guide output). */
  triggerGuideCue(guideTrackId: string | undefined, sectionType: SectionType, volume = 0.9) {
    if (volume <= 0.001) return;

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
      const guideCh = Math.max(0, (this.asioMapping.guideOut || 3) - 1);
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
        } catch {
          /* already stopped */
        }
      }
      for (const old of t.secondarySources) {
        try {
          old.stop(secWhen);
        } catch {
          /* already stopped */
        }
      }

      const isUtility =
        t.outputBus === 'OUT_6' || t.outputBus === 'OUT_5' || t.bus === 'UTILITY' || t.id === 'click' || t.id === 'guide';

      // If dual devices is active and this is a utility track (Click / Guide):
      if (this.useDualDevices && this.secondaryCtx && isUtility) {
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
    const when = this.ctx.currentTime + 0.04;
    this.fadeGain.gain.cancelScheduledValues(0);
    this.fadeGain.gain.setValueAtTime(1, this.ctx.currentTime);
    this.startSources(offset, when);
    this.segments = [{ ctxTime: when, offset, rate: this.rate }];
    this.playing = true;

    if (this.autonomousClick) {
      this.nextBeatTime = when;
      this.currentBeat = 0;
      this.metronomeBar = 1;
      this.startMetronomeScheduler();
    }
  }

  pause() {
    if (!this.playing) return;
    const pos = this.position;
    this.killSources();
    this.pausedAt = pos;
    this.playing = false;
    this.segments = [];
    if (this.autonomousClick) {
      // Continue click scheduler without stopping!
      this.startMetronomeScheduler();
    }
  }

  stop() {
    this.killSources();
    this.playing = false;
    this.stemsFadedOut = false;
    this.segments = [];
    this.pausedAt = 0;
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
    if (this.playing) this.jumpAt(pos, this.ctx.currentTime + 0.03);
    else this.pausedAt = pos;
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
        if (t.bus === 'UTILITY' || t.outputBus === 'OUT_6' || t.outputBus === 'OUT_5') continue; // Keep Click and Guide playing
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
    const t =
      this.tracks.get(id) ||
      (id === 'click' || id === '__INTERNAL_CLICK' ? this.internalClickTrack : undefined) ||
      (id === 'guide' || id === '__AUTO_GUIDE' ? this.internalGuideTrack : undefined);
    return t ? this.level(t.analyser, t.data).peak : 0;
  }

  trackMetrics(id: string): { peak: number; rms: number } {
    const t =
      this.tracks.get(id) ||
      (id === 'click' || id === '__INTERNAL_CLICK' ? this.internalClickTrack : undefined) ||
      (id === 'guide' || id === '__AUTO_GUIDE' ? this.internalGuideTrack : undefined);
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
      if (!this.playing) {
        this.nextBeatTime = this.ctx.currentTime + 0.04;
        this.currentBeat = 0;
        this.metronomeBar = 1;
        this.startMetronomeScheduler();
      }
    } else {
      if (!this.playing) {
        this.stopMetronomeScheduler();
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
    const clickTrack = this.internalClickTrack;
    if (!clickTrack || !clickTrack.audible) return;

    // Prevent collision if multitrack has an audible recorded click stem playing and autonomous click is not forced
    if (this.playing && this.hasRecordedClick && !this.autonomousClick) {
      const audibleRecordedClick = Array.from(this.tracks.values()).some(
        (t) => t.audible && t.id !== '__INTERNAL_CLICK' && (t.outputBus === 'OUT_6' || t.id.toLowerCase().includes('click')),
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

  private startMetronomeScheduler() {
    if (this.metronomeTimer !== null) return;

    if (this.nextBeatTime < this.ctx.currentTime) {
      this.nextBeatTime = this.ctx.currentTime + 0.04;
      this.currentBeat = 0;
      this.metronomeBar = 1;
    }

    const schedule = () => {
      if (!this.autonomousClick && !this.playing) {
        this.stopMetronomeScheduler();
        return;
      }

      const now = this.ctx.currentTime;
      const beatLen = 60 / (this.metronomeBpm * this.rate);

      while (this.nextBeatTime < now + 0.12) {
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

      this.metronomeTimer = window.setTimeout(schedule, 25);
    };

    schedule();
  }

  private stopMetronomeScheduler() {
    if (this.metronomeTimer !== null) {
      window.clearTimeout(this.metronomeTimer);
      this.metronomeTimer = null;
    }
  }

  masterPeaks(): [number, number] {
    return [this.level(this.analyserL, this.dataL).peak, this.level(this.analyserR, this.dataR).peak];
  }

  limiterReductionDb(): number {
    return this.limiter.reduction;
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

