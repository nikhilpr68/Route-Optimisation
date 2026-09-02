import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import { getSharedProject } from '../../api/api';
import DataOverviewSection from './workflow/DataOverviewSection';
import { deriveWorkflowData } from './workflow/deriveWorkflowData';
import { SECTION_CONFIG } from './workflow/constants';
import {
  CompareRunsPanel,
  ConstraintsPanel,
  CostBreakdownPanel,
  ExportsPanel,
  MapPanel,
  RideAssignmentPanel,
} from './workflow/panel';

const SHARED_SECTION_ORDER = [
  'map-view',
  'data-overview',
  'ride-assignment',
  'constraints',
  'cost-breakdown',
  'compare-runs',
  'exports',
];

function SharedSectionNav({ token, section, navigate }) {
  return (
    <div
      className="glass-morphism reflective-card-container"
      style={{
        padding: '14px',
        borderRadius: 18,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: 10,
      }}
    >
      {SHARED_SECTION_ORDER.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => navigate(`/shared/projects/${token}/${key}`)}
          style={{
            minHeight: 46,
            borderRadius: 12,
            border: key === section ? '1px solid rgba(96,165,250,0.5)' : '1px solid rgba(255,255,255,0.12)',
            background: key === section ? 'rgba(37,99,235,0.24)' : 'rgba(255,255,255,0.04)',
            color: 'white',
            fontSize: '0.9rem',
            fontWeight: 700,
            cursor: 'pointer',
            padding: '0 12px',
          }}
        >
          {SECTION_CONFIG[key]?.title || key}
        </button>
      ))}
    </div>
  );
}

