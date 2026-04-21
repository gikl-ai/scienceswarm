"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getScienceSwarmCloudOrigin,
  SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE,
  SCIENCESWARM_LOCAL_AUTH_TOKEN_MESSAGE_TYPE,
} from "@/lib/scienceswarm-auth";

type ScienceSwarmLocalAuthStatus = {
  detail: string;
  expiresAt: string | null;
  signedIn: boolean;
};

type ScienceSwarmLocalAuthMessage =
  | {
      state: string;
      token?: string;
      type: typeof SCIENCESWARM_LOCAL_AUTH_TOKEN_MESSAGE_TYPE;
    }
  | {
      error: string;
      state?: string;
      type: typeof SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE;
    };

type UseScienceSwarmLocalAuthResult = {
  authDetail: string | null;
  beginSignIn: () => Promise<void>;
  isLoaded: boolean;
  isSignedIn: boolean;
  isSigningIn: boolean;
  refreshAuthStatus: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SCIENCESWARM_ORIGIN = getScienceSwarmCloudOrigin();

export function useScienceSwarmLocalAuth(): UseScienceSwarmLocalAuthResult {
  const [status, setStatus] = useState<ScienceSwarmLocalAuthStatus | null>(null);
  const [authDetail, setAuthDetail] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const pendingStateRef = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  const refreshAuthStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/scienceswarm-auth/status", {
        cache: "no-store",
      });
      const payload = (await response.json()) as ScienceSwarmLocalAuthStatus;
      if (!response.ok) {
        throw new Error("ScienceSwarm sign-in status failed.");
      }
      setStatus(payload);
      setAuthDetail(null);
    } catch (error) {
      setAuthDetail(
        error instanceof Error
          ? error.message
          : "ScienceSwarm sign-in status failed.",
      );
      setStatus(null);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshAuthStatus();
  }, [refreshAuthStatus]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ScienceSwarmLocalAuthMessage>) => {
      if (
        event.origin !== SCIENCESWARM_ORIGIN &&
        event.origin !== window.location.origin
      ) {
        return;
      }

      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;

      if (data.type === SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE) {
        setAuthDetail(data.error || "ScienceSwarm sign-in failed.");
        setIsSigningIn(false);
        pendingStateRef.current = null;
        popupRef.current?.close();
        popupRef.current = null;
        return;
      }

      if (data.type !== SCIENCESWARM_LOCAL_AUTH_TOKEN_MESSAGE_TYPE) {
        return;
      }

      if (!pendingStateRef.current || data.state !== pendingStateRef.current) {
        return;
      }

      void (async () => {
        try {
          setAuthDetail(null);
          if (event.origin === SCIENCESWARM_ORIGIN) {
            if (!data.token) {
              throw new Error("ScienceSwarm sign-in could not be completed.");
            }

            const sessionResponse = await fetch("/api/scienceswarm-auth/session", {
              body: JSON.stringify({
                state: data.state,
                token: data.token,
              }),
              headers: {
                "Content-Type": "application/json",
              },
              method: "POST",
            });
            const sessionPayload = (await sessionResponse.json()) as {
              error?: string;
            };
            if (!sessionResponse.ok) {
              throw new Error(
                sessionPayload.error ||
                  "ScienceSwarm sign-in could not be completed.",
              );
            }
          }

          await refreshAuthStatus();
        } catch (error) {
          setAuthDetail(
            error instanceof Error
              ? error.message
              : "ScienceSwarm sign-in could not be completed.",
          );
        } finally {
          pendingStateRef.current = null;
          setIsSigningIn(false);
          popupRef.current?.close();
          popupRef.current = null;
        }
      })();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refreshAuthStatus]);

  useEffect(() => {
    if (!isSigningIn) return;

    const interval = window.setInterval(() => {
      const popup = popupRef.current;
      if (!popup || !popup.closed || !pendingStateRef.current) {
        return;
      }
      pendingStateRef.current = null;
      popupRef.current = null;
      setIsSigningIn(false);
      setAuthDetail("ScienceSwarm sign-in window was closed before completion.");
    }, 250);

    return () => window.clearInterval(interval);
  }, [isSigningIn]);

  const beginSignIn = useCallback(async () => {
    setAuthDetail(null);
    setIsSigningIn(true);
    const popup = window.open(
      "about:blank",
      "_blank",
      "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes",
    );
    if (!popup) {
      setAuthDetail("Allow popups to sign in with ScienceSwarm.");
      setIsSigningIn(false);
      return;
    }

    popupRef.current = popup;

    try {
      const response = await fetch("/api/scienceswarm-auth/start", {
        method: "POST",
      });
      const payload = (await response.json()) as {
        authUrl?: string;
        error?: string;
        state?: string;
      };
      if (!response.ok || !payload.authUrl || !payload.state) {
        throw new Error(payload.error || "ScienceSwarm sign-in could not start.");
      }
      pendingStateRef.current = payload.state;
      popup.location.replace(payload.authUrl);
    } catch (error) {
      popup.close();
      popupRef.current = null;
      pendingStateRef.current = null;
      setAuthDetail(
        error instanceof Error
          ? error.message
          : "ScienceSwarm sign-in could not start.",
      );
      setIsSigningIn(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    setAuthDetail(null);
    try {
      await fetch("/api/scienceswarm-auth/sign-out", {
        method: "POST",
      });
    } finally {
      pendingStateRef.current = null;
      setIsSigningIn(false);
      popupRef.current?.close();
      popupRef.current = null;
      await refreshAuthStatus();
    }
  }, [refreshAuthStatus]);

  return {
    authDetail,
    beginSignIn,
    isLoaded,
    isSignedIn: Boolean(status?.signedIn),
    isSigningIn,
    refreshAuthStatus,
    signOut,
  };
}
