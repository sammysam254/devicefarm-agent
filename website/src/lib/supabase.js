import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://kfziemhcidowtpbpjwrh.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmemllbWhjaWRvd3RwYnBqd3JoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTQ4NzY1NCwiZXhwIjoyMTAxMDYzNjU0fQ.Q-uBOwQHcbY1rQ1rvM99aQQ70GmV_ySMK74T_wSp-0A';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
