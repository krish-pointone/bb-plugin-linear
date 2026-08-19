import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const linearViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  shared: z.boolean(),
});
const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  priority: z.number().int(),
  priorityLabel: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  dueDate: z.string().nullable(),
  state: z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string() }),
  team: z.object({ id: z.string(), name: z.string(), key: z.string() }),
  assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
  project: z.object({ id: z.string(), name: z.string() }).nullable(),
  labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
  linkedThreads: z.array(
    z.object({ id: z.string(), status: z.string(), title: z.string().nullable() }),
  ),
});
const linearTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  states: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
});
const bbProjectSchema = z.object({ id: z.string(), name: z.string(), kind: z.string() });

export const rpcContract = defineRpcContract({
  linearStatus: {
    input: z.null(),
    output: z.object({ configured: z.boolean(), viewerName: z.string().nullable() }),
  },
  getLinearWorkspace: {
    input: z.object({ viewId: z.string().nullable() }).strict(),
    output: z.object({
      configured: z.boolean(),
      viewerName: z.string().nullable(),
      views: z.array(linearViewSchema),
      issues: z.array(linearIssueSchema),
      teams: z.array(linearTeamSchema),
      bbProjects: z.array(bbProjectSchema),
    }),
  },
  createLinearIssue: {
    input: z.object({
      teamId: z.string().min(1),
      title: z.string().min(1).max(255),
      description: z.string().max(100_000),
    }).strict(),
    output: z.object({ issue: linearIssueSchema.omit({ linkedThreads: true }) }),
  },
  updateLinearIssueState: {
    input: z.object({ issueId: z.string(), stateId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  startLinearAgent: {
    input: z.object({ issueId: z.string(), bbProjectId: z.string() }).strict(),
    output: z.object({ threadId: z.string() }),
  },
});

type GraphQlResponse<T> = { data?: T; errors?: Array<{ message: string }> };
type RawLinearIssue = {
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
  labels: { nodes: Array<{ id: string; name: string; color: string }> };
};

const ISSUE_FIELDS = `
  id identifier title description priority priorityLabel url updatedAt dueDate
  state { id name type color }
  team { id name key }
  assignee { id name }
  project { id name }
  labels { nodes { id name color } }
`;

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    linearApiKey: {
      type: "string",
      label: "Linear personal API key",
      description: "Created in Linear → Settings → Security & access → Personal API keys.",
      secret: true,
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS linear_thread_links (
      issue_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (issue_id, thread_id)
    )`,
  ]);
  const listLinks = db.prepare(
    "SELECT issue_id, thread_id FROM linear_thread_links ORDER BY created_at DESC",
  );
  const insertLink = db.prepare(
    "INSERT OR IGNORE INTO linear_thread_links (issue_id, thread_id, created_at) VALUES (?, ?, ?)",
  );

  async function linearGraphql<T>(query: string, variables: Record<string, unknown> = {}) {
    const { linearApiKey } = await settings.get();
    if (!linearApiKey) {
      throw new Error("Linear is not configured. Add an API key in Linear plugin settings.");
    }
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: linearApiKey },
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await response.json()) as GraphQlResponse<T>;
    if (!response.ok || payload.errors?.length) {
      throw new Error(
        payload.errors?.map(({ message }) => message).join("; ") ||
          `Linear request failed (${response.status})`,
      );
    }
    if (!payload.data) throw new Error("Linear returned no data.");
    return payload.data;
  }

  async function enrichIssues(issues: RawLinearIssue[]) {
    const links = listLinks.all() as Array<{ issue_id: string; thread_id: string }>;
    const linksByIssue = new Map<string, string[]>();
    for (const link of links) {
      const rows = linksByIssue.get(link.issue_id) ?? [];
      rows.push(link.thread_id);
      linksByIssue.set(link.issue_id, rows);
    }
    const threadIds = [...new Set(links.map(({ thread_id }) => thread_id))];
    const threadRows = await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          return [threadId, { id: thread.id, status: thread.status, title: thread.title }] as const;
        } catch {
          return null;
        }
      }),
    );
    const threadById = new Map(threadRows.filter((row) => row !== null));
    return issues.map((issue) => ({
      ...issue,
      labels: issue.labels.nodes,
      linkedThreads: (linksByIssue.get(issue.id) ?? [])
        .map((id) => threadById.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
    }));
  }

  bb.rpc.register(rpcContract, {
    async linearStatus() {
      const { linearApiKey } = await settings.get();
      if (!linearApiKey) return { configured: false, viewerName: null };
      const data = await linearGraphql<{ viewer: { name: string } }>(
        `query LinearViewer { viewer { name } }`,
      );
      return { configured: true, viewerName: data.viewer.name };
    },

    async getLinearWorkspace({ viewId }) {
      const [{ linearApiKey }, bbProjects] = await Promise.all([
        settings.get(),
        bb.sdk.projects.list({ includePersonal: true }),
      ]);
      const projectRows = bbProjects.map(({ id, name, kind }) => ({ id, name, kind }));
      if (!linearApiKey) {
        return {
          configured: false,
          viewerName: null,
          views: [],
          issues: [],
          teams: [],
          bbProjects: projectRows,
        };
      }

      type WorkspaceData = {
        viewer: { name: string };
        customViews: { nodes: Array<z.infer<typeof linearViewSchema>> };
        teams: {
          nodes: Array<{
            id: string;
            name: string;
            key: string;
            states: { nodes: Array<{ id: string; name: string; type: string }> };
          }>;
        };
        issues?: { nodes: RawLinearIssue[] };
        customView?: { issues: { nodes: RawLinearIssue[] } };
      };
      const issueSelection = viewId
        ? `customView(id: $viewId) { issues(first: 100, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`
        : `issues(first: 100, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }`;
      const data = await linearGraphql<WorkspaceData>(
        `query LinearWorkspace${viewId ? "($viewId: String!)" : ""} {
          viewer { name }
          customViews(first: 100, filter: { modelName: { eq: "Issue" } }) {
            nodes { id name description color shared }
          }
          teams(first: 100) {
            nodes { id name key states { nodes { id name type } } }
          }
          ${issueSelection}
        }`,
        viewId ? { viewId } : {},
      );
      const rawIssues = data.customView?.issues.nodes ?? data.issues?.nodes ?? [];
      return {
        configured: true,
        viewerName: data.viewer.name,
        views: data.customViews.nodes,
        issues: await enrichIssues(rawIssues),
        teams: data.teams.nodes.map((team) => ({ ...team, states: team.states.nodes })),
        bbProjects: projectRows,
      };
    },

    async createLinearIssue({ teamId, title, description }) {
      const data = await linearGraphql<{
        issueCreate: { success: boolean; issue: RawLinearIssue | null };
      }>(
        `mutation CreateLinearIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
        }`,
        { input: { teamId, title, description: description || undefined } },
      );
      if (!data.issueCreate.success || !data.issueCreate.issue) {
        throw new Error("Linear did not create the issue.");
      }
      return {
        issue: {
          ...data.issueCreate.issue,
          labels: data.issueCreate.issue.labels.nodes,
        },
      };
    },

    async updateLinearIssueState({ issueId, stateId }) {
      const data = await linearGraphql<{ issueUpdate: { success: boolean } }>(
        `mutation UpdateLinearIssueState($issueId: String!, $stateId: String!) {
          issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
        }`,
        { issueId, stateId },
      );
      if (!data.issueUpdate.success) throw new Error("Linear did not update the issue.");
      return { ok: true as const };
    },

    async startLinearAgent({ issueId, bbProjectId }) {
      const data = await linearGraphql<{ issue: RawLinearIssue }>(
        `query LinearIssueForAgent($issueId: String!) {
          issue(id: $issueId) { ${ISSUE_FIELDS} }
        }`,
        { issueId },
      );
      const issue = data.issue;
      const prompt = [
        `Work on Linear issue ${issue.identifier}: ${issue.title}`,
        "",
        issue.description ?? "No description was provided.",
        "",
        `Linear URL: ${issue.url}`,
        `Current status: ${issue.state.name}`,
        issue.project ? `Linear project: ${issue.project.name}` : null,
        "",
        "Implement or investigate the issue in the selected bb project. Keep the Kanban card current as work progresses. Report the outcome, files changed, validation performed, and any blockers.",
      ].filter((line): line is string => line !== null).join("\n");
      const thread = await bb.sdk.threads.spawn({
        projectId: bbProjectId,
        environment: { type: "project-default" },
        title: `[${issue.identifier}] ${issue.title}`,
        prompt,
      });
      insertLink.run(issue.id, thread.id, Date.now());
      bb.realtime.publish("linear-changed", { issueId: issue.id, threadId: thread.id });
      return { threadId: thread.id };
    },
  });

  bb.log.info("Linear workspace loaded");
}
