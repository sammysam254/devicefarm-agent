import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { UserPlus, ArrowRight } from 'lucide-react';

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await signup(email, password);
      setSuccess(true);
      setTimeout(() => {
        navigate('/store');
      }, 1500);
    } catch (err) {
      setError(err.message || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div className="card" style={{ maxWidth: '420px', width: '100%', padding: '36px' }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: 'linear-gradient(135deg, #38bdf8, #a855f7)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', marginBottom: '12px' }}>
            ⚡
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 800 }}>Create Account</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            Register to rent Android devices on FlexPulse Device Store
          </p>
        </div>

        {error && (
          <div style={{ background: 'rgba(248, 113, 113, 0.12)', border: '1px solid rgba(248, 113, 113, 0.3)', color: 'var(--danger)', padding: '12px', borderRadius: '10px', fontSize: '13px', marginBottom: '20px' }}>
            {error}
          </div>
        )}

        {success && (
          <div style={{ background: 'rgba(52, 211, 153, 0.12)', border: '1px solid rgba(52, 211, 153, 0.3)', color: 'var(--success)', padding: '12px', borderRadius: '10px', fontSize: '13px', marginBottom: '20px' }}>
            Account created successfully! Redirecting to Device Store...
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              EMAIL ADDRESS
            </label>
            <input
              type="email"
              required
              className="input-field"
              placeholder="name@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
              PASSWORD
            </label>
            <input
              type="password"
              required
              minLength={6}
              className="input-field"
              placeholder="At least 6 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '12px', marginTop: '8px' }}>
            {loading ? 'Creating Account...' : 'Register Account'} <ArrowRight size={16} />
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: '24px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Already have an account? <Link to="/login" style={{ fontWeight: 700 }}>Sign In</Link>
        </div>
      </div>
    </div>
  );
}
