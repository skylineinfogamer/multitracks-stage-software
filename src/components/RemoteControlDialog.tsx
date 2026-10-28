import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { remoteControlService, type RemoteServerInfo } from '../services/remoteControlService';
import { openExternalUrl } from '../utils/openUrl';

interface Props {
  onClose: () => void;
  connectedClients: number;
}

export function RemoteControlDialog({ onClose, connectedClients }: Props) {
  const [serverInfo, setServerInfo] = useState<RemoteServerInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [portInput, setPortInput] = useState(3000);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    void remoteControlService.getStatus().then((info) => {
      setServerInfo(info);
      setPortInput(info.port);
    });
  }, []);

  const handleCopy = async () => {
    if (!serverInfo) return;
    try {
      await navigator.clipboard.writeText(serverInfo.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* ignore */
    }
  };

  const handleOpenBrowser = async () => {
    if (!serverInfo) return;
    await openExternalUrl(serverInfo.url);
  };

  const handleSelectIp = async (ip: string) => {
    try {
      const updated = await remoteControlService.setRemoteIp(ip);
      setServerInfo(updated);
    } catch (e) {
      console.warn('Erro ao alterar IP do servidor:', e);
    }
  };

  const handleRestartServer = async () => {
    setIsStarting(true);
    try {
      const info = await remoteControlService.startServer(portInput, serverInfo?.ip);
      setServerInfo(info);
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Modal
      title="📱 Controle Remoto via Navegador (iPad, iPhone & Android)"
      wide
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Status Bar */}
        <div
          style={{
            background: '#16181e',
            border: '1px solid #282c37',
            padding: '12px 16px',
            borderRadius: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: serverInfo?.running ? '#10b981' : '#ef4444',
                boxShadow: serverInfo?.running ? '0 0 10px #10b981' : 'none',
              }}
            />
            <div>
              <strong style={{ fontSize: 13, color: '#f8fafc' }}>
                {serverInfo?.running
                  ? `Servidor WebSocket Ativo na Porta ${serverInfo.port}`
                  : 'Servidor Desconectado'}
              </strong>
              <div className="muted" style={{ fontSize: 11 }}>
                IP da Máquina: <span style={{ color: '#38bdf8' }}>{serverInfo?.ip || 'Detectando...'}</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                background: connectedClients > 0 ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                border: `1px solid ${connectedClients > 0 ? '#10b981' : '#333846'}`,
                color: connectedClients > 0 ? '#34d399' : '#94a3b8',
                padding: '4px 10px',
                borderRadius: 20,
              }}
            >
              👥 {connectedClients} {connectedClients === 1 ? 'dispositivo conectado' : 'dispositivos conectados'}
            </span>

            <button
              className="btn small"
              onClick={() => void handleRestartServer()}
              disabled={isStarting}
              title="Reiniciar servidor na porta especificada"
            >
              {isStarting ? 'Iniciando…' : '🔄 Reiniciar'}
            </button>
          </div>
        </div>

        {/* Main Columns: QR Code + Connection Details */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 240px) 1fr', gap: 16 }}>
          {/* QR Code Container */}
          <div
            style={{
              background: '#111317',
              border: '2px solid #0099ff',
              borderRadius: 12,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              boxShadow: '0 0 20px rgba(0, 153, 255, 0.2)',
            }}
          >
            {serverInfo?.qr_svg ? (
              <div
                style={{
                  width: 180,
                  height: 180,
                  background: '#0d0e11',
                  padding: 8,
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                dangerouslySetInnerHTML={{ __html: serverInfo.qr_svg }}
              />
            ) : (
              <div style={{ width: 180, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                Gerando QR Code…
              </div>
            )}
            <div style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8', textAlign: 'center' }}>
              📷 Aponte a câmera do iPad ou Celular
            </div>
          </div>

          {/* Connection URL & Instructions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* IP Selector */}
            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1' }}>
                🌐 Endereço IP / Interface de Rede Local:
              </label>
              <select
                value={serverInfo?.ip || ''}
                onChange={(e) => void handleSelectIp(e.target.value)}
                style={{
                  width: '100%',
                  marginTop: 4,
                  background: '#0d0e11',
                  border: '1px solid #0099ff',
                  padding: '8px 10px',
                  borderRadius: 6,
                  color: '#38bdf8',
                  fontWeight: 700,
                  fontSize: 12.5,
                }}
              >
                {(serverInfo?.available_ips || [serverInfo?.ip || '127.0.0.1']).map((ip) => {
                  const is192 = ip.startsWith('192.168.');
                  const isVpn = ip.startsWith('26.') || ip.startsWith('25.');
                  const label = is192
                    ? `🟢 ${ip} (Rede Wi-Fi / Ethernet Local — Recomendado)`
                    : isVpn
                      ? `⚠️ ${ip} (VPN Radmin/Hamachi — Não use para celular no Wi-Fi)`
                      : `🔹 ${ip} (Outra Interface)`;
                  return (
                    <option key={ip} value={ip}>
                      {label}
                    </option>
                  );
                })}
              </select>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                Selecione o IP do seu roteador (geralmente começando com <b style={{ color: '#38bdf8' }}>192.168.x.x</b>) para que os celulares no Wi-Fi consigam acessar.
              </div>
            </div>

            <div>
              <label style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1' }}>
                Link de Acesso Direto no Navegador (Safari / Chrome):
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <input
                  type="text"
                  readOnly
                  value={serverInfo?.url || ''}
                  style={{
                    flex: 1,
                    background: '#0d0e11',
                    border: '1px solid #333846',
                    padding: '8px 12px',
                    borderRadius: 6,
                    color: '#38bdf8',
                    fontFamily: 'monospace',
                    fontSize: 12.5,
                  }}
                />
                <button
                  className="btn"
                  onClick={() => void handleCopy()}
                  style={{ background: copied ? '#10b981' : undefined }}
                >
                  {copied ? '✅ Copiado!' : '📋 Copiar'}
                </button>
                <button className="btn" onClick={() => void handleOpenBrowser()} title="Abrir no navegador deste PC para testar">
                  🌐 Abrir
                </button>
              </div>
            </div>

            {/* Step-by-Step Stage Setup Guide */}
            <div
              style={{
                background: '#14161c',
                border: '1px solid #232731',
                borderRadius: 8,
                padding: '12px 14px',
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <strong style={{ color: '#f8fafc', fontSize: 12.5 }}>
                🚀 Como Usar no Palco / Igreja:
              </strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, color: '#cbd5e1' }}>
                <div>
                  <span style={{ color: '#0099ff', fontWeight: 700 }}>1. Mesma Rede Wi-Fi:</span> Conecte o seu iPad, iPhone ou Android no mesmo Wi-Fi que este computador está conectado (mesmo que seja um roteador sem internet).
                </div>
                <div>
                  <span style={{ color: '#0099ff', fontWeight: 700 }}>2. Sem Instalar Nada:</span> Apenas aponte a câmera ou abra o navegador no endereço acima. O app remoto carrega imediatamente em tela cheia.
                </div>
                <div>
                  <span style={{ color: '#0099ff', fontWeight: 700 }}>3. Controle em Tempo Real:</span> Dê Play, Pause, Fade Out, pule seções ao vivo (Live ReOrder com clique duplo) e ajuste volumes de faders, mute e solo dos músicos!
                </div>
              </div>
            </div>

            {/* Port Setting */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: '#94a3b8' }}>
              <span>Porta do Servidor:</span>
              <input
                type="number"
                value={portInput}
                onChange={(e) => setPortInput(parseInt(e.target.value, 10) || 3000)}
                style={{ width: 80, padding: '4px 8px', fontSize: 11, background: '#0d0e11', border: '1px solid #2e323b', color: '#fff', borderRadius: 4 }}
              />
              <span className="muted">(Padrão: 3000)</span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
