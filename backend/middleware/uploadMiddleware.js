const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const uploadDir = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : (process.env.VERCEL ? path.join(os.tmpdir(), 'uploads') : path.join(process.cwd(), 'uploads'));

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        const safeFieldname = String(file.fieldname || 'file').replace(/[^a-z0-9_-]+/gi, '-');
        const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
        cb(null, `${safeFieldname}-${uniqueSuffix}${ext}`);
    }
});

// Accept: Excel, CSV, PDF, images, txt/json
const fileFilter = (req, file, cb) => {
    const allowedExt = /\.(xlsx|xls|csv|pdf|png|jpg|jpeg|webp|txt|json)$/i;
    const extOk = allowedExt.test(path.extname(file.originalname || '').toLowerCase());

    const mime = file.mimetype || '';
    const mimeOk =
        mime === 'application/pdf' ||
        mime.startsWith('image/') ||
        mime.startsWith('text/') ||
        mime === 'application/json' ||
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'application/vnd.ms-excel';

    if (extOk || mimeOk) return cb(null, true);
    cb(new Error('Unsupported file type. Upload xlsx/xls/csv/pdf/images/txt/json.'));
};

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter
});

module.exports = upload;
