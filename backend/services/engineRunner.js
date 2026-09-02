const { spawn } = require('child_process');
const path = require('path');

function extractJsonFromOutput(output) {
  const s = (output || '').trim();
  if (!s) throw new Error('Empty stdout from python');

  // Try direct parse
  try { return JSON.parse(s); } catch (_) { }

  // Common case: logs + one JSON line at the end.
  let lastParsed = null;
  for (const rawLine of s.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') lastParsed = parsed;
    } catch (_) {
      // Not a JSON line.
    }
  }
  if (lastParsed && typeof lastParsed === 'object') {
    return lastParsed;
  }

  // Robust fallback: scan for balanced JSON blocks and keep the last valid one.
  const starts = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '{' || ch === '[') starts.push(i);
  }

  const tryParseBalanced = (startIdx) => {
    const open = s[startIdx];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIdx; i < s.length; i += 1) {
      const ch = s[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === open) depth += 1;
      if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const candidate = s.slice(startIdx, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (_) {
            return null;
          }
        }
      }
    }

    return null;
  };

  for (const idx of starts) {
    const parsed = tryParseBalanced(idx);
    if (parsed && typeof parsed === 'object') {
      lastParsed = parsed;
    }
  }

  if (lastParsed && typeof lastParsed === 'object') {
    return lastParsed;
  }

  throw new Error('No JSON found in stdout');
}

function runPythonEngine(canonicalJson, opts = {}) {
  const { timeoutMs = 10 * 60 * 1000, pythonCmd = process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3'), args = [] } = opts;

  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '..', 'engine', 'main.py');
    const py = spawn(pythonCmd, [scriptPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    let out = '';
    let err = '';
    let finished = false;

    const killTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { py.kill('SIGKILL'); } catch { }
      reject(new Error(`Python engine timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    py.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      reject(new Error(`Failed to start python process: ${e.message}`));
    });

    py.stdout.on('data', (d) => { out += d.toString(); });
    py.stderr.on('data', (d) => { err += d.toString(); });

    py.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);

      if (code !== 0) {
        return reject(new Error(`Python exited ${code}: ${err || out}`));
      }

      try {
        resolve(extractJsonFromOutput(out));
      } catch (e) {
        reject(new Error(`Python did not return valid JSON. stdout=${out.slice(0, 800)} stderr=${err.slice(0, 800)} parseError=${e.message}`));
      }
    });

    py.stdin.write(JSON.stringify(canonicalJson));
    py.stdin.end();
  });
}

module.exports = { runPythonEngine };
