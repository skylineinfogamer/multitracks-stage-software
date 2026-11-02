import {
  IconFade,
  IconLoop,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconStop,
} from './Icons';

interface Props {
  playing: boolean;
  fading: boolean;
  looping: boolean;
  autonomousClick?: boolean;
  onPlay: () => void;
  onStop: () => void;
  onPrev: () => void;
  onNext: () => void;
  onFade: () => void;
  onToggleLoop: () => void;
  onToggleAutonomousClick?: () => void;
}

export function TransportControls({
  playing,
  fading,
  looping,
  autonomousClick,
  onPlay,
  onStop,
  onPrev,
  onNext,
  onFade,
  onToggleLoop,
  onToggleAutonomousClick,
}: Props) {
  return (
    <div className="transport">
      <button className="tbtn" title="Música anterior (←)" onClick={onPrev}>
        <IconPrev />
      </button>
      <button
        className="tbtn"
        title="Stop / Reset: 1 clique pausa · 2 cliques voltam ao início (Esc)"
        onClick={onStop}
      >
        <IconStop />
      </button>
      <button
        className={`tbtn play ${playing ? 'on' : ''}`}
        title="Play / Pause (Espaço)"
        onClick={onPlay}
      >
        {playing ? <IconPause size={24} /> : <IconPlay size={24} />}
      </button>
      <button className="tbtn" title="Próxima música (→)" onClick={onNext}>
        <IconNext />
      </button>
      <button
        className={`tbtn click-btn ${autonomousClick ? 'on' : ''}`}
        title="Click Autônomo (C/K): Mantém o metrônomo batendo no compasso mesmo se o VS for pausado/parado"
        onClick={onToggleAutonomousClick}
        style={
          autonomousClick
            ? {
                background: '#F39C12',
                borderColor: '#F39C12',
                color: '#000',
                fontWeight: 800,
                boxShadow: '0 0 12px rgba(243, 156, 18, 0.55)',
              }
            : undefined
        }
      >
        ⏱️
      </button>
      <button
        className={`tbtn loop-btn ${looping ? 'on' : ''}`}
        title="Loop da seção atual (L)"
        onClick={onToggleLoop}
      >
        <IconLoop size={18} />
      </button>
      <button
        className={`tbtn fade ${fading ? 'on' : ''}`}
        title="Auto-Fade (F): Reduz as tracks musicais gradualmente mantendo Click e Guia tocando"
        onClick={onFade}
      >
        <IconFade size={17} />
        <span>FADE</span>
      </button>
    </div>
  );
}
