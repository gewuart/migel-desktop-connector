import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  mkdtemp,
  readFile as readFileAsync,
  rm,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  callHermesChatCompletionsStream,
  DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
} from '../desktop-connector/src/agents/hermesAgent.mjs';
import {
  selectLocalGptImage2Capability,
} from '../desktop-connector/src/agents/gptImage2Agent.mjs';
import {
  createAgentRequest,
  toAgentSessionKey,
} from '../desktop-connector/src/agents/agentTypes.mjs';
import { handleJobCreatedFrame } from '../desktop-connector/src/app/desktopConnector.mjs';
import { loadBridgeSnapshot as loadConnectorBridgeSnapshot } from '../desktop-connector/src/config/bridgeSnapshot.mjs';
import {
  createMigelComponentVersions,
  MIGEL_BRIDGE_VERSION,
  MIGEL_CONNECTOR_PROTOCOL_VERSION,
  MIGEL_DESKTOP_CONNECTOR_VERSION,
} from '../desktop-connector/src/config/componentVersions.mjs';
import {
  canRoutePureTextChatRequest,
  createJobCreatedFrameFromChatRequest,
  createLegacyChatFrameFromJobFrame,
} from '../desktop-connector/src/gateway/chatRequestRouter.mjs';
import { createRemotePermissionConfirmer } from '../desktop-connector/src/permissions/remoteConfirmation.mjs';
import {
  createChatDeltaFrame,
  createChatErrorFrame,
  createChatStatusFrame,
} from '../desktop-connector/src/protocol/frames.mjs';
import {
  isEncryptedFrame,
  isPairingFrame,
  normalizeChatRequest,
} from '../desktop-connector/src/protocol/validation.mjs';
import {
  createTextFrameDecoder,
  encodePongFrame,
  encodeTextFrame,
  WebSocketFrameError,
} from '../desktop-connector/src/protocol/websocketFrames.mjs';
import {
  createPairingInviteStore,
  isLoopbackAddress,
  isPairingInvitePath,
} from '../gateway/src/server/pairingInvites.mjs';

// Legacy CLAWPOST_* / OPENCLAW_* names are accepted only as migration fallbacks.
const HOST = process.env.HERMES_BRIDGE_HOST || process.env.CLAWPOST_HOST || '127.0.0.1';
const PORT = Number(process.env.HERMES_BRIDGE_PORT || process.env.CLAWPOST_PORT || '8443');
const HANDSHAKE_PATH = normalizePath(process.env.HERMES_BRIDGE_PATH || process.env.CLAWPOST_PATH || '/gateway');
const CONNECTOR_PROVIDER = 'domestic';
const PUBLIC_DOMAIN = normalizePublicDomain(process.env.MIGEL_PUBLIC_DOMAIN);
const SUBDOMAIN_PREFIX = normalizeDnsLabel(process.env.MIGEL_SUBDOMAIN_PREFIX) || 'h';
const SUBDOMAIN_ID = normalizeDnsLabel(process.env.MIGEL_SUBDOMAIN_ID || process.env.MIGEL_CONNECTOR_ID);
const BRIDGE_LOCAL_URL = normalizeBaseUrl(process.env.MIGEL_BRIDGE_LOCAL_URL || `http://${HOST}:${PORT}`);
const ADVERTISED_HOST = normalizeText(process.env.HERMES_BRIDGE_ADVERTISED_HOST || process.env.CLAWPOST_ADVERTISED_HOST)
  || advertisedHostFromMigelEnv()
  || legacyAdvertisedHost();
const ADVERTISED_PORT = Number(process.env.HERMES_BRIDGE_ADVERTISED_PORT || process.env.CLAWPOST_ADVERTISED_PORT || '443');
const ADVERTISED_SECURE = parseBoolean(process.env.HERMES_BRIDGE_ADVERTISED_SECURE || process.env.CLAWPOST_ADVERTISED_SECURE, true);
const CONFIG_SNAPSHOT_TOKEN = normalizeText(process.env.HERMES_BRIDGE_CONFIG_TOKEN ?? process.env.CLAWPOST_CONFIG_TOKEN);
const CONFIG_PATH = process.env.HERMES_CONFIG_PATH || process.env.OPENCLAW_CONFIG_PATH || join(homedir(), '.hermes', 'hermes.json');
const HERMES_ENV_PATH = process.env.HERMES_ENV_PATH || join(homedir(), '.hermes', '.env');
const API_SERVER_URL = normalizeApiServerUrl(process.env.HERMES_API_SERVER_URL || process.env.API_SERVER_URL || 'http://127.0.0.1:8642');
const API_SERVER_TIMEOUT_MS = Number(process.env.HERMES_API_SERVER_TIMEOUT_MS || '300000');
const API_SERVER_STREAMING = parseBoolean(process.env.HERMES_API_SERVER_STREAMING || 'false', false);
const API_SERVER_RUNS_ENABLED = parseBoolean(process.env.HERMES_API_SERVER_RUNS_ENABLED || 'true', true);
const STREAM_KEEPALIVE_MS = Number(process.env.HERMES_BRIDGE_STREAM_KEEPALIVE_MS || '30000');
const ACCOUNT_API_BASE_URL = normalizeBaseUrl(process.env.HERMES_ACCOUNT_API_BASE_URL || process.env.MIGEL_ACCOUNT_API_BASE_URL);
const REDEEM_CODES = new Set(
  (process.env.HERMES_BRIDGE_CODES ?? process.env.CLAWPOST_CODES ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean),
);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const COMPONENT_VERSIONS = createMigelComponentVersions();
const sessionModelSelections = new Map();
const STRUCTURED_FORWARDING_ENABLED = parseBoolean(process.env.HERMES_BRIDGE_STRUCTURED_FORWARDING || 'true', true);
const MAX_IMAGE_INLINE_BYTES = positiveInteger(
  process.env.HERMES_BRIDGE_MAX_IMAGE_INLINE_BYTES || process.env.HERMES_BRIDGE_MAX_INLINE_ATTACHMENT_BYTES,
  1048576,
);
const MAX_FILE_UPLOAD_BYTES = positiveInteger(process.env.HERMES_BRIDGE_MAX_FILE_UPLOAD_BYTES, 4194304);
const MAX_IMAGE_RECEIVE_BYTES = positiveInteger(process.env.HERMES_BRIDGE_MAX_IMAGE_RECEIVE_BYTES, 20 * 1024 * 1024);
const MAX_NORMALIZED_IMAGE_BYTES = positiveInteger(process.env.HERMES_BRIDGE_MAX_NORMALIZED_IMAGE_BYTES, MAX_IMAGE_INLINE_BYTES);
const MAX_IMAGE_EDGE = Number(process.env.HERMES_BRIDGE_MAX_IMAGE_EDGE || '1920');
const IMAGE_JPEG_QUALITY = clampInteger(process.env.HERMES_BRIDGE_IMAGE_JPEG_QUALITY || '82', 40, 95, 82);
const IMAGE_WEBP_QUALITY = clampInteger(process.env.HERMES_BRIDGE_IMAGE_WEBP_QUALITY || '82', 40, 95, 82);
const IMAGE_NORMALIZE_FORMAT = normalizeImageOutputFormat(process.env.HERMES_BRIDGE_IMAGE_OUTPUT_FORMAT || 'jpeg');
const IMAGE_NORMALIZER_BIN = process.env.HERMES_BRIDGE_IMAGE_NORMALIZER_BIN || '/usr/bin/sips';
const MAX_OUTPUT_INLINE_BYTES = positiveInteger(process.env.HERMES_BRIDGE_MAX_OUTPUT_INLINE_BYTES, MAX_IMAGE_INLINE_BYTES);
const MAX_OUTPUT_UPLOAD_BYTES = positiveInteger(process.env.HERMES_BRIDGE_MAX_OUTPUT_UPLOAD_BYTES, 20 * 1024 * 1024);
const MAX_EXTRACTED_TEXT_CHARS = positiveInteger(process.env.HERMES_BRIDGE_MAX_EXTRACTED_TEXT_CHARS, 60000);
const MAX_ATTACHMENTS = clampInteger(process.env.HERMES_BRIDGE_MAX_ATTACHMENTS || '6', 1, 12, 6);
const MAX_WEBSOCKET_MESSAGE_BYTES = positiveInteger(
  process.env.HERMES_BRIDGE_MAX_WEBSOCKET_MESSAGE_BYTES || process.env.HERMES_BRIDGE_MAX_WS_FRAME_BYTES,
  Math.max(64 * 1024 * 1024, Math.ceil(MAX_IMAGE_RECEIVE_BYTES * 2.25) + (2 * 1024 * 1024)),
);
const MAX_WEBSOCKET_BUFFER_BYTES = positiveInteger(
  process.env.HERMES_BRIDGE_MAX_WEBSOCKET_BUFFER_BYTES,
  MAX_WEBSOCKET_MESSAGE_BYTES + (1024 * 1024),
);
const MAX_QUEUED_SOCKET_MESSAGES = clampInteger(
  process.env.HERMES_BRIDGE_MAX_QUEUED_SOCKET_MESSAGES || '4',
  1,
  16,
  4,
);
const SOCKET_IDLE_TIMEOUT_MS = positiveInteger(
  process.env.HERMES_BRIDGE_SOCKET_IDLE_TIMEOUT_MS || '900000',
  900000,
);
const SUPPORTED_TEXT_FILE_EXTENSIONS = DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS;
const SUPPORTED_TEXT_FILE_MIME_TYPES = new Set(DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES);
const E2E_PUBLIC_KEY_BYTES = 32;
const E2E_PRIVATE_KEY_BYTES = 32;
const E2E_NONCE_BYTES = 24;
const SECRETBOX_ZEROBYTES = 32;
const POLY1305_KEY_BYTES = 32;
const POLY1305_TAG_BYTES = 16;
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SIGMA_WORDS = [
  0x61707865,
  0x3320646e,
  0x79622d32,
  0x6b206574,
];
const E2E_ENABLED = parseBoolean(process.env.HERMES_BRIDGE_E2E || 'true', true);
const E2E_KEY_PATH = process.env.HERMES_BRIDGE_E2E_KEY_PATH || join(homedir(), '.hermes', 'bridge-e2e-key.json');
const BRIDGE_E2E_KEY_PAIR = E2E_ENABLED ? loadOrCreateBridgeE2eKeyPair() : null;
const PAIRING_TTL_MS = positiveInteger(process.env.HERMES_BRIDGE_PAIRING_TTL_MS || process.env.MIGEL_PAIRING_TTL_MS, 10 * 60 * 1000);
const PAIRING_STATE_PATH = normalizeText(process.env.HERMES_BRIDGE_PAIRING_STATE_PATH || process.env.MIGEL_PAIRING_STATE_PATH)
  || join(homedir(), '.hermes', 'bridge-pairing-devices.json');
