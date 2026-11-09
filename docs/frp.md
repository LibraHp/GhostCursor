# FRP 外网连接

GhostCursor 提供三种视频连接选项。通过 FRP 分享，推荐选择 **WebSocket · FRP 单端口**：视频、鼠标位置和已授权控制共用现有网页端口，不需要 STUN/TURN。另可选普通 WebRTC + STUN/TURN，或 **WebRTC · 固定 UDP**（一个 TCP 网页端口加一个 UDP 媒体端口）。WebRTC 视频不会自动经过网页端口。

如果能额外映射一个 UDP 端口，请参见 [固定 UDP 映射说明](udp-mapping.md)，其中包含 FRP 配置。该模式一次仅支持一位访客，不使用 STUN/TURN；仅增加第二个 TCP 映射无法代替 UDP。

以下功能包含在 v0.3.0 源码与发布流程中，旧版 0.2.1 安装包不包含这些改动。公网连通性仍需使用实际 FRP / Lucky / TURN 环境验证。

## 1. 保留现有 FRP 网页映射

将公网 TCP 端口映射到主持人 `127.0.0.1:3210`，也可以使用已有 HTTPS 反向代理，需同时转发 `/ws` 的 WebSocket Upgrade。网页部署在域名根路径，暂不支持 `/ghostcursor/` 子路径。

例如现有 frpc.toml 中的代理段：

```toml
[[proxies]]
name = "ghostcursor-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3210
remotePort = 13210
```

不要用本机 `127.0.0.1` 链接邀请外网访客。在 GhostCursor「设置 → 外网与 FRP」填写 `http://公网IP:13210` 或代理后的 `https://share.example.com`，保存后重新开始共享，复制标记为“公网”的完整链接（保留 `#` 后的会话凭据）。填入的公网域名也用于允许 FRP 重写 Host 时的 WebSocket Origin。

## 2. 选择 WebSocket 视频转发

1. 停止当前共享，进入「设置 → 外网与 FRP」。
2. 将「视频传输方式」切换为「WebSocket · FRP 单端口」。新设置默认使用此模式；从旧版迁移的设置保留 WebRTC，需手动切换。
3. 填写公网邀请地址，例如 `http://公网IP:13210`，点击「保存外网设置」。
4. 建议先选流畅 / 720p / 15 帧，再重新开启共享，将完整公网链接发给访客。
5. 访客使用新版 Edge 或 Chrome 加入，画面底部会显示 `WebSocket`。移动端能否播放取决于浏览器实际支持的 MediaSource 与视频编码格式，不兼容时会提示换浏览器或改用 WebRTC。

保留上面的 FRP TCP 映射即可，无需开放额外的视频端口。使用 FRP HTTP/HTTPS 或 Nginx 等反向代理时，需支持 `/ws` 的 WebSocket Upgrade、持续的二进制消息和长连接，避免很短的空闲超时。网页仍需部署在域名根路径。

此模式将捕获轨道连续编码后转发，由浏览器解码播放，不使用截图轮询。视频和控制消息仍需有效会话凭据；观看不会自动授予鼠标控制权限，主持人按原方式选定控制者并开启权限，快捷键可随时撤销。切换画质、分辨率或窗口尺寸时会重新初始化视频缓冲，访客无需重新加入。

TCP 丢包重传、视频缓冲和逐访客编码会增加延迟及 CPU 开销。网络积压时会重新同步该访客的流，持续拥塞则断开并提示降低画质。多位访客各消耗一份上行带宽与编码资源，建议先从 1–3 人开始。

## 3. 可选：WebRTC 与 TURN

如果希望使用 WebRTC，在相同设置中选择「WebRTC · 低延迟」，填写 STUN/TURN 并保存，再重新开启共享。网页仍经过 FRP，视频和输入使用独立的 WebRTC 连接。仅添加 STUN 不能保证外网直连；直连失败时使用 TURN，或改回 WebSocket。

