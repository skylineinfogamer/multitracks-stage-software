import { useEffect, useRef } from 'react';
import type { BusGroup, ClickSound, ClickSubdivision, OutputBus, Song, Track } from '../types';
import type { AudioEngine } from '../audio/engine';
import { BUS_GROUPS, OUTPUT_BUSES, isTrackPitched, trackIcon } from '../music';

interface Props {
  song?: Song;
  engine: AudioEngine;
  mode: 'tracks' | 'buses';
  smartRouting: boolean;
  guideFlash: boolean;
  autoGuideVolume: number;
  autoGuideMute: boolean;
  masterVolume: number;
  clickSubdivision?: ClickSubdivision;
  clickSound?: ClickSound;
  autonomousClick?: boolean;
  internalClickVolume?: number;
  internalClickMute?: boolean;
  internalClickOutput?: OutputBus;
  autoGuideOutput?: OutputBus;
  onToggleAutonomousClick?: () => void;
  onClickSubdivision?: (sub: ClickSubdivision) => void;
  onClickSound?: (snd: ClickSound) => void;
  onInternalClickVolume?: (v: number) => void;
  onInternalClickMute?: () => void;
  onInternalClickOutput?: (out: OutputBus) => void;
  onAutoGuideVolume: (v: number) => void;
  onAutoGuideMute: () => void;
  onAutoGuideOutput?: (out: OutputBus) => void;
  onTestAutoGuide: () => void;
  onMasterVolume: (v: number) => void;
  onTrack: (id: string, patch: Partial<Track>) => void;
  onBusGroup: (bus: BusGroup, action: 'mute' | 'solo' | 'vol', value?: number) => void;
  onSmartRouting: () => void;
  onResetSolo: () => void;
}

const toDb = (v: number) => (v <= 0.0001 ? '-∞' : (20 * Math.log10(v)).toFixed(1));

/** Map peak (0..1+) to meter height % on a dB scale (-60..+6). */
const meterPct = (peak: number) => {
  if (peak <= 0.00001) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(100, ((db + 60) / 66) * 100));
};

