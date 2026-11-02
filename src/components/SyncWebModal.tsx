import { useEffect, useState } from 'react';
import type { WebPlaylist, WebPlaylistItem } from '../saas/AuthService';
import type { CatalogSong, DownloadProgress } from '../saas/types';
import type { Song } from '../types';
import { masterCatalogService, DEFAULT_B2_BASE_URL } from '../saas/MasterCatalogService';
import { Modal } from './Modal';

interface Props {
  webPlaylists: WebPlaylist[];
  localSongs: { id: string; name: string }[];
  ctx: AudioContext;
  onSongImported: (song: Song, originalItemId?: string) => void;
  onComplete: (syncedCount: number, downloadedCount: number) => void;
  onClose: () => void;
}

const CONCURRENCY = 1; // 1 download at a time to avoid overload

export function SyncWebModal({
  webPlaylists,
  localSongs,
  ctx,
  onSongImported,
  onComplete,
  onClose,
}: Props) {
  const [currentPlaylistIndex, setCurrentPlaylistIndex] = useState(0);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [statusText, setStatusText] = useState<string>('Iniciando sincronização…');
  const [isRunning, setIsRunning] = useState(true);
  const [downloadedCount, setDownloadedCount] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [completedPlaylists, setCompletedPlaylists] = useState<Set<string>>(new Set());

  // Helper
  const isItemInRepertoire = (item: WebPlaylistItem) => {
    return localSongs.some(
      (s) =>
        s.id === item.id ||
        s.name.toLowerCase().trim() === item.titulo.toLowerCase().trim()
    );
  };

  const buildCatalogSongFromItem = (item: WebPlaylistItem): CatalogSong => {
    const rawKey = item.b2_file_key || '';
    const fileName = rawKey.split('/').pop() || `${item.titulo.replace(/[\/\\]/g, '_')}.zip`;
    const b2Url = masterCatalogService.buildB2DownloadUrl(rawKey, DEFAULT_B2_BASE_URL);

    return {
      id: `pl_song_${item.id}`,
      title: item.titulo,
      artist: item.artista || 'Ministério de Louvor',
      bpm: parseInt(item.bpm || '120', 10) || 120,
      key: item.tom || 'G',
      beatsPerBar: 4,
      durationSec: 300,
      zipFileName: rawKey || fileName,
      zipDownloadUrl: b2Url,
      b2DownloadUrl: b2Url,
      provider: 'b2',
      stems: [],
      tags: ['Playlist Web'],
      addedAt: new Date().toISOString(),
    };
  };

  useEffect(() => {
    let cancelled = false;

    const runSync = async () => {
      setIsRunning(true);
      setStatusText('Iniciando sincronização…');
      setDownloadedCount(0);
      setErrors([]);
      setCompletedPlaylists(new Set());

      for (let plIdx = 0; plIdx < webPlaylists.length; plIdx++) {
        if (cancelled) break;
        const wp = webPlaylists[plIdx];
        setCurrentPlaylistIndex(plIdx);
        setCurrentItemIndex(0);

        const validItems = wp.items.filter((i) => i.b2_file_key && i.b2_file_key.trim() !== '');
        const pendingItems = validItems.filter((i) => !isItemInRepertoire(i));

        setStatusText(`📂 Processando playlist: "${wp.name}" (${pendingItems.length} música(s) para baixar)`);

        for (let itemIdx = 0; itemIdx < validItems.length; itemIdx++) {
          if (cancelled) break;
          const item = validItems[itemIdx];
          setCurrentItemIndex(itemIdx);

          if (isItemInRepertoire(item)) {
            setProgressMap((prev) => ({ ...prev, [item.id]: 100 }));
            continue;
          }

          setStatusText(`⬇️ Baixando [${itemIdx + 1}/${validItems.length}] "${item.titulo}"…`);
          setProgressMap((prev) => ({ ...prev, [item.id]: 0 }));

          try {
            const catSong = buildCatalogSongFromItem(item);
            const imported = await masterCatalogService.downloadSongToRepertoire(
              catSong,
              ctx,
              (p: DownloadProgress) => {
                if (!cancelled) {
                  setProgressMap((prev) => ({ ...prev, [item.id]: p.percent }));
                  setStatusText(`⬇️ Baixando [${itemIdx + 1}/${validItems.length}] "${item.titulo}": ${p.statusText} (${p.percent}%)`);
                }
              }
            );

            onSongImported(imported, item.id);
            setDownloadedCount((c) => {
              const nextCount = c + 1;
              return nextCount;
            });
            setProgressMap((prev) => ({ ...prev, [item.id]: 100 }));
            setStatusText(`✅ "${item.titulo}" baixada e adicionada ao repertório!`);
          } catch (err: any) {
            const msg = `❌ Erro ao baixar "${item.titulo}": ${err?.message || err}`;
            console.error('[SyncWebModal]', msg);
            setErrors((prev) => [...prev, msg]);
            setStatusText(msg);
            setProgressMap((prev) => ({ ...prev, [item.id]: -1 }));
          }
        }

        setCompletedPlaylists((prev) => new Set([...prev, wp.id]));
      }

      if (!cancelled) {
        setStatusText(`🎉 Sincronização concluída!`);
        onComplete(webPlaylists.length, downloadedCount);
        setIsRunning(false);
      }
    };

    runSync();

    return () => {
      cancelled = true;
    };
  }, []);

  const totalItems = webPlaylists.reduce((acc, wp) => acc + wp.items.filter((i) => i.b2_file_key).length, 0);
  const completedItems = Object.values(progressMap).filter((p) => p === 100).length;
  const failedItems = Object.values(progressMap).filter((p) => p === -1).length;
  const overallProgress = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  if (!isRunning && webPlaylists.length > 0) {
    // Auto-close after 3 seconds on success
    setTimeout(() => onClose(), 3000);
  }

  return (
    <Modal
      title={`☁️ Sincronizando Setlists da Web (${webPlaylists.length} playlist(s))`}
      onClose={isRunning ? () => {} : onClose}
      wide
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Progresso Geral */}
        <div
          style={{
            background: 'rgba(0, 153, 255, 0.08)',
            border: '1px solid rgba(0, 153, 255, 0.25)',
            borderRadius: 10,
            padding: '16px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 14 }}>
            <span style={{ fontWeight: 700, color: '#38bdf8' }}>Progresso Geral</span>
            <span style={{ color: '#cbd5e1' }}>{overallProgress}%</span>
          </div>
          <div style={{ height: 8, background: '#0f172a', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                width: `${overallProgress}%`,
                height: '100%',
                background: isRunning ? 'linear-gradient(90deg, #38bdf8, #06b6d4)' : 'linear-gradient(90deg, #10b981, #34d399)',
                borderRadius: 4,
                transition: 'width 0.3s ease',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: '#94a3b8' }}>
            <span>✅ Concluídas: {completedItems}</span>
            <span>⏳ Pendentes: {totalItems - completedItems - failedItems}</span>
            <span style={{ color: failedItems > 0 ? '#f87171' : '#94a3b8' }}>❌ Erros: {failedItems}</span>
          </div>
        </div>

        {/* Status Atual */}
        <div
          style={{
            fontSize: 13,
            padding: '12px 16px',
            borderRadius: 8,
            background: statusText.startsWith('❌')
              ? 'rgba(239, 68, 68, 0.15)'
              : statusText.startsWith('✅') || statusText.startsWith('🎉')
              ? 'rgba(16, 185, 129, 0.15)'
              : 'rgba(56, 189, 248, 0.15)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            color: '#f8fafc',
            minHeight: 40,
          }}
        >
          {statusText}
        </div>

        {/* Lista de Playlists */}
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {webPlaylists.map((wp, plIdx) => {
            const validItems = wp.items.filter((i) => i.b2_file_key && i.b2_file_key.trim() !== '');
            const isCurrent = plIdx === currentPlaylistIndex && isRunning;
            const isDone = completedPlaylists.has(wp.id);

            return (
              <div
                key={wp.id}
                style={{
                  background: isCurrent ? 'rgba(56, 189, 248, 0.1)' : 'rgba(255, 255, 255, 0.02)',
                  border: isCurrent ? '1px solid #38bdf8' : isDone ? '1px solid #10b981' : '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 10,
                  marginBottom: 12,
                  padding: 12,
                  transition: 'all 0.2s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isRunning && isCurrent ? (
                      <span style={{ color: '#38bdf8', animation: 'pulse 1s infinite' }}>⏳</span>
                    ) : isDone ? (
                      <span style={{ color: '#10b981' }}>✅</span>
                    ) : (
                      <span style={{ color: '#64748b' }}>📂</span>
                    )}
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{wp.name}</span>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>({validItems.length} música(s))</span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginLeft: 28 }}>
                  {validItems.map((item, itemIdx) => {
                    const progress = progressMap[item.id] ?? 0;
                    const isCurrentItem = isCurrent && itemIdx === currentItemIndex && progress < 100 && progress !== -1;
                    const hasError = progress === -1;
                    const isComplete = progress === 100;

                    return (
                      <div
                        key={item.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 10px',
                          background: isCurrentItem ? 'rgba(56, 189, 248, 0.08)' : 'transparent',
                          borderRadius: 6,
                          border: isCurrentItem ? '1px solid rgba(56, 189, 248, 0.3)' : undefined,
                          transition: 'all 0.2s',
                          opacity: isComplete && !isCurrentItem ? 0.7 : 1,
                        }}
                      >
                        {hasError ? (
                          <span style={{ color: '#f87171', fontSize: 14 }}>❌</span>
                        ) : isComplete ? (
                          <span style={{ color: '#10b981', fontSize: 14 }}>✅</span>
                        ) : isCurrentItem ? (
                          <span style={{ color: '#38bdf8', fontSize: 14, animation: 'spin 1s linear infinite' }}>⟳</span>
                        ) : (
                          <span style={{ color: '#64748b', fontSize: 14 }}>⏳</span>
                        )}

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.titulo}
                          </div>
                          <div style={{ fontSize: 11, color: '#94a3b8' }}>
                            {item.artista} · {item.bpm} BPM · {item.tom}
                          </div>
                          {progress > 0 && progress < 100 && (
                            <div style={{ marginTop: 4, height: 4, background: '#0f172a', borderRadius: 2, overflow: 'hidden' }}>
                              <div
                                style={{
                                  width: `${progress}%`,
                                  height: '100%',
                                  background: 'linear-gradient(90deg, #38bdf8, #06b6d4)',
                                  borderRadius: 2,
                                  transition: 'width 0.1s linear',
                                }}
                              />
                            </div>
                          )}
                        </div>

                        {progress > 0 && progress < 100 && (
                          <span style={{ fontSize: 12, color: '#38bdf8', fontWeight: 600, minWidth: 45, textAlign: 'right' }}>
                            {progress}%
                          </span>
                        )}
                        {hasError && (
                          <span style={{ fontSize: 12, color: '#f87171', fontWeight: 600 }}>
                            ERRO
                          </span>
                        )}
                        {isComplete && !hasError && (
                          <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>
                            OK
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {errors.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', color: '#f87171', fontWeight: 600 }}>
              ⚠️ {errors.length} erro(s) - clique para ver detalhes
            </summary>
            <div style={{ marginTop: 8, fontSize: 12, color: '#fca5a5', maxHeight: 150, overflow: 'auto' }}>
              {errors.map((e, i) => (
                <div key={i} style={{ marginBottom: 4, padding: '6px 8px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: 4 }}>
                  {e}
                </div>
              ))}
            </div>
          </details>
        )}

        {!isRunning && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button
              onClick={onClose}
              style={{
                padding: '10px 24px',
                background: 'linear-gradient(90deg, #10b981, #059669)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              Fechar
            </button>
          </div>
        )}

        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
        `}</style>
      </div>
    </Modal>
  );
}