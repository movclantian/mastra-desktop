import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "@/features/auth";
import { ThemeProvider } from "@/shared/theme";

function InnerProviders({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <ThemeProvider userId={user?.id} defaultTheme="light">
      {children}
    </ThemeProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <InnerProviders>{children}</InnerProviders>
    </AuthProvider>
  );
}
