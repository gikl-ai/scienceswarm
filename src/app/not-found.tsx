import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-6 px-4 py-12">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-muted">
          PAGE NOT FOUND
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-foreground">
          This route is not part of ScienceSwarm.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          If you are setting up for the first time, start with OpenClaw and
          Telegram. If your runtime is already connected, open the study
          workspace and import research data to build your brain.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Link
          href="/setup"
          className="rounded-xl border border-border bg-white px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface"
        >
          Connect OpenClaw
        </Link>
        <Link
          href="/dashboard/study"
          className="rounded-xl border border-border bg-white px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface"
        >
          Open workspace
        </Link>
        <Link
          href="/dashboard/settings"
          className="rounded-xl border border-border bg-white px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface"
        >
          Check settings
        </Link>
      </div>
    </main>
  );
}
