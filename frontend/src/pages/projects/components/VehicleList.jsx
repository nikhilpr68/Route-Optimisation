import React from 'react';

const VehicleList = ({ vehicles, onVehicleClick }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
      <h3 style={{ margin: '0 0 5px 0', fontSize: '1rem', color: 'white', opacity: 0.8 }}>Fleet Overview</h3>
      
      {vehicles.map(v => (
        <div 
          key={v.id}
          onClick={() => onVehicleClick(v)}
          className="glass-morphism reflective-card-container interactive"
          style={{
            padding: '20px',
            borderRadius: '16px',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            position: 'relative',
            overflow: 'hidden'
          }}
        >
          {/* Status Indicator Bar */}
          <div style={{ 
              position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', 
              background: v.type.includes('EV') ? '#4ade80' : '#fbbf24' 
          }} />

          <div style={{ marginLeft: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: 'white' }}>{v.id}</span>
                <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '6px', background: 'rgba(255,255,255,0.1)', color: 'white' }}>{v.type}</span>
            </div>
            <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginTop: '4px' }}>
                Cap: {v.passengers.length}/{v.capacity} | Rs {v.cost}
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1.2rem', color: 'white' }}>{v.avgSpeed || 30} <span style={{ fontSize: '0.8rem', opacity: 0.5 }}>km/h</span></div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default VehicleList;
