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

/**
 * The same value split across two lines, which is how every table renders it: `dd.MM.yyyy HH:mm` on
 * one line forces a column wider than its own header, and a taller row is the cheaper trade.
 *
 * Returns `null` when there is nothing to show, so the caller renders the dash itself.
 */
export function formatCreatedAtParts(value: string | undefined | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return {
    date: `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).padStart(4, "0")}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`
  };
}

export { MISSING_DATE_LABEL };
