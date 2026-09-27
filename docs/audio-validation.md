# 音频时间模块验证

本文记录 `apps/web/src/audio` 当前实现及其可复现的基础验证。模块不拥有界面、谱面解析器或可变谱面；调用方提供编译后的事件时间，再读取同一音频主钟的快照。

## 时间与播放规则

模块统一使用 `s = c + firstOffsetSeconds`：`c` 是相对谱面起点的时间，`s` 是 `AudioBuffer` 中的歌曲秒数。播放位置由 AudioContext 锚点和当前 0.5 / 1 / 2 倍播放率直接计算，不累计动画帧时间。seek、速度、偏移、循环和换歌都会更新播放代次并停掉旧音源与已预约的音效。

当歌曲位置 `s < 0` 时，播放头继续走虚拟时间，音效照常按事件时间预约；主音源只在 `s = 0` 对应的未来 AudioContext 时刻以非负 offset 启动。音源开始时刻按播放率缩放，音源 offset 始终是原始音频秒数。已载入歌曲在缓冲区末尾暂停，尾后再次播放仍停在尾点；没有歌曲时允许只运行人工合成音效。循环边界以谱面时间输入，必须映射到非负且位于歌曲长度内的样本区间。

`chartSeconds` 和 `songSeconds` 是软件时钟位置。`estimatedAudibleChartSeconds` 仅在浏览器提供可用的 `getOutputTimestamp()` 时返回估算值；正的设备校准秒数会向前移动这个显示估值，不会改变 `&first`、谱面事件时间、音源 offset 或音效预约。没有可用时间戳时应以软件时钟作为明确标注的显示回退。当前没有外部录音回环或扬声器 / 蓝牙实测，所以不报告物理音画偏差。

## 解码、释放与波形预算

一次最多执行一个 `decodeAudioData`。新候选替换尚未开始的等待候选；正在执行的解码无法中断，完成后依代次丢弃过期结果。选择新歌曲时先停止音源并清空旧 `AudioBuffer` 引用。默认准入上限为 300 秒和 256 MiB PCM；可用媒体元数据先按 AudioContext 输出采样率、给定声道数估算，未提供声道数时估算为双声道，解码后再以实际采样率、声道数、时长和 PCM 字节数复核。浏览器解码器内部的临时内存由浏览器控制，代码不能精确限制或直接测得；估算与事后检查不等于峰值测量。

`buildCurrentWaveform()` 只在调用时创建临时 Worker。它按最多 512 个基块切片 PCM，每次只复制并转移一个帧块，再由同一个 Worker 计算 min/max 并回传固定大小的基础摘要；主线程组装后续聚合层，默认摘要不超过 1 MiB。5 分钟、48 kHz 双声道的最大单次输入块约 3,600,384 字节（约 3.44 MiB），整次波形任务累计输入 PCM 仍受默认 128 MiB 准入限制。返回后或换歌时关闭 Worker 并释放临时 PCM。`AudioTransport` 不向 UI 暴露 AudioBuffer，也不把波形缓存放进播放状态。超过总复制预算时保留音频播放但跳过波形生成。

音符试听由短时 oscillator 和包络合成，不读取外部音效素材。已排队节点随播放代次变化立即停止，单次最多保留 128 个合成节点。

## 自动化检查

运行 `pnpm test` 会检查正负偏移换算、AudioContext 锚点与速率、循环位置、事件二分查询、波形 min/max 金字塔、单解码 latest-wins，以及 `resume()` 等待期间的 pause 和并发 play 竞态。运行 `pnpm typecheck` 检查浏览器接口和调用类型。

## 浏览器实验

`fixtures/audio/reference-tone.wav` 是由同目录 `generate-reference.mjs` 生成的 10 秒双声道 48 kHz PCM WAV。220 Hz 低音连续播放，并在 0、2、4、6、8 秒附近叠加 80 ms 的 1200 Hz 标记音。人工谱面时间事件见 `reference-events.json`，其中 chart 时间 0 对应歌曲样本位置 -0.25 秒。重新生成夹具使用 `node fixtures/audio/generate-reference.mjs`。

真实浏览器检查页为 `fixtures/audio/audio-harness.html`。在仓库根目录运行 `pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port 5173`，然后打开 `http://127.0.0.1:5173/@fs/<仓库绝对路径>/fixtures/audio/audio-harness.html` 并点击 “Run browser check”。它实际解码并播放 WAV，检查正负偏移、负预滚、0.5 / 2 倍速度、循环边界、暂停冻结和 Worker 波形摘要。报告里的速度值和音效预约均来自浏览器软件时钟，不是扬声器输出录制。`decodedBytes` 是稳态 AudioBuffer 大小，不是导入或换歌峰值；内存峰值仍需在约定浏览器版本上通过浏览器任务管理器或性能面板实测，并记录设备、格式、媒体长度和旧音轨释放时点。

