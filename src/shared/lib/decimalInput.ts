/**
 * Decimal text fields that read like a Russian number: `34,0`, `0,0`, `1,25`.
 *
 * The audio editor used `type="number"` for seconds, which shows `34` for a whole value and makes
 * the user type the decimal separator before the fraction — and on a Russian keyboard the comma
 * that comes up is exactly the character a number input rejects. A text field with
 * `inputMode="decimal"` shows the fraction from the start, so the fraction digit can be overwritten
 * in place, and the parser takes either separator.
 */

/** Millisecond resolution: seconds never need more than three fraction digits. */
const MAX_FRACTION_DIGITS = 3;

/**
 * `34` → `34,0`, `0` → `0,0`, `1.25` → `1,25`, `1.2345` → `1,235`. Always at least one fraction
 * digit, never a trailing zero beyond the first, comma as the separator. A non-finite value renders
 * as `0,0` rather than `NaN`, because the field is bound to state that can be null.
 */
export function formatDecimalRu(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const rounded = Number(safe.toFixed(MAX_FRACTION_DIGITS));
  // `String` drops trailing zeros and never uses exponent notation for values in this range.
  const plain = String(Math.abs(rounded) < 1e-9 ? 0 : rounded);
  const [whole = "0", fraction = ""] = plain.split(".");
  return `${whole},${fraction || "0"}`;
}

/**
 * Parses what the user typed. Either separator, surrounding whitespace, a trailing separator while
 * the fraction is still being typed (`34,` reads as 34). Returns null for anything that is not a
 * number yet — empty, a lone minus, letters — so the caller keeps the previous value instead of
 * writing NaN into state.
 */
export function parseDecimalInput(text: string): number | null {
  const normalized = text.trim().replace(",", ".").replace(/\s+/g, "");
  if (normalized === "" || normalized === "-" || normalized === "." || normalized === "-.") {
    return null;
  }
  if (!/^-?\d*\.?\d*$/.test(normalized)) {
    return null;
  }
  const value = Number(normalized.endsWith(".") ? normalized.slice(0, -1) : normalized);
  return Number.isFinite(value) ? value : null;
}
