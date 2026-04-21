export function createRuntimeEngine(config: {
  engine?: "postgres" | "pglite";
  database_path?: string;
  database_url?: string;
}): Promise<unknown>;

export function runRuntimeExtract(
  engine: unknown,
  args: string[],
): Promise<unknown>;

export function runRuntimeEmbed(
  engine: unknown,
  args: string[],
): Promise<unknown>;

export function performRuntimeSync(
  engine: unknown,
  opts: Record<string, unknown>,
): Promise<unknown>;
