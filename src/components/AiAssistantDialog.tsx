import { useEffect, useMemo, useState } from 'react';
import type { Section, Song } from '../types';
import { KEYS, SECTION_COLORS, formatTime, relativeMinor, sectionColor, transposeKey } from '../music';
import {
  type KeyDetectionResult,
  askGeminiWorshipAi,
  convertPlainCifraToChordPro,
  detectKeyFromSongBuffers,
  detectSectionsFromAudio,
  generateChordChartForSong,
  getTranspositionRecommendations,
} from '../audio/aiAssistant';
import { Modal } from './Modal';
import { IconSparkles } from './Icons';

interface Props {
  song: Song;
  buffers?: Map<string, AudioBuffer>;
  geminiApiKey?: string;
  onSaveGeminiKey: (key: string) => void;
  onUpdateSong: (patch: Partial<Song>) => void;
  onChangePitchOffset: (newDeltaFromCurrent: number) => void;
  onClose: () => void;
}

export function AiAssistantDialog({
  song,
  buffers,
  geminiApiKey = '',
  onSaveGeminiKey,
  onUpdateSong,
  onChangePitchOffset,
  onClose,
}: Props) {
  const [tab, setTab] = useState<'key' | 'transpose' | 'sections' | 'chords'>('key');
  const [keyResult, setKeyResult] = useState<KeyDetectionResult | null>(null);
  const [previewSections, setPreviewSections] = useState<Section[]>(() =>
    song.sections.length > 0 ? song.sections : detectSectionsFromAudio(song, buffers),
  );
  const [chordDraft, setChordDraft] = useState(song.chordChart ?? '');
  const [apiKeyInput, setApiKeyInput] = useState(geminiApiKey);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    const res = detectKeyFromSongBuffers(song, buffers ?? new Map());
    setKeyResult(res);
  }, [song, buffers]);

  const effectiveKey = transposeKey(song.key, song.pitchOffset ?? 0);
  const recommendations = useMemo(() => getTranspositionRecommendations(song), [song]);
  const barLen = (60 / Math.max(40, song.bpm)) * song.beatsPerBar;

  const notify = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 3500);
  };

  const applyDetectedKey = (newKey: string) => {
    onUpdateSong({ key: newKey });
    notify(`Tom original atualizado para ${newKey} (${relativeMinor(newKey)})!`);
  };

  const runSectionDetection = () => {
    const detected = detectSectionsFromAudio(song, buffers);
    setPreviewSections(detected);
    notify(`IA identificou ${detected.length} seções pelo mapa de energia das faixas!`);
  };

  const randomizeSectionColors = () => {
    setPreviewSections((prev) =>
      prev.map((s, idx) => ({
        ...s,
        color: SECTION_COLORS[(idx * 3 + Math.floor(Math.random() * 5)) % SECTION_COLORS.length],
      })),
    );
    notify('Paleta de cores vibrantes aplicada às seções!');
  };

  const applySectionsToSong = () => {
    onUpdateSong({ sections: previewSections });
    notify(`${previewSections.length} seções aplicadas na Timeline e no Grid!`);
  };

  const handleGenerateChords = (style: 'modern' | 'intimate' | 'prophetic' | 'celebration') => {
    const chart = generateChordChartForSong({ ...song, sections: previewSections }, style);
    setChordDraft(chart);
    notify('Cifra ChordPro gerada com base nas seções e no tom da música!');
  };

  const handleConvertPlain = () => {
    if (!chordDraft.trim()) return;
    const converted = convertPlainCifraToChordPro(chordDraft);
    setChordDraft(converted);
    notify('Cifra convertida automaticamente para o formato dinâmico ChordPro [Acorde]!');
  };

  const handleSaveChords = () => {
    onUpdateSong({ chordChart: chordDraft });
    notify('Cifra salva na música com transposição automática ativa!');
  };

  const handleAskGemini = async () => {
    if (!apiKeyInput.trim()) {
      notify('Informe sua chave da API Gemini para usar prompts livres.');
      return;
    }
    if (!aiPrompt.trim()) return;
    onSaveGeminiKey(apiKeyInput.trim());
    setAiBusy(true);
    try {
      const answer = await askGeminiWorshipAi(apiKeyInput, aiPrompt, song);
      setChordDraft(answer);
      notify('Resposta gerada pela IA Gemini!');
    } catch (e) {
      notify(`Erro ao consultar Gemini: ${(e as Error).message}`);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <Modal
      title={`✨ Assistente de IA Musical — ${song.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="mono-gold">{statusMsg ?? `Tom Atual: ${effectiveKey} · ${song.bpm} BPM`}</span>
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
        </>
      }
    >
      <div className="ai-tabs">
        <button className={tab === 'key' ? 'active' : ''} onClick={() => setTab('key')}>
          🎯 Identificar Tom (Áudio)
        </button>
        <button className={tab === 'transpose' ? 'active' : ''} onClick={() => setTab('transpose')}>
          🔄 Mudar Tom & Capotraste
        </button>
        <button className={tab === 'sections' ? 'active' : ''} onClick={() => setTab('sections')}>
          📐 Identificar Seções & Cores
        </button>
        <button className={tab === 'chords' ? 'active' : ''} onClick={() => setTab('chords')}>
          🎸 Gerir Cifras (ChordPro IA)
        </button>
      </div>

      {tab === 'key' && keyResult && (
        <div className="ai-pane">
          <div className="ai-hero-card">
            <div>
              <div className="ai-label">TONALIDADE DETECTADA PELO ESPECTRO DAS MULTITRACKS</div>
              <div className="ai-big-key">{keyResult.detectedLabel}</div>
              <div className="muted">
                Confiança da análise harmônica (Krumhansl-Kessler Chromagram):{' '}
                <b style={{ color: '#4ade80' }}>{keyResult.confidence}%</b> · Tom base na música:{' '}
                <b>{song.key}</b>
              </div>
            </div>
            <div className="ai-hero-actions">
              <button className="btn primary" onClick={() => applyDetectedKey(keyResult.key)}>
                <IconSparkles size={15} /> Usar Tom {keyResult.key}
              </button>
            </div>
          </div>

          <div className="ai-section-title">ESPECTRO CROMÁTICO DAS 12 NOTAS (CHROMAGRAM DSP)</div>
          <div className="chroma-bars">
            {KEYS.map((note, idx) => {
              const val = keyResult.chromagram[idx] ?? 0;
              const isRoot = note === keyResult.key;
              return (
                <div key={note} className={`chroma-col ${isRoot ? 'root' : ''}`} onClick={() => applyDetectedKey(note)}>
                  <div className="chroma-track">
                    <div className="chroma-fill" style={{ height: `${Math.round(val * 100)}%` }} />
                  </div>
                  <span className="chroma-note">{note}</span>
                  <small>{Math.round(val * 100)}%</small>
                </div>
              );
            })}
          </div>

          <div className="ai-section-title">CANDIDATOS HARMÔNICOS MAIS PRÓXIMOS</div>
          <div className="ai-candidates">
            {keyResult.candidates.map((c, i) => (
              <div key={i} className="ai-cand-card">
                <div>
                  <strong>{c.label}</strong>
                  <div className="muted">Correlação harmônica: {c.score}%</div>
                </div>
                <button className="btn small" onClick={() => applyDetectedKey(c.key)}>
                  Definir {c.key}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'transpose' && (
        <div className="ai-pane">
          <div className="ai-hero-card">
            <div>
              <div className="ai-label">TRANSPOSIÇÃO EM TEMPO REAL (WSOLA PITCH-SHIFT + CIFRA + PAD)</div>
              <div className="ai-big-key">
                Tom Atual: {effectiveKey}{' '}
                <span className="muted" style={{ fontSize: 14 }}>
                  (Original: {song.key} · Offset: {song.pitchOffset > 0 ? `+${song.pitchOffset}` : song.pitchOffset} st)
                </span>
              </div>
              <div className="muted">
                Ao escolher uma sugestão abaixo, a IA transpõe automaticamente todas as faixas de áudio (preservando o
                BPM), a cifra ChordPro e o Pad contínuo.
              </div>
            </div>
          </div>

          <div className="ai-candidates">
            {recommendations.map((rec) => {
              const active = (song.pitchOffset ?? 0) === rec.semitones;
              return (
                <div key={rec.id} className={`ai-cand-card ${active ? 'active' : ''}`}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong>{rec.title}</strong>
                      <span className="chord-badge">Tom: {rec.targetKey}</span>
                    </div>
                    <div className="muted" style={{ marginTop: 2 }}>
                      {rec.subtitle}
                    </div>
                    <div className="mono-gold" style={{ marginTop: 5, fontSize: 11.5 }}>
                      Acordes (I–V–vi–IV): {rec.previewChords} · 🎸 {rec.capoSuggestion}
                    </div>
                  </div>
                  <button
                    className={`btn small ${active ? 'primary' : ''}`}
                    onClick={() => {
                      const delta = rec.semitones - (song.pitchOffset ?? 0);
                      onChangePitchOffset(delta);
                      notify(`Transpondo faixas e cifras para ${rec.targetKey}...`);
                    }}
                  >
                    {active ? 'Ativo' : `Ir p/ ${rec.targetKey}`}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'sections' && (
        <div className="ai-pane">
          <div className="ai-toolbar-row">
            <div>
              <strong>Mapa de Seções Inteligente ({previewSections.length} seções)</strong>
              <div className="muted">
                A IA analisa a dinâmica dos compassos (Bateria, Baixo e Guia) para criar seções coloridas.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn small" onClick={runSectionDetection}>
                <IconSparkles size={14} /> Reanalisar Áudio
              </button>
              <button className="btn small" onClick={randomizeSectionColors}>
                🎨 Novas Cores
              </button>
              <button className="btn small primary" onClick={applySectionsToSong}>
                Aplicar Seções na Música
              </button>
            </div>
          </div>

          <div className="ai-sections-preview">
            {previewSections.map((s, idx) => {
              const col = sectionColor(s);
              const bars = Math.max(1, Math.round((s.end - s.start) / barLen));
              return (
                <div key={s.id} className="ai-sec-chip" style={{ borderColor: col, borderLeftWidth: 5 }}>
                  <input
                    type="color"
                    value={col}
                    onChange={(e) =>
                      setPreviewSections((list) =>
                        list.map((item) => (item.id === s.id ? { ...item, color: e.target.value } : item)),
                      )
                    }
                    title="Escolher cor desta marcação"
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 12.5 }}>
                      #{idx + 1} {s.label}
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {formatTime(s.start)} – {formatTime(s.end)} ({bars} comp.)
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'chords' && (
        <div className="ai-pane">
          <div className="ai-toolbar-row">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small" onClick={() => handleGenerateChords('modern')}>
                ✨ Gerar Worship Moderno (I–V–vi–IV)
              </button>
              <button className="btn small" onClick={() => handleGenerateChords('intimate')}>
                🕊️ Gerar Intimista (IV–I–vi–V)
              </button>
              <button className="btn small" onClick={() => handleGenerateChords('prophetic')}>
                🔥 Gerar Profético Menor (vi–IV–I–V)
              </button>
              <button className="btn small" onClick={handleConvertPlain} title="Cole uma cifra do CifraClub abaixo e clique aqui para converter em ChordPro">
                🔄 Converter Cifra Colada → [ChordPro]
              </button>
            </div>
            <button className="btn small primary" onClick={handleSaveChords}>
              Salvar Cifra na Música
            </button>
          </div>

          <div className="chord-editor" style={{ marginTop: 8 }}>
            <textarea
              rows={9}
              value={chordDraft}
              onChange={(e) => setChordDraft(e.target.value)}
              placeholder="Cole aqui qualquer cifra (mesmo com acordes em cima da letra) e clique em 'Converter Cifra Colada', ou clique nos botões acima para gerar com IA..."
            />
          </div>

          <div className="ai-gemini-box">
            <div className="ai-section-title">OPCIONAL: PEDIDO LIVRE COM GOOGLE GEMINI AI</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input
                type="password"
                 style={{ width: 210 }}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="Chave Gemini API (opcional)"
              />
              <input
                style={{ flex: 1 }}
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="Ex.: Crie a cifra completa com letra e acordes de Bondade de Deus em Sol..."
                onKeyDown={(e) => e.key === 'Enter' && handleAskGemini()}
              />
              <button className="btn small primary" disabled={aiBusy} onClick={handleAskGemini}>
                {aiBusy ? 'Gerando…' : 'Pedir à IA'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
