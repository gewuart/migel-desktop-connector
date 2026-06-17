import { DEFAULT_AGENT_ID } from '../agents/agentTypes.mjs';
import { DEFAULT_GATEWAY_URL } from '../gateway/gatewayClient.mjs';
import { DEFAULT_DESKTOP_E2E_KEY_PATH } from '../protocol/e2eCrypto.mjs';

const DEFAULT_AGENT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_FILE_UPLOAD_BYTES = 4194304;
const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 60000;
const DEFAULT_GATEWAY_RECONNECT_DELAY_MS = 2000;
const DEFAULT_GATEWAY_HEARTBEAT_MS = 25000;
const DEFAULT_DESKTOP_DEVICE_ID = 'desktop-1';

export function loadDesktopConnectorEnv({
  env = globalThis.process?.env || {},
} = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const explicitGatewayUrl = firstText(
    source.MIGEL_GATEWAY_URL,
    source.DESKTOP_CONNECTOR_GATEWAY_URL,
    source.HERMES_GATEWAY_URL,
  );
  return {
    gatewayUrl: explicitGatewayUrl || buildDesktopGatewayUrl(source),
    agentId: firstText(
      source.MIGEL_DESKTOP_AGENT_ID,
      source.DESKTOP_CONNECTOR_AGENT_ID,
      source.MIGEL_AGENT_ID,
      DEFAULT_AGENT_ID,
    ).toLowerCase(),
    modelId: firstText(
      source.MIGEL_DESKTOP_MODEL_ID,
      source.DESKTOP_CONNECTOR_MODEL_ID,
      source.MIGEL_AGENT_MODEL_ID,
      source.HERMES_MODEL_ID,
      source.OPENCLAW_MODEL_ID,
    ),
    apiServerUrl: firstText(
      source.MIGEL_AGENT_API_SERVER_URL,
      source.HERMES_API_SERVER_URL,
      source.OPENCLAW_API_SERVER_URL,
      source.API_SERVER_URL,
    ),
    apiKey: firstText(
      source.MIGEL_AGENT_API_KEY,
      source.HERMES_API_SERVER_KEY,
      source.OPENCLAW_API_SERVER_KEY,
      source.API_SERVER_KEY,
    ),
    attachmentBaseUrl: firstText(
      source.MIGEL_GATEWAY_ATTACHMENT_BASE_URL,
      source.DESKTOP_CONNECTOR_ATTACHMENT_BASE_URL,
    ),
    envPath: firstText(
      source.MIGEL_AGENT_ENV_PATH,
      source.HERMES_ENV_PATH,
      source.OPENCLAW_ENV_PATH,
    ),
    configPath: firstText(
      source.MIGEL_HERMES_CONFIG_PATH,
      source.HERMES_CONFIG_PATH,
      source.HERMES_BRIDGE_CONFIG_PATH,
    ),
    timeoutMs: positiveInteger(
      firstText(source.MIGEL_AGENT_TIMEOUT_MS, source.HERMES_API_SERVER_TIMEOUT_MS),
      DEFAULT_AGENT_TIMEOUT_MS,
    ),
    maxFileUploadBytes: positiveInteger(
      firstText(source.MIGEL_MAX_FILE_UPLOAD_BYTES, source.HERMES_BRIDGE_MAX_FILE_UPLOAD_BYTES),
      DEFAULT_MAX_FILE_UPLOAD_BYTES,
    ),
    maxExtractedTextChars: positiveInteger(
      firstText(source.MIGEL_MAX_EXTRACTED_TEXT_CHARS, source.HERMES_BRIDGE_MAX_EXTRACTED_TEXT_CHARS),
      DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
    ),
    reconnect: parseBoolean(
      firstText(source.MIGEL_GATEWAY_RECONNECT, source.DESKTOP_CONNECTOR_RECONNECT),
      true,
    ),
    reconnectDelayMs: positiveInteger(
      firstText(source.MIGEL_GATEWAY_RECONNECT_DELAY_MS, source.DESKTOP_CONNECTOR_RECONNECT_DELAY_MS),
      DEFAULT_GATEWAY_RECONNECT_DELAY_MS,
    ),
    heartbeatMs: positiveInteger(
      firstText(source.MIGEL_GATEWAY_HEARTBEAT_MS, source.DESKTOP_CONNECTOR_HEARTBEAT_MS),
      DEFAULT_GATEWAY_HEARTBEAT_MS,
    ),
    e2eEnabled: parseBoolean(
      firstText(source.MIGEL_DESKTOP_E2E, source.HERMES_BRIDGE_E2E),
      true,
    ),
    e2eKeyPath: firstText(
      source.MIGEL_DESKTOP_E2E_KEY_PATH,
      source.HERMES_BRIDGE_E2E_KEY_PATH,
      DEFAULT_DESKTOP_E2E_KEY_PATH,
    ),
    e2ePublicKey: firstText(
      source.MIGEL_DESKTOP_E2E_PUBLIC_KEY,
      source.MIGEL_BRIDGE_PUBLIC_KEY,
      source.HERMES_BRIDGE_PUBLIC_KEY,
    ),
    debugPermissionProbe: parseBoolean(
      firstText(source.MIGEL_DEBUG_PERMISSION_PROBE, source.DESKTOP_CONNECTOR_DEBUG_PERMISSION_PROBE),
      false,
    ),
    debugPermissionProbeCommand: firstText(
      source.MIGEL_DEBUG_PERMISSION_PROBE_COMMAND,
      source.DESKTOP_CONNECTOR_DEBUG_PERMISSION_PROBE_COMMAND,
      'cd ~/Desktop && pwd',
    ),
  };
}

