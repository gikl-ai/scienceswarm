const TEMPLATE_VARIABLE_RE = /\{([^{}]+)\}/g;
const RESERVED_WINDOWS_NAMES = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);

export const PHASE_1_TEMPLATE_VARIABLES = [
  "year",
  "first_author",
  "authors",
  "title",
  "short_title",
  "venue",
  "doi",
  "arxiv_id",
  "pmid",
] as const;

export const PHASE_4_TEMPLATE_VARIABLES = ["topic", "cluster"] as const;

export type RenameTemplateVariable =
  | (typeof PHASE_1_TEMPLATE_VARIABLES)[number]
  | (typeof PHASE_4_TEMPLATE_VARIABLES)[number];

export interface ParsedRenameTemplate {
  ok: true;
  template: string;
  variables: RenameTemplateVariable[];
}

export interface TemplateProblem {
  code:
    | "unknown_variable"
    | "missing_required_field"
    | "unsafe_path"
    | "segment_too_long"
    | "path_too_long"
    | "case_collision"
    | "fallback_not_supported";
  message: string;
  variable?: string;
  segment?: string;
}

export type RenameTemplateParseResult = ParsedRenameTemplate | { ok: false; problems: TemplateProblem[] };
export type RenameTemplateRenderResult = { ok: true; relativePath: string } | { ok: false; problems: TemplateProblem[] };

export type TemplateValues = Partial<Record<RenameTemplateVariable, string | number | string[] | null | undefined>>;

export function parseRenameTemplate(
  template: string,
  options: { enablePhase4Variables?: boolean } = {},
): RenameTemplateParseResult {
  const allowed = new Set<string>(PHASE_1_TEMPLATE_VARIABLES);
  if (options.enablePhase4Variables) {
    for (const variable of PHASE_4_TEMPLATE_VARIABLES) allowed.add(variable);
  }

  const variables: RenameTemplateVariable[] = [];
  const problems: TemplateProblem[] = [];
  TEMPLATE_VARIABLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_VARIABLE_RE.exec(template)) !== null) {
    const rawVariable = match[1]?.trim() ?? "";
    const [variable = ""] = rawVariable.split("|", 1);
    if (rawVariable.includes("|")) {
      problems.push({
        code: "fallback_not_supported",
        message: "Template fallback syntax is not supported yet; every referenced field is required.",
        variable,
      });
      continue;
    }
    if (!allowed.has(variable)) {
      problems.push({
        code: "unknown_variable",
        message: `Unknown template variable: ${variable}`,
        variable,
      });
      continue;
    }
    variables.push(variable as RenameTemplateVariable);
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, template, variables: Array.from(new Set(variables)) };
}

function stringifyTemplateValue(value: string | number | string[] | null | undefined): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return value === null || value === undefined ? "" : String(value);
}

export function sanitizePathSegment(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, " ")
    .replace(/[\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const lower = cleaned.toLowerCase();
  if (!cleaned || cleaned === "." || cleaned === "..") return "untitled";
  if (RESERVED_WINDOWS_NAMES.has(lower)) return `${cleaned}-paper`;
  return cleaned;
}

export function renderRenameTemplate(
  template: string,
  values: TemplateValues,
  options: {
    enablePhase4Variables?: boolean;
    existingDestinations?: string[];
    maxSegmentLength?: number;
    maxPathLength?: number;
  } = {},
): RenameTemplateRenderResult {
  const parsed = parseRenameTemplate(template, options);
  if (!parsed.ok) return parsed;

  const problems: TemplateProblem[] = [];
  let rendered = template.replace(TEMPLATE_VARIABLE_RE, (_full, rawVariable: string) => {
    const variable = rawVariable.trim() as RenameTemplateVariable;
    const rawValue = stringifyTemplateValue(values[variable]);
    if (!rawValue) {
      problems.push({
        code: "missing_required_field",
        message: `Missing required template field: ${variable}`,
        variable,
      });
    }
    return sanitizePathSegment(rawValue);
  });

  if (problems.length > 0) return { ok: false, problems };

  const rawSegments = rendered.split(/[\\/]+/).filter(Boolean);
  const segments = rawSegments.map(sanitizePathSegment);
  const maxSegmentLength = options.maxSegmentLength ?? 120;
  const maxPathLength = options.maxPathLength ?? 240;

  for (const segment of segments) {
    if (segment.length > maxSegmentLength) {
      problems.push({
        code: "segment_too_long",
        message: `Path segment is too long: ${segment.slice(0, 30)}`,
        segment,
      });
    }
  }

  rendered = segments.join("/");
  if (!rendered || rendered.includes("../") || rendered.startsWith("../") || rendered.startsWith("/")) {
    problems.push({ code: "unsafe_path", message: "Rendered path escapes the library root." });
  }
  if (rendered.length > maxPathLength) {
    problems.push({ code: "path_too_long", message: "Rendered path exceeds the configured maximum length." });
  }

  const caseFolded = rendered.toLowerCase();
  if ((options.existingDestinations ?? []).some((destination) => destination.toLowerCase() === caseFolded)) {
    problems.push({
      code: "case_collision",
      message: "Rendered path collides with an existing destination on case-insensitive filesystems.",
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, relativePath: rendered };
}
