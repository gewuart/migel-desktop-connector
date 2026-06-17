#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateDesktopE2EKeyPair } from '../desktop-connector/src/protocol/e2eCrypto.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const defaultStateDir = join(homedir(), '.migel', 'desktop-connector');
const defaultHermesEnvPath = join(homedir(), '.hermes', '.env');
const defaults = {
  relayBaseUrl: process.env.MIGEL_RELAY_BASE_URL || 'https://relay.gewuyishu.cn',
  claim: process.env.MIGEL_DESKTOP_CLAIM || '',
  deviceId: process.env.MIGEL_DESKTOP_DEVICE_ID || 'desktop-1',
  deviceName: process.env.MIGEL_DESKTOP_DEVICE_NAME || hostname() || 'Migel Desktop',
  stateDir: process.env.MIGEL_DESKTOP_STATE_DIR || defaultStateDir,
  envPath: process.env.MIGEL_DESKTOP_ENV_PATH || '',
  pidPath: process.env.MIGEL_DESKTOP_PID_PATH || '',
  logPath: process.env.MIGEL_DESKTOP_LOG_PATH || '',
  qrOutput: process.env.MIGEL_PAIRING_QR_OUTPUT || '',
  e2eKeyPath: process.env.MIGEL_DESKTOP_E2E_KEY_PATH || process.env.HERMES_BRIDGE_E2E_KEY_PATH || '',
  open: process.env.MIGEL_PAIRING_OPEN_QR || '',
  skipStart: process.env.MIGEL_DESKTOP_SKIP_START || 'false',
  useLaunchAgent: process.env.MIGEL_DESKTOP_USE_LAUNCH_AGENT || '',
  skipQr: process.env.MIGEL_DESKTOP_SKIP_QR || 'false',
  forceRedeem: process.env.MIGEL_DESKTOP_FORCE_REDEEM || 'false',
  verbose: process.env.MIGEL_DESKTOP_BOOTSTRAP_VERBOSE || 'false',
  connectorReadyTimeoutMs: process.env.MIGEL_DESKTOP_CONNECTOR_READY_TIMEOUT_MS || '8000',
};

await main().catch((error) => {
  printBootstrapError(error);
  process.exitCode = 1;
});

async function main() {
  const options = normalizeOptions(parseArgs(process.argv.slice(2), defaults));
  if (options.help) {
    printUsage();
    return;
  }

  const logger = createBootstrapLogger(options);
  logger.title('Migel 正在准备这台电脑的手机连接');

  mkdirSync(options.stateDir, {
    recursive: true,
    mode: 0o700,
  });

  logger.step(1, '准备本机连接凭证');
  const connectorEnv = await resolveConnectorEnv(options, logger);
  writeConnectorEnv(options.envPath, connectorEnv);
  logger.ok('本机连接凭证已准备好。');
  logger.detail(`凭证文件: ${options.envPath}`);
  logger.detail(`Desktop deviceId: ${connectorEnv.MIGEL_DESKTOP_DEVICE_ID}`);
  logger.detail(`Relay: ${connectorEnv.MIGEL_GATEWAY_HOST}:${connectorEnv.MIGEL_GATEWAY_PORT}${connectorEnv.MIGEL_GATEWAY_PATH}`);

  if (!options.skipStart) {
    logger.step(2, '启动电脑端连接器');
    const startResult = options.useLaunchAgent
      ? await restartDesktopConnectorService(options)
      : await restartDesktopConnector(options, connectorEnv);
    const ready = await waitForConnectorReady({
      pid: startResult.pid,
      logPath: options.logPath,
      fromOffset: startResult.logOffset,
      timeoutMs: options.connectorReadyTimeoutMs,
    });
    if (ready.ready) {
      logger.ok('电脑端已连接到 relay.gewuyishu.cn。');
    } else if (ready.exited) {
      throw new Error(`Desktop Connector 启动后退出。请查看日志: ${options.logPath}`);
    } else {
      logger.warn('电脑端正在连接中，二维码会继续生成；如果扫码后提示电脑不在线，请等几秒再试。');
      logger.detail(`连接器日志: ${options.logPath}`);
    }
  } else {
    logger.detail('已跳过 Desktop Connector 启动。');
  }

  if (!options.skipQr) {
    logger.step(3, '生成手机扫码二维码');
    await generatePairingQr(options, connectorEnv);
    logger.step(4, '请用 Migel Android App 扫码');
    logger.ok('扫码后手机会连接到这台电脑。');
  } else {
    logger.detail('已跳过二维码生成。');
  }
}

