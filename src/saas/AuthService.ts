import type { Setlist, Song } from '../types';
import type {
  AuthSession,
  User,
  UserApprovalStatus,
  UserCustomization,
  UserProfileSync,
  UserRole,
  UserSubscription,
} from './types';
import { supabase } from './supabaseClient';

const LS_USERS_KEY = 'wpp_saas_users_v1';
const LS_SESSION_KEY = 'wpp_saas_session_v1';
const LS_USER_SYNC_PREFIX = 'wpp_saas_sync_';

interface StoredUserRecord extends User {
  passwordHash: string; // Base64 or hash for local testing/JWT
}

const DEFAULT_USERS: StoredUserRecord[] = [
  {
    id: 'usr_admin',
    name: 'Administradora (multitracks-pro)',
    email: 'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com',
    passwordHash: btoa('admin123'),
    role: 'admin',
    status: 'active',
    churchName: 'MultiTracks Pro Cloud (Service Account)',
    createdAt: new Date().toISOString(),
    subscription: {
      planId: 'admin_vip',
      planName: 'Acesso Master Administradora',
      status: 'active',
      provider: 'manual',
      currentPeriodEnd: '2099-12-31T23:59:59.000Z',
      priceBrl: 0,
      billingCycle: 'lifetime',
      lastPaymentDate: new Date().toISOString(),
    },
  },
  {
    id: 'usr_admin_alias',
    name: 'Administradora do Catálogo',
    email: 'admin@playback.pro',
    passwordHash: btoa('admin123'),
    role: 'admin',
    status: 'active',
    churchName: 'Sede Central',
    createdAt: new Date().toISOString(),
    subscription: {
      planId: 'admin_vip',
      planName: 'Acesso Master Administradora',
      status: 'active',
      provider: 'manual',
      currentPeriodEnd: '2099-12-31T23:59:59.000Z',
      priceBrl: 0,
      billingCycle: 'lifetime',
      lastPaymentDate: new Date().toISOString(),
    },
  },
];

class AuthService {
  private users: StoredUserRecord[] = [];
  private currentSession: AuthSession | null = null;
  private listeners: Set<(session: AuthSession | null) => void> = new Set();

  constructor() {
    this.init();
    this.listenToSupabaseAuth();
  }

  private init() {
    try {
      const storedUsers = localStorage.getItem(LS_USERS_KEY);
      if (storedUsers) {
        this.users = JSON.parse(storedUsers) as StoredUserRecord[];
      } else {
        this.users = [...DEFAULT_USERS];
        this.saveUsers();
      }

      // Purge legacy mock users (e.g. usr_musico) and ensure ONLY the 2 master accounts can be admin
      const initialLen = this.users.length;
      this.users = this.users.filter((u) => u.id !== 'usr_musico' && u.email.toLowerCase() !== 'musico@igreja.com');
      let modified = this.users.length !== initialLen;

      for (const u of this.users) {
        const email = u.email.toLowerCase().trim();
        const isMaster =
          email === 'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com' ||
          email === 'admin@playback.pro' ||
          u.id === 'usr_admin' ||
          u.id === 'usr_admin_alias';

        if (!isMaster && u.role === 'admin') {
          u.role = 'user';
          modified = true;
        }
        if (!u.status) {
          u.status = u.role === 'admin' ? 'active' : 'active';
          modified = true;
        }
        if (!u.subscription) {
          if (u.role === 'admin') {
            u.subscription = {
              planId: 'admin_vip',
              planName: 'Acesso Master Administradora',
              status: 'active',
              provider: 'manual',
              currentPeriodEnd: '2099-12-31T23:59:59.000Z',
              priceBrl: 0,
              billingCycle: 'lifetime',
              lastPaymentDate: new Date().toISOString(),
            };
          } else {
            u.subscription = {
              planId: 'monthly',
              planName: 'Plano Worship Mensal',
              status: 'active',
              provider: 'stripe',
              currentPeriodEnd: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
              priceBrl: 49.90,
              billingCycle: 'monthly',
              lastPaymentDate: new Date().toISOString(),
            };
          }
          modified = true;
        } else if (u.role === 'admin' && u.subscription.status !== 'active') {
          u.subscription.status = 'active';
          u.subscription.planId = 'admin_vip';
          modified = true;
        }
      }
      if (modified) {
        this.saveUsers();
      }

      const storedSession = localStorage.getItem(LS_SESSION_KEY);
      if (storedSession) {
        const parsed = JSON.parse(storedSession) as AuthSession;
        const userExists = this.users.find((u) => u.id === parsed.user.id);
        if (userExists) {
          this.currentSession = { ...parsed, user: this.sanitizeUser(userExists) };
        } else {
          this.currentSession = parsed;
        }

        // Validate cloud status directly to avoid local cache bypass
        if (this.currentSession?.user?.id) {
          this.validateSessionOnCloud(this.currentSession.user.id);
        }
      } else {
        this.currentSession = null;
      }
    } catch (e) {
      console.warn('Falha ao inicializar AuthService:', e);
      this.users = [...DEFAULT_USERS];
    }
  }

