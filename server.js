const fs = require('fs');
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const multer = require('multer');
const {
  SUPPORTED_MAPPER_IDS: supportedMapperIds,
  MAPPER_NAMES: mapperNames,
  checkNESMagic,
  parseNESHeader
} = require('./public/js/nes-data');

const app = express();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const romsDir = path.resolve(__dirname, process.env.ROMS_DIR || '..', 'Roms');
const MAX_ROM_SIZE = 4 * 1024 * 1024;
const allowedExtensions = ['.nes'];
const ONE_HOUR = 3600;
const ONE_DAY = 86400;
const REQUEST_TIMEOUT = 30000;

function isRomFile(filename) {
  return allowedExtensions.includes(path.extname(filename).toLowerCase());
}

app.use(compression({ level: 6, threshold: 256 }));
app.use(morgan('dev', { skip: req => req.url === '/health' }));

app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: { policy: 'require-corp' },
  contentSecurityPolicy: false,
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', '');
  res.removeHeader('X-Powered-By');
  req.id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('http://localhost') || origin.endsWith('.github.dev') || origin.endsWith('.preview.app.github.dev'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT, () => {
    if (!res.headersSent) res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/roms/') || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: romsDir,
    filename: (req, file, cb) => {
      const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._\-() ]/g, '');
      const finalName = safeName || `rom-${Date.now()}.nes`;
      const dest = path.join(romsDir, finalName);
      if (fs.existsSync(dest)) {
        const ext = path.extname(finalName);
        const base = path.basename(finalName, ext);
        let n = 1;
        while (fs.existsSync(path.join(romsDir, `${base} (${n})${ext}`))) n++;
        return cb(null, `${base} (${n})${ext}`);
      }
      cb(null, finalName);
    }
  }),
  limits: { fileSize: MAX_ROM_SIZE },
  fileFilter: (req, file, cb) => {
    if (!isRomFile(file.originalname)) {
      return cb(new Error('Only .nes files are allowed'), false);
    }
    cb(null, true);
  }
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});
app.use('/roms/', limiter);

app.use('/api/saves', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many save requests.' }
}));

let romsInfoCache = null;
let romsInfoCacheMtime = null;
let romsCountCache = -1;
let romsCountCacheTime = 0;

function getCachedRomCount() {
  const now = Date.now();
  if (romsCountCache < 0 || now - romsCountCacheTime > 10000) {
    try {
      if (fs.existsSync(romsDir)) {
        romsCountCache = fs.readdirSync(romsDir).filter(f => isRomFile(f)).length;
      } else {
        romsCountCache = 0;
      }
      romsCountCacheTime = now;
    } catch {
      romsCountCache = 0;
    }
  }
  return romsCountCache;
}

const savesDir = path.join(romsDir, '..', 'saves');
const SAVE_PREFIX_PATTERN = /^[a-zA-Z0-9_\-. ]+\.json$/;

function getSavePath(name) {
  if (!SAVE_PREFIX_PATTERN.test(path.basename(name))) return null;
  const p = path.resolve(savesDir, path.basename(name));
  try {
    const realSavesDir = fs.realpathSync(savesDir);
    const realP = fs.realpathSync(p);
    if (!realP.startsWith(realSavesDir + path.sep) && realP !== realSavesDir) return null;
  } catch {
    return null;
  }
  return p;
}

function ensureSavesDir() {
  if (!fs.existsSync(savesDir)) {
    fs.mkdirSync(savesDir, { recursive: true });
  }
}

ensureSavesDir();

function getRomsDirMtime() {
  try {
    return fs.statSync(romsDir).mtimeMs;
  } catch {
    return 0;
  }
}

const romDescriptions = {
  'Castlevania (USA) (Rev-A).nes': 'Classic action-platformer. Hunt Dracula through CastleVania. UNROM (mapper 2) — supported.',
  "Castlevania II - Simon's Quest (USA).nes": 'Open-world Castlevania sequel with day/night cycle. MMC1 (mapper 1) — supported.',
  'Legend of Zelda, The (USA).nes': 'Foundational action-adventure. Explore Hyrule, defeat Ganon. MMC1 (mapper 1) — supported.',
  'Super Mario Bros. (Japan, USA).nes': 'The iconic platformer. Save Princess Peach from Bowser. NROM (mapper 0) — fully supported.'
};

function buildRomsInfo() {
  const results = [];
  if (!fs.existsSync(romsDir)) return results;
  const files = fs.readdirSync(romsDir).filter(f => isRomFile(f)).sort((a, b) => a.localeCompare(b));
  for (const name of files) {
    const filePath = path.resolve(romsDir, name);
    const info = { name, size: 0, valid: false, mapperType: null, mapperName: 'Unknown', supported: false, description: romDescriptions[name] || null };
    try {
      const stat = fs.statSync(filePath);
      info.size = stat.size;
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(16);
        fs.readSync(fd, buf, 0, 16, 0);
        const header = parseNESHeader(buf);
        if (header) {
          info.valid = true;
          info.mapperType = header.mapperType;
          info.mapperName = mapperNames[header.mapperType] || 'Unknown Mapper';
          info.supported = supportedMapperIds.has(header.mapperType);
          info.mirroring = header.mirroring;
          info.batteryRam = header.batteryRam;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      info.error = e.message;
    }
    results.push(info);
  }
  return results;
}

function getCachedRomsInfo() {
  const currentMtime = getRomsDirMtime();
  if (!romsInfoCache || romsInfoCacheMtime !== currentMtime) {
    romsInfoCache = buildRomsInfo();
    romsInfoCacheMtime = currentMtime;
  }
  return romsInfoCache;
}

function invalidateRomsInfoCache() {
  romsInfoCache = null;
  romsInfoCacheMtime = null;
}

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? ONE_DAY * 1000 : 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/health', (req, res) => {
  const uptime = process.uptime();
  res.json({
    ok: true,
    uptime: Math.floor(uptime),
    roms: getCachedRomCount(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    node: process.version
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    maxRomSize: MAX_ROM_SIZE,
    allowedExtensions,
    version: '1.0.0'
  });
});

