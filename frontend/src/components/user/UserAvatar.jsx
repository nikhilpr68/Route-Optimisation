import React from 'react';

function fallbackLetter(user) {
  return (user?.name || user?.email || 'U').trim().charAt(0).toUpperCase() || 'U';
}

export default function UserAvatar({
  user,
  size = 40,
  fontSize = '1rem',
  showRing = false,
  gradient = 'linear-gradient(145deg, #0b1f45 0%, #1e3a8a 52%, #2563eb 100%)'
}) {
  const imageSrc = String(user?.profileImage || '').trim();

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '50%',
        padding: showRing ? '3px' : 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: showRing ? '1px solid rgba(255,255,255,0.2)' : 'none',
        background: showRing ? 'rgba(255,255,255,0.03)' : 'transparent',
        overflow: 'hidden',
        flexShrink: 0
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          background: gradient,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontWeight: 'bold',
          fontSize,
          boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.18)',
          overflow: 'hidden'
        }}
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={`${user?.name || 'User'} profile`}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          fallbackLetter(user)
        )}
      </div>
    </div>
  );
}
