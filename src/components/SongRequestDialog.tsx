import { useState } from 'react';
import { Modal } from './Modal';
import { authService } from '../saas/AuthService';
import { masterCatalogService } from '../saas/MasterCatalogService';
import { openExternalUrl } from '../utils/openUrl';

interface Props {
  prefillTitle?: string;
  onClose: () => void;
}

export function SongRequestDialog({ prefillTitle = '', onClose }: Props) {
  const currentUser = authService.getCurrentUser();
  const isAdmin = currentUser?.role === 'admin';

  const [title, setTitle] = useState(prefillTitle);
  const [artist, setArtist] = useState('');
  const [key, setKey] = useState('ORIGINAL');
  const [urgencyDate, setUrgencyDate] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [notes, setNotes] = useState('');

  // WhatsApp Destination Number
  const [adminPhone, setAdminPhone] = useState(() => masterCatalogService.getAdminWhatsAppNumber());
  const [showPhoneConfig, setShowPhoneConfig] = useState(!masterCatalogService.getAdminWhatsAppNumber());

  const [sentSuccess, setSentSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSavePhone = () => {
    const clean = adminPhone.replace(/\D/g, '');
    if (clean.length < 10) {
      setErrorMsg('Por favor, informe um número de WhatsApp válido com DDD (ex: 11999998888 ou 5511999998888).');
      return;
    }
    masterCatalogService.setAdminWhatsAppNumber(clean);
    setAdminPhone(clean);
    setShowPhoneConfig(false);
    setErrorMsg(null);
  };

  const handleSendWhatsApp = async () => {
    setErrorMsg(null);

    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setErrorMsg('Por favor, informe o nome da música.');
      return;
    }

    const cleanArtist = artist.trim() || 'Não especificado';

    let destinationNumber = (adminPhone || masterCatalogService.getAdminWhatsAppNumber()).replace(/\D/g, '');

    // If destination number is not configured or too short, require entering it
    if (!destinationNumber || destinationNumber.length < 10) {
      setShowPhoneConfig(true);
      setErrorMsg('Por favor, configure o número de WhatsApp do administrador que receberá este pedido.');
      return;
    }

    // Auto-add Brazilian country code 55 if not provided
    if (destinationNumber.length === 10 || destinationNumber.length === 11) {
      destinationNumber = `55${destinationNumber}`;
    }

    const userName = currentUser?.name || 'Músico de Louvor';
    const userEmail = currentUser?.email || 'N/A';
    const churchName = currentUser?.churchName || 'Igreja Local';

    const messageLines = [
      '🎵 *SOLICITAÇÃO DE NOVO VS / MULTITRACK*',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `👤 *Solicitante:* ${userName}`,
      `⛪ *Igreja:* ${churchName}`,
      `📧 *E-mail:* ${userEmail}`,
      '',
      `🎶 *Música:* ${cleanTitle}`,
      `🎤 *Artista / Ministério:* ${cleanArtist}`,
      `🎹 *Tom Desejado:* ${key === 'ORIGINAL' ? 'Tom Original' : key}`,
      urgencyDate.trim() ? `📅 *Data / Culto:* ${urgencyDate.trim()}` : null,
      referenceUrl.trim() ? `🔗 *Referência / Link:* ${referenceUrl.trim()}` : null,
      notes.trim() ? `📝 *Observações:* ${notes.trim()}` : null,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '_Enviado automaticamente pelo Worship Playback Pro SaaS_',
    ].filter(Boolean);

    const fullMessage = messageLines.join('\n');
    const waUrl = `https://wa.me/${destinationNumber}?text=${encodeURIComponent(fullMessage)}`;

    try {
      // Copy to clipboard as a safety backup
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(fullMessage).catch(() => {});
      }

      // Open WhatsApp Web or WhatsApp Desktop/Mobile app
      await openExternalUrl(waUrl);
      setSentSuccess(true);
    } catch (e) {
      console.error('Falha ao abrir WhatsApp:', e);
      // Fallback direct window.open
      window.open(waUrl, '_blank');
      setSentSuccess(true);
    }
  };

  return (
    <Modal
      title="✨ Solicitar Nova MultiTrack / VS para o Louvor"
      wide={false}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {sentSuccess ? 'Fechar' : 'Cancelar'}
          </button>
          {!sentSuccess && (
            <button
              className="btn primary"
              style={{
                background: '#25D366',
                borderColor: '#25D366',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: 13,
                boxShadow: '0 0 14px rgba(37, 211, 102, 0.4)',
              }}
              onClick={handleSendWhatsApp}
            >
              📲 Enviar Pedido via WhatsApp
            </button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Banner */}
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(37, 211, 102, 0.12), rgba(0, 153, 255, 0.08))',
            border: '1px solid rgba(37, 211, 102, 0.35)',
            borderRadius: 8,
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              background: '#25D366',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            💬
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#f8fafc' }}>
              Não encontrou a música na lista de VS?
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
              Preencha o pedido abaixo e ele será enviado formatado diretamente para o WhatsApp do administrador responsável pelo catálogo de multitracks!
            </div>
          </div>
        </div>

        {/* Error notification */}
        {errorMsg && (
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid #ef4444',
              color: '#fca5a5',
              padding: '10px 14px',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            ⚠️ {errorMsg}
          </div>
        )}

        {/* Success Confirmation */}
        {sentSuccess ? (
          <div
            style={{
              background: 'rgba(37, 211, 102, 0.15)',
              border: '1px solid #25D366',
              borderRadius: 8,
              padding: '20px 16px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div style={{ fontSize: 36 }}>🎉</div>
            <strong style={{ fontSize: 15, color: '#34d399' }}>
              Pedido Aberto no WhatsApp com Sucesso!
            </strong>
            <p className="muted" style={{ fontSize: 12.5, margin: 0, maxWidth: 420 }}>
              Uma conversa foi iniciada com todos os dados da música <b>"{title}"</b> prontos para envio. O texto também foi copiado para sua área de transferência.
            </p>
            <button
              className="btn primary"
              style={{ background: '#25D366', borderColor: '#25D366', color: '#fff', fontWeight: 700, marginTop: 6 }}
              onClick={onClose}
            >
              Concluir e Voltar
            </button>
          </div>
        ) : (
          <>
            {/* WhatsApp Target Number configuration */}
            {(!adminPhone || showPhoneConfig || isAdmin) && (
              <div
                style={{
                  background: '#16181e',
                  border: '1px solid #2e323b',
                  borderRadius: 8,
                  padding: '10px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#38bdf8' }}>
                    📱 WHATSAPP DO DESTINATÁRIO (ADMIN):
                  </label>
                  {!showPhoneConfig && (
                    <button
                      className="btn small"
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      onClick={() => setShowPhoneConfig(true)}
                    >
                      Alterar Número
                    </button>
                  )}
                </div>

                {showPhoneConfig ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      placeholder="Ex: 5511999998888 (com DDD)"
                      value={adminPhone}
                      onChange={(e) => setAdminPhone(e.target.value)}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button
                      className="btn small primary"
                      style={{ background: '#0099ff', fontSize: 11 }}
                      onClick={handleSavePhone}
                    >
                      Salvar Número
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, color: '#cbd5e1' }}>
                    Os pedidos serão enviados para: <strong>+{adminPhone}</strong>
                  </div>
                )}
              </div>
            )}

            {/* Form Fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11.5, fontWeight: 700, color: '#e2e8f0', display: 'block', marginBottom: 4 }}>
                  NOME DA MÚSICA / VS *
                </label>
                <input
                  type="text"
                  placeholder="Ex: Bondade de Deus, Ele É Exaltado, Que Se Abram Os Céus..."
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  style={{ width: '100%', fontSize: 13 }}
                  autoFocus
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 700, color: '#e2e8f0', display: 'block', marginBottom: 4 }}>
                    ARTISTA / MINISTÉRIO *
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: Isaías Saad, Morada, Gabriel Guedes..."
                    value={artist}
                    onChange={(e) => setArtist(e.target.value)}
                    style={{ width: '100%', fontSize: 13 }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: 11.5, fontWeight: 700, color: '#e2e8f0', display: 'block', marginBottom: 4 }}>
                    TOM DESEJADO
                  </label>
                  <select
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    style={{ width: '100%', fontSize: 13 }}
                  >
                    <option value="ORIGINAL">Tom Original</option>
                    {['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].map((k) => (
                      <option key={k} value={k}>
                        Tom: {k}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                    LINK DE REFERÊNCIA (YOUTUBE / SPOTIFY)
                  </label>
                  <input
                    type="text"
                    placeholder="https://youtu.be/..."
                    value={referenceUrl}
                    onChange={(e) => setReferenceUrl(e.target.value)}
                    style={{ width: '100%', fontSize: 12 }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                    DATA OU CULTO NECESSÁRIO
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: Domingo 19h / Urgente"
                    value={urgencyDate}
                    onChange={(e) => setUrgencyDate(e.target.value)}
                    style={{ width: '100%', fontSize: 12 }}
                  />
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                  OBSERVAÇÕES / DETALHES ESPECIAIS (OPCIONAL)
                </label>
                <textarea
                  rows={2}
                  placeholder="Ex: Preferência pela versão ao vivo acústica, precisamos com Guia de voz masculina e contagem..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  style={{ width: '100%', fontSize: 12, resize: 'vertical' }}
                />
              </div>

              {currentUser && (
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  👤 Solicitando como: <strong>{currentUser.name}</strong> ({currentUser.churchName || currentUser.email})
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
