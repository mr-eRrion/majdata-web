# 皮肤与音频资源浏览器测量

`tests/skin-audio-resources-browser.mjs` 用仓库现有 Playwright Chromium 打开 4173 上的生产预览，估算核心 PNG 解码、圆形预览初始化，以及真实音频导入和波形生成对 Chromium 进程组 RSS 的影响。它只观测现有应用行为，不改音频实现，也不下载浏览器。

## 测量步骤

脚本依次记录 about:blank 基线、应用和 20 张必需核心音符 PNG 已下载但 `HTMLImageElement.decode()` 暂停时的 RSS、放行并确认 20 张图片解码后的 RSS。随后单独采样圆形预览启动阶段，再点击“打开示例”，等待预览报告 `data-skin-ready="true"` 且 Pixi canvas 已创建，再记录预览就绪 RSS。报告还列出主页面 Resource Timing 中观测到的 `.wasm` 资源；若 WASM 已内联、由其他 URL 加载，或由 Worker 独立加载，该列表可能为空。

音频夹具由脚本在系统临时目录生成：300 秒、48 kHz、双声道、PCM16 静音 WAV，文件大小为 57,600,044 字节。一个初次导入之后，脚本逐个选入十个不同文件名的同内容 WAV；每一步都等待歌曲名和时长出现。应用只有在 `load()` 和 `buildCurrentWaveform()` 完成后才结束该加载状态，因此下一个选择不会与前一个波形任务并发。脚本同时记录每次 `decodeAudioData` 结果和生产 Worker 实际收到的分块帧数、分块数及累计 PCM 复制字节。

RSS 通过 CDP `SystemInfo.getProcessInfo` 确定本次 Chromium 的进程 PID，再用系统 `ps` 读取这些进程的 RSS；空页与各阶段另取 4 个样本作为中位数，运行期间以 100 ms 间隔持续采样以估计峰值。换歌趋势使用 11 次完成后的稳定 RSS 中位数，报告首尾净变化、每次替换的线性斜率、$R^2$ 和相邻增长次数。原始逐点采样、各阶段峰值、逐曲结果和运行环境写入 `/tmp/maijdata-skin-audio-resource-results.json`；终端仅显示结果路径及关键摘要。

## 运行

使用当前生产构建并先启动本地预览：

```sh
pnpm build:web
pnpm preview --host 127.0.0.1 --port 4173
```

另开终端执行：

```sh
PLAYWRIGHT_BROWSERS_PATH=.tools/playwright node tests/skin-audio-resources-browser.mjs http://127.0.0.1:4173/
```

如果 Chromium 不在该 Playwright 浏览器目录，可通过 `BROWSER_EXECUTABLE=/path/to/chromium` 指定现有可执行文件。脚本会删除本轮在系统临时目录生成的 WAV 和链接。

## 结果与解释

| 指标 | 结果 |
| --- | --- |
| 浏览器 / 系统 / CPU | Chromium 153.0.8010.12 / macOS arm64 / Apple M4，1440×1000 DPR 1 |
| about:blank RSS 中位数 | 198.6 MiB |
| 核心 PNG 解码前 → 解码后 RSS 中位数 | 438.1 → 443.9 MiB；增量 5.8 MiB |
| 圆形预览就绪 RSS 中位数与 WASM 资源 | 585.3 MiB；主页面 ResourceTiming 不包含专用 Worker 的 WASM 请求，后者已在独立子路径验收中确认 |
| 5 分钟音频实际解码格式、PCM 字节数 | 48 kHz / 2 声道 / 14,400,000 帧，115,200,000 字节 |
| 十一次顺序导入的 Worker 分块 | 每次 32 块，累计传输 115,200,000 字节 PCM；每次一个真实解码调用 |
| 全程采样 RSS 峰值与阶段 | 942.9 MiB；第一次换歌解码/波形阶段；相对空页增量 744.2 MiB，**超过 512 MiB 初始预算** |
| 十次替换后的 RSS 净变化 / 线性趋势 | +10.4 MiB；拟合 +0.62 MiB/次，R²=0.215；后段出现回落，未见稳定线性累积，不能据此排除泄漏 |
| 关闭页面后进程组 RSS | 273.2 MiB |

以上为 2026-09-27 首轮完整应用实测，[原始报告](results/2026-09-27/skin-audio-initial.json) 保留逐点数据。加载及释放流程完成，但内存预算未通过。RSS 是浏览器进程组的粗略占用量，可能重复计算共享页，并包含渲染器、GPU、解码器、分配器和图片缓存；GPU 专用显存未必体现在进程 RSS 中。100 ms 采样可能漏掉更短的峰值，线性趋势也不能证明或排除长期泄漏。暂停图片 `decode()` 不能控制浏览器内部的压缩数据缓存或预解码行为。报告不包含 Node 测试进程自身占用；测试用 WAV 为静音合成数据，不能代表任意编码、采样率或声道布局的解码器开销。

## 单首音频分阶段复测

新增 `tests/skin-audio-memory-phases-browser.mjs` 将空白页、应用启动、选入文件、decode开始/完成、波形分块/完成和稳定阶段分别记录。使用现有完整Chrome可执行文件，等待空白页启动稳定后采样；保留可执行文件SHA-256、浏览器页面目标、各PID/PPID/命令行、按进程类型RSS和实际服务的index哈希。阶段边界回调会等待一次RSS采样，存在额外测量开销；未强制GC，也未重复十次换歌。本轮已包含新增烟花标记，核心图片数为21，前述20张与十次换歌数据保留为历史测量。

2026-09-27复测结果见[逐阶段报告](results/2026-09-27/skin-audio-memory-phases.json)：空白页793.1 MiB，选歌前1101.6 MiB，解码完成阶段采样峰值1308.8 MiB，相对空白页增量515.7 MiB；波形后稳定值比选歌前高23.5 MiB。300秒48kHz双声道PCM16文件为57,600,044字节，解码后Float PCM理论大小115,200,000字节，真实decode约104.5ms；32次Worker请求与回复、1次Worker终止均有记录。37个样本的进程类型分组与总RSS之和一致，无缺失PID、页面异常或采样错误。构建index哈希为 `feb4980193a54e328e22df7aef307723b5b7271045239b07945cc6725b932ff0`，测量前后及服务端一致。

本轮空白页有两个浏览器地址栏UI目标及额外renderer，[独立空页进程审查](results/2026-09-27/blank-process-audit.json)确认它们属于同一次启动的浏览器；不是应用创建的额外页面。旧完整测量没有记录浏览器文件哈希和启动参数，因此不能只凭版本字符串就将旧198.6 MiB空页与本轮793.1 MiB直接比较。诊断脚本初稿曾把导航过程继续记为空页，已在正式复测前纠正为独立的应用启动阶段；本节所链接报告使用修正后的脚本。

这些数据缩小了峰值位置，但不足以证明泄漏或证明预算通过。RSS包含共享页和浏览器缓存，稳定差额也不能直接归因于PCM；本轮没有相同口径的十次换歌趋势，V5内存出口继续未完成。
