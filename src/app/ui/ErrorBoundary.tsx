import { Component, ErrorInfo, ReactNode } from "react";

/**
 * The last line of defence between a throw and a blank page.
 *
 * Without a boundary React unwinds the whole tree, and the app is gone until a reload — with no
 * hint of why. The throws that reach here are not hypothetical: a `QuotaExceededError` from the
 * persistence effect recurs on every dispatch, so the blank page comes back on the next edit and
 * the user has no way to learn that the cause is a full storage.
 *
 * Deliberately dependency-free — no MUI, no Emotion, no theme, no hooks. The fallback has to render
 * when the thing that broke might be the style layer itself, so it uses plain elements and literal
 * colours taken from `theme.ts`. A class component because React still offers no hook for this.
 *
 * There is no «Стереть все данные» button here on purpose. It is the one action a user in this
 * state must not be nudged into, and it stays reachable from the menu after a reload.
 */

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { failed: boolean };

const SURFACE = "#05070d";
const TEXT = "#f7fbff";
const MUTED = "#a9b7cf";
const ACCENT = "#ec5aa7";
const ACCENT_TEXT = "#18020d";

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // The only record of what happened. A deployed build on a device the developer cannot reach is
    // exactly the case this boundary exists for, so the console is where the evidence has to land.
    console.error("mumbox: unrecoverable render error", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div
        data-testid="error-boundary"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          backgroundColor: SURFACE,
          color: TEXT,
          fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
          textAlign: "center"
        }}
      >
        <p style={{ margin: 0, fontSize: 20 }}>Что-то пошло не так</p>
        <p style={{ margin: 0, color: MUTED, maxWidth: 420, lineHeight: 1.5 }}>
          Данные проекта сохранены. Перезагрузите страницу.
        </p>
        <button
          type="button"
          data-testid="error-boundary-reload"
          onClick={() => {
            window.location.reload();
          }}
          style={{
            font: "inherit",
            padding: "10px 20px",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            backgroundColor: ACCENT,
            color: ACCENT_TEXT
          }}
        >
          Перезагрузить
        </button>
      </div>
    );
  }
}
