import { invoke } from '@tauri-apps/api/core';

export type AsioOutCount = '2' | '4' | '6' | '8' | 'custom';

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

export interface AsioOutputMapping {
  mode: AsioOutCount;
  tracksOutL: number; // 1-based physical channel (e.g. 1)
  tracksOutR: number; // 1-based physical channel (e.g. 2)
  altOutL: number;    // 1-based physical channel (e.g. 3)
  altOutR: number;    // 1-based physical channel (e.g. 4)
  guideOut: number;   // 1-based physical channel (e.g. 5 or 3 or 1)
  clickOut: number;   // 1-based physical channel (e.g. 6 or 4 or 1)
  auxOutL?: number;   // 1-based physical channel (e.g. 7)
  auxOutR?: number;   // 1-based physical channel (e.g. 8)
}

export interface AsioPresetInfo {
  mode: '2' | '4' | '6' | '8';
  title: string;
  label: string;
  desc: string;
  badge: string;
  mapping: AsioOutputMapping;
}

export const ASIO_OUT_CONFIGS: Record<'2' | '4' | '6' | '8', AsioPresetInfo> = {
  '2': {
    mode: '2',
    title: '2 OUTS',
    label: 'Modo 2 OUTS (Split L/R Cabo Y)',
    badge: '2 Saídas Físicas',
    desc: 'Saída 1 (Canal L): Click do Metrônomo 100% isolado · Saída 2 (Canal R): Backing Tracks / P.A. (ou Guia dedicada se configurada).',
    mapping: {
      mode: '2',
      tracksOutL: 2,
      tracksOutR: 2,
      altOutL: 2,
      altOutR: 2,
      guideOut: 2,
      clickOut: 1,
    },
  },
  '4': {
    mode: '4',
    title: '4 OUTS',
    label: 'Modo 4 OUTS (Palco Estéreo)',
    badge: '4 Saídas Físicas',
    desc: 'Saídas 1/2: Backing Tracks em Estéreo para o P.A. · Saída 3: Voz Guia · Saída 4: Click do Metrônomo para o Baterista.',
    mapping: {
      mode: '4',
      tracksOutL: 1,
      tracksOutR: 2,
      altOutL: 1,
      altOutR: 2,
      guideOut: 3,
      clickOut: 4,
    },
  },
  '6': {
    mode: '6',
    title: '6 OUTS',
    label: 'Modo 6 OUTS (Profissional)',
    badge: '6 Saídas Físicas',
    desc: 'Saídas 1/2: Tracks Principais · Saídas 3/4: Teclados, Guitarras & Pads · Saída 5: Voz Guia · Saída 6: Click Metrônomo.',
    mapping: {
      mode: '6',
      tracksOutL: 1,
      tracksOutR: 2,
      altOutL: 3,
      altOutR: 4,
      guideOut: 5,
      clickOut: 6,
    },
  },
  '8': {
    mode: '8',
    title: '8 OUTS',
    label: 'Modo 8 OUTS (Igrejas & Multicanal FOH)',
    badge: '8 Saídas Físicas',
    desc: 'Saídas 1/2: Bateria/Baixo/Tracks · Saídas 3/4: Teclados/Guitarras/Pads · Saída 5: Voz Guia · Saída 6: Click · Saídas 7/8: Efeitos Auxiliares.',
    mapping: {
      mode: '8',
      tracksOutL: 1,
      tracksOutR: 2,
      altOutL: 3,
      altOutR: 4,
      guideOut: 5,
      clickOut: 6,
      auxOutL: 7,
      auxOutR: 8,
    },
  },
};

export const DEFAULT_ASIO_MAPPING: AsioOutputMapping = ASIO_OUT_CONFIGS['6'].mapping;

export const ASIO_PRESETS: { name: string; desc: string; mapping: AsioOutputMapping }[] = [
  {
    name: '2 OUTS (Split Cabo Y)',
    desc: ASIO_OUT_CONFIGS['2'].desc,
    mapping: ASIO_OUT_CONFIGS['2'].mapping,
  },
  {
    name: '4 OUTS (Palco Estéreo)',
    desc: ASIO_OUT_CONFIGS['4'].desc,
    mapping: ASIO_OUT_CONFIGS['4'].mapping,
  },
  {
    name: '6 OUTS (Profissional)',
    desc: ASIO_OUT_CONFIGS['6'].desc,
    mapping: ASIO_OUT_CONFIGS['6'].mapping,
  },
  {
    name: '8 OUTS (Igrejas & FOH)',
    desc: ASIO_OUT_CONFIGS['8'].desc,
    mapping: ASIO_OUT_CONFIGS['8'].mapping,
  },
];

class AsioService {
  async getInstalledDrivers(): Promise<AsioDriverInfo[]> {
    try {
      const drivers = await invoke<AsioDriverInfo[]>('get_asio_drivers');
      if (drivers && drivers.length > 0) {
        return drivers;
      }
    } catch (e) {
      console.warn('Falha ao listar drivers ASIO via Tauri invoke, usando fallback:', e);
    }

    return [
      {
        id: 'ASIO4ALL v2',
        name: 'ASIO4ALL v2',
        description: 'ASIO4ALL Universal ASIO Driver (WDM / USB / HD Audio)',
        clsid: '{232685C6-6548-49D8-846D-4141A3EF7560}',
        max_channels: 8,
        default_sample_rate: 48000,
      },
      {
        id: 'Realtek ASIO',
        name: 'Realtek ASIO',
        description: 'Realtek High Definition Audio ASIO Driver',
        clsid: '{A80362FF-CE76-4DD9-874A-704C57BF0D6A}',
        max_channels: 6,
        default_sample_rate: 48000,
      },
    ];
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
