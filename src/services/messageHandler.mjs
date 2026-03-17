import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { generateResponse } from './claude.mjs';
import { queryKnowledgeBase } from './rag.mjs';
import { searchIssues, createIssue, buildTicketHtml, isPylonConfigured, searchKBArticles } from './pylon.mjs';
import { getStatusContext } from './status.mjs';
import { shouldRespond } from './intentClassifier.mjs';
import { logger } from '../utils/logger.mjs';

// ─── In-Memory Stores ───────────────────────────────────────────────
const conversationHistory = new Map();  // userId -> [{ role, content }]
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_TURNS || '5', 10);

const cooldowns = new Map();
const COOLDOWN_MS = parseInt(process.env.USER_COOLDOWN_MS || '3000', 10);

const unansweredLog = [];

// Pending ticket button context: `${userId}-${messageId}` -> ticket context
const pendingTickets = new Map();

// ─── Ticket Collection Sessions ──────────────────────────────────────
// Active info-collection sessions in private threads.
// Key: threadId -> TicketSession
//
// Session shape:
// {
//   query: string,           — original question
//   response: string,        — bot's response
//   username: string,
//   userId: string,
//   channelId: string,       — original public channel
//   channelName: string,
//   threadId: string,        — the private thread ID
//   collected: {
//     supportCode: string|null,
//     email: string|null,
//     gitProvider: string|null,
//     prUrl: string|null,     — null = not asked yet; '' = skipped
//   },
//   currentField: string|null,
//   prUrlAsked: boolean,
//   createdAt: number,
// }

const ticketSessions = new Map();  // threadId -> session
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// ─── Field Definitions ──────────────────────────────────────────────
const REQUIRED_FIELDS = [
  {
    key: 'supportCode',
    prompt: '🔑 What is your **Support Code**?\nIt looks like `CR-XXXXXX` (e.g., `CR-588AAD`). You can find it in the CodeRabbit app under **Account Settings → Subscription & Billing**.',
    validate: (v) => /^CR-[A-Z0-9]{6}$/i.test(v.trim()),
    errorMsg: 'That doesn\'t look like a valid support code. It should be `CR-` followed by 6 characters (e.g., `CR-588AAD`). You can find it in CodeRabbit app → Account Settings → Subscription & Billing.',
  },
  {
    key: 'email',
    prompt: '📧 What is your **email address** so our team can follow up?',
    validate: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    errorMsg: 'That doesn\'t look like a valid email address. Please try again.',
  },
  {
    key: 'gitProvider',
    prompt: '🔧 What **Git provider** are you using?',
    validate: (v) => v.length >= 2,
    errorMsg: 'Please select a Git provider from the dropdown.',
    type: 'select',
    options: [
      { label: 'GitHub', value: 'github' },
      { label: 'GitLab', value: 'gitlab' },
      { label: 'Bitbucket', value: 'bitbucket' },
      { label: 'Azure DevOps', value: 'azure_devops' },
      { label: 'GitHub Enterprise', value: 'github_enterprise' },
      { label: 'GitLab Self-Managed', value: 'gitlab_self_managed' },
    ],
  },
  {
    key: 'prUrl',
    prompt: '🔗 Is there a **PR/MR URL** related to this issue?\nPaste the link, or type **skip** if not applicable.',
    validate: () => true,
    errorMsg: null,
    optional: true,
    skipWords: ['skip', 'n/a', 'na', 'none', 'no'],
  },
];

// ═════════════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════════════

