import { logger } from '../utils/logger.mjs';

const PYLON_BASE_URL = (process.env.PYLON_BASE_URL || 'https://api.usepylon.com').replace(/\/$/, '');
const PYLON_API_KEY = process.env.PYLON_API_KEY;

// ─── Helper: Pylon API Request ───────────────────────────────────────
async function pylonRequest(endpoint, method = 'GET', body = null) {
  if (!PYLON_API_KEY) {
    logger.warn('PYLON_API_KEY not set — Pylon integration disabled');
    return null;
  }

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${PYLON_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`${PYLON_BASE_URL}${endpoint}`, options);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Pylon API ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (err) {
    logger.error('Pylon API error', { endpoint, error: err.message });
    throw err;
  }
}

// ─── Search Issues ───────────────────────────────────────────────────
// GET /issues requires start_time & end_time in ISO 8601 format.
// Returns: { data: [{ id, number, title, body_html, state, link, source, type, tags, ... }] }
/**
 * Search recent Pylon issues to find relevant past conversations.
 *
 * @param {string} query - Search term (note: the API may not filter server-side,
 *                         so we do client-side filtering on title/body_html)
 * @param {object} [options]
 * @param {number} [options.daysBack=30] - How far back to search
 * @param {number} [options.limit=10] - Max results to return after filtering
 * @returns {Promise<Array<{ id, number, title, content, url, state, source, type }>>}
 */
export async function searchIssues(query, { daysBack = 30, limit = 10 } = {}) {
  try {
    const now = new Date();
    const startTime = new Date(now - daysBack * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      start_time: startTime.toISOString(),
      end_time: now.toISOString(),
    });

    const data = await pylonRequest(`/issues?${params}`);
    if (!data?.data) return [];

    // Client-side search filtering (case-insensitive)
    const queryLower = query.toLowerCase();
    const filtered = data.data
      .filter(issue => {
        const title = (issue.title || '').toLowerCase();
        const body = (issue.body_html || '').toLowerCase();
        return title.includes(queryLower) || body.includes(queryLower);
      })
      .slice(0, limit)
      .map(issue => ({
        id: issue.id,
        number: issue.number,
        title: issue.title || `Issue #${issue.number}`,
        content: stripHtml(issue.body_html || ''),
        url: issue.link || '',
        state: issue.state || '',
        source: issue.source || '',
        type: issue.type || '',
        tags: issue.tags || [],
        createdAt: issue.created_at,
      }));

    logger.info('Pylon issue search', {
      query: query.slice(0, 60),
      totalFetched: data.data.length,
      matched: filtered.length,
    });

    return filtered;
  } catch {
    return [];
  }
}

// ─── Get Recent Issues ───────────────────────────────────────────────
/**
 * Fetch recent issues (useful for context / trending topics).
 *
 * @param {number} [daysBack=7]
 * @returns {Promise<Array>}
 */
export async function getRecentIssues(daysBack = 7) {
  try {
    const now = new Date();
    const startTime = new Date(now - daysBack * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      start_time: startTime.toISOString(),
      end_time: now.toISOString(),
    });

    const data = await pylonRequest(`/issues?${params}`);
    return data?.data || [];
  } catch {
    return [];
  }
}

// ─── Create Issue ────────────────────────────────────────────────────
// POST /issues — requires body_html (HTML string), title is accepted.
// Returns: { data: { id, number, link, ... } }
/**
 * Create a Pylon issue (ticket) from a Discord conversation.
 *
 * @param {object} params
 * @param {string} params.title - Issue title
 * @param {string} params.bodyHtml - Issue body as HTML
 * @param {string} [params.discordUserId] - Discord user ID
 * @param {string} [params.discordUsername] - Discord username
 * @param {string} [params.channelId] - Source Discord channel
 * @param {string[]} [params.tags] - Tags to apply
 * @returns {Promise<{ issueId: string, number: number, url: string } | null>}
 */
