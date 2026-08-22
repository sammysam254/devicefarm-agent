import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Shield, Key, CheckCircle, XCircle, Users, RefreshCw, Lock, Unlock, UserX, UserCheck, Smartphone, Trash2, RotateCcw, EyeOff } from 'lucide-react';
import CctvWall from '../components/CctvWall';
import DeviceAllocationSection from '../components/DeviceAllocationSection';
import { generate16CharKey, generate6DigitPin, rotateUrlWithKeyAndPin } from '../lib/keyGenerator';

export default function SeedAdminDashboard() {
  const { profile: myProfile } = useAuth();
  const [bindings, setBindings] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [blockingId, setBlockingId] = useState(null);
  const [blockReason, setBlockReason] = useState('');
  const [blockReasonModal, setBlockReasonModal] = useState(null); // profile to block

  const loadData = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const { data: bData } = await supabase.from('machine_bindings').select('*');
      const { data: pData } = await supabase.from('profiles').select('*');
      const { data: dData } = await supabase.from('devices').select('*').order('created_at', { ascending: false });
      setBindings(bData || []);
      setProfiles(pData || []);
      setDevices(dData || []);
    } catch (e) {
      console.error('Error loading seed data:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    loadData(true);

    const channel = supabase
      .channel('seed_admin_realtime_sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => loadData(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'machine_bindings' }, () => loadData(false))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadData(false))
      .subscribe();

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData(false);
      }
    }, 300000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const handleDeleteFromView = async (deviceId) => {
    if (!window.confirm('Delete this device from view in all dashboards? Super Admins, Admins, and Workers will no longer see it.')) return;
    try {
      await supabase.from('devices').update({
        is_deleted_from_view: true,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error deleting device from view: ' + err.message);
    }
  };

  const handleRestoreToView = async (deviceId) => {
    try {
      await supabase.from('devices').update({
        is_deleted_from_view: false,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error restoring device to view: ' + err.message);
    }
  };

  const toggleRentalStoreRelease = async (deviceId, currentVal) => {
    const nextVal = !currentVal;
    try {
      await supabase.from('devices').update({
        is_available_for_rental: nextVal,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error updating rental availability: ' + err.message);
    }
  };

  const handleSetRentalFee = async (deviceId, currentPrice) => {
    const newPrice = prompt('Set Monthly Rental Fee ($ USD):', currentPrice || 49);
    if (!newPrice) return;
    const numPrice = parseFloat(newPrice);
    if (isNaN(numPrice) || numPrice < 0) return alert('Invalid price');

    try {
      await supabase.from('devices').update({
        monthly_rental_price: numPrice,
        updated_at: new Date().toISOString()
      }).eq('id', deviceId);
      loadData();
    } catch (err) {
      alert('Error setting rental fee: ' + err.message);
    }
  };

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

  const handleBlockUser = async (e) => {
    e.preventDefault();
    if (!blockReasonModal) return;
    setBlockingId(blockReasonModal.id);
    try {
      await supabase.from('profiles').update({
        is_blocked: true,
        blocked_reason: blockReason.trim() || 'Suspended by Seed Owner',
        blocked_by: myProfile?.id,
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

  const handleRotateStreamLink = async (device) => {
    if (!window.confirm(`Rotate stream link for ${device.brand} ${device.model} (${device.serial})?\n\nThis will generate a new 16-character URL key and a new 6-digit stream PIN.`)) return;

    const newKey = generate16CharKey();
    const newPin = generate6DigitPin();
    const newStreamUrl = rotateUrlWithKeyAndPin(device.stream_url, device.serial, newKey, newPin);

    try {
      await supabase.from('devices').update({
        stream_url: newStreamUrl,
        updated_at: new Date().toISOString()
      }).eq('id', device.id);

      try {
        await supabase.from('device_rentals').update({
          stream_url: newStreamUrl,
          updated_at: new Date().toISOString()
        }).eq('serial_number', device.serial);
      } catch (_) {}

      try {
        await supabase.from('device_assignments').update({
          access_password: newPin,
          updated_at: new Date().toISOString()
        }).eq('device_id', device.id);
      } catch (_) {}

      alert(`✅ Stream link rotated successfully!\n\nNew 16-Char URL Key: ${newKey}\nNew 6-Digit Stream PIN: ${newPin}\n\nThe previous link and PIN have been invalidated.`);
      loadData();
    } catch (err) {
      alert('Error rotating stream link: ' + err.message);
    }
  };

  const isSeedOwner = (p) => p.email?.toLowerCase() === 'sammyseth260@gmail.com';

  return (
    <DashboardLayout>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Shield size={24} color="var(--danger)" />
            <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Seed Admin Control Center</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Owner rights (sammyseth260@gmail.com). Manage Super Admin licenses, binding codes, and system modes.
          </p>
        </div>
        <button onClick={loadData} className="btn btn-secondary">
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Stats Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '28px' }}>
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
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>TOTAL USERS</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--accent)' }}>{profiles.length}</div>
        </div>
        <div className="card">
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>DEVICES DELETED FROM VIEW</div>
          <div style={{ fontSize: '32px', fontWeight: 800, marginTop: '4px', color: 'var(--danger)' }}>
            {devices.filter(d => d.is_deleted_from_view).length}
          </div>
        </div>
      </div>

      {/* Real-time Security CCTV Camera Wall */}
      <CctvWall currentUser={myProfile} isSeedAdmin={true} />

      {/* Device Allocation Section */}
      <div style={{ marginBottom: '32px' }}>
        <DeviceAllocationSection currentUser={myProfile} />
      </div>

      {/* Seed Admin Device Visibility & Delete from View Management */}
      <div className="card" style={{ marginBottom: '32px' }}>
        <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Smartphone size={18} color="var(--primary)" /> Seed Admin Device Visibility & Delete from View Control
        </h3>

        {loading ? (
          <div>Loading devices...</div>
        ) : devices.length === 0 ? (
          <div style={{ color: 'var(--text-muted)' }}>No devices registered yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '12px' }}>
                  <th style={{ padding: '12px' }}>DEVICE / MODEL</th>
                  <th style={{ padding: '12px' }}>SERIAL</th>
                  <th style={{ padding: '12px' }}>MONTHLY FEE ($ USD)</th>
                  <th style={{ padding: '12px' }}>RENTALS STORE RELEASE</th>
                  <th style={{ padding: '12px' }}>VISIBILITY STATUS</th>
                  <th style={{ padding: '12px', textAlign: 'right' }}>SEED ADMIN ACTION</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => {
                  const now = new Date().getTime();
                  const lastTime = d.updated_at || d.last_seen ? new Date(d.updated_at || d.last_seen).getTime() : 0;
                  const isOnline = d.status === 'online' && (!d.last_seen || (now - lastTime < 180000));
                  const isDeleted = Boolean(d.is_deleted_from_view);
                  const isAvailableRental = Boolean(d.is_available_for_rental);
                  const price = d.monthly_rental_price || 49;

                  return (
                    <tr key={d.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '14px 12px', fontWeight: 700 }}>{d.brand} {d.model}</td>
                      <td style={{ padding: '14px 12px', fontFamily: 'monospace' }}>{d.serial}</td>
                      <td style={{ padding: '14px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontWeight: 800, color: 'var(--primary)' }}>${price}/mo</span>
                          <button 
                            onClick={() => handleSetRentalFee(d.id, price)} 
                            className="btn btn-secondary" 
                            style={{ padding: '2px 6px', fontSize: '10px' }}
                          >
                            Set Fee
                          </button>
                        </div>
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        <button
                          onClick={() => toggleRentalStoreRelease(d.id, isAvailableRental)}
                          className={`btn ${isAvailableRental ? 'btn-success' : 'btn-secondary'}`}
                          style={{ padding: '4px 10px', fontSize: '11px' }}
                        >
                          {isAvailableRental ? '🛒 Released to Store' : '🔒 Hold in Inventory'}
                        </button>
                      </td>
                      <td style={{ padding: '14px 12px' }}>
                        {isDeleted ? (
                          <span className="badge badge-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <EyeOff size={11} /> DELETED FROM VIEW
                          </span>
                        ) : (
                          <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <CheckCircle size={11} /> VISIBLE TO ALL
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                          <button
                            onClick={() => handleRotateStreamLink(d)}
                            className="btn btn-secondary"
                            style={{ padding: '6px 10px', fontSize: '11px' }}
                            title="Rotate stream link and issue a new 16-character access key"
                          >
                            <RotateCcw size={12} /> Rotate Link
                          </button>
                          {isDeleted ? (
                            <button
                              onClick={() => handleRestoreToView(d.id)}
                              className="btn btn-secondary"
                              style={{ padding: '6px 10px', fontSize: '11px' }}
                            >
                              Restore
                            </button>
                          ) : (
                            <button
                              onClick={() => handleDeleteFromView(d.id)}
                              className="btn btn-danger"
                              style={{ padding: '6px 10px', fontSize: '11px' }}
                            >
                              <Trash2 size={12} /> Delete from View
                            </button>
                          )}
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

      {/* User Role Management & Block Controls */}
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
                <th style={{ padding: '12px' }}>STATUS</th>
                <th style={{ padding: '12px' }}>ASSIGN ROLE</th>
                <th style={{ padding: '12px', textAlign: 'right' }}>BLOCK / UNBLOCK</th>
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
                  <td style={{ padding: '14px 12px' }}>
                    {p.is_blocked ? (
                      <span className="badge badge-danger">
                        <UserX size={11} /> BLOCKED
                      </span>
                    ) : (
                      <span className="badge badge-success">
                        <UserCheck size={11} /> ACTIVE
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '14px 12px' }}>
                    {isSeedOwner(p) ? (
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
                  <td style={{ padding: '14px 12px', textAlign: 'right' }}>
                    {isSeedOwner(p) ? (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Cannot Block Owner</span>
                    ) : p.is_blocked ? (
                      <button
                        onClick={() => handleUnblockUser(p.id)}
                        disabled={blockingId === p.id}
                        className="btn btn-primary"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                      >
                        <UserCheck size={14} /> Unblock
                      </button>
                    ) : (
                      <button
                        onClick={() => { setBlockReasonModal(p); setBlockReason(''); }}
                        disabled={blockingId === p.id}
                        className="btn btn-danger"
                        style={{ padding: '6px 14px', fontSize: '12px' }}
                      >
                        <UserX size={14} /> Block User
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Block Reason Modal */}
      {blockReasonModal && (
        <div className="modal-overlay" onClick={() => setBlockReasonModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
              <UserX size={20} /> Block User
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              You are about to block <strong style={{ color: 'var(--text-main)' }}>{blockReasonModal.email}</strong>. They will immediately see an "Access Revoked" screen.
            </p>
            <form onSubmit={handleBlockUser} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                  REASON (optional)
                </label>
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
