import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DiscoveryError,
  type DiscoverAgentsInput,
  type DiscoverAgentsResult,
  type DiscoveredAgent,
} from "@paperclipai/adapter-utils";

/**
 * OpenClaw agent discovery.
 *
 * Strategy:
 * - If the gateway URL points at loopback (127.0.0.1, localhost, ::1), read
 *   agents from the local filesystem at ~/.openclaw/agents/. Each subdir that
 *   contains an `agent/` subdir is treated as a real agent.
 * - Remote gateways require an `agent.list` WS method on the OpenClaw side,
 *   which does not yet exist upstream. We throw "not_supported" for those
 *   and document the limitation. Future: add WS-based discovery once upstream
 *   OpenClaw exposes it.
 */
export async function discoverAgents(input: DiscoverAgentsInput): Promise<DiscoverAgentsResult> {
  const url = extractUrl(input.connectionConfig);

  if (!url) {
    throw new DiscoveryError("invalid_config", "Gateway URL is required for discovery.");
  }

  if (!isLoopbackUrl(url)) {
    throw new DiscoveryError(
      "not_supported",
      "Remote OpenClaw gateways do not yet support discovery. Only local (loopback) gateways can be enumerated via the filesystem fallback.",
      { url },
    );
  }

  return discoverViaFilesystem();
}

function extractUrl(config: Record<string, unknown>): string | null {
  const raw = config.url;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
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

async function discoverViaFilesystem(): Promise<DiscoverAgentsResult> {
  const agentsDir = path.resolve(openclawHomeDir(), "agents");

  let entries;
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true, encoding: "utf8" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DiscoveryError(
        "unreachable",
        `OpenClaw agents directory does not exist at ${agentsDir}. Is OpenClaw installed and initialized?`,
        { agentsDir },
      );
    }
    throw new DiscoveryError(
      "internal",
      `Failed to read OpenClaw agents directory: ${err instanceof Error ? err.message : String(err)}`,
      { agentsDir },
    );
  }

  const agents: DiscoveredAgent[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const agentSubdir = path.join(agentsDir, entry.name, "agent");
    try {
      const stat = await fs.stat(agentSubdir);
      if (!stat.isDirectory()) continue;
    } catch {
      warnings.push(`Skipped ${entry.name}: no agent/ subdirectory`);
      continue;
    }

    agents.push({
      id: entry.name,
      name: entry.name,
      status: "unknown",
      metadata: {
        source: "filesystem",
        path: path.join(agentsDir, entry.name),
      },
    });
  }

  agents.sort((a, b) => a.name.localeCompare(b.name));

  return { agents, warnings: warnings.length > 0 ? warnings : undefined };
}

function openclawHomeDir(): string {
  const override = process.env.OPENCLAW_HOME?.trim();
  if (override) {
    return path.resolve(expandTilde(override));
  }
  return path.resolve(os.homedir(), ".openclaw");
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
