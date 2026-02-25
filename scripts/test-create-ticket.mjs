#!/usr/bin/env node
/**
 * Test Pylon Ticket Creation
 * ===========================
 * Creates a test ticket in Pylon using the discovered API shape:
 *   POST /issues with body_html (required), title, source, tags
 *
 * Usage:
 *   node scripts/test-create-ticket.mjs
 *   node scripts/test-create-ticket.mjs --dry-run
 */

import 'dotenv/config';

const API_KEY = process.env.PYLON_API_KEY;
const BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');
const DRY_RUN = process.argv.includes('--dry-run');

if (!API_KEY) {
  console.error('❌ PYLON_API_KEY not set in .env');
  process.exit(1);
}

// ─── Test ticket payload (matches Pylon's required format) ───────────
const testTicket = {
  title: '[TEST] Discord Bot — Ticket Creation Test',
  body_html: `
<h3>Test Ticket</h3>
<p>This is a test ticket created by the Discord support bot setup script.</p>
<p>If you see this, ticket creation is working correctly. You can safely close/delete this ticket.</p>
<hr>
<p><strong>Source:</strong> Discord Bot Test Script</p>
<p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
`.trim(),
  source: 'discord',
  tags: ['discord-bot', 'test'],
  requester_name: 'Discord Bot Test',
  requester_email: `discord-test000000@${process.env.PYLON_REQUESTER_DOMAIN || 'discord.coderabbit.ai'}`,
};

async function main() {
  console.log('\n🎫 Pylon Ticket Creation Test');
  console.log(`   Endpoint: POST ${BASE_URL}/issues`);
  console.log('─'.repeat(60));

  if (DRY_RUN) {
    console.log('\n📝 DRY RUN — would send:\n');
    console.log(JSON.stringify(testTicket, null, 2));
    console.log('\nRun without --dry-run to actually create the ticket.');
    return;
  }

  console.log('\n📡 Creating test ticket...\n');

  try {
    const res = await fetch(`${BASE_URL}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(testTicket),
    });

    const data = await res.json();

    if (res.status >= 200 && res.status < 300) {
      console.log('✅ Ticket created successfully!\n');
      console.log(`   ID:     ${data.data?.id}`);
      console.log(`   Number: #${data.data?.number}`);
      console.log(`   Link:   ${data.data?.link}`);
      console.log(`   State:  ${data.data?.state}`);
      console.log(`   Source: ${data.data?.source}`);
      console.log(`   Tags:   ${JSON.stringify(data.data?.tags)}`);
      console.log('\n📋 Full response:');
      console.log(JSON.stringify(data, null, 2));
      console.log('\n⚠️  Remember to delete this test ticket in Pylon!');
    } else {
      console.log(`❌ HTTP ${res.status}\n`);
      console.log(JSON.stringify(data, null, 2));

      if (data.errors) {
        console.log('\n💡 Hints:');
        for (const err of data.errors) {
          if (err.includes('body_html')) console.log('   → body_html field is required (must be HTML string)');
          if (err.includes('required')) console.log(`   → Missing required field: ${err}`);
          if (err.includes('permission') || err.includes('authorized')) console.log('   → API key may not have write permissions');
        }
      }
    }
  } catch (err) {
    console.error('❌ Request failed:', err.message);
  }
}

main();
