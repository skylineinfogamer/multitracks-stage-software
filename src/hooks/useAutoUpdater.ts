import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
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
    } catch (err) {
      console.warn('Erro ao verificar atualizações:', err);
      if (manual) {
        setError(`Falha ao verificar atualizações: ${(err as Error).message}`);
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

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            totalBytes = event.data.contentLength ?? 0;
            setDownloadStatus('Download iniciado…');
            break;
          case 'Progress': {
            downloadedBytes += event.data.chunkLength;
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
        }
      });

      setDownloadStatus('Atualização aplicada com sucesso! Reiniciando o app…');
      // Wait 1.2s to show success feedback before relaunching
      setTimeout(async () => {
        try {
          await relaunch();
        } catch (rErr) {
          console.warn('Erro ao reiniciar app via plugin-process:', rErr);
          window.location.reload();
        }
      }, 1200);
    } catch (err) {
      console.error('Erro ao instalar atualização:', err);
      setError(`Falha ao instalar a atualização: ${(err as Error).message}`);
      setIsDownloading(false);
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setUpdateAvailable(false);
    setError(null);
  }, []);

  // Silent automatic check on app startup (delayed 3.5s so startup remains zero-latency)
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
    dismissUpdate,
  };
}
