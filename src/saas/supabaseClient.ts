import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = (import.meta.env?.VITE_SUPABASE_URL as string) || 'https://ljrxnooemnfssqdlorgt.supabase.co';
export const SUPABASE_ANON_KEY = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string) || 'sb_publishable_evrZKVsm83zueAdT3zDzIQ_udMTgpWN';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'wpp_supabase_auth_token_v1',
  },
  global: {
    headers: {
      'x-application-name': 'WorshipPlaybackPro',
    },
  },
});

/**
 * Health check helper para verificar a conectividade e latência com o Supabase.
 */
export async function checkSupabaseHealth(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
  const start = performance.now();
  try {
    const { error } = await supabase.from('profiles').select('id').limit(1).maybeSingle();
    const latencyMs = Math.round(performance.now() - start);
    if (error && error.code !== 'PGRST116') {
      return { ok: false, latencyMs, message: error.message };
    }
    return { ok: true, latencyMs };
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - start);
    return { ok: false, latencyMs, message: err?.message || 'Falha de conexão com o Supabase' };
  }
}

