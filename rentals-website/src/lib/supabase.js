import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://dnpuqnmukawehtjxfqct.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRucHVxbm11a2F3ZWh0anhmcWN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0ODg2NjUsImV4cCI6MjEwMTA2NDY2NX0.Sg455y5OYkT1OvUarfXt6-E_tRukEZ62GawXPhIjEng';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
