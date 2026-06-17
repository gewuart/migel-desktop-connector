import { handleJobCreatedFrame } from '../app/desktopConnector.mjs';
import { createRemotePermissionConfirmer } from '../permissions/remoteConfirmation.mjs';
import {
  createEncryptedRelayFrame,
  encryptedPayloadFromContainer,
  peerPublicKeyFromContainer,
} from '../protocol/e2eCrypto.mjs';

const JOB_CREATED_FRAME_TYPE = 'job.created';
const GATEWAY_DELIVERY_FRAME_TYPE = 'gateway.delivery';
const GATEWAY_DELIVERY_ACK_FRAME_TYPE = 'gateway.delivery.ack';
const GATEWAY_DELIVERY_RELEASE_FRAME_TYPE = 'gateway.delivery.release';
const PERMISSION_DECISION_FRAME_TYPE = 'permission.decision';

export class GatewayQueueConsumerError extends Error {
  constructor(message, {
    code = 'gateway_queue_consumer_error',
    frameType = '',
  } = {}) {
    super(message);
    this.name = 'GatewayQueueConsumerError';
    this.code = code;
    this.frameType = frameType;
  }
}

export function createGatewayQueueConsumer({
  handleJobCreated = handleJobCreatedFrame,
  sendFrame,
  onIgnoredFrame,
  onError,
  connectorOptions = {},
} = {}) {
  const remotePermissionConfirmer = connectorOptions.remotePermissionConfirmer
    || createRemotePermissionConfirmer({
      sendFrame,
      ...normalizeObject(connectorOptions.remotePermissionConfirmation),
    });
  const baseConnectorOptions = withRemotePermissionConfirmation(connectorOptions, remotePermissionConfirmer);
  return {
    async handleTextMessage(message, options = {}) {
      try {
        return await consumeGatewayTextMessage(message, {
          handleJobCreated,
          sendFrame,
          onIgnoredFrame,
          connectorOptions: {
            ...baseConnectorOptions,
            ...normalizeObject(options.connectorOptions),
            confirmPermission: normalizeObject(options.connectorOptions).confirmPermission
              || baseConnectorOptions.confirmPermission,
            remotePermissionConfirmer,
          },
        });
      } catch (error) {
        if (typeof onError === 'function') {
          return onError(error);
        }
        throw error;
      }
    },
  };
}

export async function consumeGatewayTextMessage(message, {
  handleJobCreated = handleJobCreatedFrame,
  sendFrame,
  onIgnoredFrame,
  connectorOptions = {},
} = {}) {
  if (typeof handleJobCreated !== 'function') {
    throw new GatewayQueueConsumerError('Gateway queue consumer 缺少 job.created 处理函数。', {
      code: 'missing_job_handler',
    });
  }

  const frame = parseGatewayTextMessage(message);
  const frameType = normalizeText(frame.type);
  if (frameType === GATEWAY_DELIVERY_FRAME_TYPE) {
    return await consumeGatewayDeliveryFrame(frame, {
      handleJobCreated,
      sendFrame,
      connectorOptions,
    });
  }
  if (frameType === PERMISSION_DECISION_FRAME_TYPE) {
    return await consumePermissionDecisionFrame(frame, {
      connectorOptions,
    });
  }
  if (frameType !== JOB_CREATED_FRAME_TYPE) {
    const ignored = {
      handled: false,
      reason: 'unsupported_frame_type',
      frameType,
      frame,
    };
    if (typeof onIgnoredFrame === 'function') {
      await onIgnoredFrame(ignored);
    }
    return ignored;
  }

  const options = normalizeObject(connectorOptions);
  const emitFrame = createOutboundFrameEmitter({
    connectorEmitFrame: options.emitFrame,
    sendFrame,
  });
  const result = await handleJobCreated(frame, {
    ...options,
    emitFrame,
  });

  return {
    handled: true,
    frameType,
    frame,
    result,
  };
}

