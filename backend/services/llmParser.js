const fs = require('fs');
const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const { getGeminiClient } = require('./geminiClient');

const CANONICAL_TEMPLATE = {
  schema_version: "1.0",
  problem_type: "employee_transport_many_to_one",
  metadata: { project_name: null, date: null, avg_speed_kmph: null, distance_metric: "osrm" },
  depot: { lat: null, lng: null, name: "Office" },
  employees: [],
  vehicles: [],
  baseline: {}
};

function fileToInlineDataPart(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  return { inlineData: { mimeType, data: buf.toString('base64') } };
}

function isExcel(m, n = '') {
  return m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || m === 'application/vnd.ms-excel'
    || /\.(xlsx|xls)$/i.test(n);
}
function isPdf(m, n = '') { return m === 'application/pdf' || /\.pdf$/i.test(n); }
function isImage(m, n = '') { return (m || '').startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(n); }
function isText(m, n = '') {
  return (m || '').startsWith('text/') || m === 'application/json' || /\.(csv|txt|json)$/i.test(n);
}

async function excelToText(filePath) {
  const wb = xlsx.readFile(filePath);
  const blocks = [];
  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    const csv = xlsx.utils.sheet_to_csv(ws);
    blocks.push(`--- Excel Sheet: ${sheetName} ---\n${csv}`);
  }
  return blocks.join('\n\n');
}

async function pdfToText(filePath) {
  const buf = fs.readFileSync(filePath);
  const parsed = await pdfParse(buf);
  return (parsed.text || '').trim();
}

async function normalizeArtifacts(artifacts) {
  const textChunks = [];
  const binaryParts = [];

  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i];

    if (a.kind === 'text') {
      textChunks.push(`--- Artifact ${i + 1} (user text) ---\n${a.text}`);
      continue;
    }

    const filePath = a.storagePath;
    const mime = a.mimeType || '';
    const name = a.originalName || '';

    if (!filePath || !fs.existsSync(filePath)) {
      textChunks.push(`--- Artifact ${i + 1} (missing file) --- name=${name} mime=${mime}`);
      continue;
    }

    if (isExcel(mime, name)) {
      const t = await excelToText(filePath);
      textChunks.push(`--- Artifact ${i + 1} (excel extracted) ---\n${t}`);
      continue;
    }

    if (isPdf(mime, name)) {
      const t = await pdfToText(filePath);
      if (t && t.length > 200) {
        textChunks.push(`--- Artifact ${i + 1} (pdf extracted text) ---\n${t}`);
      } else {
        binaryParts.push(fileToInlineDataPart(filePath, 'application/pdf'));
      }
      continue;
    }

    if (isText(mime, name)) {
      const t = fs.readFileSync(filePath, 'utf-8');
      textChunks.push(`--- Artifact ${i + 1} (file text) ---\n${t}`);
      continue;
    }

    if (isImage(mime, name)) {
      binaryParts.push(fileToInlineDataPart(filePath, mime || 'image/png'));
      continue;
    }

    textChunks.push(`--- Artifact ${i + 1} (unknown file type) --- name=${name} mime=${mime}`);
  }

  return { textDump: textChunks.join('\n\n'), binaryParts };
}

function buildPrompt({ artifactsText }) {
  return `
You are a strict information extraction engine. Convert user-provided employee transport data into canonical JSON.

MANDATORY RULES:
- Output MUST be valid JSON only. No markdown. No commentary.
- Do NOT invent lat/lng, costs, capacities, IDs, or times. If unknown, set null.
- If any required field is missing for running optimization, include the JSON path in missing_required[].
- Generate stable ids EMP001.. / VEH001.. if missing.
- Time format: "HH:MM" if present.

Return this wrapper object:
{
  "status": "success|needs_review|failed",
  "confidence": number between 0 and 1,
  "missing_required": string[],
  "assumptions": string[],
  "warnings": string[],
  "sanity_checks": {
    "invalid_coordinates": number,
    "duplicate_ids": number,
    "invalid_time_windows": number,
    "missing_capacity": number,
    "notes": string[]
  },
  "canonical": <canonical JSON object>
}

Canonical JSON template:
${JSON.stringify(CANONICAL_TEMPLATE, null, 2)}

Canonical rules:
- employees[].pickup and employees[].dropoff should be objects with keys {lat,lng,address?}
- vehicles[].start_location should be object {lat,lng,address?}
- vehicles[].capacity is number or null
- depot.lat/lng must be filled if office/depot exists in input

Artifacts content:
${artifactsText}
`.trim();
}

