import React from 'react';

function PriorityPill({ priority }) {
  const p = String(priority || 'medium').toLowerCase();
  const tone = p === 'high'
    ? { bg: 'rgba(244,63,94,0.13)', border: 'rgba(244,63,94,0.45)', text: '#fda4af' }
    : p === 'low'
      ? { bg: 'rgba(59,130,246,0.15)', border: 'rgba(59,130,246,0.45)', text: '#93c5fd' }
      : { bg: 'rgba(96,165,250,0.16)', border: 'rgba(96,165,250,0.5)', text: '#bfdbfe' };
  return (
    <span style={{
      padding: '4px 12px',
      borderRadius: 999,
      border: `1px solid ${tone.border}`,
      background: tone.bg,
      color: tone.text,
      fontWeight: 700,
      fontSize: '0.85rem',
      textTransform: 'capitalize'
    }}>
      {p}
    </span>
  );
}

export default PriorityPill;
