/**
 * Brain Setup API — Natural language brain creation flow.
 *
 * POST /api/brain/setup
 *   { action: "start" }                              -> first SetupStep
 *   { action: "respond", step: number, response: string } -> next step or completion
 *   { action: "complete", responses: Record<string, string> } -> creates brain
 */

import {
  createSetupState,
  processSetupResponse,
  getSetupSteps,
  completeSetup,
} from "@/brain/setup-flow";
import type { SetupState } from "@/brain/setup-flow";

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const action = body.action;

  if (action === "start") {
    const steps = getSetupSteps();
    const state = createSetupState();
    return Response.json({
      step: steps[0],
      state,
    });
  }

  if (action === "respond") {
    const step = body.step;
    const response = body.response;

    if (typeof step !== "number" || typeof response !== "string") {
      return Response.json(
        { error: "Missing required fields: step (number), response (string)" },
        { status: 400 },
      );
    }

    const state: SetupState = {
      started: true,
      currentStep: step,
      responses: (body.state as Record<string, unknown>)?.responses as Record<string, string> ?? {},
      completed: false,
    };

    const result = processSetupResponse(state, response);

    if (result.error) {
      return Response.json({
        error: result.error,
        step: result.nextStep,
        state: result.state,
      });
    }

    if (result.state.completed) {
      try {
        const setupResult = await completeSetup(result.state);
        return Response.json({
          completed: true,
          result: setupResult,
          state: result.state,
        });
      } catch (err) {
        return Response.json(
          { error: `Failed to create brain: ${err instanceof Error ? err.message : String(err)}` },
          { status: 500 },
        );
      }
    }

    return Response.json({
      step: result.nextStep,
      state: result.state,
    });
  }

  if (action === "complete") {
    const responses = body.responses;
    if (!responses || typeof responses !== "object") {
      return Response.json(
        { error: "Missing required field: responses (object)" },
        { status: 400 },
      );
    }

    const state: SetupState = {
      started: true,
      currentStep: 4,
      responses: responses as Record<string, string>,
      completed: true,
    };

    try {
      const result = await completeSetup(state);
      return Response.json({
        completed: true,
        result,
      });
    } catch (err) {
      return Response.json(
        { error: `Failed to create brain: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
  }

  return Response.json(
    { error: `Unknown action: ${String(action)}. Expected: start, respond, complete` },
    { status: 400 },
  );
}
