import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { BUS_GROUPS, KEYS } from '../music';
import type { BusGroup, TrackKind } from '../types';
import { IconSparkles } from './Icons';

export interface MappedTrackItem {
  id: string;
  fileName: string;
  name: string;
  suggestedName: string;
  kind: TrackKind;
  bus: BusGroup;
  color: string;
  included: boolean;
  data: ArrayBuffer;
  duration?: number;
}

interface Props {
  title?: string;
  songTitle: string;
  artist: string;
  bpm: number;
  musicKey: string;
  tracks: MappedTrackItem[];
  isProcessing?: boolean;
  processingMessage?: string;
  statusText?: string;
  onConfirm: (result: {
    songTitle: string;
    artist: string;
    bpm: number;
    musicKey: string;
    tracks: MappedTrackItem[];
  }) => void | Promise<void>;
  onClose?: () => void;
  onCancel?: () => void;
}

export function TrackMappingDialog({
  title = 'Identificar e Nomear Canais de Áudio (MultiTracks)',
  songTitle: initialTitle,
  artist: initialArtist,
  bpm: initialBpm,
  musicKey: initialKey,
  tracks: initialTracks,
  isProcessing = false,
  processingMessage = '',
  statusText = '',
  onConfirm,
  onClose,
  onCancel,
}: Props) {
  const handleClose = onCancel ?? onClose ?? (() => {});
  const activeMessage = statusText || processingMessage || 'Decodificando e salvando canais de áudio no projeto…';
  const [songTitle, setSongTitle] = useState(initialTitle);
  const [artist, setArtist] = useState(initialArtist);
  const [bpm, setBpm] = useState(initialBpm || 120);
  const [key, setKey] = useState(initialKey || 'C');
  const [items, setItems] = useState<MappedTrackItem[]>(initialTracks);
  const [searchFilter, setSearchFilter] = useState('');

  // Atualiza um campo específico de uma track
  const updateTrack = (id: string, patch: Partial<MappedTrackItem>) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const updated = { ...item, ...patch };
        // Se mudou o bus e não alterou a cor explicitamente, sincroniza com a cor do bus
        if (patch.bus && !patch.color) {
          const groupMeta = BUS_GROUPS.find((g) => g.id === patch.bus);
          if (groupMeta) updated.color = groupMeta.color;
        }
        return updated;
      }),
    );
  };

  // Alterna seleção de todas
  const toggleSelectAll = (included: boolean) => {
    setItems((prev) => prev.map((item) => ({ ...item, included })));
  };

  // Restaura nomes automáticos sugeridos
  const resetToSuggestions = () => {
    if (confirm('Deseja restaurar as sugestões automáticas de nomes para todas as faixas?')) {
      setItems((prev) => prev.map((item) => ({ ...item, name: item.suggestedName })));
    }
  };

  const filteredItems = useMemo(() => {
    if (!searchFilter.trim()) return items;
    const q = searchFilter.toLowerCase();
    return items.filter(
      (it) => it.name.toLowerCase().includes(q) || it.fileName.toLowerCase().includes(q) || it.bus.toLowerCase().includes(q),
    );
  }, [items, searchFilter]);

  const includedCount = items.filter((it) => it.included).length;

  const handleConfirm = () => {
    if (includedCount === 0) {
      alert('Selecione pelo menos uma faixa para carregar a música.');
      return;
    }
    // Garante que nenhuma faixa selecionada fique sem nome
    const sanitized = items.map((it) => ({
      ...it,
      name: it.name.trim() || it.suggestedName.trim() || it.fileName.replace(/\.[^.]+$/, ''),
    }));
    onConfirm({
      songTitle: songTitle.trim() || 'Música Sem Título',
      artist: artist.trim(),
      bpm: bpm || 120,
      musicKey: key || 'C',
      tracks: sanitized,
    });
  };

  return (
    <Modal
      title={title}
      onClose={isProcessing ? () => {} : handleClose}
      wide
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#94A3B8' }}>
            <span>
              <strong style={{ color: '#F8FAFC' }}>{includedCount}</strong> de {items.length} canais selecionados
            </span>
            <span>·</span>
            <button
              type="button"
              className="btn small"
              onClick={() => toggleSelectAll(true)}
              style={{ padding: '3px 8px', fontSize: 11 }}
            >
              Marcar Todas
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => toggleSelectAll(false)}
              style={{ padding: '3px 8px', fontSize: 11 }}
            >
              Desmarcar Todas
            </button>
            <button
              type="button"
              className="btn small"
              onClick={resetToSuggestions}
              title="Restaura os nomes detectados originalmente"
              style={{ padding: '3px 8px', fontSize: 11 }}
            >
              Restaurar Sugestões
            </button>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" disabled={isProcessing} onClick={handleClose}>
              Cancelar
            </button>
            <button
              className="btn primary"
              disabled={isProcessing || includedCount === 0}
              onClick={handleConfirm}
              style={{ minWidth: 160 }}
            >
              {isProcessing ? 'Processando Áudios…' : `Confirmar e Carregar (${includedCount})`}
            </button>
          </div>
        </div>
      }
    >
      {/* Indicador de Processamento / Decodificação */}
      {isProcessing && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(13, 14, 17, 0.94)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            gap: 16,
            borderRadius: 12,
            padding: 24,
          }}
        >
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              border: '4px solid #1f242d',
              borderTopColor: '#0099FF',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <div style={{ fontSize: 16, fontWeight: 700, color: '#F8FAFC', textAlign: 'center' }}>
            {activeMessage}
          </div>
          <div style={{ fontSize: 12, color: '#94A3B8', textAlign: 'center' }}>
            Isso pode levar alguns segundos dependendo da quantidade e duração das multitracks.
          </div>
        </div>
      )}

      {/* Cabeçalho de Metadados da Música */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1.5fr 1fr 1fr',
          gap: 12,
          padding: '12px 14px',
          backgroundColor: '#16181E',
          border: '1px solid #2E323B',
          borderRadius: 10,
          marginBottom: 16,
        }}
      >
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'uppercase' }}>
            Nome da Música
          </label>
          <input
            value={songTitle}
            onChange={(e) => setSongTitle(e.target.value)}
            placeholder="Título da Canção"
            style={{
              width: '100%',
              backgroundColor: '#0D0E11',
              border: '1px solid #2E323B',
              borderRadius: 6,
              padding: '6px 10px',
              color: '#FFFFFF',
              fontSize: 13,
              fontWeight: 600,
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'uppercase' }}>
            Artista / Banda
          </label>
          <input
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
            placeholder="Nome do Artista"
            style={{
              width: '100%',
              backgroundColor: '#0D0E11',
              border: '1px solid #2E323B',
              borderRadius: 6,
              padding: '6px 10px',
              color: '#FFFFFF',
              fontSize: 13,
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'uppercase' }}>
            Tom (Key)
          </label>
          <select
            value={key}
            onChange={(e) => setKey(e.target.value)}
            style={{
              width: '100%',
              backgroundColor: '#0D0E11',
              border: '1px solid #2E323B',
              borderRadius: 6,
              padding: '6px 10px',
              color: '#FFFFFF',
              fontSize: 13,
            }}
          >
            {KEYS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#94A3B8', marginBottom: 4, textTransform: 'uppercase' }}>
            BPM
          </label>
          <input
            type="number"
            min={40}
            max={260}
            value={bpm}
            onChange={(e) => setBpm(parseFloat(e.target.value) || 120)}
            style={{
              width: '100%',
              backgroundColor: '#0D0E11',
              border: '1px solid #2E323B',
              borderRadius: 6,
              padding: '6px 10px',
              color: '#FFFFFF',
              fontSize: 13,
            }}
          />
        </div>
      </div>

      {/* Barra de Filtro e Ajuda */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
          gap: 12,
        }}
      >
        <div style={{ fontSize: 12, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconSparkles size={14} color="#38BDF8" />
          <span>
            Verifique e altere o nome das faixas abaixo. As pistas marcadas serão carregadas no mixer com a nomenclatura personalizada.
          </span>
        </div>

        {items.length > 8 && (
          <input
            type="text"
            placeholder="Filtrar faixas…"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            style={{
              backgroundColor: '#16181E',
              border: '1px solid #2E323B',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              color: '#FFFFFF',
              width: 180,
            }}
          />
        )}
      </div>

      {/* Lista / Tabela de Faixas para Nomeação */}
      <div
        style={{
          maxHeight: 380,
          overflowY: 'auto',
          border: '1px solid #2E323B',
          borderRadius: 8,
          backgroundColor: '#0D0E11',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12 }}>
          <thead>
            <tr style={{ backgroundColor: '#16181E', borderBottom: '1px solid #2E323B', color: '#94A3B8' }}>
              <th style={{ width: 40, padding: '10px 12px', textAlign: 'center' }}>Ativa</th>
              <th style={{ width: 36, padding: '10px 4px', textAlign: 'center' }}>Cor</th>
              <th style={{ width: '38%', padding: '10px 12px' }}>Nome da Track (Personalizado)</th>
              <th style={{ width: '22%', padding: '10px 12px' }}>Grupo do Mixer</th>
              <th style={{ width: '16%', padding: '10px 12px' }}>Tipo</th>
              <th style={{ width: '24%', padding: '10px 12px' }}>Arquivo Original</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item, index) => {
              const isEven = index % 2 === 0;
              return (
                <tr
                  key={item.id}
                  style={{
                    backgroundColor: item.included ? (isEven ? '#0D0E11' : '#121419') : 'rgba(239, 68, 68, 0.05)',
                    borderBottom: '1px solid #1F242D',
                    opacity: item.included ? 1 : 0.45,
                    transition: 'all 0.15s ease',
                  }}
                >
                  {/* Checkbox de Inclusão */}
                  <td style={{ textAlign: 'center', padding: '8px 12px' }}>
                    <input
                      type="checkbox"
                      checked={item.included}
                      onChange={(e) => updateTrack(item.id, { included: e.target.checked })}
                      style={{ cursor: 'pointer', transform: 'scale(1.15)', accentColor: '#0099FF' }}
                    />
                  </td>

                  {/* Cor do Canal */}
                  <td style={{ textAlign: 'center', padding: '8px 4px' }}>
                    <input
                      type="color"
                      value={item.color}
                      onChange={(e) => updateTrack(item.id, { color: e.target.value })}
                      title="Alterar cor da track"
                      style={{
                        width: 24,
                        height: 24,
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                        padding: 0,
                        backgroundColor: 'transparent',
                      }}
                    />
                  </td>

                  {/* Nome da Track (100% Editável) */}
                  <td style={{ padding: '8px 12px' }}>
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) => updateTrack(item.id, { name: e.target.value })}
                      placeholder={item.suggestedName || 'Nome da track'}
                      disabled={!item.included}
                      style={{
                        width: '100%',
                        backgroundColor: item.included ? '#16181E' : '#0D0E11',
                        border: '1px solid #2E323B',
                        borderRadius: 6,
                        padding: '6px 10px',
                        color: '#F8FAFC',
                        fontWeight: 600,
                        fontSize: 12.5,
                        outline: 'none',
                      }}
                      onFocus={(e) => (e.target.style.borderColor = '#0099FF')}
                      onBlur={(e) => (e.target.style.borderColor = '#2E323B')}
                    />
                  </td>

                  {/* Grupo / Bus do Mixer */}
                  <td style={{ padding: '8px 12px' }}>
                    <select
                      value={item.bus}
                      onChange={(e) => updateTrack(item.id, { bus: e.target.value as BusGroup })}
                      disabled={!item.included}
                      style={{
                        width: '100%',
                        backgroundColor: item.included ? '#16181E' : '#0D0E11',
                        border: '1px solid #2E323B',
                        borderRadius: 6,
                        padding: '6px 8px',
                        color: '#E2E8F0',
                        fontSize: 11.5,
                        fontWeight: 500,
                      }}
                    >
                      {BUS_GROUPS.map((bg) => (
                        <option key={bg.id} value={bg.id}>
                          {bg.label}
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* Tipo da Faixa */}
                  <td style={{ padding: '8px 12px' }}>
                    <select
                      value={item.kind}
                      onChange={(e) => {
                        const newKind = e.target.value as TrackKind;
                        const patch: Partial<MappedTrackItem> = { kind: newKind };
                        if (newKind === 'click' || newKind === 'guide') {
                          patch.bus = 'UTILITY';
                        }
                        updateTrack(item.id, patch);
                      }}
                      disabled={!item.included}
                      style={{
                        width: '100%',
                        backgroundColor: item.included ? '#16181E' : '#0D0E11',
                        border: '1px solid #2E323B',
                        borderRadius: 6,
                        padding: '6px 8px',
                        color: '#E2E8F0',
                        fontSize: 11.5,
                      }}
                    >
                      <option value="audio">Áudio Normal</option>
                      <option value="click">Click (Metrônomo)</option>
                      <option value="guide">Guia (Voz)</option>
                    </select>
                  </td>

                  {/* Nome do Arquivo Original */}
                  <td style={{ padding: '8px 12px', color: '#94A3B8', fontFamily: 'monospace', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.fileName}>
                    {item.fileName}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
