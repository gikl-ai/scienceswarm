"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────

interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description?: string;
  status: string;
  priority: string;
  assignee?: string;
  reporter?: string;
  issueType: string;
  labels: string[];
  dueDate?: string;
  created: string;
  updated: string;
  sprint?: string;
  storyPoints?: number;
}

interface JiraProject {
  id: string;
  key: string;
  name: string;
}

type ViewMode = "board" | "sprint" | "timeline";
type FilterType = "" | "Task" | "Bug" | "Story" | "Experiment" | "Paper" | "Analysis" | "Review";
type FilterStatus = "" | "To Do" | "In Progress" | "In Review" | "Done";

const KANBAN_COLUMNS = ["To Do", "In Progress", "In Review", "Done"] as const;

const ISSUE_TYPE_ICONS: Record<string, string> = {
  Experiment: "\u{1F9EA}",
  Paper: "\u{1F4DD}",
  Analysis: "\u{1F4CA}",
  Review: "\u{1F50D}",
  Task: "\u{2705}",
  Bug: "\u{1F41B}",
  Story: "\u{1F4D6}",
};

const PRIORITY_ICONS: Record<string, string> = {
  Highest: "\u{1F534}",
  High: "\u{1F7E0}",
  Medium: "\u{1F7E1}",
  Low: "\u{1F535}",
  Lowest: "\u{26AA}",
};

// ── Component ─────────────────────────────────────────────────

