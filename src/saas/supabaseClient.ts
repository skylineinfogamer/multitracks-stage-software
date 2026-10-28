import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = (import.meta.env?.VITE_SUPABASE_URL as string) || 'https://ljrxnooemnfssqdlorgt.supabase.co';
export const SUPABASE_ANON_KEY = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string) || 'sb_publishable_evrZKVsm83zueAdT3zDzIQ_udMTgpWN';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
