import { useState } from 'react';
import { Modal } from './Modal';
import { authService } from '../saas/AuthService';
import { masterCatalogService } from '../saas/MasterCatalogService';
import { subscriptionService } from '../saas/SubscriptionService';
import { openExternalUrl } from '../utils/openUrl';
import type { User } from '../saas/types';

interface Props {
  currentUser?: User | null;
  onClose: () => void;
  onSuccess?: (user: User) => void;
  onLogout?: () => void;
  onOpenAdmin?: () => void;
}

export function AuthDialog({ currentUser: propUser, onClose, onSuccess, onLogout, onOpenAdmin }: Props) {
  const [currentUser, setCurrentUser] = useState<User | null>(propUser ?? authService.getCurrentUser());
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [churchName, setChurchName] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingLoginNotice, setPendingLoginNotice] = useState<{
    name: string;
    email: string;
    churchName?: string;
  } | null>(null);

  // Change password in profile
  const [showChangePass, setShowChangePass] = useState(false);
  const [newPass, setNewPass] = useState('');
  const [passSuccess, setPassSuccess] = useState<string | null>(null);

  // Renewal checkout panel
  const [showRenewPanel, setShowRenewPanel] = useState(false);
  const [renewPlan, setRenewPlan] = useState<'monthly' | 'annual'>('monthly');
  const [copiedLink, setCopiedLink] = useState(false);

  const handleLaunchCheckout = async () => {
    let url = '';
    if (currentUser) {
      try {
        const res = await subscriptionService.createInfinitePayCharge(
          currentUser.id,
          renewPlan,
          'card',
          { name: currentUser.name, email: currentUser.email },
        );
        url = res.redirectUrl || res.checkoutUrl;
      } catch {
        /* fallback to static */
      }
    }
    if (!url) {
      url = subscriptionService.getCheckoutUrl(renewPlan);
    }
    await openExternalUrl(url);
  };

  const handleCopyCheckoutUrl = () => {
    const url = subscriptionService.getCheckoutUrl(renewPlan);
    navigator.clipboard.writeText(url);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleLogin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErrorMsg(null);
    setPendingLoginNotice(null);
    setLoading(true);
    try {
      const user = await authService.login(email, password);
      setCurrentUser(user);
      onSuccess?.(user);
      onClose();
    } catch (err: any) {
      if (err.message === 'PENDING_APPROVAL' || err.code === 'PENDING_APPROVAL') {
        const u = err.user || { name: email.split('@')[0], email };
        setPendingLoginNotice(u);
        setErrorMsg(null);
      } else if (err.message === 'ACCESS_REJECTED' || err.code === 'ACCESS_REJECTED') {
        setErrorMsg('⛔ Seu acesso foi negado pela administração. Entre em contato com o suporte para mais informações.');
      } else {
        setErrorMsg(err.message || 'Erro ao realizar login.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErrorMsg(null);
    setLoading(true);
    try {
      const user = await authService.register(name, email, password, churchName, 'user');
      setCurrentUser(user);
      onSuccess?.(user);
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogoutAction = () => {
    authService.logout();
    setCurrentUser(null);
    setEmail('');
    setPassword('');
    setErrorMsg(null);
    onLogout?.();
  };

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    try {
      authService.changePassword(currentUser.id, newPass);
      setPassSuccess('✅ Senha alterada com sucesso!');
      setNewPass('');
      setTimeout(() => {
        setPassSuccess(null);
        setShowChangePass(false);
      }, 2000);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  if (currentUser) {
    return (
      <Modal
        title="Perfil do Usuário"
        onClose={onClose}
        footer={
          <>
            {currentUser.role === 'admin' && onOpenAdmin && (
              <button
                className="btn primary"
                style={{ background: '#F59E0B', color: '#000', fontWeight: 700 }}
                onClick={() => {
                  onClose();
                  onOpenAdmin();
                }}
              >
                ⚙️ Painel Admin Server
              </button>
            )}
            <button className="btn danger" onClick={handleLogoutAction}>
              Sair da Conta
            </button>
            <button className="btn" onClick={onClose}>
              Fechar
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              background: '#16181e',
              padding: 16,
              borderRadius: 8,
              border: '1px solid #2e323b',
            }}
          >
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: currentUser.role === 'admin' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #0099ff, #2563eb)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 24,
                color: '#fff',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              <span style={{ width: '100%', textAlign: 'center' }}>{currentUser.name.charAt(0).toUpperCase()}</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 16, color: '#f8fafc' }}>{currentUser.name}</strong>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 12,
                    fontWeight: 700,
                    background: currentUser.role === 'admin' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(0, 153, 255, 0.2)',
                    color: currentUser.role === 'admin' ? '#f59e0b' : '#38bdf8',
                    border: `1px solid ${currentUser.role === 'admin' ? '#f59e0b' : '#0099ff'}`,
                  }}
                >
                  {currentUser.role === 'admin' ? '👑 Administradora' : '🎸 Músico'}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 12,
                    fontWeight: 700,
                    background:
                      currentUser.status === 'pending'
                        ? 'rgba(245, 158, 11, 0.2)'
                        : currentUser.status === 'rejected'
                        ? 'rgba(239, 68, 68, 0.2)'
                        : 'rgba(16, 185, 129, 0.2)',
                    color:
                      currentUser.status === 'pending'
                        ? '#fbbf24'
                        : currentUser.status === 'rejected'
                        ? '#f87171'
                        : '#34d399',
                    border: `1px solid ${
                      currentUser.status === 'pending'
                        ? '#f59e0b'
                        : currentUser.status === 'rejected'
                        ? '#ef4444'
                        : '#10b981'
                    }`,
                  }}
                >
                  {currentUser.status === 'pending'
                    ? '⏳ Pendente'
                    : currentUser.status === 'rejected'
                    ? '⛔ Recusado'
                    : '🟢 Aprovado'}
                </span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>
                {currentUser.email} · {currentUser.churchName || 'Igreja Local'}
              </div>
            </div>
          </div>

          {/* Minha Assinatura Section */}
          <div
            style={{
              background: '#16181e',
              borderRadius: 8,
              border: '1px solid #2e323b',
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 16 }}>💳</span>
                <strong style={{ fontSize: 13, color: '#f8fafc' }}>Minha Assinatura</strong>
              </div>
              {(() => {
                const subStatus = currentUser.subscription?.status || 'active';
                if (currentUser.role === 'admin') {
                  return (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontWeight: 700,
                        background: 'rgba(245, 158, 11, 0.2)',
                        color: '#f59e0b',
                        border: '1px solid #f59e0b',
                      }}
                    >
                      👑 VIP Perpétuo (Isento)
                    </span>
                  );
                }
                if (subStatus === 'active') {
                  return (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontWeight: 700,
                        background: 'rgba(16, 185, 129, 0.2)',
                        color: '#34d399',
                        border: '1px solid #10b981',
                      }}
                    >
                      🟢 Ativa & Regular
                    </span>
                  );
                }
                if (subStatus === 'past_due') {
                  return (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontWeight: 700,
                        background: 'rgba(239, 68, 68, 0.2)',
                        color: '#f87171',
                        border: '1px solid #ef4444',
                      }}
                    >
                      ⚠️ Inadimplente / Vencida
                    </span>
                  );
                }
                return (
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 8px',
                      borderRadius: 10,
                      fontWeight: 700,
                      background: 'rgba(100, 116, 139, 0.2)',
                      color: '#94a3b8',
                      border: '1px solid #64748b',
                    }}
                  >
                    🔴 Cancelada
                  </span>
                );
              })()}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 8,
                background: '#101216',
                padding: 10,
                borderRadius: 6,
                fontSize: 11,
              }}
            >
              <div>
                <span className="muted">Plano Contratado:</span>
                <div style={{ fontWeight: 600, color: '#f1f5f9', marginTop: 2 }}>
                  {currentUser.subscription?.planName || 'Worship Mensal'}
                </div>
              </div>
              <div>
                <span className="muted">Gateway de Cobrança:</span>
                <div style={{ fontWeight: 600, color: '#f1f5f9', marginTop: 2, textTransform: 'uppercase' }}>
                  {currentUser.subscription?.provider === 'infinitepay' ? '⚡ InfinitePay (Pix / Cartão)' : '🏛️ Manual'}
                </div>
              </div>
              <div>
                <span className="muted">Vencimento / Renovação:</span>
                <div style={{ fontWeight: 600, color: '#38bdf8', marginTop: 2 }}>
                  {currentUser.subscription?.currentPeriodEnd
                    ? new Date(currentUser.subscription.currentPeriodEnd).toLocaleDateString('pt-BR')
                    : 'Vitalício'}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
              {currentUser.role !== 'admin' && (
                <>
                  <button
                    type="button"
                    className="btn small primary"
                    style={{ fontWeight: 700 }}
                    onClick={() => setShowRenewPanel(!showRenewPanel)}
                  >
                    💳 {showRenewPanel ? 'Ocultar Opções de Planos' : 'Renovar / Mudar de Plano'}
                  </button>
                </>
              )}
            </div>

            {/* Interactive Renewal Panel */}
            {showRenewPanel && (
              <div
                style={{
                  background: '#0d0e11',
                  border: '1px solid #3b4252',
                  borderRadius: 8,
                  padding: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  marginTop: 6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 12, color: '#f8fafc' }}>
                    Selecione o Plano Desejado:
                  </strong>
                  <span className="muted" style={{ fontSize: 11 }}>
                    Ambiente Seguro InfinitePay
                  </span>
                </div>

                {/* Plan Choices */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div
                    onClick={() => setRenewPlan('monthly')}
                    style={{
                      background: renewPlan === 'monthly' ? '#161e2e' : '#111317',
                      border: renewPlan === 'monthly' ? '2px solid #0099ff' : '1px solid #272a33',
                      borderRadius: 6,
                      padding: 8,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: 12, color: renewPlan === 'monthly' ? '#38bdf8' : '#f1f5f9' }}>
                        Worship Mensal
                      </strong>
                      <input
                        type="radio"
                        checked={renewPlan === 'monthly'}
                        onChange={() => setRenewPlan('monthly')}
                        style={{ accentColor: '#0099ff' }}
                      />
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginTop: 4 }}>
                      R$ 49,90<span style={{ fontSize: 10, fontWeight: 400, color: '#94a3b8' }}>/mês</span>
                    </div>
                  </div>

                  <div
                    onClick={() => setRenewPlan('annual')}
                    style={{
                      background: renewPlan === 'annual' ? '#161e2e' : '#111317',
                      border: renewPlan === 'annual' ? '2px solid #0099ff' : '1px solid #272a33',
                      borderRadius: 6,
                      padding: 8,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: 12, color: renewPlan === 'annual' ? '#38bdf8' : '#f1f5f9' }}>
                        Pro Anual (2 meses off)
                      </strong>
                      <input
                        type="radio"
                        checked={renewPlan === 'annual'}
                        onChange={() => setRenewPlan('annual')}
                        style={{ accentColor: '#0099ff' }}
                      />
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginTop: 4 }}>
                      R$ 479,00<span style={{ fontSize: 10, fontWeight: 400, color: '#94a3b8' }}>/ano</span>
                    </div>
                  </div>
                </div>

                {/* Direct Action Button for InfinitePay */}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button
                    type="button"
                    onClick={() => void handleLaunchCheckout()}
                    style={{
                      flex: 1,
                      background: '#10b981',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      padding: '10px 14px',
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
                    }}
                  >
                    ⚡ Pagar com InfinitePay (PIX & Cartão)
                  </button>
                </div>

                {/* Direct Link and Copy option */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#16181e', padding: '6px 10px', borderRadius: 4, fontSize: 11, color: '#94a3b8' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>
                    🔗 Link: {subscriptionService.getCheckoutUrl(renewPlan)}
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={handleCopyCheckoutUrl}
                  >
                    {copiedLink ? '✅ Copiado!' : '📋 Copiar Link'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Change password section */}
          {!showChangePass ? (
            <button
              className="btn small"
              style={{ alignSelf: 'flex-start', fontSize: 12 }}
              onClick={() => setShowChangePass(true)}
            >
              🔑 Alterar Minha Senha
            </button>
          ) : (
            <form onSubmit={handleChangePassword} style={{ background: '#111317', padding: 12, borderRadius: 6, border: '1px solid #2e323b', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <strong style={{ fontSize: 12, color: '#f8fafc' }}>Definir Nova Senha:</strong>
              {passSuccess && <div style={{ fontSize: 12, color: '#34d399' }}>{passSuccess}</div>}
              {errorMsg && <div style={{ fontSize: 12, color: '#ff6b6b' }}>{errorMsg}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  required
                  placeholder="Nova senha (mínimo 4 caracteres)"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  style={{ flex: 1, fontSize: 12 }}
                />
                <button type="submit" className="btn small primary">Salvar Senha</button>
                <button type="button" className="btn small" onClick={() => setShowChangePass(false)}>Cancelar</button>
              </div>
            </form>
          )}

          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            Seus repertórios (Setlists), alterações de Tom, BPM, volumes e marcações de seções estão salvos e vinculados à sua conta. Se você abrir o software em outro computador ou dispositivo e fizer login com seu e-mail e senha, seu repertório carregará automaticamente.
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Acesso ao Sistema — Worship Tools"
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ fontSize: 11.5 }}>
            Digite seu e-mail e senha para acessar o repertório e catálogo
          </span>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Tab switch */}
        <div className="ai-tabs">
          <button className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
            Entrar (Login)
          </button>
          <button className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>
            Criar Nova Conta
          </button>
        </div>

        {errorMsg && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 6,
              background: 'rgba(231, 76, 60, 0.15)',
              border: '1px solid #e74c3c',
              color: '#ff6b6b',
              fontSize: 12,
            }}
          >
            ❌ {errorMsg}
          </div>
        )}

        {pendingLoginNotice && (
          <div
            style={{
              background: '#16181E',
              border: '1px solid #F59E0B',
              borderRadius: 10,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              boxShadow: '0 8px 24px rgba(245, 158, 11, 0.2)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 26 }}>⏳</span>
              <div>
                <strong style={{ fontSize: 14, color: '#fde68a' }}>Cadastro em Análise pela Administração</strong>
                <div style={{ fontSize: 11, color: '#fbbf24' }}>Status: Pendente de Liberação</div>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: '#e5e7eb', lineHeight: 1.5 }}>
              Olá, <strong>{pendingLoginNotice.name}</strong>! Seu cadastro foi validado na nuvem (Supabase), mas o seu acesso ainda está <b>aguardando aprovação</b> da equipe administrativa.
            </p>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>
              Assim que o seu perfil for liberado pelo administrador, você terá acesso completo ao software e ao catálogo de MultiTracks.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn small"
                style={{
                  flex: 1,
                  background: '#25D366',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '8px 12px',
                }}
                onClick={() => {
                  const cleanPhone = masterCatalogService.getAdminWhatsAppNumber().replace(/\D/g, '');
                  const msg = `Olá! Meu nome é *${pendingLoginNotice.name}* (${pendingLoginNotice.email}) e gostaria de solicitar a liberação do meu cadastro no Worship Tools.`;
                  openExternalUrl(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`);
                }}
              >
                💬 Solicitar Liberação no WhatsApp
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => setPendingLoginNotice(null)}
              >
                Tentar Outro E-mail
              </button>
            </div>
          </div>
        )}

        {tab === 'login' ? (
          <form onSubmit={(e) => void handleLogin(e)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              E-mail:
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu.email@exemplo.com ou admin@playback.pro"
                style={{ fontSize: 13 }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              Senha:
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Digite sua senha de acesso"
                style={{ fontSize: 13 }}
              />
            </label>

            <button
              type="submit"
              className="btn primary"
              disabled={loading || !email.trim() || !password.trim()}
              style={{ background: '#0099ff', borderColor: '#0099ff', padding: '10px', fontWeight: 700, marginTop: 4 }}
            >
              {loading ? 'Verificando dados…' : 'Entrar na Conta'}
            </button>

            {/* Quick field prefill helper (does NOT bypass password, only writes email into input) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, background: '#111317', padding: '10px 12px', borderRadius: 6, border: '1px solid #1f2430' }}>
              <span className="muted" style={{ fontSize: 11 }}>
                💡 <b>Dica de Acesso:</b> Todos os usuários e administradores devem digitar e-mail e senha válidos.
              </span>
              <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11 }}>
                <span
                  style={{ color: '#f59e0b', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => {
                    setEmail('admin@playback.pro');
                    setPassword('');
                  }}
                  title="Preencher campo com e-mail do Admin"
                >
                  Preencher e-mail do Admin
                </span>
                <span
                  style={{ color: '#38bdf8', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => {
                    setEmail('musico@igreja.com');
                    setPassword('');
                  }}
                  title="Preencher campo com e-mail do Músico"
                >
                  Preencher e-mail de Músico
                </span>
              </div>
            </div>
          </form>
        ) : (
          <form onSubmit={(e) => void handleRegister(e)} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              Nome Completo:
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: João Silva"
              />
            </label>

            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                E-mail:
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="joao@igreja.com"
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
                Senha:
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Crie sua senha"
                />
              </label>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              Igreja / Ministério:
              <input
                type="text"
                value={churchName}
                onChange={(e) => setChurchName(e.target.value)}
                placeholder="Ex: Igreja Batista Central"
              />
            </label>

            <button
              type="submit"
              className="btn primary"
              disabled={loading || !name.trim() || !email.trim() || !password.trim()}
              style={{ background: '#0099ff', borderColor: '#0099ff', padding: '10px', fontWeight: 700, marginTop: 4 }}
            >
              {loading ? 'Criando Conta…' : 'Cadastrar e Acessar Catálogo'}
            </button>
          </form>
        )}
      </div>
    </Modal>
  );
}
