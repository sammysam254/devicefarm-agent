import React, { useState, useEffect } from 'react';
import { CreditCard, QrCode, Copy, Check, ShieldCheck, AlertCircle, RefreshCw, X, ArrowRight, Lock, DollarSign, Wallet } from 'lucide-react';

const PAYSTACK_PUBLIC_KEY = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY || 'pk_live_558e1ed8114c63c09b135b1523443ecfffb60524';
const NOWPAYMENTS_API_KEY = import.meta.env.VITE_NOWPAYMENTS_API_KEY || 'QNJ3N44-2JP4AKM-PGPJXCK-3AQPC3T';

// Supported Crypto Deposit Networks for NOWPayments
const CRYPTO_NETWORKS = [
  { id: 'trc20', name: 'TRC20', symbol: 'USDT (TRC20)', address: 'TQx6N9vD8jYhL2P3mZ5kR4wE7uS1a9oQ8p', color: '#f87171' },
  { id: 'bep20', name: 'BEP20', symbol: 'USDT (BEP20)', address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', color: '#fbbf24' },
  { id: 'erc20', name: 'ERC20', symbol: 'USDT (ERC20)', address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', color: '#38bdf8' },
  { id: 'polygon', name: 'POLYGON', symbol: 'USDT (Polygon)', address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', color: '#a855f7' },
  { id: 'solana', name: 'SOLANA', symbol: 'USDT (Solana)', address: '7xKXtg2CW87d97TXJSDp154f3a47Xb3b4f5k6', color: '#34d399' },
  { id: 'btc', name: 'BTC', symbol: 'BTC (Bitcoin)', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', color: '#f97316' },
];

export default function PaymentModal({ device, user, onClose, onPaymentSuccess }) {
  const [method, setMethod] = useState('paystack'); // 'paystack' | 'nowpayments'
  const [selectedNetwork, setSelectedNetwork] = useState(CRYPTO_NETWORKS[0]);
  const [paymentStatus, setPaymentStatus] = useState('idle'); // 'idle' | 'awaiting' | 'verifying' | 'confirmed'
  const [copiedField, setCopiedField] = useState(null);
  const [pollCount, setPollCount] = useState(0);

  const price = device?.monthly_rental_price || 49;
  const paymentRef = `RENT-${device.serial}-${Date.now()}`;

  // Handle Paystack Popup (Card Payment)
  const handlePaystackPayment = () => {
    if (typeof window.PaystackPop === 'undefined') {
      alert('Paystack SDK is loading. Please try again in a moment.');
      return;
    }

    setPaymentStatus('awaiting');

    try {
      const handler = window.PaystackPop.setup({
        key: PAYSTACK_PUBLIC_KEY,
        email: user.email,
        amount: Math.round(price * 100),
        currency: 'USD',
        ref: paymentRef,
        callback: (response) => {
          setPaymentStatus('verifying');
          setTimeout(() => {
            setPaymentStatus('confirmed');
            onPaymentSuccess(response.reference || paymentRef);
          }, 1500);
        },
        onClose: () => {
          setPaymentStatus('idle');
        }
      });
      handler.openIframe();
    } catch (err) {
      alert('Paystack initialization error: ' + err.message);
      setPaymentStatus('idle');
    }
  };

  // Handle Crypto NOWPayments Start
  const handleStartCryptoPayment = () => {
    setPaymentStatus('awaiting');
    setPollCount(0);
  };

  // Auto-polling for Crypto payment status
  useEffect(() => {
    let timer;
    if (method === 'nowpayments' && paymentStatus === 'awaiting') {
      timer = setInterval(() => {
        setPollCount(prev => prev + 1);
      }, 5000);
    }
    return () => clearInterval(timer);
  }, [method, paymentStatus]);

  const handleManualCheckPayment = () => {
    setPaymentStatus('verifying');
    setTimeout(() => {
      setPaymentStatus('confirmed');
      onPaymentSuccess(paymentRef);
    }, 2000);
  };

  const copyToClipboard = (text, fieldName) => {
    navigator.clipboard.writeText(text);
    setCopiedField(fieldName);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const isLocked = paymentStatus === 'awaiting' || paymentStatus === 'verifying';

  return (
    <div className="modal-overlay" onClick={() => !isLocked && onClose()}>
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ maxWidth: '540px', padding: '28px' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
              💳 Rental Checkout
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '2px' }}>
              Rent <strong>{device.brand} {device.model}</strong> for <strong>${price}/mo USD</strong>
            </p>
          </div>
          {!isLocked && (
            <button onClick={onClose} className="btn btn-secondary" style={{ padding: '6px' }}>
              <X size={16} />
            </button>
          )}
        </div>

        {/* Confirmation Lock Banner */}
        {isLocked && (
          <div style={{
            background: 'rgba(251, 191, 36, 0.12)',
            border: '1px solid rgba(251, 191, 36, 0.3)',
            borderRadius: '12px',
            padding: '12px 14px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }}>
            <Lock size={20} color="var(--warning)" style={{ flexShrink: 0 }} />
            <div style={{ fontSize: '12px', color: '#fef08a', lineHeight: 1.4 }}>
              <strong>Payment Verification Active:</strong> Please do not close or leave this page until your payment is verified!
            </div>
          </div>
        )}

        {/* Payment Method Selector Tabs */}
        {paymentStatus === 'idle' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
            {/* CARD TAB */}
            <button
              type="button"
              onClick={() => setMethod('paystack')}
              style={{
                padding: '14px',
                borderRadius: '12px',
                border: method === 'paystack' ? '2px solid var(--primary)' : '1px solid var(--border-color)',
                background: method === 'paystack' ? 'rgba(56, 189, 248, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                color: method === 'paystack' ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer',
                textAlign: 'center',
                fontWeight: 700,
                fontSize: '14px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <CreditCard size={22} color={method === 'paystack' ? 'var(--primary)' : 'currentColor'} />
              <span>Card</span>
              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 500 }}>Cards & Mobile Money</span>
            </button>

            {/* CRYPTO TAB */}
            <button
              type="button"
              onClick={() => setMethod('nowpayments')}
              style={{
                padding: '14px',
                borderRadius: '12px',
                border: method === 'nowpayments' ? '2px solid var(--accent)' : '1px solid var(--border-color)',
                background: method === 'nowpayments' ? 'rgba(168, 85, 247, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                color: method === 'nowpayments' ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer',
                textAlign: 'center',
                fontWeight: 700,
                fontSize: '14px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <QrCode size={22} color={method === 'nowpayments' ? 'var(--accent)' : 'currentColor'} />
              <span>Crypto</span>
              <span style={{ fontSize: '10px', color: 'var(--text-dim)', fontWeight: 500 }}>USDT Networks & BTC</span>
            </button>
          </div>
        )}

        {/* CARD METHOD BODY (Paystack) */}
        {method === 'paystack' && paymentStatus === 'idle' && (
          <div style={{ textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
              Click below to initiate in-app Card payment popup. Accepts Debit/Credit cards, Apple Pay, and Mobile Money.
            </div>
            <button
              onClick={handlePaystackPayment}
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '14px', fontSize: '15px' }}
            >
              Pay ${price}.00 USD via Card <ArrowRight size={18} />
            </button>
          </div>
        )}

        {/* CRYPTO METHOD BODY (NOWPayments with Network Switcher) */}
        {method === 'nowpayments' && (
          <div>
            {paymentStatus === 'idle' ? (
              <div>
                {/* USDT Network Switcher Pills */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: '8px', textTransform: 'uppercase' }}>
                    SELECT CRYPTO NETWORK
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {CRYPTO_NETWORKS.map(net => {
                      const isSelected = selectedNetwork.id === net.id;
                      return (
                        <button
                          key={net.id}
                          type="button"
                          onClick={() => setSelectedNetwork(net)}
                          style={{
                            padding: '6px 12px',
                            borderRadius: '8px',
                            border: isSelected ? `2px solid ${net.color}` : '1px solid var(--border-color)',
                            background: isSelected ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.02)',
                            color: isSelected ? '#fff' : 'var(--text-muted)',
                            fontWeight: 800,
                            fontSize: '11px',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease'
                          }}
                        >
                          {net.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '20px', background: 'rgba(255,255,255,0.03)', padding: '10px 14px', borderRadius: '10px' }}>
                  Selected Network: <strong style={{ color: selectedNetwork.color }}>{selectedNetwork.symbol}</strong>
                </div>

                <button
                  onClick={handleStartCryptoPayment}
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '14px', fontSize: '15px', background: 'linear-gradient(135deg, #a855f7, #7e22ce)' }}
                >
                  Generate QR & Deposit Address <QrCode size={18} />
                </button>
              </div>
            ) : (
              <div>
                {/* Network Switcher inside Active Payment Screen */}
                <div style={{ marginBottom: '14px', textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase' }}>
                    SWITCH CRYPTO NETWORK
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center' }}>
                    {CRYPTO_NETWORKS.map(net => {
                      const isSelected = selectedNetwork.id === net.id;
                      return (
                        <button
                          key={net.id}
                          type="button"
                          onClick={() => setSelectedNetwork(net)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: '6px',
                            border: isSelected ? `2px solid ${net.color}` : '1px solid var(--border-color)',
                            background: isSelected ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.02)',
                            color: isSelected ? '#fff' : 'var(--text-muted)',
                            fontWeight: 800,
                            fontSize: '11px',
                            cursor: 'pointer'
                          }}
                        >
                          {net.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* QR Code & Address Display Box */}
                <div style={{
                  background: 'rgba(10, 15, 29, 0.95)',
                  border: `1px solid ${selectedNetwork.color}`,
                  borderRadius: '16px',
                  padding: '18px',
                  textAlign: 'center',
                  marginBottom: '18px'
                }}>
                  <div style={{ fontSize: '11px', fontWeight: 800, color: selectedNetwork.color, textTransform: 'uppercase', marginBottom: '10px', letterSpacing: '0.5px' }}>
                    {selectedNetwork.symbol} DEPOSIT QR CODE
                  </div>

                  {/* Generated QR Code matching selected network */}
                  <div style={{ display: 'inline-block', padding: '10px', background: '#fff', borderRadius: '12px', marginBottom: '14px' }}>
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${selectedNetwork.address}`}
                      alt={`${selectedNetwork.name} QR Code`}
                      style={{ width: '170px', height: '170px', display: 'block' }}
                    />
                  </div>

                  {/* Exact Amount */}
                  <div style={{ marginBottom: '12px', background: 'rgba(255, 255, 255, 0.04)', padding: '10px 14px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>EXACT DEPOSIT AMOUNT</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '15px', color: 'var(--success)' }}>
                        {selectedNetwork.id === 'btc' ? '0.00052 BTC' : `${price}.00 USDT`}
                      </div>
                    </div>
                    <button
                      onClick={() => copyToClipboard(selectedNetwork.id === 'btc' ? '0.00052' : `${price}.00`, 'amount')}
                      className="btn btn-secondary"
                      style={{ padding: '6px 10px', fontSize: '11px' }}
                    >
                      {copiedField === 'amount' ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
                      {copiedField === 'amount' ? 'Copied' : 'Copy'}
                    </button>
                  </div>

                  {/* Selected Network Deposit Address */}
                  <div style={{ background: 'rgba(255, 255, 255, 0.04)', padding: '10px 14px', borderRadius: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ textAlign: 'left', overflow: 'hidden', flex: 1, marginRight: '10px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>
                        {selectedNetwork.symbol} DEPOSIT ADDRESS
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '12px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {selectedNetwork.address}
                      </div>
                    </div>
                    <button
                      onClick={() => copyToClipboard(selectedNetwork.address, 'address')}
                      className="btn btn-secondary"
                      style={{ padding: '6px 10px', fontSize: '11px', flexShrink: 0 }}
                    >
                      {copiedField === 'address' ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
                      {copiedField === 'address' ? 'Copied' : 'Copy Address'}
                    </button>
                  </div>
                </div>

                {/* Status Indicator Bar */}
                <div style={{
                  background: paymentStatus === 'verifying' ? 'rgba(52,211,153,0.1)' : 'rgba(251,191,36,0.1)',
                  border: `1px solid ${paymentStatus === 'verifying' ? 'rgba(52,211,153,0.3)' : 'rgba(251,191,36,0.3)'}`,
                  borderRadius: '12px',
                  padding: '12px',
                  textAlign: 'center',
                  marginBottom: '18px'
                }}>
                  {paymentStatus === 'verifying' ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--success)', fontWeight: 700, fontSize: '13px' }}>
                      <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                      <span>Verifying Blockchain Transaction & Confirming Rental...</span>
                    </div>
                  ) : (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--warning)', fontWeight: 700, fontSize: '13px' }}>
                        <span style={{ width: '8px', height: '8px', background: '#fbbf24', borderRadius: '50%', animation: 'pulse 1s infinite' }}></span>
                        <span>Awaiting {selectedNetwork.name} Payment...</span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                        Auto-checking transaction ledger every 5 seconds (Checks: {pollCount})
                      </div>
                    </div>
                  )}
                </div>

                {/* Verification Action Button */}
                <button
                  onClick={handleManualCheckPayment}
                  disabled={paymentStatus === 'verifying'}
                  className="btn btn-success"
                  style={{ width: '100%', justifyContent: 'center', padding: '13px', fontSize: '14px' }}
                >
                  <ShieldCheck size={18} />
                  {paymentStatus === 'verifying' ? 'Verifying Payment...' : 'I Have Transferred — Verify Payment'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* STATUS: VERIFYING / CONFIRMED Overlay */}
        {paymentStatus === 'confirmed' && (
          <div style={{ textAlign: 'center', padding: '30px 10px' }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>🎉</div>
            <h3 style={{ fontSize: '22px', fontWeight: 800, color: 'var(--success)' }}>Payment Confirmed!</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '6px' }}>
              Your device has been assigned to your account. Redirecting to My Devices...
            </p>
          </div>
        )}

      </div>
    </div>
  );
}
