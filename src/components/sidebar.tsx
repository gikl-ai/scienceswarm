"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type SVGProps } from "react";
import {
  Brain,
  CalendarCheck,
  Chats,
  GearSix,
  House,
  type Icon,
} from "@phosphor-icons/react";

type IconLikeProps = {
  size?: number | string;
  color?: string;
  weight?: string;
} & Omit<SVGProps<SVGSVGElement>, "color">;

// ScienceSwarm brand mark: a stylized "S" formed by a swarm of connected
// network nodes, echoing the company logo on scienceswarm.ai.
const ScienceSwarmLogo: Icon = (({ size = 24, color, weight: _weight, ...rest }: IconLikeProps) => {
  const sz = typeof size === "number" ? size : Number.parseFloat(String(size)) || 24;
  return (
    <svg
      viewBox="0 0 24 24"
      width={sz}
      height={sz}
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <line x1="17" y1="4" x2="9" y2="5" />
      <line x1="9" y1="5" x2="5" y2="9" />
      <line x1="5" y1="9" x2="12" y2="12" />
      <line x1="12" y1="12" x2="19" y2="15" />
      <line x1="19" y1="15" x2="15" y2="19" />
      <line x1="15" y1="19" x2="7" y2="20" />
      <line x1="9" y1="5" x2="12" y2="12" />
      <line x1="12" y1="12" x2="15" y2="19" />
      <circle cx="17" cy="4" r="1.6" fill="currentColor" />
      <circle cx="9" cy="5" r="2" fill="currentColor" />
      <circle cx="5" cy="9" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      <circle cx="19" cy="15" r="1.4" fill="currentColor" />
      <circle cx="15" cy="19" r="2" fill="currentColor" />
      <circle cx="7" cy="20" r="1.6" fill="currentColor" />
    </svg>
  );
}) as unknown as Icon;

