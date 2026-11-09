import type { WindowSource } from '../shared/protocol';

// A timed-out OS capture query cannot be cancelled. Keep it single-flight until
// it actually finishes so retries never pile up capture work in Chromium.
export class SourceCatalog<T extends { id: string }> {
  private pending?: Promise<T[]>;
  constructor(private query: () => Promise<T[]>, private timeoutMs = 8000) {}
  async find(id: string): Promise<T> {
    if (!this.pending) {
      const pending = Promise.resolve().then(this.query);
      this.pending = pending;
      const clear = () => { if (this.pending === pending) this.pending = undefined; };
      void pending.then(clear, clear);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const list = await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('窗口捕获响应超时，请恢复目标窗口后重试；若持续失败，请重启 GhostCursor 并检查录屏权限或显卡驱动')), this.timeoutMs); }),
      ]);
      // Chromium's final ID segment identifies its capture backend and can be
      // 0 or 1. Match the native HWND, then return Chromium's original object.
      const handle = /^window:(\d+):\d+$/.exec(id)?.[1];
      const source = list.find(s => handle && /^window:(\d+):\d+$/.exec(s.id)?.[1] === handle);
      if (!source) throw new Error('该窗口无法捕获，可能已关闭、最小化或受到保护；请恢复窗口后重新选择');
      return source;
    } finally { clearTimeout(timer); }
  }
}

export function selectableWindows(value: unknown): WindowSource[] {
  if (!Array.isArray(value)) throw new Error('读取窗口列表失败，请重试');
  return value.filter((s): s is WindowSource => !!s && typeof s.id === 'string' && /^window:\d+:0$/.test(s.id) && typeof s.name === 'string')
    .map(s => ({ id: s.id, name: s.name, thumbnail: '' }));
}
