import { authService } from './AuthService';
import { supabase } from './supabaseClient';
import type {
  PaymentGatewayConfig,
  PlanDetails,
  SubscriptionPlanId,
  SubscriptionStatus,
  User,
  UserApprovalStatus,
  UserSubscription,
} from './types';

const LS_PAYMENT_CONFIG_KEY = 'wpp_saas_payment_config_v1';

export const PLANS: Record<SubscriptionPlanId, PlanDetails> = {
  monthly: {
    id: 'monthly',
    name: 'Worship Mensal',
    priceBrl: 49.9,
    interval: 'monthly',
    description: 'Acesso completo a todas as funções para músicos e líderes de louvor.',
    features: [
      'Acesso ao Catálogo Master de MultiTracks (Google Drive)',
      'Mixer Profissional com 8 Canais e Saídas USB',
      'Download e Cache de Stems Offline',
      'Sincronização de Repertórios e Volumes em Nuvem',
      'Vozes Guia em Português e Cues de Seções',
    ],
  },
  annual: {
    id: 'annual',
    name: 'Worship Pro Anual',
    priceBrl: 479.0,
    interval: 'annual',
    badge: 'MAIS POPULAR (2 MESES OFF)',
    description: 'Melhor custo-benefício. Economize mais de 20% com faturamento anual.',
    features: [
      'Tudo incluído no Plano Mensal',
      '2 Meses Grátis de Economia',
      'Prioridade de Alta Velocidade nos Downloads',
      'Acesso Antecipado a Novos Arranjos e Músicas',
      'Suporte Técnico Dedicado via WhatsApp',
    ],
  },
  church_vip: {
    id: 'church_vip',
    name: 'Igreja Louvor VIP',
    priceBrl: 990.0,
    interval: 'annual',
    badge: 'EQUIPES & IGREJAS',
    description: 'Ideal para o Ministério de Louvor da igreja com múltiplos computadores.',
    features: [
      'Instalação liberada em todos os notebooks da igreja',
      'Repertórios compartilhados entre toda a equipe',
      'Catálogo completo desbloqueado sem limite de faixas',
      'Suporte prioritário para eventos e conferências',
    ],
  },
  admin_vip: {
    id: 'admin_vip',
    name: 'Acesso Master Administradora',
    priceBrl: 0,
    interval: 'lifetime',
    badge: 'MASTER VIP',
    description: 'Conta de Administradora do Sistema com controle mestre irrestrito.',
    features: [
      'Acesso Irrestrito Perpétuo (Sem Bloqueio de Assinatura)',
      'Painel de Controle Cloud e Service Account Google Drive',
      'Gerenciamento de Assinaturas e Usuários',
      'Sincronização Master de Repertório',
    ],
  },
};

const DEFAULT_CONFIG: PaymentGatewayConfig = {
  activeProvider: 'infinitepay',
  infinitepayHandle: 'multitracks_pro',
  infinitepayApiKey: '',
  infinitepayWebhookSecret: '',
  infinitepayMonthlyCheckoutUrl: 'https://infinitepay.io/pay/multitracks_pro/49.90',
  infinitepayAnnualCheckoutUrl: 'https://infinitepay.io/pay/multitracks_pro/479.00',
};

export interface AccessCheckResult {
  allowed: boolean;
  status: SubscriptionStatus;
  isExpired: boolean;
  daysRemaining: number;
  reason?: string;
  planName?: string;
  approvalStatus?: UserApprovalStatus;
}

export interface WebhookResult {
  success: boolean;
  message: string;
  user?: User;
  eventProcessed: string;
  timestamp: string;
}

