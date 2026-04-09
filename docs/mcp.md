# NossoCRM MCP Server

## Overview

NossoCRM exposes a **remote MCP (Model Context Protocol) server** that gives AI assistants and developer tools direct, authenticated access to your CRM data. Clients can search deals, manage contacts, send messages, review AI-suggested stage advances (HITL), and more — all via standardized MCP tool calls.

The server is built on [`mcp-handler`](https://github.com/vercel/mcp-handler) and runs as a Next.js route at `/api/[transport]`, supporting both the Streamable HTTP and SSE transports defined in MCP 2025-03-26.

---

## Endpoint

| Transport | URL | Use case |
|-----------|-----|----------|
| Streamable HTTP | `/api/mcp` | Claude Code, Cursor, Windsurf, most modern clients |
| SSE (legacy) | `/api/sse` | Clients that only support the older SSE transport |

Both transports share the same tool registry and authentication logic.

---

## Authentication

Every request must carry a valid NossoCRM API key. Two header formats are accepted:

```
Authorization: Bearer <API_KEY>
```
```
X-Api-Key: <API_KEY>
```

API keys are created in **NossoCRM → Settings → API Keys**. Each key is scoped to a single organization; all tool calls are automatically filtered to that organization's data.

Unauthenticated requests receive an MCP-level auth error and no tool output.

> **Security note:** API keys are validated via the `validate_api_key` Supabase RPC. The server resolves `organization_id` and `user_id` from the key and stores them in `AsyncLocalStorage` for the duration of the request. Keys are never echoed back in any tool response.

---

## Connecting Clients

### Claude Code

Add to `.mcp.json` in your project root (or `~/.claude/mcp.json` for global config):

```json
{
  "mcpServers": {
    "nossocrm": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

For production, replace the URL with your deployed domain.

### Cursor / Windsurf

Use the same JSON structure above in your MCP settings panel (the exact UI location varies by IDE version). Both support the Streamable HTTP transport.

### MCP Inspector

1. Open MCP Inspector.
2. Set **Transport Type** to `HTTP`.
3. Set **URL** to `https://<your-domain>/api/mcp`.
4. Set **Bearer Token** to your API key.
5. Connect, then run `tools/list` to verify.

### stdio-only clients

Use `mcp-remote` as a bridge:

```bash
npx -y mcp-remote http://localhost:3000/api/mcp --header "Authorization: Bearer YOUR_API_KEY"
```

---

## Tools Reference

All tools follow the naming convention `crm.<domain>.<action>`. The **Type** column indicates whether the tool reads data (safe) or writes/mutates data.

### Deals

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.deals.search` | Read | Searches deals by title (substring match). Supports `limit`. |
| `crm.deals.get` | Read | Returns full deal details including stage, contact, and activities. |
| `crm.deals.list_by_stage` | Read | Lists open deals in a specific stage by `stageId` or `stageName`. |
| `crm.deals.list_stagnant` | Read | Lists open deals not updated for N days. |
| `crm.deals.list_overdue` | Read | Lists deals with overdue incomplete activities. |
| `crm.deals.create` | Write | Creates a new deal in a board. May create/link a contact. |
| `crm.deals.update` | Write | Updates mutable deal fields (title, value, priority, etc.). |
| `crm.deals.move` | Write | Moves a deal to a destination stage. |
| `crm.deals.mark_won` | Write | Marks a deal as won (optionally updates value and stage). |
| `crm.deals.mark_lost` | Write | Marks a deal as lost; requires a loss reason. |
| `crm.deals.assign` | Write | Reassigns a deal to a new owner by `newOwnerId`. |
| `crm.deals.bulk_move` | Write | Moves multiple deals to a stage (max guardrail applies). |
| `crm.deals.link_contact` | Write | Links an existing deal to an existing contact. |

### Contacts

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.contacts.search` | Read | Searches contacts by name or email. |
| `crm.contacts.get` | Read | Returns contact details. |
| `crm.contacts.create` | Write | Creates a new contact. |
| `crm.contacts.update` | Write | Updates mutable contact fields. |

### Contacts — Advanced

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.contacts.find_duplicates` | Read | Finds contacts sharing the same email or phone; returns grouped results. |
| `crm.contacts.merge` | Write | Merges two contacts: moves deals and conversations from source to target, then deletes source. |
| `crm.contacts.export` | Read | Exports contacts as JSON (optional `source`/`dateRange` filters, max 1000 records). |
| `crm.contacts.import` | Write | Imports up to 500 contacts; skips records whose email already exists in the org. |

### Activities

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.activities.list` | Read | Lists activities with filters (board/deal/contact, completed, date range). |
| `crm.activities.create_task` | Write | Creates an activity (TASK/CALL/MEETING/EMAIL), optionally linked to a deal. |
| `crm.activities.complete` | Write | Marks an activity as completed. |
| `crm.activities.reschedule` | Write | Updates an activity's scheduled date/time. |
| `crm.activities.log` | Write | Logs a completed interaction (CALL/MEETING/EMAIL/TASK). |

### Notes

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.deal_notes.add` | Write | Adds a note to a deal. |
| `crm.deal_notes.list` | Read | Lists the latest notes for a deal. |

### Stages & Pipeline

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.stages.list` | Read | Lists stages (columns) for a board. |
| `crm.stages.update` | Write | Updates stage fields (name, label, color, order, default). |
| `crm.stages.reorder` | Write | Reorders stages for a board via an ordered list of stage IDs. |
| `crm.pipeline.analyze` | Read | Aggregates pipeline metrics and stage breakdown for a board. |
| `crm.boards.metrics.get` | Read | Computes KPIs for a board (win rate, open/won/lost counts, pipeline value). |

### Messaging

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.channels.list` | Read | Lists messaging channels (WhatsApp, Instagram, Email, etc.). Credentials are never returned. |
| `crm.conversations.list` | Read | Lists conversations with optional filters (`channelId`, `contactId`, `status`). Includes contact name. Default limit: 50. |
| `crm.conversations.get` | Read | Returns a single conversation with its most recent messages, contact, and channel info. |
| `crm.messages.send` | Write | Queues a text message (up to 4096 chars) for sending in an existing conversation. Inserted as `pending` and dispatched by the messaging worker. |
| `crm.messages.search` | Read | Full-text search over message content (Portuguese tokenizer). |
| `crm.messages.retry` | Write | Resets a `failed` message back to `pending` for retry by the messaging worker. |
| `crm.templates.list` | Read | Lists HSM (WhatsApp) message templates, optionally filtered by `channelId`. |
| `crm.templates.sync` | — | Always returns an error — template sync requires live Meta API credentials and must be done via the web UI. |

### AI & HITL

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.ai.hitl.list` | Read | Lists AI-suggested stage advances awaiting human review. Filters by `status` (default: `pending`). |
| `crm.ai.hitl.count` | Read | Returns the count of pending (or filtered) HITL stage advances. |
| `crm.ai.hitl.resolve` | Write | Approves or rejects an AI-suggested stage advance. On approval, moves the deal to the target stage. |
| `crm.ai.daily_briefing` | Read | Aggregates a daily ops briefing: overdue activities, recent open deals, and pending HITL count. |
| `crm.ai.meeting_briefing` | AI call | Generates a pre-meeting BANT briefing for a deal by analyzing its conversation history. |
| `crm.ai.patterns.list` | Read | Lists few-shot learned patterns stored for the organization. Returns empty array if none configured. |
| `crm.ai.metrics` | Read | Aggregates AI conversation logs for the last 30 days: action counts, total tokens, breakdown by model, and daily activity. |

### Admin & Settings

| Tool Name | Type | Description |
|-----------|------|-------------|
| `crm.admin.users.list` | Read | Lists all team members (profiles) for the organization: id, email, name, role, avatar_url, created_at. |
| `crm.settings.ai.get` | Read | Returns AI configuration. API keys are never returned — only boolean flags (`hasGoogleKey`, `hasOpenAIKey`, `hasAnthropicKey`). |
| `crm.settings.ai.update` | Write | Updates non-sensitive AI config fields (`ai_enabled`, `ai_provider`, `ai_model`, `ai_takeover_enabled`, `ai_config_mode`, `ai_template_id`, `ai_hitl_threshold`). API keys cannot be set via MCP. |
| `crm.settings.ai_templates.list` | Read | Lists AI qualification templates (system-wide and org-specific). |
| `crm.settings.ai_features.get` | Read | Returns current AI feature flags: `ai_enabled`, `ai_takeover_enabled`, `ai_config_mode`. |

---

## Examples

### Initialize session

```bash
curl -sS -X POST 'https://<your-domain>/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "clientInfo": { "name": "my-client", "version": "1.0.0" },
      "capabilities": {}
    }
  }'
```

### List available tools

```bash
curl -sS -X POST 'https://<your-domain>/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### Search deals

```bash
curl -sS -X POST 'https://<your-domain>/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "crm.deals.search",
      "arguments": { "query": "Acme", "limit": 10 }
    }
  }'
