# Timeline and circular preview validation

The UI components read immutable `DisplaySnapshot` data and do not own chart state. `Timeline.draw(chartSeconds)` and `CircularPreview.draw(chartSeconds)` accept the same chart-relative software time from the application scheduler; neither component creates a playback animation loop. Timeline edits are emitted as `EditCommand`s. The placement or move ghost is local to the timeline and is cleared on release, so the preview continues to show only the last confirmed snapshot until the Worker accepts the command.

## Implemented behavior

- The timeline draws BPM-aware beat subdivisions, eight position rows, a separate center-C Touch row, Tap / Hold / Touch / TouchHold notes, Break / EX marks, the shared playhead and an optional min/max waveform summary. Numbered Touch sensors retain their A–E area and index label. Waveform x-coordinates use `songSeconds = chartSeconds + firstSeconds`; no PCM is retained or read by the component.
- Ctrl/Command + wheel zooms around the pointer; wheel scrolls horizontally. The zoom buttons and “曲首” button provide direct controls. `snapDivision` is subdivisions per quarter-note beat and defaults to 4.
- Select mode supports single selection, Shift-add/remove, box selection and group movement. A completed movement emits one update command. Tap placement commits on release; Hold click uses `holdDuration` (one beat by default), while a dragged Hold records the dragged chart-time length as fixed seconds so its visible endpoint is preserved across BPM changes.
- The circular preview uses PixiJS 8 WebGL with the built-in ticker disabled. It draws the eight lane ring, upcoming Tap / Hold markers, fixed A–E Touch sensor locations and directly derives active Hold / TouchHold progress from the requested time. Lane 1 and A/B use the source phase 22.5° clockwise from top; D/E use the source's additional 22.5° offset, and C is at the center. The sensor phase/radii were copied from pinned game source and are not a game-renderer capture. It intentionally draws no Slide / Wi-Fi trajectory. Clicking a visible marker reports its id through the shared selection callback.
- Read-only charts remain visible and selectable; the timeline blocks placement and movement commands.

## Validation status

`pnpm typecheck`, `pnpm test` (8 files / 28 tests), and `pnpm build:web` passed with the integrated components. Vite reports the Pixi-inclusive application chunk at 567.57 kB minified / 173.75 kB gzip, above its generic 500 kB warning threshold. The P2 application browser pass, 1k-note performance run, and P3 Touch browser flow passed in Playwright Chromium 153.0.8010.12 on macOS. The P3 run exercised Touch-area placement, mirror / rotate inverse mappings, Break and BX ring notes, BPM-dependent TouchHold timing, metadata-as-text, multiple difficulties, read-only Touch EX preservation, and export/reopen; it reported no page errors. The screenshot was visually reviewed for Touch locations and hold progress. The main compatibility target is Chromium (Chrome / Edge); Firefox is not a current acceptance gate.

Run the app locally with `pnpm dev -- --host 127.0.0.1`, then open the Vite URL in Chrome or Edge. Use the built-in sample or a local supported chart to check:

1. Beat lines follow BPM changes, notes align with beat positions, and the waveform origin moves with positive and negative `firstSeconds`.
2. Zoom / scroll retain pointer position while zooming; Ctrl/Command-wheel changes scale and plain wheel moves the chart.
3. Select, Shift-select, box-select, Tap placement, Hold placement, and group movement produce the expected single command; reject/failure clears the ghost and reaches `onError`.
4. Read-only difficulty allows viewing and selection while preventing placement and movement.
5. Pause, seek into the middle of a Hold or TouchHold, and resume. The circular preview is reconstructed at that time without replaying prior frames; Touch markers stay at their source-derived sensors.
6. Resize the panels and verify both canvases remain crisp at DPR ≤ 2. Confirm no component starts its own `requestAnimationFrame` clock.

The component code does not measure physical sound output or assert that the WebGL preview is supported on every browser/GPU combination. Browser interaction findings should be added here with exact browser, OS and commands after the integrated review.
