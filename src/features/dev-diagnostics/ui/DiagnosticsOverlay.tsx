import { Box, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";

import type { DiagSnapshot } from "../../../shared/lib/diagnostics";

/**
 * Diagnostics overlay, shown only under `?diag=1`.
 *
 * Deliberately carries no `role` and no `aria-label`: the e2e suite selects by Russian accessible
 * names, and a dev instrument must not add names that could collide with `getByRole` queries.
 * Tests reach it through `data-testid="diagnostics-overlay"`.
 */

const POLL_INTERVAL_MS = 500;
const MIB = 1024 * 1024;

function formatMib(bytes: number) {
  return (bytes / MIB).toFixed(1);
}

function formatMs(value: number | null) {
  return value === null ? "—" : `${String(Math.round(value))} мс`;
}

export function DiagnosticsOverlay() {
  const [snapshot, setSnapshot] = useState<DiagSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      const diag = window.__mumboxDiag;
      if (!diag) {
        return;
      }
      void diag.snapshot().then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      });
    };

    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!snapshot) {
    return null;
  }

  const { pcm, termination } = snapshot;
  const budgetLabel = pcm.budgetBytes === null ? "∞" : formatMib(pcm.budgetBytes);
  const warmLabel =
    snapshot.lastWarmupSkipped > 0
      ? `прогрето ${String(snapshot.lastWarmupWarmed)} · пропущено ${String(snapshot.lastWarmupSkipped)} · бюджет исчерпан`
      : `прогрето ${String(snapshot.lastWarmupWarmed)}`;

  return (
    <Box
      data-testid="diagnostics-overlay"
      sx={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top, 0px) + 4px)",
        right: "calc(env(safe-area-inset-right, 0px) + 4px)",
        zIndex: (theme) => theme.zIndex.modal + 30,
        // The overlay must never swallow a pad tap; only the chip is interactive.
        pointerEvents: "none",
        maxWidth: 320,
        borderRadius: 1,
        border: "1px solid rgba(127, 209, 255, 0.4)",
        backgroundColor: "rgba(5, 7, 13, 0.86)",
        color: "#cfe4ff",
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 1.35,
        px: 0.75,
        py: 0.5
      }}
    >
      <Box
        component="button"
        type="button"
        data-testid="diagnostics-overlay-toggle"
        onClick={() => {
          setExpanded((current) => !current);
        }}
        sx={{
          pointerEvents: "auto",
          display: "block",
          width: "100%",
          textAlign: "left",
          border: "none",
          background: "none",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          p: 0
        }}
      >
        {`PCM ${formatMib(pcm.totalBytes)}/${budgetLabel} МиБ · звук ${formatMs(snapshot.lastTimeToFirstSoundMs)}${termination.ungraceful ? " · ⚠" : ""}`}
      </Box>
      {expanded ? (
        <Stack data-testid="diagnostics-overlay-details" sx={{ mt: 0.5 }}>
          <Typography component="span" sx={{ font: "inherit" }}>
            {`PCM панели: ${formatMib(pcm.activePanelBytes)} МиБ · записей: ${String(pcm.entries)}`}
          </Typography>
          <Typography component="span" sx={{ font: "inherit" }}>
            {`кеш: попаданий ${String(pcm.hits)} · промахов ${String(pcm.misses)} · вытеснений ${String(pcm.evictions)}${pcm.overBudget ? " · сверх бюджета" : ""}`}
          </Typography>
          <Typography component="span" sx={{ font: "inherit" }}>
            {`декодов: ${String(snapshot.decodeCount)} · моно: ${snapshot.mono ? "вкл" : "выкл"}`}
          </Typography>
          <Typography component="span" sx={{ font: "inherit" }}>
            {`прогрев: ${formatMs(snapshot.lastWarmupMs)} · ${warmLabel}`}
          </Typography>
          <Typography component="span" sx={{ font: "inherit" }}>
            {`панель: движок ${formatMs(snapshot.lastPanelSwitchEngineMs)} · отрисовка ${formatMs(snapshot.lastPanelSwitchPaintMs)}`}
          </Typography>
          <Typography component="span" sx={{ font: "inherit" }}>
            {`хранилище: ${snapshot.storage?.usage === undefined || snapshot.storage.usage === null ? "—" : `${formatMib(snapshot.storage.usage)} МиБ`}`}
          </Typography>
          <Typography component="span" sx={{ font: "inherit" }}>
            {termination.ungraceful
              ? `прошлая сессия оборвана · PCM было ${termination.pcmBytesAtEnd === null ? "—" : `${formatMib(termination.pcmBytesAtEnd)} МиБ`}`
              : "прошлая сессия закрыта штатно"}
          </Typography>
        </Stack>
      ) : null}
    </Box>
  );
}
