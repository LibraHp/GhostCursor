import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
});
await mkdir('dist/electron', { recursive: true });
// Electron 45 exposes an explicit installer; a clean npm install alone may
// leave out the runtime. This is a no-op when the matching runtime is present.
await run(process.execPath, ['node_modules/electron/install.js']);
await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
await build({ entryPoints: ['src/electron/main.ts'], outfile: 'dist/electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'ws'], target: 'node22' });
await build({ entryPoints: ['src/electron/preload.ts'], outfile: 'dist/electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
// Never ship a helper left over from a different OS/architecture.
await rm('dist/native', { recursive: true, force: true });
await mkdir('dist/native', { recursive: true });
if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('Windows 发布目前仅支持 x64');
  await run('dotnet', ['publish', 'native/GhostCursor.Native/GhostCursor.Native.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', 'dist/native', '--nologo', '-p:NuGetAudit=false']);
} else if (process.platform === 'darwin') {
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error('macOS 发布仅支持 Intel x64 与 Apple Silicon arm64');
  const arch = process.arch === 'x64' ? 'x86_64' : 'arm64';
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos13.0`, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics', 'native/GhostCursor.Mac/main.swift', '-o', 'dist/native/GhostCursor.Native']);
} else {
  throw new Error('GhostCursor 桌面端仅支持 Windows 与 macOS');
}
