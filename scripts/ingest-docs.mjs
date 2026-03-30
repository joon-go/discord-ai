#!/usr/bin/env node
/**
 * Knowledge Base Ingestion Script
 * ================================
 * Crawls the documentation site and loads local files into ChromaDB.
 *
 * NOTE: Pylon KB articles are NOT ingested here — they are queried
 * live via the Pylon API at runtime so they're always up to date.
 *
 * Sources:
 *   1. Doc site crawl  (DOC_SITE_URL — product documentation)
 *   2. Local files     (./data/ directory — .md and .txt files)
 *   3. Local repo      (GITHUB_REPO_PATH — internal markdown docs)
 *
 * Usage:
 *   npm run ingest              # ingest all sources
 *   npm run ingest -- --docs    # doc site only
 *   npm run ingest -- --local   # local files only
 *   npm run ingest -- --github  # local repo clone only (requires GITHUB_REPO_PATH in .env)
 */

import 'dotenv/config';
import { ChromaClient } from 'chromadb';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';

const DOC_SITE_URL = process.env.DOC_SITE_URL || 'https://docs.coderabbit.ai';
const MAX_PAGES = parseInt(process.env.MAX_CRAWL_PAGES || '200', 10);
const COLLECTION_NAME = process.env.CHROMA_COLLECTION || 'support_kb';
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

// ─── Crawl Doc Site ──────────────────────────────────────────────────
async function crawlSite(baseUrl, maxPages) {
  const visited = new Set();
  const queue = [baseUrl];
  const pages = [];

  console.log(`\n🕷️  Crawling: ${baseUrl} (max ${maxPages} pages)...\n`);

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    const normalized = url.split('#')[0].split('?')[0];

    if (visited.has(normalized)) continue;
    visited.add(normalized);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'CodeRabbit-SupportBot-Ingester/1.0' },
        redirect: 'follow',
      });
      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;

      const html = await res.text();
      const $ = cheerio.load(html);

      const title = $('h1').first().text().trim() ||
                    $('title').text().trim() ||
                    url;

      const contentSelectors = [
        'article', 'main', '.article-content', '.content',
        '.markdown-body', '[role="main"]',
      ];

      let content = '';
      for (const sel of contentSelectors) {
        const el = $(sel).first();
        if (el.length) {
          content = el.text().replace(/\s+/g, ' ').trim();
          if (content.length > 50) break;
        }
      }

      if (content.length < 50) {
        $('nav, header, footer, script, style, .sidebar, .nav').remove();
        content = $('body').text().replace(/\s+/g, ' ').trim();
      }

      if (content.length > 50) {
        pages.push({ url: normalized, title, content, source: 'Docs' });
        process.stdout.write(`  ✓ ${pages.length}: ${title.slice(0, 60)}\n`);
      }

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        let fullUrl;
        try { fullUrl = new URL(href, url).toString(); } catch { return; }
        const baseHost = new URL(baseUrl).host;
        const linkHost = new URL(fullUrl).host;
        if (linkHost === baseHost && !visited.has(fullUrl.split('#')[0])) {
          queue.push(fullUrl);
        }
      });
    } catch (err) {
      console.warn(`  ✗ Failed: ${url.slice(0, 80)} — ${err.message}`);
    }
  }

  console.log(`\n  📄 Crawled ${pages.length} pages`);
  return pages;
}

// ─── Load Local Repo Files ───────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.github', 'vendor', '.git', '.claude']);
const MAX_FILE_SIZE = 100 * 1024; // 100KB

async function loadLocalRepoFiles(repoPath) {
  const pages = [];
  let totalFound = 0;
  let totalSkipped = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        totalFound++;
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > MAX_FILE_SIZE) {
            totalSkipped++;
            continue;
          }
          let raw = await fs.readFile(fullPath, 'utf-8');

          // Strip YAML frontmatter (--- at very start of file)
          raw = raw.replace(/^\s*---[\s\S]*?---\s*\n?/, '');

          // Strip code fences and their content
          raw = raw.replace(/```[\s\S]*?```/g, '');

          // Extract title from first # Heading
          const headingMatch = raw.match(/^#{1,6}\s+(.+)$/m);
          const title = headingMatch
            ? headingMatch[1].trim()
            : path.basename(fullPath, '.md');

          const content = raw.trim();
          if (content.length < 10) {
            totalSkipped++;
            continue;
          }

          // Store repo-relative path to avoid leaking host filesystem details
          const relativePath = path.relative(repoPath, fullPath).replace(/^\.\.[\\/]/, '');
          pages.push({
            url: `local://${relativePath}`,
            title,
            content,
            source: 'Internal',
          });
        } catch {
          totalSkipped++;
        }
      }
    }
  }

  await walk(repoPath);
  console.log(`  📄 Found ${totalFound} .md files — loaded ${pages.length}, skipped ${totalFound - pages.length}`);
  return pages;
}

// ─── Load Source Code Files ──────────────────────────────────────────
const SOURCE_CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.go', '.py', '.yaml', '.yml', '.json']);
const SOURCE_CODE_SKIP_DIRS = new Set([
  ...SKIP_DIRS,
  '__pycache__', '.next', 'out', 'coverage', 'tmp', 'testdata', 'fixtures', 'mocks', 'generated', 'proto',
]);
const SOURCE_CODE_MAX_FILE_SIZE = 50 * 1024; // 50KB

function isTestFile(name) {
  return (
    name.endsWith('.test.ts') || name.endsWith('.spec.ts') ||
    name.endsWith('.test.tsx') || name.endsWith('.test.js') ||
    name.endsWith('_test.go') || name.endsWith('.d.ts')
  );
}

