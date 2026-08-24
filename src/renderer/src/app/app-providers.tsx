import type { ReactNode } from "react";
import { AuthProvider } from "@/features/auth";
import { ThemeProvider } from "@/features/theme/theme-provider";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ThemeProvider defaultTheme="light">{children}</ThemeProvider>
    </AuthProvider>
  );
}
