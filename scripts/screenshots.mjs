// Capture the real Electron host and a browser receiving an actual live stream.
// A dedicated demonstration window avoids capturing the user's applications.
import { _electron, chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('docs/images');
await mkdir(output, { recursive: true });
const env = { ...process.env, GHOSTCURSOR_E2E: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const application = await _electron.launch({ args: ['.'], env, timeout: 30_000 });
application.process().stderr.on('data', chunk => process.stderr.write(chunk));
let browser;
try {
  const host = await application.firstWindow();
  await host.waitForFunction(async () => (await window.ghost.state()).nativeReady, { timeout: 25000 });
  const html = await readFile('scripts/demo-window.html', 'utf8');
  const targetId = await application.evaluate(async ({ BrowserWindow }, content) => {
    const demo = new BrowserWindow({ width: 980, height: 740, useContentSize: true, autoHideMenuBar: true, x: 24, y: 64, title: 'GhostCursor · 协作演示', webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await demo.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(content));
    return demo.id;
  }, html);
  await host.waitForFunction(async () => { try { return (await window.ghost.sources()).some(source => source.name.includes('协作演示')); } catch { return false; } }, { timeout: 15000 });
  await host.getByRole('button', { name: /选择窗口/ }).click();
  await host.getByRole('searchbox', { name: '搜索窗口' }).fill('GhostCursor · 协作演示');
  await host.getByRole('button', { name: /GhostCursor · 协作演示/ }).click();
  await host.getByRole('button', { name: '使用此窗口' }).click();
  await host.getByRole('button', { name: /开始共享/ }).click();
  await host.waitForFunction(() => { const video = document.querySelector('.capture-probe'); return video?.videoWidth > 0; }, { timeout: 25000 });
  const state = await host.evaluate(() => window.ghost.state());
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const viewer = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await viewer.goto(state.links.find(url => url.includes('127.0.0.1')));
  await viewer.getByLabel('如何称呼你').fill('协作伙伴');
  await viewer.getByRole('button', { name: '加入共享' }).click();
  await viewer.waitForFunction(() => { const video = document.querySelector('video'); return video?.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames >= 3; }, { timeout: 35000 });
  // Leave the demonstration visible; screenshots don't grant remote control.
  await viewer.getByText('已连接', { exact: true }).waitFor({ timeout: 35000 });
  await viewer.locator('.video-message').waitFor({ state: 'hidden', timeout: 35000 });
  const area = await viewer.locator('video').boundingBox();
  if (area) await viewer.mouse.move(area.x + area.width * 0.56, area.y + area.height * 0.5);
  await viewer.waitForFunction(() => { const video = document.querySelector('video'); return !document.querySelector('.video-message') && video?.readyState >= 2 && video.videoWidth > 0; });
  await viewer.screenshot({ path: resolve(output, 'viewer-live.png') });
  await host.evaluate(() => window.scrollTo(0, 0));
  await host.screenshot({ path: resolve(output, 'host-sharing.png') });
  await host.evaluate(() => window.ghost.stop());
  await host.locator('.nav-item').filter({ hasText: '设置' }).click();
  await host.evaluate(() => window.scrollTo(0, 0));
  await host.screenshot({ path: resolve(output, 'settings.png'), fullPage: true });
  await writeFile(resolve(output, 'capture-info.json'), JSON.stringify({ version: JSON.parse(await readFile('package.json', 'utf8')).version, platform: process.platform, capturedAt: new Date().toISOString(), transport: state.network.transport, description: '实际运行的 Electron、Windows 原生组件与 Edge；共享独立演示窗口，无模拟 bridge 或会话状态。' }, null, 2) + '\n');
  console.log('已保存实际运行截图到 docs/images');
} finally {
  await browser?.close();
  await application.close();
}
