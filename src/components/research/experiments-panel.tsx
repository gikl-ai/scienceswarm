"use client";

export interface Experiment {
  id: string;
  name: string;
  script: string;
  description?: string;
  language?: "python" | "shell";
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  duration?: string;
  metrics?: Record<string, number | string>;
  figures?: { name: string; type: string }[];
  logs?: string;
}

const statusConfig: Record<string, { color: string; icon: string }> = {
  pending: { color: "bg-zinc-100 text-zinc-600", icon: "○" },
  running: { color: "bg-blue-50 text-blue-600", icon: "◉" },
  completed: { color: "bg-green-50 text-green-700", icon: "✓" },
  failed: { color: "bg-red-50 text-red-600", icon: "✕" },
};

export function ExperimentsPanel({
  experiments,
  onSelect,
  onRun,
  onUseInChat,
}: {
  experiments: Experiment[];
  onSelect: (exp: Experiment) => void;
  onRun: () => void;
  onUseInChat?: (exp: Experiment) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b-2 border-border">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">Experiments</h2>
          <button
            onClick={onRun}
            className="text-sm bg-accent text-white px-3 py-1.5 rounded-lg hover:bg-accent-hover transition-colors font-medium"
          >
            + New Run
          </button>
        </div>
        <div className="flex gap-4 text-xs text-muted">
          <span>{experiments.filter((e) => e.status === "completed").length} completed</span>
          <span>{experiments.filter((e) => e.status === "running").length} running</span>
          <span>{experiments.filter((e) => e.status === "failed").length} failed</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {experiments.length === 0 ? (
          <div className="p-8 text-center text-muted text-sm">
            No experiments yet.
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {experiments.map((exp) => {
              const sc = statusConfig[exp.status];
              return (
                <div
                  key={exp.id}
                  className="p-4 hover:bg-surface/50 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(exp)}
                    className="w-full text-left"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-mono font-medium ${sc.color}`}>
                          {sc.icon} {exp.status}
                        </span>
                        <h3 className="text-sm font-semibold">{exp.name}</h3>
                      </div>
                      {exp.duration && (
                        <span className="text-[10px] text-muted font-mono">{exp.duration}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted font-mono mb-1">
                      {exp.language === "shell" ? "💻" : "🐍"} {exp.script}
                    </p>
                    {exp.description && (
                      <p className="text-xs text-muted leading-relaxed mb-2">{exp.description}</p>
                    )}

                    {/* Metrics */}
                    {exp.metrics && Object.keys(exp.metrics).length > 0 && (
                      <div className="flex gap-3 flex-wrap mb-2">
                        {Object.entries(exp.metrics).map(([key, val]) => (
                          <div key={key} className="bg-surface rounded-lg px-2.5 py-1 border border-border">
                            <span className="text-[10px] text-muted block">{key}</span>
                            <span className="text-xs font-bold font-mono">{val}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Figures */}
                    {exp.figures && exp.figures.length > 0 && (
                      <div className="flex gap-2 mt-2">
                        {exp.figures.map((fig) => (
                          <div
                            key={fig.name}
                            className="w-16 h-12 bg-surface border-2 border-border rounded flex items-center justify-center text-[10px] text-muted"
                          >
                            🖼️ {fig.type}
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                  {onUseInChat && (
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        onClick={() => onUseInChat(exp)}
                        className="rounded-lg border border-border bg-white px-3 py-1.5 text-[11px] font-semibold text-foreground transition-colors hover:border-accent hover:text-accent"
                      >
                        Use in chat
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
