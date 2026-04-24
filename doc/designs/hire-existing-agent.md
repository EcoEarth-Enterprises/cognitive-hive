# Design: Hire Existing Agent

**Status:** Draft
**Author:** EcoEarth-Enterprises
**Scope:** Cognitive Hive fork (EcoEarth-Enterprises/cognitive-hive); may be upstreamed

## Summary

Add a first-class "hire existing agent" flow — UI page, API endpoint, and adapter-level discovery — for importing already-running external agents (e.g., OpenClaw agents running on a local gateway) into a paperclip company. Runs parallel to the current "create fresh" flow at `/agents/new`, targeted at operators who have external runtimes already operating and want paperclip to orchestrate them rather than spawn new ones.

The data path already works today (`POST /agent-hires` accepts pre-filled `adapterConfig`); this feature is primarily the UX surface plus a few convenience primitives (discovery, auto-approval, auto-key-issuance).

## Motivation

The canonical mental model in paperclip today is "create an agent" — the UI at `/agents/new` implies you are *inventing* the agent. That framing is a poor fit when the agent already exists as a process somewhere (an OpenClaw agent in `~/.openclaw/agents/`, a Hermes worker, a custom gateway-backed runtime, etc.). Operators currently have to:

1. Manually know the exact `adapterType` and hand-construct an `adapterConfig` blob
2. POST it to `/agent-hires` via curl/scripts (or use the generic form and hope they fill the right fields)
3. Separately call `POST /agents/{id}/keys` to issue a paperclip API key the external runtime can use to heartbeat back

The invite-flow path (`/invites/{token}/accept` → approve → claim) solves the API-key issue automatically but is documented only in smoke scripts — no UI, no discovery, no direct "I'm bringing in Clippy from OpenClaw" framing.

The result: bringing existing agents into paperclip is technically possible but ergonomically hostile. This feature closes that gap.

## Goals

- A distinct UI entry point `/agents/import` that frames the action as "register a connection to an existing agent"
- **Discovery**: paste an endpoint URL → system enumerates available agents on the external runtime → user picks from a list
- **Adapter-agnostic**: any adapter can opt into discovery by implementing an interface method; non-supporting adapters still appear in the dropdown but are disabled
- **Auto-issue paperclip API key** at hire time so the external runtime can immediately heartbeat back
- **Approval posture**: reuse the existing `companies.requireBoardApprovalForNewAgents` flag; when on, imports create an approval row in `status: approved` (auto-decided by the requesting board member) so the audit trail is preserved with zero friction. Non-board requesters fall into `pending` as a safety net.
- **Broken-bind repair**: when the connection to the external agent breaks, the agent detail page surfaces a banner offering to re-enumerate at a (possibly new) URL

## Non-goals

- **Live upstream sync.** Importing an agent is a one-time config capture. If the upstream runtime renames or deletes the agent later, paperclip shows it as broken (see §Broken-bind) but does not auto-repair.
- **Bi-directional mirroring.** Changes to the paperclip agent row are not pushed back to the external runtime.
- **Cross-runtime agent matching.** We do not try to detect "is this the same agent as one I already imported" — operators are responsible for not double-importing.
- **Contributing `agent.list` to upstream OpenClaw gateway protocol.** See §Open questions.
- **Renaming `/agents/new` to `/agents/create`** or other adjacent UI cleanup.

## User stories

### Operator stories

> As an operator with OpenClaw agents already running on my local gateway, I want to import a specific one (e.g., `clippy`) into my Cognitive Hive company, with one form submission.

> As an operator, when I'm on the "New Agent" page, I want a clear affordance that says "already have an agent running? Import it →" so I don't assume I have to spawn fresh.

> As an operator, when discovery of external agents fails (bad URL, gateway down), I want an actionable error — "we couldn't reach the gateway at X; check that it's running and X is the right URL" — not a generic network error.

> As an operator with strict company governance (`requireBoardApprovalForNewAgents` on), I want imports I perform as a board member to just work, while imports triggered by any non-board automation remain queued for my review. The audit log should still show every import.

### External agent stories

> As the external runtime after an operator imports me, I should immediately have a paperclip API key available (via the response) so I can start heartbeating back without another setup step.

