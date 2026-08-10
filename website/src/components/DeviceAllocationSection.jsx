import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Key, Smartphone, Users, Lock, CheckCircle, RefreshCw, Trash2, ExternalLink } from 'lucide-react';

export default function DeviceAllocationSection({ currentUser }) {
  const [devices, setDevices] = useState([]);
  const [users, setUsers] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [unassigningId, setUnassigningId] = useState(null);

  const isDeviceOnline = (d) => {
    if (!d || d.is_deleted_from_view) return false;
    if (d.status === 'online' || Boolean(d.stream_url)) return true;
    if (!d.updated_at && !d.last_seen) return true;
    const lastTime = new Date(d.updated_at || d.last_seen).getTime();
    return (new Date().getTime() - lastTime) < 86400000;
  };

  const loadAllocationData = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      // 1. Fetch all devices (excluding deleted from view)
      const { data: dData, error: dErr } = await supabase
        .from('devices')
        .select('*')
        .order('created_at', { ascending: false });

      if (dErr) console.error('Error fetching devices:', dErr);
      const visibleDevices = (dData || []).filter(d => !d.is_deleted_from_view);
      setDevices(visibleDevices);

      // 2. Fetch all active profiles (workers, admins, super_admins, seed_admin)
      const { data: uData, error: uErr } = await supabase
        .from('profiles')
        .select('*')
        .order('email', { ascending: true });

      if (uErr) console.error('Error fetching profiles:', uErr);
      const activeUsers = (uData || []).filter(u => !u.is_blocked);
      setUsers(activeUsers);

      // 3. Fetch active device assignments
      const { data: aData, error: aErr } = await supabase
        .from('device_assignments')
        .select('*, devices(*), profiles!assigned_to_user_id(*)');

      if (aErr) console.error('Error fetching assignments:', aErr);
      const validAssignments = (aData || []).filter(a => a.devices && !a.devices.is_deleted_from_view);
      setAssignments(validAssignments);
    } catch (e) {
      console.error('Error loading allocation section:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    loadAllocationData(true);
    const interval = setInterval(() => loadAllocationData(false), 10000);
    return () => clearInterval(interval);
  }, []);

  const generatePassword = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
  };

  const handleAssign = async (e) => {
    e.preventDefault();
    if (!selectedDevice || !selectedUser) return alert('Please select both a device and a user');

    // Check if device is already assigned
    const existing = assignments.find(a => a.device_id === selectedDevice && a.assigned_to_user_id === selectedUser);
    if (existing) {
      return alert('This device is already assigned to the selected user.');
    }

    setAssigning(true);
    const autoPassword = generatePassword();

    try {
      const { error } = await supabase.from('device_assignments').insert([{
        device_id: selectedDevice,
        assigned_to_user_id: selectedUser,
        assigned_by_user_id: currentUser?.id,
        access_password: autoPassword
      }]);

      if (error) throw error;

      alert(`✅ Device allocated successfully!\n\nGenerated Access Password: ${autoPassword}`);
      setSelectedDevice('');
      setSelectedUser('');
      loadAllocationData();
    } catch (err) {
      alert('Error creating allocation: ' + err.message);
    } finally {
      setAssigning(false);
    }
  };

  const handleReKeyAssignment = async (assignmentId, deviceName, userEmail) => {
    if (!window.confirm(`Re-key access password for ${deviceName} assigned to ${userEmail}? This will instantly invalidate the current stream link.`)) return;

    const newPassword = generatePassword();
    try {
      const { error } = await supabase.from('device_assignments').update({
        access_password: newPassword,
      }).eq('id', assignmentId);

      if (error) throw error;

      alert(`✅ Stream link re-keyed successfully!\n\nNew Access Password: ${newPassword}`);
      loadAllocationData();
    } catch (err) {
      alert('Error re-keying link: ' + err.message);
    }
  };

  const handleRevokeAssignment = async (assignmentId, deviceName, userEmail) => {
    if (!window.confirm(`Revoke device allocation for ${deviceName} assigned to ${userEmail}?`)) return;

    setUnassigningId(assignmentId);
    try {
      const { error } = await supabase.from('device_assignments').delete().eq('id', assignmentId);
      if (error) throw error;

      loadAllocationData();
    } catch (err) {
      alert('Error revoking allocation: ' + err.message);
    } finally {
      setUnassigningId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Assign Device Form */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
            <Key size={18} color="var(--primary)" /> Allocate Device Stream Access
          </h3>
          <button onClick={loadAllocationData} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>
            <RefreshCw size={14} /> Refresh List
          </button>
        </div>

        <form onSubmit={handleAssign} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', alignItems: 'end' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              SELECT DEVICE ({devices.length} Available)
            </label>
            <select 
              className="input-field" 
              value={selectedDevice} 
              onChange={e => setSelectedDevice(e.target.value)}
              required
            >
              <option value="">-- Choose Device --</option>
              {devices.map(d => {
                const online = isDeviceOnline(d);
                return (
                  <option key={d.id} value={d.id}>
                    {d.brand || 'Android'} {d.model || 'Device'} ({d.serial}) [{online ? '🟢 ONLINE' : '🔴 OFFLINE'}]
                  </option>
                );
              })}
            </select>
          </div>

          <div>
            <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              SELECT USER ({users.length} Active Accounts)
            </label>
            <select 
              className="input-field" 
              value={selectedUser} 
              onChange={e => setSelectedUser(e.target.value)}
              required
            >
              <option value="">-- Choose Worker / Admin / User --</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>
                  {u.email} ({u.role ? u.role.replace('_', ' ').toUpperCase() : 'USER'})
                </option>
              ))}
            </select>
          </div>

          <button type="submit" className="btn btn-primary" disabled={assigning} style={{ height: '42px' }}>
            <CheckCircle size={16} /> {assigning ? 'Allocating...' : 'Allocate & Generate Password'}
          </button>
        </form>
      </div>

      {/* Active Device Allocations Table */}
      <div className="card">
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Lock size={18} color="var(--success)" /> Active Device Allocations ({assignments.length})
        </h3>

        {loading ? (
          <div>Loading active allocations...</div>
        ) : assignments.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: '12px 0' }}>No active device allocations created yet. Use the form above to allocate devices.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE</th>
                  <th style={{ padding: '12px' }}>ASSIGNED USER</th>
                  <th style={{ padding: '12px' }}>ROLE</th>
                  <th style={{ padding: '12px' }}>ACCESS PASSWORD</th>
                  <th style={{ padding: '12px' }}>STREAM LINK</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map(a => {
                  const deviceName = `${a.devices?.brand || 'Android'} ${a.devices?.model || 'Device'}`;
                  const userEmail = a.profiles?.email || 'Unknown User';
                  const userRole = a.profiles?.role ? a.profiles.role.replace('_', ' ').toUpperCase() : 'USER';
                  const online = isDeviceOnline(a.devices);

                  return (
                    <tr key={a.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '14px 12px', fontWeight: 700 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Smartphone size={16} color="var(--primary)" />
                          <span>{deviceName}</span>
                          <span style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>({a.devices?.serial})</span>
                          <span className={`badge ${online ? 'badge-success' : 'badge-warning'}`} style={{ fontSize: '10px', padding: '2px 6px' }}>
                            {online ? 'ONLINE' : 'OFFLINE'}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '14px 12px', fontWeight: 600 }}>{userEmail}</td>
                      <td style={{ padding: '14px 12px' }}>
                        <span className="badge badge-secondary" style={{ fontSize: '11px' }}>{userRole}</span>
                      </td>
                      <td style={{ padding: '14px 12px', fontFamily: 'monospace', fontWeight: 800, color: 'var(--primary)' }}>
                        🔑 {a.access_password}
                      </td>
                      <td style={{ padding: '14px 12px', fontSize: '12px', fontFamily: 'monospace' }}>
                        {a.devices?.stream_url ? (
                          <a href={a.devices.stream_url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            Open Stream <ExternalLink size={12} />
                          </a>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>Offline</span>
                        )}
                      </td>
                      <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            onClick={() => handleReKeyAssignment(a.id, deviceName, userEmail)}
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px', fontSize: '11px' }}
                            title="Invalidate current password and issue a new stream link key"
                          >
                            <Key size={12} /> Re-Key Link
                          </button>
                          <button
                            onClick={() => handleRevokeAssignment(a.id, deviceName, userEmail)}
                            disabled={unassigningId === a.id}
                            className="btn btn-danger"
                            style={{ padding: '6px 10px', fontSize: '11px' }}
                          >
                            <Trash2 size={12} /> {unassigningId === a.id ? 'Revoking...' : 'Revoke'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
