#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import { buildMigelPairUri } from '../gateway/src/server/pairingInvites.mjs';

const execFileAsync = promisify(execFile);

const defaults = {
  healthUrl: 'http://127.0.0.1:8443/health',
  inviteUrl: '',
  output: '/tmp/migel-gateway-pairing.png',
  token: process.env.MIGEL_PAIRING_ADMIN_TOKEN
    || process.env.MIGEL_DESKTOP_DEVICE_TOKEN
    || process.env.MIGEL_DESKTOP_TOKEN
    || process.env.MIGEL_RELAY_DESKTOP_TOKEN
    || process.env.HERMES_BRIDGE_PAIRING_ADMIN_TOKEN
    || process.env.GATEWAY_TOKEN
    || '',
  role: process.env.MIGEL_GATEWAY_ROLE || 'desktop',
  deviceId: process.env.MIGEL_DESKTOP_DEVICE_ID || process.env.DESKTOP_DEVICE_ID || '',
  desktopDeviceId: process.env.MIGEL_DESKTOP_DEVICE_ID || process.env.DESKTOP_DEVICE_ID || '',
  ttlMinutes: '',
  ttlSeconds: '',
  ttlMillis: '',
  host: '',
  port: '',
  secure: '',
  path: '',
  name: '',
  bridge: '',
  nodeId: '',
  source: 'HermesMigelBridge',
  publicKey: '',
  bridgePublicKey: '',
  pubkey: '',
  qr: 'short',
  terminalQr: 'true',
  terminalStyle: 'ansi',
  outputMode: process.env.MIGEL_PAIRING_OUTPUT_MODE || 'default',
  open: 'false',
};

const options = parseArgs(process.argv.slice(2), defaults);
const health = await loadHealth(options.healthUrl).catch(() => null);
const invite = await createPairingInvite(options, health);
const outputPath = resolve(options.output);
const qrContent = buildQrContent(invite, options);
const qrModel = QRCode.create(qrContent, {
  errorCorrectionLevel: 'L',
});
const pngBuffer = await QRCode.toBuffer(qrContent, {
  type: 'png',
  errorCorrectionLevel: 'L',
  margin: 4,
  width: 1080,
  color: {
    dark: '#000000',
    light: '#ffffff',
  },
});
writeFileSync(outputPath, pngBuffer);

const textPath = `${outputPath}.txt`;
writeFileSync(textPath, `${qrContent}\n`, 'utf8');
const commandTextPath = `${outputPath}.command.txt`;
const commandText = buildUniversalCommandText(options, outputPath);
writeFileSync(commandTextPath, `${commandText}\n`, 'utf8');
const shouldPrintTerminalQr = parseBoolean(options.terminalQr, false);
const openResult = await openOutputImage(options, outputPath);
const terminalQr = shouldPrintTerminalQr ? renderTerminalQr(qrModel, options) : '';
if (isUserOutputMode(options)) {
  printUserPairingOutput({
    invite,
    outputPath,
    textPath,
    openResult,
    terminalQr,
    shouldPrintTerminalQr,
  });
} else {
  printVerbosePairingOutput({
    invite,
    outputPath,
    textPath,
    commandTextPath,
    commandText,
    qrContent,
    qrModel,
    openResult,
    terminalQr,
    shouldPrintTerminalQr,
  });
}