// Two-network glyph (big mesh + small mesh) representing reasoning audit:
// the model on the left producing a smaller derived trace on the right.
const ReasoningIcon: Icon = (({ size = 24, color, weight: _weight, ...rest }: IconLikeProps) => {
  const sz = typeof size === "number" ? size : Number.parseFloat(String(size)) || 24;
  return (
    <svg
      viewBox="0 0 24 24"
      width={sz}
      height={sz}
      fill="none"
      stroke={color ?? "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <line x1="3" y1="4" x2="9" y2="3" />
      <line x1="3" y1="4" x2="2.5" y2="11" />
      <line x1="9" y1="3" x2="11" y2="11" />
      <line x1="9" y1="3" x2="2.5" y2="11" />
      <line x1="2.5" y1="11" x2="6" y2="17" />
      <line x1="11" y1="11" x2="6" y2="17" />
      <line x1="9" y1="3" x2="6" y2="17" />
      <circle cx="3" cy="4" r="1.3" fill="white" />
      <circle cx="9" cy="3" r="1.3" fill="white" />
      <circle cx="2.5" cy="11" r="1.3" fill="white" />
      <circle cx="11" cy="11" r="1.3" fill="white" />
      <circle cx="6" cy="17" r="1.3" fill="white" />
      <line x1="16" y1="13" x2="21" y2="13" />
      <line x1="16" y1="13" x2="18.5" y2="18" />
      <line x1="21" y1="13" x2="18.5" y2="18" />
      <circle cx="16" cy="13" r="0.9" fill="currentColor" />
      <circle cx="21" cy="13" r="0.9" fill="currentColor" />
      <circle cx="18.5" cy="18" r="0.9" fill="currentColor" />
    </svg>
  );
}) as unknown as Icon;
import {
  buildGbrainHrefForSlug,
  buildRoutinesHrefForSlug,
  buildWorkspaceHrefForSlug,
  readLastProjectSlug,
  safeProjectSlugOrNull,
  subscribeToLastProjectSlug,
} from "@/lib/project-navigation";

type NavItem = {
  label: string;
  href: string;
  Icon: Icon;
};

const LABEL_THRESHOLD = 100;

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const asideRef = useRef<HTMLElement>(null);
  const [showLabels, setShowLabels] = useState(false);
  const scopedProjectSlug = safeProjectSlugOrNull(searchParams.get("name"));
  const rememberedProjectSlug = useSyncExternalStore(
    subscribeToLastProjectSlug,
    readLastProjectSlug,
    () => null,
  );
  const projectSlug = scopedProjectSlug ?? rememberedProjectSlug;
  const nav: NavItem[] = [
    // Workspace is the single project surface: sidebar lists projects,
    // clicking one opens its directory + chat. /dashboard is now only
    // the "create a new project" form, reached via the + Add menu.
    { label: "Workspace", href: buildWorkspaceHrefForSlug(projectSlug), Icon: Chats },
    { label: "Routines", href: buildRoutinesHrefForSlug(projectSlug), Icon: CalendarCheck },
    { label: "gbrain", href: buildGbrainHrefForSlug(projectSlug), Icon: Brain },
    { label: "Reasoning", href: "/dashboard/reasoning", Icon: ReasoningIcon },
  ];

  // Watch the parent's data attribute to decide whether to show labels.
  // The ResizableLayout sets data-sidebar-show-labels on the wrapper div.
  // We also observe the aside's own width via ResizeObserver as a fallback.
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setShowLabels(entry.contentRect.width >= LABEL_THRESHOLD);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const linkClass = (active: boolean) =>
    `flex items-center ${showLabels ? "justify-start gap-2 px-2" : "justify-center"} w-full py-2.5 rounded-lg transition-colors ${
      active
        ? "bg-accent/10 text-accent"
        : "text-muted hover:text-foreground hover:bg-surface"
    }`;

  return (
    <aside
      ref={asideRef}
      className="w-full h-full flex-shrink-0 bg-white flex flex-col items-center overflow-hidden"
    >
      <div className="h-14 flex items-center justify-center border-b-2 border-border w-full flex-shrink-0">
        <Link href="/" title="ScienceSwarm" className={`text-foreground flex items-center ${showLabels ? "gap-2" : ""}`}>
          <ScienceSwarmLogo size={26} />
          {showLabels && <span className="text-xs font-bold truncate">ScienceSwarm</span>}
        </Link>
      </div>
      <nav className="flex-1 py-3 space-y-1 w-full px-1.5">
        {nav.map(({ label, href, Icon: ItemIcon }) => {
          const reasoningActive =
            pathname?.startsWith("/dashboard/reasoning") ||
            pathname?.startsWith("/dashboard/critique");
          const gbrainActive = pathname?.startsWith("/dashboard/gbrain");
          const routinesActive = pathname?.startsWith("/dashboard/routines");
          const active =
            pathname === href ||
            (href.startsWith("/dashboard/project") &&
              (pathname?.startsWith("/dashboard/project") || pathname === "/dashboard")) ||
            (href.startsWith("/dashboard/routines") && routinesActive) ||
            (href.startsWith("/dashboard/gbrain") && gbrainActive) ||
            (href === "/dashboard/reasoning" && reasoningActive);
          return (
            <Link key={href} href={href} className={linkClass(active)} title={label}>
              <ItemIcon size={22} weight="duotone" />
              {showLabels && <span className="text-xs font-medium truncate">{label}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="py-3 border-t-2 border-border w-full px-1.5 space-y-1">
        <Link
          href="/dashboard/settings"
          className={linkClass(!!pathname?.startsWith("/dashboard/settings"))}
          title="Settings"
        >
          <GearSix size={22} weight="duotone" />
          {showLabels && <span className="text-xs font-medium truncate">Settings</span>}
        </Link>
        <Link href="/" className={linkClass(false)} title="Home">
          <House size={22} weight="duotone" />
          {showLabels && <span className="text-xs font-medium truncate">Home</span>}
        </Link>
      </div>
    </aside>
  );
}
