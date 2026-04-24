import { test, expect, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * E2E: import an existing OpenClaw agent and run a successful heartbeat.
 *
 * Preconditions (not checked by the test but required):
 *   - An OpenClaw gateway is running locally at ws://127.0.0.1:18789
 *   - ~/.openclaw/openclaw.json declares gateway.auth.mode === "token"
 *     (token auto-detected from there by the openclaw adapter enrichment)
 *   - ~/.openclaw/agents/clawdbot/agent/ exists (a real agent named "clawdbot")
 *
 * Flow:
 *   1. Set up a company + CEO via onboarding API helpers
 *   2. Navigate /agents/import via the sidebar "+" dialog
 *   3. Pick openclaw_gateway, paste URL, discover agents, pick clawdbot
 *   4. Fill name, title, role (cto), reports-to (CEO), submit
 *   5. Trigger a heartbeat and poll until terminal; assert success
 */

const COMPANY_NAME = `E2E-Import-${Date.now()}`;
const CEO_NAME = "CEO";
const IMPORT_AGENT_NAME = `ClawdBot E2E ${Date.now()}`;
const IMPORT_AGENT_TITLE = "Head of Engineering";
const IMPORT_AGENT_ROLE_DROPDOWN_LABEL = "CTO";
const OPENCLAW_AGENT_ID = "clawdbot";
const GATEWAY_URL = "ws://127.0.0.1:18789";

const HEARTBEAT_POLL_TIMEOUT_MS = 4 * 60 * 1000;
const HEARTBEAT_POLL_INTERVAL_MS = 2_000;

// The openclaw adapter writes to the same shared path every user's OpenClaw
// reads from. Back it up so the test doesn't destroy the dev user's state.
const SHARED_KEY_PATH = path.resolve(os.homedir(), ".openclaw", "workspace", "paperclip-claimed-api-key.json");
const KEY_BACKUP_PATH = `${SHARED_KEY_PATH}.e2e-backup.${Date.now()}`;

test.describe("Import existing OpenClaw agent", () => {
  test.beforeAll(async () => {
    // Backup the shared key file so we can restore it after the test.
    if (fs.existsSync(SHARED_KEY_PATH)) {
      fs.copyFileSync(SHARED_KEY_PATH, KEY_BACKUP_PATH);
    }
  });

  test.afterAll(async () => {
    // Restore the backed-up key file so the dev's other OpenClaw agents
    // continue to authenticate against their real paperclip instance.
    if (fs.existsSync(KEY_BACKUP_PATH)) {
      fs.copyFileSync(KEY_BACKUP_PATH, SHARED_KEY_PATH);
      fs.unlinkSync(KEY_BACKUP_PATH);
    }
  });

  test("imports ClawdBot as CTO reporting to CEO and completes heartbeat", async ({ page, request }) => {
    test.setTimeout(8 * 60 * 1000); // heartbeat involves a real LLM call

    const baseURL = page.url().startsWith("http")
      ? new URL(page.url()).origin
      : (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3199");

    // ── 1. Ensure a company + CEO exist via API ────────────────────────────
    const company = await ensureCompany(request, baseURL, COMPANY_NAME);
    const ceoAgent = await ensureCeoAgent(request, baseURL, company.id, CEO_NAME);
    expect(ceoAgent.role).toBe("ceo");

    // ── 2. Navigate to import page via the sidebar dialog ──────────────────
    await page.goto("/");
    // The sidebar "+" opens NewAgentDialog; the "Import an existing agent"
    // secondary link navigates to /agents/import.
    const addAgentButton = page.getByRole("button", { name: "New agent" });
    await expect(addAgentButton).toBeVisible({ timeout: 10_000 });
    await addAgentButton.click();
    await page.getByRole("button", { name: /Import an existing agent/i }).click();
    await expect(page).toHaveURL(/\/agents\/import/, { timeout: 10_000 });

    // ── 3. Step 1: pick the adapter ────────────────────────────────────────
    const adapterButton = page
      .locator("button", { hasText: /openclaw_gateway|OpenClaw/i })
      .filter({ hasNot: page.getByText(/no discovery/i) })
      .first();
    await expect(adapterButton).toBeVisible({ timeout: 10_000 });
    await expect(adapterButton).toBeEnabled();
    await adapterButton.click();

    // ── 3b. Step 2: paste URL, discover, pick clawdbot ─────────────────────
    const urlInput = page.getByLabel(/Runtime URL/i);
    await expect(urlInput).toBeVisible();
    await urlInput.fill(GATEWAY_URL);

    await page.getByRole("button", { name: /Discover agents/i }).click();

    // Each discovered agent is a button with the agent id + status badge.
    const clawdbotOption = page.getByRole("button", { name: new RegExp(`\\b${OPENCLAW_AGENT_ID}\\b`, "i") });
    await expect(clawdbotOption).toBeVisible({ timeout: 20_000 });
    await clawdbotOption.click();

    // ── 3c. Step 3: fill confirmation fields + submit ──────────────────────
    const nameInput = page.getByLabel(/Name \(in Cognitive Hive\)/i);
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    // Name pre-fills from the discovered agent name; clear and set our unique value.
    await nameInput.fill(IMPORT_AGENT_NAME);

    await page.getByLabel(/^Title$/i).fill(IMPORT_AGENT_TITLE);

    // Role dropdown (shadcn Select). Click trigger, pick CTO option.
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: IMPORT_AGENT_ROLE_DROPDOWN_LABEL }).click();

    // Reports-to picker (Popover trigger button → CEO option).
    await page.getByRole("button", { name: /Choose a manager|Reports to/i }).click();
    await page.getByRole("button", { name: new RegExp(`\\b${CEO_NAME}\\b`, "i") }).last().click();

    // Submit the import and wait for the actual API response before moving on.
    const [importResponse] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes("/agent-imports") && resp.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.getByRole("button", { name: /Import agent/i }).click(),
    ]);
    expect(importResponse.status(), `/agent-imports: ${await importResponse.text()}`).toBe(201);

    // After a successful import, UI redirects off the /agents/import page.
    await page.waitForURL(
      (url) => !/\/agents\/import(?:[?#]|$)/.test(url.pathname + url.search),
      { timeout: 30_000 },
    );

    // ── 4. Verify the imported agent via API ──────────────────────────────
    const agentsRes = await request.get(`${baseURL}/api/companies/${company.id}/agents`);
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    console.log(
      `[debug] companyId=${company.id} currentUrl=${page.url()} agents=`,
      agents.map((a: { id: string; name: string; role: string; adapterType: string }) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        adapterType: a.adapterType,
      })),
    );
    const imported = agents.find((a: { name: string }) => a.name === IMPORT_AGENT_NAME);
    expect(imported, `imported agent "${IMPORT_AGENT_NAME}" should exist`).toBeTruthy();
    expect(imported.adapterType).toBe("openclaw_gateway");
    expect(imported.role).toBe("cto");
    expect(imported.title).toBe(IMPORT_AGENT_TITLE);
    expect(imported.reportsTo).toBe(ceoAgent.id);
    expect(imported.adapterConfig.url.replace(/\/$/, "")).toBe(GATEWAY_URL);
    expect(imported.adapterConfig.agentId).toBe(OPENCLAW_AGENT_ID);
    expect(imported.adapterConfig.headers?.["x-openclaw-token"])
      .toBeTruthy();
    expect(imported.status).not.toBe("error");

    // ── 5. Trigger a heartbeat and poll until terminal ─────────────────────
    const invokeRes = await request.post(
      `${baseURL}/api/agents/${imported.id}/heartbeat/invoke?companyId=${company.id}`,
      { data: {} },
    );
    expect(invokeRes.ok()).toBe(true);

    const terminalStatuses = new Set(["succeeded", "failed", "timeout", "cancelled"]);
    const deadline = Date.now() + HEARTBEAT_POLL_TIMEOUT_MS;
    let lastRun: {
      id: string;
      status: string;
      exitCode: number | null;
      error?: string | null;
      errorCode?: string | null;
    } | null = null;

    while (Date.now() < deadline) {
      const runsRes = await request.get(
        `${baseURL}/api/companies/${company.id}/heartbeat-runs?agentId=${imported.id}&limit=1`,
      );
      expect(runsRes.ok()).toBe(true);
      const runs = await runsRes.json();
      if (Array.isArray(runs) && runs.length > 0) {
        lastRun = runs[0];
        if (lastRun && terminalStatuses.has(lastRun.status)) break;
      }
      await new Promise((r) => setTimeout(r, HEARTBEAT_POLL_INTERVAL_MS));
    }

    expect(lastRun, "heartbeat run should have been created").toBeTruthy();
    if (lastRun!.status !== "succeeded") {
      // Surface the actual failure details so the test output is actionable.
      throw new Error(
        `Heartbeat did not succeed. status=${lastRun!.status} ` +
          `exitCode=${lastRun!.exitCode} ` +
          `errorCode=${lastRun!.errorCode ?? "(none)"} ` +
          `error=${lastRun!.error ?? "(none)"}`,
      );
    }
    expect(lastRun!.status).toBe("succeeded");
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

async function ensureCompany(
  request: APIRequestContext,
  baseURL: string,
  name: string,
): Promise<{ id: string; name: string; urlKey?: string }> {
  const existingRes = await request.get(`${baseURL}/api/companies`);
  expect(existingRes.ok()).toBe(true);
  const existing = await existingRes.json();
  if (Array.isArray(existing) && existing.length > 0) {
    return existing[0];
  }
  const createRes = await request.post(`${baseURL}/api/companies`, {
    data: { name },
  });
  if (!createRes.ok()) {
    throw new Error(`POST /api/companies failed: ${createRes.status()} ${await createRes.text()}`);
  }
  return await createRes.json();
}

async function ensureCeoAgent(
  request: APIRequestContext,
  baseURL: string,
  companyId: string,
  name: string,
): Promise<{ id: string; name: string; role: string }> {
  const existingRes = await request.get(`${baseURL}/api/companies/${companyId}/agents`);
  if (existingRes.ok()) {
    const existing = await existingRes.json();
    const ceo = Array.isArray(existing) ? existing.find((a: { role: string }) => a.role === "ceo") : null;
    if (ceo) return ceo;
  }
  const createRes = await request.post(`${baseURL}/api/companies/${companyId}/agent-hires`, {
    data: {
      name,
      role: "ceo",
      adapterType: "claude_local",
      adapterConfig: {},
      budgetMonthlyCents: 0,
    },
  });
  if (!createRes.ok()) {
    throw new Error(`CEO hire failed: ${createRes.status()} ${await createRes.text()}`);
  }
  const body = await createRes.json();
  return body.agent ?? body;
}