async function parseWithGemini({ model, artifacts }) {
  const client = getGeminiClient();
  const { textDump, binaryParts } = await normalizeArtifacts(artifacts);

  const prompt = buildPrompt({ artifactsText: textDump });
  const parts = [{ text: prompt }, ...binaryParts];

  function isTransientNetworkError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return (
      msg.includes('fetch failed') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('socket hang up') ||
      msg.includes('network')
    );
  }

  function isQuotaError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return (
      msg.includes('resource_exhausted') ||
      msg.includes('quota exceeded') ||
      msg.includes('429') ||
      msg.includes('rate limit')
    );
  }

  function isModelNotFoundError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return (
      msg.includes('not found') ||
      msg.includes('unsupported model') ||
      msg.includes('model is not found') ||
      msg.includes('unknown model')
    );
  }

  function getRetryDelayMs(err) {
    const msg = String(err?.message || '');
    const m = msg.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
    if (!m) return null;
    const secs = Number(m[1]);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return Math.ceil(secs * 1000);
  }

  function getModelCandidates(primaryModel) {
    const fallbackFromEnv = String(process.env.GEMINI_FALLBACK_MODELS || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    const defaults = [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite'
    ];

    return [primaryModel, ...fallbackFromEnv, ...defaults].filter(
      (m, idx, arr) => m && arr.indexOf(m) === idx
    );
  }

  async function callGeminiWithRetry(maxAttempts = 2) {
    const candidates = getModelCandidates(model);
    let lastErr = null;
    const quotaModels = [];

    for (const candidateModel of candidates) {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await client.models.generateContent({
            model: candidateModel,
            contents: [{ role: 'user', parts }],
            config: { temperature: 0.1, maxOutputTokens: 8192 }
          });
          return { response, modelUsed: candidateModel };
        } catch (err) {
          lastErr = err;

          if (isQuotaError(err)) {
            quotaModels.push(candidateModel);
            const delayMs = getRetryDelayMs(err);
            if (delayMs && delayMs <= 30000) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              continue;
            }
            break;
          }

          if (isModelNotFoundError(err)) {
            break;
          }

          if (attempt < maxAttempts && isTransientNetworkError(err)) {
            const backoffMs = 600 * attempt;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }

          throw err;
        }
      }
    }

    if (quotaModels.length) {
      throw new Error(
        `Quota exceeded on Gemini model(s): ${quotaModels.join(', ')}. ` +
        `API key rotation does not bypass quota when keys belong to the same Google project. ` +
        `Set GEMINI_MODEL or GEMINI_FALLBACK_MODELS to a model with available quota, or use a different billed project.`
      );
    }

    throw lastErr;
  }

  let resp;
  let modelUsed = model;
  try {
    const out = await callGeminiWithRetry(2);
    resp = out.response;
    modelUsed = out.modelUsed || model;
  } catch (e) {
    throw new Error(`LLM request failed: ${e.message}`);
  }

  const text = (resp.text || '').trim();
  try {
    const obj = JSON.parse(text);
    obj.modelUsed = modelUsed;
    return obj;
  } catch {
    return {
      status: 'failed',
      confidence: 0,
      missing_required: [],
      assumptions: [],
      warnings: ['Model did not return valid JSON'],
      sanity_checks: {
        invalid_coordinates: 0,
        duplicate_ids: 0,
        invalid_time_windows: 0,
        missing_capacity: 0,
        notes: ['Model did not return valid JSON']
      },
      canonical: null,
      raw: text,
      modelUsed
    };
  }
}

module.exports = { parseWithGemini };