async function resolveConnectorEnv(options, logger) {
  if (!options.forceRedeem) {
    const cached = readConnectorEnv(options.envPath);
    if (cached.MIGEL_DESKTOP_DEVICE_TOKEN && cached.MIGEL_GATEWAY_HOST) {
      logger?.detail?.('使用已保存的本机连接凭证。');
      return withConnectorRuntimeDefaults(cached, options);
    }
  }

  const claim = normalizeText(options.claim);
  if (!claim) {
    throw new Error('缺少 MIGEL_DESKTOP_CLAIM。请从 Migel App 复制新的终端命令。');
  }
  const redeemed = await redeemDesktopClaim({
    relayBaseUrl: options.relayBaseUrl,
    claim,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
  });
  const gateway = normalizeGateway(redeemed.gateway, options.relayBaseUrl);
  return withConnectorRuntimeDefaults({
    MIGEL_GATEWAY_HOST: gateway.host,
    MIGEL_GATEWAY_PORT: String(gateway.port),
    MIGEL_GATEWAY_SECURE: String(gateway.secure),
    MIGEL_GATEWAY_PATH: gateway.path,
    MIGEL_DESKTOP_DEVICE_ID: redeemed.deviceId || options.deviceId,
    MIGEL_DESKTOP_DEVICE_TOKEN: redeemed.desktopToken,
  }, options);
}

function withConnectorRuntimeDefaults(env, options = {}) {
  const e2eKeyPath = normalizeText(env.MIGEL_DESKTOP_E2E_KEY_PATH)
    || normalizeText(env.HERMES_BRIDGE_E2E_KEY_PATH)
    || normalizeText(options.e2eKeyPath)
    || join(options.stateDir || defaultStateDir, 'e2e-key.json');
  const e2eKeyPair = loadOrCreateDesktopE2EKeyPair({
    keyPath: e2eKeyPath,
  });
  const publicKey = e2eKeyPair.publicKey.toString('base64');
  return {
    ...env,
    HERMES_ENV_PATH: normalizeText(env.HERMES_ENV_PATH)
      || normalizeText(process.env.HERMES_ENV_PATH)
      || defaultHermesEnvPath,
    MIGEL_DESKTOP_E2E: normalizeText(env.MIGEL_DESKTOP_E2E) || 'true',
    MIGEL_DESKTOP_E2E_KEY_PATH: e2eKeyPath,
    MIGEL_DESKTOP_E2E_PUBLIC_KEY: publicKey,
    MIGEL_BRIDGE_PUBLIC_KEY: normalizeText(env.MIGEL_BRIDGE_PUBLIC_KEY) || publicKey,
    HERMES_BRIDGE_E2E: normalizeText(env.HERMES_BRIDGE_E2E) || 'true',
    HERMES_BRIDGE_E2E_KEY_PATH: e2eKeyPath,
    MIGEL_GATEWAY_RECONNECT: normalizeText(env.MIGEL_GATEWAY_RECONNECT) || 'true',
    NODE_USE_SYSTEM_CA: normalizeText(env.NODE_USE_SYSTEM_CA) || '1',
  };
}

async function redeemDesktopClaim({
  relayBaseUrl,
  claim,
  deviceId,
  deviceName,
}) {
  const response = await fetch(new URL('/desktop/token', `${relayBaseUrl}/`), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      claim,
      deviceId,
      deviceName,
      client: 'migel-desktop-bootstrap',
      platform: platform(),
    }),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok || payload?.ok === false) {
    const message = normalizeText(payload?.message)
      || normalizeText(payload?.error)
      || `HTTP ${response.status}`;
    throw new Error(`兑换 Desktop token 失败: ${message}`);
  }
  if (!normalizeText(payload?.desktopToken)) {
    throw new Error('Relay 没有返回 desktopToken。');
  }
  return payload;
}

function writeConnectorEnv(envPath, env) {
  mkdirSync(dirname(envPath), {
    recursive: true,
    mode: 0o700,
  });
  const lines = Object.entries(env)
    .filter(([, value]) => normalizeText(value))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  writeFileSync(envPath, `${lines.join('\n')}\n`, {
    mode: 0o600,
  });
  chmodSync(envPath, 0o600);
}

function readConnectorEnv(envPath) {
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, 'utf8');
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    result[match[1]] = unquoteShellValue(match[2]);
  }
  return result;
}

