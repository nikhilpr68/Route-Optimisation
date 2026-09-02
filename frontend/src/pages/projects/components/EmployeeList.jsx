import React from 'react';
import { getEmployeeStatusMeta, isEmployeeActive } from './employeeStatus';

const EmployeeList = ({ employees, onEmployeeClick }) => {
  return (
    <div className="glass-morphism reflective-card-container" style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', borderRadius: '20px' }}>
      <div style={{ padding: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <h3 style={{ margin: 0, color: 'white' }}>Employee Status</h3>
        <p style={{ margin: '5px 0 0 0', fontSize: '0.8rem', opacity: 0.6, color: 'white' }}>
          {employees.length} Total | {employees.filter((employee) => isEmployeeActive(employee.status)).length} Active
        </p>
      </div>

      <div style={{ overflowY: 'auto', flex: 1, padding: '10px' }}>
        {employees.map((e) => {
          const statusMeta = getEmployeeStatusMeta(e.status);
          return (
            <div
              key={e.id}
              onClick={() => onEmployeeClick(e)}
              className="interactive"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '16px',
                marginBottom: '10px',
                borderRadius: '12px',
                cursor: 'pointer',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.05)'
              }}
            >
              <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
                <div
                  style={{
                    width: '35px',
                    height: '35px',
                    borderRadius: '50%',
                    background: 'rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontWeight: 'bold',
                    fontSize: '0.8rem'
                  }}
                >
                  {e.id}
                </div>
                <div>
                  <div style={{ color: 'white', fontWeight: '500' }}>{e.id} (Eng)</div>
                  <div style={{ fontSize: '0.8rem', color: e.delay > 0 ? '#ef4444' : 'rgba(255,255,255,0.5)' }}>
                    {e.delay > 0 ? `+${e.delay}m Delay` : 'On Time'}
                  </div>
                </div>
              </div>

              <span style={{
                fontSize: '0.75rem',
                padding: '4px 10px',
                borderRadius: '12px',
                background: statusMeta.background,
                color: statusMeta.color,
                border: `1px solid ${statusMeta.border}`
              }}>
                {statusMeta.badgeLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default EmployeeList;