const PAIRING_ADMIN_TOKEN = normalizeText(process.env.HERMES_BRIDGE_PAIRING_ADMIN_TOKEN || process.env.MIGEL_PAIRING_ADMIN_TOKEN);
const REQUIRE_DEVICE_TOKEN = parseBoolean(process.env.HERMES_BRIDGE_REQUIRE_DEVICE_TOKEN || 'false', false);
const pairingInvites = createPairingInviteStore({
  ttlMillis: PAIRING_TTL_MS,
  statePath: PAIRING_STATE_PATH,
  logger: console,
});
const execFileAsync = promisify(execFile);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'POST' && isPairingInvitePath(url.pathname)) {
    await handlePairingInvite(req, res, url);
    return;
  }

  if (req.method === 'POST' && isRedeemPath(url.pathname)) {
    await handleRedeem(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    await handleHealth(res);
    return;
  }

  if (req.method === 'GET' && isConfigSnapshotPath(url.pathname)) {
    await handleConfigSnapshot(req, res, url);
    return;
  }

  respondJson(res, 404, {
    error: 'not_found',
    message: `No route for ${req.method} ${url.pathname}`,
  });
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname !== HANDSHAKE_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const deviceToken = gatewayAuthTokenFromRequest(req, url);
  if ((REQUIRE_DEVICE_TOKEN || deviceToken) && !pairingInvites.verifyDeviceToken(deviceToken)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key || Array.isArray(key)) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );

  const cryptoState = createSocketCryptoState();
  cryptoState.permissionConfirmer = createRemotePermissionConfirmer({
    sendFrame: async (frame) => emitBridgeFrame(socket, frame, cryptoState),
  });
  socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);

  const frameDecoder = createTextFrameDecoder({
    maxMessageBytes: MAX_WEBSOCKET_MESSAGE_BYTES,
    maxBufferedBytes: MAX_WEBSOCKET_BUFFER_BYTES,
    requireMasked: true,
    onControlFrame: (frame) => {
      if (frame.type === 'ping' && socket.writable && !socket.destroyed) {
        socket.write(encodePongFrame(frame.payload));
        return;
      }
      if (frame.type === 'close') {
        socket.destroy();
      }
    },
  });
  let requestQueue = Promise.resolve();
  let queuedSocketMessages = 0;
  socket.on('data', (chunk) => {
    let messages = [];
    try {
      messages = frameDecoder.push(chunk);
    } catch (error) {
      handleSocketProtocolError(socket, error, cryptoState);
      return;
    }
    if (socket.destroyed) return;

    for (const message of messages) {
      let framePayload = null;
      try {
        framePayload = parseSocketMessagePayload(message, cryptoState);
      } catch (error) {
        emitSocketChatError(socket, error, cryptoState);
        socket.destroy();
        return;
      }

      if (framePayload.permissionDecision) {
        Promise.resolve(handlePermissionDecisionFrame(framePayload.permissionDecision, cryptoState))
          .catch((error) => {
            console.warn(`Hermes bridge failed to handle permission decision: ${sanitizeErrorMessage(error)}`);
          });
        continue;
      }

      if (queuedSocketMessages >= MAX_QUEUED_SOCKET_MESSAGES) {
        emitSocketChatError(
          socket,
          `Hermes Migel Bridge 正在处理前一个请求，已拒绝超过 ${MAX_QUEUED_SOCKET_MESSAGES} 条的排队消息。`,
          cryptoState,
        );
        socket.destroy();
        return;
      }

      queuedSocketMessages += 1;
      requestQueue = requestQueue
        .then(() => handleSocketChatPayload(socket, framePayload, cryptoState))
        .catch((error) => {
          emitSocketChatError(socket, error, cryptoState);
        })
        .finally(() => {
          queuedSocketMessages = Math.max(0, queuedSocketMessages - 1);
        });
    }
  });

  socket.on('timeout', () => {
    emitSocketChatError(socket, 'Hermes Migel Bridge WebSocket 连接空闲超时，已断开。', cryptoState);
    socket.destroy();
  });

  socket.on('error', () => {
    socket.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Hermes bridge listening on http://${HOST}:${PORT}`);
  console.log(`Redeem paths: /pairing/redeem, /api/pairing/redeem, /api/v1/pairing/redeem`);
  console.log(`Config snapshot: /config/snapshot`);
  console.log(`WebSocket path: ${HANDSHAKE_PATH}`);
});

