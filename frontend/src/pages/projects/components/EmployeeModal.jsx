import React from 'react';
import { getEmployeeStatusMeta } from './employeeStatus';

const EmployeeModal = ({ isOpen, onClose, employees }) => {
  if (!isOpen) return null;

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
      // The background blur effect
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      backdropFilter: 'blur(15px)',
      WebkitBackdropFilter: 'blur(15px)',
      animation: 'fadeIn 0.3s ease'
    }}
    onClick={onClose} // Close when clicking background
    >
      <div 
        onClick={(e) => e.stopPropagation()} // Prevent closing when clicking card
        className="glass-morphism reflective-card-container"
        style={{
          width: '80%',
          maxWidth: '900px',
          height: '70%',
          backgroundColor: 'rgba(20, 20, 20, 0.8)', // Darker background for contrast
          borderRadius: '24px',
          padding: '40px',
          overflowY: 'auto',
          border: '1px solid rgba(255,255,255,0.15)',
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <h2 style={{ fontSize: '2rem', margin: 0 }}>Employee Live Status</h2>
          <button 
            onClick={onClose}
            style={{ 
              background: 'transparent', 
              border: 'none', 
              color: 'white', 
              fontSize: '1.5rem', 
              cursor: 'pointer',
              opacity: 0.7
            }}
          >
            x
          </button>
        </div>

        {/* Detailed Table */}
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 10px' }}>
          <thead>
            <tr style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'left' }}>
              <th>Employee</th>
              <th>Pickup Location</th>
              <th>Drop</th>
              <th>Time</th>
              <th>Delay</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const statusMeta = getEmployeeStatusMeta(e.status);
              return (
                <tr key={e.id} style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <td style={{ padding: '15px', borderRadius: '10px 0 0 10px' }}>
                    <div style={{ fontWeight: 'bold' }}>{e.id}</div>
                    <div style={{ fontSize: '0.8rem', opacity: 0.5 }}>Engineering</div>
                  </td>
                  <td style={{ padding: '15px' }}>{e.lat.toFixed(3)}, {e.lng.toFixed(3)}</td>
                  <td style={{ padding: '15px' }}>Headquarters</td>
                  <td style={{ padding: '15px' }}>{e.pickupTime}</td>
                  <td style={{ padding: '15px', color: e.delay > 0 ? '#ef4444' : '#4ade80' }}>
                    {e.delay > 0 ? `+${e.delay} min` : 'On Time'}
                  </td>
                  <td style={{ padding: '15px', borderRadius: '0 10px 10px 0' }}>
                    <span style={{
                      padding: '6px 12px',
                      borderRadius: '20px',
                      fontSize: '0.8rem',
                      background: statusMeta.background,
                      color: statusMeta.color,
                      border: `1px solid ${statusMeta.border}`,
                    }}>
                      {statusMeta.badgeLabel}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

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

export default EmployeeModal;
