import React from 'react';

function SanityCard({ label, count, tone = 'warning' }) {
  const map = {
    danger: { border: 'rgba(244,63,94,0.35)', badgeBg: 'rgba(244,63,94,0.16)', badgeText: '#fda4af' },
    warning: { border: 'rgba(250,204,21,0.35)', badgeBg: 'rgba(250,204,21,0.16)', badgeText: '#fde047' },
    ok: { border: 'rgba(20,217,163,0.35)', badgeBg: 'rgba(20,217,163,0.16)', badgeText: '#6ee7b7' },
  }[tone];
  return (
    <div style={{
      border: `1px solid ${map.border}`,
      borderRadius: 14,
      background: 'rgba(255,255,255,0.03)',
      padding: '14px 16px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
    }}>
      <span style={{ fontSize: '1rem' }}>{label}</span>
      <span style={{
        minWidth: 36,
        height: 36,
        borderRadius: 18,
        background: map.badgeBg,
        border: `1px solid ${map.border}`,
        color: map.badgeText,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: '1.15rem'
      }}>
        {count}
      </span>
    </div>
  );
}

export default SanityCard;
