import React, { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { playDingSound } from '../lib/soundEffects';
import { Shield, Server, Users, Smartphone, MessageSquare, X, Key } from 'lucide-react';

export default function Sidebar({ isOpen, onClose }) {
  const { profile } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const role = profile?.role || 'worker';

  const isSeed = role === 'seed_admin';
  const isSuper = role === 'super_admin' || isSeed;
  const isAdmin = role === 'admin' || isSuper;

  useEffect(() => {
    if (!profile?.chat_code) return;

    const fetchUnread = async () => {
      try {
        const { count, error } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('recipient_chat_code', profile.chat_code)
          .eq('is_read', false);

        if (!error && typeof count === 'number') {
          setUnreadCount(count);
        }
      } catch (e) {
        console.warn('Error fetching unread messages count:', e);
      }
    };

    fetchUnread();

    const channel = supabase
      .channel(`chat-sidebar-${profile.chat_code}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'chat_messages',
        filter: `recipient_chat_code=eq.${profile.chat_code}`,
      }, (payload) => {
        if (!payload.new.is_read) {
          setUnreadCount(prev => prev + 1);
          playDingSound();

          // Native browser/phone system notification if not directly active on messages page
          if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
            try {
              const notif = new Notification(`💬 Message from ${payload.new.sender_email || 'User #' + payload.new.sender_chat_code}`, {
                body: payload.new.message,
                icon: '/favicon.ico',
                tag: `msg-${payload.new.id}`,
                data: { url: '/messages' }
              });
              notif.onclick = () => {
                window.focus();
                window.location.href = '/messages';
              };
            } catch (_) {}
          }
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'chat_messages',
        filter: `recipient_chat_code=eq.${profile.chat_code}`,
      }, () => {
        fetchUnread();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile?.chat_code]);

  const linkStyle = ({ isActive }) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    borderRadius: '10px',
    textDecoration: 'none',
    color: isActive ? '#fff' : 'var(--text-muted)',
    background: isActive ? 'linear-gradient(135deg, var(--primary), var(--primary-hover))' : 'transparent',
    fontWeight: isActive ? 700 : 500,
    fontSize: '14px',
    transition: 'all 0.2s ease'
  });

  return (
    <>
      {/* Mobile Drawer Overlay */}
      {isOpen && (
        <div 
          onClick={onClose} 
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 45
          }} 
        />
      )}

      <aside style={{
        position: 'fixed',
        top: '64px',
        left: 0,
        bottom: 0,
        width: '260px',
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border-color)',
        padding: '20px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        zIndex: 50,
        transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.3s ease'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', padding: '0 8px' }}>
          <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-muted)', fontWeight: 700 }}>
            Navigation
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        {isSeed && (
          <NavLink to="/seed-admin" onClick={onClose} style={linkStyle}>
            <Shield size={18} /> Seed Owner Hub
          </NavLink>
        )}

        {isSuper && (
          <NavLink to="/super-admin" onClick={onClose} style={linkStyle}>
            <Server size={18} /> Super Admin Devices
          </NavLink>
        )}

        {isAdmin && (
          <NavLink to="/admin" onClick={onClose} style={linkStyle}>
            <Users size={18} /> Admin Allocations
          </NavLink>
        )}

        <NavLink to="/worker" onClick={onClose} style={linkStyle}>
          <Smartphone size={18} /> My Assigned Devices
        </NavLink>

        <NavLink to="/messages" onClick={onClose} style={linkStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
            <MessageSquare size={18} />
            <span>Messages</span>
          </div>
          {unreadCount > 0 && (
            <span style={{
              background: '#ef4444',
              color: '#ffffff',
              fontSize: '11px',
              fontWeight: 800,
              padding: '2px 7px',
              borderRadius: '999px',
              lineHeight: 1,
              boxShadow: '0 0 10px rgba(239, 68, 68, 0.6)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: '18px'
            }}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </NavLink>

        <div style={{ marginTop: 'auto', padding: '14px', background: 'var(--bg-main)', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Key size={14} color="var(--primary)" /> Role Access
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Logged in as <b>{role.replace('_', ' ').toUpperCase()}</b>
          </div>
        </div>
      </aside>
    </>
  );
}
