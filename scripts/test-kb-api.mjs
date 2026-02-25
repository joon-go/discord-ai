#!/usr/bin/env node
/**
 * Test Pylon Knowledge Base API
 */

import 'dotenv/config';

const API_KEY = process.env.PYLON_API_KEY;
const BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');

async function pylonGet(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
    },
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  console.log('\n🔬 Testing Pylon Knowledge Base API\n');

  // Step 1: List knowledge bases
  console.log('── GET /knowledge-bases ──');
  const { status: kbStatus, data: kbData } = await pylonGet('/knowledge-bases');
  console.log(`  Status: ${kbStatus}`);

  if (kbStatus !== 200 || !kbData?.data?.length) {
    console.log('  ❌ No knowledge bases found or API error');
    console.log('  Response:', JSON.stringify(kbData, null, 2).slice(0, 500));
    return;
  }

  const kbs = kbData.data;
  console.log(`  ✅ Found ${kbs.length} knowledge base(s):\n`);

  for (const kb of kbs) {
    console.log(`  📚 "${kb.title}"`);
    console.log(`     ID: ${kb.id}`);
    console.log(`     Slug: ${kb.slug}`);
    console.log(`     Languages: ${kb.supported_languages?.join(', ') || kb.default_language}`);

    // Step 2: Get collections
    console.log(`\n  ── GET /knowledge-bases/${kb.id}/collections ──`);
    const { status: colStatus, data: colData } = await pylonGet(`/knowledge-bases/${kb.id}/collections`);
    const collections = colData?.data || [];
    console.log(`     ${collections.length} collection(s):`);
    for (const col of collections) {
      console.log(`       • "${col.title}" (${col.id}) — visibility: ${col.visibility_config?.visibility || '?'}`);
    }

    // Step 3: Get articles (first page)
    console.log(`\n  ── GET /knowledge-bases/${kb.id}/articles?limit=5 ──`);
    const { status: artStatus, data: artData } = await pylonGet(`/knowledge-bases/${kb.id}/articles?limit=5`);
    const articles = artData?.data || [];
    const pagination = artData?.pagination;
    console.log(`     Status: ${artStatus}`);
    console.log(`     Articles returned: ${articles.length}`);
    console.log(`     Has more pages: ${pagination?.has_next_page || false}`);

    if (articles.length > 0) {
      console.log(`\n     First ${articles.length} article(s):\n`);
      for (const art of articles) {
        const contentLen = (art.current_published_content_html || '').length;
        const draftLen = (art.current_draft_content_html || '').length;
        console.log(`       📄 "${art.title}"`);
        console.log(`          ID: ${art.id}`);
        console.log(`          Published: ${art.is_published}`);
        console.log(`          URL: ${art.url || '(none)'}`);
        console.log(`          Published HTML: ${contentLen} chars`);
        console.log(`          Draft HTML: ${draftLen} chars`);
        console.log(`          Collection: ${art.collection_id || '(none)'}`);
        console.log('');
      }
    }
  }

  console.log('✅ KB API test complete');
}

main().catch(err => {
  console.error('❌ Error:', err.message);
});
