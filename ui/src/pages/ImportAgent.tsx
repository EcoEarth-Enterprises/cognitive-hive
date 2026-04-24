import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { adaptersApi, type AdapterInfo, type DiscoveredAgent, type ApiKeyStorageStatus } from "../api/adapters";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ReportsToPicker } from "../components/ReportsToPicker";
import type { Agent } from "@paperclipai/shared";
import { agentUrl } from "../lib/utils";
import { roleLabels } from "../components/agent-config-primitives";
import { ClipboardCopy, AlertTriangle, CheckCircle2, Check } from "lucide-react";

type Step = "adapter" | "discover" | "confirm";

interface DiscoveryErrorState {
  message: string;
  kind?: string;
}

export function ImportAgent() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const repairAgentId = searchParams.get("repair");
  const isRepair = Boolean(repairAgentId);

  const [step, setStep] = useState<Step>("adapter");
  const [adapterType, setAdapterType] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [discoveryResult, setDiscoveryResult] = useState<DiscoveredAgent[] | null>(null);
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([]);
  const [discoveryError, setDiscoveryError] = useState<DiscoveryErrorState | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("general");
  const [reportsTo, setReportsTo] = useState<string | null>(null);
  const [budgetMonthly, setBudgetMonthly] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [keyBehavior, setKeyBehavior] = useState<"auto" | "overwrite">("auto");
  // Fallback modal: only shown when the server had to return a plaintext token
  // because it couldn't write the file (or the adapter uses env storage).
  const [fallback, setFallback] = useState<{
    token: string;
    path?: string;
    envVariable?: string;
    agentId: string;
    agentName: string;
    writeError?: string;
  } | null>(null);
  const [fallbackCopied, setFallbackCopied] = useState(false);
  const [fallbackSaved, setFallbackSaved] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: isRepair ? "Repair Agent Connection" : "Import Agent" },
    ]);
  }, [setBreadcrumbs, isRepair]);

  const { data: existingAgent } = useQuery({
    queryKey: ["agent", repairAgentId, "for-repair"],
    queryFn: () => agentsApi.get(repairAgentId!),
    enabled: Boolean(repairAgentId),
  });

  useEffect(() => {
    if (!existingAgent) return;
    // Pre-fill from the existing agent and skip the adapter-pick step.
    setAdapterType(existingAgent.adapterType);
    const cfg = (existingAgent.adapterConfig ?? {}) as Record<string, unknown>;
    if (typeof cfg.url === "string") setUrl(cfg.url);
    if (typeof cfg.agentId === "string") setSelectedAgentId(cfg.agentId);
    setName(existingAgent.name);
    setTitle(existingAgent.title ?? "");
    setRole(existingAgent.role);
    setReportsTo(existingAgent.reportsTo ?? null);
    setStep("discover");
  }, [existingAgent]);

  const { data: adapters, isLoading: adaptersLoading } = useQuery({
    queryKey: ["adapters", "list"],
    queryFn: () => adaptersApi.list(),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const sortedAdapters = useMemo<AdapterInfo[]>(
    () => (adapters ?? []).slice().sort((a, b) => a.type.localeCompare(b.type)),
    [adapters],
  );

  // Fetch API key storage status once we've picked an adapter + URL so the
  // confirm step can tell the user what will happen (auto-write, reuse, etc).
  const { data: storageStatus } = useQuery<ApiKeyStorageStatus>({
    queryKey: ["adapters", adapterType, "api-key-storage", url, selectedAgentId],
    queryFn: () =>
      adaptersApi.apiKeyStorage(adapterType!, {
        url: url.trim(),
        agentId: selectedAgentId,
      }),
    enabled: Boolean(step === "confirm" && adapterType && url && selectedAgentId && !isRepair),
  });

  const discoverMutation = useMutation({
    mutationFn: async () => {
      if (!adapterType) throw new Error("Adapter not selected");
      return adaptersApi.discover(adapterType, { url: url.trim() });
    },
    onSuccess: (result) => {
      setDiscoveryResult(result.agents);
      setDiscoveryWarnings(result.warnings ?? []);
      setDiscoveryError(null);
    },
    onError: (error: unknown) => {
      setDiscoveryResult(null);
      setDiscoveryWarnings([]);
      const body = (error as { body?: { error?: string; kind?: string } }).body;
      setDiscoveryError({
        message: body?.error ?? (error instanceof Error ? error.message : "Discovery failed"),
        kind: body?.kind,
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentsApi.importExisting(selectedCompanyId!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });

      // Happy path: server wrote the file (or reused existing, or adapter is
      // keyless). No manual token handling needed — navigate to the agent page.
      if (!result.fallbackToken) {
        navigate(agentUrl(result.agent));
        return;
      }

      // Fallback: server needed the user to handle the token manually (write
      // failed, or adapter uses env storage with no file to write). Surface
      // the plaintext token in a copy-manually modal.
      setFallback({
        token: result.fallbackToken,
        path: result.keyPath,
        agentId: result.agent.id,
        agentName: result.agent.name,
        writeError: result.writeError,
      });
    },
    onError: (error) => {
      setSubmitError(error instanceof Error ? error.message : "Import failed");
    },
  });

  const repairMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentsApi.update(repairAgentId!, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["agent", repairAgentId] });
      navigate(agentUrl(updated));
    },
    onError: (error) => {
      setSubmitError(error instanceof Error ? error.message : "Update failed");
    },
  });

  function pickAdapter(type: string) {
    setAdapterType(type);
    setUrl("");
    setDiscoveryResult(null);
    setDiscoveryError(null);
    setSelectedAgentId(null);
    setStep("discover");
  }

  function pickDiscoveredAgent(agent: DiscoveredAgent) {
    setSelectedAgentId(agent.id);
    if (!name) setName(agent.name);
    setStep("confirm");
  }

  function handleSubmit() {
    if (!selectedCompanyId || !adapterType || !selectedAgentId || !name.trim()) return;
    setSubmitError(null);
    if (isRepair && repairAgentId) {
      // Repair flow: PATCH the existing agent's adapterConfig only.
      // Name/role/budget stay as they were.
      repairMutation.mutate({
        adapterConfig: {
          url: url.trim(),
          agentId: selectedAgentId,
        },
      });
      return;
    }
    importMutation.mutate({
      name: name.trim(),
      role,
      title: title.trim() || null,
      reportsTo,
      adapterType,
      adapterConfig: {
        url: url.trim(),
        agentId: selectedAgentId,
      },
      budgetMonthlyCents: Math.max(0, Math.round(budgetMonthly * 100)),
      keyBehavior,
    });
  }

  function handleFallbackContinue() {
    if (!fallback) return;
    navigate(agentUrl({ id: fallback.agentId, name: fallback.agentName } as Parameters<typeof agentUrl>[0]));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {isRepair ? "Repair Agent Connection" : "Import Existing Agent"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isRepair
              ? "Re-enumerate the external runtime and re-point this agent's connection."
              : "Register an agent that already runs on an external runtime."}
          </p>
        </div>
        {!isRepair && (
          <Button variant="ghost" onClick={() => navigate("/agents/new")}>
            Creating a new agent? →
          </Button>
        )}
      </div>

      <WizardHeader step={step} />

      {step === "adapter" && (
        <AdapterStep
          adapters={sortedAdapters}
          loading={adaptersLoading}
          onPick={pickAdapter}
        />
      )}

      {step === "discover" && adapterType && (
        <DiscoverStep
          adapterType={adapterType}
          url={url}
          setUrl={setUrl}
          onBack={() => setStep("adapter")}
          onDiscover={() => discoverMutation.mutate()}
          discovering={discoverMutation.isPending}
          result={discoveryResult}
          warnings={discoveryWarnings}
          error={discoveryError}
          onPickAgent={pickDiscoveredAgent}
        />
      )}

      {step === "confirm" && adapterType && selectedAgentId && (
        <ConfirmStep
          adapterType={adapterType}
          discoveredAgentId={selectedAgentId}
          url={url}
          name={name}
          setName={setName}
          title={title}
          setTitle={setTitle}
          role={role}
          setRole={setRole}
          reportsTo={reportsTo}
          setReportsTo={setReportsTo}
          budgetMonthly={budgetMonthly}
          setBudgetMonthly={setBudgetMonthly}
          availableAgents={(agents ?? []) as Agent[]}
          submitting={importMutation.isPending || repairMutation.isPending}
          error={submitError}
          isRepair={isRepair}
          keyBehavior={keyBehavior}
          setKeyBehavior={setKeyBehavior}
          storageStatus={storageStatus ?? null}
          onBack={() => setStep("discover")}
          onSubmit={handleSubmit}
        />
      )}

      <Dialog open={Boolean(fallback)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Save your API key manually
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            {fallback?.writeError ? (
              <p>
                We couldn't write the paperclip API key automatically:{" "}
                <code className="text-xs">{fallback.writeError}</code>
              </p>
            ) : (
              <p>
                Your agent is imported, but this adapter needs you to save the
                paperclip API key manually.
              </p>
            )}
            <div className="rounded-md border bg-muted p-3 font-mono text-xs break-all">
              {fallback?.token}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!fallback) return;
                try {
                  await navigator.clipboard.writeText(fallback.token);
                  setFallbackCopied(true);
                  setTimeout(() => setFallbackCopied(false), 2000);
                } catch {
                  // clipboard write can fail in insecure contexts
                }
              }}
              className={fallbackCopied ? "bg-green-500/10 border-green-500/50 text-green-700 dark:text-green-400" : undefined}
            >
              {fallbackCopied ? (
                <>
                  <Check className="h-3 w-3 mr-2" /> Copied!
                </>
              ) : (
                <>
                  <ClipboardCopy className="h-3 w-3 mr-2" /> Copy to clipboard
                </>
              )}
            </Button>
            {fallback?.path && (
              <p className="text-muted-foreground text-xs">
                Save this to <code>{fallback.path}</code> as JSON:{" "}
                <code>{'{"paperclipApiKey":"<token>"}'}</code>
              </p>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={fallbackSaved}
                onCheckedChange={(v) => setFallbackSaved(Boolean(v))}
              />
              I've saved this key
            </label>
            <div className="flex justify-end">
              <Button onClick={handleFallbackContinue} disabled={!fallbackSaved}>
                Continue →
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WizardHeader({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "adapter", label: "1. Adapter" },
    { key: "discover", label: "2. Discover" },
    { key: "confirm", label: "3. Confirm" },
  ];
  const activeIdx = steps.findIndex((s) => s.key === step);
  return (
    <div className="flex gap-2 text-sm">
      {steps.map((s, i) => (
        <div
          key={s.key}
          className={
            i === activeIdx
              ? "font-semibold"
              : i < activeIdx
              ? "text-muted-foreground"
              : "text-muted-foreground/60"
          }
        >
          {s.label}
          {i < steps.length - 1 && <span className="mx-2">→</span>}
        </div>
      ))}
    </div>
  );
}

function AdapterStep({
  adapters,
  loading,
  onPick,
}: {
  adapters: AdapterInfo[];
  loading: boolean;
  onPick: (type: string) => void;
}) {
  if (loading) return <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Loading adapters…</CardContent></Card>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pick the adapter type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {adapters.map((a) => {
          const canDiscover = a.capabilities?.supportsDiscovery;
          return (
            <button
              key={a.type}
              type="button"
              disabled={!canDiscover || a.disabled}
              onClick={() => onPick(a.type)}
              className="w-full text-left rounded-md border p-3 flex items-center justify-between hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                !canDiscover
                  ? "This adapter doesn't support discovery. Use /agents/new to create one manually."
                  : a.disabled
                  ? "This adapter is disabled."
                  : undefined
              }
            >
              <div>
                <div className="font-medium">{a.label || a.type}</div>
                <div className="text-xs text-muted-foreground">
                  {a.source} · {a.modelsCount} models
                </div>
              </div>
              {!canDiscover && <Badge variant="outline">no discovery</Badge>}
              {a.disabled && <Badge variant="destructive">disabled</Badge>}
            </button>
          );
        })}
        {adapters.every((a) => !a.capabilities?.supportsDiscovery) && (
          <p className="text-sm text-muted-foreground pt-2">
            No adapters currently support discovery. Import requires an adapter with the{" "}
            <code>discoverAgents</code> capability.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DiscoverStep({
  adapterType,
  url,
  setUrl,
  onBack,
  onDiscover,
  discovering,
  result,
  warnings,
  error,
  onPickAgent,
}: {
  adapterType: string;
  url: string;
  setUrl: (v: string) => void;
  onBack: () => void;
  onDiscover: () => void;
  discovering: boolean;
  result: DiscoveredAgent[] | null;
  warnings: string[];
  error: DiscoveryErrorState | null;
  onPickAgent: (agent: DiscoveredAgent) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect to the runtime</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="runtime-url">Runtime URL ({adapterType})</Label>
          <Input
            id="runtime-url"
            placeholder="ws://127.0.0.1:18789"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="flex justify-between">
          <Button variant="ghost" onClick={onBack}>← Back</Button>
          <Button onClick={onDiscover} disabled={!url.trim() || discovering}>
            {discovering ? "Discovering…" : "Discover agents"}
          </Button>
        </div>
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive" />
              <div>
                <div className="font-medium">{humanizeDiscoveryError(error)}</div>
                <div className="text-xs text-muted-foreground mt-1">{error.message}</div>
              </div>
            </div>
          </div>
        )}
        {result && result.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">
              Found {result.length} agent{result.length === 1 ? "" : "s"}:
            </div>
            {result.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => onPickAgent(a)}
                className="w-full text-left rounded-md border p-3 hover:bg-accent flex justify-between items-center"
              >
                <div>
                  <div className="font-medium">{a.name}</div>
                  {a.description && <div className="text-xs text-muted-foreground">{a.description}</div>}
                </div>
                <Badge variant="outline">{a.status ?? "unknown"}</Badge>
              </button>
            ))}
          </div>
        )}
        {result && result.length === 0 && (
          <p className="text-sm text-muted-foreground">No agents found at that URL.</p>
        )}
        {warnings.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {warnings.map((w, i) => (
              <div key={i}>• {w}</div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConfirmStep({
  adapterType,
  discoveredAgentId,
  url,
  name,
  setName,
  title,
  setTitle,
  role,
  setRole,
  reportsTo,
  setReportsTo,
  budgetMonthly,
  setBudgetMonthly,
  availableAgents,
  submitting,
  error,
  isRepair,
  keyBehavior,
  setKeyBehavior,
  storageStatus,
  onBack,
  onSubmit,
}: {
  adapterType: string;
  discoveredAgentId: string;
  url: string;
  name: string;
  setName: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  reportsTo: string | null;
  setReportsTo: (v: string | null) => void;
  budgetMonthly: number;
  setBudgetMonthly: (v: number) => void;
  availableAgents: Agent[];
  submitting: boolean;
  error: string | null;
  isRepair: boolean;
  keyBehavior: "auto" | "overwrite";
  setKeyBehavior: (v: "auto" | "overwrite") => void;
  storageStatus: ApiKeyStorageStatus | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configure & import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1">
          <div><strong>Adapter:</strong> {adapterType}</div>
          <div><strong>External agent id:</strong> {discoveredAgentId}</div>
          <div><strong>Gateway:</strong> {url}</div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="name">Name (in Cognitive Hive)</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="space-y-2">
          <Label>Role</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabels[r] ?? r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Reports to</Label>
          <ReportsToPicker
            value={reportsTo}
            onChange={setReportsTo}
            agents={availableAgents}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="budget">Monthly budget (USD)</Label>
          <Input
            id="budget"
            type="number"
            min={0}
            value={budgetMonthly}
            onChange={(e) => setBudgetMonthly(Number(e.target.value) || 0)}
          />
        </div>

        {!isRepair && storageStatus && (
          <ApiKeyStoragePanel
            status={storageStatus}
            behavior={keyBehavior}
            onChangeBehavior={setKeyBehavior}
          />
        )}

        {error && (
          <div className="text-sm text-destructive">{error}</div>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" onClick={onBack}>← Back</Button>
          <Button onClick={onSubmit} disabled={submitting || !name.trim()}>
            {submitting
              ? isRepair
                ? "Updating…"
                : "Importing…"
              : isRepair
              ? "Update connection"
              : "Import agent"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ApiKeyStoragePanel({
  status,
  behavior,
  onChangeBehavior,
}: {
  status: ApiKeyStorageStatus;
  behavior: "auto" | "overwrite";
  onChangeBehavior: (v: "auto" | "overwrite") => void;
}) {
  const d = status.descriptor;

  if (d.kind === "none") {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        This adapter doesn't use filesystem keys. Nothing to save after import.
      </div>
    );
  }

  if (d.kind === "env") {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs">
        <div className="font-medium mb-1">API key delivery</div>
        <div className="text-muted-foreground">
          This adapter reads the paperclip API key from the{" "}
          <code>{d.variable}</code> environment variable. A new key will be
          issued on import and shown to you once so you can set it.
        </div>
      </div>
    );
  }

  // kind === "file"
  const displayPath = status.absolutePath ?? d.path;
  if (!status.exists) {
    return (
      <div className="rounded-md border border-green-500/40 bg-green-500/5 p-3 text-xs space-y-1">
        <div className="font-medium text-green-700 dark:text-green-400">
          API key will be issued and saved automatically
        </div>
        <div className="text-muted-foreground">
          A fresh paperclip API key will be written to{" "}
          <code className="break-all">{displayPath}</code>. Nothing for you to
          copy-paste.
        </div>
      </div>
    );
  }

  // File exists
  if (d.scope === "shared") {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-2">
        <div className="font-medium">Existing API key file found</div>
        <div className="text-muted-foreground">
          <code className="break-all">{displayPath}</code>
          {status.lastModified && <> · modified {relative(status.lastModified)}</>}
        </div>
        <div className="text-muted-foreground">
          This adapter uses one shared key file for every agent it drives, so
          the same token will serve this imported agent too — no new key
          needs to be issued.
        </div>
        <div className="flex gap-4 pt-1">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={behavior === "auto"}
              onChange={() => onChangeBehavior("auto")}
            />
            Reuse existing key
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={behavior === "overwrite"}
              onChange={() => onChangeBehavior("overwrite")}
            />
            Replace with a fresh key
          </label>
        </div>
        {behavior === "overwrite" && (
          <div className="text-amber-700 dark:text-amber-400">
            ⚠ Replacing will invalidate any previous agents sharing this key.
          </div>
        )}
      </div>
    );
  }

  // per-agent scope
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
      <div className="font-medium">Existing per-agent key file found</div>
      <div className="text-muted-foreground">
        <code className="break-all">{displayPath}</code>
      </div>
      <div className="text-muted-foreground">
        A new key will be issued and written, replacing the previous file.
      </div>
    </div>
  );
}

function relative(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function humanizeDiscoveryError(err: DiscoveryErrorState): string {
  switch (err.kind) {
    case "unreachable":
      return "Could not reach the runtime. Is it running?";
    case "unauthorized":
      return "Runtime rejected auth. Check your token.";
    case "not_supported":
      return "This adapter can't enumerate agents at that URL.";
    case "invalid_config":
      return "The connection config is incomplete or invalid.";
    default:
      return "Discovery failed.";
  }
}
