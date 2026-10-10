/**
 * MinimalKicks — Node.js Backend Server
 * Fully dynamic, runs on any server that supports Node.js
 * No PHP, no MySQL — data stored in JSON files
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BRANDS_FILE = path.join(DATA_DIR, 'brands.json');

const DEFAULT_BRANDS = ['Nike', 'Adidas', 'New Balance', 'Puma', 'On Cloud', 'Birkenstock', 'Crocs', 'Onitsuka Tiger', 'Girls'];

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Password Hashing Helpers (Salted PBKDF2 with SHA-512)
function hashPin(pin, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(pin), salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPin(enteredPin, storedHash, storedSalt) {
  if (!storedHash || !storedSalt || !enteredPin) return false;
  try {
    const testHash = crypto.pbkdf2Sync(String(enteredPin), storedSalt, 100000, 64, 'sha512').toString('hex');
    const testBuf = Buffer.from(testHash);
    const storedBuf = Buffer.from(storedHash);
    if (testBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(testBuf, storedBuf);
  } catch (_) {
    return false;
  }
}

function ensureSecureSettings() {
  try {
    const settings = readJson(SETTINGS_FILE, {});
    let modified = false;

    // Migrate plain-text adminPin to salted SHA-512 hash
    if (settings.adminPin) {
      const { hash, salt } = hashPin(settings.adminPin);
      settings.adminPinHash = hash;
      settings.adminPinSalt = salt;
      delete settings.adminPin; // Remove plain text password completely!
      modified = true;
    } else if (!settings.adminPinHash || !settings.adminPinSalt) {
      const { hash, salt } = hashPin('MinimalKicks@Admin');
      settings.adminPinHash = hash;
      settings.adminPinSalt = salt;
      modified = true;
    }

    if (modified) {
      writeJson(SETTINGS_FILE, settings);
      console.log('[Security] Admin PIN migrated to salted SHA-512 cryptographic hash.');
    }
  } catch (err) {
    console.error('[Security Migration Error]', err.message);
  }
}

// Initialize data files if not present
if (!fs.existsSync(PRODUCTS_FILE)) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify([], null, 2), 'utf8');
}

if (!fs.existsSync(SETTINGS_FILE)) {
  const { hash, salt } = hashPin('MinimalKicks@Admin');
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    whatsappNumber: '917779012100',
    instagramUrl: 'https://instagram.com/minimal_kicks',
    adminPinHash: hash,
    adminPinSalt: salt
  }, null, 2), 'utf8');
} else {
  ensureSecureSettings();
}

if (!fs.existsSync(BRANDS_FILE)) {
  fs.writeFileSync(BRANDS_FILE, JSON.stringify(DEFAULT_BRANDS, null, 2), 'utf8');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function readJson(filePath, defaultValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return defaultValue;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// ==========================================
// SECURITY: SESSION TOKENS & AUTH MIDDLEWARE
// ==========================================
const SECRET_FILE = path.join(DATA_DIR, '.server_secret');
let SERVER_SECRET = process.env.ADMIN_JWT_SECRET || '';
if (!SERVER_SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    try { SERVER_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
  }
  if (!SERVER_SECRET) {
    SERVER_SECRET = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, SERVER_SECRET, 'utf8'); } catch (_) {}
  }
}

function signAdminToken(durationMs = 7 * 24 * 60 * 60 * 1000) {
  const payload = {
    role: 'admin',
    exp: Date.now() + durationMs,
    nonce: crypto.randomBytes(8).toString('hex')
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SERVER_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;

  try {
    const expectedSig = crypto.createHmac('sha256', SERVER_SECRET).update(payloadB64).digest('base64url');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.role !== 'admin') return false;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-admin-token'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return authHeader.trim();
}

function requireAdminAuth(req, res) {
  const token = extractBearerToken(req);
  if (!verifyAdminToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized: Valid Admin session token required.' }));
    return false;
  }
  return true;
}

// In-Memory Rate Limiter for /api/admin/login
const loginAttempts = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };

  if (record.lockedUntil && now < record.lockedUntil) {
    const waitMins = Math.ceil((record.lockedUntil - now) / 60000);
    return { allowed: false, error: `Security Lockout: Too many failed attempts. Try again in ${waitMins} minute(s).` };
  }

  if (record.lockedUntil && now >= record.lockedUntil) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
  record.count++;
  if (record.count >= 5) {
    record.lockedUntil = now + 15 * 60 * 1000;
    console.warn(`[Security Alert] IP ${ip} locked out after 5 failed login attempts.`);
  }
  loginAttempts.set(ip, record);
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// GitHub & Cloud Persistence Configuration
const GITHUB_REPO = process.env.GITHUB_REPO || 'Codewithjeel/MinimalKicks';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

function getGitHubToken() {
  const settings = readJson(SETTINGS_FILE, {});
  return (process.env.GITHUB_TOKEN || settings.githubToken || '').trim();
}

function getUpstashConfig() {
  const settings = readJson(SETTINGS_FILE, {});
  return {
    url: (process.env.UPSTASH_REDIS_REST_URL || settings.upstashUrl || '').trim(),
    token: (process.env.UPSTASH_REDIS_REST_TOKEN || settings.upstashToken || '').trim()
  };
}

let _gitSyncTimer = null;
function scheduleCloudSync(products) {
  syncToUpstash(products);

  if (_gitSyncTimer) clearTimeout(_gitSyncTimer);
  _gitSyncTimer = setTimeout(() => {
    syncCatalogToGitHub().catch(err => console.error('[GitSync Error]', err.message));
  }, 3000);
}

async function syncCatalogToGitHub() {
  const token = getGitHubToken();
  if (!token) {
    console.log('[GitSync Notice] No GitHub token configured. Changes saved locally to disk.');
    return { success: false, reason: 'No GitHub token configured. Set GITHUB_TOKEN or add it in Store Settings.' };
  }

  if (!fs.existsSync(PRODUCTS_FILE)) return { success: false, reason: 'products.json not found' };
  const content = fs.readFileSync(PRODUCTS_FILE, 'utf8');
  const pathInRepo = 'data/products.json';
  const base64Content = Buffer.from(content, 'utf8').toString('base64');

  // Step 1: Get existing file SHA from GitHub
  const getSha = () => new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${pathInRepo}?ref=${GITHUB_BRANCH}`,
      method: 'GET',
      headers: {
        'User-Agent': 'MinimalKicks-Server',
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.sha || null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });

  const sha = await getSha();

  // Step 2: PUT updated file to GitHub repo
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      message: `Auto-sync sneaker catalog [${new Date().toISOString()}]`,
      content: base64Content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {})
    });

    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${pathInRepo}`,
      method: 'PUT',
      headers: {
        'User-Agent': 'MinimalKicks-Server',
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[GitSync Success] Catalog committed to GitHub permanently!');
          resolve({ success: true, message: 'Committed to GitHub successfully!' });
        } else {
          console.error('[GitSync Failed]', res.statusCode, data);
          resolve({ success: false, status: res.statusCode, error: data });
        }
      });
    });
    req.on('error', err => {
      console.error('[GitSync Network Error]', err.message);
      resolve({ success: false, error: err.message });
    });
    req.write(payload);
    req.end();
  });
}

function syncToUpstash(products) {
  const { url, token } = getUpstashConfig();
  if (!url || !token) return;
  try {
    const endpoint = new URL(`/set/products`, url);
    const payload = JSON.stringify(products);
    const req = https.request(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

async function loadFromUpstash() {
  const { url, token } = getUpstashConfig();
  if (!url || !token) return null;
  return new Promise((resolve) => {
    try {
      const endpoint = new URL(`/get/products`, url);
      const req = https.request(endpoint, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data && data.result) {
              const parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
              if (Array.isArray(parsed) && parsed.length > 0) return resolve(parsed);
            }
            resolve(null);
          } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    } catch (_) { resolve(null); }
  });
}

function saveUploadedImage(dataUrl, id, index) {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return dataUrl;
  try {
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (match) {
      let ext = match[1].toLowerCase();
      if (ext === 'jpeg') ext = 'jpg';
      if (ext === 'svg+xml') ext = 'svg';
      const filename = `${String(id).toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}-${index}.${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(match[2], 'base64'));
      return `uploads/${filename}`;
    }
  } catch (_) {}
  return dataUrl;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // GET /api/events (Real-Time Server-Sent Events stream for instant global sync)
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // GET /api/products
  if (pathname === '/api/products' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readJson(PRODUCTS_FILE, [])));
    return;
  }

  // POST /api/products (ADMIN ONLY)
  if (pathname === '/api/products' && req.method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    try {
      const payload = await parseJsonBody(req);
      const products = readJson(PRODUCTS_FILE, []);
      const brandPrefix = (payload.brand || 'MK').replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase() || 'MK';
      const sku = payload.id || `MK-${brandPrefix}-${Date.now().toString().slice(-5)}`;
      const savedImages = (payload.images || []).map((img, i) => saveUploadedImage(img, sku, i)).filter(Boolean);

      const newProduct = {
        id: sku,
        name: payload.name || '',
        brand: payload.brand || '',
        price: Number(payload.price) || 0,
        description: payload.description || '',
        girls_collection: payload.girls_collection || 0,
        sizes: Array.isArray(payload.sizes) && payload.sizes.length > 0 ? payload.sizes : ['UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11'],
        images: savedImages,
        image_style: payload.image_style || 'product-visual',
        inStock: payload.inStock !== false,
        createdAt: payload.createdAt || new Date().toISOString()
      };

      const existingIdx = products.findIndex(p => p.id === sku);
      if (existingIdx !== -1) products[existingIdx] = newProduct;
      else products.unshift(newProduct);

      writeJson(PRODUCTS_FILE, products);
      broadcastEvent('catalog_updated', { action: 'create', id: sku });
      scheduleCloudSync(products);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(newProduct));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // PUT /api/products/:id (ADMIN ONLY)
  if (pathname.startsWith('/api/products/') && req.method === 'PUT') {
    if (!requireAdminAuth(req, res)) return;
    try {
      const targetId = pathname.replace('/api/products/', '');
      const payload = await parseJsonBody(req);
      const products = readJson(PRODUCTS_FILE, []);
      const idx = products.findIndex(p => p.id === targetId);
      if (idx === -1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Product not found' }));
        return;
      }
      const savedImages = (payload.images || products[idx].images || []).map((img, i) => saveUploadedImage(img, targetId, i)).filter(Boolean);
      products[idx] = { ...products[idx], ...payload, images: savedImages, id: targetId };
      writeJson(PRODUCTS_FILE, products);
      broadcastEvent('catalog_updated', { action: 'update', id: targetId });
      scheduleCloudSync(products);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(products[idx]));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DELETE /api/products/:id (ADMIN ONLY)
  if (pathname.startsWith('/api/products/') && req.method === 'DELETE') {
    if (!requireAdminAuth(req, res)) return;
    const targetId = pathname.replace('/api/products/', '');
    let products = readJson(PRODUCTS_FILE, []);
    const target = products.find(p => p.id === targetId);
    if (target && Array.isArray(target.images)) {
      target.images.forEach(img => {
        if (img && img.startsWith('uploads/')) {
          const fp = path.join(ROOT_DIR, img);
          if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
        }
      });
    }
    products = products.filter(p => p.id !== targetId);
    writeJson(PRODUCTS_FILE, products);
    broadcastEvent('catalog_updated', { action: 'delete', id: targetId });
    scheduleCloudSync(products);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: targetId }));
    return;
  }

  // POST /api/catalog/import (ADMIN ONLY)
  if (pathname === '/api/catalog/import' && req.method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    try {
      const payload = await parseJsonBody(req);
      const incoming = Array.isArray(payload) ? payload : (payload.products || []);
      if (!Array.isArray(incoming) || incoming.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid catalog format. Expected an array of sneakers.' }));
        return;
      }
      writeJson(PRODUCTS_FILE, incoming);
      broadcastEvent('catalog_updated', { action: 'import', count: incoming.length });
      scheduleCloudSync(incoming);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: incoming.length }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/cloud/sync (ADMIN ONLY)
  if (pathname === '/api/cloud/sync' && req.method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    try {
      const gitRes = await syncCatalogToGitHub();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gitRes));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/settings (PUBLIC STOREFRONT SETTINGS - ZERO CREDENTIALS EXPOSED)
  if (pathname === '/api/settings' && req.method === 'GET') {
    const settings = readJson(SETTINGS_FILE, {});
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    // NEVER expose adminPin, adminPinHash, adminPinSalt, githubToken, or cloud secrets to public!
    res.end(JSON.stringify({
      whatsappNumber: settings.whatsappNumber || '917779012100',
      instagramUrl: settings.instagramUrl || 'https://instagram.com/minimal_kicks'
    }));
    return;
  }

  // GET /api/admin/settings (AUTHENTICATED ADMIN ONLY)
  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    if (!requireAdminAuth(req, res)) return;
    const settings = readJson(SETTINGS_FILE, {});
    const hasToken = !!(process.env.GITHUB_TOKEN || settings.githubToken);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      whatsappNumber: settings.whatsappNumber || '917779012100',
      instagramUrl: settings.instagramUrl || 'https://instagram.com/minimal_kicks',
      hasGithubToken: hasToken,
      githubTokenMasked: hasToken ? '••••••••••••••••••••' : ''
    }));
    return;
  }

  // POST /api/settings (ADMIN ONLY)
  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    try {
      const payload = await parseJsonBody(req);
      const current = readJson(SETTINGS_FILE, {});
      if (payload.whatsappNumber !== undefined) current.whatsappNumber = String(payload.whatsappNumber).trim();
      if (payload.instagramUrl !== undefined) current.instagramUrl = String(payload.instagramUrl).trim();
      if (payload.githubToken !== undefined && String(payload.githubToken).trim() !== '') {
        current.githubToken = String(payload.githubToken).trim();
      }
      writeJson(SETTINGS_FILE, current);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/admin/login (RATE LIMITED & SALTED CRYPTOGRAPHIC VERIFICATION)
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: rateCheck.error }));
      return;
    }

    try {
      const payload = await parseJsonBody(req);
      const entered = String(payload.pin || '').trim();
      const settings = readJson(SETTINGS_FILE, {});
      
      const isValid = verifyPin(entered, settings.adminPinHash, settings.adminPinSalt);
      if (isValid) {
        resetLoginAttempts(ip);
        const token = signAdminToken();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, token }));
      } else {
        recordFailedLogin(ip);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Incorrect Admin PIN' }));
      }
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/admin/verify (VERIFY EXISTING ADMIN SESSION TOKEN)
  if (pathname === '/api/admin/verify' && req.method === 'GET') {
    const token = extractBearerToken(req);
    const valid = verifyAdminToken(token);
    res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ valid }));
    return;
  }

  // POST /api/admin/change-pin (ADMIN ONLY - SALTED SHA-512)
  if (pathname === '/api/admin/change-pin' && req.method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    try {
      const payload = await parseJsonBody(req);
      const newPin = String(payload.newPin || '').trim();
      if (!newPin || newPin.length < 4) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'PIN must be at least 4 characters long' }));
        return;
      }
      const settings = readJson(SETTINGS_FILE, {});
      const { hash, salt } = hashPin(newPin);
      settings.adminPinHash = hash;
      settings.adminPinSalt = salt;
      delete settings.adminPin; // Remove any plain text PIN forever
      writeJson(SETTINGS_FILE, settings);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/brands
  if (pathname === '/api/brands' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readJson(BRANDS_FILE, DEFAULT_BRANDS)));
    return;
  }

  // POST /api/brands (ADMIN ONLY)
  if (pathname === '/api/brands' && req.method === 'POST') {
    if (!requireAdminAuth(req, res)) return;
    try {
      const payload = await parseJsonBody(req);
      const name = (payload.name || '').trim();
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Brand name required' }));
        return;
      }
      const brands = readJson(BRANDS_FILE, DEFAULT_BRANDS);
      if (!brands.some(b => b.toLowerCase() === name.toLowerCase())) brands.push(name);
      writeJson(BRANDS_FILE, brands);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(brands));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DELETE /api/brands/:name (ADMIN ONLY)
  if (pathname.startsWith('/api/brands/') && req.method === 'DELETE') {
    if (!requireAdminAuth(req, res)) return;
    const targetBrand = pathname.replace('/api/brands/', '').trim();
    let brands = readJson(BRANDS_FILE, DEFAULT_BRANDS);
    brands = brands.filter(b => b.toLowerCase() !== targetBrand.toLowerCase());
    writeJson(BRANDS_FILE, brands);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(brands));
    return;
  }

  // Static file serving
  let safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT_DIR, safePath);

  // STRICT SECURITY FILTER: Block direct access to data/, .server_secret, .git, .env, or system json files
  const normalizedPath = safePath.replace(/\\/g, '/').toLowerCase();
  if (
    normalizedPath.startsWith('/data/') ||
    normalizedPath === '/data' ||
    normalizedPath.includes('.server_secret') ||
    normalizedPath.includes('/.') ||
    (normalizedPath.endsWith('.json') && !normalizedPath.endsWith('manifest.json')) ||
    normalizedPath.endsWith('.env') ||
    normalizedPath.endsWith('.sql') ||
    normalizedPath.endsWith('.log')
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden: Direct access to system data files is protected.');
    return;
  }

  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const isUploadAsset = safePath.startsWith('/uploads/');
    const cacheHeader = isUploadAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, no-store, must-revalidate';

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': cacheHeader,
      'Access-Control-Allow-Origin': '*'
    };
    if (!isUploadAsset) {
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, async () => {
  console.log(`MinimalKicks Server running at http://localhost:${PORT}`);
  try {
    const cloudItems = await loadFromUpstash();
    if (Array.isArray(cloudItems) && cloudItems.length > 0) {
      writeJson(PRODUCTS_FILE, cloudItems);
      console.log(`[CloudSync] Restored ${cloudItems.length} sneakers from Upstash Cloud Database.`);
    }
  } catch (_) {}
});
