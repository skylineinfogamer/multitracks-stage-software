import { useState } from 'react';
import type { Setlist, Song } from '../types';
import { formatTime } from '../music';
import { IconPlus, IconTrash, IconUpload, IconX } from './Icons';

interface Props {
  songs: Song[];
  setlists: Setlist[];
  activeSetlistId: string;
  onClose: () => void;
  onImport: () => void;
  onOpenCatalog?: () => void;
  onAddToSetlist: (id: string) => void;
  onDeleteSong: (id: string) => void;
  onSelectSetlist: (id: string) => void;
  onCreateSetlist: (name: string) => void;
  onRenameSetlist: (id: string, name: string) => void;
  onDeleteSetlist: (id: string) => void;
}

export function LibraryDrawer(p: Props) {
  const [tab, setTab] = useState<'songs' | 'setlists'>('songs');
  const [q, setQ] = useState('');
  const active = p.setlists.find((s) => s.id === p.activeSetlistId);
  const filtered = p.songs.filter((s) => `${s.name} ${s.artist}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <aside className="drawer">
        <div className="drawer-head">
          <div className="seg">
            <button className={tab === 'songs' ? 'active' : ''} onClick={() => setTab('songs')}>Biblioteca</button>
            <button className={tab === 'setlists' ? 'active' : ''} onClick={() => setTab('setlists')}>Setlists</button>
          </div>
          <button className="icon-btn" onClick={p.onClose}><IconX /></button>
        </div>

        {tab === 'songs' ? (
          <>
            <div className="drawer-tools">
              <input placeholder="Buscar música ou artista…" value={q} onChange={(e) => setQ(e.target.value)} />
              {p.onOpenCatalog && (
                <button
                  className="btn small"
                  style={{ background: '#0099FF', color: '#fff', fontWeight: 700 }}
                  onClick={() => {
                    p.onClose();
                    p.onOpenCatalog!();
                  }}
                  title="Abrir Catálogo Oficial de MultiTracks SaaS"
                >
                  🎵 Catálogo Cloud
                </button>
              )}
              <button className="btn primary small" onClick={p.onImport}>
                <IconUpload size={14} /> Importar Local / .ZIP
              </button>
            </div>
            <div className="lib-list">
              {filtered.map((s) => {
                const inSet = active?.songIds.includes(s.id);
                return (
                  <div key={s.id} className="lib-item">
                    <div className="lib-main">
                      <div className="name">{s.name}</div>
                      <div className="muted">
                        {s.artist} · {s.key} · {s.bpm} BPM · {formatTime(s.duration)} · {s.tracks.length} faixas
                      </div>
                    </div>
                    <button
                      className={`btn small ${inSet ? '' : 'primary'}`}
                      onClick={() => p.onAddToSetlist(s.id)}
                      title={`Adicionar a "${active?.name}"`}
                    >
                      <IconPlus size={14} /> {inSet ? 'Adicionar de novo' : 'Setlist'}
                    </button>
                    <button className="icon-btn" title="Excluir da biblioteca" onClick={() => p.onDeleteSong(s.id)}>
                      <IconTrash size={16} />
                    </button>
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="muted pad">
                  Nenhuma multitrack na biblioteca. Clique em <b>Importar PC</b> ou <b>☁️ Drive / OneDrive</b> acima.
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="drawer-tools">
              <button className="btn primary small" onClick={() => p.onCreateSetlist(`Novo setlist ${p.setlists.length + 1}`)}>
                <IconPlus size={14} /> Novo setlist
              </button>
            </div>
            <div className="lib-list">
              {p.setlists.map((sl) => (
                <div key={sl.id} className={`lib-item ${sl.id === p.activeSetlistId ? 'active' : ''}`}>
                  <div className="lib-main">
                    <input className="inline-edit" value={sl.name} onChange={(e) => p.onRenameSetlist(sl.id, e.target.value)} />
                    <div className="muted">{sl.songIds.length} músicas</div>
                  </div>
                  <button className="btn small" disabled={sl.id === p.activeSetlistId} onClick={() => p.onSelectSetlist(sl.id)}>
                    {sl.id === p.activeSetlistId ? 'Ativo' : 'Abrir'}
                  </button>
                  <button className="icon-btn" disabled={p.setlists.length <= 1} title="Excluir setlist" onClick={() => p.onDeleteSetlist(sl.id)}>
                    <IconTrash size={16} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
