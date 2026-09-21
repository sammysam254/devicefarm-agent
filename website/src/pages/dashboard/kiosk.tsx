import React, { useState, useEffect, useMemo } from 'react';
import Head from 'next/head';
import {
  ShieldCheck,
  Lock,
  Unlock,
  RefreshCw,
  Smartphone,
  Search,
  CheckSquare,
  Square,
  Play,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Layers,
  ExternalLink,
  Radio
} from 'lucide-react';

interface DeviceSummary {
  serial: string;
  model?: string;
  port?: number;
  isWifi?: boolean;
}

interface AppPackage {
  packageName: string;
  isEnabled: boolean;
  isEssential: boolean;
}

interface ToastNotice {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
}

const PRESET_SURVEY_APPS = [
  { name: 'AttaPoll', pkg: 'com.attapoll.app', category: 'Surveys' },
  { name: 'Freecash', pkg: 'com.freecash.app2', category: 'Earning' },
  { name: 'Swagbucks', pkg: 'com.prodege.swagbucksmobile', category: 'Rewards' },
  { name: 'Eureka Surveys', pkg: 'com.eureka.surveys', category: 'Surveys' },
  { name: 'Pawns.app', pkg: 'com.iproyal.pawns', category: 'Bandwidth & Surveys' },
  { name: 'Qmee', pkg: 'com.qmee.mobile', category: 'Surveys' },
];

