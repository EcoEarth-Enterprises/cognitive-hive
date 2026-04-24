/**
 * @fileoverview Frontend API client for external adapter management.
 */

import { api } from "./client";

export interface AdapterCapabilities {
  supportsInstructionsBundle: boolean;
  supportsSkills: boolean;
  supportsLocalAgentJwt: boolean;
  requiresMaterializedRuntimeSkills: boolean;
  supportsDiscovery: boolean;
}

export interface DiscoveredAgent {
  id: string;
  name: string;
  description?: string;
  status?: "idle" | "running" | "error" | "unknown";
  metadata?: Record<string, unknown>;
}

export interface DiscoverAgentsResult {
  agents: DiscoveredAgent[];
  warnings?: string[];
}

export type DiscoveryErrorKind =
  | "unreachable"
  | "unauthorized"
  | "not_supported"
  | "invalid_config"
  | "internal";

export interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  capabilities: AdapterCapabilities;
  /** Installed version (for external npm adapters) */
  version?: string;
  /** Package name (for external adapters) */
  packageName?: string;
  /** Whether the adapter was installed from a local path (vs npm). */
  isLocalPath?: boolean;
  /** True when an external plugin has replaced a built-in adapter of the same type. */
  overriddenBuiltin?: boolean;
  /** True when the external override for a builtin type is currently paused. */
  overridePaused?: boolean;
}

export interface AdapterInstallResult {
  type: string;
  packageName: string;
  version?: string;
  installedAt: string;
}

export const adaptersApi = {
  /** List all registered adapters (built-in + external). */
  list: () => api.get<AdapterInfo[]>("/adapters"),

  /** Install an external adapter from npm or a local path. */
  install: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
    api.post<AdapterInstallResult>("/adapters/install", params),

  /** Remove an external adapter by type. */
  remove: (type: string) => api.delete<{ type: string; removed: boolean }>(`/adapters/${type}`),

  /** Enable or disable an adapter (disabled adapters hidden from agent menus). */
  setDisabled: (type: string, disabled: boolean) =>
    api.patch<{ type: string; disabled: boolean; changed: boolean }>(`/adapters/${type}`, { disabled }),

  /** Pause or resume an external override of a builtin type. */
  setOverridePaused: (type: string, paused: boolean) =>
    api.patch<{ type: string; paused: boolean; changed: boolean }>(`/adapters/${type}/override`, { paused }),

  /** Reload an external adapter (bust server + client caches). */
  reload: (type: string) =>
    api.post<{ type: string; version?: string; reloaded: boolean }>(`/adapters/${type}/reload`, {}),

  /** Reinstall an npm-sourced adapter (pulls latest from registry, then reloads). */
  reinstall: (type: string) =>
    api.post<{ type: string; version?: string; reinstalled: boolean }>(`/adapters/${type}/reinstall`, {}),

  /**
   * Enumerate existing agents on an external runtime via the adapter's
   * discoverAgents() method. Used by the /agents/import flow.
   */
  discover: (type: string, connectionConfig: Record<string, unknown>) =>
    api.post<DiscoverAgentsResult>(`/adapters/${type}/discover`, { connectionConfig }),

  /**
   * Resolve the adapter's paperclip API-key storage descriptor and check
   * whether an on-disk key file already exists. Used by /agents/import to
   * decide whether to auto-issue+write a new key or reuse the existing one.
   */
  apiKeyStorage: (type: string, adapterConfig: Record<string, unknown>) =>
    api.post<ApiKeyStorageStatus>(`/adapters/${type}/api-key-storage`, { adapterConfig }),
};

export type ApiKeyStorageDescriptor =
  | { kind: "file"; path: string; scope: "shared" | "per-agent"; format?: "json_paperclipApiKey" }
  | { kind: "env"; variable: string }
  | { kind: "none" };

export interface ApiKeyStorageStatus {
  descriptor: ApiKeyStorageDescriptor;
  exists: boolean;
  absolutePath?: string;
  lastModified?: string;
}
