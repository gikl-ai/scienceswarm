import type { ReactNode } from "react";

export function StatusDot({ status }: { status: "ok" | "warn" | "off" }) {
  const color =
    status === "ok"
      ? "bg-ok"
      : status === "warn"
        ? "bg-warn"
        : "bg-dim";
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />;
}

export function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="bg-surface border-2 border-border rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
