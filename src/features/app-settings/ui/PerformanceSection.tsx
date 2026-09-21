import { Alert, Box, MenuItem, Select, Switch, TextField, Typography } from "@mui/material";
import { useEffect, useState } from "react";

import {
  AppSettings,
  MAX_PCM_BUDGET_MB,
  MAX_WARMUP_BUDGET_SECONDS,
  MIN_PCM_BUDGET_MB,
  MIN_WARMUP_BUDGET_SECONDS,
  WarmupMode
} from "../../../shared/lib/appSettings";
import { SettingRow } from "./SettingRow";

type PerformanceSectionProps = {
  settings: AppSettings;
  /** False when `?pcmBudgetMb=` on this load owns the value. */
  budgetEditable: boolean;
  /** False when `?partial=` on this load owns the value. */
  partialEditable: boolean;
  onChange: (next: AppSettings) => void;
};

const WARMUP_MODE_LABELS: Record<WarmupMode, string> = {
  full: "Полный — вся панель",
  "time-budget": "По бюджету времени",
  "heads-only": "Только мгновенные начала",
  "on-press": "Только по нажатию"
};

const OVERRIDDEN_NOTE = "Переопределено флагом в адресе страницы";

/**
 * Number fields keep their own text.
 *
 * Bound straight to the number they would snap to the minimum the moment the field is cleared,
 * because `Number.parseInt("")` is `NaN` — so the value could never be retyped. The text is the
 * draft, the number is committed whenever the text parses, and `parseSettings` clamps on apply.
 */
function useNumericDraft(value: number): [string, (next: string) => void] {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((current) => (Number.parseInt(current, 10) === value ? current : String(value)));
  }, [value]);
  return [text, setText];
}

