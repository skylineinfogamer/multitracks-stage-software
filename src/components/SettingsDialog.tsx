import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import type { Section } from '../types';
import type { Settings } from '../storage';
import type { AudioEngine } from '../audio/engine';
import {
  GUIDE_VOICE_PACKS,
  downloadOnlineGuidePack,
  playIsolatedGuidePreview,
  stopGuidePreview,
} from '../audio/guideVoices';
import { Modal } from './Modal';

interface Props {
  settings: Settings;
  engine: AudioEngine;
  sections?: Section[];
  onChange: (p: Partial<Settings>) => void;
  onClose: () => void;
  onOpenRemote?: () => void;
  onCheckForUpdates?: () => void;
  isCheckingUpdates?: boolean;
  onTestGuideVoice?: () => void;
}

export function SettingsDialog({
  settings,
  engine,
  sections = [],
  onChange,
  onClose,
  onOpenRemote,
  onCheckForUpdates,
  isCheckingUpdates,
  onTestGuideVoice,
}: Props) {
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [dlStatus, setDlStatus] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getVersion()
      .then((v) => {
        if (mounted && v) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);


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
      setDlStatus(`✅ ${count} chamadas de voz neural baixadas, salvas offline e prontas para uso no palco.`);
    } else {
      setDlStatus('⚠️ Sem resposta do servidor de voz; verifique a conexão com a internet.');
    }
  };

  const detectedChannels = engine.getDetectedPhysicalChannels();

  const handleClose = () => {
    void engine.stopPhysicalChannelTestTone();
    void stopGuidePreview();
    onClose();
  };

  const handlePreviewGuideVoice = () => {
    const sampleText = sections[0]?.label || 'Refrão';
    void playIsolatedGuidePreview(
      settings.guideVoicePack ?? 'neural_pt_female',
      settings.guideVoice ?? '',
      settings.autoGuideVolume ?? 0.9,
      settings.guidePitch ?? 1.0,
      settings.guideRate ?? 1.12,
      sampleText,
    );
  };

  return (
    <Modal
      title="Configurações de Áudio, Drivers WASAPI & Roteamento Multi-Out"
      wide
      onClose={handleClose}
      footer={
        <button className="btn primary" onClick={handleClose}>
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

        {/* AUTO-UPDATER & VERSION INFO */}
        <div
          style={{
            marginBottom: 20,
            padding: '14px 18px',
            backgroundColor: '#16181E',
            border: '1px solid #2E323B',
            borderRadius: 10,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#FFFFFF' }}>
                🚀 Worship Tools
              </span>
              <span
                style={{
                  fontSize: 10.5,
                  background: 'rgba(0, 153, 255, 0.2)',
                  color: '#38BDF8',
                  padding: '2px 8px',
                  borderRadius: 8,
                  fontWeight: 700,
                  border: '1px solid rgba(0, 153, 255, 0.3)',
                }}
              >
                Versão {appVersion}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
              Atualizações automáticas com verificação de integridade digital via Backblaze B2 e GitHub.
            </div>
          </div>
          {onCheckForUpdates && (
            <button
              className="btn small"
              disabled={isCheckingUpdates}
              style={{
                backgroundColor: '#1F242D',
                borderColor: '#2E323B',
                color: '#E5E7EB',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: isCheckingUpdates ? 'wait' : 'pointer',
              }}
              onClick={onCheckForUpdates}
            >
              {isCheckingUpdates ? '🔄 Verificando…' : '🔄 Verificar Atualizações'}
            </button>
          )}
        </div>

        {/* DEVELOPER CREDIT */}
        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: '1px solid #2E323B',
            textAlign: 'center',
            color: '#6B7280',
            fontSize: 11.5,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: '#9CA3AF', marginBottom: 4 }}>
            Desenvolvido por Leandro Machado
          </div>
          <div style={{ fontSize: 10.5, opacity: 0.7 }}>
            Worship Tools — Plataforma Profissional de Multitracks para Ministério de Louvor
          </div>
        </div>

        {/* DISPOSITIVO DE ÁUDIO WASAPI ÚNICO */}
        <h3>⚡ Dispositivo de Áudio WASAPI (Windows Pro Audio)</h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, background: '#111317', border: '1px solid #272a33', borderRadius: 8, padding: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label style={{ flex: 1 }}>
              <span style={{ fontWeight: 700, color: '#f8fafc' }}>
                Dispositivo de Saída de Áudio (WASAPI Windows):
              </span>
              <select
                value={settings.outputDevice || ''}
                onChange={async (e) => {
                  const dev = e.target.value;
                  onChange({ outputDevice: dev });
                  await engine.setOutputDevice(dev);
                }}
              >
                <option value="">Padrão do Sistema (WASAPI / Alto-falantes)</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Interface de Áudio WASAPI (${d.deviceId.slice(0, 8)})`}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn small"
              onClick={() => void refreshDevices(true)}
              title="Atualizar lista e buscar novas interfaces USB conectadas"
            >
              🔄 Buscar Placas USB
            </button>
          </div>

          {/* Pro Audio Priority Status */}
          <div style={{ background: '#16181e', border: '1px solid #232731', padding: '8px 12px', borderRadius: 6, fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ color: '#cbd5e1' }}>
              <span style={{ color: '#34d399', fontWeight: 700 }}>🟢 Placa Ativa:</span>{' '}
              {settings.outputDevice ? devices.find((d) => d.deviceId === settings.outputDevice)?.label || 'Dispositivo Selecionado' : 'Padrão do Sistema (WASAPI)'}{' '}
              · <strong style={{ color: '#38bdf8' }}>{detectedChannels} Canais Físicos</strong>
            </div>
            <div style={{ color: '#38bdf8', fontWeight: 600 }}>
              MMCSS 1.0ms • WASAPI Nativo
            </div>
          </div>

          {/* Latency & Sample Rate Controls */}
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <label>
              Buffer Size / Latência em Amostras
              <select
                value={settings.asioBufferSize ?? 128}
                onChange={(e) => {
                  const buf = parseInt(e.target.value, 10);
                  onChange({ asioBufferSize: buf });
                  engine.setAsioConfig('WASAPI', 'WASAPI Nativo', buf, settings.asioSampleRate || 48000);
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
                  engine.setAsioConfig('WASAPI', 'WASAPI Nativo', settings.asioBufferSize || 128, sr);
                }}
              >
                <option value={44100}>44.100 Hz (44.1 kHz - CD Audio)</option>
                <option value={48000}>48.000 Hz (48.0 kHz - Padrão Profissional MultiTracks)</option>
                <option value={96000}>96.000 Hz (96.0 kHz - Alta Resolução)</option>
              </select>
            </label>
          </div>
        </div>

        {/* ============================================================== */}
        {/* DYNAMIC HARDWARE DETECTION & FREE DIRECT ROUTING INFO          */}
        {/* ============================================================== */}
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 12, background: '#16181e', border: '1px solid #2e323b', padding: 14, borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <strong style={{ fontSize: 13, color: '#f8fafc' }}>
                🎛️ Deteção Dinâmica de Hardware & Roteamento 100% Livre:
              </strong>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                Todas as saídas físicas disponíveis são detectadas automaticamente sem restrições ou matrizes fixas.
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  background: 'rgba(56, 189, 248, 0.15)',
                  color: '#38bdf8',
                  padding: '3px 10px',
                  borderRadius: 12,
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                }}
              >
                ⚡ {detectedChannels} CANAIS FÍSICOS DISPONÍVEIS
              </span>
            </div>
          </div>

          {/* DYNAMIC HARDWARE CHANNELS SUMMARY */}
          <div style={{ background: '#101216', border: '1px solid #232731', padding: 12, borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: '#38bdf8', fontWeight: 700, marginBottom: 4 }}>
              🔊 Placa de Áudio WASAPI Ativa:
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#f8fafc' }}>
              {detectedChannels} Canais Físicos de Saída Disponíveis
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              {settings.outputDevice ? devices.find((d) => d.deviceId === settings.outputDevice)?.label || 'Dispositivo selecionado' : 'Dispositivo padrão do sistema (WASAPI)'}
            </div>
          </div>

          {/* DIRECT ROUTING EXPLANATION */}
          <div
            style={{
              background: '#0d0e11',
              border: '1px solid #0099ff',
              borderRadius: 6,
              padding: '10px 14px',
              fontSize: 11.5,
              color: '#cbd5e1',
              lineHeight: 1.5,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: '#38bdf8', marginBottom: 4 }}>
              <span>✅</span> Roteamento Direto e Independente por Fader:
            </div>
            <div>
              Sem matrizes rígidas ou imposições fixas: cada fader no Mixer (Backing Tracks, Click e Voz Guia) possui seu seletor de saída direto (Out 1 a Out 8). Você decide livremente para onde cada sinal vai em tempo real com zero crosstalk e 100% de separação discreta.
            </div>
          </div>

          {/* SPLIT 2-OUTS (CABO Y) QUICK TOGGLE */}
          <div
            style={{
              background: settings.smartRouting ? 'rgba(0, 153, 255, 0.12)' : '#101216',
              border: settings.smartRouting ? '1px solid #0099ff' : '1px solid #232731',
              borderRadius: 6,
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: settings.smartRouting ? '#38bdf8' : '#e2e8f0' }}>
                🎧 Modo Split 2 Saídas (Cabo Y Mono Split):
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                Para setups móveis sem placa multicanal: Canal 1 (L) para Fones (Click & Guia) e Canal 2 (R) para o P.A. (Músicas).
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0 }}>
              <input
                type="checkbox"
                checked={settings.smartRouting}
                onChange={(e) => {
                  const val = e.target.checked;
                  onChange({ smartRouting: val });
                  engine.setSmartRouting(val);
                }}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontSize: 12, fontWeight: 600, color: settings.smartRouting ? '#38bdf8' : '#94a3b8' }}>
                {settings.smartRouting ? 'Ativo' : 'Desativado'}
              </span>
            </label>
          </div>
        </div>

        {/* ============================================================== */}
        {/* PHYSICAL OUTPUT TEST TONES: INDIVIDUAL SEPARATE CHANNEL BUTTONS */}
        {/* ============================================================== */}
        <div className="ai-gemini-box" style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 12.5, color: '#38bdf8' }}>
              🔊 Testador Individual de Canais Físicos (Zero Crosstalk / Isolamento Absoluto):
            </strong>
            <button
              type="button"
              className="btn small"
              style={{ background: '#450a0a', border: '1px solid #ef4444', color: '#fca5a5', fontWeight: 700, padding: '2px 8px' }}
              onClick={() => engine.stopPhysicalChannelTestTone()}
              title="Corta imediatamente qualquer tom de teste em execução"
            >
              ⏹️ Silenciar Teste
            </button>
          </div>

          {/* INDIVIDUAL DISCRETE BUTTONS: CANAL 1, CANAL 2, CANAL 3, CANAL 4... */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 8 }}>
            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #38bdf8', color: '#38bdf8', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(1)}
              title="Testa Canal 1 Físico (Out 1 / 440 Hz)"
            >
              🔊 Testar Canal 1 (Out 1)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #38bdf8', color: '#38bdf8', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(2)}
              title="Testa Canal 2 Físico (Out 2 / 554 Hz)"
            >
              🔊 Testar Canal 2 (Out 2)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #fbbf24', color: '#fbbf24', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(3)}
              title="Testa Canal 3 Físico (Out 3 / 659 Hz)"
            >
              🔊 Testar Canal 3 (Out 3)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #f87171', color: '#f87171', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(4)}
              title="Testa Canal 4 Físico (Out 4 / 880 Hz)"
            >
              🔊 Testar Canal 4 (Out 4)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #a78bfa', color: '#a78bfa', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(5)}
              title="Testa Canal 5 Físico (Out 5 / 740 Hz)"
            >
              🔊 Testar Canal 5 (Out 5)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #a78bfa', color: '#a78bfa', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(6)}
              title="Testa Canal 6 Físico (Out 6 / 830 Hz)"
            >
              🔊 Testar Canal 6 (Out 6)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #34d399', color: '#34d399', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(7)}
              title="Testa Canal 7 Físico (Out 7 / 987 Hz)"
            >
              🔊 Testar Canal 7 (Out 7)
            </button>

            <button
              type="button"
              className="btn small"
              style={{ background: '#0f172a', border: '1px solid #34d399', color: '#34d399', fontWeight: 700 }}
              onClick={() => engine.playPhysicalChannelTestTone(8)}
              title="Testa Canal 8 Físico (Out 8 / 1046 Hz)"
            >
              🔊 Testar Canal 8 (Out 8)
            </button>
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
          <button className="btn small" onClick={handlePreviewGuideVoice}>
            🔊 Ouvir Prévia da Voz Guia
          </button>
          {onTestGuideVoice && (
            <button className="btn small" onClick={onTestGuideVoice}>
              🎤 Testar Voz Guia (Live)
            </button>
          )}
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
