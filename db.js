// SkelIO SQLite Database Management Layer
// Built with native Node.js node:sqlite (zero external dependencies)

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'skelio.db');
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for high concurrency and performance
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    plan TEXT DEFAULT 'PRO',
    initials TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dashboard_stats (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_bandwidth_saved INTEGER DEFAULT 0,
    total_potential_bytes INTEGER DEFAULT 0,
    total_shifts_prevented INTEGER DEFAULT 0,
    total_blocked_resources INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS domain_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    archetype TEXT DEFAULT 'STANDARD',
    bandwidth_saved INTEGER DEFAULT 0,
    actual_bytes INTEGER DEFAULT 0,
    potential_bytes INTEGER DEFAULT 0,
    shifts INTEGER DEFAULT 0,
    blocked INTEGER DEFAULT 0,
    last_updated INTEGER NOT NULL,
    UNIQUE(user_id, domain)
  );
`);

// ─── Helpers ───

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function computeInitials(name, email) {
  const cleanName = (name || '').trim() || (email || '').split('@')[0];
  const parts = cleanName.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return cleanName.slice(0, 2).toUpperCase() || 'SK';
}

// Baseline websites pre-seeded for every new registered user
const BASELINE_DOMAINS = [
  { domain: 'c2c.sh', archetype: 'SCROLL_SHOWCASE', blocked: 14, shifts: 14, bandwidthSaved: 2936012, actualBytes: 943718, potentialBytes: 3879730 },
  { domain: 'apple.com', archetype: 'SCROLL_SHOWCASE', blocked: 22, shifts: 22, bandwidthSaved: 4404019, actualBytes: 1468006, potentialBytes: 5872025 },
  { domain: 'nytimes.com', archetype: 'EDITORIAL', blocked: 8, shifts: 8, bandwidthSaved: 1677721, actualBytes: 524288, potentialBytes: 2202009 },
  { domain: 'nike.com', archetype: 'E-COMMERCE', blocked: 19, shifts: 19, bandwidthSaved: 3565158, actualBytes: 1153433, potentialBytes: 4718591 },
  { domain: 'stripe.com', archetype: 'STANDARD', blocked: 11, shifts: 11, bandwidthSaved: 2202009, actualBytes: 734003, potentialBytes: 2936012 }
];

// ─── User Authentication Functions ───

function createUser({ name, email, password }) {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name.trim();

  // Check if user already exists
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) {
    throw new Error('An account with this email address already exists.');
  }

  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);
  const initials = computeInitials(cleanName, cleanEmail);
  const now = Date.now();

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, salt, plan, initials, created_at, last_login_at)
    VALUES (?, ?, ?, ?, 'PRO', ?, ?, ?)
  `);
  insertUser.run(cleanName, cleanEmail, passwordHash, salt, initials, now, now);

  const user = db.prepare('SELECT id, name, email, plan, initials, created_at FROM users WHERE email = ?').get(cleanEmail);

  // Initialize fresh, isolated dashboard stats for this new user account
  db.prepare(`
    INSERT INTO dashboard_stats (user_id, total_bandwidth_saved, total_potential_bytes, total_shifts_prevented, total_blocked_resources, updated_at)
    VALUES (?, 0, 0, 0, 0, ?)
  `).run(user.id, now);

  // Create session token (30 days validity)
  const token = generateToken();
  const expiresAt = now + (30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    user.id,
    expiresAt,
    now
  );

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      initials: user.initials,
      createdAt: user.created_at
    },
    token
  };
}

function authenticateUser({ email, password }) {
  const cleanEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);

  if (!user) {
    throw new Error('Invalid email or password.');
  }

  const computedHash = hashPassword(password, user.salt);
  if (computedHash !== user.password_hash) {
    throw new Error('Invalid email or password.');
  }

  const now = Date.now();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);

  // Generate new session token
  const token = generateToken();
  const expiresAt = now + (30 * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    user.id,
    expiresAt,
    now
  );

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      plan: user.plan,
      initials: user.initials,
      createdAt: user.created_at
    },
    token
  };
}

