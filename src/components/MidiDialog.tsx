import { useEffect, useState } from 'react';
import type { AutomationPoint, MidiCuePin, MidiMapping, SectionType, Song } from '../types';
import { SECTION_META, SECTION_TYPES, formatTime, uid } from '../music';
import { Modal } from './Modal';
import { IconTrash } from './Icons';

interface Props {
  song?: Song;
  pos?: number;
  mappings: MidiMapping[];
  onChange: (mappings: MidiMapping[]) => void;
  onUpdateSong?: (patch: Partial<Song>) => void;
  onTrigger: (m: MidiMapping) => void;
  onSendMidiOut?: (cue: MidiCuePin) => void;
  onClose: () => void;
}

const ACTION_OPTIONS: { type: MidiMapping['actionType']; label: string; target: string }[] = [
  { type: 'PLAY_PAUSE', label: 'Play / Pause', target: 'GLOBAL' },
  { type: 'STOP', label: 'Parar Playback', target: 'GLOBAL' },
  { type: 'LOOP_CURRENT', label: 'Loop Seção Atual', target: 'GLOBAL' },
  { type: 'FADE_OUT', label: 'Auto-Fade Musical (5s)', target: 'GLOBAL' },
  ...SECTION_TYPES.map((st) => ({
    type: 'JUMP_NEXT_TYPE' as const,
    label: `Smart Jump: Próximo ${SECTION_META[st].label}`,
    target: st,
  })),
];

