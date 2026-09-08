import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import SEO from '../components/SEO';
import QuadCornerLoader from '../components/QuadCornerLoader';
import { playWelcomeSound } from '../lib/soundEffects';

export default function Signup() {
  const { signup, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [welcomeMsg, setWelcomeMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSignupSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const data = await signup(email, password);
      
      // If user session is not immediately established, attempt instant sign in
      if (!data?.session) {
        try {
          await login(email, password);
        } catch (e) {
          // If login fails but user was created
        }
      }

      playWelcomeSound();
      setWelcomeMsg(`Welcome to FlexPulse, ${email}!`);
      setTimeout(() => navigate('/store'), 1600);
    } catch (err) {
      setError(err.message || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <SEO
        title="Create Account — FlexPulse Device Rentals"
        description="Register instantly for FlexPulse Device Rentals Marketplace without needing verification codes."
        canonical="https://rentals.dennoh.site/signup"
      />
      <div className="card" style={{ maxWidth: '440px', width: '100%', padding: '36px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '52px',
            height: '52px',
            borderRadius: '16px',
            background: 'linear-gradient(135deg, #0ea5e9, #a855f7)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '24px',
            marginBottom: '12px',
            boxShadow: '0 8px 24px rgba(14,165,233,0.3)'
          }}>
            ⚡
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 800 }}>
            {welcomeMsg ? 'Account Created' : 'Create Account'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            {welcomeMsg ? 'Welcome aboard' : 'Join FlexPulse Device Rentals Marketplace'}
          </p>
        </div>

        {error && (
          <div style={{ background: 'rgba(248, 113, 113, 0.12)', border: '1px solid rgba(248, 113, 113, 0.3)', color: 'var(--danger)', padding: '12px 16px', borderRadius: '12px', fontSize: '13px', marginBottom: '20px' }}>
            {error}
          </div>
        )}

        {welcomeMsg ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', color: '#4ade80', padding: '20px', borderRadius: '16px', fontSize: '15px', fontWeight: 700, marginBottom: '16px' }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 10px auto' }} />
              {welcomeMsg}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Redirecting to Device Marketplace...</p>
          </div>
        ) : (
          <form onSubmit={handleSignupSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
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
              {loading ? (
                <QuadCornerLoader text="Creating Account..." size="small" inline />
              ) : (
                <>Create Account <ArrowRight size={16} /></>
              )}
            </button>
          </form>
        )}

        <div style={{ textAlign: 'center', marginTop: '24px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Already have an account? <Link to="/login" style={{ fontWeight: 700 }}>Sign In</Link>
        </div>
      </div>
    </main>
  );
}
