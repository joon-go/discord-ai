#!/usr/bin/env node
/**
 * Pylon API Discovery Script
 * ===========================
 * Probes common Pylon API endpoints with your token to discover
 * what's available and how the API responds.
 *
 * Usage:
 *   node scripts/discover-pylon.mjs
 *
 * Make sure .env has PYLON_API_KEY and PYLON_BASE_URL set.
 */

import 'dotenv/config';

const API_KEY = process.env.PYLON_API_KEY;
const BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');

if (!API_KEY) {
  console.error('❌ PYLON_API_KEY not set in .env');
  process.exit(1);
}

console.log(`\n🔍 Pylon API Discovery`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Token:    ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);
console.log('─'.repeat(60));

// ─── Endpoints to probe ─────────────────────────────────────────────
const probes = [
  // Root / version
  { method: 'GET', path: '/', label: 'API root' },
  { method: 'GET', path: '/v1', label: 'API v1 root' },
  { method: 'GET', path: '/health', label: 'Health check' },
  { method: 'GET', path: '/api', label: 'API info' },

  // Auth / user
  { method: 'GET', path: '/me', label: 'Current user (me)' },
  { method: 'GET', path: '/v1/me', label: 'Current user (v1/me)' },
  { method: 'GET', path: '/v1/users/me', label: 'Current user (v1/users/me)' },

  // Issues / Conversations
  { method: 'GET', path: '/issues', label: 'Issues (root)' },
  { method: 'GET', path: '/v1/issues', label: 'Issues (v1)' },
  { method: 'GET', path: '/v1/issues?limit=1', label: 'Issues (v1, limit=1)' },
  { method: 'GET', path: '/conversations', label: 'Conversations (root)' },
  { method: 'GET', path: '/v1/conversations', label: 'Conversations (v1)' },
  { method: 'GET', path: '/v1/conversations?limit=1', label: 'Conversations (v1, limit=1)' },

  // Tickets
  { method: 'GET', path: '/tickets', label: 'Tickets (root)' },
  { method: 'GET', path: '/v1/tickets', label: 'Tickets (v1)' },
  { method: 'GET', path: '/v1/tickets?limit=1', label: 'Tickets (v1, limit=1)' },

  // Accounts
  { method: 'GET', path: '/accounts', label: 'Accounts (root)' },
  { method: 'GET', path: '/v1/accounts', label: 'Accounts (v1)' },
  { method: 'GET', path: '/v1/accounts?limit=1', label: 'Accounts (v1, limit=1)' },

  // Contacts
  { method: 'GET', path: '/contacts', label: 'Contacts (root)' },
  { method: 'GET', path: '/v1/contacts', label: 'Contacts (v1)' },
  { method: 'GET', path: '/v1/contacts?limit=1', label: 'Contacts (v1, limit=1)' },

  // Knowledge Base
  { method: 'GET', path: '/knowledge-base', label: 'KB (root)' },
  { method: 'GET', path: '/v1/knowledge-base', label: 'KB (v1)' },
  { method: 'GET', path: '/v1/knowledge-base/articles', label: 'KB articles (v1)' },
  { method: 'GET', path: '/v1/articles', label: 'Articles (v1)' },
  { method: 'GET', path: '/articles', label: 'Articles (root)' },

  // Search
  { method: 'GET', path: '/v1/search?q=test', label: 'Search (v1)' },
  { method: 'POST', path: '/v1/search', label: 'Search POST (v1)', body: { query: 'test' } },
  { method: 'POST', path: '/v1/issues/search', label: 'Issue search POST (v1)', body: { query: 'test' } },

  // Teams / Users
  { method: 'GET', path: '/v1/teams', label: 'Teams (v1)' },
  { method: 'GET', path: '/v1/users', label: 'Users (v1)' },

  // Tags / Labels
  { method: 'GET', path: '/v1/tags', label: 'Tags (v1)' },
  { method: 'GET', path: '/v1/labels', label: 'Labels (v1)' },

  // Webhooks / Events
  { method: 'GET', path: '/v1/webhooks', label: 'Webhooks (v1)' },
  { method: 'GET', path: '/v1/events', label: 'Events (v1)' },

  // OpenAPI / Swagger
  { method: 'GET', path: '/openapi.json', label: 'OpenAPI spec (JSON)' },
  { method: 'GET', path: '/openapi.yaml', label: 'OpenAPI spec (YAML)' },
  { method: 'GET', path: '/swagger.json', label: 'Swagger spec' },
  { method: 'GET', path: '/docs', label: 'API docs page' },
  { method: 'GET', path: '/v1/openapi.json', label: 'OpenAPI spec v1 (JSON)' },
];

