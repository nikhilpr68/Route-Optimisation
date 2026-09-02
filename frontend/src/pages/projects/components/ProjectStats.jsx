import React from 'react';

// Compact Card
const CompactCard = ({ children, onClick, type }) => {
  const isEV = type && type.includes('EV');
  
  return (
    <div 
      onClick={onClick}
      className="glass-morphism reflective-card-container"
      style={{
        padding: '15px',
        borderRadius: '12px',
        cursor: 'pointer',
        background: 'rgba(255, 255, 255, 0.03)',
        borderLeft: type ? `4px solid ${isEV ? '#4ade80' : '#fbbf24'}` : 'none',
        transition: 'transform 0.2s, background 0.2s'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      {children}
    </div>
  );
};

const ProjectStats = ({ vehicles, onCardClick }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', color: 'white' }}>
      
      {vehicles.map(v => (
        <CompactCard key={v.id} onClick={onCardClick} type={v.type}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontWeight: 'bold', fontSize: '1rem' }}>{v.id}</span>
            <span style={{ fontSize: '0.8rem', opacity: 0.8, background: 'rgba(255,255,255,0.1)', padding:'2px 6px', borderRadius:'4px' }}>
              {v.type}
            </span>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem', opacity: 0.7, marginBottom: '8px' }}>
            <span>ðŸ‘¤ {v.passengers.length}/{v.capacity}</span>
            <span>Cost Rs {v.cost}</span>
          </div>

          {/* Mini Progress Bar */}
          <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px' }}>
            <div style={{ 
               width: `${(v.passengers.length / v.capacity) * 100}%`, 
               height: '100%', 
               background: v.passengers.length === v.capacity ? '#ef4444' : '#4ade80',
               borderRadius: '2px'
            }} />
          </div>
        </CompactCard>
      ))}

      {/* Summary Stat */}
      <div style={{ marginTop: '10px', padding: '15px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
         <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>Total Fleet Cost</div>
         <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: '#4ade80' }}>
           Rs {vehicles.reduce((acc,v) => acc + v.cost, 0)}
         </div>
      </div>

    </div>
  );
};

export default ProjectStats;
