import { handleClaimedJobDelivery } from '../app/desktopConnector.mjs';

const DEFAULT_ROLE = 'desktop';
const DEFAULT_RELEASE_DELAY_MS = 0;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export class GatewayDeliveryLoopError extends Error {
  constructor(message, {
    code = 'gateway_delivery_loop_error',
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'GatewayDeliveryLoopError';
    this.code = code;
  }
}

export function createGatewayDeliveryLoop({
  gateway,
  claimNextDelivery,
  ackDelivery,
  releaseDelivery,
  failDelivery,
  sendFrame,
  handleDelivery = handleClaimedJobDelivery,
  role = DEFAULT_ROLE,
  deviceId,
  connectorOptions = {},
  releaseDelayMs = DEFAULT_RELEASE_DELAY_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  onEmpty,
  onProcessed,
  onError,
} = {}) {
  const adapter = resolveGatewayAdapter({
    gateway,
    claimNextDelivery,
    ackDelivery,
    releaseDelivery,
    failDelivery,
    sendFrame,
  });

  let running = false;
  let timer = null;

  return {
    processNext,
    drain,
    start,
    stop,
    isRunning: () => running,
    getState: () => ({
      running,
      role: normalizeText(role),
      deviceId: normalizeText(deviceId),
    }),
  };

  async function processNext(options = {}) {
    assertClaimIdentity(role, deviceId);
    const claim = requireFunction(adapter.claimNextDelivery, 'claimNextDelivery');
    const claimedDelivery = await claim(role, deviceId, {
      ...normalizeObject(options.claimOptions),
    });

    if (!claimedDelivery) {
      const empty = {
        claimed: false,
        disposition: 'empty',
      };
      if (typeof onEmpty === 'function') {
        await onEmpty(empty);
      }
      return empty;
    }

    try {
      const outcome = await handleDelivery(claimedDelivery, {
        ...normalizeObject(connectorOptions),
        ...normalizeObject(options.connectorOptions),
      });
      const frames = Array.isArray(outcome.framesToEmit) ? outcome.framesToEmit : [];
      await emitGatewayFrames(frames, adapter.sendFrame);
      const settlement = await settleClaimedDelivery(claimedDelivery, outcome, adapter, {
        releaseDelayMs: resolveNumber(options.releaseDelayMs, releaseDelayMs),
      });
      const processed = {
        claimed: true,
        disposition: settlement.disposition,
        delivery: outcome.delivery,
        outcome,
        settlement,
      };
      if (typeof onProcessed === 'function') {
        await onProcessed(processed);
      }
      return processed;
    } catch (error) {
      const settlement = await settleDeliveryError(claimedDelivery, error, adapter, {
        releaseDelayMs: resolveNumber(options.releaseDelayMs, releaseDelayMs),
      });
      const processed = {
        claimed: true,
        disposition: settlement.disposition,
        delivery: claimedDelivery,
        error: settlement.error,
        settlement,
      };
      if (typeof onError === 'function') {
        await onError(settlement.error, {
          source: 'delivery_loop',
          delivery: claimedDelivery,
          disposition: settlement.disposition,
        });
      }
      if (typeof onProcessed === 'function') {
        await onProcessed(processed);
      }
      return processed;
    }
  }

  async function drain(options = {}) {
    const maxJobs = positiveInteger(options.maxJobs, Number.POSITIVE_INFINITY);
    const processed = [];
    let empty = null;

    while (processed.length < maxJobs) {
      const outcome = await processNext(options);
      if (!outcome.claimed) {
        empty = outcome;
        break;
      }
      processed.push(outcome);
    }

    return {
      count: processed.length,
      processed,
      empty,
    };
  }

  function start(options = {}) {
    if (running) return false;
    running = true;
    scheduleNextTick(resolveNumber(options.initialDelayMs, 0));
    return true;
  }

  function stop() {
    const wasRunning = running;
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return wasRunning;
  }

  function scheduleNextTick(delayMs) {
    if (!running) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await processNext();
      } finally {
        scheduleNextTick(resolveNumber(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
      }
    }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }
}

async function emitGatewayFrames(frames, sendFrame) {
  if (!frames.length) return [];
  const emit = requireFunction(sendFrame, 'sendFrame');
  const emitted = [];
  for (const frame of frames) {
    emitted.push(await emit(frame));
  }
  return emitted;
}

async function settleClaimedDelivery(claimedDelivery, outcome, adapter, options = {}) {
  const messageId = normalizeText(outcome?.delivery?.messageId) || normalizeText(claimedDelivery?.messageId);
  const disposition = normalizeDisposition(outcome?.disposition);
  const error = deliveryErrorFromOutcome(outcome);

  if (disposition === 'ack') {
    const ack = requireFunction(adapter.ackDelivery, 'ackDelivery');
    return {
      disposition,
      record: await ack(messageId),
      error: null,
    };
  }

  if (disposition === 'release') {
    const release = requireFunction(adapter.releaseDelivery, 'releaseDelivery');
    return {
      disposition,
      record: await release(messageId, {
        delayMs: Math.max(0, Number(options.releaseDelayMs) || 0),
        error,
      }),
      error,
    };
  }

  const fail = requireFunction(adapter.failDelivery, 'failDelivery');
  return {
    disposition: 'failed',
    record: await fail(messageId, { error }),
    error,
  };
}

async function settleDeliveryError(claimedDelivery, error, adapter, options = {}) {
  const normalizedError = normalizeDeliveryError(error);
  const disposition = normalizedError.retriable ? 'release' : 'failed';
  const messageId = normalizeText(claimedDelivery?.messageId);

  if (disposition === 'release') {
    const release = requireFunction(adapter.releaseDelivery, 'releaseDelivery');
    return {
      disposition,
      record: await release(messageId, {
        delayMs: Math.max(0, Number(options.releaseDelayMs) || 0),
        error: normalizedError,
      }),
      error: normalizedError,
    };
  }

  const fail = requireFunction(adapter.failDelivery, 'failDelivery');
  return {
    disposition,
    record: await fail(messageId, { error: normalizedError }),
    error: normalizedError,
  };
}

function resolveGatewayAdapter({
  gateway,
  claimNextDelivery,
  ackDelivery,
  releaseDelivery,
  failDelivery,
  sendFrame,
}) {
  const gatewayObject = gateway && typeof gateway === 'object' ? gateway : {};
  const queueObject = gatewayObject.queue && typeof gatewayObject.queue === 'object'
    ? gatewayObject.queue
    : {};

  return {
    claimNextDelivery: claimNextDelivery || bindFunction(gatewayObject, 'claimNextDelivery'),
    ackDelivery: ackDelivery || bindFunction(gatewayObject, 'ackDelivery'),
    releaseDelivery: releaseDelivery || bindFunction(gatewayObject, 'releaseDelivery'),
    failDelivery: failDelivery
      || bindFunction(gatewayObject, 'failDelivery')
      || bindFunction(gatewayObject, 'failedDelivery')
      || bindFunction(queueObject, 'fail'),
    sendFrame: sendFrame
      || bindFunction(gatewayObject, 'sendFrame')
      || bindFunction(gatewayObject, 'handleFrame'),
  };
}

function bindFunction(target, key) {
  return typeof target?.[key] === 'function' ? target[key].bind(target) : null;
}

function assertClaimIdentity(role, deviceId) {
  if (normalizeText(role) && normalizeText(deviceId)) return;
  throw new GatewayDeliveryLoopError('Gateway delivery claim 缺少 role 或 deviceId。', {
    code: 'missing_claim_identity',
  });
}

function requireFunction(fn, name) {
  if (typeof fn === 'function') return fn;
  throw new GatewayDeliveryLoopError(`Gateway delivery loop 缺少 ${name}。`, {
    code: `missing_${name}`,
  });
}

function normalizeDisposition(disposition) {
  const normalized = normalizeText(disposition);
  if (normalized === 'ack' || normalized === 'release' || normalized === 'failed') {
    return normalized;
  }
  throw new GatewayDeliveryLoopError('Gateway delivery loop 收到未知处理结果。', {
    code: 'invalid_delivery_disposition',
  });
}

function deliveryErrorFromOutcome(outcome) {
  return normalizeDeliveryError(
    outcome?.error || outcome?.resultFrame?.error || outcome?.agentResult?.error || {
      code: 'delivery_failed',
      message: 'Desktop Connector 处理任务失败。',
    },
  );
}

function normalizeDeliveryError(error) {
  if (!error) {
    return {
      code: 'delivery_failed',
      message: 'Desktop Connector 处理任务失败。',
      retriable: false,
    };
  }
  if (typeof error === 'string') {
    return {
      code: 'delivery_failed',
      message: error,
      retriable: false,
    };
  }
  return {
    code: normalizeText(error.code) || 'delivery_failed',
    message: normalizeText(error.message) || String(error),
    retriable: Boolean(error.retriable),
  };
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function resolveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
