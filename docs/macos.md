# macOS 使用与发布

GhostCursor v0.3.0 新增 macOS 原生组件，源码实现窗口共享、访客位置标记及主持人授权的鼠标控制。最低 macOS 13，分别提供 Apple Silicon arm64、Intel x64 安装包；不依赖 .NET。

## 首次启动

1. 根据芯片下载 DMG 或 ZIP，将 GhostCursor.app 移至「应用程序」。
2. 当前为 ad-hoc 签名，没有 Developer ID 与 Apple 公证。确认来源后，按系统提示在「系统设置 → 隐私与安全性」允许打开；不要关闭全局 Gatekeeper。
3. 打开程序，点击「请求 / 刷新权限」。允许 GhostCursor「屏幕录制」（新版系统可能显示「屏幕与系统音频录制」）及「辅助功能」。系统也可能将原生辅助程序显示为独立条目，以实际授权提示为准。
4. 录屏权限变更后如仍无窗口列表，完全退出 GhostCursor 再重新打开。
5. 选择窗口并开始共享。观看与位置标记无需授予访客控制权；开启远程控制前必须有辅助功能权限，并由主持人明确选择控制者、点击开启按钮或按快捷键。

窗口失焦、隐藏、最小化、被遮挡或尺寸无法匹配时停止输入。访客不触发窗口激活；仅主持人开启控制时尝试切换目标窗口。没有辅助功能权限时允许共享观看，但不能控制。macOS 系统或应用拒绝窗口激活时，请手动切回所选窗口再授权。

## 原生组件

`native/GhostCursor.Mac/main.swift` 使用 CGWindowList 枚举标题、AppKit 透明且可穿透点击的面板绘制名称指针、Accessibility 验证与激活目标、CoreGraphics 注入经授权的鼠标消息。控制绑定访客、授权代次、目标窗口与所属进程，丢弃过期消息，并在撤销和父进程断线后释放鼠标按钮、恢复指针。

原生组件连接 Electron 临时私有目录中的 Unix socket，目录权限为 0700，名称随机；未开放额外网络服务。视频仍由 Electron 捕获，网页服务与视频三种传输模式共用原有实现。

## 本地构建

```bash
xcode-select --install
npm ci
npm run dist:mac
```

构建使用当前机器的架构，Swift helper 与 Electron 必须一致。需要两个架构时分别在 Intel 与 Apple Silicon 环境构建，CI 已使用对应 runner。输出包括 DMG、ZIP，打包阶段对应用执行 ad-hoc 签名。正式分发的 Developer ID 签名和 notarization 需要维护者自己的 Apple 凭据，当前仓库未配置此类凭据。

## 验证范围

当前 Windows 环境只能采集 Windows 实际运行截图，macOS CI 能验证 Swift 编译、Electron 构建与安装包生成，不能代替 Mac 的 TCC 权限及交互验收。

Mac 实机仍需确认：录屏/辅助功能授权与撤销、不同应用窗口捕获、窗口边框和 Retina 坐标、多显示器、全屏空间、遮挡区域裁剪、鼠标单指针显示与恢复、点按/拖动/滚轮、断线时释放按钮，以及捕获视频是否排除悬浮标记。不要将编译通过或生成 DMG 描述为这些场景已通过。