// ─── Auth header variations to try ──────────────────────────────────
const authVariations = [
  { name: 'Bearer', headers: { Authorization: `Bearer ${API_KEY}` } },
  { name: 'X-API-Key', headers: { 'X-API-Key': API_KEY } },
  { name: 'Api-Key', headers: { 'Api-Key': API_KEY } },
];

// ─── Run discovery ──────────────────────────────────────────────────
async function probe(method, path, body, authHeaders, label) {
  const url = `${BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    let preview = '';

    if (contentType.includes('json')) {
      const json = await res.json();
      preview = JSON.stringify(json).slice(0, 200);
    } else {
      const text = await res.text();
      preview = text.slice(0, 200);
    }

    return { status: res.status, preview, contentType };
  } catch (err) {
    return { status: 'ERR', preview: err.message, contentType: '' };
  }
}

async function main() {
  // Step 1: Determine which auth method works
  console.log('\n\n📡 Step 1: Testing auth methods...\n');

  let workingAuth = null;
  for (const auth of authVariations) {
    const result = await probe('GET', '/v1/issues?limit=1', null, auth.headers, 'auth test');
    const icon = result.status === 200 ? '✅' : result.status === 401 ? '🔒' : '⚠️';
    console.log(`  ${icon} ${auth.name}: HTTP ${result.status}`);

    if (result.status === 200 && !workingAuth) {
      workingAuth = auth;
    }
  }

  // If no auth worked on /v1/issues, try /issues
  if (!workingAuth) {
    for (const auth of authVariations) {
      const result = await probe('GET', '/issues?limit=1', null, auth.headers, 'auth test fallback');
      if (result.status === 200) {
        workingAuth = auth;
        console.log(`  ✅ ${auth.name} works on /issues (no v1 prefix)`);
        break;
      }
    }
  }

  if (!workingAuth) {
    console.log('\n  ⚠️  No auth method returned 200. Will try all probes with Bearer token.');
    workingAuth = authVariations[0]; // default to Bearer
  } else {
    console.log(`\n  ✅ Using: ${workingAuth.name}`);
  }

  // Step 2: Probe all endpoints
  console.log('\n\n📡 Step 2: Probing endpoints...\n');

  const results = {
    working: [],   // 2xx
    auth: [],      // 401/403
    notFound: [],  // 404
    other: [],     // everything else
  };

  for (const p of probes) {
    const result = await probe(p.method, p.path, p.body, workingAuth.headers, p.label);
    const entry = { ...p, ...result };

    if (result.status >= 200 && result.status < 300) {
      results.working.push(entry);
    } else if (result.status === 401 || result.status === 403) {
      results.auth.push(entry);
    } else if (result.status === 404) {
      results.notFound.push(entry);
    } else {
      results.other.push(entry);
    }

    const icon = result.status >= 200 && result.status < 300 ? '✅' :
                 result.status === 404 ? '  ' :
                 result.status === 401 || result.status === 403 ? '🔒' : '⚠️';
    const statusStr = String(result.status).padEnd(4);
    console.log(`  ${icon} ${statusStr} ${p.method.padEnd(4)} ${p.path.padEnd(40)} ${p.label}`);
  }

  // Step 3: Summary
  console.log('\n\n' + '═'.repeat(60));
  console.log('📋 DISCOVERY SUMMARY');
  console.log('═'.repeat(60));

  console.log(`\n✅ Working endpoints (${results.working.length}):\n`);
  if (results.working.length === 0) {
    console.log('   None found — check your API key and base URL\n');
  }
  for (const r of results.working) {
    console.log(`   ${r.method} ${r.path}`);
    console.log(`   └─ ${r.preview.slice(0, 150)}\n`);
  }

  if (results.auth.length > 0) {
    console.log(`\n🔒 Auth required / forbidden (${results.auth.length}):\n`);
    for (const r of results.auth) {
      console.log(`   ${r.method} ${r.path} — ${r.label}`);
    }
  }

  if (results.other.length > 0) {
    console.log(`\n⚠️ Other responses (${results.other.length}):\n`);
    for (const r of results.other) {
      console.log(`   ${r.status} ${r.method} ${r.path} — ${r.preview.slice(0, 80)}`);
    }
  }

  // Step 4: Recommendations
  console.log('\n\n' + '═'.repeat(60));
  console.log('💡 NEXT STEPS');
  console.log('═'.repeat(60));
  console.log(`
  1. Copy the working endpoints above into src/services/pylon.mjs
  2. Check the response shapes to understand field names
  3. Look for an OpenAPI/Swagger spec (if found above) for full docs
  4. Test ticket creation with: node scripts/test-create-ticket.mjs
  `);
}

main().catch(err => {
  console.error('❌ Discovery failed:', err.message);
  process.exit(1);
});
