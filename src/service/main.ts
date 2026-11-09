import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { WebService } from './service';

const port = Number(process.env.PORT || '3210');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 之间');
const supplied = process.env.GHOSTCURSOR_HOST_KEY;
const key = supplied || randomBytes(32).toString('base64url');
const bind = process.env.HOST || '0.0.0.0';
const service = new WebService({ webRoot: resolve(__dirname, '../web'), port, bind, hostKey: key, publicUrl: process.env.PUBLIC_URL });
void service.listen().then(() => {
  const url = process.env.PUBLIC_URL || `http://localhost:${port}`;
  console.log(`GhostCursor Web 服务已启动：${url}/host`);
  if (!supplied) console.log(`本次生成的主持人密钥（仅部署者可见，请勿转发给访客）：${key}`);
  else console.log('主持人密钥已从 GHOSTCURSOR_HOST_KEY 读取。');
  console.log('远程浏览器共享窗口需要 HTTPS；单个网站端口即可承载 WebSocket 视频、信令与位置消息。');
}).catch(error => { console.error(error instanceof Error ? error.message : '启动失败'); process.exitCode = 1; void service.close(); });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  const timeout = setTimeout(() => process.exit(1), 8000); timeout.unref();
  void service.close().then(() => process.exit(0));
});
