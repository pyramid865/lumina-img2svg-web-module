# community.img2svg.web — Lumina Workshop 纯前端模块

把插画描摹成 **Lumina 叠色 3D 打印版画**用的分层色块 SVG——
**纯前端模块**（manifest v1 / Workshop API 1.0.0），描摹引擎
vtracer 以 WebAssembly 形式内嵌在模块 UI 里，**全部计算在浏览器内
本地完成**，不上传任何图片，也不需要模块后端。

与已登记的后端版模块 `community.img2svg`（v0.1.3，Python 后端）互补：
本模块可以在**任何支持 Workshop API 1.0.0 的 Lumina 版本**上直接安装运行。

## 下载

从本仓库的 [Releases](../../releases) 页面下载 `community.img2svg-web-0.1.0.lumina-workshop`，
通过 Lumina Workshop 安装。

## 画质档位

全自动参数，对应桌面版 **v7.5.6** 画质档（从桌面版核心提取确认）：

| 参数 | 值 |
|---|---|
| 颜色量化 | 128 色（vtracer 内建量化） |
| 工作网格 | 1600px |
| 曲线拟合 | spline |
| 分层方式 | stacked（叠色打印友好） |
| 斑点过滤 | filter_speckle 4 |
| 色彩精度 | color_precision 6 |
| 层差阈值 | layer_difference 16 |

## 许可证

- 模块自身代码：MIT（见 `LICENSE` 上半部分）
- UI 内嵌的 `@lumina/workshop-sdk`：GPL-3.0-or-later，其声明与完整
  许可证文本见 `LICENSE` 下半部分
- 描摹引擎 vtracer（wasm）：MIT OR Apache-2.0（经由 `@buzz-dee/vtrace`，
  MIT）
