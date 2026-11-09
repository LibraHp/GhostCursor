# GhostCursor Web 服务

本分支 `feat/web-service` 增加浏览器主持人和独立 Node.js 服务。打开 `/host`，输入部署者持有的主持人密钥，点击「选择窗口并共享」，浏览器弹出系统窗口选择器；访客打开同一个网站的邀请链接观看。

默认 WebSocket 模式将视频、信令、访客位置和可选辅助程序连接都放在同一个网站入口。**主持人电脑不需要 FRP，不需要开放入站端口，不需要额外媒体端口或 STUN/TURN。**服务器仍需提供可访问的 HTTPS 网站；已有反向代理时，允许长连接与 WebSocket Upgrade 即可。视频经过服务器，会使用服务器带宽。

## 两种使用方式

| 功能 | 仅浏览器 | 加本机辅助程序 |
| --- | --- | --- |
| 选择本机应用窗口并共享 | 支持，HTTPS / localhost、桌面浏览器 | 相同 |
| 浏览器观看、画质 / 分辨率 / 帧率设置 | 支持 | 相同 |
| 主持人网页预览中的访客鼠标 / 触摸位置 | 支持 | 支持 |
| 实际应用窗口上的原生标记 | 无 | 浏览器提供精确窗口编号且本机确认绑定后可用 |
| 系统鼠标控制 | 无 | 原生窗口绑定并由主持人明确授权后可用 |
| 全局收回快捷键 | 无，页面获得焦点时可用 Ctrl+Alt+F8 收回 | 本机 Ctrl+Alt+F8 收回；系统权限需可用 |

浏览器窗口选择完全由 `getDisplayMedia` 管理，不枚举或捕获服务器上的窗口，不以服务器的窗口列表替代用户设备窗口。只接受应用窗口捕获，选到屏幕或标签页会停止轨道并提示重新选择。浏览器停止共享、主持人退出 / 断线后会失效访客凭据并结束会话。

## Docker 部署

在服务器安装 Docker Compose，将源码放在服务器，使用 `compose.yaml`：

```bash
export GHOSTCURSOR_HOST_KEY="$(openssl rand -hex 32)"
export PUBLIC_URL="https://share.example.com"
docker compose up -d --build
```

请保存生成的主持人密钥。`PUBLIC_URL` 为网站根地址，不带路径、查询参数或片段。Compose 将服务绑定服务器回环地址 `127.0.0.1:3210`，再由服务器上的 Caddy / Nginx / Lucky 提供 HTTPS。

Caddy 示例见 [deploy/Caddyfile](../deploy/Caddyfile)，将域名替换为你实际控制的域名。Caddy 运行在宿主机时可直接反代 `127.0.0.1:3210`；Caddy 若也在容器中，请将两者加入同一 Docker 网络并使用 `ghostcursor:3210`，不要把容器内的 127.0.0.1 当宿主机地址。

Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3210;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

对网站配置正常 HTTPS 证书，反代整个根路径，包括 `/host`、`/host-ws`、`/ws`、`/companion-ws` 和 `/assets/`。Lucky 的 Web 服务反向代理同样指向 `127.0.0.1:3210` 并支持 WebSocket；这里不需要 Lucky STUN 或单独 UDP 转发。

如果服务器本身也在 NAT 后面，仍需让网站入口可访问；可以只映射网站一个 TCP 端口，不需要给每台主持人电脑添加映射。直接用 `http://局域网IP` 访问通常不能发起浏览器录屏，必须用 HTTPS 或在发起共享的电脑上用 localhost。

## 直接使用 Node.js

开发构建需要 Node.js 22.12+，建议 24：

```bash
npm ci --ignore-scripts
npm run build:web
GHOSTCURSOR_HOST_KEY="替换为至少24字符的随机密钥" PUBLIC_URL="https://share.example.com" npm run start:web
```

PowerShell 本机开发示例：

```powershell
npm ci --ignore-scripts
npm run build:web
$env:GHOSTCURSOR_HOST_KEY = '替换为至少24字符的随机密钥'
npm run start:web
```

打开 `http://localhost:3210/host`。没有配置密钥时，服务启动时生成仅本次有效的随机主持人密钥，并只在部署终端输出；配置后不会打印密钥。密钥不放入 URL，也不保存在浏览器存储中。

