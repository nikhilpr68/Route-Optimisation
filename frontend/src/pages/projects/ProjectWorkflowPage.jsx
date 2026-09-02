import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { createProjectShare, getProjectShare } from '../../api/api';
import { SECTION_CONFIG, SECTION_ORDER } from './workflow/constants';
import {
  CompareRunsPanel,
  ConstraintsPanel,
  CostBreakdownPanel,
  ExportsPanel,
  MapPanel,
  RideAssignmentPanel,
} from './workflow/panel';
import DataOverviewSection from './workflow/DataOverviewSection';
import { useProjectWorkflowData } from './workflow/useProjectWorkflowData';

function SectionFallback({ id, section, navigate }) {
  return (
    <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
      <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Project Sections</h2>
      <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' }}>
        {SECTION_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => navigate(`/projects/${id}/${key}`)}
            style={{
              height: '36px',
              borderRadius: '9px',
              border: key === section ? '1px solid rgba(59,130,246,0.65)' : '1px solid rgba(255,255,255,0.2)',
              background: key === section ? 'rgba(37,99,235,0.32)' : 'rgba(255,255,255,0.06)',
              color: 'white',
              fontSize: '0.82rem',
              fontWeight: 700,
              cursor: 'pointer',
              textTransform: 'none',
            }}
          >
            {SECTION_CONFIG[key].title}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectShareCard({ projectId, projectDisplayName, sectionTitle, sectionSubtitle }) {
  const [shareState, setShareState] = useState({ enabled: false, shareUrl: null, createdAt: null });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showCopyToast, setShowCopyToast] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const copyToastTimerRef = useRef(null);
  const safeProjectName = useMemo(() => {
    const name = String(projectDisplayName || '').trim();
    if (!name || /invalid project id/i.test(name)) return 'Project';
    return name;
  }, [projectDisplayName]);
  const sectionTooltipText = String(sectionSubtitle || '').trim() || 'Detailed workflow view for this project section.';

  useEffect(() => {
    let mounted = true;

    async function loadShareState() {
      setLoading(true);
      try {
        const data = await getProjectShare(projectId);
        if (!mounted) return;
        setShareState(data || { enabled: false, shareUrl: null, createdAt: null });
      } catch (err) {
        if (!mounted) return;
        setError(err?.response?.data?.message || err?.message || 'Unable to load share link');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadShareState();
    return () => {
      mounted = false;
    };
  }, [projectId]);

  const handleShareClick = async () => {
    setError('');
    setMessage('');
    const existingUrl = String(shareState?.shareUrl || '').trim();
    if (shareState?.enabled && existingUrl) {
      setShowShareModal(true);
      return;
    }

    setSubmitting(true);
    try {
      const data = await createProjectShare(projectId);
      const nextState = data || { enabled: false, shareUrl: null, createdAt: null };
      setShareState(nextState);
      if (String(nextState?.shareUrl || '').trim()) {
        setShowShareModal(true);
      } else {
        setError('Unable to prepare public link.');
      }
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Unable to create public link');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    const shareUrl = String(shareState?.shareUrl || '').trim();
    if (!shareUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        const fallbackInput = document.createElement('textarea');
        fallbackInput.value = shareUrl;
        fallbackInput.setAttribute('readonly', '');
        fallbackInput.style.position = 'fixed';
        fallbackInput.style.opacity = '0';
        fallbackInput.style.pointerEvents = 'none';
        document.body.appendChild(fallbackInput);
        fallbackInput.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(fallbackInput);
        if (!copied) throw new Error('copy command failed');
      }
      setShowCopyToast(true);
      if (copyToastTimerRef.current) {
        window.clearTimeout(copyToastTimerRef.current);
      }
      copyToastTimerRef.current = window.setTimeout(() => {
        setShowCopyToast(false);
      }, 2400);
      setError('');
    } catch {
      setError('Copy failed. Use the link field directly.');
    }
  };

  useEffect(() => () => {
    if (copyToastTimerRef.current) {
      window.clearTimeout(copyToastTimerRef.current);
    }
  }, []);

  const closeShareModal = () => {
    setShowShareModal(false);
    setShowCopyToast(false);
  };

  useEffect(() => {
    if (!showShareModal) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        closeShareModal();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showShareModal]);

  return (
    <div className="relative z-[520] overflow-visible border-b border-slate-800 pb-4">
      <div className="relative z-[520] flex min-h-[52px] flex-wrap items-center justify-between gap-3 overflow-visible">
        <div className="flex items-end gap-4 text-sm">
          <div className="group relative z-[540]">
            <h1 className="m-0 cursor-default text-[2.15rem] font-black leading-none text-white">
              {sectionTitle}
            </h1>
            <div className="pointer-events-none absolute left-0 top-[calc(100%+10px)] z-[560] w-[390px] max-w-[80vw] rounded-xl border border-slate-700 bg-slate-900/95 p-3 text-xs leading-relaxed text-slate-200 opacity-0 shadow-2xl transition-opacity duration-150 group-hover:opacity-100">
              {sectionTooltipText}
            </div>
          </div>
          <span className="h-8 w-px bg-white/85" aria-hidden="true" />
          <div className="group relative z-[540]">
            <h2 className="m-0 cursor-default text-[1.3rem] font-semibold leading-none text-slate-200">
              {safeProjectName}
            </h2>
            <div className="pointer-events-none absolute left-0 top-[calc(100%+10px)] z-[560] w-[340px] max-w-[70vw] rounded-xl border border-slate-700 bg-slate-900/95 p-3 text-xs leading-relaxed text-slate-200 opacity-0 shadow-2xl transition-opacity duration-150 group-hover:opacity-100">
              Active project context for this workflow page.
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleShareClick}
            disabled={loading || submitting}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-cyan-400/45 bg-cyan-500/15 px-4 text-sm font-semibold text-cyan-100 shadow-[0_8px_24px_rgba(8,145,178,0.28)] backdrop-blur-sm transition hover:border-cyan-300/70 hover:bg-cyan-500/22 disabled:cursor-wait disabled:opacity-65"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M16 8a3 3 0 1 0-2.83-4h-.34a3 3 0 0 0-2.81 2H8a3 3 0 1 0 0 2h2.02a3 3 0 0 0 2.81 2h.34A3 3 0 1 0 16 8Zm0 8a3 3 0 0 0-2.83 2h-.34a3 3 0 0 0-2.81-2H8a3 3 0 1 0 0 2h2.02a3 3 0 0 0 2.81 2h.34A3 3 0 1 0 16 16Z" fill="currentColor" />
              <path d="M8 8h8v8H8z" fill="currentColor" opacity="0.2" />
            </svg>
            {loading ? 'Loading...' : submitting ? 'Preparing...' : 'Share'}
          </button>
        </div>
      </div>

      {message ? <div className="mt-2 text-xs text-sky-300">{message}</div> : null}
      {error ? <div className="mt-2 text-xs text-rose-300">{error}</div> : null}

      {showShareModal && createPortal(
        <div
          onClick={closeShareModal}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9999,
            background: 'rgba(2, 6, 23, 0.58)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'fixed',
              top: 18,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10001,
              opacity: showCopyToast ? 1 : 0,
              pointerEvents: 'none',
              transition: 'opacity 900ms ease',
            }}
          >
            <div
              style={{
                borderRadius: 10,
                border: '1px solid rgba(34,197,94,0.4)',
                background: 'rgba(20,83,45,0.84)',
                color: '#dcfce7',
                padding: '8px 12px',
                fontSize: '0.82rem',
                fontWeight: 700,
                boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
              }}
            >
              Link copied to clipboard
            </div>
          </div>
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'relative',
              width: 'min(780px, 100%)',
              maxHeight: 'calc(100vh - 40px)',
              borderRadius: 20,
              border: '1px solid rgba(148,163,184,0.32)',
              background: 'linear-gradient(180deg, rgba(15,23,42,0.96), rgba(2,6,23,0.94))',
              boxShadow: '0 28px 80px rgba(0,0,0,0.5)',
              padding: '30px 30px 26px',
              display: 'flex',
              flexDirection: 'column',
              gap: 24,
              overflow: 'visible',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              zIndex: 10000,
            }}
          >
            <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#e2e8f0' }}>
              Public link generated
            </h3>
            <p style={{ margin: 0, opacity: 0.78, color: '#cbd5e1', fontSize: '0.93rem' }}>
              Share this link for read-only access to this project.
            </p>
            <input
              type="text"
              readOnly
              value={String(shareState?.shareUrl || '')}
              style={{
                width: '100%',
                height: 46,
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.32)',
                background: 'rgba(15,23,42,0.5)',
                color: '#e2e8f0',
                padding: '0 14px',
                fontSize: '0.92rem',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-500/70 bg-slate-800/55 px-3 text-sm font-semibold text-slate-100 transition hover:border-slate-300/70 hover:bg-slate-700/55"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z" fill="currentColor" />
                  </svg>
                  Copy Link
                </button>
                <span
                  style={{
                    fontSize: '0.8rem',
                    color: '#86efac',
                    opacity: showCopyToast ? 1 : 0,
                    transition: 'opacity 900ms ease',
                    pointerEvents: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Link copied to clipboard
                </span>
              </div>
              <button
                type="button"
                onClick={closeShareModal}
                className="inline-flex h-9 items-center rounded-md border border-blue-400/55 bg-blue-500/25 px-4 text-sm font-semibold text-blue-100 transition hover:bg-blue-500/38"
              >
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

const ProjectWorkflowPage = () => {
  const { id, section } = useParams();
  const navigate = useNavigate();

  const {
    projectName,
    parsedInput,
    parseReport,
    fileName,
    resultMetrics,
    resultPayload,
    compareRuns,
    objectiveTrend,
    loadingData,
    employeeQuery,
    setEmployeeQuery,
    employees,
    vehicles,
    flattenedVehicles,
    employeeColumns,
    vehicleColumns,
    filteredEmployees,
    invalidCoordinatesCount,
    duplicateIdsCount,
    invalidTimeWindowCount,
    missingCapacityCount,
    baselineRows,
    baselineArrayRows,
    baselineCostTotal,
    baselineTimeTotal,
    baselineCost,
    baselineTimeMins,
    rides,
    officeCenter,
    mapVehicles,
    mapEmployees,
    timelineEvents,
    distanceInfo,
    diagnosticsErrors,
    diagnosticsWarnings,
    costBreakdownData,
  } = useProjectWorkflowData({ id, section });

  const cfg = SECTION_CONFIG[section];
  if (!cfg) return <Navigate to={`/projects/${id}/map-view`} replace />;

  return (
    <div style={{ padding: '16px 10px 24px 4px', maxWidth: 'none', margin: 0, width: '100%', boxSizing: 'border-box', overflowX: 'hidden' }}>
      <div style={{ marginBottom: '16px' }}>
        <ProjectShareCard
          projectId={id}
          projectDisplayName={projectName || (fileName ? fileName.replace(/\.[^/.]+$/, '') : '')}
          sectionTitle={cfg.title}
          sectionSubtitle={cfg.subtitle}
        />
      </div>
      {section === 'data-overview' ? (
        <DataOverviewSection
          employees={employees}
          vehicles={vehicles}
          employeeQuery={employeeQuery}
          onEmployeeQueryChange={setEmployeeQuery}
          employeeColumns={employeeColumns}
          filteredEmployees={filteredEmployees}
          vehicleColumns={vehicleColumns}
          flattenedVehicles={flattenedVehicles}
          baselineCost={baselineCost}
          baselineTimeMins={baselineTimeMins}
          baselineArrayRows={baselineArrayRows}
          baselineRows={baselineRows}
          baselineCostTotal={baselineCostTotal}
          baselineTimeTotal={baselineTimeTotal}
          invalidCoordinatesCount={invalidCoordinatesCount}
          duplicateIdsCount={duplicateIdsCount}
          invalidTimeWindowCount={invalidTimeWindowCount}
          missingCapacityCount={missingCapacityCount}
          distanceInfo={distanceInfo}
          loadingData={loadingData}
          parsedInput={parsedInput}
          diagnosticsErrors={diagnosticsErrors}
          diagnosticsWarnings={diagnosticsWarnings}
        />
      ) : section === 'map-view' ? (
        <MapPanel
          projectId={id}
          employees={mapEmployees}
          vehicles={mapVehicles}
          rides={rides}
          officeCenter={officeCenter}
          timelineEvents={timelineEvents}
          distanceInfo={distanceInfo}
          loading={loadingData}
          hasParsedInput={Boolean(parsedInput)}
          hasResults={Boolean(resultPayload)}
        />
      ) : section === 'ride-assignment' ? (
        <RideAssignmentPanel
          rides={rides}
          employees={employees}
          vehicles={vehicles}
          timelineEvents={timelineEvents}
          officeCenter={officeCenter}
          distanceInfo={distanceInfo}
          showHeader={false}
        />
      ) : section === 'constraints' ? (
        <ConstraintsPanel
          rides={rides}
          employees={employees}
          resultPayload={resultPayload}
          projectId={id}
        />
      ) : section === 'cost-breakdown' ? (
        <CostBreakdownPanel costData={costBreakdownData} />
      ) : section === 'compare-runs' ? (
        <CompareRunsPanel
          solverRuns={compareRuns}
          objectiveTrend={objectiveTrend}
          loading={loadingData}
          distanceInfo={distanceInfo}
          baselineCost={baselineCost}
          baselineTimeMins={baselineTimeMins}
          resultPayload={resultPayload}
        />
      ) : section === 'exports' ? (
        <ExportsPanel
          projectName={projectName}
          parsedInput={parsedInput}
          parseReport={parseReport}
          resultPayload={resultPayload}
          resultMetrics={resultMetrics}
          costData={costBreakdownData}
          diagnosticsErrors={diagnosticsErrors}
          diagnosticsWarnings={diagnosticsWarnings}
          distanceInfo={distanceInfo}
        />
      ) : (
        <SectionFallback id={id} section={section} navigate={navigate} />
      )}
    </div>
  );
};

export default ProjectWorkflowPage;
