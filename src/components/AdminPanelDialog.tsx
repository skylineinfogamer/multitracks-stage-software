import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { authService } from '../saas/AuthService';
import { masterCatalogService } from '../saas/MasterCatalogService';
import { subscriptionService } from '../saas/SubscriptionService';
import { supabase } from '../saas/supabaseClient';
import { openExternalUrl } from '../utils/openUrl';
import type { CatalogSong, GoogleServiceAccountKey, MasterCloudConfig, PaymentGatewayConfig, User, UserApprovalStatus } from '../saas/types';

interface Props {
  onClose: () => void;
  onCatalogUpdated?: () => void;
}

export function AdminPanelDialog({ onClose, onCatalogUpdated }: Props) {
  const [activeTab, setActiveTab] = useState<'pending' | 'subscriptions' | 'gateways' | 'cloud'>('pending');
  const [config, setConfig] = useState<MasterCloudConfig>(() => masterCatalogService.getMasterConfig());
  const [provider, setProvider] = useState<'gdrive' | 'onedrive'>(config.provider);
  const [rootFolderInput, setRootFolderInput] = useState(config.rootFolderId);
  const [serviceAccount, setServiceAccount] = useState<GoogleServiceAccountKey | null>(config.serviceAccount ?? null);
  const [adminWhatsApp, setAdminWhatsApp] = useState(() => masterCatalogService.getAdminWhatsAppNumber());

  const [syncing, setSyncing] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [catalogSongs, setCatalogSongs] = useState<CatalogSong[]>(() => masterCatalogService.getCatalog());
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const refreshUsers = () => {
    setUsers(authService.listUsers());
  };

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
   * Ação: Excluir permanentemente o cliente via RPC do Supabase
   */
  const handleDeleteUser = async (idDoCliente: string, nomeDoCliente: string) => {
    const confirmed = window.confirm(
      `Tem certeza que deseja excluir permanentemente o cadastro de "${nomeDoCliente}"?\n\nEsta ação removerá o usuário na nuvem (Supabase) e não pode ser desfeita.`
    );
    if (!confirmed) return;

    setUpdatingId(idDoCliente);
    setActionFeedback(`Excluindo cadastro de ${nomeDoCliente}...`);

    // Atualização otimista imediata na interface
    setPendingUsers((prev) => prev.filter((u) => u.id !== idDoCliente));
    setSupabaseUsers((prev) => prev.filter((u) => u.id !== idDoCliente));
    setUsers((prev) => prev.filter((u) => u.id !== idDoCliente));

    try {
      // 1. Executa a função RPC do Supabase
      const { error: rpcError } = await supabase.rpc('admin_delete_user', {
        target_user_id: idDoCliente,
      });

      if (rpcError) {
        console.warn('[AdminPanel] Aviso no RPC admin_delete_user, tentando delete direto em profiles:', rpcError.message);
        // Fallback: exclusão direta na tabela profiles caso a RPC não esteja exposta
        const { error: tableError } = await supabase
          .from('profiles')
          .delete()
          .eq('id', idDoCliente);
        if (tableError) {
          throw new Error(tableError.message || rpcError.message);
        }
      }

      // 2. Remove do cache local do AuthService
      authService.deleteUser(idDoCliente);

      setActionFeedback(`🗑️ Cadastro de ${nomeDoCliente} excluído com sucesso!`);

      // 3. Recarrega os dados atualizados da tabela sem reload de página
      await loadPendingUsers();
      await loadSupabaseUsers();
      refreshUsers();
    } catch (err: any) {
      setActionFeedback(`❌ Falha ao excluir usuário: ${err.message || String(err)}`);
      // Em caso de falha, recarrega para restaurar o estado correto
      await loadPendingUsers();
      await loadSupabaseUsers();
    } finally {
      setUpdatingId(null);
      setTimeout(() => setActionFeedback(null), 4000);
    }
  };

  const RLS_FIX_SQL = `-- Copie e execute no SQL Editor do Supabase para corrigir e garantir permissões sem recursão infinita:
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can update all profiles" ON profiles;

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
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
  );
$$;

CREATE POLICY "Admins can view all profiles" ON profiles FOR SELECT USING (is_admin());
CREATE POLICY "Admins can update all profiles" ON profiles FOR UPDATE USING (is_admin());
`;

  const handleSaveConfig = () => {
    masterCatalogService.saveMasterConfig({
      provider,
      rootFolderId: rootFolderInput.trim(),
      serviceAccount,
      adminWhatsAppNumber: adminWhatsApp.replace(/\D/g, ''),
    });
    setConfig(masterCatalogService.getMasterConfig());
    setStatusMsg('✅ Configurações do servidor central e WhatsApp salvas com sucesso!');
  };

  const handleJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string) as GoogleServiceAccountKey;
        if (!json.private_key || !json.client_email) {
          throw new Error('Arquivo JSON inválido. Certifique-se de ser uma chave de Service Account do Google Cloud.');
        }
        setServiceAccount(json);
        masterCatalogService.saveMasterConfig({ serviceAccount: json });
        setConfig(masterCatalogService.getMasterConfig());
        setStatusMsg(`✅ Chave de Service Account "${json.client_email}" carregada com sucesso!`);
      } catch (err) {
        setStatusMsg(`❌ Falha ao carregar JSON: ${(err as Error).message}`);
      }
    };
    reader.readAsText(file);
  };

  const handleCopyEmail = () => {
    if (!serviceAccount?.client_email) return;
    navigator.clipboard.writeText(serviceAccount.client_email);
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2000);
  };

  const handleSyncNow = async () => {
    handleSaveConfig();
    setSyncing(true);
    setStatusMsg('Conectando ao Drive mestre via Service Account e sincronizando catálogo…');

    try {
      const res = await masterCatalogService.syncCatalogFromMasterCloud((msg) => {
        setStatusMsg(msg);
      });
      setCatalogSongs(res.songs);
      setConfig(masterCatalogService.getMasterConfig());
      onCatalogUpdated?.();
      setStatusMsg(`🎉 Catálogo sincronizado com sucesso! Total de ${res.count} músicas disponíveis para os usuários.`);
    } catch (err) {
      setStatusMsg(`❌ Falha no sync: ${(err as Error).message}`);
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
    setGatewaySavedMsg('✅ Configurações dos Gateways Stripe & Asaas salvas com sucesso!');
    setTimeout(() => setGatewaySavedMsg(null), 3000);
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
            💳 Gateways & Webhooks (Stripe / Asaas)
          </button>
          <button
            className={`btn small ${activeTab === 'cloud' ? 'primary' : ''}`}
            onClick={() => setActiveTab('cloud')}
            style={{ fontWeight: 700 }}
          >
            ☁️ Servidor Google Drive ({catalogSongs.length} músicas)
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

                          <button
                            className="btn small"
                            disabled={isProcessing}
                            onClick={() => handleDeleteUser(client.id, client.name)}
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
                  {users.length}
                </div>
              </div>
              <div style={{ background: '#16181e', border: '1px solid #10b981', borderRadius: 8, padding: 12 }}>
                <span className="muted" style={{ fontSize: 11 }}>Assinaturas Ativas:</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#34d399', marginTop: 2 }}>
                  {users.filter(u => u.subscription?.status === 'active').length}
                </div>
              </div>
              <div style={{ background: '#16181e', border: '1px solid #ef4444', borderRadius: 8, padding: 12 }}>
                <span className="muted" style={{ fontSize: 11 }}>Inadimplentes / Bloqueados:</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#f87171', marginTop: 2 }}>
                  {users.filter(u => u.subscription?.status === 'past_due' || u.subscription?.status === 'canceled').length}
                </div>
              </div>
              <div style={{ background: '#16181e', border: '1px solid #f59e0b', borderRadius: 8, padding: 12 }}>
                <span className="muted" style={{ fontSize: 11 }}>Contas VIP / Master:</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fbbf24', marginTop: 2 }}>
                  {users.filter(u => u.role === 'admin' || u.subscription?.planId === 'church_vip').length}
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
                {users.map((u) => {
                  const sub = u.subscription;
                  const status = sub?.status || 'active';
                  const isBlocked = status === 'past_due' || status === 'canceled';
                  const isVip = u.role === 'admin' || sub?.planId === 'admin_vip' || sub?.planId === 'church_vip';

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
                            {u.role === 'admin' ? '👑' : isBlocked ? '⚠️' : '🎸'}
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
                                  background: u.role === 'admin' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(0, 153, 255, 0.2)',
                                  color: u.role === 'admin' ? '#f59e0b' : '#38bdf8',
                                }}
                              >
                                {u.role === 'admin' ? 'Admin' : 'Músico'}
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
                          Plano: <span style={{ color: '#f1f5f9', fontWeight: 600 }}>{sub?.planName || 'Mensal'}</span> · Gateway: <span style={{ color: '#f1f5f9', textTransform: 'uppercase' }}>{sub?.provider || 'Stripe'}</span> · Vence: <span style={{ color: '#38bdf8' }}>{sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString('pt-BR') : 'Vitalício'}</span>
                        </div>

                        {/* Admin Action Buttons */}
                        {u.role !== 'admin' && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
                                boxShadow: '0 2px 8px rgba(239, 68, 68, 0.25)',
                              }}
                              onClick={() => handleDeleteUser(u.id, u.name)}
                              title="Excluir permanentemente este usuário do Supabase"
                            >
                              🗑️ Excluir
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: GATEWAYS & WEBHOOKS CONFIGURATION */}
        {activeTab === 'gateways' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {gatewaySavedMsg && (
              <div style={{ background: 'rgba(16, 185, 129, 0.2)', border: '1px solid #10b981', color: '#34d399', padding: '10px 14px', borderRadius: 6, fontSize: 12 }}>
                {gatewaySavedMsg}
              </div>
            )}

            {/* Provider Toggle */}
            <div style={{ background: '#16181e', border: '1px solid #2e323b', padding: 14, borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: 13, color: '#f8fafc' }}>Gateway Principal de Checkout:</strong>
                  <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                    Selecione qual provedor de pagamento será sugerido primariamente aos usuários (Excluído Mercado Pago).
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: gatewayConfig.activeProvider === 'stripe' ? '#38bdf8' : '#94a3b8' }}>
                    <input
                      type="radio"
                      name="activeProvider"
                      checked={gatewayConfig.activeProvider === 'stripe'}
                      onChange={() => setGatewayConfig(p => ({ ...p, activeProvider: 'stripe' }))}
                      style={{ accentColor: '#0099ff' }}
                    />
                    💳 Stripe (Cartão de Crédito)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: gatewayConfig.activeProvider === 'asaas' ? '#38bdf8' : '#94a3b8' }}>
                    <input
                      type="radio"
                      name="activeProvider"
                      checked={gatewayConfig.activeProvider === 'asaas'}
                      onChange={() => setGatewayConfig(p => ({ ...p, activeProvider: 'asaas' }))}
                      style={{ accentColor: '#0099ff' }}
                    />
                    ⚡ Asaas (Pix / Boleto / Cartão)
                  </label>
                </div>
              </div>
            </div>

            {/* Form for URLs and API Keys */}
            <form onSubmit={handleSaveGatewayConfig} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                {/* Stripe Card */}
                <div style={{ background: '#111317', border: '1px solid #2e323b', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>💳</span>
                    <strong style={{ fontSize: 13, color: '#f8fafc' }}>Configurações do Stripe:</strong>
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Stripe Publishable Key:</label>
                    <input
                      type="text"
                      value={gatewayConfig.stripePublishableKey || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, stripePublishableKey: e.target.value }))}
                      placeholder="pk_live_..."
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Stripe Checkout Mensal (R$ 49,90):</label>
                    <input
                      type="text"
                      value={gatewayConfig.stripeMonthlyCheckoutUrl || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, stripeMonthlyCheckoutUrl: e.target.value }))}
                      placeholder="https://buy.stripe.com/..."
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Stripe Checkout Anual Pro (R$ 479,00):</label>
                    <input
                      type="text"
                      value={gatewayConfig.stripeAnnualCheckoutUrl || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, stripeAnnualCheckoutUrl: e.target.value }))}
                      placeholder="https://buy.stripe.com/..."
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>
                </div>

                {/* Asaas Card */}
                <div style={{ background: '#111317', border: '1px solid #2e323b', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>⚡</span>
                    <strong style={{ fontSize: 13, color: '#f8fafc' }}>Configurações do Asaas (Pix):</strong>
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Asaas API Key / Token:</label>
                    <input
                      type="text"
                      value={gatewayConfig.asaasApiKey || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, asaasApiKey: e.target.value }))}
                      placeholder="$aact_..."
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Asaas Link Mensal Pix (R$ 49,90):</label>
                    <input
                      type="text"
                      value={gatewayConfig.asaasMonthlyCheckoutUrl || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, asaasMonthlyCheckoutUrl: e.target.value }))}
                      placeholder="https://asaas.com/c/..."
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>Asaas Link Anual Pix (R$ 479,00):</label>
                    <input
                      type="text"
                      value={gatewayConfig.asaasAnnualCheckoutUrl || ''}
                      onChange={(e) => setGatewayConfig(p => ({ ...p, asaasAnnualCheckoutUrl: e.target.value }))}
                      placeholder="https://asaas.com/c/..."
                      style={{ width: '100%', fontSize: 12 }}
                    />
                  </div>
                </div>
              </div>

              <button type="submit" className="btn primary" style={{ alignSelf: 'flex-start' }}>
                💾 Salvar Configurações de Checkout
              </button>
            </form>
          </div>
        )}

        {/* TAB 3: MASTER CLOUD / GOOGLE DRIVE */}
        {activeTab === 'cloud' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Service Account Banner */}
            {serviceAccount ? (
              <div
                style={{
                  background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(5, 150, 105, 0.06))',
                  border: '1px solid rgba(16, 185, 129, 0.4)',
                  borderRadius: 8,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🟢</span>
                    <strong style={{ fontSize: 14, color: '#34d399' }}>
                      Google Cloud Service Account Ativa (multitracks-pro)
                    </strong>
                  </div>
                  <button
                    className="btn small"
                    style={{ fontSize: 11, borderColor: '#34d399', color: '#34d399' }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Trocar Chave (.json)
                  </button>
                </div>

                <div
                  style={{
                    background: '#0d0e11',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid #2e323b',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <code style={{ fontSize: 12, color: '#38bdf8', wordBreak: 'break-all' }}>
                    {serviceAccount.client_email}
                  </code>
                  <button
                    className="btn small"
                    style={{ fontSize: 11, marginLeft: 8, whiteSpace: 'nowrap' }}
                    onClick={handleCopyEmail}
                  >
                    {copiedEmail ? '✅ Copiado!' : 'Copiar E-mail da Robô'}
                  </button>
                </div>

                <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
                  💡 <strong>Instrução Importante:</strong> Abra sua pasta no seu Google Drive pessoal/profissional, clique em <strong>Compartilhar</strong> e adicione o e-mail da robô acima como <strong>Leitor</strong>. Feito isso, o sistema consegue ler e baixar todas as suas músicas instantaneamente!
                </div>
              </div>
            ) : (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid #ef4444',
                  borderRadius: 8,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <strong style={{ fontSize: 13, color: '#f87171' }}>
                  Nenhuma chave de Service Account configurada!
                </strong>
                <p style={{ fontSize: 12, color: '#cbd5e1', margin: 0 }}>
                  Faça upload do arquivo JSON de credenciais fornecido pelo Google Cloud Console para ativar o servidor SaaS central.
                </p>
                <button
                  className="btn primary"
                  style={{ alignSelf: 'flex-start', marginTop: 4 }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  📁 Carregar Arquivo JSON do Google Service Account
                </button>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={handleJsonUpload}
            />

            {/* Provider and Root Folder Configuration */}
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
              <div style={{ display: 'flex', gap: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="cloud_provider"
                    checked={provider === 'gdrive'}
                    onChange={() => setProvider('gdrive')}
                  />
                  Google Drive (Oficial via Service Account)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="cloud_provider"
                    checked={provider === 'onedrive'}
                    onChange={() => setProvider('onedrive')}
                  />
                  Microsoft OneDrive (Admin Business)
                </label>
              </div>

              <div>
                <label style={{ fontSize: 12, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
                  ID da Pasta Raiz no Drive (Root Folder ID):
                </label>
                <input
                  type="text"
                  value={rootFolderInput}
                  onChange={(e) => setRootFolderInput(e.target.value)}
                  placeholder="Ex: 1A2b3C4d5E6F7G8h9I... (copie o final da URL da pasta no seu Drive)"
                  style={{ width: '100%', fontSize: 13 }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: '#38bdf8', display: 'block', marginBottom: 4 }}>
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

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn" onClick={handleSaveConfig}>
                  Salvar Parâmetros
                </button>
                <button
                  className="btn primary"
                  style={{ background: '#f59e0b', borderColor: '#f59e0b', color: '#000', fontWeight: 800 }}
                  disabled={syncing}
                  onClick={() => void handleSyncNow()}
                >
                  {syncing ? '⏳ Escaneando Pastas no Drive…' : '🔄 Sincronizar Catálogo Agora'}
                </button>
              </div>
            </div>

            {/* Current Shared Catalog Items */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 13, color: '#f8fafc' }}>
                  Músicas Ativas no Catálogo dos Músicos ({catalogSongs.length}):
                </strong>
                <span className="muted" style={{ fontSize: 11 }}>
                  {config.lastSyncTime ? `Último sync: ${new Date(config.lastSyncTime).toLocaleString('pt-BR')}` : 'Pronto para sincronizar'}
                </span>
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
