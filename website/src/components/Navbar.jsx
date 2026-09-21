import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Sun, Moon, Menu, LogOut, Shield, Smartphone, Lock, Server, Users } from 'lucide-react';

export default function Navbar({ toggleSidebar }) {
  const { user, profile, theme, toggleTheme, logout } = useAuth();
  const role = profile?.role || 'worker';
  const isSeed = role === 'seed_admin';
  const isSuper = role === 'super_admin' || isSeed;
  const isAdmin = role === 'admin' || isSuper;

  const getRoleBadge = (r) => {
    switch (r) {
      case 'seed_admin': return <span className="badge badge-danger"><Shield size={12} /> Seed Owner</span>;
      case 'super_admin': return <span className="badge badge-warning">Super Admin</span>;
      case 'admin': return <span className="badge badge-info">Admin</span>;
      default: return <span className="badge badge-success">Worker</span>;
    }
  };

  const navTabStyle = ({ isActive }) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '7px 12px',
    borderRadius: '8px',
    textDecoration: 'none',
    fontSize: '13px',
    fontWeight: isActive ? 700 : 500,
    color: isActive ? '#fff' : 'var(--text-muted)',
    background: isActive ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
    border: isActive ? '1px solid var(--border-color)' : '1px solid transparent',
    transition: 'all 0.2s ease',
    whiteSpace: 'nowrap',
  });

  const kioskTabStyle = ({ isActive }) => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '7px 14px',
    borderRadius: '8px',
    textDecoration: 'none',
    fontSize: '13px',
    fontWeight: 700,
    color: '#ffffff',
    background: isActive
      ? 'linear-gradient(135deg, #0284c7, #38bdf8)'
      : 'rgba(2, 132, 199, 0.18)',
    border: isActive ? '1px solid #38bdf8' : '1px solid rgba(56, 189, 248, 0.4)',
    boxShadow: isActive ? '0 0 15px rgba(56, 189, 248, 0.4)' : 'none',
    transition: 'all 0.2s ease',
    whiteSpace: 'nowrap',
  });

  return (
    <header style={{
      height: '64px',
      background: 'var(--bg-header)',
      backdropFilter: 'blur(10px)',
      borderBottom: '1px solid var(--border-color)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      position: 'sticky',
      top: 0,
      zIndex: 40
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <button 
          onClick={toggleSidebar}
          className="btn btn-secondary"
          style={{ padding: '8px', display: 'flex' }}
          aria-label="Toggle Navigation Menu"
        >
          <Menu size={20} />
        </button>
        <NavLink to={isAdmin ? '/dashboard/kiosk' : '/worker'} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, fontSize: '18px', textDecoration: 'none', color: 'inherit' }}>
          <img src="/favicon.svg" alt="FlexPulse" style={{ width: '28px', height: '28px' }} />
          <span>FlexPulse</span>
        </NavLink>

        {/* Top Desktop Navigation Tabs */}
        {profile && (
          <nav className="header-nav-tabs" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '12px' }}>
            {isSeed && (
              <NavLink to="/seed-admin" style={navTabStyle}>
                <Shield size={14} /> Seed Hub
              </NavLink>
            )}

            {isSuper && (
              <NavLink to="/super-admin" style={navTabStyle}>
                <Server size={14} /> Super Admin
              </NavLink>
            )}

            {isAdmin && (
              <NavLink to="/admin" style={navTabStyle}>
                <Users size={14} /> Allocations
              </NavLink>
            )}

            {isAdmin && (
              <NavLink to="/dashboard/kiosk" style={kioskTabStyle}>
                <Lock size={14} /> FlexPulse Kiosk
              </NavLink>
            )}

            <NavLink to="/worker" style={navTabStyle}>
              <Smartphone size={14} /> My Devices
            </NavLink>
          </nav>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button 
          onClick={toggleTheme} 
          className="btn btn-secondary" 
          style={{ padding: '8px', borderRadius: '50%' }}
          title="Toggle Dark/Light Mode"
        >
          {theme === 'dark' ? <Sun size={18} color="#f59e0b" /> : <Moon size={18} color="#8b5cf6" />}
        </button>

        {profile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {getRoleBadge(profile.role)}
            <button onClick={logout} className="btn btn-danger" style={{ padding: '6px 12px', fontSize: '12px' }}>
              <LogOut size={14} /> <span style={{ display: 'none' }} className="nav-exit-label">Exit</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}