async function handleSocketChatPayload(socket, framePayload, cryptoState) {
  const payload = framePayload?.payload || {};
  const encrypted = Boolean(framePayload?.encrypted);

  if (isPairingFrame(payload)) {
    handlePairingFrame(socket, payload, cryptoState);
    return;
  }

  if (isPermissionDecisionFrame(payload)) {
    await handlePermissionDecisionFrame(payload, cryptoState);
    return;
  }

  if (!encrypted && E2E_ENABLED) {
    emitBridgeFrame(socket, createChatErrorFrame({
      message: 'Hermes Migel Bridge 已启用端到端加密，但收到的是明文聊天请求。',
    }), cryptoState);
    return;
  }

  const request = await normalizeBridgeRequestImages(normalizeChatRequest(payload, {
    maxAttachments: MAX_ATTACHMENTS,
    maxImageInlineBytes: Math.max(MAX_IMAGE_INLINE_BYTES, MAX_IMAGE_RECEIVE_BYTES),
    maxFileUploadBytes: MAX_FILE_UPLOAD_BYTES,
  }));
  const sessionId = request.sessionId || `android-${randomUUID().slice(0, 8)}`;
  const modelId = request.modelId;
  const content = request.text;

  if (!content) {
    emitBridgeFrame(socket, createChatErrorFrame({
      sessionId,
      message: 'Hermes Migel Bridge 没有收到可发送到智能体的文本内容。',
    }), cryptoState);
    return;
  }

  const sessionKey = toAgentSessionKey(sessionId);
  if (modelId) {
    sessionModelSelections.set(sessionKey, modelId);
  }

  const selectedModelId = sessionModelSelections.get(sessionKey) || modelId;

  const structuredForwardingCandidate = {
      ...payload,
      content,
      attachments: request.attachments,
      modelId: selectedModelId,
    };
  const shouldUseStructuredForwarding = STRUCTURED_FORWARDING_ENABLED
    && canRouteStructuredChatRequest(structuredForwardingCandidate);

  if (shouldUseStructuredForwarding) {
    await handleStructuredChatRequest({
      socket,
      cryptoState,
      payload,
      request,
      sessionId,
      modelId: selectedModelId,
    });
    return;
  }

  const agentRequest = createAgentRequest({
    request,
    sessionId,
    sessionKey,
    modelId: selectedModelId,
  });

  emitBridgeFrame(socket, createChatStatusFrame({
    sessionId,
    phase: 'queued',
    message: '消息已送达 bridge，正在请求 Hermes API Server。',
  }), cryptoState);

  let lastStreamOutputAt = Date.now();
  let streamedContent = '';
  let responseImages = [];
  let responseModel = agentRequest.modelId;
  const keepalive = setInterval(() => {
    if (Date.now() - lastStreamOutputAt < STREAM_KEEPALIVE_MS) return;
    emitBridgeFrame(socket, createChatStatusFrame({
      sessionId,
      phase: 'streaming',
      message: 'Hermes API Server 仍在处理，等待模型输出。',
    }), cryptoState);
    lastStreamOutputAt = Date.now();
  }, STREAM_KEEPALIVE_MS);
  keepalive.unref?.();

  try {
    const completion = await callHermesChatCompletionsStream({
      agentRequest,
      apiServerUrl: API_SERVER_URL,
      envPath: HERMES_ENV_PATH,
      timeoutMs: API_SERVER_TIMEOUT_MS,
      stream: API_SERVER_STREAMING,
      maxFileUploadBytes: MAX_FILE_UPLOAD_BYTES,
      maxExtractedTextChars: MAX_EXTRACTED_TEXT_CHARS,
      supportedTextFileExtensions: SUPPORTED_TEXT_FILE_EXTENSIONS,
      supportedTextFileMimeTypes: SUPPORTED_TEXT_FILE_MIME_TYPES,
      onDelta: ({ delta, content: nextContent, model, images = [] }) => {
        if (model) responseModel = model;
        streamedContent = nextContent;
        responseImages = images;
        lastStreamOutputAt = Date.now();
        emitBridgeFrame(socket, createChatDeltaFrame({
          sessionId,
          delta,
          content: streamedContent,
          images: bridgeStreamImages(responseImages),
          done: false,
          model: responseModel,
        }), cryptoState);
      },
    });
    streamedContent = streamedContent || completion.content;
    responseModel = completion.model || responseModel;
    responseImages = completion.images || responseImages;
  } finally {
    clearInterval(keepalive);
  }

  if (!streamedContent && responseImages.length === 0) {
    throw new Error('Hermes API Server 没有返回可展示的助手文本或图片。');
  }

  responseImages = await prepareBridgeOutputImages(responseImages, {
    payload,
    sessionId,
    socket,
    cryptoState,
  });
  if (!streamedContent && responseImages.length === 0) {
    throw new Error('Hermes API Server 返回了图片结构，但 bridge 未能得到可展示的 URL 或小图 inline 数据。');
  }

  emitBridgeFrame(socket, createChatDeltaFrame({
    sessionId,
    delta: '',
    content: streamedContent,
    images: responseImages,
    done: true,
    model: responseModel,
  }), cryptoState);
}

async function handleStructuredChatRequest({
  socket,
  cryptoState,
  payload,
  request,
  sessionId,
  modelId,
}) {
  const jobFrame = createJobCreatedFrameFromChatRequest({
    ...payload,
    requestId: normalizeText(payload?.requestId) || `req-${randomUUID()}`,
    conversationId: sessionId,
    fromDeviceId: normalizeText(payload?.client) || 'migel-android',
    content: request.text,
    attachments: request.attachments,
    modelId,
  }, {
    jobId: `job-${randomUUID()}`,
  });

  let lastStreamOutputAt = Date.now();
  const keepalive = setInterval(() => {
    if (Date.now() - lastStreamOutputAt < STREAM_KEEPALIVE_MS) return;
    emitBridgeFrame(socket, createChatStatusFrame({
      sessionId,
      phase: 'streaming',
      message: 'Desktop Connector 仍在处理，等待模型输出。',
    }), cryptoState);
    lastStreamOutputAt = Date.now();
  }, STREAM_KEEPALIVE_MS);
  keepalive.unref?.();

  try {
    await handleJobCreatedFrame(jobFrame, {
      agentId: 'hermes',
      modelId,
      callAgentOptions: {
        apiServerUrl: API_SERVER_URL,
        envPath: HERMES_ENV_PATH,
        timeoutMs: API_SERVER_TIMEOUT_MS,
        stream: API_SERVER_STREAMING,
        useRunsApi: API_SERVER_RUNS_ENABLED,
        maxFileUploadBytes: MAX_FILE_UPLOAD_BYTES,
        maxExtractedTextChars: MAX_EXTRACTED_TEXT_CHARS,
        supportedTextFileExtensions: SUPPORTED_TEXT_FILE_EXTENSIONS,
        supportedTextFileMimeTypes: SUPPORTED_TEXT_FILE_MIME_TYPES,
      },
      confirmPermission: cryptoState.permissionConfirmer?.confirm,
      logger: console,
      onAgentDelta: ({ delta, content, model, images = [] }) => {
        lastStreamOutputAt = Date.now();
        emitBridgeFrame(socket, createChatDeltaFrame({
          sessionId,
          delta,
          content,
          images,
          done: false,
          model: model || modelId,
          gateway: 'Desktop Connector',
        }), cryptoState);
      },
      emitFrame: async (frame) => {
        const legacyFrame = createLegacyChatFrameFromJobFrame(frame, {
          sessionId,
        });
        if (legacyFrame) {
          lastStreamOutputAt = Date.now();
          logStructuredBridgeFrame(frame, legacyFrame);
          emitBridgeFrame(socket, legacyFrame, cryptoState);
        }
      },
    });
  } finally {
    clearInterval(keepalive);
  }
}

function canRouteStructuredChatRequest(chatRequest) {
  if (canRoutePureTextChatRequest(chatRequest)) return true;
  return Boolean(selectLocalGptImage2Capability(chatRequest));
}

function logStructuredBridgeFrame(frame, legacyFrame) {
  const frameType = normalizeText(frame?.type) || 'unknown';
  const legacyType = normalizeText(legacyFrame?.type) || 'unknown';
  const images = Array.isArray(legacyFrame?.images) ? legacyFrame.images : [];
  console.log(`Structured bridge frame type=${frameType} legacy=${legacyType} done=${legacyFrame?.done === true} images=${images.length} firstImage=${debugBridgeImageSummary(images[0])}`);
}

function debugBridgeImageSummary(image) {
  if (!image || typeof image !== 'object') return 'none';
  return JSON.stringify({
    mimeType: normalizeText(image.mimeType || image.mime_type),
    hasUrl: Boolean(normalizeText(image.url || image.remoteUrl)),
    hasData: Boolean(normalizeText(image.dataBase64 || image.b64_json)),
    objectKey: normalizeText(image.objectKey || image.object_key).slice(0, 96),
  });
}

async function handlePairingInvite(req, res, url) {
  if (!isAuthorizedPairingInviteRequest(req, url)) {
    respondJson(res, 403, {
      ok: false,
      error: 'pairing_invite_forbidden',
      message: '只能在本机终端创建临时配对邀请。',
    });
    return;
  }
  const body = await readBody(req);
  const payload = parseJson(body);
  const configSummary = await loadBridgeSnapshot().catch(() => null);
  const invite = pairingInvites.createInvite({
    host: normalizeText(payload?.host) || ADVERTISED_HOST,
    port: positiveInteger(payload?.port, ADVERTISED_PORT),
    secure: parseBoolean(payload?.secure, ADVERTISED_SECURE),
    path: normalizePath(payload?.path || HANDSHAKE_PATH),
    name: normalizeText(payload?.name) || configSummary?.nodeName || 'Hermes 本地节点',
    bridge: normalizeText(payload?.bridge) || 'Hermes Migel Bridge',
    nodeId: normalizeText(payload?.nodeId) || configSummary?.nodeId || 'hermes-local',
    source: normalizeText(payload?.source) || 'HermesMigelBridge',
    bridgePublicKey: normalizeText(payload?.bridgePublicKey || payload?.publicKey || payload?.pubkey) || bridgePublicKeyBase64(),
    ttlMillis: positiveInteger(payload?.ttlMillis, PAIRING_TTL_MS),
  });
  respondJson(res, 201, {
    ok: true,
    ...invite,
  });
}

