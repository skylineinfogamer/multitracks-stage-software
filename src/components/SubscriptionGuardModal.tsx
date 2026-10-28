import { useEffect, useState } from 'react';
import { subscriptionService } from '../saas/SubscriptionService';
import { authService } from '../saas/AuthService';
import { masterCatalogService } from '../saas/MasterCatalogService';
import { supabase } from '../saas/supabaseClient';
import { openExternalUrl } from '../utils/openUrl';
import type { SubscriptionPlanId, User } from '../saas/types';

interface Props {
  user: User;
  reason?: string;
  onLogout: () => void;
  onUnlocked?: () => void;
}

export function SubscriptionGuardModal({ user, reason, onLogout, onUnlocked }: Props) {
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId>('monthly');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [pixData, setPixData] = useState<{
    pixCode: string;
    qrcodeUrl: string;
    checkoutUrl: string;
    amountFormatted: string;
  } | null>(null);
  const [copiedPix, setCopiedPix] = useState(false);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);

  // Supabase Realtime Listener na tabela public.profiles:
  // Assim que a Edge Function do Webhook atualizar o status para 'active', desbloqueia automaticamente!
  useEffect(() => {
    if (!user.id) return;

    const channel = supabase
      .channel(`profile-subscription-realtime-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${user.id}`,
        },
        async (payload: any) => {
          console.log('[Supabase Realtime] Perfil atualizado:', payload);
          if (payload.new && payload.new.status === 'active') {
            setPaymentConfirmed(true);
            setFeedback('🎉 Pagamento Confirmado via InfinitePay! Seu acesso foi liberado com sucesso.');
            await authService.refreshCurrentUser();
            setTimeout(() => {
              onUnlocked?.();
            }, 1800);
          }
        },
      )
      .subscribe();

    // Polling de redundância a cada 4 segundos caso o WebSocket Realtime sofra restrição de rede
    const interval = setInterval(async () => {
      try {
        const refreshed = await authService.refreshCurrentUser();
        if (refreshed && refreshed.status === 'active') {
          setPaymentConfirmed(true);
          setFeedback('🎉 Pagamento Confirmado via InfinitePay! Seu acesso foi liberado.');
          clearInterval(interval);
          setTimeout(() => {
            onUnlocked?.();
          }, 1500);
        }
      } catch {
        /* ignore */
      }
    }, 4000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [user.id, onUnlocked]);

  const handleCreatePixInfinitePay = async () => {
    setLoading(true);
    setFeedback('⚡ Gerando cobrança PIX via InfinitePay Edge Function...');
    try {
      const res = await subscriptionService.createInfinitePayCharge(
        user.id,
        selectedPlan,
        'pix',
        { name: user.name, email: user.email },
      );
      if (res && res.pixCode) {
        setPixData({
          pixCode: res.pixCode,
          qrcodeUrl: res.qrcodeUrl,
          checkoutUrl: res.checkoutUrl,
          amountFormatted: res.amountFormatted,
        });
        setFeedback('⚡ QR Code PIX gerado! Pague com seu banco para liberação automática via Realtime.');
      }
    } catch (e: any) {
      setFeedback(`❌ Falha ao gerar PIX: ${e.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenInfinitePayCard = async () => {
    const url = pixData?.checkoutUrl || subscriptionService.getCheckoutUrl(selectedPlan, 'infinitepay');
    const opened = await openExternalUrl(url);
    if (opened) {
      setFeedback('✅ Abrindo checkout com cartão InfinitePay no seu navegador...');
    } else {
      setFeedback(`⚠️ Acesse o checkout diretamente pelo link: ${url}`);
    }
  };

  const isPending = user.status === 'pending';
  const isRejected = user.status === 'rejected';

  const plans = subscriptionService.getAllPlans();
  const adminWhatsApp = masterCatalogService.getAdminWhatsAppNumber();

  const handleOpenWhatsApp = () => {
    const cleanPhone = adminWhatsApp.replace(/\D/g, '');
    let msg = `Olá! Meu nome é *${user.name}* (${user.email}) e acabei de me cadastrar no *Worship Tools* (${user.churchName || 'Ministério de Louvor'}).\n\nGostaria de solicitar a liberação do meu acesso ao aplicativo!`;
    if (isRejected) {
      msg = `Olá! Meu nome é *${user.name}* (${user.email}). Gostaria de entender o motivo da recusa do meu acesso ao *Worship Tools*.`;
    }
    const url = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
    openExternalUrl(url);
  };

  const handleCheckApprovalStatus = async () => {
    setLoading(true);
    setFeedback('Consultando status da sua conta no Supabase...');
    try {
      const refreshed = await authService.refreshCurrentUser();
      if (refreshed && refreshed.status === 'active') {
        setFeedback('🎉 Seu cadastro foi aprovado com sucesso! Liberando acesso...');
        setTimeout(() => {
          onUnlocked?.();
        }, 1000);
      } else if (refreshed && refreshed.status === 'rejected') {
        setFeedback('❌ Seu cadastro foi recusado pela administração.');
      } else {
        setFeedback('⏳ Seu cadastro ainda está em análise pela administração. Você também pode avisar o administrador pelo WhatsApp.');
      }
    } catch {
      setFeedback('Erro ao consultar o servidor. Verifique sua conexão.');
    } finally {
      setLoading(false);
    }
  };

  const handleCheckStatus = () => {
    setLoading(true);
    setFeedback('Consultando gateway de pagamento InfinitePay...');
    setTimeout(() => {
      setLoading(false);
      const res = subscriptionService.checkUserAccess(user);
      if (res.allowed) {
        setFeedback('🎉 Pagamento identificado! Seu acesso foi liberado.');
        onUnlocked?.();
      } else {
        setFeedback('Ainda não identificamos a confirmação bancária. Se acabou de pagar via Pix ou Cartão, aguarde alguns instantes para a compensação e verifique novamente.');
      }
    }, 1200);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(6, 7, 10, 0.94)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 620,
          background: '#0D0E11',
          border: `1px solid ${isPending ? '#F59E0B' : isRejected ? '#EF4444' : '#EF4444'}`,
          borderRadius: 14,
          boxShadow: isPending
            ? '0 25px 60px -15px rgba(245, 158, 11, 0.25)'
            : '0 25px 60px -15px rgba(239, 68, 68, 0.35)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Banner Alert Top */}
        <div
          style={{
            background: isPending
              ? 'linear-gradient(90deg, #b45309, #f59e0b)'
              : 'linear-gradient(90deg, #991b1b, #ef4444)',
            padding: '16px 20px',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 24 }}>{isPending ? '⏳' : isRejected ? '⛔' : '⚠️'}</span>
            <div>
              <strong style={{ fontSize: 14, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                {isPending
                  ? 'CADASTRO EM ANÁLISE — AGUARDANDO APROVAÇÃO'
                  : isRejected
                  ? 'ACESSO RECUSADO PELA ADMINISTRAÇÃO'
                  : 'ACESSO BLOQUEADO — ASSINATURA EXPIRADA'}
              </strong>
              <div style={{ fontSize: 12, opacity: 0.95, marginTop: 2 }}>
                Conta: <strong>{user.name}</strong> ({user.email})
              </div>
            </div>
          </div>
          <button
            onClick={onLogout}
            style={{
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.25)',
              color: '#fff',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Sair da Conta
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18, color: '#f1f5f9' }}>
          {isPending ? (
            /* Pending Approval View */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div
                style={{
                  background: '#16181E',
                  border: '1px solid #332B18',
                  borderRadius: 10,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 14, color: '#fde68a', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>⏳</span> Seu cadastro foi recebido com sucesso!
                </div>
                <div style={{ fontSize: 13, color: '#d1d5db', lineHeight: 1.6 }}>
                  {reason ||
                    'Seu cadastro está em análise pela administração. Você receberá acesso assim que for aprovado pela nossa equipe.'}
                </div>
                <div style={{ fontSize: 12, color: '#9ca3af', borderTop: '1px solid #272a33', paddingTop: 10 }}>
                  Igreja cadastrada: <strong style={{ color: '#fff' }}>{user.churchName || 'Não informada'}</strong>
                </div>
              </div>

              {/* Blocked resources notice */}
              <div
                style={{
                  background: '#12141a',
                  border: '1px solid #1f232e',
                  borderRadius: 8,
                  padding: '12px 16px',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ color: '#fbbf24' }}>🔒 Mixer e Reprodução de Stems</div>
                <div style={{ color: '#fbbf24' }}>🔒 Catálogo Master Google Drive</div>
                <div style={{ color: '#fbbf24' }}>🔒 Download de VS Offline</div>
                <div style={{ color: '#fbbf24' }}>🔒 Sincronização de Repertórios</div>
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                <button
                  onClick={handleCheckApprovalStatus}
                  disabled={loading}
                  style={{
                    background: '#0099FF',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '12px 18px',
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: loading ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    boxShadow: '0 4px 14px rgba(0, 153, 255, 0.3)',
                  }}
                >
                  {loading ? 'Consultando status...' : '🔄 Já fui aprovado? Verificar Status Agora'}
                </button>

                <button
                  onClick={handleOpenWhatsApp}
                  style={{
                    background: '#25D366',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '12px 18px',
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    boxShadow: '0 4px 14px rgba(37, 211, 102, 0.25)',
                  }}
                >
                  💬 Solicitar Liberação ao Administrador no WhatsApp
                </button>
              </div>
            </div>
          ) : isRejected ? (
            /* Rejected View */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div
                style={{
                  background: '#16181E',
                  border: '1px solid #451a1a',
                  borderRadius: 10,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 14, color: '#fca5a5', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>⛔</span> Acesso negado
                </div>
                <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>
                  {reason ||
                    'Seu cadastro foi recusado pela administração. Para regularizar seu acesso ou tirar dúvidas, entre em contato com o suporte.'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={handleOpenWhatsApp}
                  style={{
                    flex: 1,
                    background: '#25D366',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    padding: '12px 18px',
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                >
                  💬 Conversar com o Suporte no WhatsApp
                </button>
                <button
                  onClick={onLogout}
                  style={{
                    background: '#1f242d',
                    border: '1px solid #3b4252',
                    color: '#e2e8f0',
                    borderRadius: 8,
                    padding: '12px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Sair
                </button>
              </div>
            </div>
          ) : (
            /* Expired Subscription View (Standard) */
            <>
              <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>
                {reason ||
                  'Seu período de assinatura encerrou ou o pagamento da mensalidade está pendente. Para continuar utilizando o mixer de palco, vozes guias e o download de MultiTracks do Google Drive, regularize sua assinatura:'}
              </div>

              {/* Blocked items notification */}
              <div
                style={{
                  background: '#16181E',
                  border: '1px solid #2E323B',
                  borderRadius: 8,
                  padding: '12px 16px',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ color: '#f87171' }}>🔒 Reprodução de Stems e Mixer</div>
                <div style={{ color: '#f87171' }}>🔒 Catálogo Master Google Drive</div>
                <div style={{ color: '#f87171' }}>🔒 Download de VS Offline</div>
                <div style={{ color: '#f87171' }}>🔒 Sincronização de Repertórios</div>
              </div>

              {/* Plan Options Selector */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#94a3b8',
                    marginBottom: 8,
                    textTransform: 'uppercase',
                    letterSpacing: 0.8,
                  }}
                >
                  Escolha seu Plano de Renovação:
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {plans.map((p) => {
                    const isSelected = selectedPlan === p.id;
                    return (
                      <div
                        key={p.id}
                        onClick={() => setSelectedPlan(p.id)}
                        style={{
                          background: isSelected ? '#161e2e' : '#12141a',
                          border: isSelected ? '2px solid #0099FF' : '1px solid #272a33',
                          borderRadius: 8,
                          padding: 14,
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          position: 'relative',
                        }}
                      >
                        {p.badge && (
                          <span
                            style={{
                              position: 'absolute',
                              top: -9,
                              right: 10,
                              background: '#0099FF',
                              color: '#fff',
                              fontSize: 9,
                              fontWeight: 800,
                              padding: '2px 8px',
                              borderRadius: 10,
                              letterSpacing: 0.5,
                            }}
                          >
                            {p.badge}
                          </span>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong style={{ fontSize: 15, color: isSelected ? '#38bdf8' : '#f8fafc' }}>{p.name}</strong>
                          <input
                            type="radio"
                            checked={isSelected}
                            onChange={() => setSelectedPlan(p.id)}
                            style={{ accentColor: '#0099FF' }}
                          />
                        </div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', marginTop: 6 }}>
                          R$ {p.priceBrl.toFixed(2).replace('.', ',')}
                          <span style={{ fontSize: 12, fontWeight: 400, color: '#94a3b8' }}>
                            /{p.interval === 'annual' ? 'ano' : 'mês'}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{p.description}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* PIX QR Code Display Box (InfinitePay) */}
              {pixData && (
                <div
                  style={{
                    background: '#161922',
                    border: '1px solid #10b981',
                    borderRadius: 10,
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 12,
                    boxShadow: '0 8px 24px rgba(16, 185, 129, 0.15)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#34d399', fontWeight: 700, fontSize: 14 }}>
                    <span>⚡</span> QR Code PIX (InfinitePay) — {pixData.amountFormatted}
                  </div>

                  {/* QR Code Image */}
                  <div
                    style={{
                      background: '#fff',
                      padding: 10,
                      borderRadius: 8,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                    }}
                  >
                    <img
                      src={pixData.qrcodeUrl}
                      alt="PIX QR Code InfinitePay"
                      style={{ width: 180, height: 180, display: 'block' }}
                    />
                  </div>

                  <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>
                    Abra o app do seu banco, escolha <b>PIX &gt; Pagar com QR Code</b> ou copie o código abaixo:
                  </div>

                  {/* Copia e Cola Box */}
                  <div style={{ width: '100%', display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      readOnly
                      value={pixData.pixCode}
                      style={{
                        flex: 1,
                        background: '#0d0e12',
                        border: '1px solid #2e323b',
                        color: '#94a3b8',
                        fontSize: 11,
                        fontFamily: 'monospace',
                        padding: '8px 10px',
                        borderRadius: 6,
                      }}
                    />
                    <button
                      className="btn primary"
                      style={{ background: '#10b981', borderColor: '#10b981', color: '#fff', fontSize: 12, fontWeight: 700 }}
                      onClick={() => {
                        navigator.clipboard.writeText(pixData.pixCode);
                        setCopiedPix(true);
                        setTimeout(() => setCopiedPix(false), 3000);
                      }}
                    >
                      {copiedPix ? '✅ Copiado!' : '📋 Copiar'}
                    </button>
                  </div>

                  {/* Live Supabase Realtime indicator */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 11.5,
                      color: paymentConfirmed ? '#34d399' : '#38bdf8',
                      background: paymentConfirmed ? 'rgba(16, 185, 129, 0.15)' : 'rgba(0, 153, 255, 0.1)',
                      padding: '6px 12px',
                      borderRadius: 20,
                      border: `1px solid ${paymentConfirmed ? '#10b981' : 'rgba(0, 153, 255, 0.3)'}`,
                    }}
                  >
                    <span style={{ display: 'inline-block', animation: paymentConfirmed ? 'none' : 'spin 1.5s linear infinite' }}>
                      {paymentConfirmed ? '🎉' : '🔄'}
                    </span>
                    <span>
                      {paymentConfirmed
                        ? 'Pagamento Confirmado! Desbloqueando software…'
                        : 'Aguardando pagamento via Supabase Realtime (liberação automática)…'}
                    </span>
                  </div>
                </div>
              )}

              {/* Action Buttons: InfinitePay & Stripe */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 10 }}>
                  <button
                    onClick={handleCreatePixInfinitePay}
                    disabled={loading}
                    style={{
                      background: '#10b981',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontWeight: 800,
                      fontSize: 13.5,
                      cursor: loading ? 'wait' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
                    }}
                  >
                    ⚡ {loading ? 'Gerando PIX…' : 'Pagar via PIX (InfinitePay)'}
                  </button>

                  <button
                    onClick={handleOpenInfinitePayCard}
                    style={{
                      background: '#0ea5e9',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '12px 16px',
                      fontWeight: 700,
                      fontSize: 13,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      boxShadow: '0 4px 12px rgba(14, 165, 233, 0.3)',
                    }}
                  >
                    💳 Cartão (InfinitePay)
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    onClick={handleCheckStatus}
                    disabled={loading}
                    style={{
                      flex: 1,
                      background: '#1f242d',
                      border: '1px solid #3b4252',
                      color: '#e2e8f0',
                      borderRadius: 8,
                      padding: '10px 14px',
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: loading ? 'wait' : 'pointer',
                    }}
                  >
                    {loading ? 'Consultando InfinitePay…' : '🔄 Já Paguei? Verificar Status Agora'}
                  </button>
                </div>
              </div>
            </>
          )}

          {feedback && (
            <div
              style={{
                fontSize: 12,
                padding: '10px 14px',
                borderRadius: 6,
                background:
                  feedback.includes('✅') || feedback.includes('🎉')
                    ? 'rgba(16, 185, 129, 0.2)'
                    : feedback.includes('⏳')
                    ? 'rgba(245, 158, 11, 0.2)'
                    : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${
                  feedback.includes('✅') || feedback.includes('🎉')
                    ? '#10B981'
                    : feedback.includes('⏳')
                    ? '#F59E0B'
                    : '#EF4444'
                }`,
                color:
                  feedback.includes('✅') || feedback.includes('🎉')
                    ? '#6ee7b7'
                    : feedback.includes('⏳')
                    ? '#fde68a'
                    : '#fca5a5',
              }}
            >
              {feedback}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
