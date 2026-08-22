import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://lazdyihryfvrlczczvxz.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhemR5aWhyeWZ2cmxjemN6dnh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNzYxNjgsImV4cCI6MjEwMjk1MjE2OH0.fUBdMbDgV8e0Fk4mfVB8DqQc88vrw8oA6MdHXHFsXAs';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
