import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

type BridgeAction =
  | "create_readme"
  | "skip_existing_readme"
  | "skip_blocked_canonical_home";

interface LegacyHomeDefinition {
  legacyHome: string;
  canonicalHome: string;
  label: string;
}

interface ManualReviewHomeDefinition {
  legacyHome: string;
  label: string;
}

export interface LegacyResearchHomePreview {
  legacyHome: string;
  label: string;
  pageCount: number;
  samplePages: string[];
}

export interface ResearchLayoutBridgePreview {
  canonicalHome: string;
  legacyHomes: LegacyResearchHomePreview[];
  legacyPageCount: number;
  canonicalHomeExists: boolean;
  canonicalHomeBlocked: boolean;
  readmePath: string;
  readmeExists: boolean;
  proposedAction: BridgeAction;
}

export interface ResearchLayoutMigrationPreview {
  generatedAt: string;
  legacyHomesDetected: number;
  legacyPagesDetected: number;
  bridgeableHomes: number;
  homes: ResearchLayoutBridgePreview[];
  unmappedLegacyHomes: LegacyResearchHomePreview[];
  warnings: string[];
}

export interface ResearchLayoutBridgeResult {
  generatedAt: string;
  preview: ResearchLayoutMigrationPreview;
  createdReadmes: number;
  skippedReadmes: number;
  createdPaths: string[];
  skippedPaths: string[];
  warnings: string[];
}

const BRIDGEABLE_LEGACY_HOMES: readonly LegacyHomeDefinition[] = [
  {
    legacyHome: "concepts",
    canonicalHome: "topics",
    label: "Legacy concept pages",
  },
  {
    legacyHome: "wiki/concepts",
    canonicalHome: "topics",
    label: "Legacy wiki concept pages",
  },
  {
    legacyHome: "wiki/entities/papers",
    canonicalHome: "papers",
    label: "Legacy paper pages",
  },
  {
    legacyHome: "wiki/entities/datasets",
    canonicalHome: "datasets",
    label: "Legacy dataset pages",
  },
  {
    legacyHome: "wiki/entities/people",
    canonicalHome: "people",
    label: "Legacy people pages",
  },
  {
    legacyHome: "wiki/entities/projects",
    canonicalHome: "projects",
    label: "Legacy project pages",
  },
  {
    legacyHome: "wiki/entities/tools",
    canonicalHome: "methods",
    label: "Legacy tool pages",
  },
  {
    legacyHome: "wiki/protocols",
    canonicalHome: "methods",
    label: "Legacy protocol pages",
  },
  {
    legacyHome: "wiki/hypotheses",
    canonicalHome: "hypotheses",
    label: "Legacy hypothesis pages",
  },
  {
    legacyHome: "wiki/originals",
    canonicalHome: "originals",
    label: "Legacy original synthesis pages",
  },
] as const;

const MANUAL_REVIEW_LEGACY_HOMES: readonly ManualReviewHomeDefinition[] = [
  {
    legacyHome: "wiki/experiments",
    label: "Legacy experiment pages",
  },
] as const;

export function previewResearchLayoutMigration(
  brainRoot: string,
): ResearchLayoutMigrationPreview {
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];
  const grouped = new Map<string, ResearchLayoutBridgePreview>();
  let legacyHomesDetected = 0;
  let legacyPagesDetected = 0;

  for (const definition of BRIDGEABLE_LEGACY_HOMES) {
    const preview = previewLegacyHome(brainRoot, definition.legacyHome, definition.label);
    if (!preview) continue;

    legacyHomesDetected += 1;
    legacyPagesDetected += preview.pageCount;

    const existing = grouped.get(definition.canonicalHome);
    if (existing) {
      existing.legacyHomes.push(preview);
      existing.legacyPageCount += preview.pageCount;
      continue;
    }

    const canonicalAbsolutePath = join(brainRoot, definition.canonicalHome);
    const canonicalHomeExists = existsSync(canonicalAbsolutePath);
    const canonicalHomeBlocked =
      canonicalHomeExists && !statSync(canonicalAbsolutePath).isDirectory();
    const readmePath = join(definition.canonicalHome, "README.md").replace(/\\/g, "/");
    const readmeExists = existsSync(join(brainRoot, readmePath));

    grouped.set(definition.canonicalHome, {
      canonicalHome: definition.canonicalHome,
      legacyHomes: [preview],
      legacyPageCount: preview.pageCount,
      canonicalHomeExists,
      canonicalHomeBlocked,
      readmePath,
      readmeExists,
      proposedAction: canonicalHomeBlocked
        ? "skip_blocked_canonical_home"
        : readmeExists
          ? "skip_existing_readme"
          : "create_readme",
    });
  }

  const homes = Array.from(grouped.values()).sort((a, b) =>
    a.canonicalHome.localeCompare(b.canonicalHome),
  );

  for (const home of homes) {
    if (home.canonicalHomeBlocked) {
      warnings.push(
        `${home.canonicalHome}/ exists as a non-directory path, so ScienceSwarm cannot create ${home.readmePath}.`,
      );
      continue;
    }
    if (home.readmeExists) {
      warnings.push(
        `${home.readmePath} already exists, so the bridge helper will leave it unchanged.`,
      );
      continue;
    }
    if (home.canonicalHomeExists) {
      warnings.push(
        `${home.canonicalHome}/ already exists; the bridge helper will only add ${home.readmePath} and will not move legacy pages.`,
      );
    }
  }

  const unmappedLegacyHomes = MANUAL_REVIEW_LEGACY_HOMES
    .map((definition) => previewLegacyHome(brainRoot, definition.legacyHome, definition.label))
    .filter((item): item is LegacyResearchHomePreview => item != null);

  for (const preview of unmappedLegacyHomes) {
    legacyHomesDetected += 1;
    legacyPagesDetected += preview.pageCount;
    warnings.push(
      `${preview.legacyHome} has no first-class research-first bridge yet; leave those pages in place and review them manually.`,
    );
  }

  return {
    generatedAt,
    legacyHomesDetected,
    legacyPagesDetected,
    bridgeableHomes: homes.length,
    homes,
    unmappedLegacyHomes,
    warnings,
  };
}