生产部署只需要 `dist/service/`、`dist/web/` 与 Node.js，不需要 `node_modules`、Electron、Chromium、.NET 或桌面原生组件。服务端与 `ws` 已打包进 `main.cjs`。`HOST` 默认 `0.0.0.0`，`PORT` 默认 `3210`，`/healthz` 为健康检查入口。

## 可选辅助程序

在**共享窗口所在电脑**构建和运行：

```bash
npm run build:companion
npm run start:companion
```

Windows 构建需要 .NET 10 SDK，Mac 需要 Xcode Command Line Tools。运行辅助程序需要 Node.js，但不需要 Electron；Windows helper 当前仍自带 .NET 运行时，尚未迁移为更小的纯原生 Windows 实现。不要将它称为已经实现“几 MB 的独立单文件程序”。

在主持人网页「本机辅助程序」生成 2 分钟内有效的一次性配对码；在本机终端输入 HTTPS 网站地址与配对码，并确认信任该网站。辅助程序仅向网站发起出站连接，不监听本地网络端口，不需要额外 FRP。配对码使用一次即失效，退出主持人连接后也失效。

原生窗口绑定需要浏览器捕获轨道暴露 `window:编号:后端` 形式的精确编号。辅助程序在本机枚举并核对该编号，还需在本机终端输入 `yes` 确认它就是浏览器选中的窗口；随后主持人才能选择访客并开启控制。浏览器隐去窗口编号、使用屏幕捕获、原生组件找不到窗口或本机未确认时，继续共享观看和网页标记，原生标记与控制保持关闭。不能根据窗口名称猜测绑定，也不能自动允许控制其他窗口。

Windows 版注册本机 `Ctrl+Alt+F8` 收回快捷键，冲突时启动失败并清理。Mac 版需要正常的录屏 / 辅助功能权限，快捷键还可能受系统功能键设置影响；尚需 Mac 实机验收。主机切走、最小化、遮挡操作落点、撤销、辅助程序断线或退出时，原生组件保留现有目标与授权代次检查并释放按钮、恢复指针。

辅助程序与部署服务器可能不同时区、时钟有偏差，配对时同步时间偏移以校验输入时效；它不会更改系统时钟。网络延迟过高或消息过期时会丢弃输入，避免重新播放积压的点击。

## 网络和部署边界

- 当前每个部署同时一位主持人、最多 8 位访客；无账号平台、数据库、多房间或无人值守功能。
- 主持人密钥能管理整个部署，不能发给访客；访客只使用随机会话链接。TURN 凭据在会话认证后才发送。
- 默认 WebSocket 无需额外映射；可选 WebRTC 能降低转发开销，但穿透仍受双方网络限制，必要时配置 TURN。浏览器无法固定 UDP 端口，因此 Web 版不提供桌面端的固定 UDP 模式。
- 自动 STUN 名单由部署服务器下载并探测 UDP 响应，不能把服务器探测成功等同于主持人电脑或访客网络直连成功；无需额外映射时保持默认 WebSocket 即可。
- 服务重启后会话、网络设置与配对状态不恢复。主持人断线不自动恢复控制。
- Docker 中不会捕获宿主机桌面或自动控制服务器鼠标；视频来自主持人浏览器明确选择的本机窗口。
- 尚未执行自动测试套件；Docker 镜像、跨设备 HTTPS、实际浏览器窗口编号与可选辅助程序链路需按真实部署环境验收。

## 本次验证记录

Web 服务与 Windows 辅助程序均已独立构建。Windows / Edge 实际运行时，通过浏览器选择专用演示应用窗口，由独立 Node 服务转发 WebSocket 视频；访客正常解码 1302 × 1040 的画面，主持人网页预览显示访客位置，停止共享后会话结束。未模拟 bridge、媒体轨道或会话状态；截图及记录见 README。

本次服务与静态网页约 1.1 MB，指 `dist/service` 与 `dist/web` 的未压缩文件，不含 Node.js、Docker 基础镜像和可选 Windows .NET helper。当前环境没有 Docker，未构建镜像；辅助程序完整授权与输入链路、Mac 原生改动、跨设备及 HTTPS 反代仍需验收。自动测试已补充主持人认证、访客隔离、视频转发、配对码重用与断线清理场景，遵照此前要求未执行自动测试套件。
