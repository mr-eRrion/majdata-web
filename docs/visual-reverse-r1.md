# Visual Maimai R1：皮肤、Hold 与 Touch 静态恢复

日期：2026-09-27。目标为用户提供的 `Visual Maimai/Visual Maimai_Data/Managed/Assembly-CSharp.dll`，SHA-256 为 `e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`，MVID 为 `58e61df1-0329-40d9-801a-4e104725cca0`。证据来自 ILSpy 对选定类型与方法的反编译以及 MethodDef / TypeDef 元数据表；没有运行目标程序，也没有用截图验证运行时画面。

本次固定使用本地 `.tools/dotnet` 的 .NET SDK `10.0.401` 和 [ilspycmd 11.1.0.9782](https://www.nuget.org/packages/ilspycmd/11.1.0.9782)。安装隔离在 `.tools/visual-reverse/bin/`，没有全局安装。复现 R1 的命令为 `bash tools/visual-reverse/decompile.sh --group r1`；工具缺失时脚本会安装固定版本。它把程序集哈希、工具版本、选定类型与元数据表写进 `.tools/visual-reverse/r1/`，并保存类型源码、目标方法片段、TypeDef / MethodDef 映射和 Touch alpha 歧义方法的单独 IL。给 R2 / R3 提取其他类型时可用 `bash tools/visual-reverse/decompile.sh --group r2 --type 'Gameplay.Control.SlideLineControl' --type 'Gameplay.Mono.SlideLineMono'`，输出在 `.tools/visual-reverse/r2/raw/`；需要单方法源码时追加 `--member 0x06000339`，只需核对一个 IL 方法时追加 `--il-member 'SlideLineControl::UpdateSlide'`。原始产物默认在 `.tools/` 忽略目录，使用脚本可重新生成。

## 皮肤装载规则

`SkinManager.Start` 从序列化的 `defaultSkin` 深拷贝 Tap、Hold、Slide、SlideMulti、Touch、TouchHold 六种 Note 实例及 SlideLine、SlideWifi、Star 实例，先全部停用，再以 `SettingsManager.CurrentSettings.currentSkin` 调用 `LoadSkin`。缺少皮肤名或皮肤目录时直接用 `defaultSkin` 初始化对象池；换皮肤时先归还活动 Note、清空对象池，再重新装载。`SkinData` 由 `noteInstances`、`slideLineInstance`、`slideWifiInstance`、`starMono` 四部分组成。

| 目标实例 | 皮肤文件 | 代码中的用途 |
| --- | --- | --- |
| Tap | `tap.png`、`tap_each.png`、`tap_break.png`、`tap_ex.png` | 单音符、each、Break、EX 覆层 |
| Hold | `hold.png`、`hold_each.png`、`hold_break.png`、`hold_ex.png` | Hold 主体状态与 EX 覆层 |
| Slide 星头 | `star.png`、`star_each.png`、`star_break.png`、`star_ex.png` | Slide Note 头部；`star_double` 对应 `SlideMulti` |
| SlideMulti 星头 | `star_double.png`、`star_double_each.png`、`star_double_break.png`、`star_double_ex.png` | 多轨 Slide 头部 |
| Touch | `touch.png`、`touch_each.png`、`touch_point.png`、`touch_point_each.png` | 外圈三角与中心点，each 分别切换 |
| TouchHold | `touchhold_0.png` 至 `touchhold_3.png`、`touchhold_border.png` | 四个预设三角与进度环边框；中心点复用 `touch_point.png` |
| Slide 条带 | `slide.png`、`slide_each.png`、`slide_break.png` | 分别替换默认 SlideLine 单音符、each、Break 材质贴图 |
| Wi-Fi | `wifi_0.png` 至 `wifi_10.png`；`wifi_each_0.png` 至 `wifi_each_10.png`；`wifi_break_0.png` 至 `wifi_break_10.png` | 分别替换 `arrowsSingle`、`arrowsMulti`、`arrowsBreak` 的 11 个元素 |

上表文件总计 61 张，与目标包中的 `Visual Maimai/Skins/经典/` 目录清点结果一致。代码从 `Path.GetDirectoryName(Application.dataPath)/Skins/<skinName>/` 读取；目标包的经典皮肤 PNG 就在该目录下。外部 `hold.png` 实测为 122 × 200 RGBA；外部 `touch.png` 与 `touchhold_0.png` 为 112 × 82 RGBA。PNG 像素尺寸是文件证据，不能据此推定场景 Sprite 的 Rect、Pivot 或缩放值。

`LoadTap` 为四个 Tap 类实例分别按文件名前缀加载四种状态。Hold 是 `TapMono` 子类：`InitNote` 在 Break 时选 `breakSprite`，否则按 `isMulti` 选 `singleSprite` / `multiSprite`；EX 纹理独立赋给 `exModel.sprite`，由 `isEx` 控制该 Renderer 显隐。Hold 控制器传入 Break / each / EX 状态，并把 EX 颜色设为 Single `(0.95, 0.69, 0.86)`、Multi `(1, 1, 0.35)` 或 Break `(1, 0.69, 0.23)`。StarMono 的单音符 / each / Break 纹理再从已加载的 Slide `TapMono` 复制，因此星头与游动星共享同一组 PNG。

每个 Sprite 文件用默认 Sprite 的 `rect.size` 创建初始 `Texture2D`，解码后再以默认 Sprite 的 `rect`、归一化 Pivot、`border` 重建 Sprite；代码常量为 Pixels Per Unit `100`、extrude `1`、`SpriteMeshType.FullRect`。这意味着外部贴图沿用默认 Sprite 的裁切和边框元数据，没有从外部 PNG 重新推导 Pivot 或边框。Slide 条带 `Material` 会先实例化，然后同时设置 `mainTexture` 与 Shader 属性 `_EmissionMap` 为新贴图。

存在两级回退。皮肤目录缺失时整套使用 `defaultSkin`；贴图解码返回失败时对应元素用默认 Sprite / Texture。另一方面，`FileManager.LoadTexture` 在解码前直接执行 `File.ReadAllBytes(path)`，缺图会抛异常；`LoadSkin` 外层捕获该异常并为对象池初始化整套 `defaultSkin`。因此不能把“单文件缺失必定逐项回退”当成规则；只有加载调用返回 `false` 时才是逐项回退。

## Hold 状态规则

普通 Tap / Hold 共用 `NoteControl` 基类的时间定位：`HitTime = Bpm.GetTime(note.hitTime)`，`EndDistance = GetDistance(HitTime)`，每帧 `Distance = EndDistance - RuntimeManager.CurrentDistance`。Touch 与 TouchHold 使用 `GetTouchDistance` 和 `CurrentTouchDistance`；类型判断是 `noteData is TouchData`，而 `TouchHoldData : TouchData`，所以 TouchHold 也走 touchSpeed。基类普通 Note 的可见条件是 `Distance < Functions.MaxLength`，代码常量 `MaxLength = 5.6`。Tap 使用基类位置更新：`Distance > 3.6` 时 Y 固定为 `3.6`，Note Transform 缩放为 `(5.6 - Distance) / 2`，BeatLine alpha 同值；否则 Y 为 `Distance`、缩放与 BeatLine alpha 均为 `1`。Tap / Hold 的 Note Sprite alpha 本身不变。R4 的 RuntimeManager 复核记录了 `GetDistance(t) = t × speed × 1.44444` 和 `GetTouchDistance(t) = t × touchSpeed × 1.44444`。速度是运行时设置，Web 当前默认值 `8` 不是已恢复的目标运行值。

`HoldControl` 将 `hitTime + holdTime` 交给 BPM 时间换算得到绝对结束时间，并用 `GetDistance` 换成绝对结束距离。它使用同一基类可见窗和 `3.6` 的缩放边界，但另行更新 Hold 长度与端点：

令 `d = max(Distance, 0)`，Hold 可见位置与长度由以下分支控制：

```text
若 d > 3.6：
  headY = 3.6
  scale = (5.6 - d) / 2
  beatlineY = 3.6
  beatlineAlpha = scale
  bodyLength = 0
  endpointVisible = 新实例初始状态（Unity 分支没有显式改写）
否则：
  scale = 1
  headY = d
  remaining = holdEndDistance - max(currentDistance, endDistance)
  bodyLength = min(remaining, 3.6 - d)
  beatlineY = d
  beatlineAlpha = 1
  endpointVisible = remaining <= 3.6 - d
```

`SetLength(length)` 将终点子对象本地 Y 设为 `length`，并把主体与 EX Renderer 的 `size.y` 设为 `1.4 + length`。长 Hold 因而按视窗余量截短；发生 seek 时应按当前 `Distance` 和结束距离重算，不应累加上一帧长度。远端分支把 Hold 主体长度清零，并把头部 / beatline 固定在 Y `3.6` 处渐隐。该分支没有调用 `endPoint.gameObject.SetActive`，`GetObject` 也没有显式重置端点 active；对象池复用时此状态可能继承前一实例。纯状态 Web 实现把远端 `endpointVisible` 规范化为新实例默认 `false`，这是为无历史帧状态选择的实现约定，不是已恢复的 Unity 分支规则。

最小几何样例：假设控制器算出的 `d = 1`、`remaining = 2`，则 `headY = 1`、`bodyLength = 2`、主体 `size.y = 3.4`，终点显示，因为 `2 ≤ 3.6 - 1`。这只是复算控制器规则的合成输入，不代表某个目标谱面的 BPM、速度或场景值。

## Touch 与 TouchHold 状态规则

普通 Touch 取 `touchPositions.positions[button]` 作为本地位置，并将 Z 设为 `hitTime / 100`；ChartData 的 `isBigTouch` 为真时，Note Transform 的局部缩放是 `(1.5, 1.5, 1)`，否则是单位缩放。Touch 在 `Distance < 4` 时可见。每帧计算：

```text
spread = 0.3 × (1 - (Distance / 4 - 1)^4)
alpha = 4 - Distance
```

`TouchMono.SetScale` 将 `spread` 夹在 `[0, 0.3]` 后写入四个三角 Renderer 的本地位置 `(0, spread)`；它不是 Note Transform 的缩放。`SetAlpha` 将输入夹在 `[0, 1]`，先计算 `alpha²` 并将相同颜色写给中心和所有三角。因此全部 Touch 部件 alpha 相同，均为平方后的值。单独 IL 片段中 `IL_0022`–`IL_0024` 将输入相乘，`IL_002C` 保存修改后的中心 Color，`IL_0041` 将同一 Color 写给每个三角；对应方法 token 为 `0x0600029E`、RVA `0x0000F88C`。each 状态把三角切到 `touch_each.png`，中心切到 `touch_point_each.png`。

TouchHold 使用同一套 Touch Renderer 状态，但时间窗常量是 `3`，即仅在 `Distance < 3` 可见，spread 公式为 `0.3 × (1 - (Distance / 3 - 1)^4)`，输入 alpha 为 `3 - Distance`。初始化只把进度重置为零，不调用 `TouchMono.InitNote`，因此保留 `SkinManager` 先设置的 TouchHold 三角贴图：四个 `touchhold_i.png`，中心复用单音符 `touch_point.png`。TouchHoldControl 的进度是 `(time - HitTime) / (_holdTime - HitTime)`，每帧写入 Shader `_Angle` 前夹到 `[0, 1]` 并乘 `360` 度。

最小 Touch 样例：`Distance = 3.5` 时 `spread ≈ 0.299927`，输入 alpha 为 `0.5`，中心与全部三角 alpha 均为 `0.25`，且 `3.5 < 4` 所以 Note 可见。最小 TouchHold 环样例：处于 Hold 区间一半时 `progress = 0.5`，Shader 角度为 `180°`；区间外的值由 Setter 夹到 `0°` 或 `360°`。这些是纯代码状态样例，没有覆盖 Unity Shader 的屏幕像素效果。

## 来源、证据等级与未决项

主要 TypeDef / MethodDef 来源如下；token 只对上面列出的 Assembly-CSharp 哈希有效。精确映射和 RVA 保存在 `.tools/visual-reverse/r1/raw/type-method-map.json`，方法伪代码保存在同目录 `member-<token>.cs`，完整选定类型源码也保存在该目录。

| 恢复内容 | 类型与关键成员 |
| --- | --- |
| 皮肤克隆、装载、回退、贴图绑定 | `Gameplay.Manager.SkinManager` `0x0200007C`：`LoadSkin` `0x060002FD`、`LoadTap` `0x060002FE`、`LoadTouch` `0x060002FF`、`LoadSlide` `0x06000300`、`LoadTexture` `0x06000302`、`LoadSprite` `0x06000303` |
| 皮肤对象结构与对象池 | `Gameplay.Data.SkinData` `0x0200007D`；`Gameplay.Manager.NoteInstanceManager` `0x02000079`，`InitPool` `0x060002C9` |
| Tap / Hold / Touch 纹理状态 | `Gameplay.Mono.TapMono`：`InitNote` `0x06000295`；`Gameplay.Mono.HoldMono`：`InitNote` `0x06000273`；`Gameplay.Mono.TouchMono`：`InitNote` `0x0600029D`、`SetAlpha` `0x0600029E`、`SetScale` `0x0600029F` |
| Hold 与 Touch 动态更新 | `Gameplay.Control.HoldControl`：`UpdateNote` `0x0600031B`、`SetLength` `0x0600031C`；`Gameplay.Control.TouchControl`：`UpdateNote` `0x06000348`；`Gameplay.Control.TouchHoldControl`：`UpdateNote` `0x0600034F` |
| 共同时间基类与 Tap 位置更新 | `Gameplay.Control.NoteControl` `0x02000086`：`.ctor` `0x0600031F`、`OnUpdate` `0x06000320`、`UpdateNote` `0x06000324`、`IsNoteVisible` `0x06000328`；`Gameplay.Control.TapControl` `0x0200008A` |
| TouchHold 类型继承与默认可见窗 | `Global.Chart.TouchData` `0x0200005C`；`Global.Chart.TouchHoldData` `0x0200005D`；`Global.Utils.Functions` `0x02000043`，静态构造中的 `MaxLength = 5.6` |
| TouchHold 进度环 | `Gameplay.Mono.TouchHoldMono`：`SetProgress` `0x0600029A` |
| PNG 解码语义 | `EditorScene.FileManager`：`LoadTexture` `0x06000368` |

代码常量和状态转换属于静态恢复；外置 `经典` PNG 的文件名、像素尺寸来自本地文件检查。Unity 场景中序列化的 `defaultSkin` 引用、Sprite Rect / Pivot / Border、Material 参数和 33 个触点坐标已由 [场景提取](visual-scene.md) 独立恢复，源对象 ID 和属性保存在 [rendering.json](../fixtures/visual-maimai/rendering.json)。运行中的皮肤/速度设置、`isBigTouch` 和 TouchHold Shader 的像素裁切方向仍未验证。Web 当前采用标准 Touch 大小与速度 8；后续已从 [SprFill 字节码](touchhold-shader.md) 恢复上方起始、顺时针填充规则并接入动态遮罩，目标运行像素校准继续保持未完成。