async function handleRedeem(req, res) {
  const body = await readBody(req);
  const payload = parseJson(body);
  const redeemed = pairingInvites.redeem({
    inviteId: payload?.inviteId,
    code: payload?.code,
    client: payload?.client,
    platform: payload?.platform,
    deviceId: payload?.deviceId,
  });
  if (redeemed.ok) {
    respondJson(res, 200, pairingRedeemPayload({
      invite: redeemed.invite,
      deviceToken: redeemed.deviceToken,
      deviceTokenId: redeemed.deviceTokenId,
    }));
    return;
  }

  const code = normalizeText(payload?.code).toUpperCase();
  if (!REDEEM_CODES.has(code)) {
    respondJson(res, 400, {
      ok: false,
      error: redeemed.error || 'invalid_code',
      message: redeemed.message || '连接码无效，请确认 bridge 控制台中的展示内容。',
    });
    return;
  }

  const configSummary = await loadBridgeSnapshot().catch(() => null);
  respondJson(res, 200, {
    host: ADVERTISED_HOST,
    port: ADVERTISED_PORT,
    secure: ADVERTISED_SECURE,
    code,
    name: configSummary?.nodeName || 'Hermes 本地节点',
    sourceApp: 'HermesMigelBridge',
    bridgeLabel: 'Hermes Migel Bridge',
    bridgeVersion: MIGEL_BRIDGE_VERSION,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    components: COMPONENT_VERSIONS.components,
    nodeId: configSummary?.nodeId || 'hermes-local',
    handshakePath: HANDSHAKE_PATH,
    path: HANDSHAKE_PATH,
    publicKey: bridgePublicKeyBase64(),
    bridgePublicKey: bridgePublicKeyBase64(),
    capabilities: bridgeCapabilities(),
  });
}

function pairingRedeemPayload({
  invite,
  deviceToken,
  deviceTokenId,
}) {
  return {
    ok: true,
    host: invite.host,
    port: invite.port,
    secure: invite.secure,
    inviteId: invite.inviteId,
    code: invite.code,
    bootstrapCode: invite.code,
    name: invite.name || 'Hermes 本地节点',
    displayName: invite.name || 'Hermes 本地节点',
    sourceApp: invite.source || 'HermesMigelBridge',
    source: invite.source || 'HermesMigelBridge',
    bridgeLabel: invite.bridge || 'Hermes Migel Bridge',
    bridge: invite.bridge || 'Hermes Migel Bridge',
    bridgeVersion: MIGEL_BRIDGE_VERSION,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    components: COMPONENT_VERSIONS.components,
    nodeId: invite.nodeId || 'hermes-local',
    handshakePath: invite.path || HANDSHAKE_PATH,
    path: invite.path || HANDSHAKE_PATH,
    publicKey: invite.bridgePublicKey || bridgePublicKeyBase64(),
    bridgePublicKey: invite.bridgePublicKey || bridgePublicKeyBase64(),
    deviceToken,
    deviceTokenId,
    expiresAtEpochMillis: invite.expiresAtEpochMillis,
    gateway: {
      host: invite.host,
      port: invite.port,
      secure: invite.secure,
      path: invite.path || HANDSHAKE_PATH,
    },
    capabilities: bridgeCapabilities(),
  };
}

function isConfigSnapshotPath(pathname) {
  if (pathname === '/config/snapshot') return true;
  return pathname === `${HANDSHAKE_PATH}/config/snapshot`;
}

async function handleHealth(res) {
  try {
    const snapshot = await loadBridgeSnapshot();
    respondJson(res, 200, {
      ok: true,
      bridge: 'Hermes Migel Bridge',
      version: MIGEL_BRIDGE_VERSION,
      bridgeVersion: MIGEL_BRIDGE_VERSION,
      desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
      connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
      components: COMPONENT_VERSIONS.components,
      capabilities: bridgeCapabilities(),
      gatewayPath: HANDSHAKE_PATH,
      pairing: pairingInvites.snapshot(),
      gateway: snapshot.gateway,
      nodeName: snapshot.nodeName,
      modelCount: snapshot.models.length,
      publicKey: bridgePublicKeyBase64(),
      bridgePublicKey: bridgePublicKeyBase64(),
      advertisedEndpoint: {
        host: ADVERTISED_HOST,
        port: ADVERTISED_PORT,
        secure: ADVERTISED_SECURE,
        path: HANDSHAKE_PATH,
      },
      connector: {
        provider: CONNECTOR_PROVIDER,
        bridgeLocalUrl: BRIDGE_LOCAL_URL,
      },
    });
  } catch (error) {
    respondJson(res, 503, {
      ok: false,
      bridge: 'Hermes Migel Bridge',
      message: sanitizeErrorMessage(error),
    });
  }
}

async function handleConfigSnapshot(req, res, url) {
  try {
    const snapshot = await loadBridgeSnapshot();
    const activeSessionId = normalizeText(url.searchParams.get('activeSessionId'));
    if (!isAuthorizedConfigSnapshotRequest(req, url)) {
      respondJson(res, 200, buildPublicConfigSnapshot(snapshot, activeSessionId));
      return;
    }

    respondJson(res, 200, {
      origin: snapshot.origin,
      bridgeName: 'Hermes Migel Bridge',
      bridgeVersion: MIGEL_BRIDGE_VERSION,
      desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
      connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
      components: COMPONENT_VERSIONS.components,
      endpointHost: ADVERTISED_HOST,
      endpointPort: ADVERTISED_PORT,
      secure: ADVERTISED_SECURE,
      configFingerprint: snapshot.configFingerprint,
      configuredSessionId: snapshot.configuredSessionId,
      activeSessionId: activeSessionId || snapshot.activeSessionId || null,
      extractedAtEpochMillis: Date.now(),
      models: snapshot.models,
      skills: snapshot.skills,
      capabilities: bridgeCapabilities(),
      configSummary: snapshot.configSummary,
      sessionPolicy: snapshot.sessionPolicy,
      redacted: false,
    });
  } catch (error) {
    respondJson(res, 503, {
      error: 'config_unavailable',
      message: sanitizeErrorMessage(error),
    });
  }
}

function buildPublicConfigSnapshot(snapshot, activeSessionId) {
  return {
    origin: snapshot.origin,
    bridgeName: 'Hermes Migel Bridge',
    bridgeVersion: MIGEL_BRIDGE_VERSION,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    components: COMPONENT_VERSIONS.components,
    endpointHost: ADVERTISED_HOST,
    endpointPort: ADVERTISED_PORT,
    secure: ADVERTISED_SECURE,
    configFingerprint: safeConfigFingerprint(snapshot.configFingerprint),
    configuredSessionId: snapshot.configuredSessionId,
    activeSessionId: activeSessionId || snapshot.activeSessionId || null,
    extractedAtEpochMillis: Date.now(),
    modelCount: Array.isArray(snapshot.models) ? snapshot.models.length : 0,
    skillCount: Array.isArray(snapshot.skills) ? snapshot.skills.length : 0,
    capabilities: bridgeCapabilities(),
    sessionPolicy: snapshot.sessionPolicy,
    gateway: {
      status: normalizeText(snapshot.gateway?.status) || 'unknown',
      authMode: normalizeText(snapshot.gateway?.authMode) || 'bearer',
    },
    redacted: true,
    fullSnapshotRequiresToken: true,
  };
}

function safeConfigFingerprint(value) {
  const text = normalizeText(value);
  return text ? `sha256:${sha256Hex(Buffer.from(text, 'utf8'))}` : '';
}

function isAuthorizedConfigSnapshotRequest(req, url) {
  const token = gatewayAuthTokenFromRequest(req, url);
  if (!token) return false;
  if (CONFIG_SNAPSHOT_TOKEN && token === CONFIG_SNAPSHOT_TOKEN) return true;
  return pairingInvites.verifyDeviceToken(token);
}

