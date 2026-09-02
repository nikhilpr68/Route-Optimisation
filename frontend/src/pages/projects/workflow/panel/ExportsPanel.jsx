import React from 'react';

function ExportsPanel({
  projectName,
  parsedInput,
  parseReport,
  resultPayload,
  resultMetrics,
  costData,
  diagnosticsErrors = [],
  diagnosticsWarnings = [],
  distanceInfo = null,
}) {
  const downloadBlob = (filename, content, mimeType = 'application/octet-stream') => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadJson = (filename, obj) => {
    const payload = JSON.stringify(obj ?? {}, null, 2);
    downloadBlob(filename, payload, 'application/json;charset=utf-8');
  };


  const collectEmployeeVehicleAssignments = () => {
    const assignments = [];
    const seen = new Set();
    const rides = Array.isArray(resultPayload?.rides) ? resultPayload.rides : [];

    const pushAssignment = (employeeId, vehicleId, source = '') => {
      const e = String(employeeId || '').trim();
      const v = String(vehicleId || '').trim();
      if (!e || !v) return;
      const key = `${e}::${v}`;
      if (seen.has(key)) return;
      seen.add(key);
      assignments.push({ employeeId: e, vehicleId: v, source });
    };

    // Primary: assignments from solver rides
    rides.forEach((ride, idx) => {
      const vehicleId = String(ride?.vehicleId || `VEH_${idx + 1}`);
      if (Array.isArray(ride?.assignedEmployees)) {
        ride.assignedEmployees.forEach((emp) => {
          pushAssignment(emp, vehicleId, 'rides.assignedEmployees');
        });
      }
      if (Array.isArray(ride?.path)) {
        ride.path.forEach((stop) => {
          const t = String(stop?.type || '').toLowerCase();
          if (t === 'pickup' || t === 'dropoff' || t === 'drop') {
            pushAssignment(stop?.employeeId, vehicleId, 'rides.path');
          }
        });
      }
    });

    // Fallback: parsed input pre-assignment fields
    const parsedEmployees = Array.isArray(parsedInput?.employees) ? parsedInput.employees : [];
    parsedEmployees.forEach((e, idx) => {
      const employeeId = e?.id || e?.employee_id || `EMP_${idx + 1}`;
      const vehicleId = e?.assignedVehicle || e?.assigned_vehicle || e?.vehicleId;
      pushAssignment(employeeId, vehicleId, 'parsedInput');
    });

    return assignments.sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  };

  const buildRideCapacityDetails = () => {
    const rides = Array.isArray(resultPayload?.rides) ? resultPayload.rides : [];
    const vehicles = Array.isArray(parsedInput?.vehicles) ? parsedInput.vehicles : [];
    const vehicleCapacityById = vehicles.reduce((acc, v, idx) => {
      const id = String(v?.id || v?.vehicle_id || `VEH_${idx + 1}`);
      const cap = Number(v?.capacity);
      acc[id] = Number.isFinite(cap) ? cap : null;
      return acc;
    }, {});

    return rides.map((ride, idx) => {
      const vehicleId = String(ride?.vehicleId || `VEH_${idx + 1}`);
      const capacity = vehicleCapacityById[vehicleId] ?? null;
      const path = Array.isArray(ride?.path) ? ride.path : [];
      let onboard = 0;
      let maxConcurrentOnboard = 0;
      let tripCount = 0;
      const stopOnboardTimeline = [];

      path.forEach((stop, sIdx) => {
        const t = String(stop?.type || '').toLowerCase();
        const employeeId = String(stop?.employeeId || '').trim() || null;
        const onboardBefore = onboard;

        if (t === 'pickup') {
          if (onboardBefore === 0) tripCount += 1;
          onboard += 1;
        } else if (t === 'dropoff' || t === 'drop') {
          onboard = Math.max(0, onboard - 1);
        }

        if (onboard > maxConcurrentOnboard) maxConcurrentOnboard = onboard;
        stopOnboardTimeline.push({
          stopIndex: sIdx + 1,
          type: t || 'move',
          employeeId,
          onboardBefore,
          onboardAfter: onboard,
        });
      });

      const capacityViolated = (capacity != null && capacity > 0)
        ? maxConcurrentOnboard > capacity
        : false;

      return {
        vehicleId,
        capacity,
        pathStops: path.length,
        tripCount,
        maxConcurrentOnboard,
        capacityViolated,
        stopOnboardTimeline,
      };
    });
  };

  const buildSolutionExport = () => {
    const assignments = collectEmployeeVehicleAssignments();
    const rides = Array.isArray(resultPayload?.rides) ? resultPayload.rides : [];
    const rideCapacityDetails = buildRideCapacityDetails();
    const capacityByVehicle = rideCapacityDetails.reduce((acc, r) => {
      acc[r.vehicleId] = r;
      return acc;
    }, {});
    const rideGroups = rides.map((ride, idx) => {
      const vehicleId = String(ride?.vehicleId || `VEH_${idx + 1}`);
      const pickupOrder = Array.from(new Set(
        (Array.isArray(ride?.path) ? ride.path : [])
          .filter((s) => String(s?.type || '').toLowerCase() === 'pickup')
          .map((s) => String(s?.employeeId || '').trim())
          .filter(Boolean)
      ));
      const dropOrder = Array.from(new Set(
        (Array.isArray(ride?.path) ? ride.path : [])
          .filter((s) => {
            const t = String(s?.type || '').toLowerCase();
            return t === 'dropoff' || t === 'drop';
          })
          .map((s) => String(s?.employeeId || '').trim())
          .filter(Boolean)
      ));
      const together = Array.from(new Set([
        ...(Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees.map((x) => String(x)) : []),
        ...pickupOrder,
      ]));
      const cap = capacityByVehicle[vehicleId] || {};
      return {
        vehicleId,
        groupSize: together.length,
        employeesTogether: together,
        pickupOrder,
        dropOrder,
        capacity: cap.capacity ?? null,
        tripCount: cap.tripCount ?? 0,
        maxConcurrentOnboard: cap.maxConcurrentOnboard ?? 0,
        capacityViolated: Boolean(cap.capacityViolated),
        stopOnboardTimeline: cap.stopOnboardTimeline || [],
        feasible: ride?.feasible ?? null,
      };
    });
    return {
      reportType: 'solution_export',
      generatedAt: new Date().toISOString(),
      runName: projectName || 'Untitled',
      summary: {
        assignmentsCount: assignments.length,
        ridesCount: rides.length,
        ridesWithCapacityViolation: rideCapacityDetails.filter((r) => r.capacityViolated).length,
        distanceBackend: distanceInfo?.backend || distanceInfo?.metric || null,
        distanceBackendLabel: distanceInfo?.backendLabel || distanceInfo?.metricLabel || null,
      },
      employeeVehicleAssignments: assignments,
      rideGroups,
      rideCapacityDetails,
      result: resultPayload || {},
    };
  };

  const buildValidationReport = () => {
    const employees = Array.isArray(parsedInput?.employees) ? parsedInput.employees : [];
    const vehicles = Array.isArray(parsedInput?.vehicles) ? parsedInput.vehicles : [];
    const baseline = parsedInput?.baseline ?? null;
    const assignments = collectEmployeeVehicleAssignments();
    const rideCapacityDetails = buildRideCapacityDetails();
    const capacityViolations = rideCapacityDetails.filter((r) => r.capacityViolated);
    const assignmentCoverage = employees.length ? Math.round((assignments.length / employees.length) * 100) : 0;

    const checks = [
      {
        name: 'parsed_input_present',
        status: parsedInput ? 'pass' : 'fail',
        detail: parsedInput ? 'Parsed input is available.' : 'Parsed input is missing.'
      },
      {
        name: 'employees_present',
        status: employees.length > 0 ? 'pass' : 'fail',
        detail: employees.length > 0 ? `${employees.length} employee rows found.` : 'No employees found.'
      },
      {
        name: 'vehicles_present',
        status: vehicles.length > 0 ? 'pass' : 'fail',
        detail: vehicles.length > 0 ? `${vehicles.length} vehicle rows found.` : 'No vehicles found.'
      },
      {
        name: 'parse_status',
        status: parseReport?.status === 'failed' ? 'fail' : (parseReport?.status === 'needs_review' ? 'warning' : 'pass'),
        detail: `parseReport.status = ${parseReport?.status || 'unknown'}`
      },
      {
        name: 'diagnostics_errors',
        status: diagnosticsErrors.length ? 'fail' : 'pass',
        detail: diagnosticsErrors.length ? `${diagnosticsErrors.length} errors detected.` : 'No errors detected.'
      },
      {
        name: 'diagnostics_warnings',
        status: diagnosticsWarnings.length ? 'warning' : 'pass',
        detail: diagnosticsWarnings.length ? `${diagnosticsWarnings.length} warnings detected.` : 'No warnings detected.'
      },
      {
        name: 'employee_vehicle_assignment',
        status: assignments.length ? 'pass' : 'warning',
        detail: assignments.length
          ? `${assignments.length} employee->vehicle assignments found (${assignmentCoverage}% coverage).`
          : 'No employee->vehicle assignments found in result.'
      },
      {
        name: 'capacity_concurrent_check',
        status: capacityViolations.length ? 'fail' : 'pass',
        detail: capacityViolations.length
          ? `${capacityViolations.length} ride(s) exceed vehicle capacity by concurrent onboard count.`
          : 'All rides satisfy capacity by concurrent onboard count.'
      }
    ];

    const passCount = checks.filter((c) => c.status === 'pass').length;
    const warningCount = checks.filter((c) => c.status === 'warning').length;
    const failCount = checks.filter((c) => c.status === 'fail').length;
    const overallStatus = failCount > 0 ? 'Failed' : (warningCount > 0 ? 'NeedsReview' : 'Passed');

    return {
      reportType: 'validation_report',
      generatedAt: new Date().toISOString(),
      runName: projectName || 'Untitled',
      overallStatus,
      summary: {
        checksTotal: checks.length,
        checksPassed: passCount,
        checksWarning: warningCount,
        checksFailed: failCount,
        diagnosticsErrors: diagnosticsErrors.length,
        diagnosticsWarnings: diagnosticsWarnings.length,
        assignmentsFound: assignments.length,
        assignmentCoveragePercent: assignmentCoverage,
        ridesWithCapacityViolation: capacityViolations.length
      },
      inputSummary: {
        employeesCount: employees.length,
        vehiclesCount: vehicles.length,
        hasBaseline: Boolean(baseline),
        hasResults: Boolean(resultPayload),
        distanceBackend: distanceInfo?.backend || distanceInfo?.metric || null,
        distanceBackendLabel: distanceInfo?.backendLabel || distanceInfo?.metricLabel || null,
      },
      checks,
      parseReport: parseReport || null,
      diagnostics: {
        errors: diagnosticsErrors,
        warnings: diagnosticsWarnings
      },
      employeeVehicleAssignments: assignments,
      rideCapacityDetails
    };
  };

  const downloadChartsPng = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#0b1224';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e5edff';
    ctx.font = 'bold 30px Arial';
    ctx.fillText('Route Optimization Charts Snapshot', 40, 52);
    ctx.font = '18px Arial';
    ctx.fillStyle = '#b9c7e8';
    ctx.fillText(`Run: ${projectName || 'Untitled'} | ${new Date().toLocaleString()}`, 40, 86);

    // Histogram bars (Delay buckets)
    const histogram = Array.isArray(costData?.histogram) ? costData.histogram : [];
    const delayBucketLabels = ['0-5m', '6-10m', '11-20m', '21-30m', '31-45m', '45m+'];
    ctx.fillStyle = '#d23f73';
    const baseY = 420;
    const barW = 70;
    const barGap = 18;
    histogram.forEach((v, i) => {
      const h = Math.max(10, Number(v) * 2);
      const x = 40 + (i * (barW + barGap));
      ctx.fillRect(x, baseY - h, barW, h);
      ctx.fillStyle = '#e5edff';
      ctx.font = '12px Arial';
      ctx.fillText(delayBucketLabels[i] || `B${i + 1}`, x + 8, baseY + 20);
      ctx.fillStyle = '#d23f73';
    });
    ctx.fillStyle = '#8ea5d8';
    ctx.font = '16px Arial';
    ctx.fillText('Delay Distribution (by time bucket)', 40, 450);

    // Cost per vehicle bars
    const vehicleStacks = Array.isArray(costData?.vehicleStacks) ? costData.vehicleStacks.slice(0, 6) : [];
    const vx0 = 620;
    const vy0 = 210;
    const vBarH = 24;
    const vGap = 14;
    vehicleStacks.forEach((row, i) => {
      const y = vy0 + i * (vBarH + vGap);
      const total = Number(row?.totalValue) || 0;
      const opW = Math.max(0, Math.round((Number(row?.op) || 0) * 2.2));
      const delayW = Math.max(0, Math.round((Number(row?.delay) || 0) * 2.2));
      const usageW = Math.max(0, Math.round((Number(row?.usage) || 0) * 2.2));

      ctx.fillStyle = '#e5edff';
      ctx.font = '13px Arial';
      ctx.fillText(String(row?.id || `Vehicle ${i + 1}`), vx0, y - 5);

      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(vx0, y, opW, vBarH);
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(vx0 + opW, y, delayW, vBarH);
      ctx.fillStyle = '#10b981';
      ctx.fillRect(vx0 + opW + delayW, y, usageW, vBarH);

      ctx.fillStyle = '#9fb2dd';
      ctx.font = '12px Arial';
      ctx.fillText(`Total: ${Math.round(total)}`, vx0 + 235, y + 16);
    });

    ctx.fillStyle = '#8ea5d8';
    ctx.font = '16px Arial';
    ctx.fillText('Cost per Vehicle (Op/Delay/Usage)', vx0, 175);
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(vx0, 735, 12, 12);
    ctx.fillStyle = '#e5edff';
    ctx.font = '12px Arial';
    ctx.fillText('Operational', vx0 + 18, 745);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(vx0 + 110, 735, 12, 12);
    ctx.fillStyle = '#e5edff';
    ctx.fillText('Delay', vx0 + 128, 745);
    ctx.fillStyle = '#10b981';
    ctx.fillRect(vx0 + 190, 735, 12, 12);
    ctx.fillStyle = '#e5edff';
    ctx.fillText('Usage', vx0 + 208, 745);

    // Pareto bars
    const pareto = Array.isArray(costData?.pareto) ? costData.pareto : [];
    ctx.fillStyle = '#60a5fa';
    pareto.forEach((row, i) => {
      const pct = Math.max(0, Math.min(100, Number(row?.pct) || 0));
      const y = 520 + (i * 56);
      ctx.fillRect(240, y - 24, Math.round(pct * 7), 24);
      ctx.fillStyle = '#e5edff';
      ctx.font = '15px Arial';
      ctx.fillText(`${row?.id || 'N/A'} (${pct}%)`, 40, y - 6);
      ctx.fillStyle = '#60a5fa';
    });
    ctx.fillStyle = '#8ea5d8';
    ctx.fillText('Top Delay Contributors', 40, 492);

    // Employee -> vehicle assignment list (top 8)
    const assignments = collectEmployeeVehicleAssignments().slice(0, 8);
    ctx.fillStyle = '#8ea5d8';
    ctx.font = '16px Arial';
    ctx.fillText('Employee -> Vehicle Assignments', 620, 520);
    ctx.font = '13px Arial';
    assignments.forEach((a, i) => {
      ctx.fillStyle = '#e5edff';
      ctx.fillText(`${a.employeeId} -> ${a.vehicleId}`, 620, 548 + (i * 24));
    });
    if (!assignments.length) {
      ctx.fillStyle = '#e5edff';
      ctx.fillText('No assignment rows available', 620, 548);
    }

    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'charts-summary.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openPrintableReport = () => {
    const w = window.open('', '_blank', 'width=980,height=800');
    if (!w) return;

    const esc = (v) => String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const employees = Array.isArray(parsedInput?.employees) ? parsedInput.employees : [];
    const vehicles = Array.isArray(parsedInput?.vehicles) ? parsedInput.vehicles : [];
    const rides = Array.isArray(resultPayload?.rides) ? resultPayload.rides : [];
    const assignments = collectEmployeeVehicleAssignments();
    const rideCapacityDetails = buildRideCapacityDetails();
    const capByVehicle = rideCapacityDetails.reduce((acc, r) => {
      acc[r.vehicleId] = r;
      return acc;
    }, {});
    const baselineObj = parsedInput?.baseline || {};
    const baselineRows = Array.isArray(baselineObj)
      ? baselineObj
      : (baselineObj && typeof baselineObj === 'object'
        ? Object.entries(baselineObj).map(([employeeId, row]) => ({ employeeId, ...(row || {}) }))
        : []);

    const metricsRows = Object.entries(resultMetrics || {})
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`)
      .join('');

    const employeeRows = employees.map((e, idx) => {
      const id = e?.id || e?.employee_id || `EMP_${idx + 1}`;
      const pick = e?.pickup || {};
      const drop = e?.dropoff || {};
      const tw = e?.time_window || e?.timeWindow || {};
      const start = tw?.start ?? e?.earliest_pickup ?? e?.earliestPickup ?? '';
      const end = tw?.end ?? e?.latest_drop ?? e?.latestDrop ?? '';
      return `<tr>
        <td>${esc(id)}</td>
        <td>${esc(e?.priority ?? '')}</td>
        <td>${esc(`${pick?.lat ?? e?.pickup_lat ?? e?.pickupLat ?? ''}, ${pick?.lng ?? e?.pickup_lng ?? e?.pickupLng ?? ''}`)}</td>
        <td>${esc(`${drop?.lat ?? e?.drop_lat ?? e?.dropLat ?? ''}, ${drop?.lng ?? e?.drop_lng ?? e?.dropLng ?? ''}`)}</td>
        <td>${esc(`${start} - ${end}`)}</td>
      </tr>`;
    }).join('');

    const vehicleRows = vehicles.map((v, idx) => {
      const id = v?.id || v?.vehicle_id || `VEH_${idx + 1}`;
      const start = v?.start_location || {};
      return `<tr>
        <td>${esc(id)}</td>
        <td>${esc(v?.capacity ?? '')}</td>
        <td>${esc(v?.cost_per_km ?? '')}</td>
        <td>${esc(v?.available_time ?? v?.available_from ?? '')}</td>
        <td>${esc(`${start?.lat ?? v?.start_lat ?? v?.startLat ?? v?.current_lat ?? ''}, ${start?.lng ?? v?.start_lng ?? v?.startLng ?? v?.current_lng ?? ''}`)}</td>
      </tr>`;
    }).join('');

    const baselineTableRows = baselineRows.map((b, idx) => {
      const employeeId = b?.employeeId || b?.employee_id || b?.emp_id || b?.id || `EMP_${idx + 1}`;
      const cost = b?.baselineCost ?? b?.baseline_cost ?? b?.cost ?? '';
      const time = b?.baselineTimeMin ?? b?.baseline_time_min ?? b?.time ?? '';
      return `<tr><td>${esc(employeeId)}</td><td>${esc(cost)}</td><td>${esc(time)}</td></tr>`;
    }).join('');

    const rideRows = rides.map((r, idx) => {
      const vehicleId = r?.vehicleId || `VEH_${idx + 1}`;
      const assigned = Array.isArray(r?.assignedEmployees) ? r.assignedEmployees.length : '';
      const cost = r?.metrics?.cost ?? r?.cost ?? '';
      const time = r?.metrics?.timeMinutes ?? r?.timeMinutes ?? '';
      const feasible = r?.feasible;
      const cap = capByVehicle[String(vehicleId)] || {};
      return `<tr>
        <td>${esc(vehicleId)}</td>
        <td>${esc(assigned)}</td>
        <td>${esc(cost)}</td>
        <td>${esc(time)}</td>
        <td>${esc(typeof feasible === 'boolean' ? (feasible ? 'Yes' : 'No') : '')}</td>
        <td>${esc(cap.capacity ?? '-')}</td>
        <td>${esc(cap.maxConcurrentOnboard ?? '-')}</td>
        <td>${esc(cap.tripCount ?? '-')}</td>
        <td>${esc(cap.capacityViolated ? 'Yes' : 'No')}</td>
      </tr>`;
    }).join('');

    const parseReportRows = Object.entries(parseReport || {})
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(Array.isArray(v) ? v.join(', ') : (typeof v === 'object' ? JSON.stringify(v) : v))}</td></tr>`)
      .join('');

    const assignmentRows = assignments.map((a) => (
      `<tr><td>${esc(a.employeeId)}</td><td>${esc(a.vehicleId)}</td><td>${esc(a.source || '')}</td></tr>`
    )).join('');

    const rideGroupRows = rides.map((ride, idx) => {
      const vehicleId = String(ride?.vehicleId || `VEH_${idx + 1}`);
      const pickupOrder = Array.from(new Set(
        (Array.isArray(ride?.path) ? ride.path : [])
          .filter((s) => String(s?.type || '').toLowerCase() === 'pickup')
          .map((s) => String(s?.employeeId || '').trim())
          .filter(Boolean)
      ));
      const dropOrder = Array.from(new Set(
        (Array.isArray(ride?.path) ? ride.path : [])
          .filter((s) => {
            const t = String(s?.type || '').toLowerCase();
            return t === 'dropoff' || t === 'drop';
          })
          .map((s) => String(s?.employeeId || '').trim())
          .filter(Boolean)
      ));
      const together = Array.from(new Set([
        ...(Array.isArray(ride?.assignedEmployees) ? ride.assignedEmployees.map((x) => String(x)) : []),
        ...pickupOrder,
      ]));
      const cap = capByVehicle[vehicleId] || {};
      return `<tr>
        <td>${esc(vehicleId)}</td>
        <td>${esc(together.length)}</td>
        <td>${esc(together.join(', ') || '-')}</td>
        <td>${esc(pickupOrder.join(' -> ') || '-')}</td>
        <td>${esc(dropOrder.join(' -> ') || '-')}</td>
        <td>${esc(cap.tripCount ?? '-')}</td>
        <td>${esc(cap.maxConcurrentOnboard ?? '-')}</td>
        <td>${esc(cap.capacity ?? '-')}</td>
      </tr>`;
    }).join('');

    const capacityTimelineRows = rideCapacityDetails.map((r) => {
      const steps = (Array.isArray(r.stopOnboardTimeline) ? r.stopOnboardTimeline : [])
        .map((s) => `${s.stopIndex}.${s.type}${s.employeeId ? `(${s.employeeId})` : ''}:${s.onboardBefore}->${s.onboardAfter}`)
        .join(' | ');
      return `<tr>
        <td>${esc(r.vehicleId)}</td>
        <td>${esc(r.capacity ?? '-')}</td>
        <td>${esc(r.maxConcurrentOnboard)}</td>
        <td>${esc(r.tripCount)}</td>
        <td>${esc(r.capacityViolated ? 'Yes' : 'No')}</td>
        <td>${esc(steps || '-')}</td>
      </tr>`;
    }).join('');

    const warningsList = (diagnosticsWarnings.length ? diagnosticsWarnings : ['No warnings'])
      .map((x) => `<li>${esc(x)}</li>`).join('');
    const errorsList = (diagnosticsErrors.length ? diagnosticsErrors : ['No errors'])
      .map((x) => `<li>${esc(x)}</li>`).join('');

    const html = `
      <html>
      <head>
        <title>Route Optimization Report</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
          h1 { margin: 0 0 8px 0; font-size: 22px; }
          h2 { margin-top: 20px; font-size: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
          pre { background: #f5f7fb; padding: 12px; border-radius: 8px; overflow: auto; font-size: 12px; }
          ul { margin: 6px 0 0 20px; }
          table { width: 100%; border-collapse: collapse; margin-top: 8px; }
          th, td { border: 1px solid #e2e8f0; text-align: left; padding: 6px 8px; font-size: 12px; vertical-align: top; }
          th { background: #f8fafc; }
          .meta { margin: 4px 0; font-size: 13px; }
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; background: #fcfdff; }
        </style>
      </head>
      <body>
        <h1>Route Optimization Full Report</h1>
        <div class="meta"><strong>Run:</strong> ${esc(projectName || 'Untitled')}</div>
        <div class="meta"><strong>Generated:</strong> ${esc(new Date().toLocaleString())}</div>
        <div class="meta"><strong>Parse Status:</strong> ${esc(parseReport?.status || 'unknown')}</div>
        <div class="meta"><strong>Distance Backend:</strong> ${esc(distanceInfo?.backendLabel || distanceInfo?.metricLabel || 'unknown')}</div>
        <div class="meta"><strong>Employees:</strong> ${esc(employees.length)} | <strong>Vehicles:</strong> ${esc(vehicles.length)} | <strong>Rides:</strong> ${esc(rides.length)}</div>

        <h2>Summary</h2>
        <div class="grid">
          <div class="card">
            <strong>Diagnostics Errors</strong>
            <ul>${errorsList}</ul>
          </div>
          <div class="card">
            <strong>Diagnostics Warnings</strong>
            <ul>${warningsList}</ul>
          </div>
        </div>

        <h2>Parse Report</h2>
        <table>
          <thead><tr><th>Field</th><th>Value</th></tr></thead>
          <tbody>${parseReportRows || '<tr><td colspan="2">No parse report</td></tr>'}</tbody>
        </table>

        <h2>Result Metrics</h2>
        <table>
          <thead><tr><th>Metric</th><th>Value</th></tr></thead>
          <tbody>${metricsRows || '<tr><td colspan="2">No metrics found</td></tr>'}</tbody>
        </table>

        <h2>Employees</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Priority</th>
              <th>Pickup</th>
              <th>Drop</th>
              <th>Time Window</th>
            </tr>
          </thead>
          <tbody>${employeeRows || '<tr><td colspan="5">No employee data</td></tr>'}</tbody>
        </table>

        <h2>Vehicles</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Capacity</th>
              <th>Cost / Km</th>
              <th>Available From</th>
              <th>Start Location</th>
            </tr>
          </thead>
          <tbody>${vehicleRows || '<tr><td colspan="5">No vehicle data</td></tr>'}</tbody>
        </table>

        <h2>Baseline</h2>
        <table>
          <thead>
            <tr>
              <th>Employee ID</th>
              <th>Baseline Cost</th>
              <th>Baseline Time</th>
            </tr>
          </thead>
          <tbody>${baselineTableRows || '<tr><td colspan="3">No baseline data</td></tr>'}</tbody>
        </table>

        <h2>Solution / Rides</h2>
        <table>
          <thead>
            <tr>
              <th>Vehicle</th>
              <th>Assigned Employees</th>
              <th>Cost</th>
              <th>Time</th>
              <th>Feasible</th>
              <th>Capacity</th>
              <th>Max Onboard</th>
              <th>Trips</th>
              <th>Capacity Violated</th>
            </tr>
          </thead>
          <tbody>${rideRows || '<tr><td colspan="9">No ride results</td></tr>'}</tbody>
        </table>

        <h2>Who Traveled Together (By Vehicle)</h2>
        <table>
          <thead>
            <tr>
              <th>Vehicle</th>
              <th>Group Size</th>
              <th>Employees Together</th>
              <th>Pickup Sequence</th>
              <th>Drop Sequence</th>
              <th>Trips</th>
              <th>Max Onboard</th>
              <th>Capacity</th>
            </tr>
          </thead>
          <tbody>${rideGroupRows || '<tr><td colspan="8">No grouping data</td></tr>'}</tbody>
        </table>

        <h2>Capacity Timeline (Concurrent Onboard)</h2>
        <table>
          <thead>
            <tr>
              <th>Vehicle</th>
              <th>Capacity</th>
              <th>Max Onboard</th>
              <th>Trips</th>
              <th>Capacity Violated</th>
              <th>Stop Timeline (before->after)</th>
            </tr>
          </thead>
          <tbody>${capacityTimelineRows || '<tr><td colspan="6">No timeline data</td></tr>'}</tbody>
        </table>

        <h2>Employee to Vehicle Assignment</h2>
        <table>
          <thead>
            <tr>
              <th>Employee ID</th>
              <th>Vehicle ID</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>${assignmentRows || '<tr><td colspan="3">No assignment rows</td></tr>'}</tbody>
        </table>

        <h2>Raw Solution JSON</h2>
        <pre>${esc(JSON.stringify(resultPayload || {}, null, 2))}</pre>
      </body>
      </html>
    `;
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  const left = [
    {
      name: 'Input JSON',
      onClick: () => downloadJson('input.json', parsedInput || {})
    },
    {
      name: 'Validation Report',
      onClick: () => downloadJson('validation_report.json', buildValidationReport())
    },
    { name: 'All charts as PNG', onClick: downloadChartsPng },
  ];
  const right = [
    {
      name: 'Output JSON',
      onClick: () => downloadJson('output.json', buildSolutionExport())
    },
    { name: 'Print Report', actionLabel: 'Print', onClick: openPrintableReport },
  ];

  const tileStyle = {
    height: 52,
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(13,24,54,0.55)',
    color: 'rgba(235,242,255,0.96)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 14px',
    fontSize: '0.9rem',
    fontWeight: 600,
  };

  return (
    <div className="glass-morphism reflective-card-container" style={{ padding: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ display: 'grid', gap: 16 }}>
          {left.map((item) => (
            <button
              key={item.name}
              type="button"
              style={tileStyle}
              onClick={item.onClick}
            >
              <span>{item.name}</span>
              <span style={{ opacity: 0.72, fontSize: '0.78rem', fontWeight: 600 }}>
                Download
              </span>
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          {right.map((item) => (
            <button
              key={item.name}
              type="button"
              style={tileStyle}
              onClick={item.onClick}
            >
              <span>{item.name}</span>
              <span style={{ opacity: 0.72, fontSize: '0.78rem', fontWeight: 600 }}>
                {item.actionLabel || 'Download'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ExportsPanel;
