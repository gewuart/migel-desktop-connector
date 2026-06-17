#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const skillName = 'migel-pairing';
const sourceSkillDir = join(repoRoot, 'skills', skillName);

const defaults = {
  agent: process.env.MIGEL_PAIRING_AGENT || process.env.MIGEL_DESKTOP_AGENT_ID || 'hermes',
  pairCode: process.env.MIGEL_PAIR_CODE || process.env.MIGEL_DESKTOP_PAIR_CODE || '',
  desktopClaim: process.env.MIGEL_DESKTOP_CLAIM || '',
  skillRoot: process.env.HERMES_SKILL_ROOT || join(homedir(), '.hermes'),
  installOnly: process.env.MIGEL_PAIRING_INSTALL_ONLY || 'false',
  dryRun: process.env.MIGEL_PAIRING_DRY_RUN || 'false',
};

await main().catch((error) => {
  console.error('');
  console.error('Migel 配对 Skill 没有完成。');
  console.error(`原因: ${redactSensitive(error?.message || error || '未知错误')}`);
  console.error('请从 Migel Android 重新复制一键终端命令，或在 Migel 项目根目录重新执行。');
  process.exitCode = 1;
});

async function main() {
  const options = normalizeOptions(parseArgs(process.argv.slice(2), defaults));
  if (options.help) {
    printUsage();
    return;
  }

  assertRepoRoot();
  assertNodeRuntime();
  await ensureRuntimeDependencies(options);
  console.log('Migel 正在检查配对 Skill');
  const installResult = installSkill(options);
  console.log(`    Skill 位置: ${installResult.targetDir}`);

  if (options.installOnly) {
    console.log('    Skill 已就绪。之后可以在 Hermes 中直接使用 Migel 配对 Skill。');
    return;
  }

  console.log('Migel 配对 Skill 已就绪，开始配对...');
  await runPairingSkill(options);
}

function installSkill(options) {
  const sourceSkillFile = join(sourceSkillDir, 'SKILL.md');
  if (!existsSync(sourceSkillFile)) {
    throw new Error(`找不到 Skill 源文件: ${sourceSkillDir}`);
  }
  const sourceMeta = readSkillMetadata(sourceSkillFile);
  if (sourceMeta.name !== skillName) {
    throw new Error(`Skill 源文件名称不正确: ${sourceMeta.name || '未声明'}`);
  }
  if (!sourceMeta.version) {
    throw new Error('Skill 源文件缺少 version。');
  }
  const sourceHash = hashSkillDirectory(sourceSkillDir);
  const targetRoot = resolve(expandHome(options.skillRoot), 'skills');
  const targetDir = join(targetRoot, skillName);
  mkdirSync(targetRoot, {
    recursive: true,
    mode: 0o700,
  });
  const current = inspectInstalledSkill(targetDir, sourceMeta, sourceHash);
  if (current.status === 'current') {
    console.log(`    Migel 配对 Skill 已是最新版本 ${sourceMeta.version}，跳过安装。`);
    chmodSync(targetDir, 0o700);
    return {
      targetDir,
      action: 'skipped',
    };
  }

  if (current.status === 'missing') {
    console.log(`    未检测到 Migel 配对 Skill，正在安装版本 ${sourceMeta.version}...`);
  } else {
    const fromVersion = current.version ? ` ${current.version}` : '';
    console.log(`    发现旧版 Migel 配对 Skill${fromVersion}，正在更新到 ${sourceMeta.version}...`);
  }

  rmSync(targetDir, {
    recursive: true,
    force: true,
  });
  cpSync(sourceSkillDir, targetDir, {
    recursive: true,
    force: true,
  });
  chmodSync(targetDir, 0o700);
  console.log('    Migel 配对 Skill 已安装。');
  return {
    targetDir,
    action: current.status === 'missing' ? 'installed' : 'updated',
  };
}

function runPairingSkill(options) {
  const args = [
    join(scriptDir, 'migel-pairing-skill.mjs'),
    '--agent',
    options.agent,
  ];
  if (options.pairCode) {
    args.push('--pair-code', options.pairCode);
  }
  if (options.desktopClaim) {
    args.push('--desktop-claim', options.desktopClaim);
  }
  if (options.dryRun) {
    args.push('--dry-run', 'true');
  }

  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIGEL_PAIRING_AGENT: options.agent,
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) {
        resolveRun();
      } else {
        reject(new Error('配对 Skill 执行失败。'));
      }
    });
  });
}

