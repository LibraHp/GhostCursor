import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`辅助程序构建退出 ${code}`)));
});
await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
await mkdir('dist/companion', { recursive: true });
await rm('dist/native', { recursive: true, force: true }); await mkdir('dist/native', { recursive: true });
await build({ entryPoints: ['src/companion/main.ts'], outfile: 'dist/companion/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
if (process.platform === 'win32' && process.arch === 'x64') {
  await run('dotnet', ['publish', 'native/GhostCursor.Native/GhostCursor.Native.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', 'dist/native', '--nologo', '-p:NuGetAudit=false']);
} else if (process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch)) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  await run('xcrun', ['swiftc', '-O', '-swift-version', '5', '-target', `${arch}-apple-macos13.0`, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'CoreGraphics', 'native/GhostCursor.Mac/main.swift', '-o', 'dist/native/GhostCursor.Native']);
} else throw new Error('辅助程序仅支持 Windows x64 / macOS');
console.log('运行 node dist/companion/main.cjs 进行本机配对；无需 Electron。');
