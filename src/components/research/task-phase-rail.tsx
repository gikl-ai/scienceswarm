import type { ChatTaskPhase } from "@/hooks/use-unified-chat";

interface TaskPhaseRailProps {
  phases?: ChatTaskPhase[];
  className?: string;
}

function phaseStyles(status: ChatTaskPhase["status"]) {
  if (status === "completed") {
    return {
      pill: "border-ok/30 bg-ok/10 text-ok",
      dot: "bg-ok",
    };
  }

  if (status === "active") {
    return {
      pill: "border-warn/30 bg-warn/10 text-warn",
      dot: "bg-warn animate-pulse",
    };
  }

  if (status === "failed") {
    return {
      pill: "border-danger/30 bg-danger/10 text-danger",
      dot: "bg-danger",
    };
  }

  return {
    pill: "border-rule bg-sunk text-dim",
    dot: "bg-rule",
  };
}

export function TaskPhaseRail({ phases, className = "" }: TaskPhaseRailProps) {
  if (!phases || phases.length === 0) {
    return null;
  }

  const railClassName = className
    ? `flex flex-wrap gap-2 ${className}`
    : "flex flex-wrap gap-2";

  return (
    <div className={railClassName} aria-label="Task phases">
      {phases.map((phase) => {
        const styles = phaseStyles(phase.status);

        return (
          <span
            key={phase.id}
            aria-label={`${phase.label} (${phase.status})`}
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${styles.pill}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
            {phase.label}
          </span>
        );
      })}
    </div>
  );
}
