import { NextResponse } from "next/server";

import { getScienceSwarmLocalRequestOrigin } from "@/lib/scienceswarm-auth";
import {
  buildScienceSwarmLocalSignInUrl,
  createScienceSwarmLocalAuthState,
} from "@/lib/scienceswarm-local-auth";

export async function POST(request: Request) {
  try {
    const localOrigin = getScienceSwarmLocalRequestOrigin(request);
    const state = await createScienceSwarmLocalAuthState({ localOrigin });
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