function isAuthorizedPairingInviteRequest(req, url) {
  if (isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackAddress(requestHostName(req))) {
    return true;
  }
  if (!PAIRING_ADMIN_TOKEN) return false;
  const headers = createHeaderReader(req.headers);
  const token = normalizeText(url.searchParams.get('token'))
    || normalizeBearer(headers.get('authorization'))
    || normalizeText(headers.get('x-pairing-admin-token'))
    || normalizeText(headers.get('x-hermes-bridge-token'));
  return token === PAIRING_ADMIN_TOKEN;
}

function gatewayAuthTokenFromRequest(req, url) {
  const headers = createHeaderReader(req.headers);
  return normalizeText(url.searchParams.get('deviceToken'))
    || normalizeText(url.searchParams.get('device_token'))
    || normalizeText(url.searchParams.get('authToken'))
    || normalizeText(url.searchParams.get('auth_token'))
    || normalizeText(url.searchParams.get('token'))
    || normalizeBearer(headers.get('authorization'))
    || normalizeText(headers.get('x-hermes-bridge-token'))
    || normalizeText(headers.get('x-gateway-token'));
}

function requestHostName(req) {
  const value = normalizeText(req.headers?.host);
  if (!value) return '';
  if (value.startsWith('[')) {
    const closingIndex = value.indexOf(']');
    return closingIndex > 0 ? value.slice(1, closingIndex) : value;
  }
  return value.split(':')[0];
}

function createHeaderReader(headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : value,
    ]),
  );
  return {
    get(name) {
      return normalizedHeaders.get(name.toLowerCase()) || '';
    },
  };
}

function normalizeBearer(value) {
  const normalized = normalizeText(value);
  if (!normalized.toLowerCase().startsWith('bearer ')) return '';
  return normalized.slice('bearer '.length).trim();
}

async function loadBridgeSnapshot() {
  return loadConnectorBridgeSnapshot({
    configPath: CONFIG_PATH,
    apiServerUrl: API_SERVER_URL,
    hermesEnvPath: HERMES_ENV_PATH,
    handshakePath: HANDSHAKE_PATH,
    selectedModelIds: Array.from(sessionModelSelections.values()),
  });
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function bridgeCapabilities() {
  return {
    version: MIGEL_BRIDGE_VERSION,
    bridgeVersion: MIGEL_BRIDGE_VERSION,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    text: true,
    image: true,
    imageNative: true,
    file: true,
    fileTextExtraction: true,
    inlineAttachments: true,
    remoteAttachments: true,
    maxInlineBytes: MAX_IMAGE_INLINE_BYTES,
    maxImageInlineBytes: MAX_IMAGE_INLINE_BYTES,
    maxImageReceiveBytes: MAX_IMAGE_RECEIVE_BYTES,
    maxNormalizedImageBytes: MAX_NORMALIZED_IMAGE_BYTES,
    maxImageEdge: MAX_IMAGE_EDGE,
    imageOutputFormat: IMAGE_NORMALIZE_FORMAT,
    imageJpegQuality: IMAGE_JPEG_QUALITY,
    imageWebpQuality: IMAGE_WEBP_QUALITY,
    maxFileUploadBytes: MAX_FILE_UPLOAD_BYTES,
    maxOutputInlineBytes: MAX_OUTPUT_INLINE_BYTES,
    maxOutputUploadBytes: MAX_OUTPUT_UPLOAD_BYTES,
    maxExtractedTextChars: MAX_EXTRACTED_TEXT_CHARS,
    maxAttachments: MAX_ATTACHMENTS,
    maxWebSocketMessageBytes: MAX_WEBSOCKET_MESSAGE_BYTES,
    maxWebSocketBufferBytes: MAX_WEBSOCKET_BUFFER_BYTES,
    maxQueuedSocketMessages: MAX_QUEUED_SOCKET_MESSAGES,
    socketIdleTimeoutMs: SOCKET_IDLE_TIMEOUT_MS,
    requireMaskedWebSocketFrames: true,
    supportedFileMimeTypes: Array.from(SUPPORTED_TEXT_FILE_MIME_TYPES),
    supportedFileExtensions: SUPPORTED_TEXT_FILE_EXTENSIONS,
    uploadEndpoint: null,
    ossOutputUpload: true,
    ossPurposes: {
      input: 'hermes_bridge_input',
      output: 'hermes_bridge_output',
      editInput: 'hermes_bridge_edit_input',
      temp: 'hermes_bridge_temp',
    },
    e2eEncryption: E2E_ENABLED,
    structuredForwarding: true,
    apiServer: true,
  };
}

function sanitizeErrorMessage(error) {
  return String(error?.message || error || '未知错误')
    .replace(/--token\s+\S+/g, '--token [redacted]')
    .replace(/[A-Fa-f0-9]{32,}/g, '[redacted]');
}

function normalizePath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '/gateway';
  return value.startsWith('/') ? value : `/${value}`;
}

function normalizeApiServerUrl(raw) {
  const value = String(raw || '').trim() || 'http://127.0.0.1:8642';
  return value.replace(/\/+$/g, '');
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/g, '');
}

function normalizePublicDomain(raw) {
  const domain = normalizeText(raw).toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!domain || domain.includes('/') || domain.includes(':')) return '';
  return domain;
}

