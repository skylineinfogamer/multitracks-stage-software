import { invoke } from '@tauri-apps/api/core';

export interface AsioDriverInfo {
  id: string;
  name: string;
  description: string;
  clsid: string;
  dll_path?: string;
  panel_path?: string;
  max_channels: number;
  default_sample_rate: number;
}

class AsioService {
  async getInstalledDrivers(): Promise<AsioDriverInfo[]> {
    try {
      const drivers = await invoke<AsioDriverInfo[]>('get_asio_drivers');
      if (drivers && drivers.length > 0) {
        // Exclude any wrappers strictly
        return drivers.filter((d) => !d.name.toLowerCase().includes('asio4all'));
      }
    } catch (e) {
      console.warn('Falha ao listar drivers ASIO via Tauri invoke:', e);
    }

    return [];
  }

  async openControlPanel(driverName: string, panelPath?: string): Promise<string> {
    try {
      return await invoke<string>('open_asio_control_panel', {
        driverName,
        panelPath: panelPath || null,
      });
    } catch (e) {
      console.warn('Erro ao abrir painel ASIO:', e);
      throw new Error(`Falha ao abrir painel de controle ASIO: ${(e as Error).message || e}`);
    }
  }

  calculateLatencyMs(bufferSize: number, sampleRate = 48000): number {
    const raw = ((bufferSize * 2) / sampleRate) * 1000;
    return Math.round(raw * 10) / 10;
  }
}

export const asioService = new AsioService();