function parseArgs(argv, seed) {
  const result = { ...seed };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const rawKey = arg.slice(2);
    const key = Object.hasOwn(result, rawKey) ? rawKey : toCamelCase(rawKey);
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

function isUserOutputMode(options) {
  const mode = normalize(options.outputMode).toLowerCase();
  return mode === 'user' || mode === 'simple';
}

function printUserPairingOutput({
  invite,
  outputPath,
  textPath,
  openResult,
  terminalQr,
  shouldPrintTerminalQr,
}) {
  console.log(`    二维码已准备好: ${outputPath}`);
  console.log('    请用 Migel Android App 扫码连接这台电脑。');
  if (openResult.opened) {
    console.log('    二维码窗口已打开，请直接用手机扫码。');
  } else if (openResult.reason) {
    console.log(`    二维码窗口没有自动打开，请扫下面的终端二维码。`);
  }
  console.log(`    备用配对码: ${invite.code}`);
  console.log(`    有效期: ${formatExpiresAt(invite.expiresAtEpochMillis)}`);
  if (!shouldPrintTerminalQr) {
    console.log(`    二维码内容已保存: ${textPath}`);
    return;
  }
  console.log('');
  printTerminalQrUserHints(terminalQr);
  console.log('终端扫码二维码:');
  console.log(terminalQr.text);
}

function printVerbosePairingOutput({
  invite,
  outputPath,
  textPath,
  commandTextPath,
  commandText,
  qrContent,
  qrModel,
  openResult,
  terminalQr,
  shouldPrintTerminalQr,
}) {
  console.log(`二维码已生成: ${outputPath}`);
  if (openResult.opened) {
    console.log('二维码窗口已打开，请直接用手机扫码。');
  } else if (openResult.reason) {
    console.log(`二维码窗口未自动打开: ${openResult.reason}`);
  }
  console.log(`配对内容: ${textPath}`);
  console.log(`一键复制命令: ${commandTextPath}`);
  console.log(`配对码: ${invite.code}`);
  console.log(`Invite ID: ${invite.inviteId}`);
  console.log(`过期时间: ${formatExpiresAt(invite.expiresAtEpochMillis)}`);
  console.log(`兑换接口: ${invite.redeemUrl}`);
  console.log(`网关地址: ${invite.host}:${invite.port}${invite.path}`);
  console.log(`二维码复杂度: ${qrContent.length} 字符，${qrModel.modules.size}x${qrModel.modules.size} 模块`);
  console.log('');
  console.log(qrContent);
  if (shouldPrintTerminalQr) {
    console.log('');
    printTerminalQrHints(terminalQr);
    console.log('终端扫码二维码（低密度黑白大块版；请保持终端不换行）:');
    console.log(terminalQr.text);
  }
  console.log('');
  console.log('终端/智能体通用复制块:');
  console.log(commandText);
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

async function loadHealth(healthUrl) {
  const response = await fetch(healthUrl);
  if (!response.ok) {
    throw new Error(`health request failed: ${response.status}`);
  }
  return response.json();
}

async function createPairingInvite(options, health) {
  const inviteUrl = pairingInviteUrl(options.inviteUrl || options.healthUrl);
  const body = pairingInviteRequestBody(options, health);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
  };
  const token = normalize(options.token);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const identity = pairingInviteRequestIdentity(options, body);
  if (identity.role) {
    headers['X-Gateway-Role'] = identity.role;
  }
  if (identity.deviceId) {
    headers['X-Gateway-Device-Id'] = identity.deviceId;
  }

  const response = await fetch(inviteUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok || payload?.ok === false) {
    const message = normalize(payload?.message)
      || normalize(payload?.error)
      || text.trim()
      || `HTTP ${response.status}`;
    throw new Error(`创建临时配对邀请失败: ${message}`);
  }

  const qrContent = normalize(payload.qrContent) || buildMigelPairUri(payload);
  return {
    inviteId: normalize(payload.inviteId),
    code: normalize(payload.code),
    expiresAtEpochMillis: Number(payload.expiresAtEpochMillis) || null,
    host: normalize(payload.host || body.host),
    port: Number(payload.port || body.port),
    secure: parseBoolean(payload.secure, body.secure),
    path: normalizePath(payload.path || body.path),
    bridgePublicKey: normalize(payload.bridgePublicKey || body.bridgePublicKey),
    qrContent,
    redeemUrl: pairingRedeemUrl(inviteUrl),
  };
}

function buildQrContent(invite, options) {
  if (normalize(options.qr).toLowerCase() === 'full') {
    return invite.qrContent || buildMigelPairUri(invite);
  }
  return buildCompactMigelPairUri(invite);
}

function buildCompactMigelPairUri(invite) {
  const port = positiveInteger(invite.port, 443);
  const secure = Boolean(invite.secure);
  const host = normalize(invite.host);
  const inviteId = normalize(invite.inviteId);
  const path = normalizePath(invite.path);
  if (port === 443 && secure && path === '/gateway' && host && inviteId) {
    return `migel:${host},${inviteId}`;
  }
  const params = new URLSearchParams({
    host,
    invite: inviteId,
  });
  if (port !== 443) {
    params.set('port', String(port));
  }
  if (!secure) {
    params.set('secure', '0');
  }
  if (path !== '/gateway') {
    params.set('path', path);
  }
  return `migel://pair?${params.toString()}`;
}

function buildUniversalCommandText(options, outputPath) {
  const args = [
    'tools/gateway-companion-qr.mjs',
    '--output',
    outputPath,
    '--qr',
    'short',
    '--terminalQr',
    'true',
    '--terminal-style',
    'ansi',
    '--open',
    'false',
    ...ttlCommandArgs(options),
  ];
  const commandArgs = args.map(shellQuote).join(' ');
  return [
    '# Migel/OpenClaw/Hermes 一键生成低密度配对二维码。',
    '# 用法：整段复制到 zsh/bash 终端直接运行；也可以整段发给智能体，让它在本机执行。',
    '# 作用：生成短时有效的低密度终端二维码和 PNG 备用图，并打印备用配对码；本段不包含 token 或密钥。',
    `cd ${shellQuote(process.cwd())}`,
    'if command -v rtk >/dev/null 2>&1; then',
    `  rtk node ${commandArgs}`,
    'else',
    `  node ${commandArgs}`,
    'fi',
  ].join('\n');
}

function ttlCommandArgs(options) {
  const millis = positiveInteger(options.ttlMillis, 0);
  if (millis > 0) return ['--ttlMillis', String(millis)];
  const seconds = positiveInteger(options.ttlSeconds, 0);
  if (seconds > 0) return ['--ttlSeconds', String(seconds)];
  const minutes = positiveInteger(options.ttlMinutes, 10);
  return ['--ttlMinutes', String(minutes)];
}

function pairingInviteRequestBody(options, health) {
  const advertised = health?.advertisedEndpoint || {};
  const gateway = health?.gateway || {};
  const ttlMillis = requestedTtlMillis(options);
  const desktopDeviceId = normalize(options.desktopDeviceId || options.deviceId);
  return removeBlankValues({
    host: normalize(options.host || advertised.host || gateway.host),
    port: positiveInteger(options.port || advertised.port || gateway.port, 443),
    secure: parseBoolean(options.secure, advertised.secure ?? gateway.secure ?? true),
    path: normalizePath(options.path || advertised.path || gateway.path || health?.gatewayPath || '/gateway'),
    name: normalize(options.name || health?.nodeName || 'Hermes 本地节点'),
    bridge: normalize(options.bridge || health?.bridge || health?.bridgeLabel || 'Gateway Companion'),
    nodeId: normalize(options.nodeId || desktopDeviceId || gateway.nodeId || health?.nodeId || 'hermes-local'),
    source: normalize(options.source || 'HermesMigelBridge'),
    bridgePublicKey: normalize(
      options.bridgePublicKey
        || options.publicKey
        || options.pubkey
        || health?.bridgePublicKey
        || health?.publicKey,
    ),
    ttlMillis,
  });
}

function pairingInviteRequestIdentity(options, body) {
  return {
    role: normalize(options.role || 'desktop'),
    deviceId: normalize(options.desktopDeviceId || options.deviceId || options.nodeId || body?.nodeId),
  };
}

function requestedTtlMillis(options) {
  const millis = positiveInteger(options.ttlMillis, 0);
  if (millis > 0) return millis;
  const seconds = positiveInteger(options.ttlSeconds, 0);
  if (seconds > 0) return seconds * 1000;
  const minutes = positiveInteger(options.ttlMinutes, 0);
  if (minutes > 0) return minutes * 60 * 1000;
  return undefined;
}

function pairingInviteUrl(rawUrl) {
  if (normalize(rawUrl) && !normalize(rawUrl).endsWith('/health')) {
    return rawUrl;
  }
  return new URL('/pairing/invite', rawUrl).toString();
}

function pairingRedeemUrl(inviteUrl) {
  return new URL('/pairing/redeem', inviteUrl).toString();
}

function removeBlankValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== '' && entry != null),
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

