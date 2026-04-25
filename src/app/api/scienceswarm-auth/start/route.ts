import { NextResponse } from "next/server";

import { isLocalRequest } from "@/lib/local-guard";
import { getScienceSwarmLocalRequestOrigin } from "@/lib/scienceswarm-auth";
import {
  buildScienceSwarmLocalSignInUrl,
  createScienceSwarmLocalAuthState,
} from "@/lib/scienceswarm-local-auth";

function getLocalReturnPath(request: Request, localOrigin: string): string {
  const referer = request.headers.get("referer")?.trim();
  if (!referer) return "/dashboard/reasoning";

  try {
    const url = new URL(referer);
    if (url.origin !== localOrigin) return "/dashboard/reasoning";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/dashboard/reasoning";
  }
}

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const localOrigin = getScienceSwarmLocalRequestOrigin(request);
    const state = await createScienceSwarmLocalAuthState({
      localOrigin,
      returnPath: getLocalReturnPath(request, localOrigin),
    });
    const authUrl = buildScienceSwarmLocalSignInUrl({
      localOrigin,
      state,
    });

    return NextResponse.json({ authUrl, state });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "ScienceSwarm sign-in could not start.",
      },
      { status: 400 },
    );
  }
}
