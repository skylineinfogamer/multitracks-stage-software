import type { GuideMode, JumpMode, SectionType, Song, TransitionMode } from '../types';
import { SECTION_META, sectionColor, transposeChordPro, transposeKey } from '../music';
import { IconChords, IconEdit, IconLoop, IconMic, IconSparkles } from './Icons';

interface Props {
  song: Song;
  currentIndex: number;
  pos: number;
  queued: { index: number } | null;
  loopSectionId: string | null;
  jumpMode: JumpMode;
  guideEnabled: boolean;
  autoGuideVolume: number;
  guideFlash: string | null;
  autoAdvance: boolean;
  transitionMode: TransitionMode;
  showChords: boolean;
  onQueue: (index: number) => void;
  onQueueByType: (type: SectionType) => void;
  onLoop: (id: string) => void;
  onJumpMode: (m: JumpMode) => void;
  onGuide: () => void;
  onAutoGuideVolume: (v: number) => void;
  onGuideMode: (m: GuideMode) => void;
  onAutoAdvance: () => void;
  onTransitionMode: (m: TransitionMode) => void;
  onToggleChords: () => void;
  onEdit: () => void;
  onOpenAi: () => void;
}

const MODES: { id: JumpMode; label: string; hint: string }[] = [
  { id: 'now', label: 'Imediato', hint: 'Pula na hora' },
  { id: 'bar', label: 'Próx. Compasso', hint: 'Quantizado no próximo compasso' },
  { id: 'section', label: 'Fim da Seção', hint: 'Transição suave ao terminar a seção atual' },
];

const SMART_TYPES: { type: SectionType; label: string; key: string }[] = [
  { type: 'INTRO', label: 'Intro', key: 'I' },
  { type: 'VERSO', label: 'Próx. Verso', key: 'V' },
  { type: 'PRE', label: 'Pré-Refrão', key: 'U' },
  { type: 'REFRAO', label: 'Próx. Refrão', key: 'R' },
  { type: 'PONTE', label: 'Próx. Ponte', key: 'P' },
  { type: 'ESPONTANEO', label: 'Espontâneo', key: 'S' },
  { type: 'FINAL', label: 'Ir p/ Final', key: 'E' },
];

