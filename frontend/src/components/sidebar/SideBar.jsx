import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { listProjects } from '../../api/api';

const PROJECT_MENU_ITEMS = [
  { key: 'map-view', label: 'Map View', icon: 'map' },
  { key: 'data-overview', label: 'Data Overview', icon: 'overview' },
  { key: 'ride-assignment', label: 'Ride Assignment', icon: 'assignment' },
  { key: 'constraints', label: 'Constraints & Violations', icon: 'shield' },
  { key: 'cost-breakdown', label: 'Cost Breakdown', icon: 'chart' },
  { key: 'compare-runs', label: 'Compare Runs', icon: 'compare' },
  { key: 'exports', label: 'Exports', icon: 'file' }
];

const Sidebar = () => {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [recentRuns, setRecentRuns] = useState([]);
  const [displayedRunsCount, setDisplayedRunsCount] = useState(5);
  const navigate = useNavigate();
  const location = useLocation();

  const isProjectView = location.pathname.includes('/projects/');
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/);
  const activeProjectId = projectMatch?.[1] || '';
  const activeProjectSection = projectMatch?.[2] || 'map-view';

  const handleHistoryClick = (e) => {
    e.stopPropagation(); // Prevent bubbling
    setShowHistory(!showHistory);
  };

  const handleNavigate = (path, options = {}) => {
    navigate(path, options);
  };

  useEffect(() => {
    let mounted = true;
    async function loadRecentRuns() {
      try {
        const data = await listProjects();
        const items = Array.isArray(data) ? data : (data.items || []);
        if (!mounted) return;
        setRecentRuns(items);
      } catch {
        if (!mounted) return;
        setRecentRuns([]);
      }
    }
    loadRecentRuns();
    return () => { mounted = false; };
  }, []);

  // Reset displayed count when history is toggled
  useEffect(() => {
    if (showHistory) {
      setDisplayedRunsCount(5);
    }
  }, [showHistory]);

  const handleRunsScroll = (e) => {
    const container = e.target;
    const scrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 10;

    if (scrolledToBottom && displayedRunsCount < recentRuns.length) {
      setDisplayedRunsCount((prev) => Math.min(prev + 5, recentRuns.length));
    }
  };

  const displayedRuns = recentRuns.slice(0, displayedRunsCount);

  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { setOpen(false); setShowHistory(false); }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        height: '100vh',
        width: open ? '280px' : '60px',
        zIndex: 100,
        transition: 'width 0.15s cubic-bezier(0.25, 0.8, 0.25, 1)',
        pointerEvents: 'auto',
      }}
    >
      {/* Invisible Hover Buffer */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: '24px', height: '100%' }} />

      {/* Sidebar Background */}
      <div
        style={{
          height: '100%',
          width: '100%',
          background: open ? 'rgba(0, 0, 0, 0.6)' : 'transparent',
          backdropFilter: open ? 'blur(30px)' : 'none',
          WebkitBackdropFilter: open ? 'blur(30px)' : 'none',

          /* REMOVED THE BORDER HERE */
          borderRight: 'none',

          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: '80px',
          paddingBottom: '20px',
          overflow: 'hidden',
          transition: 'all 0.3s ease',
        }}
      >

        {isProjectView ? (
          <div style={{ width: '100%' }}>
            {PROJECT_MENU_ITEMS.map((item) => (
              <ProjectFlowItem
                key={item.key}
                icon={item.icon}
                label={item.label}
                isOpen={open}
                isActive={activeProjectSection === item.key}
                onClick={() => {
                  if (!activeProjectId) return;
                  handleNavigate(`/projects/${activeProjectId}/${item.key}`);
                }}
              />
            ))}
          </div>
        ) : (
          <>
            <SidebarItem
              icon={<HomeIcon />}
              label="Home"
              isOpen={open}
              isActive={location.pathname === '/home'}
              onClick={() => handleNavigate('/home')}
            />

            <SidebarItem
              icon={<ChartIcon />}
              label="Metrics"
              isOpen={open}
              isActive={location.pathname === '/metrics'}
              onClick={() => handleNavigate('/metrics')}
            />

            <SidebarItem
              icon={<ValidateIcon />}
              label="Validater"
              isOpen={open}
              isActive={location.pathname === '/validator'}
              onClick={() => handleNavigate('/validator')}
            />

            <SidebarItem
              icon={<HistoryIcon />}
              label="Recent Runs"
              isOpen={open}
              onClick={handleHistoryClick}
              isActive={showHistory}
            />

            <div style={{
              width: '85%',
              maxHeight: (open && showHistory) ? '200px' : '0px',
              overflow: 'hidden',
              transition: 'max-height 0.3s ease',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: '12px',
              marginTop: (open && showHistory) ? '5px' : '0',
              marginBottom: (open && showHistory) ? '10px' : '0',
            }}>
              <div
                onScroll={handleRunsScroll}
                style={{
                  padding: '10px',
                  maxHeight: '200px',
                  overflowY: 'auto',
                  overflowX: 'hidden'
                }}
              >
                <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', opacity: 0.5, marginBottom: '8px', color: 'white' }}>
                  Latest
                </div>
                {displayedRuns.length ? (
                  displayedRuns.map((run) => (
                    <div
                      key={run._id || run.id}
                      onClick={() => handleNavigate(`/projects/${run._id || run.id}`)}
                      style={{
                        fontSize: '0.86rem',
                        padding: '7px 8px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        opacity: 0.88,
                        color: 'white',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {run.name || 'Untitled Run'}
                    </div>
                  ))
                ) : (
                  <div style={{ fontSize: '0.82rem', opacity: 0.65, color: 'white' }}>No runs yet</div>
                )}
              </div>
            </div>
          </>
        )}

        <div style={{ flex: 1 }} />

        <SidebarItem
          icon={<SettingsIcon />}
          label="Settings"
          isOpen={open}
          isActive={location.pathname === '/settings'}
          onClick={() => handleNavigate('/settings')}
        />
        <SidebarItem
          icon={<LogoutIcon />}
          label="Log Out"
          isOpen={open}
          onClick={() => {
            localStorage.removeItem('token');
            handleNavigate('/', { replace: true });
          }}
        />

      </div>
    </div>
  );
};

