import {
  assertRuntimeApiLocalRequest,
  getRuntimeApiServices,
  listRuntimeApiHostProfiles,
  runtimeAdapterForApi,
  runtimeErrorResponse,
} from "../_shared";
import { readScienceSwarmGbrainPackageState } from "@/lib/gbrain/source-of-truth";
import { resolveRuntimeMcpToolProfile } from "@/lib/runtime-hosts/mcp/tool-profiles";

export async function GET(request: Request): Promise<Response> {
  try {
    await assertRuntimeApiLocalRequest(request);
    const services = getRuntimeApiServices();
    const hosts = await Promise.all(
      listRuntimeApiHostProfiles(services).map(async (profile) => {
        const adapter = runtimeAdapterForApi(profile.id, services);
        const [health, auth, privacy] = await Promise.all([
          adapter?.health() ?? Promise.resolve({
            status: "unavailable" as const,
            checkedAt: services.now().toISOString(),
            detail: "No runtime adapter is registered for this host.",
          }),
          adapter?.authStatus() ?? Promise.resolve({
            status: "unknown" as const,
            authMode: profile.authMode,
            provider: profile.authProvider,
            detail: "No runtime adapter is registered for this host.",
          }),
          adapter?.privacyProfile() ?? Promise.resolve({
            privacyClass: profile.privacyClass,
            adapterProof: "unknown" as const,
            reason: "No runtime adapter is registered for this host.",
            observedAt: services.now().toISOString(),
          }),
        ]);

        return {
          profile: {
            id: profile.id,
            label: profile.label,
            authMode: profile.authMode,
            authProvider: profile.authProvider,
            privacyClass: profile.privacyClass,
            transport: profile.transport,
            capabilities: profile.capabilities,
            lifecycle: profile.lifecycle,
            accountDisclosure: {
              storesTokensInScienceSwarm: profile.storesTokensInScienceSwarm,
              requiresProjectPrivacy: profile.requiresProjectPrivacy,
            },
            mcpTools: resolveRuntimeMcpToolProfile(profile).allowedTools,
          },
          health,
          auth,
          privacy,
        };
      }),
    );

    return Response.json({
      hosts,
      gbrain: {
        package: readScienceSwarmGbrainPackageState(process.cwd()),
      },
      checkedAt: services.now().toISOString(),
    });
  } catch (error) {
    return runtimeErrorResponse(error);
  }
}