async function restartDesktopConnector(options, connectorEnv) {
  const connectorEntry = join(repoRoot, 'desktop-connector', 'src', 'main.mjs');
  if (!existsSync(connectorEntry)) {
    throw new Error(`找不到 desktop-connector 入口: ${connectorEntry}`);
  }
  await stopOldProcess(options.pidPath);

  const logOffset = fileSize(options.logPath);
  const logFd = openSync(options.logPath, 'a', 0o600);
  const child = spawn(process.execPath, [connectorEntry], {
    cwd: join(repoRoot, 'desktop-connector'),
    detached: true,
    env: {
      ...process.env,
      ...connectorEnv,
    },
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(options.pidPath, `${child.pid}\n`, {
    mode: 0o600,
  });
  chmodSync(options.pidPath, 0o600);
  return {
    pid: child.pid,
    logOffset,
  };
}

async function restartDesktopConnectorService(options) {
  const installer = join(repoRoot, 'tools', 'install-migel-desktop-connector-service.sh');
  if (!existsSync(installer)) {
    throw new Error(`找不到 Desktop Connector 服务安装脚本: ${installer}`);
  }

  const logOffset = fileSize(options.logPath);
  await runCaptured(installer, ['restart'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIGEL_DESKTOP_STATE_DIR: options.stateDir,
      MIGEL_DESKTOP_ENV_PATH: options.envPath,
      MIGEL_DESKTOP_PID_PATH: options.pidPath,
      MIGEL_DESKTOP_LOG_PATH: options.logPath,
    },
  });

  return {
    pid: readPid(options.pidPath),
    logOffset,
  };
}

async function stopOldProcess(pidPath) {
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await waitForProcessExit(pid, 1500);
}

function readPid(pidPath) {
  try {
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForConnectorReady({
  pid,
  logPath,
  fromOffset = 0,
  timeoutMs = 8000,
}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() <= deadline) {
    const logText = readLogSince(logPath, fromOffset);
    if (/Desktop Connector gateway state:\s*open/i.test(logText)) {
      return {
        ready: true,
      };
    }
    if (pid && !isProcessAlive(pid)) {
      return {
        ready: false,
        exited: true,
      };
    }
    await sleep(300);
  }
  return {
    ready: false,
    timedOut: true,
  };
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readLogSince(path, offset) {
  if (!existsSync(path)) return '';
  try {
    const text = readFileSync(path, 'utf8');
    return text.slice(Math.max(0, Math.min(Number(offset) || 0, text.length)));
  } catch {
    return '';
  }
}

async function generatePairingQr(options, connectorEnv) {
  const qrScript = join(scriptDir, 'gateway-companion-qr.mjs');
  const relayBaseUrl = options.relayBaseUrl.replace(/\/+$/g, '');
  const args = [
    qrScript,
    '--health-url',
    `${relayBaseUrl}/health`,
    '--invite-url',
    `${relayBaseUrl}/pairing/invite`,
    '--output',
    options.qrOutput,
    '--host',
    connectorEnv.MIGEL_GATEWAY_HOST,
    '--port',
    connectorEnv.MIGEL_GATEWAY_PORT,
    '--secure',
    connectorEnv.MIGEL_GATEWAY_SECURE,
    '--path',
    connectorEnv.MIGEL_GATEWAY_PATH,
    '--nodeId',
    connectorEnv.MIGEL_DESKTOP_DEVICE_ID,
    '--desktop-device-id',
    connectorEnv.MIGEL_DESKTOP_DEVICE_ID,
    '--role',
    'desktop',
    '--source',
    'MigelDesktopBootstrap',
    '--name',
    options.deviceName,
    '--bridge',
    'Migel Desktop Connector',
    '--bridgePublicKey',
    connectorEnv.MIGEL_DESKTOP_E2E_PUBLIC_KEY,
    '--qr',
    'short',
    '--terminalQr',
    'true',
    '--output-mode',
    options.verbose ? 'default' : 'user',
    '--open',
    String(options.open),
  ];
  await runForeground(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...connectorEnv,
    },
  });
}

function runForeground(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with status ${status}`));
      }
    });
  });
}

function runCaptured(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with status ${status}: ${redactSensitive(stderr || stdout)}`));
      }
    });
  });
}

