import { useState } from 'react';
import JSZip from 'jszip';
import type { BusGroup, OutputBus, Song, Track, TrackKind } from '../types';
import { KEYS, guessTrack, orderTracksForStage, uid } from '../music';
import { decodeAudioDataSafe, isValidAudioCandidate, saveStem } from '../storage';
import { isCombinedClickGuide, isDualChannelClickGuide, splitStereoClickGuide } from '../audio/audioSeparation';
import {
  type KeyDetectionResult,
  detectKeyAndBpmFromFiles,
  detectSectionsFromAudio,
  generateChordChartForSong,
} from '../audio/aiAssistant';
import { Modal } from './Modal';
import { IconSparkles, IconUpload, IconX } from './Icons';

interface Props {
  ctx: AudioContext;
  onClose: () => void;
  onImported: (s: Song) => void;
}

interface Pending {
  id: string;
  name: string;
  fileName: string;
  data: ArrayBuffer;
  color: string;
  kind: TrackKind;
  bus: BusGroup;
  output: OutputBus;
}

export function ImportDialog({ ctx, onClose, onImported }: Props) {
  const [items, setItems] = useState<Pending[]>([]);
  const [name, setName] = useState('');
  const [artist, setArtist] = useState('');
  const [bpm, setBpm] = useState(120);
  const [key, setKey] = useState('C');
  const [beats, setBeats] = useState(4);
  const [genClick, setGenClick] = useState(true);
  const [guide, setGuide] = useState(true);
  const [aiSections, setAiSections] = useState(true);
  const [aiInfo, setAiInfo] = useState<KeyDetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const runAutoDetect = async (fileList: Array<{ name: string; data: ArrayBuffer }>, folderHint = '') => {
    if (!fileList.length) return;
    setDetecting(true);
    try {
      const res = await detectKeyAndBpmFromFiles(fileList, folderHint);
      setAiInfo(res);
      setKey(res.key);
      if (res.bpm && res.bpm >= 45 && res.bpm <= 220) {
        setBpm(res.bpm);
      }
    } catch {
      /* ignore detection error */
    } finally {
      setDetecting(false);
    }
  };

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const rawList = Array.from(files);
    const audioCandidates: Array<{ name: string; data: ArrayBuffer }> = [];

    setBusy('Lendo e extraindo arquivos de áudio…');
    try {
      for (const f of rawList) {
        if (f.name.toLowerCase().endsWith('.zip')) {
          try {
            // Read zip buffer immediately
            const zipBuf = await f.arrayBuffer();
            const zip = await JSZip.loadAsync(zipBuf);
            const entries = Object.keys(zip.files);
            for (const en of entries) {
              const ze = zip.files[en];
              if (ze.dir) continue;
              const bName = en.split('/').pop() || en;
              if (bName.startsWith('.') || en.includes('__MACOSX')) continue;
              if (/\.(wav|wave|mp3|m4a|aac|ogg|flac|aif|aiff)$/i.test(bName)) {
                // Read ArrayBuffer directly into memory immediately, preventing any file-locking issues
                const buf = await ze.async('arraybuffer');
                audioCandidates.push({ name: bName, data: buf });
              }
            }
            if (!name) {
              const cleanZip = f.name.replace(/\.zip$/i, '').replace(/[-_]?(multitrack|vs|stems|tracks)/i, '').trim();
              setName(cleanZip);
            }
          } catch (err) {
            console.warn('Falha ao descompactar ZIP local:', err);
          }
        } else if (isValidAudioCandidate(f)) {
          try {
            const buf = await f.arrayBuffer();
            audioCandidates.push({ name: f.name, data: buf });
          } catch (err) {
            console.warn('Falha ao ler arquivo local:', f.name, err);
          }
        }
      }
    } finally {
      setBusy(null);
    }

    if (!audioCandidates.length) return;
    const next: Pending[] = audioCandidates.map((f, i) => {
      const g = guessTrack(f.name, items.length + i, name);
      return {
        id: uid('t'),
        fileName: f.name,
        data: f.data,
        name: g.name,
        color: g.color,
        kind: g.kind,
        bus: g.bus,
        output: g.output,
      };
    });
    const merged = [...items, ...next];
    setItems(merged);

    let folderName = name;
    if (!name && audioCandidates[0]) {
      folderName = audioCandidates[0].name.replace(/\.[^.]+$/, '');
      setName(folderName);
    }
    if (next.some((n) => n.kind === 'click')) setGenClick(false);
    if (next.some((n) => n.kind === 'guide')) setGuide(false);

    void runAutoDetect(
      merged.map((m) => ({ name: m.fileName, data: m.data })),
      folderName,
    );
  };

  const doImport = async () => {
    if (!items.length) return;
    setBusy('Preparando importação e decodificando áudios…');
    try {
      const songId = uid('song');
      let duration = 0;
      const preloadedBuffers = new Map<string, AudioBuffer>();

      const tracks: Track[] = [];

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        setBusy(`Processando e separando canais (${i + 1}/${items.length}): ${it.name}…`);
        const ab = it.data;

        try {
          const decoded = await decodeAudioDataSafe(ctx, ab.slice(0));
          if (isFinite(decoded.duration) && decoded.duration > 0) {
            duration = Math.max(duration, decoded.duration);
          }

          // Check if this file is a combined Click & Guide track (Stereo Left = Click, Right = Guide)
          if (
            isCombinedClickGuide(it.fileName) ||
            isCombinedClickGuide(it.name) ||
            ((it.kind === 'click' || it.kind === 'guide') && isDualChannelClickGuide(decoded))
          ) {
            const split = splitStereoClickGuide(ctx, decoded);

            // 1. Pristine isolated Click stem
            const clickId = uid('tr_click');
            await saveStem(songId, clickId, split.clickWav);
            preloadedBuffers.set(clickId, split.clickBuffer);
            tracks.push({
              id: clickId,
              name: 'CLICK',
              color: '#F39C12',
              kind: 'click',
              bus: 'UTILITY',
              output: 'OUT_6',
              volume: 0.75,
              pan: 0,
              mute: false,
              solo: false,
              fileName: it.fileName,
            });

            // 2. Pristine isolated Guide stem
            const guideId = uid('tr_guide');
            await saveStem(songId, guideId, split.guideWav);
            preloadedBuffers.set(guideId, split.guideBuffer);
            tracks.push({
              id: guideId,
              name: 'GUIA',
              color: '#0099FF',
              kind: 'guide',
              bus: 'UTILITY',
              output: 'OUT_5',
              volume: 0.9,
              pan: 0,
              mute: false,
              solo: false,
              fileName: it.fileName,
            });
            continue;
          }

          // Standard individual stem
          preloadedBuffers.set(it.id, decoded);
          await saveStem(songId, it.id, ab);
          tracks.push({
            id: it.id,
            name: it.name,
            color: it.color,
            kind: it.kind,
            bus: it.bus,
            output: it.output,
            volume: it.kind === 'click' ? 0.75 : 0.85,
            pan: 0,
            mute: false,
            solo: false,
            fileName: it.fileName,
          });
        } catch {
          const bytesPerSec = 44100 * 2 * 2;
          const est = Math.max(10, Math.round(ab.byteLength / bytesPerSec));
          duration = Math.max(duration, est);
          await saveStem(songId, it.id, ab);
          tracks.push({
            id: it.id,
            name: it.name,
            color: it.color,
            kind: it.kind,
            bus: it.bus,
            output: it.output,
            volume: it.kind === 'click' ? 0.75 : 0.85,
            pan: 0,
            mute: false,
            solo: false,
            fileName: it.fileName,
          });
        }
      }

      if (!duration || duration < 5) duration = 240;

      // Always ensure Click exists on OUT_6 (Fones Click)
      if (!tracks.some((t) => t.kind === 'click')) {
        tracks.push({
          id: uid('click'),
          name: 'CLICK',
          color: '#F39C12',
          kind: 'click',
          bus: 'UTILITY',
          output: 'OUT_6',
          volume: 0.75,
          pan: 0,
          mute: false,
          solo: false,
        });
      }

      // Always ensure Guide exists on OUT_5 (Fones Guia)
      if (!tracks.some((t) => t.kind === 'guide')) {
        tracks.push({
          id: uid('guide'),
          name: 'GUIA',
          color: '#0099FF',
          kind: 'guide',
          bus: 'UTILITY',
          output: 'OUT_5',
          volume: 0.9,
          pan: 0,
          mute: false,
          solo: false,
        });
      }

      const baseSong: Song & { _preloadedBuffers?: Map<string, AudioBuffer> } = {
        id: songId,
        name: name || items[0].fileName.replace(/\.[^.]+$/, ''),
        artist: artist || 'Multitrack Importada',
        bpm,
        key,
        pitchOffset: 0,
        beatsPerBar: beats,
        firstBeat: 0,
        duration: Math.round(duration),
        guideMode: 'REANNOUNCE',
        sections: [],
        tracks: orderTracksForStage(tracks),
        source: 'import',
        _preloadedBuffers: preloadedBuffers,
      };

      if (aiSections) {
        baseSong.sections = detectSectionsFromAudio(baseSong);
        baseSong.chordChart = generateChordChartForSong(baseSong, 'modern');
      }

      onImported(baseSong);
    } catch (e) {
      alert(`Falha ao importar: ${(e as Error).message}`);
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Importar Multitracks (Stems) + Detecção Automática por IA"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted">{busy}</span>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!items.length || !!busy} onClick={doImport}>
            Importar {items.length ? `(${items.length} faixas)` : ''}
          </button>
        </>
      }
    >
      {(detecting || aiInfo) && (
        <div className="ai-import-banner">
          <IconSparkles size={16} />
          {detecting ? (
            <span>Analisando espectro harmônico das faixas para identificar Tom e BPM…</span>
          ) : aiInfo ? (
            <span>
              <b>IA Identificou Automaticamente:</b> Tom <b>{aiInfo.detectedLabel}</b> ({aiInfo.confidence}% confiança)
              {aiInfo.bpm ? ` · ${aiInfo.bpm} BPM` : ''}
            </span>
          ) : null}
        </div>
      )}

      <div className="form-grid">
        <label>
          Nome da música
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Bondade de Deus" />
        </label>
        <label>
          Artista
          <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Ex.: Ministério" />
        </label>
        <label>
          BPM (Detectado)
          <input
            type="number"
            min={30}
            max={300}
            step={0.1}
            value={bpm}
            onChange={(e) => setBpm(parseFloat(e.target.value) || 120)}
          />
        </label>
        <label>
          Tom (Detectado por IA)
          <select value={key} onChange={(e) => setKey(e.target.value)}>
            {KEYS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Compasso
          <select value={beats} onChange={(e) => setBeats(parseInt(e.target.value, 10))}>
            {[2, 3, 4, 6].map((b) => (
              <option key={b} value={b}>
                {b}/4
              </option>
            ))}
          </select>
        </label>
        <div className="checks">
          <label className="check">
            <input type="checkbox" checked={genClick} onChange={(e) => setGenClick(e.target.checked)} /> Gerar Click
            sincronizado
          </label>
          <label className="check">
            <input type="checkbox" checked={guide} onChange={(e) => setGuide(e.target.checked)} /> Guia automática de
            seção
          </label>
          <label className="check">
            <input type="checkbox" checked={aiSections} onChange={(e) => setAiSections(e.target.checked)} /> ✨ Gerar
            Seções & Cifra com IA
          </label>
        </div>
      </div>

      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        <IconUpload size={28} />
        <div style={{ fontSize: 14, fontWeight: 700 }}>Arraste faixas de áudio ou arquivo .ZIP aqui</div>
        <div className="drop-actions">
          <label className="btn small primary">
            Selecionar arquivos / .ZIP
            <input type="file" accept="audio/*,.zip" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          </label>
          <label className="btn small">
            Selecionar pasta da música
            <input
              type="file"
              multiple
              hidden
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(e) => void addFiles(e.target.files)}
            />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          Suporta .ZIP, WAV, MP3, M4A, OGG e FLAC — descompactação automática, detecção harmônica de Tom, BPM e organização canônica de palco.
        </div>
      </div>

      {items.length > 0 && (
        <table className="track-table">
          <thead>
            <tr>
              <th></th>
              <th>Faixa</th>
              <th>Arquivo</th>
              <th>Tipo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>
                  <input
                    type="color"
                    value={it.color}
                    onChange={(e) =>
                      setItems((l) => l.map((x) => (x.id === it.id ? { ...x, color: e.target.value } : x)))
                    }
                  />
                </td>
                <td>
                  <input
                    value={it.name}
                    onChange={(e) =>
                      setItems((l) => l.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))
                    }
                  />
                </td>
                <td className="muted">{it.fileName}</td>
                <td>
                  <select
                    value={it.kind}
                    onChange={(e) =>
                      setItems((l) =>
                        l.map((x) => (x.id === it.id ? { ...x, kind: e.target.value as Pending['kind'] } : x)),
                      )
                    }
                  >
                    <option value="audio">Áudio</option>
                    <option value="click">Click</option>
                  </select>
                </td>
                <td>
                  <button className="icon-btn" onClick={() => setItems((l) => l.filter((x) => x.id !== it.id))}>
                    <IconX size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
