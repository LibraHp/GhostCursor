import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
});
await mkdir('dist/electron', { recursive: true });
await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
await build({ entryPoints: ['src/electron/main.ts'], outfile: 'dist/electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'ws'], target: 'node22' });
await build({ entryPoints: ['src/electron/preload.ts'], outfile: 'dist/electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node22' });
await run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
await run('dotnet', ['publish', 'native/GhostCursor.Native/GhostCursor.Native.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', 'dist/native', '--nologo', '-p:NuGetAudit=false']);
