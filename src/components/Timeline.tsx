import { useEffect, useRef } from 'react';
import type { LoopMode, Song } from '../types';
import { SECTION_META, formatTime, sectionColor } from '../music';

interface Props {
  song: Song;
  peaks?: Float32Array;
  getPos: () => number;
  duration: number;
  queued: { index: number; boundary: number } | null;
  loopSectionId: string | null;
  loopMode?: LoopMode;
  loading: number | null;
  onSeek: (t: number) => void;
  onQueueSection?: (index: number) => void;
  onToggleLoopOnce?: () => void;
  onToggleLoopInfinite?: () => void;
  onOpenWaveform?: () => void;
}

const LABEL_H = 26;
const RULER_H = 16;

export function Timeline({
  song,
  peaks,
  getPos,
  duration,
  queued,
  loopSectionId,
  loopMode = 'infinite',
  loading,
  onSeek,
  onQueueSection,
  onToggleLoopOnce,
  onToggleLoopInfinite,
  onOpenWaveform,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const fgRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef({ queued, loopSectionId, duration });
  propsRef.current = { queued, loopSectionId, duration };

  // static layer: sections + bar grid + waveform + midi cue pins + automation curve + time ruler
  useEffect(() => {
    const wrap = wrapRef.current!;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      for (const c of [bgRef.current!, fgRef.current!]) {
        c.width = w * dpr;
        c.height = h * dpr;
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
      const ctx = bgRef.current!.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const dur = duration || 1;
      const x = (t: number) => (t / dur) * w;
      const waveTop = LABEL_H + 4;
      const waveH = h - waveTop - RULER_H - 4;
      const mid = waveTop + waveH / 2;

      // section blocks (Song Map Pills)
      ctx.font = '700 11px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      song.sections.forEach((s) => {
        const color = sectionColor(s);
        const short = SECTION_META[s.type]?.short ?? 'S';
        const x0 = x(s.start);
        const x1 = x(s.end);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.95;
        roundRect(ctx, x0 + 1, 2, Math.max(2, x1 - x0 - 2), LABEL_H - 4, 6);
        ctx.fill();
        ctx.globalAlpha = 0.14;
        ctx.fillRect(x0 + 1, waveTop, Math.max(1, x1 - x0 - 2), waveH);
        ctx.globalAlpha = 1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 4, 0, Math.max(0, x1 - x0 - 8), LABEL_H);
        ctx.clip();
        ctx.fillStyle = '#fff';
        ctx.fillText(`${short} · ${s.label.toUpperCase()}`, x0 + 7, LABEL_H / 2);
        ctx.restore();
      });

      // bar vertical gridlines
      const barLen = (60 / song.bpm) * song.beatsPerBar;
      if (barLen > 0.3) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        for (let t = song.firstBeat; t < dur; t += barLen) {
          const bx = Math.floor(x(t)) + 0.5;
          ctx.beginPath();
          ctx.moveTo(bx, waveTop);
          ctx.lineTo(bx, h - RULER_H);
          ctx.stroke();
        }
      }

      // waveform
      if (peaks) {
        const n = peaks.length;
        for (let px = 0; px < w; px++) {
          const i0 = Math.floor((px / w) * n);
          const i1 = Math.max(i0 + 1, Math.floor(((px + 1) / w) * n));
          let m = 0;
          for (let i = i0; i < i1 && i < n; i++) m = Math.max(m, peaks[i]);
          const t = (px / w) * dur;
          const sec = song.sections.find((s) => t >= s.start && t < s.end);
          ctx.fillStyle = sec ? sectionColor(sec) : '#8b95a7';
          const a = Math.max(1, m * (waveH / 2) * 0.94);
          ctx.fillRect(px, mid - a, 1, a * 2);
        }
      }

      // volume automation line (if any points exist)
      if (song.automations && song.automations.length > 0) {
        const pts = [...song.automations].sort((a, b) => a.time - b.time);
        ctx.strokeStyle = '#0099FF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach((pt, idx) => {
          const px = x(pt.time);
          const py = waveTop + waveH * (1 - Math.min(1, pt.volume / 1.1));
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        pts.forEach((pt) => {
          const px = x(pt.time);
          const py = waveTop + waveH * (1 - Math.min(1, pt.volume / 1.1));
          ctx.fillStyle = '#0099FF';
          ctx.beginPath();
          ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // MIDI Out Cue Pins (ProPresenter / DMX)
      if (song.midiCues && song.midiCues.length > 0) {
        song.midiCues.forEach((pin) => {
          const px = x(pin.time);
          ctx.strokeStyle = pin.type === 'PROPRESENTER_SLIDE' ? '#F39C12' : '#00E676';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(px, waveTop);
          ctx.lineTo(px, h - RULER_H);
          ctx.stroke();
          ctx.fillStyle = pin.type === 'PROPRESENTER_SLIDE' ? '#F39C12' : '#00E676';
          ctx.beginPath();
          ctx.arc(px, h - RULER_H - 5, 3, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      // ruler
      ctx.fillStyle = '#7c8596';
      ctx.font = '10px Inter, system-ui, sans-serif';
      const step = dur > 300 ? 30 : dur > 120 ? 15 : 10;
      for (let t = 0; t < dur; t += step) {
        const xx = x(t);
        ctx.fillRect(xx, h - RULER_H, 1, 5);
        ctx.fillText(formatTime(t), xx + 3, h - RULER_H / 2 + 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [song, peaks, duration]);

  // dynamic layer: playhead, played shading, queue + loop markers
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = fgRef.current;
      if (c) {
        const ctx = c.getContext('2d')!;
        const dpr = window.devicePixelRatio || 1;
        const w = c.width / dpr;
        const h = c.height / dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const { queued, loopSectionId, duration } = propsRef.current;
        const dur = duration || 1;
        const x = (t: number) => (t / dur) * w;
        const px = x(getPos());
        // Slightly dim the already-played part of the waveform (Stage Dark Mode spec)
        ctx.fillStyle = 'rgba(13, 14, 17, 0.52)';
        ctx.fillRect(0, LABEL_H + 4, Math.max(0, px), h - LABEL_H - RULER_H - 8);

        const loopSec = song.sections.find((s) => s.id === loopSectionId);
        if (loopSec) {
          ctx.strokeStyle = '#F39C12';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(x(loopSec.start) + 1, 1, x(loopSec.end) - x(loopSec.start) - 2, h - RULER_H - 2);
          ctx.setLineDash([]);
        }
        if (queued) {
          const bx = x(queued.boundary);
          const tx = x(song.sections[queued.index]?.start ?? 0);
          const blink = Math.floor(performance.now() / 250) % 2 === 0;
          ctx.strokeStyle = blink ? '#F39C12' : '#0099FF';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(bx, LABEL_H);
          ctx.lineTo(bx, h - RULER_H);
          ctx.stroke();
          // Dashed Live-ReOrder jump arc / line from boundary to target section
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = '#0099FF';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(bx, LABEL_H + 14);
          ctx.lineTo(tx, LABEL_H + 14);
          ctx.stroke();
          ctx.restore();
          ctx.fillStyle = 'rgba(0, 153, 255, 0.32)';
          const tsec = song.sections[queued.index];
          if (tsec) ctx.fillRect(tx, 0, x(tsec.end) - tx, LABEL_H);
        }
        // playhead (bright white/blue needle)
        ctx.fillStyle = '#0099FF';
        ctx.fillRect(px - 1.5, 0, 3, h - RULER_H);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px - 0.5, 0, 1, h - RULER_H);
        ctx.fillStyle = '#0099FF';
        ctx.beginPath();
        ctx.moveTo(px - 7, 0);
        ctx.lineTo(px + 7, 0);
        ctx.lineTo(px, 9);
        ctx.fill();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [song, getPos]);

  return (
    <div
      className="timeline"
      ref={wrapRef}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.timeline-loop-dock')) return;
        const r = wrapRef.current!.getBoundingClientRect();
        const clickTime = ((e.clientX - r.left) / r.width) * (duration || 1);
        const clickY = e.clientY - r.top;
        if (clickY <= LABEL_H && onQueueSection) {
          const idx = song.sections.findIndex((s) => clickTime >= s.start && clickTime < s.end);
          if (idx !== -1) {
            onQueueSection(idx);
            return;
          }
        }
        onSeek(clickTime);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.timeline-loop-dock')) return;
        const r = wrapRef.current!.getBoundingClientRect();
        const clickTime = ((e.clientX - r.left) / r.width) * (duration || 1);
        const idx = song.sections.findIndex((s) => clickTime >= s.start && clickTime < s.end);
        if (idx !== -1 && onQueueSection) {
          onQueueSection(idx);
        }
      }}
      title="Clique ou dê duplo clique nas pílulas de seção para Live ReOrder (salto sincronizado) ou clique na forma de onda para buscar"
    >
      <canvas ref={bgRef} />
      <canvas ref={fgRef} />

      {/* Docked Quick Loop Controls (Loop 1x & Infinite Loop ∞) */}
      <div className="timeline-loop-dock" onClick={(e) => e.stopPropagation()}>
        <button
          className={`tl-loop-btn ${loopSectionId && loopMode === 'once' ? 'on' : ''}`}
          onClick={onToggleLoopOnce}
          title="Loop 1x: Repete a seção atual uma única vez e depois avança"
        >
          🔁 1x
        </button>
        <button
          className={`tl-loop-btn ${loopSectionId && loopMode === 'infinite' ? 'on' : ''}`}
          onClick={onToggleLoopInfinite}
          title="Infinite Loop (∞): Prende a reprodução na seção atual indefinidamente (Atalho: L)"
        >
          ∞ Loop
        </button>
        {onOpenWaveform && (
          <button
            className="tl-loop-btn"
            onClick={onOpenWaveform}
            title="Abrir Editor de Seções, Marcadores e Compassos (Waveform com Zoom)"
            style={{ marginLeft: 6, borderColor: 'rgba(56, 189, 248, 0.4)', color: '#38bdf8' }}
          >
            🌊 Waveform
          </button>
        )}
      </div>

      {loading !== null && (
        <div className="timeline-loading">
          <div>Preparando faixas… {Math.round(loading * 100)}%</div>
          <div className="progress">
            <div style={{ width: `${loading * 100}%` }} />
          </div>
        </div>
      )}
      {song.sections.length === 0 && loading === null && (
        <div className="timeline-hint">Sem marcadores de seção — clique em “Editar Arranjo” para adicionar.</div>
      )}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
