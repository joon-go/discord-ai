#!/usr/bin/env node
import 'dotenv/config';

const API_KEY = process.env.PYLON_API_KEY;
const BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');

async function main() {
  console.log('\n🔬 Fetching Pylon custom fields for issues\n');

  const res = await fetch(`${BASE_URL}/custom-fields?object_type=issue`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    console.log(`  ❌ ${res.status}: ${await res.text()}`);
    return;
  }

  const json = await res.json();
  const fields = json?.data || [];

  if (fields.length === 0) {
    console.log('  No custom fields found for issues');
    return;
  }

  console.log(`  ✅ Found ${fields.length} custom field(s):\n`);
  for (const f of fields) {
    console.log(`  📋 "${f.label}"`);
    console.log(`     Slug: ${f.slug}`);
    console.log(`     Type: ${f.type}`);
    console.log(`     ID:   ${f.id}`);
    if (f.select_metadata?.options) {
      console.log(`     Options: ${f.select_metadata.options.map(o => o.label).join(', ')}`);
    }
    console.log('');
  }
}

main().catch(console.error);
