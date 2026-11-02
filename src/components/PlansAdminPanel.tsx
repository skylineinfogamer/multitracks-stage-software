import React, { useEffect, useState } from 'react';
import { subscriptionService } from '../saas/SubscriptionService';
import type { PlanDetails } from '../saas/types';

interface Props {
  onPlanChanged?: () => void;
}

export function PlansAdminPanel({ onPlanChanged }: Props) {
  const [plans, setPlans] = useState<PlanDetails[]>(() => subscriptionService.getAllPlans(true));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Modal de Criação / Edição
  const [modalOpen, setModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [formId, setFormId] = useState('');
  const [formName, setFormName] = useState('');
  const [formPriceBrl, setFormPriceBrl] = useState('49.90');
  const [formInterval, setFormInterval] = useState<'month' | 'year' | 'lifetime'>('month');
  const [formDescription, setFormDescription] = useState('');
  const [formIsActive, setFormIsActive] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const [copiedSql, setCopiedSql] = useState(false);

  const reloadPlans = async () => {
    setLoading(true);
    try {
      const data = await subscriptionService.fetchPlans();
      setPlans([...data]);
      onPlanChanged?.();
    } catch (err: any) {
      setFeedback({ type: 'error', message: `Erro ao buscar planos: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reloadPlans();
  }, []);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setFeedback({ type, message });
    setTimeout(() => {
      setFeedback(null);
    }, 4000);
  };

  const handleOpenCreate = () => {
    setIsEditing(false);
    setFormId('');
    setFormName('');
    setFormPriceBrl('49.90');
    setFormInterval('month');
    setFormDescription('');
    setFormIsActive(true);
    setFormError(null);
    setModalOpen(true);
  };

  const handleOpenEdit = (plan: PlanDetails) => {
    setIsEditing(true);
    setFormId(plan.id);
    setFormName(plan.name);
    setFormPriceBrl(plan.priceBrl.toFixed(2));
    setFormInterval(plan.interval === 'annual' ? 'year' : plan.interval === 'lifetime' ? 'lifetime' : 'month');
    setFormDescription(plan.description || '');
    setFormIsActive(plan.is_active !== false);
    setFormError(null);
    setModalOpen(true);
  };

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const cleanId = formId.trim().toLowerCase().replace(/\s+/g, '_');
    const cleanName = formName.trim();
    const parsedPrice = parseFloat(formPriceBrl.replace(',', '.'));

    if (!cleanId) {
      setFormError('Identificador / Chave do plano é obrigatório.');
      return;
    }
    if (!cleanName) {
      setFormError('Nome do plano é obrigatório.');
      return;
    }
    if (isNaN(parsedPrice) || parsedPrice < 0) {
      setFormError('Insira um preço válido maior ou igual a zero.');
      return;
    }

    setSaving(true);
    try {
      await subscriptionService.savePlan({
        id: cleanId,
        name: cleanName,
        priceBrl: parsedPrice,
        interval: formInterval,
        description: formDescription.trim(),
        is_active: formIsActive,
      });

      setModalOpen(false);
      await reloadPlans();
      showToast(
        isEditing
          ? `✅ Plano "${cleanName}" atualizado com sucesso no Supabase!`
          : `🎉 Novo plano "${cleanName}" criado com sucesso no Supabase!`
      );
    } catch (err: any) {
      setFormError(err.message || 'Erro ao salvar plano no banco de dados.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (plan: PlanDetails) => {
    const nextState = plan.is_active === false;
    try {
      await subscriptionService.togglePlanActive(plan.id, nextState);
      await reloadPlans();
      showToast(`Plano "${plan.name}" agora está ${nextState ? '🟢 ATIVO' : '⚪ INATIVO'}.`);
    } catch (err: any) {
      showToast(`Falha ao alterar status: ${err.message}`, 'error');
    }
  };

  const handleDelete = async (plan: PlanDetails) => {
    const confirmed = window.confirm(
      `Tem certeza que deseja excluir permanentemente o plano "${plan.name}" (${plan.id})?\n\nEsta alteração refletirá imediatamente no Supabase e no Checkout.`
    );
    if (!confirmed) return;

    try {
      await subscriptionService.deletePlan(plan.id);
      await reloadPlans();
      showToast(`🗑️ Plano "${plan.name}" removido com sucesso.`);
    } catch (err: any) {
      showToast(`Erro ao excluir plano: ${err.message}`, 'error');
    }
  };

  const PLANS_SQL = `-- Copie e execute no SQL Editor do Supabase se a tabela 'plans' ainda não existir:
CREATE TABLE IF NOT EXISTS public.plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL, -- Valor em centavos (ex: 4990 = R$ 49,90)
  interval TEXT NOT NULL DEFAULT 'month',
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can view active plans" ON public.plans;
CREATE POLICY "Anyone can view active plans" ON public.plans FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admins can manage plans" ON public.plans;
CREATE POLICY "Admins can manage plans" ON public.plans FOR ALL USING (true);
`;

  const handleCopySql = () => {
    navigator.clipboard.writeText(PLANS_SQL);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2500);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Top Banner and Actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: '#16181e',
          padding: '14px 18px',
          borderRadius: 10,
          border: '1px solid #2e323b',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 15, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>💳</span> Gestão de Planos de Assinatura
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
            Os planos cadastrados abaixo sincronizam diretamente com a tabela <code>plans</code> do Supabase e são carregados no Checkout da InfinitePay.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn small"
            onClick={reloadPlans}
            disabled={loading}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {loading ? '🔄 Atualizando…' : '🔄 Recarregar'}
          </button>
          <button
            type="button"
            className="btn small primary"
            onClick={handleOpenCreate}
            style={{
              background: '#0099ff',
              borderColor: '#0099ff',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>➕</span> Criar Novo Plano
          </button>
        </div>
      </div>

      {/* Visual Feedback / Alerts */}
      {feedback && (
        <div
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: feedback.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            border: `1px solid ${feedback.type === 'success' ? '#10b981' : '#ef4444'}`,
            color: feedback.type === 'success' ? '#34d399' : '#f87171',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          }}
        >
          <span>{feedback.type === 'success' ? '🎉' : '❌'}</span>
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Cards Grid of Current Plans */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        {plans.map((p) => {
          const isActive = p.is_active !== false;
          const priceCents = p.priceCents || Math.round(p.priceBrl * 100);

          return (
            <div
              key={p.id}
              style={{
                background: isActive ? '#13151b' : '#0e1014',
                border: `1px solid ${isActive ? '#2e323b' : '#22252c'}`,
                borderRadius: 10,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 12,
                opacity: isActive ? 1 : 0.65,
                transition: 'all 0.15s ease',
                position: 'relative',
              }}
            >
              {/* Header inside card */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 10.5,
                        background: '#1f2430',
                        color: '#38bdf8',
                        padding: '2px 6px',
                        borderRadius: 4,
                        border: '1px solid #334155',
                      }}
                    >
                      ID: {p.id}
                    </span>
                    <h4 style={{ margin: '6px 0 2px', fontSize: 15, color: '#f1f5f9', fontWeight: 700 }}>
                      {p.name}
                    </h4>
                  </div>

                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 12,
                      background: isActive ? 'rgba(16, 185, 129, 0.2)' : 'rgba(148, 163, 184, 0.2)',
                      color: isActive ? '#34d399' : '#94a3b8',
                      border: `1px solid ${isActive ? '#10b981' : '#64748b'}`,
                    }}
                  >
                    {isActive ? '🟢 Ativo' : '⚪ Inativo'}
                  </span>
                </div>

                {/* Price Display */}
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: '#fff' }}>
                    R$ {p.priceBrl.toFixed(2).replace('.', ',')}
                  </span>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>
                    /{p.interval === 'annual' ? 'ano' : p.interval === 'lifetime' ? 'vitalício' : 'mês'}
                  </span>
                  <span style={{ fontSize: 10, color: '#64748b', marginLeft: 'auto' }}>
                    ({priceCents.toLocaleString('pt-BR')} centavos)
                  </span>
                </div>

                {/* Description */}
                {p.description && (
                  <p style={{ margin: '8px 0 0', fontSize: 12, color: '#94a3b8', lineHeight: 1.4 }}>
                    {p.description}
                  </p>
                )}
              </div>

              {/* Card Actions */}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  borderTop: '1px solid #232733',
                  paddingTop: 10,
                  marginTop: 6,
                  alignItems: 'center',
                }}
              >
                <button
                  type="button"
                  className="btn small"
                  onClick={() => handleOpenEdit(p)}
                  style={{ flex: 1, fontSize: 11.5, fontWeight: 600 }}
                >
                  ✏️ Editar
                </button>

                <button
                  type="button"
                  className="btn small"
                  onClick={() => handleToggleActive(p)}
                  style={{
                    fontSize: 11.5,
                    color: isActive ? '#f59e0b' : '#34d399',
                    borderColor: isActive ? 'rgba(245, 158, 11, 0.4)' : 'rgba(16, 185, 129, 0.4)',
                  }}
                  title={isActive ? 'Desativar este plano no checkout' : 'Ativar este plano no checkout'}
                >
                  {isActive ? 'Pausar' : 'Ativar'}
                </button>

                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => handleDelete(p)}
                  style={{ fontSize: 11.5, padding: '4px 8px' }}
                  title="Excluir plano do Supabase"
                >
                  🗑️
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* SQL Migration Helper Banner */}
      <div
        style={{
          background: '#0d0f14',
          border: '1px solid #2e323b',
          borderRadius: 8,
          padding: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginTop: 6,
        }}
      >
        <div style={{ fontSize: 12, color: '#94a3b8' }}>
          💡 <b>Dica Supabase:</b> Caso a tabela <code>plans</code> ainda não tenha sido criada no seu projeto Supabase, você pode copiar o script SQL pronto para criá-la com um clique.
        </div>
        <button
          type="button"
          className="btn small"
          onClick={handleCopySql}
          style={{ fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}
        >
          {copiedSql ? '✅ SQL Copiado!' : '📋 Copiar SQL da Tabela plans'}
        </button>
      </div>

      {/* MODAL: CRIAR OU EDITAR PLANO */}
      {modalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999999,
            background: 'rgba(0, 0, 0, 0.85)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 480,
              background: '#16181e',
              border: '1px solid #3b4252',
              borderRadius: 12,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 20px 40px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0, fontSize: 16, color: '#f8fafc', fontWeight: 700 }}>
                {isEditing ? `Editar Plano: ${formName || formId}` : 'Criar Novo Plano de Assinatura'}
              </h4>
              <button
                type="button"
                className="btn small"
                onClick={() => setModalOpen(false)}
                style={{ padding: '2px 8px', fontSize: 12 }}
              >
                ✕
              </button>
            </div>

            {formError && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid #ef4444',
                  color: '#f87171',
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                ❌ {formError}
              </div>
            )}

            <form onSubmit={handleSaveForm} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* ID / Chave */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#cbd5e1' }}>
                <span>
                  Identificador / Chave Única (slug):{' '}
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>(ex: monthly, annual, trimestral, vip)</span>
                </span>
                <input
                  type="text"
                  required
                  disabled={isEditing}
                  value={formId}
                  onChange={(e) => setFormId(e.target.value.toLowerCase().replace(/\s+/g, '_'))}
                  placeholder="ex: trimestral"
                  style={{
                    fontSize: 12.5,
                    fontFamily: 'monospace',
                    background: isEditing ? '#0d0e11' : '#111317',
                    border: '1px solid #2e323b',
                    borderRadius: 6,
                    padding: '8px 10px',
                    color: isEditing ? '#94a3b8' : '#38bdf8',
                  }}
                />
              </label>

              {/* Nome do Plano */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#cbd5e1' }}>
                Nome do Plano:
                <input
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Ex: Plano Worship Trimestral"
                  style={{
                    fontSize: 12.5,
                    background: '#111317',
                    border: '1px solid #2e323b',
                    borderRadius: 6,
                    padding: '8px 10px',
                  }}
                />
              </label>

              {/* Preço em Reais e Intervalo */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#cbd5e1' }}>
                  <span>
                    Preço em Reais (R$):{' '}
                    <span style={{ fontSize: 10, color: '#38bdf8' }}>
                      ({Math.round(parseFloat(formPriceBrl.replace(',', '.') || '0') * 100)} centavos)
                    </span>
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={formPriceBrl}
                    onChange={(e) => setFormPriceBrl(e.target.value)}
                    placeholder="49.90"
                    style={{
                      fontSize: 13,
                      background: '#111317',
                      border: '1px solid #2e323b',
                      borderRadius: 6,
                      padding: '8px 10px',
                      fontWeight: 700,
                      color: '#34d399',
                    }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#cbd5e1' }}>
                  Intervalo de Cobrança:
                  <select
                    value={formInterval}
                    onChange={(e) => setFormInterval(e.target.value as any)}
                    style={{
                      fontSize: 12.5,
                      background: '#111317',
                      border: '1px solid #2e323b',
                      borderRadius: 6,
                      padding: '8px 10px',
                      color: '#f1f5f9',
                    }}
                  >
                    <option value="month">Mensal (/mês)</option>
                    <option value="year">Anual (/ano)</option>
                    <option value="lifetime">Vitalício (/vitalício)</option>
                  </select>
                </label>
              </div>

              {/* Descrição */}
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#cbd5e1' }}>
                Descrição dos Recursos:
                <textarea
                  rows={2}
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Ex: Acesso completo ao mixer, stems e downloads ilimitados."
                  style={{
                    fontSize: 12,
                    background: '#111317',
                    border: '1px solid #2e323b',
                    borderRadius: 6,
                    padding: '8px 10px',
                    resize: 'vertical',
                  }}
                />
              </label>

              {/* Status Ativo */}
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12.5,
                  color: '#f1f5f9',
                  background: '#111317',
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid #272a33',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={formIsActive}
                  onChange={(e) => setFormIsActive(e.target.checked)}
                  style={{ accentColor: '#10b981', width: 16, height: 16 }}
                />
                <span>Plano Ativo (Disponível para seleção no Checkout do software)</span>
              </label>

              {/* Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  disabled={saving}
                  style={{
                    background: '#0099ff',
                    borderColor: '#0099ff',
                    fontWeight: 700,
                    padding: '8px 16px',
                  }}
                >
                  {saving ? 'Gravando no Supabase…' : isEditing ? 'Salvar Alterações' : 'Criar Plano'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
