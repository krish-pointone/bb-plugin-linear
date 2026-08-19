import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface LinearIssueRow {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  priorityLabel: string;
  url: string;
  updatedAt: string;
  dueDate: string | null;
  state: { id: string; name: string; type: string; color: string };
  team: { id: string; name: string; key: string };
  assignee: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
  labels: Array<{ id: string; name: string; color: string }>;
  linkedThreads: Array<{ id: string; status: string; title: string | null }>;
}

interface LinearWorkspaceState {
  configured: boolean;
  viewerName: string | null;
  views: Array<{
    id: string;
    name: string;
    description: string | null;
    color: string | null;
    shared: boolean;
  }>;
  issues: LinearIssueRow[];
  teams: Array<{
    id: string;
    name: string;
    key: string;
    states: Array<{ id: string; name: string; type: string }>;
  }>;
  bbProjects: Array<{ id: string; name: string; kind: string }>;
}

function LinearStateIcon({ type }: { type: string }) {
  if (type === "completed") return <Icon name="CircleCheck" className="size-4 text-success" aria-hidden />;
  if (type === "canceled") return <Icon name="CircleX" className="size-4 text-muted-foreground" aria-hidden />;
  if (type === "started") return <Icon name="Loading" className="size-4 text-primary" aria-hidden />;
  return <Icon name="Circle" className="size-4 text-muted-foreground" aria-hidden />;
}

function LinearMark({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true">
      <path d="M4.2 14.7a8.4 8.4 0 0 0 5.1 5.1L4.2 14.7Z" fill="currentColor" />
      <path d="m3.6 10.3 10.1 10.1M5.1 7.1l11.8 11.8M7.7 4.9l11.4 11.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M11.2 3.6A8.4 8.4 0 0 1 20.4 12c0 .6-.1 1.2-.2 1.8L10.2 3.8c.3-.1.7-.2 1-.2Z" fill="currentColor" />
    </svg>
  );
}

function LinearSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<{ configured: boolean; viewerName: string | null } | null>(null);

  useEffect(() => {
    void rpc.call("linearStatus").then(setStatus).catch(() => {
      setStatus({ configured: false, viewerName: null });
    });
  }, [rpc]);

  return (
    <div className="space-y-2 text-sm">
      <p>
        {status?.configured
          ? `Connected as ${status.viewerName ?? "a Linear user"}.`
          : "Add a Linear personal API key in the secure field above to enable the Linear panel."}
      </p>
      <p className="text-muted-foreground">
        Create a key in Linear under Settings → Security &amp; access → Personal API keys.
        It is stored as a bb secret and is never sent to the frontend.
      </p>
    </div>
  );
}

