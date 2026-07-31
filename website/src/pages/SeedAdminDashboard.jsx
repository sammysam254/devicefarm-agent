import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { supabase } from '../lib/supabase';
import { Shield, Key, CheckCircle, XCircle, Users, RefreshCw, Lock, Unlock } from 'lucide-react';

export default function SeedAdminDashboard() {
  const [bindings, setBindings] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: bData } = await supabase.from('machine_bindings').select('*');
      const { data: pData } = await supabase.from('profiles').select('*');
      setBindings(bData || []);
      setProfiles(pData || []);
    } catch (e) {
      console.error('Error loading seed data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const toggleLicense = async (bindingCode, currentStatus) => {
    const nextStatus = !currentStatus;
    await supabase.from('machine_bindings')
      .update({ is_licensed: nextStatus, updated_at: new Date().toISOString() })
      .eq('binding_code', bindingCode);
    loadData();
  };

  const toggleMode = async (bindingCode, currentMode) => {
    const nextMode = currentMode === 'free' ? 'licensed' : 'free';
    await supabase.from('machine_bindings')
      .update({ license_mode: nextMode, updated_at: new Date().toISOString() })
      .eq('binding_code', bindingCode);
    loadData();
  };

  const updateUserRole = async (userId, newRole) => {
    await supabase.from('profiles')
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq('id', userId);
    loadData();
  };

  return (
    <DashboardLayout>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Shield size={24} color="var(--danger)" />
            <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Seed Admin Control Center</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Owner rights (`sammyseth260@gmail.com`). Manage Super Admin licenses, binding codes, and system modes.
          </p>
        </div>
        <button onClick={loadData} className="btn btn-secondary">
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Stats Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>TOTAL MACHINES BOUND</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--primary)' }}>{bindings.length}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>ACTIVE LICENSES</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--success)' }}>
            {bindings.filter(b => b.is_licensed).length}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>FREE MODE MACHINES</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--warning)' }}>
            {bindings.filter(b => b.license_mode === 'free').length}
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>REGISTERED USERS</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--accent)' }}>{profiles.length}</div>
        </div>
      </div>

      {/* Machine Bindings & License Management */}
      <div className="card" style={{ marginBottom: '32px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Key size={18} color="var(--primary)" /> Machine Binding Codes & License Enforcement
        </h3>

        {loading ? (
          <div>Loading machine bindings...</div>
        ) : bindings.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No machine binding codes registered yet. Start the setup script on a computer to bind.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>BINDING CODE</th>
                  <th style={{ padding: '12px' }}>MACHINE NAME</th>
                  <th style={{ padding: '12px' }}>MODE</th>
                  <th style={{ padding: '12px' }}>LICENSE STATUS</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map(b => (
                  <tr key={b.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace', fontWeight: 700, fontSize: '16px', color: 'var(--primary)' }}>
                      {b.binding_code}
                    </td>
                    <td style={{ padding: '14px 12px' }}>{b.machine_name || 'Windows Machine'}</td>
                    <td style={{ padding: '14px 12px' }}>
                      <span className={`badge ${b.license_mode === 'free' ? 'badge-warning' : 'badge-info'}`}>
                        {b.license_mode.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '14px 12px' }}>
                      <span className={`badge ${b.is_licensed ? 'badge-success' : 'badge-danger'}`}>
                        {b.is_licensed ? <CheckCircle size={12} /> : <XCircle size={12} />}
                        {b.is_licensed ? 'LICENSED' : 'REVOKED'}
                      </span>
                    </td>
                    <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '8px' }}>
                        <button 
                          onClick={() => toggleMode(b.binding_code, b.license_mode)}
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '12px' }}
                        >
                          Mode: {b.license_mode === 'free' ? 'Set Licensed' : 'Set Free Mode'}
                        </button>
                        <button 
                          onClick={() => toggleLicense(b.binding_code, b.is_licensed)}
                          className={`btn ${b.is_licensed ? 'btn-danger' : 'btn-primary'}`}
                          style={{ padding: '6px 12px', fontSize: '12px' }}
                        >
                          {b.is_licensed ? <Lock size={14} /> : <Unlock size={14} />}
                          {b.is_licensed ? 'Revoke License' : 'Activate License'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* User Role Management */}
      <div className="card">
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={18} color="var(--accent)" /> User Role & Access Control
        </h3>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                <th style={{ padding: '12px' }}>EMAIL</th>
                <th style={{ padding: '12px' }}>CURRENT ROLE</th>
                <th style={{ padding: '12px', textAlign: 'right' }}>ASSIGN ROLE</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '14px 12px', fontWeight: 600 }}>{p.email}</td>
                  <td style={{ padding: '14px 12px' }}>
                    <span className={`badge ${
                      p.role === 'seed_admin' ? 'badge-danger' :
                      p.role === 'super_admin' ? 'badge-warning' :
                      p.role === 'admin' ? 'badge-info' : 'badge-success'
                    }`}>
                      {p.role.replace('_', ' ').toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                    {p.email?.toLowerCase() === 'sammyseth260@gmail.com' ? (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Owner (Immutable)</span>
                    ) : (
                      <select 
                        value={p.role} 
                        onChange={e => updateUserRole(p.id, e.target.value)}
                        className="input-field"
                        style={{ width: 'auto', padding: '6px 12px', fontSize: '12px' }}
                      >
                        <option value="worker">Worker</option>
                        <option value="admin">Admin</option>
                        <option value="super_admin">Super Admin</option>
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </DashboardLayout>
  );
}
