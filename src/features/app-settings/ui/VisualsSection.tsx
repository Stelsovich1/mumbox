import { Box, Button, MenuItem, Select, Switch } from "@mui/material";

import {
  AppSettings,
  LabelScale,
  resetSection,
  resolveWarmthDisplay,
  WarmthDisplay
} from "../../../shared/lib/appSettings";
import { SettingRow } from "./SettingRow";

type VisualsSectionProps = {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
};

const WARMTH_LABELS: Record<WarmthDisplay, string> = {
  auto: "Автоматически",
  full: "Показывать с анимацией",
  static: "Показывать без анимации",
  off: "Не показывать"
};

const LABEL_SCALE_LABELS: Record<LabelScale, string> = {
  xs: "XS — очень мелкий",
  sm: "S — мелкий",
  md: "M — обычный",
  lg: "L — крупный",
  xl: "XL — очень крупный"
};

export function VisualsSection({ settings, onChange }: VisualsSectionProps) {
  const visuals = settings.visuals;

  const patch = (next: Partial<AppSettings["visuals"]>) => {
    onChange({ ...settings, visuals: { ...visuals, ...next } });
  };

  const resolvedWarmth = resolveWarmthDisplay(settings);

  return (
    <Box data-testid="settings-section-visuals" sx={{ display: "grid" }}>
      <SettingRow
        title="Упрощённая графика"
        hint={
          "Убирает свечения, плавные переходы и анимации ячеек."
        }
      >
        <Switch
          checked={visuals.flatGraphics}
          slotProps={{ input: { "aria-label": "Упрощённая графика" } }}
          onChange={(event) => {
            patch({ flatGraphics: event.target.checked });
          }}
        />
      </SettingRow>

      <SettingRow
        title="Индикация готовности ячейки"
        hint={
          "Неготовая ячейка затемняется, готовая подсвечивается. Автоматически означает: " +
          "показывать только при полном режиме прогрева."
        }
        note={
          visuals.warmthDisplay === "auto"
            ? `Сейчас: ${WARMTH_LABELS[resolvedWarmth].toLowerCase()}`
            : null
        }
      >
        <Select
          size="small"
          fullWidth
          value={visuals.warmthDisplay}
          inputProps={{ "aria-label": "Индикация готовности ячейки" }}
          onChange={(event) => {
            patch({ warmthDisplay: event.target.value });
          }}
        >
          {Object.entries(WARMTH_LABELS).map(([value, label]) => (
            <MenuItem key={value} value={value}>
              {label}
            </MenuItem>
          ))}
        </Select>
      </SettingRow>

      <SettingRow
        title="Уменьшить движение"
        hint={
          "Убирает анимации интерфейса, оставляя состояния видимыми. Системная настройка " +
          "уменьшения движения действует всегда и этим переключателем не отменяется."
        }
      >
        <Switch
          checked={visuals.reduceMotion}
          slotProps={{ input: { "aria-label": "Уменьшить движение" } }}
          onChange={(event) => {
            patch({ reduceMotion: event.target.checked });
          }}
        />
      </SettingRow>

      <SettingRow
        title="Размер подписей"
        hint="Масштаб подписей и бейджей горячих клавиш на ячейках."
      >
        <Select
          size="small"
          fullWidth
          value={visuals.labelScale}
          inputProps={{ "aria-label": "Размер подписей" }}
          onChange={(event) => {
            patch({ labelScale: event.target.value });
          }}
        >
          {Object.entries(LABEL_SCALE_LABELS).map(([value, label]) => (
            <MenuItem key={value} value={value}>
              {label}
            </MenuItem>
          ))}
        </Select>
      </SettingRow>

      <Box sx={{ pt: 2, justifySelf: "start" }}>
        <Button
          variant="outlined"
          onClick={() => {
            onChange(resetSection(settings, "visuals"));
          }}
        >
          Вернуть визуализацию к умолчанию
        </Button>
      </Box>
    </Box>
  );
}
