// ── Jira REST API Client for Research Project Management ──────

const JIRA_URL = process.env.JIRA_URL; // e.g., https://yourorg.atlassian.net
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;

// ── Types ─────────────────────────────────────────────────────

export interface JiraIssue {
  id: string;
  key: string; // e.g., RES-42
  summary: string;
  description?: string;
  status: string;
  priority: string;
  assignee?: string;
  reporter?: string;
  issueType: string; // Task, Story, Bug, Experiment, Paper
  labels: string[];
  dueDate?: string;
  created: string;
  updated: string;
  sprint?: string;
  storyPoints?: number;
  customFields?: Record<string, unknown>;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface CreateIssueParams {
  projectKey: string;
  summary: string;
  description?: string;
  issueType: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  dueDate?: string;
  storyPoints?: number;
}

export interface Sprint {
  id: number;
  name: string;
  state: string; // active, closed, future
  startDate?: string;
  endDate?: string;
  goal?: string;
}

export interface Board {
  id: number;
  name: string;
  type: string;
  projectKey: string;
}

interface JiraTransition {
  id: string;
  name: string;
}

// ── Helpers ───────────────────────────────────────────────────

function getAuthHeaders(): Record<string, string> {
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_TOKEN) {
    throw new Error("Jira credentials not configured. Set JIRA_URL, JIRA_EMAIL, and JIRA_API_TOKEN.");
  }
  const encoded = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function apiUrl(path: string): string {
  if (!JIRA_URL) throw new Error("JIRA_URL not configured");
  const base = JIRA_URL.replace(/\/$/, "");
  return `${base}${path}`;
}

async function jiraFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: { ...getAuthHeaders(), ...(options.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API error ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

interface JiraIssueResponse {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: string;
    status: { name: string };
    priority: { name: string };
    assignee?: { displayName: string };
    reporter?: { displayName: string };
    issuetype: { name: string };
    labels: string[];
    duedate?: string;
    created: string;
    updated: string;
    customfield_10016?: number; // story points (Jira Cloud)
    sprint?: { name: string };
    [key: string]: unknown;
  };
}

function mapIssue(raw: JiraIssueResponse): JiraIssue {
  const f = raw.fields;
  return {
    id: raw.id,
    key: raw.key,
    summary: f.summary,
    description: typeof f.description === "string"
      ? f.description
      : f.description && typeof f.description === "object"
        ? JSON.stringify(f.description)
        : undefined,
    status: f.status.name,
    priority: f.priority.name,
    assignee: f.assignee?.displayName,
    reporter: f.reporter?.displayName,
    issueType: f.issuetype.name,
    labels: f.labels ?? [],
    dueDate: f.duedate ?? undefined,
    created: f.created,
    updated: f.updated,
    sprint: f.sprint?.name,
    storyPoints: f.customfield_10016 ?? undefined,
  };
}

// ── Core API ──────────────────────────────────────────────────

export async function checkConnection(): Promise<boolean> {
  try {
    await jiraFetch("/rest/api/3/myself");
    return true;
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<JiraProject[]> {
  const data = await jiraFetch<Array<{ id: string; key: string; name: string }>>("/rest/api/3/project");
  return data.map((p) => ({ id: p.id, key: p.key, name: p.name }));
}

export async function getIssues(projectKey: string, jql?: string): Promise<JiraIssue[]> {
  const sanitized = projectKey.replace(/[^a-zA-Z0-9_]/g, "");
  const query = jql || `project = "${sanitized}" ORDER BY updated DESC`;
  const encoded = encodeURIComponent(query);
  const data = await jiraFetch<{ issues: JiraIssueResponse[] }>(
    `/rest/api/3/search?jql=${encoded}&maxResults=100&fields=summary,description,status,priority,assignee,reporter,issuetype,labels,duedate,created,updated,customfield_10016,sprint`
  );
  return data.issues.map(mapIssue);
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  const raw = await jiraFetch<JiraIssueResponse>(`/rest/api/3/issue/${issueKey}`);
  return mapIssue(raw);
}

export async function createIssue(params: CreateIssueParams): Promise<JiraIssue> {
  const fields: Record<string, unknown> = {
    project: { key: params.projectKey },
    summary: params.summary,
    issuetype: { name: params.issueType },
  };
  if (params.description) fields.description = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: params.description }] }] };
  if (params.priority) fields.priority = { name: params.priority };
  if (params.assignee) fields.assignee = { accountId: params.assignee };
  if (params.labels) fields.labels = params.labels;
  if (params.dueDate) fields.duedate = params.dueDate;
  if (params.storyPoints !== undefined) fields.customfield_10016 = params.storyPoints;

  const result = await jiraFetch<{ id: string; key: string }>("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({ fields }),
  });
  return getIssue(result.key);
}

