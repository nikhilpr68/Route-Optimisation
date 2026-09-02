import React from 'react';

const VehicleModal = ({ isOpen, onClose, vehicle }) => {
  if (!isOpen || !vehicle) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      backdropFilter: 'blur(15px)',
      WebkitBackdropFilter: 'blur(15px)',
      animation: 'fadeIn 0.3s ease'
    }}
    onClick={onClose}
    >
      <div 
        onClick={(e) => e.stopPropagation()} 
        className="glass-morphism reflective-card-container"
        style={{
          width: '70%',
          maxWidth: '700px',
          backgroundColor: 'rgba(20, 20, 20, 0.85)',
          borderRadius: '24px',
          padding: '40px',
          border: '1px solid rgba(255,255,255,0.2)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <div>
            <h2 style={{ fontSize: '2rem', margin: 0, color: 'white' }}>{vehicle.id}</h2>
            <p style={{ margin: '5px 0 0 0', opacity: 0.6, color: 'white' }}>Fleet Vehicle Details</p>
          </div>
          <div style={{
             padding: '8px 16px',
             borderRadius: '20px',
             background: vehicle.type.includes('EV') ? 'rgba(74, 222, 128, 0.2)' : 'rgba(251, 191, 36, 0.2)',
             color: vehicle.type.includes('EV') ? '#4ade80' : '#fbbf24',
             fontWeight: 'bold'
          }}>
            {vehicle.type}
          </div>
        </div>

        {/* --- GRID STATS --- */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '25px', marginBottom: '30px' }}>
            <DetailCard label="Avg Speed" value={`${vehicle.avgSpeed || 32} km/h`} />
            <DetailCard label="Avg Mileage" value={`${vehicle.mileage || 12} km/l`} />
            <DetailCard label="Cost per KM" value={`Rs ${vehicle.costPerKm || 14}`} />
            <DetailCard label="Service Status" value="Good Condition" color="#4ade80" />
        </div>

        {/* --- LOCATION DATA --- */}
        <div style={{ 
            background: 'rgba(255,255,255,0.05)', 
            padding: '20px', 
            borderRadius: '16px',
            border: '1px solid rgba(255,255,255,0.1)'
        }}>
            <h3 style={{ margin: '0 0 15px 0', color: 'white', fontSize: '1.1rem' }}>Current Location</h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'white', opacity: 0.8 }}>
                <span>Latitude: {vehicle.startLat}</span>
                <span>Longitude: {vehicle.startLng}</span>
            </div>
            <div style={{ marginTop: '15px', fontSize: '0.9rem', color: '#60a5fa' }}>
                ðŸ“ Vehicle is currently active on route
            </div>
        </div>

      </div>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
};

const DetailCard = ({ label, value, color = 'white' }) => (
    <div style={{ padding: '20px', background: 'rgba(255,255,255,0.03)', borderRadius: '16px' }}>
        <div style={{ fontSize: '0.9rem', opacity: 0.5, marginBottom: '8px', color: 'white' }}>{label}</div>
        <div style={{ fontSize: '1.4rem', fontWeight: 'bold', color: color }}>{value}</div>
    </div>
);

export default VehicleModal;