class SubscriptionService {
  private config: PaymentGatewayConfig = { ...DEFAULT_CONFIG };
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    try {
      const stored = localStorage.getItem(LS_PAYMENT_CONFIG_KEY);
      if (stored) {
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.warn('Falha ao carregar configuração de pagamento:', e);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  getGatewayConfig(): PaymentGatewayConfig {
    return { ...this.config };
  }

  saveGatewayConfig(patch: Partial<PaymentGatewayConfig>) {
    this.config = { ...this.config, ...patch };
    localStorage.setItem(LS_PAYMENT_CONFIG_KEY, JSON.stringify(this.config));
    this.notify();
  }

  onSubscriptionUpdate(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify() {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  getPlan(planId: SubscriptionPlanId): PlanDetails {
    return PLANS[planId] || PLANS.monthly;
  }

  getAllPlans(): PlanDetails[] {
    return [PLANS.monthly, PLANS.annual, PLANS.church_vip];
  }

  getCheckoutUrl(planId: SubscriptionPlanId): string {
    const handle = this.config.infinitepayHandle?.replace(/^\$/, '') || 'multitracks_pro';
    const price = this.getPlan(planId).priceBrl;
    if (planId === 'annual' || planId === 'church_vip') {
      return this.config.infinitepayAnnualCheckoutUrl || `https://infinitepay.io/pay/${handle}/${price.toFixed(2)}`;
    }
    return this.config.infinitepayMonthlyCheckoutUrl || `https://infinitepay.io/pay/${handle}/${price.toFixed(2)}`;
  }

  async createInfinitePayCharge(
    userId: string,
    planId: SubscriptionPlanId,
    method: 'pix' | 'card' = 'pix',
    customer?: { name?: string; email?: string; phone?: string; cpf?: string },
  ): Promise<{
    ok: boolean;
    pixCode: string;
    qrcodeUrl: string;
    checkoutUrl: string;
    chargeId: string;
    amountFormatted: string;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('create-infinitepay-charge', {
        body: {
          userId,
          planId,
          method,
          customer: {
            name: customer?.name || '',
            email: customer?.email || '',
            phone: customer?.phone || '',
            cpf: customer?.cpf || '',
          },
        },
      });

      if (!error && data && data.ok) {
        return data;
      }
    } catch (edgeErr) {
      console.warn('[SubscriptionService] Edge function invoke fallback:', edgeErr);
    }

    const plan = this.getPlan(planId);
    const handle = this.config.infinitepayHandle?.replace(/^\$/, '') || 'multitracks_pro';
    const pixCode = `00020126580014br.gov.bcb.pix0136${userId}520400005303986540${plan.priceBrl.toFixed(2)}5802BR5916InfinitePay Pagam6009Sao Paulo62240520WPP${Date.now()}6304`;
    const qrcodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pixCode)}`;
    const checkoutUrl = `https://infinitepay.io/pay/${handle}/${plan.priceBrl.toFixed(2)}`;

    return {
      ok: true,
      pixCode,
      qrcodeUrl,
      checkoutUrl,
      chargeId: `inf_local_${Date.now()}`,
      amountFormatted: plan.priceBrl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    };
  }

  /**
   * Main Subscription Guard check.
   * Admin accounts are perpetually exempted from blocking.
   * For regular users, checks if subscription is active and not past expiration date.
   */
  checkUserAccess(user: User | null): AccessCheckResult {
    if (!user) {
      return {
        allowed: false,
        status: 'unpaid',
        isExpired: true,
        daysRemaining: 0,
        reason: 'Faça login com seu e-mail e senha para utilizar o software.',
      };
    }

    // Admins are always authorized
    if (user.role === 'admin') {
      return {
        allowed: true,
        status: 'active',
        isExpired: false,
        daysRemaining: 9999,
        planName: 'Administradora Master (VIP Perpétuo)',
        approvalStatus: 'active',
      };
    }

    // Check account approval status
    if (user.status === 'pending') {
      return {
        allowed: false,
        status: 'trialing',
        isExpired: false,
        daysRemaining: 0,
        approvalStatus: 'pending',
        reason: 'Seu cadastro está em análise pela administração. Você receberá acesso assim que for aprovado.',
      };
    }

    if (user.status === 'rejected') {
      return {
        allowed: false,
        status: 'unpaid',
        isExpired: true,
        daysRemaining: 0,
        approvalStatus: 'rejected',
        reason: 'Seu acesso foi negado pela administração. Entre em contato com o suporte para mais informações.',
      };
    }

    const sub = user.subscription;
    if (!sub) {
      return {
        allowed: false,
        status: 'unpaid',
        isExpired: true,
        daysRemaining: 0,
        reason: 'Nenhuma assinatura ativa encontrada para este usuário.',
      };
    }

    const now = Date.now();
    const periodEnd = new Date(sub.currentPeriodEnd).getTime();
    const diffMs = periodEnd - now;
    const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

    // Check expiration date
    if (periodEnd <= now && sub.status === 'active') {
      // Auto-transition to past_due because current period has lapsed
      this.setUserStatus(user.id, 'past_due');
      return {
        allowed: false,
        status: 'past_due',
        isExpired: true,
        daysRemaining: 0,
        planName: sub.planName,
        reason: 'Sua assinatura expirou. Renove via InfinitePay (Pix ou Cartão) para desbloquear o acesso.',
      };
    }

    if (sub.status === 'past_due') {
      return {
        allowed: false,
        status: 'past_due',
        isExpired: true,
        daysRemaining: 0,
        planName: sub.planName,
        reason: 'Acesso suspenso por inadimplência. Regularize o pagamento para continuar.',
      };
    }

    if (sub.status === 'canceled') {
      return {
        allowed: false,
        status: 'canceled',
        isExpired: true,
        daysRemaining: 0,
        planName: sub.planName,
        reason: 'Sua assinatura foi cancelada. Reative o plano para acessar o catálogo e mixer.',
      };
    }

    if (sub.status === 'unpaid') {
      return {
        allowed: false,
        status: 'unpaid',
        isExpired: true,
        daysRemaining: 0,
        planName: sub.planName,
        reason: 'Pagamento pendente de confirmação.',
      };
    }

    // Active or trialing within period
    return {
      allowed: true,
      status: sub.status,
      isExpired: false,
      daysRemaining,
      planName: sub.planName,
    };
  }

  // Administrative overrides
  setUserStatus(userId: string, status: SubscriptionStatus): User {
    const user = authService.getUserById(userId);
    if (!user) throw new Error('Usuário não encontrado.');

    const updatedSub: UserSubscription = {
      ...(user.subscription || {
        planId: 'monthly',
        planName: 'Worship Mensal',
        provider: this.config.activeProvider,
        currentPeriodEnd: new Date().toISOString(),
      }),
      status,
    };

    const updated = authService.updateUser(userId, { subscription: updatedSub });
    this.notify();
    return updated;
  }

  renewUserDays(userId: string, days = 30): User {
    const user = authService.getUserById(userId);
    if (!user) throw new Error('Usuário não encontrado.');

    const sub = user.subscription;
    const baseDate = sub && new Date(sub.currentPeriodEnd).getTime() > Date.now()
      ? new Date(sub.currentPeriodEnd).getTime()
      : Date.now();

    const newPeriodEnd = new Date(baseDate + days * 24 * 60 * 60 * 1000).toISOString();

    const updatedSub: UserSubscription = {
      ...(sub || {
        planId: 'monthly',
        planName: 'Worship Mensal',
        provider: this.config.activeProvider,
      }),
      status: 'active',
      currentPeriodEnd: newPeriodEnd,
      lastPaymentDate: new Date().toISOString(),
    };

    const updated = authService.updateUser(userId, { subscription: updatedSub });
    this.notify();
    return updated;
  }

  grantVip(userId: string): User {
    const user = authService.getUserById(userId);
    if (!user) throw new Error('Usuário não encontrado.');

    const vipSub: UserSubscription = {
      planId: 'church_vip',
      planName: 'Igreja Louvor VIP (Isenção Concedida)',
      status: 'active',
      provider: 'manual',
      currentPeriodEnd: '2099-12-31T23:59:59.000Z',
      billingCycle: 'lifetime',
      priceBrl: 0,
      lastPaymentDate: new Date().toISOString(),
    };

    const updated = authService.updateUser(userId, { subscription: vipSub });
    this.notify();
    return updated;
  }

  setUserPlan(userId: string, planId: SubscriptionPlanId, provider: PaymentProvider = 'infinitepay'): User {
    const user = authService.getUserById(userId);
    if (!user) throw new Error('Usuário não encontrado.');

    const plan = this.getPlan(planId);
    const durationDays = plan.interval === 'annual' ? 365 : 30;

    const sub: UserSubscription = {
      planId,
      planName: plan.name,
      status: 'active',
      provider,
      priceBrl: plan.priceBrl,
      billingCycle: plan.interval,
      currentPeriodEnd: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString(),
      lastPaymentDate: new Date().toISOString(),
    };

    const updated = authService.updateUser(userId, { subscription: sub });
    this.notify();
    return updated;
  }
}

export const subscriptionService = new SubscriptionService();
