import 'dotenv/config';
import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import {
  handleMessage,
  handleTicketButton,
  handleTicketCommand,
  handleTicketSelect,
} from './services/messageHandler.mjs';
import { logger } from './utils/logger.mjs';
import { loadConfigSchema, setValidConfigKeys } from './services/schemaValidator.mjs';

// ─── Discord Client Setup ────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const SUPPORT_CHANNELS = new Set(
  (process.env.SUPPORT_CHANNEL_IDS || '').split(',').map(id => id.trim()).filter(Boolean)
);

// ─── Slash Commands ──────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Create a support ticket')
    .addStringOption(opt =>
      opt.setName('subject')
        .setDescription('Brief summary of your issue')
        .setRequired(true)
        .setMaxLength(100)
    ),
];

async function registerCommands() {
  const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    logger.info('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands.map(cmd => cmd.toJSON()) },
    );
    logger.info('Slash commands registered');
  } catch (err) {
    logger.error('Failed to register commands', { error: err.message });
  }
}

// ─── Events ──────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  logger.info(`✅ Bot online as ${c.user.tag}`);
  logger.info(`   Watching ${SUPPORT_CHANNELS.size} support channel(s)`);
  await registerCommands();

  // Load config schema for runtime YAML key validation (if configured)
  if (process.env.GITHUB_REPO_PATH && process.env.GITHUB_SCHEMA_DIR) {
    const keys = await loadConfigSchema(process.env.GITHUB_REPO_PATH);
    setValidConfigKeys(keys);
  }
});

// Handle chat messages (support channels and DMs)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const channel = message.channel;
  const isDM = !message.guild;
  const isThread = channel.isThread?.();
  const channelToCheck = isThread ? channel.parentId : channel.id;
  const inSupportChannel = SUPPORT_CHANNELS.has(channelToCheck);

  // ── DMs: could be ticket collection or general support ──
  // ── Support channels (and their threads): normal Q&A ──
  if (!inSupportChannel && !isDM) return;

  try {
    await handleMessage(message);
  } catch (err) {
    logger.error('Unhandled error in message handler', { error: err.message, stack: err.stack });
    await message.reply(
      '⚠️ Sorry, I ran into an unexpected error. A human from our support team will follow up!'
    ).catch(() => {});
  }
});

// Handle interactions: buttons, slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ── Button clicks (Create Ticket / No Thanks) ──
    if (interaction.isButton()) {
      if (interaction.customId === 'create_ticket' || interaction.customId === 'dismiss_ticket') {
        await handleTicketButton(interaction);
        return;
      }
    }

    // ── Select menu (Git Provider dropdown in DM) ──
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('ticket_select_')) {
        await handleTicketSelect(interaction);
        return;
      }
    }

    // ── Slash commands ──
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticket') {
        await handleTicketCommand(interaction);
        return;
      }
    }
  } catch (err) {
    logger.error('Unhandled interaction error', { error: err.message, stack: err.stack });

    const reply = {
      content: '⚠️ Something went wrong processing that action.',
      ephemeral: true,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// ─── Error Handling ──────────────────────────────────────────────────
client.on(Events.Error, (err) => logger.error('Discord client error', { error: err.message }));
process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', { error: err }));

// ─── Start ───────────────────────────────────────────────────────────
client.login(process.env.DISCORD_BOT_TOKEN);
