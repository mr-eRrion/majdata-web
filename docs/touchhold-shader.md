# TouchHold 进度环字节码恢复

2026-09-27，补齐 R1 中“编译 Shader 无可读源码”的缺口。此结论来自提供的资源字节码，不是目标程序运行截图。

## 来源与提取

`sharedassets0.assets` 的 Shader 对象 215 名为 `Custom/SprFill`，对象原始字节 SHA-256 为 `4b2fd53ce35103c232b33fbbab5cadac0a6dbc357d52fd6b7e81aa8d156d9772`。Touch Hold Fill 材质启用 `_CLOCKWISE_ON`，`_StartAngle=90`；C# 按已经过的时长写入 `_Angle=360×progress`。

运行 `tools/visual-scene/extract_touchhold_shader.py`，从 Unity LZ4 压缩块按 ShaderLab 的程序索引提取 16 个实际程序。参数记录 0/9 不作为程序解析。工具校验每个程序的关键字与 ShaderLab 引用一致，结果写入忽略目录 `.tools/visual-reverse/touchhold-shader/`。其中无额外功能关键字的顺时针 fragment 是索引 11，DXBC 长 1,524 字节，SHA-256 为 `7cff658e182f0f49df48d9a590689d4bd850171d4b10de856f0e8df26344706b`。

反汇编使用 [DXDecompiler](https://github.com/spacehamster/DXDecompiler/tree/e7c32662bbf5909e0a80f12e9d07f510bfd0e220)，MIT 许可，固定提交 `e7c32662bbf5909e0a80f12e9d07f510bfd0e220`。工具源码仅在 `.tools/visual-reverse/DXDecompiler`；使用已有 .NET SDK，将其库源码加入 net10.0 小型控制台工程，调用 `BytecodeContainer.Parse(bytes).ToString()`，无需 Windows 或 DirectX 运行库。工具自身不进入站点或分发源码。

## 指令与方向

ShaderLab 常量布局将 `_MainColor` 映射至 `cb0[3]`，`_Angle` 至 `cb0[4].x`，`_StartAngle` 至 `cb0[4].y`。fragment 对 UV 减去 `(0.5,0.5)`，用多项式近似 atan2，恢复象限，再加 `_StartAngle` 并取 360 度余数。随后计算 `_Angle - theta`，结果小于零时执行 `discard_nz`；保留像素采样原纹理并乘 `_MainColor`。

当前顺时针变体在 Unity UV 坐标中给出如下对应关系；采用像素中心附近的极限，避开中心与扇形接缝上的浮点歧义。

| 原纹理方向 | Unity UV | 角度 theta |
| --- | --- | --- |
| 上 | `(0.5,1)` | 0° |
| 右 | `(1,0.5)` | 90° |
| 下 | `(0.5,0)` | 180° |
| 左 | `(0,0.5)` | 270° |

因此进度 0 时环为空，0.25 保留右上扇区，0.5 保留右半环，1 保留完整环；随进度增加而填充。PNG 不重绘。Web Canvas 与 Pixi 都对原纹理应用从屏幕上方开始、顺时针增长的扇形遮罩；中心按 UV 0.5 与 Sprite Pivot 换算，跟随同一局部变换。

Web 扇形使用几何角度，源 Shader 使用 atan2 近似多项式；接缝、边界像素与抗锯齿不声称完全一致。代码方向恢复、Web 显示测试和目标运行校准分别记录，后者仍待完成。

## Web 显示检查

`tests/touchhold-browser.mjs` 在开发预览中直接加载产品的 `PixiNoteLayer`、Sprite 组合与原 PNG，不启动额外解析器。已有 Chromium 153、400×400 的同一音符分别渲染进度 0、0.25、0.5、1，再回退至 0.25。以零进度图为基准，四分之一只改变右上象限 7,573 个像素；一半改变右上 7,573、右下 7,476 个像素，左侧不变；完整环覆盖四象限。回退后的 PNG 字节完全一致，页面无异常。此检查验证实际遮罩方向和状态重建，未比较 Unity 原生截图。
