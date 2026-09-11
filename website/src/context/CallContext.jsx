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
import { 
  registerServiceWorker, 
  syncPushSubscription, 
  dispatchOfflineCallAlert 
} from '../lib/pushNotifications';

const CallContext = createContext();

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  iceCandidatePoolSize: 10
};

// Helper: Wait for ICE candidates to be gathered into local description
const waitForIceGathering = (pc, maxWaitMs = 1500) => {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        cleanup();
      }
    };
    pc.addEventListener('icegatheringstatechange', onStateChange);
    const timer = setTimeout(cleanup, maxWaitMs);
  });
};

export function CallProvider({ children }) {
  const { profile, user } = useAuth();
  const [callState, setCallState] = useState(null); 
  // callState: null | { type: 'incoming' | 'outgoing' | 'connected', session, partnerEmail, partnerCode, isWaitingForOffline }
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [ringCountdown, setRingCountdown] = useState(45);
  const [onlineChatCodes, setOnlineChatCodes] = useState(new Set());

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const durationTimerRef = useRef(null);
  const ringCountdownTimerRef = useRef(null);
  const activeSessionIdRef = useRef(null);
  const callStateRef = useRef(null);
  const iceChannelRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const pollTimerRef = useRef(null);

  // Keep callStateRef synchronized
  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  // 1. Service Worker & Push Registration on startup
  useEffect(() => {
    registerServiceWorker();

    if (profile?.chat_code) {
      syncPushSubscription(profile.chat_code, profile.id);
    }

    // Listen for service worker notification clicks
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const handleSwMessage = (event) => {
        if (event.data?.type === 'INCOMING_CALL_ACTION') {
          if (event.data.action === 'answer') {
            acceptCall();
          } else if (event.data.action === 'decline') {
            declineCall();
          }
        }
      };
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
      return () => navigator.serviceWorker.removeEventListener('message', handleSwMessage);
    }
  }, [profile?.chat_code, profile?.id]);

  // 2. Check for active incoming calls on startup / window focus (wakes up receiver)
  useEffect(() => {
    if (!profile?.chat_code) return;

    const checkPendingCalls = async () => {
      if (callStateRef.current) return;
      try {
        const cutoff = new Date(Date.now() - 45000).toISOString();
        const { data: pending } = await supabase
          .from('call_sessions')
          .select('*')
          .eq('recipient_chat_code', profile.chat_code)
          .eq('status', 'ringing')
          .gt('created_at', cutoff)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (pending && !callStateRef.current) {
          activeSessionIdRef.current = pending.id;
          setCallState({
            type: 'incoming',
            session: pending,
            partnerEmail: pending.caller_email || `User #${pending.caller_chat_code}`,
            partnerCode: pending.caller_chat_code
          });
          playRingtone();
        }
      } catch (_) {}
    };

    checkPendingCalls();
    window.addEventListener('focus', checkPendingCalls);
    return () => window.removeEventListener('focus', checkPendingCalls);
  }, [profile?.chat_code]);

  // Initialize hidden remote audio element in DOM
  useEffect(() => {
    let audio = remoteAudioRef.current;
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = false;
      audio.volume = 1.0;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      remoteAudioRef.current = audio;
    }

    return () => {
      if (audio && audio.parentNode) {
        audio.parentNode.removeChild(audio);
        remoteAudioRef.current = null;
      }
    };
  }, []);

  // ── 3. Presence Tracking (Online / Offline detection on site) ───────────────
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

  // Helper to connect caller with recipient answer
  const handleConnectedFromAnswer = async (sess) => {
    if (callStateRef.current?.type !== 'outgoing') return;

    stopRingtone();
    if (ringCountdownTimerRef.current) {
      clearInterval(ringCountdownTimerRef.current);
      ringCountdownTimerRef.current = null;
    }
    playCallConnectedSound();
    startDurationTimer();
    setCallState(prev => prev ? ({ ...prev, type: 'connected', session: sess }) : null);

    if (sess.answer && pcRef.current && pcRef.current.signalingState !== 'closed') {
      try {
        console.log('[WebRTC] Applying recipient answer SDP:', sess.answer.type);
        const remoteDesc = new RTCSessionDescription(sess.answer);
        await pcRef.current.setRemoteDescription(remoteDesc);

        // Flush any queued remote ICE candidates
        while (pendingCandidatesRef.current.length > 0) {
          const cand = pendingCandidatesRef.current.shift();
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(cand));
            console.log('[WebRTC] Flushed queued ICE candidate on caller');
          } catch (_) {}
        }
      } catch (err) {
        console.warn('[WebRTC] Set remote description answer error:', err);
      }
    }
  };

  // ── 4. Listen for Incoming Calls & Session State Changes (Stable Listener) ──
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
                icon: '/favicon.ico',
                requireInteraction: true
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
        if (sess.status === 'connected') {
          await handleConnectedFromAnswer(sess);
        }

        // Call ended, declined, or missed
        if (sess.status === 'ended' || sess.status === 'declined' || sess.status === 'missed') {
          handleCleanupCall();
          playCallEndedSound();
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile?.chat_code]);

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
    if (ringCountdownTimerRef.current) {
      clearInterval(ringCountdownTimerRef.current);
      ringCountdownTimerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (iceChannelRef.current) {
      supabase.removeChannel(iceChannelRef.current);
      iceChannelRef.current = null;
    }
    pendingCandidatesRef.current = [];
    setCallDuration(0);
    setRingCountdown(45);
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

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  };

  // Setup PeerConnection with all audio and ICE listeners
  const setupPeerConnection = (sessionId) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    // Handle remote audio stream arrival
    pc.ontrack = (event) => {
      console.log('[WebRTC] ontrack received:', event.track.kind, event.streams);
      const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.muted = false;
        remoteAudioRef.current.volume = 1.0;
        remoteAudioRef.current.play()
          .then(() => console.log('[WebRTC] Remote voice stream is now playing'))
          .catch((err) => console.warn('[WebRTC] Remote audio play error:', err));
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE connection state:', pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
    };

    // Setup Realtime Broadcast channel for Trickle ICE candidates
    const iceChannel = supabase.channel(`call-ice-${sessionId}`);
    iceChannelRef.current = iceChannel;

    iceChannel
      .on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
        if (!payload || payload.sender === profile.chat_code) return;
        const candidate = payload.candidate;
        if (!candidate) return;

        if (pcRef.current && pcRef.current.remoteDescription && pcRef.current.remoteDescription.type) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('[WebRTC] Realtime ICE candidate added successfully');
          } catch (e) {
            console.warn('[WebRTC] Error adding ICE candidate:', e);
          }
        } else {
          pendingCandidatesRef.current.push(candidate);
        }
      })
      .subscribe();

    pc.onicecandidate = (event) => {
      if (event.candidate && iceChannelRef.current) {
        iceChannelRef.current.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: {
            candidate: event.candidate.toJSON(),
            sender: profile.chat_code
          }
        }).catch(() => {});
      }
    };

    return pc;
  };

  // ── 5. Start Outgoing Call (Supports reaching offline users with 45s ringing) ──
  const startCall = async (partnerCode, partnerEmail) => {
    if (!profile?.chat_code || !partnerCode) return { success: false, reason: 'invalid_code' };

    // Prime the remote audio element
    if (remoteAudioRef.current) {
      remoteAudioRef.current.play().catch(() => {});
    }

    // Check if recipient is active on the site (used to customize status display)
    const isOnline = await checkIsUserOnline(partnerCode);

    try {
      // 1. Get microphone stream with clear voice constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      localStreamRef.current = stream;

      // Temporary session placeholder to create channel
      const tempSessionId = crypto.randomUUID();
      const pc = setupPeerConnection(tempSessionId);

      // Add microphone tracks to connection
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Create Offer SDP
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering so candidates are embedded in SDP
      await waitForIceGathering(pc, 1500);
      const finalOffer = pc.localDescription || offer;

      // Create call session in Supabase with embedded offer
      const { data: session, error } = await supabase
        .from('call_sessions')
        .insert([{
          id: tempSessionId,
          caller_id: profile.id,
          caller_chat_code: profile.chat_code,
          caller_email: profile.email,
          recipient_chat_code: partnerCode,
          recipient_email: partnerEmail || `User #${partnerCode}`,
          status: 'ringing',
          offer: { type: finalOffer.type, sdp: finalOffer.sdp }
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
        partnerCode,
        isWaitingForOffline: !isOnline
      });

      // Dispatch background push alert to reach offline user's device
      dispatchOfflineCallAlert(partnerCode, session);

      playRingtone();

      // Start 45-second ringing countdown timer
      setRingCountdown(45);
      if (ringCountdownTimerRef.current) clearInterval(ringCountdownTimerRef.current);
      ringCountdownTimerRef.current = setInterval(() => {
        setRingCountdown(prev => {
          if (prev <= 1) {
            clearInterval(ringCountdownTimerRef.current);
            // 45 seconds expired without answer -> Mark as missed
            if (callStateRef.current?.type === 'outgoing' && activeSessionIdRef.current) {
              supabase
                .from('call_sessions')
                .update({ status: 'missed', updated_at: new Date().toISOString() })
                .eq('id', activeSessionIdRef.current);
              handleCleanupCall();
              playOfflineSound();
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      // Polling fallback: check every 1000ms if session is answered
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = setInterval(async () => {
        if (callStateRef.current?.type !== 'outgoing' || !activeSessionIdRef.current) {
          clearInterval(pollTimerRef.current);
          return;
        }
        try {
          const { data: latestSess } = await supabase
            .from('call_sessions')
            .select('*')
            .eq('id', activeSessionIdRef.current)
            .maybeSingle();

          if (latestSess?.status === 'connected' && latestSess.answer && callStateRef.current?.type === 'outgoing') {
            clearInterval(pollTimerRef.current);
            await handleConnectedFromAnswer(latestSess);
          } else if (latestSess?.status === 'declined' || latestSess?.status === 'ended' || latestSess?.status === 'missed') {
            clearInterval(pollTimerRef.current);
            handleCleanupCall();
            playCallEndedSound();
          }
        } catch (_) {}
      }, 1000);

      return { success: true, isRecipientOnline: isOnline };
    } catch (err) {
      console.error('Start call error:', err);
      handleCleanupCall();
      return { success: false, reason: 'mic_denied', error: err.message };
    }
  };

  // ── 6. Accept Incoming Call ───────────────────────────────────────────────
  const acceptCall = async () => {
    if (!callState?.session) return;
    const sess = callState.session;

    stopRingtone();
    if (ringCountdownTimerRef.current) {
      clearInterval(ringCountdownTimerRef.current);
      ringCountdownTimerRef.current = null;
    }

    // Prime remote audio element on click
    if (remoteAudioRef.current) {
      remoteAudioRef.current.play().catch(() => {});
    }

    try {
      // 1. Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      localStreamRef.current = stream;

      // 2. Setup PeerConnection
      const pc = setupPeerConnection(sess.id);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // 3. Set Remote Description from Caller's Offer
      if (sess.offer) {
        console.log('[WebRTC] Recipient setting remote offer SDP');
        const remoteDesc = new RTCSessionDescription(sess.offer);
        await pc.setRemoteDescription(remoteDesc);

        // Flush any candidates received early
        while (pendingCandidatesRef.current.length > 0) {
          const cand = pendingCandidatesRef.current.shift();
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
            console.log('[WebRTC] Flushed queued candidate on recipient');
          } catch (_) {}
        }
      }

      // 4. Create Answer SDP
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for ICE gathering so candidates are embedded in Answer SDP
      await waitForIceGathering(pc, 1500);
      const finalAnswer = pc.localDescription || answer;

      // 5. Update call session in Supabase with embedded answer
      await supabase
        .from('call_sessions')
        .update({
          status: 'connected',
          answer: { type: finalAnswer.type, sdp: finalAnswer.sdp },
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

  // ── 7. Decline Incoming Call ──────────────────────────────────────────────
  const declineCall = async () => {
    if (callState?.session?.id) {
      await supabase
        .from('call_sessions')
        .update({ status: 'declined', updated_at: new Date().toISOString() })
        .eq('id', callState.session.id);
    }
    handleCleanupCall();
  };

  // ── 8. End Active Call / Cancel Outgoing ──────────────────────────────────
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
    ringCountdown,
    onlineChatCodes,
    remoteAudioRef,
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
