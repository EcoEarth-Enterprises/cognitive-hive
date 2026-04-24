import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiKeyStorageDescriptor } from "../adapters/types.js";

export interface ApiKeyStorageOutcome {
  /** What the server actually did. */
  action: "reused_existing" | "issued_and_written" | "overwritten" | "issued_no_storage" | "skipped";
  /** Absolute path (when the descriptor was "file"). */
  path?: string;
  /** Status of the filesystem write, when one was attempted. */
  writeStatus?: "wrote" | "skipped_existing" | "failed";
  /** Human-readable write error when writeStatus === "failed". */
  writeError?: string;
  /**
   * If the server attempted to write but failed, include the plaintext token
   * here so the UI can surface a copy-manually fallback. Never populated on
   * successful writes.
   */
  fallbackToken?: string;
  /** Record of the issued API key row (when a new key was minted). */
  issuedApiKey?: { id: string; name: string };
}

export interface HandleApiKeyStorageInput {
  descriptor: ApiKeyStorageDescriptor;
  behavior: "auto" | "reuse_existing" | "overwrite";
  agentId: string;
  issueKey: (name: string) => Promise<{ id: string; name: string; token: string }>;
}

/**
 * Execute the adapter's declared API key storage policy for an import.
 *
 * Decision matrix:
 *   descriptor.kind === "none":
 *     - Skip everything. No key issued, nothing written. action: "skipped".
 *
 *   descriptor.kind === "env":
 *     - Issue a key so the agent exists with a valid credential, but there's
 *       nothing to write. Token is returned via fallbackToken for the UI to
 *       surface so the operator can set the env var manually.
 *       action: "issued_no_storage".
 *
 *   descriptor.kind === "file":
 *     - If behavior === "reuse_existing": don't issue, don't write, never
 *       touch the file regardless of presence. action: "reused_existing".
 *     - If behavior === "overwrite": always issue + write (clobbers).
 *     - If behavior === "auto":
 *         * scope === "shared" + file exists: reuse (no issuance).
 *         * scope === "shared" + file missing: issue + write.
 *         * scope === "per-agent": always issue + write (each agent has its
 *           own path, no collisions by definition).
 *
 * Write failures do NOT fail the import — the outcome carries fallbackToken
 * and writeStatus="failed" so the UI can tell the user to paste manually.
 */
export async function handleApiKeyStorage(
  input: HandleApiKeyStorageInput,
): Promise<ApiKeyStorageOutcome> {
  const { descriptor, behavior, issueKey } = input;

  if (descriptor.kind === "none") {
    return { action: "skipped" };
  }

  if (descriptor.kind === "env") {
    const key = await issueKey("import");
    return {
      action: "issued_no_storage",
      fallbackToken: key.token,
      issuedApiKey: { id: key.id, name: key.name },
    };
  }

  // descriptor.kind === "file"
  const absolutePath = expandTildePath(descriptor.path);
  const fileExists = await fileExistsAt(absolutePath);

  const shouldReuse =
    behavior === "reuse_existing" ||
    (behavior === "auto" && descriptor.scope === "shared" && fileExists);

  if (shouldReuse) {
    return {
      action: "reused_existing",
      path: absolutePath,
      writeStatus: "skipped_existing",
    };
  }

  // Issue a fresh key.
  const key = await issueKey("import");

  // Try to write it atomically.
  const writeResult = await writeApiKeyFile(absolutePath, key.token, descriptor.format);

  if (writeResult.ok) {
    return {
      action: behavior === "overwrite" && fileExists ? "overwritten" : "issued_and_written",
      path: absolutePath,
      writeStatus: "wrote",
      issuedApiKey: { id: key.id, name: key.name },
    };
  }

  return {
    action: "issued_and_written",
    path: absolutePath,
    writeStatus: "failed",
    writeError: writeResult.error,
    fallbackToken: key.token,
    issuedApiKey: { id: key.id, name: key.name },
  };
}

function expandTildePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.resolve(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

async function fileExistsAt(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(absPath);
    return stat.isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    // For other errors (EACCES, etc.) treat as "does not exist" rather than
    // erroring — we'll attempt the write and surface the real error there.
    return false;
  }
}

async function writeApiKeyFile(
  absPath: string,
  token: string,
  format: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    const body = format === "json_paperclipApiKey"
      ? JSON.stringify({ paperclipApiKey: token }, null, 2) + "\n"
      : token;
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmpPath, body, { mode: 0o600 });
    await fs.promises.rename(tmpPath, absPath);
    // Ensure mode is tight even if the rename preserved a looser one.
    try {
      await fs.promises.chmod(absPath, 0o600);
    } catch {
      // Non-fatal — the initial writeFile already set the mode on most OSes.
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
