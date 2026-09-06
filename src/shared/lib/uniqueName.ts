/**
 * Resolves a name against the ones already taken, appending `_2`, `_3` and so on.
 *
 * Shared by panel copy, project merge and the save dialog's default project name, so all three
 * disambiguate the same way and a user sees one convention.
 */
export function makeUniqueName(
  existingNames: Iterable<string>,
  requestedName: string,
  fallbackName: string
) {
  const baseName = requestedName.trim() || fallbackName;
  const taken = new Set(existingNames);

  if (!taken.has(baseName)) {
    return baseName;
  }

  let index = 2;
  let candidate = `${baseName}_${String(index)}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${baseName}_${String(index)}`;
  }

  return candidate;
}
