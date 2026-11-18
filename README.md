# community.img2svg.web — Lumina Workshop 纯前端模块

把插画描摹成 **Lumina 叠色 3D 打印版画**用的分层色块 SVG——
**纯前端模块**（manifest v1 / Workshop API 1.0.0），描摹引擎为**纯 JavaScript**，
**全部计算在浏览器内本地完成**，不上传任何图片，也不需要模块后端。

与已登记的后端版模块 `community.img2svg`（v0.1.3，Python 后端）互补：
本模块可以在**任何支持 Workshop API 1.0.0 的 Lumina 版本**上直接安装运行。

## 为什么用纯 JS 而不是 WebAssembly

早期版本内嵌 vtracer 的 WASM，但工坊宿主的内容安全策略（CSP）不允许编译
WASM（缺 `wasm-unsafe-eval`），导致脚本在顶层初始化 WASM 时被拦截、
SDK 的 `lifecycle.ready()` 永远发不出、模块停在"正在连接宿主"。

现版本改用纯 JS 描摹引擎（imagetracerjs），**不调用任何 WebAssembly API**，
因此能在现有工坊的默认安全设置下正常启动、选图、描摹并交接——无需用户
调整任何安全设置。已在真实 Chromium + 工坊同款严格 CSP 下端到端验证：
ready → 选图 → 转换 → 交接 全链路通过。

## 下载

从本仓库的 [Releases](../../releases) 页面下载
`community.img2svg.web-0.1.1.lumina-workshop`，通过 Lumina Workshop 安装。

> 0.1.1 修复了 0.1.0 在工坊里卡在"正在连接宿主"的问题（WASM 被 CSP 拦截）。
> 0.1.0 的用户请升级到 0.1.1。

## 画质档位

全自动参数，无用户选项。为兼容现有工坊而采用纯 JS 描摹，画质为**简化的
平涂分层风格**（与桌面 v7.5.6 档同思路，但由 imagetracerjs 实现）：

| 参数 | 值 |
|---|---|
| 颜色量化 | 32 色（确定性采样） |
| 工作网格 | 1600px |
| 去噪 | pathomit 10（丢弃短小路径） |
| 分层方式 | stacked（叠色打印友好） |
| 描边 | 无（纯填色） |
| 透明处理 | 填白后描摹 |

> 画质取舍：纯色块插画与 WASM 版几乎无差；带透明背景的复杂插画上，
> 纯 JS 版在边缘平滑度和颜色层级上略逊于 WASM 版，但保证能在现有工坊运行。

## 许可证

- 模块自身代码：MIT（见 `LICENSE` 上半部分）
- UI 内嵌的 `@lumina/workshop-sdk`：GPL-3.0-or-later，其声明与完整
  许可证文本见 `LICENSE` 下半部分
- 描摹引擎 imagetracerjs：MIT（https://github.com/jankovicsandras/imagetracerjs）
