import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, KeyRound, ArrowRight, CheckCircle2, ArrowLeft } from 'lucide-react';
import SEO from '../components/SEO';

export default function ForgotPassword() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);

    try {
      const { error: err } = await resetPassword(email);
      if (err) throw err;
      setMessage('Password reset link sent! Please check your inbox and click the reset link to proceed.');
    } catch (err) {
      setError(err.message || 'Failed to send password reset email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'radial-gradient(circle at top, rgba(56,189,248,0.1), transparent)'
    }}>
      <SEO
        title="Forgot Password — FlexPulse Platform"
        description="Reset your FlexPulse account password to restore secure portal access."
        canonical="https://dennoh.site/forgot-password"
      />
      <div className="card" style={{ maxWidth: '440px', width: '100%', padding: '36px 28px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '56px',
            height: '56px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, var(--primary), var(--primary-hover))',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '14px',
            color: '#fff'
          }}>
            <KeyRound size={28} />
          </div>
          <h2 style={{ fontSize: '24px', fontWeight: 800 }}>Reset Password</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px', lineHeight: 1.5 }}>
            Enter your email to receive a password reset link
          </p>
        </div>

        {error && (
          <div style={{
            padding: '10px 14px',
            borderRadius: '10px',
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: 'var(--danger)',
            fontSize: '13px',
            marginBottom: '16px'
          }}>
            {error}
          </div>
        )}

        {message ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              color: '#4ade80',
              fontSize: '14px',
              lineHeight: 1.6,
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              textAlign: 'left'
            }}>
              <CheckCircle2 size={24} style={{ flexShrink: 0, marginTop: '2px' }} />
              <div>{message}</div>
            </div>
            <Link to="/login" className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
              <ArrowLeft size={16} /> Return to Log In
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                EMAIL ADDRESS
              </label>
              <div style={{ position: 'relative' }}>
                <Mail size={16} style={{ position: 'absolute', left: '14px', top: '14px', color: 'var(--text-muted)' }} />
                <input
                  type="email"
                  required
                  className="input-field"
                  style={{ paddingLeft: '40px' }}
                  placeholder="name@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}>
              {loading ? 'Sending link...' : 'Send Reset Link'} <ArrowRight size={16} />
            </button>

            <div style={{ textAlign: 'center', marginTop: '12px' }}>
              <Link to="/login" style={{ fontSize: '13px', color: 'var(--primary)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                <ArrowLeft size={14} /> Back to Log In
              </Link>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
