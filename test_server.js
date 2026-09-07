// Automated Test Suite for SkelIO SQLite Database & API Server

const http = require('node:http');
const server = require('./server.js');

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n--- Starting SkelIO API & Database Verification ---');
  const testEmail = `dev_${Date.now()}@skelio.dev`;
  let authToken = '';

  try {
    // 1. Register new account
    console.log(`1. Testing POST /api/auth/register (${testEmail})...`);
    const regRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      name: 'Rudranksh Parial',
      email: testEmail,
      password: 'mypassword123'
    });

    console.log('Register status:', regRes.status);
    console.log('User created:', regRes.body.user);
    console.log('Initial stats stored in DB:', regRes.body.stats);
    console.log('Baseline domains stored in DB:', regRes.body.domains.length);
    if (regRes.status !== 201 || !regRes.body.token) throw new Error('Registration failed');
    authToken = regRes.body.token;

    // 2. Duplicate registration check
    console.log('2. Testing Duplicate Registration (Expect 409 Conflict)...');
    const dupRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/register',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      name: 'Rudranksh Parial',
      email: testEmail,
      password: 'mypassword123'
    });
    console.log('Duplicate status:', dupRes.status, dupRes.body.error);
    if (dupRes.status !== 409) throw new Error('Expected 409 for duplicate');

    // 3. Login with correct credentials
    console.log('3. Testing POST /api/auth/login...');
    const loginRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      email: testEmail,
      password: 'mypassword123'
    });
    console.log('Login status:', loginRes.status, 'User:', loginRes.body.user.name);
    if (loginRes.status !== 200 || !loginRes.body.token) throw new Error('Login failed');

    // 4. Login with wrong password
    console.log('4. Testing Invalid Password (Expect 401)...');
    const failRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      email: testEmail,
      password: 'wrongpassword'
    });
    console.log('Invalid pass status:', failRes.status, failRes.body.error);
    if (failRes.status !== 401) throw new Error('Expected 401 for wrong pass');

    // 5. GET /api/dashboard with token
    console.log('5. Testing GET /api/dashboard...');
    const dashRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/dashboard',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    console.log('Dashboard status:', dashRes.status);
    console.log('Retrieved stats from SQLite:', dashRes.body.stats);
    console.log('Retrieved domains count:', dashRes.body.domains.length);
    if (dashRes.status !== 200 || dashRes.body.domains.length !== 5) throw new Error('Dashboard fetch failed');

    // 6. POST /api/dashboard/sync (Simulate live browsing updates)
    console.log('6. Testing POST /api/dashboard/sync with live browsing site...');
    const syncRes = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/dashboard/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    }, {
      domains: [
        {
          domain: 'youtube.com',
          archetype: 'VIDEO_STREAM',
          bandwidthSaved: 5400000,
          actualBytes: 1200000,
          potentialBytes: 6600000,
          shifts: 28,
          blocked: 30,
          lastUpdated: Date.now()
        }
      ],
      totalBandwidth: 20184919,
      totalShifts: 102,
      totalBlocked: 104
    });

    console.log('Sync status:', syncRes.status);
    console.log('Updated total saved in DB:', syncRes.body.stats.totalBandwidthSaved);
    console.log('Total domains in DB:', syncRes.body.domains.length);
    const hasYouTube = syncRes.body.domains.some(d => d.domain === 'youtube.com');
    console.log('YouTube recorded in SQLite DB:', hasYouTube);
    if (!hasYouTube) throw new Error('Sync failed to record new domain');

    // 7. Verify persistent retrieval after sync
    console.log('7. Verifying data persistence via GET /api/dashboard...');
    const recheck = await request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/dashboard',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (recheck.body.domains.length !== 6) throw new Error('Persistence re-check failed');

    console.log('\n=============================================');
    console.log('  ALL BACKEND & DATABASE TESTS PASSED! (7/7) ');
    console.log('=============================================\n');

  } catch (err) {
    console.error('Test Failed:', err);
  } finally {
    server.close();
  }
}

runTests();