async function consumeGatewayDeliveryFrame(frame, {
  handleJobCreated,
  sendFrame,
  connectorOptions = {},
} = {}) {
  const messageId = normalizeText(frame.messageId);
  if (!messageId) {
    throw new GatewayQueueConsumerError('gateway.delivery 缺少 messageId。', {
      code: 'missing_delivery_message_id',
      frameType: GATEWAY_DELIVERY_FRAME_TYPE,
    });
  }
  const inboundE2E = describeInboundDeliveryE2E(frame.frame);
  let jobFrame;
  try {
    jobFrame = prepareInboundDeliveryFrame(frame.frame, connectorOptions);
  } catch (error) {
    logGatewayQueueDebug(
      connectorOptions.logger,
      `Desktop Connector E2E inbound delivery message=${messageId} ${formatInboundE2EDiagnostics(inboundE2E)} prepareError=${normalizeText(error?.code) || normalizeText(error?.message) || 'unknown'}`,
    );
    throw error;
  }
  logGatewayQueueDebug(
    connectorOptions.logger,
    `Desktop Connector E2E inbound delivery message=${messageId} ${formatInboundE2EDiagnostics(inboundE2E)} preparedE2e=${Boolean(jobFrame?.e2e?.peerPublicKey)} preparedType=${normalizeText(jobFrame?.type) || '-'}`,
  );
  if (!jobFrame || typeof jobFrame !== 'object' || Array.isArray(jobFrame)) {
    await releaseDelivery(messageId, sendFrame, {
      code: 'missing_delivery_frame',
      message: 'gateway.delivery 缺少可处理的 job frame。',
    });
    throw new GatewayQueueConsumerError('gateway.delivery 缺少可处理的 job frame。', {
      code: 'missing_delivery_frame',
      frameType: GATEWAY_DELIVERY_FRAME_TYPE,
    });
  }
  const jobFrameType = normalizeText(jobFrame.type);
  if (jobFrameType === PERMISSION_DECISION_FRAME_TYPE) {
    const result = await consumePermissionDecisionFrame(jobFrame, {
      connectorOptions,
    });
    await ackDelivery(messageId, sendFrame);
    return {
      ...result,
      frameType: GATEWAY_DELIVERY_FRAME_TYPE,
      messageId,
      frame: jobFrame,
      disposition: 'ack',
    };
  }
  if (jobFrameType !== JOB_CREATED_FRAME_TYPE) {
    await releaseDelivery(messageId, sendFrame, {
      code: 'unsupported_delivery_frame_type',
      message: `Desktop Connector 不支持处理 ${jobFrameType || 'unknown'} delivery。`,
    });
    return {
      handled: false,
      reason: 'unsupported_delivery_frame_type',
      frameType: GATEWAY_DELIVERY_FRAME_TYPE,
      messageId,
      frame: jobFrame,
    };
  }

  const options = normalizeObject(connectorOptions);
  const emitFrame = createOutboundFrameEmitter({
    connectorEmitFrame: options.emitFrame,
    sendFrame,
    encryptForPeer: createOutboundE2EEncryptor(jobFrame, options),
    logger: options.logger,
    deliveryMessageId: messageId,
  });
  try {
    const result = await handleJobCreated(jobFrame, {
      ...options,
      emitFrame,
    });
    await ackDelivery(messageId, sendFrame);
    return {
      handled: true,
      frameType: GATEWAY_DELIVERY_FRAME_TYPE,
      messageId,
      frame: jobFrame,
      result,
      disposition: 'ack',
    };
  } catch (error) {
    await releaseDelivery(messageId, sendFrame, normalizeError(error));
    throw error;
  }
}

async function consumePermissionDecisionFrame(frame, {
  connectorOptions = {},
} = {}) {
  const handler = typeof connectorOptions.handlePermissionDecision === 'function'
    ? connectorOptions.handlePermissionDecision
    : connectorOptions.remotePermissionConfirmer?.handleDecision;
  if (typeof handler !== 'function') {
    return {
      handled: false,
      reason: 'missing_permission_decision_handler',
      frameType: PERMISSION_DECISION_FRAME_TYPE,
      frame,
    };
  }
  const result = await handler(frame);
  return {
    handled: result?.handled !== false,
    reason: result?.reason,
    frameType: PERMISSION_DECISION_FRAME_TYPE,
    frame,
    result,
  };
}

