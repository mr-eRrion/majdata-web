# Visual Maimai 定向逆向调查

日期：2026-09-27。用途：为 Web 复刻定位真实逻辑入口，配合 [实施计划](../PLAN.md) 与 [阶段计划](../ROADMAP.md)。本次只做静态元数据与方法体存在性检查，没有执行目标程序集，没有反编译或解释具体方法体，也没有取得运行对照。

## 已取得的证据

使用仓库已有 .NET 10 的 PEReader / MetadataReader 只读解析 DLL，无需加载 Unity 或运行 Windows 程序，未新增工具依赖。定位来自程序集元数据，不仅是字符串搜索。临时检查产物在 /tmp，正式保留下面的入口与身份信息；后续反编译须固定工具版本与参数，产出可重复的提取清单。

| 程序集 | MVID | 类型定义数 | 方法定义数 | 含 IL 方法体数 |
| --- | --- | --- | --- | --- |
| Assembly-CSharp | 58e61df1-0329-40d9-801a-4e104725cca0 | 564 | 2431 | 2354 |
| SimaiSharp | 9b577573-b1d3-415d-a702-e78a3c0184d3 | 40 | 103 | 103 |

主程序集 SHA-256：`e235f01a6c28dc93aed5a7ffa239780c2a449ba122731b15a13594f24735369e`。方法 token 只对这份程序集有效；MVID 辅助标识，不代替哈希。统计含编译器生成类型和方法，不表示全部逻辑已理解或源代码可完整恢复。

## 优先阅读入口

下表入口均已确认含方法体，最后一栏是调查目的，不是已验证的行为。B 为 IL 方法体字节数，不是源码行数。

| 类型 | 方法、token 与 IL 大小 | 要查明的问题 |
| --- | --- | --- |
| `Gameplay.Manager.SkinManager` | `LoadTap` (`0x060002FE`, 332 B)；`LoadTouch` (`0x060002FF`, 390 B)；`LoadSlide` (`0x06000300`, 471 B)；`LoadSprite` (`0x06000303`, 114 B) | 图片加载、Sprite 参数、皮肤状态映射 |
| `Gameplay.Control.HoldControl` | `UpdateNote` (`0x0600031B`, 283 B)；`SetLength` (`0x0600031C`, 86 B) | Hold 长度与帧状态 |
| `Gameplay.Mono.TouchHoldMono` | `SetProgress` (`0x0600029A`, 44 B) | Touch Hold 进度与组件变化 |
| `Gameplay.Control.SlideLineControl` | `UpdateSlide` (`0x06000339`, 423 B)；`GetObject` (`0x0600033D`, 685 B) | Slide 时序、运动与条带状态 |
| `Gameplay.Mono.SlideLineMono` | `SetSlide` (`0x06000282`, 496 B) | 条带的空间组合 |
| `Gameplay.Mono.SlideWifiMono` | `SetSlide` (`0x0600028D`, 345 B) | Wi-Fi 的空间组合 |
| `Gameplay.Data.SlideTypesData` | `GetPath` (`0x06000310`, 216 B)；`GetPaths` (`0x06000311`, 251 B) | 命令到路径的选择 |
| `Gameplay.Manager.RuntimeManager` | `GetDistance` (`0x060002F4`, 19 B)；`GetTouchDistance` (`0x060002F5`, 19 B) | 速度与显示距离换算 |
| `Gameplay.Manager.InitManager` | `InitChartData` (`0x060002C3`, 605 B) | 解析结果到预览数据的转换 |
| `Gameplay.Manager.ProgressManager` | `get_Time` (`0x060002DB`, 12 B)；`get_RawTime` (`0x060002DD`, 11 B)；`set_Time` (`0x060002DC`, 57 B) | 时间、偏移与定位 |
| `EditorScene.Edit.NoteTrack` | `PlaceHold` (`0x060005D2`, 109 B)；`PlaceSlide` (`0x060005D3`, 261 B)；`EndDraggingNote` (`0x060005CD`, 312 B) | 桌面放置、拖动和提交 |
| `EditorScene.Slide.SlidePlacePanel` | `EndPaint` (`0x060003EE`, 253 B)；`UndoSlide` (`0x060003F2`, 169 B)；`Confirm` (`0x060003F4`, 102 B) | 路径绘制与取消 / 确认 |
| `EditorScene.Slide.SlideUtility` | `SelectSlideFromPath` (`0x06000407`, 276 B) | 绘制路径到轨迹类型的匹配 |
| `EditorScene.Edit.BeatLineManager` | `UpdateSelectedTime` (`0x0600059C`, 656 B) | 编辑时间与吸附 |
| `Global.Chart.ChartExporter` | `ExportNote` (`0x0600024C`, 1203 B) | 目标导出表达及兼容差异 |

还确认 `Gameplay.Data.SlidePathData` 含 `points`、`splitIndexes`、`enterAreaData` 字段，`RuntimeManager` 含 `slideTypes`、`touchPositions`、`tracks` 引用。下一步沿调用链追踪赋值来源，查明数据来自代码、场景序列化还是资源对象；不能仅从字段名认定已取得路径数据。

程序集同时包含 `Mobile.Edit.*` 与 `EditorScene.Edit.*`。桌面复刻优先追踪后者，通过场景对象和调用关系确认实际生效的分支，不能混用移动端手势。

## 执行顺序与交付

1. 定向反编译上述方法及必要调用者 / 被调用者，按皮肤加载 → Hold / Touch → Slide 路径与时序 → 桌面手势 → 解析转换 / 导出差异推进，不做无差别移植。
2. 提取对应场景 / Prefab / ScriptableObject 引用与序列化值。代码字段可能被场景覆盖，构造函数默认值不能当最终参数；尺寸、pivot、动画曲线、轨迹点和材质都要回到使用位置核对。
3. 每条结论记录程序集哈希、完整类型 / 方法、token 与必要 IL 偏移，或资源对象 ID / 属性路径；区分“元数据定位”“静态逻辑恢复”“运行验证”。反编译伪代码有歧义时回看 IL。
4. 整理成 Web 可实现的公式、状态转换、坐标约定、参数表和最小输入 / 输出样例，再落到现有代码。保留 Worker、精确拍点、撤销与导出保护；发现与目标冲突时明确改动，不为保留内核扭曲目标行为。
5. 用少量目标运行帧 / 操作序列及人工预期交叉验证。暂不能运行时仍推进静态恢复，标出依赖 Unity 生命周期、资源或时间调度的残余不确定性。

2026-09-27 执行更新：已用 ILSpyCmd 11.1.0.9782 完成定向方法体恢复，并以 UnityPy 1.20.26 提取场景实参。分项报告为 [R1 皮肤组合](visual-reverse-r1.md)、[R2 Slide 时序](visual-reverse-r2.md)、[R3 桌面操作](visual-reverse-r3.md)、[R4 时间与导入导出](visual-reverse-r4.md)；[场景记录](visual-scene.md) 包含 69 条路径、33 个触点、Sprite 切片/锚点和桌面面板参数。以上是静态证据，目标运行与固定播放器对照仍待 [采集清单](target-capture.md) 完成。