STUN 可打开「自动配置 STUN」，无需手动复制服务器。来源为 `https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts_tcp.txt`。该文件是第三方检测到支持 TCP 的地址列表；普通 Chromium WebRTC STUN 使用 UDP，GhostCursor 会随机抽样并仅选用本机 UDP Binding 响应有效的地址，最多配置 3 项，不会将 TCP 列表当作 TURN 中继。

保存或开始共享时获取，缓存 1 小时；缓存过期会在下次保存或共享时刷新，共享中保持两端相同的 ICE 配置。下载最多等待 6 秒，兼容性检测最多约 3 秒，重复请求会合并；失败后自动回退到缓存或默认 STUN。停止共享后可点击「立即更新」，设置页显示当前地址及更新结果。GitHub 列表不通不会阻止使用回退地址开启共享。本机 STUN 响应有效不能证明访客可达或两端可以直连，UDP 被阻断时请用 WebSocket 或 TURN/TCP。

如果已有 TURN 服务，直接填写服务商提供的 URL、账号、密码即可。否则可在有公网 IP 的 Linux 服务器上部署 coturn；它可以与 frps 在同一台服务器运行，但需要独立端口。

Debian/Ubuntu 示例，以下命令需由你在服务器执行：

```sh
sudo apt-get update
sudo apt-get install coturn
```

将 [turnserver.conf.example](../deploy/turnserver.conf.example) 复制到 `/etc/turnserver.conf`，替换公网 IP、realm、账号密码后启动：

```sh
sudo systemctl enable --now coturn
sudo systemctl restart coturn
```

服务器安全组与系统防火墙同时放行：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 3478 | TCP、UDP | 两端连接 TURN |
| 49160–49200 | UDP | TURN 分配的媒体中继端口 |

TURN 服务应直接部署在公网服务器；不要把它当作一个 HTTP 服务套在 FRP 的网页映射后面。如果服务器本身位于 NAT 后，`external-ip` 需填写 `公网IP/内网IP` 并配置上述端口转发。

### 填写 TURN 设置

先停止共享，填写：

```text
TURN 地址（每行一个）：
turn:你的服务器公网IP:3478?transport=udp
turn:你的服务器公网IP:3478?transport=tcp

账号、密码：与 coturn 配置一致
```

建议先打开“强制使用 TURN 中继”，确认外网视频可以建立，再按需要关闭以优先直连。保存后重新开始共享，访客重新加入。TURN 账号会发给持有有效会话凭据的访客浏览器用于建立连接，使用专用、可更换的中继账号。

限制严格的网络可使用 `turns:turn.example.com:5349?transport=tcp`（也可由服务器提供 443 端口的 TURN/TLS）。这要求 coturn 配置有效证书与 TLS 监听；不能把普通 TURN 地址直接改为 `turns:`，也不能与现有 HTTPS 服务占用同一个 IP 和端口。示例配置仅包含普通 TURN 3478，不包含 TLS。

## 排查

- 网页打不开：检查 FRP 网页端口、域名和 HTTPS 配置。
- 网页打开但无法加入：检查 `/ws` 转发和公网邀请地址，保留链接中的会话凭据。
- WebSocket 模式一直缓冲或超时：检查代理是否转发 `/ws` 的 Upgrade 和二进制长连接，确认浏览器提示没有格式不兼容，并尝试流畅 / 720p / 15 帧、减少访客数量。仅网页能打开不能说明代理允许视频长连接。
- WebSocket 模式反复缓冲或断开：检查主持人上行、FRP 带宽限制、CPU 占用和浏览器解码能力；降低画质和帧率，或在可直连网络中改用 WebRTC。
- WebRTC 模式建立视频超时：检查 TURN 可达性、账号密码、3478 及媒体端口，或切换到 WebSocket。
- WebRTC 配置了 TURN 但只在局域网成功：打开强制中继排除局域网直连造成的误判，检查服务端 external-ip 和防火墙。

v0.3.0 发布流程会构建安装包；尚未对真实公网 FRP/TURN 服务器做连通验证。
