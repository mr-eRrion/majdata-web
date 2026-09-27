# Local recovery validation

## Storage contract

`apps/web/src/files/recovery.ts` stores one latest `Checkpoint` value under one IndexedDB key. It waits for the read/write transaction to complete before resolving. Storage failures, blocked database upgrades, and environments without IndexedDB reject to the caller; the module does not retry, clear an incompatible checkpoint, or migrate older data. `readRecovery()` distinguishes `available`, `none`, and `incompatible`. Only schema version 2 with the metadata fields is offered to the editor; schema version 1 is reported as incompatible and may include `originalBytes` when the raw byte array can be safely extracted. The editor engine remains responsible for full restore validation.

The checkpoint includes `createdAt` and its document version. Recovery stores chart state and original source bytes only; audio, waveform summaries, and undo history are not added. `discardRecovery()` deletes only the latest checkpoint key. `readChartFile()` checks the 4 MiB default limit before reading the file, and `downloadBytes()` is shared by source and candidate downloads.

## Browser evidence

On 2026-09-23, the one-key schema 2 write/read/delete path passed in Playwright Chromium 153.0.8010.12 using the project Chromium installed at `.tools/playwright`. The synthetic checkpoint was version 7 and included empty editable metadata plus four original bytes. Structured clone preserved the version, metadata and byte sequence; after `discardRecovery()`, the next read returned `none`. A schema 1 checkpoint returned `incompatible` while retaining extractable original bytes. This checks browser IndexedDB behavior; it does not measure quota limits, cross-tab coordination, persistence after browser profile deletion, or recovery correctness inside the chart engine.

2026-09-27：加入结构化 Slide 后，当前检查点升级为 schema 3。已有 Chromium 再次通过 schema 3 写入、读取、删除与原字节保留；schema 2 返回 `incompatible`，仍提供原稿下载。当前浏览器脚本已同步新旧版本号；上面的 schema 2 结果保留为历史记录。真实谱面的 Worker 恢复与导出重开在编辑器 / Slide 浏览器流程中另行检查。

Reproduce from the repository root:

```sh
pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port 5175
PLAYWRIGHT_BROWSERS_PATH=.tools/playwright node tests/recovery-browser.mjs http://127.0.0.1:5175/
```

The browser script performs one synthetic write/read/delete cycle and leaves the latest key empty. Manual recovery from the app should additionally verify that a loaded checkpoint is presented to the user before calling the engine's restore operation, and that incompatible data leaves the original byte download available without automatic cleanup.
