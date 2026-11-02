import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import type { Section, Song, TransitionMode } from '../types';
import type { User } from '../saas/types';
import { SECTION_META, formatTime, transposeKey } from '../music';
import {
  IconEdit,
  IconLibrary,
  IconMidi,
  IconSettings,
  IconSparkles,
} from './Icons';

interface Props {
  song?: Song;
  playing: boolean;
  pos: number;
  duration: number;
  section?: Section;
  rate: number;
  fading: boolean;
  looping: boolean;
  padKey: string | null;
  transitionMode: TransitionMode;
  masterVolume: number;
  setlistName: string;
  hwStats: {
    sampleRate: number;
    latencyMs: number;
    maxChannels: number;
    multichannel: boolean;
    driverType?: 'WASAPI' | 'ASIO';
    driverName?: string;
    bufferSize?: number;
  };
  midiConnectedCount: number;
  midiInFlash?: boolean;
  midiOutFlash?: boolean;
  editMode?: boolean;
  user?: User | null;
  onToggleEditMode?: () => void;
  onPlay?: () => void;
  onStop?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onFade?: () => void;
  onToggleLoop?: () => void;
  onTogglePadQuick: () => void;
  onOpenPadDrawer?: () => void;
  onToggleFloatingPad?: () => void;
  onResetAll?: () => void;
  onImport?: () => void;
  onOpenCatalog?: () => void;
  onOpenAdmin?: () => void;
  onOpenAuth?: () => void;
  onPitchOffset: (delta: number) => void;
  onOpenPitchPlugin: () => void;
  onRate: (r: number) => void;
  onTransitionMode: (m: TransitionMode) => void;
  onMasterVolume: (v: number) => void;
  onMidi: () => void;
  onSettings: () => void;
  onLibrary: () => void;
  onAi: () => void;
  remoteClientsCount?: number;
  onOpenRemote?: () => void;
  autonomousClick?: boolean;
  autonomousBeat?: number;
  onToggleAutonomousClick?: () => void;
}