function CreateLinearIssueDialog({
  open,
  onOpenChange,
  teams,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: LinearWorkspaceState["teams"];
  onCreated: () => Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!teamId && teams[0]) setTeamId(teams[0].id);
  }, [teamId, teams]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!teamId || !title.trim()) return;
    setSaving(true);
    try {
      await rpc.call("createLinearIssue", {
        teamId,
        title: title.trim(),
        description: description.trim(),
      });
      toast.success("Linear issue created");
      setTitle("");
      setDescription("");
      onOpenChange(false);
      await onCreated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the issue");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Create Linear issue</DialogTitle>
            <DialogDescription>Create it without leaving bb.</DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Team</span>
            <select className="h-9 w-full rounded-md border border-input bg-background px-3" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Title</span>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Description</span>
            <textarea className="min-h-32 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving || !teamId || !title.trim()}>{saving ? "Creating…" : "Create issue"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinearPanel() {
  const context = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [workspace, setWorkspace] = useState<LinearWorkspaceState | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [bbProjectId, setBbProjectId] = useState(context.projectId ?? "");

  const load = useCallback(async () => {
    try {
      const next = await rpc.call("getLinearWorkspace", { viewId });
      setWorkspace(next);
      setSelectedIssueId((current) =>
        next.issues.some(({ id }) => id === current) ? current : (next.issues[0]?.id ?? null),
      );
      if (!bbProjectId) {
        setBbProjectId(next.bbProjects.find(({ kind }) => kind === "standard")?.id ?? next.bbProjects[0]?.id ?? "");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Linear");
    } finally {
      setLoading(false);
    }
  }, [bbProjectId, rpc, viewId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  useRealtime("linear-changed", () => void load());

  const assignees = useMemo(() => {
    const people = new Map<string, string>();
    for (const issue of workspace?.issues ?? []) {
      if (issue.assignee) people.set(issue.assignee.id, issue.assignee.name);
    }
    return [...people.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [workspace]);
  const hasUnassigned = useMemo(() => (workspace?.issues ?? []).some((issue) => issue.assignee === null), [workspace]);
  const issues = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (workspace?.issues ?? []).filter((issue) => {
      const matchesPerson = assigneeFilter === "all" || (assigneeFilter === "unassigned" ? issue.assignee === null : issue.assignee?.id === assigneeFilter);
      const matchesSearch = !query || issue.identifier.toLowerCase().includes(query) || issue.title.toLowerCase().includes(query) || issue.assignee?.name.toLowerCase().includes(query);
      return matchesPerson && matchesSearch;
    });
  }, [assigneeFilter, search, workspace]);
  const selectedIssue = workspace?.issues.find(({ id }) => id === selectedIssueId) ?? null;

  async function updateState(stateId: string) {
    if (!selectedIssue) return;
    try {
      await rpc.call("updateLinearIssueState", { issueId: selectedIssue.id, stateId });
      toast.success("Linear status updated");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update Linear");
    }
  }

  async function startAgent() {
    if (!selectedIssue || !bbProjectId) return;
    setStarting(true);
    try {
      const { threadId } = await rpc.call("startLinearAgent", { issueId: selectedIssue.id, bbProjectId });
      toast.success(`Started agent for ${selectedIssue.identifier}`);
      navigate.toThread(threadId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the agent");
    } finally {
      setStarting(false);
    }
  }

  if (loading && !workspace) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading Linear…</div>;

  if (!workspace?.configured) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-muted"><LinearMark className="size-6" /></div>
          <h2 className="font-semibold">Connect Linear</h2>
          <p className="mt-2 text-sm text-muted-foreground">Open Extensions → Plugins → Linear and add a Linear personal API key. The key stays in bb&apos;s secure plugin storage.</p>
        </div>
      </div>
    );
  }

  const selectedTeam = workspace.teams.find(({ id }) => id === selectedIssue?.team.id);

  return (
    <div className="flex h-full min-h-0 min-w-[980px] bg-background">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-border p-3">
        <p className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Views</p>
        <button className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${viewId === null ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`} onClick={() => setViewId(null)}>
          <Icon name="ListTodo" className="size-4 shrink-0" aria-hidden />All issues
        </button>
        {workspace.views.map((view) => (
          <button key={view.id} className={`mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${viewId === view.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`} title={view.description ?? view.name} onClick={() => setViewId(view.id)}>
            <Icon name="Eye" className="size-4 shrink-0" aria-hidden /><span className="truncate">{view.name}</span>
          </button>
        ))}
        <div className="mt-5 border-t border-border px-2 pt-3 text-xs text-muted-foreground">Connected as {workspace.viewerName}</div>
      </aside>

      <section className="flex w-[390px] shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <Input aria-label="Search Linear issues" placeholder="Search issues…" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Button size="sm" onClick={() => setCreateOpen(true)}><Icon name="Plus" className="size-4" aria-hidden />New</Button>
          </div>
          <div className="flex items-center gap-2">
            <Icon name="UserRound" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <select aria-label="Filter issues by assignee" className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}>
              <option value="all">Everyone</option>
              {assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              {hasUnassigned ? <option value="unassigned">Unassigned</option> : null}
            </select>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{issues.length}</span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {issues.map((issue) => (
            <button key={issue.id} className={`w-full border-b border-border px-3 py-3 text-left transition hover:bg-muted/60 ${selectedIssueId === issue.id ? "bg-accent/70" : ""}`} onClick={() => setSelectedIssueId(issue.id)}>
              <div className="flex items-start gap-2"><LinearStateIcon type={issue.state.type} /><span className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground">{issue.identifier}</span><span className="line-clamp-2 text-sm font-medium">{issue.title}</span></div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><span>{issue.state.name}</span>{issue.assignee ? <span>· {issue.assignee.name}</span> : null}{issue.linkedThreads.length ? <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">{issue.linkedThreads.length} bb</span> : null}</div>
            </button>
          ))}
          {!issues.length ? <p className="p-8 text-center text-sm text-muted-foreground">No matching issues.</p> : null}
        </div>
      </section>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {selectedIssue ? (
          <div className="mx-auto max-w-3xl space-y-5 p-5">
            <div className="flex items-start gap-4"><div className="min-w-0 flex-1"><p className="text-sm font-medium text-muted-foreground">{selectedIssue.identifier}</p><h1 className="mt-1 text-xl font-semibold leading-7">{selectedIssue.title}</h1></div><Button variant="outline" size="sm" onClick={() => window.open(selectedIssue.url, "_blank", "noopener,noreferrer")}><Icon name="ExternalLink" className="size-4" aria-hidden />Open in Linear</Button></div>
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-4 text-sm md:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Status</p><p className="mt-1 flex items-center gap-1.5 font-medium"><LinearStateIcon type={selectedIssue.state.type} />{selectedIssue.state.name}</p></div>
              <div><p className="text-xs text-muted-foreground">Priority</p><p className="mt-1 flex items-center gap-1.5 font-medium"><Icon name="Target" className="size-4 text-muted-foreground" aria-hidden />{selectedIssue.priorityLabel}</p></div>
              <div><p className="text-xs text-muted-foreground">Assignee</p><p className="mt-1 font-medium">{selectedIssue.assignee?.name ?? "Unassigned"}</p></div>
              <div><p className="text-xs text-muted-foreground">Project</p><p className="mt-1 truncate font-medium">{selectedIssue.project?.name ?? "None"}</p></div>
            </div>
            <section><h2 className="text-sm font-semibold">Description</h2><div className="mt-2 rounded-lg border border-border bg-card p-4 text-sm leading-6 text-foreground">{selectedIssue.description ? <Markdown content={selectedIssue.description} /> : <span className="text-muted-foreground">No description.</span>}</div></section>
            {selectedIssue.labels.length ? <div className="flex flex-wrap gap-2">{selectedIssue.labels.map((label) => <span key={label.id} className="rounded-full border border-border bg-muted px-2 py-1 text-xs">{label.name}</span>)}</div> : null}
            <section className="space-y-3 rounded-lg border border-border bg-card p-4"><div><h2 className="text-sm font-semibold">Status</h2><select className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedIssue.state.id} onChange={(event) => void updateState(event.target.value)}>{(selectedTeam?.states ?? []).map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></div></section>
            <section className="space-y-3 rounded-lg border border-border bg-card p-4">
              <div><h2 className="text-sm font-semibold">bb agent</h2><p className="mt-1 text-sm text-muted-foreground">Start an agent with this issue&apos;s full context and link its thread back here.</p></div>
              <div className="flex flex-wrap gap-2"><select aria-label="bb project for agent" className="h-9 min-w-52 flex-1 rounded-md border border-input bg-background px-3 text-sm" value={bbProjectId} onChange={(event) => setBbProjectId(event.target.value)}>{workspace.bbProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><Button onClick={() => void startAgent()} disabled={starting || !bbProjectId}><Icon name={starting ? "Spinner" : "Play"} className={`size-4 ${starting ? "animate-spin" : ""}`} aria-hidden />{starting ? "Starting…" : "Start agent"}</Button></div>
              {selectedIssue.linkedThreads.length ? <div className="space-y-2 border-t border-border pt-3">{selectedIssue.linkedThreads.map((thread) => <button key={thread.id} className="flex w-full items-center justify-between rounded-md bg-muted px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => navigate.toThread(thread.id)}><span className="flex min-w-0 items-center gap-2"><Icon name={thread.status === "active" ? "Spinner" : "CircleCheck"} className={`size-4 shrink-0 ${thread.status === "active" ? "animate-spin text-primary" : "text-muted-foreground"}`} aria-hidden /><span className="truncate">{thread.title ?? thread.id}</span></span><span className="ml-3 shrink-0 text-xs capitalize text-muted-foreground">{thread.status}</span></button>)}</div> : null}
            </section>
          </div>
        ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select an issue.</div>}
      </main>
      <CreateLinearIssueDialog open={createOpen} onOpenChange={setCreateOpen} teams={workspace.teams} onCreated={load} />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "linear-workspace",
    title: "Linear",
    icon: "Workflow",
    path: "workspace",
    component: LinearPanel,
  });
  app.slots.settingsSection({
    id: "linear-connection",
    title: "Linear connection",
    description: "Use your Linear workspace inside bb.",
    component: LinearSettings,
  });
});