export async function handleMessage(message) {
  const userId = message.author.id;
  const username = message.author.username;
  const displayName = message.member?.displayName || message.author.displayName || username;
  const text = message.content.trim();
  const hasImages = message.attachments.some(att => att.contentType?.startsWith('image/'));

  if (text.length < 2 && !hasImages) return;

  // ── Check if this message is in an active ticket collection DM ──
  const session = ticketSessions.get(userId);
  if (session && !message.guild) {
    await handleTicketCollection(message, session, text);
    return;
  }

  // ── Normal Q&A message handling ──
  if (text.length < 3 && !hasImages) return;

  // Cooldown
  const lastMsg = cooldowns.get(userId);
  if (lastMsg && Date.now() - lastMsg < COOLDOWN_MS) return;
  cooldowns.set(userId, Date.now());

  // ── Intent classification gate (skip for DMs and @mentions) ──
  const isDM = !message.guild;
  const isMentioned = message.mentions.has(message.client.user);

  // ── Skip human-to-human replies unless bot is @mentioned ──
  // If someone replies to another human's message (not the bot's), they're
  // having a human conversation — the bot should not jump in unless explicitly called.
  // The bot only auto-responds to: top-level messages, replies to its own messages,
  // @mentions, and DMs.
  if (!isDM && !isMentioned && message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedTo.author.id !== message.client.user.id) {
        logger.info('Skipping reply to another human', { userId, username, repliedToUser: repliedTo.author.username });
        return;
      }
    } catch {
      // If we can't fetch the referenced message, proceed normally
    }
  }

  if (!isDM && !isMentioned) {
    const relevant = await shouldRespond(text);
    if (!relevant) {
      logger.info('Skipping irrelevant message', { userId, username, query: text.slice(0, 80) });
      return;
    }
  }

  await message.channel.sendTyping();
  const queryText = text || (hasImages ? 'Please analyze this image and help me with any CodeRabbit-related issue shown.' : '');
  logger.info('Processing query', { userId, username, query: queryText.slice(0, 100), images: hasImages });

  // ── Check if user wants a ticket/agent ──
  const userWantsTicket = containsTicketIntent(queryText);

  // ── Parallel retrieval (always fetch — KB may have routing info for non-support inquiries) ──
  const [docResult, kbResult, pylonResult] = await Promise.all([
    queryKnowledgeBase(queryText),
    isPylonConfigured() ? searchKBArticles(queryText) : Promise.resolve([]),
    isPylonConfigured() ? searchIssues(queryText) : Promise.resolve([]),
  ]);

  const docContext = docResult.context;
  const docSources = docResult.sources;
  const docRefs = docResult.refs || [];
  const kbArticles = kbResult;
  const pylonResults = pylonResult;

  const kbContext = kbArticles
    .map(a => `[KB: ${a.title}]: ${a.content.slice(0, 800)}`)
    .join('\n\n');

  const pylonContext = pylonResults
    .map(r => `[Pylon: ${r.title}${r.state ? ` (${r.state})` : ''}]: ${r.content.slice(0, 500)}`)
    .join('\n\n');

  // Fetch live system status
  const statusContext = await getStatusContext();

  const combinedContext = [statusContext, kbContext, docContext, pylonContext].filter(Boolean).join('\n\n---\n\n');

  const hasContext = combinedContext.length > 20;
  if (!hasContext) {
    unansweredLog.push({ query: text, userId, timestamp: new Date().toISOString() });
  }

  // ── Build conversation history ──
  // For threads triggered by mention: fetch thread messages for full context (all participants)
  // For all other cases (channels/DMs/non-mention threads): use per-user history
  const isThread = message.channel.isThread?.();
  const isMentionTriggeredThread = isThread && isMentioned;
  let history;
  if (isMentionTriggeredThread) {
    history = await fetchThreadHistory(message);
  } else {
    history = conversationHistory.get(userId) || [];
  }

  // Extract image attachments
  const images = await extractImageAttachments(message);

  let responseText = await generateResponse(queryText, combinedContext, history, images, displayName);

  // ── Parse metadata tags from AI response ──
  // AI prefixes with [NO_REFS] and/or [TICKET] on the first line
  // Match only tags at the beginning (as whole tokens), in any order
  const metadataMatch = responseText.match(/^(\s*(?:\[NO_REFS\]|\[TICKET\])\s*)+/);
  const metadataPrefix = metadataMatch ? metadataMatch[0] : '';
  const suppressRefs = metadataPrefix.includes('[NO_REFS]');
  const aiWantsTicket = metadataPrefix.includes('[TICKET]');
  // Strip the matched metadata prefix from the response
  responseText = metadataPrefix ? responseText.slice(metadataPrefix.length).replace(/^\n/, '') : responseText;

  // ── Evaluate ticket/routing signals ──
  // NOTE: Ticket offers rely on explicit signals only. If KB retrieval returns
  // no context, the model is responsible for surfacing that via the [TICKET] tag
  // rather than the code inferring it from hasContext (which would falsely trigger
  // tickets for off-topic declines and [NO_REFS] responses).
  const responseRoutedElsewhere = containsNonSupportRouting(responseText);
  const shouldOfferTicket = isPylonConfigured() && !responseRoutedElsewhere && (
    userWantsTicket || aiWantsTicket || containsEscalationSignal(responseText)
  );

  // ── Append reference links if KB/docs were used ──
  const allRefs = [...docRefs];
  // Add KB article URLs
  for (const article of kbArticles) {
    if (article.url && article.url.startsWith('http')) {
      allRefs.push({ url: article.url, title: article.title });
    }
  }
  // Deduplicate by URL and by title (same article can appear with different URLs)
  const seenUrls = new Set();
  const seenTitles = new Set();
  const uniqueRefs = allRefs.filter(r => {
    const normalizedUrl = r.url.replace(/\/+$/, '').replace(/#.*$/, '');
    const normalizedTitle = r.title.toLowerCase().trim();
    if (seenUrls.has(normalizedUrl) || seenTitles.has(normalizedTitle)) return false;
    seenUrls.add(normalizedUrl);
    seenTitles.add(normalizedTitle);
    return true;
  }).slice(0, 3); // max 3 links

  if (uniqueRefs.length > 0 && !responseRoutedElsewhere && !suppressRefs) {
    const refLinks = uniqueRefs.map(r => `• [${r.title}](${r.url})`).join('\n');
    responseText += `\n\n📚 **References:**\n${refLinks}`;
  }

  // ── First-time user greeting ──
  const isFirstInteraction = !conversationHistory.has(userId);
  if (isFirstInteraction) {
    const greeting = `👋 Hi <@${userId}>! I'm **AI Bunny**, CodeRabbit's support assistant.\n`
      + `Here's how I can help:\n`
      + `• **Ask me anything** about CodeRabbit — setup, configuration, reviews, billing, CLI, and more\n`
      + `• **Create a support ticket** — just ask and I'll guide you through it\n`
      + `• **Tag me in threads** — mention \`@AI Bunny\` and I'll read the thread context and jump in\n\n`
      + `---\n\n`;
    responseText = greeting + responseText;
  }

  // ── Send reply ──
  const replyOptions = buildReply(responseText, shouldOfferTicket);
  const botReply = await message.reply(replyOptions);

  // ── Store pending ticket context ──
  if (shouldOfferTicket && botReply) {
    const ticketKey = `${userId}-${botReply.id}`;
    pendingTickets.set(ticketKey, {
      query: queryText,
      response: responseText,
      userId,
      username,
      channelId: message.channel.id,
      channelName: message.channel.name,
      timestamp: Date.now(),
    });
    // Silent cleanup after 24h (just memory, no UI change)
    setTimeout(() => pendingTickets.delete(ticketKey), 24 * 60 * 60 * 1000);
  }

  // ── Update history (skip for mention-triggered threads — thread context is fetched live) ──
  if (!isMentionTriggeredThread) {
    const updatedHistory = [
      ...history,
      { role: 'user', content: queryText },
      { role: 'assistant', content: responseText },
    ].slice(-MAX_HISTORY * 2);
    conversationHistory.set(userId, updatedHistory);
  }

  logger.info('Response sent', {
    userId,
    hasContext,
    offeredTicket: shouldOfferTicket,
    docSources: docSources.length,
    kbArticles: kbArticles.length,
    pylonResults: pylonResults.length,
  });
}

