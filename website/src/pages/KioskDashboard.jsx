import React, { useState, useEffect, useMemo } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
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

const PRESET_SURVEY_APPS = [
  { name: 'AttaPoll', pkg: 'com.attapoll.app', category: 'Surveys' },
  { name: 'Freecash', pkg: 'com.freecash.app2', category: 'Earning' },
  { name: 'Swagbucks', pkg: 'com.prodege.swagbucksmobile', category: 'Rewards' },
  { name: 'Eureka Surveys', pkg: 'com.eureka.surveys', category: 'Surveys' },
  { name: 'Pawns.app', pkg: 'com.iproyal.pawns', category: 'Bandwidth & Surveys' },
  { name: 'Qmee', pkg: 'com.qmee.mobile', category: 'Surveys' },
  { name: 'Prime Opinion', pkg: 'com.primeopinion.appname', category: 'Surveys' },
  { name: 'TapResearch Rewards', pkg: 'com.tapresearch.taprewards', category: 'Surveys' },
  { name: 'HeyCash', pkg: 'com.heycash.surveys.earn.money', category: 'Surveys & Cash' },
  { name: 'TopSurveys', pkg: 'topsurveys.paid.survey.money.cash', category: 'Paid Surveys' },
  { name: 'AirPerks', pkg: 'app.airperks', category: 'Rewards' },
];

