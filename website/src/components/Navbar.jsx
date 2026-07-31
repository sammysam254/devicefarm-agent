import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Sun, Moon, Menu, LogOut, Shield, Smartphone } from 'lucide-react';

export default function Navbar({ toggleSidebar }) {
  const { user, profile, theme, toggleTheme, logout } = useAuth();

  const getRoleBadge = (role) => {
    switch (role) {
      case 'seed_admin': return <span class="badge badge-danger"><Shield size={12} /> Seed Owner</span>;
      case 'super_admin': return <span class="badge badge-warning">Super Admin</span>;
      case 'admin': return <span class="badge badge-info">Admin</span>;
      default: return <span class="badge badge-success">Worker</span>;
    }
  };

  return (
    <header style={{
      height: '64px',
      background: 'var(--bg-header)',
      backdropFilter: 'blur(10px)',
      borderBottom: '1px solid var(--border-color)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 20px',
      position: 'sticky',
      top: 0,
      zIndex: 40
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <button 
          onClick={toggleSidebar}
          className="btn btn-secondary"
          style={{ padding: '8px', display: 'flex' }}
          aria-label="Toggle Navigation Menu"
        >
          <Menu size={20} />
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: 800, fontSize: '18px' }}>
          <Smartphone size={24} color="var(--primary)" />
          <span>DeviceFarm</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <button 
          onClick={toggleTheme} 
          className="btn btn-secondary" 
          style={{ padding: '8px', borderRadius: '50%' }}
          title="Toggle Dark/Light Mode"
        >
          {theme === 'dark' ? <Sun size={18} color="#f59e0b" /> : <Moon size={18} color="#8b5cf6" />}
        </button>

        {profile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {getRoleBadge(profile.role)}
            <span style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'none', mdDisplay: 'inline' }}>
              {profile.email}
            </span>
            <button onClick={logout} className="btn btn-danger" style={{ padding: '6px 12px', fontSize: '12px' }}>
              <LogOut size={14} /> Exit
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
