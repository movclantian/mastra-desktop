import type * as React from "react";
import { AppProviders } from "./app-providers";
import AppShell from "./app-shell";

export default function RendererApp(): React.JSX.Element {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}
