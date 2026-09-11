import React, { useState, useEffect, useRef } from 'react';
import DashboardLayout from '../layouts/DashboardLayout';
import SEO from '../components/SEO';
import { useAuth } from '../context/AuthContext';
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
  RefreshCw 
} from 'lucide-react';

export default function MessagesPage() {
  const { profile, user } = useAuth();
  const [activeTab, setActiveTab] = useState('chats'); // 'chats' | 'directory'
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
        // Even if not yet in profiles, allow opening chat with code
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

      <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        
        {/* Top Header Card: User's Own 6-Digit Chat Code */}
        <div style={{
          background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.85), rgba(15, 23, 42, 0.95))',
          borderRadius: '16px',
          border: '1px solid rgba(56, 189, 248, 0.25)',
          padding: '20px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
          boxShadow: '0 10px 30px rgba(0,0,0,0.4)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{
              width: '52px',
              height: '52px',
              borderRadius: '14px',
              background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(14, 165, 233, 0.35))',
              border: '1px solid rgba(56, 189, 248, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--primary)',
              flexShrink: 0
            }}>
              <MessageSquare size={26} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0, color: '#f8fafc' }}>
                  Platform Messages & Live In-Stream Chat
                </h1>
                <span style={{
                  background: 'rgba(34, 197, 94, 0.15)',
                  color: '#22c55e',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  padding: '2px 8px',
                  borderRadius: '100px',
                  fontSize: '11px',
                  fontWeight: 700
                }}>
                  ONLINE
                </span>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '4px 0 0' }}>
                Directly chat with any user using their 6-digit code. In-stream messages automatically pop up with a chime alert.
              </p>
            </div>
          </div>

          {/* User's Chat Code Display */}
          <div style={{
            background: 'rgba(15, 23, 42, 0.75)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '12px',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)', fontWeight: 700 }}>
                Your 6-Digit Chat Code
              </span>
              <span style={{
                fontFamily: 'monospace',
                fontSize: '20px',
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
                padding: '8px 12px',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                borderRadius: '8px'
              }}
              title="Copy your 6-digit chat code"
            >
              {myCodeCopied ? <Check size={14} color="#22c55e" /> : <Copy size={14} />}
              <span>{myCodeCopied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>

        {/* Tab Switcher (For Admins) */}
        {isAdmin && (
          <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
            <button
              onClick={() => setActiveTab('chats')}
              style={{
                padding: '10px 20px',
                borderRadius: '10px',
                border: 'none',
                background: activeTab === 'chats' ? 'linear-gradient(135deg, var(--primary), var(--primary-hover))' : 'rgba(255, 255, 255, 0.05)',
                color: activeTab === 'chats' ? '#fff' : 'var(--text-muted)',
                fontWeight: 700,
                fontSize: '14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s ease'
              }}
            >
              <MessageSquare size={16} /> Direct Chats
            </button>
            <button
              onClick={() => setActiveTab('directory')}
              style={{
                padding: '10px 20px',
                borderRadius: '10px',
                border: 'none',
                background: activeTab === 'directory' ? 'linear-gradient(135deg, var(--primary), var(--primary-hover))' : 'rgba(255, 255, 255, 0.05)',
                color: activeTab === 'directory' ? '#fff' : 'var(--text-muted)',
                fontWeight: 700,
                fontSize: '14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.2s ease'
              }}
            >
              <Users size={16} /> Users Directory & Chat Codes
            </button>
          </div>
        )}

        {/* ── TAB 1: DIRECT CHATS ────────────────────────────────────────── */}
        {activeTab === 'chats' && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(300px, 360px) 1fr',
            gap: '20px',
            minHeight: '680px'
          }}>
            
            {/* Left Panel: Start Chat by Code & Active Conversations List */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              background: 'var(--bg-card)',
              borderRadius: '16px',
              border: '1px solid var(--border-color)',
              padding: '18px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)'
            }}>
              
              {/* Connect by 6-Digit Code Box */}
              <div style={{
                background: 'rgba(15, 23, 42, 0.7)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: '12px',
                padding: '14px'
              }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-main)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Hash size={14} color="var(--primary)" /> Connect by 6-Digit Code
                </div>
                <form onSubmit={handleConnectByCode} style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    maxLength={6}
                    placeholder="e.g. 482915"
                    value={connectCodeInput}
                    onChange={(e) => setConnectCodeInput(e.target.value.replace(/\D/g, ''))}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
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
                    style={{ padding: '8px 14px', fontSize: '12px', fontWeight: 700, borderRadius: '8px' }}
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
                <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-muted)', fontWeight: 700 }}>
                  Recent Chats ({conversations.length})
                </span>
                <button
                  onClick={loadConversations}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}
                >
                  <RefreshCw size={12} /> Refresh
                </button>
              </div>

              {/* Conversations Scrollable List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto', maxHeight: '520px' }}>
                {conversations.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--text-muted)' }}>
                    <MessageSquare size={32} style={{ opacity: 0.3, marginBottom: '10px' }} />
                    <p style={{ fontSize: '13px', margin: 0 }}>No conversations yet.</p>
                    <p style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
                      Enter a 6-digit code above or choose a user from the Directory to chat!
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
                          padding: '12px 14px',
                          borderRadius: '12px',
                          background: isSelected 
                            ? 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(14, 165, 233, 0.25))' 
                            : 'rgba(255, 255, 255, 0.02)',
                          border: isSelected ? '1px solid rgba(56, 189, 248, 0.5)' : '1px solid transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '12px',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <div style={{
                          width: '40px',
                          height: '40px',
                          borderRadius: '10px',
                          background: isSelected ? 'var(--primary)' : 'rgba(255, 255, 255, 0.06)',
                          color: isSelected ? '#000' : 'var(--text-main)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 800,
                          fontSize: '14px',
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
                            fontSize: '12px',
                            color: isSelected ? '#cbd5e1' : 'var(--text-muted)',
                            margin: '3px 0 0',
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

            {/* Right Panel: Active Chat Messages Thread */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-card)',
              borderRadius: '16px',
              border: '1px solid var(--border-color)',
              overflow: 'hidden',
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)'
            }}>
              {activePartnerCode ? (
                <>
                  {/* Chat Header */}
                  <div style={{
                    padding: '16px 20px',
                    background: 'rgba(15, 23, 42, 0.85)',
                    borderBottom: '1px solid var(--border-color)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '12px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{
                        width: '42px',
                        height: '42px',
                        borderRadius: '12px',
                        background: 'linear-gradient(135deg, var(--primary), var(--primary-hover))',
                        color: '#000',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 800,
                        fontSize: '16px'
                      }}>
                        {activePartnerInfo?.email ? activePartnerInfo.email[0].toUpperCase() : '#'}
                      </div>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '15px', fontWeight: 800, color: '#f8fafc' }}>
                            {activePartnerInfo?.email || `User #${activePartnerCode}`}
                          </span>
                          {activePartnerInfo?.role && (
                            <span style={{
                              background: 'rgba(255, 255, 255, 0.08)',
                              color: 'var(--text-muted)',
                              fontSize: '10px',
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              textTransform: 'uppercase'
                            }}>
                              {activePartnerInfo.role}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                          <span style={{ fontSize: '12px', color: 'var(--primary)', fontFamily: 'monospace', fontWeight: 700 }}>
                            Chat Code: #{activePartnerCode}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>•</span>
                          <span style={{ fontSize: '11px', color: '#22c55e', fontWeight: 600 }}>Active Channel</span>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleCopyAnyCode(activePartnerCode)}
                      className="btn btn-secondary"
                      style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                      {copiedCodeMap[activePartnerCode] ? <Check size={13} color="#22c55e" /> : <Copy size={13} />}
                      <span>{copiedCodeMap[activePartnerCode] ? 'Copied' : 'Copy Code'}</span>
                    </button>
                  </div>

                  {/* Message Stream */}
                  <div style={{
                    flex: 1,
                    padding: '20px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    background: 'radial-gradient(circle at 50% 10%, rgba(56, 189, 248, 0.03), transparent 70%)'
                  }}>
                    {loadingMessages ? (
                      <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--text-muted)' }}>
                        <RefreshCw size={24} className="spin" style={{ marginBottom: '8px' }} />
                        <p style={{ fontSize: '13px' }}>Loading conversation...</p>
                      </div>
                    ) : messages.length === 0 ? (
                      <div style={{ textAlign: 'center', margin: 'auto', color: 'var(--text-muted)', maxWidth: '360px' }}>
                        <div style={{ fontSize: '32px', marginBottom: '8px' }}>💬</div>
                        <h4 style={{ color: '#fff', fontSize: '16px', fontWeight: 700, margin: '0 0 6px' }}>Direct Connected Channel</h4>
                        <p style={{ fontSize: '13px', margin: 0, lineHeight: 1.5 }}>
                          Say hello! If this user is currently viewing a live device stream, your message will pop up on their screen with an audio ding alert.
                        </p>
                      </div>
                    ) : (
                      messages.map((m) => {
                        const isMe = m.sender_chat_code === profile?.chat_code;
                        const timeStr = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        return (
                          <div
                            key={m.id}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: isMe ? 'flex-end' : 'flex-start',
                              maxWidth: '80%',
                              alignSelf: isMe ? 'flex-end' : 'flex-start'
                            }}
                          >
                            <div style={{
                              padding: '10px 16px',
                              borderRadius: isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                              background: isMe 
                                ? 'linear-gradient(135deg, var(--primary), var(--primary-hover))' 
                                : 'rgba(255, 255, 255, 0.07)',
                              color: isMe ? '#020617' : '#f8fafc',
                              fontSize: '14px',
                              lineHeight: 1.5,
                              wordBreak: 'break-word',
                              boxShadow: isMe ? '0 4px 14px rgba(56, 189, 248, 0.3)' : '0 4px 12px rgba(0,0,0,0.2)',
                              border: isMe ? 'none' : '1px solid rgba(255, 255, 255, 0.08)'
                            }}>
                              {m.message}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', fontSize: '10px', color: 'var(--text-dim)', padding: '0 4px' }}>
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
                      padding: '14px 20px',
                      background: 'rgba(15, 23, 42, 0.95)',
                      borderTop: '1px solid var(--border-color)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px'
                    }}
                  >
                    <input
                      type="text"
                      placeholder={`Message User #${activePartnerCode}...`}
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      style={{
                        flex: 1,
                        padding: '12px 16px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '12px',
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
                        padding: '12px 20px',
                        borderRadius: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontWeight: 700,
                        opacity: inputText.trim() ? 1 : 0.5,
                        cursor: inputText.trim() ? 'pointer' : 'not-allowed'
                      }}
                    >
                      <Send size={16} /> Send
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
                  padding: '40px',
                  textAlign: 'center',
                  color: 'var(--text-muted)'
                }}>
                  <div style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '50%',
                    background: 'rgba(56, 189, 248, 0.1)',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--primary)',
                    marginBottom: '16px'
                  }}>
                    <MessageSquare size={30} />
                  </div>
                  <h3 style={{ fontSize: '18px', fontWeight: 800, color: '#f8fafc', margin: '0 0 8px' }}>
                    Select or Start a Chat
                  </h3>
                  <p style={{ fontSize: '13px', maxWidth: '400px', margin: 0, lineHeight: 1.6 }}>
                    Select an existing conversation from the list, connect using any user's 6-digit code, or browse all platform users in the Directory tab.
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
            padding: '24px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
              <div>
                <h2 style={{ fontSize: '18px', fontWeight: 800, margin: 0, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Users size={20} color="var(--primary)" /> All Users Directory & Chat Codes
                </h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '4px 0 0' }}>
                  View all system users with their email, 6-digit chat code, and assigned device serial(s) to initiate a direct chat.
                </p>
              </div>

              {/* Search & Refresh */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ position: 'relative', width: '260px' }}>
                  <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input
                    type="text"
                    placeholder="Search email, serial, code..."
                    value={directorySearch}
                    onChange={(e) => setDirectorySearch(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px 8px 34px',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      color: '#fff',
                      fontSize: '13px',
                      outline: 'none'
                    }}
                  />
                </div>
                <button
                  onClick={loadDirectory}
                  className="btn btn-secondary"
                  style={{ padding: '8px 14px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>
            </div>

            {/* Users Directory Table */}
            {loadingDirectory ? (
              <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
                <RefreshCw size={24} className="spin" style={{ marginBottom: '12px' }} />
                <p>Loading directory & chat codes...</p>
              </div>
            ) : filteredDirectory.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>
                <User size={32} style={{ opacity: 0.3, marginBottom: '8px' }} />
                <p>No matching users found.</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                      <th style={{ padding: '12px 14px' }}>User Email</th>
                      <th style={{ padding: '12px 14px' }}>Role</th>
                      <th style={{ padding: '12px 14px' }}>6-Digit Chat Code</th>
                      <th style={{ padding: '12px 14px' }}>Assigned Device Serial(s)</th>
                      <th style={{ padding: '12px 14px', textAlign: 'right' }}>Actions</th>
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
                            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                            transition: 'background 0.15s ease'
                          }}
                        >
                          <td style={{ padding: '14px', fontWeight: 600, color: '#f8fafc' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <span>{u.email}</span>
                              {isMe && (
                                <span style={{ background: 'rgba(56, 189, 248, 0.2)', color: 'var(--primary)', fontSize: '10px', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                                  YOU
                                </span>
                              )}
                              {u.is_blocked && (
                                <span style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', fontSize: '10px', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                                  BLOCKED
                                </span>
                              )}
                            </div>
                          </td>

                          <td style={{ padding: '14px' }}>
                            <span style={{
                              background: u.role.includes('admin') ? 'rgba(168, 85, 247, 0.15)' : 'rgba(255, 255, 255, 0.06)',
                              color: u.role.includes('admin') ? '#c084fc' : 'var(--text-muted)',
                              padding: '3px 8px',
                              borderRadius: '6px',
                              fontSize: '11px',
                              fontWeight: 700,
                              textTransform: 'uppercase'
                            }}>
                              {u.role.replace('_', ' ')}
                            </span>
                          </td>

                          <td style={{ padding: '14px' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: 'rgba(0,0,0,0.3)', padding: '4px 10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 800, color: 'var(--primary)', letterSpacing: '1px', fontSize: '14px' }}>
                                {u.chat_code || '------'}
                              </span>
                              {u.chat_code && (
                                <button
                                  onClick={() => handleCopyAnyCode(u.chat_code)}
                                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                                  title="Copy chat code"
                                >
                                  {copiedCodeMap[u.chat_code] ? <Check size={13} color="#22c55e" /> : <Copy size={13} />}
                                </button>
                              )}
                            </div>
                          </td>

                          <td style={{ padding: '14px' }}>
                            {hasDevices ? (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                {u.device_serials.map(s => (
                                  <span
                                    key={s}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                      background: 'rgba(34, 197, 94, 0.12)',
                                      color: '#4ade80',
                                      border: '1px solid rgba(34, 197, 94, 0.25)',
                                      padding: '2px 8px',
                                      borderRadius: '6px',
                                      fontFamily: 'monospace',
                                      fontSize: '11px',
                                      fontWeight: 700
                                    }}
                                  >
                                    <Smartphone size={12} /> {s}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}>None Assigned</span>
                            )}
                          </td>

                          <td style={{ padding: '14px', textAlign: 'right' }}>
                            <button
                              disabled={isMe || !u.chat_code}
                              onClick={() => selectPartner(u.chat_code, u.email)}
                              className="btn btn-primary"
                              style={{
                                padding: '6px 14px',
                                fontSize: '12px',
                                borderRadius: '8px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                opacity: (isMe || !u.chat_code) ? 0.4 : 1,
                                cursor: (isMe || !u.chat_code) ? 'not-allowed' : 'pointer'
                              }}
                            >
                              <MessageSquare size={13} /> Chat Now
                            </button>
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
