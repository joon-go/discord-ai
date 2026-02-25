import { logger } from '../utils/logger.mjs';

// ─── Instatus API for status.coderabbit.ai ──────────────────────────
const STATUS_BASE_URL = process.env.STATUS_PAGE_URL || 'https://status.coderabbit.ai';
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

let statusCache = { data: null, fetchedAt: 0 };

/**
 * Fetch current component statuses from the Instatus status page.
 * Cached for 2 minutes to avoid hammering the API.
 *
 * @returns {Promise<{ pageStatus: string, components: Array<{ name: string, status: string }> }>}
 */
export async function getStatus() {
  const now = Date.now();
  if (statusCache.data && (now - statusCache.fetchedAt) < CACHE_TTL_MS) {
    return statusCache.data;
  }

  try {
    const [summaryRes, componentsRes] = await Promise.all([
      fetch(`${STATUS_BASE_URL}/summary.json`),
      fetch(`${STATUS_BASE_URL}/v2/components.json`),
    ]);

    const summary = summaryRes.ok ? await summaryRes.json() : null;
    const componentsData = componentsRes.ok ? await componentsRes.json() : null;

    const result = {
      pageStatus: summary?.page?.status || 'UNKNOWN',
      components: (componentsData?.components || []).map(c => ({
        name: c.name,
        status: c.status,
      })),
    };

    statusCache = { data: result, fetchedAt: now };

    logger.info('Status page fetched', {
      pageStatus: result.pageStatus,
      components: result.components.length,
      degraded: result.components.filter(c => c.status !== 'OPERATIONAL').length,
    });

    return result;
  } catch (err) {
    logger.warn('Failed to fetch status page', { error: err.message });
    // Return cached data if available, otherwise unknown
    return statusCache.data || { pageStatus: 'UNKNOWN', components: [] };
  }
}

// Components we care about for customer-facing status
const RELEVANT_COMPONENTS = new Set([
  'App',
  'Reviews',
  'VS Code Extension (Private Beta)',
]);

/**
 * Build a human-readable status context string for Claude.
 * Only includes relevant product components.
 *
 * @returns {Promise<string>} Status context or empty string if all operational
 */
export async function getStatusContext() {
  const status = await getStatus();

  const relevant = status.components.filter(c => RELEVANT_COMPONENTS.has(c.name));
  const degraded = relevant.filter(c => c.status !== 'OPERATIONAL');

  if (degraded.length === 0) {
    return '[System Status]: All CodeRabbit product systems (App, Reviews, VS Code Extension) are currently operational.';
  }

  const lines = ['[System Status]: ⚠️ Some CodeRabbit systems have issues:'];
  for (const c of degraded) {
    lines.push(`  • ${c.name}: ${c.status}`);
  }
  const operational = relevant.filter(c => c.status === 'OPERATIONAL');
  if (operational.length > 0) {
    lines.push(`  ✅ Operational: ${operational.map(c => c.name).join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Check if any component is currently degraded.
 * Useful for quickly deciding whether to mention status in responses.
 *
 * @returns {Promise<boolean>}
 */
export async function hasActiveIncident() {
  const status = await getStatus();
  const relevant = status.components.filter(c => RELEVANT_COMPONENTS.has(c.name));
  return relevant.some(c => c.status !== 'OPERATIONAL');
}
