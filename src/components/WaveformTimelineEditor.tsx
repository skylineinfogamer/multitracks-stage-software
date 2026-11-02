import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { AudioEngine } from '../audio/engine';
import { computePeaks } from '../audio/demo';
import { SECTION_COLORS, SECTION_META, SECTION_TYPES, formatTime, sectionColor, uid } from '../music';
import {
  exportSectionsJsonFile,
  parseSectionsJson,
  syncSectionsToB2,
} from '../services/sectionMetadataService';
import type { Section, SectionType, Song } from '../types';
import { IconLoop, IconPause, IconPlay, IconPlus, IconTrash, IconWaveform, IconX } from './Icons';

interface Props {
  song: Song;
  engine: AudioEngine;
  peaks?: Float32Array;
  buffers?: Map<string, AudioBuffer>;
  b2BaseUrl?: string;
  onSave: (updatedSong: Song) => void;
  onClose: () => void;
}

type DragMode = 'move' | 'resize-start' | 'resize-end' | null;

export function WaveformTimelineEditor({
  song,
  engine,
  peaks: initialPeaks,
  buffers,
  b2BaseUrl = '',
  onSave,
  onClose,
}: Props) {
  // Song state draft
  const [draft, setDraft] = useState<Song>(() => ({
    ...song,
    sections: song.sections.map((s) => ({ ...s })),
  }));

  // Selected track stem for waveform visualization
  const [selectedTrackId, setSelectedTrackId] = useState<string>('__MASTER__');
  const [zoomLevel, setZoomLevel] = useState<number>(45); // pixels per second (15 .. 300)
  const [snapToBar, setSnapToBar] = useState<boolean>(true);
  const [isPlaying, setIsPlaying] = useState<boolean>(engine.playing);
  const [currentTime, setCurrentTime] = useState<number>(engine.position);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    song.sections[0]?.id ?? null,
  );
  const [loopActive, setLoopActive] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSyncingB2, setIsSyncingB2] = useState<boolean>(false);

  // Dragging state
  const [dragState, setDragState] = useState<{
    sectionId: string;
    mode: DragMode;
    startX: number;
    initialStart: number;
    initialEnd: number;
  } | null>(null);

  // Refs for scrolling and canvas
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  // Timing math
  const barLen = (60 / Math.max(20, draft.bpm || 120)) * Math.max(1, draft.beatsPerBar || 4);
  const beatLen = 60 / Math.max(20, draft.bpm || 120);
  const duration = Math.max(1, draft.duration || engine.duration || 180);

  const currentBar = Math.max(1, 1 + Math.floor((currentTime - draft.firstBeat) / barLen));
  const currentBeatInBar = Math.max(
    1,
    1 + Math.floor((Math.max(0, currentTime - draft.firstBeat) % barLen) / beatLen),
  );

  const snap = useCallback(
    (t: number): number => {
      if (!snapToBar) return t;
      const snapped = draft.firstBeat + Math.round((t - draft.firstBeat) / barLen) * barLen;
      return Math.max(0, Math.min(duration, Math.round(snapped * 1000) / 1000));
    },
    [snapToBar, draft.firstBeat, barLen, duration],
  );

  // Compute or select peaks for current stem
  const activePeaks = useMemo(() => {
    try {
      if (selectedTrackId === '__MASTER__') {
        if (initialPeaks && initialPeaks.length > 0) return initialPeaks;
        if (buffers && buffers.size > 0) {
          const bufs = Array.from(buffers.values());
          return computePeaks(bufs, 3000, duration);
        }
      } else if (buffers) {
        const buf = buffers.get(selectedTrackId);
        if (buf) {
          return computePeaks([buf], 3000, duration);
        }
      }
    } catch (e) {
      console.warn('Erro ao calcular peaks para stem:', e);
    }
    // Fallback: dummy synthetic peaks
    const dummy = new Float32Array(3000);
    for (let i = 0; i < 3000; i++) {
      dummy[i] = 0.15 + 0.35 * Math.abs(Math.sin(i / 15));
    }
    return dummy;
  }, [selectedTrackId, initialPeaks, buffers, duration]);

  // Width of the timeline canvas based on zoom
  const totalTimelineWidth = Math.max(800, Math.round(duration * zoomLevel));
  const WAVE_HEIGHT = 160;
  const BAR_RULER_HEIGHT = 28;
  const TIME_RULER_HEIGHT = 20;
  const TOTAL_HEIGHT = BAR_RULER_HEIGHT + WAVE_HEIGHT + TIME_RULER_HEIGHT;

  // 1. Draw static layer: bar ruler, waveform, and sections
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = totalTimelineWidth;
    canvas.height = TOTAL_HEIGHT;

    ctx.clearRect(0, 0, totalTimelineWidth, TOTAL_HEIGHT);

    // Background
    ctx.fillStyle = '#080a10';
    ctx.fillRect(0, 0, totalTimelineWidth, TOTAL_HEIGHT);

    // --- A. BAR RULER (Top 28px) ---
    ctx.fillStyle = '#0e111a';
    ctx.fillRect(0, 0, totalTimelineWidth, BAR_RULER_HEIGHT);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, BAR_RULER_HEIGHT);
    ctx.lineTo(totalTimelineWidth, BAR_RULER_HEIGHT);
    ctx.stroke();

    const totalBars = Math.ceil(duration / barLen) + 2;
    for (let b = 1; b <= totalBars; b++) {
      const barTime = draft.firstBeat + (b - 1) * barLen;
      const x = Math.round(barTime * zoomLevel);
      if (x < 0 || x > totalTimelineWidth) continue;

      // Bar primary line
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, TOTAL_HEIGHT);
      ctx.stroke();

      // Bar number label
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(`C${b}`, x + 5, 17);

      // Beat tick subdivisions
      for (let bt = 1; bt < draft.beatsPerBar; bt++) {
        const beatTime = barTime + bt * beatLen;
        const bx = Math.round(beatTime * zoomLevel);
        if (bx >= 0 && bx <= totalTimelineWidth) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(bx + 0.5, BAR_RULER_HEIGHT - 8);
          ctx.lineTo(bx + 0.5, BAR_RULER_HEIGHT);
          ctx.stroke();
        }
      }
    }

    // --- B. SECTIONS UNDERLAY ---
    const waveTop = BAR_RULER_HEIGHT;
    const waveMid = waveTop + WAVE_HEIGHT / 2;

    draft.sections.forEach((sec) => {
      const x0 = Math.round(sec.start * zoomLevel);
      const x1 = Math.round(sec.end * zoomLevel);
      const width = Math.max(4, x1 - x0);
      const color = sectionColor(sec);
      const isSelected = sec.id === selectedSectionId;

      // Fill section background
      ctx.fillStyle = color;
      ctx.globalAlpha = isSelected ? 0.28 : 0.14;
      ctx.fillRect(x0, waveTop, width, WAVE_HEIGHT);
      ctx.globalAlpha = 1;

      // Top section tag badge in wave area
      ctx.fillStyle = color;
      ctx.fillRect(x0, waveTop, width, 22);

      // Border around section if selected
      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x0 + 1, waveTop + 1, width - 2, WAVE_HEIGHT - 2);
      }

      // Section text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      const labelText = `${SECTION_META[sec.type]?.short || 'S'} · ${sec.label.toUpperCase()}`;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 4, waveTop, Math.max(0, width - 8), 22);
      ctx.clip();
      ctx.fillText(labelText, x0 + 6, waveTop + 15);
      ctx.restore();
    });

    // --- C. WAVEFORM AMPLITUDE ---
    if (activePeaks && activePeaks.length > 0) {
      const numPeaks = activePeaks.length;
      for (let px = 0; px < totalTimelineWidth; px++) {
        const t = px / zoomLevel;
        if (t > duration) break;

        const peakIdx = Math.min(numPeaks - 1, Math.floor((t / duration) * numPeaks));
        const amp = Math.max(0.02, activePeaks[peakIdx] || 0);
        const h = Math.round(amp * (WAVE_HEIGHT / 2) * 0.92);

        // Find which section this pixel belongs to
        const sec = draft.sections.find((s) => t >= s.start && t < s.end);
        ctx.fillStyle = sec ? sectionColor(sec) : '#475569';

        ctx.fillRect(px, waveMid - h, 1, h * 2);
      }
    }

    // --- D. TIME RULER (Bottom 20px) ---
    const timeTop = BAR_RULER_HEIGHT + WAVE_HEIGHT;
    ctx.fillStyle = '#0a0c13';
    ctx.fillRect(0, timeTop, totalTimelineWidth, TIME_RULER_HEIGHT);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, timeTop);
    ctx.lineTo(totalTimelineWidth, timeTop);
    ctx.stroke();

    // Time intervals (e.g. every 5s or 10s based on zoom)
    const timeStep = zoomLevel > 60 ? 5 : 10;
    for (let t = 0; t <= duration; t += timeStep) {
      const tx = Math.round(t * zoomLevel);
      ctx.fillStyle = '#64748b';
      ctx.font = '10px monospace';
      ctx.fillText(formatTime(t), tx + 4, timeTop + 14);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.beginPath();
      ctx.moveTo(tx + 0.5, timeTop);
      ctx.lineTo(tx + 0.5, timeTop + 6);
      ctx.stroke();
    }
  }, [totalTimelineWidth, zoomLevel, draft.sections, draft.bpm, draft.beatsPerBar, draft.firstBeat, selectedSectionId, activePeaks, duration]);

  // 2. Playhead & Follow cursor loop (High 60 FPS animation on dedicated transparent layer)
  useEffect(() => {
    let active = true;

    const tick = () => {
      if (!active) return;
      try {
        const pos = engine.position;
        setCurrentTime(pos);
        setIsPlaying(engine.playing);

        const pCanvas = playheadCanvasRef.current;
        if (pCanvas) {
          const pCtx = pCanvas.getContext('2d');
          if (pCtx) {
            if (pCanvas.width !== totalTimelineWidth || pCanvas.height !== TOTAL_HEIGHT) {
              pCanvas.width = totalTimelineWidth;
              pCanvas.height = TOTAL_HEIGHT;
            }
            pCtx.clearRect(0, 0, totalTimelineWidth, TOTAL_HEIGHT);

            // Red playhead line
            const x = Math.round(pos * zoomLevel);
            pCtx.strokeStyle = '#f43f5e';
            pCtx.lineWidth = 2;
            pCtx.beginPath();
            pCtx.moveTo(x + 0.5, 0);
            pCtx.lineTo(x + 0.5, TOTAL_HEIGHT);
            pCtx.stroke();

            // Playhead head tag (Top marker)
            pCtx.fillStyle = '#f43f5e';
            pCtx.beginPath();
            pCtx.moveTo(x - 6, 0);
            pCtx.lineTo(x + 6, 0);
            pCtx.lineTo(x + 6, 12);
            pCtx.lineTo(x, 18);
            pCtx.lineTo(x - 6, 12);
            pCtx.fill();
          }
        }

        // Handle section looping if enabled
        if (loopActive && selectedSectionId) {
          const sec = draft.sections.find((s) => s.id === selectedSectionId);
          if (sec && pos >= sec.end - 0.03) {
            engine.seek(sec.start);
          }
        }

        // Auto-scroll when playing if playhead exits view
        if (engine.playing && scrollContainerRef.current) {
          const container = scrollContainerRef.current;
          const curX = pos * zoomLevel;
          const scrollLeft = container.scrollLeft;
          const viewW = container.clientWidth;

          if (curX > scrollLeft + viewW - 80 || curX < scrollLeft) {
            container.scrollLeft = curX - 120;
          }
        }
      } catch {
        // Safe UI decoupling: canvas rendering issues never affect the audio engine or transport
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      active = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [totalTimelineWidth, zoomLevel, loopActive, selectedSectionId, draft.sections]);

  // 3. Mouse interactions: dragging, resizing, seeking
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickTime = clickX / zoomLevel;

    // Check if clicked near an edge handle of a section (tolerance: 8px)
    const HANDLE_PX = 8;
    for (const sec of draft.sections) {
      const x0 = sec.start * zoomLevel;
      const x1 = sec.end * zoomLevel;

      if (Math.abs(clickX - x0) <= HANDLE_PX) {
        setSelectedSectionId(sec.id);
        setDragState({
          sectionId: sec.id,
          mode: 'resize-start',
          startX: e.clientX,
          initialStart: sec.start,
          initialEnd: sec.end,
        });
        return;
      }

      if (Math.abs(clickX - x1) <= HANDLE_PX) {
        setSelectedSectionId(sec.id);
        setDragState({
          sectionId: sec.id,
          mode: 'resize-end',
          startX: e.clientX,
          initialStart: sec.start,
          initialEnd: sec.end,
        });
        return;
      }

      if (clickX > x0 + HANDLE_PX && clickX < x1 - HANDLE_PX && e.clientY - rect.top < BAR_RULER_HEIGHT + 26) {
        // Clicked on section header tag: start moving section
        setSelectedSectionId(sec.id);
        setDragState({
          sectionId: sec.id,
          mode: 'move',
          startX: e.clientX,
          initialStart: sec.start,
          initialEnd: sec.end,
        });
        return;
      }
    }

    // Otherwise: seek playhead to clicked time
    const targetTime = Math.max(0, Math.min(duration, clickTime));
    engine.seek(targetTime);
    setCurrentTime(targetTime);

    // Select section at click position if any
    const hitSec = draft.sections.find((s) => targetTime >= s.start && targetTime < s.end);
    if (hitSec) {
      setSelectedSectionId(hitSec.id);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragState) return;

    const deltaX = e.clientX - dragState.startX;
    const deltaTime = deltaX / zoomLevel;

    setDraft((prev) => {
      const updated = prev.sections.map((sec) => {
        if (sec.id !== dragState.sectionId) return sec;

        let newStart = sec.start;
        let newEnd = sec.end;

        if (dragState.mode === 'resize-start') {
          newStart = Math.max(0, Math.min(dragState.initialEnd - 0.5, dragState.initialStart + deltaTime));
          if (snapToBar) newStart = snap(newStart);
        } else if (dragState.mode === 'resize-end') {
          newEnd = Math.max(dragState.initialStart + 0.5, Math.min(duration, dragState.initialEnd + deltaTime));
          if (snapToBar) newEnd = snap(newEnd);
        } else if (dragState.mode === 'move') {
          const secDuration = dragState.initialEnd - dragState.initialStart;
          newStart = Math.max(0, Math.min(duration - secDuration, dragState.initialStart + deltaTime));
          if (snapToBar) newStart = snap(newStart);
          newEnd = newStart + secDuration;
        }

        return { ...sec, start: newStart, end: newEnd };
      });

      return { ...prev, sections: updated };
    });
  };

  const handleMouseUp = () => {
    if (dragState) {
      setDragState(null);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        addMarkerAtCursor();
      } else if (e.code === 'KeyL') {
        e.preventDefault();
        setLoopActive((v) => !v);
      } else if (e.code === 'KeyS') {
        e.preventDefault();
        setSnapToBar((v) => !v);
      } else if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'KeyZ') {
        e.preventDefault();
        setZoomLevel((z) => Math.min(250, z + 15));
      } else if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'KeyX') {
        e.preventDefault();
        setZoomLevel((z) => Math.max(15, z - 15));
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        if (selectedSectionId) {
          e.preventDefault();
          removeSection(selectedSectionId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTime, selectedSectionId, snapToBar, isPlaying]);

  // Actions
  const togglePlayPause = () => {
    if (engine.playing) {
      engine.pause();
      setIsPlaying(false);
    } else {
      void engine.play();
      setIsPlaying(true);
    }
  };

  const addMarkerAtCursor = () => {
    const t = snapToBar ? snap(currentTime) : currentTime;
    const defaultDuration = barLen * 4; // 4 bars default
    const newEnd = Math.min(duration, t + defaultDuration);

    const newSec: Section = {
      id: uid('sec'),
      type: 'VERSO',
      label: `Verso ${draft.sections.filter((s) => s.type === 'VERSO').length + 1}`,
      start: t,
      end: newEnd,
      color: SECTION_META.VERSO.color,
    };

    const nextSections = [...draft.sections, newSec].sort((a, b) => a.start - b.start);
    setDraft((d) => ({ ...d, sections: nextSections }));
    setSelectedSectionId(newSec.id);
    showToast(`Marcador criado no compasso ${Math.max(1, 1 + Math.floor((t - draft.firstBeat) / barLen))}`);
  };

  const removeSection = (id: string) => {
    const next = draft.sections.filter((s) => s.id !== id);
    setDraft((d) => ({ ...d, sections: next }));
    if (selectedSectionId === id) {
      setSelectedSectionId(next[0]?.id ?? null);
    }
    showToast('Marcador removido.');
  };

  const updateSelectedSection = (patch: Partial<Section>) => {
    if (!selectedSectionId) return;
    setDraft((prev) => {
      const updated = prev.sections.map((s) => (s.id === selectedSectionId ? { ...s, ...patch } : s));
      return { ...prev, sections: updated };
    });
  };

  const showToast = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 3500);
  };

  // Export / Import Metadata Handlers
  const handleExportJson = () => {
    try {
      exportSectionsJsonFile(draft);
      showToast('Arquivo .sections.json exportado com sucesso!');
    } catch (e: any) {
      showToast(`Erro ao exportar: ${e.message}`);
    }
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const content = ev.target?.result as string;
        const meta = parseSectionsJson(content);
        setDraft((d) => ({
          ...d,
          bpm: meta.bpm || d.bpm,
          beatsPerBar: meta.beatsPerBar || d.beatsPerBar,
          firstBeat: meta.firstBeat ?? d.firstBeat,
          sections: meta.sections,
        }));
        showToast(`Importadas ${meta.sections.length} seções com sucesso!`);
      } catch (err: any) {
        showToast(`Erro ao importar: ${err.message}`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleSyncB2 = async () => {
    if (!b2BaseUrl) {
      showToast('URL base do Backblaze B2 não configurada no sistema.');
      return;
    }
    setIsSyncingB2(true);
    const res = await syncSectionsToB2(b2BaseUrl, draft);
    setIsSyncingB2(false);
    showToast(res.message);
  };

  const handleSaveAndClose = () => {
    onSave(draft);
    onClose();
  };

  const selectedSec = draft.sections.find((s) => s.id === selectedSectionId);
  const selectedSecBars = selectedSec
    ? Math.max(1, Math.round((selectedSec.end - selectedSec.start) / barLen))
    : 0;

  return (
    <div className="wf-modal-overlay">
      <div className="wf-modal-window">
        {/* TOP BAR */}
        <div className="wf-header">
          <div className="wf-header-info">
            <span className="wf-badge">
              <IconWaveform size={14} /> TIMELINE PRO
            </span>
            <h2 className="wf-song-title">{draft.name}</h2>
            <span className="wf-meta-pill">{draft.artist || 'Artista'}</span>
            <span className="wf-meta-pill">Tom: {draft.key}</span>
            <span className="wf-meta-pill">{draft.bpm} BPM</span>
            <span className="wf-meta-pill">{draft.beatsPerBar}/4</span>
          </div>

          <div className="wf-header-actions">
            <button
              className="wf-btn wf-btn-outline"
              onClick={handleExportJson}
              title="Exportar marcações para arquivo .sections.json"
            >
              ⬇️ Exportar JSON
            </button>
            <label className="wf-btn wf-btn-outline" title="Importar arquivo .sections.json existente">
              ⬆️ Importar JSON
              <input type="file" accept=".json" onChange={handleImportJson} style={{ display: 'none' }} />
            </label>
            {b2BaseUrl && (
              <button
                className={`wf-btn wf-btn-outline ${isSyncingB2 ? 'loading' : ''}`}
                onClick={handleSyncB2}
                disabled={isSyncingB2}
                title="Sincronizar metadados de seções com o bucket Backblaze B2"
              >
                ☁️ {isSyncingB2 ? 'Sincronizando B2...' : 'Sincronizar B2'}
              </button>
            )}
            <button className="wf-btn wf-btn-primary" onClick={handleSaveAndClose}>
              Salvar & Aplicar
            </button>
            <button className="wf-close-btn" onClick={onClose} title="Fechar (Esc)">
              <IconX size={20} />
            </button>
          </div>
        </div>

        {/* STATUS BANNER */}
        {statusMessage && <div className="wf-toast-banner">{statusMessage}</div>}

        {/* TOOLBAR CONTROLS */}
        <div className="wf-toolbar">
          {/* Stem Selector */}
          <div className="wf-tool-group">
            <span className="wf-tool-label">FORMA DE ONDA:</span>
            <select
              className="wf-select"
              value={selectedTrackId}
              onChange={(e) => setSelectedTrackId(e.target.value)}
              title="Selecione o stem individual ou a mixagem geral para visualizar a forma de onda"
            >
              <option value="__MASTER__">✨ Mix Geral (Master)</option>
              {draft.tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.bus || 'Pista'})
                </option>
              ))}
            </select>
          </div>

          {/* Transport buttons */}
          <div className="wf-tool-group">
            <button
              className={`wf-btn wf-transport-btn ${isPlaying ? 'active' : ''}`}
              onClick={togglePlayPause}
              title="Play / Pause (Espaço)"
            >
              {isPlaying ? <IconPause size={16} /> : <IconPlay size={16} />}
              {isPlaying ? 'Pausar' : 'Tocar'}
            </button>

            <button
              className={`wf-btn ${loopActive ? 'wf-btn-active' : ''}`}
              onClick={() => setLoopActive(!loopActive)}
              title="Loopar seção selecionada continuamente (L)"
            >
              <IconLoop size={14} /> Loop Seção {loopActive ? 'ON' : 'OFF'}
            </button>

            <button
              className="wf-btn wf-btn-accent"
              onClick={addMarkerAtCursor}
              title="Criar marcador de seção na posição exata do cursor (Atalho: M)"
            >
              <IconPlus size={14} /> Marcador no Cursor (M)
            </button>
          </div>

          {/* Magnetic snap */}
          <div className="wf-tool-group">
            <label className="wf-checkbox-label" title="Alinha os marcadores magneticamente ao início dos compassos">
              <input
                type="checkbox"
                checked={snapToBar}
                onChange={(e) => setSnapToBar(e.target.checked)}
              />
              🧲 Imã nos Compassos (Snap)
            </label>
          </div>

          {/* Zoom Controls */}
          <div className="wf-tool-group wf-zoom-group">
            <span className="wf-tool-label">ZOOM:</span>
            <button
              className="wf-btn-icon"
              onClick={() => setZoomLevel((z) => Math.max(15, z - 15))}
              title="Reduzir Zoom (X ou -)"
            >
              −
            </button>
            <input
              type="range"
              min={15}
              max={250}
              step={5}
              value={zoomLevel}
              onChange={(e) => setZoomLevel(Number(e.target.value))}
              className="wf-slider"
              title={`Zoom: ${zoomLevel} px/segundo`}
            />
            <button
              className="wf-btn-icon"
              onClick={() => setZoomLevel((z) => Math.min(250, z + 15))}
              title="Aumentar Zoom (Z ou +)"
            >
              +
            </button>
            <button
              className="wf-btn wf-btn-sm"
              onClick={() => setZoomLevel(40)}
              title="Ajustar visualização"
            >
              Fit
            </button>
          </div>

          {/* Playhead Time Badge */}
          <div className="wf-time-badge">
            <span className="wf-time-clock">{formatTime(currentTime)}</span>
            <span className="wf-time-sub">
              Compasso {currentBar} · Tempo {currentBeatInBar}
            </span>
          </div>
        </div>

        {/* TIMELINE & WAVEFORM DISPLAY */}
        <div
          ref={scrollContainerRef}
          className="wf-canvas-wrapper"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <div
            style={{
              position: 'relative',
              width: `${totalTimelineWidth}px`,
              height: `${TOTAL_HEIGHT}px`,
              minWidth: '100%',
              cursor: dragState ? (dragState.mode === 'move' ? 'grabbing' : 'ew-resize') : 'crosshair',
            }}
          >
            {/* Base Waveform & Sections Canvas */}
            <canvas
              ref={canvasRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                display: 'block',
                width: `${totalTimelineWidth}px`,
                height: `${TOTAL_HEIGHT}px`,
              }}
            />

            {/* Top Interactive Playhead Canvas */}
            <canvas
              ref={playheadCanvasRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                display: 'block',
                width: `${totalTimelineWidth}px`,
                height: `${TOTAL_HEIGHT}px`,
                pointerEvents: 'none',
              }}
            />
          </div>
        </div>

        {/* SECTION INSPECTOR PANEL */}
        <div className="wf-inspector">
          {selectedSec ? (
            <div className="wf-inspector-content">
              <div className="wf-inspector-header">
                <span className="wf-inspector-badge" style={{ backgroundColor: sectionColor(selectedSec) }}>
                  {SECTION_META[selectedSec.type]?.short || 'SEC'}
                </span>
                <span className="wf-inspector-title">Configurar Marcador de Seção</span>
              </div>

              <div className="wf-inspector-fields">
                {/* Type */}
                <div className="wf-field">
                  <label>Tipo:</label>
                  <select
                    value={selectedSec.type}
                    onChange={(e) => {
                      const newType = e.target.value as SectionType;
                      updateSelectedSection({
                        type: newType,
                        label: SECTION_META[newType]?.label || selectedSec.label,
                        color: SECTION_META[newType]?.color || selectedSec.color,
                      });
                    }}
                  >
                    {SECTION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {SECTION_META[t].label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Label */}
                <div className="wf-field">
                  <label>Nome / Rótulo:</label>
                  <input
                    type="text"
                    value={selectedSec.label}
                    onChange={(e) => updateSelectedSection({ label: e.target.value })}
                  />
                </div>

                {/* Start */}
                <div className="wf-field">
                  <label>Início:</label>
                  <div className="wf-field-composite">
                    <input
                      type="number"
                      step={0.1}
                      value={Number(selectedSec.start.toFixed(2))}
                      onChange={(e) =>
                        updateSelectedSection({ start: Math.max(0, parseFloat(e.target.value) || 0) })
                      }
                    />
                    <span className="wf-field-hint">
                      C{Math.max(1, 1 + Math.floor((selectedSec.start - draft.firstBeat) / barLen))}
                    </span>
                  </div>
                </div>

                {/* End */}
                <div className="wf-field">
                  <label>Fim:</label>
                  <div className="wf-field-composite">
                    <input
                      type="number"
                      step={0.1}
                      value={Number(selectedSec.end.toFixed(2))}
                      onChange={(e) =>
                        updateSelectedSection({
                          end: Math.max(selectedSec.start + 0.1, parseFloat(e.target.value) || 0),
                        })
                      }
                    />
                    <span className="wf-field-hint">
                      C{Math.max(1, 1 + Math.floor((selectedSec.end - draft.firstBeat) / barLen))}
                    </span>
                  </div>
                </div>

                {/* Duration */}
                <div className="wf-field">
                  <label>Duração:</label>
                  <span className="wf-field-static">
                    {formatTime(selectedSec.end - selectedSec.start)} ({selectedSecBars} compassos)
                  </span>
                </div>

                {/* Color Palette */}
                <div className="wf-field wf-field-colors">
                  <label>Cor do Palco:</label>
                  <div className="wf-color-row">
                    {SECTION_COLORS.slice(0, 10).map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`wf-color-swatch ${selectedSec.color === c ? 'active' : ''}`}
                        style={{ backgroundColor: c }}
                        onClick={() => updateSelectedSection({ color: c })}
                      />
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <div className="wf-field-actions">
                  <button
                    className="wf-btn wf-btn-sm"
                    onClick={() => {
                      engine.seek(selectedSec.start);
                      setCurrentTime(selectedSec.start);
                    }}
                    title="Posicionar cursor e ouvir esta seção"
                  >
                    ▶ Ir p/ Seção
                  </button>
                  <button
                    className="wf-btn wf-btn-danger wf-btn-sm"
                    onClick={() => removeSection(selectedSec.id)}
                    title="Excluir este marcador (Del)"
                  >
                    <IconTrash size={14} /> Excluir
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="wf-inspector-empty">
              Nenhum marcador selecionado. Clique em uma região na timeline ou aperte <strong>M</strong> para criar um marcador na posição atual.
            </div>
          )}
        </div>

        {/* FOOTER / SHORTCUTS REFERENCE */}
        <div className="wf-footer-help">
          <span>
            <strong>Atalhos:</strong> <kbd>Espaço</kbd> Play/Pause · <kbd>M</kbd> Novo Marcador · <kbd>L</kbd> Loop · <kbd>S</kbd> Snap Compasso · <kbd>Del</kbd> Excluir · <kbd>Z</kbd>/<kbd>X</kbd> Zoom · Arraste as bordas dos marcadores para ajustar a duração milimétrica.
          </span>
        </div>
      </div>
    </div>
  );
}
