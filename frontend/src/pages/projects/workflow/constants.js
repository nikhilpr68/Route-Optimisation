const SECTION_CONFIG = {
  'upload-parse': {
    title: 'Parse',
    subtitle: 'Parse testcase inputs for this run.'
  },
  'data-overview': {
    title: 'Data Overview',
    subtitle: 'Inspect parsed entities, counts, and quality checks.'
  },
  'map-view': {
    title: 'Map View',
    subtitle: 'Visualize routes, stops, and assignments on the map.'
  },
  'ride-assignment': {
    title: 'Ride Assignment',
    subtitle: 'Track employee-to-vehicle assignments, timings, and route distance details.'
  },
  constraints: {
    title: 'Constraints & Violations',
    subtitle: 'Track violated constraints, feasibility diagnostics, and run validation.'
  },
  'cost-breakdown': {
    title: 'Cost Breakdown',
    subtitle: 'Analyze cost components across routes and resources.'
  },
  'compare-runs': {
    title: 'Compare Runs',
    subtitle: 'Compare objective metrics with previous runs.'
  },
  explainability: {
    title: 'Explainability',
    subtitle: 'Understand solver decisions and assignment rationale.'
  },
  exports: {
    title: 'Exports',
    subtitle: 'Export outputs, reports, and run artifacts.'
  }
};

const SECTION_ORDER = Object.keys(SECTION_CONFIG);

const tableHeadCell = {
  textAlign: 'left',
  fontSize: '0.92rem',
  color: 'rgba(184,200,230,0.95)',
  fontWeight: 700,
  padding: '12px 10px',
  borderBottom: '1px solid rgba(255,255,255,0.12)'
};

const tableCell = {
  fontSize: '0.96rem',
  color: 'rgba(236,243,255,0.95)',
  padding: '14px 10px',
  borderBottom: '1px solid rgba(255,255,255,0.08)'
};

const mapControlStyle = {
  height: 40,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(10,20,44,0.65)',
  color: 'white',
  padding: '0 12px',
  outline: 'none',
  fontSize: '0.95rem',
};

const mapButtonStyle = {
  height: 40,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.03)',
  color: 'rgba(236,243,255,0.95)',
  padding: '0 14px',
  fontSize: '0.95rem',
  cursor: 'pointer',
};

const timelineBtnStyle = {
  width: 56,
  height: 56,
  borderRadius: 14,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.04)',
  color: 'rgba(236,243,255,0.95)',
  fontSize: '1.35rem',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};

const timelinePlayStyle = {
  width: 56,
  height: 56,
  borderRadius: 14,
  border: '1px solid rgba(96,165,250,0.45)',
  background: 'radial-gradient(circle, rgba(40,85,160,0.8), rgba(28,48,91,0.95))',
  color: 'rgba(236,243,255,0.95)',
  fontSize: '1.35rem',
  cursor: 'pointer',
  boxShadow: '0 0 0 5px rgba(59,130,246,0.08)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};

export {
  SECTION_CONFIG,
  SECTION_ORDER,
  tableHeadCell,
  tableCell,
  mapControlStyle,
  mapButtonStyle,
  timelineBtnStyle,
  timelinePlayStyle,
};
