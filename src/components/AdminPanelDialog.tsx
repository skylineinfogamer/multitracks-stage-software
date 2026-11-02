import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Modal } from './Modal';
import { PlansAdminPanel } from './PlansAdminPanel';
import { authService } from '../saas/AuthService';
import { masterCatalogService } from '../saas/MasterCatalogService';
import { subscriptionService } from '../saas/SubscriptionService';
import { supabase } from '../saas/supabaseClient';
import { openExternalUrl } from '../utils/openUrl';
import type { CatalogSong, MasterCloudConfig, PaymentGatewayConfig, User, UserApprovalStatus, PlanDetails, SubscriptionPlanId } from '../saas/types';

interface Props {
  onClose: () => void;
  onCatalogUpdated?: () => void;
}

export function AdminPanelDialog({ onClose, onCatalogUpdated }: Props) {
  const [activeTab, setActiveTab] = useState<'pending' | 'subscriptions' | 'plans' | 'gateways' | 'cloud'>('pending');
  const [config, setConfig] = useState<MasterCloudConfig>(() => masterCatalogService.getMasterConfig());
  const b2BaseUrl = masterCatalogService.getB2BaseUrl();
  const [b2BucketName, setB2BucketName] = useState(() => config.b2BucketName || 'worship-playback-vs');
  const [b2KeyId, setB2KeyId] = useState(() => config.b2KeyId || '0053f8d54a0fee60000000003');
  const [b2ApplicationKey, setB2ApplicationKey] = useState(() => config.b2ApplicationKey || 'K005Oq/5orR64KcpTr3HsUBsMIvgsUI');
  const [testingB2, setTestingB2] = useState(false);
  const [b2TestFeedback, setB2TestFeedback] = useState<{ success: boolean; message: string } | null>(null);

  const [adminWhatsApp, setAdminWhatsApp] = useState(() => masterCatalogService.getAdminWhatsAppNumber());

  const [syncing, setSyncing] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [catalogSongs, setCatalogSongs] = useState<CatalogSong[]>(() => masterCatalogService.getCatalog());

  // Subscriptions & Users state
  const [users, setUsers] = useState<User[]>(() => authService.listUsers());
  const [supabaseUsers, setSupabaseUsers] = useState<User[]>([]);
  const [pendingUsers, setPendingUsers] = useState<User[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);
  const [loadingSupabase, setLoadingSupabase] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [pendingSearch, setPendingSearch] = useState('');
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);

  const [gatewayConfig, setGatewayConfig] = useState<PaymentGatewayConfig>(() => subscriptionService.getGatewayConfig());
  const [gatewaySavedMsg, setGatewaySavedMsg] = useState<string | null>(null);

  // 1. Guard de Administrador: verificar permissão de acesso
  const currentUser = authService.getCurrentUser();
  const isAdmin = currentUser?.role === 'admin';

  /**
   * Identifica as 2 contas mestres imutáveis protegidas contra exclusão:
   * 1. Administradora (multitracks pro)
   * 2. Administradora do Catálogo (admin@playback.pro)
   */
  const isMasterAdmin = (target: { id?: string; email?: string; name?: string }) => {
    const email = (target.email || '').toLowerCase().trim();
    const id = (target.id || '').toLowerCase().trim();
    const name = (target.name || '').toLowerCase().trim();

    // 1. Administradora (multitracks-pro)
    if (
      id === 'usr_admin' ||
      email === 'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com' ||
      name.includes('multitracks pro') ||
      name.includes('multitracks-pro')
    ) {
      return true;
    }

    // 2. Administradora do Catálogo
    if (
      id === 'usr_admin_alias' ||
      email === 'admin@playback.pro' ||
      name.includes('administradora do catálogo') ||
      name.includes('administradora do catalogo')
    ) {
      return true;
    }

    return false;
  };

  const refreshUsers = () => {
    setUsers(authService.listUsers());
  };

  /**
   * Lista unificada e filtrada para a aba de assinaturas:
   * Garante as 2 contas Masters no topo e trata todos os outros usuários como Músicos ('user').
   */
  const displayUsers = useMemo(() => {
    // 1. Contas Master administradoras (sempre role 'admin')
    const masters = authService.listUsers().filter((u) => isMasterAdmin(u));

    // 2. Contas vindas da nuvem (Supabase) - não masters são estritamente 'user'
    const cloudUsers = supabaseUsers
      .filter((su) => !isMasterAdmin(su))
      .map((su) => ({ ...su, role: 'user' as const }));

    // 3. Contas locais que não sejam master e não estejam já na lista cloud
    const localUsers = users
      .filter(
        (lu) =>
          !isMasterAdmin(lu) &&
          !cloudUsers.some(
            (cu) =>
              cu.id === lu.id ||
              (cu.email && lu.email && cu.email.toLowerCase() === lu.email.toLowerCase()),
          ),
      )
      .map((lu) => ({ ...lu, role: 'user' as const }));

    return [...masters, ...cloudUsers, ...localUsers];
  }, [users, supabaseUsers]);

  /**
   * Consulta a tabela `profiles` no Supabase filtrando exclusivamente por status = 'pending'
   */
  const loadPendingUsers = async () => {
    setLoadingPending(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (!error && Array.isArray(data)) {
        setPendingUsers(
          data.map((p: any) => ({
            id: p.id,
            name: p.name || 'Sem nome',
            email: p.email || 'sem-email',
            role: (p.role || 'user') as UserApprovalStatus as any,
            status: 'pending' as UserApprovalStatus,
            churchName: p.church_name || '',
            createdAt: p.created_at || new Date().toISOString(),
          }))
        );
      } else {
        if (error) {
          console.warn('[AdminPanel] Aviso consulta pendentes:', error.message);
        }
        // Fallback local caso offline
        const local = authService.listUsers().filter((u) => u.status === 'pending');
        setPendingUsers(local);
      }
    } catch (err) {
      console.warn('[AdminPanel] Erro ao carregar cadastros pendentes:', err);
      const local = authService.listUsers().filter((u) => u.status === 'pending');
      setPendingUsers(local);
    } finally {
      setLoadingPending(false);
    }
  };

  /**
   * Consulta todos os perfis para a aba de assinaturas
   */
  const loadSupabaseUsers = async () => {
    setLoadingSupabase(true);
    try {
      const list = await authService.listSupabaseProfiles();
      setSupabaseUsers(list);
    } catch (e) {
      console.warn('Erro ao carregar do Supabase:', e);
    } finally {
      setLoadingSupabase(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      loadPendingUsers();
      loadSupabaseUsers();
    }
  }, [isAdmin]);

  /**
   * Ação: Aprovar cadastro do cliente no Supabase
   */
  const handleApprove = async (idDoCliente: string, nomeDoCliente: string) => {
    setUpdatingId(idDoCliente);
    setActionFeedback(`Aprovando cadastro de ${nomeDoCliente}...`);

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ status: 'active' })
        .eq('id', idDoCliente);

      if (error) {
        throw error;
      }

      await authService.updateUserApprovalStatus(idDoCliente, 'active');
      setActionFeedback(`🎉 Cadastro de ${nomeDoCliente} APROVADO com sucesso!`);
      
      // Recarrega instantaneamente a lista do banco de dados
      await loadPendingUsers();
      await loadSupabaseUsers();
      refreshUsers();
    } catch (err: any) {
      setActionFeedback(`❌ Falha ao aprovar no Supabase: ${err.message || String(err)}`);
    } finally {
      setUpdatingId(null);
      setTimeout(() => setActionFeedback(null), 4000);
    }
  };

  /**
   * Ação: Recusar cadastro do cliente no Supabase
   */
  const handleReject = async (idDoCliente: string, nomeDoCliente: string) => {
    setUpdatingId(idDoCliente);
    setActionFeedback(`Recusando cadastro de ${nomeDoCliente}...`);

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ status: 'rejected' })
        .eq('id', idDoCliente);

      if (error) {
        throw error;
      }

      await authService.updateUserApprovalStatus(idDoCliente, 'rejected');
      setActionFeedback(`❌ Cadastro de ${nomeDoCliente} foi RECUSADO.`);

      // Recarrega instantaneamente a lista do banco de dados
      await loadPendingUsers();
      await loadSupabaseUsers();
      refreshUsers();
    } catch (err: any) {
      setActionFeedback(`❌ Falha ao recusar no Supabase: ${err.message || String(err)}`);
    } finally {
      setUpdatingId(null);
      setTimeout(() => setActionFeedback(null), 4000);
    }
  };

  /**
   * Ação: Excluir permanentemente o cliente via Supabase e cache local
   */
  const handleDeleteUser = async (idDoCliente: string, nomeDoCliente: string, emailDoCliente?: string) => {
    if (isMasterAdmin({ id: idDoCliente, name: nomeDoCliente, email: emailDoCliente })) {
      alert('Ação Bloqueada: As contas Administradoras Master (Multitracks Pro e Catálogo) são essenciais para o sistema e não podem ser excluídas.');
      return;
    }

    const confirmed = window.confirm(
      `Tem certeza que deseja excluir permanentemente o cadastro de "${nomeDoCliente}"?\n\nEsta ação removerá o usuário na nuvem (Supabase) e não pode ser desfeita.`
    );
    if (!confirmed) return;

    setUpdatingId(idDoCliente);
    setActionFeedback(`Excluindo cadastro de ${nomeDoCliente}...`);

    const cleanEmail = emailDoCliente?.trim().toLowerCase();

    // 1. Remove imediatamente do cache local e da interface para resposta instantânea
    authService.deleteUser(idDoCliente, emailDoCliente);
    setPendingUsers((prev) =>
      prev.filter(
        (u) => u.id !== idDoCliente && (!cleanEmail || u.email.toLowerCase() !== cleanEmail),
      ),
    );
    setSupabaseUsers((prev) =>
      prev.filter(
        (u) => u.id !== idDoCliente && (!cleanEmail || u.email.toLowerCase() !== cleanEmail),
      ),
    );
    setUsers((prev) =>
      prev.filter(
        (u) => u.id !== idDoCliente && (!cleanEmail || u.email.toLowerCase() !== cleanEmail),
      ),
    );

    // 2. Se for UUID, exclui na nuvem (Supabase profiles e auth.users)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idDoCliente);
    if (isUuid) {
      try {
        const { error: profileError } = await supabase
          .from('profiles')
          .delete()
          .eq('id', idDoCliente);

        if (profileError) {
          console.warn('[AdminPanel] Aviso ao excluir em profiles:', profileError.message);
        }

        try {
          await supabase.rpc('admin_delete_user', { target_user_id: idDoCliente });
        } catch {
          // RPC opcional caso não esteja configurada ainda no Supabase
        }
      } catch (cloudErr) {
        console.warn('[AdminPanel] Falha na exclusão remota:', cloudErr);
      }
    }

    setActionFeedback(`🗑️ Cadastro de ${nomeDoCliente} excluído com sucesso!`);
    setUpdatingId(null);
    setTimeout(() => setActionFeedback(null), 3000);
  };

  const RLS_FIX_SQL = `-- Copie e execute no SQL Editor do Supabase para corrigir e garantir exclusão e permissões:
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can update all profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can delete profiles" ON profiles;

CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles 
    WHERE id = auth.uid() 
      AND (
        role = 'admin' 
        OR lower(email) IN (
          'admin@playback.pro',
          'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com'
        )
      )
  );
$$;

CREATE POLICY "Admins can view all profiles" ON profiles FOR SELECT USING (is_admin());
CREATE POLICY "Admins can update all profiles" ON profiles FOR UPDATE USING (is_admin());
CREATE POLICY "Admins can delete profiles" ON profiles FOR DELETE USING (is_admin());

-- RPC para exclusão completa definitiva (auth.users + profiles)
CREATE OR REPLACE FUNCTION public.admin_delete_user(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.profiles WHERE id = target_user_id;
  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(uuid) TO anon;

-- Tabela de Planos de Assinatura Dinâmicos
CREATE TABLE IF NOT EXISTS public.plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  interval TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read active plans" ON public.plans;
CREATE POLICY "Anyone can read active plans" ON public.plans FOR SELECT USING (true);
DROP POLICY IF EXISTS "Admins can manage plans" ON public.plans;
CREATE POLICY "Admins can manage plans" ON public.plans FOR ALL USING (public.is_admin());

INSERT INTO public.plans (id, name, price, interval, description, is_active)
VALUES
  ('monthly', 'Worship Mensal', 4990, 'month', 'Acesso completo ao catálogo mestre e mixer', true),
  ('annual', 'Pro Anual (2 meses off)', 47900, 'year', 'Acesso anual ilimitado com economia de 2 meses', true),
  ('church_vip', 'Ministério VIP Vitalício', 99000, 'lifetime', 'Acesso contínuo sem renovações periódicas', false)
ON CONFLICT (id) DO NOTHING;
`;

  const handleSaveConfig = async (silent: boolean = false) => {
    const cleanKeyId = b2KeyId.trim() || '0053f8d54a0fee60000000003';
    const cleanAppKey = b2ApplicationKey.trim() || 'K005Oq/5orR64KcpTr3HsUBsMIvgsUI';
    const cleanBucketName = b2BucketName.trim() || 'worship-playback-vs';
    const cleanBucketId = '437f98cd55f48a50af1e0e16';
    const cleanBaseUrl = b2BaseUrl.trim() || `https://f005.backblazeb2.com/file/${cleanBucketName}/`;

    masterCatalogService.saveMasterConfig({
      b2BaseUrl: cleanBaseUrl,
      b2KeyId: cleanKeyId,
      b2ApplicationKey: cleanAppKey,
      b2BucketName: cleanBucketName,
      b2BucketId: cleanBucketId,
      adminWhatsAppNumber: adminWhatsApp.replace(/\D/g, ''),
    });
    setConfig(masterCatalogService.getMasterConfig());

    if (typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)) {
      try {
        await invoke('b2_save_config', {
          config: {
            bucketName: cleanBucketName,
            bucketId: cleanBucketId,
            keyId: cleanKeyId,
            applicationKey: cleanAppKey,
            downloadUrl: cleanBaseUrl,
          },
        });
      } catch (e: any) {
        console.warn('Falha ao salvar b2_config no Rust:', e);
      }
    }
    if (!silent) {
      setStatusMsg('✅ Configurações do Backblaze B2 e WhatsApp salvas com sucesso!');
    }
  };

  const handleTestB2 = async () => {
    setTestingB2(true);
    setB2TestFeedback(null);
    setStatusMsg('Conectando e autorizando Backblaze B2 via Rust nativo…');

    try {
      await handleSaveConfig(true);
      const res = await masterCatalogService.testB2Connection();
      setB2TestFeedback({
        success: res.success,
        message: res.message,
      });
      if (res.success) {
        setStatusMsg('✅ Conexão B2 autorizada! Atualizando catálogo dinamicamente…');
        // Imediatamente atualiza a listagem de arquivos e contador do catálogo
        await handleSyncNow(false);
      } else {
        setStatusMsg(`❌ Falha no teste B2: ${res.message}`);
      }
    } catch (e: any) {
      setB2TestFeedback({
        success: false,
        message: e?.message || 'Falha de conexão ao autorizar Backblaze B2',
      });
      setStatusMsg(`❌ Erro no teste B2: ${e?.message || e}`);
    } finally {
      setTestingB2(false);
    }
  };

  const handleSyncNow = async (saveFirst: boolean = true) => {
    if (saveFirst) {
      await handleSaveConfig(true);
    }
    setSyncing(true);
    setStatusMsg('Sincronizando catálogo dinamicamente via Backblaze B2 (Rust)…');

    try {
      const res = await masterCatalogService.syncCatalogFromMasterCloud((msg) => {
        setStatusMsg(msg);
      });
      setCatalogSongs(res.songs);
      setConfig(masterCatalogService.getMasterConfig());
      onCatalogUpdated?.();
      setStatusMsg(`🎉 Catálogo Backblaze B2 sincronizado! ${res.count} músicas disponíveis em tempo real.`);
    } catch (err: any) {
      setStatusMsg(`❌ Falha no sync B2: ${err?.message || err}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleRemoveSong = (songId: string) => {
    if (!confirm('Remover esta música do catálogo público dos usuários?')) return;
    const next = catalogSongs.filter((s) => s.id !== songId);
    masterCatalogService.saveCatalog(next);
    setCatalogSongs(next);
    onCatalogUpdated?.();
  };

  const handleSaveGatewayConfig = (e: React.FormEvent) => {
    e.preventDefault();
    subscriptionService.saveGatewayConfig(gatewayConfig);
    setGatewaySavedMsg('✅ Configurações do Gateway InfinitePay salvas com sucesso!');
    setTimeout(() => setGatewaySavedMsg(null), 3000);
  };

  /**
   * Altera o plano de assinatura de um usuário
   */
  const handleChangePlan = async (userId: string, userName: string, newPlanId: SubscriptionPlanId) => {
    setUpdatingId(userId);
    setActionFeedback(`Alterando plano de ${userName}...`);

    try {
      subscriptionService.setUserPlan(userId, newPlanId);
      setActionFeedback(`✅ Plano de ${userName} alterado com sucesso!`);
      refreshUsers();
      await loadSupabaseUsers();
    } catch (err: any) {
      setActionFeedback(`❌ Falha ao alterar plano: ${err.message || String(err)}`);
    } finally {
      setUpdatingId(null);
      setTimeout(() => setActionFeedback(null), 4000);
    }
  };

  const filteredPendingList = pendingUsers.filter((u) => {
    if (!pendingSearch.trim()) return true;
    const q = pendingSearch.toLowerCase();
    return (
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.churchName && u.churchName.toLowerCase().includes(q))
    );
  });

  const allUsersList = supabaseUsers.length > 0 ? supabaseUsers : users;

  // 1. Guard de Administrador: Se não for admin, bloqueia a renderização
  if (!isAdmin) {
    return (
      <Modal title="Acesso Restrito" onClose={onClose}>
        <div
          style={{
            padding: 32,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            color: '#f87171',
          }}
        >
          <span style={{ fontSize: 48 }}>⛔</span>
          <strong style={{ fontSize: 18, color: '#f8fafc' }}>Acesso Restrito ao Administrador</strong>
          <p style={{ margin: 0, fontSize: 13, color: '#94a3b8', maxWidth: 420, lineHeight: 1.6 }}>
            Esta tela é restrita exclusivamente a contas com o perfil de Administrador (<code>role: 'admin'</code> na tabela{' '}
            <code>profiles</code> do Supabase). Usuários comuns não possuem autorização de acesso.
          </p>
          <button className="btn primary" onClick={onClose} style={{ marginTop: 10 }}>
            Fechar
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="👑 Painel Administrativo — Worship Tools"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ fontSize: 11.5 }}>
            Controle mestre de aprovação de novos cadastros, assinaturas e catálogo Google Drive.
          </span>
          <button className="btn" onClick={onClose}>
            Fechar
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid #2e323b', paddingBottom: 8, overflowX: 'auto' }}>
          <button
            className={`btn small ${activeTab === 'pending' ? 'primary' : ''}`}
            onClick={() => setActiveTab('pending')}
            style={{
              fontWeight: 700,
              background: activeTab === 'pending' ? '#f59e0b' : undefined,
              color: activeTab === 'pending' ? '#000' : undefined,
            }}
          >
            ⏳ Cadastros Pendentes ({pendingUsers.length})
          </button>
          <button
            className={`btn small ${activeTab === 'subscriptions' ? 'primary' : ''}`}
            onClick={() => setActiveTab('subscriptions')}
            style={{ fontWeight: 700 }}
          >
            👥 Todos os Usuários ({allUsersList.length})
          </button>
          <button
            className={`btn small ${activeTab === 'gateways' ? 'primary' : ''}`}
            onClick={() => setActiveTab('gateways')}
            style={{ fontWeight: 700 }}
          >
            ⚡ Gateway InfinitePay (PIX & Cartão)
          </button>
          <button
            className={`btn small ${activeTab === 'plans' ? 'primary' : ''}`}
            onClick={() => setActiveTab('plans')}
            style={{
              fontWeight: 700,
              background: activeTab === 'plans' ? '#0099ff' : undefined,
              color: activeTab === 'plans' ? '#fff' : undefined,
            }}
          >
            💳 Gestão de Planos
          </button>
          <button
            className={`btn small ${activeTab === 'cloud' ? 'primary' : ''}`}
            onClick={() => setActiveTab('cloud')}
            style={{ fontWeight: 700 }}
          >
            ⚡ Servidor Backblaze B2 ({catalogSongs.length} músicas)
          </button>
        </div>

        {/* TAB: CADASTROS PENDENTES DE APROVAÇÃO (SUPABASE) */}
        {activeTab === 'pending' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Header info & Controls */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: '#16181E',
                border: '1px solid #2E323B',
                borderRadius: 8,
                padding: '12px 16px',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <div>
                <strong style={{ fontSize: 14, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>⏳</span> Fila de Aprovação de Novos Cadastros
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: pendingUsers.length > 0 ? '#f59e0b' : '#334155',
                      color: pendingUsers.length > 0 ? '#000' : '#cbd5e1',
                      fontWeight: 800,
                    }}
                  >
                    {pendingUsers.length} aguardando
                  </span>
                </strong>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  Cadastros novos ficam bloqueados até você aprovar. Ao aprovar, o acesso ao software e catálogo é liberado instantaneamente.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Filtrar por nome ou e-mail..."
                  value={pendingSearch}
                  onChange={(e) => setPendingSearch(e.target.value)}
                  style={{
                    background: '#0d0e11',
                    border: '1px solid #2e323b',
                    color: '#f8fafc',
                    padding: '6px 12px',
                    borderRadius: 6,
                    fontSize: 12,
                    minWidth: 200,
                  }}
                />
                <button
                  className="btn small"
                  onClick={loadPendingUsers}
                  disabled={loadingPending}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}
                >
                  {loadingPending ? 'Carregando…' : '🔄 Atualizar'}
                </button>
              </div>
            </div>

            {actionFeedback && (
              <div
                style={{
                  fontSize: 12,
                  padding: '10px 14px',
                  borderRadius: 6,
                  background: actionFeedback.includes('✅') || actionFeedback.includes('🎉') ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                  border: `1px solid ${actionFeedback.includes('✅') || actionFeedback.includes('🎉') ? '#10b981' : '#ef4444'}`,
                  color: actionFeedback.includes('✅') || actionFeedback.includes('🎉') ? '#6ee7b7' : '#fca5a5',
                  fontWeight: 600,
                }}
              >
                {actionFeedback}
              </div>
            )}

            {/* List / Table of Pending Clients */}
            {filteredPendingList.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '44px 20px',
                  background: '#12141A',
                  borderRadius: 10,
                  border: '1px dashed #2E323B',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 42 }}>✨</span>
                <strong style={{ fontSize: 16, color: '#F1F5F9' }}>
                  Nenhum cadastro pendente no momento
                </strong>
                <span style={{ fontSize: 13, color: '#94A3B8', maxWidth: 460, lineHeight: 1.5 }}>
                  {pendingSearch
                    ? `Nenhum cadastro pendente corresponde à busca "${pendingSearch}".`
                    : 'Todos os usuários cadastrados já foram aprovados e liberados pela administração.'}
                </span>
                <button
                  className="btn small"
                  onClick={loadPendingUsers}
                  disabled={loadingPending}
                  style={{ marginTop: 8, fontWeight: 600 }}
                >
                  {loadingPending ? 'Verificando…' : '🔄 Verificar Novamente'}
                </button>
              </div>
            ) : (
              <div
                style={{
                  background: '#16181E',
                  border: '1px solid #2E323B',
                  borderRadius: 8,
                  overflow: 'hidden',
                  maxHeight: 420,
                  overflowY: 'auto',
                }}
              >
                {/* Table Header */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.4fr 1.5fr 1.1fr 0.8fr 2.4fr',
                    padding: '10px 16px',
                    background: '#111317',
                    borderBottom: '1px solid #2E323B',
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#94A3B8',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  <div>Nome & Igreja</div>
                  <div>E-mail</div>
                  <div>Data do Cadastro</div>
                  <div>Status</div>
                  <div style={{ textAlign: 'right' }}>Ações Rápidas</div>
                </div>

                {/* Table Body */}
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {filteredPendingList.map((client) => {
                    const isProcessing = updatingId === client.id;
                    const dateFormatted = new Date(client.createdAt).toLocaleDateString('pt-BR', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    });

                    return (
                      <div
                        key={client.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1.4fr 1.5fr 1.1fr 0.8fr 2.4fr',
                          padding: '12px 16px',
                          borderBottom: '1px solid #1f242d',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12,
                          background: isProcessing ? 'rgba(0, 153, 255, 0.05)' : 'transparent',
                          transition: 'background 0.15s ease',
                        }}
                      >
                        {/* Name & Church */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div
                            style={{
                              width: 32,
                              height: 32,
                              borderRadius: '50%',
                              background: '#252932',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 700,
                              color: '#38bdf8',
                              fontSize: 13,
                              flexShrink: 0,
                            }}
                          >
                            {client.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <strong style={{ fontSize: 13, color: '#f8fafc', display: 'block' }}>
                              {client.name}
                            </strong>
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>
                              {client.churchName || 'Igreja não informada'}
                            </span>
                          </div>
                        </div>

                        {/* Email */}
                        <div style={{ color: '#cbd5e1', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 11.5 }}>
                          {client.email}
                        </div>

                        {/* Created At */}
                        <div style={{ color: '#94a3b8', fontSize: 11.5 }}>
                          {dateFormatted}
                        </div>

                        {/* Status */}
                        <div>
                          <span
                            style={{
                              fontSize: 10,
                              padding: '2px 8px',
                              borderRadius: 12,
                              fontWeight: 700,
                              background: 'rgba(245, 158, 11, 0.18)',
                              color: '#fbbf24',
                              border: '1px solid #f59e0b',
                              display: 'inline-block',
                            }}
                          >
                            ⏳ Pendente
                          </span>
                        </div>

                        {/* Actions: Aprovar / Recusar / Excluir */}
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                          <button
                            className="btn small"
                            disabled={isProcessing}
                            onClick={() => handleApprove(client.id, client.name)}
                            style={{
                              background: '#10B981',
                              color: '#fff',
                              border: 'none',
                              fontWeight: 700,
                              fontSize: 11,
                              padding: '6px 12px',
                              cursor: isProcessing ? 'wait' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
                            }}
                          >
                            {isProcessing ? '...' : '✅ Aprovar'}
                          </button>

                          <button
                            className="btn small"
                            disabled={isProcessing}
                            onClick={() => handleReject(client.id, client.name)}
                            style={{
                              background: 'rgba(239, 68, 68, 0.18)',
                              border: '1px solid #EF4444',
                              color: '#f87171',
                              fontWeight: 700,
                              fontSize: 11,
                              padding: '6px 10px',
                              cursor: isProcessing ? 'wait' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            {isProcessing ? '...' : '❌ Recusar'}
                          </button>

                          {!isMasterAdmin(client) && (
                            <button
                              className="btn small"
                              disabled={isProcessing}
                              onClick={() => handleDeleteUser(client.id, client.name, client.email)}
                              style={{
                                background: '#EF4444',
                                color: '#fff',
                                border: 'none',
                                fontWeight: 700,
                                fontSize: 11,
                                padding: '6px 10px',
                                cursor: isProcessing ? 'wait' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                              title="Excluir permanentemente este cadastro via RPC do Supabase"
                            >
                              {isProcessing ? '...' : '🗑️ Excluir'}
                            </button>
                          )}

                          <button
                            className="btn small"
                            onClick={() => {
                              const cleanPhone = adminWhatsApp.replace(/\D/g, '');
                              const msg = `Olá *${client.name}*! Sou da administração do *Worship Tools*. Recebemos seu cadastro (${client.email}).`;
                              openExternalUrl(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`);
                            }}
                            title="Conversar com o usuário no WhatsApp"
                            style={{
                              background: '#1f242d',
                              border: '1px solid #3b4252',
                              color: '#25D366',
                              fontSize: 12,
                              padding: '6px 8px',
                            }}
                          >
                            💬
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Supabase RLS Helper Card */}
            <div
              style={{
                background: '#111317',
                border: '1px solid #2e323b',
                borderRadius: 8,
                padding: 12,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                🛡️ <b>Segurança Supabase:</b> O painel sincroniza diretamente com a tabela <code>profiles</code>.
              </div>
              <button
                className="btn small"
                style={{ fontSize: 11, padding: '3px 10px' }}
                onClick={() => {
                  navigator.clipboard.writeText(RLS_FIX_SQL);
                  setCopiedSql(true);
                  setTimeout(() => setCopiedSql(false), 2500);
                }}
              >
                {copiedSql ? '✅ SQL Copiado!' : '📋 Copiar Script SQL do Supabase (RLS)'}
              </button>
            </div>
          </div>
        )}

        {/* TAB 1: SUBSCRIPTIONS & USER MANAGEMENT */}
        {activeTab === 'subscriptions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Quick Metrics Bar */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              <div style={{ background: '#16181e', border: '1px solid #2e323b', borderRadius: 8, padding: 12 }}>
                <span className="muted" style={{ fontSize: 11 }}>Total Usuários:</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#f8fafc', marginTop: 2 }}>
                  {displayUsers.length}
                </div>
              </div>
              <div style={{ background: '#16181e', border: '1px solid #10b981', borderRadius: 8, padding: 12 }}>
                <span className="muted" style={{ fontSize: 11 }}>Assinaturas Ativas:</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#34d399', marginTop: 2 }}>
                  {displayUsers.filter(u => u.subscription?.status === 'active').length}
                </div>
              </div>
              <div style={{ background: '#16181e', border: '1px solid #ef4444', borderRadius: 8, padding: 12 }}>
                <span className="muted" style={{ fontSize: 11 }}>Inadimplentes / Bloqueados:</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#f87171', marginTop: 2 }}>
                  {displayUsers.filter(u => u.subscription?.status === 'past_due' || u.subscription?.status === 'canceled' || u.status === 'rejected').length}
                </div>
              </div>
              <div style={{ background: '#16181e', border: '1px solid #f59e0b', borderRadius: 8, padding: 12 }}>
                <span className="muted" style={{ fontSize: 11 }}>Admins Master:</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fbbf24', marginTop: 2 }}>
                  {displayUsers.filter(u => isMasterAdmin(u)).length}
                </div>
              </div>
            </div>

            {/* User List Table */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 13, color: '#f8fafc' }}>
                  Usuários Cadastrados e Status de Cobrança:
                </strong>
                <button
                  className="btn small"
                  onClick={loadSupabaseUsers}
                  disabled={loadingSupabase}
                  style={{ fontWeight: 600 }}
                >
                  {loadingSupabase ? 'Sincronizando…' : '🔄 Atualizar Lista Cloud'}
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflowY: 'auto' }}>
                {displayUsers.map((u) => {
                  const sub = u.subscription;
                  const status = sub?.status || 'active';
                  const isBlocked = status === 'past_due' || status === 'canceled';
                  const isMaster = isMasterAdmin(u);
                  const isVip = isMaster || sub?.planId === 'admin_vip' || sub?.planId === 'church_vip';

                  return (
                    <div
                      key={u.id}
                      style={{
                        background: '#16181e',
                        border: isBlocked ? '1px solid #ef4444' : isVip ? '1px solid #f59e0b' : '1px solid #2e323b',
                        borderRadius: 8,
                        padding: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 18 }}>
                            {isMaster ? '👑' : isBlocked ? '⚠️' : '🎸'}
                          </span>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <strong style={{ fontSize: 14, color: '#f8fafc' }}>{u.name}</strong>
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '1px 6px',
                                  borderRadius: 8,
                                  fontWeight: 700,
                                  background: isMaster ? 'rgba(245, 158, 11, 0.2)' : 'rgba(0, 153, 255, 0.2)',
                                  color: isMaster ? '#f59e0b' : '#38bdf8',
                                }}
                              >
                                {isMaster ? 'Admin Master' : 'Músico'}
                              </span>
                            </div>
                            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                              {u.email} · {u.churchName || 'Igreja'}
                            </div>
                          </div>
                        </div>

                        {/* Status Badge */}
                        <div>
                          {status === 'active' ? (
                            <span
                              style={{
                                fontSize: 11,
                                padding: '3px 10px',
                                borderRadius: 12,
                                fontWeight: 700,
                                background: 'rgba(16, 185, 129, 0.2)',
                                color: '#34d399',
                                border: '1px solid #10b981',
                              }}
                            >
                              🟢 Ativo (Liberado)
                            </span>
                          ) : status === 'past_due' ? (
                            <span
                              style={{
                                fontSize: 11,
                                padding: '3px 10px',
                                borderRadius: 12,
                                fontWeight: 700,
                                background: 'rgba(239, 68, 68, 0.2)',
                                color: '#f87171',
                                border: '1px solid #ef4444',
                              }}
                            >
                              ⚠️ Inadimplente (Bloqueado)
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: 11,
                                padding: '3px 10px',
                                borderRadius: 12,
                                fontWeight: 700,
                                background: 'rgba(100, 116, 139, 0.2)',
                                color: '#94a3b8',
                                border: '1px solid #64748b',
                              }}
                            >
                              🔴 Cancelado
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Subscription Info & Actions */}
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          borderTop: '1px solid #232731',
                          paddingTop: 8,
                          flexWrap: 'wrap',
                          gap: 8,
                        }}
                      >
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>
                          Plano: <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{sub?.planName || 'Mensal'}</span> · Gateway: <span style={{ color: '#f1f5f9', textTransform: 'uppercase' }}>{sub?.provider || 'InfinitePay'}</span> · Vence: <span style={{ color: '#38bdf8' }}>{sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString('pt-BR') : 'Vitalício'}</span>
                        </div>

                        {/* Plan Selector Dropdown */}
                        {!isMaster && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <select
                              value={sub?.planId || 'monthly'}
                              onChange={(e) => handleChangePlan(u.id, u.name, e.target.value as SubscriptionPlanId)}
                              disabled={updatingId === u.id}
                              style={{
                                fontSize: 11,
                                background: '#111317',
                                border: '1px solid #2e323b',
                                borderRadius: 6,
                                padding: '6px 10px',
                                color: '#f1f5f9',
                                cursor: updatingId === u.id ? 'wait' : 'pointer',
                                minWidth: 160,
                              }}
                              title="Alterar plano de assinatura do usuário"
                            >
                              {subscriptionService.getAllPlans(true).map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} ({p.interval === 'annual' ? 'Anual' : p.interval === 'lifetime' ? 'Vitalício' : 'Mensal'}) - R$ {p.priceBrl.toFixed(2).replace('.', ',')}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {/* Action Buttons */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          {!isMaster && (
                            <>
                              <button
                                className="btn small"
                                style={{ fontSize: 11, background: '#059669', borderColor: '#059669', color: '#fff' }}
                                onClick={() => {
                                  subscriptionService.renewUserDays(u.id, 30);
                                  refreshUsers();
                                }}
                                title="Renova assinatura por mais 30 dias"
                              >
                                ➕ Renovar +30d
                              </button>
                              <button
                                className="btn small"
                                style={{ fontSize: 11, background: '#d97706', borderColor: '#d97706', color: '#fff' }}
                                onClick={() => {
                                  subscriptionService.grantVip(u.id);
                                  refreshUsers();
                                }}
                                title="Concede isenção VIP vitalícia"
                              >
                                👑 Conceder VIP
                              </button>
                              {status === 'active' ? (
                                <button
                                  className="btn small danger"
                                  style={{ fontSize: 11 }}
                                  onClick={() => {
                                    subscriptionService.setUserStatus(u.id, 'past_due');
                                    refreshUsers();
                                  }}
                                  title="Bloqueia imediatamente por inadimplência"
                                >
                                  ⚠️ Bloquear (Inadimplente)
                                </button>
                              ) : (
                                <button
                                  className="btn small"
                                  style={{ fontSize: 11, borderColor: '#10b981', color: '#34d399' }}
                                  onClick={() => {
                                    subscriptionService.setUserStatus(u.id, 'active');
                                    refreshUsers();
                                  }}
                                  title="Desbloqueia o usuário"
                                >
                                  🟢 Desbloquear
                                </button>
                              )}
                            </>
                          )}

                          {/* Delete button: available for all users, EXCEPT the 2 Master accounts */}
                          {!isMaster ? (
                            <button
                              className="btn small"
                              style={{
                                fontSize: 11,
                                background: '#EF4444',
                                border: 'none',
                                color: '#fff',
                                fontWeight: 700,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '5px 9px',
                                boxShadow: '0 2px 8px rgba(239, 68, 68, 0.25)',
                              }}
                              onClick={() => handleDeleteUser(u.id, u.name, u.email)}
                              title="Excluir permanentemente este usuário do Supabase e do sistema"
                            >
                              🗑️ Excluir
                            </button>
                          ) : (
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 800,
                                color: '#f59e0b',
                                background: 'rgba(245, 158, 11, 0.15)',
                                border: '1px solid rgba(245, 158, 11, 0.35)',
                                padding: '3px 8px',
                                borderRadius: 4,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                              title="Conta Administradora Master imutável e protegida contra exclusão acidental"
                            >
                              🛡️ Master Protegido
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: GATEWAYS CONFIGURATION (INFINITEPAY) */}
        {activeTab === 'gateways' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {gatewaySavedMsg && (
              <div style={{ background: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#34d399', padding: '10px 14px', borderRadius: 6, fontSize: 12 }}>
                {gatewaySavedMsg}
              </div>
            )}

            {/* Provider Info Banner */}
            <div style={{ background: '#16181e', border: '1px solid #10b981', padding: 14, borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <strong style={{ fontSize: 13, color: '#f8fafc' }}>Gateway Oficial Ativo:</strong>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    O sistema utiliza exclusivamente o <strong>InfinitePay</strong> para processamento de assinaturas via PIX dinâmico (QR Code) e Cartão de Crédito.
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: '6px 12px', borderRadius: 6, border: '1px solid #10b981' }}>
                  <span style={{ fontSize: 16 }}>⚡</span> InfinitePay (PIX & Cartão)
                </div>
              </div>
            </div>

            {/* Form for URLs and API Keys */}
            <form onSubmit={handleSaveGatewayConfig} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* InfinitePay Card */}
              <div style={{ background: '#111317', border: '1px solid #10b981', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>⚡</span>
                  <strong style={{ fontSize: 13, color: '#34d399' }}>Configurações do InfinitePay:</strong>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Merchant Tag/Handle (ex: multitracks_pro):</label>
                    <input
                      type="text"
                      value={gatewayConfig.infinitepayHandle || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, infinitepayHandle: e.target.value }))}
                      placeholder="multitracks_pro"
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>InfinitePay API Key / Token (Opcional se usar Edge):</label>
                    <input
                      type="password"
                      value={gatewayConfig.infinitepayApiKey || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, infinitepayApiKey: e.target.value }))}
                      placeholder="inf_live_..."
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Link Checkout Mensal InfinitePay (R$ 49,90):</label>
                    <input
                      type="text"
                      value={gatewayConfig.infinitepayMonthlyCheckoutUrl || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, infinitepayMonthlyCheckoutUrl: e.target.value }))}
                      placeholder="https://infinitepay.io/pay/multitracks_pro/49.90"
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Link Checkout Anual InfinitePay (R$ 479,00):</label>
                    <input
                      type="text"
                      value={gatewayConfig.infinitepayAnnualCheckoutUrl || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, infinitepayAnnualCheckoutUrl: e.target.value }))}
                      placeholder="https://infinitepay.io/pay/multitracks_pro/479.00"
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>
                </div>
              </div>

              <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }}>
                💾 Salvar Configurações InfinitePay
              </button>
            </form>
          </div>
        )}

        {/* TAB: GESTÃO DE PLANOS DE ASSINATURA */}
        {activeTab === 'plans' && (
          <PlansAdminPanel />
        )}

        {/* TAB 3: MASTER CLOUD / STORAGE (BACKBLAZE B2 EXCLUSIVO) */}
        {activeTab === 'cloud' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 1. Servidor Backblaze B2 (API Direta & Dinâmica) */}
            <div
              style={{
                background: '#141720',
                border: '1px solid #293040',
                borderRadius: 8,
                padding: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                <div>
                  <strong style={{ fontSize: 14, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>⚡</span> Servidor Central Backblaze B2 (Nuvem Dinâmica)
                  </strong>
                  <span className="muted" style={{ fontSize: 11.5, marginTop: 2, display: 'block' }}>
                    Sincronização 100% automática e direta via Rust nativo dos arquivos .zip e .rar disponíveis no bucket.
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(16, 185, 129, 0.15)', border: '1px solid #10b981', padding: '4px 10px', borderRadius: 20 }}>
                  <span style={{ color: '#34d399', fontSize: 10 }}>●</span>
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#34d399' }}>B2 ATIVO (EXCLUSIVO)</span>
                </div>
              </div>

              {/* Campos simplificados: Key ID, Application Key, Bucket Name */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11.5, color: '#94a3b8', display: 'block', marginBottom: 3, fontWeight: 600 }}>
                    Key ID (Application Key ID):
                  </label>
                  <input
                    type="text"
                    value={b2KeyId}
                    onChange={(e) => setB2KeyId(e.target.value)}
                    placeholder="0053f8d54a0fee60000000003"
                    style={{ width: '100%', fontSize: 12.5, fontFamily: 'monospace' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11.5, color: '#94a3b8', display: 'block', marginBottom: 3, fontWeight: 600 }}>
                    Application Key:
                  </label>
                  <input
                    type="password"
                    value={b2ApplicationKey}
                    onChange={(e) => setB2ApplicationKey(e.target.value)}
                    placeholder="K005Oq/5orR64KcpTr3HsUBsMIvgsUI"
                    style={{ width: '100%', fontSize: 12.5, fontFamily: 'monospace' }}
                  />
                </div>
              </div>

              <div>
                <label style={{ fontSize: 11.5, color: '#94a3b8', display: 'block', marginBottom: 3, fontWeight: 600 }}>
                  Bucket Name (opcional / padrão):
                </label>
                <input
                  type="text"
                  value={b2BucketName}
                  onChange={(e) => setB2BucketName(e.target.value)}
                  placeholder="worship-playback-vs"
                  style={{ width: '100%', fontSize: 12.5, fontFamily: 'monospace' }}
                />
                <span className="muted" style={{ fontSize: 11, marginTop: 4, display: 'block', color: '#64748b' }}>
                  🔒 O Bucket ID (<code style={{ color: '#38bdf8' }}>437f98cd55f48a50af1e0e16</code>) é resolvido e vinculado automaticamente pelo motor nativo Rust sem necessidade de preenchimento manual.
                </span>
              </div>

              {b2TestFeedback && (
                <div
                  style={{
                    fontSize: 12,
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: b2TestFeedback.success ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    border: `1px solid ${b2TestFeedback.success ? '#10b981' : '#ef4444'}`,
                    color: b2TestFeedback.success ? '#34d399' : '#f87171',
                  }}
                >
                  {b2TestFeedback.message}
                </div>
              )}

              {/* Ações principais */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <button
                  className="btn"
                  disabled={testingB2 || syncing}
                  onClick={() => void handleTestB2()}
                  style={{
                    background: '#1e293b',
                    borderColor: '#0099ff',
                    color: '#38bdf8',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {testingB2 ? '⏳ Testando Conexão…' : '🧪 Testar Conexão / Autorização'}
                </button>
                <button
                  className="btn primary"
                  style={{ background: '#0099ff', borderColor: '#0099ff', color: '#fff', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6 }}
                  disabled={syncing || testingB2}
                  onClick={() => void handleSyncNow()}
                >
                  {syncing ? '⏳ Sincronizando Catálogo B2…' : '🔄 Sincronizar Catálogo Agora'}
                </button>
                <button className="btn" disabled={syncing || testingB2} onClick={() => void handleSaveConfig()}>
                  💾 Salvar Credenciais
                </button>
              </div>
            </div>

            {/* 2. WhatsApp & Pedidos de MultiTracks */}
            <div
              style={{
                background: '#16181e',
                border: '1px solid #2e323b',
                borderRadius: 8,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div>
                <label style={{ fontSize: 12, color: '#38bdf8', display: 'block', marginBottom: 4, fontWeight: 600 }}>
                  📱 WhatsApp do Administrador para Receber Pedidos de VS dos Usuários:
                </label>
                <input
                  type="text"
                  value={adminWhatsApp}
                  onChange={(e) => setAdminWhatsApp(e.target.value)}
                  placeholder="Ex: 5511999998888 (com DDD)"
                  style={{ width: '100%', fontSize: 13 }}
                />
                <span className="muted" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>
                  Quando qualquer usuário normal buscar uma música que não está no catálogo e solicitar, o pedido formatado abrirá uma conversa direta no seu WhatsApp.
                </span>
              </div>

              {statusMsg && (
                <div
                  style={{
                    fontSize: 12,
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: statusMsg.startsWith('❌') ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                    border: `1px solid ${statusMsg.startsWith('❌') ? '#ef4444' : '#10b981'}`,
                    color: statusMsg.startsWith('❌') ? '#fca5a5' : '#6ee7b7',
                  }}
                >
                  {statusMsg}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn small" onClick={() => void handleSaveConfig()}>
                  💾 Salvar WhatsApp
                </button>
              </div>
            </div>

            {/* Current Shared Catalog Items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <strong style={{ fontSize: 13, color: '#f8fafc' }}>
                  Músicas Ativas no Catálogo dos Músicos ({catalogSongs.length}):
                </strong>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {catalogSongs.length > 0 && (
                    <button
                      className="btn small danger"
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={() => {
                        if (confirm('Tem certeza que deseja limpar todo o catálogo? Todas as músicas serão removidas da lista pública para que você possa ressincronizar do zero.')) {
                          masterCatalogService.clearCatalog();
                          setCatalogSongs([]);
                          onCatalogUpdated?.();
                          setStatusMsg('🗑️ Todo o catálogo foi limpo! Você pode sincronizar agora com os novos arquivos.');
                        }
                      }}
                      title="Limpar todas as músicas do catálogo público"
                    >
                      🗑️ Limpar Todo o Catálogo
                    </button>
                  )}
                  <span className="muted" style={{ fontSize: 11 }}>
                    {config.lastSyncTime ? `Último sync: ${new Date(config.lastSyncTime).toLocaleString('pt-BR')}` : 'Pronto para sincronizar'}
                  </span>
                </div>
              </div>

              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {catalogSongs.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      background: '#16181e',
                      border: '1px solid #2e323b',
                      borderRadius: 6,
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: 13, color: '#f8fafc' }}>{s.title}</strong>
                      <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                        {s.artist} · {s.key} · {s.bpm} BPM · {s.stems.length} faixas
                      </span>
                    </div>
                    <button
                      className="btn small danger"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={() => handleRemoveSong(s.id)}
                      title="Remover do catálogo público"
                    >
                      Remover
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