### Ops / governance stories

> As someone reviewing the company's activity log later, I want to clearly distinguish "this agent was spawned fresh in paperclip" from "this agent was imported from an external runtime." The approval type `hire_existing_agent` makes that possible at a glance.

## Architecture overview

```
                        ┌─────────────────────────────────┐
                        │  UI: /agents/import             │
                        │  (new ImportAgent.tsx page)     │
                        └──┬──────────────────────────────┘
                           │
            1. GET /api/adapters                      2. POST /api/adapters/{type}/discover
               (existing)                                (NEW)
                           │                                    │
                           ▼                                    ▼
            ┌──────────────────────────┐        ┌──────────────────────────┐
            │  Adapter registry         │       │  Discovery dispatcher     │
            │  (server/src/adapters/)   │       │  (calls adapter's         │
            │  now returns capabilities │       │   discoverAgents())       │
            └──────────────────────────┘        └──────────┬───────────────┘
                                                            │
                                                            ▼
                                          ┌──────────────────────────────┐
                                          │  ServerAdapterModule          │
                                          │  (packages/adapter-utils)     │
                                          │  + new optional method:       │
                                          │    discoverAgents(config)     │
                                          └──────────────────────────────┘

                        ┌─────────────────────────────────┐
                        │  POST /api/companies/{id}/      │
                        │        agent-imports  (NEW)     │
                        └──┬──────────────────────────────┘
                           │
     ┌─────────────────────┼─────────────────────┬──────────────────────┐
     ▼                     ▼                     ▼                      ▼
  create agent       issue API key        write approval row        activity log
  (existing svc)    (existing helper)    type=hire_existing_agent   (existing svc)
                                          status=approved if board
```

## Design details

### Adapter interface extension

**File:** [packages/adapter-utils/src/types.ts](../../packages/adapter-utils/src/types.ts)

Add an optional method to `ServerAdapterModule`:

```ts
export interface DiscoveredAgent {
  /** Stable id the external runtime uses to address this agent */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional — role/title/description the UI can surface next to each option */
  description?: string;
  /** Optional — current status hint from the external runtime */
  status?: "idle" | "running" | "error" | "unknown";
  /** Optional — arbitrary metadata passed through to the UI */
  metadata?: Record<string, unknown>;
}

export interface DiscoverAgentsInput {
  /** The minimum config needed to connect — for openclaw_gateway this is `{ url, headers? }` */
  connectionConfig: Record<string, unknown>;
}

export interface DiscoverAgentsResult {
  agents: DiscoveredAgent[];
  /** Optional — hints for the UI when the list is empty or capped */
  warnings?: string[];
}

export interface ServerAdapterModule {
  // ... existing fields

  /**
   * Optional. If implemented, the adapter supports "hire existing" discovery:
   * given connection config (e.g., a gateway URL), enumerate agents that exist
   * on the external runtime.
   */
  discoverAgents?(input: DiscoverAgentsInput): Promise<DiscoverAgentsResult>;
}
```

**Adapter implementation contract:**
- `discoverAgents` is optional. Adapters that don't implement it are **not disabled outright** in the registry — the capability flag merely instructs the UI to disable them on `/agents/import` specifically. They remain available on `/agents/new`.
- Implementations must not have side effects on the external runtime (no pairing, no state mutation). It's a read.
- Errors are thrown as typed `DiscoveryError`s (new lightweight class in `adapter-utils`) with discriminants like `unreachable`, `unauthorized`, `not_supported` so the UI can render specific messages.

### Adapter registry surface

**File:** [server/src/routes/adapters.ts](../../server/src/routes/adapters.ts)

`GET /api/adapters` already returns adapter metadata. Extend the response items with a `capabilities` subset:

```jsonc
{
  "type": "openclaw_gateway",
  "label": "OpenClaw (gateway)",
  "source": "builtin",
  "modelsCount": 0,
  "loaded": true,
  "disabled": false,
  "capabilities": {
    "discoverAgents": true   // derived from whether the adapter module exports discoverAgents
  }
}
```

### New endpoints

#### `POST /api/adapters/{type}/discover`

