import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Signup from './pages/Signup';
import DeviceStore from './pages/DeviceStore';
import MyDevices from './pages/MyDevices';
import AdminRentalHub from './pages/AdminRentalHub';

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: '40px', color: '#94a3b8', textAlign: 'center' }}>Loading rentals app...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
};

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DeviceStore />} />
          <Route path="/store" element={<DeviceStore />} />
          <Route path="/my-devices" element={<ProtectedRoute><MyDevices /></ProtectedRoute>} />
          <Route path="/admin-rentals" element={<ProtectedRoute><AdminRentalHub /></ProtectedRoute>} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="*" element={<Navigate to="/store" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
