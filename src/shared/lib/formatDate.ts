const MISSING_DATE_LABEL = "—";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/**
 * `dd.MM.yyyy HH:mm` in local time, or `—` when the value is missing or unparseable.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat`: newer ICU emits U+202F before the time, so Node and
 * Chromium would disagree and the unit tier and the e2e tier would have to assert different strings.
 */
export function formatCreatedAt(value: string | undefined | null) {
  if (!value) {
    return MISSING_DATE_LABEL;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return MISSING_DATE_LABEL;
  }

  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear()).padStart(4, "0");

  return `${day}.${month}.${year} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export { MISSING_DATE_LABEL };
