import React, { useState, useEffect } from 'react';
import { Volume2, Mic, Bell, CheckCircle2, AlertCircle, ArrowRight, ShieldCheck, X } from 'lucide-react';
import { playDingSound } from '../lib/soundEffects';

export default function PermissionsModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0); // 0: Audio, 1: Mic, 2: Notification, 3: Completed
  const [status, setStatus] = useState({
    audio: false,
    mic: false,
    notification: false
  });
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Check initial permissions state (only ask once per user/browser)
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && localStorage.getItem('df_permissions_prompted')) {
        return; // Already asked once — do not prompt again
      }
    } catch (_) {}

    // Check Notification
    const notifGranted = typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted';

    // Check Microphone if supported
    const checkMic = async () => {
      let micGranted = false;
      if (typeof navigator !== 'undefined' && navigator.permissions && navigator.permissions.query) {
        try {
          const res = await navigator.permissions.query({ name: 'microphone' });
          micGranted = res.state === 'granted';
        } catch (_) {}
      }
      return micGranted;
    };

    checkMic().then(micGranted => {
      const audioGranted = Boolean(localStorage.getItem('df_audio_unlocked') || sessionStorage.getItem('df_audio_unlocked'));
      setStatus({
        audio: audioGranted,
        mic: micGranted,
        notification: notifGranted
      });

      // If any of the required permissions are missing, show the modal ONCE
      if (!audioGranted || !micGranted || !notifGranted) {
        // Determine first incomplete step
        if (!audioGranted) setCurrentStep(0);
        else if (!micGranted) setCurrentStep(1);
        else if (!notifGranted) setCurrentStep(2);
        setIsOpen(true);
        // Mark as prompted in localStorage so user is never asked repeatedly
        try {
          localStorage.setItem('df_permissions_prompted', '1');
        } catch (_) {}
      } else {
        try {
          localStorage.setItem('df_permissions_prompted', '1');
        } catch (_) {}
      }
    });
  }, []);

  // Step 1: Unlock Audio
  const handleEnableAudio = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') ctx.resume();
      }
      playDingSound();
      localStorage.setItem('df_audio_unlocked', '1');
      sessionStorage.setItem('df_audio_unlocked', '1');
      setStatus(prev => ({ ...prev, audio: true }));
      setErrorMessage('');
      // Advance to next step
      if (!status.mic) {
        setCurrentStep(1);
      } else if (!status.notification) {
        setCurrentStep(2);
      } else {
        setCurrentStep(3);
      }
    } catch (e) {
      setErrorMessage('Audio activation failed: ' + e.message);
    }
  };

  // Step 2: Request Microphone Access
  const handleRequestMic = async () => {
    setLoading(true);
    setErrorMessage('');
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Release tracks immediately
        stream.getTracks().forEach(track => track.stop());
        setStatus(prev => ({ ...prev, mic: true }));
        // Advance to next step
        if (!status.notification) {
          setCurrentStep(2);
        } else {
          setCurrentStep(3);
        }
      } else {
        throw new Error('Microphone API not supported on this browser.');
      }
    } catch (err) {
      console.warn('Microphone permission error:', err);
      setErrorMessage('Microphone access was denied or not found. You can still proceed, but voice calls will be disabled.');
      // Allow user to advance anyway
      setTimeout(() => {
        if (!status.notification) setCurrentStep(2);
        else setCurrentStep(3);
      }, 1500);
    } finally {
      setLoading(false);
    }
  };

  // Step 3: Request Notifications
  const handleRequestNotification = async () => {
    setLoading(true);
    setErrorMessage('');
    try {
      if ('Notification' in window) {
        const res = await Notification.requestPermission();
        if (res === 'granted') {
          setStatus(prev => ({ ...prev, notification: true }));
        } else {
          setErrorMessage('Notifications were not allowed. You can enable them later in browser settings.');
        }
      }
      try {
        localStorage.setItem('df_permissions_prompted', '1');
      } catch (_) {}
      setCurrentStep(3);
    } catch (err) {
      console.warn('Notification error:', err);
      try {
        localStorage.setItem('df_permissions_prompted', '1');
      } catch (_) {}
      setCurrentStep(3);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    try {
      localStorage.setItem('df_permissions_prompted', '1');
    } catch (_) {}
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(2, 6, 23, 0.85)',
      backdropFilter: 'blur(16px)',
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      animation: 'fadeIn 0.25s ease'
    }}>
      <div style={{
        background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.98), rgba(30, 41, 59, 0.95))',
        border: '1px solid rgba(56, 189, 248, 0.4)',
        boxShadow: '0 25px 60px rgba(0, 0, 0, 0.8), 0 0 35px rgba(56, 189, 248, 0.25)',
        borderRadius: '20px',
        maxWidth: '480px',
        width: '100%',
        padding: '28px 24px',
        position: 'relative',
        color: '#f8fafc',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px'
      }}>
        {/* Close Button */}
        <button
          onClick={handleClose}
          style={{
            position: 'absolute',
            top: '18px',
            right: '18px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '8px',
            width: '30px',
            height: '30px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#94a3b8',
            cursor: 'pointer'
          }}
          title="Dismiss"
        >
          <X size={16} />
        </button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '44px',
            height: '44px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(14, 165, 233, 0.35))',
            border: '1px solid rgba(56, 189, 248, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--primary)'
          }}>
            <ShieldCheck size={24} />
          </div>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: '#f8fafc' }}>
              Platform Permissions Setup
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '3px 0 0' }}>
              Configure sound, voice calls, and alerts for seamless operation.
            </p>
          </div>
        </div>

        {/* Step Progress Indicators */}
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          {[
            { label: 'Audio', icon: Volume2, done: status.audio, idx: 0 },
            { label: 'Mic', icon: Mic, done: status.mic, idx: 1 },
            { label: 'Alerts', icon: Bell, done: status.notification, idx: 2 }
          ].map(s => {
            const isCurrent = currentStep === s.idx;
            return (
              <div
                key={s.label}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 10px',
                  borderRadius: '10px',
                  background: s.done 
                    ? 'rgba(34, 197, 94, 0.15)' 
                    : isCurrent 
                      ? 'rgba(56, 189, 248, 0.18)' 
                      : 'rgba(255, 255, 255, 0.04)',
                  border: isCurrent 
                    ? '1px solid var(--primary)' 
                    : s.done 
                      ? '1px solid rgba(34, 197, 94, 0.4)' 
                      : '1px solid rgba(255, 255, 255, 0.06)',
                  color: s.done ? '#4ade80' : isCurrent ? 'var(--primary)' : 'var(--text-muted)',
                  fontSize: '11px',
                  fontWeight: 700
                }}
              >
                <s.icon size={14} />
                <span>{s.label}</span>
                {s.done && <CheckCircle2 size={12} style={{ marginLeft: 'auto', color: '#22c55e' }} />}
              </div>
            );
          })}
        </div>

        {/* Error message if any */}
        {errorMessage && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '10px',
            padding: '10px 12px',
            color: '#f87171',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <AlertCircle size={16} style={{ flexShrink: 0 }} />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* ── STEP 0: AUDIO ALERTS ── */}
        {currentStep === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{
              background: 'rgba(0, 0, 0, 0.3)',
              borderRadius: '14px',
              padding: '16px',
              border: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)', fontWeight: 700, fontSize: '14px', marginBottom: '6px' }}>
                <Volume2 size={18} /> Step 1: Sound & Audio Alerts
              </div>
              <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: 1.5, margin: 0 }}>
                Allow sound playback so incoming message chimes, voice call ringtones, and device streams play clearly with zero browser blocking.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleEnableAudio}
                className="btn btn-primary"
                style={{ flex: 1, padding: '12px', fontSize: '14px', fontWeight: 700, borderRadius: '10px', justifyContent: 'center' }}
              >
                <Volume2 size={16} /> Enable Sound Alerts
              </button>
              <button
                onClick={() => setCurrentStep(1)}
                className="btn btn-secondary"
                style={{ padding: '12px 16px', fontSize: '13px', borderRadius: '10px' }}
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 1: MICROPHONE ACCESS ── */}
        {currentStep === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{
              background: 'rgba(0, 0, 0, 0.3)',
              borderRadius: '14px',
              padding: '16px',
              border: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)', fontWeight: 700, fontSize: '14px', marginBottom: '6px' }}>
                <Mic size={18} /> Step 2: Microphone Permission
              </div>
              <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: 1.5, margin: 0 }}>
                Allow microphone access to make direct peer-to-peer voice calls with other workers and administrators inside the messaging system.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleRequestMic}
                disabled={loading}
                className="btn btn-primary"
                style={{ flex: 1, padding: '12px', fontSize: '14px', fontWeight: 700, borderRadius: '10px', justifyContent: 'center' }}
              >
                <Mic size={16} /> {loading ? 'Requesting...' : 'Allow Microphone'}
              </button>
              <button
                onClick={() => setCurrentStep(2)}
                className="btn btn-secondary"
                style={{ padding: '12px 16px', fontSize: '13px', borderRadius: '10px' }}
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: NOTIFICATIONS ── */}
        {currentStep === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{
              background: 'rgba(0, 0, 0, 0.3)',
              borderRadius: '14px',
              padding: '16px',
              border: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)', fontWeight: 700, fontSize: '14px', marginBottom: '6px' }}>
                <Bell size={18} /> Step 3: Incoming Call & Chat Notifications
              </div>
              <p style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: 1.5, margin: 0 }}>
                Allow notifications to receive instant alert popups when someone calls you or messages your 6-digit chat code, even if your browser is in the background.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleRequestNotification}
                disabled={loading}
                className="btn btn-primary"
                style={{ flex: 1, padding: '12px', fontSize: '14px', fontWeight: 700, borderRadius: '10px', justifyContent: 'center' }}
              >
                <Bell size={16} /> {loading ? 'Requesting...' : 'Allow Notifications'}
              </button>
              <button
                onClick={() => setCurrentStep(3)}
                className="btn btn-secondary"
                style={{ padding: '12px 16px', fontSize: '13px', borderRadius: '10px' }}
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: ALL COMPLETED ── */}
        {currentStep === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', textAlign: 'center', padding: '10px 0' }}>
            <div style={{
              width: '60px',
              height: '60px',
              borderRadius: '50%',
              background: 'rgba(34, 197, 94, 0.15)',
              border: '2px solid rgba(34, 197, 94, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#22c55e',
              margin: '0 auto 8px'
            }}>
              <CheckCircle2 size={32} />
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: '#f8fafc' }}>
              You're Ready to Go!
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
              All set. You can now chat, make live voice calls, and view device streams with full sound and alert support.
            </p>
            <button
              onClick={handleClose}
              className="btn btn-primary"
              style={{ padding: '12px', fontSize: '14px', fontWeight: 700, borderRadius: '10px', justifyContent: 'center', marginTop: '6px' }}
            >
              Enter FlexPulse Portal <ArrowRight size={16} />
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
