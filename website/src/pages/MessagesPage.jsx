import React, { useState, useEffect, useRef } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import SEO from '../components/SEO';
import { useAuth } from '../context/AuthContext';
import { useCall } from '../context/CallContext';
import { supabase } from '../lib/supabase';
import { playDingSound } from '../lib/soundEffects';
import { 
  MessageSquare, 
  Send, 
  Copy, 
  Check, 
  Search, 
  Users, 
  Smartphone, 
  Clock, 
  Hash, 
  User, 
  ShieldCheck, 
  RefreshCw,
  ArrowLeft,
  Phone,
  PhoneOff,
  AlertCircle
} from 'lucide-react';

export default function MessagesPage() {
  const { profile, user } = useAuth();
  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'directory'
  const [mobileView, setMobileView] = useState('list'); // 'list' | 'chat'
  const [myCodeCopied, setMyCodeCopied] = useState(false);

  // Conversations & active chat
  const [conversations, setConversations] = useState([]);
  const [activePartnerCode, setActivePartnerCode] = useState(null);
  const [activePartnerInfo, setActivePartnerInfo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [connectCodeInput, setConnectCodeInput] = useState('');
  const [connectError, setConnectError] = useState('');
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Admin directory state
  const [directoryUsers, setDirectoryUsers] = useState([]);
  const [directorySearch, setDirectorySearch] = useState('');
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [copiedCodeMap, setCopiedCodeMap] = useState({});

  // Voice calling & presence integration
  const { startCall, onlineChatCodes } = useCall();
  const [callNotice, setCallNotice] = useState(null);

  const messagesEndRef = useRef(null);
  const chatChannelRef = useRef(null);

  const role = profile?.role || 'worker';
  const isAdmin = role === 'admin' || role === 'super_admin' || role === 'seed_admin';

  // Copy my chat code helper
  const handleCopyMyCode = () => {
    if (!profile?.chat_code) return;
    navigator.clipboard.writeText(profile.chat_code);
    setMyCodeCopied(true);
    setTimeout(() => setMyCodeCopied(false), 2000);
  };

  const handleCopyAnyCode = (code) => {
    navigator.clipboard.writeText(code);
    setCopiedCodeMap(prev => ({ ...prev, [code]: true }));
    setTimeout(() => {
      setCopiedCodeMap(prev => ({ ...prev, [code]: false }));
    }, 2000);
  };

  // Voice call initiator with offline sound & notice handling
  const handleInitiateCall = async (targetCode, targetEmail) => {
    const code = targetCode || activePartnerCode;
    const email = targetEmail || activePartnerInfo?.email;
    if (!code) return;

    setCallNotice(null);
    const res = await startCall(code, email);
    if (!res?.success) {
      if (res?.reason === 'offline') {
        setCallNotice({
          type: 'error',
          message: `User #${code} is currently offline (not active on site).`
        });
      } else {
        setCallNotice({
          type: 'error',
          message: res?.message || 'Call could not be connected. Please verify microphone permissions.'
        });
      }
      setTimeout(() => setCallNotice(null), 6000);
    }
  };

  // 1. Fetch Conversations list for the current user
  const loadConversations = async () => {
    if (!profile?.chat_code) return;

    try {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .or(`sender_chat_code.eq.${profile.chat_code},recipient_chat_code.eq.${profile.chat_code}`)
        .order('created_at', { ascending: false });

      if (error) {
        console.warn('Error fetching conversations:', error);
        return;
      }

      // Group by chat partner code
      const map = new Map();
      for (const msg of (data || [])) {
        const isMeSender = msg.sender_chat_code === profile.chat_code;
        const partnerCode = isMeSender ? msg.recipient_chat_code : msg.sender_chat_code;
        const partnerEmail = isMeSender ? '' : (msg.sender_email || '');

        if (!map.has(partnerCode)) {
          map.set(partnerCode, {
            partnerCode,
            partnerEmail: partnerEmail || `User #${partnerCode}`,
            lastMessage: msg.message,
            lastTime: msg.created_at,
            unreadCount: (!isMeSender && !msg.is_read) ? 1 : 0,
          });
        } else {
          const item = map.get(partnerCode);
          if (!item.partnerEmail && partnerEmail) {
            item.partnerEmail = partnerEmail;
          }
          if (!isMeSender && !msg.is_read) {
            item.unreadCount = (item.unreadCount || 0) + 1;
          }
        }
      }

      // Query profiles to resolve accurate partner emails
      const partnerCodes = Array.from(map.keys());
      if (partnerCodes.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('email, chat_code, role')
          .in('chat_code', partnerCodes);

        if (profs) {
          profs.forEach(p => {
            if (map.has(p.chat_code)) {
              const it = map.get(p.chat_code);
              it.partnerEmail = p.email || it.partnerEmail;
              it.partnerRole = p.role;
            }
          });
        }
      }

      setConversations(Array.from(map.values()));
    } catch (e) {
      console.warn('Conversations fetch error:', e);
    }
  };

  useEffect(() => {
    loadConversations();
  }, [profile?.chat_code]);

  // 2. Fetch Active Conversation Messages & Mark Read
  const loadMessages = async (partnerCode) => {
    if (!profile?.chat_code || !partnerCode) return;
    setLoadingMessages(true);

    try {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('*')
        .or(`and(sender_chat_code.eq.${profile.chat_code},recipient_chat_code.eq.${partnerCode}),and(sender_chat_code.eq.${partnerCode},recipient_chat_code.eq.${profile.chat_code})`)
        .order('created_at', { ascending: true });

      if (!error && data) {
        setMessages(data);
        // Mark unread messages sent to me as read
        const unreadIds = data
          .filter(m => m.recipient_chat_code === profile.chat_code && !m.is_read)
          .map(m => m.id);

        if (unreadIds.length > 0) {
          await supabase
            .from('chat_messages')
            .update({ is_read: true })
            .in('id', unreadIds);

          // Refresh sidebar & convos unread counts
          loadConversations();
        }
      }
    } catch (e) {
      console.warn('Load messages error:', e);
    } finally {
      setLoadingMessages(false);
    }
  };

  // Set active conversation partner
  const selectPartner = async (partnerCode, optionalEmail = '') => {
    setActivePartnerCode(partnerCode);
    setActiveTab('chats');
    setMobileView('chat'); // Switch to chat view on mobile
    setConnectError('');

    // Fetch partner info
    try {
      const { data: prof } = await supabase
        .from('profiles')
        .select('id, email, chat_code, role')
        .eq('chat_code', partnerCode)
        .maybeSingle();

      if (prof) {
        setActivePartnerInfo(prof);
      } else {
        setActivePartnerInfo({
          chat_code: partnerCode,
          email: optionalEmail || `User #${partnerCode}`,
          role: 'user'
        });
      }
    } catch (_) {
      setActivePartnerInfo({
        chat_code: partnerCode,
        email: optionalEmail || `User #${partnerCode}`,
        role: 'user'
      });
    }

    loadMessages(partnerCode);
  };

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 3. Realtime Chat Subscription for incoming and outgoing messages
  useEffect(() => {
    if (!profile?.chat_code) return;

    const channel = supabase
      .channel(`chat-main-stream-${profile.chat_code}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages',
      }, (payload) => {
        const msg = payload.new;
        const isForMe = msg.recipient_chat_code === profile.chat_code;
        const isFromMe = msg.sender_chat_code === profile.chat_code;

        if (!isForMe && !isFromMe) return;

        // If message is in currently active chat
        if (
          (activePartnerCode && msg.sender_chat_code === activePartnerCode && isForMe) ||
          (activePartnerCode && msg.recipient_chat_code === activePartnerCode && isFromMe)
        ) {
          setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
          });

          if (isForMe) {
            playDingSound();
            // Automatically mark read since we have the window open
            supabase
              .from('chat_messages')
              .update({ is_read: true })
              .eq('id', msg.id);
          }
        } else {
          // If message is from another user
          if (isForMe) {
            playDingSound();
          }
        }

        loadConversations();
      })
      .subscribe();

    chatChannelRef.current = channel;

    return () => {
      if (chatChannelRef.current) {
        supabase.removeChannel(chatChannelRef.current);
      }
    };
  }, [profile?.chat_code, activePartnerCode]);

  // 4. Send Message
  const handleSendMessage = async (e) => {
    if (e) e.preventDefault();
    const text = inputText.trim();
    if (!text || !activePartnerCode || !profile?.chat_code) return;

    setInputText('');

    try {
      const { data, error } = await supabase
        .from('chat_messages')
        .insert([{
          sender_id: user?.id || profile.id,
          sender_email: profile.email,
          sender_chat_code: profile.chat_code,
          recipient_id: activePartnerInfo?.id || null,
          recipient_chat_code: activePartnerCode,
          message: text,
          is_read: false
        }])
        .select()
        .single();

      if (error) {
        console.error('Send message error:', error);
        alert('Failed to send message: ' + error.message);
      } else if (data) {
        setMessages(prev => {
          if (prev.some(m => m.id === data.id)) return prev;
          return [...prev, data];
        });
        loadConversations();
      }
    } catch (err) {
      console.error('Send message exception:', err);
    }
  };

  // 5. Connect by 6-digit Code
  const handleConnectByCode = async (e) => {
    e.preventDefault();
    const code = connectCodeInput.trim();
    if (!code) return;

    if (code === profile?.chat_code) {
      setConnectError("You cannot start a chat with your own code.");
      return;
    }

    if (!/^\d{6}$/.test(code)) {
      setConnectError("Please enter a valid 6-digit code (e.g. 583921).");
      return;
    }

    // Verify code exists in profiles
    try {
      const { data: prof, error } = await supabase
        .from('profiles')
        .select('id, email, chat_code, role')
        .eq('chat_code', code)
        .maybeSingle();

      if (error || !prof) {
        selectPartner(code, `User #${code}`);
      } else {
        selectPartner(code, prof.email);
      }
      setConnectCodeInput('');
      setConnectError('');
    } catch (err) {
      selectPartner(code, `User #${code}`);
      setConnectCodeInput('');
      setConnectError('');
    }
  };

  // 6. Admin Directory: Fetch all users, emails, chat codes, and assigned devices
  const loadDirectory = async () => {
    if (!isAdmin) return;
    setLoadingDirectory(true);

    try {
      const { data: profilesData, error: pErr } = await supabase
        .from('profiles')
        .select('id, email, role, chat_code, is_blocked, created_at')
        .order('created_at', { ascending: false });

      if (pErr) throw pErr;

      // Fetch device assignments to correlate serials
      const { data: assignData, error: aErr } = await supabase
        .from('device_assignments')
        .select('user_id, devices(serial, custom_name)');

      const assignmentsByUser = new Map();
      if (!aErr && assignData) {
        assignData.forEach(a => {
          if (!a.user_id) return;
          const current = assignmentsByUser.get(a.user_id) || [];
          const serial = a.devices?.serial;
          if (serial && !current.includes(serial)) {
            current.push(serial);
          }
          assignmentsByUser.set(a.user_id, current);
        });
      }

      const merged = (profilesData || []).map(p => ({
        ...p,
        device_serials: assignmentsByUser.get(p.id) || []
      }));

      setDirectoryUsers(merged);
    } catch (err) {
      console.warn('Error loading admin user directory:', err);
    } finally {
      setLoadingDirectory(false);
    }
  };

  useEffect(() => {
    if (isAdmin && activeTab === 'directory') {
      loadDirectory();
    }
  }, [isAdmin, activeTab]);

  const filteredDirectory = directoryUsers.filter(u => {
    const q = directorySearch.toLowerCase().trim();
    if (!q) return true;
    return (
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.chat_code && u.chat_code.includes(q)) ||
      (u.role && u.role.toLowerCase().includes(q)) ||
      (u.device_serials && u.device_serials.some(s => s.toLowerCase().includes(q)))
    );
  });

  return (
    <DashboardLayout>
      <SEO
        title="Direct Messages & Chat — FlexPulse Cloud"
        description="Encrypted peer-to-peer messaging system with 6-digit chat codes and in-stream alerts."
        noIndex={true}
      />

      <style>{`
        /* Responsive Mobile Styles */
        .chat-main-grid {
          display: grid;
          grid-template-columns: minmax(280px, 340px) 1fr;
          gap: 16px;
          height: calc(100vh - 200px);
          min-height: 560px;
        }

        .chat-left-col {
          display: flex;
          flex-direction: column;
          gap: 14px;
          background: var(--bg-card);
          border-radius: 16px;
          border: 1px solid var(--border-color);
          padding: 16px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.3);
          overflow: hidden;
          height: 100%;
        }

        .chat-right-col {
          display: flex;
          flex-direction: column;
          background: var(--bg-card);
          border-radius: 16px;
          border: 1px solid var(--border-color);
          overflow: hidden;
          box-shadow: 0 8px 24px rgba(0,0,0,0.3);
          height: 100%;
        }

        .mobile-back-btn {
          display: none !important;
        }

        .top-code-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 14px;
          padding: 16px 20px;
        }

        .top-code-badge {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        /* Mobile specific query */
        @media (max-width: 768px) {
          .chat-main-grid {
            display: flex;
            flex-direction: column;
            gap: 0;
            height: calc(100dvh - 150px);
            min-height: 480px;
          }

          .chat-left-col {
            display: ${mobileView === 'list' ? 'flex' : 'none'} !important;
            width: 100%;
            height: 100%;
            padding: 12px;
            border-radius: 14px;
          }

          .chat-right-col {
            display: ${mobileView === 'chat' ? 'flex' : 'none'} !important;
            width: 100%;
            height: 100%;
            border-radius: 14px;
          }

          .mobile-back-btn {
            display: inline-flex !important;
          }

          .top-code-banner {
            padding: 12px 14px;
            gap: 10px;
          }

          .top-code-badge {
            width: 100%;
            justify-content: space-between;
          }

          .chat-msg-bubble {
            max-width: 88% !important;
            font-size: 13.5px !important;
          }

          .msg-input-field {
            font-size: 16px !important; /* Prevents auto-zoom on iOS Safari */
          }

          .call-btn-text {
            display: inline;
          }

          @media (max-width: 640px) {
            .call-btn-text {
              display: none;
            }
          }
        }
      `}</style>

      <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        
        {/* Top Header Card: User's Own 6-Digit Chat Code */}
        <div 
          className="top-code-banner"
          style={{
            background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.85), rgba(15, 23, 42, 0.95))',
            borderRadius: '16px',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '44px',
              height: '44px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(14, 165, 233, 0.35))',
              border: '1px solid rgba(56, 189, 248, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--primary)',
              flexShrink: 0
            }}>
              <MessageSquare size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h1 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: '#f8fafc' }}>
                  Platform Messages & Live Chat
                </h1>
                <span style={{
                  background: 'rgba(34, 197, 94, 0.15)',
                  color: '#22c55e',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  padding: '2px 7px',
                  borderRadius: '100px',
                  fontSize: '10px',
                  fontWeight: 700
                }}>
                  LIVE
                </span>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '2px 0 0' }}>
                Connect by 6-digit code. In-stream messages pop up with an audio ding alert.
              </p>
            </div>
          </div>

          {/* User's Chat Code Display */}
          <div 
            className="top-code-badge"
            style={{
              background: 'rgba(15, 23, 42, 0.75)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '12px',
              padding: '8px 14px'
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)', fontWeight: 700 }}>
                My Chat Code
              </span>
              <span style={{
                fontFamily: 'monospace',
                fontSize: '18px',
                fontWeight: 800,
                color: 'var(--primary)',
                letterSpacing: '2px'
              }}>
                {profile?.chat_code || '------'}
              </span>
            </div>
            <button
              onClick={handleCopyMyCode}
              className="btn btn-secondary"
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                borderRadius: '8px'
              }}
              title="Copy your 6-digit chat code"
            >
              {myCodeCopied ? <Check size={13} color="#22c55e" /> : <Copy size={13} />}
              <span>{myCodeCopied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>

        {/* Tab Switcher (For Admins) */}
        {isAdmin && (
          <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
            <button
              onClick={() => setActiveTab('chats')}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: 'none',
                background: activeTab === 'chats' ? 'linear-gradient(135deg, var(--primary), var(--primary-hover))' : 'rgba(255, 255, 255, 0.05)',
                color: activeTab === 'chats' ? '#fff' : 'var(--text-muted)',
                fontWeight: 700,
                fontSize: '13px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.2s ease'
              }}
            >
              <MessageSquare size={15} /> Direct Chats
            </button>
            <button
              onClick={() => setActiveTab('directory')}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: 'none',
                background: activeTab === 'directory' ? 'linear-gradient(135deg, var(--primary), var(--primary-hover))' : 'rgba(255, 255, 255, 0.05)',
                color: activeTab === 'directory' ? '#fff' : 'var(--text-muted)',
                fontWeight: 700,
                fontSize: '13px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.2s ease'
              }}
            >
              <Users size={15} /> Users & Codes Directory
            </button>
          </div>
        )}

        {/* ── TAB 1: DIRECT CHATS ────────────────────────────────────────── */}
        {activeTab === 'chats' && (
          <div className="chat-main-grid">
            
            {/* Left Panel: Connect Code & Conversations List */}
            <div className="chat-left-col">
              
              {/* Connect by 6-Digit Code Box */}
              <div style={{
                background: 'rgba(15, 23, 42, 0.7)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: '12px',
                padding: '12px'
              }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Hash size={13} color="var(--primary)" /> Connect by 6-Digit Code
                </div>
                <form onSubmit={handleConnectByCode} style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="e.g. 482915"
                    value={connectCodeInput}
                    onChange={(e) => setConnectCodeInput(e.target.value.replace(/\D/g, ''))}
                    className="msg-input-field"
                    style={{
                      flex: 1,
                      padding: '8px 10px',
                      background: 'rgba(0, 0, 0, 0.3)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '14px',
                      letterSpacing: '1px',
                      fontFamily: 'monospace',
                      outline: 'none'
                    }}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ padding: '8px 12px', fontSize: '12px', fontWeight: 700, borderRadius: '8px', flexShrink: 0 }}
                  >
                    Connect
                  </button>
                </form>
                {connectError && (
                  <div style={{ color: '#ef4444', fontSize: '11px', marginTop: '6px', fontWeight: 600 }}>
                    {connectError}
                  </div>
                )}
              </div>

              {/* Conversations Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
                <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)', fontWeight: 700 }}>
                  Recent Chats ({conversations.length})
                </span>
                <button
                  onClick={loadConversations}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
                >
                  <RefreshCw size={11} /> Refresh
                </button>
              </div>

              {/* Conversations Scrollable List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto', flex: 1 }}>
                {conversations.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '30px 14px', color: 'var(--text-muted)' }}>
                    <MessageSquare size={28} style={{ opacity: 0.3, marginBottom: '8px' }} />
                    <p style={{ fontSize: '12px', margin: 0 }}>No conversations yet.</p>
                    <p style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>
                      Enter a 6-digit code above to connect!
                    </p>
                  </div>
                ) : (
                  conversations.map((c) => {
                    const isSelected = activePartnerCode === c.partnerCode;
                    return (
                      <div
                        key={c.partnerCode}
                        onClick={() => selectPartner(c.partnerCode, c.partnerEmail)}
                        style={{
                          padding: '10px 12px',
                          borderRadius: '10px',
                          background: isSelected 
                            ? 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(14, 165, 233, 0.25))' 
                            : 'rgba(255, 255, 255, 0.02)',
                          border: isSelected ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <div style={{
                          width: '36px',
                          height: '36px',
                          borderRadius: '8px',
                          background: isSelected ? 'var(--primary)' : 'rgba(255, 255, 255, 0.06)',
                          color: isSelected ? '#000' : 'var(--text-main)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 800,
                          fontSize: '13px',
                          flexShrink: 0
                        }}>
                          {c.partnerEmail ? c.partnerEmail[0].toUpperCase() : '#'}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '13px', fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {c.partnerEmail || `User #${c.partnerCode}`}
                            </span>
                            <span style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--primary)', fontWeight: 700 }}>
                              #{c.partnerCode}
                            </span>
                          </div>
                          <p style={{
                            fontSize: '11px',
                            color: isSelected ? '#cbd5e1' : 'var(--text-muted)',
                            margin: '2px 0 0',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                          }}>
                            {c.lastMessage || 'Connected'}
                          </p>
                        </div>
                        {c.unreadCount > 0 && (
                          <span style={{
                            background: '#ef4444',
                            color: '#fff',
                            fontSize: '10px',
                            fontWeight: 800,
                            padding: '2px 6px',
                            borderRadius: '100px',
                            boxShadow: '0 0 8px rgba(239, 68, 68, 0.7)'
                          }}>
                            {c.unreadCount}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Panel: Active Chat Thread */}
            <div className="chat-right-col">
              {activePartnerCode ? (
                <>
                  {/* Chat Header */}
                  <div style={{
                    padding: '12px 16px',
                    background: 'rgba(15, 23, 42, 0.85)',
                    borderBottom: '1px solid var(--border-color)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '10px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                      
                      {/* Mobile Back Button */}
                      <button
                        onClick={() => setMobileView('list')}
                        className="mobile-back-btn btn btn-secondary"
                        style={{
                          padding: '6px 10px',
                          borderRadius: '8px',
                          fontSize: '12px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontWeight: 700
                        }}
                        title="Back to conversations"
                      >
                        <ArrowLeft size={14} /> Back
                      </button>

                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '10px',
                        background: 'linear-gradient(135deg, var(--primary), var(--primary-hover))',
                        color: '#000',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 800,
                        fontSize: '14px',
                        flexShrink: 0
                      }}>
                        {activePartnerInfo?.email ? activePartnerInfo.email[0].toUpperCase() : '#'}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '14px', fontWeight: 800, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {activePartnerInfo?.email || `User #${activePartnerCode}`}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
                          <span style={{ color: 'var(--primary)', fontFamily: 'monospace', fontWeight: 700 }}>
                            #{activePartnerCode}
                          </span>
                          <span style={{ color: 'var(--text-dim)' }}>•</span>
                          {onlineChatCodes?.has(activePartnerCode) ? (
                            <span style={{ color: '#22c55e', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
                              Online
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-dim)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#64748b' }} />
                              Offline
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {/* Voice Call Button */}
                      <button
                        onClick={() => handleInitiateCall(activePartnerCode, activePartnerInfo?.email)}
                        className="btn"
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          borderRadius: '8px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          background: 'linear-gradient(135deg, #10b981, #059669)',
                          border: '1px solid rgba(16, 185, 129, 0.4)',
                          color: '#fff',
                          fontWeight: 700,
                          cursor: 'pointer',
                          boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)',
                          transition: 'all 0.2s ease',
                          flexShrink: 0
                        }}
                        title={`Voice Call User #${activePartnerCode}`}
                      >
                        <Phone size={13} />
                        <span className="call-btn-text">Voice Call</span>
                      </button>

                      <button
                        onClick={() => handleCopyAnyCode(activePartnerCode)}
                        className="btn btn-secondary"
                        style={{ padding: '6px 10px', fontSize: '11px', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
                      >
                        {copiedCodeMap[activePartnerCode] ? <Check size={12} color="#22c55e" /> : <Copy size={12} />}
                        <span>{copiedCodeMap[activePartnerCode] ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Offline / Call Status Banner */}
                  {callNotice && (
                    <div style={{
                      padding: '10px 14px',
                      background: 'rgba(239, 68, 68, 0.15)',
                      borderBottom: '1px solid rgba(239, 68, 68, 0.3)',
                      color: '#fca5a5',
                      fontSize: '12px',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      animation: 'fadeIn 0.2s ease'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <AlertCircle size={15} color="#ef4444" style={{ flexShrink: 0 }} />
                        <span>{callNotice.message}</span>
                      </div>
                      <button 
                        onClick={() => setCallNotice(null)} 
                        style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: '14px', padding: '0 4px' }}
                      >
                        ✕
                      </button>
                    </div>
                  )}

                  {/* Message Stream */}
                  <div style={{
                    flex: 1,
                    padding: '14px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    background: 'radial-gradient(circle at 50% 10%, rgba(56, 189, 248, 0.03), transparent 70%)'
                  }}>
                    {loadingMessages ? (
                      <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--text-muted)' }}>
                        <RefreshCw size={20} className="spin" style={{ marginBottom: '6px' }} />
                        <p style={{ fontSize: '12px' }}>Loading conversation...</p>
                      </div>
                    ) : messages.length === 0 ? (
                      <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--text-muted)', maxWidth: '320px', padding: '20px' }}>
                        <div style={{ fontSize: '28px', marginBottom: '6px' }}>💬</div>
                        <h4 style={{ color: '#fff', fontSize: '15px', fontWeight: 700, margin: '0 0 4px' }}>Connected Channel</h4>
                        <p style={{ fontSize: '12px', margin: 0, lineHeight: 1.5 }}>
                          Send a message! In-stream alerts will pop up automatically with a chime.
                        </p>
                      </div>
                    ) : (
                      messages.map((m) => {
                        const isMe = m.sender_chat_code === profile?.chat_code;
                        const timeStr = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        return (
                          <div
                            key={m.id}
                            className="chat-msg-bubble"
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: isMe ? 'flex-end' : 'flex-start',
                              maxWidth: '80%',
                              alignSelf: isMe ? 'flex-end' : 'flex-start'
                            }}
                          >
                            <div style={{
                              padding: '9px 14px',
                              borderRadius: isMe ? '14px 14px 3px 14px' : '14px 14px 14px 3px',
                              background: isMe 
                                ? 'linear-gradient(135deg, var(--primary), var(--primary-hover))' 
                                : 'rgba(255, 255, 255, 0.07)',
                              color: isMe ? '#020617' : '#f8fafc',
                              fontSize: '13.5px',
                              lineHeight: 1.45,
                              wordBreak: 'break-word',
                              boxShadow: isMe ? '0 3px 12px rgba(56, 189, 248, 0.25)' : '0 3px 10px rgba(0,0,0,0.2)',
                              border: isMe ? 'none' : '1px solid rgba(255, 255, 255, 0.08)'
                            }}>
                              {m.message}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '3px', fontSize: '10px', color: 'var(--text-dim)', padding: '0 4px' }}>
                              <span>{timeStr}</span>
                              {isMe && (
                                <span>• {m.is_read ? <span style={{ color: 'var(--primary)', fontWeight: 700 }}>Read</span> : 'Sent'}</span>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Message Input Box */}
                  <form
                    onSubmit={handleSendMessage}
                    style={{
                      padding: '10px 14px',
                      background: 'rgba(15, 23, 42, 0.95)',
                      borderTop: '1px solid var(--border-color)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}
                  >
                    <input
                      type="text"
                      placeholder={`Message User #${activePartnerCode}...`}
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      className="msg-input-field"
                      style={{
                        flex: 1,
                        padding: '10px 14px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '10px',
                        color: '#fff',
                        fontSize: '14px',
                        outline: 'none'
                      }}
                    />
                    <button
                      type="submit"
                      disabled={!inputText.trim()}
                      className="btn btn-primary"
                      style={{
                        padding: '10px 16px',
                        borderRadius: '10px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontWeight: 700,
                        opacity: inputText.trim() ? 1 : 0.5,
                        cursor: inputText.trim() ? 'pointer' : 'not-allowed',
                        flexShrink: 0
                      }}
                    >
                      <Send size={15} />
                    </button>
                  </form>
                </>
              ) : (
                <div style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '30px',
                  textAlign: 'center',
                  color: 'var(--text-muted)'
                }}>
                  <div style={{
                    width: '56px',
                    height: '56px',
                    borderRadius: '50%',
                    background: 'rgba(56, 189, 248, 0.1)',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--primary)',
                    marginBottom: '14px'
                  }}>
                    <MessageSquare size={26} />
                  </div>
                  <h3 style={{ fontSize: '16px', fontWeight: 800, color: '#f8fafc', margin: '0 0 6px' }}>
                    Select or Start a Chat
                  </h3>
                  <p style={{ fontSize: '12px', maxWidth: '360px', margin: 0, lineHeight: 1.5 }}>
                    Select a conversation from the list or connect using any user's 6-digit code.
                  </p>
                </div>
              )}
            </div>

          </div>
        )}

        {/* ── TAB 2: ADMIN USERS DIRECTORY & CHAT CODES ──────────────────── */}
        {isAdmin && activeTab === 'directory' && (
          <div style={{
            background: 'var(--bg-card)',
            borderRadius: '16px',
            border: '1px solid var(--border-color)',
            padding: '16px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <div>
                <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Users size={18} color="var(--primary)" /> All Users Directory & Chat Codes
                </h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '12px', margin: '2px 0 0' }}>
                  User emails, 6-digit chat codes, and assigned device serial(s).
                </p>
              </div>

              {/* Search & Refresh */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', maxWidth: '340px' }}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <Search size={13} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input
                    type="text"
                    placeholder="Search email, serial, code..."
                    value={directorySearch}
                    onChange={(e) => setDirectorySearch(e.target.value)}
                    className="msg-input-field"
                    style={{
                      width: '100%',
                      padding: '8px 10px 8px 30px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '12px',
                      outline: 'none'
                    }}
                  />
                </div>
                <button
                  onClick={loadDirectory}
                  className="btn btn-secondary"
                  style={{ padding: '8px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
            </div>

            {/* Users Directory Table with Mobile Card Fallback */}
            {loadingDirectory ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                <RefreshCw size={22} className="spin" style={{ marginBottom: '10px' }} />
                <p style={{ fontSize: '13px' }}>Loading directory & chat codes...</p>
              </div>
            ) : filteredDirectory.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 14px', color: 'var(--text-muted)' }}>
                <User size={28} style={{ opacity: 0.3, marginBottom: '6px' }} />
                <p style={{ fontSize: '13px' }}>No matching users found.</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px', minWidth: '600px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                      <th style={{ padding: '10px 12px' }}>User Email</th>
                      <th style={{ padding: '10px 12px' }}>Role</th>
                      <th style={{ padding: '10px 12px' }}>6-Digit Chat Code</th>
                      <th style={{ padding: '10px 12px' }}>Assigned Device Serial(s)</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDirectory.map((u) => {
                      const isMe = u.id === profile?.id;
                      const hasDevices = u.device_serials && u.device_serials.length > 0;
                      return (
                        <tr
                          key={u.id}
                          style={{
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)'
                          }}
                        >
                          <td style={{ padding: '12px', fontWeight: 600, color: '#f8fafc' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span>{u.email}</span>
                              {isMe && (
                                <span style={{ background: 'rgba(56, 189, 248, 0.2)', color: 'var(--primary)', fontSize: '9px', padding: '1px 5px', borderRadius: '4px', fontWeight: 700 }}>
                                  YOU
                                </span>
                              )}
                              {u.is_blocked && (
                                <span style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', fontSize: '9px', padding: '1px 5px', borderRadius: '4px', fontWeight: 700 }}>
                                  BLOCKED
                                </span>
                              )}
                            </div>
                          </td>

                          <td style={{ padding: '12px' }}>
                            <span style={{
                              background: u.role.includes('admin') ? 'rgba(168, 85, 247, 0.15)' : 'rgba(255, 255, 255, 0.06)',
                              color: u.role.includes('admin') ? '#c084fc' : 'var(--text-muted)',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              fontSize: '10px',
                              fontWeight: 700,
                              textTransform: 'uppercase'
                            }}>
                              {u.role.replace('_', ' ')}
                            </span>
                          </td>

                          <td style={{ padding: '12px' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'rgba(0,0,0,0.3)', padding: '3px 8px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.08)' }}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 800, color: 'var(--primary)', letterSpacing: '1px', fontSize: '13px' }}>
                                {u.chat_code || '------'}
                              </span>
                              {u.chat_code && (
                                <button
                                  onClick={() => handleCopyAnyCode(u.chat_code)}
                                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                                  title="Copy chat code"
                                >
                                  {copiedCodeMap[u.chat_code] ? <Check size={11} color="#22c55e" /> : <Copy size={11} />}
                                </button>
                              )}
                            </div>
                          </td>

                          <td style={{ padding: '12px' }}>
                            {hasDevices ? (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                {u.device_serials.map(s => (
                                  <span
                                    key={s}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '3px',
                                      background: 'rgba(34, 197, 94, 0.12)',
                                      color: '#4ade80',
                                      border: '1px solid rgba(34, 197, 94, 0.25)',
                                      padding: '2px 6px',
                                      borderRadius: '4px',
                                      fontFamily: 'monospace',
                                      fontSize: '10px',
                                      fontWeight: 700
                                    }}
                                  >
                                    <Smartphone size={10} /> {s}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>None Assigned</span>
                            )}
                          </td>

                          <td style={{ padding: '12px', textAlign: 'right' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              <button
                                disabled={isMe || !u.chat_code}
                                onClick={() => handleInitiateCall(u.chat_code, u.email)}
                                className="btn"
                                style={{
                                  padding: '5px 10px',
                                  fontSize: '11px',
                                  borderRadius: '6px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  background: 'rgba(16, 185, 129, 0.15)',
                                  color: '#34d399',
                                  border: '1px solid rgba(16, 185, 129, 0.3)',
                                  fontWeight: 600,
                                  opacity: (isMe || !u.chat_code) ? 0.4 : 1,
                                  cursor: (isMe || !u.chat_code) ? 'not-allowed' : 'pointer'
                                }}
                                title="Call User"
                              >
                                <Phone size={11} /> Call
                              </button>

                              <button
                                disabled={isMe || !u.chat_code}
                                onClick={() => selectPartner(u.chat_code, u.email)}
                                className="btn btn-primary"
                                style={{
                                  padding: '5px 12px',
                                  fontSize: '11px',
                                  borderRadius: '6px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                  opacity: (isMe || !u.chat_code) ? 0.4 : 1,
                                  cursor: (isMe || !u.chat_code) ? 'not-allowed' : 'pointer'
                                }}
                              >
                                <MessageSquare size={12} /> Chat Now
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

      </div>
    </DashboardLayout>
  );
}
