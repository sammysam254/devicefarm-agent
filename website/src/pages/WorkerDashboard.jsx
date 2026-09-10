import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Smartphone, Play, ExternalLink, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';
import SEO from '../components/SEO';

export default function WorkerDashboard() {
  const { profile } = useAuth();
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadData = async (isInitial = false) => {
    if (!profile) return;
    if (isInitial) setLoading(true);
    try {
      const { data } = await supabase
        .from('device_assignments')
        .select('*, devices(*)')
        .eq('assigned_to_user_id', profile.id);

      const activeAssignments = (data || []).filter(a => {
        if (!a.devices) return false;
        if (a.devices.is_deleted_from_view) return false;
        return true;
      });
      setAssignments(activeAssignments);
    } catch (e) {
      console.error('Error loading worker assignments:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    if (!profile) return;
    loadData(true);

    const channel = supabase
      .channel(`worker-realtime-${profile.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'device_assignments',
        filter: `assigned_to_user_id=eq.${profile.id}`,
      }, () => loadData(false))
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'devices',
      }, () => loadData(false))
      .subscribe();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData(false);
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(timer);
    };
  }, [profile]);

  const handleOpenDevice = (assignment) => {
    const streamUrl = assignment.devices?.stream_url;
    if (!streamUrl) return;
    const w = 510, h = 900;
    const left = Math.max(0, Math.round((window.screen.width - w) / 2));
    const top = Math.max(0, Math.round((window.screen.height - h) / 2));
    window.open(streamUrl, `Stream_${assignment.devices?.serial || 'Device'}`, `width=${w},height=${h},top=${top},left=${left},resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no,popup=yes`);
  };

  const isDeviceOnline = (d) => {
    if (!d || d.is_deleted_from_view) return false;
    if (d.status === 'online' || Boolean(d.stream_url)) return true;
    return false;
  };

  return (
    <DashboardLayout>
      <SEO
        title="Worker Control Dashboard — FlexPulse Cloud"
        description="Assigned devices control center."
        noIndex={true}
      />
      <main aria-labelledby="worker-devices-heading">
        <header style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Smartphone size={24} color="var(--primary)" />
              <h1 id="worker-devices-heading" style={{ fontSize: '22px', fontWeight: 800 }}>My Assigned Devices</h1>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
              Devices assigned to you. Click to open and control your live device stream instantly without PIN.
            </p>
          </div>
          <button onClick={() => loadData(true)} className="btn btn-secondary" aria-label="Refresh">
            <RefreshCw size={16} /> Refresh
          </button>
        </header>

        {loading ? (
          <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <RefreshCw size={24} className="spin" style={{ marginBottom: '12px' }} />
            <p>Loading assigned devices...</p>
          </div>
        ) : assignments.length === 0 ? (
          <div className="card" style={{ padding: '60px 24px', textAlign: 'center' }}>
            <Smartphone size={40} color="var(--text-dim)" style={{ marginBottom: '16px' }} />
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px' }}>No Devices Assigned</h3>
            <p style={{ color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto 20px', fontSize: '14px' }}>
              You do not have any devices assigned to your account yet. Contact your administrator to get access.
            </p>
            <button onClick={() => loadData(true)} className="btn btn-secondary">
              Check Again
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' }}>
            {assignments.map(a => {
              const online = isDeviceOnline(a.devices);
              const isBlocked = a.devices?.is_stream_blocked === true || a.devices?.status === 'blocked';

              return (
                <div
                  key={a.id}
                  className="card"
                  style={{
                    padding: '20px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    border: isBlocked
                      ? '1px solid rgba(239, 68, 68, 0.4)'
                      : online
                        ? '1px solid rgba(34, 197, 94, 0.3)'
                        : '1px solid var(--border)',
                    background: isBlocked ? 'rgba(239, 68, 68, 0.03)' : undefined,
                  }}
                >
                  <div>
                    {/* Header: Brand & Status */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                      <div>
                        <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--primary)', letterSpacing: '0.5px' }}>
                          {a.devices?.brand || 'Android'}
                        </span>
                        <h3 style={{ fontSize: '18px', fontWeight: 800, marginTop: '2px' }}>
                          {a.devices?.model || 'Device'}
                        </h3>
                      </div>
                      <span className={`badge ${isBlocked ? 'badge-danger' : online ? 'badge-success' : 'badge-secondary'}`}>
                        <span className="badge-dot"></span>
                        {isBlocked ? 'Blocked by Admin' : online ? 'Ready to Stream' : 'Offline'}
                      </span>
                    </div>

                    {/* Serial / ID */}
                    <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '16px', fontFamily: 'monospace' }}>
                      UDID: {a.devices?.serial || 'Unknown'}
                    </div>

                    {/* Access Mode Indicator */}
                    <div style={{
                      background: isBlocked ? 'rgba(239,68,68,0.06)' : 'rgba(56,189,248,0.06)',
                      border: isBlocked ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(56,189,248,0.15)',
                      borderRadius: '10px',
                      padding: '10px 14px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      marginBottom: '14px',
                      flexWrap: 'wrap',
                      gap: '8px',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <CheckCircle size={16} color={isBlocked ? 'var(--danger)' : 'var(--primary)'} />
                        <span style={{ fontSize: '13px', fontWeight: 600, color: isBlocked ? '#f87171' : 'var(--text-light)' }}>
                          {isBlocked ? 'Stream Suspended' : 'Direct Assigned Access'}
                        </span>
                      </div>
                      <span style={{ fontSize: '11px', color: isBlocked ? '#f87171' : 'var(--text-muted)', fontFamily: 'monospace' }}>
                        {isBlocked ? 'ACCESS PAUSED' : 'NO PIN NEEDED'}
                      </span>
                    </div>

                    {/* Stream URL info */}
                    {a.devices?.stream_url ? (
                      <div style={{
                        fontSize: '11px', fontFamily: 'monospace',
                        color: 'var(--text-muted)', wordBreak: 'break-all',
                        marginBottom: '14px', lineHeight: 1.5,
                      }}>
                        {a.devices.stream_url.substring(0, 55)}...
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px', color: 'var(--text-dim)', fontSize: '12px' }}>
                        <AlertCircle size={14} /> Device offline — stream link not yet available
                      </div>
                    )}

                    {/* Open Button */}
                    <button
                      disabled={!online || isBlocked}
                      onClick={() => handleOpenDevice(a)}
                      className="btn btn-primary"
                      style={{
                        width: '100%',
                        justifyContent: 'center',
                        opacity: (!online || isBlocked) ? 0.5 : 1,
                        background: isBlocked ? '#dc2626' : undefined,
                        cursor: (!online || isBlocked) ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <Play size={16} />
                      {isBlocked ? 'Stream Blocked by Admin' : online ? 'Open Device Stream' : 'Device Offline'}
                      {online && !isBlocked && <ExternalLink size={14} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </DashboardLayout>
  );
}
