import * as React from "react";
import { apiFetch, MASTRA_SERVER_URL } from "@/shared/api";
import { validateAuthToken } from "./auth-api";
import { AuthContext } from "./auth-context";
import {
  AUTH_AUTO_LOGIN_KEY,
  AUTH_SESSION_KEY,
  AUTH_TOKEN_KEY,
  getStoredSession,
  getStoredToken,
  rememberAccount,
  syncAuthCookie,
} from "./auth-storage";
import type { AuthSession, AuthUser } from "./types";

export type { AuthUser } from "./types";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const rememberedSession = getStoredSession();
  const autoLogin = localStorage.getItem(AUTH_AUTO_LOGIN_KEY) === "true";
  const [token, setToken] = React.useState<string | null>(
    () =>
      sessionStorage.getItem(AUTH_TOKEN_KEY) ??
      (autoLogin ? (rememberedSession?.token ?? null) : null),
  );
  const [user, setUser] = React.useState<AuthUser | null>(() =>
    autoLogin ? (rememberedSession?.user ?? null) : null,
  );
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    if (!token) {
      syncAuthCookie(null);
      setReady(true);
      return () => {
        active = false;
      };
    }
    syncAuthCookie(token);
    validateAuthToken(token)
      .then((nextUser) => {
        if (!active) return;
        if (!nextUser) {
          sessionStorage.removeItem(AUTH_TOKEN_KEY);
          localStorage.removeItem(AUTH_SESSION_KEY);
          localStorage.setItem(AUTH_AUTO_LOGIN_KEY, "false");
          syncAuthCookie(null);
          setToken(null);
          setUser(null);
        } else {
          setUser(nextUser);
        }
      })
      .catch(() => {
        if (active) {
          sessionStorage.removeItem(AUTH_TOKEN_KEY);
          setToken(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [token]);

  const setSession = React.useCallback(
    (session: AuthSession, remember: boolean, autoLoginEnabled: boolean) => {
      sessionStorage.setItem(AUTH_TOKEN_KEY, session.token);
      if (remember) {
        rememberAccount(session.user);
        if (autoLoginEnabled) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(AUTH_SESSION_KEY);
      }
      localStorage.setItem(AUTH_AUTO_LOGIN_KEY, String(Boolean(remember && autoLoginEnabled)));
      syncAuthCookie(session.token);
      setToken(session.token);
      setUser(session.user);
    },
    [],
  );

  const signOut = React.useCallback(() => {
    const currentToken = getStoredToken();
    if (currentToken) {
      void apiFetch(`${MASTRA_SERVER_URL}/work/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${currentToken}` },
      }).catch(() => undefined);
    }
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_SESSION_KEY);
    localStorage.setItem(AUTH_AUTO_LOGIN_KEY, "false");
    syncAuthCookie(null);
    setToken(null);
    setUser(null);
    setReady(true);
  }, []);

  const value = React.useMemo(
    () => ({ user, token, signOut, setSession }),
    [setSession, signOut, token, user],
  );
  if (!ready) return null;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