async function loadSourceCodeFiles(repoPath, sourceDirs) {
  const pages = [];
  let totalFound = 0;
  let totalSkipped = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SOURCE_CODE_SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!SOURCE_CODE_EXTENSIONS.has(ext)) continue;
        if (isTestFile(entry.name)) continue;
        totalFound++;
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > SOURCE_CODE_MAX_FILE_SIZE) { totalSkipped++; continue; }

          const raw = await fs.readFile(fullPath, 'utf-8');
          const relativePath = path.relative(repoPath, fullPath).replace(/^\.\.[\\/]/, '');
          // Prepend file path so Claude has context about where the code lives
          const content = `// ${relativePath}\n${raw}`.trim();
          if (content.length < 10) { totalSkipped++; continue; }

          pages.push({
            url: `local://${relativePath}`,
            title: relativePath,
            content,
            source: 'SourceCode',
          });
        } catch {
          totalSkipped++;
        }
      }
    }
  }

  for (const dir of sourceDirs) {
    const absDir = path.isAbsolute(dir) ? dir : path.join(repoPath, dir);
    await walk(absDir);
  }

  console.log(`  💻 Source code: found ${totalFound} files — loaded ${pages.length}, skipped ${totalSkipped}`);
  return pages;
}

// ─── Load Local Files ────────────────────────────────────────────────
async function loadLocalDocs(dirPath) {
  const pages = [];
  try {
    const files = await fs.readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith('.md') && !file.endsWith('.txt')) continue;
      const content = await fs.readFile(path.join(dirPath, file), 'utf-8');
      const title = content.split('\n')[0].replace(/^#+\s*/, '') || file;
      pages.push({ url: `local://${file}`, title, content, source: 'Local' });
      console.log(`  📁 Loaded: ${file}`);
    }
  } catch {
    // data/ dir may not exist
  }
  return pages;
}

// ─── Sanitize Text ───────────────────────────────────────────────────
// Removes characters that cause JSON serialization failures in ChromaDB:
//   - Null bytes
//   - Lone Unicode surrogates (U+D800–U+DFFF) — valid JS but invalid JSON
//   - C0/C1 control characters (except tab, newline, carriage return)
function sanitizeText(text) {
  return text
    .replace(/\0/g, '')
    // Remove only lone surrogates, preserve valid surrogate pairs
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

// ─── Chunk Text ──────────────────────────────────────────────────────
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    start += Math.max(size - overlap, 1);
    if (end === text.length) break;
  }
  return chunks;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const ingestDocs = args.length === 0 || args.includes('--docs');
  const ingestLocal = args.length === 0 || args.includes('--local');
  const ingestGitHub = args.includes('--github') || (args.length === 0 && !!process.env.GITHUB_REPO_PATH);

  console.log('🚀 Starting knowledge base ingestion');
  console.log('   (Pylon KB articles are fetched live at runtime — not ingested here)\n');

  const allPages = [];

  if (ingestDocs) {
    const docPages = await crawlSite(DOC_SITE_URL, MAX_PAGES);
    allPages.push(...docPages);
  }

  if (ingestLocal) {
    console.log('\n📂 Loading local files from ./data/...');
    const localPages = await loadLocalDocs('./data');
    allPages.push(...localPages);
  }

  if (ingestGitHub) {
    const repoPath = process.env.GITHUB_REPO_PATH;
    if (!repoPath) {
      console.log('\n⚠️  --github flag set but GITHUB_REPO_PATH not configured in .env — skipping');
      process.exit(0);
    } else {
      console.log(`\n📂 Loading markdown files from ${repoPath}...`);
      const repoPages = await loadLocalRepoFiles(repoPath);
      allPages.push(...repoPages);

      // Load source code from configured subdirectories (GITHUB_SOURCE_DIRS)
      const sourceDirsRaw = process.env.GITHUB_SOURCE_DIRS || '';
      const sourceDirs = sourceDirsRaw
        .split(',')
        .map(d => d.trim())
        .filter(Boolean);

      if (sourceDirs.length > 0) {
        console.log(`\n📂 Loading source code from ${sourceDirs.length} director${sourceDirs.length === 1 ? 'y' : 'ies'}...`);
        const codePages = await loadSourceCodeFiles(repoPath, sourceDirs);
        allPages.push(...codePages);
      }
    }
  }

  if (allPages.length === 0) {
    console.log('\n⚠️  No content found. Check DOC_SITE_URL or add .md files to ./data/');
    process.exit(1);
  }

  // Chunk
  const allChunks = [];
  for (const page of allPages) {
    const chunks = chunkText(page.content);
    for (const chunk of chunks) {
      allChunks.push({
        text: chunk,
        metadata: { source: page.source, url: page.url, title: page.title },
      });
    }
  }

  console.log(`\n🔪 Created ${allChunks.length} chunks from ${allPages.length} pages`);

  // Upsert into ChromaDB
  console.log('\n📦 Upserting to ChromaDB...');
  const client = new ChromaClient({
    path: process.env.CHROMA_URL || 'http://localhost:8000',
  });

  try { await client.deleteCollection({ name: COLLECTION_NAME }); } catch {}

  const collection = await client.createCollection({
    name: COLLECTION_NAME,
    metadata: { 'hnsw:space': 'cosine' },
  });

  const BATCH_SIZE = 100;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    await collection.add({
      ids: batch.map((_, j) => `doc-${i + j}`),
      documents: batch.map(c => sanitizeText(c.text)),
      metadatas: batch.map(c => c.metadata),
    });
    process.stdout.write(`  Upserted ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}\r`);
  }

  console.log(`\n\n✅ Ingestion complete! ${allChunks.length} chunks in "${COLLECTION_NAME}"`);
}

main().catch((err) => {
  console.error('❌ Ingestion failed:', err);
  process.exit(1);
});
