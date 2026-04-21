import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

function appendSearchParams(basePath: string, params: SearchParams): string {
  const nextParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      nextParams.set(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => nextParams.append(key, entry));
    }
  }

  const query = nextParams.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export default async function CritiqueRedirectPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  redirect(appendSearchParams("/dashboard/reasoning", await searchParams ?? {}));
}