function normalizeDnsLabel(raw) {
  return normalizeText(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function advertisedHostFromMigelEnv() {
  const publicHost = normalizePublicDomain(process.env.MIGEL_PUBLIC_HOST || process.env.MIGEL_CONNECTOR_HOST);
  if (publicHost) return publicHost;
  if (PUBLIC_DOMAIN && SUBDOMAIN_ID) {
    return `${SUBDOMAIN_PREFIX}-${SUBDOMAIN_ID}.${PUBLIC_DOMAIN}`;
  }
  return '';
}

function legacyAdvertisedHost() {
  return 'relay.gewuyishu.cn';
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function isRedeemPath(pathname) {
  return pathname === '/pairing/redeem'
    || pathname === '/api/pairing/redeem'
    || pathname === '/api/v1/pairing/redeem';
}

function respondJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function createSocketCryptoState() {
  return {
    clientPublicKey: null,
    sharedKey: null,
    permissionConfirmer: null,
  };
}

async function handlePermissionDecisionFrame(payload, cryptoState) {
  const result = await cryptoState?.permissionConfirmer?.handleDecision?.(payload);
  if (result?.handled === false) {
    console.warn(`Hermes bridge ignored permission decision: ${result.reason || 'unmatched'}`);
  }
  return result;
}

function isPermissionDecisionFrame(payload) {
  return normalizeText(payload?.type).toLowerCase() === 'permission.decision';
}

function parseSocketMessagePayload(message, cryptoState) {
  let payload = {};
  try {
    payload = JSON.parse(message);
  } catch {
    payload = { content: message };
  }

  const encryptedFrame = encryptedPayloadFromContainer(payload);
  if (!encryptedFrame) {
    return {
      encrypted: false,
      payload,
      permissionDecision: isPermissionDecisionFrame(payload) ? payload : null,
    };
  }

  const decrypted = decryptClientPayload(encryptedFrame, cryptoState);
  return {
    encrypted: true,
    payload: decrypted,
    permissionDecision: isPermissionDecisionFrame(decrypted) ? decrypted : null,
  };
}

function encryptedPayloadFromContainer(container) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
  if (isEncryptedFrame(container)) return container;
  if (isEncryptedFrame(container.encrypted)) return container.encrypted;
  if (container.e2e && typeof container.e2e === 'object' && isEncryptedFrame(container.e2e.encrypted)) {
    return container.e2e.encrypted;
  }
  return null;
}

function emitSocketChatError(socket, error, cryptoState) {
  try {
    emitBridgeFrame(socket, createChatErrorFrame({
      message: typeof error === 'string' ? error : sanitizeErrorMessage(error),
    }), cryptoState);
  } catch {
    socket.destroy();
  }
}

function handleSocketProtocolError(socket, error, cryptoState) {
  const protocolError = error instanceof WebSocketFrameError;
  const message = protocolError
    ? `Hermes Migel Bridge WebSocket 帧异常：${sanitizeErrorMessage(error)}`
    : sanitizeErrorMessage(error);
  console.warn(`Hermes bridge socket protocol error: ${message}`);
  emitSocketChatError(socket, message, cryptoState);
  socket.destroy();
}

function handlePairingFrame(socket, payload, cryptoState) {
  if (!E2E_ENABLED || !BRIDGE_E2E_KEY_PAIR) {
    emitPlainBridgeFrame(socket, {
      type: 'pairing_ack',
      e2e: false,
      message: 'Hermes Migel Bridge 当前未启用端到端加密。',
      bridge: 'Hermes Migel Bridge',
    });
    return;
  }

  const publicKeyBase64 = normalizeText(payload?.publicKey)
    || normalizeText(payload?.clientPublicKey)
    || normalizeText(payload?.pubkey);
  const clientPublicKey = decodeBase64Bytes(publicKeyBase64, E2E_PUBLIC_KEY_BYTES);
  if (!clientPublicKey) {
    emitPlainBridgeFrame(socket, createChatErrorFrame({
      message: 'Hermes Migel Bridge 没有收到有效的客户端 E2E 公钥。',
    }));
    return;
  }

  cryptoState.clientPublicKey = clientPublicKey;
  cryptoState.sharedKey = computeX25519SharedKey(
    BRIDGE_E2E_KEY_PAIR.privateKey,
    clientPublicKey,
  );
  emitPlainBridgeFrame(socket, {
    type: 'pairing_ack',
    e2e: true,
    publicKey: bridgePublicKeyBase64(),
    bridgePublicKey: bridgePublicKeyBase64(),
    bridge: 'Hermes Migel Bridge',
  });
}

function decryptClientPayload(frame, cryptoState) {
  if (!cryptoState.sharedKey) {
    throw new Error('Hermes Migel Bridge 尚未完成 E2E 公钥握手，无法解密聊天请求。');
  }
  const plaintext = decryptSecretBoxFrame(frame, cryptoState.sharedKey);
  const text = plaintext.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

function emitBridgeFrame(socket, payload, cryptoState = null) {
  if (!socket || socket.destroyed || !socket.writable) return;
  if (cryptoState?.sharedKey) {
    socket.write(encodeTextFrame(JSON.stringify(encryptSecretBoxFrame(payload, cryptoState.sharedKey))));
    return;
  }
  emitPlainBridgeFrame(socket, payload);
}

function emitPlainBridgeFrame(socket, payload) {
  if (!socket || socket.destroyed || !socket.writable) return;
  socket.write(encodeTextFrame(JSON.stringify(payload)));
}

async function normalizeBridgeRequestImages(request) {
  const attachments = [];
  for (const attachment of Array.isArray(request?.attachments) ? request.attachments : []) {
    if (attachment?.kind !== 'image') {
      attachments.push(attachment);
      continue;
    }

    const remoteUrl = normalizeRemoteUrl(attachment.remoteUrl) || normalizeRemoteUrl(attachment.url);
    if (remoteUrl) {
      attachments.push({
        ...attachment,
        data: '',
        dataBase64: '',
        encoding: 'url',
        remoteUrl,
        objectKey: normalizeText(attachment.objectKey),
      });
      continue;
    }

    const base64 = normalizeBase64Payload(attachment.data || attachment.dataBase64 || attachment.base64);
    const bytes = decodeBase64Strict(base64);
    if (!bytes) {
      throw new Error(`图片 ${normalizeText(attachment.name) || 'image'} 的 base64 无法解码。`);
    }

    const normalized = await normalizeInlineImageBytes(bytes, attachment);
    const data = normalized.bytes.toString('base64');
    attachments.push({
      ...attachment,
      name: normalizeImageName(attachment.name, normalized.mimeType),
      mimeType: normalized.mimeType,
      data,
      dataBase64: data,
      encoding: 'base64',
      sizeBytes: normalized.bytes.length,
      sha256: sha256Hex(normalized.bytes),
      remoteUrl: '',
      objectKey: '',
    });
  }

  return {
    ...request,
    attachments,
  };
}

async function normalizeInlineImageBytes(bytes, attachment) {
  const inputMimeType = normalizeImageMimeType(attachment?.mimeType);
  const maxBytes = positiveInteger(MAX_NORMALIZED_IMAGE_BYTES, MAX_IMAGE_INLINE_BYTES);
  const maxEdge = positiveInteger(MAX_IMAGE_EDGE, 1920);
  const normalized = await normalizeImageBytesWithSips(bytes, {
    mimeType: inputMimeType,
    maxBytes,
    maxEdge,
  }).catch(() => null);

  if (normalized) return normalized;
  if (bytes.length <= maxBytes) {
    return {
      bytes,
      mimeType: inputMimeType,
    };
  }
  throw new Error(`图片 ${normalizeText(attachment?.name) || 'image'} 归一化后仍超过 ${formatBytes(maxBytes)}，请先压缩或上传 OSS URL。`);
}

async function normalizeImageBytesWithSips(bytes, {
  mimeType,
  maxBytes,
  maxEdge,
} = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'hermes-bridge-image-'));
  try {
    const inputPath = join(workDir, `input.${extensionForMimeType(mimeType)}`);
    await writeFileAsync(inputPath, bytes);

    const outputFormat = IMAGE_NORMALIZE_FORMAT === 'webp' ? 'jpeg' : IMAGE_NORMALIZE_FORMAT;
    const outputMimeType = outputFormat === 'png' ? 'image/png' : 'image/jpeg';
    const baseQuality = IMAGE_NORMALIZE_FORMAT === 'webp' ? IMAGE_WEBP_QUALITY : IMAGE_JPEG_QUALITY;
    const qualities = uniqueIntegers([baseQuality, 86, 78, 70, 62, 54, 46, 40])
      .filter((value) => value >= 40 && value <= 95);
    const edges = imageEdgeCandidates(maxEdge);
    let smallest = null;

    for (const edge of edges) {
      for (const quality of qualities) {
        const outputPath = join(workDir, `output-${edge}-${quality}.${outputFormat === 'png' ? 'png' : 'jpg'}`);
        const args = [
          '-s',
          'format',
          outputFormat,
          '-s',
          'formatOptions',
          String(quality),
          '--resampleHeightWidthMax',
          String(edge),
          inputPath,
          '--out',
          outputPath,
        ];
        await execFileAsync(IMAGE_NORMALIZER_BIN, args, {
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
        }).catch(() => null);
        const output = await readOptionalFile(outputPath);
        if (!output?.length) continue;
        if (!smallest || output.length < smallest.bytes.length) {
          smallest = {
            bytes: output,
            mimeType: outputMimeType,
          };
        }
        if (output.length <= maxBytes) return smallest;
      }
    }

    return smallest?.bytes?.length <= maxBytes ? smallest : null;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareBridgeOutputImages(images, {
  payload,
  sessionId,
  socket,
  cryptoState,
} = {}) {
  const sourceImages = Array.isArray(images) ? images : [];
  if (!sourceImages.length) return [];

  const uploadContext = bridgeOutputUploadContext(payload);
  const needsUpload = sourceImages.some((image) => imageNeedsOssUpload(image));
  if (needsUpload && uploadContext) {
    emitBridgeFrame(socket, createChatStatusFrame({
      sessionId,
      phase: 'uploading_images',
      message: 'Hermes Migel Bridge 已收到生成图片，正在上传 OSS。',
    }), cryptoState);
  }

  const prepared = [];
  for (let index = 0; index < sourceImages.length; index += 1) {
    prepared.push(await prepareSingleBridgeOutputImage(sourceImages[index], {
      index,
      uploadContext,
    }));
  }
  return prepared.filter(Boolean);
}

async function prepareSingleBridgeOutputImage(image, {
  index,
  uploadContext,
} = {}) {
  if (!image || typeof image !== 'object') return null;
  const remoteUrl = normalizeRemoteUrl(image.url) || normalizeRemoteUrl(image.remoteUrl);
  const inline = imageInlineBytes(image);
  if (!inline && remoteUrl) {
    return {
      ...image,
      dataBase64: undefined,
      b64_json: undefined,
      url: remoteUrl,
      remoteUrl,
      objectKey: normalizeText(image.objectKey),
    };
  }
  if (!inline) return null;

  const { bytes, mimeType } = inline;
  if (uploadContext) {
    const uploaded = await uploadBridgeOutputImage({
      uploadContext,
      bytes,
      mimeType,
      image,
      index,
    });
    return uploaded;
  }

  if (bytes.length <= MAX_OUTPUT_INLINE_BYTES) {
    return {
      ...image,
      mimeType,
      dataBase64: bytes.toString('base64'),
      url: remoteUrl || undefined,
    };
  }

  throw new Error(
    `Hermes Migel Bridge 已生成第 ${index + 1} 张图片，但缺少账号 OSS 上传授权，且图片超过 ${formatBytes(MAX_OUTPUT_INLINE_BYTES)}，已阻止大 base64 回传到 Android。`,
  );
}

async function uploadBridgeOutputImage({
  uploadContext,
  bytes,
  mimeType,
  image,
  index,
}) {
  if (bytes.length > MAX_OUTPUT_UPLOAD_BYTES) {
    throw new Error(`生成图片 ${normalizeText(image?.name) || index + 1} 超过 OSS 上传上限 ${formatBytes(MAX_OUTPUT_UPLOAD_BYTES)}。`);
  }
  const name = normalizeImageName(image?.name || image?.id || `hermes-output-${index + 1}`, mimeType);
  const sha256 = sha256Hex(bytes);
  const signature = await presignBridgeOutputUpload(uploadContext, {
    name,
    mimeType,
    sizeBytes: bytes.length,
    sha256,
  });
  await putBridgeOutputBytes(signature, {
    bytes,
    mimeType,
    name,
  });
  return {
    id: normalizeText(image?.id) || `hermes-output-${sha256.slice(0, 16)}`,
    name,
    mimeType,
    dataBase64: undefined,
    url: signature.downloadUrl,
    remoteUrl: signature.downloadUrl,
    objectKey: signature.objectKey,
  };
}

async function presignBridgeOutputUpload(uploadContext, {
  name,
  mimeType,
  sizeBytes,
  sha256,
}) {
  const response = await fetch(`${uploadContext.accountApiBaseUrl}/oss/presign-upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${uploadContext.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType,
      kind: 'image',
      purpose: 'hermes_bridge_output',
      sizeBytes,
      sha256,
    }),
  });
  const text = await response.text();
  const parsed = parseJsonObject(text);
  if (!response.ok) {
    throw new Error(`Hermes 输出图 OSS 签名失败（HTTP ${response.status}）：${extractServiceMessage(parsed) || text.slice(0, 240)}`);
  }
  const uploadUrl = normalizeText(parsed?.uploadUrl);
  const downloadUrl = normalizeText(parsed?.downloadUrl);
  const objectKey = normalizeText(parsed?.objectKey);
  if (!uploadUrl || !downloadUrl || !objectKey) {
    throw new Error('Hermes 输出图 OSS 签名响应缺少 uploadUrl/downloadUrl/objectKey。');
  }
  return {
    uploadUrl,
    downloadUrl,
    objectKey,
    method: normalizeText(parsed?.method) || 'PUT',
    uploadHeaders: parsed?.uploadHeaders && typeof parsed.uploadHeaders === 'object'
      ? parsed.uploadHeaders
      : {},
  };
}

async function putBridgeOutputBytes(signature, {
  bytes,
  mimeType,
  name,
}) {
  const headers = Object.keys(signature.uploadHeaders).length
    ? signature.uploadHeaders
    : { 'Content-Type': mimeType };
  const response = await fetch(signature.uploadUrl, {
    method: signature.method || 'PUT',
    headers,
    body: bytes,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Hermes 输出图 OSS 上传失败（HTTP ${response.status}）：${text.slice(0, 240) || name}`);
  }
}

function bridgeStreamImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((image) => {
      const remoteUrl = normalizeRemoteUrl(image?.url) || normalizeRemoteUrl(image?.remoteUrl);
      if (!remoteUrl) return null;
      return {
        ...image,
        dataBase64: undefined,
        b64_json: undefined,
        url: remoteUrl,
        remoteUrl,
        objectKey: normalizeText(image?.objectKey),
      };
    })
    .filter(Boolean);
}

function bridgeOutputUploadContext(payload) {
  const source = payload?.hermesBridgeOss && typeof payload.hermesBridgeOss === 'object'
    ? payload.hermesBridgeOss
    : payload?.accountOss && typeof payload.accountOss === 'object'
      ? payload.accountOss
      : {};
  const accountApiBaseUrl = normalizeBaseUrl(
    source.accountApiBaseUrl
      || source.baseUrl
      || payload?.accountApiBaseUrl
      || ACCOUNT_API_BASE_URL,
  );
  const token = normalizeText(
    source.token
      || source.accountSessionToken
      || payload?.accountSessionToken
      || process.env.HERMES_ACCOUNT_SESSION_TOKEN,
  );
  if (!accountApiBaseUrl || !token) return null;
  return {
    accountApiBaseUrl,
    token,
  };
}

function hasBridgeOutputUploadContext(payload) {
  return Boolean(bridgeOutputUploadContext(payload));
}

function imageNeedsOssUpload(image) {
  return Boolean(imageInlineBytes(image));
}

function imageInlineBytes(image) {
  const dataUrl = parseDataImageUrl(image?.url || image?.remoteUrl);
  const base64 = normalizeBase64Payload(image?.dataBase64 || image?.b64_json || dataUrl?.base64);
  if (!base64) return null;
  const bytes = decodeBase64Strict(base64);
  if (!bytes) return null;
  return {
    bytes,
    mimeType: normalizeImageMimeType(dataUrl?.mimeType || image?.mimeType || image?.mime_type),
  };
}

function parseDataImageUrl(value) {
  const text = normalizeText(value);
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(text);
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2],
  };
}

