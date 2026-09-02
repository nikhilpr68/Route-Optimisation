import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Profile from '../../components/topbar/Profile';
import ProjectMap from './components/ProjectMap';
import EmployeeModal from './components/EmployeeModal';
import VehicleModal from './components/VehicleModal';
import EmployeeList from './components/EmployeeList';
import VehicleList from './components/VehicleList';
import { normalizeEmployeeStatus } from './components/employeeStatus';
import { formatUSD } from '../../utils/currency';

import { getResults, getProject } from '../../api/api';

const Project_Dashboard = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  // Modals State
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);

  // Data State
  const [projectName, setProjectName] = useState('');
  const [status, setStatus] = useState('');
  const [metrics, setMetrics] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [distanceInfo, setDistanceInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      setError('');
      try {
        // Fetch project info + results in parallel
        const [projData, resultsData] = await Promise.all([
          getProject(id),
          getResults(id),
        ]);

        setProjectName(projData?.name || `Project ${id}`);
        setStatus(resultsData?.status || projData?.status || 'Unknown');
        setMetrics(resultsData?.metrics || resultsData?.results?.metrics || null);
        setDistanceInfo({
          ...(resultsData?.results?.distance || {}),
          requestedMetric: projData?.runConfig?.distanceMetric || null,
        });

        const rides = resultsData?.results?.rides || [];

        // Build vehicles from rides
        const vehicleArr = rides.map((ride) => ({
          id: ride.vehicleId,
          type: ride.vehicleId || 'Vehicle',
          capacity: ride.assignedEmployees?.length || 0,
          cost: ride.metrics?.cost || 0,
          startLat: ride.path?.[0]?.lat || 0,
          startLng: ride.path?.[0]?.lng || 0,
          passengers: ride.assignedEmployees || [],
          avgSpeed: 0,
          mileage: 0,
          costPerKm: 0,
        }));

        // Build employees from rides
        const employeeArr = [];
        rides.forEach((ride) => {
          const employeeDelayMap = ride.metrics?.employeeDelayMinutes || {};

          (ride.path || []).forEach((stop) => {
            if (stop.type === 'pickup') {
              employeeArr.push({
                id: stop.employeeId,
                lat: stop.lat,
                lng: stop.lng,
                vehicleId: ride.vehicleId,
                pickupTime: '',
                delay: Math.max(0, employeeDelayMap?.[stop.employeeId] || 0),
                status: normalizeEmployeeStatus(ride.feasible ? 'Assigned' : 'Issue'),
              });
            }
          });
        });

        // De-duplicate employees (only keep first occurrence)
        const seen = new Set();
        const uniqueEmployees = employeeArr.filter((e) => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        });

        setVehicles(vehicleArr);
        setEmployees(uniqueEmployees);
      } catch (err) {
        console.error('Failed to load project data:', err);
        setError(err.response?.data?.message || err.message || 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [id]);

  // Listener for Sidebar Event (History/Employee Status)
  useEffect(() => {
    const handleOpenModal = () => setShowEmployeeModal(true);
    window.addEventListener('openEmployeeModal', handleOpenModal);
    return () => window.removeEventListener('openEmployeeModal', handleOpenModal);
  }, []);

  if (loading) {
    return (
      <div style={{ padding: '20px 40px', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'white' }}>
          <div style={{
            width: '40px', height: '40px', border: '3px solid rgba(255,255,255,0.2)',
            borderTop: '3px solid #60a5fa', borderRadius: '50%',
            animation: 'spin 1s linear infinite', margin: '0 auto 20px'
          }} />
          <p style={{ opacity: 0.8 }}>Loading project results...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '20px 40px', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: 'white' }}>
          <p style={{ fontSize: '1.2rem', marginBottom: '10px' }}>⚠️ {error}</p>
          <button
            onClick={() => navigate('/home')}
            style={{
              padding: '10px 24px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.1)', color: 'white', cursor: 'pointer'
            }}
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px 40px', height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>

      {/* --- MODALS --- */}
      <EmployeeModal
        isOpen={showEmployeeModal || !!selectedEmployee}
        onClose={() => { setShowEmployeeModal(false); setSelectedEmployee(null); }}
        employees={selectedEmployee ? [selectedEmployee] : employees}
      />

      <VehicleModal
        isOpen={!!selectedVehicle}
        onClose={() => setSelectedVehicle(null)}
        vehicle={selectedVehicle}
      />

      {/* --- TOPBAR --- */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '30px' }}>
          <div style={{ width: '180px' }} />
          <div style={{ paddingLeft: '20px' }}>
            <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'white' }}>{projectName}</h2>
            <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.6, color: 'white' }}>
              Bengaluru • {status}
              {metrics && ` • Savings ${metrics.savingsPercent?.toFixed(1) || 0}%`}
            </p>
          </div>
        </div>

        {/* Quick Metrics Pills */}
        {metrics && (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <div style={{
              padding: '8px 16px', borderRadius: '12px',
              background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.2)',
              color: '#4ade80', fontSize: '0.85rem', fontWeight: 600
            }}>
              Cost {formatUSD(metrics.totalSystemCost, { fallback: '—' })}
            </div>
            <div style={{
              padding: '8px 16px', borderRadius: '12px',
              background: 'rgba(96, 165, 250, 0.1)', border: '1px solid rgba(96, 165, 250, 0.2)',
              color: '#60a5fa', fontSize: '0.85rem', fontWeight: 600
            }}>
              ⏱ {metrics.totalTimeMinutes?.toFixed(0) || '—'} min
            </div>
            <div style={{
              padding: '8px 16px', borderRadius: '12px',
              background: 'rgba(250, 204, 21, 0.1)', border: '1px solid rgba(250, 204, 21, 0.2)',
              color: '#facc15', fontSize: '0.85rem', fontWeight: 600
            }}>
              📉 {metrics.savingsPercent?.toFixed(1) || 0}% saved
            </div>
          </div>
        )}

        <div style={{ width: '200px', display: 'flex', justifyContent: 'flex-end' }}><Profile /></div>
      </div>

      {/* --- MAIN GRID LAYOUT (Left: List, Right: Map+Vehicles) --- */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        gap: '30px',
        flex: 1,
        minHeight: 0
      }}>

        {/* LEFT COLUMN: Employee Status List */}
        <EmployeeList
          employees={employees}
          onEmployeeClick={(e) => setSelectedEmployee(e)}
        />

        {/* RIGHT COLUMN: Map (Short) + Vehicles */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

          {/* 1. SHORT MAP (Approx 45% Height) */}
          <div style={{
            height: '45%',
            borderRadius: '20px',
            overflow: 'hidden',
            marginBottom: '20px',
            border: '1px solid rgba(255,255,255,0.15)',
            position: 'relative',
            zIndex: 0
          }}>
            <ProjectMap vehicles={vehicles} employees={employees} distanceInfo={distanceInfo} />
          </div>

          {/* 2. VEHICLE LIST (Scrollable Remaining Height) */}
          <div style={{ flex: 1, overflowY: 'auto', paddingRight: '5px' }}>
            <VehicleList
              vehicles={vehicles}
              onVehicleClick={(v) => setSelectedVehicle(v)}
            />
          </div>
        </div>

      </div>
    </div>
  );
};

export default Project_Dashboard;