function SharedProjectPage() {
  const { token, section } = useParams();
  const navigate = useNavigate();
  const [sharedProject, setSharedProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [employeeQuery, setEmployeeQuery] = useState('');

  const activeSection = SHARED_SECTION_ORDER.includes(section) ? section : 'map-view';

  useEffect(() => {
    let mounted = true;

    async function loadSharedProject() {
      setLoading(true);
      setError('');
      try {
        const data = await getSharedProject(token);
        if (!mounted) return;
        setSharedProject(data || null);
      } catch (err) {
        if (!mounted) return;
        setSharedProject(null);
        setError(err?.response?.data?.message || err?.message || 'Unable to load shared project');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadSharedProject();
    return () => {
      mounted = false;
    };
  }, [token]);

  const derived = useMemo(
    () => deriveWorkflowData({
      projectRunConfig: sharedProject?.runConfig || null,
      parsedInput: sharedProject?.parsedInput || null,
      parseReport: sharedProject?.parseReport || null,
      resultMetrics: sharedProject?.metrics || sharedProject?.results?.metrics || null,
      resultPayload: sharedProject?.results || null,
      employeeQuery,
    }),
    [sharedProject, employeeQuery]
  );

  if (!SHARED_SECTION_ORDER.includes(section)) {
    return <Navigate to={`/shared/projects/${token}/map-view`} replace />;
  }

  return (
    <div style={{ minHeight: '100vh', padding: '32px 20px 48px', background: 'transparent', color: 'white' }}>
      <div style={{ maxWidth: 1480, margin: '0 auto', display: 'grid', gap: 16 }}>
        <div className="glass-morphism reflective-card-container" style={{ padding: '22px 24px', borderRadius: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ fontSize: '0.78rem', letterSpacing: '0.16em', textTransform: 'uppercase', opacity: 0.68 }}>
                Shared Project
              </div>
              <h1 style={{ margin: 0, fontSize: '2rem', lineHeight: 1.05 }}>
                {sharedProject?.name || 'Shared Route Optimization Project'}
              </h1>
              <p style={{ margin: 0, opacity: 0.78, maxWidth: 760, lineHeight: 1.55 }}>
                Read-only view of the latest shared optimization snapshot.
              </p>
            </div>
            <div style={{ display: 'grid', gap: 6, minWidth: 220 }}>
              <div style={{ opacity: 0.68, fontSize: '0.86rem' }}>Status</div>
              <div style={{ fontSize: '1.15rem', fontWeight: 800 }}>{sharedProject?.status || 'Pending'}</div>
              {sharedProject?.sharedAt ? (
                <div style={{ opacity: 0.7, fontSize: '0.85rem' }}>
                  Shared {new Date(sharedProject.sharedAt).toLocaleString()}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <SharedSectionNav token={token} section={activeSection} navigate={navigate} />

        {loading ? (
          <div className="glass-morphism reflective-card-container" style={{ padding: 28, borderRadius: 20 }}>
            Loading shared project...
          </div>
        ) : error ? (
          <div className="glass-morphism reflective-card-container" style={{ padding: 28, borderRadius: 20, color: '#fca5a5' }}>
            {error}
          </div>
        ) : activeSection === 'data-overview' ? (
          <DataOverviewSection
            employees={derived.employees}
            vehicles={derived.vehicles}
            employeeQuery={employeeQuery}
            onEmployeeQueryChange={setEmployeeQuery}
            employeeColumns={derived.employeeColumns}
            filteredEmployees={derived.filteredEmployees}
            vehicleColumns={derived.vehicleColumns}
            flattenedVehicles={derived.flattenedVehicles}
            baselineCost={derived.baselineCost}
            baselineTimeMins={derived.baselineTimeMins}
            baselineArrayRows={derived.baselineArrayRows}
            baselineRows={derived.baselineRows}
            baselineCostTotal={derived.baselineCostTotal}
            baselineTimeTotal={derived.baselineTimeTotal}
            invalidCoordinatesCount={derived.invalidCoordinatesCount}
            duplicateIdsCount={derived.duplicateIdsCount}
            invalidTimeWindowCount={derived.invalidTimeWindowCount}
            missingCapacityCount={derived.missingCapacityCount}
            distanceInfo={derived.distanceInfo}
            loadingData={loading}
            parsedInput={sharedProject?.parsedInput || null}
            diagnosticsErrors={derived.diagnosticsErrors}
            diagnosticsWarnings={derived.diagnosticsWarnings}
          />
        ) : activeSection === 'map-view' ? (
          <MapPanel
            employees={derived.mapEmployees}
            vehicles={derived.mapVehicles}
            rides={derived.rides}
            officeCenter={derived.officeCenter}
            timelineEvents={derived.timelineEvents}
            distanceInfo={derived.distanceInfo}
            loading={loading}
            hasParsedInput={Boolean(sharedProject?.parsedInput)}
            hasResults={Boolean(sharedProject?.results)}
          />
        ) : activeSection === 'ride-assignment' ? (
          <RideAssignmentPanel
            rides={derived.rides}
            employees={derived.employees}
            vehicles={derived.vehicles}
            timelineEvents={derived.timelineEvents}
            officeCenter={derived.officeCenter}
            distanceInfo={derived.distanceInfo}
            showHeader={false}
          />
        ) : activeSection === 'constraints' ? (
          <ConstraintsPanel
            rides={derived.rides}
            employees={derived.employees}
            resultPayload={sharedProject?.results || null}
            initialValidationResult={sharedProject?.runValidation || null}
            readOnly
          />
        ) : activeSection === 'cost-breakdown' ? (
          <CostBreakdownPanel costData={derived.costBreakdownData} />
        ) : activeSection === 'compare-runs' ? (
          <CompareRunsPanel
            solverRuns={Array.isArray(sharedProject?.results?.solverRuns) ? sharedProject.results.solverRuns : []}
            objectiveTrend={Array.isArray(sharedProject?.results?.objectiveTrend) ? sharedProject.results.objectiveTrend : []}
            loading={loading}
            distanceInfo={derived.distanceInfo}
            baselineCost={derived.baselineCost}
            baselineTimeMins={derived.baselineTimeMins}
            resultPayload={sharedProject?.results || null}
          />
        ) : (
          <ExportsPanel
            projectName={sharedProject?.name || ''}
            parsedInput={sharedProject?.parsedInput || null}
            parseReport={sharedProject?.parseReport || null}
            resultPayload={sharedProject?.results || null}
            resultMetrics={sharedProject?.metrics || sharedProject?.results?.metrics || null}
            costData={derived.costBreakdownData}
            diagnosticsErrors={derived.diagnosticsErrors}
            diagnosticsWarnings={derived.diagnosticsWarnings}
            distanceInfo={derived.distanceInfo}
          />
        )}
      </div>
    </div>
  );
}

export default SharedProjectPage;
