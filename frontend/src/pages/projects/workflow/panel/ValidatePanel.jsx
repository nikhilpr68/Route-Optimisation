import React, { useEffect, useState } from 'react';
import { getResults, startRunValidation } from '../../../../api/api';
import { tableCell, tableHeadCell } from '../constants';

function ValidatePanel({ projectId }) {
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);

  // Poll for validation results
  useEffect(() => {
    if (validating && projectId) {
      const interval = setInterval(async () => {
        try {
          const result = await getResults(projectId);
          if (result?.runValidation?.status !== 'Running') {
            setValidationResult(result.runValidation);
            setValidating(false);
            setLastChecked(new Date());
            clearInterval(interval);
          }
        } catch (err) {
          console.error('Error polling validation:', err);
        }
      }, 2000);
      return () => clearInterval(interval);
    }
  }, [validating, projectId]);

  // Load existing validation result on mount
  useEffect(() => {
    if (projectId) {
      loadValidationResult();
    }
  }, [projectId]);

  const loadValidationResult = async () => {
    try {
      const result = await getResults(projectId);
      if (result?.runValidation) {
        setValidationResult(result.runValidation);
        setLastChecked(new Date());
      }
    } catch (err) {
      console.error('Error loading validation:', err);
    }
  };

  const handleRunValidation = async () => {
    if (!projectId) {
      alert('No project ID available');
      return;
    }

    setValidating(true);
    setValidationResult(null);
    setLastChecked(null);
    try {
      await startRunValidation(projectId);
    } catch (err) {
      alert('Failed to start validation: ' + (err.response?.data?.message || err.message));
      setValidating(false);
    }
  };

  const checks = validationResult?.checks || [];
  const passed = checks.filter((c) => c.status === 'Pass' || c.status === 'pass' || c.passed === true).length;
  const failed = checks.filter((c) => c.status === 'Fail' || c.status === 'fail' || c.passed === false).length;
  const warnings = checks.filter((c) => c.status === 'Warning' || c.status === 'warning').length;

  const overallStatus = validationResult?.status || 'Not Run';
  const statusColor =
    overallStatus === 'Passed' ? '#6ee7b7' :
    overallStatus === 'Failed' ? '#fca5a5' :
    overallStatus === 'Running' ? '#fde68a' : '#94a3b8';

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: '1400px', margin: '0 auto' }}>
      {/* Header Section */}
      <div className="glass-morphism reflective-card-container" style={{ padding: '24px 28px', borderRadius: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '2.2rem', fontWeight: 800, letterSpacing: '-0.5px' }}>Run Validation</h2>
            <p style={{ margin: '8px 0 0 0', opacity: 0.75, fontSize: '1.05rem', lineHeight: 1.5 }}>
              Validate solver output for feasibility, consistency, and quality checks
            </p>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            {lastChecked && (
              <span style={{ opacity: 0.65, fontSize: '0.9rem', fontWeight: 600 }}>
                Last checked: {lastChecked.toLocaleTimeString()}
              </span>
            )}
            <button
              type="button"
              style={{
                padding: '14px 28px',
                borderRadius: 12,
                border: validating ? '1px solid rgba(250,204,21,0.5)' : '1px solid rgba(96,165,250,0.5)',
                background: validating ? 'rgba(250,204,21,0.18)' : 'rgba(96,165,250,0.18)',
                color: 'white',
                fontSize: '1.05rem',
                fontWeight: 700,
                cursor: validating ? 'not-allowed' : 'pointer',
                opacity: validating ? 0.7 : 1,
                transition: 'all 0.2s',
                boxShadow: validating ? 'none' : '0 4px 12px rgba(96,165,250,0.2)'
              }}
              onClick={handleRunValidation}
              disabled={validating}
            >
            {validating ? '⏳ Running Validation...' : '▶ Run Validation'}
           </button>
          </div>
        </div>
      </div>

      {/* Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16 }}>
        <div className="glass-morphism reflective-card-container" style={{ padding: '20px 22px', borderRadius: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Overall Status</div>
          <div style={{ fontSize: '2rem', fontWeight: 900, color: statusColor, letterSpacing: '-0.5px' }}>
            {overallStatus}
          </div>
        </div>
        <div className="glass-morphism reflective-card-container" style={{ padding: '20px 22px', borderRadius: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Passed Checks</div>
          <div style={{ fontSize: '2rem', fontWeight: 900, color: '#6ee7b7', letterSpacing: '-0.5px' }}>
            {passed}
          </div>
        </div>
        <div className="glass-morphism reflective-card-container" style={{ padding: '20px 22px', borderRadius: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Warnings</div>
          <div style={{ fontSize: '2rem', fontWeight: 900, color: '#fde68a', letterSpacing: '-0.5px' }}>
            {warnings}
          </div>
        </div>
        <div className="glass-morphism reflective-card-container" style={{ padding: '20px 22px', borderRadius: 16 }}>
          <div style={{ opacity: 0.74, fontSize: '0.95rem', fontWeight: 600, marginBottom: 8 }}>Failed Checks</div>
          <div style={{ fontSize: '2rem', fontWeight: 900, color: '#fca5a5', letterSpacing: '-0.5px' }}>
            {failed}
          </div>
        </div>
      </div>

      {/* Validation Score */}
      {validationResult?.score !== undefined && (
        <div className="glass-morphism reflective-card-container" style={{ padding: '24px 28px', borderRadius: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800 }}>Validation Score</h3>
            <span style={{ fontSize: '3rem', fontWeight: 900, color: validationResult.score >= 80 ? '#6ee7b7' : validationResult.score >= 60 ? '#fde68a' : '#fca5a5', letterSpacing: '-1px' }}>
              {validationResult.score}%
            </span>
          </div>
          <div style={{ height: 16, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${validationResult.score}%`,
                height: '100%',
                background: validationResult.score >= 80 ? 'linear-gradient(90deg, #6ee7b7, #34d399)' : validationResult.score >= 60 ? 'linear-gradient(90deg, #fde68a, #fbbf24)' : 'linear-gradient(90deg, #fca5a5, #f87171)',
                transition: 'width 0.6s ease',
                boxShadow: '0 0 12px rgba(255,255,255,0.3)'
              }}
            />
          </div>
          {validationResult.message && (
            <p style={{ margin: '16px 0 0 0', opacity: 0.85, fontSize: '1rem', lineHeight: 1.6 }}>
              {validationResult.message}
            </p>
          )}
        </div>
      )}

      {/* Validation Checks Table */}
      {checks.length > 0 && (
        <div className="glass-morphism reflective-card-container" style={{ padding: '24px 28px', borderRadius: 18 }}>
          <h3 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800, marginBottom: 18 }}>Validation Checks</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                  <th style={{ ...tableHeadCell, fontSize: '1rem' }}>Check</th>
                  <th style={{ ...tableHeadCell, fontSize: '1rem' }}>Status</th>
                  <th style={{ ...tableHeadCell, fontSize: '1rem' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c, idx) => (
                  <tr key={idx} style={{ background: idx % 2 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                    <td style={{ ...tableCell, fontSize: '0.98rem', fontWeight: 600 }}>{c.name || c.check}</td>
                    <td style={tableCell}>
                      <span
                        style={{
                          padding: '6px 14px',
                          borderRadius: 999,
                          fontWeight: 700,
                          fontSize: '0.88rem',
                          background:
                            (c.status === 'Pass' || c.status === 'pass' || c.passed === true) ? 'rgba(16,185,129,0.18)' :
                            (c.status === 'Fail' || c.status === 'fail' || c.passed === false) ? 'rgba(239,68,68,0.18)' :
                            'rgba(245,158,11,0.18)',
                          color:
                            (c.status === 'Pass' || c.status === 'pass' || c.passed === true) ? '#34d399' :
                            (c.status === 'Fail' || c.status === 'fail' || c.passed === false) ? '#f87171' :
                            '#fbbf24',
                          border: `1px solid ${
                            (c.status === 'Pass' || c.status === 'pass' || c.passed === true) ? 'rgba(16,185,129,0.3)' :
                            (c.status === 'Fail' || c.status === 'fail' || c.passed === false) ? 'rgba(239,68,68,0.3)' :
                            'rgba(245,158,11,0.3)'
                          }`
                        }}
                      >
                        {c.status || (c.passed === true ? 'Pass' : c.passed === false ? 'Fail' : 'N/A')}
                      </span>
                    </td>
                    <td style={{ ...tableCell, fontSize: '0.95rem' }}>{c.detail || c.message || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!validationResult && !validating && (
        <div className="glass-morphism reflective-card-container" style={{ padding: '48px 32px', textAlign: 'center', borderRadius: 18 }}>
          <div style={{ 
            width: '80px', 
            height: '80px', 
            borderRadius: '50%', 
            background: 'rgba(96,165,250,0.12)', 
            border: '2px solid rgba(96,165,250,0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
            fontSize: '2.5rem'
          }}>
            ✓
          </div>
          <div style={{ opacity: 0.8, fontSize: '1.3rem', fontWeight: 700, marginBottom: 12 }}>
            No validation results yet
          </div>
          <p style={{ opacity: 0.6, fontSize: '1rem', margin: 0, lineHeight: 1.6 }}>
            Click "Run Validation" above to validate the solver output and check for issues
          </p>
        </div>
      )}

      {/* Python Output */}
      {validationResult?.pythonOutput && (
        <div className="glass-morphism reflective-card-container" style={{ padding: '24px 28px', borderRadius: 18 }}>
          <h3 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800, marginBottom: 16 }}>Python Validation Output</h3>
          <pre style={{
            background: 'rgba(0,0,0,0.4)',
            padding: 18,
            borderRadius: 12,
            overflow: 'auto',
            maxHeight: 400,
            fontSize: '0.9rem',
            lineHeight: 1.6,
            color: '#e2e8f0',
            border: '1px solid rgba(255,255,255,0.1)'
          }}>
            {validationResult.pythonOutput}
          </pre>
        </div>
      )}

      {/* Python Errors */}
      {validationResult?.pythonError && (
        <div className="glass-morphism reflective-card-container" style={{ padding: '24px 28px', borderRadius: 18, border: '1px solid rgba(239,68,68,0.4)' }}>
          <h3 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800, marginBottom: 16, color: '#f87171' }}>Python Validation Errors</h3>
          <pre style={{
            background: 'rgba(239,68,68,0.12)',
            padding: 18,
            borderRadius: 12,
            overflow: 'auto',
            maxHeight: 400,
            fontSize: '0.9rem',
            lineHeight: 1.6,
            color: '#fca5a5',
            border: '1px solid rgba(239,68,68,0.2)'
          }}>
            {validationResult.pythonError}
          </pre>
        </div>
      )}
    </div>
  );
}

export default ValidatePanel;
