import React, { useEffect, useState } from 'react';
import RentalsLayout from '../layouts/RentalsLayout';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { Store, Smartphone, CheckCircle, RefreshCw, ShoppingCart, Lock, DollarSign, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PaymentModal from '../components/PaymentModal';

export default function DeviceStore() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [storeDevices, setStoreDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paymentModalDevice, setPaymentModalDevice] = useState(null);

  const fetchStoreDevices = async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      // Query devices available for rental & unassigned/available
      const { data } = await supabase
        .from('devices')
        .select('*')
        .eq('is_available_for_rental', true)
        .eq('status', 'online')
        .order('created_at', { ascending: false });

      // Filter: must be available rental status and not deleted from view
      const available = (data || []).filter(d => {
        if (d.is_deleted_from_view) return false;
        if (d.rental_status && d.rental_status !== 'available') return false;
        if (d.rented_by_user_id) return false;
        return true;
      });

      setStoreDevices(available);
    } catch (e) {
      console.error('Error fetching store devices:', e);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchStoreDevices(true);
    const interval = setInterval(() => fetchStoreDevices(false), 5000);
    return () => clearInterval(interval);
  }, []);

  const handleOpenPaymentModal = (device) => {
    if (!user) {
      alert('Please sign in to rent a device');
      return navigate('/login');
    }
    setPaymentModalDevice(device);
  };

  const handlePaymentConfirmed = async (paymentRef) => {
    if (!paymentModalDevice || !user) return;
    const device = paymentModalDevice;

    try {
      const autoPassword = Math.floor(100000 + Math.random() * 900000).toString();

      // 1. Update device rental status to rented
      await supabase.from('devices').update({
        rental_status: 'rented',
        rented_by_user_id: user.id,
        rented_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', device.id);

      // 2. Create device assignment record for instant stream access
      await supabase.from('device_assignments').insert([{
        device_id: device.id,
        assigned_to_user_id: user.id,
        assigned_by_user_id: user.id,
        access_password: autoPassword
      }]);

      setPaymentModalDevice(null);
      alert(`🎉 Payment Verified & Device Rented Successfully! Access Password: ${autoPassword}\n\nRedirecting to My Devices...`);
      navigate('/my-devices');
    } catch (err) {
      alert('Error finalizing rental: ' + err.message);
    }
  };

  return (
    <RentalsLayout>
      <div style={{ marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Store size={26} color="var(--primary)" />
            <h1 style={{ fontSize: '26px', fontWeight: 800 }}>Device Store Marketplace</h1>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Unassigned high-performance Android devices ready for instant monthly rental.
          </p>
        </div>
        <button onClick={fetchStoreDevices} className="btn btn-secondary">
          <RefreshCw size={16} /> Refresh Marketplace
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 0' }}>
          Loading available store devices...
        </div>
      ) : storeDevices.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <ShoppingCart size={48} style={{ marginBottom: '14px', opacity: 0.3 }} />
          <h3 style={{ fontSize: '18px', fontWeight: 700 }}>No Devices Currently in Store</h3>
          <p style={{ fontSize: '13px', marginTop: '6px' }}>
            All available devices are currently rented out. Check back soon when new devices are released by Super Admin!
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '22px' }}>
          {storeDevices.map(d => {
            const price = d.monthly_rental_price || 49;
            const isRenting = rentingId === d.id;

            return (
              <div key={d.id} className="card card-interactive" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                <div>
                  {/* Header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
                    <div>
                      <h3 style={{ fontSize: '18px', fontWeight: 800 }}>
                        {d.brand} {d.model}
                      </h3>
                      <p style={{ color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'monospace', marginTop: '2px' }}>
                        SN: {d.serial}
                      </p>
                    </div>
                    <span className="badge badge-success">
                      <Zap size={11} /> READY
                    </span>
                  </div>

                  {/* Pricing Box */}
                  <div style={{
                    background: 'linear-gradient(135deg, rgba(56,189,248,0.08), rgba(168,85,247,0.05))',
                    border: '1px solid rgba(56,189,248,0.2)',
                    borderRadius: '12px',
                    padding: '14px 16px',
                    marginBottom: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    justify: 'space-between'
                  }}>
                    <div>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        MONTHLY RENTAL FEE
                      </div>
                      <div style={{ fontSize: '26px', fontWeight: 800, color: 'var(--primary)', display: 'flex', alignItems: 'center' }}>
                        <span style={{ fontSize: '16px', marginRight: '2px' }}>$</span>{price}
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '4px' }}>/mo USD</span>
                      </div>
                    </div>
                    <div className="badge badge-primary">Instant Setup</div>
                  </div>
                </div>

                {/* Action Button */}
                <button
                  onClick={() => handleOpenPaymentModal(d)}
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px' }}
                >
                  <ShoppingCart size={16} />
                  Rent Device (${price}/mo)
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* In-App Payment Modal (Paystack & NOWPayments Crypto) */}
      {paymentModalDevice && (
        <PaymentModal
          device={paymentModalDevice}
          user={user}
          onClose={() => setPaymentModalDevice(null)}
          onPaymentSuccess={handlePaymentConfirmed}
        />
      )}
    </RentalsLayout>
  );
}