export async function updateIssue(issueKey: string, fields: Partial<JiraIssue>): Promise<void> {
  const update: Record<string, unknown> = {};
  if (fields.summary) update.summary = fields.summary;
  if (fields.description) update.description = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: fields.description }] }] };
  if (fields.priority) update.priority = { name: fields.priority };
  if (fields.labels) update.labels = fields.labels;
  if (fields.dueDate) update.duedate = fields.dueDate;
  if (fields.storyPoints !== undefined) update.customfield_10016 = fields.storyPoints;

  await jiraFetch(`/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields: update }),
  });
}

export async function transitionIssue(issueKey: string, transitionName: string): Promise<void> {
  const data = await jiraFetch<{ transitions: JiraTransition[] }>(`/rest/api/3/issue/${issueKey}/transitions`);
  const transition = data.transitions.find((t) => t.name.toLowerCase() === transitionName.toLowerCase());
  if (!transition) {
    const available = data.transitions.map((t) => t.name).join(", ");
    throw new Error(`Transition "${transitionName}" not found. Available: ${available}`);
  }
  await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
}

export async function addComment(issueKey: string, comment: string): Promise<void> {
  await jiraFetch(`/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }] },
    }),
  });
}

export async function getBoard(projectKey: string): Promise<Board> {
  const data = await jiraFetch<{ values: Array<{ id: number; name: string; type: string; location?: { projectKey: string } }> }>(
    `/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=1`
  );
  if (data.values.length === 0) throw new Error(`No board found for project ${projectKey}`);
  const b = data.values[0];
  return { id: b.id, name: b.name, type: b.type, projectKey };
}

export async function getSprints(boardId: string): Promise<Sprint[]> {
  const data = await jiraFetch<{ values: Array<{ id: number; name: string; state: string; startDate?: string; endDate?: string; goal?: string }> }>(
    `/rest/agile/1.0/board/${boardId}/sprint?state=active,future`
  );
  return data.values.map((s) => ({
    id: s.id,
    name: s.name,
    state: s.state,
    startDate: s.startDate,
    endDate: s.endDate,
    goal: s.goal,
  }));
}

// ── Research-Specific Helpers ─────────────────────────────────

interface ExperimentInput {
  name: string;
  script: string;
  params?: Record<string, unknown>;
}

export async function createExperimentIssue(
  projectKey: string,
  name: string,
  script: string,
  params?: Record<string, unknown>
): Promise<JiraIssue> {
  const description = [
    `Script: ${script}`,
    params ? `Parameters: ${JSON.stringify(params, null, 2)}` : "",
  ].filter(Boolean).join("\n\n");

  return createIssue({
    projectKey,
    summary: `[Experiment] ${name}`,
    description,
    issueType: "Task",
    labels: ["experiment", "automated"],
  });
}

export async function createPaperTask(
  projectKey: string,
  section: string,
  description: string
): Promise<JiraIssue> {
  return createIssue({
    projectKey,
    summary: `[Paper] ${section}`,
    description,
    issueType: "Task",
    labels: ["paper", "writing"],
  });
}

export async function syncExperimentsToJira(
  projectKey: string,
  experiments: ExperimentInput[]
): Promise<JiraIssue[]> {
  const sanitized = projectKey.replace(/[^a-zA-Z0-9_]/g, "");
  const existing = await getIssues(
    projectKey,
    `project = "${sanitized}" AND labels = experiment ORDER BY created DESC`
  );
  const existingSummaries = new Set(existing.map((i) => i.summary));

  const results: JiraIssue[] = [];
  for (const exp of experiments) {
    const summary = `[Experiment] ${exp.name}`;
    if (existingSummaries.has(summary)) continue;
    const issue = await createExperimentIssue(projectKey, exp.name, exp.script, exp.params);
    existingSummaries.add(summary);
    results.push(issue);
  }
  return results;
}

export async function getResearchTimeline(projectKey: string): Promise<JiraIssue[]> {
  const sanitized = projectKey.replace(/[^a-zA-Z0-9_]/g, "");
  return getIssues(projectKey, `project = "${sanitized}" AND duedate IS NOT EMPTY ORDER BY duedate ASC`);
}
