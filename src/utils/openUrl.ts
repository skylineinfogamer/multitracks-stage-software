import { invoke } from '@tauri-apps/api/core';
import { openUrl as tauriOpenUrl } from '@tauri-apps/plugin-opener';

/**
 * Universal external URL opener for Tauri desktop and browser.
 * Ensures that payment checkout URLs (InfinitePay) open properly
 * in the user's default browser (Edge, Chrome, etc.).
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!url) return false;

  // 1. Try Tauri plugin opener
  try {
    await tauriOpenUrl(url);
    return true;
  } catch (e1) {
    console.warn('tauriOpenUrl falhou, tentando fallback nativo invoke:', e1);
  }

  // 2. Try native Rust open_browser_url command
  try {
    await invoke('open_browser_url', { url });
    return true;
  } catch (e2) {
    console.warn('invoke open_browser_url falhou, tentando fallback window.open:', e2);
  }

  // 3. Browser fallback
  try {
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (win) return true;
  } catch (e3) {
    console.error('window.open falhou:', e3);
  }

  return false;
}
