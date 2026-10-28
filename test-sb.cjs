const { createClient } = require('@supabase/supabase-js');
const sb = createClient('https://ljrxnooemnfssqdlorgt.supabase.co', 'sb_publishable_evrZKVsm83zueAdT3zDzIQ_udMTgpWN');

async function main() {
  try {
    const res = await sb.from('profiles').select('*').limit(5);
    console.log('STATUS:', res.status, 'ERROR:', res.error ? res.error.message : 'none', 'DATA:', res.data);
  } catch (e) {
    console.error('EXCEPTION:', e.message);
  }
  process.exit(0);
}
main();
