/**
 * Russian numeric agreement: `[one, few, many]`, e.g. `["запись", "записи", "записей"]`.
 * 1 запись, 2 записи, 5 записей, 11 записей, 21 запись.
 */
export function pluralizeRu(count: number, forms: readonly [string, string, string]) {
  const absolute = Math.abs(Math.trunc(count));
  const lastTwo = absolute % 100;
  const last = absolute % 10;

  if (lastTwo >= 11 && lastTwo <= 14) {
    return forms[2];
  }
  if (last === 1) {
    return forms[0];
  }
  if (last >= 2 && last <= 4) {
    return forms[1];
  }

  return forms[2];
}

export function formatCountRu(count: number, forms: readonly [string, string, string]) {
  return `${String(count)} ${pluralizeRu(count, forms)}`;
}
