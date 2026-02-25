import { ChromaClient } from 'chromadb';
import { logger } from '../utils/logger.mjs';

const COLLECTION_NAME = process.env.CHROMA_COLLECTION || 'support_kb';
const RELEVANCE_THRESHOLD = parseFloat(process.env.RELEVANCE_THRESHOLD || '0.3');
const TOP_K = 5; // Number of chunks to retrieve

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
export async function queryKnowledgeBase(query) {
  try {
    const col = await getCollection();
    const count = await col.count();

    if (count === 0) {
      logger.warn('KB collection is empty — run `npm run ingest` first');
      return { context: '', sources: [], refs: [] };
    }

    const results = await col.query({
      queryTexts: [query],
      nResults: TOP_K,
    });

    // Filter by relevance threshold
    // ChromaDB returns distances (lower = more similar for cosine)
    const documents = [];
    const sources = new Set();
    const sourceUrls = new Set();

    if (results.documents?.[0]) {
      results.documents[0].forEach((doc, i) => {
        const distance = results.distances?.[0]?.[i] ?? 1;
        // For cosine distance: 0 = identical, 2 = opposite
        // Convert to similarity: 1 - (distance / 2)
        const similarity = 1 - distance / 2;

        if (similarity >= RELEVANCE_THRESHOLD) {
          documents.push(doc);
          const meta = results.metadatas?.[0]?.[i] || {};
          sources.add(meta.source || 'unknown');
          if (meta.url && meta.url.startsWith('http')) {
            sourceUrls.add(JSON.stringify({ url: meta.url, title: meta.title || meta.url }));
          }
        }
      });
    }

    logger.info('KB query completed', {
      query: query.slice(0, 80),
      totalResults: results.documents?.[0]?.length || 0,
      relevantResults: documents.length,
    });

    // Join chunks into a single context string
    const context = documents
      .map((doc, i) => `[Source ${i + 1}]: ${doc}`)
      .join('\n\n');

    // Deduplicate source URLs
    const refs = [...sourceUrls].map(s => JSON.parse(s));

    return { context, sources: [...sources], refs };
  } catch (err) {
    logger.error('KB query failed', { error: err.message });
    return { context: '', sources: [], refs: [] };
  }
}
