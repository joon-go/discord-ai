#!/usr/bin/env node
/**
 * Probe Pylon API for Knowledge Base endpoints.
 */

import 'dotenv/config';

const API_KEY = process.env.PYLON_API_KEY;
const BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');

const endpoints = [
  // Common KB endpoint patterns
  '/knowledge_base',
  '/knowledge-base',
  '/kb',
  '/articles',
  '/knowledge_base/articles',
  '/knowledge-base/articles',
  '/kb/articles',
  '/help_center',
  '/help-center',
  '/faqs',
  '/faq',
  '/docs',
  '/documents',
  '/knowledge',
  '/knowledge_base/categories',
  '/kb/categories',
  '/knowledge_base/collections',
  '/kb/collections',
  '/knowledge_base/search',
  '/kb/search',
  // Also try with /v1 prefix
  '/v1/knowledge_base',
  '/v1/articles',
  '/v1/kb',
];

async function probe(endpoint) {
  try {
    const res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
      },
    });

    const text = await res.text();
    let preview = text.slice(0, 200);

    const icon = res.status < 300 ? '✅' :
                 res.status === 404 ? '❌' :
                 res.status === 401 ? '🔒' : '⚠️';

    console.log(`  ${icon} ${res.status} ${endpoint}`);

    if (res.status < 300) {
      try {
        const json = JSON.parse(text);
        if (json.data && Array.isArray(json.data)) {
          console.log(`     → Array with ${json.data.length} items`);
          if (json.data[0]) {
            console.log(`     → First item keys: ${Object.keys(json.data[0]).join(', ')}`);
            if (json.data[0].title) console.log(`     → First title: "${json.data[0].title}"`);
          }
        } else if (json.data) {
          console.log(`     → Data keys: ${Object.keys(json.data).join(', ')}`);
        }
      } catch {}
    }
  } catch (err) {
    console.log(`  💥 ERR ${endpoint}: ${err.message}`);
  }
}

async function main() {
  console.log(`\n🔬 Probing Pylon KB endpoints at ${BASE_URL}\n`);

  for (const ep of endpoints) {
    await probe(ep);
  }

  // Also try search with query params
  console.log('\n🔍 Trying search variants...\n');
  const searchEndpoints = [
    '/knowledge_base/search?q=billing',
    '/kb/search?q=billing',
    '/articles?search=billing',
    '/knowledge_base?search=billing',
    '/search?q=billing&type=article',
  ];
  for (const ep of searchEndpoints) {
    await probe(ep);
  }
}

main().catch(console.error);
