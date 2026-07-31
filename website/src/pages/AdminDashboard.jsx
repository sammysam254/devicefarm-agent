import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Users, Smartphone, Key, Lock, CheckCircle, RefreshCw, UserX, UserCheck } from 'lucide-react';

export default function AdminDashboard() {
  const { profile } = useAuth();
  const [devices, setDevices] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [selectedWorker, setSelectedWorker] = useState('');
  const [loading, setLoading] = useState(true);
  const [blockingId, setBlockingId] = useState(null);
  const [blockReasonModal, setBlockReasonModal] = useState(null);
  const [blockReason, setBlockReason] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      // Fetch devices
      const { data: dData } = await supabase.from('devices').select('*');
      setDevices(dData || []);

      // Fetch workers (only workers, not admins or above)
      const { data: wData } = await supabase.from('profiles').select('*').eq('role', 'worker');
      setWorkers(wData || []);

      // Fetch current assignments
      const { data: aData } = await supabase.from('device_assignments').select('*, devices(*), profiles!assigned_to_user_id(*)');
      setAssignments(aData || []);
    } catch (e) {
      console.error('Error loading admin allocations:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const generatePassword = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
  };

  const handleAssign = async (e) => {
    e.preventDefault();
    if (!selectedDevice || !selectedWorker) return alert('Pick both a device and worker');

    const autoPassword = generatePassword();

    try {
      await supabase.from('device_assignments').insert([{
        device_id: selectedDevice,
        assigned_to_user_id: selectedWorker,
        assigned_by_user_id: profile.id,
        access_password: autoPassword
      }]);

      alert(`Device assigned successfully! Generated password: ${autoPassword}`);
      setSelectedDevice('');
      setSelectedWorker('');
      loadData();
    } catch (err) {
      alert('Assignment error: ' + err.message);
    }
  };

  const handleBlockUser = async (e) => {
    e.preventDefault();
    if (!blockReasonModal) return;
    setBlockingId(blockReasonModal.id);
    try {
      await supabase.from('profiles').update({
        is_blocked: true,
        blocked_reason: blockReason.trim() || 'Suspended by Admin',
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
            <Users size={24} color="var(--primary)" />
            <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Admin Allocation Hub</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Assign device stream links to workers with auto-generated passwords for password-protected access.
          </p>
        </div>
        <button onClick={loadData} className="btn btn-secondary">
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Assign Device Form */}
      <div className="card" style={{ marginBottom: '28px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Key size={18} color="var(--primary)" /> Assign Device to Worker / Self
        </h3>

        <form onSubmit={handleAssign} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', alignItems: 'end' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>SELECT DEVICE</label>
            <select 
              className="input-field" 
              value={selectedDevice} 
              onChange={e => setSelectedDevice(e.target.value)}
              required
            >
              <option value="">-- Choose Device --</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>{d.brand} {d.model} ({d.serial})</option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>SELECT WORKER / ADMIN</label>
            <select 
              className="input-field" 
              value={selectedWorker} 
              onChange={e => setSelectedWorker(e.target.value)}
              required
            >
              <option value="">-- Choose User --</option>
              {workers.map(w => (
                <option key={w.id} value={w.id}>{w.email} ({w.role})</option>
              ))}
            </select>
          </div>

          <button type="submit" className="btn btn-primary">
            <CheckCircle size={16} /> Assign & Auto-Generate Password
          </button>
        </form>
      </div>

      {/* Active Assignments */}
      <div className="card" style={{ marginBottom: '28px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Lock size={18} color="var(--success)" /> Password-Protected Worker Allocations
        </h3>

        {loading ? (
          <div>Loading assignments...</div>
        ) : assignments.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No device assignments created yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE</th>
                  <th style={{ padding: '12px' }}>ASSIGNED WORKER</th>
                  <th style={{ padding: '12px' }}>ACCESS PASSWORD</th>
                  <th style={{ padding: '12px' }}>STREAM URL</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map(a => (
                  <tr key={a.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontWeight: 700 }}>{a.devices?.brand} {a.devices?.model}</td>
                    <td style={{ padding: '14px 12px' }}>{a.profiles?.email}</td>
                    <td style={{ padding: '14px 12px', fontFamily: 'monospace', fontWeight: 800, color: 'var(--primary)' }}>
                      🔑 {a.access_password}
                    </td>
                    <td style={{ padding: '14px 12px', fontSize: '12px', fontFamily: 'monospace' }}>
                      {a.devices?.stream_url || 'Offline'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Worker Block Management */}
      <div className="card">
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={18} color="var(--accent)" /> Worker Access Control
        </h3>

        {workers.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No workers registered yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>WORKER EMAIL</th>
                  <th style={{ padding: '12px' }}>STATUS</th>
                  <th style={{ padding: '12px' }}>BLOCK REASON</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {workers.map(w => (
                  <tr key={w.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 12px', fontWeight: 600 }}>{w.email}</td>
                    <td style={{ padding: '14px 12px' }}>
                      {w.is_blocked ? (
                        <span className="badge badge-danger"><UserX size={11} /> BLOCKED</span>
                      ) : (
                        <span className="badge badge-success"><UserCheck size={11} /> ACTIVE</span>
                      )}
                    </td>
                    <td style={{ padding: '14px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {w.blocked_reason || '—'}
                    </td>
                    <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                      {w.is_blocked ? (
                        <button
                          onClick={() => handleUnblockUser(w.id)}
                          disabled={blockingId === w.id}
                          className="btn btn-primary"
                          style={{ padding: '6px 14px', fontSize: '12px' }}
                        >
                          <UserCheck size={14} /> Unblock
                        </button>
                      ) : (
                        <button
                          onClick={() => { setBlockReasonModal(w); setBlockReason(''); }}
                          disabled={blockingId === w.id}
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
        )}
      </div>

      {/* Block Reason Modal */}
      {blockReasonModal && (
        <div className="modal-overlay" onClick={() => setBlockReasonModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
              <UserX size={20} /> Block Worker
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
                  placeholder="e.g. Account suspended"
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