```

### Send a message

```bash
curl -sS -X POST 'https://<your-domain>/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "crm.messages.send",
      "arguments": {
        "conversationId": "uuid-of-conversation",
        "text": "Hello! Following up on our proposal."
      }
    }
  }'
```

### Resolve a HITL stage advance

```bash
curl -sS -X POST 'https://<your-domain>/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "crm.ai.hitl.resolve",
      "arguments": {
        "advanceId": "uuid-of-pending-advance",
        "action": "approved",
        "notes": "Confirmed budget in last call."
      }
    }
  }'
```

> **Note:** The `Accept: application/json, text/event-stream` header is required for Streamable HTTP transport. Without it, some intermediaries may reject the response.

---

## Architecture

- **Framework:** Next.js App Router route at `app/api/[transport]/route.ts`, handling both `/api/mcp` (Streamable HTTP) and `/api/sse` (SSE) via a single `[transport]` dynamic segment.
- **MCP library:** [`mcp-handler`](https://github.com/vercel/mcp-handler) — provides `createMcpHandler` and `withMcpAuth` wrappers optimized for Vercel serverless functions (`maxDuration: 120s`).
- **Tool registration:** Five registration functions are composed at server startup:
  - `registerExistingCrmTools` — deals, contacts (basic), activities, notes, stages, pipeline
  - `registerMessagingTools` — channels, conversations, messages, templates
  - `registerAITools` — HITL, briefings, patterns, metrics
  - `registerAdminTools` — users, AI settings
  - `registerContactsAdvancedTools` — dedup, merge, export, import
- **Database access:** All tools use `createStaticAdminClient()` — a Supabase service-role client that bypasses RLS. Organization scoping is enforced explicitly in every query via `.eq('organization_id', ctx.organizationId)`.
- **Request context:** `organizationId` and `userId` are resolved from the API key during auth and stored in `AsyncLocalStorage` (`mcpContextStorage`). Tools retrieve context via `getMcpContext()` without needing to pass it through function arguments.
- **Auth flow:** `withMcpAuth` calls `resolveApiKey(token)`, which delegates to `authPublicApi` (the same validator used by the REST public API), then fetches the `created_by` user from `api_keys` to populate `userId`.

---

## Security

- **API keys** are validated server-side on every request; the raw key value is never included in tool responses or logs.
- **Channel credentials** (WhatsApp tokens, email API keys, etc.) are explicitly excluded from all `crm.channels.list` queries — the `settings` column is returned but credential fields are not selected.
- **AI provider keys** (`ai_google_key`, `ai_openai_key`, `ai_anthropic_key`) are stripped from `crm.settings.ai.get` output; only boolean presence flags are returned.
- **Organization isolation:** Every query is scoped by `organization_id`. There is no cross-org data access path.
- **Write tools** verify resource ownership before mutating — e.g., `crm.messages.send` confirms the target conversation belongs to the caller's org before inserting.
- **Template sync** (`crm.templates.sync`) is intentionally blocked at the MCP layer — it always returns an error directing users to the web UI, because it requires live Meta API credentials that are not safe to expose through this interface.
- **HITL resolution** records `resolved_by` (the `userId` from the API key) and `resolved_at` for audit purposes.