2026-09-23 在 Codex 内置浏览器（UA `Chrome/153.0.0.0` / macOS，Vite `8.3.0`）实际运行的结果：WAV 解码为 48 kHz 双声道、3,840,000 字节；10 秒波形 Worker 返回每声道 16,000 个基块、15 层 min/max 摘要，共 512,016 字节。`c = 0.5` 分别映射到 `s = 0.25`（first = -0.25）与 `s = 0.75`（first = +0.25）。负预滚从 `s = -0.25` 开始，播放 100 ms 后仍小于 0；0.5 倍速的 241 ms 软件时间推进 120 ms，2 倍速的 142 ms 推进 288 ms；循环播放头回到 `c = 0.45` 且在 `[0.3, 0.6)` 内；暂停后 100 ms 的软件播放头漂移为 0。浏览器提供 `getOutputTimestamp()`，但没有做声卡回环录音，不能据此声称测得物理输出延迟或音画同步误差。媒体为 10 秒合成夹具，未通过浏览器任务管理器或性能面板测导入峰值、换歌峰值或长音轨释放曲线；3,840,000 字节仅是解码后稳态 PCM 大小。

### 5 分钟双声道资源测量（2026-09-23、2026-09-27）

在整段 PCM clone 的旧实现下，使用 `tests/audio-resources-browser.mjs` 于项目已安装的 Playwright Chromium `153.0.8010.12`、Apple M4/macOS、headless 实测 300 秒、48 kHz、双声道 PCM16 静音 WAV（编码文件 57,600,044 字节；测试在 `/tmp` 生成，不作为项目媒体发布）。实际 `AudioBuffer` 为 115,200,000 字节 Float32 PCM，采样率 48 kHz。波形 Worker 返回 524,256 字节、每声道 16,383 个基块、15 层 min/max 摘要；旧实现把完整 115,200,000 字节 PCM 复制后一次性转移。暂停状态下 seek 到 123.456 秒后快照精确返回同一软件歌曲位置。已有音轨时连选十个候选，测试确认一个在途候选解码完成后仅再解码最终候选：本轮 2 次 decoder 调用、9 个请求 `superseded`、`swap-9.wav` 加载成功。随后无效 WAV 返回 `rejected`，播放状态为 paused、track 为 null；当前策略在选择替换音轨时先释放旧 Buffer，因此失败候选后不会自动恢复旧曲。

该次旧实现运行用 Browser CDP 的 `SystemInfo.getProcessInfo` 只取本次测试 Chromium 进程 PID，并每 150 ms 用 `ps` 汇总这些 PID 的 RSS。about:blank 基线为 204,750,848 字节；导入阶段峰值 413,302,784 字节；波形阶段峰值 684,654,592 字节；十次候选替换阶段峰值 934,838,272 字节，相对基线增加 730,087,424 字节（约 696.3 MiB），超过首版 512 MiB 目标。坏媒体后 1 秒仍为 917,553,152 字节；关页后进程组 RSS 回到 195,395,584 字节。抽样显示峰值在连续换曲阶段；旧实现的全长波形 PCM 副本可解释波形阶段的主要额外数据量，但这次没有逐进程或高频采样，不能据 RSS 断定具体活跃对象或分配器回收延迟。RSS 可能重复计算进程间共享页，也包含浏览器/GPU/解码器内存，并非准确的页面堆或存活 PCM 计数；关页后回落也不能证明传输器 dispose 时及时释放。完整机器可读记录为 `/tmp/maijdata-audio-resource-results.json`。

之后将波形输入改为每 512 个基块一次的顺序 Worker 转移，避免同时持有整段 PCM 副本。2026-09-27 对这版实现做了两种浏览器进程 RSS 测量，两份记录的负载和基线不同，不能把数值差解释成同一条件下的内存回归或优化：

- `skin-audio-initial.json` 是完整应用、核心皮肤和预览就绪后的一次首载加十次顺序换歌，100 ms 采样。峰值为 988,659,712 字节，相对 about:blank 中位基线 208,257,024 字节增加 780,402,688 字节（744.2 MiB）。五个基线样本的前四个约为 208 MiB；第五个样本已因 `audio.mojom.AudioService` 出现升至 326,057,984 字节，但五样本中位数仍取低值。
- `skin-audio-memory-phases.json` 是生产应用单次导入同规格 WAV，Chromium 启动后先等待 2.5 秒再取空白页基线，并在导入各阶段采样。37 个 RSS 样本的空白基线为 831,668,224 字节；`decode-complete` 峰值为 1,372,405,760 字节，较空白基线增加 540,737,536 字节（515.7 MiB）。该峰值只采到一个样本，100 ms 周期仍可能漏掉更短的峰值。应用与预览就绪时为 1,154,449,408 字节；峰值较此增加 217,956,352 字节（207.9 MiB），这只用于拆分该次运行的阶段增量，不能替代包含页面和皮肤成本的总预算基线。

