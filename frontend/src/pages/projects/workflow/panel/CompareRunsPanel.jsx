import React, { useMemo, useState } from 'react';
import { parseNumericLike } from '../helpers';

const TABLE_COLUMNS = [
  { key: 'rank', label: 'Rank', width: '72px' },
  { key: 'run', label: 'Run', width: '88px' },
  { key: 'objective', label: 'Objective (No Penalty)', width: '190px' },
  { key: 'cost', label: 'Total Cost', width: '130px' },
  { key: 'time', label: 'Total Time', width: '120px' },
  { key: 'delay', label: 'Delay', width: '100px' },
  { key: 'vehicles', label: 'Vehicles', width: '90px' },
  { key: 'stops', label: 'Stops', width: '90px' },
  { key: 'unassigned', label: 'Unassigned', width: '110px' },
  { key: 'duration', label: 'Run Duration', width: '120px' },
  { key: 'status', label: 'Feasibility', width: '116px' },
];

const glassCardStyle = {
  borderRadius: 16,
  border: '1px solid rgba(255,255,255,0.2)',
  borderTop: '1px solid rgba(255,255,255,0.45)',
  borderBottom: '1px solid rgba(255,255,255,0.1)',
  background: 'rgba(10, 10, 10, 0.15)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
};

const sectionTitleStyle = {
  margin: 0,
  fontSize: '1.42rem',
  fontWeight: 800,
  color: 'rgba(236,243,255,0.98)',
  letterSpacing: '0.01em',
};

const CHART_GEOMETRY = {
  width: 980,
  height: 349,
  left: 70,
  right: 24,
  top: 22,
  bottom: 54,
};

const EXTRA_BOTTOM_OBJECTIVE_GAP_PX = 19;
const CHART_TOOLTIP_WIDTH = 168;
const CHART_TOOLTIP_HEIGHT = 54;

