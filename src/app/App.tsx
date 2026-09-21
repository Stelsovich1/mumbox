import { CssBaseline, ThemeProvider } from "@mui/material";
import { lazy, Suspense } from "react";

import { BoardPage } from "../pages/board";
import { useAppSettings } from "../shared/lib/appSettingsStore";
import { isDiagnosticsQueryEnabled } from "../shared/lib/diagnostics";
import { appTheme } from "./providers/theme";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles/global.css";

// Lazily imported so the overlay chunk is fetched only when the overlay is actually shown — under
// `?diag=1`, or the first time the setting is switched on.
const DiagnosticsOverlay = lazy(async () => ({
  default: (await import("../features/dev-diagnostics")).DiagnosticsOverlay
}));

export function App() {
  // Subscribed rather than read once: the overlay used to be gated on a latched query flag, so the
  // switch in the settings dialog could not have taken effect without a reload.
  const settings = useAppSettings();
  const overlayEnabled = isDiagnosticsQueryEnabled() || settings.diagnostics.overlay;

  return (
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <ErrorBoundary>
        <BoardPage />
      </ErrorBoundary>
      {overlayEnabled ? (
        <Suspense fallback={null}>
          <DiagnosticsOverlay />
        </Suspense>
      ) : null}
    </ThemeProvider>
  );
}
