import React, { useEffect, useState } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Smartphone, Lock, Unlock, ExternalLink, RefreshCw } from 'lucide-react';

export default function WorkerDashboard() {
  const { profile } = useAuth();
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [unlockModal, setUnlockModal] = useState(null); // assignment object
  const [inputPassword, setInputPassword] = useState('');
  const [error, setError] = useState(null);

  const loadData = async () => {
    if (!profile) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('device_assignments')
        .select('*, devices(*)')
        .eq('assigned_to_user_id', profile.id);
      setAssignments(data || []);
    } catch (e) {
      console.error('Error loading worker assignments:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [profile]);

  const handleUnlock = (e) => {
    e.preventDefault();
    setError(null);

    if (inputPassword.trim() === unlockModal.access_password.trim()) {
      window.open(unlockModal.devices?.stream_url, '_blank');
      setUnlockModal(null);
      setInputPassword('');
    } else {
      setError('Invalid password. Check with your admin.');
    }
  };

  return (
    <DashboardLayout>
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Smartphone size={24} color="var(--primary)" />
            <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Worker Assigned Streams</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Devices assigned to you by your Admin. Click to unlock with your password.
          </p>
        </div>
        <button onClick={loadData} className="btn btn-secondary">
          <RefreshCw size={16} /> Refresh Links
        </button>
      </div>

      {loading ? (
        <div>Loading assigned devices...</div>
      ) : assignments.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
          <Lock size={40} style={{ marginBottom: '12px', opacity: 0.5 }} />
          <h3>No Devices Assigned Yet</h3>
          <p style={{ fontSize: '13px', marginTop: '6px' }}>Your Admin has not assigned any device streams to your account yet.</p>
        </div>
      ) : (
        <div className="grid-cards">
          {assignments.map(a => (
            <div key={a.id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span className="badge badge-success">Assigned to You</span>
                  <span style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{a.devices?.serial}</span>
                </div>
                <h3 style={{ fontSize: '18px', fontWeight: 700 }}>{a.devices?.brand} {a.devices?.model}</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '4px' }}>
                  Password protected device link
                </p>
              </div>

              <div style={{ marginTop: '20px' }}>
                <button 
                  onClick={() => { setUnlockModal(a); setInputPassword(''); setError(null); }}
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  <Unlock size={16} /> Unlock & Open Device Stream <ExternalLink size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Password Unlock Modal */}
      {unlockModal && (
        <div className="modal-overlay" onClick={() => setUnlockModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Lock size={20} color="var(--primary)" /> Unlock Device Stream
            </h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              Enter the password assigned by your Admin to open <b>{unlockModal.devices?.brand} {unlockModal.devices?.model}</b>.
            </p>

            {error && (
              <div style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '12px', padding: '8px', background: 'rgba(239,68,68,0.1)', borderRadius: '8px' }}>
                {error}
              </div>
            )}

            <form onSubmit={handleUnlock} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <input 
                type="password"
                required
                autoFocus
                className="input-field"
                placeholder="Enter Access Password"
                value={inputPassword}
                onChange={e => setInputPassword(e.target.value)}
              />

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                <button type="button" onClick={() => setUnlockModal(null)} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Unlock Stream <ExternalLink size={14} />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
