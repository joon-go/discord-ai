import fs from 'fs/promises';
import path from 'path';

// ─── Module State ─────────────────────────────────────────────────────
// Loaded once at startup from GITHUB_SCHEMA_DIR JSON files.
let _validKeys = new Set();
export const setValidConfigKeys = (keys) => { _validKeys = keys; };
export const getValidConfigKeys = () => _validKeys;

// ─── Schema Parsing ──────────────────────────────────────────────────

/**
 * Recursively extract all dotted key paths from a JSON Schema object.
 * Handles `properties`, `allOf`, `anyOf`, `oneOf`.
 */
function extractKeyPaths(schema, prefix = '') {
  const paths = new Set();
  if (!schema || typeof schema !== 'object') return paths;

  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      paths.add(fullPath);
      for (const p of extractKeyPaths(value, fullPath)) paths.add(p);
    }
  }

  for (const combinator of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[combinator])) {
      for (const sub of schema[combinator]) {
        for (const p of extractKeyPaths(sub, prefix)) paths.add(p);
      }
    }
  }

  return paths;
}

/**
 * Load all JSON schema files from GITHUB_SCHEMA_DIR and build a flat Set
 * of valid dotted config key paths (e.g. "reviews.auto_review.enabled").
 * Called once at bot startup.
 */
export async function loadConfigSchema(repoPath) {
  const schemaDir = process.env.GITHUB_SCHEMA_DIR;
  if (!schemaDir || !repoPath) return new Set();

  const fullDir = path.join(repoPath, schemaDir);
  const validKeys = new Set();

  try {
    const files = await fs.readdir(fullDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(fullDir, file), 'utf-8');
        const schema = JSON.parse(raw);

        // Handle definition-based schemas ($ref + definitions) or plain schemas
        let rootSchema = schema;
        if (schema.definitions) {
          rootSchema = Object.values(schema.definitions)[0] ?? schema;
        }

        for (const key of extractKeyPaths(rootSchema)) validKeys.add(key);
      } catch {
        // Skip unparseable files silently
      }
    }
    console.log(`✅ Config schema loaded — ${validKeys.size} valid key paths`);
  } catch (err) {
    console.warn(`⚠️  Could not load config schema from ${fullDir}: ${err.message}`);
  }

  return validKeys;
}

// ─── YAML Key Extraction ─────────────────────────────────────────────

/**
 * Extract dotted key paths from all YAML code blocks in a response string.
 * Uses indentation depth to reconstruct the full key path for each entry.
 *
 * Example: given ```yaml\nreviews:\n  profile: chill\n```
 * returns ['reviews', 'reviews.profile']
 */
function extractYamlConfigKeys(text) {
  const keys = [];
  const blockRegex = /```ya?ml\n([\s\S]*?)```/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const lines = match[1].split('\n');
    const stack = []; // { indent: number, path: string }[]
    for (const line of lines) {
      const m = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/);
      if (!m) continue;
      const indent = m[1].length;
      const key = m[2];
      // Pop stack until we find a parent with strictly lesser indent
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parentPath = stack.length > 0 ? stack[stack.length - 1].path : '';
      const fullPath = parentPath ? `${parentPath}.${key}` : key;
      keys.push(fullPath);
      stack.push({ indent, path: fullPath });
    }
  }
  return keys;
}

// ─── Validate and Warn ───────────────────────────────────────────────

/**
 * Post-process Claude's response: if it contains YAML config blocks,
 * validate all suggested key paths against the known schema Set.
 * Appends an inline warning for any unrecognized keys.
 *
 * Returns the (possibly modified) response text.
 */
export function validateAndWarn(responseText, validKeys) {
  const suggested = extractYamlConfigKeys(responseText);
  if (suggested.length === 0) return responseText;

  const invalid = suggested.filter(k => !validKeys.has(k));
  if (invalid.length === 0) return responseText;

  const keyList = invalid.map(k => `\`${k}\``).join(', ');
  const noun = invalid.length === 1 ? 'option' : 'options';
  const verb = invalid.length === 1 ? 'this is a' : 'these are';
  return `${responseText}\n\n⚠️ **Config notice:** I suggested ${keyList} but couldn\'t verify ${verb} valid config ${noun}. Please check the [docs](https://docs.coderabbit.ai) or open a support ticket before applying.`;
}
