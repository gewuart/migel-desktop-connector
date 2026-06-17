#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const defaults = {
  agent: process.env.MIGEL_DESKTOP_AGENT_ID || process.env.MIGEL_PAIRING_AGENT || 'hermes',
  pairCode: process.env.MIGEL_PAIR_CODE || process.env.MIGEL_DESKTOP_PAIR_CODE || '',
  desktopClaim: process.env.MIGEL_DESKTOP_CLAIM || '',
  apiBaseUrl: process.env.MIGEL_API_BASE_URL || 'https://api.gewuyishu.cn/account-api',
  relayBaseUrl: process.env.MIGEL_RELAY_BASE_URL || 'https://relay.gewuyishu.cn',
  deviceId: process.env.MIGEL_DESKTOP_DEVICE_ID || '',
  deviceName: process.env.MIGEL_DESKTOP_DEVICE_NAME || '',
  dryRun: process.env.MIGEL_PAIRING_DRY_RUN || 'false',
};

await main().catch((error) => {
  console.error('');
  console.error('Migel 配对没有完成。');
  console.error(`原因: ${friendlyErrorMessage(error)}`);
  console.error('请稍后重试，或确认 Migel 云端 API 已开放桌面配对凭证申请接口。');
  process.exitCode = 1;
});

async function main() {
  const options = normalizeOptions(parseArgs(process.argv.slice(2), defaults));
  if (options.help) {
    printUsage();
    return;
  }

  console.log('Migel 配对 Skill 正在连接这台电脑');
  console.log('[1/3] 准备云端配对凭证...');

  const claim = await resolveDesktopClaimForRun(options);

  console.log('[2/3] 准备桌面连接器...');
  if (options.dryRun) {
    printDryRun(options);
    return;
  }

  console.log('[3/3] 启动连接并生成二维码...');
  await runDesktopBootstrap(options, claim);
  console.log('');
  console.log('Migel 配对入口已就绪：请用 Migel Android App 扫码，或输入终端显示的备用配对码。');
}

async function resolveDesktopClaimForRun(options) {
  if (options.dryRun && options.pairCode && !options.desktopClaim && !options.pairCode.startsWith('migel_dc_')) {
    console.log('    dry-run: 已收到一次性配对码，未兑换用户中心。');
    return '';
  }
  if (
    options.dryRun &&
    !options.pairCode &&
    !options.desktopClaim &&
    isDefaultApiBaseUrl(options.apiBaseUrl)
  ) {
    console.log('    dry-run: 未请求线上用户中心。真实运行时会申请短期桌面配对凭证。');
    return '';
  }
  const claim = await resolveDesktopClaim(options);
  console.log('    云端配对凭证已准备好。');
  return claim;
}

async function resolveDesktopClaim(options) {
  if (options.desktopClaim) return options.desktopClaim;

  const pairCode = normalizePairCode(options.pairCode);
  if (!pairCode) {
    const payload = await requestDesktopClaim({
      apiBaseUrl: options.apiBaseUrl,
      agent: options.agent,
      deviceId: options.deviceId,
      deviceName: options.deviceName,
    });
    const claim = normalizeText(payload.desktopClaim || payload.claim);
    if (!claim) {
      throw new Error('用户中心没有返回 desktop claim。');
    }
    return claim;
  }

  if (pairCode.startsWith('migel_dc_')) {
    return pairCode;
  }

  const payload = await redeemPairCode({
    apiBaseUrl: options.apiBaseUrl,
    pairCode,
    agent: options.agent,
  });
  const claim = normalizeText(payload.desktopClaim || payload.claim);
  if (!claim) {
    throw new Error('用户中心没有返回 desktop claim。');
  }
  return claim;
}

async function requestDesktopClaim({
  apiBaseUrl,
  agent,
  deviceId,
  deviceName,
}) {
  const response = await fetch(apiEndpoint(apiBaseUrl, '/desktop/claim/create'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      agent,
      deviceId,
      deviceName,
      client: 'migel-pairing-skill',
    }),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok || payload?.ok === false) {
    const message = errorMessageFromPayload(payload, `HTTP ${response.status}`);
    throw new Error(`云端配对凭证申请失败: ${message}`);
  }
  return payload;
}