  /**
   * Validates active session directly in the cloud (profiles table) to prevent cached bypass.
   */
  private async validateSessionOnCloud(userId: string) {
    if (userId === 'usr_admin' || userId === 'usr_admin_alias') return;

    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (!error && profile) {
        if (profile.role !== 'admin' && (profile.status === 'pending' || profile.status === 'rejected')) {
          console.warn(`[AuthService] Sessão invalidada na nuvem. Status do perfil: ${profile.status}`);
          await supabase.auth.signOut().catch(() => {});
          this.currentSession = null;
          localStorage.removeItem(LS_SESSION_KEY);
          this.notify();
        } else if (profile.status === 'active' && this.currentSession?.user) {
          this.currentSession.user.status = 'active';
          if (profile.role) this.currentSession.user.role = profile.role;
          this.notify();
        }
      }
    } catch (e) {
      console.warn('Erro ao verificar status na nuvem:', e);
    }
  }

  private listenToSupabaseAuth() {
    try {
      supabase.auth.onAuthStateChange(async (_event, session) => {
        if (session?.user) {
          await this.syncSessionFromSupabaseUser(session.user);
        }
      });
    } catch (e) {
      console.warn('Falha ao escutar auth state change:', e);
    }
  }

  private async syncSessionFromSupabaseUser(sbUser: any): Promise<User | null> {
    let profile: any = null;
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', sbUser.id)
        .maybeSingle();
      if (!error && data) {
        profile = data;
      }
    } catch {
      /* ignore */
    }

    const email = sbUser.email || '';
    const isAdminEmail =
      email.toLowerCase() === 'admin@playback.pro' ||
      email.toLowerCase() === 'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com';

    const role: UserRole = isAdminEmail ? 'admin' : 'user';
    const status: UserApprovalStatus =
      role === 'admin'
        ? 'active'
        : ((profile?.status || sbUser.user_metadata?.status || 'pending') as UserApprovalStatus);

    // If account is pending or rejected, immediately revoke session
    if (role !== 'admin' && (status === 'pending' || status === 'rejected')) {
      await supabase.auth.signOut().catch(() => {});
      this.currentSession = null;
      localStorage.removeItem(LS_SESSION_KEY);
      this.notify();
      return null;
    }

    const name: string = profile?.name || sbUser.user_metadata?.name || email.split('@')[0] || 'Usuário';
    const churchName: string = profile?.church_name || sbUser.user_metadata?.church_name || 'Ministério de Louvor';

    const user: User = {
      id: sbUser.id,
      name,
      email,
      role,
      status: 'active',
      churchName,
      createdAt: profile?.created_at || sbUser.created_at || new Date().toISOString(),
      subscription:
        role === 'admin'
          ? {
              planId: 'admin_vip',
              planName: 'Acesso Master Administradora',
              status: 'active',
              provider: 'manual',
              currentPeriodEnd: '2099-12-31T23:59:59.000Z',
              priceBrl: 0,
              billingCycle: 'lifetime',
              lastPaymentDate: new Date().toISOString(),
            }
          : {
              planId: 'monthly',
              planName: 'Plano Worship Mensal',
              status: 'active',
              provider: 'infinitepay',
              currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              priceBrl: 49.90,
              billingCycle: 'monthly',
              lastPaymentDate: new Date().toISOString(),
            },
    };

    // Update in local array cache
    const idx = this.users.findIndex((u) => u.id === user.id || u.email.toLowerCase() === email.toLowerCase());
    if (idx !== -1) {
      this.users[idx] = { ...this.users[idx], ...user };
    } else {
      this.users.push({ ...user, passwordHash: '' });
    }
    this.saveUsers();

    // Set session
    this.setSessionFromUser(user);
    return user;
  }

  private sanitizeUser(u: StoredUserRecord): User {
    const { passwordHash: _p, ...safe } = u;
    return safe;
  }

  private saveUsers() {
    localStorage.setItem(LS_USERS_KEY, JSON.stringify(this.users));
  }

  private setSession(userRecord: StoredUserRecord): AuthSession {
    const safeUser = this.sanitizeUser(userRecord);
    return this.setSessionFromUser(safeUser);
  }

  private setSessionFromUser(user: User): AuthSession {
    const session: AuthSession = {
      user,
      token: `jwt_${user.id}_${Date.now()}`,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.currentSession = session;
    localStorage.setItem(LS_SESSION_KEY, JSON.stringify(session));
    this.notify();
    return session;
  }

  onSessionChange(cb: (session: AuthSession | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify() {
    for (const cb of this.listeners) {
      try {
        cb(this.currentSession);
      } catch {
        /* ignore */
      }
    }
  }

  getCurrentSession(): AuthSession | null {
    return this.currentSession;
  }

  getCurrentUser(): User | null {
    return this.currentSession?.user ?? null;
  }

  getUserById(userId: string): User | null {
    const record = this.users.find((u) => u.id === userId);
    return record ? this.sanitizeUser(record) : null;
  }

  findUserByEmail(email: string): User | null {
    const clean = email.trim().toLowerCase();
    const record = this.users.find((u) => u.email.toLowerCase() === clean);
    return record ? this.sanitizeUser(record) : null;
  }

  deleteUser(userId: string, email?: string): void {
    const cleanEmail = email?.trim().toLowerCase();
    this.users = this.users.filter(
      (u) => u.id !== userId && (!cleanEmail || u.email.toLowerCase() !== cleanEmail)
    );
    this.saveUsers();
    if (
      this.currentSession?.user.id === userId ||
      (cleanEmail && this.currentSession?.user.email.toLowerCase() === cleanEmail)
    ) {
      this.logout();
    }
  }

  updateUser(userId: string, patch: Partial<User>): User {
    const idx = this.users.findIndex((u) => u.id === userId);
    if (idx === -1) {
      throw new Error(`Usuário ${userId} não encontrado.`);
    }

    const current = this.users[idx];
    const updated: StoredUserRecord = {
      ...current,
      ...patch,
      subscription: patch.subscription ? { ...current.subscription, ...patch.subscription } : current.subscription,
    };

    this.users[idx] = updated;
    this.saveUsers();

    const sanitized = this.sanitizeUser(updated);

    if (this.currentSession && this.currentSession.user.id === userId) {
      this.currentSession = {
        ...this.currentSession,
        user: sanitized,
      };
      localStorage.setItem(LS_SESSION_KEY, JSON.stringify(this.currentSession));
      this.notify();
    }

    return sanitized;
  }

  isAdmin(): boolean {
    return this.currentSession?.user.role === 'admin';
  }

  /**
   * Refresh current user profile directly from Supabase (e.g. check if pending has been approved)
   */
  async refreshCurrentUser(): Promise<User | null> {
    const currentUser = this.getCurrentUser();
    if (!currentUser) return null;

    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .maybeSingle();

      if (!error && profile) {
        const newStatus = (profile.status || currentUser.status) as UserApprovalStatus;
        const newRole = (profile.role || currentUser.role) as UserRole;

        if (newRole !== 'admin' && (newStatus === 'pending' || newStatus === 'rejected')) {
          await this.logout();
          return null;
        }

        const updated = this.updateUser(currentUser.id, {
          status: newStatus,
          role: newRole,
          name: profile.name || currentUser.name,
          churchName: profile.church_name || currentUser.churchName,
        });
        return updated;
      }
    } catch (e) {
      console.warn('Erro ao atualizar usuário do Supabase:', e);
    }
    return currentUser;
  }

  /**
   * Login with email and password via Supabase Auth, validating directly in the profiles cloud table.
   */
  async login(email: string, password: string): Promise<User> {
    const cleanEmail = email.trim().toLowerCase();
    const cleanPass = password.trim();

    if (!cleanEmail || !cleanPass) {
      throw new Error('Preencha o e-mail e a senha para entrar.');
    }

    let supabaseAuthError: any = null;
    let authUser: any = null;

    // 1. Authenticate with Supabase Auth
    try {
      const res = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password: cleanPass,
      });
      if (res.error) {
        supabaseAuthError = res.error;
      } else if (res.data?.user) {
        authUser = res.data.user;
      }
    } catch (err) {
      supabaseAuthError = err;
    }

    // 2. If Supabase authenticated successfully, VALIDATE DIRECTLY IN THE PROFILES TABLE
    if (authUser) {
      let profile: any = null;
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', authUser.id)
          .maybeSingle();

        if (!error && data) {
          profile = data;
        } else if (error) {
          console.warn('[AuthService] Erro ao consultar profile:', error.message);
        }
      } catch (err) {
        console.warn('[AuthService] Falha na consulta de profiles:', err);
      }

      const isAdminEmail =
        cleanEmail === 'admin@playback.pro' ||
        cleanEmail === 'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com';

      const role: UserRole = isAdminEmail ? 'admin' : 'user';
      const status: UserApprovalStatus =
        role === 'admin'
          ? 'active'
          : ((profile?.status || authUser.user_metadata?.status || 'pending') as UserApprovalStatus);

      const userName = profile?.name || authUser.user_metadata?.name || cleanEmail.split('@')[0] || 'Usuário';
      const userChurch = profile?.church_name || authUser.user_metadata?.church_name || 'Ministério de Louvor';

      // RIGOROUS CLOUD ACCESS STATUS CHECK:
      if (role !== 'admin') {
        if (status === 'pending') {
          // Immediately revoke session in Supabase Auth & wipe local session cache
          await supabase.auth.signOut().catch(() => {});
          this.currentSession = null;
          localStorage.removeItem(LS_SESSION_KEY);
          this.notify();

          const err: any = new Error('PENDING_APPROVAL');
          err.code = 'PENDING_APPROVAL';
          err.user = {
            id: authUser.id,
            name: userName,
            email: cleanEmail,
            churchName: userChurch,
          };
          throw err;
        }

        if (status === 'rejected') {
          // Immediately revoke session
          await supabase.auth.signOut().catch(() => {});
          this.currentSession = null;
          localStorage.removeItem(LS_SESSION_KEY);
          this.notify();

          const err: any = new Error('ACCESS_REJECTED');
          err.code = 'ACCESS_REJECTED';
          err.user = {
            id: authUser.id,
            name: userName,
            email: cleanEmail,
          };
          throw err;
        }
      }

      // If active (or admin), assemble authenticated user
      const activeUser: User = {
        id: authUser.id,
        name: userName,
        email: cleanEmail,
        role,
        status: 'active',
        churchName: userChurch,
        createdAt: profile?.created_at || authUser.created_at || new Date().toISOString(),
        subscription:
          role === 'admin'
            ? {
                planId: 'admin_vip',
                planName: 'Acesso Master Administradora',
                status: 'active',
                provider: 'manual',
                currentPeriodEnd: '2099-12-31T23:59:59.000Z',
                priceBrl: 0,
                billingCycle: 'lifetime',
                lastPaymentDate: new Date().toISOString(),
              }
            : {
                planId: 'monthly',
                planName: 'Plano Worship Mensal',
                status: 'active',
                provider: 'infinitepay',
                currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                priceBrl: 49.90,
                billingCycle: 'monthly',
                lastPaymentDate: new Date().toISOString(),
              },
      };

      // Cache active user
      const idx = this.users.findIndex((u) => u.id === activeUser.id || u.email.toLowerCase() === cleanEmail);
      if (idx !== -1) {
        this.users[idx] = { ...this.users[idx], ...activeUser };
      } else {
        this.users.push({ ...activeUser, passwordHash: '' });
      }
      this.saveUsers();

      this.setSessionFromUser(activeUser);
      return activeUser;
    }

    // 3. Fallback for offline service accounts
    const localUser = this.users.find(
      (u) =>
        u.email.toLowerCase() === cleanEmail ||
        (cleanEmail === 'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com' && u.role === 'admin') ||
        (cleanEmail === 'admin@playback.pro' && u.role === 'admin'),
    );

    if (localUser && localUser.passwordHash === btoa(cleanPass)) {
      if (localUser.role !== 'admin' && localUser.status === 'pending') {
        const err: any = new Error('PENDING_APPROVAL');
        err.code = 'PENDING_APPROVAL';
        err.user = { name: localUser.name, email: localUser.email, churchName: localUser.churchName };
        throw err;
      }
      if (localUser.role !== 'admin' && localUser.status === 'rejected') {
        const err: any = new Error('ACCESS_REJECTED');
        err.code = 'ACCESS_REJECTED';
        throw err;
      }

      const sess = this.setSession(localUser);
      return sess.user;
    }

    // 4. Translate Supabase errors
    if (supabaseAuthError) {
      const msg = supabaseAuthError.message || '';
      if (msg.includes('Invalid login credentials') || msg.includes('invalid_grant')) {
        throw new Error('E-mail ou senha incorretos. Verifique suas credenciais e tente novamente.');
      }
      if (msg.includes('Email not confirmed')) {
        throw new Error('E-mail ainda não confirmado. Verifique a caixa de entrada do seu e-mail.');
      }
      if (msg.includes('Failed to fetch') || msg.includes('network')) {
        throw new Error('Não foi possível conectar ao servidor. Verifique sua conexão com a internet.');
      }
      throw new Error(`Falha no login: ${msg}`);
    }

    throw new Error('E-mail ou senha incorretos. Verifique os dados digitados ou crie uma nova conta.');
  }

  /**
   * Register a new user in Supabase Auth and insert into `profiles` with status 'pending'.
   */
  async register(
    name: string,
    email: string,
    password: string,
    churchName = '',
    role: UserRole = 'user',
  ): Promise<User> {
    const cleanEmail = email.trim().toLowerCase();
    const cleanPass = password.trim();
    const cleanName = name.trim();
    const cleanChurch = churchName.trim() || 'Ministério de Louvor';

    if (!cleanName || !cleanEmail || !cleanPass) {
      throw new Error('Preencha todos os campos obrigatórios (Nome, E-mail e Senha).');
    }

    if (cleanPass.length < 6) {
      throw new Error('A senha deve conter no mínimo 6 caracteres para sua segurança.');
    }

    // Check local duplicate
    if (this.users.some((u) => u.email.toLowerCase() === cleanEmail)) {
      throw new Error('Este e-mail já está cadastrado. Faça login ou use outro e-mail!');
    }

    let authUser: any = null;

    // 1. Sign up on Supabase Auth
    try {
      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password: cleanPass,
        options: {
          data: {
            name: cleanName,
            church_name: cleanChurch,
            role,
            status: 'pending',
          },
        },
      });

      if (error) {
        const msg = error.message;
        if (msg.includes('already registered') || msg.includes('User already registered')) {
          throw new Error('Este e-mail já está cadastrado no sistema. Faça login para continuar.');
        }
        if (msg.includes('Password should be at least')) {
          throw new Error('A senha deve ter pelo menos 6 caracteres.');
        }
        throw new Error(msg);
      }

      authUser = data.user;
    } catch (err: any) {
      if (err.message) throw err;
      throw new Error('Erro ao registrar no Supabase: ' + String(err));
    }

    const userId = authUser?.id || `usr_${Date.now()}`;

    // 2. Insert into `profiles` table with status 'pending'
    try {
      await supabase.from('profiles').upsert({
        id: userId,
        name: cleanName,
        email: cleanEmail,
        church_name: cleanChurch,
        role,
        status: 'pending' as UserApprovalStatus,
        created_at: new Date().toISOString(),
      });
    } catch (profileErr) {
      console.warn('Aviso ao registrar perfil no Supabase:', profileErr);
    }

    // 3. Close auth session immediately so pending user cannot stay logged in
    await supabase.auth.signOut().catch(() => {});
    this.currentSession = null;
    localStorage.removeItem(LS_SESSION_KEY);
    this.notify();

    const initialSubscription: UserSubscription = {
      planId: 'monthly',
      planName: 'Plano Worship Mensal (Aguardando Aprovação)',
      status: 'unpaid',
      provider: 'infinitepay',
      currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      priceBrl: 49.90,
      billingCycle: 'monthly',
      lastPaymentDate: new Date().toISOString(),
    };

    const newUser: StoredUserRecord = {
      id: userId,
      name: cleanName,
      email: cleanEmail,
      passwordHash: btoa(cleanPass),
      role,
      status: 'pending',
      churchName: cleanChurch,
      createdAt: new Date().toISOString(),
      subscription: initialSubscription,
    };

    this.users.push(newUser);
    this.saveUsers();

    return this.sanitizeUser(newUser);
  }

  /**
   * Fetch all profiles from Supabase profiles table for admin review.
   */
  async listSupabaseProfiles(): Promise<User[]> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && Array.isArray(data)) {
        return data.map((p: any) => {
          const email = (p.email || '').toLowerCase().trim();
          const isMaster =
            email === 'admin@playback.pro' ||
            email === 'servidor-vs-backend@multitracks-pro.iam.gserviceaccount.com';
          const role: UserRole = isMaster ? 'admin' : 'user';
          return {
            id: p.id,
            name: p.name || 'Sem nome',
            email: p.email || 'sem-email',
            role,
            status: (p.status || 'pending') as UserApprovalStatus,
            churchName: p.church_name || '',
            createdAt: p.created_at || new Date().toISOString(),
            subscription: {
              planId: isMaster ? 'admin_vip' : 'monthly',
              planName: isMaster ? 'Acesso Master Administradora' : 'Plano Worship Mensal',
              status: isMaster ? 'active' : p.status === 'active' ? 'active' : 'unpaid',
              provider: 'manual',
              currentPeriodEnd: isMaster
                ? '2099-12-31T23:59:59.000Z'
                : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              priceBrl: isMaster ? 0 : 49.9,
              billingCycle: isMaster ? 'lifetime' : 'monthly',
              lastPaymentDate: new Date().toISOString(),
            },
          };
        });
      }
      if (error) {
        console.warn('Aviso Supabase list profiles:', error.message);
      }
    } catch (err) {
      console.warn('Erro ao buscar perfis do Supabase:', err);
    }

    // Fallback to local users list
    return this.listUsers();
  }

  /**
   * Admin approves or rejects a user profile.
   */
  async updateUserApprovalStatus(userId: string, newStatus: UserApprovalStatus): Promise<void> {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ status: newStatus })
        .eq('id', userId);

      if (error) {
        console.warn('Aviso ao atualizar status no Supabase:', error.message);
      }
    } catch (err) {
      console.warn('Erro ao atualizar status no Supabase:', err);
    }

    // Update in local cache
    const idx = this.users.findIndex((u) => u.id === userId);
    if (idx !== -1) {
      this.users[idx].status = newStatus;
      if (this.users[idx].subscription) {
        this.users[idx].subscription!.status = newStatus === 'active' ? 'active' : 'unpaid';
      }
      this.saveUsers();

      if (this.currentSession && this.currentSession.user.id === userId) {
        this.currentSession.user.status = newStatus;
        if (this.currentSession.user.subscription) {
          this.currentSession.user.subscription.status = newStatus === 'active' ? 'active' : 'unpaid';
        }
        localStorage.setItem(LS_SESSION_KEY, JSON.stringify(this.currentSession));
        this.notify();
      }
    }
  }

  changePassword(userId: string, newPass: string): void {
    const cleanPass = newPass.trim();
    if (cleanPass.length < 4) {
      throw new Error('A nova senha deve ter no mínimo 4 caracteres.');
    }
    const idx = this.users.findIndex((u) => u.id === userId);
    if (idx === -1) throw new Error('Usuário não encontrado.');
    this.users[idx].passwordHash = btoa(cleanPass);
    this.saveUsers();
  }

  async logout() {
    try {
      await supabase.auth.signOut();
    } catch {
      /* ignore */
    }
    this.currentSession = null;
    localStorage.removeItem(LS_SESSION_KEY);
    this.notify();
  }

  // User setlists and song mixes sync to profile
  saveUserSync(setlists: Setlist[], songs: Song[]): void {
    const user = this.getCurrentUser();
    if (!user) return;

    const customizations: Record<string, UserCustomization> = {};
    for (const s of songs) {
      const trackMix: Record<string, { volume: number; mute: boolean; solo: boolean; pan: number }> = {};
      for (const t of s.tracks) {
        trackMix[t.id] = { volume: t.volume, mute: t.mute, solo: t.solo, pan: t.pan };
      }
      customizations[s.id] = {
        pitchOffset: s.pitchOffset,
        pitchCents: s.pitchCents,
        bpm: s.bpm,
        trackMix,
      };
    }

    const syncPayload: UserProfileSync = {
      userId: user.id,
      setlists,
      songCustomizations: customizations,
      updatedAt: new Date().toISOString(),
    };

    try {
      localStorage.setItem(`${LS_USER_SYNC_PREFIX}${user.id}`, JSON.stringify(syncPayload));
    } catch {
      /* quota */
    }
  }

  loadUserSync(userId: string): UserProfileSync | null {
    try {
      const raw = localStorage.getItem(`${LS_USER_SYNC_PREFIX}${userId}`);
      return raw ? (JSON.parse(raw) as UserProfileSync) : null;
    } catch {
      return null;
    }
  }

  listUsers(): User[] {
    return this.users.map((u) => this.sanitizeUser(u));
  }
}

export const authService = new AuthService();
