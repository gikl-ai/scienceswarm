import { NextResponse } from "next/server";

import {
  buildScienceSwarmCookieClearOptions,
  SCIENCESWARM_LOCAL_AUTH_COOKIE,
  SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE,
} from "@/lib/scienceswarm-local-auth";

export async function POST() {
  const response = NextResponse.json({ signedIn: false });
  response.cookies.set(
    SCIENCESWARM_LOCAL_AUTH_COOKIE,
    "",
    buildScienceSwarmCookieClearOptions(),
  );
  response.cookies.set(
    SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE,
    "",
    buildScienceSwarmCookieClearOptions(),
  );
  return response;
}
