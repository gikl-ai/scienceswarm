"use client";

import { ClerkProvider, SignInButton, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  getScienceSwarmClerkPublishableKey,
  getScienceSwarmCloudOrigin,
  SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE,
  isScienceSwarmHostedOrigin,
  isSupportedScienceSwarmLocalOrigin,
} from "@/lib/scienceswarm-auth";

export const dynamic = "force-dynamic";

function ScienceSwarmLocalBridgeInner() {
  const searchParams = useSearchParams();
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const postedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [hasOpener, setHasOpener] = useState(false);

  const requestedOrigin = useMemo(
    () => searchParams.get("origin")?.trim() || "",
    [searchParams],
  );
  const state = useMemo(
    () => searchParams.get("state")?.trim() || "",
    [searchParams],
  );
  const canPostBack =
    hasOpener &&
    Boolean(state) &&
    isSupportedScienceSwarmLocalOrigin(requestedOrigin);

  useEffect(() => {
    setHasOpener(Boolean(window.opener));
  }, []);

  useEffect(() => {
    if (!canPostBack || !isLoaded || !isSignedIn || postedRef.current) {
      return;
    }

    postedRef.current = true;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("ScienceSwarm could not issue a session token.");
        }
        const form = document.createElement("form");
        form.method = "POST";
        form.action = `${requestedOrigin}/api/scienceswarm-auth/session`;

        const appendHiddenInput = (name: string, value: string) => {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.appendChild(input);
        };

        appendHiddenInput("state", state);
        appendHiddenInput("token", token);
        document.body.appendChild(form);
        form.submit();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "ScienceSwarm sign-in could not be completed.";
        setError(message);
        window.opener?.postMessage(
          {
            error: message,
            type: SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE,
          },
          requestedOrigin,
        );
      }
    })();
  }, [canPostBack, getToken, isLoaded, isSignedIn, requestedOrigin, state]);

  if (!requestedOrigin || !state) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          ScienceSwarm local sign-in is missing the required handoff state.
        </div>
      </main>
    );
  }

  if (!isSupportedScienceSwarmLocalOrigin(requestedOrigin)) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          ScienceSwarm local sign-in only supports localhost installs.
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6">
      <div className="w-full rounded-3xl border border-border bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
          ScienceSwarm Account
        </p>
        <h1 className="mt-4 text-3xl font-semibold text-foreground">
          Connect your local ScienceSwarm install
        </h1>
        <p className="mt-4 text-sm leading-7 text-muted-foreground">
          Create a free ScienceSwarm account to connect the hosted Reasoning
          API to your local install. When you run hosted Reasoning, the PDF
          or pasted text is sent to ScienceSwarm&apos;s cloud service rather
          than the local model.
        </p>
        <p className="mt-3 text-sm leading-7 text-muted-foreground">
          ScienceSwarm routes this hosted reasoning flow across frontier
          models from Google, Anthropic, and OpenAI. During the beta period,
          ScienceSwarm is covering that access for free.
        </p>

        {!isLoaded ? (
          <div className="mt-8 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted-foreground">
            Loading your ScienceSwarm account…
          </div>
        ) : isSignedIn ? (
          <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            Finalizing the connection to your local install…
          </div>
        ) : (
          <SignInButton mode="modal">
            <button
              type="button"
              className="mt-8 inline-flex rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Create free account / Sign in
            </button>
          </SignInButton>
        )}

        {!canPostBack ? (
          <p className="mt-4 text-sm text-amber-700">
            Return to your local ScienceSwarm window after you sign in.
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 text-sm text-rose-700">{error}</p>
        ) : null}
      </div>
    </main>
  );
}

export default function ScienceSwarmLocalBridgePage() {
  const clientOrigin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => null,
  );
  const isHosted = clientOrigin
    ? isScienceSwarmHostedOrigin(clientOrigin)
    : null;

  if (isHosted === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6">
        <div className="rounded-2xl border border-border bg-white p-6 text-sm text-muted-foreground">
          Loading ScienceSwarm sign-in bridge…
        </div>
      </main>
    );
  }

  if (!isHosted) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-6">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          This bridge page must be opened from {getScienceSwarmCloudOrigin()}.
        </div>
      </main>
    );
  }

  return (
    <ClerkProvider publishableKey={getScienceSwarmClerkPublishableKey()}>
      <ScienceSwarmLocalBridgeInner />
    </ClerkProvider>
  );
}
