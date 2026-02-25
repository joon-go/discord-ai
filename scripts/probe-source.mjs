#!/usr/bin/env node
/**
 * Probe which `source` values Pylon accepts on POST /issues.
 */

import 'dotenv/config';

const API_KEY = process.env.PYLON_API_KEY;
const BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');

const sources = ['discord', 'chat', 'form', 'email', 'api', 'slack', 'web', 'portal', 'manual'];

async function trySource(source) {
  const res = await fetch(`${BASE_URL}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `[TEST] Source probe: ${source} — safe to delete`,
      body_html: `<p>Testing source="${source}"</p>`,
      requester_email: 'discord-bot-test@coderabbit.ai',
      requester_name: 'Bot Test',
      source,
      tags: ['test-probe'],
    }),
  });

  const data = await res.json();
  const actual = data?.data?.source || '(n/a)';
  const icon = res.status < 300 ? '✅' : '❌';
  console.log(`  ${icon} source: "${source}" → HTTP ${res.status}, actual source in response: "${actual}"${data?.data?.number ? ` (#${data.data.number})` : ''}`);

  return { status: res.status, actual, number: data?.data?.number };
}

async function main() {
  console.log('\n🔬 Pylon Source Field Probe\n');

  const created = [];
  for (const src of sources) {
    const result = await trySource(src);
    if (result.number) created.push(result.number);
  }

  if (created.length) {
    console.log(`\n⚠️  Created ${created.length} test tickets: #${created.join(', #')}`);
    console.log('   Delete them in Pylon when done!');
  }
}

main().catch(console.error);
