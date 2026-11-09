import { createServer, type Socket } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class NativeBridge extends EventEmitter {
  private socket?: Socket; private child?: ChildProcess; private serial = 0;
  private socketDirectory?: string;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  async launch(executable: string) {
    const name = `ghostcursor-${randomUUID()}`;
    let address = `\\\\.\\pipe\\${name}`;
    if (process.platform === 'darwin') {
      this.socketDirectory = await mkdtemp(join(tmpdir(), 'gc-'));
      await chmod(this.socketDirectory, 0o700);
      address = join(this.socketDirectory, 'ipc');
    }
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('原生组件连接超时')), 15_000);
        const fail = (error: Error) => { clearTimeout(timer); reject(error); };
        server.once('connection', socket => {
          clearTimeout(timer); this.socket = socket; server.close();
          socket.on('error', error => this.emit('failure', error));
          socket.on('close', () => {
            this.socket = undefined;
            for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('原生组件已断开')); }
            this.pending.clear(); this.emit('failure', new Error('原生组件已断开'));
          });
          createInterface({ input: socket }).on('line', line => {
            try {
              const data = JSON.parse(line);
              if (data.id && this.pending.has(data.id)) {
                const p = this.pending.get(data.id)!; this.pending.delete(data.id); clearTimeout(p.timer);
                data.ok ? p.resolve(data) : p.reject(new Error(data.error || '原生操作失败'));
              } else if (data.type === 'status') this.emit('status', data);
              else if (data.type === 'local-revoke') this.emit('local-revoke', data);
            } catch { this.emit('failure', new Error('原生组件返回了无效消息')); }
          });
          resolve();
        });
        this.child = spawn(executable, [process.platform === 'darwin' ? address : name], { windowsHide: true, stdio: process.env.GHOSTCURSOR_E2E ? ['ignore', 'ignore', 'pipe'] : 'ignore' });
        this.child.stderr?.on('data', chunk => process.stderr.write(chunk));
        this.child.once('error', fail);
        this.child.once('exit', () => fail(new Error('原生组件意外退出')));
      });
    } catch (error) { server.close(); this.child?.kill(); await this.cleanup(); throw error; }
  }
  private async cleanup() {
    const directory = this.socketDirectory; this.socketDirectory = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  send(type: string, payload: object = {}) {
    if (!this.socket || this.socket.destroyed) throw new Error('原生组件尚未就绪');
    // Refuse to accumulate stale input if the native process becomes unresponsive.
    if (this.socket.writableLength > 256_000) { this.socket.destroy(); throw new Error('原生输入处理超时'); }
    this.socket.write(JSON.stringify({ type, ...payload }) + '\n');
  }
  request(type: string, payload: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('原生组件响应超时')); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(type, { ...payload, id }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  close() {
    try { this.send('shutdown'); } catch {}
    this.socket?.end();
    void this.cleanup();
    // Let the helper restore cursor visibility and release pressed buttons before exit.
    const child = this.child;
    if (child && child.exitCode === null) {
      const timeout = setTimeout(() => child.kill(), 2000); timeout.unref();
      child.once('exit', () => clearTimeout(timeout));
    }
  }
}
