import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { masterCatalogService } from '../saas/MasterCatalogService';
import { authService } from '../saas/AuthService';
import type { CatalogSong, DownloadProgress } from '../saas/types';
import type { Song } from '../types';
import { TrackMappingDialog, type MappedTrackItem } from './TrackMappingDialog';
import { guessTrack, uid } from '../music';

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

  // Track Mapping Dialog State (Permite ao usuário nomear e gerenciar cada track antes de importar)
  const [mappingSong, setMappingSong] = useState<CatalogSong | null>(null);
  const [mappingTracks, setMappingTracks] = useState<MappedTrackItem[]>([]);
  const [isFinalizingMapping, setIsFinalizingMapping] = useState(false);
  const [mappingStatusText, setMappingStatusText] = useState('');

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

    try {
      const currentUser = authService.getCurrentUser();
      if (currentUser && currentUser.role !== 'admin') {
        setSyncStatus('🔄 Sincronizando suas MultiTracks da sua nuvem pessoal…');
        const res = await masterCatalogService.syncUserCatalog(currentUser.id, (msg) => {
          setSyncStatus(msg);
        });
        setCatalog([...res.songs]);
        setSyncStatus(`✅ Sincronizado com sucesso! ${res.count} MultiTrack(s) na sua conta.`);
      } else {
        setSyncStatus('🔄 Conectando ao servidor e sincronizando Catálogo Master…');
        const res = await masterCatalogService.syncCatalogFromMasterCloud((msg) => {
          setSyncStatus(msg);
        });
        setCatalog([...res.songs]);
        setSyncStatus(`✅ Catálogo atualizado com sucesso! ${res.count} músicas disponíveis.`);
      }
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
      // 1. Baixa o pacote completo e extrai todos os ficheiros de áudio brutos
      const pkg = await masterCatalogService.downloadAndExtractSongPackage(item, (p) => {
        setProgress(p);
      });

      // 2. Mapeia 100% de todas as faixas sem descartar nenhuma, com nomes inteligentes preservados
      const mappedItems: MappedTrackItem[] = pkg.audioFiles.map((f, i) => {
        const g = guessTrack(f.fileName, i, item.title);
        return {
          id: uid('tr'),
          fileName: f.fileName,
          name: g.name,
          suggestedName: g.name,
          kind: g.kind,
          bus: g.bus,
          color: g.color,
          included: true,
          data: f.data,
        };
      });

      // 3. Abre a tela para o usuário verificar, renomear e excluir o que desejar
      setDownloadingSongId(null);
      setProgress(null);
      setMappingSong(item);
      setMappingTracks(mappedItems);
    } catch (err) {
      setProgress({ statusText: `❌ Falha ao baixar: ${(err as Error).message}`, percent: 0, isError: true });
      setTimeout(() => {
        setDownloadingSongId(null);
      }, 3000);
    }
  };

  const handleConfirmMapping = async (res: {
    songTitle: string;
    artist: string;
    bpm: number;
    musicKey: string;
    tracks: MappedTrackItem[];
  }) => {
    if (!mappingSong) return;
    setIsFinalizingMapping(true);
    setMappingStatusText('Decodificando e salvando canais de áudio no projeto…');

    try {
      const updatedCatalogSong: CatalogSong = {
        ...mappingSong,
        title: res.songTitle,
        artist: res.artist,
        bpm: res.bpm,
        key: res.musicKey,
      };

      const imported = await masterCatalogService.finalizeSongWithCustomTracks({
        catalogSong: updatedCatalogSong,
        customTracks: res.tracks,
        ctx,
        onProgress: (p) => {
          setMappingStatusText(p.statusText);
        },
      });

      onSongImported(imported);
      setMappingSong(null);
      setMappingTracks([]);
      onClose();
    } catch (err) {
      alert(`Falha ao compilar canais: ${(err as Error).message}`);
    } finally {
      setIsFinalizingMapping(false);
      setMappingStatusText('');
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
                <span>{isAdmin ? 'Catálogo Master B2' : 'Minhas MultiTracks na Nuvem'}</span>
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
                {isAdmin
                  ? 'Repositório Master B2 Cloud com canais isolados.'
                  : 'MultiTracks vinculadas à sua conta na nuvem e playlists.'}
              </div>
            </div>

            {/* Sync Button */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 800,
                  padding: '4px 10px',
                  background: 'rgba(0, 153, 255, 0.15)',
                  borderColor: 'rgba(0, 153, 255, 0.4)',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderRadius: 6,
                  color: '#38bdf8',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>⚡ Servidor: Backblaze B2</span>
              </div>

              <button
                className="btn small primary"
                disabled={syncing}
                onClick={handleSyncCatalog}
                style={{
                  background: syncing ? 'rgba(0, 153, 255, 0.2)' : '#0284c7',
                  borderColor: '#0099ff',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                title={isAdmin ? 'Sincronizar todo o repositório mestre B2' : 'Sincronizar as MultiTracks da sua pasta na nuvem'}
              >
                <span style={{ display: 'inline-block', animation: syncing ? 'spin 1s linear infinite' : 'none' }}>
                  🔄
                </span>
                {syncing
                  ? 'Sincronizando…'
                  : isAdmin
                  ? 'Sincronizar Master'
                  : 'Sincronizar Minha Nuvem'}
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
                <div style={{ fontSize: 36 }}>{catalog.length === 0 ? '☁️' : '🔍'}</div>
                <div>
                  <strong style={{ fontSize: 15, color: '#f8fafc', display: 'block' }}>
                    {catalog.length === 0
                      ? 'Nenhuma MultiTrack sincronizada ainda'
                      : q
                      ? `Nenhuma MultiTrack encontrada para "${q}"`
                      : 'Nenhuma música no catálogo com esses filtros'}
                  </strong>
                  <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0', maxWidth: 460 }}>
                    {catalog.length === 0
                      ? 'O catálogo é 100% dinâmico e sincroniza os pacotes (.zip e .rar) diretamente da sua conta Backblaze B2 sem hardcoded ou arquivos estáticos.'
                      : 'Precisa dessa música para o culto deste fim de semana? Solicite agora mesmo e o pedido cairá diretamente no WhatsApp da administração!'}
                  </p>
                </div>
                {catalog.length === 0 ? (
                  <button
                    className="btn primary"
                    disabled={syncing}
                    onClick={handleSyncCatalog}
                    style={{
                      background: '#0099ff',
                      borderColor: '#0099ff',
                      color: '#ffffff',
                      fontWeight: 700,
                      fontSize: 13,
                      padding: '8px 20px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      boxShadow: '0 0 16px rgba(0, 153, 255, 0.35)',
                    }}
                  >
                    <span>🔄</span> {syncing ? 'Sincronizando com Backblaze B2…' : 'Sincronizar com Backblaze B2'}
                  </button>
                ) : (
                  <button
                    className="btn"
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '8px 16px',
                    }}
                    onClick={() => {
                      setQ('');
                      setKeyFilter('ALL');
                    }}
                  >
                    <span>🔍</span> Limpar busca e ver todas
                  </button>
                )}
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
                            <span
                              style={{
                                fontSize: 10,
                                background: 'rgba(0, 153, 255, 0.15)',
                                color: '#38bdf8',
                                border: '1px solid rgba(0, 153, 255, 0.35)',
                                borderRadius: 4,
                                padding: '1px 5px',
                                fontWeight: 800,
                              }}
                              title="Download de alta velocidade via Backblaze B2"
                            >
                              ⚡ B2 Cloud
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

              </>
            )}
          </div>
        </div>
      </Modal>

      {/* Tela de Mapeamento, Edição de Nomes e Seleção de Canais */}
      {mappingSong && mappingTracks.length > 0 && (
        <TrackMappingDialog
          songTitle={mappingSong.title}
          artist={mappingSong.artist}
          bpm={mappingSong.bpm}
          musicKey={mappingSong.key}
          tracks={mappingTracks}
          isProcessing={isFinalizingMapping}
          processingMessage={mappingStatusText}
          onConfirm={handleConfirmMapping}
          onClose={() => {
            if (!isFinalizingMapping) {
              setMappingSong(null);
              setMappingTracks([]);
            }
          }}
        />
      )}
    </>
  );
}
