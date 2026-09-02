import { useEffect, useMemo, useState } from 'react';
import { getCompareRuns, getParsedInput, getProject, getResults } from '../../../api/api';
import { deriveWorkflowData } from './deriveWorkflowData';

const SECTIONS_WITH_OVERVIEW_DATA = new Set([
  'data-overview',
  'map-view',
  'ride-assignment',
  'cost-breakdown',
  'compare-runs',
  'validate',
  'exports',
  'constraints',
]);

const WORKFLOW_CACHE_PREFIX = 'workflow-cache-v4';
const CACHE_TTL_MS = 10 * 60 * 1000;

function makeCacheKey(projectId) {
  return `${WORKFLOW_CACHE_PREFIX}:${projectId}`;
}

function readWorkflowCache(projectId) {
  if (typeof window === 'undefined' || !projectId) return null;
  try {
    const raw = window.sessionStorage.getItem(makeCacheKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const savedAt = Number(parsed?.savedAt || 0);
    if (!savedAt || (Date.now() - savedAt) > CACHE_TTL_MS) return null;
    return parsed?.data || null;
  } catch {
    return null;
  }
}

function writeWorkflowCache(projectId, data) {
  if (typeof window === 'undefined' || !projectId) return;
  try {
    window.sessionStorage.setItem(
      makeCacheKey(projectId),
      JSON.stringify({ savedAt: Date.now(), data })
    );
  } catch {
    // Ignore cache failures.
  }
}

function useProjectWorkflowData({ id, section }) {
  const cached = readWorkflowCache(id);
  const sectionNeedsOverview = SECTIONS_WITH_OVERVIEW_DATA.has(section);

  const [projectName, setProjectName] = useState(() => cached?.projectName || '');
  const [projectRunConfig, setProjectRunConfig] = useState(() => cached?.projectRunConfig || null);
  const [parsedInput, setParsedInput] = useState(() => cached?.parsedInput || null);
  const [parseReport, setParseReport] = useState(() => cached?.parseReport || null);
  const [fileName, setFileName] = useState(() => cached?.fileName || null);
  const [resultMetrics, setResultMetrics] = useState(() => cached?.resultMetrics || null);
  const [resultPayload, setResultPayload] = useState(() => cached?.resultPayload || null);
  const [compareRuns, setCompareRuns] = useState(() => cached?.compareRuns || []);
  const [objectiveTrend, setObjectiveTrend] = useState(() => cached?.objectiveTrend || []);
  const [loadingData, setLoadingData] = useState(() => sectionNeedsOverview && !cached);
  const [employeeQuery, setEmployeeQuery] = useState('');

  useEffect(() => {
    const cached = readWorkflowCache(id);
    setProjectName(cached?.projectName || '');
    setProjectRunConfig(cached?.projectRunConfig || null);
    setParsedInput(cached?.parsedInput || null);
    setParseReport(cached?.parseReport || null);
    setFileName(cached?.fileName || null);
    setResultMetrics(cached?.resultMetrics || null);
    setResultPayload(cached?.resultPayload || null);
    setCompareRuns(Array.isArray(cached?.compareRuns) ? cached.compareRuns : []);
    setObjectiveTrend(Array.isArray(cached?.objectiveTrend) ? cached.objectiveTrend : []);
    setLoadingData(SECTIONS_WITH_OVERVIEW_DATA.has(section) && !cached);
  }, [id, section]);

  useEffect(() => {
    const cached = readWorkflowCache(id);
    if (cached?.projectName) return undefined;
    let mounted = true;
    async function loadProject() {
      try {
        const project = await getProject(id);
        if (!mounted) return;
        setProjectName(project?.name || '');
        setProjectRunConfig(project?.runConfig || null);
      } catch {
        if (!mounted) return;
        setProjectName('');
        setProjectRunConfig(null);
      }
    }
    loadProject();
    return () => { mounted = false; };
  }, [id]);

  useEffect(() => {
    writeWorkflowCache(id, {
      projectName,
      projectRunConfig,
      parsedInput,
      parseReport,
      fileName,
      resultMetrics,
      resultPayload,
      compareRuns,
      objectiveTrend,
    });
  }, [id, projectName, projectRunConfig, parsedInput, parseReport, fileName, resultMetrics, resultPayload, compareRuns, objectiveTrend]);

  useEffect(() => {
    if (!SECTIONS_WITH_OVERVIEW_DATA.has(section)) return;
    let mounted = true;
    async function loadOverview() {
      setLoadingData(true);
      try {
        const inputPromise = getParsedInput(id)
          .then((inputData) => {
            if (!mounted) return;
            setParseReport(inputData?.parseReport || null);
            setParsedInput(inputData?.parsedInput || null);
            setFileName(inputData?.fileName || null);
          })
          .catch(() => {
            if (!mounted) return;
            setParseReport(null);
            setParsedInput(null);
            setFileName(null);
          });

        const resultsPromise = getResults(id)
          .then((resultsData) => {
            if (!mounted) return;
            setResultMetrics(resultsData?.metrics || resultsData?.results?.metrics || null);
            setResultPayload(resultsData?.results || null);
            const runs = Array.isArray(resultsData?.results?.solverRuns)
              ? resultsData.results.solverRuns
              : (Array.isArray(resultsData?.results?.solverRunsByOrder) ? resultsData.results.solverRunsByOrder : []);
            const trend = Array.isArray(resultsData?.results?.objectiveTrend) ? resultsData.results.objectiveTrend : [];
            setCompareRuns(runs);
            setObjectiveTrend(trend);
          })
          .catch(() => {
            if (!mounted) return;
            setResultMetrics(null);
            setResultPayload(null);
          });

        const comparePromise = section === 'compare-runs'
          ? getCompareRuns(id)
            .then((compareData) => {
              if (!mounted) return;
              const runs = Array.isArray(compareData?.solverRuns) ? compareData.solverRuns : [];
              const trend = Array.isArray(compareData?.objectiveTrend) ? compareData.objectiveTrend : [];
              if (runs.length) setCompareRuns(runs);
              if (trend.length) setObjectiveTrend(trend);
            })
            .catch(() => {
              // Keep results-derived compare data if dedicated compare endpoint fails.
            })
          : Promise.resolve();

        await Promise.allSettled([inputPromise, resultsPromise, comparePromise]);
      } catch {
        if (!mounted) return;
        setParseReport(null);
        setParsedInput(null);
        setFileName(null);
        setResultMetrics(null);
        setResultPayload(null);
        setCompareRuns([]);
        setObjectiveTrend([]);
      } finally {
        if (mounted) setLoadingData(false);
      }
    }
    loadOverview();
    return () => { mounted = false; };
  }, [id, section]);

  const derived = useMemo(
    () => deriveWorkflowData({
      projectRunConfig,
      parsedInput,
      parseReport,
      resultMetrics,
      resultPayload,
      employeeQuery,
    }),
    [projectRunConfig, parsedInput, parseReport, resultMetrics, resultPayload, employeeQuery]
  );

  return {
    projectName,
    projectRunConfig,
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
    ...derived,
  };
}

export { useProjectWorkflowData };
