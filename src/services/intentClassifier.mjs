import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTENT_MODEL = process.env.INTENT_MODEL || 'claude-haiku-4-20250414';

const CLASSIFICATION_PROMPT = `You are a message classifier for a CodeRabbit support Discord channel.

Determine if the user's message is requesting help, asking a question, or reporting an issue related to CodeRabbit (an AI code review tool) or its ecosystem (setup, configuration, billing, Git provider integrations, PR/MR reviews, CI/CD, CLI tools, etc.).

Reply ONLY with "yes" or "no".

Reply "yes" if the message is:
- A question or request about CodeRabbit features, setup, pricing, or troubleshooting
- A bug report or issue related to CodeRabbit or code review tooling
- A request to create a support ticket or talk to a human agent
- A greeting that seems directed at the bot for help (e.g., "hi, I need help with CodeRabbit")

Reply "no" if the message is:
- General chat, banter, or off-topic conversation between community members
- Questions about unrelated tools, general programming, or personal topics
- Simple greetings not directed at the bot (e.g., "hey everyone", "where is john?")
- Messages that are clearly part of a conversation between other users`;

/**
 * Classify whether a message warrants a bot response.
 * Uses a fast, cheap model to avoid unnecessary full RAG + Claude calls.
 *
 * @param {string} messageText - The user's message
 * @returns {Promise<boolean>} true if the bot should respond
 */
export async function shouldRespond(messageText) {
  try {
    const response = await anthropic.messages.create({
      model: INTENT_MODEL,
      max_tokens: 8,
      system: CLASSIFICATION_PROMPT,
      messages: [{ role: 'user', content: messageText }],
    });

    const answer = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
      .toLowerCase();

    const relevant = answer.startsWith('yes');

    logger.info('Intent classification', {
      query: messageText.slice(0, 80),
      classified: relevant ? 'relevant' : 'irrelevant',
      model: INTENT_MODEL,
      tokens: response.usage.input_tokens + response.usage.output_tokens,
    });

    return relevant;
  } catch (err) {
    logger.error('Intent classifier error, defaulting to respond', { error: err.message });
    // Fail open — if classifier breaks, respond to everything (previous behavior)
    return true;
  }
}