async function redeemPairCode({
  apiBaseUrl,
  pairCode,
  agent,
}) {
  const response = await fetch(apiEndpoint(apiBaseUrl, '/desktop/claim/redeem'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      pairCode,
      agent,
      client: 'migel-pairing-skill',
    }),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok || payload?.ok === false) {
    const message = errorMessageFromPayload(payload, `HTTP ${response.status}`);
    throw new Error(`一次性配对码兑换失败: ${message}`);
  }
  return payload;
}

async function runDesktopBootstrap(options, desktopClaim) {
  const bootstrapScript = join(scriptDir, 'migel-desktop-bootstrap.mjs');
  const env = {
    ...process.env,
    MIGEL_RELAY_BASE_URL: options.relayBaseUrl,
    MIGEL_DESKTOP_CLAIM: desktopClaim,
    MIGEL_DESKTOP_DEVICE_ID: options.deviceId,
    MIGEL_DESKTOP_DEVICE_NAME: options.deviceName,
    MIGEL_DESKTOP_AGENT_ID: options.agent,
    MIGEL_DESKTOP_BOOTSTRAP_VERBOSE: 'false',
  };
  await runForeground(process.execPath, [bootstrapScript], {
    cwd: repoRoot,
    env,
  });
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
        reject(new Error('桌面连接器启动失败。'));
      }
    });
  });
}

function printDryRun(options) {
  console.log('    已启用 dry-run，没有启动桌面连接器。');
  console.log(`    Agent: ${options.agent}`);
  console.log(`    Device: ${options.deviceId}`);
  console.log('    下一步会启动 desktop-connector 并生成 Migel Android 扫码二维码。');
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
  const agent = normalizeAgent(raw.agent);
  return {
    ...raw,
    agent,
    pairCode: normalizePairCode(raw.pairCode),
    desktopClaim: normalizeText(raw.desktopClaim),
    apiBaseUrl: normalizeHttpBaseUrl(raw.apiBaseUrl, 'https://api.gewuyishu.cn/account-api'),
    relayBaseUrl: normalizeHttpBaseUrl(raw.relayBaseUrl, 'https://relay.gewuyishu.cn'),
    deviceId: normalizeText(raw.deviceId) || defaultDeviceId(agent),
    deviceName: normalizeText(raw.deviceName) || defaultDeviceName(agent),
    dryRun: parseBoolean(raw.dryRun, false),
  };
}

function normalizeAgent(value) {
  const text = normalizeText(value).toLowerCase();
  if (text === 'openclaw') return 'openclaw';
  return 'hermes';
}

function defaultDeviceId(agent) {
  return agent === 'openclaw' ? 'openclaw-local' : 'desktop-1';
}

function defaultDeviceName(agent) {
  if (agent === 'openclaw') return 'OpenClaw Desktop';
  return hostname() || 'Hermes Desktop';
}

function normalizeHttpBaseUrl(value, fallback) {
  const url = new URL(normalizeText(value) || fallback);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('服务地址必须使用 http 或 https。');
  }
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function apiEndpoint(baseUrl, path) {
  const base = normalizeHttpBaseUrl(baseUrl, 'https://api.gewuyishu.cn/account-api');
  return `${base}/${String(path || '').replace(/^\/+/, '')}`;
}

function normalizePairCode(value) {
  const text = normalizeText(value).replace(/\s+/g, '');
  if (text.startsWith('migel_dc_')) return text;
  return text.toUpperCase();
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return Boolean(fallback);
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  return Boolean(fallback);
}

function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function errorMessageFromPayload(payload, fallback) {
  const error = payload?.error;
  return normalizeText(payload?.message)
    || normalizeText(error?.message)
    || normalizeText(error?.code)
    || normalizeText(error && typeof error === 'object' ? JSON.stringify(error) : error)
    || normalizeText(payload?.code)
    || fallback;
}

function isDefaultApiBaseUrl(value) {
  return normalizeHttpBaseUrl(value, 'https://api.gewuyishu.cn/account-api') === 'https://api.gewuyishu.cn/account-api';
}

function friendlyErrorMessage(error) {
  const message = redactSensitive(error?.message || error || '未知错误');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(message)) {
    return '无法连接到 Migel 用户中心。请检查网络后重试。';
  }
  if (/配对码|pair/i.test(message)) {
    return message;
  }
  return message;
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
  rtk node tools/migel-pairing-skill.mjs --agent hermes

Options:
  --agent hermes|openclaw
  --pair-code MIGEL-8K3D-29QF   # optional compatibility fallback
  --desktop-claim migel_dc_...   # internal beta fallback
  --dry-run true
`);
}