function parseArgs(argv, seed) {
  const result = { ...seed };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      result[key] = 'true';
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function normalizeOptions(raw) {
  return {
    ...raw,
    agent: normalizeAgent(raw.agent),
    pairCode: normalizePairCode(raw.pairCode),
    desktopClaim: normalizeText(raw.desktopClaim),
    skillRoot: resolve(expandHome(raw.skillRoot || join(homedir(), '.hermes'))),
    installOnly: parseBoolean(raw.installOnly, false),
    dryRun: parseBoolean(raw.dryRun, false),
  };
}

function assertRepoRoot() {
  const requiredPaths = [
    join(repoRoot, 'tools', 'migel-skill-bootstrap.mjs'),
    join(repoRoot, 'tools', 'migel-pairing-skill.mjs'),
    join(repoRoot, 'skills', skillName, 'SKILL.md'),
    join(repoRoot, 'desktop-connector', 'src', 'main.mjs'),
  ];
  const missing = requiredPaths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`当前 Migel 项目不完整，缺少 ${missing.map((path) => relative(repoRoot, path)).join(', ')}。`);
  }
}

function assertNodeRuntime() {
  const [major] = process.versions.node.split('.').map((part) => Number(part));
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`Node.js 版本过低：${process.versions.node}。请安装 Node.js 22 或更新版本后重试。`);
  }
}

async function ensureRuntimeDependencies(options) {
  if (options.dryRun || options.installOnly) return;
  const qrcodePackage = join(repoRoot, 'tools', 'node_modules', 'qrcode', 'package.json');
  if (existsSync(qrcodePackage)) return;

  const toolsPackageJson = join(repoRoot, 'tools', 'package.json');
  if (!existsSync(toolsPackageJson)) {
    throw new Error('缺少 tools/package.json，无法自动安装二维码生成依赖。');
  }
  console.log('    正在安装二维码生成依赖...');
  await runForeground(npmCommand(), ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: join(repoRoot, 'tools'),
    env: process.env,
  }).catch((error) => {
    throw new Error(`二维码生成依赖安装失败：${error?.message || error}`);
  });
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runForeground(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) {
        resolveRun();
      } else {
        reject(new Error(`${command} exited with status ${status}`));
      }
    });
  });
}

function normalizePairCode(value) {
  const text = normalizeText(value).replace(/\s+/g, '');
  if (text.startsWith('migel_dc_')) return text;
  return text.toUpperCase();
}

function normalizeAgent(value) {
  const text = normalizeText(value).toLowerCase();
  if (text === 'openclaw') return 'openclaw';
  return 'hermes';
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return Boolean(fallback);
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  return Boolean(fallback);
}

function inspectInstalledSkill(targetDir, sourceMeta, sourceHash) {
  const targetSkillFile = join(targetDir, 'SKILL.md');
  if (!existsSync(targetSkillFile)) {
    return {
      status: 'missing',
    };
  }

  try {
    const targetMeta = readSkillMetadata(targetSkillFile);
    if (targetMeta.name !== sourceMeta.name) {
      return {
        status: 'stale',
        version: targetMeta.version,
      };
    }
    if (targetMeta.version !== sourceMeta.version) {
      return {
        status: 'stale',
        version: targetMeta.version,
      };
    }
    if (hashSkillDirectory(targetDir) !== sourceHash) {
      return {
        status: 'stale',
        version: targetMeta.version,
      };
    }
    return {
      status: 'current',
      version: targetMeta.version,
    };
  } catch {
    return {
      status: 'stale',
    };
  }
}

function hashSkillDirectory(dir) {
  const hash = createHash('sha256');
  for (const filePath of listSkillFiles(dir)) {
    const relativePath = relative(dir, filePath);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function listSkillFiles(dir) {
  const files = [];
  const entries = readdirSync(dir, {
    withFileTypes: true,
  }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSkillFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function readSkillMetadata(skillFile) {
  const text = readFileSync(skillFile, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`Skill 文件缺少 frontmatter: ${skillFile}`);
  }
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    metadata[field[1]] = field[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return metadata;
}

function expandHome(value) {
  const text = normalizeText(value);
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

function redactSensitive(value) {
  return String(value || '')
    .replace(/migel_desktop_dt_[A-Za-z0-9._-]+/g, '[desktop-token]')
    .replace(/migel_dt_[A-Za-z0-9._-]+/g, '[device-token]')
    .replace(/migel_dc_[A-Za-z0-9._-]+/g, '[desktop-claim]');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function printUsage() {
  console.log(`Usage:
  rtk node tools/migel-skill-bootstrap.mjs --agent hermes

Options:
  --agent hermes|openclaw
  --pair-code MIGEL-8K3D-29QF   # optional compatibility fallback
  --desktop-claim migel_dc_...   # internal beta fallback
  --install-only true
  --skill-root ~/.hermes
`);
}
