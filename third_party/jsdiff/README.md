# jsdiff

Package: `diff` 9.0.0, pinned in `package-lock.json`.
Upstream: https://github.com/kpdecker/jsdiff
License: BSD-3-Clause; full copyright, conditions and disclaimer in `LICENSE`.

The production renderer imports `diffLines` in `src/renderer/RevisionDiff.tsx`. It computes local text differences between a user-edited Skill and a proposed revision, with an 80 ms timeout and an edit-distance cap. Large changes fall back to full-text comparison. Changed/unchanged text is rendered as escaped text, never HTML or executable instructions. No upstream source was modified and no model/provider service is called by the comparison.