// Reusable Item Component
const SidebarItem = ({ icon, label, isOpen, onClick, isActive }) => {
  const [hover, setHover] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '85%',
        padding: '12px 14px',
        marginBottom: '6px',
        borderRadius: '12px',
        cursor: 'pointer',
        background: isActive ? 'rgba(255, 255, 255, 0.15)' : (hover ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
        color: isActive ? '#fff' : (hover ? '#fff' : 'rgba(255,255,255,0.7)'),
        transition: 'all 0.2s',
      }}
    >
      <div style={{ minWidth: '24px', display: 'flex', justifyContent: 'center' }}>
        {icon}
      </div>

      <span
        style={{
          marginLeft: '14px',
          fontSize: '0.9rem',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          opacity: isOpen ? 1 : 0,
          transform: isOpen ? 'translateX(0)' : 'translateX(10px)',
          transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
        }}
      >
        {label}
      </span>
    </div>
  );
};

const ProjectFlowItem = ({ icon, label, isOpen, isActive, onClick }) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '85%',
        padding: '12px 14px',
        marginBottom: '6px',
        borderRadius: '14px',
        cursor: 'pointer',
        background: isActive ? 'rgba(37,99,235,0.35)' : (hover ? 'rgba(255,255,255,0.08)' : 'transparent'),
        border: isActive ? '1px solid rgba(59,130,246,0.45)' : '1px solid transparent',
        color: '#dbe6ff',
        transition: 'all 0.2s'
      }}
    >
      <div style={{ minWidth: '24px', display: 'flex', justifyContent: 'center' }}>
        <ProjectIcon type={icon} />
      </div>
      <span
        style={{
          marginLeft: '14px',
          fontSize: '0.9rem',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          opacity: isOpen ? 1 : 0,
          transform: isOpen ? 'translateX(0)' : 'translateX(10px)',
          transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)'
        }}
      >
        {label}
      </span>
    </div>
  );
};

