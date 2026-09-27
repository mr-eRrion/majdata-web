# Visual Maimai 经典皮肤素材

当前清单把用户提供的 `Visual Maimai/Skins/经典/` 中 61 张 PNG 原样复制到 `apps/web/public/assets/visual-maimai/`。来源清单是 [manifest.json](../apps/web/public/assets/visual-maimai/manifest.json)，逐项记录稳定语义键、仓库相对源路径、SHA-256、输出路径和 PNG 尺寸。清单不含生成时间，按固定顺序生成。

```sh
node tools/visual-assets/prepare-classic-skin.mjs
node tools/visual-assets/prepare-classic-skin.mjs --check
node tools/visual-assets/prepare-classic-skin.mjs --check-packaged
```

准备命令只复制原字节并重写清单，不裁切或修改图片。`--check` 不写文件，会检查源目录与显式清单无缺项或额外 PNG，核对 PNG 签名和 IHDR 尺寸，并比对输出副本与源文件的 SHA-256、尺寸及清单内容。`--check-packaged` 只读取输出目录和 manifest，可在没有原安装包的源码归档中核验 61 个 PNG 的清单项、文件集合、签名、尺寸和 SHA-256。完整图片解码留给浏览器加载验收。当前 PNG 副本合计 560,987 字节。

语义键保留源文件名可见的类别、修饰词和数字后缀。数字后缀不代表已确认的动画帧或空间编号；清单也不定义图片组合、锚点、尺度或层级。这些显示规则待 Visual Maimai 逻辑和运行画面对照后再记录。此文档说明素材来源与完整性，不构成对素材许可或再分发权的判断。
