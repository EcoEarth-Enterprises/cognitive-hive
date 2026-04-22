import type {
  ApiKeyStorageDescriptor,
  GetApiKeyStorageInput,
} from "@paperclipai/adapter-utils";

/**
 * OpenClaw gateway's paperclip API key storage.
 *
 * Today upstream OpenClaw reads the token from a single shared path:
 *   ~/.openclaw/workspace/paperclip-claimed-api-key.json
 *
 * That means one file serves every OpenClaw agent on the machine, so scope
 * is "shared" — imports 2..N will see an existing file and reuse instead
 * of piling up tokens. When upstream OpenClaw adds per-agent key paths,
 * this function should flip to scope "per-agent" and return a path like
 *   ~/.openclaw/agents/<agentId>/paperclip-claimed-api-key.json
 * based on adapterConfig.agentId.
 *
 * If the user has overridden the claimed-key path via adapterConfig
 * (claimedApiKeyPath), we honor it — whatever value they put there.
 */
export function getApiKeyStorage(
  input: GetApiKeyStorageInput,
): ApiKeyStorageDescriptor | null {
  const overridden = input.adapterConfig.claimedApiKeyPath;
  const path =
    typeof overridden === "string" && overridden.trim().length > 0
      ? overridden.trim()
      : "~/.openclaw/workspace/paperclip-claimed-api-key.json";

  return {
    kind: "file",
    path,
    scope: "shared",
    format: "json_paperclipApiKey",
  };
}
