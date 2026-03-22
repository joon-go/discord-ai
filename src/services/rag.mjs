import { ChromaClient } from 'chromadb';
import { logger } from '../utils/logger.mjs';

const COLLECTION_NAME = process.env.CHROMA_COLLECTION || 'support_kb';
const RELEVANCE_THRESHOLD = parseFloat(process.env.RELEVANCE_THRESHOLD || '0.3');
const DOC_K = 5;  // Max doc chunks per query
const CODE_K = 3; // Max code chunks per query

let collection = null;

// ─── Initialize ChromaDB Connection ──────────────────────────────────
async function getCollection() {
  if (collection) return collection;

  try {
    const client = new ChromaClient({
      path: process.env.CHROMA_URL || 'http://localhost:8000',
    });

    // getOrCreate ensures the collection exists
    collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
      metadata: { 'hnsw:space': 'cosine' },
    });

    const count = await collection.count();
    logger.info(`ChromaDB collection "${COLLECTION_NAME}" loaded with ${count} documents`);
    return collection;
  } catch (err) {
    logger.error('Failed to connect to ChromaDB', { error: err.message });
    throw err;
  }
}

// ─── Query Knowledge Base ────────────────────────────────────────────
/**
 * Retrieve relevant KB chunks for a user query.
 *
 * @param {string} query - The user's question
 * @returns {Promise<{ context: string, sources: string[] }>}
 */
export async function queryKnowledgeBase(query, _retried = false) {
  try {
    const col = await getCollection();
    const count = await col.count();

    if (count === 0) {
      logger.warn('KB collection is empty — run `npm run ingest` first');
      return { context: '', sources: [], refs: [] };
    }

    // Two independent filtered queries so code chunks can never be crowded out
    // by a doc-heavy mixed top-K result set.
    const queryOpts = (where, k) => ({ queryTexts: [query], nResults: k, where });
    const safeQuery = async (where, k) => {
      try { return await col.query(queryOpts(where, k)); } catch { return null; }
    };

    const [docResults, codeResults] = await Promise.all([
      safeQuery({ source: { $ne: 'SourceCode' } }, DOC_K),
      safeQuery({ source: { $eq: 'SourceCode' } }, CODE_K),
    ]);

    // Filter by relevance threshold
    const sourceUrls = new Set();
    const parseChunks = (results, isCode) => {
      const chunks = [];
      results?.documents?.[0]?.forEach((doc, i) => {
        const distance = results.distances?.[0]?.[i] ?? 1;
        const similarity = 1 - distance / 2;
        if (similarity >= RELEVANCE_THRESHOLD) {
          const meta = results.metadatas?.[0]?.[i] || {};
          chunks.push({ doc, meta });
          if (!isCode && meta.url?.startsWith('http')) {
            sourceUrls.add(JSON.stringify({ url: meta.url, title: meta.title || meta.url }));
          }
        }
      });
      return chunks;
    };

    const docChunks = parseChunks(docResults, false);
    const codeChunks = parseChunks(codeResults, true);

    const relevant = [...docChunks.slice(0, DOC_K), ...codeChunks.slice(0, CODE_K)];
    const usedSource = `docs:${Math.min(docChunks.length, DOC_K)} code:${Math.min(codeChunks.length, CODE_K)}`;
    const sources = new Set(relevant.map(c => c.meta.source || 'unknown'));

    logger.info('KB query completed', {
      query: query.slice(0, 80),
      docResults: docChunks.length,
      codeResults: codeChunks.length,
      usedSource,
    });

    // Join chunks into a single context string
    const context = relevant
      .map(({ doc }, i) => `[Source ${i + 1}]: ${doc}`)
      .join('\n\n');

    // Deduplicate source URLs
    const refs = [...sourceUrls].map(s => JSON.parse(s));

    return { context, sources: [...sources], refs };
  } catch (err) {
    // Collection may have been recreated by ingest — reset cache and retry once
    if (!_retried && err.message?.includes('could not be found')) {
      logger.warn('Collection reference stale, refreshing and retrying', { error: err.message });
      collection = null;
      return queryKnowledgeBase(query, true);
    }
    logger.error('KB query failed', { error: err.message });
    return { context: '', sources: [], refs: [] };
  }
}
