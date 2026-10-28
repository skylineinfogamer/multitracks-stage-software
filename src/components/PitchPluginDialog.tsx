import type { PitchMode, Song, Track } from '../types';
import { inferTrackBus, isTrackPitched, relativeMinor, transposeKey } from '../music';
import { Modal } from './Modal';
import { IconSparkles } from './Icons';

interface Props {
  song: Song;
  onChangeSemitones: (newSemitones: number) => void;
  onUpdateSong: (patch: Partial<Song>) => void;
  onUpdateTrack: (trackId: string, patch: Partial<Track>) => void;
  onClose: () => void;
}

const MODES: { id: PitchMode; name: string; desc: string }[] = [
  {
    id: 'PRO_SOLA',
    name: 'Studio Phase-Locked SOLA (Padrão)',
    desc: 'Autocorrelação em sub-amostra + interpolação cúbica Hermite separada por subgrupo (Baixo, Guitarras, Keys, Vozes).',
  },
  {
    id: 'WARM_FORMANT',
    name: 'Formant & Warmth Pro',
    desc: 'Janela longa ultra-suave com compensação de formante reforçada para Pads, Pianos e Vozes em grandes transposições.',
  },
  {
    id: 'TIGHT_RHYTHM',
    name: 'Transient Lock (Ataque Rápido)',
    desc: 'Janela curta de alta definição para preservar ataques de palheta em Violões e Guitarras rítmicas.',
  },
];