// ═════════════════════════════════════════════════════════════════════
//  BUTTON CLICK → CREATE PRIVATE THREAD → START COLLECTION
// ═════════════════════════════════════════════════════════════════════

export async function handleTicketButton(interaction) {
  const userId = interaction.user.id;
  const messageId = interaction.message.id;
  const ticketKey = `${userId}-${messageId}`;

  // ── "Create Ticket" ──
  if (interaction.customId === 'create_ticket') {
    const pending = pendingTickets.get(ticketKey);

    if (!pending) {
      await interaction.reply({
        content: '⏰ This ticket prompt has expired. Please ask your question again.',
        ephemeral: true,
      });
      return;
    }

    if (pending.userId !== userId) {
      await interaction.reply({
        content: 'Only the person who asked the question can create a ticket.',
        ephemeral: true,
      });
      return;
    }

    // Close any existing session for this user
    if (ticketSessions.has(userId)) {
      ticketSessions.delete(userId);
      try {
        const oldDm = await interaction.user.createDM();
        await oldDm.send('ℹ️ Your previous ticket session has been closed because you started a new one.');
      } catch {}
      logger.info('Replaced existing ticket session', { userId });
    }

    // ── Try to DM the user ──
    let dmChannel;
    try {
      dmChannel = await interaction.user.createDM();
    } catch (err) {
      logger.error('Cannot DM user', { userId, error: err.message });
      await interaction.reply({
        content: '❌ I can\'t send you a DM. Please make sure your DMs are open for this server (Server Settings → Privacy Settings → Direct Messages).',
        ephemeral: true,
      });
      return;
    }

    // ── Set up collection session ──
    const userMessagesOnly = (conversationHistory.get(userId) || [])
      .filter(m => m.role === 'user')
      .map(m => m.content).join('\n') + '\n' + pending.query;
    const extracted = extractInfoFromConversation(userMessagesOnly);

    const session = {
      query: pending.query,
      response: pending.response,
      username: pending.username,
      userId,
      channelId: pending.channelId,
      channelName: pending.channelName,
      dmChannelId: dmChannel.id,
      collected: {
        supportCode: extracted.supportCode || null,
        email: extracted.email || null,
        gitProvider: extracted.gitProvider || null,
        prUrl: extracted.prUrl ?? null,
      },
      currentField: null,
      prUrlAsked: !!extracted.prUrl,
      createdAt: Date.now(),
    };

    ticketSessions.set(userId, session);

    await disableButtons(interaction.message);
    pendingTickets.delete(ticketKey);

    // ── Reply in channel (ephemeral) ──
    await interaction.reply({
      content: '📬 I\'ve sent you a DM to collect your ticket details privately!',
      ephemeral: true,
    });

    // ── Send first prompt in DM ──
    await sendDMIntro(dmChannel, session);

    logger.info('Ticket collection started via DM', {
      userId,
      dmChannelId: dmChannel.id,
      preExtracted: Object.entries(session.collected)
        .filter(([, v]) => v != null)
        .map(([k]) => k),
    });
  }

  // ── "No Thanks" ──
  if (interaction.customId === 'dismiss_ticket') {
    pendingTickets.delete(ticketKey);
    await interaction.reply({
      content: '👍 No problem! Let me know if you need anything else.',
      ephemeral: true,
    });
    await disableButtons(interaction.message);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  HANDLE SELECT MENU INTERACTIONS (git provider dropdown in DM)
// ═════════════════════════════════════════════════════════════════════

export async function handleTicketSelect(interaction) {
  const userId = interaction.user.id;
  const session = ticketSessions.get(userId);

  if (!session) {
    await interaction.reply({ content: '⏰ This session has expired. Please start a new ticket.', ephemeral: true });
    return;
  }

  // Extract field key from customId: "ticket_select_gitProvider" → "gitProvider"
  const fieldKey = interaction.customId.replace('ticket_select_', '');
  const selectedValue = interaction.values[0];

  session.collected[fieldKey] = selectedValue;

  // Map slug back to display label
  const gitProviderLabels = {
    'github': 'GitHub', 'gitlab': 'GitLab', 'bitbucket': 'Bitbucket',
    'azure_devops': 'Azure DevOps', 'github_enterprise': 'GitHub Enterprise',
    'gitlab_self_managed': 'GitLab Self-Managed',
  };
  const displayLabel = gitProviderLabels[selectedValue] || selectedValue;

  // Disable the select menu
  try {
    const disabledRow = ActionRowBuilder.from(interaction.message.components[0]);
    disabledRow.components.forEach(c => c.setDisabled(true));
    await interaction.update({ content: `🔧 Git Provider: **${displayLabel}** ✅`, components: [disabledRow] });
  } catch {
    await interaction.deferUpdate();
  }

  // ── Next field or finalize ──
  const nextField = getNextMissingField(session);
  if (!nextField) {
    await finalizeTicket(interaction, session);
  } else {
    session.currentField = nextField.key;
    await sendFieldPrompt(interaction.channel, nextField);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  HANDLE MESSAGES IN DM (collection flow)
// ═════════════════════════════════════════════════════════════════════

async function handleTicketCollection(message, session, text) {
  const userId = message.author.id;
  const lower = text.toLowerCase();

  // ── Cancel ──
  if (lower === 'cancel') {
    ticketSessions.delete(userId);
    await message.reply('🚫 Ticket creation cancelled.');
    return;
  }

  // ── Which field are we collecting? ──
  const fieldDef = getNextMissingField(session);
  if (!fieldDef) {
    await finalizeTicket(message, session);
    return;
  }

  // ── Detect non-answer messages (casual/filler/questions) ──
  const fillerPatterns = [
    /^(hang on|hold on|one sec|one moment|wait|brb|sec|gimme a|let me)/i,
    /^(ok|okay|sure|got it|alright|right|hmm|umm|uh|ah|oh)/i,
    /^(thanks|thank you|ty|thx)/i,
    /^(hi|hey|hello|yo|sup)/i,
  ];
  const isFiller = fillerPatterns.some(p => p.test(lower));

  if (isFiller) {
    await message.reply(`No worries, take your time! When you're ready:\n\n${fieldDef.prompt}`);
    return;
  }

  // ── Detect product questions during collection ──
  const isQuestion = /\?$/.test(text.trim()) ||
    /^(how|what|why|where|when|can|does|is|do|will|should|could|would)\b/i.test(lower);

  if (isQuestion && fieldDef.key !== 'prUrl') {
    await message.reply(
      `Great question! I can help with that once we finish creating your ticket. 😊\n\nFor now, could you provide:\n${fieldDef.prompt}`
    );
    return;
  }

  // ── Handle optional PR/MR skip ──
  if (fieldDef.key === 'prUrl' && fieldDef.skipWords?.includes(lower)) {
    session.collected.prUrl = '';
    session.prUrlAsked = true;
  } else {
    // ── Validate ──
    const clean = text.trim();
    if (!fieldDef.validate(clean)) {
      // Friendly validation error with context
      const friendlyErrors = {
        supportCode: `Hmm, that doesn't look like a support code. It should be in the format \`CR-XXXXXX\` (e.g., \`CR-588AAD\`). You can find it in CodeRabbit app → **Account Settings → Subscription & Billing**.`,
        email: `That doesn't seem to be an email address. Could you provide your email so our team can follow up?`,
        gitProvider: `Please select your Git provider from the dropdown above.`,
        prUrl: `That doesn't look like a valid URL. Please paste the full PR/MR link, or type **skip** if not applicable.`,
      };
      await message.reply(friendlyErrors[fieldDef.key] || fieldDef.errorMsg);
      return;
    }
    session.collected[fieldDef.key] = clean;
    if (fieldDef.key === 'prUrl') session.prUrlAsked = true;
  }

  // ── Next field or finalize ──
  const nextField = getNextMissingField(session);
  if (!nextField) {
    await finalizeTicket(message, session);
  } else {
    session.currentField = nextField.key;
    await sendFieldPrompt(message.channel, nextField);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  FINALIZE: Create Pylon Ticket
// ═════════════════════════════════════════════════════════════════════

async function finalizeTicket(messageOrInteraction, session) {
  // Works with both Message objects and Interaction objects
  const channel = messageOrInteraction.channel;
  try { await channel.sendTyping(); } catch {}

  const { supportCode, email, gitProvider, prUrl } = session.collected;

  const ticketBodyHtml = buildTicketHtml({
    query: session.query,
    botResponse: session.response,
    discordUsername: session.username,
    discordUserId: session.userId,
    channelName: session.channelName,
    supportCode,
    gitProvider,
    prUrl: prUrl || '',
    extra: '',
  });

  const result = await createIssue({
    title: truncate(session.query, 100),
    bodyHtml: ticketBodyHtml,
    requesterEmail: email,
    requesterName: session.username,
    discordUserId: session.userId,
    discordUsername: session.username,
    channelId: session.channelId,
    supportCode,
    gitProvider,
  });

  ticketSessions.delete(session.userId);

  if (result) {
    const gitLabels = {
      'github': 'GitHub', 'gitlab': 'GitLab', 'bitbucket': 'Bitbucket',
      'azure_devops': 'Azure DevOps', 'github_enterprise': 'GitHub Enterprise',
      'gitlab_self_managed': 'GitLab Self-Managed',
    };

    const fields = [
      { name: 'Ticket', value: `#${result.number}`, inline: true },
      { name: 'Link', value: `[View in Pylon](${result.url})`, inline: true },
      { name: 'Support Code', value: supportCode, inline: true },
      { name: 'Email', value: email, inline: true },
      { name: 'Git Provider', value: gitLabels[gitProvider] || gitProvider, inline: true },
    ];
    if (prUrl) fields.push({ name: 'PR/MR', value: prUrl, inline: false });

    const embed = new EmbedBuilder()
      .setColor(0x00c853)
      .setTitle('✅ Support Ticket Created')
      .setDescription(`Your ticket has been created and our team will follow up at **${email}**.`)
      .addFields(fields)
      .setTimestamp();

    // Send confirmation in DM
    await channel.send({ embeds: [embed] });

    logger.info('Ticket created via DM', {
      userId: session.userId,
      ticketNumber: result.number,
      supportCode,
      gitProvider,
    });
  } else {
    await message.reply(
      '❌ Sorry, I wasn\'t able to create the ticket. Please reach out to our support team directly.'
    );
  }
}

// ═════════════════════════════════════════════════════════════════════
//  /ticket SLASH COMMAND → Also opens a private thread
// ═════════════════════════════════════════════════════════════════════

export async function handleTicketCommand(interaction) {
  if (!isPylonConfigured()) {
    await interaction.reply({
      content: 'Ticket creation is not configured yet. Please reach out to our support team directly.',
      ephemeral: true,
    });
    return;
  }

  const userId = interaction.user.id;
  const subject = interaction.options.getString('subject');

  // Close any existing session for this user
  if (ticketSessions.has(userId)) {
    ticketSessions.delete(userId);
    try {
      const oldDm = await interaction.user.createDM();
      await oldDm.send('ℹ️ Your previous ticket session has been closed because you started a new one.');
    } catch {}
  }

  // ── Try to DM the user ──
  let dmChannel;
  try {
    dmChannel = await interaction.user.createDM();
  } catch (err) {
    logger.error('Cannot DM user for /ticket', { userId, error: err.message });
    await interaction.reply({
      content: '❌ I can\'t send you a DM. Please make sure your DMs are open for this server (Server Settings → Privacy Settings → Direct Messages).',
      ephemeral: true,
    });
    return;
  }

  // ── Set up session ──
  const session = {
    query: subject,
    response: '',
    username: interaction.user.username,
    userId,
    channelId: interaction.channelId,
    channelName: interaction.channel?.name || interaction.channelId,
    dmChannelId: dmChannel.id,
    collected: {
      supportCode: null,
      email: null,
      gitProvider: null,
      prUrl: null,
    },
    currentField: null,
    prUrlAsked: false,
    createdAt: Date.now(),
  };

  ticketSessions.set(userId, session);

  // ── Reply in channel (ephemeral) ──
  await interaction.reply({
    content: '📬 I\'ve sent you a DM to collect your ticket details privately!',
    ephemeral: true,
  });

  // ── Send intro in DM ──
  await sendDMIntro(dmChannel, session);

  logger.info('Ticket collection started via /ticket DM', {
    userId,
    dmChannelId: dmChannel.id,
    subject,
  });
}

// ═════════════════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════════════════

/**
 * Build the intro message for the DM and send it.
 * If the first field is a dropdown, sends the select menu as a follow-up.
 */
async function sendDMIntro(dmChannel, session) {
  const parts = [];

  parts.push(`Hey! I'll collect a few details to create your support ticket from **#${session.channelName}**.\n`);

  // Show what we already know
  const known = [];
  if (session.collected.supportCode) known.push(`✅ Support Code: **${session.collected.supportCode}**`);
  if (session.collected.email) known.push(`✅ Email: **${session.collected.email}**`);
  if (session.collected.gitProvider) known.push(`✅ Git Provider: **${session.collected.gitProvider}**`);
  if (session.collected.prUrl) known.push(`✅ PR/MR URL: ${session.collected.prUrl}`);

  if (known.length > 0) {
    parts.push(`I picked up some info from our conversation:\n${known.join('\n')}\n`);
  }

  // First missing field
  const nextField = getNextMissingField(session);
  if (nextField) {
    session.currentField = nextField.key;
    if (nextField.type !== 'select') {
      parts.push(nextField.prompt);
    }
  }

  parts.push('\n_Type **cancel** at any time to abort._');

  await dmChannel.send(parts.join('\n'));

  // Send select menu as separate message if needed
  if (nextField?.type === 'select') {
    await sendFieldPrompt(dmChannel, nextField);
  }
}

/**
 * Send a field prompt — either plain text or a select menu dropdown.
 */
async function sendFieldPrompt(channel, fieldDef) {
  if (fieldDef.type === 'select') {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`ticket_select_${fieldDef.key}`)
      .setPlaceholder(fieldDef.prompt)
      .addOptions(fieldDef.options.map(opt => ({
        label: opt.label,
        value: opt.value,
      })));

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await channel.send({ content: fieldDef.prompt, components: [row] });
  } else {
    await channel.send(fieldDef.prompt);
  }
}

/**
 * Get the field definition for the next field that hasn't been collected yet.
 */
function getNextMissingField(session) {
  for (const field of REQUIRED_FIELDS) {
    if (field.key === 'prUrl') {
      if (!session.prUrlAsked) return field;
      continue;
    }
    if (session.collected[field.key] === null) return field;
  }
  return null;
}

/**
 * Scan conversation text for support info the user may have already provided.
 */
function extractInfoFromConversation(text) {
  const result = {
    supportCode: null,
    email: null,
    gitProvider: null,
    prUrl: null,
  };

  // Email
  const emailMatch = text.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
  if (emailMatch) result.email = emailMatch[1];

  // Git provider
  const gitProviders = [
    { pattern: /\bgithub\b/i, value: 'GitHub' },
    { pattern: /\bgitlab\b/i, value: 'GitLab' },
    { pattern: /\bbitbucket\b/i, value: 'Bitbucket' },
    { pattern: /\bazure\s*devops\b/i, value: 'Azure DevOps' },
  ];
  for (const { pattern, value } of gitProviders) {
    if (pattern.test(text)) { result.gitProvider = value; break; }
  }

  // PR/MR URL
  const prPatterns = [
    /https?:\/\/github\.com\/[^\s]+\/pull\/\d+[^\s]*/i,
    /https?:\/\/gitlab\.com\/[^\s]+\/-\/merge_requests\/\d+[^\s]*/i,
    /https?:\/\/bitbucket\.org\/[^\s]+\/pull-requests\/\d+[^\s]*/i,
    /https?:\/\/dev\.azure\.com\/[^\s]+\/pullrequest\/\d+[^\s]*/i,
  ];
  for (const pattern of prPatterns) {
    const match = text.match(pattern);
    if (match) { result.prUrl = match[0]; break; }
  }

  // Support code — matches CR-XXXXXX format (e.g., CR-588AAD)
  const codeMatch = text.match(/\b(CR-[A-Z0-9]{6})\b/i);
  if (codeMatch) result.supportCode = codeMatch[1].toUpperCase();

  return result;
}

function buildReply(responseText, includeTicketButton) {
  const content = responseText.length > 2000
    ? responseText.slice(0, 1997) + '...'
    : responseText;

  if (!includeTicketButton) {
    return { content };
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel('📋 Create Support Ticket')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('dismiss_ticket')
      .setLabel('No thanks')
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row] };
}

function containsEscalationSignal(text) {
  const signals = [
    'open a support ticket',
    'opening a support ticket',
    'recommend opening a ticket',
    'reach out to our support',
    'contact our support',
    'our team can look into',
    'i\'m not sure about this',
    'i don\'t have enough information',
    'beyond what i can help with',
    'i wasn\'t able to find',
    'i couldn\'t find',
  ];
  const lower = text.toLowerCase();
  return signals.some(signal => lower.includes(signal));
}

/**
 * Detect if Claude's response already routed the user to a non-support contact
 * (e.g., partnership email, hiring page, events email, security disclosure).
 * In these cases we should NOT also offer a support ticket button.
 */
function containsNonSupportRouting(text) {
  const lower = text.toLowerCase();
  const nonSupportContacts = [
    'hello@coderabbit.ai',
    'hiring@coderabbit.ai',
    'sales@coderabbit.ai',
    'events@coderabbit.ai',
    'security@coderabbit.ai',
    'vdp.coderabbit.ai',
    'coderabbit.ai/careers',
  ];
  return nonSupportContacts.some(contact => lower.includes(contact));
}

/**
 * Detect if the user is explicitly asking to create a ticket or talk to a human.
 */
function containsTicketIntent(text) {
  const lower = text.toLowerCase();

  // Direct ticket requests
  const ticketWords = ['ticket', 'support ticket'];
  const ticketVerbs = ['create', 'open', 'submit', 'make', 'file', 'raise', 'need', 'want', 'get'];
  for (const word of ticketWords) {
    for (const verb of ticketVerbs) {
      if (lower.includes(verb) && lower.includes(word)) return true;
    }
  }

  // Want to talk to a person/human/agent/support
  const talkVerbs = ['talk to', 'speak to', 'speak with', 'chat with', 'connect with', 'reach', 'contact'];
  const targets = ['human', 'person', 'agent', 'someone', 'support', 'team', 'representative', 'rep', 'staff', 'engineer'];
  for (const verb of talkVerbs) {
    for (const target of targets) {
      if (lower.includes(verb) && lower.includes(target)) return true;
    }
  }

  // Other direct phrases
  const directPhrases = [
    'live agent',
    'live support',
    'human support',
    'real person',
    'escalate',
    'need help from a person',
    'i need support',
    'can i get help',
    'need to talk to',
    'need to speak to',
    'want to talk to',
    'want to speak to',
  ];
  return directPhrases.some(phrase => lower.includes(phrase));
}

/**
 * Fetch recent messages from a Discord thread and build a conversation history
 * array suitable for Claude's messages API. Includes all participants' messages
 * so the bot has full thread context.
 */
const MAX_THREAD_MESSAGES = 20;

async function fetchThreadHistory(message) {
  try {
    const fetched = await message.channel.messages.fetch({
      limit: MAX_THREAD_MESSAGES,
      before: message.id, // exclude the current message (it's added separately)
    });

    // Messages come newest-first, reverse to chronological order
    const sorted = [...fetched.values()].reverse();

    const history = [];
    for (const msg of sorted) {
      const isBot = msg.author.id === message.client.user?.id;
      const role = isBot ? 'assistant' : 'user';
      const content = isBot
        ? msg.content
        : `[${msg.author.username}]: ${msg.content}`;

      // Claude requires alternating user/assistant roles — merge consecutive same-role messages
      if (history.length > 0 && history[history.length - 1].role === role) {
        history[history.length - 1].content += `\n${content}`;
      } else {
        history.push({ role, content });
      }
    }

    // Ensure history starts with a user message (Claude API requirement)
    while (history.length > 0 && history[0].role !== 'user') {
      history.shift();
    }

    return history;
  } catch (err) {
    logger.warn('Failed to fetch thread history', { error: err.message });
    return [];
  }
}

async function disableButtons(message) {
  try {
    const disabledRow = ActionRowBuilder.from(message.components[0]);
    disabledRow.components.forEach(btn => btn.setDisabled(true));
    await message.edit({ components: [disabledRow] });
  } catch (err) {
    logger.warn('Failed to disable buttons', { error: err.message });
  }
}

/**
 * Extract image attachments from a Discord message and convert to Claude content blocks.
 * Supports png, jpg, gif, webp. Max 5 images, max 5MB each.
 */
const SUPPORTED_IMAGE_TYPES = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_IMAGES = 5;

/**
 * Detect actual image MIME type from buffer magic bytes.
 * Returns a supported media type or null if unrecognized.
 */
function detectImageType(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

async function extractImageAttachments(message) {
  const images = [];

  const imageAttachments = [...message.attachments.values()]
    .filter(att => att.contentType && SUPPORTED_IMAGE_TYPES[att.contentType])
    .filter(att => att.size <= MAX_IMAGE_SIZE)
    .slice(0, MAX_IMAGES);

  for (const att of imageAttachments) {
    try {
      const response = await fetch(att.url);
      if (!response.ok) continue;

      const buffer = await response.arrayBuffer();
      const actualType = detectImageType(buffer);
      if (!actualType) {
        logger.warn('Unrecognized image format from magic bytes, skipping', { filename: att.name });
        continue;
      }
      const base64 = Buffer.from(buffer).toString('base64');

      images.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: actualType,
          data: base64,
        },
      });

      logger.info('Image attachment extracted', {
        filename: att.name,
        size: att.size,
        declaredType: att.contentType,
        detectedType: actualType,
      });
    } catch (err) {
      logger.warn('Failed to fetch image attachment', { filename: att.name, error: err.message });
    }
  }

  return images;
}

export function splitMessage(text, maxLen = 1950) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len - 3) + '...' : str;
}

export function getUnansweredQueries() {
  return [...unansweredLog];
}