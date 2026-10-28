import { useRef, useState } from 'react';
import type { PadFolderBank, PadSound } from '../types';
import { KEYS } from '../music';
import { parsePadKeyFromFileName } from '../audio/pads';

interface Props {
  activeKey: string | null;
  songKey?: string;
  volume: number;
  sound: PadSound;
  cutoff?: number;
  resonance?: number;
  crossfade?: number;
  // Multiple Pad Folder Banks
  banks?: PadFolderBank[];
  activeBankId?: string;
  onSelectBank?: (bankId: string) => void;
  onCreateBank?: (name: string, files: FileList | File[]) => Promise<void>;
  onRenameBank?: (bankId: string, newName: string) => void;
  onDeleteBank?: (bankId: string) => void;
  onAddFilesToBank?: (bankId: string, files: FileList | File[]) => Promise<void>;

  customFolderName?: string;
  customKeysCount?: number;
  isDrawer?: boolean;
  onClose?: () => void;
  onToggle: (key: string) => void;
  onStop: () => void;
  onVolume: (v: number) => void;
  onSound: (s: PadSound) => void;
  onCutoff?: (hz: number) => void;
  onResonance?: (q: number) => void;
  onCrossfade?: (sec: number) => void;
  onImportFolder?: (files: FileList | null) => void;
  onOpenFloating?: () => void;
}

const SYNTH_SOUNDS: { id: PadSound; label: string }[] = [
  { id: 'warm', label: 'Warm Pad' },
  { id: 'shimmer', label: 'Shimmer' },
  { id: 'cathedral', label: 'Cathedral' },
  { id: 'strings', label: 'Strings' },
];

