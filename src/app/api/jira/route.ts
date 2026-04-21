import {
  listProjects,
  getIssues,
  getIssue,
  createIssue,
  updateIssue,
  transitionIssue,
  addComment,
  syncExperimentsToJira,
  getResearchTimeline,
  checkConnection,
  type JiraIssue,
} from "@/lib/jira";
import { isLocalRequest } from "@/lib/local-guard";

// ── GET handler ───────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  try {
    switch (action) {
      case "health": {
        const connected = await checkConnection();
        return Response.json({ status: connected ? "connected" : "disconnected" });
      }
      case "projects": {
        const projects = await listProjects();
        return Response.json(projects);
      }
      case "issues": {
        const project = searchParams.get("project");
        if (!project) return Response.json({ error: "Missing project parameter" }, { status: 400 });
        const issues = await getIssues(project);
        return Response.json(issues);
      }
      case "issue": {
        const key = searchParams.get("key");
        if (!key) return Response.json({ error: "Missing key parameter" }, { status: 400 });
        const issue = await getIssue(key);
        return Response.json(issue);
      }
      case "timeline": {
        const project = searchParams.get("project");
        if (!project) return Response.json({ error: "Missing project parameter" }, { status: 400 });
        const timeline = await getResearchTimeline(project);
        return Response.json(timeline);
      }
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== "object") {
      return Response.json({ error: "Invalid or missing JSON body" }, { status: 400 });
    }
    const body = raw as Record<string, unknown>;
    const action = body.action as string | undefined;
    if (!action || typeof action !== "string") {
      return Response.json({ error: "Missing action field" }, { status: 400 });
    }

    switch (action) {
      case "create": {
        const projectKey = body.projectKey;
        const summary = body.summary;
        const issueType = body.issueType;
        if (!projectKey || typeof projectKey !== "string" || !summary || typeof summary !== "string" || !issueType || typeof issueType !== "string") {
          return Response.json({ error: "Missing required fields: projectKey, summary, issueType" }, { status: 400 });
        }
        const issue = await createIssue({
          projectKey,
          summary,
          description: body.description as string | undefined,
          issueType,
          priority: body.priority as string | undefined,
          assignee: body.assignee as string | undefined,
          labels: body.labels as string[] | undefined,
          dueDate: body.dueDate as string | undefined,
          storyPoints: body.storyPoints as number | undefined,
        });
        return Response.json(issue);
      }
      case "update": {
        const key = body.key as string;
        if (!key) return Response.json({ error: "Missing key" }, { status: 400 });
        if (!body.fields || typeof body.fields !== "object" || Array.isArray(body.fields)) {
          return Response.json({ error: "fields must be an object" }, { status: 400 });
        }
        await updateIssue(key, body.fields as unknown as Partial<JiraIssue>);
        return Response.json({ success: true });
      }
      case "transition": {
        const key = body.key as string;
        const transition = body.transition as string;
        if (!key || !transition) return Response.json({ error: "Missing key or transition" }, { status: 400 });
        await transitionIssue(key, transition);
        return Response.json({ success: true });
      }
      case "comment": {
        const key = body.key as string;
        const comment = body.comment as string;
        if (!key || !comment) return Response.json({ error: "Missing key or comment" }, { status: 400 });
        await addComment(key, comment);
        return Response.json({ success: true });
      }
      case "sync-experiments": {
        const projectKey = body.projectKey;
        const experiments = body.experiments;
        if (!projectKey || typeof projectKey !== "string" || !Array.isArray(experiments)) return Response.json({ error: "Missing projectKey or experiments must be an array" }, { status: 400 });
        const typedExperiments = experiments as Array<{ name: string; script: string; params?: Record<string, unknown> }>;
        const issues = await syncExperimentsToJira(projectKey, typedExperiments);
        return Response.json(issues);
      }
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