按 512 MiB 的空白页 RSS 增量目标，515.7 MiB 仍高约 3.7 MiB，不能判为通过；而且单次导入没有复测十次换歌场景。744.2 MiB 与 515.7 MiB 使用不同的浏览器启动等待、基线样本、页面阶段和换歌次数，不能据此声称新实现降低了约 228.5 MiB。RSS 仍是浏览器进程组估算，可能重复计算共享页，也包含 renderer、GPU、解码器、分配器和缓存；稳定样本或关页后的变化不能直接证明哪些对象仍存活。完整记录分别见 `docs/results/2026-09-27/skin-audio-initial.json` 和 `docs/results/2026-09-27/skin-audio-memory-phases.json`。这两次实验没有强制 GC，也没有测扬声器/蓝牙延迟。

代码审查未发现当前波形路径复制整首 PCM：`waveform.ts` 每轮最多复制 512 个基块，双声道输入块约 3.44 MiB 后即转移给 Worker；`waveform.worker.ts` 用 `Float32Array` 包装转入的 ArrayBuffer 视图，并只回传受限大小的 min/max 摘要。Worker 在任务结束或换歌时关闭，传输器在换歌时清空旧 `AudioBuffer` 引用；运行时保留一个供播放使用的 `AudioBuffer` 是预期行为。浏览器解码器与分配器的内部暂存无法由这些代码判定。UI 的 `openFiles()` 在等待波形完成期间仍有原始 `File` 的局部引用，但这不能证明浏览器继续驻留一份编码字节副本。测量脚本的解码监听只保存数值元数据；阶段探针在 `decode-complete` 采样时会短暂把同一个 `AudioBuffer` 留在回调栈中，不会额外克隆它。换歌测试的皮肤解码 gate 会暂存 HTMLImageElement 引用到本轮结束，这影响的是皮肤对象生命周期，不是音频 Buffer。旧的直接传输器竞争测试会按需暂缓一个解码结果，但那不是上述 744.2 MiB 应用测量所用的测试。

后续复测可并行记录 macOS 自带 `/usr/bin/footprint`：本机手册支持 `--targetChildren`、`--sample`、`--sample-duration` 和 JSON 输出；对多个进程会去重多重映射对象，并分列共享与私有对象。可从 CDP `SystemInfo.getProcessInfo` 取得 Chromium browser PID 后，在同一负载期间运行：

```sh
/usr/bin/footprint --sample 0.5 --sample-duration 30 --targetChildren --pid "$BROWSER_PID" --json /tmp/maijdata-footprint.json
```

默认报告包含 Dirty、Clean、Reclaimable 等分类，可作为共享页影响的辅助诊断；它不是 RSS，也不能直接替代当前 512 MiB RSS 门槛。手册注明 `--vmObjectDirty` 模式计算开销较大，不适合频繁实时采样，因此不建议把它加入常规 100 ms 采样。随后已执行以下并行复测；实际 JSON 标记 `vm_object_dirty_analysis=true`，所以不能假定该调用采用了不同的低开销口径。

### 当前版本十次顺序换歌复测

生产入口 `index-BBGb8KFi.js` 使用同一 300 秒双声道 WAV，先等待空白页 2.5 秒再取基线，同时用系统 footprint 辅助采样。11 次真实 UI 载入（首载加十次换歌）均成功，每曲波形为 32 个顺序输入块，无页面或 RSS 采样错误。空白基线 788,774,912 字节，RSS 峰值 1,444,790,272 字节，增量 656,015,360 字节（625.6 MiB），仍超过 512 MiB；峰值发生于第七次载入。末次波形就绪 RSS 比首次低 30,490,624 字节（29.1 MiB），11 个稳态点没有稳定线性增长，但这一短时观察不能证明没有长期泄漏。脚本使用系统采样器会有额外测量开销；此数据不与之前不同基线的测量直接作优化比较。

footprint 保存 20 组样本、PID 并集覆盖 CDP 的全部 8 个进程，但 stderr 报告三个 renderer 无法分析。它们在 19 组 footprint 样本、125 组 RSS 样本中仍有非零记录，只在关页后的最后一组消失；错误没有时间戳，不能断言错误就是进程退出引起。原脚本把 JSON 可读误归为 complete，现已分开记录采集器结束与覆盖状态，本次经审查应为 **partial**。其 total footprint 峰值 859,104,688 字节不是 RSS，且采样起点早于稳定空白基线，不据此改判总内存预算。