export function PitchPluginDialog({
  song,
  onChangeSemitones,
  onUpdateSong,
  onUpdateTrack,
  onClose,
}: Props) {
  const semis = song.pitchOffset ?? 0;
  const cents = song.pitchCents ?? 0;
  const mode = song.pitchMode ?? 'PRO_SOLA';
  const formant = song.formantPreserve ?? 0.75;
  const effectiveKey = transposeKey(song.key, semis);
  const a4Freq = (440 * Math.pow(2, cents / 1200)).toFixed(1);

  const autoClassifyTracks = () => {
    const nextTracks = song.tracks.map((t) => {
      const bus = inferTrackBus(t);
      const pitched = isTrackPitched({ ...t, pitchShift: undefined, bus });
      return { ...t, bus, pitchShift: pitched };
    });
    onUpdateSong({ tracks: nextTracks });
  };

  return (
    <Modal
      title={`🎛️ Studio Pitch Pro — Processador Harmônico em Tempo Real`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="mono-gold">
            DSP AudioWorklet Ativo · 0ms Espera · Bateria/Click/Guia em Bypass Inteligente
          </span>
          <button
            className="btn"
            onClick={() => {
              onChangeSemitones(0);
              onUpdateSong({ pitchCents: 0 });
            }}
          >
            Resetar Tom Original ({song.key})
          </button>
          <button className="btn primary" onClick={onClose}>
            Concluído
          </button>
        </>
      }
    >
      <div className="pitch-plugin-rack">
        <div className="pitch-plugin-header">
          <div className="pitch-readout-box">
            <span className="pitch-readout-label">TOM ORIGINAL</span>
            <div className="pitch-readout-val muted">{song.key}</div>
            <small>{relativeMinor(song.key)}</small>
          </div>

          <div className="pitch-readout-arrow">➔</div>

          <div className="pitch-readout-box active">
            <span className="pitch-readout-label">TOM DE PALCO ATUAL</span>
            <div className="pitch-readout-val">{effectiveKey}</div>
            <small>{relativeMinor(effectiveKey)}</small>
          </div>

          <div className="pitch-readout-box">
            <span className="pitch-readout-label">TRANSPOSIÇÃO</span>
            <div className="pitch-readout-val" style={{ color: semis === 0 ? '#eef1f7' : '#4ade80' }}>
              {semis > 0 ? `+${semis}` : semis} st
            </div>
            <small>
              {cents > 0 ? `+${cents}` : cents} cents ({a4Freq} Hz)
            </small>
          </div>
        </div>

        {/* Semitone StepButtons */}
        <div className="pitch-semitone-strip">
          {[-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].map((st) => {
            const k = transposeKey(song.key, st);
            const isSel = semis === st;
            return (
              <button
                key={st}
                className={`pitch-st-btn ${isSel ? 'active' : ''} ${st === 0 ? 'origin' : ''}`}
                onClick={() => onChangeSemitones(st)}
              >
                <span className="st-num">{st > 0 ? `+${st}` : st}</span>
                <span className="st-key">{k}</span>
              </button>
            );
          })}
        </div>

        {/* Fine Tune & Formant Knobs/Sliders */}
        <div className="pitch-controls-grid">
          <div className="pitch-ctrl-card">
            <div className="pitch-ctrl-top">
              <strong>AFINAÇÃO FINA (CENTS / 432Hz)</strong>
              <span className="mono-gold">
                {cents > 0 ? `+${cents}` : cents} ct · A4 = {a4Freq} Hz
              </span>
            </div>
            <input
              type="range"
              min={-50}
              max={50}
              step={1}
              value={cents}
              onChange={(e) => onUpdateSong({ pitchCents: parseInt(e.target.value, 10) })}
              onDoubleClick={() => onUpdateSong({ pitchCents: 0 })}
            />
            <div className="pitch-preset-pills">
              <button className="btn small" onClick={() => onUpdateSong({ pitchCents: 0 })}>
                440 Hz (Padrão)
              </button>
              <button className="btn small" onClick={() => onUpdateSong({ pitchCents: -32 })}>
                432 Hz (-32 ct)
              </button>
              <button className="btn small" onClick={() => onUpdateSong({ pitchCents: 15 })}>
                444 Hz (+15 ct)
              </button>
            </div>
          </div>

          <div className="pitch-ctrl-card">
            <div className="pitch-ctrl-top">
              <strong>PRESERVAÇÃO DE FORMANTE & CALOR</strong>
              <span className="mono-gold">{Math.round(formant * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={formant}
              onChange={(e) => onUpdateSong({ formantPreserve: parseFloat(e.target.value) })}
              onDoubleClick={() => onUpdateSong({ formantPreserve: 0.75 })}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Compensa o brilho excessivo ao subir o tom e evita embolar graves ao baixar o tom.
            </div>
          </div>
        </div>

        {/* DSP Mode Selector */}
        <div className="ai-section-title">ALGORITMO DO MOTOR DE PITCH</div>
        <div className="pitch-modes-row">
          {MODES.map((m) => (
            <div
              key={m.id}
              className={`pitch-mode-card ${mode === m.id ? 'active' : ''}`}
              onClick={() => onUpdateSong({ pitchMode: m.id })}
            >
              <strong>{m.name}</strong>
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                {m.desc}
              </div>
            </div>
          ))}
        </div>

        {/* Per-Track Smart Pitch Bypass Matrix */}
        <div className="ai-toolbar-row" style={{ marginTop: 6 }}>
          <div>
            <div className="ai-section-title">PROTEÇÃO DE BATERIA, PERCUSSÃO E GUIA (SMART STEM BYPASS)</div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              Trilhas rítmicas (Bateria, Loops, Percussão, Click e Guia) ficam em <b>BYPASS</b> com compensação de
              fase para manter os transientes 100% puros e sem distorção.
            </div>
          </div>
          <button className="btn small" onClick={autoClassifyTracks}>
            <IconSparkles size={13} /> Auto-Classificar Trilhas
          </button>
        </div>

        <div className="pitch-tracks-grid">
          {song.tracks.map((t) => {
            const pitched = isTrackPitched(t);
            const inferredBus = inferTrackBus(t);
            return (
              <div
                key={t.id}
                className={`pitch-track-pill ${pitched ? 'pitched' : 'bypassed'}`}
                onClick={() => onUpdateTrack(t.id, { pitchShift: !pitched, bus: inferredBus })}
                title="Clique para alternar entre Pitch Shift Ativo e Bypass Puro nesta faixa"
              >
                <span className="pt-dot" style={{ background: t.color }} />
                <span className="pt-name">{t.name}</span>
                <span className="pt-badge">{pitched ? '🎵 PITCH' : '🥁 FIXO'}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
