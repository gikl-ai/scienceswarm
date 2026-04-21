import type { ChatTaskPhase } from "@/hooks/use-unified-chat";

interface TaskPhaseRailProps {
  phases?: ChatTaskPhase[];
  className?: string;
}

function phaseStyles(status: ChatTaskPhase["status"]) {
  if (status === "completed") {
    return {
      pill: "border-emerald-200 bg-emerald-50 text-emerald-700",
      dot: "bg-emerald-500",
    };
  }

  if (status === "active") {
    return {
      pill: "border-amber-200 bg-amber-50 text-amber-700",
      dot: "bg-amber-500 animate-pulse",
    };
  }

  if (status === "failed") {
    return {
      pill: "border-red-200 bg-red-50 text-red-700",
      dot: "bg-red-500",
    };
  }

  return {
    pill: "border-stone-200 bg-stone-50 text-stone-500",
    dot: "bg-stone-300",
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
