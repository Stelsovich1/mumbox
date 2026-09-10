import { CssBaseline, ThemeProvider } from "@mui/material";
import { lazy, Suspense } from "react";

import { BoardPage } from "../pages/board";
import { isDiagnosticsEnabled } from "../shared/lib/diagnostics";
import { appTheme } from "./providers/theme";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles/global.css";

// Lazily imported so the overlay chunk is fetched only under `?diag=1`.
const DiagnosticsOverlay = lazy(async () => ({
  default: (await import("../features/dev-diagnostics")).DiagnosticsOverlay
}));

export function App() {
  return (
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <ErrorBoundary>
        <BoardPage />
      </ErrorBoundary>
      {isDiagnosticsEnabled() ? (
        <Suspense fallback={null}>
          <DiagnosticsOverlay />
        </Suspense>
      ) : null}
    </ThemeProvider>
  );
}
