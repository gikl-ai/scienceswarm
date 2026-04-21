import { NextResponse } from "next/server";

import {
  buildScienceSwarmCookieClearOptions,
  readScienceSwarmLocalAuthFromRequest,
  SCIENCESWARM_LOCAL_AUTH_COOKIE,
} from "@/lib/scienceswarm-local-auth";
import { SCIENCESWARM_CRITIQUE_SIGN_IN_REQUIRED_MESSAGE } from "@/lib/scienceswarm-auth";

export async function GET(request: Request) {
  const response = NextResponse.json({
    detail: SCIENCESWARM_CRITIQUE_SIGN_IN_REQUIRED_MESSAGE,
    expiresAt: null,
    signedIn: false,
  });

  const session = await readScienceSwarmLocalAuthFromRequest(request);
  if (!session) {
    response.cookies.set(
      SCIENCESWARM_LOCAL_AUTH_COOKIE,
      "",
      buildScienceSwarmCookieClearOptions(),
    );
    return response;
  }

  return NextResponse.json({
    detail: "ScienceSwarm account connected.",
    expiresAt: session.expiresAt,
    signedIn: true,
  });
}