export function applyResearchLayoutBridge(
  brainRoot: string,
  preview: ResearchLayoutMigrationPreview = previewResearchLayoutMigration(brainRoot),
): ResearchLayoutBridgeResult {
  const createdPaths: string[] = [];
  const skippedPaths: string[] = [];
  const warnings = [...preview.warnings];

  for (const home of preview.homes) {
    if (home.proposedAction !== "create_readme") {
      skippedPaths.push(home.readmePath);
      continue;
    }

    const canonicalAbsolutePath = join(brainRoot, home.canonicalHome);
    const readmeAbsolutePath = join(brainRoot, home.readmePath);
    try {
      mkdirSync(canonicalAbsolutePath, { recursive: true });
      writeFileSync(
        readmeAbsolutePath,
        renderBridgeReadme(home, preview.generatedAt.slice(0, 10)),
        {
          encoding: "utf-8",
          flag: "wx",
        },
      );
      createdPaths.push(home.readmePath);
    } catch (error) {
      skippedPaths.push(home.readmePath);
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped ${home.readmePath}: ${message}`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    preview,
    createdReadmes: createdPaths.length,
    skippedReadmes: skippedPaths.length,
    createdPaths,
    skippedPaths,
    warnings,
  };
}

function previewLegacyHome(
  brainRoot: string,
  legacyHome: string,
  label: string,
): LegacyResearchHomePreview | null {
  const files = collectMarkdownPages(brainRoot, legacyHome);
  if (files.length === 0) {
    return null;
  }

  return {
    legacyHome,
    label,
    pageCount: files.length,
    samplePages: files.slice(0, 5),
  };
}

function collectMarkdownPages(brainRoot: string, relativeDir: string): string[] {
  const absoluteDir = join(brainRoot, relativeDir);
  if (!existsSync(absoluteDir)) {
    return [];
  }

  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(brainRoot);
  } catch {
    return [];
  }

  let dirRealPath: string;
  try {
    dirRealPath = realpathSync(absoluteDir);
  } catch {
    return [];
  }
  if (!isPathInside(rootRealPath, dirRealPath)) {
    return [];
  }

  const files: string[] = [];
  const stack = [absoluteDir];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    let currentRealPath: string;
    try {
      currentRealPath = realpathSync(current);
    } catch {
      continue;
    }
    if (!isPathInside(rootRealPath, currentRealPath) || visited.has(currentRealPath)) {
      continue;
    }
    visited.add(currentRealPath);

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(current, entry);
      let realPath: string;
      try {
        realPath = realpathSync(fullPath);
      } catch {
        continue;
      }
      if (!isPathInside(rootRealPath, realPath)) {
        continue;
      }
      const stat = statSync(realPath);
      if (stat.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!/\.mdx?$/i.test(entry)) {
        continue;
      }
      files.push(relative(brainRoot, fullPath).replace(/\\/g, "/"));
    }
  }

  return files.sort();
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function renderBridgeReadme(
  home: ResearchLayoutBridgePreview,
  date: string,
): string {
  const legacyHomes = home.legacyHomes.map((item) => item.legacyHome);
  const samplePages = home.legacyHomes.flatMap((item) => item.samplePages).slice(0, 5);

  return [
    "---",
    `date: ${date}`,
    "type: note",
    "para: resources",
    "tags:",
    "  - research-layout",
    "  - migration",
    "  - legacy-home",
    `preferred_home: ${home.canonicalHome}`,
    "legacy_homes:",
    ...legacyHomes.map((item) => `  - ${item}`),
    "---",
    "",
    `# ${toTitle(home.canonicalHome)}`,
    "",
    "ScienceSwarm created this bridge README while upgrading the brain to the research-first layout.",
    "",
    "No files were moved.",
    "Existing legacy pages remain readable in:",
    ...legacyHomes.map((item) => `- \`${item}/\``),
    "",
    `Use \`${home.canonicalHome}/\` for new research-first pages.`,
    "",
    "Representative legacy pages:",
    ...samplePages.map((item) => `- \`${item}\``),
    "",
  ].join("\n");
}

function toTitle(segment: string): string {
  return segment
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