export function PerformanceSection({
  settings,
  budgetEditable,
  partialEditable,
  onChange
}: PerformanceSectionProps) {
  const performance = settings.performance;
  const budgetMb = performance.pcmBudget.mode === "mb" ? performance.pcmBudget.mb : 0;
  const [budgetText, setBudgetText] = useNumericDraft(budgetMb);
  const [secondsText, setSecondsText] = useNumericDraft(performance.warmupBudgetSeconds);
  const coarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  // The pair that reproduces the failure the mobile budget exists to prevent: no ceiling AND no
  // byte-range path. Said here rather than prevented, because both are legitimate on a machine with
  // headroom — but on a phone this is how the tab gets killed, and the setting survives the kill.
  const dangerousOnPhone =
    coarsePointer &&
    performance.pcmBudget.mode === "unlimited" &&
    performance.partialDecode === "off";

  const patch = (next: Partial<AppSettings["performance"]>) => {
    onChange({ ...settings, performance: { ...performance, ...next } });
  };

  const budgetMode = performance.pcmBudget.mode;

  return (
    <Box data-testid="settings-section-performance" sx={{ display: "grid" }}>
      {dangerousOnPhone ? (
        <Alert severity="warning" data-testid="settings-danger-warning" sx={{ mb: 2 }}>
          Без ограничения памяти и без побайтового декодирования телефон почти наверняка закроет
          приложение во время прогрева. Настройка переживает такое закрытие, поэтому вернуть её
          обратно придётся здесь же, а если открыть настройки уже не удаётся — открыть приложение с
          адресом, к которому добавлено ?pcmBudgetMb=256
        </Alert>
      ) : null}
      <SettingRow
        title="Память под декодированный звук"
        hint={
          "Сколько распакованного звука держать в памяти. Лимит бережёт память, а не время: " +
          "прогрев быстрее не становится, а ячейки, которые в лимит не поместились, остаются " +
          "неготовыми до первого нажатия. Автоматически - без лимита на компьютере и 1 ГБ на " +
          "телефоне."
        }
        note={budgetEditable ? null : OVERRIDDEN_NOTE}
      >
        <Box sx={{ display: "grid", gap: 1 }}>
          <Select
            size="small"
            value={budgetMode}
            disabled={!budgetEditable}
            inputProps={{ "aria-label": "Память под декодированный звук" }}
            onChange={(event) => {
              const mode = event.target.value;
              patch({
                pcmBudget:
                  mode === "mb"
                    ? { mode: "mb", mb: 512 }
                    : mode === "unlimited"
                      ? { mode: "unlimited" }
                      : { mode: "auto" }
              });
            }}
          >
            <MenuItem value="auto">Автоматически</MenuItem>
            <MenuItem value="mb">Ограничить</MenuItem>
            <MenuItem value="unlimited">Без ограничения</MenuItem>
          </Select>
          {performance.pcmBudget.mode === "mb" ? (
            <TextField
              size="small"
              type="number"
              label="Мегабайт"
              disabled={!budgetEditable}
              value={budgetText}
              slotProps={{
                htmlInput: {
                  "aria-label": "Лимит памяти в мегабайтах",
                  min: MIN_PCM_BUDGET_MB,
                  max: MAX_PCM_BUDGET_MB
                }
              }}
              onChange={(event) => {
                setBudgetText(event.target.value);
                const mb = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(mb)) {
                  patch({ pcmBudget: { mode: "mb", mb } });
                }
              }}
            />
          ) : null}
        </Box>
      </SettingRow>

      <SettingRow
        title="Побайтовое декодирование"
        hint={
          "Читает из файла только тот кусок, который играет. Выключение возвращает полный декод " +
          "каждого файла: на панели из двенадцати трёхминутных треков это 762 МБ в памяти против " +
          "2,4 МБ. Выключать имеет смысл только если звук на " +
          "этом устройстве воспроизводится неправильно."
        }
        note={partialEditable ? null : OVERRIDDEN_NOTE}
      >
        <Select
          size="small"
          fullWidth
          value={performance.partialDecode}
          disabled={!partialEditable}
          inputProps={{ "aria-label": "Побайтовое декодирование" }}
          onChange={(event) => {
            patch({ partialDecode: event.target.value === "off" ? "off" : "auto" });
          }}
        >
          <MenuItem value="auto">Автоматически</MenuItem>
          <MenuItem value="off">Выключить</MenuItem>
        </Select>
      </SettingRow>

      <SettingRow
        title="Режим прогрева"
        hint={
          "Что готовить заранее, до нажатия. Полный греет всю панель. По бюджету времени греет " +
          "столько, сколько успеет за указанное время. Только мгновенные начала готовит лишь то, " +
          "что удаётся прочитать из файла кусками, и не платит за полный декод. Только по нажатию " +
          "не готовит ничего, а после нажатия подогревает соседние ячейки."
        }
      >
        <Select
          size="small"
          fullWidth
          value={performance.warmupMode}
          inputProps={{ "aria-label": "Режим прогрева" }}
          onChange={(event) => {
            patch({ warmupMode: event.target.value });
          }}
        >
          {Object.entries(WARMUP_MODE_LABELS).map(([mode, label]) => (
            <MenuItem key={mode} value={mode}>
              {label}
            </MenuItem>
          ))}
        </Select>
      </SettingRow>

      {performance.warmupMode === "time-budget" ? (
        <SettingRow
          title="Бюджет времени прогрева"
          hint={
            "Сколько секунд тратить на подготовку панели. Что не успело - подготовится при первом " +
            "нажатии на ячейку."
          }
        >
          <TextField
            size="small"
            type="number"
            fullWidth
            value={secondsText}
            slotProps={{
              htmlInput: {
                "aria-label": "Бюджет времени прогрева в секундах",
                min: MIN_WARMUP_BUDGET_SECONDS,
                max: MAX_WARMUP_BUDGET_SECONDS
              }
            }}
            onChange={(event) => {
              setSecondsText(event.target.value);
              const seconds = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(seconds)) {
                patch({ warmupBudgetSeconds: seconds });
              }
            }}
          />
        </SettingRow>
      ) : null}

      <SettingRow
        title="Не мешать нажатиям"
        hint={
          "Прогрев уступает, пока идут нажатия на ячейки. Подготовка занимает больше времени, зато " +
          "интерфейс во время выступления ровнее."
        }
      >
        <Switch
          checked={performance.warmupYieldsToInput}
          slotProps={{ input: { "aria-label": "Не мешать нажатиям" } }}
          onChange={(event) => {
            patch({ warmupYieldsToInput: event.target.checked });
          }}
        />
      </SettingRow>

      <SettingRow
        title="Одновременных декодов при прогреве"
        hint={
          "Больше — быстрее прогрев, но выше пик памяти и сильнее подтормаживает интерфейс. " +
          "Автоматически означает два на телефоне и до четырёх на компьютере."
        }
        note="Общий предел одновременных чтений изменится только после перезагрузки"
      >
        <Select
          size="small"
          fullWidth
          value={performance.warmupConcurrency === null ? "auto" : String(performance.warmupConcurrency)}
          inputProps={{ "aria-label": "Одновременных декодов при прогреве" }}
          onChange={(event) => {
            const raw = event.target.value;
            patch({ warmupConcurrency: raw === "auto" ? null : Number.parseInt(raw, 10) });
          }}
        >
          <MenuItem value="auto">Автоматически</MenuItem>
          <MenuItem value="1">1</MenuItem>
          <MenuItem value="2">2</MenuItem>
          <MenuItem value="3">3</MenuItem>
          <MenuItem value="4">4</MenuItem>
        </Select>
      </SettingRow>

      <Typography variant="caption" color="text.secondary" sx={{ pt: 2 }}>
        На больших сетках упрощённая графика в разделе «Визуализация» обычно даёт больше, чем любая
        настройка декодирования.
      </Typography>
    </Box>
  );
}