function normalizeBase64Payload(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const dataUrl = parseDataImageUrl(text);
  return (dataUrl?.base64 || text).replace(/\s/g, '');
}

function decodeBase64Strict(value) {
  const base64 = normalizeBase64Payload(value);
  if (!base64) return null;
  try {
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length) return null;
    const expected = bytes.toString('base64').replace(/=+$/g, '');
    const actual = base64.replace(/=+$/g, '');
    if (expected !== actual) return null;
    return bytes;
  } catch {
    return null;
  }
}

function normalizeRemoteUrl(value) {
  const url = normalizeText(value);
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return '';
}

function normalizeImageMimeType(value) {
  const mimeType = normalizeText(value).toLowerCase();
  return mimeType.startsWith('image/') ? mimeType : 'image/png';
}

function normalizeImageName(value, mimeType) {
  const raw = normalizeText(value) || 'image';
  const extension = extensionForMimeType(mimeType);
  const withoutQuery = raw.split('?')[0].split('#')[0];
  if (/\.[a-z0-9]{2,5}$/i.test(withoutQuery)) {
    return withoutQuery.replace(/\.[a-z0-9]{2,5}$/i, `.${extension}`);
  }
  return `${withoutQuery}.${extension}`;
}

function normalizeImageOutputFormat(value) {
  const format = normalizeText(value).toLowerCase();
  if (format === 'png') return 'png';
  if (format === 'webp') return 'webp';
  return 'jpeg';
}

function extensionForMimeType(mimeType) {
  const normalized = normalizeImageMimeType(mimeType);
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('gif')) return 'gif';
  return 'jpg';
}

function imageEdgeCandidates(maxEdge) {
  const base = positiveInteger(maxEdge, 1920);
  return uniqueIntegers([
    base,
    Math.floor(base * 0.85),
    Math.floor(base * 0.7),
    Math.floor(base * 0.55),
    1280,
    1024,
    768,
    640,
  ]).filter((value) => value >= 320);
}

function uniqueIntegers(values) {
  return Array.from(new Set(values.map((value) => Math.floor(Number(value))).filter((value) => Number.isFinite(value) && value > 0)));
}