export function PadPanel({
  activeKey,
  songKey,
  volume,
  sound,
  cutoff = 1800,
  resonance = 0.8,
  crossfade = 3.0,
  banks = [],
  activeBankId = 'default',
  onSelectBank,
  onCreateBank,
  onRenameBank,
  onDeleteBank,
  onAddFilesToBank,
  customFolderName,
  customKeysCount = 0,
  isDrawer = false,
  onClose,
  onToggle,
  onStop,
  onVolume,
  onSound,
  onCutoff,
  onResonance,
  onCrossfade,
  onImportFolder,
  onOpenFloating,
}: Props) {
  // Modal for creating a new named pad folder
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedNewFiles, setSelectedNewFiles] = useState<File[]>([]);
  const [detectedNewKeys, setDetectedNewKeys] = useState<string[]>([]);
  const [isSavingBank, setIsSavingBank] = useState(false);

  // Rename bank prompt state
  const [renamingBankId, setRenamingBankId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Find active bank
  const currentBank = banks.find((b) => b.id === activeBankId) || banks[0];
  const effectiveKeysCount = currentBank ? currentBank.keys.length : customKeysCount;

  // Handler when user selects files for a new folder
  const handleFilesSelectedForNewBank = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setSelectedNewFiles(files);

    const keys: string[] = [];
    for (const f of files) {
      const k = parsePadKeyFromFileName(f.name);
      if (k && !keys.includes(k)) keys.push(k);
    }
    setDetectedNewKeys(keys);

    // Auto-fill folder name from path if not typed
    if (!newFolderName.trim()) {
      const relPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
      if (relPath.includes('/')) {
        setNewFolderName(relPath.split('/')[0]);
      } else {
        setNewFolderName('Pads ' + (banks.length + 1));
      }
    }
  };

  const handleConfirmCreateBank = async () => {
    if (!newFolderName.trim()) {
      alert('Por favor, informe o nome para a nova pasta de pads.');
      return;
    }
    if (selectedNewFiles.length === 0) {
      alert('Por favor, selecione os arquivos de áudio dos pads.');
      return;
    }
    if (detectedNewKeys.length === 0) {
      alert(
        'Nenhuma nota musical identificada nos arquivos selecionados. Nomeie os arquivos com as notas (C.wav, D.mp3, E.wav, etc).'
      );
      return;
    }

    try {
      setIsSavingBank(true);
      if (onCreateBank) {
        await onCreateBank(newFolderName.trim(), selectedNewFiles);
      } else if (onImportFolder) {
        // Fallback
        const dt = new DataTransfer();
        selectedNewFiles.forEach((f) => dt.items.add(f));
        onImportFolder(dt.files);
      }
      setShowNewFolderModal(false);
      setNewFolderName('');
      setSelectedNewFiles([]);
      setDetectedNewKeys([]);
    } catch (err) {
      console.error('Erro ao criar pasta de pads:', err);
      alert('Erro ao salvar nova pasta de pads.');
    } finally {
      setIsSavingBank(false);
    }
  };

  const content = (
    <div className={`pads ${isDrawer ? 'pads-drawer-body' : ''}`}>
      <div className="pad-side">
        {/* Header / Title */}
        <div className="pad-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>AMBIENT PAD {activeKey && <span className="pad-live-pill">TOM {activeKey}</span>}</span>
          {onOpenFloating && (
            <button
              className="btn small"
              style={{ padding: '2px 7px', fontSize: 10.5 }}
              onClick={onOpenFloating}
              title="Soltar Janela Flutuante de Pads (permanece visível sobre qualquer tela)"
            >
              🪟 Flutuante
            </button>
          )}
        </div>

        {/* Sound Selection Grid (Synthesizers + Custom Folders) */}
        <div className="pad-sound-grid">
          {SYNTH_SOUNDS.map((s) => (
            <button
              key={s.id}
              className={`pad-sound-btn ${sound === s.id ? 'active' : ''}`}
              onClick={() => onSound(s.id)}
            >
              {s.label}
            </button>
          ))}
          <button
            className={`pad-sound-btn full-w ${sound === 'custom_folder' ? 'active' : ''}`}
            onClick={() => onSound('custom_folder')}
            title="Usar samples de áudio de pastas personalizadas de Pads"
          >
            📂 Pastas Custom {effectiveKeysCount > 0 ? `(${effectiveKeysCount} tons)` : ''}
          </button>
        </div>

        {/* Named Pad Folders / Banks Manager */}
        <div className={`pad-banks-box ${sound === 'custom_folder' ? 'active' : ''}`}>
          <div className="pad-banks-head">
            <span>PASTAS DE PADS</span>
            <button
              className="btn small primary"
              style={{ padding: '1px 7px', fontSize: 10, height: 21 }}
              onClick={() => setShowNewFolderModal(true)}
              title="Criar e carregar uma nova pasta de Pads com nome customizado"
            >
              + Nova Pasta
            </button>
          </div>

          {banks.length > 0 ? (
            <>
              <select
                className="pad-bank-select"
                value={activeBankId}
                onChange={(e) => {
                  onSelectBank?.(e.target.value);
                  if (sound !== 'custom_folder') onSound('custom_folder');
                }}
                title="Selecione a pasta de pads ativa"
              >
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    📁 {b.name} ({b.keys.length} notas)
                  </option>
                ))}
              </select>

              <div className="pad-bank-actions">
                <button
                  className="btn small"
                  title="Renomear esta pasta de pads"
                  onClick={() => {
                    const b = currentBank;
                    if (!b) return;
                    setRenamingBankId(b.id);
                    setRenameValue(b.name);
                  }}
                >
                  ✏️ Renomear
                </button>
                <label
                  className="btn small"
                  style={{ cursor: 'pointer', textAlign: 'center' }}
                  title="Adicionar mais arquivos de notas nesta pasta"
                >
                  + Sons
                  <input
                    type="file"
                    accept="audio/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      if (e.target.files && currentBank) {
                        onAddFilesToBank?.(currentBank.id, e.target.files);
                      }
                    }}
                  />
                </label>
                <button
                  className="btn small danger"
                  title="Excluir esta pasta de pads"
                  onClick={() => {
                    if (currentBank) onDeleteBank?.(currentBank.id);
                  }}
                >
                  🗑️
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <button
                className="btn small primary"
                style={{ width: '100%', fontSize: 11 }}
                onClick={() => setShowNewFolderModal(true)}
              >
                📂 + Criar 1ª Pasta de Pads
              </button>
              {customFolderName && (
                <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center' }}>
                  Ativa: {customFolderName} ({customKeysCount} notas)
                </div>
              )}
            </div>
          )}
        </div>

        {/* DSP Filters & Crossfade Controls */}
        <div className="pad-dsp-controls">
          <label title="Frequência de Corte do Filtro Low-Pass (Cutoff)">
            <span>LP CUTOFF</span>
            <strong>{Math.round(cutoff)} Hz</strong>
          </label>
          <input
            type="range"
            min={250}
            max={6500}
            step={25}
            value={cutoff}
            onChange={(e) => onCutoff?.(parseFloat(e.target.value))}
          />
          <label title="Ressonância do Filtro (Q)">
            <span>RESONANCE</span>
            <strong>{resonance.toFixed(1)} Q</strong>
          </label>
          <input
            type="range"
            min={0.3}
            max={6.0}
            step={0.1}
            value={resonance}
            onChange={(e) => onResonance?.(parseFloat(e.target.value))}
          />
          <label title="Tempo de fusão suave (Crossfade) ao trocar de tom">
            <span>CROSSFADE</span>
            <strong>{crossfade.toFixed(1)}s</strong>
          </label>
          <input
            type="range"
            min={0.5}
            max={8.0}
            step={0.5}
            value={crossfade}
            onChange={(e) => onCrossfade?.(parseFloat(e.target.value))}
          />
        </div>

        {/* Bottom Play/Stop Actions */}
        <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
          {songKey && (
            <button className="btn small primary" style={{ flex: 1 }} onClick={() => onToggle(songKey)}>
              Tom ({songKey})
            </button>
          )}
          <button className="btn small danger" onClick={onStop} disabled={!activeKey} style={{ flex: songKey ? 1 : 2 }}>
            Fade Stop
          </button>
        </div>
      </div>

      {/* 12-Tone Pad Trigger Grid */}
      <div className="pad-grid">
        {KEYS.map((k) => (
          <button
            key={k}
            className={`pad-key ${activeKey === k ? 'on' : ''} ${songKey === k ? 'song' : ''}`}
            onClick={() => onToggle(k)}
          >
            <span>{k}</span>
            {songKey === k && <small>tom da música</small>}
          </button>
        ))}
      </div>

      {/* Vertical Master Pad Volume Fader */}
      <div className="pad-vol">
        <label>PAD LEVEL</label>
        <input
          className="fader"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
        />
        <span>{Math.round(volume * 100)}%</span>
      </div>

      {/* Modal: Nova Pasta de Pads */}
      {showNewFolderModal && (
        <div className="modal-backdrop" onClick={() => setShowNewFolderModal(false)}>
          <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>📁 Nova Pasta de Pads Ambient</h2>
              <button className="icon-btn" onClick={() => setShowNewFolderModal(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.4 }}>
                Crie um banco nomeado para seus samples de Pads (ex: <em>Warm Worship</em>, <em>Ambient Drone</em>, <em>Cellos Shimmer</em>).
                O software mapeia e afina automaticamente as notas ausentes.
              </p>

              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--gold)', marginBottom: 6 }}>
                  NOME DA PASTA:
                </label>
                <input
                  type="text"
                  placeholder="Ex: Worship Warm 2024"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  style={{
                    width: '100%',
                    height: 36,
                    padding: '0 12px',
                    borderRadius: 8,
                    background: '#0a0d13',
                    border: '1px solid #2e323b',
                    color: '#fff',
                    fontSize: 13,
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#38bdf8', marginBottom: 6 }}>
                  SELECIONAR ÁUDIOS DOS PADS:
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label
                    className="btn primary"
                    style={{ flex: 1, cursor: 'pointer', textAlign: 'center', fontSize: 12 }}
                  >
                    📂 Selecionar Pasta Completa
                    <input
                      type="file"
                      multiple
                      hidden
                      {...({ webkitdirectory: '' } as Record<string, string>)}
                      onChange={(e) => handleFilesSelectedForNewBank(e.target.files)}
                    />
                  </label>
                  <label className="btn" style={{ cursor: 'pointer', textAlign: 'center', fontSize: 12 }}>
                    + Arquivos Avulsos
                    <input
                      type="file"
                      accept="audio/*"
                      multiple
                      hidden
                      onChange={(e) => handleFilesSelectedForNewBank(e.target.files)}
                    />
                  </label>
                </div>
              </div>

              {selectedNewFiles.length > 0 && (
                <div style={{ padding: 10, borderRadius: 8, background: '#0a0e17', border: '1px solid #1e293b' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: '#4ade80', marginBottom: 4 }}>
                    ✓ {selectedNewFiles.length} arquivos selecionados · {detectedNewKeys.length} notas identificadas
                  </div>
                  <div className="pad-notes-badges">
                    {KEYS.map((k) => {
                      const detected = detectedNewKeys.includes(k);
                      return (
                        <span
                          key={k}
                          className="pad-note-badge"
                          style={{
                            background: detected ? 'rgba(74, 222, 128, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                            color: detected ? '#4ade80' : '#64748b',
                            borderColor: detected ? '#4ade80' : '#2e323b',
                          }}
                        >
                          {k} {detected ? '✓' : ''}
                        </span>
                      );
                    })}
                  </div>
                  {detectedNewKeys.length < 12 && detectedNewKeys.length > 0 && (
                    <small style={{ display: 'block', marginTop: 6, fontSize: 10.5, color: 'var(--muted)' }}>
                      As notas não carregadas serão geradas com transposição inteligente a partir do tom mais próximo.
                    </small>
                  )}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setShowNewFolderModal(false)} disabled={isSavingBank}>
                Cancelar
              </button>
              <button
                className="btn primary"
                onClick={handleConfirmCreateBank}
                disabled={isSavingBank || selectedNewFiles.length === 0}
              >
                {isSavingBank ? 'Carregando...' : 'Salvar Pasta de Pads'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Renomear Pasta */}
      {renamingBankId && (
        <div className="modal-backdrop" onClick={() => setRenamingBankId(null)}>
          <div className="modal" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>✏️ Renomear Pasta de Pads</h2>
              <button className="icon-btn" onClick={() => setRenamingBankId(null)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--gold)', marginBottom: 6 }}>
                NOVO NOME DA PASTA:
              </label>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                style={{
                  width: '100%',
                  height: 36,
                  padding: '0 12px',
                  borderRadius: 8,
                  background: '#0a0d13',
                  border: '1px solid #2e323b',
                  color: '#fff',
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setRenamingBankId(null)}>
                Cancelar
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  if (renameValue.trim() && renamingBankId) {
                    onRenameBank?.(renamingBankId, renameValue.trim());
                  }
                  setRenamingBankId(null);
                }}
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (!isDrawer) return content;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="drawer pad-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>🌊 Ambient Pad Player Contínuo</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {content}
      </div>
    </div>
  );
}

/** Always-on-top Draggable Floating Pad Window with full folder selection and pads control */
export function FloatingPadWindow({
  activeKey,
  songKey,
  volume,
  sound,
  cutoff = 1800,
  banks = [],
  activeBankId = 'default',
  onSelectBank,
  customFolderName,
  customKeysCount = 0,
  onToggle,
  onStop,
  onVolume,
  onSound,
  onCutoff,
  onImportFolder,
  onClose,
}: Props) {
  const [pos, setPos] = useState({ x: Math.max(20, window.innerWidth - 360), y: 125 });
  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, label')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const nx = Math.max(8, Math.min(window.innerWidth - 260, dragRef.current.origX + (ev.clientX - dragRef.current.startX)));
      const ny = Math.max(8, Math.min(window.innerHeight - 80, dragRef.current.origY + (ev.clientY - dragRef.current.startY)));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const currentBank = banks.find((b) => b.id === activeBankId) || banks[0];
  const keysCount = currentBank ? currentBank.keys.length : customKeysCount;

  return (
    <div className={`floating-pad-win ${minimized ? 'min' : ''}`} style={{ left: pos.x, top: pos.y }}>
      <div className="floating-pad-head" onMouseDown={startDrag} title="Arraste para mover a Janela Flutuante de Pads">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={`pitch-led ${activeKey ? 'on' : ''}`} />
          <strong>🌊 PAD PLAYER</strong>
          {activeKey && <span className="pad-live-pill">TOM {activeKey}</span>}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="icon-btn" onClick={() => setMinimized((m) => !m)} title="Minimizar / Expandir">
            {minimized ? '▢' : '—'}
          </button>
          <button className="icon-btn" onClick={onClose} title="Fechar janela flutuante">
            ✕
          </button>
        </div>
      </div>

      {!minimized && (
        <div className="floating-pad-body">
          {/* Sound Timbre & Bank selector */}
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <select
              value={sound}
              onChange={(e) => onSound(e.target.value as PadSound)}
              style={{ flex: 1, fontSize: 11, padding: '4px 6px', borderRadius: 6, background: '#12141a', border: '1px solid #2e323b', color: '#fff' }}
            >
              {SYNTH_SOUNDS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value="custom_folder">
                📂 Pastas Custom {keysCount > 0 ? `(${keysCount} tons)` : ''}
              </option>
            </select>

            {sound === 'custom_folder' && banks.length > 0 && (
              <select
                value={activeBankId}
                onChange={(e) => onSelectBank?.(e.target.value)}
                style={{ flex: 1, fontSize: 11, padding: '4px 6px', borderRadius: 6, background: '#12141a', border: '1px solid #0099ff', color: '#38bdf8' }}
                title="Pasta de Pads Selecionada"
              >
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    📁 {b.name}
                  </option>
                ))}
              </select>
            )}

            <label
              className="btn small"
              style={{ cursor: 'pointer', fontSize: 10.5, padding: '4px 7px' }}
              title={`Escolher pasta com seus arquivos de Pad ${customFolderName ? `(${customFolderName})` : ''}`}
            >
              📂
              <input
                type="file"
                multiple
                hidden
                {...({ webkitdirectory: '' } as Record<string, string>)}
                onChange={(e) => onImportFolder?.(e.target.files)}
              />
            </label>
          </div>

          <div className="floating-pad-grid">
            {KEYS.map((k) => (
              <button
                key={k}
                className={`pad-key ${activeKey === k ? 'on' : ''} ${songKey === k ? 'song' : ''}`}
                onClick={() => onToggle(k)}
              >
                <span>{k}</span>
              </button>
            ))}
          </div>

          <div className="pad-dsp-controls">
            <label>
              <span>VOLUME</span>
              <strong>{Math.round(volume * 100)}%</strong>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => onVolume(parseFloat(e.target.value))}
            />
            <label>
              <span>FILTRO LP (CUTOFF)</span>
              <strong>{Math.round(cutoff)} Hz</strong>
            </label>
            <input
              type="range"
              min={250}
              max={6500}
              step={25}
              value={cutoff}
              onChange={(e) => onCutoff?.(parseFloat(e.target.value))}
            />
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            {songKey && (
              <button className="btn small primary" style={{ flex: 1 }} onClick={() => onToggle(songKey)}>
                Tom ({songKey})
              </button>
            )}
            <button className="btn small danger" onClick={onStop} disabled={!activeKey} style={{ flex: songKey ? 1 : 2 }}>
              Fade Stop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