Thin dispatcher to `adapter.discoverAgents(body.connectionConfig)`. Returns `DiscoverAgentsResult` or a typed error. Auth: company membership (not necessarily board).

**Why not inline this into the import endpoint?** Because discovery happens *before* the user picks which agent — the UI calls discover, renders the list, waits for the user, then calls import. Separating them keeps concerns clean and makes retry-on-failure trivial.

#### `POST /api/companies/{id}/agent-imports`

The import endpoint. Responsibilities:

1. **Validate** the request (adapter type loaded, has `discoverAgents` capability, user has company membership, name not taken).
2. **Create the agent row** via the existing `agents.create()` service function — same as `/agent-hires` under the hood.
3. **Issue an API key** via `agents.createApiKey(agentId, "import-auto")` — reusing the helper at [server/src/services/agents.ts:601](../../server/src/services/agents.ts#L601). Return the plaintext token in the response (only chance to see it).
4. **Approval row logic:**
   - If `company.requireBoardApprovalForNewAgents` is **false**: no approval row, agent goes straight to `idle`.
   - If `true` and requester **is board-tier**: insert approval row with `type: "hire_existing_agent"`, `status: "approved"`, `decidedByUserId: requesterId`, `decidedAt: now`. Agent goes to `idle`.
   - If `true` and requester **is not board-tier**: insert approval row with `type: "hire_existing_agent"`, `status: "pending"`. Agent stays `pending_approval` until a real board member approves.
5. **Activity log** entries:
   - `agent.imported` with adapter type, discovered-agent id, requester
   - `agent.api_key.issued` (already logged by the helper)
   - `approval.auto_approved` (new action) when the board-tier auto-approve branch fires — distinct from manual approval so reviewers can filter

Response body:

```jsonc
{
  "agent": { /* full agent record */ },
  "apiKey": {
    "id": "...",
    "token": "pcp_...",   // plaintext, one-time
    "createdAt": "..."
  },
  "approval": {           // present only if approval row was created
    "id": "...",
    "status": "approved" | "pending",
    "autoApproved": true | false
  }
}
```

### Data model changes

**None.** `approvals.type` is a TEXT column — adding the string `"hire_existing_agent"` is a code change only. Approval status enum already includes `approved` and `pending`. Activity log action strings are ad-hoc.

We are deliberately not adding a new `requireBoardApprovalForImports` flag (per design decision §5). One flag governs both paths; imports auto-approve when the requester has the authority already.

### UI

#### New page `ui/src/pages/ImportAgent.tsx`, route `/agents/import`

Wizard with three steps:

**Step 1 — Adapter selection**
- Dropdown of all registered adapters (fetched from `GET /api/adapters`)
- Options without `capabilities.discoverAgents` are rendered disabled with hover tooltip: "This adapter doesn't support discovery. Use [New Agent](/agents/new) instead."
- On select: reveal step 2

**Step 2 — Discovery**
- A config form rendered dynamically from the adapter's UI manifest, but **scoped to connection fields only** (e.g., for openclaw_gateway: `url` and `headers`). Full config comes later.
- "Discover agents" button → calls `POST /api/adapters/{type}/discover`
- Result list:
  - Loading state with cancel
  - Error state with typed messages (`unreachable` → "Could not reach gateway at $URL. Is it running?", `unauthorized` → "Gateway rejected auth. Check your token.", etc.)
  - Empty state: "No agents found at $URL. Is this the right endpoint?"
  - Success: radio-button list of `DiscoveredAgent` entries showing name, description, status badge

**Step 3 — Confirm & import**
- Pre-filled from the selection: `adapterType`, `adapterConfig.url`, `adapterConfig.agentId`
- User-supplied: `name` (defaults to discovered name), `role`, `title`, `reportsTo` (agent picker), `budgetMonthlyCents`, optional `capabilities[]`
- Submit → `POST /api/companies/{id}/agent-imports`
- Success: redirect to agent detail page, flash a modal showing the one-time API key with copy-to-clipboard + "I've saved this" checkbox

**Left nav:** new entry "Import Agent" next to "New Agent."

#### `/agents/new` affordance

Add a banner or secondary CTA on `NewAgent.tsx`: *"Have an agent already running? [Import it instead →](/agents/import)"*. Also add a matching banner on `/agents/import` pointing back to `/agents/new` for users who land in the wrong flow.

#### Broken-bind repair on agent detail page

**File:** `ui/src/pages/AgentDetail.tsx` (existing)

Heartbeat / execute failures already surface in the status column. Add logic:

- If the agent's adapter has `capabilities.discoverAgents` **and** the most recent heartbeat error is in the "unreachable" / "unauthorized" class **and** the agent was originally imported (determinable by checking whether a `hire_existing_agent` approval row exists for this agent), show a banner:
  - *"Can't reach the external runtime at `{adapterConfig.url}`. [Re-enumerate and repair →](/agents/import?repair={agentId})"*

`/agents/import?repair={agentId}` loads the existing agent record and pre-fills step 2 with the stored URL. The repair flow ends with a **PATCH** (not POST) to the existing agent row, updating `adapterConfig` to the new (url, agentId). No new agent row, no new API key, preserves history.

The repair-mode submit endpoint can be `PATCH /api/agents/{id}/adapter-config` — this may already exist or need adding; to be determined in implementation phase 6.

### Per-adapter API key storage (Phase 8)

Rather than always issuing a new paperclip API key on import, each adapter now
declares **where its paperclip key is stored**, via a new optional method on
`ServerAdapterModule`:

```ts
getApiKeyStorage?(input: { adapterConfig: Record<string, unknown> }): ApiKeyStorageDescriptor | null;

type ApiKeyStorageDescriptor =
  | { kind: "file"; path: string; scope: "shared" | "per-agent"; format?: "json_paperclipApiKey" }
  | { kind: "env"; variable: string }
  | { kind: "none" };
```

The server endpoint `POST /api/adapters/:type/api-key-storage` resolves the
descriptor and reports whether the target file exists. The import endpoint
accepts a `keyBehavior: "auto" | "reuse_existing" | "overwrite"` and branches:

| descriptor | behavior | file exists | server action |
|---|---|---|---|
| `file`, scope `shared` | `auto` | yes | reuse, no issuance |
| `file`, scope `shared` | `auto` | no | issue + atomically write |
| `file`, scope `shared` | `overwrite` | any | issue + atomically write |
| `file`, scope `shared` | `reuse_existing` | any | reuse, no issuance |
| `file`, scope `per-agent` | `auto` | any | issue + atomically write |
| `env` | any | n/a | issue and return token once for manual env-var setup |
| `none` | any | n/a | skip |

**Server-side file writes** are atomic (write to `.tmp`, rename into place)
with mode `0o600`. Parent dirs are created as needed. Write failures do
**not** fail the import — the outcome carries `writeStatus: "failed"`
and a `fallbackToken` so the UI can surface a manual copy-paste flow.

**OpenClaw adapter** declares `scope: "shared"` pointing at
`~/.openclaw/workspace/paperclip-claimed-api-key.json`, matching upstream
OpenClaw's current single-file convention. Future upgrade path: when
upstream OpenClaw supports per-agent key paths, flip `scope` to
`"per-agent"` and interpolate `adapterConfig.agentId` into the path.

### Security / privacy

- `adapterConfig` is JSONB-plaintext at rest in pg (not encrypted). The import form should strongly encourage `${SECRET_NAME}` references for any token fields, with inline help text explaining the difference. Raw token paste remains allowed (parity with existing `/agents/new`) but flagged with a warning icon + tooltip.
- The one-time API key returned from `/agent-imports` is shown once, then discarded server-side after the response. Log lines must not include it.
- `POST /api/adapters/{type}/discover` connects to arbitrary operator-supplied URLs — same as today's heartbeat execution. No SSRF mitigation planned beyond what adapter implementations already do (TLS verification, etc.).

### OpenClaw gateway: the `agent.list` gap

The OpenClaw gateway running locally doesn't currently expose an `agent.list` WS request. We have three paths:

1. **Upstream addition** (preferred long-term). Contribute `{ method: "agent.list" }` to the OpenClaw gateway protocol. Out of scope for this feature's initial ship; track as a separate issue.
2. **Local filesystem fallback** (fork-specific). If `connectionConfig.url` resolves to loopback and the paperclip process has access to `~/.openclaw/agents/`, the adapter can list directory entries. Only works for single-machine setups like the operator's current config. This is what we'll ship in the fork as phase 2.
3. **Dual path**. Try `agent.list` over WS first; on `method_not_supported`, fall back to loopback-only filesystem read.

**Phase-2 implementation:** go with option 3. If the gateway supports `agent.list` we use it; otherwise local-loopback filesystem read is the fallback. Document clearly that remote gateways require upstream support.

## Implementation plan

Phased so each phase lands a reviewable PR and can be smoke-tested in isolation.

### Phase 1 — Adapter interface + registry capability
- Extend `ServerAdapterModule` in `packages/adapter-utils/src/types.ts` with optional `discoverAgents()`
- Define `DiscoveredAgent`, `DiscoverAgentsInput`, `DiscoverAgentsResult`, `DiscoveryError` types
- Update adapter registry to derive and surface `capabilities.discoverAgents` in `GET /api/adapters`
- No adapter implements `discoverAgents` yet — registry just exposes the flag as `false` for all
- **Test:** unit test that registry serializes capability flags; existing `/agents/new` unchanged

### Phase 2 — OpenClaw gateway `discoverAgents` implementation
- In `packages/adapters/openclaw-gateway/src/server/index.ts`: implement `discoverAgents`
  - Try WS `agent.list` request; on `method_not_supported`, fall back to filesystem read (loopback only)
- **Test:** integration test against the user's running gateway at `ws://127.0.0.1:18789` — should return all 9 local agents

### Phase 3 — Discovery endpoint
- New route `POST /api/adapters/{type}/discover` in `server/src/routes/adapters.ts`
- Dispatches to adapter; maps `DiscoveryError` to HTTP errors (400/401/502 etc.)
- **Test:** endpoint tests + smoke test that mirrors the openclaw-join smoke shape

### Phase 4 — Import endpoint + auto-approval
- New route `POST /api/companies/{id}/agent-imports` in `server/src/routes/agents.ts`
- New service function `agents.import()` composing `create`, `createApiKey`, and approval insertion
- New approval type string `hire_existing_agent` used in service + displayed in UI approval detail page
- New activity log action `approval.auto_approved` (or leverage existing action with metadata)
- **Test:** three-path tests (flag off, flag on + board requester, flag on + non-board requester)

### Phase 5 — Import UI page
- New `ui/src/pages/ImportAgent.tsx` with three-step wizard
- Add route, add nav entry, add banner on `NewAgent.tsx`
- Post-import modal showing one-time API key
- **Test:** e2e Playwright test — full happy path from adapter select → discovery → submit → agent appears in `/agents`

### Phase 6 — Broken-bind repair
- Agent detail page banner when adapter is broken + import-type approval exists
- `/agents/import?repair=<agentId>` mode wires into the same wizard, ends with PATCH instead of POST
- `PATCH /api/agents/{id}/adapter-config` endpoint if not already present (check during implementation)
- **Test:** e2e test simulating gateway URL change

### Phase 7 — Docs + smoke
- Update [doc/OPENCLAW_ONBOARDING.md](../OPENCLAW_ONBOARDING.md) to reference the new UI-based flow as the recommended path; keep the invite-script flow documented as the "programmatic / external-initiated" alternative
- New smoke script `scripts/smoke/openclaw-import.sh` paralleling `openclaw-join.sh` but hitting `/agent-imports`
- Brief section in [README.md](../../README.md) mentioning the new flow

### Rollout

- Phases 1–4 are backend-only and merge-safe with no UI changes — can ship separately
- Phase 5 is the user-visible change; gate behind a feature flag (`features.agentImport` in instance settings) if we want a soft launch, otherwise ship directly
- Phases 6–7 can follow; broken-bind repair is not blocking for the feature

## Open questions & risks

1. **Upstream vs fork.** Everything in this doc is designed to be upstreamable to paperclipai/paperclip — the decisions don't hard-code EcoEarth specifics. When to propose upstream, and whether to submit phase-by-phase PRs or a single large one, is a judgment call for later.

2. **Activity log action strings.** I'm introducing `agent.imported` and `approval.auto_approved`. The existing codebase uses kebab-within-dot patterns ambiguously; confirm convention when implementing phase 4.

3. **Repair flow and history.** Does re-pointing an agent at a different gateway URL count as a new "hiring" event for audit purposes, or a simple config patch? The doc proposes patch-only, but if the new URL is a fundamentally different runtime, that might merit a new activity log entry. Flag during phase 6 review.

4. **`agent.list` upstream contribution.** Adding this to OpenClaw's gateway protocol is the right long-term fix; tracking it as a separate effort. Fork ships with the filesystem-fallback behavior and only works with local gateways until then.

5. **Non-board auto-approve surprise.** If a company has the approval flag on and a non-board user triggers an import, their agent will be stuck in `pending_approval` with no obvious signal in the UI unless the pending-approvals list is in their nav. Worth making sure the import-success page explicitly says "your import is pending board approval" rather than dumping them on the agent detail page in confusion.

6. **Name collisions.** If a discovered agent has the same name as an existing agent in the company, the UI should prompt for rename before submit rather than failing on the server.

7. **Multi-tenancy in discovery.** If a gateway hosts agents for multiple companies/orgs, filtering (e.g., via `headers` or a `namespace` arg) may be needed. Out of scope for v1; flag if the need arises.

## Appendix A — File/path summary

**New files:**
- `doc/designs/hire-existing-agent.md` (this doc)
- `ui/src/pages/ImportAgent.tsx`
- `scripts/smoke/openclaw-import.sh`

**Modified files (rough):**
- `packages/adapter-utils/src/types.ts` (+ `discoverAgents` etc.)
- `packages/adapters/openclaw-gateway/src/server/index.ts` (+ implementation)
- `server/src/adapters/registry.ts` (+ capability propagation)
- `server/src/routes/adapters.ts` (+ `/discover` route, + capability in listing)
- `server/src/routes/agents.ts` (+ `/agent-imports` route)
- `server/src/services/agents.ts` (+ `import` composition)
- `server/src/services/approvals.ts` (+ `hire_existing_agent` handling)
- `ui/src/pages/NewAgent.tsx` (+ banner)
- `ui/src/pages/AgentDetail.tsx` (+ broken-bind banner)
- `ui/src/router/*` (+ `/agents/import` route)
- `README.md` / `doc/OPENCLAW_ONBOARDING.md` (+ docs update)

## Appendix B — Wireframe sketches (ascii)

### `/agents/import` — step 2 (discovery)

```
┌────────────────────────────────────────────────────────────────┐
│ Import Agent                                      ① Adapter     │
│                                                   ● Discover    │
│                                                   ○ Confirm     │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│ OpenClaw (gateway)                                              │
│                                                                 │
│  Gateway URL                                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ ws://127.0.0.1:18789                                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Auth header (optional)                                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ x-openclaw-token: ${OPENCLAW_GATEWAY_TOKEN}              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  [ Discover agents ]                                            │
│                                                                 │
│  Found 9 agents at ws://127.0.0.1:18789:                        │
│   ○ brad         — idle                                         │
│   ● clippy       — idle                                         │
│   ○ clawdbot     — idle                                         │
│   ○ iclawrus     — idle                                         │
│   ○ main         — running                                      │
│   ○ oppencoder   — idle                                         │
│   ○ ukesui       — idle                                         │
│   ○ sisyphus     — idle                                         │
│   ○ claude       — idle                                         │
│                                                                 │
│                                                   [ Cancel ]  [ Continue → ] │
└────────────────────────────────────────────────────────────────┘
```

### Post-import API key modal

```
┌────────────────────────────────────────────────────────────────┐
│  ✓ Agent "clippy" imported                                      │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Paperclip API key (one-time display, save it now):             │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ pcp_ab12cd34ef56...                                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                               [ Copy to clipboard ] │
│                                                                 │
│  Paste this into your external runtime's paperclip config. For  │
│  OpenClaw, save it to:                                          │
│     ~/.openclaw/workspace/paperclip-claimed-api-key.json        │
│                                                                 │
│  [ ] I've saved this key                                        │
│                                                                 │
│                                                       [ Continue → ] │
└────────────────────────────────────────────────────────────────┘
```