function normalizeOptions(raw) {
  const stateDir = resolve(expandHome(raw.stateDir || defaultStateDir));
  const relayBaseUrl = normalizeRelayBaseUrl(raw.relayBaseUrl);
  return {
    ...raw,
    relayBaseUrl,
    claim: normalizeText(raw.claim),
    deviceId: normalizeText(raw.deviceId) || 'desktop-1',
    deviceName: normalizeText(raw.deviceName) || 'Migel Desktop',
    stateDir,
    envPath: resolve(expandHome(raw.envPath || join(stateDir, 'desktop-connector.env'))),
    pidPath: resolve(expandHome(raw.pidPath || join(stateDir, 'desktop-connector.pid'))),
    logPath: resolve(expandHome(raw.logPath || join(stateDir, 'desktop-connector.log'))),
    qrOutput: resolve(expandHome(raw.qrOutput || join(stateDir, 'pairing.png'))),
    e2eKeyPath: resolve(expandHome(raw.e2eKeyPath || join(stateDir, 'e2e-key.json'))),
    open: parseBoolean(raw.open, platform() === 'darwin'),
    skipStart: parseBoolean(raw.skipStart, false),
    skipQr: parseBoolean(raw.skipQr, false),
    useLaunchAgent: parseBoolean(raw.useLaunchAgent, platform() === 'darwin'),
    forceRedeem: parseBoolean(raw.forceRedeem, false),
    verbose: parseBoolean(raw.verbose, false),
    connectorReadyTimeoutMs: positiveInteger(raw.connectorReadyTimeoutMs, 8000),
  };
}

function normalizeGateway(gateway, relayBaseUrl) {
  const source = gateway && typeof gateway === 'object' ? gateway : {};
  const base = new URL(relayBaseUrl);
  const secure = typeof source.secure === 'boolean' ? source.secure : base.protocol === 'https:';
  return {
    host: normalizeText(source.host) || base.hostname,
    port: positiveInteger(source.port || base.port, secure ? 443 : 80),
    secure,
    path: normalizePath(source.path || '/gateway'),
  };
}

function normalizeRelayBaseUrl(value) {
  const url = new URL(normalizeText(value) || 'https://relay.gewuyishu.cn');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MIGEL_RELAY_BASE_URL 必须使用 http 或 https。');
  }
  url.pathname = url.pathname.replace(/\/+$/g, '') || '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
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

function printUsage() {
  console.log(`Usage:
  MIGEL_DESKTOP_CLAIM='migel_dc_...' node tools/migel-desktop-bootstrap.mjs

Options:
  --relay-base-url https://relay.gewuyishu.cn
  --claim migel_dc_...
  --device-id desktop-1
  --state-dir ~/.migel/desktop-connector
  --skip-start true
  --use-launch-agent true
  --skip-qr true
  --verbose true
`);
}

function createBootstrapLogger(options) {
  return {
    title(message) {
      console.log(message);
    },
    step(index, message) {
      console.log(`[${index}/4] ${message}...`);
    },
    ok(message) {
      console.log(`    ${message}`);
    },
    warn(message) {
      console.log(`    ${message}`);
    },
    detail(message) {
      if (options.verbose) {
        console.log(`    ${message}`);
      }
    },
  };
}

function printBootstrapError(error) {
  const message = friendlyErrorMessage(error);
  console.error('');
  console.error('Migel 连接没有完成。');
  console.error(`原因: ${message}`);
  console.error('请回到 Migel App 重新复制一条最新命令后再试。');
  if (parseBoolean(process.env.MIGEL_DESKTOP_BOOTSTRAP_VERBOSE, false) && error?.stack) {
    console.error('');
    console.error(redactSensitive(error.stack));
  }
}

function friendlyErrorMessage(error) {
  const message = redactSensitive(error?.message || error || '未知错误');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(message)) {
    return '无法连接到 Migel 中继服务。请检查网络后重试。';
  }
  if (/缺少 MIGEL_DESKTOP_CLAIM|claim/i.test(message)) {
    return '这条连接命令缺少或已经失效。请从 Migel App 重新复制。';
  }
  return message;
}

function redactSensitive(value) {
  return String(value || '')
    .replace(/migel_desktop_dt_[A-Za-z0-9._-]+/g, '[desktop-token]')
    .replace(/migel_dt_[A-Za-z0-9._-]+/g, '[device-token]')
    .replace(/migel_dc_[A-Za-z0-9._-]+/g, '[desktop-claim]');
}

function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function normalizePath(value) {
  const text = normalizeText(value);
  if (!text) return '/gateway';
  return text.startsWith('/') ? text : `/${text}`;
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return Boolean(fallback);
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  return Boolean(fallback);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function unquoteShellValue(value) {
  const text = normalizeText(value);
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

function expandHome(value) {
  const text = normalizeText(value);
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

function normalizeText(value) {
  return String(value || '').trim();
}
