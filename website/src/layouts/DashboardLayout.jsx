import React, { useState } from 'react';
import Navbar from '../components/Navbar';
import Sidebar from '../components/Sidebar';

export default function DashboardLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Navbar toggleSidebar={() => setSidebarOpen(prev => !prev)} />
      <div style={{ display: 'flex', flex: 1 }}>
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main style={{
          flex: 1,
          padding: '24px',
          maxWidth: '1400px',
          width: '100%',
          margin: '0 auto',
          transition: 'all 0.3s ease'
        }}>
          {children}
        </main>
      </div>
    </div>
  );
}
