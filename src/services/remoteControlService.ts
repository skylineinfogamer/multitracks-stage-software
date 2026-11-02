import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface RemoteServerInfo {
  running: boolean;
  port: number;
  ip: string;
  url: string;
  client_count: number;
  qr_svg: string;
  available_ips?: string[];
}

export interface RemoteActionPayload {
  action:
    | 'play'
    | 'pause'
    | 'stop'
    | 'seek'
    | 'jump'
    | 'loop_current'
    | 'fade_out'
    | 'prev_song'
    | 'next_song'
    | 'toggle_click'
    | 'track_volume'
    | 'track_mute'
    | 'track_solo'
    | 'bus_volume'
    | 'bus_mute'
    | 'bus_solo'
    | 'master_volume'
    | 'pitch_offset'
    | 'pad_toggle'
    | 'pad_play'
    | 'pad_stop';
  position?: number;
  sectionId?: string;
  mode?: 'bar' | 'now';
  trackId?: string;
  bus?: string;
  value?: any;
  delta?: number;
  reset?: boolean;
  key?: string;
}

export interface RemoteBroadcastState {
  type?: string;
  playing: boolean;
  position: number;
  duration: number;
  autonomousClick?: boolean;
  padKey?: string | null;
  padPlaying?: boolean;
  activeSectionId?: string | null;
  song: {
    id: string;
    title: string;
    artist?: string;
    key?: string;
    originalKey?: string;
    pitchOffset?: number;
    bpm?: number;
    duration?: number;
    chordChart?: string;
    transposedChords?: string;
    diatonicChords?: string[];
    sections?: Array<{
      id: string;
      label: string;
      type: string;
      start: number;
      end: number;
      color?: string;
    }>;
  } | null;
  queuedSectionId?: string | null;
  loopSectionId?: string | null;
  tracks?: Array<{
    id: string;
    name: string;
    kind: string;
    vol: number;
    mute: boolean;
    solo: boolean;
    color?: string;
  }>;
  buses?: Array<{
    id: string;
    name: string;
    vol: number;
    mute: boolean;
    solo: boolean;
  }>;
}

class RemoteControlService {
  async getStatus(): Promise<RemoteServerInfo> {
    try {
      return await invoke<RemoteServerInfo>('get_remote_server_status');
    } catch (e) {
      console.warn('Erro ao obter status do servidor remoto:', e);
      return {
        running: false,
        port: 3000,
        ip: '127.0.0.1',
        url: 'http://localhost:3000/remote',
        client_count: 0,
        qr_svg: '',
      };
    }
  }

  async startServer(port = 3000, customIp?: string): Promise<RemoteServerInfo> {
    return await invoke<RemoteServerInfo>('start_remote_server', { port, customIp });
  }

  async setRemoteIp(ip: string): Promise<RemoteServerInfo> {
    return await invoke<RemoteServerInfo>('set_remote_ip', { ip });
  }

  async stopServer(): Promise<void> {
    await invoke('stop_remote_server');
  }

  async broadcastState(state: RemoteBroadcastState): Promise<void> {
    try {
      const json = JSON.stringify({ type: 'state', ...state });
      await invoke('broadcast_remote_state', { stateJson: json });
    } catch {
      /* ignore */
    }
  }

  onRemoteAction(handler: (action: RemoteActionPayload) => void): () => void {
    let unlistenFn: (() => void) | null = null;
    void listen<string>('remote-action', (event) => {
      try {
        const parsed = JSON.parse(event.payload);
        handler(parsed);
      } catch (e) {
        console.warn('Erro ao decodificar ação remota:', e);
      }
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }

  onClientCountChange(handler: (count: number) => void): () => void {
    let unlistenFn: (() => void) | null = null;
    void listen<{ count: number }>('remote-client-change', (event) => {
      handler(event.payload.count);
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }
}

export const remoteControlService = new RemoteControlService();
