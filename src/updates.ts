import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gt, valid } from 'semver';

const execute = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';

async function getUpdate(): Promise<{ name: string; current: string; latest: string }> {
  const { name, version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
  const { stdout } = await execute(npmCommand, ['view', `${name}@latest`, 'version', '--json', '--fetch-timeout=5000', '--fetch-retries=0'], { shell, timeout: 10000 });
  const latest: unknown = JSON.parse(stdout);
  if (typeof latest !== 'string' || !valid(latest)) throw new Error('npm 返回的版本号无效');
  return { name, current: version, latest };
}

export async function checkForUpdates(): Promise<void> {
  const { name, current, latest } = await getUpdate();
  if (!gt(latest, current)) return;
  console.log(`\n发现新版本：${current} → ${latest}\n运行 ${name} update 更新全局安装，或运行 npx ${name}@latest 启动最新版本。\n`);
}

export async function updatePackage(): Promise<void> {
  const { name, current, latest } = await getUpdate();
  if (!gt(latest, current)) {
    console.log(`当前版本 ${current} 已是最新版本。`);
    return;
  }
  console.log(`正在更新 ${name}：${current} → ${latest}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ['install', '--global', `${name}@${latest}`], { shell, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm 更新失败（${signal ? `信号：${signal}` : `退出码：${code}`}）`));
    });
  });
  console.log(`已更新至 ${latest}，请重新启动 Agent Muster。`);
}
