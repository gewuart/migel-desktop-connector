import { createGatewayQueueConsumer } from './queueConsumer.mjs';

export const DEFAULT_GATEWAY_URL = '';

export class GatewayClientError extends Error {
  constructor(message, {
    code = 'gateway_client_error',
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'GatewayClientError';
    this.code = code;
  }
}

export function createGatewayWebSocketClient({
  url = DEFAULT_GATEWAY_URL,
  protocols,
  WebSocketClass = globalThis.WebSocket,
  reconnect = false,
  reconnectDelayMs = 2000,
  heartbeatMs = 0,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  consumer,
  createConsumer = createGatewayQueueConsumer,
  connectorOptions = {},
  onStateChange,
  onOpen,
  onIgnoredFrame,
  onError,
} = {}) {
  const targetUrl = normalizeGatewayUrl(url);
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let manualClose = false;
  let state = createState('idle', { url: targetUrl });

  const client = {
    connect,
    close,
    sendFrame,
    getSocket: () => socket,
    getState: () => ({ ...state }),
  };

  const queueConsumer = consumer || createConsumer({
    sendFrame,
    connectorOptions,
    onIgnoredFrame,
    onError: (error) => reportError(error, { source: 'queue_consumer' }),
  });

  return client;

  function connect() {
    if (socket && isSocketConnectingOrOpen(socket, WebSocketClass)) {
      return socket;
    }
    if (typeof WebSocketClass !== 'function') {
      throw new GatewayClientError('No WebSocket implementation is available for the gateway client.', {
        code: 'missing_websocket',
      });
    }

    manualClose = false;
    socket = Array.isArray(protocols) || typeof protocols === 'string'
      ? new WebSocketClass(targetUrl, protocols)
      : new WebSocketClass(targetUrl);
    updateState('connecting');

    bindSocketEvent(socket, 'open', async () => {
      clearReconnectTimer();
      updateState('open');
      startHeartbeat();
      if (typeof onOpen === 'function') {
        try {
          await onOpen({
            client,
            socket,
            state: { ...state },
            sendFrame,
          });
        } catch (error) {
          reportError(error, { source: 'open' });
        }
      }
    });
    bindSocketEvent(socket, 'message', async (event) => {
      await handleMessage(event);
    });
    bindSocketEvent(socket, 'close', (event) => {
      clearHeartbeatTimer();
      updateState('closed', normalizeCloseEvent(event));
      scheduleReconnect('close');
    });
    bindSocketEvent(socket, 'error', (event) => {
      const error = normalizeSocketError(event);
      updateState('error', { error });
      reportError(error, { source: 'websocket' });
      scheduleReconnect('error');
    });

    return socket;
  }

  async function handleMessage(event) {
    try {
      const message = await normalizeMessageData(event);
      if (typeof queueConsumer?.handleTextMessage !== 'function') {
        throw new GatewayClientError('Gateway client consumer must expose handleTextMessage().', {
          code: 'missing_consumer_handler',
        });
      }
      return await queueConsumer.handleTextMessage(message);
    } catch (error) {
      return reportError(error, { source: 'message' });
    }
  }

  async function sendFrame(frame) {
    const activeSocket = requireOpenSocket(socket, WebSocketClass);
    const text = JSON.stringify(frame || {});
    const result = activeSocket.send(text);
    if (result && typeof result.then === 'function') {
      await result;
    }
    return { frame, text };
  }

  function close(code = 1000, reason = 'desktop connector closing') {
    manualClose = true;
    clearReconnectTimer();
    clearHeartbeatTimer();
    if (!socket || typeof socket.close !== 'function') {
      updateState('closed', { code, reason });
      return false;
    }
    socket.close(code, reason);
    return true;
  }

  function scheduleReconnect(reason) {
    if (!reconnect || manualClose || reconnectTimer) return false;
    if (typeof setTimeoutImpl !== 'function') return false;
    const delayMs = normalizeReconnectDelay(reconnectDelayMs);
    updateState('reconnecting', { reason, delayMs });
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      if (!manualClose) {
        connect();
      }
    }, delayMs);
    return true;
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    if (typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(reconnectTimer);
    }
    reconnectTimer = null;
  }

  function startHeartbeat() {
    clearHeartbeatTimer();
    const intervalMs = normalizeHeartbeatInterval(heartbeatMs);
    if (!intervalMs || typeof setTimeoutImpl !== 'function') return false;
    const tick = async () => {
      heartbeatTimer = null;
      if (manualClose || !socket || !isSocketOpen(socket, WebSocketClass)) return;
      try {
        await sendFrame({
          type: 'gateway.heartbeat',
          sentAtEpochMillis: Date.now(),
        });
      } catch (error) {
        reportError(error, { source: 'heartbeat' });
        closeSocketForReconnect(socket, 4000, 'heartbeat failed');
        scheduleReconnect('heartbeat');
        return;
      }
      if (!manualClose && socket && isSocketOpen(socket, WebSocketClass)) {
        heartbeatTimer = setTimeoutImpl(tick, intervalMs);
      }
    };
    heartbeatTimer = setTimeoutImpl(tick, intervalMs);
    return true;
  }

  function clearHeartbeatTimer() {
    if (!heartbeatTimer) return;
    if (typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(heartbeatTimer);
    }
    heartbeatTimer = null;
  }

  function updateState(status, details = {}) {
    state = createState(status, {
      url: targetUrl,
      readyState: socket?.readyState,
      ...details,
    });
    if (typeof onStateChange === 'function') {
      onStateChange({ ...state });
    }
    return state;
  }

  function reportError(error, context = {}) {
    const normalized = error instanceof Error
      ? error
      : new GatewayClientError(String(error || 'Gateway client error.'), {
        code: 'gateway_client_error',
      });
    if (typeof onError === 'function') {
      return onError(normalized, context);
    }
    return {
      handled: false,
      error: normalized,
      context,
    };
  }
}

function normalizeGatewayUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new GatewayClientError('Gateway URL is required.', {
      code: 'missing_gateway_url',
    });
  }

  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new GatewayClientError('Gateway URL is invalid.', {
      code: 'invalid_gateway_url',
      cause: error,
    });
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new GatewayClientError('Gateway URL must use ws:// or wss://.', {
      code: 'invalid_gateway_protocol',
    });
  }
  return url.toString();
}

function normalizeReconnectDelay(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 100) return 2000;
  return Math.floor(numeric);
}

function normalizeHeartbeatInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  if (numeric < 1000) return 1000;
  return Math.floor(numeric);
}

function closeSocketForReconnect(socket, code, reason) {
  if (!socket || typeof socket.close !== 'function') return false;
  try {
    socket.close(code, reason);
    return true;
  } catch {
    return false;
  }
}

function requireOpenSocket(socket, WebSocketClass) {
  if (!socket || !isSocketOpen(socket, WebSocketClass)) {
    throw new GatewayClientError('Gateway WebSocket is not open.', {
      code: 'socket_not_open',
    });
  }
  if (typeof socket.send !== 'function') {
    throw new GatewayClientError('Gateway WebSocket does not support send().', {
      code: 'socket_send_unavailable',
    });
  }
  return socket;
}

function isSocketConnectingOrOpen(socket, WebSocketClass) {
  const open = readyStateValue(socket, WebSocketClass, 'OPEN', 1);
  const connecting = readyStateValue(socket, WebSocketClass, 'CONNECTING', 0);
  return socket.readyState === open || socket.readyState === connecting;
}

function isSocketOpen(socket, WebSocketClass) {
  return socket.readyState === readyStateValue(socket, WebSocketClass, 'OPEN', 1);
}

function readyStateValue(socket, WebSocketClass, key, fallback) {
  return Number.isInteger(socket?.[key])
    ? socket[key]
    : Number.isInteger(WebSocketClass?.[key])
      ? WebSocketClass[key]
      : fallback;
}

function bindSocketEvent(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(eventName, handler);
    return;
  }
  if (typeof socket.on === 'function') {
    socket.on(eventName, (...args) => handler(normalizeEventArgs(eventName, args)));
    return;
  }
  socket[`on${eventName}`] = handler;
}

function normalizeEventArgs(eventName, args) {
  if (args.length <= 1) {
    return args[0];
  }
  if (eventName === 'message') {
    return { data: args[0] };
  }
  if (eventName === 'close') {
    return { code: args[0], reason: String(args[1] || '') };
  }
  return args[0];
}

async function normalizeMessageData(event) {
  const value = event && typeof event === 'object' && 'data' in event ? event.data : event;
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value && typeof value.text === 'function') {
    return value.text();
  }
  return value;
}

function normalizeCloseEvent(event) {
  return {
    code: Number.isFinite(Number(event?.code)) ? Number(event.code) : undefined,
    reason: typeof event?.reason === 'string' ? event.reason : '',
    wasClean: Boolean(event?.wasClean),
  };
}

function normalizeSocketError(event) {
  if (event instanceof Error) return event;
  if (event?.error instanceof Error) return event.error;
  return new GatewayClientError('Gateway WebSocket error.', {
    code: 'websocket_error',
  });
}

function createState(status, details = {}) {
  return {
    status,
    ...details,
  };
}
