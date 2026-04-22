import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { adaptersApi, type AdapterInfo, type DiscoveredAgent } from "../api/adapters";
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
import { ClipboardCopy, AlertTriangle, CheckCircle2 } from "lucide-react";

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
  const [issuedKey, setIssuedKey] = useState<{ token: string; agentId: string; agentName: string } | null>(null);
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: "Import Agent" },
    ]);
  }, [setBreadcrumbs]);

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
      setIssuedKey({
        token: result.apiKey.token,
        agentId: result.agent.id,
        agentName: result.agent.name,
      });
    },
    onError: (error) => {
      setSubmitError(error instanceof Error ? error.message : "Import failed");
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
    });
  }

  function handleKeyModalContinue() {
    if (!issuedKey) return;
    navigate(agentUrl({ id: issuedKey.agentId, name: issuedKey.agentName } as Parameters<typeof agentUrl>[0]));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Import Existing Agent</h1>
          <p className="text-sm text-muted-foreground">
            Register an agent that already runs on an external runtime.
          </p>
        </div>
        <Button variant="ghost" onClick={() => navigate("/agents/new")}>
          Creating a new agent? →
        </Button>
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
          submitting={importMutation.isPending}
          error={submitError}
          onBack={() => setStep("discover")}
          onSubmit={handleSubmit}
        />
      )}

      <Dialog open={Boolean(issuedKey)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              Agent imported
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p>
              Your paperclip API key has been issued. This is shown{" "}
              <strong>once</strong> — save it now.
            </p>
            <div className="rounded-md border bg-muted p-3 font-mono text-xs break-all">
              {issuedKey?.token}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (issuedKey) void navigator.clipboard.writeText(issuedKey.token);
              }}
            >
              <ClipboardCopy className="h-3 w-3 mr-2" /> Copy to clipboard
            </Button>
            <p className="text-muted-foreground text-xs">
              Paste this into your external runtime's paperclip config. For OpenClaw, save
              it to <code>~/.openclaw/workspace/paperclip-claimed-api-key.json</code>.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={keySaved}
                onCheckedChange={(v) => setKeySaved(Boolean(v))}
              />
              I've saved this key
            </label>
            <div className="flex justify-end">
              <Button onClick={handleKeyModalContinue} disabled={!keySaved}>
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

        {error && (
          <div className="text-sm text-destructive">{error}</div>
        )}

        <div className="flex justify-between">
          <Button variant="ghost" onClick={onBack}>← Back</Button>
          <Button onClick={onSubmit} disabled={submitting || !name.trim()}>
            {submitting ? "Importing…" : "Import agent"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
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
