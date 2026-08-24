import * as React from "react";
import { validateAuthToken } from "@/api/auth-api";
import { apiFetch, MASTRA_SERVER_URL } from "@/api/client";
import {
  AUTH_AUTO_LOGIN_KEY,
  AUTH_SESSION_KEY,
  AUTH_TOKEN_KEY,
  getStoredSession,
  getStoredToken,
  rememberAccount,
  syncAuthCookie,
} from "./auth-storage";
import { LoginScreen } from "./login-screen";
import type { AuthContextValue, AuthUser } from "./types";

export { installAuthenticatedFetch } from "./auth-client";
export type { AuthUser } from "./types";
export const getAuthToken = getStoredToken;

const AuthContext = React.createContext<AuthContextValue | null>(null);

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

  const value = React.useMemo(() => ({ user, token, signOut }), [signOut, token, user]);
  if (!ready) return null;
  return (
    <AuthContext.Provider value={value}>
      {user && token ? (
        children
      ) : (
        <LoginScreen
          onAuthenticated={(session, remember, autoLoginEnabled) => {
            sessionStorage.setItem(AUTH_TOKEN_KEY, session.token);
            if (remember) {
              rememberAccount(session.user);
              if (autoLoginEnabled) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
            } else {
              localStorage.removeItem(AUTH_SESSION_KEY);
            }
            localStorage.setItem(
              AUTH_AUTO_LOGIN_KEY,
              String(Boolean(remember && autoLoginEnabled)),
            );
            syncAuthCookie(session.token);
            setToken(session.token);
            setUser(session.user);
          }}
        />
      )}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
