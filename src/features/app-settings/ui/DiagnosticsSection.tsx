import { Alert, Box, Button, Switch, Typography } from "@mui/material";
import { useEffect, useState } from "react";

import { MediaAsset } from "../../../entities/media/model/types";
import { getMediaLabel } from "../../../entities/media/model/mediaSort";
import { AppSettings, DEFAULT_SETTINGS, settingsEqual } from "../../../shared/lib/appSettings";
import { getSnapshot, isDiagnosticsQueryEnabled } from "../../../shared/lib/diagnostics";
import type { DiagSnapshot } from "../../../shared/lib/diagnostics";
import { readPartialDecodeRecord } from "../../../shared/lib/partialDecodePolicy";
import { SettingRow } from "./SettingRow";

type DiagnosticsSectionProps = {
  settings: AppSettings;
  /** Only to turn the ids in the report into file names. */
  media: MediaAsset[];
  onChange: (next: AppSettings) => void;
  /** Applies a settings object immediately, for the "return to defaults" offer below. */
  onApply: (next: AppSettings) => void;
};

/** The English the engine records, in the language the rest of this dialog speaks. */
const VERDICT_LABELS: Record<string, string> = {
  unknown: "ещё не проверялся",
  ok: "работает",
  blocked: "отключено на этом браузере"
};

const DECLINE_LABELS: Record<string, string> = {
  loop: "зацикленные ячейки",
  "no-payoff-hint": "нечего экономить",
  "no-duration": "нет длительности",
  "range-empty": "пустой диапазон",
  "no-plan": "не удалось разбить на куски",
  unsupported: "формат без побайтового чтения"
};

export function DiagnosticsSection({
  settings,
  media,
  onChange,
  onApply
}: DiagnosticsSectionProps) {
  const [snapshot, setSnapshot] = useState<DiagSnapshot | null>(null);
  const [copied, setCopied] = useState(false);
  const record = readPartialDecodeRecord();

  useEffect(() => {
    let cancelled = false;
    void getSnapshot().then((next) => {
      if (!cancelled) {
        setSnapshot(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const partial = snapshot?.partial;
  // The report carries ids, and nothing in the app shows one. A single file that fails verification
  // is read whole on every press, so naming it is the difference between a number and an action.
  const failedNames = (partial?.failedMediaIds ?? []).map((mediaId) => {
    const asset = media.find((candidate) => candidate.id === mediaId);
    return asset ? getMediaLabel(asset) : mediaId;
  });

  // The previous session being killed is a signal, not a verdict: it is also what a restore from
  // the back/forward cache looks like on iOS. So it is shown next to an offer rather than acted on
  // — a silent rollback of settings the user chose would be wrong far more often than it was right.
  const showRollbackOffer =
    (snapshot?.termination.ungraceful ?? false) && !settingsEqual(settings, DEFAULT_SETTINGS);

  return (
    <Box data-testid="settings-section-diagnostics" sx={{ display: "grid", gap: 2 }}>
      {showRollbackOffer ? (
        <Alert
          severity="warning"
          data-testid="diagnostics-rollback"
          action={
            <Button
              color="inherit"
              onClick={() => {
                onApply(DEFAULT_SETTINGS);
              }}
            >
              Вернуть умолчания
            </Button>
          }
        >
          Прошлая сессия закрылась нештатно — так выглядит и нехватка памяти, и обычный возврат
          назад. Если приложение закрывалось само, начните с возврата настроек к умолчанию.
        </Alert>
      ) : null}
      <SettingRow
        title="Показывать окно диагностики"
        hint={
          "То же, что адрес с ?diag=1, но без правки адреса — в установленном приложении адресной " +
          "строки нет вообще. Окно показывает память, декодирование и состояние прошлой сессии."
        }
        note={isDiagnosticsQueryEnabled() ? "Уже включено флагом в адресе страницы" : null}
      >
        <Switch
          checked={settings.diagnostics.overlay}
          slotProps={{ input: { "aria-label": "Показывать окно диагностики" } }}
          onChange={(event) => {
            onChange({
              ...settings,
              diagnostics: { ...settings.diagnostics, overlay: event.target.checked }
            });
          }}
        />
      </SettingRow>

      <Box sx={{ display: "grid", gap: 0.5 }}>
        <Typography variant="h6">Побайтовое декодирование</Typography>
        <Typography data-testid="diagnostics-verdict">
          Вердикт для этого браузера: {VERDICT_LABELS[record.verdict] ?? record.verdict}
          {record.hardBlocked ? " (браузер не умеет, снять нельзя)" : ""}
        </Typography>
        <Typography>
          Проверок пройдено: {String(record.passes)}, не пройдено: {String(record.failures)}
        </Typography>
        <Typography>
          Потоком: {String(partial?.served.streamed ?? 0)}, диапазоном:{" "}
          {String(partial?.served.range ?? 0)}, отказов: {String(partial?.served.declined ?? 0)}
        </Typography>
        <Typography>Полных декодов: {String(snapshot?.decodeCount ?? 0)}</Typography>
        {failedNames.length > 0 ? (
          <Typography color="warning.main" data-testid="diagnostics-failed-media">
            Не проходят проверку и читаются целиком: {failedNames.join(", ")}
          </Typography>
        ) : null}
        <Typography variant="caption" color="text.secondary">
          Причины отказов:{" "}
          {Object.entries(partial?.declineReasons ?? {})
            .map(([reason, count]) => `${DECLINE_LABELS[reason] ?? reason}: ${String(count)}`)
            .join(", ") || "нет"}
        </Typography>
      </Box>

      <Box sx={{ display: "grid", gap: 0.5 }}>
        <Typography variant="h6">Устройство и сессия</Typography>
        <Typography>
          Ядер: {String(snapshot?.device.hardwareConcurrency ?? 0)}, память:{" "}
          {snapshot?.device.deviceMemoryGb === null || snapshot?.device.deviceMemoryGb === undefined
            ? "неизвестно"
            : `${String(snapshot.device.deviceMemoryGb)} ГБ`}
        </Typography>
        <Typography data-testid="diagnostics-termination">
          Прошлая сессия:{" "}
          {snapshot === null
            ? "неизвестно"
            : snapshot.termination.ungraceful
              ? "закрылась нештатно"
              : "закрылась штатно"}
        </Typography>
      </Box>

      <Box sx={{ justifySelf: "start" }}>
        <Button
          variant="outlined"
          onClick={() => {
            void (async () => {
              const report = JSON.stringify(await getSnapshot(), null, 2);
              try {
                await navigator.clipboard.writeText(report);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            })();
          }}
        >
          Скопировать отчёт
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", pt: 1 }}>
          В отчёт попадают версия браузера целиком, счётчики декодирования и идентификаторы
          аудиофайлов внутри приложения. Имена файлов и сам звук в него не входят.
          {copied ? " Отчёт скопирован." : ""}
        </Typography>
      </Box>
    </Box>
  );
}
