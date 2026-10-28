import type { UpdateInfo } from '../hooks/useAutoUpdater';

interface UpdateDialogProps {
  updateInfo: UpdateInfo | null;
  isDownloading: boolean;
  downloadProgress: number;
  downloadStatus: string;
  error: string | null;
  onUpdate: () => void;
  onClose: () => void;
}

export function UpdateDialog({
  updateInfo,
  isDownloading,
  downloadProgress,
  downloadStatus,
  error,
  onUpdate,
  onClose,
}: UpdateDialogProps) {
  if (!updateInfo) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(5, 7, 10, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 99999,
        padding: 20,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          backgroundColor: '#0D0E11',
          border: '1px solid #2E323B',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(0, 153, 255, 0.15)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'scaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            backgroundColor: '#16181E',
            borderBottom: '1px solid #2E323B',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                backgroundColor: 'rgba(0, 153, 255, 0.15)',
                border: '1px solid rgba(0, 153, 255, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 18,
              }}
            >
              🚀
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#FFFFFF' }}>
                Nova Versão Disponível!
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#9CA3AF' }}>
                Worship Tools Auto-Updater
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 6,
                backgroundColor: '#2E323B',
                color: '#9CA3AF',
                fontWeight: 600,
              }}
            >
              v{updateInfo.currentVersion}
            </span>
            <span style={{ color: '#0099FF', fontSize: 12 }}>➔</span>
            <span
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 6,
                backgroundColor: 'rgba(0, 153, 255, 0.2)',
                color: '#38BDF8',
                fontWeight: 700,
                border: '1px solid rgba(0, 153, 255, 0.4)',
              }}
            >
              v{updateInfo.version}
            </span>
          </div>
        </div>

        {/* Content Body */}
        <div style={{ padding: 24 }}>
          <p style={{ margin: '0 0 16px', fontSize: 13.5, color: '#E5E7EB', lineHeight: 1.5 }}>
            Uma nova versão do software está pronta para ser instalada. Deseja atualizar agora?
          </p>

          {/* Release Notes */}
          {updateInfo.body && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#9CA3AF',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 6,
                }}
              >
                Notas da Versão:
              </div>
              <div
                style={{
                  maxHeight: 140,
                  overflowY: 'auto',
                  backgroundColor: '#16181E',
                  border: '1px solid #2E323B',
                  borderRadius: 8,
                  padding: '10px 14px',
                  fontSize: 12,
                  color: '#D1D5DB',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {updateInfo.body}
              </div>
            </div>
          )}

          {/* Download Progress */}
          {isDownloading && (
            <div
              style={{
                backgroundColor: '#16181E',
                border: '1px solid #2E323B',
                borderRadius: 10,
                padding: 14,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: '#38BDF8' }}>
                  {downloadStatus || 'Baixando atualização…'}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#FFFFFF' }}>
                  {downloadProgress}%
                </span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 6,
                  backgroundColor: '#2E323B',
                  borderRadius: 3,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${downloadProgress}%`,
                    height: '100%',
                    backgroundColor: '#0099FF',
                    borderRadius: 3,
                    transition: 'width 0.2s ease',
                  }}
                />
              </div>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: 8,
                padding: '10px 14px',
                color: '#F87171',
                fontSize: 12,
                marginBottom: 16,
              }}
            >
              ⚠️ {error}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: '16px 24px',
            backgroundColor: '#16181E',
            borderTop: '1px solid #2E323B',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 12,
          }}
        >
          <button
            onClick={onClose}
            disabled={isDownloading}
            style={{
              padding: '9px 18px',
              borderRadius: 8,
              border: '1px solid #2E323B',
              backgroundColor: '#1F242D',
              color: '#9CA3AF',
              fontSize: 12.5,
              fontWeight: 600,
              cursor: isDownloading ? 'not-allowed' : 'pointer',
              opacity: isDownloading ? 0.5 : 1,
              transition: 'all 0.15s ease',
            }}
          >
            Lembrar Mais Tarde
          </button>
          <button
            onClick={onUpdate}
            disabled={isDownloading}
            style={{
              padding: '9px 22px',
              borderRadius: 8,
              border: 'none',
              backgroundColor: isDownloading ? '#0077CC' : '#0099FF',
              color: '#FFFFFF',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: isDownloading ? 'wait' : 'pointer',
              boxShadow: '0 4px 14px rgba(0, 153, 255, 0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'all 0.15s ease',
            }}
          >
            {isDownloading ? (
              <>
                <span
                  style={{
                    display: 'inline-block',
                    width: 12,
                    height: 12,
                    border: '2px solid rgba(255, 255, 255, 0.3)',
                    borderTopColor: '#FFF',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
                Instalando…
              </>
            ) : (
              'Atualizar Agora'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
