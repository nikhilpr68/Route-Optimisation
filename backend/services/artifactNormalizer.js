const fs = require('fs');
const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');

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
    const out = [];
    for (const name of wb.SheetNames || []) {
        const ws = wb.Sheets[name];
        const csv = xlsx.utils.sheet_to_csv(ws);
        out.push(`--- Excel Sheet: ${name} ---\n${csv}`);
    }
    return out.join('\n\n');
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

        textChunks.push(`--- Artifact ${i + 1} (unknown) --- name=${name} mime=${mime}`);
    }

    return { textChunks, binaryParts };
}

module.exports = { normalizeArtifacts };