import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`构建退出 ${code}`)));
});
await run(['node_modules/typescript/bin/tsc', '--noEmit']);
await mkdir('dist/service', { recursive: true });
await build({ entryPoints: ['src/service/main.ts'], outfile: 'dist/service/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
await run(['node_modules/vite/bin/vite.js', 'build']);
await writeFile('dist/service/package.json', JSON.stringify({ name: 'ghostcursor-web', version: '0.3.0', private: true, scripts: { start: 'node main.cjs' } }, null, 2) + '\n');
await copyFile('docs/web-service.md', 'dist/service/DEPLOY.md');
console.log('Web 服务已生成：dist/service + dist/web；部署只需 Node.js，无 Electron / .NET。');
