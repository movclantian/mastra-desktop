import type { AuthSession, AuthUser } from "@/api/auth-api";

export type { AuthSession, AuthUser };

export interface RememberedAccount {
  email: string;
  name: string;
}

export interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  signOut: () => void;
  setSession: (session: AuthSession, remember: boolean, autoLogin: boolean) => void;
}
