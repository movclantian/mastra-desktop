import { apiFetch, requestJson } from "@/shared/api";
import { i18n } from "@/shared/i18n";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

export async function validateAuthToken(token: string): Promise<AuthUser | null> {
  const response = await apiFetch("/work/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { user?: AuthUser | null };
  return payload.user ?? null;
}

export async function submitAuth(
  mode: "login" | "register",
  body: Record<string, unknown>,
): Promise<AuthSession> {
  const fallback = mode === "login" ? i18n.t("auth:loginFailed") : i18n.t("auth:registerFailed");
  const payload = await requestJson<Partial<AuthSession> & { error?: string }>(
    `/work/auth/${mode}`,
    { method: "POST", body },
    fallback,
  );
  if (!payload.token || !payload.user) {
    throw new Error(payload.error || fallback);
  }
  return { token: payload.token, user: payload.user };
}
