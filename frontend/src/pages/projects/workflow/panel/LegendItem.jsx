import React from 'react';

function LegendItem({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'rgba(235,242,255,0.92)' }}>
      <span style={{ width: 11, height: 11, borderRadius: 999, background: color }} />
      {label}
    </span>
  );
}

export default LegendItem;