app.get('/roms/list', (req, res) => {
  if (!fs.existsSync(romsDir)) {
    fs.mkdirSync(romsDir, { recursive: true });
  }
  fs.readdir(romsDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Unable to read ROMs directory' });
    res.json(files.filter(file => isRomFile(file)));
  });
});

app.get('/roms/file', (req, res) => {
  const name = req.query.name;
  if (!name || path.basename(name) !== name || !isRomFile(name) || name.length > 200) {
    return res.status(400).json({ error: 'Invalid ROM name' });
  }
  const filePath = path.resolve(romsDir, name);
  if (!filePath.startsWith(romsDir + path.sep)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ROM not found' });
  }
  res.setHeader('Cache-Control', `public, max-age=${ONE_HOUR}`);
  res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'ROM read error' });
  });
});

app.post('/roms/upload', (req, res, next) => {
  upload.single('rom')(req, res, err => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Max 4MB.' });
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const filePath = req.file.path;
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        if (!checkNESMagic(buf)) {
          fs.unlinkSync(filePath);
          return res.status(400).json({ error: 'Invalid NES ROM — missing iNES header.' });
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      fs.unlinkSync(filePath);
      return res.status(500).json({ error: 'Failed to validate ROM.', detail: e.message });
    }

    invalidateRomsInfoCache();
    res.status(201).json({ name: req.file.filename, size: req.file.size });
  });
});

app.delete('/roms/delete', (req, res) => {
  const name = req.query.name;
  if (!name || path.basename(name) !== name || !isRomFile(name) || name.length > 200) {
    return res.status(400).json({ error: 'Invalid ROM name' });
  }
  const filePath = path.resolve(romsDir, name);
  if (!filePath.startsWith(romsDir + path.sep)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ROM not found' });
  }
  try {
    fs.unlinkSync(filePath);
    invalidateRomsInfoCache();
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete ROM', detail: e.message });
  }
});

app.get('/roms/info', (req, res) => {
  if (!fs.existsSync(romsDir)) return res.json([]);
  res.json(getCachedRomsInfo());
});

app.get('/api/saves', (req, res) => {
  try {
    if (!fs.existsSync(savesDir)) return res.json([]);
    const files = fs.readdirSync(savesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(savesDir, f));
        return { name: f.replace(/\.json$/, ''), size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: 'Failed to list saves', detail: e.message });
  }
});

app.get('/api/saves/file', (req, res) => {
  const name = req.query.name;
  if (!name || !SAVE_PREFIX_PATTERN.test(name + '.json')) {
    return res.status(400).json({ error: 'Invalid save name' });
  }
  const filePath = getSavePath(name + '.json');
  if (!filePath || path.basename(filePath) !== name + '.json') {
    return res.status(400).json({ error: 'Invalid save name' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Save not found' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(filePath);
});

app.post('/api/saves/save', (req, res) => {
  const { name, data } = req.body || {};
  if (!name || !data || typeof name !== 'string' || name.length > 100) {
    return res.status(400).json({ error: 'Invalid save data. Provide name and data.' });
  }
  if (!SAVE_PREFIX_PATTERN.test(name + '.json')) {
    return res.status(400).json({ error: 'Invalid save name format.' });
  }
try { ensureSavesDir(); } catch (e) { console.error('[server] Failed to create saves directory:', e.message); }
  const filePath = getSavePath(name + '.json');
  if (!filePath) return res.status(400).json({ error: 'Invalid save path.' });
  try {
    let payload = data;
    if (typeof payload === 'object') payload = JSON.stringify(payload);
    fs.writeFileSync(filePath, payload, 'utf8');
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save', detail: e.message });
  }
});

app.delete('/api/saves/delete', (req, res) => {
  const name = req.query.name;
  if (!name || !SAVE_PREFIX_PATTERN.test(name + '.json')) {
    return res.status(400).json({ error: 'Invalid save name' });
  }
  const filePath = getSavePath(name + '.json');
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Save not found' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete save', detail: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(`[${req.id || 'unknown'}] Unhandled error:`, err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

if (!fs.existsSync(romsDir)) {
  console.log(`[server] Creating ROMs directory: ${romsDir}`);
  fs.mkdirSync(romsDir, { recursive: true });
}

const files = fs.existsSync(romsDir) ? fs.readdirSync(romsDir).filter(f => isRomFile(f)) : [];
console.log(`[server] Found ${files.length} ROM(s) in ${romsDir}`);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Ruusian Retro Emulator running at http://localhost:${PORT}`);
  console.log(`   Access it from VS Code using the Ports view`);
  console.log(`   Upload:  POST /roms/upload (multipart/form-data, field: "rom")`);
  console.log(`   Delete:  DELETE /roms/delete?name=...`);
  console.log(`   Saves:   GET/POST/DELETE /api/saves/...`);
  console.log(`   Config:  GET  /api/config`);
  console.log(`   Health:  GET  /health`);
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down gracefully...`);
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(() => {
    console.log('[server] All connections closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[server] Forced shutdown after 5s.');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', err => {
  console.error('[server] Uncaught exception:', err);
  process.exit(1);
});
