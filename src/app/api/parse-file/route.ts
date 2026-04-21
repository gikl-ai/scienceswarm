import { parseFile } from "@/lib/file-parser";
import { isLocalRequest } from "@/lib/local-guard";

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await parseFile(buffer, file.name);

    return Response.json({ ...result, name: file.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse error";
    console.error("File parse error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
