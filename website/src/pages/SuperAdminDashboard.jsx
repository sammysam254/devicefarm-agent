import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Server, Key, Smartphone, Users, RefreshCw, Link2, ExternalLink, UserX, UserCheck } from 'lucide-react';

export default function SuperAdminDashboard() {
  const { profile } = useAuth();
  const [bindingCodeInput, setBindingCodeInput] = useState('');
  const [myBindings, setMyBindings] = useState([]);
  const [devices, setDevices] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [blockingId, setBlockingId] = useState(null);
  const [blockReasonModal, setBlockReasonModal] = useState(null);
  const [blockReason, setBlockReason] = useState('');

  const loadData = async () => {
    try {
      const isSeed = profile?.role === 'seed_admin';
      let bQuery = supabase.from('machine_bindings').select('*');
      if (!isSeed && profile?.id) {
        bQuery = bQuery.eq('super_admin_id', profile.id);
      }
      const { data: bData } = await bQuery;
      setMyBindings(bData || []);

      const { data: dData } = await supabase.from('devices').select('*');
      setDevices(dData || []);

      // Fetch admins AND workers under this super admin (to block them)
      let aQuery = supabase.from('profiles').select('*').in('role', ['admin', 'worker']);
      if (!isSeed && profile?.id) {
        aQuery = aQuery.eq('super_admin_id', profile.id);
      }
      const { data: aData } = await aQuery;
      setAdmins(aData || []);
    } catch (e) {
      console.error('Error loading super admin data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (profile) {
      loadData();
      const timer = setInterval(() => {
        loadData();
      }, 4000);
      return () => clearInterval(timer);
    }
  }, [profile]);

  const handleClaimBinding = async (e) => {
    e.preventDefault();
    if (!bindingCodeInput || bindingCodeInput.length !== 8) {
      return alert('Enter a valid 8-digit binding code');
    }

    try {
      const { data: existing } = await supabase
        .from('machine_bindings')
        .select('*')
        .eq('binding_code', bindingCodeInput.trim())
        .single();

      if (existing) {
        await supabase
          .from('machine_bindings')
          .update({ super_admin_id: profile.id, updated_at: new Date().toISOString() })
          .eq('binding_code', bindingCodeInput.trim());
      } else {
        await supabase
          .from('machine_bindings')
          .insert([{
            binding_code: bindingCodeInput.trim(),
            super_admin_id: profile.id,
            machine_name: 'Super Admin Machine'
          }]);
      }

      alert(`Machine Binding ${bindingCodeInput} claimed successfully!`);
      setBindingCodeInput('');
      loadData();
    } catch (err) {
      alert('Error claiming binding code: ' + err.message);
    }
  };

  const handleBlockUser = async (e) => {
    e.preventDefault();
    if (!blockReasonModal) return;
    setBlockingId(blockReasonModal.id);
    try {
      await supabase.from('profiles').update({
        is_blocked: true,
        blocked_reason: blockReason.trim() || 'Suspended by Super Admin',
        blocked_by: profile?.id,
        updated_at: new Date().toISOString(),
      }).eq('id', blockReasonModal.id);
      setBlockReasonModal(null);
      setBlockReason('');
      loadData();
    } catch (err) {
      alert('Error blocking user: ' + err.message);
    } finally {
      setBlockingId(null);
    }
  };

  const handleUnblockUser = async (userId) => {
    setBlockingId(userId);
    try {
      await supabase.from('profiles').update({
        is_blocked: false,
        blocked_reason: null,
        blocked_by: null,
        updated_at: new Date().toISOString(),
      }).eq('id', userId);
      loadData();
    } catch (err) {
      alert('Error unblocking user: ' + err.message);
    } finally {
      setBlockingId(null);
    }
  };

  return (
    <DashboardLayout>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Server size={24} color="var(--primary)" />
            <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Super Admin Machine Hub</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Add 8-digit binding codes from setup scripts to fetch and manage connected devices.
          </p>
        </div>
        <button onClick={loadData} className="btn btn-secondary">
          <RefreshCw size={16} /> Refresh Devices
        </button>
      </div>

      {/* Claim Machine Binding Code */}
      <div className="card" style={{ marginBottom: '28px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Key size={18} color="var(--warning)" /> Bind New Computer Machine
        </h3>
        <form onSubmit={handleClaimBinding} style={{ display: 'flex', gap: '12px', maxWidth: '540px' }}>
          <input 
            type="text" 
            className="input-field" 
            maxLength={8}
            placeholder="Enter 8-digit binding code (e.g. 53361175)" 
            value={bindingCodeInput}
            onChange={e => setBindingCodeInput(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" style={{ whiteSpace: 'nowrap' }}>
            <Link2 size={16} /> Claim Machine
          </button>
        </form>
      </div>

      {/* Connected Devices Table */}
      <div className="card" style={{ marginBottom: '28px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Smartphone size={18} color="var(--primary)" /> Managed Devices & Stream Links
        </h3>

        {loading ? (
          <div>Loading devices...</div>
        ) : devices.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No devices connected. Run `DeviceFarm-Agent-Setup.bat` on your computer to connect devices.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE / MODEL</th>
                  <th style={{ padding: '12px' }}>SERIAL</th>
                  <th style={{ padding: '12px' }}>BINDING CODE</th>
                  <th style={{ padding: '12px' }}>AUTO-UPDATED STREAM URL</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>STREAM ACCESS</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => (
                  <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontWeight: 700 }}>{d.brand} {d.model}</td>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace' }}>{d.serial}</td>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace', color: 'var(--primary)' }}>{d.binding_code || 'Unbound'}</td>
                    <td style={{ padding: '14px 12px', fontSize: '12px', fontFamily: 'monospace', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.stream_url || 'Generating Cloudflare link...'}
                    </td>
                    <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                      {d.stream_url ? (
                        <a href={d.stream_url} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: '12px' }}>
                          Open Stream <ExternalLink size={12} />
                        </a>
                      ) : (
                        <span className="badge badge-warning">Offline</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* User Block Management */}
      {admins.length > 0 && (
        <div className="card">
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Users size={18} color="var(--accent)" /> Admin & Worker Access Control
          </h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>EMAIL</th>
                  <th style={{ padding: '12px' }}>ROLE</th>
                  <th style={{ padding: '12px' }}>STATUS</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {admins.map(u => (
                  <tr key={u.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontWeight: 600 }}>{u.email}</td>
                    <td style={{ padding: '14px 12px' }}>
                      <span className={`badge ${u.role === 'admin' ? 'badge-info' : 'badge-success'}`}>
                        {u.role.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '14px 12px' }}>
                      {u.is_blocked ? (
                        <span className="badge badge-danger"><UserX size={11} /> BLOCKED</span>
                      ) : (
                        <span className="badge badge-success"><UserCheck size={11} /> ACTIVE</span>
                      )}
                    </td>
                    <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                      {u.is_blocked ? (
                        <button
                          onClick={() => handleUnblockUser(u.id)}
                          disabled={blockingId === u.id}
                          className="btn btn-primary"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                        >
                          <UserCheck size={14} /> Unblock
                        </button>
                      ) : (
                        <button
                          onClick={() => { setBlockReasonModal(u); setBlockReason(''); }}
                          disabled={blockingId === u.id}
                          className="btn btn-danger"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                        >
                          <UserX size={14} /> Block
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Block Reason Modal */}
      {blockReasonModal && (
        <div className="modal-overlay" onClick={() => setBlockReasonModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
              <UserX size={20} /> Block User
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              Blocking <strong style={{ color: 'var(--text-main)' }}>{blockReasonModal.email}</strong>. They will immediately see an "Access Revoked" screen.
            </p>
            <form onSubmit={handleBlockUser} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>REASON (optional)</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. Violated usage policy"
                  value={blockReason}
                  onChange={e => setBlockReason(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '6px' }}>
                <button type="button" onClick={() => setBlockReasonModal(null)} className="btn btn-secondary">Cancel</button>
                <button type="submit" className="btn btn-danger" disabled={blockingId}>
                  <UserX size={14} /> Confirm Block
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