export function JiraPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("board");
  const [selectedIssue, setSelectedIssue] = useState<JiraIssue | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [draggedIssue, setDraggedIssue] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Filters
  const [filterType, setFilterType] = useState<FilterType>("");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("");
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterLabel, setFilterLabel] = useState("");

  // Create form
  const [newSummary, setNewSummary] = useState("");
  const [newType, setNewType] = useState("Task");
  const [newPriority, setNewPriority] = useState("Medium");
  const [newAssignee, setNewAssignee] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [newLabels, setNewLabels] = useState("");
  const [newDescription, setNewDescription] = useState("");

  // ── API calls ───────────────────────────────────────────────

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/jira?action=health");
      const data = await res.json() as { status: string };
      setConnected(data.status === "connected");
      if (data.status === "connected") {
        await loadProjects();
      }
    } catch {
      setConnected(false);
    }
  }, []);

  const loadProjects = async () => {
    try {
      const res = await fetch("/api/jira?action=projects");
      const data = await res.json() as JiraProject[];
      setProjects(Array.isArray(data) ? data : []);
    } catch {
      setProjects([]);
    }
  };

  const loadIssues = useCallback(async (projectKey: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jira?action=issues&project=${projectKey}`);
      const data = await res.json() as JiraIssue[] | { error: string };
      if ("error" in data) throw new Error(data.error);
      setIssues(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load issues");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCreateIssue = async () => {
    if (!newSummary.trim() || !selectedProject) return;
    setLoading(true);
    try {
      const res = await fetch("/api/jira", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          projectKey: selectedProject,
          summary: newSummary,
          description: newDescription || undefined,
          issueType: newType,
          priority: newPriority,
          assignee: newAssignee || undefined,
          dueDate: newDueDate || undefined,
          labels: newLabels ? newLabels.split(",").map((l) => l.trim()) : undefined,
        }),
      });
      const data = await res.json() as JiraIssue | { error: string };
      if ("error" in data) throw new Error(data.error);
      setIssues((prev) => [data, ...prev]);
      resetCreateForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setLoading(false);
    }
  };

  const handleTransition = async (issueKey: string, targetStatus: string) => {
    try {
      const res = await fetch("/api/jira", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "transition", key: issueKey, transition: targetStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setIssues((prev) =>
        prev.map((i) => (i.key === issueKey ? { ...i, status: targetStatus } : i))
      );
      setSelectedIssue((prev) =>
        prev?.key === issueKey ? { ...prev, status: targetStatus } : prev
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transition failed");
    }
  };

  const handleAddComment = async () => {
    if (!selectedIssue || !commentText.trim()) return;
    try {
      const res = await fetch("/api/jira", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "comment", key: selectedIssue.key, comment: commentText }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setCommentText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add comment");
    }
  };

  const handleSyncExperiments = async () => {
    if (!selectedProject) return;
    setSyncing(true);
    try {
      const experiments = [
        { name: "Baseline partition on small graphs", script: "experiments/exp_001_baseline/run.py" },
        { name: "Optimized SAT-based verification", script: "experiments/exp_002_optimized/run.py" },
        { name: "Large graph enumeration", script: "code/main.py --large" },
        { name: "Counterexample search n=12", script: "code/partition.py --search --n=12" },
      ];
      const res = await fetch("/api/jira", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync-experiments", projectKey: selectedProject, experiments }),
      });
      const data = await res.json() as JiraIssue[] | { error: string };
      if ("error" in data) throw new Error(data.error);
      setIssues((prev) => [...data, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const resetCreateForm = () => {
    setShowCreateForm(false);
    setNewSummary("");
    setNewType("Task");
    setNewPriority("Medium");
    setNewAssignee("");
    setNewDueDate("");
    setNewLabels("");
    setNewDescription("");
  };

  const quickCreate = (type: string, prefix: string) => {
    setShowCreateForm(true);
    setNewType(type);
    setNewSummary(prefix);
  };

  // ── Effects ─────────────────────────────────────────────────

  useEffect(() => { checkHealth(); }, [checkHealth]);

  useEffect(() => {
    if (selectedProject) loadIssues(selectedProject);
  }, [selectedProject, loadIssues]);

  // ── Filtering ───────────────────────────────────────────────

  const filteredIssues = issues.filter((issue) => {
    if (filterType && issue.issueType !== filterType) return false;
    if (filterStatus && issue.status !== filterStatus) return false;
    if (filterAssignee && issue.assignee !== filterAssignee) return false;
    if (filterLabel && !issue.labels.includes(filterLabel)) return false;
    return true;
  });

  const assignees = [...new Set(issues.map((i) => i.assignee).filter(Boolean))] as string[];
  const allLabels = [...new Set(issues.flatMap((i) => i.labels))];

  // ── Drag and Drop ──────────────────────────────────────────

  const handleDragStart = (issueKey: string) => {
    setDraggedIssue(issueKey);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (targetColumn: string) => {
    if (draggedIssue) {
      handleTransition(draggedIssue, targetColumn);
      setDraggedIssue(null);
    }
  };

  // ── Render helpers ──────────────────────────────────────────

  const renderIssueCard = (issue: JiraIssue) => (
    <div
      key={issue.key}
      draggable
      onDragStart={() => handleDragStart(issue.key)}
      onClick={() => setSelectedIssue(issue)}
      className={`p-3 bg-white border-2 rounded-lg cursor-pointer transition-all hover:border-accent hover:shadow-sm ${
        selectedIssue?.key === issue.key ? "border-accent ring-2 ring-accent/20" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-mono font-bold text-accent">{issue.key}</span>
        <span className="text-xs" title={issue.priority}>
          {PRIORITY_ICONS[issue.priority] || "\u{26AA}"}
        </span>
      </div>
      <p className="text-xs font-medium text-foreground leading-snug mb-2">{issue.summary}</p>
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <span className="text-xs" title={issue.issueType}>
            {ISSUE_TYPE_ICONS[issue.issueType] || "\u{2705}"}
          </span>
          {issue.labels.slice(0, 2).map((label) => (
            <span key={label} className="text-[9px] bg-surface border border-border rounded px-1.5 py-0.5 text-muted">
              {label}
            </span>
          ))}
        </div>
        {issue.assignee && (
          <div className="w-5 h-5 rounded-full bg-accent/10 text-accent text-[9px] font-bold flex items-center justify-center" title={issue.assignee}>
            {issue.assignee.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      {issue.storyPoints !== undefined && (
        <div className="mt-1.5">
          <span className="text-[9px] bg-accent/10 text-accent rounded-full px-1.5 py-0.5 font-medium">{issue.storyPoints} pts</span>
        </div>
      )}
    </div>
  );

  // ── Disconnected State ──────────────────────────────────────

  if (connected === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted">Checking Jira connection...</div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="w-12 h-12 rounded-full bg-red-50 border-2 border-red-200 flex items-center justify-center mx-auto mb-4">
            <span className="text-xl">{"\u{1F512}"}</span>
          </div>
          <h3 className="font-semibold text-foreground mb-2">Jira Not Connected</h3>
          <p className="text-sm text-muted mb-4">
            Configure your Jira credentials to enable task tracking and project scheduling.
          </p>
          <div className="bg-surface border-2 border-border rounded-lg p-4 text-left text-xs font-mono space-y-1">
            <p className="text-muted"># Add to .env</p>
            <p>JIRA_URL=https://yourorg.atlassian.net</p>
            <p>JIRA_EMAIL=you@example.com</p>
            <p>JIRA_API_TOKEN=your_api_token</p>
          </div>
          <button
            onClick={checkHealth}
            className="mt-4 text-xs bg-accent text-white rounded-lg px-4 py-2 hover:bg-accent-hover transition-colors"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  // ── Connected State ─────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b-2 border-border bg-white flex-shrink-0">
          <div className="flex items-center gap-3">
            {/* Connection status */}
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-[10px] font-medium text-green-700">Connected</span>
            </div>

            {/* Project selector */}
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              className="text-xs bg-surface border-2 border-border rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-accent"
            >
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>{p.key} - {p.name}</option>
              ))}
            </select>

            {/* View mode */}
            <div className="flex bg-surface border-2 border-border rounded-lg overflow-hidden">
              {(["board", "sprint", "timeline"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`text-[10px] font-medium px-2.5 py-1.5 transition-colors ${
                    viewMode === mode ? "bg-accent text-white" : "text-muted hover:text-foreground"
                  }`}
                >
                  {mode === "board" ? "Board" : mode === "sprint" ? "Sprint" : "Timeline"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Quick-create buttons */}
            <button
              onClick={() => quickCreate("Task", "[Experiment] ")}
              className="text-[10px] bg-purple-50 text-purple-700 border border-purple-200 rounded-lg px-2.5 py-1.5 hover:bg-purple-100 transition-colors"
            >
              {"\u{1F9EA}"} New Experiment
            </button>
            <button
              onClick={() => quickCreate("Task", "[Paper] ")}
              className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-100 transition-colors"
            >
              {"\u{1F4DD}"} New Paper Section
            </button>
            <button
              onClick={() => quickCreate("Task", "[Review] ")}
              className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 rounded-lg px-2.5 py-1.5 hover:bg-amber-100 transition-colors"
            >
              {"\u{1F50D}"} New Review Task
            </button>
            <button
              onClick={() => setShowCreateForm(true)}
              className="text-xs bg-accent text-white rounded-lg px-3 py-1.5 hover:bg-accent-hover transition-colors font-medium"
            >
              + Create Issue
            </button>
            <button
              onClick={handleSyncExperiments}
              disabled={syncing || !selectedProject}
              className="text-[10px] bg-surface border-2 border-border rounded-lg px-2.5 py-1.5 text-muted hover:text-foreground hover:border-accent transition-colors disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync Experiments"}
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface/30 flex-shrink-0">
          <span className="text-[10px] font-medium text-muted mr-1">Filter:</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as FilterType)}
            className="text-[10px] bg-white border border-border rounded px-2 py-1 focus:outline-none focus:border-accent"
          >
            <option value="">All Types</option>
            {Object.keys(ISSUE_TYPE_ICONS).map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
            className="text-[10px] bg-white border border-border rounded px-2 py-1 focus:outline-none focus:border-accent"
          >
            <option value="">All Statuses</option>
            {KANBAN_COLUMNS.map((col) => (
              <option key={col} value={col}>{col}</option>
            ))}
          </select>
          <select
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            className="text-[10px] bg-white border border-border rounded px-2 py-1 focus:outline-none focus:border-accent"
          >
            <option value="">All Assignees</option>
            {assignees.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <select
            value={filterLabel}
            onChange={(e) => setFilterLabel(e.target.value)}
            className="text-[10px] bg-white border border-border rounded px-2 py-1 focus:outline-none focus:border-accent"
          >
            <option value="">All Labels</option>
            {allLabels.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          {(filterType || filterStatus || filterAssignee || filterLabel) && (
            <button
              onClick={() => { setFilterType(""); setFilterStatus(""); setFilterAssignee(""); setFilterLabel(""); }}
              className="text-[10px] text-accent hover:underline"
            >
              Clear filters
            </button>
          )}
          <span className="text-[10px] text-muted ml-auto">
            {filteredIssues.length} issue{filteredIssues.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* Error display */}
        {error && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">{"\u2715"}</button>
          </div>
        )}

        {/* Board View */}
        {viewMode === "board" && (
          <div className="flex-1 overflow-x-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center h-full text-sm text-muted">Loading issues...</div>
            ) : !selectedProject ? (
              <div className="flex items-center justify-center h-full text-sm text-muted">Select a project to view the board</div>
            ) : (
              <div className="flex gap-4 h-full min-w-0">
                {KANBAN_COLUMNS.map((column) => {
                  const columnIssues = filteredIssues.filter((i) => i.status === column);
                  return (
                    <div
                      key={column}
                      className="flex-1 min-w-[240px] flex flex-col"
                      onDragOver={handleDragOver}
                      onDrop={() => handleDrop(column)}
                    >
                      <div className="flex items-center justify-between mb-3 px-1">
                        <h3 className="text-xs font-bold text-muted uppercase tracking-wider">{column}</h3>
                        <span className="text-[10px] bg-surface border border-border rounded-full px-2 py-0.5 text-muted font-medium">
                          {columnIssues.length}
                        </span>
                      </div>
                      <div className="flex-1 space-y-2 overflow-y-auto pb-4">
                        {columnIssues.map(renderIssueCard)}
                        {columnIssues.length === 0 && (
                          <div className="text-[10px] text-muted text-center py-8 border-2 border-dashed border-border rounded-lg">
                            No issues
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Sprint View */}
        {viewMode === "sprint" && (
          <div className="flex-1 overflow-y-auto p-4">
            {!selectedProject ? (
              <div className="flex items-center justify-center h-full text-sm text-muted">Select a project to view sprints</div>
            ) : (
              <div>
                <div className="mb-4">
                  <h3 className="text-sm font-bold text-foreground mb-1">Current Sprint</h3>
                  <div className="w-full bg-surface border-2 border-border rounded-full h-3 overflow-hidden">
                    {(() => {
                      const pct = filteredIssues.length > 0
                        ? Math.round((filteredIssues.filter((i) => i.status === "Done").length / filteredIssues.length) * 100)
                        : 0;
                      return (
                        <div
                          className={`h-full bg-accent rounded-full transition-all w-[var(--progress)]`}
                          {...{ style: { "--progress": `${pct}%` } as React.CSSProperties }}
                        />
                      );
                    })()}
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-[10px] text-muted">
                      {filteredIssues.filter((i) => i.status === "Done").length} / {filteredIssues.length} done
                    </span>
                    <span className="text-[10px] text-muted">
                      {filteredIssues.length > 0
                        ? Math.round((filteredIssues.filter((i) => i.status === "Done").length / filteredIssues.length) * 100)
                        : 0}%
                    </span>
                  </div>
                </div>
                <div className="space-y-2">
                  {filteredIssues.map((issue) => (
                    <div
                      key={issue.key}
                      onClick={() => setSelectedIssue(issue)}
                      className="flex items-center gap-3 p-3 bg-white border-2 border-border rounded-lg cursor-pointer hover:border-accent transition-colors"
                    >
                      <span className="text-xs">{ISSUE_TYPE_ICONS[issue.issueType] || "\u{2705}"}</span>
                      <span className="text-[10px] font-mono font-bold text-accent">{issue.key}</span>
                      <span className="text-xs text-foreground flex-1">{issue.summary}</span>
                      <span className={`text-[9px] font-medium px-2 py-0.5 rounded-full ${
                        issue.status === "Done" ? "bg-green-50 text-green-700 border border-green-200" :
                        issue.status === "In Progress" ? "bg-blue-50 text-blue-700 border border-blue-200" :
                        issue.status === "In Review" ? "bg-amber-50 text-amber-700 border border-amber-200" :
                        "bg-surface text-muted border border-border"
                      }`}>
                        {issue.status}
                      </span>
                      {issue.assignee && (
                        <div className="w-5 h-5 rounded-full bg-accent/10 text-accent text-[9px] font-bold flex items-center justify-center" title={issue.assignee}>
                          {issue.assignee.charAt(0).toUpperCase()}
                        </div>
                      )}
                      {issue.storyPoints !== undefined && (
                        <span className="text-[9px] bg-accent/10 text-accent rounded-full px-1.5 py-0.5 font-medium">{issue.storyPoints}</span>
                      )}
                    </div>
                  ))}
                  {filteredIssues.length === 0 && (
                    <div className="text-sm text-muted text-center py-12">No issues in current sprint</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Timeline View */}
        {viewMode === "timeline" && (
          <div className="flex-1 overflow-y-auto p-4">
            {!selectedProject ? (
              <div className="flex items-center justify-center h-full text-sm text-muted">Select a project to view timeline</div>
            ) : (
              <div>
                <h3 className="text-sm font-bold text-foreground mb-4">Research Timeline</h3>
                <div className="relative">
                  {/* Timeline line */}
                  <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />

                  <div className="space-y-3">
                    {filteredIssues
                      .filter((i) => i.dueDate)
                      .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
                      .map((issue) => (
                        <div key={issue.key} className="flex items-start gap-3 pl-2">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-1 z-10 ${
                            issue.status === "Done" ? "bg-green-500" :
                            issue.status === "In Progress" ? "bg-blue-500" :
                            "bg-surface border-2 border-border"
                          }`}>
                            {issue.status === "Done" && <span className="text-white text-[8px]">{"\u2713"}</span>}
                          </div>
                          <div
                            onClick={() => setSelectedIssue(issue)}
                            className="flex-1 p-3 bg-white border-2 border-border rounded-lg cursor-pointer hover:border-accent transition-colors"
                          >
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs">{ISSUE_TYPE_ICONS[issue.issueType] || "\u{2705}"}</span>
                                <span className="text-[10px] font-mono font-bold text-accent">{issue.key}</span>
                              </div>
                              <span className="text-[10px] text-muted">{issue.dueDate}</span>
                            </div>
                            <p className="text-xs font-medium text-foreground">{issue.summary}</p>
                            <div className="flex items-center gap-2 mt-1.5">
                              {issue.labels.map((label) => (
                                <span key={label} className="text-[9px] bg-surface border border-border rounded px-1.5 py-0.5 text-muted">
                                  {label}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      ))}
                    {filteredIssues.filter((i) => i.dueDate).length === 0 && (
                      <div className="text-sm text-muted text-center py-12 ml-8">No issues with due dates</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right panel: Issue detail or Create form */}
      {(selectedIssue || showCreateForm) && (
        <div className="w-80 flex-shrink-0 border-l-2 border-border bg-white overflow-y-auto">
          {showCreateForm ? (
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-foreground">Create Issue</h3>
                <button onClick={resetCreateForm} className="text-muted hover:text-foreground text-sm">{"\u2715"}</button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-medium text-muted uppercase tracking-wider block mb-1">Summary</label>
                  <input
                    value={newSummary}
                    onChange={(e) => setNewSummary(e.target.value)}
                    className="w-full text-xs bg-surface border-2 border-border rounded-lg px-3 py-2 focus:outline-none focus:border-accent"
                    placeholder="Issue summary..."
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted uppercase tracking-wider block mb-1">Description</label>
                  <textarea
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    rows={3}
                    className="w-full text-xs bg-surface border-2 border-border rounded-lg px-3 py-2 focus:outline-none focus:border-accent resize-none"
                    placeholder="Optional description..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted uppercase tracking-wider block mb-1">Type</label>
                    <select
                      value={newType}
                      onChange={(e) => setNewType(e.target.value)}
                      className="w-full text-xs bg-surface border-2 border-border rounded-lg px-2.5 py-2 focus:outline-none focus:border-accent"
                    >
                      <option value="Task">Task</option>
                      <option value="Bug">Bug</option>
                      <option value="Story">Story</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted uppercase tracking-wider block mb-1">Priority</label>
                    <select
                      value={newPriority}
                      onChange={(e) => setNewPriority(e.target.value)}
                      className="w-full text-xs bg-surface border-2 border-border rounded-lg px-2.5 py-2 focus:outline-none focus:border-accent"
                    >
                      <option value="Highest">Highest</option>
                      <option value="High">High</option>
                      <option value="Medium">Medium</option>
                      <option value="Low">Low</option>
                      <option value="Lowest">Lowest</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted uppercase tracking-wider block mb-1">Assignee</label>
                  <input
                    value={newAssignee}
                    onChange={(e) => setNewAssignee(e.target.value)}
                    className="w-full text-xs bg-surface border-2 border-border rounded-lg px-3 py-2 focus:outline-none focus:border-accent"
                    placeholder="Jira account ID..."
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted uppercase tracking-wider block mb-1">Due Date</label>
                  <input
                    type="date"
                    value={newDueDate}
                    onChange={(e) => setNewDueDate(e.target.value)}
                    className="w-full text-xs bg-surface border-2 border-border rounded-lg px-3 py-2 focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted uppercase tracking-wider block mb-1">Labels (comma-separated)</label>
                  <input
                    value={newLabels}
                    onChange={(e) => setNewLabels(e.target.value)}
                    className="w-full text-xs bg-surface border-2 border-border rounded-lg px-3 py-2 focus:outline-none focus:border-accent"
                    placeholder="experiment, analysis..."
                  />
                </div>
                <button
                  onClick={handleCreateIssue}
                  disabled={!newSummary.trim() || !selectedProject || loading}
                  className="w-full text-xs bg-accent text-white rounded-lg px-3 py-2.5 hover:bg-accent-hover transition-colors font-medium disabled:opacity-50"
                >
                  {loading ? "Creating..." : "Create Issue"}
                </button>
              </div>
            </div>
          ) : selectedIssue ? (
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-mono font-bold text-accent">{selectedIssue.key}</span>
                <button onClick={() => setSelectedIssue(null)} className="text-muted hover:text-foreground text-sm">{"\u2715"}</button>
              </div>

              <h3 className="text-sm font-bold text-foreground mb-3">{selectedIssue.summary}</h3>

              <div className="space-y-3 mb-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-muted uppercase">Status</span>
                  <span className={`text-[10px] font-medium px-2.5 py-0.5 rounded-full ${
                    selectedIssue.status === "Done" ? "bg-green-50 text-green-700 border border-green-200" :
                    selectedIssue.status === "In Progress" ? "bg-blue-50 text-blue-700 border border-blue-200" :
                    selectedIssue.status === "In Review" ? "bg-amber-50 text-amber-700 border border-amber-200" :
                    "bg-surface text-muted border border-border"
                  }`}>
                    {selectedIssue.status}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-muted uppercase">Type</span>
                  <span className="text-xs">
                    {ISSUE_TYPE_ICONS[selectedIssue.issueType] || "\u{2705}"} {selectedIssue.issueType}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-muted uppercase">Priority</span>
                  <span className="text-xs">
                    {PRIORITY_ICONS[selectedIssue.priority] || "\u{26AA}"} {selectedIssue.priority}
                  </span>
                </div>
                {selectedIssue.assignee && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-muted uppercase">Assignee</span>
                    <span className="text-xs">{selectedIssue.assignee}</span>
                  </div>
                )}
                {selectedIssue.dueDate && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-muted uppercase">Due Date</span>
                    <span className="text-xs">{selectedIssue.dueDate}</span>
                  </div>
                )}
                {selectedIssue.storyPoints !== undefined && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-muted uppercase">Story Points</span>
                    <span className="text-xs font-medium">{selectedIssue.storyPoints}</span>
                  </div>
                )}
                {selectedIssue.sprint && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-muted uppercase">Sprint</span>
                    <span className="text-xs">{selectedIssue.sprint}</span>
                  </div>
                )}
              </div>

              {selectedIssue.labels.length > 0 && (
                <div className="mb-4">
                  <span className="text-[10px] font-medium text-muted uppercase block mb-1.5">Labels</span>
                  <div className="flex flex-wrap gap-1">
                    {selectedIssue.labels.map((label) => (
                      <span key={label} className="text-[9px] bg-surface border border-border rounded px-2 py-0.5 text-muted">
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedIssue.description && (
                <div className="mb-4">
                  <span className="text-[10px] font-medium text-muted uppercase block mb-1.5">Description</span>
                  <p className="text-xs text-foreground leading-relaxed bg-surface/50 border border-border rounded-lg p-3">
                    {selectedIssue.description}
                  </p>
                </div>
              )}

              {/* Transition buttons */}
              <div className="mb-4">
                <span className="text-[10px] font-medium text-muted uppercase block mb-1.5">Move to</span>
                <div className="flex flex-wrap gap-1">
                  {KANBAN_COLUMNS.filter((col) => col !== selectedIssue.status).map((col) => (
                    <button
                      key={col}
                      onClick={() => {
                        handleTransition(selectedIssue.key, col);
                      }}
                      className="text-[10px] bg-surface border border-border rounded px-2.5 py-1 text-muted hover:text-accent hover:border-accent transition-colors"
                    >
                      {col}
                    </button>
                  ))}
                </div>
              </div>

              {/* Add comment */}
              <div>
                <span className="text-[10px] font-medium text-muted uppercase block mb-1.5">Add Comment</span>
                <textarea
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  rows={3}
                  className="w-full text-xs bg-surface border-2 border-border rounded-lg px-3 py-2 focus:outline-none focus:border-accent resize-none mb-2"
                  placeholder="Write a comment..."
                />
                <button
                  onClick={handleAddComment}
                  disabled={!commentText.trim()}
                  className="w-full text-xs bg-accent text-white rounded-lg px-3 py-2 hover:bg-accent-hover transition-colors font-medium disabled:opacity-50"
                >
                  Comment
                </button>
              </div>

              <div className="mt-4 pt-4 border-t border-border">
                <div className="text-[9px] text-muted space-y-0.5">
                  <p>Created: {selectedIssue.created}</p>
                  <p>Updated: {selectedIssue.updated}</p>
                  {selectedIssue.reporter && <p>Reporter: {selectedIssue.reporter}</p>}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