export async function createIssue({ title, bodyHtml, requesterEmail, requesterName, discordUserId, discordUsername, channelId, supportCode, gitProvider, tags = [] }) {
  try {
    // Map git provider to Pylon's custom field slug values
    // Values may come as slugs (from dropdown) or free text
    const gitProviderMap = {
      'github': 'github',
      'gitlab': 'gitlab',
      'bitbucket': 'bitbucket',
      'azure devops': 'azure_devops',
      'azure_devops': 'azure_devops',
      'azure': 'azure_devops',
      'github enterprise': 'github_enterprise',
      'github_enterprise': 'github_enterprise',
      'gitlab self-managed': 'gitlab_self_managed',
      'gitlab_self_managed': 'gitlab_self_managed',
      'gitlab self managed': 'gitlab_self_managed',
    };
    const mappedGitProvider = gitProviderMap[(gitProvider || '').toLowerCase()] || null;

    const customFields = [];
    if (supportCode) {
      customFields.push({ slug: 'support_code', value: supportCode.toUpperCase() });
    }
    if (mappedGitProvider) {
      customFields.push({ slug: 'git_provider', value: mappedGitProvider });
    }

    const payload = {
      title,
      body_html: bodyHtml,
      source: 'discord',
      tags: ['discord-bot', ...tags],
      requester_email: requesterEmail,
      requester_name: requesterName || discordUsername || 'Discord User',
      destination_metadata: {
        destination: 'email',
        email: process.env.PYLON_FROM_EMAIL || 'support@coderabbit.ai',
      },
      ...(customFields.length > 0 && { custom_fields: customFields }),
    };

    logger.info('Creating Pylon issue with payload', {
      title,
      requesterEmail,
      supportCode,
      gitProvider: mappedGitProvider,
      fromEmail: process.env.PYLON_FROM_EMAIL || 'support@coderabbit.ai',
    });

    const data = await pylonRequest('/issues', 'POST', payload);

    if (data?.data?.id) {
      logger.info('Pylon issue created', {
        issueId: data.data.id,
        number: data.data.number,
        user: discordUsername,
        requesterEmail,
      });
      return {
        issueId: data.data.id,
        number: data.data.number,
        url: data.data.link || `https://app.usepylon.com/issues?issueNumber=${data.data.number}`,
      };
    }
    return null;
  } catch (err) {
    logger.error('Failed to create Pylon issue', { error: err.message });
    return null;
  }
}

// ─── Helper: Build HTML body for ticket ──────────────────────────────
/**
 * Converts the Discord conversation context into HTML for Pylon's body_html field.
 *
 * @param {object} params
 * @param {string} params.query - Original user question
 * @param {string} params.botResponse - Bot's response
 * @param {string} params.discordUsername - Username
 * @param {string} params.discordUserId - User ID
 * @param {string} params.channelName - Channel name
 * @returns {string} HTML string
 */
export function buildTicketHtml({ query, botResponse, discordUsername, discordUserId, channelName, supportCode, gitProvider, prUrl, extra }) {
  const sections = [];

  sections.push(`<h3>Original Question (Discord)</h3>\n<p>${escapeHtml(query)}</p>`);

  if (botResponse) {
    sections.push(`<h3>Bot Response</h3>\n<p>${escapeHtml(botResponse.slice(0, 1500))}</p>`);
  }

  if (extra) {
    sections.push(`<h3>Additional Details</h3>\n<p>${escapeHtml(extra)}</p>`);
  }

  // Support metadata
  const meta = [];
  if (supportCode) meta.push(`<p><strong>Support Code:</strong> ${escapeHtml(supportCode)}</p>`);
  if (gitProvider) meta.push(`<p><strong>Git Provider:</strong> ${escapeHtml(gitProvider)}</p>`);
  if (prUrl) meta.push(`<p><strong>PR/MR URL:</strong> <a href="${escapeHtml(prUrl)}">${escapeHtml(prUrl)}</a></p>`);
  meta.push(`<p><strong>Source:</strong> Discord (#${escapeHtml(channelName || 'unknown')})</p>`);
  meta.push(`<p><strong>User:</strong> ${escapeHtml(discordUsername)} (${escapeHtml(discordUserId)})</p>`);
  meta.push(`<p><strong>Created:</strong> ${new Date().toISOString()}</p>`);

  sections.push(`<hr>\n${meta.join('\n')}`);

  return sections.join('\n\n');
}

// ─── Get Accounts ────────────────────────────────────────────────────
// GET /accounts — returns { data: [{ id, name, domain, domains, type, tags, ... }] }
/**
 * Search accounts by name or domain.
 *
 * @param {string} query - Account name or domain to search
 * @returns {Promise<Array<{ id, name, domain, type }>>}
 */
export async function searchAccounts(query) {
  try {
    const data = await pylonRequest('/accounts');
    if (!data?.data) return [];

    const queryLower = query.toLowerCase();
    return data.data
      .filter(acc => {
        const name = (acc.name || '').toLowerCase();
        const domain = (acc.domain || '').toLowerCase();
        const domains = (acc.domains || []).map(d => d.toLowerCase());
        return name.includes(queryLower) ||
               domain.includes(queryLower) ||
               domains.some(d => d.includes(queryLower));
      })
      .slice(0, 5)
      .map(acc => ({
        id: acc.id,
        name: acc.name,
        domain: acc.domain,
        type: acc.type,
      }));
  } catch {
    return [];
  }
}

// ─── Get Contacts ────────────────────────────────────────────────────
// GET /contacts — returns { data: [{ id, name, email, emails, account, ... }] }
/**
 * Search contacts by name or email.
 *
 * @param {string} query - Contact name or email
 * @returns {Promise<Array<{ id, name, email, accountId }>>}
 */
