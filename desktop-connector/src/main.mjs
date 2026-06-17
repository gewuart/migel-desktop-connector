import { pathToFileURL } from 'node:url';

import { loadBridgeSnapshot } from './config/bridgeSnapshot.mjs';
import {
  createMigelComponentVersions,
  MIGEL_CONNECTOR_PROTOCOL_VERSION,
  MIGEL_DESKTOP_CONNECTOR_VERSION,
} from './config/componentVersions.mjs';
import { loadDesktopConnectorEnv } from './config/env.mjs';
import { createGatewayWebSocketClient } from './gateway/gatewayClient.mjs';
import { createDesktopE2ECrypto } from './protocol/e2eCrypto.mjs';

export function createDesktopConnectorRuntime({
  env = globalThis.process?.env || {},
  WebSocketClass = globalThis.WebSocket,
  clientFactory = createGatewayWebSocketClient,
  connectorOptions = {},
  publishBridgeSnapshot = true,
  loadBridgeSnapshotImpl = loadBridgeSnapshot,
  now = () => Date.now(),
  logger = console,
  onStateChange,
  onIgnoredFrame,
  onError,
} = {}) {
  const config = loadDesktopConnectorEnv({ env });
  const resolvedConnectorOptions = buildConnectorOptions(config, connectorOptions, { logger });
  const client = clientFactory({
    url: config.gatewayUrl,
    WebSocketClass,
    reconnect: config.reconnect,
    reconnectDelayMs: config.reconnectDelayMs,
    heartbeatMs: config.heartbeatMs,
    connectorOptions: resolvedConnectorOptions,
    onStateChange: (state) => {
      logState(logger, state);
      onStateChange?.(state);
    },
    onOpen: async ({ sendFrame }) => {
      if (!publishBridgeSnapshot) return null;
      return publishGatewayConfigSnapshot({
        config,
        sendFrame,
        loadBridgeSnapshotImpl,
        now,
      });
    },
    onIgnoredFrame: async (ignored) => {
      logIgnoredFrame(logger, ignored);
      if (typeof onIgnoredFrame === 'function') {
        await onIgnoredFrame(ignored);
      }
    },
    onError: (error, context) => {
      logError(logger, error, context);
      if (typeof onError === 'function') {
        return onError(error, context);
      }
      return { handled: false, error, context };
    },
  });

  return {
    config,
    client,
    start() {
      return client.connect();
    },
    stop(code = 1000, reason = 'desktop connector stopping') {
      return client.close(code, reason);
    },
  };
}

export function startDesktopConnector(options = {}) {
  const runtime = createDesktopConnectorRuntime(options);
  runtime.start();
  return runtime;
}

export async function publishGatewayConfigSnapshot({
  config,
  sendFrame,
  loadBridgeSnapshotImpl = loadBridgeSnapshot,
  now = () => Date.now(),
} = {}) {
  if (typeof sendFrame !== 'function') return null;
  const snapshotOptions = compactObject({
    configPath: config?.configPath,
    apiServerUrl: config?.apiServerUrl,
    hermesEnvPath: config?.envPath,
    handshakePath: gatewayPathFromUrl(config?.gatewayUrl),
    e2eEncryption: Boolean(config?.e2eEnabled),
  });
  const selectedModelIds = [config?.modelId].filter(Boolean);
  const snapshot = await loadBridgeSnapshotImpl({
    ...snapshotOptions,
    selectedModelIds,
  });
  return sendFrame({
    type: 'gateway.config.snapshot',
    version: 1,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    components: createMigelComponentVersions().components,
    publishedAtEpochMillis: Number(now()) || Date.now(),
    snapshot,
  });
}

function buildConnectorOptions(config, connectorOptions, {
  logger,
} = {}) {
  const baseCallAgentOptions = compactObject({
    apiServerUrl: config.apiServerUrl,
    apiKey: config.apiKey,
    attachmentBaseUrl: config.attachmentBaseUrl,
    envPath: config.envPath,
    timeoutMs: config.timeoutMs,
    maxFileUploadBytes: config.maxFileUploadBytes,
    maxExtractedTextChars: config.maxExtractedTextChars,
  });
  return {
    agentId: config.agentId,
    modelId: config.modelId,
    logger,
    e2eCrypto: createDesktopE2ECrypto({
      enabled: config.e2eEnabled,
      keyPath: config.e2eKeyPath,
    }),
    ...normalizeObject(connectorOptions),
    callAgent: connectorOptions.callAgent || createDebugPermissionProbeAgent(config),
    callAgentOptions: {
      ...baseCallAgentOptions,
      ...normalizeObject(connectorOptions.callAgentOptions),
    },
  };
}

function createDebugPermissionProbeAgent(config) {
  if (!config?.debugPermissionProbe) return undefined;
  const command = normalizeText(config.debugPermissionProbeCommand) || 'cd ~/Desktop && pwd';
  return async ({ permissionGate }) => {
    if (typeof permissionGate?.requireAllowed !== 'function') {
      throw new Error('Debug permission probe 缺少 permissionGate。');
    }
    await permissionGate.requireAllowed({
      operation: 'command.execute',
      command,
      intent: 'Debug-only probe for Android permission request UI. The command is not executed.',
      requestedBy: 'desktop-connector-debug',
    });
    return {
      content: `权限弹窗链路测试完成：Android 已确认 ${command}。这只是 debug probe，没有执行命令。`,
      done: true,
    };
  };
}

function logState(logger, state) {
  writeLog(logger, 'info', `Desktop Connector gateway state: ${state.status}`);
}

function logIgnoredFrame(logger, ignored) {
  writeLog(logger, 'warn', `Desktop Connector ignored frame: ${ignored.frameType || 'unknown'}`);
}

function logError(logger, error, context = {}) {
  writeLog(logger, 'error', `Desktop Connector error (${context.source || 'unknown'}): ${error.message}`);
}

function writeLog(logger, level, message) {
  const writer = logger?.[level] || logger?.log;
  if (typeof writer === 'function') {
    writer.call(logger, message);
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(normalizeObject(value)).filter(([, item]) => item !== undefined && item !== ''),
  );
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function gatewayPathFromUrl(value) {
  try {
    return new URL(value || '').pathname || '/gateway';
  } catch {
    return '/gateway';
  }
}

function isMainModule(metaUrl, argvPath = globalThis.process?.argv?.[1]) {
  return Boolean(argvPath && metaUrl === pathToFileURL(argvPath).href);
}

if (isMainModule(import.meta.url)) {
  startDesktopConnector();
}
