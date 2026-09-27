# MajSimai source provenance

- Upstream repository: `https://github.com/TeamMajdata/MajSimai`
- Pinned commit: `fdb2a3e39d8997a0abbf8b4679062d854473cc77`
- Upstream project version: `2.2.1`
- Upstream project metadata declares `GPL-3.0-or-later` in `MajSimai.csproj`.
- The accompanying `COPYING` contains the GNU GPL version 3 text; the upstream `-or-later` grant is preserved.
- `LOCAL_PATCH.diff` records the browser-only compile-time patch: replace two `Parallel.For` loops with sequential loops under `MAJSIMAI_BROWSER`, leaving the upstream non-browser build unchanged.

The vendored files are stored as ordinary repository files, without a nested `.git` directory. Reapply the recorded patch to the pinned commit to reconstruct the browser-specific `Runtime/SimaiParser.cs` changes.