function formatObjective(value) {
  if (!Number.isFinite(value)) return '-';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTimeMinutes(value) {
  if (!Number.isFinite(value)) return '-';
  return `${Number(value).toFixed(1)} min`;
}

function formatCost(value) {
  if (!Number.isFinite(value)) return '-';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(2)} s`;
}

function normalizeSolutionStatus(rawStatus, feasibleFlag, unassignedCount) {
  const normalized = String(rawStatus || '').trim().toLowerCase();
  if (['feasible', 'partial', 'infeasible'].includes(normalized)) return normalized;
  if (feasibleFlag === false) return 'infeasible';
  if (Number.isFinite(unassignedCount) && unassignedCount > 0) return 'partial';
  return 'feasible';
}

function formatSolutionStatus(status) {
  if (status === 'infeasible') return 'Infeasible';
  if (status === 'partial') return 'Partial';
  return 'Feasible';
}

function solutionStatusColor(status) {
  if (status === 'infeasible') return '#fda4af';
  if (status === 'partial') return '#fde68a';
  return '#86efac';
}

function formatSignedDelta(value, formatter, positivePrefix = '+') {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return '0';
  const abs = formatter(Math.abs(value));
  return value > 0 ? `${positivePrefix}${abs}` : `-${abs}`;
}

function resolveObjectiveWeights(payload = null) {
  const sources = [
    payload?.metadata,
    payload?.parsedInput?.metadata,
    payload?.input?.metadata,
    payload?.objectiveWeights,
    payload?.solverConfig,
  ];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const c = parseNumericLike(
      src?.cost
      ?? src?.objectiveCostWeight
      ?? src?.objective_cost_weight
      ?? src?.costWeight
      ?? src?.cost_weight
      ?? src?.OBJECTIVE_COST_WEIGHT
      ?? src?.OBJECTIVECOSTWEIGHT
    );
    const t = parseNumericLike(
      src?.time
      ?? src?.objectiveTimeWeight
      ?? src?.objective_time_weight
      ?? src?.timeWeight
      ?? src?.time_weight
      ?? src?.OBJECTIVE_TIME_WEIGHT
      ?? src?.OBJECTIVETIMEWEIGHT
    );
    const cost = Number.isFinite(c) ? Math.max(0, c) : null;
    const time = Number.isFinite(t) ? Math.max(0, t) : null;
    if (cost !== null && time !== null) {
      const sum = cost + time;
      if (sum > 0) return { cost: cost / sum, time: time / sum };
      continue;
    }
    if (cost !== null) {
      const clamped = Math.min(1, cost);
      return { cost: clamped, time: 1 - clamped };
    }
    if (time !== null) {
      const clamped = Math.min(1, time);
      return { cost: 1 - clamped, time: clamped };
    }
  }
  return { cost: 0.5, time: 0.5 };
}

function resolveDelayCostPerMinute(payload = null) {
  const sources = [
    payload?.metrics,
    payload?.solverConfig,
    payload?.metadata,
    payload?.parsedInput?.metadata,
    payload?.input?.metadata,
  ];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const delayCostPerMinute = parseNumericLike(
      src?.delayCostPerMinute
      ?? src?.delay_cost_per_minute
      ?? src?.delayPenaltyPerMinute
      ?? src?.delay_penalty_per_minute
      ?? src?.DELAY_COST_PER_MINUTE
      ?? src?.DELAYPENALTYPERMINUTE
    );
    if (Number.isFinite(delayCostPerMinute) && delayCostPerMinute >= 0) {
      return delayCostPerMinute;
    }
  }
  return 1;
}

function computeDisplayObjective({
  totalSystemCost,
  totalTimeMinutes,
  totalDelayMinutes,
  totalDelayCost = null,
  objectiveWeights,
  delayCostPerMinute,
  fallbackObjective = null,
}) {
  const cost = parseNumericLike(totalSystemCost);
  const time = parseNumericLike(totalTimeMinutes);
  const delay = parseNumericLike(totalDelayMinutes);
  const delayCostValue = parseNumericLike(totalDelayCost);
  if (Number.isFinite(cost) && Number.isFinite(time)) {
    const weighted = (cost * objectiveWeights.cost) + (time * objectiveWeights.time);
    const delayCost = Number.isFinite(delayCostValue)
      ? Math.max(0, delayCostValue)
      : ((Number.isFinite(delay) ? Math.max(0, delay) : 0) * Math.max(0, delayCostPerMinute));
    return weighted + delayCost;
  }
  const fallback = parseNumericLike(fallbackObjective);
  return Number.isFinite(fallback) ? fallback : null;
}

function normalizeNumericSeries(candidate = []) {
  if (!Array.isArray(candidate) || !candidate.length) return [];
  const rows = [];
  candidate.forEach((entry, idx) => {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      rows.push({ generation: idx + 1, objective: entry });
      return;
    }
    if (Array.isArray(entry)) {
      // Supports backend checkpoint history entries like [elapsedSec, objective].
      const objective = parseNumericLike(entry[1] ?? entry[0]);
      if (Number.isFinite(objective)) {
        rows.push({ generation: idx + 1, objective });
      }
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const generation = parseNumericLike(
      entry.generation ?? entry.gen ?? entry.iteration ?? entry.step ?? entry.index
    );
    const objective = parseNumericLike(
      entry.objectiveScore
      ?? entry.globalBestBaseObjective
      ?? entry.bestBaseObjective
      ?? entry.globalBestObjective
      ?? entry.bestObjective
      ?? entry.objective
      ?? entry.cost
      ?? entry.value
    );
    if (Number.isFinite(objective)) {
      rows.push({
        generation: Number.isFinite(generation) ? Math.max(1, Math.round(generation)) : (idx + 1),
        objective,
      });
    }
  });
  return rows
    .filter((row) => Number.isFinite(row.generation) && Number.isFinite(row.objective))
    .sort((a, b) => a.generation - b.generation);
}

function buildLinePath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i += 1) {
    const curr = points[i];
    d += ` L ${curr.x} ${curr.y}`;
  }
  return d;
}

function buildSemiLogTicks(minValue, maxValue) {
  if (!Number.isFinite(maxValue) || maxValue <= 1e-9) return [0];
  const safeMin = Number.isFinite(minValue) && minValue > 1e-9 ? minValue : (maxValue / 180);
  const minCandidate = Math.max(safeMin * 0.75, 1e-6);
  const ticks = new Set([0]);
  const startExponent = Math.floor(Math.log10(minCandidate)) - 1;
  const endExponent = Math.ceil(Math.log10(maxValue));

  for (let exponent = startExponent; exponent <= endExponent; exponent += 1) {
    [1, 2, 5].forEach((factor) => {
      const tickValue = factor * (10 ** exponent);
      if (tickValue < minCandidate || tickValue > maxValue * 1.001) return;
      ticks.add(Number(tickValue.toPrecision(10)));
    });
  }

  ticks.add(Number(maxValue.toPrecision(10)));
  return Array.from(ticks).sort((a, b) => a - b);
}

function CompareRunsPanel({
  solverRuns = [],
  loading = false,
  distanceInfo = null,
  baselineCost = null,
  baselineTimeMins = null,
  resultPayload = null,
}) {
  const objectiveWeights = useMemo(
    () => resolveObjectiveWeights(resultPayload),
    [resultPayload]
  );
  const delayCostPerMinute = useMemo(
    () => resolveDelayCostPerMinute(resultPayload),
    [resultPayload]
  );
  const runHistoryById = useMemo(() => {
    const map = new Map();
    const candidates = [
      ...(Array.isArray(resultPayload?.solverRunsByOrder) ? resultPayload.solverRunsByOrder : []),
      ...(Array.isArray(resultPayload?.solverRuns) ? resultPayload.solverRuns : []),
      ...(Array.isArray(solverRuns) ? solverRuns : []),
    ];
    candidates.forEach((row, idx) => {
      const runId = Number(row?.runId ?? row?.run ?? (idx + 1));
      if (!Number.isFinite(runId)) return;
      const previous = map.get(runId) || {};
      map.set(runId, { ...previous, ...(row || {}) });
    });
    return map;
  }, [resultPayload, solverRuns]);

  const normalizedRuns = useMemo(
    () => (Array.isArray(solverRuns) ? solverRuns : [])
      .map((row, idx) => {
        const runId = Number(row?.runId ?? row?.run ?? (idx + 1));
        const mergedRaw = {
          ...(runHistoryById.get(runId) || {}),
          ...(row || {}),
        };
        const rawObjectiveScore = parseNumericLike(mergedRaw?.objectiveScore ?? mergedRaw?.objective ?? mergedRaw?.score);
        const totalTimeMinutes = parseNumericLike(mergedRaw?.totalTimeMinutes ?? mergedRaw?.timeMinutes ?? mergedRaw?.time);
        const totalSystemCost = parseNumericLike(mergedRaw?.totalSystemCost ?? mergedRaw?.cost ?? mergedRaw?.totalCost);
        const totalDelayMinutes = parseNumericLike(mergedRaw?.totalDelayMinutes ?? mergedRaw?.delayMinutes ?? mergedRaw?.delay);
        const totalDelayCost = parseNumericLike(mergedRaw?.totalDelayCost ?? mergedRaw?.delayCost ?? mergedRaw?.delayPenalty);
        const objectiveScore = computeDisplayObjective({
          totalSystemCost,
          totalTimeMinutes,
          totalDelayMinutes,
          totalDelayCost,
          objectiveWeights,
          delayCostPerMinute,
          fallbackObjective: rawObjectiveScore,
        });
        const vehiclesUsed = parseNumericLike(mergedRaw?.vehiclesUsed ?? mergedRaw?.vehicles);
        const stops = parseNumericLike(mergedRaw?.stops ?? mergedRaw?.stopCount);
        const unassignedCount = parseNumericLike(mergedRaw?.unassignedCount ?? mergedRaw?.unassigned);
        const durationSeconds = parseNumericLike(mergedRaw?.durationSeconds ?? mergedRaw?.durationSec);
        const searchObjectiveScore = parseNumericLike(
          mergedRaw?.searchObjectiveScore
          ?? mergedRaw?.searchObjective
          ?? mergedRaw?.engineScore
          ?? mergedRaw?.score
          ?? mergedRaw?.objectiveScore
        );
        const seed = parseNumericLike(mergedRaw?.seed);
        const status = normalizeSolutionStatus(mergedRaw?.status, mergedRaw?.feasible !== false, unassignedCount);
        return {
          key: `${runId || idx + 1}-${mergedRaw?.strategy || 'run'}-${idx}`,
          runId: Number.isFinite(runId) ? runId : (idx + 1),
          strategy: String(mergedRaw?.strategy || 'Strategy'),
          objectiveScore,
          rawObjectiveScore,
          totalTimeMinutes,
          totalSystemCost,
          totalDelayMinutes,
          totalDelayCost,
          feasible: mergedRaw?.feasible !== false,
          status,
          searchObjectiveScore,
          vehiclesUsed,
          stops,
          unassignedCount,
          durationSeconds,
          seed,
          raw: mergedRaw,
        };
      })
      .filter((row) => row.objectiveScore !== null)
      .sort((a, b) => {
        const left = Number.isFinite(a.searchObjectiveScore) ? a.searchObjectiveScore : a.objectiveScore;
        const right = Number.isFinite(b.searchObjectiveScore) ? b.searchObjectiveScore : b.objectiveScore;
        return left - right;
      })
      .map((row, idx) => ({
        ...row,
        rank: idx + 1,
      })),
    [solverRuns, objectiveWeights, delayCostPerMinute, runHistoryById]
  );

  const [selectedRunKey, setSelectedRunKey] = useState(null);
  const [hoveredChartPoint, setHoveredChartPoint] = useState(null);

  const selectedRun = useMemo(() => {
    if (!normalizedRuns.length) return null;
    return normalizedRuns.find((run) => run.key === selectedRunKey) || normalizedRuns[0];
  }, [normalizedRuns, selectedRunKey]);

  const baselineObjective = useMemo(() => {
    const cost = parseNumericLike(baselineCost);
    const time = parseNumericLike(baselineTimeMins);
    if (!Number.isFinite(cost) || !Number.isFinite(time)) return null;
    return (cost * objectiveWeights.cost) + (time * objectiveWeights.time);
  }, [baselineCost, baselineTimeMins, objectiveWeights.cost, objectiveWeights.time]);

  const objectiveMetricLabel = distanceInfo?.backendLabel || distanceInfo?.metricLabel || 'unknown metric';
  const selectedRunSeriesInfo = (() => {
    if (!selectedRun) return { rows: [], source: 'none' };
    const raw = selectedRun.raw || {};
    const candidates = [
      raw.generationObjectiveHistory,
      raw.objectiveHistory,
      raw.generationHistory,
      raw.objectiveByGeneration,
      raw.perGenerationObjective,
      raw.bestHistory,
    ];
    for (const candidate of candidates) {
      const parsed = normalizeNumericSeries(candidate);
      if (parsed.length > 0) return { rows: parsed, source: 'backend' };
    }
    return { rows: [], source: 'missing' };
  })();

  const hasRealSeries = selectedRunSeriesInfo.source === 'backend';

  const selectedRunSeries = useMemo(() => {
    const rows = Array.isArray(selectedRunSeriesInfo.rows) ? [...selectedRunSeriesInfo.rows] : [];
    if (!Number.isFinite(baselineObjective)) return rows;
    if (!rows.length) return [{ generation: 0, objective: baselineObjective }];
    const firstGen = Number(rows[0]?.generation);
    if (!Number.isFinite(firstGen) || firstGen > 0) {
      rows.unshift({ generation: 0, objective: baselineObjective });
      return rows;
    }
    if (firstGen === 0) {
      rows[0] = { generation: 0, objective: baselineObjective };
    }
    return rows;
  }, [selectedRunSeriesInfo.rows, baselineObjective]);

  const semiLogSeries = useMemo(() => {
    return selectedRunSeries.map((row) => ({
      generation: row.generation,
      objective: row.objective,
      value: row.objective,
    }));
  }, [selectedRunSeries]);

  const chartPresentation = useMemo(() => {
    return {
      label: 'Objective Cost',
      axisCopy: `X-axis: generations/checkpoints, Y-axis: objective cost on a generation-1 anchored semi-log scale (${objectiveMetricLabel}).`,
      valueFormatter: formatObjective,
      lineStroke: '#34d399',
      pointFill: '#a7f3d0',
      haloFill: 'rgba(52,211,153,0.22)',
      gridStroke: 'rgba(52,211,153,0.18)',
      scaleType: 'semiLog',
      series: semiLogSeries.map((row) => ({
        generation: row.generation,
        value: row.value,
      })),
    };
  }, [objectiveMetricLabel, semiLogSeries]);

  const chartData = useMemo(() => {
    if (!chartPresentation.series.length) return null;
    const xMin = Math.min(...chartPresentation.series.map((d) => d.generation));
    const xMax = Math.max(...chartPresentation.series.map((d) => d.generation));
    const yMinRaw = Math.min(...chartPresentation.series.map((d) => d.value));
    const yMaxRaw = Math.max(...chartPresentation.series.map((d) => d.value));
    const plotWidth = CHART_GEOMETRY.width - CHART_GEOMETRY.left - CHART_GEOMETRY.right;
    const plotHeight = CHART_GEOMETRY.height - CHART_GEOMETRY.top - CHART_GEOMETRY.bottom;
    const isSemiLog = chartPresentation.scaleType === 'semiLog';
    const linearSpread = yMaxRaw - yMinRaw;
    const linearPad = linearSpread > 1e-9
      ? Math.max(1, linearSpread * 0.08)
      : Math.max(1, Math.abs(yMaxRaw) * 0.12);
    const linearYMin = Math.max(0, yMinRaw - linearPad);
    const linearYMax = yMaxRaw + linearPad;
    const realRows = Array.isArray(selectedRunSeriesInfo.rows) ? selectedRunSeriesInfo.rows : [];
    const firstRealObjective = realRows.length
      ? parseNumericLike(realRows[0]?.objective)
      : parseNumericLike(chartPresentation.series[0]?.value);
    const parsedFinalObjective = parseNumericLike(selectedRun?.objectiveScore);
    const finalObjective = Number.isFinite(parsedFinalObjective)
      ? parsedFinalObjective
      : (
        realRows.length
          ? parseNumericLike(realRows[realRows.length - 1]?.objective)
          : parseNumericLike(chartPresentation.series[chartPresentation.series.length - 1]?.value)
      );
    const anchorLow = Number.isFinite(firstRealObjective) && Number.isFinite(finalObjective)
      ? Math.min(firstRealObjective, finalObjective)
      : yMinRaw;
    const anchorHigh = Number.isFinite(firstRealObjective) && Number.isFinite(finalObjective)
      ? Math.max(firstRealObjective, finalObjective)
      : yMaxRaw;
    const anchorSpan = Math.max(0, anchorHigh - anchorLow);
    const hasTopOverflow = isSemiLog && yMaxRaw > (anchorHigh + 1e-9);
    const hasBottomOverflow = isSemiLog && yMinRaw < (anchorLow - 1e-9);
    const topOverflowMax = yMaxRaw;
    const bottomOverflowMin = yMinRaw;
    const topOverflowHeight = hasTopOverflow ? Math.max(plotHeight * 0.16, 18) : 0;
    const bottomOverflowHeight = hasBottomOverflow ? Math.max(plotHeight * 0.08, 12) : 0;
    const visualBottomPad = isSemiLog
      ? (Math.max(plotHeight * 0.05, 10) + EXTRA_BOTTOM_OBJECTIVE_GAP_PX)
      : 0;
    const mainTop = CHART_GEOMETRY.top + topOverflowHeight;
    const mainBottom = CHART_GEOMETRY.top + plotHeight - visualBottomPad - bottomOverflowHeight;
    const scaleLog = (value) => Math.log10(Math.max(0, value) + 1);

    const mapX = (g) => {
      if (xMax === xMin) return CHART_GEOMETRY.left;
      return CHART_GEOMETRY.left + (((g - xMin) / (xMax - xMin)) * plotWidth);
    };
    const mapY = (v) => {
      if (!isSemiLog) {
        if (linearYMax === linearYMin) return CHART_GEOMETRY.top + (plotHeight / 2);
        return CHART_GEOMETRY.top + (((linearYMax - v) / (linearYMax - linearYMin)) * plotHeight);
      }

      if (anchorSpan <= 1e-9) return CHART_GEOMETRY.top + (plotHeight / 2);

      if (v > anchorHigh && hasTopOverflow) {
        const overflowMax = Math.max(1e-9, topOverflowMax - anchorHigh);
        const t = scaleLog(v - anchorHigh) / scaleLog(overflowMax);
        return mainTop - (t * topOverflowHeight);
      }

      if (v < anchorLow && hasBottomOverflow) {
        const overflowMax = Math.max(1e-9, anchorLow - bottomOverflowMin);
        const t = scaleLog(anchorLow - v) / scaleLog(overflowMax);
        return mainBottom + (t * bottomOverflowHeight);
      }

      const clampedValue = Math.min(anchorHigh, Math.max(anchorLow, v));
      const t = scaleLog(clampedValue - anchorLow) / scaleLog(anchorSpan);
      return mainBottom - (t * Math.max(1, mainBottom - mainTop));
    };

    const points = chartPresentation.series.map((d) => ({
      ...d,
      x: mapX(d.generation),
      y: mapY(d.value),
    }));

    const yTicks = isSemiLog
      ? (() => {
        const tickValues = new Set();
        tickValues.add(Number(anchorLow.toPrecision(10)));
        tickValues.add(Number(anchorHigh.toPrecision(10)));
        if (hasTopOverflow) tickValues.add(Number(topOverflowMax.toPrecision(10)));
        if (hasBottomOverflow) tickValues.add(Number(bottomOverflowMin.toPrecision(10)));

        const positiveGaps = chartPresentation.series
          .map((row) => row.value - anchorLow)
          .filter((gap) => gap > 1e-9 && gap < anchorSpan - 1e-9);
        const minPositiveGap = positiveGaps.length ? Math.min(...positiveGaps) : Math.max(anchorSpan / 6, 1e-6);

        buildSemiLogTicks(minPositiveGap, Math.max(anchorSpan, 1e-6)).forEach((gap) => {
          tickValues.add(Number((anchorLow + gap).toPrecision(10)));
        });

        return Array.from(tickValues)
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => a - b)
          .map((value) => ({
            y: mapY(value),
            value,
            isAnchor: Math.abs(value - anchorLow) < 1e-6 || Math.abs(value - anchorHigh) < 1e-6,
          }));
      })()
      : Array.from({ length: 6 }, (_, idx) => {
        const ratio = idx / 5;
        return {
          y: CHART_GEOMETRY.top + (plotHeight * ratio),
          value: linearYMax - ((linearYMax - linearYMin) * ratio),
          isAnchor: false,
        };
      });

    const xTicks = (() => {
      const minGen = Math.round(xMin);
      const maxGen = Math.round(xMax);
      const span = Math.max(0, maxGen - minGen);
      const targetTickCount = 6;
      const step = Math.max(1, Math.ceil(span / Math.max(1, targetTickCount - 1)));
      const ticks = [];
      for (let g = minGen; g <= maxGen; g += step) {
        ticks.push({
          x: mapX(g),
          generation: g,
        });
      }
      if (!ticks.length || ticks[ticks.length - 1].generation !== maxGen) {
        ticks.push({
          x: mapX(maxGen),
          generation: maxGen,
        });
      }
      return ticks;
    })();

    return {
      points,
      yTicks,
      xTicks,
      path: buildLinePath(points),
      isSemiLog,
      showLowerAxisBreak: isSemiLog && anchorLow > 1e-9,
      lowerAxisBreakY: Math.min(
        CHART_GEOMETRY.top + plotHeight - 10,
        mainBottom + Math.max(10, ((visualBottomPad + bottomOverflowHeight) * 0.45)),
      ),
    };
  }, [chartPresentation, selectedRun?.objectiveScore, selectedRunSeriesInfo.rows]);

  const bestObjective = normalizedRuns[0]?.objectiveScore;
  const bestRun = normalizedRuns[0] || null;
  const selectedRunSummary = useMemo(() => {
    if (!selectedRun) return [];
    const objectiveDelta = Number.isFinite(bestRun?.objectiveScore) && Number.isFinite(selectedRun?.objectiveScore)
      ? selectedRun.objectiveScore - bestRun.objectiveScore
      : null;
    const costDelta = Number.isFinite(bestRun?.totalSystemCost) && Number.isFinite(selectedRun?.totalSystemCost)
      ? selectedRun.totalSystemCost - bestRun.totalSystemCost
      : null;
    const timeDelta = Number.isFinite(bestRun?.totalTimeMinutes) && Number.isFinite(selectedRun?.totalTimeMinutes)
      ? selectedRun.totalTimeMinutes - bestRun.totalTimeMinutes
      : null;
    const delayRatio = Number.isFinite(selectedRun.totalDelayMinutes) && Number.isFinite(selectedRun.totalTimeMinutes) && selectedRun.totalTimeMinutes > 0
      ? (selectedRun.totalDelayMinutes / selectedRun.totalTimeMinutes) * 100
      : null;

    return [
      {
        key: 'rank',
        label: 'Rank',
        value: `#${selectedRun.rank}`,
      },
      {
        key: 'objective',
        label: 'Objective (No Penalty)',
        value: formatObjective(selectedRun.objectiveScore),
        helper: objectiveDelta === null || Math.abs(objectiveDelta) < 1e-9
          ? undefined
          : `Gap vs best: ${formatSignedDelta(objectiveDelta, formatObjective)}`,
      },
      {
        key: 'cost',
        label: 'Total Cost',
        value: formatCost(selectedRun.totalSystemCost),
        helper: costDelta === null || Math.abs(costDelta) < 1e-9
          ? undefined
          : `Delta vs best: ${formatSignedDelta(costDelta, formatCost)}`,
      },
      {
        key: 'time',
        label: 'Total Time',
        value: formatTimeMinutes(selectedRun.totalTimeMinutes),
        helper: timeDelta === null || Math.abs(timeDelta) < 1e-9
          ? undefined
          : `Delta vs best: ${formatSignedDelta(timeDelta, (v) => `${Number(v).toFixed(1)} min`)}`,
      },
      {
        key: 'delay',
        label: 'Total Delay',
        value: formatTimeMinutes(selectedRun.totalDelayMinutes),
        helper: delayRatio === null ? undefined : `${delayRatio.toFixed(1)}% of total time`,
      },
      {
        key: 'vehicles',
        label: 'Vehicles Used',
        value: Number.isFinite(selectedRun.vehiclesUsed) ? String(selectedRun.vehiclesUsed) : '-',
      },
      {
        key: 'stops',
        label: 'Stops',
        value: Number.isFinite(selectedRun.stops) ? String(selectedRun.stops) : '-',
      },
      {
        key: 'unassigned',
        label: 'Unassigned',
        value: Number.isFinite(selectedRun.unassignedCount) ? String(selectedRun.unassignedCount) : '-',
      },
      {
        key: 'runtime',
        label: 'Run Duration',
        value: formatDuration(selectedRun.durationSeconds),
      },
      {
        key: 'status',
        label: 'Feasibility',
        value: formatSolutionStatus(selectedRun.status),
        helper: selectedRun.status === 'partial' && Number.isFinite(selectedRun.unassignedCount) && selectedRun.unassignedCount > 0
          ? `${selectedRun.unassignedCount} employees unassigned`
          : undefined,
        emphasize: true,
      },
    ];
  }, [bestRun, selectedRun]);

  if (loading) {
    return (
      <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
        Loading compare-runs data...
      </div>
    );
  }

  if (!normalizedRuns.length) {
    return (
      <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
        No solver run history available yet. Run the solver first, then open Compare Runs.
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div
        className="glass-morphism reflective-card-container"
        style={{
          ...glassCardStyle,
          padding: 18,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <h3 style={sectionTitleStyle}>All Solver Runs</h3>
        </div>

        <div style={{ border: '1px solid rgba(255,255,255,0.16)', borderRadius: 14, overflowX: 'auto', overflowY: 'hidden', background: 'rgba(5,11,26,0.35)' }}>
          <div style={{ minWidth: '1512px' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: TABLE_COLUMNS.map((col) => col.width).join(' '),
                gap: 0,
                background: 'rgba(255,255,255,0.07)',
                borderBottom: '1px solid rgba(255,255,255,0.14)',
                fontWeight: 700,
                fontSize: '0.9rem',
                color: 'rgba(210,225,250,0.95)',
              }}
            >
              {TABLE_COLUMNS.map((col) => (
                <div key={col.key} style={{ padding: '12px 10px' }}>{col.label}</div>
              ))}
            </div>

            <div
              style={{
                maxHeight: `${Math.max(1, Math.min(4, normalizedRuns.length)) * 62}px`,
                overflowY: normalizedRuns.length > 4 ? 'auto' : 'hidden',
                background: 'rgba(3,10,28,0.24)',
              }}
            >
              {normalizedRuns.map((run) => {
                const isSelected = selectedRun?.key === run.key;
                const delta = Number.isFinite(bestObjective) && Number.isFinite(run.objectiveScore)
                  ? (run.objectiveScore - bestObjective)
                  : null;

                return (
                  <button
                    key={run.key}
                    type="button"
                    onClick={() => {
                      setSelectedRunKey(run.key);
                      setHoveredChartPoint(null);
                    }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: TABLE_COLUMNS.map((col) => col.width).join(' '),
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      borderBottom: '1px solid rgba(255,255,255,0.09)',
                      cursor: 'pointer',
                      color: 'rgba(236,243,255,0.96)',
                      background: isSelected
                        ? 'linear-gradient(90deg, rgba(37,99,235,0.28), rgba(37,99,235,0.08))'
                        : 'rgba(255,255,255,0.02)',
                      outline: 'none',
                      fontSize: '0.93rem',
                    }}
                  >
                    <div style={{ padding: '11px 10px', fontWeight: 800, color: run.rank === 1 ? '#86efac' : '#dbe6ff' }}>
                      #{run.rank}
                    </div>
                    <div style={{ padding: '11px 10px' }}>{`Run ${run.runId}`}</div>
                    <div style={{ padding: '11px 10px', fontWeight: 800 }}>
                      {formatObjective(run.objectiveScore)}
                      {delta && delta > 0 ? (
                        <span style={{ marginLeft: 6, color: '#fda4af', fontWeight: 700 }}>
                          +{formatObjective(delta)}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ padding: '11px 10px' }}>{formatCost(run.totalSystemCost)}</div>
                    <div style={{ padding: '11px 10px' }}>{formatTimeMinutes(run.totalTimeMinutes)}</div>
                    <div style={{ padding: '11px 10px' }}>{formatTimeMinutes(run.totalDelayMinutes)}</div>
                    <div style={{ padding: '11px 10px' }}>{Number.isFinite(run.vehiclesUsed) ? run.vehiclesUsed : '-'}</div>
                    <div style={{ padding: '11px 10px' }}>{Number.isFinite(run.stops) ? run.stops : '-'}</div>
                    <div style={{ padding: '11px 10px' }}>{Number.isFinite(run.unassignedCount) ? run.unassignedCount : '-'}</div>
                    <div style={{ padding: '11px 10px' }}>{formatDuration(run.durationSeconds)}</div>
                    <div style={{ padding: '11px 10px', color: solutionStatusColor(run.status), fontWeight: 700 }}>
                      {formatSolutionStatus(run.status)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div
        className="glass-morphism reflective-card-container"
        style={{
          ...glassCardStyle,
          padding: 18,
          display: 'grid',
          gap: 14,
        }}
      >
        <div style={{ display: 'grid', gap: 6 }}>
          <h3 style={sectionTitleStyle}>
            {selectedRun ? `Run ${selectedRun.runId} Optimization Curve` : 'Run Optimization Curve'}
          </h3>
          <div style={{ opacity: 0.84, fontSize: '0.9rem', color: 'rgba(220,233,255,0.92)' }}>
            {chartPresentation.axisCopy}
          </div>
        </div>
        {selectedRun && chartData ? (
          <div style={{ border: '1px solid rgba(255,255,255,0.16)', borderRadius: 14, padding: 12, background: 'rgba(8,16,38,0.35)' }}>
            <svg
              viewBox={`0 0 ${CHART_GEOMETRY.width} ${CHART_GEOMETRY.height}`}
              style={{ width: '100%', height: 369 }}
              onMouseLeave={() => setHoveredChartPoint(null)}
              onMouseMove={(event) => {
                if (!chartData.points.length) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                const ratioX = bounds.width > 0
                  ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
                  : 0;
                const viewBoxX = ratioX * CHART_GEOMETRY.width;
                const nearestPoint = chartData.points.reduce((closest, point) => {
                  if (!closest) return point;
                  return Math.abs(point.x - viewBoxX) < Math.abs(closest.x - viewBoxX) ? point : closest;
                }, null);
                if (!nearestPoint) return;

                const tooltipX = Math.max(
                  CHART_GEOMETRY.left + 10,
                  Math.min(
                    nearestPoint.x + 12,
                    CHART_GEOMETRY.width - CHART_GEOMETRY.right - CHART_TOOLTIP_WIDTH - 8,
                  ),
                );
                const tooltipY = Math.max(
                  CHART_GEOMETRY.top + 8,
                  nearestPoint.y - CHART_TOOLTIP_HEIGHT - 12,
                );

                setHoveredChartPoint({
                  ...nearestPoint,
                  tooltipX,
                  tooltipY,
                });
              }}
            >
              <rect
                x={CHART_GEOMETRY.left}
                y={CHART_GEOMETRY.top}
                width={CHART_GEOMETRY.width - CHART_GEOMETRY.left - CHART_GEOMETRY.right}
                height={CHART_GEOMETRY.height - CHART_GEOMETRY.top - CHART_GEOMETRY.bottom}
                rx="10"
                fill="rgba(12,24,56,0.36)"
                stroke="rgba(255,255,255,0.08)"
              />
              {chartData.isSemiLog && chartData.showLowerAxisBreak ? (
                <>
                  <polyline
                    points={[
                      `${CHART_GEOMETRY.left - 2},${chartData.lowerAxisBreakY - 8}`,
                      `${CHART_GEOMETRY.left + 4},${chartData.lowerAxisBreakY - 3}`,
                      `${CHART_GEOMETRY.left - 2},${chartData.lowerAxisBreakY + 2}`,
                      `${CHART_GEOMETRY.left + 4},${chartData.lowerAxisBreakY + 7}`,
                    ].join(' ')}
                    fill="none"
                    stroke="rgba(250,204,21,0.92)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <polyline
                    points={[
                      `${CHART_GEOMETRY.width - CHART_GEOMETRY.right + 2},${chartData.lowerAxisBreakY - 8}`,
                      `${CHART_GEOMETRY.width - CHART_GEOMETRY.right - 4},${chartData.lowerAxisBreakY - 3}`,
                      `${CHART_GEOMETRY.width - CHART_GEOMETRY.right + 2},${chartData.lowerAxisBreakY + 2}`,
                      `${CHART_GEOMETRY.width - CHART_GEOMETRY.right - 4},${chartData.lowerAxisBreakY + 7}`,
                    ].join(' ')}
                    fill="none"
                    stroke="rgba(250,204,21,0.92)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </>
              ) : null}
              <rect
                x={CHART_GEOMETRY.left}
                y={CHART_GEOMETRY.top}
                width={CHART_GEOMETRY.width - CHART_GEOMETRY.left - CHART_GEOMETRY.right}
                height={CHART_GEOMETRY.height - CHART_GEOMETRY.top - CHART_GEOMETRY.bottom}
                fill="transparent"
                style={{ cursor: 'crosshair' }}
              />
                {chartData.yTicks.map((tick, idx) => (
                  <g key={`y-${idx}`}>
                    <line
                      x1={CHART_GEOMETRY.left}
                      y1={tick.y}
                      x2={CHART_GEOMETRY.width - CHART_GEOMETRY.right}
                      y2={tick.y}
                      stroke={tick.isAnchor ? 'rgba(255,255,255,0.24)' : chartPresentation.gridStroke}
                      strokeWidth={tick.isAnchor ? '1.4' : '1'}
                      strokeDasharray={chartData.isSemiLog && !tick.isAnchor ? '5 6' : undefined}
                    />
                    <text x={CHART_GEOMETRY.left - 10} y={tick.y + 4} textAnchor="end" fontSize="11" fill="rgba(203,219,246,0.85)">
                      {chartPresentation.valueFormatter(tick.value)}
                    </text>
                    <text
                      x={CHART_GEOMETRY.width - CHART_GEOMETRY.right + 10}
                      y={tick.y + 4}
                      textAnchor="start"
                      fontSize="11"
                      fill="rgba(203,219,246,0.85)"
                    >
                      {chartPresentation.valueFormatter(tick.value)}
                    </text>
                  </g>
                ))}
              {chartData.xTicks.map((tick, idx) => (
                <g key={`x-${idx}`}>
                  <line
                    x1={tick.x}
                    y1={CHART_GEOMETRY.top}
                    x2={tick.x}
                    y2={CHART_GEOMETRY.height - CHART_GEOMETRY.bottom}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1"
                    strokeDasharray={chartData.isSemiLog ? '3 8' : undefined}
                  />
                  <text
                    x={tick.x}
                    y={CHART_GEOMETRY.height - CHART_GEOMETRY.bottom + 20}
                    textAnchor="middle"
                    fontSize="11"
                    fill="rgba(203,219,246,0.85)"
                  >
                    {tick.generation}
                  </text>
                </g>
              ))}
              <path d={chartData.path} fill="none" stroke={chartPresentation.lineStroke} strokeWidth="3" strokeLinecap="round" />
              {chartData.points.filter((_, idx) => idx % 12 === 0 || idx === chartData.points.length - 1).map((pt, idx) => (
                <g key={`pt-${idx}`}>
                  <circle cx={pt.x} cy={pt.y} r="4.4" fill={chartPresentation.haloFill} />
                  <circle cx={pt.x} cy={pt.y} r="2.2" fill={chartPresentation.pointFill} />
                </g>
              ))}
              {hoveredChartPoint ? (
                <g pointerEvents="none">
                  <line
                    x1={hoveredChartPoint.x}
                    y1={CHART_GEOMETRY.top}
                    x2={hoveredChartPoint.x}
                    y2={CHART_GEOMETRY.height - CHART_GEOMETRY.bottom}
                    stroke="rgba(255,255,255,0.28)"
                    strokeWidth="1.2"
                    strokeDasharray="4 6"
                  />
                  <circle
                    cx={hoveredChartPoint.x}
                    cy={hoveredChartPoint.y}
                    r="6"
                    fill="rgba(255,255,255,0.14)"
                    stroke={chartPresentation.pointFill}
                    strokeWidth="1.5"
                  />
                  <circle
                    cx={hoveredChartPoint.x}
                    cy={hoveredChartPoint.y}
                    r="3"
                    fill={chartPresentation.pointFill}
                  />
                  <rect
                    x={hoveredChartPoint.tooltipX}
                    y={hoveredChartPoint.tooltipY}
                    width={CHART_TOOLTIP_WIDTH}
                    height={CHART_TOOLTIP_HEIGHT}
                    rx="10"
                    fill="rgba(7,14,32,0.92)"
                    stroke="rgba(255,255,255,0.18)"
                  />
                  <text
                    x={hoveredChartPoint.tooltipX + 10}
                    y={hoveredChartPoint.tooltipY + 20}
                    fontSize="12"
                    fill="rgba(203,219,246,0.9)"
                  >
                    {`Generation ${hoveredChartPoint.generation}`}
                  </text>
                  <text
                    x={hoveredChartPoint.tooltipX + 10}
                    y={hoveredChartPoint.tooltipY + 39}
                    fontSize="12"
                    fill="rgba(236,243,255,0.98)"
                    fontWeight="700"
                  >
                    {`Objective ${formatObjective(hoveredChartPoint.value)}`}
                  </text>
                </g>
              ) : null}
              <text x={CHART_GEOMETRY.left} y={12} fontSize="12" fill="rgba(203,219,246,0.86)">{chartPresentation.label}</text>
              <text
                x={CHART_GEOMETRY.width - CHART_GEOMETRY.right}
                y={CHART_GEOMETRY.height - 8}
                textAnchor="end"
                fontSize="12"
                fill="rgba(203,219,246,0.86)"
              >
                Generations
              </text>
            </svg>
            {!hasRealSeries ? (
              <div style={{ marginTop: 6, fontSize: '0.82rem', opacity: 0.78 }}>
                Real generation/checkpoint history is unavailable for this run. Showing baseline only.
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ opacity: 0.8, fontSize: '0.98rem' }}>Click any run row to open its generation vs objective graph.</div>
        )}

        {!!selectedRunSummary.length && (
          <div
            style={{
              border: '1px solid rgba(255,255,255,0.16)',
              borderRadius: 14,
              padding: 12,
              background: 'rgba(5,12,28,0.36)',
            }}
          >
            <div style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: 10 }}>Run Summary</div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 8,
              }}
            >
              {selectedRunSummary.map((item) => (
                <div
                  key={`${item.key}`}
                  style={{
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 10,
                    padding: '9px 10px',
                    background: 'rgba(255,255,255,0.04)',
                  }}
                >
                  <div style={{ fontSize: '0.78rem', opacity: 0.78, marginBottom: 4 }}>{item.label}</div>
                  <div style={{
                    fontSize: '0.96rem',
                    fontWeight: 600,
                    color: item.key === 'status'
                      ? solutionStatusColor(selectedRun.status)
                      : 'rgba(236,243,255,0.96)',
                  }}>
                    {String(item.value)}
                  </div>
                  {item.helper ? (
                    <div style={{ fontSize: '0.76rem', opacity: 0.72, marginTop: 4 }}>
                      {item.helper}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default CompareRunsPanel;