const ProjectIcon = ({ type }) => {
  switch (type) {
    case 'upload': return <UploadIcon />;
    case 'overview': return <OverviewIcon />;
    case 'map': return <MapIcon />;
    case 'assignment': return <AssignmentIcon />;
    case 'shield': return <ShieldIcon />;
    case 'validate': return <ValidateIcon />;
    case 'chart': return <ChartIcon />;
    case 'compare': return <CompareIcon />;
    case 'brain': return <BrainIcon />;
    case 'file': return <FileIcon />;
    default: return <OverviewIcon />;
  }
};

/* ICONS */
const HomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
    <path d="M12 2.9a1.8 1.8 0 0 1 1.2.45l7 6.2a1.8 1.8 0 0 1-1.2 3.15h-.5V19a3 3 0 0 1-3 3h-2.6a1.4 1.4 0 0 1-1.4-1.4v-4.2h-1v4.2A1.4 1.4 0 0 1 9.1 22H6.5a3 3 0 0 1-3-3v-6.3H3a1.8 1.8 0 0 1-1.2-3.15l7-6.2A1.8 1.8 0 0 1 12 2.9Z" />
  </svg>
);
const ChartIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>;
const HistoryIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>;
const SettingsIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm9.2 3.4c0-.37-.03-.73-.1-1.08l-2.35-.77a6.96 6.96 0 0 0-.7-1.67l1.12-2.2a9.3 9.3 0 0 0-1.52-1.52l-2.2 1.12a6.96 6.96 0 0 0-1.67-.7L13 2.8a9.23 9.23 0 0 0-2.16 0l-.77 2.35a6.96 6.96 0 0 0-1.67.7l-2.2-1.12a9.3 9.3 0 0 0-1.52 1.52l1.12 2.2c-.3.52-.53 1.08-.7 1.67l-2.35.77a9.23 9.23 0 0 0 0 2.16l2.35.77c.17.59.4 1.15.7 1.67l-1.12 2.2a9.3 9.3 0 0 0 1.52 1.52l2.2-1.12c.52.3 1.08.53 1.67.7l.77 2.35a9.23 9.23 0 0 0 2.16 0l.77-2.35c.59-.17 1.15-.4 1.67-.7l2.2 1.12a9.3 9.3 0 0 0 1.52-1.52l-1.12-2.2c.3-.52.53-1.08.7-1.67l2.35-.77c.07-.35.1-.71.1-1.08Z" />
  </svg>
);
const LogoutIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>;
const UploadIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
const OverviewIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><rect x="4" y="3" width="16" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="13" y2="16" /></svg>;
const MapIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polygon points="1 6 8 2 16 6 23 2 23 18 16 22 8 18 1 22 1 6" /><line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" /></svg>;
const AssignmentIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="13" y2="13" /><circle cx="6.5" cy="9" r="0.9" fill="currentColor" /><circle cx="6.5" cy="13" r="0.9" fill="currentColor" /></svg>;
const ShieldIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>;
const ValidateIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>;
const CompareIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" /><polyline points="8 21 3 21 3 16" /><line x1="15" y1="15" x2="3" y2="3" /></svg>;
const BrainIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M9.5 3a3.5 3.5 0 0 0-3.47 3.06A3.5 3.5 0 0 0 4 9.2a3.5 3.5 0 0 0 1.38 2.8 3.5 3.5 0 0 0 1.12 5.95A3.5 3.5 0 0 0 9.5 21H12V3H9.5zM14.5 3A3.5 3.5 0 0 1 18 6.06 3.5 3.5 0 0 1 20 9.2a3.5 3.5 0 0 1-1.38 2.8 3.5 3.5 0 0 1-1.12 5.95A3.5 3.5 0 0 1 14.5 21H12V3h2.5z" /></svg>;
const FileIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>;

export default Sidebar;
