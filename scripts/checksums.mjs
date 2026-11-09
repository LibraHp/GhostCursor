import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2] || 'release';
const files = (await readdir(directory)).filter(name => /\.(exe|dmg|zip)$/.test(name)).sort();
if (!files.length) throw new Error('没有找到可发布安装包');
const lines = [];
for (const name of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`已生成 ${files.length} 个安装包的 SHA256 校验值`);
