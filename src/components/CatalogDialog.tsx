import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { masterCatalogService } from '../saas/MasterCatalogService';
import type { CatalogSong, DownloadProgress } from '../saas/types';
import type { Song } from '../types';
import { SongRequestDialog } from './SongRequestDialog';

interface Props {
  ctx: AudioContext;
  repertoireSongs: Song[];
  onSongImported: (s: Song & { _preloadedBuffers?: Map<string, AudioBuffer> }) => void;
  onOpenAdminPanel?: () => void;
  isAdmin?: boolean;
  onClose: () => void;
}

export function CatalogDialog({
  ctx,
  repertoireSongs,
  onSongImported,
  onOpenAdminPanel,
  isAdmin,
  onClose,
}: Props) {
  const [q, setQ] = useState('');
  const [keyFilter, setKeyFilter] = useState('ALL');
  const [downloadingSongId, setDownloadingSongId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  // Dynamic Catalog State & Live Subscription
  const [catalog, setCatalog] = useState<CatalogSong[]>(() => masterCatalogService.getCatalog());
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  // Song Request Dialog State
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [requestPrefill, setRequestPrefill] = useState('');

  useEffect(() => {
    return masterCatalogService.subscribe((updated) => {
      setCatalog([...updated]);
    });
  }, []);

  const filtered = useMemo(() => {
    return catalog.filter((s) => {
      const matchText = `${s.title} ${s.artist} ${s.tags?.join(' ') ?? ''}`.toLowerCase().includes(q.toLowerCase());
      const matchKey = keyFilter === 'ALL' || s.key.toUpperCase() === keyFilter.toUpperCase();
      return matchText && matchKey;
    });
  }, [catalog, q, keyFilter]);

  const handleSyncCatalog = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncStatus('🔄 Conectando ao servidor e sincronizando lista de MultiTracks…');

    try {
      const res = await masterCatalogService.syncCatalogFromMasterCloud((msg) => {
        setSyncStatus(msg);
      });
      setCatalog([...res.songs]);
      setSyncStatus(`✅ Catálogo atualizado com sucesso! ${res.count} músicas disponíveis.`);
      setTimeout(() => {
        setSyncStatus(null);
      }, 4000);
    } catch (err) {
      setSyncStatus(`❌ Falha ao sincronizar: ${(err as Error).message}`);
      setTimeout(() => {
        setSyncStatus(null);
      }, 6000);
    } finally {
      setSyncing(false);
    }
  };

  const handleDownload = async (item: CatalogSong) => {
    setDownloadingSongId(item.id);
    setProgress({ statusText: `Preparando download de "${item.title}"…`, percent: 5 });

    try {
      const imported = await masterCatalogService.downloadSongToRepertoire(item, ctx, (p) => {
        setProgress(p);
      });
      onSongImported(imported);
      setProgress({ statusText: `✅ "${imported.name}" adicionada ao Repertório!`, percent: 100 });
      setTimeout(() => {
        setDownloadingSongId(null);
        setProgress(null);
        onClose();
      }, 900);
    } catch (err) {
      setProgress({ statusText: `❌ Falha ao baixar: ${(err as Error).message}`, percent: 0, isError: true });
      setTimeout(() => {
        setDownloadingSongId(null);
      }, 3000);
    }
  };

  return (
    <>
      <Modal
        title="🎵 Catálogo Oficial de MultiTracks — Servidor Central"
        wide
        onClose={onClose}
        footer={
          <>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
              {isAdmin && onOpenAdminPanel && (
                <button
                  className="btn small"
                  style={{ borderColor: '#f59e0b', color: '#f59e0b', fontWeight: 700 }}
                  onClick={onOpenAdminPanel}
                >
                  ⚙️ Painel Admin (Conectar Drive)
                </button>
              )}
              <span className="muted" style={{ fontSize: 11.5 }}>
                Músicas centralizadas no servidor · Download direto para execução 100% offline no palco
              </span>
            </div>
            <button className="btn" onClick={onClose}>
              Fechar
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Top Banner with Stats & Sync Action */}
          <div
            style={{
              background: 'linear-gradient(135deg, rgba(0, 153, 255, 0.15), rgba(46, 204, 113, 0.08))',
              border: '1px solid rgba(0, 153, 255, 0.35)',
              borderRadius: 8,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 240, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Catálogo Oficial da Igreja</span>
                <span
                  style={{
                    background: 'rgba(0, 153, 255, 0.25)',
                    color: '#38bdf8',
                    border: '1px solid rgba(0, 153, 255, 0.4)',
                    padding: '1px 8px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {catalog.length} VS Disponíveis
                </span>
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>
                MultiTracks originais prontas com Click, Guia de contagem e canais isolados.
              </div>
            </div>

            {/* Sync Button & Request Button */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="btn small"
                disabled={syncing}
                onClick={handleSyncCatalog}
                style={{
                  background: syncing ? 'rgba(0, 153, 255, 0.2)' : '#1e293b',
                  borderColor: '#0099ff',
                  color: '#38bdf8',
                  fontWeight: 700,
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                title="Sincronizar e baixar lista atualizada de MultiTracks do servidor mestre"
              >
                <span style={{ display: 'inline-block', animation: syncing ? 'spin 1s linear infinite' : 'none' }}>
                  🔄
                </span>
                {syncing ? 'Sincronizando…' : 'Atualizar / Sincronizar'}
              </button>

              {isAdmin && catalog.length > 0 && (
                <button
                  className="btn small"
                  onClick={() => {
                    if (confirm('Deseja limpar todo o catálogo para atualizar do zero com os novos arquivos?')) {
                      masterCatalogService.clearCatalog();
                      setCatalog([]);
                      setSyncStatus('🗑️ Catálogo limpo com sucesso! Clique em "Atualizar / Sincronizar" para ler os novos arquivos.');
                      setTimeout(() => setSyncStatus(null), 4000);
                    }
                  }}
                  style={{
                    background: 'rgba(239, 68, 68, 0.15)',
                    borderColor: '#ef4444',
                    color: '#f87171',
                    fontWeight: 700,
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  title="Limpar todo o catálogo para nova sincronização"
                >
                  <span>🗑️</span> Limpar Catálogo
                </button>
              )}

              <button
                className="btn small primary"
                style={{
                  background: '#25D366',
                  borderColor: '#25D366',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                onClick={() => {
                  setRequestPrefill(q);
                  setShowRequestModal(true);
                }}
                title="Pedir uma música que não está no catálogo direto no WhatsApp do administrador"
              >
                <span>💬</span> Solicitar VS no Whats
              </button>
            </div>
          </div>

          {/* Sync Status Alert Message */}
          {syncStatus && (
            <div
              style={{
                fontSize: 12,
                padding: '8px 12px',
                borderRadius: 6,
                background: syncStatus.startsWith('❌')
                  ? 'rgba(239, 68, 68, 0.15)'
                  : syncStatus.startsWith('✅')
                  ? 'rgba(16, 185, 129, 0.15)'
                  : 'rgba(0, 153, 255, 0.15)',
                border: `1px solid ${
                  syncStatus.startsWith('❌')
                    ? '#ef4444'
                    : syncStatus.startsWith('✅')
                    ? '#10b981'
                    : '#0099ff'
                }`,
                color: syncStatus.startsWith('❌')
                  ? '#fca5a5'
                  : syncStatus.startsWith('✅')
                  ? '#6ee7b7'
                  : '#93c5fd',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {syncStatus}
            </div>
          )}

          {/* Filter and Search Bar */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
              <input
                style={{ width: '100%', fontSize: 13, paddingRight: q ? 30 : 10 }}
                placeholder="🔍 Buscar por nome da música, cantor ou ministério (ex: Bondade de Deus, Isaías Saad)…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {q && (
                <button
                  onClick={() => setQ('')}
                  style={{
                    position: 'absolute',
                    right: 8,
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    fontSize: 14,
                    padding: '2px 6px',
                  }}
                  title="Limpar busca"
                >
                  ✕
                </button>
              )}
            </div>

            <select
              style={{ width: 140, fontSize: 12 }}
              value={keyFilter}
              onChange={(e) => setKeyFilter(e.target.value)}
            >
              <option value="ALL">Todos os Tons</option>
              {['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].map((k) => (
                <option key={k} value={k}>
                  Tom: {k}
                </option>
              ))}
            </select>
          </div>

          {/* Download Progress Bar if active */}
          {progress && (
            <div
              style={{
                background: progress.isError ? 'rgba(231, 76, 60, 0.15)' : '#16181e',
                border: progress.isError ? '1px solid #e74c3c' : '1px solid #2e323b',
                borderRadius: 6,
                padding: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <strong style={{ color: progress.isError ? '#ff6b6b' : '#38bdf8' }}>
                  {progress.statusText}
                </strong>
                {!progress.isError && (
                  <span style={{ fontWeight: 800, color: '#2ecc71' }}>{progress.percent}%</span>
                )}
              </div>
              {!progress.isError && (
                <div className="progress" style={{ width: '100%', height: 8 }}>
                  <div style={{ width: `${progress.percent}%`, background: '#0099ff' }} />
                </div>
              )}
            </div>
          )}

          {/* Song Cards Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div
                style={{
                  background: '#16181e',
                  border: '1px dashed #2e323b',
                  borderRadius: 8,
                  padding: '36px 20px',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div style={{ fontSize: 36 }}>🔍</div>
                <div>
                  <strong style={{ fontSize: 15, color: '#f8fafc', display: 'block' }}>
                    {q ? `Nenhuma MultiTrack encontrada para "${q}"` : 'Nenhuma música no catálogo com esses filtros'}
                  </strong>
                  <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0', maxWidth: 440 }}>
                    Precisa dessa música para o culto deste fim de semana? Solicite agora mesmo e o pedido cairá diretamente no WhatsApp da administração!
                  </p>
                </div>
                <button
                  className="btn primary"
                  style={{
                    background: '#25D366',
                    borderColor: '#25D366',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: 13,
                    padding: '8px 18px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    boxShadow: '0 0 16px rgba(37, 211, 102, 0.35)',
                  }}
                  onClick={() => {
                    setRequestPrefill(q);
                    setShowRequestModal(true);
                  }}
                >
                  <span>💬</span> Solicitar "{q || 'Nova MultiTrack'}" no WhatsApp
                </button>
              </div>
            ) : (
              <>
                {filtered.map((item) => {
                  const inRepertoire = repertoireSongs.some(
                    (r) => r.name.toLowerCase() === item.title.toLowerCase(),
                  );
                  const isDownloading = downloadingSongId === item.id;

                  return (
                    <div
                      key={item.id}
                      style={{
                        background: '#16181e',
                        border: '1px solid #2e323b',
                        borderRadius: 8,
                        padding: '14px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 14,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: 8,
                            background: 'linear-gradient(135deg, #0099ff, #6366f1)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 22,
                            flexShrink: 0,
                          }}
                        >
                          🎵
                        </div>

                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <strong
                              style={{
                                fontSize: 14,
                                color: '#f8fafc',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {item.title}
                            </strong>
                            <span className="key-pill" style={{ fontSize: 11, padding: '1px 6px' }}>
                              {item.key}
                            </span>
                            <span className="bpm-pill" style={{ fontSize: 11, padding: '1px 6px' }}>
                              {item.bpm} BPM
                            </span>
                          </div>
                          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                            {item.artist} · {Math.floor(item.durationSec / 60)}:
                            {(item.durationSec % 60).toString().padStart(2, '0')} min
                          </div>

                          {/* Stems tags list */}
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                            {item.stems.map((st) => (
                              <span
                                key={st.id}
                                style={{
                                  fontSize: 9.5,
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  background: '#222631',
                                  color: '#cbd5e1',
                                  border: '1px solid #2e323b',
                                }}
                              >
                                {st.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {inRepertoire ? (
                          <span
                            style={{
                              fontSize: 11,
                              padding: '4px 10px',
                              borderRadius: 6,
                              background: 'rgba(46, 204, 113, 0.15)',
                              color: '#2ecc71',
                              border: '1px solid #2ecc71',
                              fontWeight: 700,
                            }}
                          >
                            ✓ No Repertório
                          </span>
                        ) : (
                          <button
                            className="btn primary"
                            disabled={isDownloading}
                            style={{ background: '#0099ff', borderColor: '#0099ff', fontWeight: 700, fontSize: 12 }}
                            onClick={() => void handleDownload(item)}
                          >
                            {isDownloading ? 'Baixando…' : '⬇️ Baixar para o Repertório'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Persistent Bottom Callout */}
                <div
                  style={{
                    background: 'rgba(37, 211, 102, 0.08)',
                    border: '1px solid rgba(37, 211, 102, 0.25)',
                    borderRadius: 8,
                    padding: '10px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 6,
                  }}
                >
                  <div style={{ fontSize: 12, color: '#e2e8f0' }}>
                    💡 Não encontrou a música que sua igreja precisa?
                  </div>
                  <button
                    className="btn small"
                    style={{
                      borderColor: '#25D366',
                      color: '#25D366',
                      fontWeight: 700,
                      fontSize: 11.5,
                    }}
                    onClick={() => {
                      setRequestPrefill(q);
                      setShowRequestModal(true);
                    }}
                  >
                    💬 Solicitar Nova MultiTrack
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </Modal>

      {/* WhatsApp Song Request Dialog */}
      {showRequestModal && (
        <SongRequestDialog
          prefillTitle={requestPrefill}
          onClose={() => setShowRequestModal(false)}
        />
      )}
    </>
  );
}