export function TopBar(p: Props) {
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [taps, setTaps] = useState<number[]>([]);

  useEffect(() => {
    let mounted = true;
    getVersion()
      .then((v) => {
        if (mounted && v) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const bpm = p.song ? Math.round(p.song.bpm * p.rate * 10) / 10 : 0;
  const barLen = p.song ? (60 / p.song.bpm) * p.song.beatsPerBar : 1;
  const rel = p.song ? Math.max(0, p.pos - p.song.firstBeat) : 0;
  const songBar = Math.floor(rel / barLen) + 1;
  const songBeat = p.song ? Math.floor((rel % barLen) / (60 / p.song.bpm)) + 1 : 1;
  const activeBeat = p.playing ? songBeat : (p.autonomousClick && p.autonomousBeat ? p.autonomousBeat : 1);
  const remaining = Math.max(0, p.duration - p.pos);
  const effectiveKey = p.song ? transposeKey(p.song.key, p.song.pitchOffset ?? 0) : '—';

  const handleTap = () => {
    if (!p.song) return;
    const now = performance.now();
    const recent = [...taps.filter((t) => now - t < 2600), now];
    setTaps(recent);
    if (recent.length >= 2) {
      const intervals = recent.slice(1).map((t, i) => t - recent[i]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const tappedBpm = 60000 / avgMs;
      const ratio = Math.max(0.65, Math.min(1.4, tappedBpm / p.song.bpm));
      p.onRate(ratio);
    }
  };

  return (
    <header className="topbar">
      {/* 1. LEFT: Brand & Live HUD Display */}
      <div className="brand">
        <img
          src="/worship-tools-logo.jpg"
          alt="Worship Tools"
          style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            objectFit: 'contain',
            background: '#090d14',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            flexShrink: 0,
          }}
        />
        <div>
          <div className="brand-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>WORSHIP<span>TOOLS</span></span>
            <span
              style={{
                fontSize: 9.5,
                padding: '1px 5px',
                borderRadius: 4,
                backgroundColor: 'rgba(0, 153, 255, 0.15)',
                border: '1px solid rgba(0, 153, 255, 0.35)',
                color: '#38bdf8',
                fontWeight: 700,
                letterSpacing: '0.02em',
                lineHeight: '13px',
              }}
              title="Versão do Worship Tools"
            >
              v{appVersion}
            </span>
          </div>
          <div className="brand-sub">{p.setlistName}</div>
        </div>
      </div>

      <div className="display">
        <div className="display-time">
          <div className="big">{formatTime(p.pos)}</div>
          <div className="small">-{formatTime(remaining)}</div>
        </div>
        <div className="display-song">
          <div className="title">{p.song?.name ?? '—'}</div>
          <div className="meta">
            {p.section && (
              <span className="sec-chip" style={{ background: SECTION_META[p.section.type].color }}>
                {p.section.label}
              </span>
            )}
            <span className="bar">
              {p.playing
                ? `Comp. ${songBar}.${songBeat}`
                : p.autonomousClick
                ? `Metrônomo: Batida ${activeBeat}`
                : 'Parado'} · {p.song?.beatsPerBar ?? 4}/4
            </span>
          </div>
        </div>
        <div className="display-beat" title="Indicador visual de batida">
          {Array.from({ length: p.song?.beatsPerBar ?? 4 }).map((_, i) => (
            <div
              key={i}
              className={`beat-dot ${
                (p.playing || p.autonomousClick) && activeBeat === i + 1
                  ? i === 0
                    ? 'on accent'
                    : 'on'
                  : ''
              }`}
            />
          ))}
        </div>
      </div>

      {/* 2. CENTER: Studio Pitch Pro, BPM / TAP e Pads */}
      <div className="top-center">
        <div className="info-boxes">
          <div className="info tempo">
            <label>
              TOM{' '}
              {p.song && p.song.pitchOffset
                ? `(${p.song.pitchOffset > 0 ? `+${p.song.pitchOffset}` : p.song.pitchOffset} st)`
                : ''}
              {p.song && p.song.pitchCents ? ` ${p.song.pitchCents > 0 ? `+${p.song.pitchCents}` : p.song.pitchCents}ct` : ''}
            </label>
            <div className="stepper">
              <button onClick={() => p.onPitchOffset(-1)} title="Baixar 1 semitom (Tempo Real)">
                −
              </button>
              <span
                onClick={p.onOpenPitchPlugin}
                onDoubleClick={() => p.song && p.onPitchOffset(-p.song.pitchOffset)}
                title="Clique para abrir o Plugin Studio Pitch Pro · Duplo clique para tom original"
                className="key-badge"
                style={{ cursor: 'pointer' }}
              >
                {effectiveKey}
              </span>
              <button onClick={() => p.onPitchOffset(1)} title="Subir 1 semitom (Tempo Real)">
                +
              </button>
              <button
                className={`tap-pill ${p.song && ((p.song.pitchOffset ?? 0) !== 0 || (p.song.pitchCents ?? 0) !== 0) ? 'pitch-active' : ''}`}
                onClick={p.onOpenPitchPlugin}
                title="Abrir Plugin Profissional Studio Pitch Pro (Semitons, Cents 432/440Hz, Formantes e Bypass de Bateria)"
              >
                PITCH
              </button>
            </div>
          </div>

          <div className="info tempo">
            <label>BPM / TAP</label>
            <div className="stepper">
              <button onClick={() => p.onRate(p.rate - 0.01)} title="-1% velocidade">
                −
              </button>
              <span onDoubleClick={() => p.onRate(1)} title="Duplo clique para 100%">
                {bpm || '—'}
              </span>
              <button onClick={() => p.onRate(p.rate + 0.01)} title="+1% velocidade">
                +
              </button>
              <button className="tap-pill" onClick={handleTap} title="Toque no ritmo para ajustar o BPM (Tap Tempo)">
                TAP
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`pad-pill ${p.padKey ? 'on' : ''}`}
              onClick={p.onTogglePadQuick}
              onContextMenu={(e) => {
                e.preventDefault();
                p.onOpenPadDrawer?.();
              }}
              title="Clique: Disparar/Parar Pad no tom · Botão direito: Abrir Drawer de Pad Player"
            >
              <span className="dot" />
              PAD {p.padKey ?? effectiveKey}
            </button>
            <button
              className="top-action-btn"
              style={{ padding: '0 8px' }}
              onClick={p.onToggleFloatingPad}
              title="Soltar Janela Flutuante de Pads (Sempre Visível)"
            >
              <span>🪟</span>
            </button>
          </div>
        </div>
      </div>

      <div className="top-right">
        {p.user?.role === 'admin' && (
          <button
            className="top-action-btn admin-btn"
            title="Painel do Administrador: Conectar Google Drive/OneDrive Master e Gerenciar Músicas"
            onClick={p.onOpenAdmin}
          >
            <span>👑 ADMIN</span>
          </button>
        )}

        <button
          className="top-action-btn primary-action"
          title="Catálogo Oficial de MultiTracks (Nuvem Centralizada SaaS)"
          onClick={p.onOpenCatalog}
        >
          <span>🎵 CATÁLOGO</span>
        </button>

        <button
          className="top-action-btn"
          title="Importar MultiTrack / VS localmente (.ZIP, WAV, MP3) do seu computador"
          onClick={p.onImport}
        >
          <span>➕ IMPORTAR</span>
        </button>

        <button
          className="top-action-btn"
          title="Redefinir Tudo: Restaura Tom (0 st), Velocidade (100%), Faders, Mute/Solo e Edições da Música"
          onClick={p.onResetAll}
        >
          <span>↺ RESET</span>
        </button>

        <button
          className={`top-action-btn edit-btn ${p.editMode ? 'active' : ''}`}
          title="Modo Edit: Ativa edição rápida do Setlist, Mapa da Música e Arranjo"
          onClick={p.onToggleEditMode}
        >
          <IconEdit size={15} />
          <span>EDIT</span>
        </button>

        <button
          className="top-action-btn ai-btn"
          title="Assistente de IA Musical (Identificar Tom, Mudar Tom, Seções e Cifras)"
          onClick={p.onAi}
        >
          <IconSparkles size={15} />
          <span>IA</span>
        </button>

        <button
          className="top-action-btn"
          title={`MIDI In/Out & Automação (${p.midiConnectedCount} dispositivo(s) MIDI ativo(s))`}
          onClick={p.onMidi}
        >
          <IconMidi size={16} />
          <span>MIDI</span>
          <span className="midi-leds" title="Indicadores de Entrada (IN) e Saída (OUT) MIDI">
            <i className={`midi-led in ${p.midiInFlash || p.midiConnectedCount > 0 ? 'on' : ''}`} />
            <i className={`midi-led out ${p.midiOutFlash ? 'on' : ''}`} />
          </span>
        </button>

        <button
          className="top-action-btn"
          title={`Controle Remoto via Wi-Fi (iPad/Celular) ${p.remoteClientsCount ? `(${p.remoteClientsCount} dispositivo(s) conectado(s))` : ''}`}
          onClick={p.onOpenRemote}
          style={{
            borderColor: p.remoteClientsCount && p.remoteClientsCount > 0 ? '#10B981' : undefined,
            color: p.remoteClientsCount && p.remoteClientsCount > 0 ? '#34D399' : undefined,
          }}
        >
          <span>📱 REMOTO</span>
          {p.remoteClientsCount && p.remoteClientsCount > 0 ? (
            <span
              style={{
                fontSize: 9,
                background: '#10B981',
                color: '#000',
                padding: '1px 5px',
                borderRadius: 10,
                fontWeight: 800,
              }}
            >
              {p.remoteClientsCount}
            </span>
          ) : null}
        </button>

        <button className="top-action-btn" title="Biblioteca e Setlists" onClick={p.onLibrary}>
          <IconLibrary size={16} />
          <span>SETLIST</span>
        </button>

        <button className="top-action-btn" title="Configurações de Áudio e Geral" onClick={p.onSettings}>
          <IconSettings size={16} />
          <span>CONFIG</span>
        </button>

        <button
          className="top-action-btn user-profile-btn"
          title={p.user ? `Conectado como ${p.user.name} (${p.user.email})` : 'Entrar / Criar Conta SaaS'}
          onClick={p.onOpenAuth}
          style={{
            borderColor: p.user ? '#3B82F6' : '#2E323B',
            background: p.user ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
          }}
        >
          <span>{p.user ? `👤 ${p.user.name.split(' ')[0]}` : '👤 ENTRAR'}</span>
          {p.user?.role === 'admin' && (
            <span style={{ fontSize: 9, background: '#F59E0B', color: '#000', padding: '1px 4px', borderRadius: 4, fontWeight: 800 }}>
              ADM
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
