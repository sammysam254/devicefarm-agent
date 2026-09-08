import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import { Smartphone, Lock, Mail, ArrowRight, CheckCircle2 } from 'lucide-react';
import SEO from '../components/SEO';
import QuadCornerLoader from '../components/QuadCornerLoader';
import { playWelcomeSound } from '../lib/soundEffects';

export default function Login() {
  const { login, signup } = useAuth();
  const navigate = useNavigate();

  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [welcomeMsg, setWelcomeMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (isSignUp) {
        const { data, error: err } = await signup(email, password);
        if (err) throw err;

        // If session was not immediately returned by signUp, attempt instant signIn
        if (!data?.session) {
          const { error: logErr } = await login(email, password);
          if (logErr && !data?.user) throw logErr;
        }

        playWelcomeSound();
        setWelcomeMsg(`Welcome to FlexPulse, ${email}!`);
        setTimeout(() => navigate('/worker'), 1600);
      } else {
        const { error: logErr } = await login(email, password);
        if (logErr) throw logErr;
        playWelcomeSound();
        setWelcomeMsg(`Welcome back to FlexPulse!`);
        setTimeout(() => navigate('/worker'), 1600);
      }
    } catch (err) {
      setError(err.message || 'Authentication failed');
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
        title={isSignUp ? "Create Account — FlexPulse Cloud Device Farm" : "Access Portal — FlexPulse Cloud Device Farm"}
        description="Sign in or create an account on FlexPulse Cloud Platform to access dedicated device streaming, WebRTC controls, and agent monitoring."
        canonical="https://dennoh.site/login"
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
            marginBottom: '12px',
            color: '#fff',
            boxShadow: '0 8px 24px rgba(56, 189, 248, 0.3)'
          }}>
            <Smartphone size={28} />
          </div>
          <h2 style={{ fontSize: '24px', fontWeight: 800 }}>
            {isSignUp ? 'Create Account' : 'FlexPulse Access'}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            {welcomeMsg 
              ? 'Authentication Verified' 
              : (isSignUp ? 'Create an account to access your device dashboard' : 'Log in to access your device dashboard')}
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

        {welcomeMsg ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{
              padding: '20px',
              borderRadius: '16px',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              color: '#4ade80',
              fontSize: '15px',
              fontWeight: 700,
              marginBottom: '16px'
            }}>
              <CheckCircle2 size={36} style={{ display: 'block', margin: '0 auto 10px auto' }} />
              {welcomeMsg}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Opening Cloud Dashboard...</p>
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

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', display: 'block' }}>
                  PASSWORD
                </label>
                {!isSignUp && (
                  <Link to="/forgot-password" style={{ fontSize: '12px', color: 'var(--primary)', fontWeight: 600, textDecoration: 'none' }}>
                    Forgot Password?
                  </Link>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <Lock size={16} style={{ position: 'absolute', left: '14px', top: '14px', color: 'var(--text-muted)' }} />
                <input 
                  type="password" 
                  required 
                  minLength={6}
                  className="input-field" 
                  style={{ paddingLeft: '40px' }}
                  placeholder="••••••••" 
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '10px' }}>
              {loading ? (
                <QuadCornerLoader text={isSignUp ? 'Creating Account...' : 'Connecting Corners & Authenticating...'} size="small" inline />
              ) : (
                <>{isSignUp ? 'Create Account' : 'Sign In'} <ArrowRight size={16} /></>
              )}
            </button>
          </form>
        )}

        <div style={{ textAlign: 'center', marginTop: '20px' }}>
          <button 
            type="button" 
            onClick={() => { setIsSignUp(!isSignUp); setError(null); }}
            style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
          >
            {isSignUp ? 'Already have an account? Log in' : "Don't have an account? Sign up"}
          </button>
        </div>
      </div>
    </main>
  );
}
