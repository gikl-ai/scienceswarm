import { redirect } from "next/navigation";
import "katex/dist/katex.min.css";

import { Sidebar } from "@/components/sidebar";
import { ResizableLayout } from "@/components/resizable-layout";
import { getConfigStatus } from "@/lib/setup/config-status";
import { migrateEnvLocalOnce } from "@/lib/setup/env-migration";

/**
 * Dashboard layout (server component).
 *
 * Guards the entire `/dashboard/*` subtree: if `.env` does not
 * currently hold a valid config, redirect the user to `/setup` before
 * rendering anything else. This is the deterministic server-component
 * equivalent of a middleware redirect, but without the edge-runtime
 * `fs` problem — `getConfigStatus` needs Node APIs to read the
 * on-disk `.env`.
 *
 * Failure policy
 *   If `getConfigStatus` throws for any reason, we redirect to
 *   `/setup` rather than render the dashboard. The reasoning: a
 *   broken status probe is always safer to surface on the setup page,
 *   which can also display the error to the user, than to render a
 *   dashboard that will fail later in more confusing ways. We log a
 *   short message (no secrets) for debugging.
 *
 * Runtime env handling
 *   `getConfigStatus` re-reads `.env` every call so setup edits become
 *   visible without a restart. For this dashboard guard only, we also
 *   allow explicit runtime env values to satisfy readiness when the app
 *   is deployed or launched by a test harness that supplies config via
 *   the process manager instead of writing `.env`.
 *
 * Why force-dynamic
 *   `.env` on disk can change any time after build — in fact
 *   the `/setup` flow's whole purpose is to write to it at runtime.
 *   Without `force-dynamic`, Next.js may prerender this layout at
 *   build time, which would bake the build-time ready state into
 *   production and never re-evaluate. We explicitly opt into
 *   per-request rendering so the redirect reflects the current
 *   filesystem state.
 */
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // One-time idempotent migration from `.env.local` → `.env`. Safe to
  // call on every request: the module guards itself with a sentinel
  // file so repeat invocations are cheap no-ops. We swallow errors
  // here because we still want to render the dashboard (or redirect
  // to /setup) even if migration fails — the user will see the
  // `.env.local` still on disk and can recover manually.
  try {
    await migrateEnvLocalOnce(process.cwd());
  } catch (err) {
    console.warn(
      "[dashboard-redirect] env migration failed (non-blocking)",
      err instanceof Error ? err.name : "unknown_error",
    );
  }

  let ready = false;
  try {
    const status = await getConfigStatus(process.cwd(), {
      includeRuntimeEnv: true,
    });
    ready = status.ready;
  } catch (err) {
    // Privacy: log only a fixed category plus `err.name`. Never log
    // `err.message` or the whole error object — Node I/O errors
    // routinely embed the absolute path of the failing file (e.g.
    // `ENOENT: no such file, open '/Users/alice/…/.env.local'`),
    // which reveals the user's home-directory layout. `err.name`
    // (the constructor name: `Error`, `TypeError`, a subclass
    // sentinel) is sufficient to grep for this entry in server
    // output without spilling filesystem details.
    console.warn(
      "[dashboard-redirect] config probe failed; redirecting to /setup",
      err instanceof Error ? err.name : "unknown_error",
    );
    redirect("/setup");
  }

  if (!ready) {
    redirect("/setup");
  }

  return (
    <ResizableLayout sidebar={<Sidebar />}>
      {children}
    </ResizableLayout>
  );
}
