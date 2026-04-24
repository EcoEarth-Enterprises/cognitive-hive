import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OpenClaw adapter config enrichment.
 *
 * For loopback gateway URLs (the machine running paperclip also runs OpenClaw),
 * read ~/.openclaw/openclaw.json and, if it declares a token-mode gateway
 * auth, merge that token into headers["x-openclaw-token"] so the agent can
 * actually authenticate to the gateway without the operator pasting the token
 * by hand at import time.
 *
 * Runs server-side only; the token never reaches the browser. If the openclaw
 * config is missing, unreadable, or doesn't declare token auth, returns null
 * and the import proceeds with whatever the operator provided.
 */
export async function enrichAdapterConfigForImport(input: {
  adapterConfig: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const { adapterConfig } = input;
  const url = typeof adapterConfig.url === "string" ? adapterConfig.url : null;
  if (!url) return null;

  if (!isLoopbackUrl(url)) return null;

  // Don't overwrite a token the operator explicitly set.
  const existingHeaders =
    adapterConfig.headers && typeof adapterConfig.headers === "object" && !Array.isArray(adapterConfig.headers)
      ? (adapterConfig.headers as Record<string, unknown>)
      : {};
  if (typeof existingHeaders["x-openclaw-token"] === "string" && existingHeaders["x-openclaw-token"]) {
    return null;
  }
  if (typeof adapterConfig.authToken === "string" && adapterConfig.authToken) {
    return null;
  }

  const token = await readLocalGatewayToken();
  if (!token) return null;

  return {
    headers: {
      ...existingHeaders,
      "x-openclaw-token": token,
    },
  };
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

async function readLocalGatewayToken(): Promise<string | null> {
  const configPath = path.resolve(openclawHomeDir(), "openclaw.json");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const gateway = (parsed as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) return null;
  const auth = (gateway as Record<string, unknown>).auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const authRec = auth as Record<string, unknown>;
  if (authRec.mode !== "token") return null;
  const token = authRec.token;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

function openclawHomeDir(): string {
  const override = process.env.OPENCLAW_HOME?.trim();
  if (override) return path.resolve(expandTilde(override));
  return path.resolve(os.homedir(), ".openclaw");
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
