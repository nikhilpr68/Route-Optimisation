import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMe, logout as clearAuth } from '../../api/api';
import UserAvatar from '../user/UserAvatar';

const Profile = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [user, setUser] = useState({ name: 'User', email: '', profileImage: '' });
  const navigate = useNavigate();
  const menuRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    const loadUser = async () => {
      try {
        const me = await getMe();
        if (!mounted || !me) return;
        setUser({
          name: me.name || 'User',
          email: me.email || '',
          profileImage: me.profileImage || ''
        });
      } catch {
        if (!mounted) return;
        setUser({ name: 'User', email: '', profileImage: '' });
      }
    };
    loadUser();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const handleProfileUpdated = (event) => {
      const detail = event?.detail || {};
      setUser({
        name: detail.name || 'User',
        email: detail.email || '',
        profileImage: detail.profileImage || ''
      });
    };

    window.addEventListener('profile-updated', handleProfileUpdated);
    return () => window.removeEventListener('profile-updated', handleProfileUpdated);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogOut = () => {
    clearAuth();
    navigate('/', { replace: true });
  };

  const handleOpenSettings = () => {
    setIsOpen(false);
    navigate('/settings');
  };

  const handleOpenHelp = () => {
    setIsOpen(false);
    navigate('/help-support');
  };

  return (
    <div className="profile-container" ref={menuRef} style={{ position: 'relative' }}>
      
      {/* 1. TRIGGER: THE COLORFUL ICON 
         Simple shape, but vibrant gradient colors.
      */}
      <div 
        onClick={() => setIsOpen(!isOpen)}
        className="glass-morphism reflective-card-container interactive" 
        style={{
          cursor: 'pointer',
          transition: 'transform 0.2s ease'
        }}
      >
        <UserAvatar user={user} size={46} fontSize="1.1rem" showRing />
      </div>

      {/* 2. DROPDOWN MENU
         Pure Glassmorphism + Attractive Item Hovers
      */}
      {isOpen && (
        <div 
          className="glass-morphism reflective-card-container"
          style={{
            position: 'absolute',
            top: '60px',
            right: '0',
            width: '260px',
            padding: '16px',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            animation: 'slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            transformOrigin: 'top right',
            background: '#05070b',
            border: '1px solid rgba(255,255,255,0.16)',
            borderTop: '1px solid rgba(255,255,255,0.26)',
            boxShadow: '0 18px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none'
          }}
        >
          {/* Header */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '12px',
            paddingBottom: '12px',
            marginBottom: '8px',
            borderBottom: '1px solid rgba(255,255,255,0.1)' 
          }}>
            {/* Mini Avatar in Dropdown */}
            <UserAvatar user={user} size={36} fontSize="0.9rem" />
            <div>
              <p style={{ margin: 0, fontWeight: '600', color: 'white', fontSize: '0.95rem' }}>{user.name}</p>
              <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.9, color: 'rgba(236,242,255,0.96)' }}>{user.email || 'No email'}</p>
            </div>
          </div>

          {/* Menu Items */}
          <MenuItem icon={<SettingsIcon />} label="Account Settings" onClick={handleOpenSettings} />
          <MenuItem icon={<HelpIcon />} label="Help & Support" onClick={handleOpenHelp} />
          
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.1)', margin: '4px 0' }} />
          
          <MenuItem icon={<LogoutIcon />} label="Log Out" onClick={handleLogOut} isDanger={true} />

        </div>
      )}

      {/* Animation Style */}
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: scale(0.95) translateY(-10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
};

// --- Sub-Components ---

const MenuItem = ({ icon, label, onClick, isDanger }) => {
  const [hover, setHover] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '10px 12px',
        borderRadius: '12px',
        cursor: 'pointer',
        // Attractive internal glass hover
        background: hover ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
        border: '1px solid transparent',
        borderColor: hover ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
        transition: 'all 0.2s ease',
        color: isDanger && hover ? '#ff8787' : 'white', // Soft red on hover for logout
      }}
    >
      <div style={{ 
        opacity: hover ? 1 : 0.7, 
        color: 'inherit',
        display: 'flex', 
        alignItems: 'center',
        transform: hover ? 'scale(1.1)' : 'scale(1)',
        transition: 'transform 0.2s'
      }}>
        {icon}
      </div>
      <span style={{ fontSize: '0.9rem', fontWeight: 500, opacity: hover ? 1 : 0.9 }}>{label}</span>
    </div>
  );
};

/* --- ICONS --- */
const SettingsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19.14 12.94a7.43 7.43 0 0 0 .05-.94 7.43 7.43 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.28 7.28 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54a7.28 7.28 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.43 7.43 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.39 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.22 1.13-.55 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
  </svg>
);

const HelpIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
);

const LogoutIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
);

export default Profile;