function buildDesktopGatewayUrl(source) {
  const host = firstText(
    source.MIGEL_GATEWAY_HOST,
    source.MIGEL_RELAY_HOST,
    source.MIGEL_PUBLIC_HOST,
    source.GATEWAY_PUBLIC_HOST,
    source.PUBLIC_HOST,
  );
  const token = firstText(
    source.MIGEL_DESKTOP_DEVICE_TOKEN,
    source.MIGEL_DESKTOP_TOKEN,
    source.MIGEL_RELAY_DESKTOP_TOKEN,
    source.DESKTOP_CONNECTOR_TOKEN,
    source.MIGEL_GATEWAY_TOKEN,
    source.MIGEL_RELAY_GATEWAY_TOKEN,
    source.GATEWAY_TOKEN,
  );
  if (!host || !token) return DEFAULT_GATEWAY_URL;

  const secure = parseBoolean(
    firstText(
      source.MIGEL_GATEWAY_SECURE,
      source.MIGEL_RELAY_SECURE,
      source.MIGEL_PUBLIC_SECURE,
      source.GATEWAY_PUBLIC_SECURE,
      source.PUBLIC_SECURE,
    ),
    true,
  );
  const protocol = secure ? 'wss:' : 'ws:';
  const port = positiveInteger(
    firstText(
      source.MIGEL_GATEWAY_PORT,
      source.MIGEL_RELAY_PORT,
      source.MIGEL_PUBLIC_PORT,
      source.GATEWAY_PUBLIC_PORT,
      source.PUBLIC_PORT,
    ),
    secure ? 443 : 80,
  );
  const url = new URL(`${protocol}//${host}`);
  if (!isDefaultPort(protocol, port)) {
    url.port = String(port);
  }
  url.pathname = normalizePath(firstText(
    source.MIGEL_GATEWAY_PATH,
    source.MIGEL_RELAY_PATH,
    source.MIGEL_PUBLIC_PATH,
    source.GATEWAY_PATH,
    source.PUBLIC_PATH,
  ) || '/gateway');
  url.searchParams.set('role', 'desktop');
  url.searchParams.set('deviceId', firstText(
    source.MIGEL_DESKTOP_DEVICE_ID,
    source.DESKTOP_DEVICE_ID,
    DEFAULT_DESKTOP_DEVICE_ID,
  ));
  url.searchParams.set('token', token);
  return url.toString();
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function parseBoolean(value, fallback) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return fallback;
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  return fallback;
}

function normalizePath(value) {
  const text = normalizeText(value);
  if (!text) return '/gateway';
  return text.startsWith('/') ? text : `/${text}`;
}

function isDefaultPort(protocol, port) {
  return (protocol === 'wss:' && port === 443) || (protocol === 'ws:' && port === 80);
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
