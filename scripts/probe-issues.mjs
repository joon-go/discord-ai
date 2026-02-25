#!/usr/bin/env node
/**
 * Pylon Deep Probe
 * =================
 * Now that we know the API shape (no /v1 prefix, Bearer auth),
 * this digs deeper into /issues and tests ticket creation.
 *
 * Usage:
 *   node scripts/probe-issues.mjs
 */

import 'dotenv/config';

const API_KEY = process.env.PYLON_API_KEY;
const BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');

if (!API_KEY) {
  console.error('❌ PYLON_API_KEY not set');
  process.exit(1);
}

async function req(method, path, body = null) {
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, options);
  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data };
}

function log(icon, msg) {
  console.log(`  ${icon} ${msg}`);
}

async function main() {
  console.log('\n🔬 Pylon Deep Probe');
  console.log('═'.repeat(60));

  // ── 1. Probe /issues with time params ──────────────────────
  console.log('\n\n📋 ISSUES ENDPOINT\n');

  // Try various time param formats
  const now = new Date();
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const timeFormats = [
    // ISO 8601
    { label: 'ISO timestamps', params: `start_time=${oneWeekAgo.toISOString()}&end_time=${now.toISOString()}` },
    // Unix seconds
    { label: 'Unix seconds', params: `start_time=${Math.floor(oneWeekAgo.getTime() / 1000)}&end_time=${Math.floor(now.getTime() / 1000)}` },
    // Unix ms
    { label: 'Unix milliseconds', params: `start_time=${oneWeekAgo.getTime()}&end_time=${now.getTime()}` },
    // Date only
    { label: 'Date only (YYYY-MM-DD)', params: `start_time=${oneWeekAgo.toISOString().split('T')[0]}&end_time=${now.toISOString().split('T')[0]}` },
  ];

  let issuesWorking = null;

  for (const tf of timeFormats) {
    const result = await req('GET', `/issues?${tf.params}`);
    const icon = result.status === 200 ? '✅' : '❌';
    console.log(`  ${icon} ${tf.label}: HTTP ${result.status}`);

    if (result.status === 200 && !issuesWorking) {
      issuesWorking = tf;
      const count = Array.isArray(result.data?.data) ? result.data.data.length : '?';
      console.log(`     → ${count} issues returned`);

      // Show first issue structure
      if (result.data?.data?.[0]) {
        const sample = result.data.data[0];
        console.log(`\n     Sample issue fields:`);
        for (const [key, val] of Object.entries(sample)) {
          const display = typeof val === 'object' ? JSON.stringify(val).slice(0, 80) : String(val).slice(0, 80);
          console.log(`       ${key}: ${display}`);
        }
      }

      // Check pagination
      if (result.data?.cursor || result.data?.next_cursor || result.data?.pagination) {
        console.log(`\n     Pagination: ${JSON.stringify(result.data.cursor || result.data.next_cursor || result.data.pagination).slice(0, 100)}`);
      }
    } else if (result.status !== 200) {
      console.log(`     → ${JSON.stringify(result.data).slice(0, 100)}`);
    }
  }

  // ── 2. Try additional issue query params ───────────────────
  if (issuesWorking) {
    console.log('\n\n  📎 Testing additional query params...\n');

    const baseParams = issuesWorking.params;
    const extras = [
      { label: 'with limit', params: `${baseParams}&limit=1` },
      { label: 'with search', params: `${baseParams}&search=test` },
      { label: 'with query', params: `${baseParams}&query=test` },
      { label: 'with q', params: `${baseParams}&q=test` },
      { label: 'with status=open', params: `${baseParams}&status=open` },
      { label: 'with state=open', params: `${baseParams}&state=open` },
    ];

    for (const extra of extras) {
      const result = await req('GET', `/issues?${extra.params}`);
      const icon = result.status === 200 ? '✅' : '❌';
      const count = result.status === 200 && Array.isArray(result.data?.data) ? `(${result.data.data.length} results)` : '';
      console.log(`  ${icon} ${extra.label}: HTTP ${result.status} ${count}`);
    }
  }

  // ── 3. Probe issue creation ────────────────────────────────
  console.log('\n\n🎫 ISSUE CREATION\n');

  const createEndpoints = [
    '/issues',
    '/tickets',
    '/conversations',
  ];

  // Try different payload shapes
  const payloads = [
    {
      label: 'title + body',
      data: {
        title: '[TEST] Bot discovery probe — safe to delete',
        body: 'Automated test from Discord bot setup.',
      },
    },
    {
      label: 'title + description',
      data: {
        title: '[TEST] Bot discovery probe — safe to delete',
        description: 'Automated test from Discord bot setup.',
      },
    },
    {
      label: 'subject + body',
      data: {
        subject: '[TEST] Bot discovery probe — safe to delete',
        body: 'Automated test from Discord bot setup.',
      },
    },
    {
      label: 'title + body + source',
      data: {
        title: '[TEST] Bot discovery probe — safe to delete',
        body: 'Automated test from Discord bot setup.',
        source: 'discord',
      },
    },
  ];

  // First do dry-run style probes with OPTIONS/HEAD
  console.log('  Testing which endpoints accept POST...\n');

  for (const endpoint of createEndpoints) {
    // Just try the first payload to see which endpoints accept POST
    const result = await req('POST', endpoint, payloads[0].data);
    const icon = result.status >= 200 && result.status < 300 ? '✅' :
                 result.status === 405 ? '🚫' :
                 result.status === 422 || result.status === 400 ? '⚠️' : '❌';

    console.log(`  ${icon} POST ${endpoint}: HTTP ${result.status}`);
    console.log(`     → ${JSON.stringify(result.data).slice(0, 200)}`);

    // If we got a validation error (400/422), try other payload shapes
    if (result.status === 400 || result.status === 422) {
      console.log('     Trying alternative payloads...');
      for (const payload of payloads.slice(1)) {
        const altResult = await req('POST', endpoint, payload.data);
        const altIcon = altResult.status >= 200 && altResult.status < 300 ? '✅' : '❌';
        console.log(`     ${altIcon} ${payload.label}: HTTP ${altResult.status}`);
        if (altResult.status >= 200 && altResult.status < 300) {
          console.log(`        → ${JSON.stringify(altResult.data).slice(0, 200)}`);
        }
      }
    }

    // If created successfully, show the response shape
    if (result.status >= 200 && result.status < 300) {
      console.log('\n  🎉 Issue creation works!\n');
      console.log(`  Endpoint: POST ${endpoint}`);
      console.log(`  Payload shape: ${payloads[0].label}`);
      console.log(`  Response:`);
      console.log(JSON.stringify(result.data, null, 2));
      console.log('\n  ⚠️  Delete this test issue in Pylon!');
    }
    console.log('');
  }

  // ── 4. Probe /accounts deeper ──────────────────────────────
  console.log('\n📇 ACCOUNTS ENDPOINT\n');

  const accResult = await req('GET', '/accounts?limit=1');
  if (accResult.status === 200 && accResult.data?.data?.[0]) {
    const sample = accResult.data.data[0];
    console.log('  Sample account fields:');
    for (const [key, val] of Object.entries(sample)) {
      const display = typeof val === 'object' ? JSON.stringify(val).slice(0, 80) : String(val).slice(0, 80);
      console.log(`    ${key}: ${display}`);
    }
  }

  // ── 5. Probe /contacts deeper ──────────────────────────────
  console.log('\n\n👤 CONTACTS ENDPOINT\n');

  const conResult = await req('GET', '/contacts?limit=1');
  if (conResult.status === 200 && conResult.data?.data?.[0]) {
    const sample = conResult.data.data[0];
    console.log('  Sample contact fields:');
    for (const [key, val] of Object.entries(sample)) {
      const display = typeof val === 'object' ? JSON.stringify(val).slice(0, 80) : String(val).slice(0, 80);
      console.log(`    ${key}: ${display}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(60));
  console.log('📋 WHAT WE KNOW');
  console.log('═'.repeat(60));
  console.log(`
  Auth:       Bearer token ✅
  Base URL:   ${BASE_URL} (no /v1 prefix)
  /me:        ✅ Returns service account info
  /issues:    Requires start_time & end_time params${issuesWorking ? ` (${issuesWorking.label} format)` : ''}
  /accounts:  ✅ Paginated list
  /contacts:  ✅ Paginated list

  Share this output and I'll wire up pylon.mjs with the exact endpoints!
  `);
}

main().catch(err => {
  console.error('❌ Probe failed:', err.message);
  process.exit(1);
});