function getUserByToken(token) {
  if (!token) return null;
  const now = Date.now();
  const session = db.prepare(`
    SELECT s.token, u.id, u.name, u.email, u.plan, u.initials, u.created_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);

  if (!session) return null;
  return {
    id: session.id,
    name: session.name,
    email: session.email,
    plan: session.plan,
    initials: session.initials,
    createdAt: session.created_at
  };
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ─── Dashboard Data Queries ───

function getDashboardData(userId) {
  const stats = db.prepare(`
    SELECT total_bandwidth_saved, total_potential_bytes, total_shifts_prevented, total_blocked_resources, updated_at
    FROM dashboard_stats
    WHERE user_id = ?
  `).get(userId);

  const rawDomains = db.prepare(`
    SELECT domain, archetype, bandwidth_saved, actual_bytes, potential_bytes, shifts, blocked, last_updated
    FROM domain_records
    WHERE user_id = ?
    ORDER BY last_updated DESC
  `).all(userId);

  const domains = rawDomains.map(d => ({
    domain: d.domain,
    archetype: d.archetype || 'STANDARD',
    bandwidthSaved: Math.max(0, d.bandwidth_saved),
    actualBytes: Math.max(10000, d.actual_bytes),
    potentialBytes: Math.max(d.bandwidth_saved + d.actual_bytes, d.potential_bytes),
    shifts: Math.max(0, d.shifts),
    blocked: Math.max(0, d.blocked),
    lastUpdated: d.last_updated
  }));

  return {
    stats: stats ? {
      totalBandwidthSaved: Math.max(0, stats.total_bandwidth_saved),
      totalPotentialBytes: Math.max(0, stats.total_potential_bytes),
      totalShiftsPrevented: Math.max(0, stats.total_shifts_prevented),
      totalBlockedResources: Math.max(0, stats.total_blocked_resources),
      updatedAt: stats.updated_at
    } : {
      totalBandwidthSaved: 0,
      totalPotentialBytes: 0,
      totalShiftsPrevented: 0,
      totalBlockedResources: 0,
      updatedAt: Date.now()
    },
    domains
  };
}

function syncDashboardData(userId, payload) {
  const now = Date.now();
  const { domains, totalBandwidth, totalShifts, totalBlocked } = payload;

  if (Array.isArray(domains)) {
    const upsertDomain = db.prepare(`
      INSERT INTO domain_records (user_id, domain, archetype, bandwidth_saved, actual_bytes, potential_bytes, shifts, blocked, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, domain) DO UPDATE SET
        archetype = excluded.archetype,
        bandwidth_saved = MAX(domain_records.bandwidth_saved, excluded.bandwidth_saved),
        actual_bytes = CASE WHEN excluded.actual_bytes > 0 THEN excluded.actual_bytes ELSE domain_records.actual_bytes END,
        potential_bytes = MAX(domain_records.bandwidth_saved, excluded.bandwidth_saved) + CASE WHEN excluded.actual_bytes > 0 THEN excluded.actual_bytes ELSE domain_records.actual_bytes END,
        shifts = MAX(domain_records.shifts, excluded.shifts),
        blocked = MAX(domain_records.blocked, excluded.blocked),
        last_updated = excluded.last_updated
    `);

    for (const d of domains) {
      if (!d.domain) continue;
      const saved = Math.max(0, Math.round(Number(d.bandwidthSaved) || 0));
      const used = Math.max(0, Math.round(Number(d.actualBytes) || 0));
      const pot = saved + used;
      const sh = Math.max(0, Math.round(Number(d.shifts) || 0));
      const blk = Math.max(0, Math.round(Number(d.blocked) || sh));

      upsertDomain.run(
        userId,
        d.domain,
        d.archetype || 'STANDARD',
        saved,
        used,
        pot,
        sh,
        blk,
        Number(d.lastUpdated) || now
      );
    }
  }

  // Update summary stats
  // Compute true sums from all current user domains
  const sumRow = db.prepare(`
    SELECT 
      COALESCE(SUM(bandwidth_saved), 0) as sum_saved,
      COALESCE(SUM(potential_bytes), 0) as sum_potential,
      COALESCE(SUM(shifts), 0) as sum_shifts,
      COALESCE(SUM(blocked), 0) as sum_blocked
    FROM domain_records
    WHERE user_id = ?
  `).get(userId);

  const finalSaved = Math.max(sumRow.sum_saved, Number(totalBandwidth) || 0);
  const finalShifts = Math.max(sumRow.sum_shifts, Number(totalShifts) || 0);
  const finalBlocked = Math.max(sumRow.sum_blocked, Number(totalBlocked) || 0);
  const finalPotential = Math.max(sumRow.sum_potential, finalSaved);

  db.prepare(`
    INSERT INTO dashboard_stats (user_id, total_bandwidth_saved, total_potential_bytes, total_shifts_prevented, total_blocked_resources, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total_bandwidth_saved = excluded.total_bandwidth_saved,
      total_potential_bytes = excluded.total_potential_bytes,
      total_shifts_prevented = excluded.total_shifts_prevented,
      total_blocked_resources = excluded.total_blocked_resources,
      updated_at = excluded.updated_at
  `).run(userId, finalSaved, finalPotential, finalShifts, finalBlocked, now);

  return getDashboardData(userId);
}

module.exports = {
  db,
  createUser,
  authenticateUser,
  getUserByToken,
  deleteSession,
  getDashboardData,
  syncDashboardData
};
