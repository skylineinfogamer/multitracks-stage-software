import { useEffect, useState } from 'react';
import { subscriptionService } from '../saas/SubscriptionService';
import { authService } from '../saas/AuthService';
import { masterCatalogService } from '../saas/MasterCatalogService';
import { supabase } from '../saas/supabaseClient';
import { openExternalUrl } from '../utils/openUrl';
import type { PlanDetails, SubscriptionPlanId, User } from '../saas/types';

interface Props {
  user: User;
  reason?: string;
  onLogout: () => void;
  onUnlocked?: () => void;
}

export type PaymentMode = 'select_plan' | 'pix_qrcode';

export function SubscriptionGuardModal({ user, reason, onLogout, onUnlocked }: Props) {
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanId>('monthly');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('select_plan');

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

    console.log(`[Supabase Realtime] Inicializando listener para o usuário: ${user.id}`);

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
      .subscribe((status) => {
        console.log(`[Supabase Realtime] Status da conexão: ${status}`);
      });

    // Polling de redundância a cada 3 segundos caso o WebSocket Realtime sofra restrição de rede
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
    }, 3000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [user.id, onUnlocked]);

  const handleCreatePixInfinitePay = async () => {
    setLoading(true);
    setFeedback('⚡ Gerando cobrança PIX via InfinitePay...');
    try {
      const res = await subscriptionService.createInfinitePayCharge(
        user.id,
        selectedPlan,
        'pix',
        { name: user.name, email: user.email },
      );

      // 1. Verifica se contém pixCode (PIX Copia e Cola) e qrcodeUrl
      if (res && res.pixCode && res.qrcodeUrl) {
        setPixData({
          pixCode: res.pixCode,
          qrcodeUrl: res.qrcodeUrl,
          checkoutUrl: res.redirectUrl || res.checkoutUrl,
          amountFormatted: res.amountFormatted,
        });
        // NÃO abre o navegador externo! Renderiza na própria tela do software:
        setPaymentMode('pix_qrcode');
        setFeedback('⚡ QR Code PIX gerado! Pague com seu app de banco para liberação automática.');
      } else if (res && (res.redirectUrl || res.checkoutUrl)) {
        // Fallback: se não vierem os dados de PIX, abre a URL de checkout no navegador
        const url = res.redirectUrl || res.checkoutUrl;
        await openExternalUrl(url);
        setFeedback('✅ Abrindo checkout InfinitePay no seu navegador...');
      } else {
        throw new Error('Não foi possível gerar os dados de pagamento da InfinitePay.');
      }
    } catch (e: any) {
      setFeedback(`❌ Falha ao processar PIX: ${e.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenInfinitePayCard = async () => {
    setLoading(true);
    setFeedback('⚡ Gerando checkout para Cartão de Crédito...');
    try {
      const res = await subscriptionService.createInfinitePayCharge(
        user.id,
        selectedPlan,
        'card',
        { name: user.name, email: user.email },
      );
      const url = res.redirectUrl || res.checkoutUrl;
      if (url) {
        // Abre no navegador padrão usando a API do Tauri
        const opened = await openExternalUrl(url);
        if (opened) {
          setFeedback('✅ Abrindo checkout com Cartão InfinitePay no seu navegador padrão...');
        } else {
          setFeedback(`⚠️ Acesse o checkout diretamente pelo link: ${url}`);
        }
      } else {
        throw new Error('URL de checkout não retornada pela InfinitePay.');
      }
    } catch (e: any) {
      const fallbackUrl = subscriptionService.getCheckoutUrl(selectedPlan);
      await openExternalUrl(fallbackUrl);
      setFeedback(`⚠️ Abrindo link alternativo de checkout: ${e.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const isPending = user.status === 'pending';
  const isRejected = user.status === 'rejected';

  const [plans, setPlans] = useState<PlanDetails[]>(() => subscriptionService.getAllPlans());

  useEffect(() => {
    subscriptionService.fetchPlans().then((loaded) => {
      if (loaded && loaded.length > 0) {
        setPlans(loaded);
        setSelectedPlan((prev) => {
          if (!loaded.some((p) => p.id === prev)) {
            return (loaded[0].id as SubscriptionPlanId);
          }
          return prev;
        });
      }
    }).catch((err) => {
      console.warn('[SubscriptionGuardModal] Usando planos locais por falha no fetch:', err);
    });
  }, []);

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

  const handleCheckStatus = async () => {
    setLoading(true);
    setFeedback('Consultando confirmação de pagamento no Supabase...');
    try {
      const refreshed = await authService.refreshCurrentUser();
      if (refreshed && refreshed.status === 'active') {
        setPaymentConfirmed(true);
        setFeedback('✅ Pagamento identificado! Seu acesso foi liberado com sucesso.');
        setTimeout(() => {
          onUnlocked?.();
        }, 1200);
        return;
      }
      setFeedback('Ainda não identificamos a confirmação bancária. Seu cadastro continua com status Pendente no sistema. Se acabou de pagar via Pix ou Cartão, aguarde alguns instantes para a compensação e verifique novamente.');
    } catch {
      setFeedback('Erro ao consultar status. Verifique sua conexão.');
    } finally {
      setLoading(false);
    }
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
            background: isRejected
              ? 'linear-gradient(90deg, #991b1b, #ef4444)'
              : isPending
              ? 'linear-gradient(90deg, #059669, #10b981)'
              : 'linear-gradient(90deg, #b45309, #d97706)',
            padding: '16px 20px',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 24 }}>{isRejected ? '⛔' : isPending ? '⚡' : '⚠️'}</span>
            <div>
              <strong style={{ fontSize: 14, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                {isRejected
                  ? 'ACESSO RECUSADO PELA ADMINISTRAÇÃO'
                  : isPending
                  ? '⚡ ATIVAÇÃO DA CONTA — ESCOLHA SEU PLANO'
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
          {isRejected ? (
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
            /* Active Payment & Subscription View (For both newly registered & expired accounts) */
            <>
              <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.6 }}>
                {isPending
                  ? `Olá, ${user.name}! Seu cadastro foi concluído com sucesso. Para ativar sua conta e liberar o acesso completo ao mixer de palco, vozes guias e ao download de MultiTracks, escolha seu plano abaixo:`
                  : (reason || 'Seu período de assinatura encerrou ou o pagamento da mensalidade está pendente. Para continuar utilizando o mixer de palco, vozes guias e o download de MultiTracks do Google Drive, regularize sua assinatura:')}
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

              {/* VIEW 1: PIX IN-APP QR CODE PAYMENT */}
              {paymentMode === 'pix_qrcode' && pixData ? (
                <div
                  style={{
                    background: '#13151b',
                    border: '1px solid #10b981',
                    borderRadius: 12,
                    padding: 20,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 16,
                    boxShadow: '0 10px 30px rgba(16, 185, 129, 0.15)',
                  }}
                >
                  {/* Top Bar inside PIX View */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      width: '100%',
                      borderBottom: '1px solid #232733',
                      paddingBottom: 12,
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 22 }}>⚡</span>
                      <div>
                        <strong style={{ fontSize: 15, color: '#34d399' }}>Pagamento via PIX — InfinitePay</strong>
                        <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                          Plano: <b style={{ color: '#fff' }}>{plans.find((p) => p.id === selectedPlan)?.name}</b> · Valor: <b style={{ color: '#38bdf8' }}>{pixData.amountFormatted}</b>
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPaymentMode('select_plan')}
                      className="btn small"
                      style={{ fontSize: 11, color: '#cbd5e1', borderColor: '#334155' }}
                    >
                      ⬅️ Trocar Plano
                    </button>
                  </div>

                  {/* QR Code Container */}
                  <div
                    style={{
                      background: '#ffffff',
                      padding: 14,
                      borderRadius: 12,
                      boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                    }}
                  >
                    <img
                      src={pixData.qrcodeUrl}
                      alt="PIX QR Code InfinitePay"
                      style={{ width: 200, height: 200, display: 'block', borderRadius: 4 }}
                    />
                  </div>

                  {/* Instructions */}
                  <div style={{ fontSize: 12, color: '#cbd5e1', textAlign: 'center', maxWidth: 440, lineHeight: 1.5 }}>
                    1. Abra o app do seu banco ou instituição financeira.<br />
                    2. Acesse a área <b>PIX</b> e escolha <b>Ler QR Code</b> ou <b>Pix Copia e Cola</b>.<br />
                    3. Assim que efetuar o pagamento, a liberação ocorre <b>automaticamente nesta tela</b>!
                  </div>

                  {/* Copia e Cola Box */}
                  <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>
                      Código PIX Copia e Cola:
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        readOnly
                        value={pixData.pixCode}
                        onFocus={(e) => e.target.select()}
                        style={{
                          flex: 1,
                          background: '#090a0d',
                          border: '1px solid #272a33',
                          color: '#38bdf8',
                          fontSize: 11.5,
                          fontFamily: 'monospace',
                          padding: '10px 12px',
                          borderRadius: 6,
                          letterSpacing: 0.3,
                        }}
                      />
                      <button
                        type="button"
                        className="btn primary"
                        style={{
                          background: copiedPix ? '#059669' : '#10b981',
                          borderColor: copiedPix ? '#059669' : '#10b981',
                          color: '#fff',
                          fontSize: 12,
                          fontWeight: 700,
                          padding: '0 16px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          whiteSpace: 'nowrap',
                        }}
                        onClick={() => {
                          navigator.clipboard.writeText(pixData.pixCode);
                          setCopiedPix(true);
                          setTimeout(() => setCopiedPix(false), 3000);
                        }}
                      >
                        {copiedPix ? '✅ Copiado!' : '📋 Copiar Código'}
                      </button>
                    </div>
                  </div>

                  {/* Supabase Realtime Live Indicator */}
                  <div
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      fontSize: 12,
                      color: paymentConfirmed ? '#34d399' : '#38bdf8',
                      background: paymentConfirmed ? 'rgba(16, 185, 129, 0.15)' : 'rgba(0, 153, 255, 0.08)',
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: `1px solid ${paymentConfirmed ? '#10b981' : 'rgba(0, 153, 255, 0.25)'}`,
                    }}
                  >
                    <span style={{ fontSize: 16 }}>
                      {paymentConfirmed ? '🎉' : '🔄'}
                    </span>
                    <span style={{ fontWeight: 600 }}>
                      {paymentConfirmed
                        ? 'Pagamento Confirmado! Desbloqueando software…'
                        : 'Aguardando confirmação em tempo real (Supabase Realtime)…'}
                    </span>
                  </div>

                  {/* Action buttons inside PIX view */}
                  <div style={{ display: 'flex', gap: 10, width: '100%', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={handleCheckStatus}
                      disabled={loading}
                      style={{
                        flex: 1,
                        background: '#1f242d',
                        border: '1px solid #3b4252',
                        color: '#f8fafc',
                        borderRadius: 8,
                        padding: '10px 14px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: loading ? 'wait' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                      }}
                    >
                      {loading ? 'Consultando…' : '🔄 Já Paguei? Verificar Status'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPaymentMode('select_plan')}
                      style={{
                        background: '#16181e',
                        border: '1px solid #2e323b',
                        color: '#94a3b8',
                        borderRadius: 8,
                        padding: '10px 14px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      ⬅️ Escolher Outro Método
                    </button>

                    {pixData.checkoutUrl && (
                      <button
                        type="button"
                        onClick={() => openExternalUrl(pixData.checkoutUrl)}
                        style={{
                          background: 'transparent',
                          border: '1px solid #334155',
                          color: '#94a3b8',
                          borderRadius: 8,
                          padding: '10px 14px',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                        title="Abrir página completa de checkout no navegador externo"
                      >
                        🌐 Pagar pelo Navegador
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                /* VIEW 2: SELECT PLAN AND CHOOSE PAYMENT METHOD */
                <>
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
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
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
                                /{p.interval === 'annual' || p.interval === 'year' ? 'ano' : p.interval === 'lifetime' ? 'vitalício' : 'mês'}
                              </span>
                            </div>
                            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{p.description}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Action Buttons: InfinitePay (PIX & Cartão) */}
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
                        disabled={loading}
                        style={{
                          background: '#0ea5e9',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 8,
                          padding: '12px 16px',
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: loading ? 'wait' : 'pointer',
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

                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={handleOpenWhatsApp}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#94a3b8',
                          fontSize: 11.5,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          textDecoration: 'underline',
                        }}
                      >
                        💬 Dúvidas ou precisa de suporte com sua conta? Falar no WhatsApp
                      </button>
                    </div>
                  </div>
                </>
              )}
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