async function openOutputImage(options, outputPath) {
  if (!parseBoolean(options.open, true)) {
    return {
      opened: false,
      reason: '',
    };
  }
  const opener = outputImageOpener();
  if (!opener) {
    return {
      opened: false,
      reason: '当前系统没有可用的图片打开命令。',
    };
  }
  try {
    await execFileAsync(opener.command, [...opener.args, outputPath], {
      timeout: 5000,
      windowsHide: true,
    });
    return {
      opened: true,
      reason: '',
    };
  } catch (error) {
    return {
      opened: false,
      reason: sanitizeOpenError(error),
    };
  }
}

function outputImageOpener() {
  if (process.platform === 'darwin') return { command: 'open', args: [] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

function sanitizeOpenError(error) {
  return String(error?.message || error || '未知错误')
    .replace(/[A-Fa-f0-9]{32,}/g, '[redacted]');
}

function normalize(value) {
  return String(value || '').trim();
}

function normalizePath(value) {
  const raw = normalize(value);
  if (!raw) return '/gateway';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseBoolean(rawValue, fallback) {
  if (typeof rawValue === 'boolean') return rawValue;
  if (rawValue === '' || rawValue == null) return Boolean(fallback);
  switch (String(rawValue).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'y':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'n':
    case 'off':
      return false;
    default:
      return Boolean(fallback);
  }
}

function formatExpiresAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '未知';
  return new Date(numeric).toLocaleString();
}

function renderTerminalQr(qr, options) {
  const size = qr.modules.size;
  const data = qr.modules.data;
  const quietZone = 4;
  const modulesPerLine = size + (quietZone * 2);
  const columns = modulesPerLine * 2;
  const style = terminalQrStyle(options);
  const rows = [];
  const light = style === 'ansi' ? '\u001b[47m  ' : '  ';
  const dark = style === 'ansi' ? '\u001b[40m  ' : '██';
  const reset = style === 'ansi' ? '\u001b[0m' : '';
  for (let row = -quietZone; row < size + quietZone; row += 1) {
    let line = '';
    for (let column = -quietZone; column < size + quietZone; column += 1) {
      const inBounds = row >= 0 && row < size && column >= 0 && column < size;
      const isDark = inBounds && data[(row * size) + column];
      line += isDark ? dark : light;
    }
    rows.push(`${line}${reset}`);
  }
  return {
    text: rows.join('\n'),
    columns,
    rows: rows.length,
    style,
  };
}

function terminalQrStyle(options) {
  const rawStyle = normalize(options.terminalStyle).toLowerCase();
  if (rawStyle === 'ansi' || rawStyle === 'block') return rawStyle;
  if (process.env.NO_COLOR) return 'block';
  return 'ansi';
}

function printTerminalQrHints(terminalQr) {
  const actualColumns = Number(process.stdout.columns) || 0;
  if (actualColumns > 0 && actualColumns < terminalQr.columns) {
    console.log(`提示：当前终端宽度 ${actualColumns} 列，小于二维码需要的 ${terminalQr.columns} 列；请先放宽终端，否则换行后会扫不出。`);
  }
  console.log(`终端二维码尺寸: ${terminalQr.columns} 列 x ${terminalQr.rows} 行，渲染: ${terminalQr.style}`);
}

function printTerminalQrUserHints(terminalQr) {
  const actualColumns = Number(process.stdout.columns) || 0;
  if (actualColumns > 0 && actualColumns < terminalQr.columns) {
    console.log(`提示：当前终端太窄，请先放宽窗口再扫码。`);
  }
}
