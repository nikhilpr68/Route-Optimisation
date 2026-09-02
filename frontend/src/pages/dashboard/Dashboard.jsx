import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import DragDrop from './components/Drag_drop';

import { listProjects, deleteProject, bulkDeleteProjects, renameProject } from '../../api/api';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const RUNS_BATCH_SIZE = 12;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toYmd(dateObj) {
  return `${dateObj.getFullYear()}-${pad2(dateObj.getMonth() + 1)}-${pad2(dateObj.getDate())}`;
}

function parseYmd(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function prettyDate(ymd) {
  const d = parseYmd(ymd);
  if (!d) return 'Select Date';
  return `${pad2(d.getDate())} ${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

const CustomCalendarFilter = ({ value, onChange }) => {
  const wrapperRef = useRef(null);
  const selectedDate = parseYmd(value);
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(
    selectedDate ? new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1) : new Date(today.getFullYear(), today.getMonth(), 1)
  );

  useEffect(() => {
    const onDocDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: 132 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          height: 34,
          borderRadius: 12,
          border: '1px solid rgba(163,191,227,0.34)',
          background: 'linear-gradient(180deg, rgba(28,33,44,0.58), rgba(10,12,18,0.54))',
          color: 'rgba(234,243,255,0.96)',
          fontSize: '0.78rem',
          fontWeight: 700,
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          boxShadow: '0 10px 24px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.12)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)'
        }}
      >
        <span>{prettyDate(value)}</span>
        <span style={{ opacity: 0.9 }}>v</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            right: 0,
            width: 280,
            borderRadius: 14,
            border: '1px solid rgba(163,191,227,0.3)',
            background: 'linear-gradient(180deg, rgba(24,29,39,0.92), rgba(10,12,18,0.9))',
            boxShadow: '0 18px 42px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)',
            padding: 12,
            zIndex: 60,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1rem' }}
            >
              {"<"}
            </button>
            <div style={{ color: 'white', fontWeight: 700, fontSize: '0.9rem' }}>{MONTH_NAMES[month]} {year}</div>
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month + 1, 1))}
              style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1rem' }}
            >
              {">"}
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {WEEKDAY_SHORT.map((w) => (
              <div key={w} style={{ textAlign: 'center', fontSize: '0.72rem', color: 'rgba(220,230,255,0.75)', fontWeight: 700 }}>
                {w}
              </div>
            ))}
            {cells.map((d, idx) => {
              if (!d) return <div key={`e-${idx}`} style={{ height: 30 }} />;
              const ymd = toYmd(d);
              const isSelected = value === ymd;
              const isToday = toYmd(today) === ymd;
              return (
                <button
                  key={ymd}
                  type="button"
                  onClick={() => {
                    onChange(ymd);
                    setOpen(false);
                  }}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: isToday ? '1px solid rgba(96,165,250,0.95)' : '1px solid transparent',
                    background: isSelected ? 'rgba(96,165,250,0.92)' : 'rgba(255,255,255,0.04)',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: isSelected ? 800 : 600
                  }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const RunTag = ({ status }) => {
  const s = String(status || 'pending').toLowerCase();
  const tone = {
    pending: { bg: 'rgba(59,130,246,0.16)', border: 'rgba(59,130,246,0.35)', text: '#93c5fd' },
    processing: { bg: 'rgba(168,85,247,0.16)', border: 'rgba(168,85,247,0.35)', text: '#c084fc' },
    completed: { bg: 'rgba(74,222,128,0.16)', border: 'rgba(74,222,128,0.35)', text: '#86efac' },
  }[s] || { bg: 'rgba(255,255,255,0.1)', border: 'rgba(255,255,255,0.2)', text: '#e2e8f0' };

  return (
    <span
      style={{
        padding: '5px 10px',
        borderRadius: 999,
        fontSize: '0.72rem',
        fontWeight: 700,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.text,
        letterSpacing: '0.2px',
        textTransform: 'capitalize'
      }}
    >
      {s}
    </span>
  );
};

const PROCESSING_PROGRESS_MS = {
  low: 90 * 1000,
  medium: 180 * 1000,
  high: 360 * 1000,
  custom: 180 * 1000,
};
const FIXED_GENERATIONS_BY_INTENSITY = {
  low: 30,
  medium: 60,
  high: 135,
  custom: 60,
};

function clampPercent(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

function resolveExpectedProcessingMs(project) {
  const intensity = String(project?.runConfig?.optimizationIntensity || 'medium').toLowerCase();
  const explicitCustomSeconds = Number(project?.runConfig?.customMaxRunSeconds);
  if (intensity === 'custom' && Number.isFinite(explicitCustomSeconds) && explicitCustomSeconds > 0) {
    return explicitCustomSeconds * 1000;
  }

  const explicitCustomGenerations = Number(project?.runConfig?.customGenerations);
  if (intensity === 'custom' && Number.isFinite(explicitCustomGenerations) && explicitCustomGenerations > 0) {
    const baselineGenerations = FIXED_GENERATIONS_BY_INTENSITY.medium;
    const baselineMs = PROCESSING_PROGRESS_MS.medium;
    return Math.max(1000, (explicitCustomGenerations / baselineGenerations) * baselineMs);
  }

  return PROCESSING_PROGRESS_MS[intensity] || PROCESSING_PROGRESS_MS.medium;
}

function getExplicitRunProgress(project) {
  const directCandidates = [
    project?.run?.progressPct,
    project?.run?.progressPercent,
    project?.run?.progress,
    project?.run?.completionPct,
    project?.run?.completionPercent,
    project?.results?.progressPct,
    project?.results?.progressPercent,
    project?.results?.progress,
  ];
  for (const candidate of directCandidates) {
    const clamped = clampPercent(candidate);
    if (clamped !== null) return clamped;
  }

  const solverRuns = Array.isArray(project?.results?.solverRunsByOrder)
    ? project.results.solverRunsByOrder
    : (Array.isArray(project?.results?.solverRuns) ? project.results.solverRuns : []);
  if (!solverRuns.length) return null;

  let executed = 0;
  let planned = 0;
  solverRuns.forEach((run) => {
    const runExecuted = Number(run?.generationsExecuted);
    const runPlanned = Number(run?.generationsPlanned);
    if (Number.isFinite(runExecuted) && runExecuted > 0) executed += runExecuted;
    if (Number.isFinite(runPlanned) && runPlanned > 0) planned += runPlanned;
  });
  if (planned <= 0) return null;
  return clampPercent((executed / planned) * 100);
}

function getProcessingProgress(project, nowTs = Date.now()) {
  const explicitProgress = getExplicitRunProgress(project);
  if (explicitProgress !== null) {
    return {
      percent: clampPercent(explicitProgress, 1, 100),
      mode: 'actual',
    };
  }

  const startedAt = project?.run?.startedAt || project?.updatedAt || project?.createdAt || null;
  const startedTs = startedAt ? new Date(startedAt).getTime() : NaN;
  const expectedMs = resolveExpectedProcessingMs(project);
  if (!Number.isFinite(startedTs)) {
    return {
      percent: 5,
      mode: 'estimated',
    };
  }

  const elapsedMs = Math.max(0, nowTs - startedTs);
  if (elapsedMs <= expectedMs) {
    const linear = 4 + ((elapsedMs / Math.max(1, expectedMs)) * 92);
    return {
      percent: clampPercent(linear, 4, 96),
      mode: 'estimated',
    };
  }

  const overrunMs = elapsedMs - expectedMs;
  const tail = 96 + (Math.log1p(overrunMs / Math.max(1, expectedMs * 0.25)) * 1.35);
  return {
    percent: clampPercent(tail, 96, 99),
    mode: 'estimated',
  };
}

const ProcessingRunIndicator = ({ project }) => {
  const [nowTs, setNowTs] = useState(() => Date.now());
  const { percent: progress, mode } = getProcessingProgress(project, nowTs);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowTs(Date.now());
    }, 800);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div
      style={{
        width: '100%',
        display: 'grid',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#d8b4fe', letterSpacing: '0.02em' }}>
          Processing
        </span>
        <span style={{ fontSize: '0.68rem', opacity: 0.72, color: '#e9d5ff' }}>
          {Math.round(progress)}%
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'rgba(168,85,247,0.18)',
          border: '1px solid rgba(168,85,247,0.28)',
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.28)',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            borderRadius: 999,
            background: 'linear-gradient(90deg, #a855f7, #c084fc 55%, #e9d5ff)',
            boxShadow: '0 0 14px rgba(192,132,252,0.45)',
            transition: 'width 0.75s ease',
          }}
        />
      </div>
    </div>
  );
};

const ContextMenu = ({
  x,
  y,
  onRename,
  onDelete,
  onSelectMultiple,
  onDeleteSelected,
  selectionMode = false,
}) => (
  <div
    style={{
      position: 'fixed',
      top: y,
      left: x,
      zIndex: 1000,
      background: 'rgba(8,12,24,0.96)',
      border: '1px solid rgba(255,255,255,0.14)',
      borderRadius: '10px',
      padding: '4px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      minWidth: '150px'
    }}
    onClick={(e) => e.stopPropagation()}
    onMouseDown={(e) => e.stopPropagation()}
  >
    {!selectionMode ? (
      <>
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRename();
          }}
          style={{
            padding: '9px 12px',
            fontSize: '0.88rem',
            color: '#dbeafe',
            cursor: 'pointer',
            borderRadius: '8px',
            transition: 'background 0.1s'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.16)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          Edit Name
        </div>
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          style={{
            padding: '9px 12px',
            fontSize: '0.88rem',
            color: '#fca5a5',
            cursor: 'pointer',
            borderRadius: '8px',
            transition: 'background 0.1s'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(248,113,113,0.16)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          Delete Run
        </div>
      </>
    ) : null}
    {selectionMode ? (
      <div
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDeleteSelected();
        }}
        style={{
          padding: '9px 12px',
          fontSize: '0.88rem',
          color: '#fca5a5',
          cursor: 'pointer',
          borderRadius: '8px',
          transition: 'background 0.1s'
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(248,113,113,0.16)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        Delete Selected Runs
      </div>
    ) : (
      <div
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelectMultiple();
        }}
        style={{
          padding: '9px 12px',
          fontSize: '0.88rem',
          color: '#bfdbfe',
          cursor: 'pointer',
          borderRadius: '8px',
          transition: 'background 0.1s'
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.16)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        Select Multiple
      </div>
    )}
  </div>
);

const Dashboard = () => {
  const navigate = useNavigate();
  const [runDateFilter, setRunDateFilter] = useState('');
  const [runStatusFilter, setRunStatusFilter] = useState('all');
  const [projectsHidden, setProjectsHidden] = useState(false);
  const [visibleRunsCount, setVisibleRunsCount] = useState(RUNS_BATCH_SIZE);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeProjectId, setActiveProjectId] = useState(null);
  // Prevent "Recent Runs" flicker during the brief window where the client has
  // started a run but the backend list still reports it as pending/notrun.
  const pinnedRecentRunIdsRef = useRef(new Set());
  const [contextMenu, setContextMenu] = useState(null); // { x, y, projectId }
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState([]);

  const getProjectId = (p) => p?._id || p?.id;

  const fetchProjects = async (options = {}) => {
    try {
      const data = await listProjects(options);
      const list = Array.isArray(data) ? data : (data.items || []);
      setProjects((prev) => {
        const pinned = pinnedRecentRunIdsRef.current;
        if (!pinned.size) return list;

        const nextIds = new Set(list.map((p) => getProjectId(p)).filter(Boolean));
        const prevById = new Map(
          (Array.isArray(prev) ? prev : [])
            .map((p) => [getProjectId(p), p])
            .filter(([id]) => Boolean(id))
        );

        const pinnedCarryOver = (Array.isArray(prev) ? prev : []).filter((p) => {
          const id = getProjectId(p);
          return id && pinned.has(id) && !nextIds.has(id);
        });

        // If the backend briefly "regresses" a just-started run (or hasn't persisted it yet),
        // keep the locally-known run fields so the item doesn't disappear/relabel.
        const merged = list.map((project) => {
          const id = getProjectId(project);
          if (!id || !pinned.has(id)) return project;

          const prior = prevById.get(id);
          if (!prior) return project;

          if (hasSolverRunBeenTriggered(project)) return project;

          const priorStatus = String(prior?.status || '').trim().toLowerCase();
          const priorRunState = String(prior?.run?.state || '').trim().toLowerCase();
          const priorStartedAt = prior?.run?.startedAt;
          const priorLooksRunning = priorStatus === 'processing'
            || priorRunState === 'running'
            || Boolean(priorStartedAt);

          if (!priorLooksRunning) return project;

          return {
            ...project,
            status: prior?.status || project?.status,
            run: {
              ...(project?.run || {}),
              ...(prior?.run || {}),
            },
          };
        });

        return [...pinnedCarryOver, ...merged];
      });
    } catch (err) {
      console.error('Failed to load projects', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjects();
    const handleClickAway = () => setContextMenu(null);
    window.addEventListener('click', handleClickAway);
    return () => window.removeEventListener('click', handleClickAway);
  }, []);

  useEffect(() => {
    const hasProcessingRuns = projects.some((project) => {
      const status = String(project?.status || '').trim().toLowerCase();
      const runState = String(project?.run?.state || '').trim().toLowerCase();
      return status === 'processing' || runState === 'running';
    });
    if (!hasProcessingRuns) return undefined;

    const intervalId = window.setInterval(() => {
      fetchProjects({ forceRefresh: true });
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [projects]);

  const handleUploadCompleted = (pid) => {
    fetchProjects();
    const navId = pid || activeProjectId;
    if (navId) navigate(`/projects/${navId}`);
  };

  const handleRunStarted = (pid) => {
    if (!pid) return;
    setActiveProjectId(pid);
    pinnedRecentRunIdsRef.current.add(pid);

    const startedAt = new Date().toISOString();
    setProjects((prev) => {
      const index = prev.findIndex((project) => getProjectId(project) === pid);
      if (index === -1) {
        return [
          {
            _id: pid,
            name: 'Run starting...',
            status: 'Processing',
            run: {
              state: 'Running',
              startedAt,
              finishedAt: null,
              error: '',
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          },
          ...prev,
        ];
      }

      const next = [...prev];
      const current = next[index] || {};
      next[index] = {
        ...current,
        status: 'Processing',
        run: {
          ...(current.run || {}),
          state: 'Running',
          startedAt: current?.run?.startedAt || startedAt,
          finishedAt: null,
          error: '',
        },
      };
      return next;
    });

    // Reconcile with backend shortly after the run starts.
    window.setTimeout(() => fetchProjects({ forceRefresh: true }), 500);
    window.setTimeout(() => fetchProjects({ forceRefresh: true }), 2000);
  };

  const handleContextMenu = (e, projectId) => {
    e.preventDefault();
    if (!projectId) return;
    if (selectionMode) {
      setSelectedProjectIds((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
    }
    setContextMenu({ x: e.clientX, y: e.clientY, projectId });
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedProjectIds([]);
  };

  const enterSelectionMode = (projectId) => {
    setSelectionMode(true);
    setSelectedProjectIds((prev) => {
      if (!projectId) return prev;
      return prev.includes(projectId) ? prev : [...prev, projectId];
    });
    setContextMenu(null);
  };

  const toggleSelectedProject = (projectId) => {
    if (!projectId) return;
    setSelectedProjectIds((prev) => (
      prev.includes(projectId)
        ? prev.filter((id) => id !== projectId)
        : [...prev, projectId]
    ));
  };

  const handleDeleteRun = async (projectId) => {
    if (!projectId) return;
    if (!confirm('Delete this run?')) {
      setContextMenu(null);
      return;
    }
    try {
      await deleteProject(projectId);
      setProjects((prev) => prev.filter((p) => getProjectId(p) !== projectId));
      if (activeProjectId === projectId) setActiveProjectId(null);
    } catch (err) {
      alert('Failed to delete run: ' + (err.response?.data?.message || err.message));
    } finally {
      setContextMenu(null);
    }
  };

  const handleBulkDelete = async () => {
    const ids = selectedProjectIds.filter(Boolean);
    if (!ids.length) {
      alert('Select at least one run to delete.');
      return;
    }
    if (!confirm(`Delete ${ids.length} selected ${ids.length === 1 ? 'run' : 'runs'}?`)) return;

    try {
      await bulkDeleteProjects(ids);
      setProjects((prev) => prev.filter((p) => !ids.includes(getProjectId(p))));
      if (ids.includes(activeProjectId)) setActiveProjectId(null);
      exitSelectionMode();
    } catch (err) {
      alert('Failed to delete selected runs: ' + (err.response?.data?.message || err.message));
    }
  };

  const handleRenameRun = async (projectId) => {
    if (!projectId) return;
    const current = projects.find((p) => getProjectId(p) === projectId);
    const currentName = String(current?.name || '');
    const nextName = prompt('Enter new run name', currentName);

    if (nextName == null) {
      setContextMenu(null);
      return;
    }

    const trimmed = nextName.trim();
    if (!trimmed) {
      alert('Run name is required');
      setContextMenu(null);
      return;
    }
    if (trimmed === currentName.trim()) {
      setContextMenu(null);
      return;
    }

    try {
      const updated = await renameProject(projectId, trimmed);
      setProjects((prev) => prev.map((p) => (
        getProjectId(p) === projectId
          ? { ...p, ...(updated || {}), name: updated?.name || trimmed }
          : p
      )));
    } catch (err) {
      alert('Failed to rename run: ' + (err.response?.data?.message || err.message));
    } finally {
      setContextMenu(null);
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const month = d.toLocaleDateString('en-US', { month: 'short' });
    const day = d.toLocaleDateString('en-US', { day: '2-digit' });
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
  };

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const toLocalDateKey = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const getScheduleDate = (project) => project?.runConfig?.runDate || project?.createdAt || project?.updatedAt;

  const getScheduleDateKey = (project) => {
    const runDate = project?.runConfig?.runDate;
    if (typeof runDate === 'string') {
      const exactDate = runDate.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
      if (exactDate) return exactDate[1];
    }
    return toLocalDateKey(getScheduleDate(project));
  };

  const getUploadTimestamp = (project) => {
    const artifacts = Array.isArray(project?.inputArtifacts) ? project.inputArtifacts : [];
    if (artifacts.length > 0) {
      const lastArtifact = artifacts[artifacts.length - 1];
      if (lastArtifact?.createdAt) return lastArtifact.createdAt;
    }
    return project?.createdAt || project?.updatedAt || null;
  };

  const hasSolverRunBeenTriggered = (project) => {
    const status = String(project?.status || '').trim().toLowerCase();
    const runState = String(project?.run?.state || '').trim().toLowerCase();
    const startedAtTs = project?.run?.startedAt ? new Date(project.run.startedAt).getTime() : NaN;
    const finishedAtTs = project?.run?.finishedAt ? new Date(project.run.finishedAt).getTime() : NaN;
    const hasResults = Boolean(project?.results && typeof project.results === 'object');
    const hasRunError = Boolean(String(project?.run?.error || '').trim());

    if (Number.isFinite(startedAtTs) || Number.isFinite(finishedAtTs)) return true;
    if (hasResults || hasRunError) return true;
    if (['running', 'done', 'failed', 'infeasible'].includes(runState)) return true;
    if (['processing', 'completed', 'failed', 'infeasible'].includes(status)) return true;
    return false;
  };

  useEffect(() => {
    // Drop pins once the backend reports the run as started/completed.
    // (Pinned IDs live in a ref, so this effect keeps the set bounded over time.)
    const pinned = pinnedRecentRunIdsRef.current;
    if (!pinned.size) return;
    for (const project of projects) {
      const id = getProjectId(project);
      if (!id || !pinned.has(id)) continue;
      if (hasSolverRunBeenTriggered(project)) pinned.delete(id);
    }
  }, [projects]);

  const getRunLifecycleTag = (project) => {
    const status = String(project?.status || '').trim().toLowerCase();
    const runState = String(project?.run?.state || '').trim().toLowerCase();
    const validationState = String(project?.runValidation?.status || '').trim().toLowerCase();
    const hasPassedValidation = validationState === 'passed';
    const hasGeneratedResult = Boolean(project?.results && typeof project.results === 'object');

    const isRunning = status === 'processing' || runState === 'running';
    const isPending = status === 'pending' || runState === 'notrun';

    if (isRunning) return 'processing';

    // If a run produced any result payload, always show it as completed (even if marked infeasible/failed).
    if (hasGeneratedResult || hasPassedValidation) return 'completed';

    const parseStatus = String(project?.parseReport?.status || '').trim().toLowerCase();

    // Remove failed: anything non-processing with no result stays completed (or pending for review).
    if (parseStatus === 'needs_review' || isPending) return 'pending';
    return 'completed';
  };

  const runTriggeredProjects = projects.filter((p) => (
    hasSolverRunBeenTriggered(p) || pinnedRecentRunIdsRef.current.has(getProjectId(p))
  ));

  const filteredProjects = runTriggeredProjects.filter((p) => {
    const byDate = !runDateFilter || getScheduleDateKey(p) === runDateFilter;
    const byStatus = runStatusFilter === 'all' || getRunLifecycleTag(p) === runStatusFilter;
    return byDate && byStatus;
  });

  const getRecentActivityTimestamp = (project) => {
    const candidates = [
      project?.run?.startedAt,
      project?.run?.finishedAt,
      project?.updatedAt,
      getUploadTimestamp(project),
      project?.createdAt,
      getScheduleDate(project),
    ];
    for (const value of candidates) {
      const ts = value ? new Date(value).getTime() : NaN;
      if (Number.isFinite(ts)) return ts;
    }
    return 0;
  };

  const sortedProjects = [...filteredProjects].sort((a, b) => {
    const activityDelta = getRecentActivityTimestamp(b) - getRecentActivityTimestamp(a);
    if (activityDelta !== 0) return activityDelta;

    const scheduleDelta = new Date(getScheduleDate(b) || 0).getTime() - new Date(getScheduleDate(a) || 0).getTime();
    if (scheduleDelta !== 0) return scheduleDelta;

    const bId = String(getProjectId(b) || '');
    const aId = String(getProjectId(a) || '');
    return bId.localeCompare(aId);
  });
  const visibleProjects = sortedProjects.slice(0, visibleRunsCount);
  const hasMoreRuns = sortedProjects.length > visibleRunsCount;
  const hasExpandedRuns = visibleRunsCount > RUNS_BATCH_SIZE;
  const canShowRunControls = sortedProjects.length > RUNS_BATCH_SIZE;

  useEffect(() => {
    setVisibleRunsCount(RUNS_BATCH_SIZE);
  }, [runDateFilter, runStatusFilter]);
  const visibleProjectIds = visibleProjects.map((project) => getProjectId(project)).filter(Boolean);
  const hasSelectedProjects = selectedProjectIds.length > 0;

  const handleToggleAllSelection = () => {
    if (hasSelectedProjects) {
      setSelectedProjectIds([]);
      setContextMenu(null);
      return;
    }
    setSelectedProjectIds(visibleProjectIds);
    setContextMenu(null);
  };

  return (
    <div style={{ padding: '20px 16px 20px 8px', width: '100%', maxWidth: 'none', margin: 0, boxSizing: 'border-box', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRename={() => handleRenameRun(contextMenu.projectId)}
          onDelete={() => handleDeleteRun(contextMenu.projectId)}
          onSelectMultiple={() => enterSelectionMode(contextMenu.projectId)}
          onDeleteSelected={handleBulkDelete}
          selectionMode={selectionMode}
        />
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div style={{ flex: '0 0 38%', minHeight: 230, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 8px' }}>
          <div style={{ width: '100%', maxWidth: '100%', height: '100%' }}>
            <DragDrop
              projectId={activeProjectId}
              onCompleted={handleUploadCompleted}
              onRunStarted={handleRunStarted}
              onProjectCreated={(pid) => { setActiveProjectId(pid); fetchProjects(); }}
            />
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, padding: '4px 8px', display: 'flex', justifyContent: 'center', overflow: 'hidden' }}>
          <div style={{ width: '100%', maxWidth: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', gap: '10px', flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.6px' }}>Recent Runs</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {selectionMode ? (
                <>
                  <span style={{ opacity: 0.88, fontSize: '0.82rem', fontWeight: 700 }}>
                    {selectedProjectIds.length} selected
                  </span>
                  <button
                    type="button"
                    onClick={handleToggleAllSelection}
                    style={{
                      height: 34,
                      borderRadius: 10,
                      border: '1px solid rgba(96,165,250,0.35)',
                      background: 'rgba(30,41,59,0.72)',
                      color: '#dbeafe',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '0 12px',
                      cursor: 'pointer'
                    }}
                  >
                    {hasSelectedProjects ? 'Cancel All' : 'Select All'}
                  </button>
                  <button
                    type="button"
                    onClick={handleBulkDelete}
                    style={{
                      height: 34,
                      borderRadius: 10,
                      border: '1px solid rgba(248,113,113,0.35)',
                      background: 'rgba(127,29,29,0.32)',
                      color: '#fecaca',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      padding: '0 12px',
                      cursor: 'pointer'
                    }}
                  >
                    Delete Selected Runs
                  </button>
                  {hasSelectedProjects ? (
                    <button
                      type="button"
                      onClick={exitSelectionMode}
                      style={{
                        height: 34,
                        borderRadius: 10,
                        border: '1px solid rgba(255,255,255,0.18)',
                        background: 'rgba(255,255,255,0.04)',
                        color: 'white',
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        padding: '0 12px',
                        cursor: 'pointer'
                      }}
                    >
                      Cancel
                    </button>
                  ) : null}
                </>
              ) : null}
              <span style={{ opacity: 0.75, fontSize: '0.95rem' }}>Status</span>
              <select
                value={runStatusFilter}
                onChange={(e) => setRunStatusFilter(e.target.value)}
                style={{
                  height: 34,
                  borderRadius: 12,
                  border: '1px solid rgba(163,191,227,0.34)',
                  background: 'linear-gradient(180deg, rgba(28,33,44,0.58), rgba(10,12,18,0.54))',
                  color: 'rgba(234,243,255,0.96)',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  padding: '0 10px',
                  cursor: 'pointer',
                  boxShadow: '0 10px 24px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.12)',
                  backdropFilter: 'blur(10px)',
                  WebkitBackdropFilter: 'blur(10px)'
                }}
              >
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="completed">Completed</option>
              </select>
              <span style={{ opacity: 0.75, fontSize: '0.95rem' }}>Find by date</span>
              <CustomCalendarFilter value={runDateFilter} onChange={setRunDateFilter} />
              {runDateFilter ? (
                <button
                  type="button"
                  onClick={() => setRunDateFilter('')}
                  style={{
                    height: 34,
                    borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.18)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'white',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    padding: '0 10px',
                    cursor: 'pointer'
                  }}
                >
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setProjectsHidden((prev) => !prev)}
                style={{
                  height: 34,
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.18)',
                  background: projectsHidden ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.04)',
                  color: 'white',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  padding: '0 12px',
                  cursor: 'pointer'
                }}
              >
                {projectsHidden ? 'Show Projects' : 'Hide Projects'}
              </button>
            </div>
          </div>

          {loading ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <p style={{ opacity: 0.7 }}>Loading runs...</p>
            </div>
          ) : projectsHidden ? (
            <div style={{ flex: 1, minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <p style={{ opacity: 0.72, margin: 0, fontSize: '0.95rem' }}>Projects are hidden.</p>
            </div>
          ) : sortedProjects.length === 0 ? (
            <div style={{ flex: 1, minHeight: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px' }}>
              <div style={{
                width: '76px',
                height: '76px',
                borderRadius: '999px',
                display: 'grid',
                placeItems: 'center',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.12)'
              }}>
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15.5 14" />
                </svg>
              </div>
              <h3 style={{ margin: 0, fontSize: '2.8rem', fontWeight: 700 }}>No runs yet</h3>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: '9px',
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  paddingRight: '2px',
                  alignContent: 'start',
                  alignItems: 'start'
                }}
              >
                {visibleProjects.map((p) => (
                    <div
                    key={getProjectId(p)}
                    className="glass-morphism reflective-card-container interactive"
                    onClick={() => {
                      const projectId = getProjectId(p);
                      if (selectionMode) {
                        toggleSelectedProject(projectId);
                        return;
                      }
                      navigate(`/projects/${projectId}`);
                    }}
                    onContextMenu={(e) => handleContextMenu(e, getProjectId(p))}
                    style={{
                      minHeight: '84px',
                      minWidth: '200px',
                      borderRadius: '14px',
                      padding: '8px 12px',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      alignItems: 'stretch',
                      overflow: 'hidden',
                      cursor: 'pointer',
                      border: selectedProjectIds.includes(getProjectId(p))
                        ? '1px solid rgba(96,165,250,0.95)'
                        : '1px solid transparent',
                      background: selectedProjectIds.includes(getProjectId(p))
                        ? 'linear-gradient(180deg, rgba(30,58,138,0.28), rgba(15,23,42,0.88))'
                        : undefined,
                      boxShadow: selectedProjectIds.includes(getProjectId(p))
                        ? '0 0 0 1px rgba(96,165,250,0.3), 0 12px 30px rgba(30,64,175,0.18)'
                        : undefined
                    }}
                  >
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                        <div style={{ fontSize: '0.88rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.name || 'Untitled Run'}
                        </div>
                        {selectionMode ? (
                          <div
                            style={{
                              width: 18,
                              height: 18,
                              borderRadius: 999,
                              flex: '0 0 auto',
                              border: selectedProjectIds.includes(getProjectId(p))
                                ? '1px solid rgba(147,197,253,1)'
                                : '1px solid rgba(255,255,255,0.35)',
                              background: selectedProjectIds.includes(getProjectId(p))
                                ? 'rgba(59,130,246,0.95)'
                                : 'transparent',
                              color: 'white',
                              display: 'grid',
                              placeItems: 'center',
                              fontSize: '0.72rem',
                              fontWeight: 900
                            }}
                          >
                            {selectedProjectIds.includes(getProjectId(p)) ? 'X' : ''}
                          </div>
                        ) : null}
                      </div>
                      <div style={{ fontSize: '0.65rem', opacity: 0.68, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '3px' }}>
                        <span>{formatDate(getScheduleDate(p))}</span>
                        <span>|</span>
                        <span>{formatTime(getUploadTimestamp(p))}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
                        {getRunLifecycleTag(p) === 'processing' ? (
                          <ProcessingRunIndicator project={p} />
                        ) : (
                          <RunTag status={getRunLifecycleTag(p)} />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {canShowRunControls ? (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {hasMoreRuns ? (
                      <button
                        type="button"
                        onClick={() => setVisibleRunsCount((prev) => prev + RUNS_BATCH_SIZE)}
                        style={{
                          height: 36,
                          borderRadius: 12,
                          border: '1px solid rgba(163,191,227,0.34)',
                          background: 'linear-gradient(180deg, rgba(28,33,44,0.58), rgba(10,12,18,0.54))',
                          color: 'rgba(234,243,255,0.96)',
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          padding: '0 14px',
                          cursor: 'pointer',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.12)',
                          backdropFilter: 'blur(10px)',
                          WebkitBackdropFilter: 'blur(10px)'
                        }}
                      >
                        Show more
                      </button>
                    ) : null}
                    {hasExpandedRuns ? (
                      <button
                        type="button"
                        onClick={() => setVisibleRunsCount((prev) => Math.max(RUNS_BATCH_SIZE, prev - RUNS_BATCH_SIZE))}
                        style={{
                          height: 36,
                          borderRadius: 12,
                          border: '1px solid rgba(200,208,224,0.28)',
                          background: 'linear-gradient(180deg, rgba(24,27,35,0.54), rgba(8,10,16,0.5))',
                          color: 'rgba(241,245,255,0.92)',
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          padding: '0 14px',
                          cursor: 'pointer',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.1)',
                          backdropFilter: 'blur(10px)',
                          WebkitBackdropFilter: 'blur(10px)'
                        }}
                      >
                        Show less
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
