import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
}

/**
 * Utilitário seguro para formatar mensagens de erro retornadas pelo Tauri/Rust.
 * No Tauri, rejeições de IPC frequentemente retornam strings nativas de erro
 * ou objetos que não implementam a interface padrão Error (sem .message).
 */
export function formatTauriErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return 'Erro desconhecido retornado pelo backend.';
  }
  if (typeof error === 'string') {
    return error.trim() || 'Erro desconhecido.';
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  if (typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.message === 'string' && errObj.message.trim()) {
      return errObj.message.trim();
    }
    if (typeof errObj.error === 'string' && errObj.error.trim()) {
      return errObj.error.trim();
    }
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') {
        return json;
      }
    } catch {
      // fallback abaixo
    }
  }
  return String(error);
}

export function useAutoUpdater() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const activeUpdateRef = useRef<Update | null>(null);

  const checkForUpdates = useCallback(async (manual = false) => {
    setIsChecking(true);
    setError(null);
    try {
      // In development mode or outside Tauri runtime, check() safely returns null
      const update = await check();
      if (update && update.available) {
        activeUpdateRef.current = update;
        setUpdateInfo({
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body,
          date: update.date,
        });
        setUpdateAvailable(true);
      } else {
        activeUpdateRef.current = null;
        setUpdateAvailable(false);
        if (manual) {
          alert('Você já está utilizando a versão mais recente do Worship Tools!');
        }
      }
    } catch (err: unknown) {
      console.error('Detalhes do erro do Tauri (verificação):', err);
      if (manual) {
        const errorMsg = formatTauriErrorMessage(err);
        setError(`Falha ao verificar atualizações: ${errorMsg}`);
      }
    } finally {
      setIsChecking(false);
    }
  }, []);

  const downloadAndApply = useCallback(async () => {
    const update = activeUpdateRef.current;
    if (!update) return;

    setIsDownloading(true);
    setError(null);
    setDownloadProgress(0);
    setDownloadStatus('Iniciando download da atualização…');

    try {
      let totalBytes = 0;
      let downloadedBytes = 0;

      await update.downloadAndInstall((event: any) => {
        if (!event) return;

        switch (event.event) {
          case 'Started':
            totalBytes = event.data?.contentLength ?? 0;
            setDownloadStatus('Download iniciado…');
            break;
          case 'Progress': {
            downloadedBytes += event.data?.chunkLength ?? 0;
            if (totalBytes > 0) {
              const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
              setDownloadProgress(pct);
              const mbCurrent = (downloadedBytes / (1024 * 1024)).toFixed(1);
              const mbTotal = (totalBytes / (1024 * 1024)).toFixed(1);
              setDownloadStatus(`Baixando: ${pct}% (${mbCurrent} MB / ${mbTotal} MB)`);
            } else {
              const mbCurrent = (downloadedBytes / (1024 * 1024)).toFixed(1);
              setDownloadStatus(`Baixando: ${mbCurrent} MB recebidos…`);
            }
            break;
          }
          case 'Finished':
            setDownloadProgress(100);
            setDownloadStatus('Instalação concluída! Reiniciando…');
            break;
          // Tratamento para eventos de erro (ex: caso venha pelo listener de eventos ou onUpdaterEvent)
          case 'Error':
          case 'ERROR': {
            const rawEvtErr = event.data ?? event.error ?? event;
            console.error('Detalhes do erro do Tauri (evento updater):', rawEvtErr);
            const evtErrMsg = formatTauriErrorMessage(rawEvtErr);
            setError(`Falha ao instalar a atualização: ${evtErrMsg}`);
            break;
          }
          default:
            break;
        }
      });

      setDownloadStatus('Atualização aplicada com sucesso! Reiniciando o app…');
      // Aguarda 1.2s para exibir feedback visual antes de reiniciar
      setTimeout(async () => {
        try {
          await relaunch();
        } catch (rErr) {
          console.warn('Erro ao reiniciar app via plugin-process:', rErr);
          window.location.reload();
        }
      }, 1200);
    } catch (error: unknown) {
      console.error('Detalhes do erro do Tauri:', error);
      const errorMessage = formatTauriErrorMessage(error);
      setError(`Falha ao instalar a atualização: ${errorMessage}`);
      setIsDownloading(false);
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setUpdateAvailable(false);
    setError(null);
  }, []);

  // Verificação silenciosa ao iniciar o app (atrasada em 3.5s para não impactar o cold-start)
  useEffect(() => {
    const timer = setTimeout(() => {
      void checkForUpdates(false);
    }, 3500);
    return () => clearTimeout(timer);
  }, [checkForUpdates]);

  return {
    updateAvailable,
    updateInfo,
    isChecking,
    isDownloading,
    downloadProgress,
    downloadStatus,
    error,
    checkForUpdates,
    downloadAndApply,
    installUpdate: downloadAndApply,
    dismissUpdate,
  };
}
