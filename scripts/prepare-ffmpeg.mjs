import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Arch } from 'electron-builder';
import { EnvHttpProxyAgent, fetch } from 'undici';

const release = 'b6.1.1';
const checksums = {
  'darwin-arm64': 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  'darwin-x64': 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
  'win32-x64': '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
  'linux-arm64': '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce',
  'linux-x64': 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
};

export default async function prepareFfmpeg(context) {
  const platform = context.electronPlatformName;
  const target = `${platform}-${Arch[context.arch]}`;
  const checksum = checksums[target];
  if (!checksum) throw new Error(`尚未配置 ${target} 的 FFmpeg，请使用受支持的打包架构。`);
  const os = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform];
  const root = join(context.packager.projectDir, 'node_modules', '.cache', 'agent-muster', 'ffmpeg', release);
  const directory = join(root, `${os}-${Arch[context.arch]}`);
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const verify = data => {
    if (createHash('sha256').update(data).digest('hex') !== checksum) throw new Error(`${target} 的 FFmpeg 校验失败，请删除 ${directory} 后重新打包。`);
  };
  try {
    verify(await readFile(join(directory, executable)));
    await access(join(directory, 'LICENSE'));
    await access(join(directory, 'README'));
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(root, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(root, `${os}-${Arch[context.arch]}-`));
  const dispatcher = new EnvHttpProxyAgent();
  try {
    console.log(`准备 ${target} 的内置 FFmpeg（${release}）`);
    for (const [asset, file] of [[`ffmpeg-${target}.gz`, executable], [`${target}.LICENSE`, 'LICENSE'], [`${target}.README`, 'README']]) {
      const response = await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/${release}/${asset}`, {
        dispatcher, signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`FFmpeg 资源下载失败：${asset}（HTTP ${response.status}）`);
      const downloaded = Buffer.from(await response.arrayBuffer());
      const data = file === executable ? gunzipSync(downloaded) : downloaded;
      if (file === executable) verify(data);
      await writeFile(join(temporaryDirectory, file), data);
    }
    await chmod(join(temporaryDirectory, executable), 0o755);
    await rm(directory, { recursive: true, force: true });
    await rename(temporaryDirectory, directory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await dispatcher.close();
  }
}