保留 [RSS 原始结果](results/2026-09-27/skin-audio-sequential-current.json)、[footprint 原始结果](results/2026-09-27/skin-audio-footprint.json)、[stderr](results/2026-09-27/skin-audio-footprint-stderr.txt) 和 [事后覆盖审查](results/2026-09-27/skin-audio-footprint-review.json)。后续条带网格修复不涉及音频；该内存数值只对应上述入口版本，不冒充后续构建的重新测量。

复现（需先在另一个终端运行 Vite，并且只使用仓库已有的 Chromium）：

```sh
pnpm exec vite --config vite.config.ts --host 127.0.0.1 --port 5173
PLAYWRIGHT_BROWSERS_PATH=.tools/playwright node tests/audio-resources-browser.mjs http://127.0.0.1:5173/@fs/<仓库绝对路径>/fixtures/audio/resource-harness.html
```

## 对齐空白基线后的完整采样

后续生产入口 `index-TYMxAMaV.js` 使用相同300秒/48kHz/双声道WAV，首载后十次顺序换歌；没有修改音频产品实现。采集器先启动并等待空页稳定，再取11个明确RSS基线样本；footprint在关页之前结束，覆盖完整且无进程分析错误。当前脚本另补充导航阶段标记和显式基线窗，原始记录中两个导航样本误留的空白标签不参与本次基线计算。

进程组RSS基线796.6 MiB，峰值增量494.0 MiB，峰在第九次换歌解码/波形阶段。11次波形就绪后的RSS首末增加10.8 MiB，拟合斜率约0.777 MiB/次、R²约0.743；因此不能沿用上一轮“稳态没有增长”的结论，但这些有限样本也不足以证明长期泄漏或锁定具体对象。峰值增量主要来自renderer；目前没有完整PCM副本重复传输的证据，每首仍为32次分块波形请求。

按时间戳限定到上述空白窗的两个footprint样本，基线中位数405.7 MiB、抽样峰806.5 MiB，增量400.8 MiB。footprint半秒采样未命中153ms之后的RSS瞬时峰；两种指标包含的成本不同，不能互换。footprint首末就绪值反而下降9.2 MiB，进一步说明不能把RSS趋势直接解释为存活对象增长。原预算为页面增量512 MiB；本轮抽样低于目标，但此前625.6/744.2 MiB的RSS结果、基线差异和新出现的稳态增长仍需解释，故不关闭总体内存验收。

原始证据：[RSS](results/2026-09-27/skin-audio-sequential-aligned.json)、[footprint](results/2026-09-27/skin-audio-footprint-aligned.json)、[采集状态](results/2026-09-27/skin-audio-footprint-aligned-status.json)、[stderr](results/2026-09-27/skin-audio-footprint-aligned-stderr.txt)、[对齐审查](results/2026-09-27/skin-audio-aligned-review.json)。这些数据属于中键拖动修改之前的入口版本，不作为之后版本的内存重新测量。

## 音频对象存活诊断（2026-09-27）

针对此前 RSS 波动，新增 `tests/audio-retention-browser.mjs`，在真实生产应用内顺序加载 300 秒 / 48 kHz / 双声道 PCM16 WAV，完成波形后再换歌，共首次加载加十次替换。采用现有 Chromium 153.0.8010.12、主包 `index-Bu6yDX1X.js`（SHA-256 `655889bb930121cfef5376b2e95b11ccbf666a81519a191b4ba2cb257cf682aa`）；此轮没有加载谱面，不能替代完整编辑场景的页面内存预算。

探针只保存编码 ArrayBuffer 和解码 AudioBuffer 的 WeakRef 与标量信息，不强引用历史对象。第十次替换波形完成时，十个旧 AudioBuffer 均已不可访问，当前 AudioBuffer 仍存活；此时尚未调用诊断性强制 GC。编码 ArrayBuffer 也均已不可访问。随后显式 GC 的旧对象计数仍为零。页面 JS 堆 usedSize 从 6,422,372 变为 5,426,172 字节，backingStorageSize 从 117,144,993 变为 117,030,305 字节；共 11 次解码，无页面错误。原始记录见 [audio-retention.json](results/2026-09-27/audio-retention.json)。

这一结果未发现当前顺序换歌流程持续持有旧 AudioBuffer；它不能证明浏览器原生音频内存、分配器缓存或进程 RSS 已释放，也不构成 512 MiB 峰值预算达标。`decodeAudioData` 会分离输入 ArrayBuffer，因此即使编码对象包装仍存活，零 byteLength 也不能计作整份 WAV 仍被占用。没有因此修改生产音频逻辑。