export function Mixer({
  song,
  engine,
  mode,
  smartRouting,
  guideFlash,
  autoGuideVolume,
  autoGuideMute,
  masterVolume,
  clickSubdivision = '1/4',
  clickSound = 'woodblock',
  autonomousClick,
  internalClickVolume = 0.75,
  internalClickMute = false,
  internalClickOutput = 'OUT_6',
  autoGuideOutput = 'OUT_5',
  onToggleAutonomousClick,
  onClickSubdivision,
  onClickSound,
  onInternalClickVolume,
  onInternalClickMute,
  onInternalClickOutput,
  onAutoGuideVolume,
  onAutoGuideMute,
  onAutoGuideOutput,
  onTestAutoGuide,
  onMasterVolume,
  onTrack,
  onBusGroup,
  onSmartRouting,
  onResetSolo,
}: Props) {
  const meters = useRef(new Map<string, HTMLDivElement>());
  const held = useRef(new Map<string, number>());
  const stripsRef = useRef<HTMLDivElement | null>(null);
  const guideRef = useRef(guideFlash);
  guideRef.current = guideFlash;
  const autoGuideVolRef = useRef(autoGuideVolume);
  autoGuideVolRef.current = autoGuideVolume;
  const autoGuideMuteRef = useRef(autoGuideMute);
  autoGuideMuteRef.current = autoGuideMute;
  const songRef = useRef(song);
  songRef.current = song;

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      meters.current.forEach((el, id) => {
        let peak = 0;
        if (id === '__L' || id === '__R') {
          const [l, r] = engine.masterPeaks();
          peak = id === '__L' ? l : r;
        } else if (id === '__AUTO_GUIDE') {
          const hwPeak = engine.trackPeak('__AUTO_GUIDE');
          peak = Math.max(
            hwPeak,
            !autoGuideMuteRef.current && guideRef.current
              ? (0.58 + Math.random() * 0.28) * autoGuideVolRef.current
              : 0,
          );
        } else if (id === '__INTERNAL_CLICK') {
          peak = engine.trackPeak('__INTERNAL_CLICK');
        } else if (id.startsWith('bus:')) {
          const busId = id.slice(4) as BusGroup;
          const tracks = songRef.current?.tracks.filter((t) => (t.bus ?? 'KEYS') === busId) ?? [];
          for (const tr of tracks) {
            const p = engine.trackPeak(tr.id);
            if (p > peak) peak = p;
          }
        } else {
          peak = engine.trackPeak(id);
        }
        const target = meterPct(peak);
        const prev = held.current.get(id) ?? 0;
        const v = target > prev ? target : Math.max(target, prev - 2.2);
        held.current.set(id, v);
        el.style.height = `${100 - v}%`;
        el.classList.toggle('clip', peak >= 0.98);
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  if (!song) return <div className="mixer empty">Carregue uma música para ver o mixer.</div>;
  const anySolo = song.tracks.some((t) => t.solo);

  // ALL tracks uploaded by the user are rendered in the main channel strips!
  // No user tracks (such as original audio click or guide stems) are filtered out!
  const stemTracks = song.tracks;

  const setMeter = (id: string) => (el: HTMLDivElement | null) => {
    if (el) meters.current.set(id, el);
    else meters.current.delete(id);
  };

  return (
    <div className="mixer">
      {/* Pinned Left Utility Channels: Standalone Software Metronome & Software Guide IA */}
      <div className="pinned-left-strips">
        {/* Pinned Left Channel 1: CLICK DO SOFTWARE / METRÔNOMO AUTÔNOMO */}
        <div
          className={`strip utility-strip ${internalClickMute ? 'dimmed' : ''}`}
          style={{ ['--c' as string]: '#F39C12' }}
        >
          <div className="strip-name" title="Metrônomo do Software / Click Autônomo">
            <span className="strip-icon">⏱</span> CLICK
            <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(243, 156, 18, 0.2)', color: '#f59e0b', fontWeight: 800 }}>
              SOFTWARE
            </span>
          </div>
          <button
            className={`smart-route-btn ${autonomousClick ? 'on' : ''}`}
            onClick={onToggleAutonomousClick}
            title="Click Autônomo: Mantém o metrônomo batendo no compasso mesmo se o VS for pausado/parado"
            style={
              autonomousClick
                ? { background: 'rgba(243, 156, 18, 0.25)', borderColor: '#F39C12', color: '#F39C12', fontWeight: 800 }
                : undefined
            }
          >
            {autonomousClick ? '● AUTÔNOMO' : '○ AUTÔNOMO'}
          </button>
          <div className="click-quick-row">
            <select
              className="bus-select"
              value={clickSubdivision}
              onChange={(e) => onClickSubdivision?.(e.target.value as ClickSubdivision)}
              title="Subdivisão do Metrônomo (Semínima 1/4, Colcheia 1/8, Semicolcheia 1/16, Tercina 1/3)"
            >
              <option value="1/4">♩ 1/4</option>
              <option value="1/8">♪ 1/8</option>
              <option value="1/16">♬ 1/16</option>
              <option value="1/3">³ 1/3</option>
            </select>
            <select
              className="bus-select"
              value={clickSound}
              onChange={(e) => onClickSound?.(e.target.value as ClickSound)}
              title="Timbre do Click"
            >
              <option value="woodblock">Woodblock</option>
              <option value="digital">Digital</option>
              <option value="rimshot">Rimshot</option>
              <option value="cowbell">Cowbell</option>
            </select>
          </div>
          <div className="fader-area">
            <input
              className="fader"
              type="range"
              min={0}
              max={1.2}
              step={0.005}
              value={internalClickVolume}
              onChange={(e) => onInternalClickVolume?.(parseFloat(e.target.value))}
              onDoubleClick={() => onInternalClickVolume?.(0.75)}
            />
            <div className="meter">
              <div className="meter-fill" ref={setMeter('__INTERNAL_CLICK')} />
            </div>
          </div>
          <div className="strip-btns">
            <button
              className={`m ${internalClickMute ? 'on' : ''}`}
              title="Mute Click do Software"
              onClick={onInternalClickMute}
            >
              M
            </button>
          </div>
          <select
            className="bus-select"
            value={internalClickOutput}
            onChange={(e) => onInternalClickOutput?.(e.target.value as OutputBus)}
            title="Saída Física do Click do Software (Padrão: Out 6 Fones Click)"
          >
            {OUTPUT_BUSES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.short}
              </option>
            ))}
          </select>
          <div className="strip-db">{toDb(internalClickVolume)} dB</div>
          <div className="strip-color" style={{ background: '#F39C12' }} />
        </div>

        {/* Pinned Left Channel 2: GUIA IA DO SOFTWARE (Voz Guia Dinâmica) */}
        <div
          className={`strip utility-strip guide-auto ${autoGuideMute ? 'dimmed' : ''}`}
          style={{ ['--c' as string]: '#0099FF' }}
          title="Canal da Contagem e Chamada Dinâmica de Seções (Voz Guia IA)"
        >
          <div className="strip-name" style={{ color: '#38bdf8' }}>
            <span className="strip-icon">🎙</span> GUIDE
            <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(0, 153, 255, 0.2)', color: '#38bdf8', fontWeight: 800 }}>
              VOZ IA
            </span>
          </div>
          <button
            className="smart-route-btn"
            onClick={onTestAutoGuide}
            title="Testar chamada de voz da Guia agora"
          >
            🔊 CUE
          </button>
          <div className="fader-area">
            <input
              className="fader"
              type="range"
              min={0}
              max={1.2}
              step={0.005}
              value={autoGuideVolume}
              onChange={(e) => onAutoGuideVolume(parseFloat(e.target.value))}
              onDoubleClick={() => onAutoGuideVolume(0.9)}
            />
            <div className="meter">
              <div className="meter-fill" ref={setMeter('__AUTO_GUIDE')} />
            </div>
          </div>
          <div className="strip-btns">
            <button
              className={`m ${autoGuideMute ? 'on' : ''}`}
              title="Mute Guide IA (Silenciar Voz Guia Dinâmica)"
              onClick={onAutoGuideMute}
            >
              M
            </button>
          </div>
          <select
            className="bus-select"
            value={autoGuideOutput}
            onChange={(e) => onAutoGuideOutput?.(e.target.value as OutputBus)}
            title="Saída Física da Voz Guia IA (Padrão: Out 5 Fones Guia)"
          >
            {OUTPUT_BUSES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.short}
              </option>
            ))}
          </select>
          <div className="strip-db">{toDb(autoGuideVolume)} dB</div>
          <div className="strip-color" style={{ background: '#0099FF' }} />
        </div>
      </div>

      {mode === 'tracks' ? (
        <div
          className="strips"
          ref={stripsRef}
          onWheel={(e) => {
            if ((e.target as HTMLElement).tagName !== 'INPUT' && stripsRef.current) {
              stripsRef.current.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
            }
          }}
        >
          {stemTracks.map((t) => {
            const dimmed = t.mute || (anySolo && !t.solo);
            const outBus = t.output ?? 'OUT_1_2';
            const pitched = isTrackPitched(t);
            const icon = trackIcon(t);
            return (
              <div key={t.id} className={`strip ${dimmed ? 'dimmed' : ''}`} style={{ ['--c' as string]: t.color }}>
                <div className="strip-name" title={t.name}>
                  <span className="strip-icon">{icon}</span> {t.name}
                </div>
                <input
                  className="pan"
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={t.pan}
                  title={`Pan ${t.pan === 0 ? 'C' : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : `R${Math.round(t.pan * 100)}`}`}
                  onChange={(e) => onTrack(t.id, { pan: parseFloat(e.target.value) })}
                  onDoubleClick={() => onTrack(t.id, { pan: 0 })}
                />
                <div className="fader-area">
                  <input
                    className="fader"
                    type="range"
                    min={0}
                    max={1.2}
                    step={0.005}
                    value={t.volume}
                    onChange={(e) => onTrack(t.id, { volume: parseFloat(e.target.value) })}
                    onDoubleClick={() => onTrack(t.id, { volume: 0.85 })}
                  />
                  <div className="meter">
                    <div className="meter-fill" ref={setMeter(t.id)} />
                  </div>
                </div>
                <div className="strip-btns">
                  <button
                    className={`m ${t.mute ? 'on' : ''}`}
                    title="Mute (M - Vermelho quando ativo)"
                    onClick={() => onTrack(t.id, { mute: !t.mute })}
                  >
                    M
                  </button>
                  <button
                    className={`s ${t.solo ? 'on' : ''}`}
                    title="Solo (S - Amarelo quando ativo)"
                    onClick={() => onTrack(t.id, { solo: !t.solo })}
                  >
                    S
                  </button>
                  <button
                    className={`p ${pitched ? 'on' : 'bypass'}`}
                    title={
                      pitched
                        ? '🎵 Pitch Ativo: Acompanha mudança de tom (Clique para travar como Bateria/Percussão)'
                        : '🥁 Bypass de Pitch: Transientes preservados sem alterar tom (Clique para ativar Pitch)'
                    }
                    onClick={() => onTrack(t.id, { pitchShift: !pitched })}
                  >
                    {pitched ? '🎵' : '🥁'}
                  </button>
                </div>
                <select
                  className="bus-select"
                  value={outBus}
                  onChange={(e) => onTrack(t.id, { output: e.target.value as OutputBus })}
                  title="Roteamento de Saída (MultiOuts / SmartRouting)"
                >
                  {OUTPUT_BUSES.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.short}
                    </option>
                  ))}
                </select>
                <div className="strip-db">{toDb(t.volume)} dB</div>
                <div className="strip-color" />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="strips">
          {BUS_GROUPS.filter((bg) => bg.id !== 'UTILITY').map((bg) => {
            const members = song.tracks.filter((t) => (t.bus ?? 'KEYS') === bg.id);
            if (members.length === 0) return null;
            const allMuted = members.every((m) => m.mute);
            const anyBusSolo = members.some((m) => m.solo);
            const avgVol = members.reduce((acc, m) => acc + m.volume, 0) / members.length;
            return (
              <div
                key={bg.id}
                className={`strip bus-strip ${allMuted ? 'dimmed' : ''}`}
                style={{ ['--c' as string]: bg.color }}
              >
                <div className="strip-name" title={bg.label}>
                  {bg.label}
                </div>
                <div className="bus-count">{members.length} faixas</div>
                <div className="fader-area">
                  <input
                    className="fader"
                    type="range"
                    min={0}
                    max={1.2}
                    step={0.01}
                    value={avgVol}
                    onChange={(e) => onBusGroup(bg.id, 'vol', parseFloat(e.target.value))}
                    onDoubleClick={() => onBusGroup(bg.id, 'vol', 0.85)}
                  />
                  <div className="meter">
                    <div className="meter-fill" ref={setMeter(`bus:${bg.id}`)} />
                  </div>
                </div>
                <div className="strip-btns">
                  <button className={`m ${allMuted ? 'on' : ''}`} onClick={() => onBusGroup(bg.id, 'mute')}>
                    M
                  </button>
                  <button className={`s ${anyBusSolo ? 'on' : ''}`} onClick={() => onBusGroup(bg.id, 'solo')}>
                    S
                  </button>
                </div>
                <div className="strip-db">{toDb(avgVol)} dB</div>
                <div className="strip-color" />
              </div>
            );
          })}
        </div>
      )}

      {/* Pinned Fader: Master Output */}
      <div className="strip master">
        <div className="strip-name">MASTER</div>
        <button
          className={`smart-route-btn ${smartRouting ? 'on' : ''}`}
          onClick={onSmartRouting}
          title="SmartRouting™: Separa Click/Guia no canal L (In-Ear) e Backing Tracks no R (P.A.) em saídas estéreo"
        >
          {smartRouting ? 'SMART ROUTE' : 'STEREO MIX'}
        </button>
        <div className="strip-btns">
          <button className="reset" onClick={onResetSolo} title="Limpar todos os Mute / Solo">
            CLR M/S
          </button>
        </div>
        <div className="fader-area">
          <input
            className="fader"
            type="range"
            min={0}
            max={1.2}
            step={0.005}
            value={masterVolume}
            onChange={(e) => onMasterVolume(parseFloat(e.target.value))}
            onDoubleClick={() => onMasterVolume(0.9)}
          />
          <div className="meter stereo">
            <div className="meter-fill" ref={setMeter('__L')} />
          </div>
          <div className="meter stereo">
            <div className="meter-fill" ref={setMeter('__R')} />
          </div>
        </div>
        <div className="strip-db">{toDb(masterVolume)} dB</div>
        <div className="strip-color" style={{ background: '#e9b44c' }} />
      </div>
    </div>
  );
}