export async function searchContacts(query) {
  try {
    const data = await pylonRequest('/contacts');
    if (!data?.data) return [];

    const queryLower = query.toLowerCase();
    return data.data
      .filter(contact => {
        const name = (contact.name || '').toLowerCase();
        const email = (contact.email || '').toLowerCase();
        return name.includes(queryLower) || email.includes(queryLower);
      })
      .slice(0, 5)
      .map(contact => ({
        id: contact.id,
        name: contact.name,
        email: contact.email,
        accountId: contact.account?.id || null,
      }));
  } catch {
    return [];
  }
}

// ─── Get Current User (Service Account) ──────────────────────────────
// GET /me — returns { data: { id, name } }
export async function getMe() {
  try {
    const data = await pylonRequest('/me');
    return data?.data || null;
  } catch {
    return null;
  }
}

// ─── Live KB Article Search ─────────────────────────────────────────
// Fetches published articles from Pylon KB API at query time.
// Uses in-memory cache to avoid hammering the API (refreshes every 5 min).

let kbCache = { articles: [], fetchedAt: 0 };
const KB_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Search Pylon KB articles for content relevant to a query.
 * Articles are fetched live from the API and cached briefly.
 *
 * @param {string} query - User's question
 * @param {number} [limit=5] - Max results
 * @returns {Promise<Array<{ title, content, url }>>}
 */
export async function searchKBArticles(query, limit = 5) {
  try {
    const articles = await getCachedKBArticles();
    if (articles.length === 0) return [];

    // Filter out common stopwords that cause false matches
    const stopwords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'will',
      'with', 'this', 'that', 'from', 'they', 'what', 'how', 'why', 'when',
      'where', 'which', 'does', 'don', 'isn', 'get', 'got', 'let', 'its',
      'coderabbit', 'code', 'rabbit', // too generic for matching
    ]);

    const queryWords = query.toLowerCase().split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));
    if (queryWords.length === 0) return [];

    const scored = articles.map(article => {
      const titleLower = article.title.toLowerCase();
      const contentLower = article.content.toLowerCase();
      let score = 0;
      let matchedWords = 0;

      for (const word of queryWords) {
        let wordScore = 0;
        // Title matches worth more
        if (titleLower.includes(word)) wordScore += 3;
        // Content matches (capped)
        const contentMatches = (contentLower.match(new RegExp(word, 'gi')) || []).length;
        wordScore += Math.min(contentMatches, 3);

        if (wordScore > 0) matchedWords++;
        score += wordScore;
      }

      // Require at least 2 matching words or 50% of query words
      const minMatches = Math.max(2, Math.ceil(queryWords.length * 0.5));
      if (matchedWords < minMatches) score = 0;

      return { ...article, score };
    });

    const results = scored
      .filter(a => a.score >= 5) // minimum score threshold
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    logger.info('Pylon KB search', {
      query: query.slice(0, 60),
      queryWords: queryWords.join(', '),
      totalArticles: articles.length,
      matched: results.length,
    });

    return results;
  } catch (err) {
    logger.error('Pylon KB search failed', { error: err.message });
    return [];
  }
}

/**
 * Fetch and cache all published KB articles.
 * Skips internal KBs (slug containing "sop" or "internal").
 */
async function getCachedKBArticles() {
  if (Date.now() - kbCache.fetchedAt < KB_CACHE_TTL_MS && kbCache.articles.length > 0) {
    return kbCache.articles;
  }

  const allowedKbId = process.env.PYLON_KB_ID || null;
  const internalSlugs = ['sop', 'internal'];

  // Get knowledge bases
  const kbResponse = await pylonRequest('/knowledge-bases');
  const knowledgeBases = (kbResponse?.data || []).filter(kb => {
    if (allowedKbId) return kb.id === allowedKbId;
    return !internalSlugs.some(s => (kb.slug || '').toLowerCase().includes(s));
  });

  const allArticles = [];

  for (const kb of knowledgeBases) {
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({ limit: '100' });
      if (cursor) params.set('cursor', cursor);

      const res = await pylonRequest(`/knowledge-bases/${kb.id}/articles?${params}`);
      const articles = res?.data || [];
      const pagination = res?.pagination;

      for (const article of articles) {
        if (!article.is_published) continue;

        const htmlContent = article.current_published_content_html || '';
        const textContent = stripHtml(htmlContent);
        if (textContent.length < 20) continue;

        allArticles.push({
          title: article.title || 'Untitled',
          content: textContent,
          url: article.url || '',
        });
      }

      cursor = pagination?.cursor;
      hasMore = pagination?.has_next_page && cursor;
    }
  }

  kbCache = { articles: allArticles, fetchedAt: Date.now() };
  logger.info('Pylon KB cache refreshed', { articleCount: allArticles.length });
  return allArticles;
}

// ─── Check if Pylon is configured ────────────────────────────────────
export function isPylonConfigured() {
  return !!PYLON_API_KEY;
}

// ─── Utility: Strip HTML tags ────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Utility: Escape HTML ────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
