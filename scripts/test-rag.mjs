#!/usr/bin/env node
/**
 * Test RAG + Pylon Pipeline
 * =========================
 * Query the vector KB, Pylon API, and Claude without needing Discord.
 *
 * Usage:
 *   npm test
 *   npm test -- "How do I configure CodeRabbit?"
 */

import 'dotenv/config';
import { queryKnowledgeBase } from '../src/services/rag.mjs';
import { searchIssues, isPylonConfigured } from '../src/services/pylon.mjs';
import { generateResponse } from '../src/services/claude.mjs';

const query = process.argv[2] || 'How do I set up CodeRabbit for my GitHub repo?';

console.log(`\n🔍 Query: "${query}"\n`);
console.log('─'.repeat(60));

// Step 1: Doc site RAG
console.log('\n📚 Retrieving from doc site vector KB...');
const { context: docContext, sources } = await queryKnowledgeBase(query);

if (docContext) {
  console.log(`   Found ${sources.length} source(s):`);
  sources.forEach(s => console.log(`   - ${s}`));
} else {
  console.log('   ⚠️  No doc site context found');
}

// Step 2: Pylon search
console.log('\n🔧 Searching Pylon issues...');
if (isPylonConfigured()) {
  const pylonResults = await searchIssues(query);
  console.log(`   Found ${pylonResults.length} Pylon result(s)`);
  pylonResults.forEach(r => console.log(`   - ${r.title}`));
} else {
  console.log('   ⚠️  PYLON_API_KEY not set — skipping');
}

console.log('\n' + '─'.repeat(60));

// Step 3: Claude
console.log('\n🤖 Generating Claude response...\n');
const response = await generateResponse(query, docContext, []);
console.log(response);

console.log('\n' + '─'.repeat(60));
console.log('✅ Test complete\n');
