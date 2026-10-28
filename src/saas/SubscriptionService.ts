import { authService } from './AuthService';
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
  activeProvider: 'stripe',
  stripePublishableKey: 'pk_live_51Pxxxxxxxxxxxxxxxxxxxxxx',
  stripeWebhookSecret: 'whsec_xxxxxxxxxxxxxxxxxxxxxx',
  stripeMonthlyCheckoutUrl: 'https://buy.stripe.com/test_worship_monthly',
  stripeAnnualCheckoutUrl: 'https://buy.stripe.com/test_worship_annual',
  asaasApiKey: '$aact_YTU5YTE0M2M6N2ZlYS00...',
  asaasWebhookToken: 'asaas_secret_token_123',
  asaasMonthlyCheckoutUrl: 'https://asaas.com/c/worship_mensal_pix',
  asaasAnnualCheckoutUrl: 'https://asaas.com/c/worship_anual_pix',
  asaasPixKey: 'financeiro@playback.pro',
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

  getCheckoutUrl(planId: SubscriptionPlanId, providerOverride?: 'stripe' | 'asaas'): string {
    const provider = providerOverride || this.config.activeProvider;
    if (provider === 'stripe') {
      if (planId === 'annual' || planId === 'church_vip') {
        return this.config.stripeAnnualCheckoutUrl || 'https://buy.stripe.com/test_worship_annual';
      }
      return this.config.stripeMonthlyCheckoutUrl || 'https://buy.stripe.com/test_worship_monthly';
    } else {
      if (planId === 'annual' || planId === 'church_vip') {
        return this.config.asaasAnnualCheckoutUrl || 'https://asaas.com/c/worship_anual_pix';
      }
      return this.config.asaasMonthlyCheckoutUrl || 'https://asaas.com/c/worship_mensal_pix';
    }
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
        reason: 'Sua assinatura expirou. Renove via Stripe ou Asaas para desbloquear o acesso.',
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

  setUserPlan(userId: string, planId: SubscriptionPlanId, provider: 'stripe' | 'asaas' = 'stripe'): User {
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

  /**
   * Stripe Webhook Handler
   * Handles:
   *  - `invoice.payment_succeeded`
   *  - `checkout.session.completed`
   *  - `invoice.payment_failed`
   *  - `customer.subscription.deleted`
   */
  handleStripeWebhook(event: { type: string; data?: { object?: any } }): WebhookResult {
    const eventType = event.type;
    const obj = event.data?.object || {};
    const email: string =
      obj.customer_email ||
      obj.customer_details?.email ||
      obj.receipt_email ||
      obj.email ||
      '';

    if (!email) {
      return {
        success: false,
        message: 'Stripe Webhook ignorado: e-mail do cliente não identificado no payload.',
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    const user = authService.findUserByEmail(email);
    if (!user) {
      return {
        success: false,
        message: `Stripe Webhook: usuário não encontrado com o e-mail ${email}.`,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    if (eventType === 'invoice.payment_succeeded' || eventType === 'checkout.session.completed') {
      const planId: SubscriptionPlanId = obj.amount_total && obj.amount_total > 30000 ? 'annual' : 'monthly';
      const days = planId === 'annual' ? 365 : 30;
      const updated = this.renewUserDays(user.id, days);
      return {
        success: true,
        message: `✅ Pagamento Stripe confirmado para ${user.name} (${user.email}). Assinatura liberada por +${days} dias!`,
        user: updated,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    if (eventType === 'invoice.payment_failed') {
      const updated = this.setUserStatus(user.id, 'past_due');
      return {
        success: true,
        message: `⚠️ Pagamento Stripe recusado para ${user.name} (${user.email}). Status alterado para Inadimplente (Bloqueado).`,
        user: updated,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    if (eventType === 'customer.subscription.deleted') {
      const updated = this.setUserStatus(user.id, 'canceled');
      return {
        success: true,
        message: `❌ Assinatura Stripe cancelada para ${user.name} (${user.email}). Acesso bloqueado.`,
        user: updated,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      success: true,
      message: `Stripe Webhook recebido (${eventType}), sem alteração necessária.`,
      user,
      eventProcessed: eventType,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Asaas Webhook Handler
   * Handles:
   *  - `PAYMENT_CONFIRMED`
   *  - `PAYMENT_RECEIVED`
   *  - `PAYMENT_OVERDUE`
   *  - `SUBSCRIPTION_CANCELED`
   *  - `PAYMENT_REFUNDED`
   */
  handleAsaasWebhook(payload: { event: string; payment?: any; subscription?: any }): WebhookResult {
    const eventType = payload.event;
    const payment = payload.payment || {};
    const email: string =
      payment.customerEmail ||
      payment.email ||
      payment.customer?.email ||
      '';

    if (!email) {
      return {
        success: false,
        message: 'Asaas Webhook ignorado: e-mail do pagador não identificado no payload.',
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    const user = authService.findUserByEmail(email);
    if (!user) {
      return {
        success: false,
        message: `Asaas Webhook: nenhum usuário cadastrado com o e-mail ${email}.`,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    if (eventType === 'PAYMENT_CONFIRMED' || eventType === 'PAYMENT_RECEIVED') {
      const value = payment.value || 0;
      const planId: SubscriptionPlanId = value >= 400 ? 'annual' : 'monthly';
      const days = planId === 'annual' ? 365 : 30;
      const updated = this.renewUserDays(user.id, days);
      return {
        success: true,
        message: `✅ Pagamento Asaas (Pix/Boleto/Cartão) confirmado para ${user.name} (${user.email}). Assinatura liberada por +${days} dias!`,
        user: updated,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    if (eventType === 'PAYMENT_OVERDUE') {
      const updated = this.setUserStatus(user.id, 'past_due');
      return {
        success: true,
        message: `⚠️ Cobrança Asaas vencida para ${user.name} (${user.email}). Status alterado para Inadimplente.`,
        user: updated,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    if (eventType === 'SUBSCRIPTION_CANCELED' || eventType === 'PAYMENT_REFUNDED') {
      const updated = this.setUserStatus(user.id, 'canceled');
      return {
        success: true,
        message: `❌ Assinatura Asaas cancelada ou estornada para ${user.name} (${user.email}). Acesso bloqueado.`,
        user: updated,
        eventProcessed: eventType,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      success: true,
      message: `Asaas Webhook recebido (${eventType}), sem alteração necessária.`,
      user,
      eventProcessed: eventType,
      timestamp: new Date().toISOString(),
    };
  }
}

export const subscriptionService = new SubscriptionService();
