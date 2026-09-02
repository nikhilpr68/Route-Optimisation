const fs = require('fs');
const path = require('path');
const asyncHandler = require('express-async-handler');

const { parseWithPythonRgx } = require('../services/pythonRgxParser');
const {
  normalizeDistanceMetric,
  normalizePreferenceRelaxation,
  normalizeIntensity,
  runStandaloneValidation,
} = require('../services/standaloneValidator');

function pickUploadedFile(reqFiles, fieldName) {
  if (!reqFiles || !reqFiles[fieldName] || !reqFiles[fieldName][0]) return null;
  return reqFiles[fieldName][0];
}

function extractJsonFromText(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Empty JSON payload');

  try {
    return JSON.parse(text);
  } catch (_) {}

  let lastObject = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lastObject = JSON.parse(trimmed);
    } catch (_) {}
  }

  if (lastObject && typeof lastObject === 'object') return lastObject;
  throw new Error('File does not contain valid JSON');
}

function readJsonFile(file) {
  const raw = fs.readFileSync(file.path, 'utf8');
  return extractJsonFromText(raw);
}

function looksLikeJsonFile(file) {
  const ext = path.extname(file?.originalname || '').toLowerCase();
  return ext === '.json' || ext === '.txt' || file?.mimetype === 'application/json';
}

async function parseTestcaseFile(testcaseFile) {
  if (looksLikeJsonFile(testcaseFile)) {
    return {
      canonical: readJsonFile(testcaseFile),
      sourceType: 'canonical_json',
      parseReport: null,
    };
  }

  const parsed = await parseWithPythonRgx({
    artifacts: [{
      kind: 'file',
      originalName: testcaseFile.originalname,
      mimeType: testcaseFile.mimetype,
      size: testcaseFile.size,
      storagePath: testcaseFile.path,
    }],
  });

  if (!parsed?.canonical) {
    const error = new Error('Unable to parse testcase into canonical format');
    error.statusCode = 400;
    throw error;
  }

  return {
    canonical: parsed.canonical,
    sourceType: 'parsed_artifacts',
    parseReport: {
      status: parsed.status || 'failed',
      confidence: parsed.confidence ?? 0,
      warnings: parsed.warnings || [],
      missingRequired: parsed.missing_required || [],
      assumptions: parsed.assumptions || [],
      sanityChecks: parsed.sanity_checks || parsed.sanityChecks || null,
      model: parsed.modelUsed || 'python-rgx',
    },
  };
}

const runValidator = asyncHandler(async (req, res) => {
  const testcaseFile = pickUploadedFile(req.files, 'testcase');
  const resultFile = pickUploadedFile(req.files, 'result');

  if (!testcaseFile) {
    res.status(400);
    throw new Error('Testcase file is required');
  }
  if (!resultFile) {
    res.status(400);
    throw new Error('Result file is required');
  }
  if (!looksLikeJsonFile(resultFile)) {
    res.status(400);
    throw new Error('Result file must be JSON or TXT containing solver output JSON');
  }

  const testcase = await parseTestcaseFile(testcaseFile);
  const validation = await runStandaloneValidation({
    canonical: testcase.canonical,
    uploadedResultPayload: readJsonFile(resultFile),
    distanceMetric: normalizeDistanceMetric(req.body?.distanceMetric),
    preferenceRelaxation: normalizePreferenceRelaxation(req.body?.preferenceRelaxation),
    optimizationIntensity: normalizeIntensity(req.body?.optimizationIntensity),
    customMaxRunSeconds: req.body?.customMaxRunSeconds,
    customGenerations: req.body?.customGenerations,
    compareWithEngine: String(req.body?.compareWithEngine || '').trim().toLowerCase() === 'true',
  });

  res.json({
    success: true,
    testcaseFile: testcaseFile.originalname,
    resultFile: resultFile.originalname,
    testcaseSourceType: testcase.sourceType,
    parseReport: testcase.parseReport,
    ...validation,
  });
});

module.exports = { runValidator };
