// SkelIO Backend HTTP & API Server
// Native Node.js HTTP server with SQLite persistence (zero external dependencies)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const db = require('./db.js');

const PORT = process.env.PORT || 3000;
const WEBSITE_DIR = path.join(__dirname, 'website');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// ─── Helpers ───

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { success: false, error: message });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) { // 2 MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function extractToken(req, parsedUrl) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (req.headers['x-skelio-token']) {
    return req.headers['x-skelio-token'];
  }
  if (parsedUrl.searchParams && parsedUrl.searchParams.get('token')) {
    return parsedUrl.searchParams.get('token');
  }
  return null;
}

// ─── Request Handler ───

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
  const pathname = parsedUrl.pathname;

  try {
    // ─── REST API ROUTES ───

    // POST /api/auth/register
    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await parseJsonBody(req);
      const { name, email, password } = body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return sendError(res, 400, 'Name is required.');
      }
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return sendError(res, 400, 'A valid email address is required.');
      }
      if (!password || typeof password !== 'string' || password.length < 6) {
        return sendError(res, 400, 'Password must be at least 6 characters long.');
      }

      try {
        const result = db.createUser({ name, email, password });
        const dashData = db.getDashboardData(result.user.id);
        return sendJson(res, 201, {
          success: true,
          message: 'Account created successfully.',
          user: result.user,
          token: result.token,
          stats: dashData.stats,
          domains: dashData.domains
        });
      } catch (err) {
        if (err.message.includes('already exists')) {
          return sendError(res, 409, err.message);
        }
        return sendError(res, 500, err.message || 'Server error during registration.');
      }
    }

    // POST /api/auth/login
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await parseJsonBody(req);
      const { email, password } = body;

      if (!email || !password) {
        return sendError(res, 400, 'Email and password are required.');
      }

      try {
        const result = db.authenticateUser({ email, password });
        const dashData = db.getDashboardData(result.user.id);
        return sendJson(res, 200, {
          success: true,
          message: 'Logged in successfully.',
          user: result.user,
          token: result.token,
          stats: dashData.stats,
          domains: dashData.domains
        });
      } catch (err) {
        return sendError(res, 401, err.message || 'Invalid credentials.');
      }
    }

    // GET /api/auth/me
    if (req.method === 'GET' && pathname === '/api/auth/me') {
      const token = extractToken(req, parsedUrl);
      const user = db.getUserByToken(token);
      if (!user) {
        return sendError(res, 401, 'Invalid or expired session.');
      }
      return sendJson(res, 200, { success: true, user });
    }

    // POST /api/auth/logout
    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const token = extractToken(req, parsedUrl);
      if (token) {
        db.deleteSession(token);
      }
      return sendJson(res, 200, { success: true, message: 'Logged out successfully.' });
    }

    // GET /api/dashboard
    if (req.method === 'GET' && pathname === '/api/dashboard') {
      const token = extractToken(req, parsedUrl);
      const user = db.getUserByToken(token);
      if (!user) {
        return sendError(res, 401, 'Please log in to access your dashboard data.');
      }

      const data = db.getDashboardData(user.id);
      return sendJson(res, 200, {
        success: true,
        user,
        stats: data.stats,
        domains: data.domains
      });
    }

    // POST /api/dashboard/sync
    if (req.method === 'POST' && pathname === '/api/dashboard/sync') {
      const token = extractToken(req, parsedUrl);
      const user = db.getUserByToken(token);
      if (!user) {
        return sendError(res, 401, 'Please log in to sync dashboard data.');
      }

      const body = await parseJsonBody(req);
      const updated = db.syncDashboardData(user.id, body);
      return sendJson(res, 200, {
        success: true,
        stats: updated.stats,
        domains: updated.domains
      });
    }

    // ─── STATIC WEBSITE ASSET SERVING ───
    if (req.method === 'GET') {
      let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (relativePath === 'login') relativePath = 'login.html';
      if (relativePath === 'dashboard') relativePath = 'dashboard.html';

      const filePath = path.join(WEBSITE_DIR, relativePath);

      // Security: prevent directory traversal
      if (!filePath.startsWith(WEBSITE_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>404 Not Found</h1><p>The requested SkelIO resource was not found.</p>');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      });
      return;
    }

    // Fallback 405 Method Not Allowed
    sendError(res, 405, 'Method not allowed.');

  } catch (err) {
    console.error('[SkelIO Server Error]:', err);
    sendError(res, 500, 'Internal server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  SkelIO Server & SQLite Database Active!`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  Database: data/skelio.db`);
  console.log(`  API: /api/auth/register, /api/auth/login, /api/dashboard`);
  console.log(`======================================================\n`);
});

module.exports = server;
