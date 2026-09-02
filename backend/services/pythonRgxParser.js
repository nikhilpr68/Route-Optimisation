const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const xlsx = require('xlsx');

function extractJsonFromOutput(output) {
  const s = String(output || '').trim();
  if (!s) throw new Error('Empty stdout from python RGX parser');
  try {
    return JSON.parse(s);
  } catch (_) {}

  const lastObj = s.lastIndexOf('{');
  const lastArr = s.lastIndexOf('[');
  const start = Math.max(lastObj, lastArr);
  if (start === -1) throw new Error('No JSON found in parser stdout');
  return JSON.parse(s.slice(start));
}

function isExcel(mime = '', name = '') {
  return (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    /\.(xlsx|xls)$/i.test(name)
  );
}

function isCsv(mime = '', name = '') {
  return mime === 'text/csv' || /\.csv$/i.test(name);
}

function isTabularArtifact(artifact) {
  if (!artifact || artifact.kind !== 'file') return false;
  const mime = artifact.mimeType || '';
  const name = artifact.originalName || '';
  return isExcel(mime, name) || isCsv(mime, name);
}

function artifactToTables(artifact) {
  const filePath = artifact.storagePath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  const artifactLabel = artifact.originalName || path.basename(filePath);
  const preferredCsvSheetName = isCsv(artifact.mimeType || '', artifactLabel)
    ? path.basename(artifactLabel, path.extname(artifactLabel))
    : '';
  const wb = xlsx.readFile(filePath, { cellDates: false });
  const out = [];
  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(ws, {
      defval: null,
      raw: false,
      blankrows: false
    });
    if (!Array.isArray(rows) || !rows.length) continue;
    out.push({
      artifactName: artifactLabel,
      sheetName: preferredCsvSheetName || sheetName,
      rows
    });
  }
  return out;
}

function runPythonRgx(payload, opts = {}) {
  const {
    timeoutMs = 2 * 60 * 1000,
    pythonCmd = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3')
  } = opts;

  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'engine', 'rgx_parser.py');
    const py = spawn(pythonCmd, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let out = '';
    let err = '';
    let finished = false;

    const killTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { py.kill('SIGKILL'); } catch {}
      reject(new Error(`Python RGX parser timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    py.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      reject(new Error(`Failed to start python RGX parser: ${e.message}`));
    });

    py.stdout.on('data', (d) => { out += d.toString(); });
    py.stderr.on('data', (d) => { err += d.toString(); });

    py.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);

      if (code !== 0) {
        return reject(new Error(`Python RGX parser exited ${code}: ${err || out}`));
      }

      try {
        resolve(extractJsonFromOutput(out));
      } catch (e) {
        reject(new Error(`Python RGX parser returned invalid JSON. stdout=${out.slice(0, 700)} stderr=${err.slice(0, 700)} parseError=${e.message}`));
      }
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}

async function parseWithPythonRgx({ artifacts }) {
  const allArtifacts = Array.isArray(artifacts) ? artifacts : [];
  const tabularArtifacts = allArtifacts.filter(isTabularArtifact);
  const tables = tabularArtifacts.flatMap(artifactToTables);
  const textArtifacts = allArtifacts
    .filter((a) => a?.kind === 'text' && typeof a.text === 'string')
    .map((a) => a.text);

  if (!tables.length) {
    return {
      status: 'failed',
      confidence: 0,
      missing_required: ['artifacts(csv/xlsx)'],
      assumptions: [],
      warnings: ['No CSV/XLSX artifacts found for parser'],
      sanity_checks: {
        invalid_coordinates: 0,
        duplicate_ids: 0,
        invalid_time_windows: 0,
        missing_capacity: 0,
        notes: ['No tabular artifacts']
      },
      canonical: null,
      modelUsed: 'python-rgx'
    };
  }

  const parsed = await runPythonRgx({
    tables,
    text_artifacts: textArtifacts
  });

  if (parsed && typeof parsed === 'object' && !parsed.modelUsed) {
    parsed.modelUsed = 'python-rgx';
  }
  return parsed;
}

module.exports = { parseWithPythonRgx };