export default function KioskDashboard() {
  const { profile } = useAuth();
  const role = profile?.role || 'admin';

  // Device & App states
  const [devices, setDevices] = useState([]);
  const [selectedSerial, setSelectedSerial] = useState('');
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deviceApps, setDeviceApps] = useState([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [selectedPackages, setSelectedPackages] = useState(new Set());
  const [searchFilter, setSearchFilter] = useState('');

  // Remote Play Store installer state
  const [playStorePkg, setPlayStorePkg] = useState('');
  const [installingPlayStore, setInstallingPlayStore] = useState(false);

  // Enforcement action state
  const [enforcingLockdown, setEnforcingLockdown] = useState(false);
  const [enforcingUnlock, setEnforcingUnlock] = useState(false);

  // Toast alert state
  const [toast, setToast] = useState(null);

  const showToast = (type, title, message) => {
    setToast({ type, title, message });
    setTimeout(() => {
      setToast(null);
    }, 6000);
  };

  /**
   * Universal API caller:
   * Prioritizes direct high-performance Cloudflare Tunnel (agent.dennoh.site)
   * Seamlessly falls back to Netlify Serverless Proxy and local daemon.
   */
  const callAdbApi = async (endpoint, method = 'GET', body = null) => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token || '';

    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    };

    const targetUrls = [
      `https://agent.dennoh.site/api${endpoint}`,
      `/.netlify/functions/adb?path=${encodeURIComponent(endpoint)}`,
      `http://localhost:9001/api${endpoint}`,
      `http://localhost:7400/api${endpoint}`,
    ];

    let lastError = null;

    for (const baseUrl of targetUrls) {
      try {
        const res = await fetch(baseUrl, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

        if (res.ok) {
          return await res.json();
        }
        const errData = await res.json().catch(() => ({}));
        if (errData && errData.message) {
          lastError = new Error(errData.message);
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Unable to reach Farm ADB daemon via direct tunnel or serverless proxy.');
  };

  // 1. Fetch Fleet Devices
  const fetchDevices = async () => {
    setLoadingDevices(true);
    try {
      const data = await callAdbApi('/devices');
      const devList = data.devices || [];
      setDevices(devList);

      const params = new URLSearchParams(window.location.search);
      const querySerial = params.get('serial');
      if (querySerial) {
        setSelectedSerial(querySerial);
      } else if (devList.length > 0 && !selectedSerial) {
        setSelectedSerial(devList[0].serial);
      }
      showToast('success', 'Fleet Synced', `Found ${devList.length} farm devices online`);
    } catch (err) {
      showToast('error', 'Fleet Scan Failed', err.message);
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const querySerial = params.get('serial');
    if (querySerial) {
      setSelectedSerial(querySerial);
    }
    fetchDevices();
  }, []);

  // 2. Fetch Apps for Selected Device
  const fetchDeviceApps = async (serial, preserveSelection = false) => {
    if (!serial) return;
    setLoadingApps(true);
    try {
      const data = await callAdbApi(`/devices/${encodeURIComponent(serial)}/apps`);
      const pkgs = data.packages || [];
      setDeviceApps(pkgs);

      // Only recompute selection if not explicitly told to preserve the user's choices
      if (!preserveSelection) {
        const enabledPkgs = pkgs.filter(p => p.isEnabled).map(p => p.packageName);
        const presetPkgSet = new Set(PRESET_SURVEY_APPS.map(p => p.pkg));
        const detectedPresets = pkgs
          .filter(p => presetPkgSet.has(p.packageName))
          .map(p => p.packageName);

        // If the device is currently locked down with a specific subset enabled, reflect that state
        if (enabledPkgs.length > 0 && enabledPkgs.length < pkgs.length && enabledPkgs.length <= 15) {
          setSelectedPackages(new Set(enabledPkgs));
        } else if (detectedPresets.length > 0) {
          setSelectedPackages(new Set(detectedPresets));
        } else if (enabledPkgs.length > 0 && enabledPkgs.length <= 5) {
          setSelectedPackages(new Set(enabledPkgs));
        } else {
          setSelectedPackages(new Set());
        }
      }
    } catch (err) {
      showToast('error', 'Package Scan Error', err.message);
    } finally {
      setLoadingApps(false);
    }
  };

  useEffect(() => {
    if (selectedSerial) {
      fetchDeviceApps(selectedSerial);
    } else {
      setDeviceApps([]);
      setSelectedPackages(new Set());
    }
  }, [selectedSerial]);

  // App Selection Handlers
  const togglePackage = (pkgName) => {
    setSelectedPackages(prev => {
      const next = new Set(prev);
      if (next.has(pkgName)) {
        next.delete(pkgName);
      } else {
        next.add(pkgName);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    const all = new Set(deviceApps.map(p => p.packageName));
    setSelectedPackages(all);
  };

  const handleDeselectAll = () => {
    setSelectedPackages(new Set());
  };

  const handleSelectPresetsOnly = () => {
    const presetPkgSet = new Set(PRESET_SURVEY_APPS.map(p => p.pkg));
    const matched = new Set(
      deviceApps
        .filter(p => presetPkgSet.has(p.packageName))
        .map(p => p.packageName)
    );
    setSelectedPackages(matched);
    showToast('info', 'Presets Selected', `Selected ${matched.size} detected survey/earning applications`);
  };

  // Filtered App List
  const filteredApps = useMemo(() => {
    if (!searchFilter.trim()) return deviceApps;
    const q = searchFilter.toLowerCase();
    return deviceApps.filter(p => p.packageName.toLowerCase().includes(q));
  }, [deviceApps, searchFilter]);

  // Section 1: Play Store Installation Action
  const handleLaunchPlayStore = async (targetPkg) => {
    const pkgToInstall = (targetPkg || playStorePkg).trim();
    if (!pkgToInstall) {
      showToast('warning', 'Missing Input', 'Please enter a valid Android package ID');
      return;
    }
    if (!selectedSerial) {
      showToast('warning', 'No Device Selected', 'Please select a target farm device first');
      return;
    }

    setInstallingPlayStore(true);
    try {
      const res = await callAdbApi(
        `/devices/${encodeURIComponent(selectedSerial)}/install-playstore`,
        'POST',
        { packageName: pkgToInstall }
      );
      showToast('success', 'Play Store Launched', res.message || `Listing opened for ${pkgToInstall}`);
      setPlayStorePkg('');
    } catch (err) {
      showToast('error', 'Store Launch Failed', err.message);
    } finally {
      setInstallingPlayStore(false);
    }
  };

  // Section 3: Lockdown & Branding Action
  const handleApplyLockdown = async () => {
    if (!selectedSerial) {
      showToast('warning', 'No Device Selected', 'Please choose a connected device');
      return;
    }

    const allowed = Array.from(selectedPackages);
    if (allowed.length === 0) {
      if (!window.confirm('No third-party apps are selected. This will freeze ALL non-system apps on the device. Continue?')) {
        return;
      }
    }

    setEnforcingLockdown(true);
    try {
      const res = await callAdbApi(
        `/devices/${encodeURIComponent(selectedSerial)}/lockdown`,
        'POST',
        { allowedPackages: allowed }
      );

      showToast(
        'success',
        'FlexPulse Lockdown Active',
        `Success: ${res.enabledCount} apps allowed, ${res.lockedCount} frozen. Branded wallpaper applied!`
      );
      // Refresh app states with preserveSelection = true so user checkmarks STAY CHECKED!
      await fetchDeviceApps(selectedSerial, true);
    } catch (err) {
      showToast('error', 'Lockdown Failed', err.message);
    } finally {
      setEnforcingLockdown(false);
    }
  };

  // Section 3: Restore / Unlock Action
  const handleUnlockDevice = async () => {
    if (!selectedSerial) return;
    if (!window.confirm('Restore all frozen third-party packages back to normal mode?')) return;

    setEnforcingUnlock(true);
    try {
      const res = await callAdbApi(
        `/devices/${encodeURIComponent(selectedSerial)}/unlock`,
        'POST'
      );
      showToast('success', 'Device Unlocked', res.message || `Re-enabled ${res.unlockedCount} packages`);
      await fetchDeviceApps(selectedSerial, false);
    } catch (err) {
      showToast('error', 'Unlock Failed', err.message);
    } finally {
      setEnforcingUnlock(false);
    }
  };

  const selectedDeviceObj = devices.find(d => d.serial === selectedSerial);

  return (
    <DashboardLayout>
      {/* Light Blue Custom Theme Container */}
      <div style={{
        color: '#f8fafc',
        fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
      }}>
        {/* Toast Notification Alert */}
        {toast && (
          <div style={{
            position: 'fixed',
            top: '80px',
            right: '24px',
            zIndex: 9999,
            minWidth: '320px',
            maxWidth: '460px',
            padding: '16px 20px',
            borderRadius: '14px',
            background: toast.type === 'error'
              ? 'rgba(15, 23, 42, 0.96)'
              : toast.type === 'success'
              ? 'rgba(15, 23, 42, 0.96)'
              : 'rgba(15, 23, 42, 0.96)',
            border: `1px solid ${
              toast.type === 'error' ? '#ef4444' : toast.type === 'success' ? '#0284c7' : '#38bdf8'
            }`,
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6), 0 0 25px rgba(56, 189, 248, 0.2)',
            backdropFilter: 'blur(12px)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '14px',
            animation: 'fadeIn 0.3s ease',
          }}>
            {toast.type === 'error' ? (
              <AlertTriangle size={22} color="#ef4444" style={{ flexShrink: 0, marginTop: '2px' }} />
            ) : (
              <CheckCircle2 size={22} color="#38bdf8" style={{ flexShrink: 0, marginTop: '2px' }} />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '14px', color: '#f8fafc' }}>{toast.title}</div>
              <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '4px', lineHeight: 1.4 }}>
                {toast.message}
              </div>
            </div>
          </div>
        )}

        {/* ── Header Section ────────────────────────────────────────────── */}
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '18px',
          marginBottom: '28px',
          paddingBottom: '20px',
          borderBottom: '1px solid rgba(56, 189, 248, 0.15)',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
              <div style={{
                background: 'linear-gradient(135deg, #0284c7, #38bdf8)',
                padding: '10px',
                borderRadius: '12px',
                display: 'flex',
                boxShadow: '0 0 20px rgba(56, 189, 248, 0.35)',
              }}>
                <ShieldCheck size={26} color="#ffffff" />
              </div>
              <div>
                <h1 style={{
                  fontSize: '24px',
                  fontWeight: 800,
                  letterSpacing: '-0.5px',
                  margin: 0,
                  background: 'linear-gradient(135deg, #ffffff 30%, #38bdf8 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}>
                  FlexPulse Fleet Kiosk
                </h1>
                <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#94a3b8' }}>
                  Multi-App Lockdown & Physical System Branding Manager
                </p>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              background: 'rgba(2, 132, 199, 0.15)',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              borderRadius: '20px',
              padding: '6px 14px',
              fontSize: '12px',
              fontWeight: 700,
              color: '#38bdf8',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8', display: 'inline-block' }} />
              Role: {role.toUpperCase()}
            </div>

            <button
              onClick={fetchDevices}
              disabled={loadingDevices}
              style={{
                background: 'rgba(15, 23, 42, 0.8)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                color: '#38bdf8',
                borderRadius: '10px',
                padding: '9px 16px',
                fontSize: '13px',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              <RefreshCw size={15} className={loadingDevices ? 'spin' : ''} />
              {loadingDevices ? 'Scanning...' : 'Scan Fleet'}
            </button>
          </div>
        </div>

        {/* ── Device Selector Strip ─────────────────────────────────────── */}
        <div style={{
          background: 'rgba(15, 23, 42, 0.7)',
          border: '1px solid rgba(56, 189, 248, 0.25)',
          borderRadius: '16px',
          padding: '18px 22px',
          marginBottom: '24px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          boxShadow: '0 8px 30px rgba(0, 0, 0, 0.3)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flex: 1, minWidth: '260px' }}>
            <Smartphone size={22} color="#38bdf8" />
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#94a3b8', fontWeight: 700, marginBottom: '4px' }}>
                Active Target Device
              </label>
              <select
                value={selectedSerial}
                onChange={(e) => setSelectedSerial(e.target.value)}
                style={{
                  width: '100%',
                  background: '#060913',
                  color: '#f8fafc',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  borderRadius: '10px',
                  padding: '9px 14px',
                  fontSize: '14px',
                  fontWeight: 600,
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                {devices.length === 0 ? (
                  <option value="">No online devices found</option>
                ) : (
                  devices.map(d => (
                    <option key={d.serial} value={d.serial}>
                      {d.model || 'Android Device'} — {d.serial} (Port: {d.port || 'USB'})
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          {selectedDeviceObj && (
            <div style={{
              display: 'flex',
              gap: '20px',
              padding: '8px 18px',
              background: 'rgba(2, 132, 199, 0.08)',
              borderRadius: '12px',
              border: '1px solid rgba(56, 189, 248, 0.15)',
            }}>
              <div>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>Hardware Model</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#f8fafc' }}>{selectedDeviceObj.model || 'Generic'}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>Stream Daemon</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Radio size={12} /> Active :{selectedDeviceObj.port || 8000}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>Kiosk Mode</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#38bdf8' }}>
                  {deviceApps.filter(p => !p.isEnabled).length > 0 ? 'Locked Down' : 'Unrestricted'}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Main 2-Column Grid Layout ─────────────────────────────────── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: '24px',
          alignItems: 'start',
        }}>

          {/* LEFT COLUMN: Section 1 (Play Store) & Section 3 (Mode Enforcement) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

            {/* SECTION 1: Official Google Play Store Remote Installer */}
            <div style={{
              background: 'rgba(15, 23, 42, 0.7)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              borderRadius: '16px',
              padding: '24px',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.3)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                <div style={{ background: 'rgba(56, 189, 248, 0.15)', padding: '8px', borderRadius: '10px' }}>
                  <Play size={18} color="#38bdf8" />
                </div>
                <div>
                  <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                    Google Play Store Remote Installer
                  </h2>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#94a3b8' }}>
                    Remotely triggers official Google Play listings via ADB (zero sideload flags)
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <input
                  type="text"
                  placeholder="Target package ID (e.g. com.attapoll.app)"
                  value={playStorePkg}
                  onChange={(e) => setPlayStorePkg(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLaunchPlayStore()}
                  style={{
                    flex: 1,
                    background: '#060913',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    color: '#f8fafc',
                    fontSize: '13px',
                    outline: 'none',
                  }}
                />
                <button
                  onClick={() => handleLaunchPlayStore()}
                  disabled={installingPlayStore || !playStorePkg.trim()}
                  style={{
                    background: 'linear-gradient(135deg, #0284c7, #38bdf8)',
                    border: 'none',
                    borderRadius: '10px',
                    padding: '10px 18px',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: '13px',
                    cursor: installingPlayStore || !playStorePkg.trim() ? 'not-allowed' : 'pointer',
                    opacity: installingPlayStore || !playStorePkg.trim() ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {installingPlayStore ? <RefreshCw size={14} className="spin" /> : <ExternalLink size={14} />}
                  Launch on Device
                </button>
              </div>

              {/* Quick Preset Chips */}
              <div>
                <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#94a3b8', fontWeight: 700, marginBottom: '8px' }}>
                  Quick Launch Presets
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {PRESET_SURVEY_APPS.map(preset => (
                    <button
                      key={preset.pkg}
                      onClick={() => handleLaunchPlayStore(preset.pkg)}
                      style={{
                        background: 'rgba(2, 132, 199, 0.1)',
                        border: '1px solid rgba(56, 189, 248, 0.25)',
                        color: '#e0f2fe',
                        padding: '6px 12px',
                        borderRadius: '8px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'all 0.2s',
                      }}
                      title={`Launch ${preset.pkg}`}
                    >
                      <Sparkles size={12} color="#38bdf8" />
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* SECTION 3: Mode Enforcement & Physical Branding */}
            <div style={{
              background: 'rgba(15, 23, 42, 0.7)',
              border: '1px solid rgba(56, 189, 248, 0.25)',
              borderRadius: '16px',
              padding: '24px',
              boxShadow: '0 8px 30px rgba(0, 0, 0, 0.3)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                <div style={{ background: 'rgba(56, 189, 248, 0.15)', padding: '8px', borderRadius: '10px' }}>
                  <Lock size={18} color="#38bdf8" />
                </div>
                <div>
                  <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                    Kiosk Lockdown & Physical Branding
                  </h2>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#94a3b8' }}>
                    Enforce Multi-App restrictions and inject custom FlexPulse System wallpaper
                  </p>
                </div>
              </div>

              {/* Status summary box */}
              <div style={{
                background: 'rgba(2, 132, 199, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: '12px',
                padding: '14px',
                marginBottom: '20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <div>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>Allowed Apps To Permit</div>
                  <div style={{ fontSize: '20px', fontWeight: 800, color: '#38bdf8' }}>
                    {selectedPackages.size} <span style={{ fontSize: '12px', fontWeight: 500, color: '#cbd5e1' }}>of {deviceApps.length} total</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>Physical Branding</div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
                    <Sparkles size={14} /> FlexPulse 1080x2400
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <button
                  onClick={handleApplyLockdown}
                  disabled={enforcingLockdown || !selectedSerial}
                  style={{
                    background: 'linear-gradient(135deg, #0284c7, #38bdf8)',
                    border: 'none',
                    borderRadius: '12px',
                    padding: '14px',
                    color: '#ffffff',
                    fontWeight: 700,
                    fontSize: '14px',
                    cursor: enforcingLockdown || !selectedSerial ? 'not-allowed' : 'pointer',
                    boxShadow: '0 4px 15px rgba(2, 132, 199, 0.4)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '10px',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {enforcingLockdown ? <RefreshCw size={18} className="spin" /> : <Lock size={18} />}
                  {enforcingLockdown ? 'Applying FlexPulse Mode...' : 'Apply FlexPulse Lockdown & Wallpaper'}
                </button>

                <button
                  onClick={handleUnlockDevice}
                  disabled={enforcingUnlock || !selectedSerial}
                  style={{
                    background: 'rgba(15, 23, 42, 0.8)',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    borderRadius: '12px',
                    padding: '12px',
                    color: '#94a3b8',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: enforcingUnlock || !selectedSerial ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {enforcingUnlock ? <RefreshCw size={16} className="spin" /> : <Unlock size={16} />}
                  {enforcingUnlock ? 'Restoring Apps...' : 'Unlock All Apps (Normal Mode)'}
                </button>
              </div>
            </div>

          </div>

          {/* RIGHT COLUMN: Section 2 (Allowed App Selection) */}
          <div style={{
            background: 'rgba(15, 23, 42, 0.7)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: '16px',
            padding: '24px',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.3)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ background: 'rgba(56, 189, 248, 0.15)', padding: '8px', borderRadius: '10px' }}>
                  <Layers size={18} color="#38bdf8" />
                </div>
                <div>
                  <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                    Allowed App Selection (Multi-App Mode)
                  </h2>
                  <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#94a3b8' }}>
                    Select apps permitted to run. Non-selected apps are frozen.
                  </p>
                </div>
              </div>

              {/* Real-time selection badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  background: '#0284c7',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: '11px',
                  padding: '4px 10px',
                  borderRadius: '12px',
                }}>
                  {selectedPackages.size} Dedicated Allowed
                </span>
                <span style={{
                  background: 'rgba(239, 68, 68, 0.2)',
                  color: '#f87171',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  fontWeight: 700,
                  fontSize: '11px',
                  padding: '4px 10px',
                  borderRadius: '12px',
                }}>
                  {Math.max(0, deviceApps.length - selectedPackages.size)} Frozen & Hidden
                </span>
              </div>
            </div>

            {/* Strict Lockdown Rule Warning Banner */}
            <div style={{
              background: 'rgba(239, 68, 68, 0.08)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              borderRadius: '10px',
              padding: '10px 14px',
              marginBottom: '14px',
              fontSize: '12px',
              lineHeight: '1.5',
              color: '#cbd5e1',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}>
              <AlertTriangle size={18} color="#f87171" style={{ flexShrink: 0 }} />
              <div>
                <strong style={{ color: '#f87171' }}>Strict Multi-App Isolation:</strong> Only checked apps below will be usable. All unselected apps (TikTok, Facebook, games, etc.) will be completely frozen, hidden from the launcher, and untapable. On lockdown, the screen will switch directly to your dedicated apps.
              </div>
            </div>

            {/* Filter Search Bar & Convenience Buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
              <div style={{ position: 'relative' }}>
                <Search size={15} color="#94a3b8" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                <input
                  type="text"
                  placeholder="Filter packages by name or ID..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  style={{
                    width: '100%',
                    background: '#060913',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    borderRadius: '10px',
                    padding: '9px 12px 9px 36px',
                    color: '#f8fafc',
                    fontSize: '13px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  onClick={handleSelectPresetsOnly}
                  style={{
                    background: 'linear-gradient(135deg, #0284c7, #38bdf8)',
                    border: 'none',
                    color: '#ffffff',
                    padding: '7px 14px',
                    borderRadius: '8px',
                    fontSize: '12px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    boxShadow: '0 2px 10px rgba(2, 132, 199, 0.3)',
                  }}
                >
                  <Sparkles size={13} color="#ffffff" /> Select Survey Presets Only
                </button>
                <button
                  onClick={handleDeselectAll}
                  style={{
                    background: 'rgba(148, 163, 184, 0.1)',
                    border: '1px solid rgba(148, 163, 184, 0.25)',
                    color: '#94a3b8',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <Square size={13} /> Deselect All (Freeze All)
                </button>
                <button
                  onClick={handleSelectAll}
                  style={{
                    background: 'rgba(56, 189, 248, 0.1)',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    color: '#38bdf8',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    fontSize: '12px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <CheckSquare size={13} /> Select All
                </button>
              </div>
            </div>

            {/* App Packages List */}
            <div style={{
              maxHeight: '440px',
              overflowY: 'auto',
              border: '1px solid rgba(56, 189, 248, 0.15)',
              borderRadius: '12px',
              background: '#060913',
              padding: '6px',
            }}>
              {loadingApps ? (
                <div style={{ padding: '36px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                  <RefreshCw size={22} className="spin" style={{ margin: '0 auto 10px', color: '#38bdf8' }} />
                  Scanning installed packages via ADB...
                </div>
              ) : filteredApps.length === 0 ? (
                <div style={{ padding: '36px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
                  No third-party packages matching filter.
                </div>
              ) : (
                filteredApps.map(pkg => {
                  const isSelected = selectedPackages.has(pkg.packageName);
                  const isPreset = PRESET_SURVEY_APPS.some(p => p.pkg === pkg.packageName);
                  const isSocialOrDistraction = /facebook|katana|musically|tiktok|instagram|whatsapp|temu|solitaire|mahjong|candycrush|game|shopping|netflix/i.test(pkg.packageName);

                  return (
                    <div
                      key={pkg.packageName}
                      onClick={() => togglePackage(pkg.packageName)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 14px',
                        borderRadius: '8px',
                        marginBottom: '4px',
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(2, 132, 199, 0.15)' : 'transparent',
                        border: isSelected ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid transparent',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}} // Handled by div onClick
                          style={{
                            width: '16px',
                            height: '16px',
                            accentColor: '#0284c7',
                            cursor: 'pointer',
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{
                            fontSize: '13px',
                            fontWeight: 600,
                            color: isSelected ? '#ffffff' : '#cbd5e1',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {pkg.packageName}
                          </div>
                          {isPreset && (
                            <span style={{
                              fontSize: '10px',
                              color: '#38bdf8',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.5px',
                            }}>
                              ⭐ Certified Survey App
                            </span>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        {isSocialOrDistraction && !isSelected && (
                          <span style={{
                            fontSize: '10px',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            fontWeight: 700,
                            background: 'rgba(239, 68, 68, 0.2)',
                            color: '#fca5a5',
                            border: '1px solid rgba(239, 68, 68, 0.4)',
                          }}>
                            🚫 Non-Dedicated
                          </span>
                        )}
                        <span style={{
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '6px',
                          fontWeight: 700,
                          background: isSelected ? 'rgba(56, 189, 248, 0.2)' : 'rgba(239, 68, 68, 0.15)',
                          color: isSelected ? '#38bdf8' : '#f87171',
                          border: `1px solid ${isSelected ? 'rgba(56, 189, 248, 0.4)' : 'rgba(239, 68, 68, 0.3)'}`,
                        }}>
                          {isSelected ? 'Allowed Dedicated App' : 'Will Freeze & Hide'}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

          </div>

        </div>
      </div>
    </DashboardLayout>
  );
}