async function ackDelivery(messageId, sendFrame) {
  if (typeof sendFrame !== 'function') return null;
  return await sendFrame({
    type: GATEWAY_DELIVERY_ACK_FRAME_TYPE,
    messageId,
  });
}

async function releaseDelivery(messageId, sendFrame, error) {
  if (typeof sendFrame !== 'function') return null;
  return await sendFrame({
    type: GATEWAY_DELIVERY_RELEASE_FRAME_TYPE,
    messageId,
    error,
  });
}

export function parseGatewayTextMessage(message) {
  if (Buffer.isBuffer(message)) {
    return parseGatewayTextMessage(message.toString('utf8'));
  }
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    return { ...message };
  }
  if (typeof message !== 'string') {
    throw new GatewayQueueConsumerError('Gateway 消息必须是 JSON 文本或 frame 对象。', {
      code: 'invalid_gateway_message',
    });
  }

  const text = message.trim();
  if (!text) {
    throw new GatewayQueueConsumerError('Gateway 消息为空。', {
      code: 'empty_gateway_message',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayQueueConsumerError('Gateway 消息不是有效 JSON。', {
      code: 'invalid_gateway_json',
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayQueueConsumerError('Gateway JSON 消息必须是 frame 对象。', {
      code: 'invalid_gateway_frame',
    });
  }
  return parsed;
}

function createOutboundFrameEmitter({
  connectorEmitFrame,
  sendFrame,
  encryptForPeer,
  logger,
  deliveryMessageId = '',
}) {
  let emittedCount = 0;
  return async (frame) => {
    emittedCount += 1;
    const sourceType = normalizeText(frame?.type) || 'unknown';
    const shouldEncrypt = typeof encryptForPeer === 'function';
    let outboundFrame = frame;
    if (shouldEncrypt) {
      try {
        outboundFrame = encryptForPeer(frame);
      } catch (error) {
        logGatewayQueueDebug(
          logger,
          `Desktop Connector E2E outbound frame delivery=${deliveryMessageId || '-'} seq=${emittedCount} type=${sourceType} encrypt=true encryptError=${normalizeText(error?.code) || normalizeText(error?.message) || 'unknown'}`,
        );
        throw error;
      }
    }
    const outboundEncrypted = Boolean(encryptedPayloadFromContainer(outboundFrame));
    if (shouldLogOutboundE2EProbe(frame, emittedCount)) {
      logGatewayQueueDebug(
        logger,
        `Desktop Connector E2E outbound frame delivery=${deliveryMessageId || '-'} seq=${emittedCount} type=${sourceType} encrypt=${shouldEncrypt} encrypted=${outboundEncrypted} phase=${normalizeText(frame?.phase) || '-'} done=${typeof frame?.done === 'boolean' ? frame.done : '-'}`,
      );
    }
    if (typeof connectorEmitFrame === 'function') {
      await connectorEmitFrame(outboundFrame);
    }
    if (typeof sendFrame === 'function') {
      await sendFrame(outboundFrame);
    }
    return outboundFrame;
  };
}

function prepareInboundDeliveryFrame(frame, connectorOptions = {}) {
  const encrypted = encryptedPayloadFromContainer(frame?.payload)
    || encryptedPayloadFromContainer(frame);
  if (!encrypted) return frame;
  const e2eCrypto = connectorOptions?.e2eCrypto;
  if (!e2eCrypto || typeof e2eCrypto.decryptJsonFrame !== 'function') {
    throw new GatewayQueueConsumerError('Desktop Connector 收到 E2E 任务，但本机未启用 E2E 解密。', {
      code: 'missing_e2e_crypto',
      frameType: normalizeText(frame?.type),
    });
  }
  const peerPublicKey = peerPublicKeyFromContainer(frame?.payload)
    || peerPublicKeyFromContainer(frame);
  const decrypted = e2eCrypto.decryptJsonFrame(encrypted, peerPublicKey);
  const payload = decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
    ? decrypted
    : {};
  const decryptedType = normalizeText(payload.type);
  if (decryptedType && decryptedType !== 'chat.request') {
    return {
      ...payload,
      requestId: normalizeText(payload.requestId) || normalizeText(frame?.requestId),
      conversationId: normalizeText(payload.conversationId) || normalizeText(frame?.conversationId),
      targetDeviceId: normalizeText(payload.targetDeviceId) || normalizeText(frame?.targetDeviceId),
      fromDeviceId: normalizeText(payload.fromDeviceId) || normalizeText(frame?.fromDeviceId),
      e2e: {
        encrypted: true,
        peerPublicKey,
      },
    };
  }
  const decryptedFrame = normalizeText(payload.type) === JOB_CREATED_FRAME_TYPE
    ? payload
    : {
      ...frame,
      payload: {
        ...normalizeObject(frame?.payload),
        ...payload,
      },
    };
  return {
    ...decryptedFrame,
    type: JOB_CREATED_FRAME_TYPE,
    version: Number.isFinite(Number(decryptedFrame.version || frame?.version))
      ? Number(decryptedFrame.version || frame?.version)
      : frame?.version,
    jobId: normalizeText(decryptedFrame.jobId) || normalizeText(frame?.jobId),
    requestId: normalizeText(decryptedFrame.requestId) || normalizeText(frame?.requestId),
    conversationId: normalizeText(decryptedFrame.conversationId) || normalizeText(frame?.conversationId),
    fromDeviceId: normalizeText(decryptedFrame.fromDeviceId) || normalizeText(frame?.fromDeviceId),
    e2e: {
      encrypted: true,
      peerPublicKey,
    },
  };
}

function describeInboundDeliveryE2E(frame) {
  const payload = normalizeObject(frame?.payload);
  const encrypted = encryptedPayloadFromContainer(payload)
    || encryptedPayloadFromContainer(frame);
  const peerPublicKey = peerPublicKeyFromContainer(payload)
    || peerPublicKeyFromContainer(frame);
  return {
    frameType: normalizeText(frame?.type) || '-',
    payloadKeys: Object.keys(payload).sort(),
    payloadContentChars: normalizeText(payload.content).length,
    payloadEncrypted: Boolean(encryptedPayloadFromContainer(payload)),
    frameEncrypted: Boolean(encryptedPayloadFromContainer(frame)),
    hasEncrypted: Boolean(encrypted),
    peerKey: Boolean(peerPublicKey),
  };
}

function formatInboundE2EDiagnostics(diagnostics) {
  return [
    `frameType=${diagnostics.frameType}`,
    `payloadKeys=${diagnostics.payloadKeys.join(',') || '-'}`,
    `payloadContentChars=${diagnostics.payloadContentChars}`,
    `payloadEncrypted=${diagnostics.payloadEncrypted}`,
    `frameEncrypted=${diagnostics.frameEncrypted}`,
    `hasEncrypted=${diagnostics.hasEncrypted}`,
    `peerKey=${diagnostics.peerKey}`,
  ].join(' ');
}

function shouldLogOutboundE2EProbe(frame, emittedCount) {
  if (emittedCount <= 3) return true;
  const frameType = normalizeText(frame?.type);
  if (frameType === 'job.status' && normalizeText(frame?.phase).toLowerCase() === 'failed') return true;
  if (frameType === 'job.result' && frame?.done !== false) return true;
  return false;
}

function createOutboundE2EEncryptor(jobFrame, options = {}) {
  const peerPublicKey = normalizeText(jobFrame?.e2e?.peerPublicKey);
  if (!peerPublicKey) return null;
  const e2eCrypto = options.e2eCrypto;
  return (frame) => createEncryptedRelayFrame(frame, {
    crypto: e2eCrypto,
    peerPublicKeyBase64: peerPublicKey,
  });
}

function withRemotePermissionConfirmation(connectorOptions, remotePermissionConfirmer) {
  const options = normalizeObject(connectorOptions);
  return {
    ...options,
    remotePermissionConfirmer,
    confirmPermission: options.confirmPermission || remotePermissionConfirmer.confirm,
  };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeError(error) {
  return {
    code: normalizeText(error?.code) || 'desktop_connector_failed',
    message: normalizeText(error?.message) || String(error || 'Desktop Connector 处理 delivery 失败。'),
  };
}

function logGatewayQueueDebug(logger, message) {
  const writer = logger?.info || logger?.log;
  if (typeof writer === 'function') {
    writer.call(logger, message);
  }
}
