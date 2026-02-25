# Discord AI Support Bot

AI-powered Discord support bot using **Claude** (Anthropic), **ChromaDB** (RAG), and **Pylon API** to answer user questions grounded in your documentation and support data.

## Architecture

```
User Question (Discord)
        │
        ▼
  ┌─────────────┐
  │ Message      │  ← rate limit, cooldown, typing indicator
  │ Handler      │
  └──────┬───────┘
         │
    ┌────┴────┐        parallel retrieval
    ▼         ▼
┌────────┐ ┌────────┐
│ChromaDB│ │ Pylon  │
│  RAG   │ │  API   │
│(docs)  │ │(issues)│
└───┬────┘ └───┬────┘
    │          │
    └────┬─────┘
         ▼
  ┌─────────────┐
  │ Claude API  │  ← system prompt + combined context + history
  └──────┬──────┘
         │
         ▼
  Discord Reply + Pylon logging
```

Both knowledge sources are queried in parallel, combined into context, and fed to Claude for a grounded response.

## Quick Start

### 1. Prerequisites

- **Node.js 18+**
- **ChromaDB** running locally (or hosted)
- Discord bot token ([Developer Portal](https://discord.com/developers/applications))
- Anthropic API key
- Pylon API key (optional — bot works without it using doc site only)

### 2. Install ChromaDB

```bash
# Docker (recommended)
docker run -p 8000:8000 chromadb/chroma

# Or pip
pip install chromadb
chroma run --path ./chroma-data
```

### 3. Create Discord Bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot
2. Copy token
3. Enable **Privileged Gateway Intents**: `MESSAGE CONTENT INTENT`, `SERVER MEMBERS INTENT`
4. Invite with permissions: Send Messages, Read Messages, Read Message History

### 4. Configure & Run

```bash
cp .env.example .env     # fill in tokens and channel IDs
npm install
npm run ingest           # crawl doc site → ChromaDB
npm run dev              # start bot (auto-restart on changes)
```

### 5. Test without Discord

```bash
npm test                                    # default test query
npm test -- "How do I configure CodeRabbit?" # custom query
```

## Project Structure

```
discord-support-bot/
├── src/
│   ├── index.mjs              # Discord bot entry point
│   ├── services/
│   │   ├── claude.mjs          # Claude API + system prompt
│   │   ├── messageHandler.mjs  # Orchestrator: RAG + Pylon → Claude → reply
│   │   ├── pylon.mjs           # Pylon REST API (issues, accounts, logging)
│   │   └── rag.mjs             # ChromaDB vector retrieval
│   └── utils/
│       └── logger.mjs          # Winston logger
├── scripts/
│   ├── ingest-docs.mjs         # Crawl docs → chunk → embed → ChromaDB
│   └── test-rag.mjs            # Test full pipeline without Discord
├── data/                       # Drop .md/.txt files here for local ingestion
├── .env.example
└── package.json
```

## Key Customization Points

### System Prompt (`src/services/claude.mjs`)
Your biggest quality lever. Edit `SYSTEM_PROMPT` to define persona, tone, escalation rules, and formatting.

### Pylon Endpoints (`src/services/pylon.mjs`)
The Pylon service has TODO markers where you'll need to adjust endpoints to match your Pylon API. Key functions:
- `searchIssues()` — find relevant past issues/conversations
- `getAccount()` — look up account by external ID
- `createIssue()` — escalate unresolved questions
- `logInteraction()` — audit trail

### Ingestion Selectors (`scripts/ingest-docs.mjs`)
Adjust CSS selectors for your doc site HTML structure:
```js
$('article, main, .content, .markdown-body, [role="main"]')
```

### Relevance Threshold (`.env`)
- `0.2` = loose (more results, some noise)
- `0.4` = strict (fewer, higher quality)
- Start at `0.3` and tune

## Adding Local KB Content

Drop `.md` or `.txt` files into `./data/` and run `npm run ingest`. Useful for internal FAQs, exported Pylon KB articles, or troubleshooting guides not on the public doc site.

## Pylon MCP (Future)

Pylon also offers an MCP server at `https://mcp.usepylon.com/` which works great with interactive clients like Claude Desktop, Cursor, and Claude Code. Currently it uses OAuth browser auth which isn't ideal for headless bots. When Pylon adds support for service account tokens, you can switch from the REST API to MCP for a cleaner integration. For now, you can use Pylon MCP in your own workflow:

```bash
# Claude Code
claude mcp add pylon --transport http https://mcp.usepylon.com/
```

## Production Considerations

- **Hosting**: Railway, Fly.io, or any VPS (~256MB RAM)
- **ChromaDB**: [Chroma Cloud](https://www.trychroma.com/) or self-host with persistent storage
- **Conversation history**: In-memory `Map()` — swap for Redis for multi-instance
- **Re-ingestion**: Cron `npm run ingest` when docs update
- **Monitoring**: Logger writes to `logs/bot.log`
- **Unanswered tracking**: `getUnansweredQueries()` for KB gap analysis

## Next Steps

1. **Thread support** — reply in threads to keep channels clean
2. **Slash commands** — `/ticket`, `/search`
3. **Feedback buttons** — 👍/👎 reactions
4. **Admin dashboard** — unanswered questions + usage metrics
5. **Pylon MCP migration** — when service account auth is available
