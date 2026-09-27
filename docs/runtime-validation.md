# MajSimai WASM runtime validation

The browser parser is a pinned .NET 10 WebAssembly build of MajSimai commit `fdb2a3e39d8997a0abbf8b4679062d854473cc77`. `createMajSimaiParser(baseUrl)` from [`packages/majsimai-browser/src/bridge.ts`](../packages/majsimai-browser/src/bridge.ts) loads `baseUrl/_framework/dotnet.js` into the calling chart Worker and exposes one batched `parse(sourceText)` call. It does not create another Worker. The chart Worker must register messages with `self.addEventListener('message', ...)`: `dotnet.create()` replaces `self.onmessage` during runtime initialization.

The host returns one JSON DTO per input string. Notes carry exact rational quarter-note beats, chart-relative start seconds, declared source order, stable source-offset IDs and UTF-16 half-open source ranges; charts carry BPM events and `endBeat`. Touch notes add `touchArea`; A/B/D/E positions remain 1–8 and center C is normalized to position 0 (the pinned parser's internal sentinel 8 is checked before normalization). Known unsupported tokens make their difficulty read-only and receive diagnostics. Touch EX and bare short Touch Hold are diagnosed but omitted from normalized notes so the chart-core validator cannot accept semantics it does not model; the original field text and range remain available for exact preservation. Slides, unknown modifiers, state commands and chart comments remain read-only.

## Reproducible build and assets

[`global.json`](../global.json) requires the exact .NET SDK 10.0.401. [`tools/dotnet/setup.sh`](../tools/dotnet/setup.sh) installs that SDK and its bundled `wasm-tools` manifest 10.0.112/10.0.100 (SDK feature band 10.0.400) under the ignored `.tools` directory, verifies the selected SDK and workload manifest, then restores the host project. The resolved browser runtime pack is 10.0.12. [`tools/dotnet/publish-majsimai-browser.mjs`](../tools/dotnet/publish-majsimai-browser.mjs) publishes Release output, copies the `wwwroot` contents flat to `apps/web/public/wasm` so `_framework/dotnet.js` is at the bridge's expected path, and copies the runtime pack's `LICENSE.TXT` and `THIRD-PARTY-NOTICES.TXT` as `DOTNET-LICENSE.txt` and `DOTNET-THIRD-PARTY-NOTICES.txt`.

The P0 HTML/Worker harness source is in `packages/majsimai-browser/host/` and its published copy stays in ignored `.tools/dotnet-publish/p0-harness`; it is not included in `public/wasm` or the product build. Release JSON serialization uses the source-generated `ParserJsonContext`; the actual trimmed Release assembly was exercised in Chromium. Publish reports existing upstream CA2024/CA1416 analyzer warnings, but no JSON trimming warning. The vendor copy has its upstream GPL-3.0-or-later license and local browser-only patch recorded alongside its source.

## Chromium Release results

Validated 2026-09-23 on Playwright Chromium 153.0.8010.12, macOS arm64, headless, with no CPU or network throttling. The cold standalone harness reached ready in 75.9 ms; its .NET Worker reported 51.3 ms initialization. The copied `public/wasm` tree occupied 5,866,250 bytes on disk, including raw and precompressed framework variants and runtime notices; this is not a compressed transfer-size measurement.

The direct Release harness passed the baseline Tap/Hold expectations, 15 strict boundary cases (including `1bx` and `2hx[#0.25]`), the full [`p3-touch.maidata.txt`](../fixtures/charts/p3-touch.maidata.txt) manual fixture (difficulty 1: all 7 Touch/Touch Hold notes editable and matching hand-authored values; difficulty 2 `D4x`: read-only, no unsupported note leaked into the DTO), the separate `E1`-versus-terminal-`E` fixture, and a raw-string BOM/emoji/CRLF UTF-16 range check. The harness completed without browser console or page errors. The fixture is synthetic and is not a player compatibility test.

For the normal 1,000-note Tap/Hold workload (300 seconds, 10 Holds, 9,600 subdivisions, no Slide segments), two parses warmed the Worker and ten further parses were measured. Worker time includes strict parsing, the pinned whole-chart semantic check and JSON serialization: median 23.35 ms, P95 38.20 ms. In-page Worker `postMessage` round-trip median was 31.20 ms, P95 41.60 ms. The separate Playwright/CDP evaluation measured 55.97 ms median and 73.63 ms P95. A single 10,000-note pressure observation after those samples took 116.60 ms in the Worker, 118.0 ms in-page and 177.0 ms through Playwright/CDP. Both synthetic inputs were editable; no Slide performance was measured. The 50,000-note case was dropped from routine validation.

The standalone measurements exclude chart-core model construction and React rendering. A separate production editor integration run is recorded by the application validation task. No external player playback or Slide behavior was verified here; unsupported difficulties must remain read-only.

Run the local checks with:

```sh
bash tools/dotnet/setup.sh
node tools/dotnet/publish-majsimai-browser.mjs
node tools/dotnet/measure-runtime.mjs
```
