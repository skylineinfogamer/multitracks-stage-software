import { Fragment, useState } from 'react';
import type { Song, SongTransition } from '../types';
import { formatTime, transposeKey } from '../music';
import { IconPlus, IconX } from './Icons';

interface Props {
  songs: Song[];
  currentId: string | null;
  loading: { id: string; progress: number } | null;
  editMode?: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onTransitionChange?: (songId: string, next: SongTransition) => void;
  onAdd: () => void;
  onOpenPadDrawer?: () => void;
}

const TRANSITION_ORDER: SongTransition[] = ['STOP', 'AUTO_ADVANCE', 'OVERLAP', 'CROSSFADE'];

const TRANSITION_META: Record<SongTransition, { icon: string; label: string; desc: string }> = {
  STOP: {
    icon: '⏹',
    label: 'Stop',
    desc: 'Stop (Quadrado): Para ao terminar a música atual (Clique para alternar transição)',
  },
  AUTO_ADVANCE: {
    icon: '→',
    label: 'Auto',
    desc: 'Auto-Advance (→): Carrega a próxima música automaticamente ao terminar (Clique para alternar)',
  },
  OVERLAP: {
    icon: '»',
    label: 'Play',
    desc: 'Auto-Play / Overlap (»): Inicia a próxima música imediatamente sem pausa (Clique para alternar)',
  },
  CROSSFADE: {
    icon: '✕',
    label: 'X-Fade',
    desc: 'Crossfade (✕): Fusão suave de áudio e Pad entre o final desta música e o início da próxima',
  },
};

export function SetlistStrip({
  songs,
  currentId,
  loading,
  editMode = false,
  onSelect,
  onRemove,
  onReorder,
  onTransitionChange,
  onAdd,
  onOpenPadDrawer,
}: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const drop = (to: number) => {
    if (drag === null || drag === to) return;
    const ids = songs.map((s) => s.id);
    const [m] = ids.splice(drag, 1);
    ids.splice(to, 0, m);
    onReorder(ids);
  };

  const moveSong = (index: number, direction: -1 | 1, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = index + direction;
    if (target < 0 || target >= songs.length) return;
    const ids = songs.map((s) => s.id);
    const [m] = ids.splice(index, 1);
    ids.splice(target, 0, m);
    onReorder(ids);
  };

  const cycleTransition = (song: Song) => {
    const cur = song.transitionAfter ?? 'AUTO_ADVANCE';
    const next = TRANSITION_ORDER[(TRANSITION_ORDER.indexOf(cur) + 1) % TRANSITION_ORDER.length];
    onTransitionChange?.(song.id, next);
  };

  return (
    <nav className={`setlist ${editMode ? 'edit-mode' : ''}`}>
      {songs.map((s, i) => {
        const active = s.id === currentId;
        const isLoading = loading?.id === s.id;
        const effectiveKey = transposeKey(s.key, s.pitchOffset ?? 0);
        const tr = s.transitionAfter ?? 'AUTO_ADVANCE';
        const trMeta = TRANSITION_META[tr];
        return (
          <Fragment key={s.id}>
            <div
              className={`song-card ${active ? 'active' : ''} ${over === i ? 'over' : ''} ${editMode ? 'is-editable' : ''}`}
              draggable={editMode}
              onDragStart={(e) => {
                if (!editMode) return;
                setDrag(i);
                e.dataTransfer.setData('text/plain', String(i));
              }}
              onDragOver={(e) => {
                if (!editMode) return;
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                if (!editMode) return;
                e.preventDefault();
                drop(i);
                setDrag(null);
                setOver(null);
              }}
              onClick={() => {
                if (!editMode) onSelect(s.id);
              }}
            >
              {editMode && (
                <div className="reorder-handle" title="Arrastar para reordenar no Setlist">
                  ⠿
                </div>
              )}
              <div className="num">{i + 1}</div>
              <div className="body">
                <div className="name" title={s.name}>
                  {s.name}
                </div>
                <div className="artist">{s.artist}</div>
                <div className="tags">
                  <span className={`key-pill ${s.pitchOffset ? 'tag-transposed' : ''}`}>
                    {effectiveKey}
                    {s.pitchOffset ? ` (${s.pitchOffset > 0 ? `+${s.pitchOffset}` : s.pitchOffset})` : ''}
                  </span>
                  <span className="bpm-pill">{s.bpm} BPM</span>
                  <span>{formatTime(s.duration)}</span>
                </div>
              </div>

              {editMode && (
                <div className="reorder-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="reorder-btn"
                    disabled={i === 0}
                    title="Mover para esquerda"
                    onClick={(e) => moveSong(i, -1, e)}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    className="reorder-btn"
                    disabled={i === songs.length - 1}
                    title="Mover para direita"
                    onClick={(e) => moveSong(i, 1, e)}
                  >
                    ▶
                  </button>
                </div>
              )}

              <button
                className="rm"
                title="Remover do setlist"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(s.id);
                }}
              >
                <IconX size={14} />
              </button>
              {isLoading && <div className="load-bar" style={{ width: `${Math.round(loading!.progress * 100)}%` }} />}
            </div>

            {i < songs.length - 1 && (
              <button
                className={`setlist-connector tr-${tr.toLowerCase()}`}
                onClick={() => cycleTransition(s)}
                title={trMeta.desc}
              >
                <span className="conn-icon">{trMeta.icon}</span>
                <small>{trMeta.label}</small>
              </button>
            )}
          </Fragment>
        );
      })}
      <button className="song-card add" onClick={onAdd} title="Adicionar música, Click Track ou multitrack ao Setlist">
        <IconPlus />
        <span>+ Add Song</span>
      </button>
      {onOpenPadDrawer && (
        <button className="song-card add pad-quick-card" onClick={onOpenPadDrawer} title="Abrir Pad Player Ambiente">
          <span>🌊 Pad</span>
        </button>
      )}
    </nav>
  );
}
