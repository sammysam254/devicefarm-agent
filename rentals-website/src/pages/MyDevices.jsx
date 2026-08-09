import React, { useEffect, useState } from 'react';
import RentalsLayout from '../layouts/RentalsLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Smartphone, Lock, Unlock, ExternalLink, RefreshCw, Eye, EyeOff, AlertCircle, ArrowLeft, Video } from 'lucide-react';

export default function MyDevices() {
  const { user } = useAuth();
  const [rentedDevices, setRentedDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [revealedPasswords, setRevealedPasswords] = useState({});
  const [focusDevice, setFocusDevice] = useState(null);

  const fetchMyRentedDevices = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Query device assignments for this user
      const { data: aData } = await supabase
        .from('device_assignments')
        .select('*, devices(*)')
        .eq('assigned_to_user_id', user.id);

      setRentedDevices(aData || []);
    } catch (e) {
      console.error('Error fetching my rented devices:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMyRentedDevices();
    const timer = setInterval(fetchMyRentedDevices, 5000);
    return () => clearInterval(timer);
  }, [user]);

  const togglePasswordReveal = (id) => {
    setRevealedPasswords(prev => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  return (
    <RentalsLayout>
      <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Smartphone size={26} color="var(--success)" />
            <h1 style={{ fontSize: '26px', fontWeight: 800 }}>My Rented Devices</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Devices you currently rent. Access real-time control streams and access passwords.
          </p>
        </div>
        <button onClick={fetchMyRentedDevices} className="btn btn-secondary">
          <RefreshCw size={16} /> Refresh Feeds
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0' }}>
          Loading your rented devices...
        </div>
      ) : rentedDevices.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <Lock size={48} style={{ marginBottom: '14px', opacity: 0.3 }} />
          <h3 style={{ fontSize: '18px', fontWeight: 700 }}>No Rented Devices Found</h3>
          <p style={{ fontSize: '13px', marginTop: '6px' }}>
            You haven't rented any devices yet. Browse the Device Store to rent available devices!
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '22px' }}>
          {rentedDevices.map(a => {
            const dev = a.devices;
            const isOnline = dev?.status === 'online' && dev?.stream_url && !dev?.is_deleted_from_view;
            const price = dev?.monthly_rental_price || 49;
            const isPasswordRevealed = revealedPasswords[a.id];

            return (
              <div key={a.id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                    <div>
                      <h3 style={{ fontSize: '18px', fontWeight: 800 }}>
                        {dev?.brand || ''} {dev?.model || 'Android Device'}
                      </h3>
                      <p style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace', marginTop: '2px' }}>
                        SN: {dev?.serial}
                      </p>
                    </div>
                    <span className={`badge ${isOnline ? 'badge-success' : 'badge-warning'}`}>
                      {isOnline ? '🟢 Live Online' : '🟡 Device Offline'}
                    </span>
                  </div>

                  {/* Password box */}
                  <div style={{
                    background: 'rgba(56,189,248,0.06)',
                    border: '1px solid rgba(56,189,248,0.15)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    marginBottom: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    justify: 'space-between'
                  }}>
                    <div>
                      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        ACCESS PASSWORD
                      </div>
                      <div style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '18px', letterSpacing: '2px', color: 'var(--primary)' }}>
                        {isPasswordRevealed ? a.access_password : '••••••'}
                      </div>
                    </div>
                    <button
                      onClick={() => togglePasswordReveal(a.id)}
                      className="btn btn-secondary"
                      style={{ padding: '4px 8px', fontSize: '11px' }}
                    >
                      {isPasswordRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                      {isPasswordRevealed ? 'Hide' : 'Show'}
                    </button>
                  </div>

                  {/* Rental info */}
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                    Rental Fee: <strong style={{ color: '#fff' }}>${price}/mo USD</strong>
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    disabled={!isOnline}
                    onClick={() => setFocusDevice(dev)}
                    className="btn btn-primary"
                    style={{ flex: 1, justifyContent: 'center', opacity: isOnline ? 1 : 0.5 }}
                  >
                    <Video size={14} /> Open Live Stream
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Focus Stream Modal */}
      {focusDevice && (
        <div className="modal-overlay" onClick={() => setFocusDevice(null)}>
          <div 
            className="modal-box" 
            onClick={e => e.stopPropagation()} 
            style={{ maxWidth: '560px', height: '90vh', maxHeight: '840px', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          >
            <div style={{ padding: '14px 20px', background: 'rgba(15, 23, 42, 0.95)', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ color: '#fff', fontSize: '15px' }}>📱 {focusDevice.brand || ''} {focusDevice.model}</strong>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>SN: {focusDevice.serial}</div>
              </div>
              <button onClick={() => setFocusDevice(null)} className="btn btn-danger" style={{ padding: '6px 12px', fontSize: '12px' }}>
                <ArrowLeft size={14} /> Back
              </button>
            </div>

            <div style={{ flex: 1, background: '#000', position: 'relative' }}>
              <iframe 
                src={focusDevice.stream_url} 
                style={{ width: '100%', height: '100%', border: 'none' }} 
                title="Rented Device Stream"
                referrerPolicy="no-referrer"
                allow="autoplay; fullscreen"
              />
            </div>
          </div>
        </div>
      )}
    </RentalsLayout>
  );
}
