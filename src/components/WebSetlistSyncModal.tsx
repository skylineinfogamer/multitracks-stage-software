import { useState } from 'react';
import type { Song } from '../types';
import type { CatalogSong, DownloadProgress } from '../saas/types';
import type { WebPlaylist, WebPlaylistItem } from '../saas/AuthService';
import { masterCatalogService, DEFAULT_B2_BASE_URL } from '../saas/MasterCatalogService';
import { Modal } from './Modal';

interface Props {
  playlist: WebPlaylist;
  localSongs: Song[];
  ctx: AudioContext;
  onSongImported: (song: Song, originalItemId?: string) => void;
  onOrganizeSetlist: (setlistId: string) => void;
  onClose: () => void;
}

export function WebSetlistSyncModal({
  playlist,
  localSongs,
  ctx,
  onSongImported,
  onOrganizeSetlist,
  onClose,
}: Props) {
  const [downloadingItemId, setDownloadingItemId] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);

  // Helper para verificar se um item já foi baixado / importado no repertório local
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
      tags: ['Playlist Web', playlist.name],
      addedAt: new Date().toISOString(),
    };
  };

  const handleDownloadSingle = async (item: WebPlaylistItem) => {
    if (downloadingItemId || isDownloadingAll) return;
    setDownloadingItemId(item.id);
    setStatusText(`Iniciando download de "${item.titulo}"…`);

    try {
      const catSong = buildCatalogSongFromItem(item);
      const imported = await masterCatalogService.downloadSongToRepertoire(
        catSong,
        ctx,
        (p: DownloadProgress) => {
          setProgressMap((prev) => ({ ...prev, [item.id]: p.percent }));
          setStatusText(`Baixando "${item.titulo}": ${p.statusText} (${p.percent}%)`);
        }
      );

      onSongImported(imported, item.id);
      setStatusText(`✅ "${item.titulo}" baixada e adicionada ao repertório!`);
    } catch (err: any) {
      alert(`Falha ao baixar "${item.titulo}": ${err?.message || err}`);
      setStatusText(`❌ Erro ao baixar "${item.titulo}".`);
    } finally {
      setDownloadingItemId(null);
    }
  };

  const handleDownloadAll = async () => {
    const pendingItems = playlist.items.filter((item) => !isItemInRepertoire(item));
    if (pendingItems.length === 0) {
      alert('Todas as músicas desta playlist já estão baixadas no seu repertório!');
      return;
    }

    setIsDownloadingAll(true);
    const CONCURRENCY = 2; // Evita saturar banda / conexões B2
    const queue = [...pendingItems];
    const running = new Set<Promise<void>>();

    const runNext = () => {
      if (!queue.length) return;
      const item = queue.shift()!;
      setDownloadingItemId(item.id);
      const total = pendingItems.length;
      const completed = total - queue.length - running.size;

      const promise = masterCatalogService
        .downloadSongToRepertoire(
          buildCatalogSongFromItem(item),
          ctx,
          (prog: DownloadProgress) => {
            setProgressMap((prev) => ({ ...prev, [item.id]: prog.percent }));
            setStatusText(
              `Baixando [${completed + 1}/${total}] "${item.titulo}": ${prog.statusText} (${prog.percent}%)`
            );
          }
        )
        .then((imported) => {
          onSongImported(imported, item.id);
        })
        .catch((err: any) => {
          console.error(`Erro ao baixar ${item.titulo}:`, err);
          setStatusText(`⚠️ Erro ao baixar "${item.titulo}". Pulando para a próxima...`);
        })
        .finally(() => {
          running.delete(promise);
          runNext();
        });
      running.add(promise);
      if (running.size < CONCURRENCY) runNext();
    };

    // Iniciar primeiros
    for (let i = 0; i < Math.min(CONCURRENCY, pendingItems.length); i++) runNext();
    await Promise.all(running);

    setIsDownloadingAll(false);
    setDownloadingItemId(null);
    setStatusText('🎉 Todas as músicas possíveis da playlist foram processadas!');
  };

  const pendingCount = playlist.items.filter((item) => !isItemInRepertoire(item)).length;

  return (
    <Modal
      title={`🎵 Playlist Sincronizada da Web: "${playlist.name}"`}
      onClose={onClose}
      wide
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Banner Explicativo */}
        <div
          style={{
            background: 'rgba(0, 153, 255, 0.08)',
            border: '1px solid rgba(0, 153, 255, 0.25)',
            borderRadius: 10,
            padding: '12px 16px',
            fontSize: 13,
            lineHeight: 1.5,
            color: '#cbd5e1',
          }}
        >
          <div style={{ fontWeight: 700, color: '#38bdf8', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>☁️</span> Nova Playlist Criada no Painel do Músico
          </div>
          <div>
            Esta playlist possui <strong>{playlist.items.length} música(s)</strong> vinculada(s) à sua conta.
            {pendingCount > 0 ? (
              <span style={{ color: '#f59e0b', marginLeft: 4 }}>
                Você tem <strong>{pendingCount} música(s) pendente(s)</strong> para baixar para poder reproduzir no software.
              </span>
            ) : (
              <span style={{ color: '#10b981', marginLeft: 4 }}>
                Todas as músicas já estão prontas no seu repertório!
              </span>
            )}
          </div>
        </div>

        {/* Status de Progresso Global */}
        {statusText && (
          <div
            style={{
              fontSize: 12,
              padding: '8px 12px',
              borderRadius: 8,
              background: statusText.startsWith('❌')
                ? 'rgba(239, 68, 68, 0.15)'
                : statusText.startsWith('✅') || statusText.startsWith('🎉')
                ? 'rgba(16, 185, 129, 0.15)'
                : 'rgba(56, 189, 248, 0.15)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#f8fafc',
            }}
          >
            {statusText}
          </div>
        )}

        {/* Lista de Músicas da Playlist */}
        <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {playlist.items.map((item, index) => {
            const inRep = isItemInRepertoire(item);
            const isCurrent = downloadingItemId === item.id;
            const progress = progressMap[item.id] || 0;

            return (
              <div
                key={item.id || index}
                style={{
                  background: inRep ? 'rgba(16, 185, 129, 0.05)' : '#16181e',
                  border: inRep ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid #2e323b',
                  borderRadius: 10,
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                {/* Info da Música */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span
                      style={{
                        background: '#334155',
                        color: '#94a3b8',
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 4,
                      }}
                    >
                      #{index + 1}
                    </span>
                    <h4
                      style={{
                        margin: 0,
                        fontSize: 14,
                        fontWeight: 600,
                        color: inRep ? '#10b981' : '#f8fafc',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {item.titulo}
                    </h4>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#94a3b8' }}>
                    {item.artista && <span>{item.artista}</span>}
                    {item.bpm && (
                      <span style={{ background: '#1e293b', padding: '1px 6px', borderRadius: 4 }}>
                        {item.bpm} BPM
                      </span>
                    )}
                    {item.tom && (
                      <span style={{ background: '#1e293b', padding: '1px 6px', borderRadius: 4, color: '#38bdf8' }}>
                        Tom: {item.tom}
                      </span>
                    )}
                    {item.compasso && (
                      <span style={{ background: '#1e293b', padding: '1px 6px', borderRadius: 4 }}>
                        {item.compasso}
                      </span>
                    )}
                  </div>

                  {/* Barra de progresso individual */}
                  {isCurrent && (
                    <div style={{ marginTop: 8 }}>
                      <div
                        style={{
                          height: 6,
                          width: '100%',
                          background: '#1e293b',
                          borderRadius: 3,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${progress}%`,
                            background: '#0099ff',
                            transition: 'width 0.2s',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Status e Ação */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  {inRep ? (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        color: '#10b981',
                        fontSize: 12,
                        fontWeight: 600,
                        padding: '6px 12px',
                        borderRadius: 6,
                        background: 'rgba(16, 185, 129, 0.12)',
                        border: '1px solid rgba(16, 185, 129, 0.25)',
                      }}
                    >
                      <span>✓</span> No Repertório
                    </div>
                  ) : (
                    <button
                      className="btn primary small"
                      disabled={Boolean(downloadingItemId) || isDownloadingAll}
                      style={{
                        background: isCurrent ? '#0284c7' : '#0099ff',
                        fontSize: 12,
                        fontWeight: 600,
                        padding: '6px 14px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                      onClick={() => handleDownloadSingle(item)}
                    >
                      {isCurrent ? (
                        <>
                          <span className="spinner" style={{ width: 12, height: 12 }} />
                          <span>{progress}%</span>
                        </>
                      ) : (
                        <>
                          <span>📥</span>
                          <span>Baixar VS</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Ações Inferiores */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid #2e323b',
            paddingTop: 14,
            marginTop: 4,
          }}
        >
          <div>
            {pendingCount > 0 && (
              <button
                className="btn primary"
                disabled={Boolean(downloadingItemId) || isDownloadingAll}
                style={{
                  background: '#10b981',
                  borderColor: '#10b981',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
                onClick={handleDownloadAll}
              >
                <span>📥</span>
                <span>
                  {isDownloadingAll
                    ? 'Baixando Músicas em Lote…'
                    : `Baixar Todas as ${pendingCount} Músicas Pendentes`}
                </span>
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              className="btn primary"
              style={{
                background: '#0099ff',
                fontWeight: 700,
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
              onClick={() => {
                onOrganizeSetlist(playlist.id);
                onClose();
              }}
            >
              <span>🎛️</span>
              <span>Organizar / Abrir Setlist</span>
            </button>
            <button className="btn" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