export function SectionGrid(p: Props) {
  const effectiveKey = transposeKey(p.song.key, p.song.pitchOffset ?? 0);
  const transposed = transposeChordPro(p.song.chordChart ?? '', p.song.pitchOffset ?? 0);

  return (
    <div className="sections-panel">
      <div className="sections-toolbar">
        <div className="seg">
          <span className="seg-label">QUANTIZAÇÃO</span>
          {MODES.map((m) => (
            <button
              key={m.id}
              title={m.hint}
              className={p.jumpMode === m.id ? 'active' : ''}
              onClick={() => p.onJumpMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="smart-bar">
          <span className="smart-title">
            <IconSparkles size={13} /> SMART JUMP
          </span>
          {SMART_TYPES.map((st) => {
            const exists = p.song.sections.some((s) => s.type === st.type);
            if (!exists) return null;
            return (
              <button
                key={st.type}
                className="smart-pill"
                style={{ ['--c' as string]: SECTION_META[st.type].color }}
                onClick={() => p.onQueueByType(st.type)}
                title={`Enfileirar ${st.label} (Atalho: ${st.key})`}
              >
                {st.label}
              </button>
            );
          })}
        </div>

        <div className="toolbar-right">
          <div className="guide-inline-pill" title="Volume da Guia Automática de Anúncio de Seções">
            <button
              className={`chip ${p.guideEnabled ? 'on' : ''} ${p.guideFlash ? 'flash' : ''}`}
              onClick={p.onGuide}
              style={{ border: 0 }}
            >
              <IconMic size={14} /> GUIA {p.guideFlash ? `“${p.guideFlash}”` : p.guideEnabled ? 'ON' : 'OFF'}
            </button>
            <input
              type="range"
              min={0}
              max={1.2}
              step={0.02}
              value={p.autoGuideVolume}
              onChange={(e) => p.onAutoGuideVolume(parseFloat(e.target.value))}
              title={`Volume da Guia Automática: ${Math.round(p.autoGuideVolume * 100)}%`}
            />
          </div>

          <select
            className="chip-select"
            value={p.song.guideMode ?? 'REANNOUNCE'}
            onChange={(e) => p.onGuideMode(e.target.value as GuideMode)}
            title="Comportamento inteligente da Guia dinâmica ao pular ou repetir seções"
          >
            <option value="REANNOUNCE">Guia: Reanunciar Dinâmico</option>
            <option value="SILENCE_ON_JUMP">Guia: Silenciar no Pulo</option>
            <option value="NORMAL">Guia: Fixa Original</option>
          </select>

          <button
            className={`chip ${p.autoAdvance ? 'on' : ''}`}
            onClick={p.onAutoAdvance}
            title="AutoLink: avança automaticamente para a próxima música do Setlist"
          >
            AUTOLINK {p.autoAdvance ? 'ON' : 'OFF'}
          </button>

          <button
            className={`chip ${p.showChords ? 'on' : ''}`}
            onClick={p.onToggleChords}
            title="Alternar visualização de Cifras & Letras (ChordPro)"
          >
            <IconChords size={14} /> CIFRAS ({effectiveKey})
          </button>

          <button className="chip ai-chip" onClick={p.onOpenAi} title="Abrir Assistente de IA (Tom, Seções, Cifras)">
            <IconSparkles size={14} /> IA Musical
          </button>

          <button className="chip" onClick={p.onEdit}>
            <IconEdit size={14} /> Editar Arranjo
          </button>
        </div>
      </div>

      <div className={`stage-split ${p.showChords ? 'with-chords' : ''}`}>
        <div className="section-grid">
          {p.song.sections.map((s, i) => {
            const meta = SECTION_META[s.type] ?? SECTION_META.VERSO;
            const color = sectionColor(s);
            const active = i === p.currentIndex;
            const isQueued = p.queued?.index === i;
            const looping = p.loopSectionId === s.id;
            const progress = active ? Math.min(1, Math.max(0, (p.pos - s.start) / (s.end - s.start))) : 0;
            const bars = Math.max(1, Math.round((s.end - s.start) / ((60 / p.song.bpm) * p.song.beatsPerBar)));
            return (
              <div
                key={s.id}
                className={`section-btn ${active ? 'active' : ''} ${isQueued ? 'queued' : ''} ${looping ? 'looping' : ''}`}
                style={{ ['--c' as string]: color }}
                onClick={() => p.onQueue(i)}
                title={`${i < 9 ? `Tecla ${i + 1} — ` : ''}${s.label} (${bars} compassos)`}
              >
                <div className="sb-top">
                  <span className="sb-short">
                    #{i + 1} · {meta.short}
                  </span>
                  <button
                    className={`sb-loop ${looping ? 'on' : ''}`}
                    title="Loop infinito desta seção (L)"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onLoop(s.id);
                    }}
                  >
                    <IconLoop size={13} />
                  </button>
                </div>
                <div className="sb-label">{s.label}</div>
                <div className="sb-bars">{bars} compassos</div>
                {active && !isQueued && <div className="sb-live">TOCANDO</div>}
                {isQueued && <div className="sb-badge">NA FILA</div>}
                <div className="sb-progress" style={{ width: `${progress * 100}%` }} />
              </div>
            );
          })}
        </div>

        {p.showChords && (
          <div className="chord-panel">
            <div className="chord-head">
              <div>
                <strong>CHART / CIFRA DINÂMICA</strong>
                <span className="chord-sub">
                  Tom: <b>{effectiveKey}</b> {p.song.pitchOffset ? `(Original: ${p.song.key})` : '(Original)'}
                </span>
              </div>
              <button className="btn small" onClick={p.onOpenAi}>
                <IconSparkles size={13} /> Gerir Cifra com IA
              </button>
            </div>
            <div className="chord-body">
              {transposed ? (
                renderHighlightedChords(transposed)
              ) : (
                <div className="muted">
                  Nenhuma cifra cadastrada para esta música. Clique em “Gerir Cifra com IA” acima para gerar ou
                  converter cifras automaticamente!
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function renderHighlightedChords(text: string) {
  const lines = text.split('\n');
  return lines.map((line, idx) => {
    const trimmed = line.trim();
    if (/^\[(Contagem.*|Intro.*|Verso.*|Pré.*|Refrão.*|Pós.*|Ponte.*|Subida.*|Espontâneo.*|Ministração.*|Interlúdio.*|Solo.*|Vamp.*|Break.*|Final.*|Instrumental.*|Tag.*)\]$/i.test(trimmed)) {
      return (
        <div key={idx} className="chord-sec-title">
          {trimmed.slice(1, -1)}
        </div>
      );
    }
    const parts = line.split(/(\[[A-G][#b]?[^\]]*\])/g);
    return (
      <div key={idx} className="chord-line">
        {parts.map((part, i) =>
          part.startsWith('[') && part.endsWith(']') ? (
            <span key={i} className="chord-token">
              {part.slice(1, -1)}
            </span>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </div>
    );
  });
}
