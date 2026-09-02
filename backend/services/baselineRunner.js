const { spawn } = require('child_process');
const path = require('path');

function extractJsonFromOutput(output) {
  const text = String(output || '').trim();
  if (!text) {
    throw new Error('Empty stdout from baseline solver');
  }

  try {
    return JSON.parse(text);
  } catch (_) {}

  let lastObject = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        lastObject = parsed;
      }
    } catch (_) {}
  }

  if (lastObject && typeof lastObject === 'object') {
    return lastObject;
  }

  throw new Error('No JSON found in baseline solver stdout');
}

function computeBaselineFromCanonical(canonicalJson, opts = {}) {
  const {
    timeoutMs = 60 * 1000,
    pythonCmd = process.env.PYTHON_CMD || 'python3',
  } = opts;

  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'engine', 'baseline_solver.py');
    const py = spawn(pythonCmd, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let out = '';
    let err = '';
    let finished = false;

    const killTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { py.kill('SIGKILL'); } catch {}
      reject(new Error(`Baseline solver timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    py.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      reject(new Error(`Failed to start baseline solver: ${e.message}`));
    });

    py.stdout.on('data', (d) => { out += d.toString(); });
    py.stderr.on('data', (d) => { err += d.toString(); });

    py.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);

      if (code !== 0) {
        return reject(new Error(`Baseline solver exited ${code}: ${err || out}`));
      }

      try {
        const parsed = extractJsonFromOutput(out);
        resolve(parsed);
      } catch (e) {
        reject(new Error(`Baseline solver returned invalid JSON. stdout=${out.slice(0, 700)} stderr=${err.slice(0, 700)} parseError=${e.message}`));
      }
    });

    py.stdin.write(JSON.stringify(canonicalJson || {}));
    py.stdin.end();
  });
}

module.exports = { computeBaselineFromCanonical };