export default function NextKioskDashboard() {
  const role = 'admin'; // Or via user session context

  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [selectedSerial, setSelectedSerial] = useState<string>('');
  const [loadingDevices, setLoadingDevices] = useState<boolean>(false);
  const [deviceApps, setDeviceApps] = useState<AppPackage[]>([]);
  const [loadingApps, setLoadingApps] = useState<boolean>(false);
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [searchFilter, setSearchFilter] = useState<string>('');

  const [playStorePkg, setPlayStorePkg] = useState<string>('');
  const [installingPlayStore, setInstallingPlayStore] = useState<boolean>(false);

  const [enforcingLockdown, setEnforcingLockdown] = useState<boolean>(false);
  const [enforcingUnlock, setEnforcingUnlock] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastNotice | null>(null);

  const showToast = (type: ToastNotice['type'], title: string, message: string) => {
    setToast({ type, title, message });
    setTimeout(() => setToast(null), 6000);
  };

  const callAdbApi = async (endpoint: string, method = 'GET', body: any = null) => {
    const urls = [
      `https://agent.dennoh.site/api${endpoint}`,
      `/.netlify/functions/adb?path=${encodeURIComponent(endpoint)}`,
      `http://localhost:9001/api${endpoint}`,
      `http://localhost:7400/api${endpoint}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (res.ok) return await res.json();
      } catch (_) {}
    }
    throw new Error('Unable to connect to Farm ADB host via proxy or tunnel.');
  };

  const fetchDevices = async () => {
    setLoadingDevices(true);
    try {
      const data = await callAdbApi('/devices');
      const list = data.devices || [];
      setDevices(list);
      if (list.length > 0 && !selectedSerial) {
        setSelectedSerial(list[0].serial);
      }
      showToast('success', 'Fleet Synced', `Found ${list.length} farm devices online`);
    } catch (err: any) {
      showToast('error', 'Fleet Scan Failed', err.message);
    } finally {
      setLoadingDevices(false);
    }
  };

  const fetchDeviceApps = async (serial: string) => {
    if (!serial) return;
    setLoadingApps(true);
    try {
      const data = await callAdbApi(`/devices/${encodeURIComponent(serial)}/apps`);
      const pkgs: AppPackage[] = data.packages || [];
      setDeviceApps(pkgs);
      const initiallyEnabled = new Set(pkgs.filter(p => p.isEnabled).map(p => p.packageName));
      setSelectedPackages(initiallyEnabled);
    } catch (err: any) {
      showToast('error', 'Package Query Failed', err.message);
    } finally {
      setLoadingApps(false);
    }
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  useEffect(() => {
    if (selectedSerial) {
      fetchDeviceApps(selectedSerial);
    }
  }, [selectedSerial]);

  const togglePackage = (pkg: string) => {
    setSelectedPackages(prev => {
      const next = new Set(prev);
      if (next.has(pkg)) next.delete(pkg);
      else next.add(pkg);
      return next;
    });
  };

  const filteredApps = useMemo(() => {
    if (!searchFilter.trim()) return deviceApps;
    const q = searchFilter.toLowerCase();
    return deviceApps.filter(p => p.packageName.toLowerCase().includes(q));
  }, [deviceApps, searchFilter]);

  const handleLaunchPlayStore = async (targetPkg?: string) => {
    const pkg = (targetPkg || playStorePkg).trim();
    if (!pkg || !selectedSerial) return;
    setInstallingPlayStore(true);
    try {
      const res = await callAdbApi(
        `/devices/${encodeURIComponent(selectedSerial)}/install-playstore`,
        'POST',
        { packageName: pkg }
      );
      showToast('success', 'Play Store Launched', res.message || `Listing opened for ${pkg}`);
      setPlayStorePkg('');
    } catch (err: any) {
      showToast('error', 'Store Launch Failed', err.message);
    } finally {
      setInstallingPlayStore(false);
    }
  };

  const handleApplyLockdown = async () => {
    if (!selectedSerial) return;
    setEnforcingLockdown(true);
    try {
      const res = await callAdbApi(
        `/devices/${encodeURIComponent(selectedSerial)}/lockdown`,
        'POST',
        { allowedPackages: Array.from(selectedPackages) }
      );
      showToast('success', 'FlexPulse Lockdown Active', `Enforced: ${res.enabledCount} allowed, ${res.lockedCount} frozen.`);
      await fetchDeviceApps(selectedSerial);
    } catch (err: any) {
      showToast('error', 'Lockdown Failed', err.message);
    } finally {
      setEnforcingLockdown(false);
    }
  };

  const handleUnlockDevice = async () => {
    if (!selectedSerial) return;
    setEnforcingUnlock(true);
    try {
      const res = await callAdbApi(`/devices/${encodeURIComponent(selectedSerial)}/unlock`, 'POST');
      showToast('success', 'Device Unlocked', `Restored ${res.unlockedCount} packages`);
      await fetchDeviceApps(selectedSerial);
    } catch (err: any) {
      showToast('error', 'Unlock Failed', err.message);
    } finally {
      setEnforcingUnlock(false);
    }
  };

  const selectedDeviceObj = devices.find(d => d.serial === selectedSerial);

  return (
    <div style={{ minHeight: '100vh', background: '#060913', color: '#f8fafc', padding: '24px' }}>
      <Head>
        <title>FlexPulse Fleet Kiosk & Branding</title>
        <meta name="description" content="Device Multi-App Lockdown & Custom Wallpaper Injection" />
      </Head>

      {/* Toast Alert */}
      {toast && (
        <div style={{
          position: 'fixed', top: '24px', right: '24px', zIndex: 9999,
          background: 'rgba(15, 23, 42, 0.96)', padding: '16px 20px', borderRadius: '12px',
          border: `1px solid ${toast.type === 'error' ? '#ef4444' : '#0284c7'}`,
          display: 'flex', gap: '12px', maxWidth: '420px',
        }}>
          {toast.type === 'error' ? <AlertTriangle size={20} color="#ef4444" /> : <CheckCircle2 size={20} color="#38bdf8" />}
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px' }}>{toast.title}</div>
            <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '2px' }}>{toast.message}</div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ background: 'linear-gradient(135deg, #0284c7, #38bdf8)', padding: '10px', borderRadius: '12px' }}>
            <ShieldCheck size={26} color="#fff" />
          </div>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: 800, margin: 0, color: '#f8fafc' }}>
              FlexPulse Fleet Kiosk
            </h1>
            <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>
              Multi-App Lockdown & Physical System Branding
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <div style={{ background: 'rgba(2, 132, 199, 0.15)', border: '1px solid rgba(56, 189, 248, 0.3)', padding: '6px 14px', borderRadius: '20px', fontSize: '12px', color: '#38bdf8', fontWeight: 700 }}>
            Role: {role.toUpperCase()}
          </div>
          <button
            onClick={fetchDevices}
            disabled={loadingDevices}
            style={{
              background: '#0f172a', border: '1px solid rgba(56, 189, 248, 0.3)', color: '#38bdf8',
              borderRadius: '10px', padding: '9px 16px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '8px'
            }}
          >
            <RefreshCw size={14} className={loadingDevices ? 'spin' : ''} />
            {loadingDevices ? 'Scanning...' : 'Scan Fleet'}
          </button>
        </div>
      </div>

      {/* Target Device Selector */}
      <div style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '14px', padding: '16px 20px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
          <Smartphone size={22} color="#38bdf8" />
          <div style={{ flex: 1, maxWidth: '400px' }}>
            <select
              value={selectedSerial}
              onChange={(e) => setSelectedSerial(e.target.value)}
              style={{ width: '100%', background: '#060913', color: '#fff', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: '8px', padding: '8px 12px', fontSize: '13px' }}
            >
              {devices.map(d => (
                <option key={d.serial} value={d.serial}>
                  {d.model || 'Android Device'} — {d.serial}
                </option>
              ))}
            </select>
          </div>
        </div>
        {selectedDeviceObj && (
          <div style={{ fontSize: '13px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Radio size={14} /> Active Session :{selectedDeviceObj.port || 8000}
          </div>
        )}
      </div>

      {/* Main Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
        {/* Left Side: Play Store & Lockdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Section 1: Play Store */}
          <div style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '16px', padding: '20px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 12px', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Play size={18} color="#38bdf8" /> Play Store Remote Launch
            </h2>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
              <input
                type="text"
                placeholder="Target package ID (e.g. com.attapoll.app)"
                value={playStorePkg}
                onChange={(e) => setPlayStorePkg(e.target.value)}
                style={{ flex: 1, background: '#060913', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: '8px', padding: '8px 12px', color: '#fff', fontSize: '13px' }}
              />
              <button
                onClick={() => handleLaunchPlayStore()}
                disabled={installingPlayStore}
                style={{ background: 'linear-gradient(135deg, #0284c7, #38bdf8)', border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}
              >
                Launch
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {PRESET_SURVEY_APPS.map(p => (
                <button
                  key={p.pkg}
                  onClick={() => handleLaunchPlayStore(p.pkg)}
                  style={{ background: 'rgba(2, 132, 199, 0.1)', border: '1px solid rgba(56, 189, 248, 0.25)', color: '#e0f2fe', padding: '5px 10px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer' }}
                >
                  ⭐ {p.name}
                </button>
              ))}
            </div>
          </div>

          {/* Section 3: Enforcement */}
          <div style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '16px', padding: '20px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 16px', color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Lock size={18} color="#38bdf8" /> Mode Enforcement & Branding
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={handleApplyLockdown}
                disabled={enforcingLockdown}
                style={{ background: 'linear-gradient(135deg, #0284c7, #38bdf8)', border: 'none', borderRadius: '10px', padding: '12px', color: '#fff', fontWeight: 700, fontSize: '14px', cursor: 'pointer' }}
              >
                {enforcingLockdown ? 'Applying...' : `Apply FlexPulse Mode (${selectedPackages.size} Apps)`}
              </button>
              <button
                onClick={handleUnlockDevice}
                disabled={enforcingUnlock}
                style={{ background: 'rgba(15, 23, 42, 0.8)', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: '10px', padding: '10px', color: '#94a3b8', fontSize: '13px', cursor: 'pointer' }}
              >
                {enforcingUnlock ? 'Unlocking...' : 'Unlock All Third-Party Apps'}
              </button>
            </div>
          </div>
        </div>

        {/* Right Side: Section 2 (App Selection) */}
        <div style={{ background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '16px', padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
              Allowed App Selection ({selectedPackages.size} Selected)
            </h2>
          </div>
          <input
            type="text"
            placeholder="Search packages..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            style={{ width: '100%', background: '#060913', border: '1px solid rgba(56, 189, 248, 0.25)', borderRadius: '8px', padding: '8px 12px', color: '#fff', fontSize: '13px', marginBottom: '12px', boxSizing: 'border-box' }}
          />
          <div style={{ maxHeight: '420px', overflowY: 'auto', border: '1px solid rgba(56, 189, 248, 0.15)', borderRadius: '10px', background: '#060913', padding: '6px' }}>
            {filteredApps.map(pkg => (
              <div
                key={pkg.packageName}
                onClick={() => togglePackage(pkg.packageName)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px',
                  borderRadius: '6px', cursor: 'pointer', background: selectedPackages.has(pkg.packageName) ? 'rgba(2, 132, 199, 0.15)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                  <input type="checkbox" checked={selectedPackages.has(pkg.packageName)} readOnly />
                  <span>{pkg.packageName}</span>
                </div>
                <span style={{ fontSize: '11px', color: pkg.isEnabled ? '#34d399' : '#f87171' }}>
                  {pkg.isEnabled ? 'Active' : 'Frozen'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