export function MidiDialog({
  song,
  pos = 0,
  mappings,
  onChange,
  onUpdateSong,
  onTrigger,
  onSendMidiOut,
  onClose,
}: Props) {
  const [tab, setTab] = useState<'in' | 'out' | 'auto'>('in');
  const [learning, setLearning] = useState<{ type: MidiMapping['actionType']; label: string; target: string } | null>(
    null,
  );
  const [selectedIdx, setSelectedIdx] = useState(4);
  const [midiStatus, setMidiStatus] = useState<string>('Buscando dispositivos WebMIDI…');
  const [autoTrackId, setAutoTrackId] = useState<string>('__MASTER');
  const [autoVol, setAutoVol] = useState<number>(0.85);

  useEffect(() => {
    const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<any> };
    if (!nav.requestMIDIAccess) {
      setMidiStatus('WebMIDI pronto (Use seu controlador USB ou clique em "Simular Sinal MIDI" abaixo)');
      return;
    }
    nav
      .requestMIDIAccess()
      .then((access) => {
        const inputs = Array.from(access.inputs.values()) as any[];
        const outputs = Array.from(access.outputs.values()) as any[];
        setMidiStatus(
          inputs.length || outputs.length
            ? `MIDI In: ${inputs.length} disp. · MIDI Out: ${outputs.length} disp. ativos`
            : 'Nenhum hardware MIDI físico detectado — Modo Virtual / Timecode ativo',
        );
        inputs.forEach((input) => {
          input.onmidimessage = (ev: { data: Uint8Array }) => {
            const [status, data1, data2] = ev.data;
            const cmd = status >> 4;
            const ch = (status & 0xf) + 1;
            if ((cmd === 9 && data2 > 0) || cmd === 11) {
              const msgType = cmd === 11 ? 'CC' : 'NOTE_ON';
              if (learning) {
                addLearned(ch, msgType, data1);
              }
            }
          };
        });
      })
      .catch(() => setMidiStatus('Modo Controlador Virtual / Footswitch Ativo'));
  }, [learning]);

  const addLearned = (channel: number, messageType: 'NOTE_ON' | 'CC', controllerNumber: number) => {
    if (!learning) return;
    const next: MidiMapping = {
      id: uid('midi'),
      actionLabel: learning.label,
      actionType: learning.type,
      targetValue: learning.target,
      channel,
      messageType,
      controllerNumber,
    };
    onChange([...mappings, next]);
    setLearning(null);
  };

  const addCueAtPlayhead = (type: MidiCuePin['type']) => {
    if (!song || !onUpdateSong) return;
    const cues = song.midiCues ?? [];
    const next: MidiCuePin = {
      id: uid('mc'),
      time: Math.round(pos * 10) / 10,
      label: type === 'PROPRESENTER_SLIDE' ? `Slide @ ${formatTime(pos)}` : `Cena DMX @ ${formatTime(pos)}`,
      type,
      channel: 1,
      number: 60 + (cues.length % 24),
      value: 127,
    };
    onUpdateSong({ midiCues: [...cues, next].sort((a, b) => a.time - b.time) });
  };

  const autoGenerateSectionCues = () => {
    if (!song || !onUpdateSong) return;
    const generated: MidiCuePin[] = song.sections.map((sec, i) => ({
      id: uid('mc'),
      time: sec.start,
      label: `ProPresenter: ${sec.label}`,
      type: 'PROPRESENTER_SLIDE',
      channel: 1,
      number: 60 + i,
      value: 127,
    }));
    onUpdateSong({ midiCues: generated });
  };

  const addAutomationPoint = () => {
    if (!song || !onUpdateSong) return;
    const pts = song.automations ?? [];
    const next: AutomationPoint = {
      id: uid('auto'),
      trackId: autoTrackId,
      time: Math.round(pos * 10) / 10,
      volume: autoVol,
    };
    onUpdateSong({ automations: [...pts, next].sort((a, b) => a.time - b.time) });
  };

  return (
    <Modal
      title="MIDI Learn, Automação de Volume & ProPresenter / DMX Cues"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted">{midiStatus}</span>
          <button className="btn primary" onClick={onClose}>
            Concluir
          </button>
        </>
      }
    >
      <div className="ai-tabs" style={{ marginBottom: 12 }}>
        <button className={tab === 'in' ? 'active' : ''} onClick={() => setTab('in')}>
          🦶 MIDI IN (Footswitch / Learn)
        </button>
        <button className={tab === 'out' ? 'active' : ''} onClick={() => setTab('out')}>
          📡 MIDI OUT Pins (ProPresenter / DMX)
        </button>
        <button className={tab === 'auto' ? 'active' : ''} onClick={() => setTab('auto')}>
          📈 Automação de Volume na Timeline
        </button>
      </div>

      {tab === 'in' && (
        <>
          <div className="midi-learn-bar">
            <select value={selectedIdx} onChange={(e) => setSelectedIdx(parseInt(e.target.value, 10))}>
              {ACTION_OPTIONS.map((opt, idx) => (
                <option key={`${opt.type}-${opt.target}`} value={idx}>
                  {opt.label}
                </option>
              ))}
            </select>

            {learning ? (
              <button
                className="btn primary pulse-btn"
                onClick={() => addLearned(1, 'NOTE_ON', 60 + Math.floor(Math.random() * 24))}
              >
                Aguardando Footswitch MIDI… (Clique p/ Simular)
              </button>
            ) : (
              <button className="btn primary" onClick={() => setLearning(ACTION_OPTIONS[selectedIdx])}>
                + Iniciar MIDI Learn
              </button>
            )}
          </div>

          <table className="track-table">
            <thead>
              <tr>
                <th>Comando / Ação</th>
                <th>Alvo</th>
                <th>Atalho Teclado</th>
                <th>Mensagem MIDI</th>
                <th>Testar</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.actionLabel}</strong>
                  </td>
                  <td>
                    <span
                      className="sec-chip"
                      style={{
                        background: SECTION_META[m.targetValue as SectionType]?.color ?? '#2a303c',
                      }}
                    >
                      {m.targetValue}
                    </span>
                  </td>
                  <td>{m.keyShortcut ? <kbd>{m.keyShortcut}</kbd> : '—'}</td>
                  <td className="mono-gold">
                    CH {m.channel} · {m.messageType} #{m.controllerNumber}
                  </td>
                  <td>
                    <button className="btn small" onClick={() => onTrigger(m)}>
                      Disparar
                    </button>
                  </td>
                  <td>
                    <button className="icon-btn" onClick={() => onChange(mappings.filter((x) => x.id !== m.id))}>
                      <IconTrash size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'out' && song && (
        <>
          <div className="midi-learn-bar" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span className="muted">
              Posição atual da Agulha: <strong>{formatTime(pos)}</strong> — Insira pins na timeline para disparar slides
              no ProPresenter ou cenas DMX automaticamente.
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn small primary" onClick={() => addCueAtPlayhead('PROPRESENTER_SLIDE')}>
                + Pin Slide ({formatTime(pos)})
              </button>
              <button className="btn small" onClick={() => addCueAtPlayhead('DMX_LIGHT')}>
                + Pin Cena DMX ({formatTime(pos)})
              </button>
              <button className="btn small" onClick={autoGenerateSectionCues}>
                ✨ Gerar Pins em Todas as Seções
              </button>
            </div>
          </div>

          <table className="track-table">
            <thead>
              <tr>
                <th>Tempo</th>
                <th>Descrição do Pin</th>
                <th>Tipo</th>
                <th>Canal / Nota MIDI</th>
                <th>Testar Envio</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(song.midiCues ?? []).map((cue) => (
                <tr key={cue.id}>
                  <td className="mono-gold">{formatTime(cue.time)}</td>
                  <td>
                    <input
                      value={cue.label}
                      onChange={(e) =>
                        onUpdateSong?.({
                          midiCues: (song.midiCues ?? []).map((c) =>
                            c.id === cue.id ? { ...c, label: e.target.value } : c,
                          ),
                        })
                      }
                    />
                  </td>
                  <td>
                    <span
                      className="sec-chip"
                      style={{
                        background: cue.type === 'PROPRESENTER_SLIDE' ? '#F39C12' : '#2ECC71',
                      }}
                    >
                      {cue.type === 'PROPRESENTER_SLIDE' ? 'PROPRESENTER' : 'DMX LIGHT'}
                    </span>
                  </td>
                  <td className="mono-gold">
                    CH {cue.channel} · NOTE #{cue.number} (Vel {cue.value})
                  </td>
                  <td>
                    <button className="btn small" onClick={() => onSendMidiOut?.(cue)}>
                      Enviar MIDI Out
                    </button>
                  </td>
                  <td>
                    <button
                      className="icon-btn"
                      onClick={() =>
                        onUpdateSong?.({
                          midiCues: (song.midiCues ?? []).filter((c) => c.id !== cue.id),
                        })
                      }
                    >
                      <IconTrash size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'auto' && song && (
        <>
          <div className="midi-learn-bar" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label>Canal:</label>
              <select value={autoTrackId} onChange={(e) => setAutoTrackId(e.target.value)}>
                <option value="__MASTER">MASTER OUTPUT</option>
                {song.tracks
                  .filter((t) => t.kind === 'audio')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <label>Nível ({Math.round(autoVol * 100)}%):</label>
              <input
                type="range"
                min={0}
                max={1.1}
                step={0.05}
                value={autoVol}
                onChange={(e) => setAutoVol(parseFloat(e.target.value))}
              />
            </div>
            <button className="btn small primary" onClick={addAutomationPoint}>
              + Inserir Ponto em {formatTime(pos)}
            </button>
          </div>

          <table className="track-table">
            <thead>
              <tr>
                <th>Tempo</th>
                <th>Canal Automatizado</th>
                <th>Volume Alvo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(song.automations ?? []).map((pt) => {
                const trName =
                  pt.trackId === '__MASTER'
                    ? 'MASTER'
                    : song.tracks.find((t) => t.id === pt.trackId)?.name ?? pt.trackId;
                return (
                  <tr key={pt.id}>
                    <td className="mono-gold">{formatTime(pt.time)}</td>
                    <td>
                      <strong>{trName}</strong>
                    </td>
                    <td>{Math.round(pt.volume * 100)}%</td>
                    <td>
                      <button
                        className="icon-btn"
                        onClick={() =>
                          onUpdateSong?.({
                            automations: (song.automations ?? []).filter((a) => a.id !== pt.id),
                          })
                        }
                      >
                        <IconTrash size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}
