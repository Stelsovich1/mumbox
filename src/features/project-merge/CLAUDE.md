# Merging projects

## Merging projects

`src/features/project-merge` appends one project's panels to another. Two rules carry the feature:
audio is deduplicated by SHA-256 of the bytes (`contentHash`, an optional `MediaAsset` field), and
**every incoming panel id is regenerated** — `sanitizeImportedState` keeps incoming ids, and a
collision would silently overwrite a panel's cells. Names are resolved with the same
`makeUniquePanelName` panel copy uses, against the accumulating list. Global settings always come
from the current project.

`isDuplicateMediaFile`'s name-and-size rule is still consulted, but only as a cheap NEGATIVE: it can
say "different", never "same". Allowing it to assert identity was a silent data-substitution bug and
the default path at that — the current project's assets only gain a hash as a side effect of saving,
so a project that had never been saved deduplicated entirely on file name and byte length, and two
different `bell.mp3` of equal length collapsed into one. `prepareMerge` now hashes BOTH sides
(through an injected `loadBlob`, so the module stays unit-testable), bucketed by size so only assets
that could possibly collide are hashed at all. A pair that cannot be decided is KEPT and counted in
`undecidedCount`, and the user is told that duplicates were not checked rather than shown a number
implying they were.

