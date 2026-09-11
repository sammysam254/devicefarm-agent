import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { 
  playRingtone, 
  stopRingtone, 
  playOfflineSound, 
  playCallConnectedSound, 
  playCallEndedSound 
} from '../lib/soundEffects';

const CallContext = createContext();

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

export function CallProvider({ children }) {
  const { profile, user } = useAuth();
  const [callState, setCallState] = useState(null); 
  // callState: null | { type: 'incoming' | 'outgoing' | 'connected', session, partnerEmail, partnerCode }
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [onlineChatCodes, setOnlineChatCodes] = useState(new Set());

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const durationTimerRef = useRef(null);
  const activeSessionIdRef = useRef(null);

  // Initialize hidden remote audio element
  useEffect(() => {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    remoteAudioRef.current = audio;

    return () => {
      if (audio.parentNode) {
        audio.parentNode.removeChild(audio);
      }
    };
  }, []);

  // ── 1. Presence Tracking (Online / Offline detection on site) ───────────────
  useEffect(() => {
    if (!profile?.chat_code) return;

    // Heartbeat: update last_seen_at in profiles every 30s
    const heartbeat = async () => {
      try {
        await supabase
          .from('profiles')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', profile.id);
      } catch (_) {}
    };

    heartbeat();
    const hbTimer = setInterval(heartbeat, 30000);

    // Supabase Realtime Presence channel for instant sub-second online tracking
    const presenceChannel = supabase.channel('site-presence', {
      config: { presence: { key: profile.chat_code } }
    });

    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        const state = presenceChannel.presenceState();
        const activeCodes = new Set(Object.keys(state));
        setOnlineChatCodes(activeCodes);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({
            chat_code: profile.chat_code,
            email: profile.email,
            online_at: Date.now()
          });
        }
      });

    return () => {
      clearInterval(hbTimer);
      supabase.removeChannel(presenceChannel);
    };
  }, [profile?.chat_code, profile?.id]);

  // Check if a specific partner is currently online on site
  const checkIsUserOnline = async (partnerChatCode) => {
    if (!partnerChatCode) return false;

    // 1. Check Realtime Presence memory set
    if (onlineChatCodes.has(partnerChatCode)) return true;

    // 2. Query profile's last_seen_at (fallback within last 50 seconds)
    try {
      const { data } = await supabase
        .from('profiles')
        .select('last_seen_at')
        .eq('chat_code', partnerChatCode)
        .maybeSingle();

      if (data?.last_seen_at) {
        const lastSeen = new Date(data.last_seen_at).getTime();
        if (Date.now() - lastSeen < 50000) {
          return true;
        }
      }
    } catch (_) {}

    return false;
  };

  // ── 2. Listen for Incoming Calls & Session State Changes ───────────────────
  useEffect(() => {
    if (!profile?.chat_code) return;

    const channel = supabase
      .channel(`calls-listener-${profile.chat_code}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'call_sessions',
        filter: `recipient_chat_code=eq.${profile.chat_code}`,
      }, (payload) => {
        const sess = payload.new;
        if (sess.status === 'ringing') {
          activeSessionIdRef.current = sess.id;
          setCallState({
            type: 'incoming',
            session: sess,
            partnerEmail: sess.caller_email || `User #${sess.caller_chat_code}`,
            partnerCode: sess.caller_chat_code
          });
          playRingtone();

          // Native browser notification if tab in background
          if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
            try {
              new Notification('Incoming Voice Call', {
                body: `${sess.caller_email || 'User #' + sess.caller_chat_code} is calling you...`,
                icon: '/favicon.ico'
              });
            } catch (_) {}
          }
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'call_sessions',
      }, async (payload) => {
        const sess = payload.new;
        if (!activeSessionIdRef.current || activeSessionIdRef.current !== sess.id) return;

        // Recipient accepted: handle answer on caller side
        if (sess.status === 'connected' && callState?.type === 'outgoing') {
          stopRingtone();
          playCallConnectedSound();
          startDurationTimer();
          setCallState(prev => prev ? ({ ...prev, type: 'connected', session: sess }) : null);

          if (sess.answer && pcRef.current && pcRef.current.signalingState !== 'closed') {
            try {
              const remoteDesc = new RTCSessionDescription(sess.answer);
              await pcRef.current.setRemoteDescription(remoteDesc);
            } catch (err) {
              console.warn('Set remote description answer error:', err);
            }
          }
        }

        // Call ended or declined
        if (sess.status === 'ended' || sess.status === 'declined') {
          handleCleanupCall();
          playCallEndedSound();
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile?.chat_code, callState?.type]);

  // Duration timer
  const startDurationTimer = () => {
    setCallDuration(0);
    if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    durationTimerRef.current = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);
  };

  const handleCleanupCall = () => {
    stopRingtone();
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    setCallDuration(0);
    setCallState(null);
    activeSessionIdRef.current = null;

    // Stop and release local microphone
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }

    // Close WebRTC peer connection
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch (_) {}
      pcRef.current = null;
    }
  };

  // ── 3. Start Outgoing Call ────────────────────────────────────────────────
  const startCall = async (partnerCode, partnerEmail) => {
    if (!profile?.chat_code || !partnerCode) return { success: false, reason: 'invalid_code' };

    // Check if recipient is online on the site
    const isOnline = await checkIsUserOnline(partnerCode);
    if (!isOnline) {
      playOfflineSound();
      return { success: false, reason: 'offline' };
    }

    try {
      // 1. Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      // 2. Create WebRTC PeerConnection
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      // Add local audio tracks to PC
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Handle remote audio stream
      pc.ontrack = (event) => {
        if (remoteAudioRef.current && event.streams && event.streams[0]) {
          remoteAudioRef.current.srcObject = event.streams[0];
          remoteAudioRef.current.play().catch(() => {});
        }
      };

      // Create Offer
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      // Create call session in Supabase
      const { data: session, error } = await supabase
        .from('call_sessions')
        .insert([{
          caller_id: profile.id,
          caller_chat_code: profile.chat_code,
          caller_email: profile.email,
          recipient_chat_code: partnerCode,
          recipient_email: partnerEmail || `User #${partnerCode}`,
          status: 'ringing',
          offer: { type: offer.type, sdp: offer.sdp }
        }])
        .select()
        .single();

      if (error || !session) {
        throw error || new Error('Failed to initiate call session');
      }

      activeSessionIdRef.current = session.id;
      setCallState({
        type: 'outgoing',
        session,
        partnerEmail: partnerEmail || `User #${partnerCode}`,
        partnerCode
      });

      playRingtone();
      return { success: true };
    } catch (err) {
      console.error('Start call error:', err);
      handleCleanupCall();
      return { success: false, reason: 'mic_denied', error: err.message };
    }
  };

  // ── 4. Accept Incoming Call ───────────────────────────────────────────────
  const acceptCall = async () => {
    if (!callState?.session) return;
    const sess = callState.session;

    stopRingtone();

    try {
      // 1. Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      // 2. Create WebRTC PeerConnection
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.ontrack = (event) => {
        if (remoteAudioRef.current && event.streams && event.streams[0]) {
          remoteAudioRef.current.srcObject = event.streams[0];
          remoteAudioRef.current.play().catch(() => {});
        }
      };

      // Set Remote Offer
      if (sess.offer) {
        const remoteDesc = new RTCSessionDescription(sess.offer);
        await pc.setRemoteDescription(remoteDesc);
      }

      // Create Answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Update call session in Supabase
      await supabase
        .from('call_sessions')
        .update({
          status: 'connected',
          answer: { type: answer.type, sdp: answer.sdp },
          updated_at: new Date().toISOString()
        })
        .eq('id', sess.id);

      playCallConnectedSound();
      startDurationTimer();
      setCallState(prev => prev ? ({ ...prev, type: 'connected' }) : null);
    } catch (err) {
      console.error('Accept call error:', err);
      declineCall();
    }
  };

  // ── 5. Decline Incoming Call ──────────────────────────────────────────────
  const declineCall = async () => {
    if (callState?.session?.id) {
      await supabase
        .from('call_sessions')
        .update({ status: 'declined', updated_at: new Date().toISOString() })
        .eq('id', callState.session.id);
    }
    handleCleanupCall();
  };

  // ── 6. End Active Call / Cancel Outgoing ──────────────────────────────────
  const endCall = async () => {
    if (callState?.session?.id) {
      await supabase
        .from('call_sessions')
        .update({ status: 'ended', updated_at: new Date().toISOString() })
        .eq('id', callState.session.id);
    }
    playCallEndedSound();
    handleCleanupCall();
  };

  // Toggle Mute Microphone
  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const value = {
    callState,
    isMuted,
    callDuration,
    onlineChatCodes,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMute,
    checkIsUserOnline
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall() {
  return useContext(CallContext);
}
