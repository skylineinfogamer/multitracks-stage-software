import { useEffect, useMemo, useState } from 'react';
import type { Section } from '../types';
import type { Settings } from '../storage';
import type { AudioEngine } from '../audio/engine';
import { GUIDE_VOICE_PACKS, downloadOnlineGuidePack } from '../audio/guideVoices';
import { Modal } from './Modal';
import {
  ASIO_OUT_CONFIGS,
  DEFAULT_ASIO_MAPPING,
  asioService,
  type AsioDriverInfo,
  type AsioOutCount,
  type AsioOutputMapping,
} from '../audio/asioService';

interface Props {
  settings: Settings;
  engine: AudioEngine;
  sections?: Section[];
  onTestGuideVoice?: () => void;
  onChange: (p: Partial<Settings>) => void;
  onClose: () => void;
  onOpenRemote?: () => void;
}

export function SettingsDialog({ settings, engine, sections = [], onTestGuideVoice, onChange, onClose, onOpenRemote }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [dlStatus, setDlStatus] = useState<string | null>(null);

  // ASIO State
  const [asioDrivers, setAsioDrivers] = useState<AsioDriverInfo[]>([]);
  const [asioPanelFeedback, setAsioPanelFeedback] = useState<string | null>(null);
  const [currentMapping, setCurrentMapping] = useState<AsioOutputMapping>(() => settings.asioOutputMapping ?? DEFAULT_ASIO_MAPPING);
  const [modeSuccessMsg, setModeSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (settings.asioOutputMapping) {
      setCurrentMapping(settings.asioOutputMapping);
    }
  }, [settings.asioOutputMapping]);

  const activeDriverType = settings.audioDriverType ?? 'ASIO';

  const refreshAsioDrivers = async () => {
    try {
      const list = await asioService.getInstalledDrivers();
      setAsioDrivers(list);
      if (list.length > 0 && !settings.asioDriverName) {
        onChange({ asioDriverName: list[0].name });
      }
    } catch (e) {
      console.warn('Erro ao carregar drivers ASIO:', e);
    }
  };

  const handleOpenAsioPanel = async () => {
    setAsioPanelFeedback('Abrindo painel de controle ASIO…');
    try {
      const selected = asioDrivers.find((d) => d.name === settings.asioDriverName);
      const msg = await asioService.openControlPanel(
        settings.asioDriverName || 'ASIO4ALL v2',
        selected?.panel_path,
      );
      setAsioPanelFeedback(`✅ ${msg}`);
      setTimeout(() => setAsioPanelFeedback(null), 4000);
    } catch (err) {
      setAsioPanelFeedback(`❌ ${(err as Error).message}`);
    }
  };

  const handleSelectOutMode = (m: '2' | '4' | '6' | '8') => {
    const conf = ASIO_OUT_CONFIGS[m];
    const newMapping: AsioOutputMapping = { ...conf.mapping };

    setCurrentMapping(newMapping);
    onChange({
      asioOutputMapping: newMapping,
      smartRouting: m === '2',
    });

    engine.setAsioConfig(
      settings.audioDriverType || 'ASIO',
      settings.asioDriverName || 'ASIO4ALL v2',
      settings.asioBufferSize || 128,
      settings.asioSampleRate || 48000,
      newMapping,
    );

    setModeSuccessMsg(`🎉 ${conf.title} selecionado com sucesso! (${conf.desc})`);
    setTimeout(() => setModeSuccessMsg(null), 3500);
  };

  const updateMappingChannel = (key: keyof AsioOutputMapping, value: number) => {
    const next: AsioOutputMapping = {
      ...currentMapping,
      mode: 'custom',
      [key]: value,
    };
    setCurrentMapping(next);
    onChange({ asioOutputMapping: next });
    engine.setAsioConfig(
      settings.audioDriverType || 'ASIO',
      settings.asioDriverName || 'ASIO4ALL v2',
      settings.asioBufferSize || 128,
      settings.asioSampleRate || 48000,
      next,
    );
  };

  const refreshDevices = async (requestPermission = false) => {
    try {
      if (requestPermission && navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* user cancelled or no mic */
        }
      }
      let list = await navigator.mediaDevices?.enumerateDevices();
      if (list && list.some((d) => d.kind === 'audiooutput' && !d.label) && navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          list = await navigator.mediaDevices.enumerateDevices();
        } catch {
          /* ignore */
        }
      }
      if (list) {
        const outs = list.filter((x) => x.kind === 'audiooutput');
        setDevices(outs);
      }
    } catch (err) {
      console.warn('Erro ao atualizar dispositivos de áudio:', err);
    }
  };

  useEffect(() => {
    void refreshDevices();
    void refreshAsioDrivers();

    const handleDeviceChange = () => {
      void refreshDevices();
    };
    navigator.mediaDevices?.addEventListener('devicechange', handleDeviceChange);
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? []);
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', handleDeviceChange);
      window.speechSynthesis?.removeEventListener('voiceschanged', load);
    };
  }, []);

  const handleDownloadVoices = async () => {
    const activePack = settings.guideVoicePack ?? 'neural_pt_female';
    if (settings.guideVoice) {
      onChange({ guideVoice: '' });
    }
    setDlStatus('Baixando pacote completo de vozes neurais da internet…');
    const items = sections.map((s) => ({ label: s.label, type: s.type }));
    const count = await downloadOnlineGuidePack(
      engine.ctx,
      activePack,
      items,
      (done, total) => setDlStatus(`Baixando e salvando vozes neurais (${done}/${total})…`),
    );
    if (count > 0) {
      setDlStatus(`✅ ${count} chamadas de voz neural baixadas, salvas offline e ativas no canal Out 5 (Guia)!`);
      onTestGuideVoice?.();
    } else {
      setDlStatus('⚠️ Sem resposta do servidor de voz; verifique a conexão com a internet.');
    }
  };

  const selectedDriver = asioDrivers.find((d) => d.name === settings.asioDriverName) || asioDrivers[0];
  const activeMode: AsioOutCount = useMemo(() => {
    if (currentMapping.mode && currentMapping.mode !== 'custom') {
      return currentMapping.mode;
    }
    if (currentMapping.tracksOutL === 2 && currentMapping.guideOut === 1 && currentMapping.clickOut === 1) {
      return '2';
    }
    if (
      currentMapping.tracksOutL === 1 &&
      currentMapping.tracksOutR === 2 &&
      currentMapping.guideOut === 3 &&
      currentMapping.clickOut === 4
    ) {
      return '4';
    }
    if (
      currentMapping.tracksOutL === 1 &&
      currentMapping.tracksOutR === 2 &&
      currentMapping.altOutL === 3 &&
      currentMapping.altOutR === 4 &&
      currentMapping.guideOut === 5 &&
      currentMapping.clickOut === 6
    ) {
      return '6';
    }
    if (
      currentMapping.tracksOutL === 1 &&
      currentMapping.tracksOutR === 2 &&
      currentMapping.altOutL === 3 &&
      currentMapping.altOutR === 4 &&
      currentMapping.guideOut === 5 &&
      currentMapping.clickOut === 6 &&
      currentMapping.auxOutL === 7 &&
      currentMapping.auxOutR === 8
    ) {
      return '8';
    }
    return 'custom';
  }, [currentMapping]);
  const activeConfig = activeMode !== 'custom' ? ASIO_OUT_CONFIGS[activeMode] : null;

  return (
    <Modal
      title="Configurações de Áudio, Drivers ASIO & Roteamento Multi-Out"
      wide
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Concluir
        </button>
      }
    >
      <div className="settings">
        {/* REMOTE CONTROL VIA WI-FI SHORTCUT */}
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(0, 153, 255, 0.15), rgba(16, 185, 129, 0.12))',
            border: '1px solid #0099ff',
            borderRadius: 8,
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            boxShadow: '0 4px 16px rgba(0, 153, 255, 0.15)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#38bdf8' }}>
                📱 Servidor de Controle Remoto via Wi-Fi (iPad & Celular)
              </span>
              <span style={{ fontSize: 10, background: '#10b981', color: '#000', padding: '1px 6px', borderRadius: 10, fontWeight: 800 }}>
                ATIVO NA REDE
              </span>
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
              Controle Play, Pause, Seções (Live ReOrder) e Mixer de Faders em qualquer iPad, iPhone ou Android no mesmo Wi-Fi.
            </div>
          </div>
          {onOpenRemote && (
            <button
              className="btn small"
              style={{ background: '#0099ff', borderColor: '#0099ff', color: '#fff', fontWeight: 700, whiteSpace: 'nowrap' }}
              onClick={() => {
                onClose();
                onOpenRemote();
              }}
            >
              📱 Abrir QR Code & Link
            </button>
          )}
        </div>

        {/* DRIVER ARCHITECTURE SELECTOR */}
        <h3>⚡ Arquitetura de Áudio, Drivers ASIO & Mapeamento de Saídas Físicas</h3>

        {/* 3 ARCHITECTURE CARDS */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {/* 1. ASIO */}
          <div
            onClick={() => {
              onChange({ audioDriverType: 'ASIO', useDualAudioDevices: false });
              engine.setDualDeviceConfig(false, settings.outputDevice || '', '');
              engine.setAsioConfig('ASIO', settings.asioDriverName || 'ASIO4ALL v2', settings.asioBufferSize || 128, settings.asioSampleRate || 48000, currentMapping);
            }}
            style={{
              padding: 12,
              borderRadius: 8,
              cursor: 'pointer',
              background: !settings.useDualAudioDevices && activeDriverType === 'ASIO' ? 'rgba(0, 153, 255, 0.14)' : '#16181e',
              border: !settings.useDualAudioDevices && activeDriverType === 'ASIO' ? '2px solid #0099ff' : '1px solid #2e323b',
              boxShadow: !settings.useDualAudioDevices && activeDriverType === 'ASIO' ? '0 0 12px rgba(0, 153, 255, 0.25)' : 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              transition: 'all 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, color: !settings.useDualAudioDevices && activeDriverType === 'ASIO' ? '#38bdf8' : '#e2e8f0' }}>
              <span>⚡ Driver ASIO Profissional</span>
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              ASIO4ALL, Focusrite, Behringer UMC, Roland com controle de latência ultra-baixa.
            </div>
          </div>

          {/* 2. DUAL AUDIO DEVICES (Notebook + USB) */}
          <div
            onClick={() => {
              onChange({ useDualAudioDevices: true });
              handleSelectOutMode('4');
              engine.setDualDeviceConfig(true, settings.outputDevice || '', settings.secondaryOutputDevice || '');
            }}
            style={{
              padding: 12,
              borderRadius: 8,
              cursor: 'pointer',
              background: settings.useDualAudioDevices ? 'rgba(16, 185, 129, 0.15)' : '#16181e',
              border: settings.useDualAudioDevices ? '2px solid #10b981' : '1px solid #2e323b',
              boxShadow: settings.useDualAudioDevices ? '0 0 14px rgba(16, 185, 129, 0.3)' : 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              transition: 'all 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, color: settings.useDualAudioDevices ? '#34d399' : '#e2e8f0' }}>
              <span>🎧 2 Placas Juntas (Notebook + USB)</span>
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              4 saídas físicas reais: Placa USB (Tracks FOH) + Fone Notebook (Click & Guia).
            </div>
          </div>

          {/* 3. WASAPI Standard */}
          <div
            onClick={() => {
              onChange({ audioDriverType: 'WASAPI', useDualAudioDevices: false });
              engine.setDualDeviceConfig(false, settings.outputDevice || '', '');
              engine.setAsioConfig('WASAPI', 'WASAPI / WDM', settings.asioBufferSize || 128, settings.asioSampleRate || 48000, currentMapping);
            }}
            style={{
              padding: 12,
              borderRadius: 8,
              cursor: 'pointer',
              background: !settings.useDualAudioDevices && activeDriverType === 'WASAPI' ? 'rgba(0, 153, 255, 0.14)' : '#16181e',
              border: !settings.useDualAudioDevices && activeDriverType === 'WASAPI' ? '2px solid #0099ff' : '1px solid #2e323b',
              boxShadow: !settings.useDualAudioDevices && activeDriverType === 'WASAPI' ? '0 0 12px rgba(0, 153, 255, 0.25)' : 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              transition: 'all 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13, color: !settings.useDualAudioDevices && activeDriverType === 'WASAPI' ? '#38bdf8' : '#e2e8f0' }}>
              <span>🔊 WASAPI Padrão (Placa Única)</span>
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              Saída simples do Windows com opção de SmartRouting (Split L/R Cabo Y).
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* DUAL SOUNDCARD CONFIGURATION PANEL (Notebook + Placa USB)      */}
        {/* ============================================================== */}
        {settings.useDualAudioDevices && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, background: '#111317', border: '1px solid #10b981', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ fontSize: 13, color: '#34d399' }}>
                  🟢 Modo 2 Placas Simultâneas Ativo (4 Saídas Físicas 100% Isoladas):
                </strong>
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  Selecione qual placa tocará as músicas (P.A.) e qual placa tocará o Click & Guia (Fones).
                </div>
              </div>
              <button className="btn small" onClick={() => void refreshDevices(true)} title="Reconhecer novas placas USB">
                🔄 Reconhecer Placas
              </button>
            </div>

            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label>
                <span style={{ color: '#38bdf8', fontWeight: 700 }}>🎵 Placa 1 — Tracks FOH / P.A. (Canais 1 & 2):</span>
                <select
                  value={settings.outputDevice || ''}
                  onChange={(e) => {
                    const dev = e.target.value;
                    onChange({ outputDevice: dev });
                    engine.setDualDeviceConfig(true, dev, settings.secondaryOutputDevice || '');
                  }}
                >
                  <option value="">Padrão do Sistema (WASAPI / Placa USB)</option>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Interface de Áudio (${d.deviceId.slice(0, 8)})`}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span style={{ color: '#fbbf24', fontWeight: 700 }}>🎧 Placa 2 — Click & Guia Fones (Canais 3 & 4):</span>
                <select
                  value={settings.secondaryOutputDevice || ''}
                  onChange={(e) => {
                    const secDev = e.target.value;
                    onChange({ secondaryOutputDevice: secDev });
                    engine.setDualDeviceConfig(true, settings.outputDevice || '', secDev);
                  }}
                >
                  <option value="">Selecione a saída do Notebook / Fone de Ouvido</option>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Saída de Fone / Alto-falante (${d.deviceId.slice(0, 8)})`}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ background: '#0d0e11', border: '1px solid #232731', padding: 10, borderRadius: 6, fontSize: 11.5, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              <div><span style={{ color: '#38bdf8', fontWeight: 700 }}>Canal 1:</span> Tracks L (Placa 1)</div>
              <div><span style={{ color: '#38bdf8', fontWeight: 700 }}>Canal 2:</span> Tracks R (Placa 1)</div>
              <div><span style={{ color: '#fbbf24', fontWeight: 700 }}>Canal 3:</span> Voz Guia (Placa 2 L)</div>
              <div><span style={{ color: '#f87171', fontWeight: 700 }}>Canal 4:</span> Click Metrônomo (Placa 2 R)</div>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* ASIO CONFIGURATION PANEL                                       */}
        {/* ============================================================== */}
        {!settings.useDualAudioDevices && activeDriverType === 'ASIO' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, background: '#111317', border: '1px solid #272a33', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <label style={{ flex: 1 }}>
                Driver ASIO Conectado (Windows):
                <select
                  value={settings.asioDriverName ?? (asioDrivers[0]?.name || 'ASIO4ALL v2')}
                  onChange={(e) => {
                    const nextDriver = e.target.value;
                    onChange({ asioDriverName: nextDriver });
                    engine.setAsioConfig('ASIO', nextDriver, settings.asioBufferSize || 128, settings.asioSampleRate || 48000, currentMapping);
                  }}
                >
                  {asioDrivers.map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name} {d.description && d.description !== d.name ? `— (${d.description})` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <button
                className="btn small"
                style={{ background: '#0099ff', borderColor: '#0099ff', color: '#fff', fontWeight: 700 }}
                onClick={() => void handleOpenAsioPanel()}
                title="Abre a janela oficial de configuração e latência do driver ASIO no Windows"
              >
                ⚙️ Abrir Painel ASIO
              </button>

              <button
                className="btn small"
                onClick={() => void refreshAsioDrivers()}
                title="Escanear registro do Windows em busca de novos drivers ASIO"
              >
                🔄 Recarregar Drivers
              </button>
            </div>

            {/* Driver Specs & Details */}
            {selectedDriver && (
              <div style={{ background: '#16181e', border: '1px solid #232731', padding: '8px 12px', borderRadius: 6, fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ color: '#cbd5e1' }}>
                  <span style={{ color: '#34d399', fontWeight: 700 }}>🟢 Driver ASIO Ativo:</span> {selectedDriver.description || selectedDriver.name}
                  {selectedDriver.dll_path && <span className="muted" style={{ marginLeft: 8 }}>({selectedDriver.dll_path})</span>}
                </div>
                <div style={{ color: '#38bdf8', fontWeight: 600 }}>
                  Até {selectedDriver.max_channels} Saídas Físicas
                </div>
              </div>
            )}

            {asioPanelFeedback && (
              <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 6, background: asioPanelFeedback.includes('✅') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', border: `1px solid ${asioPanelFeedback.includes('✅') ? '#10b981' : '#ef4444'}`, color: asioPanelFeedback.includes('✅') ? '#6ee7b7' : '#fca5a5' }}>
                {asioPanelFeedback}
              </div>
            )}

            {/* Latency & Sample Rate Controls */}
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <label>
                Buffer Size / Latência em Amostras
                <select
                  value={settings.asioBufferSize ?? 128}
                  onChange={(e) => {
                    const buf = parseInt(e.target.value, 10);
                    onChange({ asioBufferSize: buf });
                    engine.setAsioConfig('ASIO', settings.asioDriverName || 'ASIO4ALL v2', buf, settings.asioSampleRate || 48000, currentMapping);
                  }}
                >
                  <option value={64}>64 samples (1.3 ms) — Ultra Baixa Latência</option>
                  <option value={128}>128 samples (2.7 ms) — Recomendado para Palco</option>
                  <option value={256}>256 samples (5.3 ms) — Alta Estabilidade</option>
                  <option value={512}>512 samples (10.7 ms) — Modo Seguro</option>
                  <option value={1024}>1024 samples (21.3 ms) — Modo Econômico</option>
                </select>
              </label>

              <label>
                Taxa de Amostragem (Sample Rate)
                <select
                  value={settings.asioSampleRate ?? 48000}
                  onChange={(e) => {
                    const sr = parseInt(e.target.value, 10);
                    onChange({ asioSampleRate: sr });
                    engine.setAsioConfig('ASIO', settings.asioDriverName || 'ASIO4ALL v2', settings.asioBufferSize || 128, sr, currentMapping);
                  }}
                >
                  <option value={44100}>44.100 Hz (44.1 kHz - CD Audio)</option>
                  <option value={48000}>48.000 Hz (48.0 kHz - Padrão Profissional MultiTracks)</option>
                  <option value={96000}>96.000 Hz (96.0 kHz - Alta Resolução)</option>
                </select>
              </label>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* WASAPI STANDARD SELECTION                                      */}
        {/* ============================================================== */}
        {!settings.useDualAudioDevices && activeDriverType === 'WASAPI' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: '#111317', border: '1px solid #272a33', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <label style={{ flex: 1 }}>
                Interface / Saída de Áudio WASAPI:
                <select value={settings.outputDevice} onChange={(e) => onChange({ outputDevice: e.target.value })}>
                  <option value="">Padrão do Sistema (WASAPI / Alto-falantes)</option>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Saída de Áudio (${d.deviceId.slice(0, 8)})`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn small"
                onClick={() => void refreshDevices(true)}
                title="Atualizar lista e buscar novas interfaces USB conectadas"
              >
                🔄 Buscar Novas Placas USB
              </button>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={settings.smartRouting}
                onChange={(e) => onChange({ smartRouting: e.target.checked })}
              />
              <span>
                <strong>SmartRouting™ Split L/R (Cabo Y / 2 Canais):</strong> Isola 100% <b>Click & Guia no Canal L (Out 1)</b>{' '}
                e <b>Backing Tracks 100% no Canal R (Out 2)</b> sem vazamento! (Desmarque para ouvir todos os canais em Estéreo normal).
              </span>
            </label>
          </div>
        )}

        {/* ============================================================== */}
        {/* MULTI-OUT PHYSICAL SELECTOR: 2 OUTS, 4 OUTS, 6 OUTS, 8 OUTS   */}
        {/* ============================================================== */}
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 12, background: '#16181e', border: '1px solid #2e323b', padding: 14, borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong style={{ fontSize: 13, color: '#f8fafc' }}>
                🎛️ Matriz de Mapeamento de Saídas Físicas (MultiOuts):
              </strong>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                Selecione quantos canais de saída física você deseja utilizar na sua placa / setup:
              </div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8' }}>
              {activeMode === 'custom' ? '⚙️ Modo Personalizado' : `⚡ ${activeMode} OUTS ATIVO`}
            </div>
          </div>

          {/* 4 PROMINENT BUTTONS FOR 2, 4, 6, 8 OUTS */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {(['2', '4', '6', '8'] as const).map((m) => {
              const isSelected = activeMode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleSelectOutMode(m)}
                  style={{
                    padding: '12px 6px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontWeight: 800,
                    fontSize: 13,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    transition: 'all 0.15s ease',
                    background: isSelected ? 'linear-gradient(135deg, #0099ff, #0284c7)' : '#101216',
                    color: isSelected ? '#ffffff' : '#94a3b8',
                    border: isSelected ? '2px solid #38bdf8' : '1px solid #272a33',
                    boxShadow: isSelected ? '0 0 16px rgba(0, 153, 255, 0.45)' : 'none',
                    transform: isSelected ? 'scale(1.02)' : 'scale(1)',
                  }}
                >
                  <span style={{ fontSize: 15 }}>
                    {m === '2' ? '🎧 2 OUTS' : m === '4' ? '🔊 4 OUTS' : m === '6' ? '🎛️ 6 OUTS' : '🏛️ 8 OUTS'}
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 500, opacity: isSelected ? 0.95 : 0.7 }}>
                    {m === '2' ? 'Split Cabo Y' : m === '4' ? 'Palco Estéreo' : m === '6' ? 'Pro Discreto' : 'Igreja FOH'}
                  </span>
                </button>
              );
            })}
          </div>

          {modeSuccessMsg && (
            <div style={{ background: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#34d399', padding: '8px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 600 }}>
              {modeSuccessMsg}
            </div>
          )}

          {/* Active Mode Explanation Banner */}
          {activeConfig && (
            <div
              style={{
                background: '#0d0e11',
                border: '1px solid #0099ff',
                borderRadius: 6,
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#38bdf8' }}>
                    ✅ {activeConfig.label}
                  </span>
                  <span style={{ fontSize: 10, background: 'rgba(0, 153, 255, 0.2)', color: '#38bdf8', padding: '2px 8px', borderRadius: 10, fontWeight: 700 }}>
                    {activeConfig.badge}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: '#cbd5e1', marginTop: 4, lineHeight: 1.5 }}>
                  {activeConfig.desc}
                </div>
              </div>
            </div>
          )}

          {/* Physical Channels Grid Customizer */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            {/* Master Tracks */}
            <div style={{ background: '#101216', border: '1px solid #232731', padding: 10, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 12, color: '#38bdf8' }}>🎵 Tracks (P.A. / FOH)</strong>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>
                  {activeMode === '2' ? 'Mono (Ch 2)' : 'Estéreo'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ flex: 1, fontSize: 11 }}>
                  Saída L:
                  <select
                    value={currentMapping.tracksOutL}
                    onChange={(e) => updateMappingChannel('tracksOutL', parseInt(e.target.value, 10))}
                    style={{ fontSize: 11 }}
                  >
                    {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                      <option key={ch} value={ch}>Canal {ch}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1, fontSize: 11 }}>
                  Saída R:
                  <select
                    value={currentMapping.tracksOutR}
                    onChange={(e) => updateMappingChannel('tracksOutR', parseInt(e.target.value, 10))}
                    style={{ fontSize: 11 }}
                  >
                    {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                      <option key={ch} value={ch}>Canal {ch}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {/* Alt Tracks */}
            <div style={{ background: '#101216', border: '1px solid #232731', padding: 10, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 12, color: '#a78bfa' }}>🎹 Alt / Teclados / Pads</strong>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>Estéreo Aux</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ flex: 1, fontSize: 11 }}>
                  Saída L:
                  <select
                    value={currentMapping.altOutL}
                    onChange={(e) => updateMappingChannel('altOutL', parseInt(e.target.value, 10))}
                    style={{ fontSize: 11 }}
                  >
                    {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                      <option key={ch} value={ch}>Canal {ch}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1, fontSize: 11 }}>
                  Saída R:
                  <select
                    value={currentMapping.altOutR}
                    onChange={(e) => updateMappingChannel('altOutR', parseInt(e.target.value, 10))}
                    style={{ fontSize: 11 }}
                  >
                    {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                      <option key={ch} value={ch}>Canal {ch}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {/* Guide Voice */}
            <div style={{ background: '#101216', border: '1px solid #232731', padding: 10, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 12, color: '#fbbf24' }}>🗣️ Voz Guia (Fones)</strong>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>Canal Mono</span>
              </div>
              <label style={{ fontSize: 11 }}>
                Canal Físico:
                <select
                  value={currentMapping.guideOut}
                  onChange={(e) => updateMappingChannel('guideOut', parseInt(e.target.value, 10))}
                  style={{ fontSize: 11 }}
                >
                  {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                    <option key={ch} value={ch}>Canal {ch}</option>
                  ))}
                </select>
              </label>
            </div>

            {/* Click */}
            <div style={{ background: '#101216', border: '1px solid #232731', padding: 10, borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 12, color: '#f87171' }}>⏱️ Click / Metrônomo</strong>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>Canal Mono Bateria</span>
              </div>
              <label style={{ fontSize: 11 }}>
                Canal Físico:
                <select
                  value={currentMapping.clickOut}
                  onChange={(e) => updateMappingChannel('clickOut', parseInt(e.target.value, 10))}
                  style={{ fontSize: 11 }}
                >
                  {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                    <option key={ch} value={ch}>Canal {ch}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* PHYSICAL OUTPUT TEST TONES: INDIVIDUAL SEPARATE CHANNEL BUTTONS */}
        {/* ============================================================== */}
        <div className="ai-gemini-box" style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 12.5, color: '#38bdf8' }}>
              🔊 Testador Individual de Canais Físicos (Isolamento 100% sem vazamento):
            </strong>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              Clique para testar cada saída física separadamente
            </span>
          </div>

          {/* INDIVIDUAL DISCRETE BUTTONS: CANAL 1, CANAL 2, CANAL 3, CANAL 4... */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 8 }}>
            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #38bdf8', color: '#38bdf8', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(1)}
              title="Testa Canal 1 Físico (Tracks L / 440 Hz)"
            >
              🔊 Testar Canal 1 (Tracks L)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #38bdf8', color: '#38bdf8', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(2)}
              title="Testa Canal 2 Físico (Tracks R / 554 Hz)"
            >
              🔊 Testar Canal 2 (Tracks R)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #fbbf24', color: '#fbbf24', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(3)}
              title="Testa Canal 3 Físico (Voz Guia Fones / 659 Hz)"
            >
              🔊 Testar Canal 3 (Voz Guia)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #f87171', color: '#f87171', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(4)}
              title="Testa Canal 4 Físico (Click Metrônomo / 880 Hz)"
            >
              🔊 Testar Canal 4 (Click Metrônomo)
            </button>

            {(activeMode === '6' || activeMode === '8') && (
              <>
                <button
                  type="button"
                  className="btn small"
                  style={{ background: '#0f172a', border: '1px solid #a78bfa', color: '#a78bfa', fontWeight: 700 }}
                  onClick={() => engine.playPhysicalChannelTestTone(5)}
                  title="Testa Canal 5 Físico (Alt L / 740 Hz)"
                >
                  🔊 Testar Canal 5 (Alt L)
                </button>

                <button
                  type="button"
                  className="btn small"
                  style={{ background: '#0f172a', border: '1px solid #a78bfa', color: '#a78bfa', fontWeight: 700 }}
                  onClick={() => engine.playPhysicalChannelTestTone(6)}
                  title="Testa Canal 6 Físico (Alt R / 830 Hz)"
                >
                  🔊 Testar Canal 6 (Alt R)
                </button>
              </>
            )}

            {activeMode === '8' && (
              <>
                <button
                  type="button"
                  className="btn small"
                  style={{ background: '#0f172a', border: '1px solid #34d399', color: '#34d399', fontWeight: 700 }}
                  onClick={() => engine.playPhysicalChannelTestTone(7)}
                  title="Testa Canal 7 Físico (Aux L / 987 Hz)"
                >
                  🔊 Testar Canal 7 (Aux L)
                </button>

                <button
                  type="button"
                  className="btn small"
                  style={{ background: '#0f172a', border: '1px solid #34d399', color: '#34d399', fontWeight: 700 }}
                  onClick={() => engine.playPhysicalChannelTestTone(8)}
                  title="Testa Canal 8 Físico (Aux R / 1046 Hz)"
                >
                  🔊 Testar Canal 8 (Aux R)
                </button>
              </>
            )}
          </div>
        </div>

        {/* GUIDE VOICES & AI ANNOUNCEMENTS */}
        <h3>🎙️ Vozes da Guia Automática (Internet Neural TTS & Vozes IA)</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.guideEnabled}
            onChange={(e) => onChange({ guideEnabled: e.target.checked })}
          />
          Anunciar seções (“Intro”, “Verso 1”, “Refrão”, “Ponte”…) um compasso antes da mudança
        </label>

        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label>
            Pacote de Voz IA / Internet (PT-BR, PT-EU & EN-US)
            <select
              value={settings.guideVoicePack ?? 'neural_pt_female'}
              onChange={(e) => {
                const nextPack = e.target.value;
                onChange({
                  guideVoicePack: nextPack,
                  guideVoice: nextPack === 'system_native' ? settings.guideVoice : '',
                });
              }}
            >
              {GUIDE_VOICE_PACKS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Voz Nativa do Sistema (Apenas se "Voz Nativa do Windows" estiver ativa)
            <select
              value={settings.guideVoice}
              onChange={(e) =>
                onChange({
                  guideVoice: e.target.value,
                  guideVoicePack: e.target.value ? 'system_native' : settings.guideVoicePack,
                })
              }
            >
              <option value="">✨ Usar Pacote de Voz Neural / IA selecionado ao lado</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label>
            Tom da Voz Guia (Pitch): {(settings.guidePitch ?? 1.0).toFixed(2)}x
            <input
              type="range"
              min={0.7}
              max={1.4}
              step={0.02}
              value={settings.guidePitch ?? 1.0}
              onChange={(e) => onChange({ guidePitch: parseFloat(e.target.value) })}
            />
          </label>
          <label>
            Velocidade da Voz Guia: {(settings.guideRate ?? 1.12).toFixed(2)}x
            <input
              type="range"
              min={0.85}
              max={1.5}
              step={0.02}
              value={settings.guideRate ?? 1.12}
              onChange={(e) => onChange({ guideRate: parseFloat(e.target.value) })}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn small primary" onClick={handleDownloadVoices}>
            🌐 Buscar & Baixar Vozes Neurais da Internet (Roteamento Out 5)
          </button>
          <button className="btn small" onClick={onTestGuideVoice}>
            🔊 Ouvir Prévia da Voz Guia
          </button>
          {dlStatus && <span className="muted">{dlStatus}</span>}
        </div>

        {/* UI RESIZE CONTROLS */}
        <h3>📐 Tamanho das Áreas da Interface (Redimensionamento)</h3>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label>
            Altura da Waveform / Timeline: {settings.timelineHeight ?? 145}px
            <input
              type="range"
              min={90}
              max={340}
              step={5}
              value={settings.timelineHeight ?? 145}
              onChange={(e) => onChange({ timelineHeight: parseInt(e.target.value, 10) })}
            />
          </label>
          <label>
            Altura dos Faders / Mixer: {settings.mixerHeight ?? 280}px
            <input
              type="range"
              min={190}
              max={500}
              step={5}
              value={settings.mixerHeight ?? 280}
              onChange={(e) => onChange({ mixerHeight: parseInt(e.target.value, 10) })}
            />
          </label>
        </div>

        <h3>Reprodução & Transições</h3>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <label>
            Quantização de salto padrão
            <select
              value={settings.jumpMode}
              onChange={(e) => onChange({ jumpMode: e.target.value as Settings['jumpMode'] })}
            >
              <option value="now">Imediato</option>
              <option value="bar">Próximo compasso (Quantizado)</option>
              <option value="section">Fim da seção atual (Arranjo Dinâmico)</option>
            </select>
          </label>
          <label>
            Duração do Fade Out: {settings.fadeSeconds}s
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={settings.fadeSeconds}
              onChange={(e) => onChange({ fadeSeconds: parseInt(e.target.value, 10) })}
            />
          </label>
        </div>
      </div>
    </Modal>
  );
}
