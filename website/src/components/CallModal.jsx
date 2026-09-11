import React from 'react';
import { useCall } from '../context/CallContext';
import { Phone, PhoneOff, Mic, MicOff, Volume2 } from 'lucide-react';

export default function CallModal() {
  const { 
    callState, 
    isMuted, 
    callDuration, 
    remoteAudioRef, 
    acceptCall, 
    declineCall, 
    endCall, 
    toggleMute 
  } = useCall();

  if (!callState) return null;

  const handleAcceptCall = () => {
    if (remoteAudioRef?.current) {
      remoteAudioRef.current.play().catch(() => {});
    }
    acceptCall();
  };

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isIncoming = callState.type === 'incoming';
  const isOutgoing = callState.type === 'outgoing';
  const isConnected = callState.type === 'connected';

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(2, 6, 23, 0.85)',
      backdropFilter: 'blur(16px)',
      zIndex: 100000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      animation: 'fadeIn 0.25s ease'
    }}>
      <style>{`
        @keyframes pulseRing {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.7); }
          70% { transform: scale(1.05); box-shadow: 0 0 0 20px rgba(56, 189, 248, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); }
        }
        @keyframes pulseGreen {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
          70% { transform: scale(1.05); box-shadow: 0 0 0 22px rgba(34, 197, 94, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
        }
      `}</style>

      <div style={{
        background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.98), rgba(30, 41, 59, 0.96))',
        border: isConnected 
          ? '1.5px solid rgba(34, 197, 94, 0.5)' 
          : '1.5px solid rgba(56, 189, 248, 0.5)',
        boxShadow: isConnected
          ? '0 25px 60px rgba(0, 0, 0, 0.85), 0 0 35px rgba(34, 197, 94, 0.25)'
          : '0 25px 60px rgba(0, 0, 0, 0.85), 0 0 35px rgba(56, 189, 248, 0.25)',
        borderRadius: '24px',
        maxWidth: '420px',
        width: '100%',
        padding: '36px 24px',
        color: '#f8fafc',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: '20px'
      }}>

        {/* Animated Avatar Icon */}
        <div style={{
          width: '90px',
          height: '90px',
          borderRadius: '50%',
          background: isConnected 
            ? 'linear-gradient(135deg, #10b981, #059669)' 
            : 'linear-gradient(135deg, var(--primary), var(--primary-hover))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#020617',
          animation: isConnected ? 'pulseGreen 2s infinite' : 'pulseRing 1.8s infinite',
          margin: '0 auto'
        }}>
          <Phone size={42} />
        </div>

        {/* Caller / Status Info */}
        <div>
          <div style={{
            fontSize: '12px',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            fontWeight: 800,
            color: isConnected ? '#4ade80' : 'var(--primary)',
            marginBottom: '6px'
          }}>
            {isIncoming && 'Incoming Voice Call...'}
            {isOutgoing && 'Calling...'}
            {isConnected && 'Call Connected'}
          </div>

          <h3 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 4px', color: '#f8fafc', wordBreak: 'break-word' }}>
            {callState.partnerEmail || `User #${callState.partnerCode}`}
          </h3>

          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'rgba(0,0,0,0.35)', padding: '3px 10px', borderRadius: '100px', border: '1px solid rgba(255,255,255,0.08)' }}>
            <span style={{ fontSize: '12px', fontFamily: 'monospace', color: 'var(--primary)', fontWeight: 700 }}>
              Chat Code: #{callState.partnerCode}
            </span>
          </div>

          {isConnected && (
            <div style={{
              fontSize: '24px',
              fontFamily: 'monospace',
              fontWeight: 800,
              color: '#38bdf8',
              marginTop: '12px',
              letterSpacing: '1px'
            }}>
              {formatDuration(callDuration)}
            </div>
          )}
        </div>

        {/* ── ACTION BUTTONS ── */}

        {/* 1. INCOMING CALL ACTIONS */}
        {isIncoming && (
          <div style={{ display: 'flex', gap: '16px', width: '100%', justifyContent: 'center', marginTop: '10px' }}>
            <button
              onClick={handleAcceptCall}
              style={{
                flex: 1,
                padding: '14px 20px',
                borderRadius: '14px',
                background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                color: '#fff',
                border: 'none',
                fontWeight: 800,
                fontSize: '15px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                boxShadow: '0 8px 20px rgba(34, 197, 94, 0.4)'
              }}
            >
              <Phone size={18} /> Accept
            </button>

            <button
              onClick={declineCall}
              style={{
                flex: 1,
                padding: '14px 20px',
                borderRadius: '14px',
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                color: '#fff',
                border: 'none',
                fontWeight: 800,
                fontSize: '15px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                boxShadow: '0 8px 20px rgba(239, 68, 68, 0.4)'
              }}
            >
              <PhoneOff size={18} /> Decline
            </button>
          </div>
        )}

        {/* 2. OUTGOING CALL ACTIONS */}
        {isOutgoing && (
          <div style={{ width: '100%', marginTop: '10px' }}>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              Ringing... Waiting for recipient to answer on site.
            </p>
            <button
              onClick={endCall}
              style={{
                width: '100%',
                padding: '14px 20px',
                borderRadius: '14px',
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                color: '#fff',
                border: 'none',
                fontWeight: 800,
                fontSize: '15px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                boxShadow: '0 8px 20px rgba(239, 68, 68, 0.4)'
              }}
            >
              <PhoneOff size={18} /> Cancel Call
            </button>
          </div>
        )}

        {/* 3. CONNECTED CALL ACTIONS */}
        {isConnected && (
          <div style={{ display: 'flex', gap: '14px', width: '100%', justifyContent: 'center', marginTop: '10px' }}>
            <button
              onClick={toggleMute}
              style={{
                flex: 1,
                padding: '12px',
                borderRadius: '12px',
                background: isMuted ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                border: isMuted ? '1px solid rgba(239, 68, 68, 0.5)' : '1px solid rgba(255, 255, 255, 0.15)',
                color: isMuted ? '#f87171' : '#f8fafc',
                fontWeight: 700,
                fontSize: '13px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
              }}
            >
              {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
              <span>{isMuted ? 'Unmute' : 'Mute Mic'}</span>
            </button>

            <button
              onClick={endCall}
              style={{
                flex: 1,
                padding: '12px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                color: '#fff',
                border: 'none',
                fontWeight: 800,
                fontSize: '14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                boxShadow: '0 6px 16px rgba(239, 68, 68, 0.4)'
              }}
            >
              <PhoneOff size={16} /> End Call
            </button>
          </div>
        )}

        {/* Dedicated remote voice audio playback element */}
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      </div>
    </div>
  );
}
