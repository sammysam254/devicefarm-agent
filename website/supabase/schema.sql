-- ══════════════════════════════════════════════════════════════════════════════
-- DEVICEFARM ONLINE MANAGEMENT SYSTEM — SUPABASE DATABASE SCHEMA
-- Execute this script in your Supabase Project -> SQL Editor
-- ══════════════════════════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. PROFILES TABLE (Stores user roles: seed_admin, super_admin, admin, worker)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('seed_admin', 'super_admin', 'admin', 'worker')),
    super_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    is_blocked BOOLEAN DEFAULT FALSE,
    blocked_reason TEXT DEFAULT NULL,
    blocked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. MACHINE BINDINGS TABLE (Stores 8-digit binding code printed by setup script)
CREATE TABLE IF NOT EXISTS public.machine_bindings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    binding_code TEXT UNIQUE NOT NULL,
    machine_name TEXT DEFAULT 'Windows Agent Machine',
    super_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    is_licensed BOOLEAN DEFAULT TRUE,
    license_mode TEXT DEFAULT 'licensed' CHECK (license_mode IN ('licensed', 'free')),
    license_note TEXT DEFAULT 'Active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. DEVICES TABLE (Stores connected device streams & live Cloudflare URLs)
CREATE TABLE IF NOT EXISTS public.devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    serial TEXT UNIQUE NOT NULL,
    model TEXT DEFAULT 'Android Device',
    brand TEXT DEFAULT 'Generic',
    stream_url TEXT,
    local_url TEXT,
    port INT,
    binding_code TEXT REFERENCES public.machine_bindings(binding_code) ON DELETE CASCADE,
    status TEXT DEFAULT 'online',
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. DEVICE ASSIGNMENTS TABLE (Admin -> Worker assignments with auto-generated passwords)
CREATE TABLE IF NOT EXISTS public.device_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    assigned_to_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    assigned_by_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    access_password TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(device_id, assigned_to_user_id)
);

-- ── AUTOMATIC PROFILE CREATION & SEED ADMIN ASSIGNMENT TRIGGER ────────────────
-- Automatically creates a profile record when a user signs up.
-- If the email is sammyseth260@gmail.com, automatically assigns role = 'seed_admin'!

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role)
  VALUES (
    NEW.id,
    NEW.email,
    CASE 
      WHEN LOWER(NEW.email) = 'sammyseth260@gmail.com' THEN 'seed_admin'
      ELSE 'worker'
    END
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Re-create trigger for auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── AUTO-CLEAR DEVICE ASSIGNMENTS WHEN USER IS BLOCKED ───────────────────────
-- When is_blocked is set to TRUE, automatically delete all device_assignments
-- for that user so the devices are freed up for reassignment.

CREATE OR REPLACE FUNCTION public.handle_user_blocked()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act when is_blocked changed from FALSE/NULL to TRUE
  IF NEW.is_blocked = TRUE AND (OLD.is_blocked IS DISTINCT FROM TRUE) THEN
    DELETE FROM public.device_assignments
    WHERE assigned_to_user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_user_blocked ON public.profiles;
CREATE TRIGGER on_user_blocked
  AFTER UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_blocked();

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.machine_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_assignments ENABLE ROW LEVEL SECURITY;

-- Permissive policies for web application operation
CREATE POLICY "Allow public read profiles" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Allow authenticated update profiles" ON public.profiles FOR ALL USING (true);

CREATE POLICY "Allow public read machine_bindings" ON public.machine_bindings FOR SELECT USING (true);
CREATE POLICY "Allow all write machine_bindings" ON public.machine_bindings FOR ALL USING (true);

CREATE POLICY "Allow public read devices" ON public.devices FOR SELECT USING (true);
CREATE POLICY "Allow all write devices" ON public.devices FOR ALL USING (true);

CREATE POLICY "Allow public read device_assignments" ON public.device_assignments FOR SELECT USING (true);
CREATE POLICY "Allow all write device_assignments" ON public.device_assignments FOR ALL USING (true);

-- Enable Realtime broadcasting on devices and machine_bindings tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.machine_bindings;
ALTER PUBLICATION supabase_realtime ADD TABLE public.device_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