async function readOptionalFile(path) {
  try {
    return await readFileAsync(path);
  } catch {
    return null;
  }
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJson(text) {
  return parseJsonObject(text);
}

function extractServiceMessage(payload) {
  return normalizeText(payload?.message)
    || normalizeText(payload?.error?.message)
    || normalizeText(payload?.code);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function encryptSecretBoxFrame(payload, sharedKey) {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const nonce = randomBytes(E2E_NONCE_BYTES);
  const padded = Buffer.concat([Buffer.alloc(SECRETBOX_ZEROBYTES), plaintext]);
  const boxed = cryptoStreamXor(padded, nonce, sharedKey);
  const tag = poly1305Authenticate(boxed.subarray(SECRETBOX_ZEROBYTES), boxed.subarray(0, POLY1305_KEY_BYTES));
  return {
    v: 1,
    nonce: nonce.toString('base64'),
    ciphertext: Buffer.concat([tag, boxed.subarray(SECRETBOX_ZEROBYTES)]).toString('base64'),
  };
}

function decryptSecretBoxFrame(frame, sharedKey) {
  const nonce = decodeBase64Bytes(frame.nonce, E2E_NONCE_BYTES);
  const ciphertext = decodeBase64Bytes(frame.ciphertext);
  if (!nonce || !ciphertext || ciphertext.length < POLY1305_TAG_BYTES) {
    throw new Error('Hermes Migel Bridge 收到了无效的 E2E 加密帧。');
  }

  const tag = ciphertext.subarray(0, POLY1305_TAG_BYTES);
  const body = ciphertext.subarray(POLY1305_TAG_BYTES);
  const firstBlock = cryptoStream(SECRETBOX_ZEROBYTES, nonce, sharedKey);
  const expectedTag = poly1305Authenticate(body, firstBlock.subarray(0, POLY1305_KEY_BYTES));
  if (!constantTimeEqual(tag, expectedTag)) {
    throw new Error('Hermes Migel Bridge 无法验证 E2E 加密帧。');
  }
  const opened = cryptoStreamXor(Buffer.concat([Buffer.alloc(SECRETBOX_ZEROBYTES), body]), nonce, sharedKey);
  return opened.subarray(SECRETBOX_ZEROBYTES);
}

function loadOrCreateBridgeE2eKeyPair() {
  const existing = readBridgeKeyPair();
  if (existing) return existing;

  const generated = generateKeyPairSync('x25519');
  const publicKey = exportRawX25519PublicKey(generated.publicKey);
  const privateKey = exportRawX25519PrivateKey(generated.privateKey);
  const keyPair = { publicKey, privateKey };
  writeBridgeKeyPair(keyPair);
  return keyPair;
}

function readBridgeKeyPair() {
  if (!existsSync(E2E_KEY_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(E2E_KEY_PATH, 'utf8'));
    const publicKey = decodeBase64Bytes(parsed?.publicKey, E2E_PUBLIC_KEY_BYTES);
    const privateKey = decodeBase64Bytes(parsed?.privateKey, E2E_PRIVATE_KEY_BYTES);
    if (!publicKey || !privateKey) return null;
    return { publicKey, privateKey };
  } catch {
    return null;
  }
}

function writeBridgeKeyPair(keyPair) {
  try {
    mkdirSync(dirname(E2E_KEY_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(
      E2E_KEY_PATH,
      `${JSON.stringify({
        publicKey: keyPair.publicKey.toString('base64'),
        privateKey: keyPair.privateKey.toString('base64'),
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    throw new Error(`Hermes Migel Bridge 无法保存 E2E 密钥：${error.message || error}`);
  }
}

function bridgePublicKeyBase64() {
  return BRIDGE_E2E_KEY_PAIR?.publicKey?.toString('base64') || null;
}

function computeX25519SharedKey(privateKey, peerPublicKey) {
  const secret = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, peerPublicKey]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = diffieHellman({ privateKey: secret, publicKey });
  return hsalsa20(sharedSecret, Buffer.alloc(16));
}

function exportRawX25519PublicKey(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - E2E_PUBLIC_KEY_BYTES);
}

function exportRawX25519PrivateKey(privateKey) {
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - E2E_PRIVATE_KEY_BYTES);
}

function decodeBase64Bytes(value, expectedLength = null) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const bytes = Buffer.from(text, 'base64');
    if (expectedLength != null && bytes.length !== expectedLength) return null;
    return bytes;
  } catch {
    return null;
  }
}

function cryptoStreamXor(message, nonce, key) {
  const output = Buffer.alloc(message.length);
  let offset = 0;
  let counter = 0n;
  while (offset < message.length) {
    const block = salsa20Block(hsalsa20(key, nonce.subarray(0, 16)), nonce.subarray(16, 24), counter);
    const length = Math.min(block.length, message.length - offset);
    for (let index = 0; index < length; index += 1) {
      output[offset + index] = message[offset + index] ^ block[index];
    }
    offset += length;
    counter += 1n;
  }
  return output;
}

function cryptoStream(length, nonce, key) {
  return cryptoStreamXor(Buffer.alloc(length), nonce, key);
}

function hsalsa20(key, nonce16) {
  const state = [
    SIGMA_WORDS[0],
    readUint32LE(key, 0),
    readUint32LE(key, 4),
    readUint32LE(key, 8),
    readUint32LE(key, 12),
    SIGMA_WORDS[1],
    readUint32LE(nonce16, 0),
    readUint32LE(nonce16, 4),
    readUint32LE(nonce16, 8),
    readUint32LE(nonce16, 12),
    SIGMA_WORDS[2],
    readUint32LE(key, 16),
    readUint32LE(key, 20),
    readUint32LE(key, 24),
    readUint32LE(key, 28),
    SIGMA_WORDS[3],
  ];
  const x = salsaCore(state);
  const out = Buffer.alloc(32);
  writeUint32LE(out, x[0], 0);
  writeUint32LE(out, x[5], 4);
  writeUint32LE(out, x[10], 8);
  writeUint32LE(out, x[15], 12);
  writeUint32LE(out, x[6], 16);
  writeUint32LE(out, x[7], 20);
  writeUint32LE(out, x[8], 24);
  writeUint32LE(out, x[9], 28);
  return out;
}

function salsa20Block(key, nonce8, counter) {
  const state = [
    SIGMA_WORDS[0],
    readUint32LE(key, 0),
    readUint32LE(key, 4),
    readUint32LE(key, 8),
    readUint32LE(key, 12),
    SIGMA_WORDS[1],
    readUint32LE(nonce8, 0),
    readUint32LE(nonce8, 4),
    Number(counter & 0xffffffffn),
    Number((counter >> 32n) & 0xffffffffn),
    SIGMA_WORDS[2],
    readUint32LE(key, 16),
    readUint32LE(key, 20),
    readUint32LE(key, 24),
    readUint32LE(key, 28),
    SIGMA_WORDS[3],
  ];
  const x = salsaCore(state);
  const out = Buffer.alloc(64);
  for (let index = 0; index < 16; index += 1) {
    writeUint32LE(out, (x[index] + state[index]) >>> 0, index * 4);
  }
  return out;
}

function salsaCore(input) {
  const x = input.map((value) => value >>> 0);
  for (let round = 0; round < 10; round += 1) {
    x[4] ^= rotateLeft((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotateLeft((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotateLeft((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotateLeft((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotateLeft((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotateLeft((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotateLeft((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotateLeft((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotateLeft((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotateLeft((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotateLeft((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotateLeft((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotateLeft((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotateLeft((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotateLeft((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotateLeft((x[11] + x[7]) >>> 0, 18);
    x[1] ^= rotateLeft((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotateLeft((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotateLeft((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotateLeft((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotateLeft((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotateLeft((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotateLeft((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotateLeft((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotateLeft((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotateLeft((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotateLeft((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotateLeft((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotateLeft((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotateLeft((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotateLeft((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotateLeft((x[14] + x[13]) >>> 0, 18);
  }
  return x.map((value) => value >>> 0);
}

function poly1305Authenticate(message, key) {
  let r = bufferToLittleEndianBigInt(key.subarray(0, 16));
  r &= 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = bufferToLittleEndianBigInt(key.subarray(16, 32));
  const p = (1n << 130n) - 5n;
  let accumulator = 0n;

  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, offset + 16);
    let number = bufferToLittleEndianBigInt(block);
    number += 1n << BigInt(8 * block.length);
    accumulator = ((accumulator + number) * r) % p;
  }

  const tagNumber = (accumulator + s) % (1n << 128n);
  return littleEndianBigIntToBuffer(tagNumber, POLY1305_TAG_BYTES);
}

function bufferToLittleEndianBigInt(buffer) {
  let value = 0n;
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(buffer[index]);
  }
  return value;
}

function littleEndianBigIntToBuffer(value, length) {
  const out = Buffer.alloc(length);
  let current = value;
  for (let index = 0; index < length; index += 1) {
    out[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function constantTimeEqual(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

function rotateLeft(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function readUint32LE(buffer, offset) {
  return buffer.readUInt32LE(offset) >>> 0;
}

function writeUint32LE(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
