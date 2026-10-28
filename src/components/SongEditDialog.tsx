import { useState } from 'react';
import type { Section, SectionType, Song } from '../types';
import { KEYS, SECTION_COLORS, SECTION_META, SECTION_TYPES, formatTime, sectionColor, uid } from '../music';
import {
  convertPlainCifraToChordPro,
  detectSectionsFromAudio,
  generateChordChartForSong,
} from '../audio/aiAssistant';
import { Modal } from './Modal';
import { IconPlus, IconSparkles, IconTrash } from './Icons';

interface Props {
  song: Song;
  pos: number;
  onSave: (s: Song) => void;
  onClose: () => void;
}

/** Sort sections by start and recompute ends from the next section's start. */
function normalize(sections: Section[], duration: number): Section[] {
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  return sorted.map((s, i) => ({ ...s, start: Math.max(0, s.start), end: sorted[i + 1]?.start ?? duration }));
}

export function SongEditDialog({ song, pos, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Song>(() => ({ ...song, sections: song.sections.map((s) => ({ ...s })) }));
  const [tab, setTab] = useState<'arrangement' | 'chords'>('arrangement');
  const set = (p: Partial<Song>) => setDraft((d) => ({ ...d, ...p }));
  const setSec = (id: string, p: Partial<Section>) =>
    setDraft((d) => ({ ...d, sections: d.sections.map((s) => (s.id === id ? { ...s, ...p } : s)) }));

  const barLen = (60 / draft.bpm) * draft.beatsPerBar;
  const snap = (t: number) => draft.firstBeat + Math.round((t - draft.firstBeat) / barLen) * barLen;

  const addAt = (t: number, type: SectionType = 'VERSO') => {
    setDraft((d) => ({
      ...d,
      sections: normalize(
        [
          ...d.sections,
          {
            id: uid('s'),
            type,
            label: SECTION_META[type].label,
            start: Math.max(0, t),
            end: d.duration,
            color: SECTION_META[type].color,
          },
        ],
        d.duration,
      ),
    }));
  };

  const aiAutoSplit = () => {
    const secs = detectSectionsFromAudio(draft);
    set({ sections: normalize(secs, draft.duration) });
  };

  const randomizeColors = () => {
    setDraft((d) => ({
      ...d,
      sections: d.sections.map((s, i) => ({
        ...s,
        color: SECTION_COLORS[(i * 3 + Math.floor(Math.random() * 5)) % SECTION_COLORS.length],
      })),
    }));
  };

  const sections = normalize(draft.sections, draft.duration);

  return (
    <Modal
      title="Editar Música, Seções Coloridas & Cifra"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            onClick={() => onSave({ ...draft, sections: normalize(draft.sections, draft.duration) })}
          >
            Salvar Alterações
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>
          Nome
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          Artista
          <input value={draft.artist} onChange={(e) => set({ artist: e.target.value })} />
        </label>
        <label>
          BPM
          <input
            type="number"
            step={0.1}
            min={30}
            max={300}
            value={draft.bpm}
            onChange={(e) => set({ bpm: parseFloat(e.target.value) || draft.bpm })}
          />
        </label>
        <label>
          Tom Original
          <select value={draft.key} onChange={(e) => set({ key: e.target.value })}>
            {KEYS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Compasso
          <select
            value={draft.beatsPerBar}
            onChange={(e) => set({ beatsPerBar: parseInt(e.target.value, 10) })}
          >
            {[2, 3, 4, 6].map((b) => (
              <option key={b} value={b}>
                {b}/4
              </option>
            ))}
          </select>
        </label>
        <label>
          Offset 1º Tempo (s)
          <input
            type="number"
            step={0.001}
            min={0}
            value={draft.firstBeat}
            onChange={(e) => set({ firstBeat: parseFloat(e.target.value) || 0 })}
          />
        </label>
      </div>

      <div className="sec-edit-head">
        <div className="seg">
          <button className={tab === 'arrangement' ? 'active' : ''} onClick={() => setTab('arrangement')}>
            Seções & Cores ({sections.length})
          </button>
          <button className={tab === 'chords' ? 'active' : ''} onClick={() => setTab('chords')}>
            Cifra & Letra (ChordPro)
          </button>
        </div>

        {tab === 'arrangement' ? (
          <div>
            <button className="btn small" onClick={() => addAt(snap(pos))}>
              <IconPlus size={14} /> Na agulha ({formatTime(pos)})
            </button>
            <button className="btn small" onClick={randomizeColors}>
              🎨 Mais Cores
            </button>
            <button className="btn small primary" onClick={aiAutoSplit}>
              <IconSparkles size={14} /> Auto-Seções IA
            </button>
          </div>
        ) : (
          <div>
            <button
              className="btn small"
              onClick={() => set({ chordChart: convertPlainCifraToChordPro(draft.chordChart ?? '') })}
            >
              🔄 Converter Cifra Colada
            </button>
            <button
              className="btn small primary"
              onClick={() => set({ chordChart: generateChordChartForSong({ ...draft, sections }, 'modern') })}
            >
              <IconSparkles size={14} /> Gerar Cifra IA
            </button>
          </div>
        )}
      </div>

      {tab === 'arrangement' ? (
        <>
          <div className="palette-bar">
            <span className="muted">Paleta rápida (clique numa cor abaixo na tabela para personalizar cada seção):</span>
            <div className="palette-dots">
              {SECTION_COLORS.map((c) => (
                <span key={c} className="palette-swatch" style={{ background: c }} title={c} />
              ))}
            </div>
          </div>

          <table className="track-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Cor</th>
                <th>Tipo</th>
                <th>Nome</th>
                <th>Início (s)</th>
                <th>Duração</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sections.map((s, i) => {
                const col = sectionColor(s);
                return (
                  <tr key={s.id}>
                    <td>
                      <span className="sec-dot" style={{ background: col }}>
                        {i + 1}
                      </span>
                    </td>
                    <td>
                      <input
                        type="color"
                        value={col}
                        onChange={(e) => setSec(s.id, { color: e.target.value })}
                        title="Escolher cor personalizada para esta seção"
                      />
                    </td>
                    <td>
                      <select
                        value={s.type}
                        onChange={(e) => {
                          const type = e.target.value as SectionType;
                          setSec(s.id, {
                            type,
                            color: SECTION_META[type].color,
                            label: s.label === SECTION_META[s.type]?.label ? SECTION_META[type].label : s.label,
                          });
                        }}
                      >
                        {SECTION_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {SECTION_META[t].label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input value={s.label} onChange={(e) => setSec(s.id, { label: e.target.value })} />
                    </td>
                    <td>
                      <input
                        type="number"
                        step={0.01}
                        min={0}
                        value={Math.round(s.start * 1000) / 1000}
                        onChange={(e) => setSec(s.id, { start: parseFloat(e.target.value) || 0 })}
                      />
                    </td>
                    <td className="muted">
                      {formatTime(s.end - s.start)} · {Math.round((s.end - s.start) / barLen)} comp.
                    </td>
                    <td>
                      <button
                        className="icon-btn"
                        onClick={() => set({ sections: draft.sections.filter((x) => x.id !== s.id) })}
                      >
                        <IconTrash size={16} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sections.length === 0 && (
            <p className="muted">
              Nenhuma seção. Clique em “Auto-Seções IA” acima para identificar e colorir automaticamente!
            </p>
          )}
        </>
      ) : (
        <div className="chord-editor">
          <p className="muted">
            Escreva acordes entre colchetes como <code>[G]</code>, <code>[D/F#]</code> ou <code>[Em7]</code>, ou cole
            uma cifra tradicional e clique em “Converter Cifra Colada”.
          </p>
          <textarea
            rows={12}
            value={draft.chordChart ?? ''}
            onChange={(e) => set({ chordChart: e.target.value })}
            placeholder="[Verso 1]&#10;Mil [G]gerações se [D/F#]prostram em lou[Em7]vor..."
          />
        </div>
      )}
    </Modal>
  );
}
