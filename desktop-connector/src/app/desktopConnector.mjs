import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';

import { createAgentRequest, createAgentResult } from '../agents/agentTypes.mjs';
import { executeShellCommand } from '../agents/localTools.mjs';
import {
  imageNeedsOutputUpload,
  outputUploadContextFromPayload,
  prepareOutputImagesForAndroid,
} from '../attachments/outputImageUploader.mjs';
import { callHermesChatCompletionsStream } from '../agents/hermesAgent.mjs';
import {
  createGptImage2CapabilityRegistry,
  selectLocalGptImage2Capability,
} from '../agents/gptImage2Agent.mjs';
import { callOpenClawChatCompletionsStream } from '../agents/openClawAgent.mjs';
import {
  createJobResultFrame,
  createJobStatusFrame,
} from '../protocol/frames.mjs';
import { createPermissionGate } from '../permissions/gate.mjs';
import { formatPermissionRequest } from '../permissions/policy.mjs';

const DEFAULT_AGENT_ID = 'hermes';
const DEFAULT_RUNNING_MESSAGE = 'Desktop Connector 正在处理任务';
const DEFAULT_AGENT_CALL_STARTED_MESSAGE = '已送到本地 Hermes，正在等待模型输出。';
const DEFAULT_LOCAL_GPT_IMAGE_2_STARTED_MESSAGE = '已切到本机 gpt-image-2，正在生成图片。';
const DEFAULT_LOCAL_GPT_IMAGE_2_EDIT_STARTED_MESSAGE = '已切到本机 gpt-image-2，正在根据输入图片生成。';
const DEFAULT_PERMISSION_CONFIRMATION_MESSAGE = '等待电脑确认敏感操作';
const DEFAULT_LOCAL_COMMAND_STARTED_MESSAGE = '检测到明确本地命令请求，正在等待权限确认。';
const DEFAULT_LOCAL_FILE_DELETE_STARTED_MESSAGE = '检测到明确本地文件删除请求，正在等待权限确认。';
const DEFAULT_STATUS_HEARTBEAT_MS = 15000;

export class ConnectorJobError extends Error {
  constructor(message, {
    code = 'connector_job_error',
    retriable = false,
  } = {}) {
    super(message);
    this.name = 'ConnectorJobError';
    this.code = code;
    this.retriable = Boolean(retriable);
  }
}

export async function handleJobCreatedFrame(frame, {
  agentId = DEFAULT_AGENT_ID,
  modelId,
  callAgent,
  callAgentOptions = {},
  resolveAttachments = null,
  emitFrame,
  onAgentDelta,
  runningMessage = DEFAULT_RUNNING_MESSAGE,
  permissionGate,
  permissionPolicy,
  confirmPermission,
  permissionDecisionStore,
  onPermissionDecision,
  onPermissionConfirmationRequired,
  permissionConfirmationMessage = DEFAULT_PERMISSION_CONFIRMATION_MESSAGE,
  streamDeltaFrames = true,
  statusHeartbeatMs = DEFAULT_STATUS_HEARTBEAT_MS,
  statusClock = Date.now,
  logger,
} = {}) {
  const job = normalizeJobCreatedFrame(frame);
  const outputUploadContext = outputUploadContextFromPayload(job.payload);
  const outputImageUploadCache = new Map();
  logConnectorDebug(
    logger,
    `Desktop Connector job auth job=${job.jobId} request=${job.requestId} ` +
      `payloadKeys=${Object.keys(job.payload).sort().join(',')} ` +
      `hasHermesBridgeOss=${Boolean(job.payload.hermesBridgeOss)} ` +
      `hasAccountOss=${Boolean(job.payload.accountOss)} ` +
      `hasTopLevelAccountApiBaseUrl=${Boolean(job.payload.accountApiBaseUrl)} ` +
      `hasTopLevelAccountSessionToken=${Boolean(job.payload.accountSessionToken)} ` +
      `hasUploadAuth=${Boolean(outputUploadContext)}`,
  );
  const emittedFrames = [];
  const emit = async (nextFrame) => {
    emittedFrames.push(nextFrame);
    if (typeof emitFrame === 'function') {
      await emitFrame(nextFrame);
    }
    return nextFrame;
  };

  const unsupported = validateJob(job);
  if (unsupported) {
    const { statusFrame, resultFrame } = await emitJobFailure(job, unsupported, emit);
    return {
      job,
      agentRequest: null,
      agentResult: null,
      statusFrame,
      resultFrame,
      frames: emittedFrames,
    };
  }

  const heartbeatState = createJobStatusHeartbeatState({
    clock: statusClock,
    initialMessage: runningMessage,
  });
  const statusFrame = await emit(createJobStatusFrame({
    jobId: job.jobId,
    requestId: job.requestId,
    conversationId: job.conversationId,
    targetDeviceId: job.fromDeviceId,
    phase: 'running',
    message: heartbeatState.currentMessage(),
  }));
  const stopStatusHeartbeat = startJobStatusHeartbeat({
    job,
    emit,
    emitFrame,
    intervalMs: statusHeartbeatMs,
    heartbeatState,
  });
  const jobPermissionGate = createJobPermissionGate({
    job,
    permissionGate,
    permissionPolicy,
    confirmPermission,
    permissionDecisionStore,
    onPermissionDecision,
    onPermissionConfirmationRequired,
    permissionConfirmationMessage,
    emit,
  });
  let agentRequest = null;
  let cleanupAttachments = async () => [];

  try {
    const attachmentResolution = job.payload.attachments.length
      ? await resolveJobAttachments(job.payload.attachments, {
        resolveJobAttachments: resolveAttachments,
        ...normalizeObject(callAgentOptions),
        job,
      })
      : { attachments: [], cleanup: async () => [] };
    const resolvedAttachments = normalizeResolvedAttachments(attachmentResolution);
    cleanupAttachments = typeof attachmentResolution.cleanup === 'function'
      ? attachmentResolution.cleanup
      : cleanupAttachments;

    agentRequest = createAgentRequest({
      agentId,
      modelId: modelId || job.payload.modelId,
      request: {
        sessionId: job.conversationId || job.requestId,
        modelId: modelId || job.payload.modelId,
        text: job.payload.content,
        attachments: resolvedAttachments,
      },
      metadata: {
        jobId: job.jobId,
        requestId: job.requestId,
        conversationId: job.conversationId,
        fromDeviceId: job.fromDeviceId,
      },
    });
    const customAgentCaller = typeof callAgent === 'function';
    const explicitFileDeleteIntent = agentRequest.attachments.length
      ? null
      : extractExplicitLocalFileDeleteIntent(agentRequest.text);
    const explicitCommandIntent = agentRequest.attachments.length
      || explicitFileDeleteIntent
      ? null
      : extractExplicitLocalCommandIntent(agentRequest.text);
    const localGptImage2Capability = customAgentCaller ? '' : selectLocalGptImage2Capability(agentRequest, {
      enabled: callAgentOptions?.localGptImage2 !== false,
    });
    const useLocalGptImage2 = Boolean(localGptImage2Capability);
    const localImageCapabilityRegistry = useLocalGptImage2 ? createGptImage2CapabilityRegistry() : null;
    const agentCaller = customAgentCaller
      ? callAgent
      : useLocalGptImage2
        ? (args) => localImageCapabilityRegistry.run({
          capability: localGptImage2Capability,
          text: agentRequest.text,
          attachments: agentRequest.attachments,
          metadata: agentRequest.metadata,
        }, args)
        : resolveAgentCall(agentId);
    heartbeatState.setBaseMessage(
      explicitFileDeleteIntent
        ? DEFAULT_LOCAL_FILE_DELETE_STARTED_MESSAGE
        : explicitCommandIntent
        ? DEFAULT_LOCAL_COMMAND_STARTED_MESSAGE
        : useLocalGptImage2
        ? localGptImage2Capability === 'image.edit'
          ? DEFAULT_LOCAL_GPT_IMAGE_2_EDIT_STARTED_MESSAGE
          : DEFAULT_LOCAL_GPT_IMAGE_2_STARTED_MESSAGE
        : DEFAULT_AGENT_CALL_STARTED_MESSAGE,
    );
    await emit(createJobStatusFrame({
      jobId: job.jobId,
      requestId: job.requestId,
      conversationId: job.conversationId,
      targetDeviceId: job.fromDeviceId,
      phase: 'processing',
      message: heartbeatState.currentMessage(),
    }));
    const onDelta = createAgentDeltaHandler({
      job,
      emit,
      userOnDelta: onAgentDelta || callAgentOptions?.onDelta,
      streamDeltaFrames,
      outputUploadContext,
      outputImageUploadCache,
      fetchImpl: callAgentOptions?.fetchImpl || globalThis.fetch,
      readFileImpl: callAgentOptions?.readFileImpl,
      allowedLocalImageRoots: callAgentOptions?.allowedLocalImageRoots,
      logger,
    });
    const rawResult = explicitFileDeleteIntent
      ? await runExplicitLocalFileDeleteIntent(explicitFileDeleteIntent, {
        permissionGate: jobPermissionGate,
        deleteFile: callAgentOptions?.deleteFile,
        logger,
        job,
      })
      : explicitCommandIntent
      ? await runExplicitLocalCommandIntent(explicitCommandIntent, {
        permissionGate: jobPermissionGate,
        executeCommand: callAgentOptions?.executeCommand,
        commandTimeoutMs: callAgentOptions?.commandTimeoutMs,
        commandMaxOutputChars: callAgentOptions?.commandMaxOutputChars,
        logger,
        job,
      })
      : await agentCaller({
        ...normalizeObject(callAgentOptions),
        agentRequest,
        permissionGate: jobPermissionGate,
        authorizePermission: jobPermissionGate.authorize,
        onDelta,
      });
    const agentResult = createAgentResult(rawResult);
    logConnectorDebug(
      logger,
      `Desktop Connector agent result job=${job.jobId} request=${job.requestId} ` +
        `contentChars=${agentResult.content.length} rawImages=${agentResult.images.length} ` +
        `preview=${debugPreview(agentResult.content)} firstRawImage=${debugImageSummary(agentResult.images[0])}`,
    );
    const resultImages = await prepareOutputImagesForAndroid(agentResult.images, {
      uploadContext: outputUploadContext,
      fetchImpl: callAgentOptions?.fetchImpl || globalThis.fetch,
      cache: outputImageUploadCache,
      readFileImpl: callAgentOptions?.readFileImpl,
      allowedLocalImageRoots: callAgentOptions?.allowedLocalImageRoots,
    });
    logConnectorDebug(
      logger,
      `Desktop Connector prepared output images job=${job.jobId} request=${job.requestId} ` +
        `hasUploadAuth=${Boolean(outputUploadContext)} rawImages=${agentResult.images.length} ` +
        `preparedImages=${resultImages.length} firstPreparedImage=${debugImageSummary(resultImages[0])}`,
    );
    const resultArtifacts = syncImageArtifactsWithPreparedImages(agentResult.artifacts || [], resultImages);
    const resultFrame = await emit(createJobResultFrame({
      jobId: job.jobId,
      requestId: job.requestId,
      conversationId: job.conversationId,
      targetDeviceId: job.fromDeviceId,
      done: agentResult.done,
      content: agentResult.content,
      modelId: agentResult.modelId || agentResult.model,
      images: resultImages,
      artifacts: resultArtifacts,
      files: agentResult.files || [],
      error: agentResult.error || undefined,
    }));

    return {
      job,
      agentRequest,
      agentResult,
      statusFrame,
      resultFrame,
      frames: emittedFrames,
    };
  } catch (error) {
    const { statusFrame: failedStatusFrame, resultFrame } = await emitJobFailure(job, error, emit);
    return {
      job,
      agentRequest,
      agentResult: null,
      statusFrame: failedStatusFrame,
      resultFrame,
      frames: emittedFrames,
    };
  } finally {
    stopStatusHeartbeat();
    await cleanupAttachments().catch(() => {});
  }
}

async function resolveJobAttachments(attachments, options = {}) {
  const customResolver = typeof options.resolveAttachments === 'function'
    ? options.resolveAttachments
    : options.resolveJobAttachments;
  if (typeof customResolver === 'function') {
    return customResolver(attachments, options);
  }

  const attachmentModule = await import('../attachments/jobAttachments.mjs');
  const defaultResolver = attachmentModule.resolveJobAttachments || attachmentModule.resolveGatewayAttachments;
  return defaultResolver(attachments, options);
}

function createAgentDeltaHandler({
  job,
  emit,
  userOnDelta,
  streamDeltaFrames = true,
  outputUploadContext,
  outputImageUploadCache,
  fetchImpl = globalThis.fetch,
  readFileImpl,
  allowedLocalImageRoots,
  logger,
} = {}) {
  return async (event = {}) => {
    if (typeof userOnDelta === 'function') {
      await userOnDelta(event);
    }
    if (!streamDeltaFrames) return;

    const content = typeof event?.content === 'string' ? event.content : normalizeText(event?.content);
    const rawImages = cloneList(event?.images);
    if (content.trim() || rawImages.length) {
      logConnectorDebug(
        logger,
        `Desktop Connector agent delta job=${job.jobId} request=${job.requestId} ` +
          `contentChars=${content.length} rawImages=${rawImages.length} ` +
          `preview=${debugPreview(content)} firstRawImage=${debugImageSummary(rawImages[0])}`,
      );
    }
    const images = rawImages.some((image) => imageNeedsOutputUpload(image))
      ? await prepareOutputImagesForAndroid(rawImages, {
        uploadContext: outputUploadContext,
        fetchImpl,
        cache: outputImageUploadCache,
        readFileImpl,
        allowedLocalImageRoots,
      })
      : rawImages;
    const artifacts = syncImageArtifactsWithPreparedImages(cloneList(event?.artifacts), images);
    if (!content.trim() && images.length === 0 && artifacts.length === 0) return;

    await emit(createJobResultFrame({
      jobId: job.jobId,
      requestId: job.requestId,
      conversationId: job.conversationId,
      targetDeviceId: job.fromDeviceId,
      done: false,
      content,
      modelId: normalizeText(event?.modelId) || normalizeText(event?.model),
      images,
      artifacts,
      files: [],
    }));
  };
}

function startJobStatusHeartbeat({
  job,
  emit,
  emitFrame,
  intervalMs,
  heartbeatState,
} = {}) {
  if (typeof emitFrame !== 'function') return () => {};
  const resolvedIntervalMs = positiveInteger(intervalMs, 0);
  if (!resolvedIntervalMs) return () => {};

  const timer = setInterval(() => {
    emit(createJobStatusFrame({
      jobId: job.jobId,
      requestId: job.requestId,
      conversationId: job.conversationId,
      targetDeviceId: job.fromDeviceId,
      phase: 'processing',
      message: heartbeatState?.currentMessage?.() || DEFAULT_AGENT_CALL_STARTED_MESSAGE,
    })).catch(() => {});
  }, resolvedIntervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return () => clearInterval(timer);
}

function createJobStatusHeartbeatState({
  clock = Date.now,
  initialMessage = DEFAULT_RUNNING_MESSAGE,
} = {}) {
  const startedAt = Number(clock()) || Date.now();
  let baseMessage = normalizeText(initialMessage) || DEFAULT_RUNNING_MESSAGE;
  return {
    setBaseMessage(message) {
      baseMessage = normalizeText(message) || baseMessage;
    },
    currentMessage() {
      const elapsedMs = Math.max(0, (Number(clock()) || Date.now()) - startedAt);
      return buildRunningStatusMessage(baseMessage, elapsedMs);
    },
  };
}

function buildRunningStatusMessage(baseMessage, elapsedMs) {
  const elapsedText = formatElapsedChinese(elapsedMs);
  if (elapsedMs >= 120000) {
    return `${baseMessage} 已等待 ${elapsedText}，长回复仍在继续。`;
  }
  if (elapsedMs >= 60000) {
    return `${baseMessage} 已等待 ${elapsedText}，还在处理。`;
  }
  if (elapsedMs >= 15000) {
    return `${baseMessage} 已等待 ${elapsedText}。`;
  }
  return baseMessage;
}

function formatElapsedChinese(elapsedMs) {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes} 分 ${seconds} 秒`;
  }
  return `${totalSeconds} 秒`;
}

export async function handleClaimedJobDelivery(claimedDelivery, options = {}) {
  const delivery = normalizeClaimedGatewayDelivery(claimedDelivery);
  const connectorOptions = normalizeObject(options);
  delete connectorOptions.emitFrame;

  try {
    const result = await handleJobCreatedFrame(delivery.frame, connectorOptions);
    const disposition = classifyJobDeliveryDisposition(result);
    const framesToEmit = selectFramesForDeliveryDisposition(result.frames, disposition);
    return {
      ...result,
      delivery,
      disposition,
      framesToEmit,
    };
  } catch (error) {
    const normalizedError = normalizeError(error);
    return {
      delivery,
      job: null,
      agentRequest: null,
      agentResult: null,
      statusFrame: null,
      resultFrame: null,
      frames: [],
      framesToEmit: [],
      disposition: normalizedError.retriable ? 'release' : 'failed',
      error: normalizedError,
    };
  }
}

export function normalizeClaimedGatewayDelivery(claimedDelivery) {
  if (!claimedDelivery || typeof claimedDelivery !== 'object' || Array.isArray(claimedDelivery)) {
    throw new ConnectorJobError('Gateway claimed delivery 不是对象。', {
      code: 'invalid_claimed_delivery',
      retriable: false,
    });
  }

  const messageId = normalizeText(claimedDelivery.messageId);
  const envelope = normalizeObject(claimedDelivery.delivery);
  const frame = claimedDelivery.frame || envelope.frame;
  if (!messageId) {
    throw new ConnectorJobError('Gateway claimed delivery 缺少 messageId。', {
      code: 'missing_delivery_message_id',
      retriable: false,
    });
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new ConnectorJobError('Gateway claimed delivery 缺少 job frame。', {
      code: 'missing_delivery_frame',
      retriable: false,
    });
  }

  return {
    messageId,
    state: normalizeText(claimedDelivery.state),
    queueKey: normalizeText(claimedDelivery.queueKey) || normalizeText(envelope.queueKey),
    requestId: normalizeText(claimedDelivery.requestId) || normalizeText(envelope.requestId),
    attempts: Number.isFinite(Number(claimedDelivery.attempts))
      ? Number(claimedDelivery.attempts)
      : 0,
    frame: cloneFrame(frame),
    delivery: envelope.frame
      ? {
        ...envelope,
        frame: cloneFrame(envelope.frame),
      }
      : null,
  };
}

export function classifyJobDeliveryDisposition(result) {
  const error = getJobDeliveryError(result);
  if (!error) return 'ack';
  return error.retriable ? 'release' : 'failed';
}

export function selectFramesForDeliveryDisposition(frames, disposition) {
  const normalizedDisposition = normalizeText(disposition);
  const clonedFrames = cloneFrameList(frames);
  if (normalizedDisposition !== 'release') return clonedFrames;

  return clonedFrames.filter((frame) => normalizeText(frame.type) !== 'job.result');
}

export function resolveAgentCall(agentId = DEFAULT_AGENT_ID) {
  const normalizedAgentId = normalizeText(agentId).toLowerCase();
  if (normalizedAgentId === 'openclaw') return callOpenClawChatCompletionsStream;
  return callHermesChatCompletionsStream;
}

export function normalizeJobCreatedFrame(frame) {
  if (!frame || typeof frame !== 'object') {
    throw new ConnectorJobError('Desktop Connector 收到的任务不是对象。', {
      code: 'invalid_job_frame',
    });
  }
  if (normalizeText(frame.type) !== 'job.created') {
    throw new ConnectorJobError('Desktop Connector 目前只处理 job.created frame。', {
      code: 'unsupported_frame_type',
    });
  }

  const payload = normalizeObject(frame.payload);
  const jobId = normalizeText(frame.jobId);
  const requestId = normalizeText(frame.requestId);
  const content = normalizeText(payload.content);
  if (!jobId || !requestId) {
    throw new ConnectorJobError('job.created 缺少 jobId 或 requestId。', {
      code: 'invalid_job_ids',
    });
  }

  const normalizedPayload = {
    content,
    attachments: cloneList(payload.attachments),
    modelId: normalizeText(payload.modelId) || normalizeText(payload.model),
  };
  const hermesBridgeOss = cloneObject(payload.hermesBridgeOss);
  if (hermesBridgeOss) normalizedPayload.hermesBridgeOss = hermesBridgeOss;
  const accountOss = cloneObject(payload.accountOss);
  if (accountOss) normalizedPayload.accountOss = accountOss;
  const accountApiBaseUrl = normalizeText(payload.accountApiBaseUrl);
  if (accountApiBaseUrl) normalizedPayload.accountApiBaseUrl = accountApiBaseUrl;
  const accountSessionToken = normalizeText(payload.accountSessionToken);
  if (accountSessionToken) normalizedPayload.accountSessionToken = accountSessionToken;

  return {
    type: 'job.created',
    version: Number.isFinite(Number(frame.version)) ? Number(frame.version) : 3,
    jobId,
    requestId,
    conversationId: normalizeText(frame.conversationId),
    fromDeviceId: normalizeText(frame.fromDeviceId),
    payload: normalizedPayload,
  };
}

function validateJob(job) {
  if (!job.payload.content && !job.payload.attachments.length) {
    return new ConnectorJobError('Desktop Connector 需要 content 或附件引用。', {
      code: 'empty_content',
      retriable: false,
    });
  }
  return null;
}

function extractExplicitLocalFileDeleteIntent(value) {
  const text = normalizeText(value).replace(/\r\n/g, '\n');
  if (!text || text.length > 4000) return null;
  if (!looksLikeExplicitFileDeleteRequest(text)) return null;
  if (looksLikeLocalFileDeleteNegation(text) || looksLikeLocalFileDeleteDiscussion(text)) return null;

  const path = selectExplicitLocalPathCandidate(text);
  if (!path) return null;

  return {
    path,
    intent: `删除用户明确指定的本地文件：${path}`,
  };
}

async function runExplicitLocalFileDeleteIntent(intent, {
  permissionGate,
  deleteFile,
  logger,
  job,
} = {}) {
  if (typeof permissionGate?.requireAllowed !== 'function') {
    throw new Error('显式本地文件删除缺少权限确认入口。');
  }

  const path = normalizeText(intent?.path);
  logConnectorDebug(
    logger,
    `Desktop Connector explicit local file delete route job=${job?.jobId || ''} ` +
      `request=${job?.requestId || ''} path=${debugPreview(path, 160)}`,
  );

  await permissionGate.requireAllowed({
    operation: 'file.delete',
    path,
    target: path,
    intent: normalizeText(intent?.intent) || '删除用户明确指定的本地文件。',
    requestedBy: 'desktop-connector-explicit-file-delete',
    metadata: {
      route: 'explicit-local-file-delete',
    },
  }, {
    route: 'explicit-local-file-delete',
  });

  const deleter = typeof deleteFile === 'function' ? deleteFile : deleteLocalFile;
  const result = await deleter({ path });
  return {
    content: formatLocalFileDeleteResult({ path, result }),
    model: 'desktop-connector-local-file-delete',
    done: true,
  };
}

function looksLikeExplicitFileDeleteRequest(text) {
  return /(?:删除|删掉|删了|移除|清理掉|delete\b|remove\b)/i.test(text)
    && /(?:~\/|\/Users\/|\/private\/tmp\/|\/tmp\/)/.test(text);
}

function looksLikeLocalFileDeleteNegation(text) {
  return /(?:不要|别|先别|不用|无需|不需要)[^，。；;\n]{0,40}(?:删除|删掉|删了|移除|delete\b|remove\b)/i.test(text);
}

function looksLikeLocalFileDeleteDiscussion(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /(?:如果|假如|解释|说明|讲讲|风险|会发生什么|为什么|原因|是否|可以.*吗|能不能|是什么|是什么意思|怎么|如何|写一段|生成|示例|例子|包含|别真的|不要真的|不要实际)/i.test(normalized)
    || /[？?]\s*$/.test(normalized);
}

function selectExplicitLocalPathCandidate(text) {
  const backtick = firstMatchingLocalPath(text.matchAll(/`([^`\n]{1,1000})`/g));
  if (backtick) return backtick;

  const quoted = firstMatchingLocalPath(text.matchAll(/["'“”‘’]((?:~\/|\/)[^"'“”‘’\n]{1,1000})["'“”‘’]/g));
  if (quoted) return quoted;

  const plain = firstMatchingLocalPath(text.matchAll(/(^|[\s:：\n])((?:~\/|\/)[^\s`"'，。；;！？?<>]{1,1000})/gm), 2);
  return plain;
}

function firstMatchingLocalPath(matches, groupIndex = 1) {
  for (const match of matches) {
    const path = normalizeLocalFilePathCandidate(match?.[groupIndex]);
    if (path) return path;
  }
  return '';
}

function normalizeLocalFilePathCandidate(value) {
  let text = normalizeText(value);
  if (!text) return '';
  text = text
    .replace(/^file:\/\//i, '')
    .replace(/[，。；;！？?]+$/g, '')
    .trim();
  if (text.startsWith('~/')) {
    text = `${homedir()}${text.slice(1)}`;
  }
  if (!text.startsWith('/')) return '';
  if (/[\u0000-\u001f]/.test(text)) return '';
  const withoutTrailingSlash = text.replace(/\/+$/g, '');
  const protectedPaths = new Set([
    '',
    '/',
    homedir(),
    `${homedir()}/Desktop`,
    `${homedir()}/Documents`,
    '/Users',
    '/tmp',
    '/private/tmp',
  ]);
  if (protectedPaths.has(withoutTrailingSlash)) return '';
  return withoutTrailingSlash;
}

async function deleteLocalFile({ path } = {}) {
  const normalizedPath = normalizeText(path);
  try {
    await unlink(normalizedPath);
    return {
      ok: true,
      path: normalizedPath,
    };
  } catch (error) {
    return {
      ok: false,
      path: normalizedPath,
      code: normalizeText(error?.code),
      error: normalizeText(error?.message) || '文件删除失败。',
    };
  }
}

function extractExplicitLocalCommandIntent(value) {
  const text = normalizeText(value).replace(/\r\n/g, '\n');
  if (!text || text.length > 4000) return null;
  const explicitRequest = looksLikeExplicitCommandRequest(text);
  if (looksLikeCommandNegation(text) || looksLikeCommandDiscussion(text)) return null;

  const command = selectExplicitCommandCandidate(text, { explicitRequest });
  if (!command) return null;

  return {
    command,
    cwd: inferExplicitCommandCwd(text),
    intent: `执行用户明确请求的本地命令：${command}`,
  };
}

async function runExplicitLocalCommandIntent(intent, {
  permissionGate,
  executeCommand,
  commandTimeoutMs,
  commandMaxOutputChars,
  logger,
  job,
} = {}) {
  if (typeof permissionGate?.requireAllowed !== 'function') {
    throw new Error('显式本地命令缺少权限确认入口。');
  }

  const command = normalizeText(intent?.command);
  const cwd = resolveLocalCommandCwd(intent?.cwd);
  logConnectorDebug(
    logger,
    `Desktop Connector explicit local command route job=${job?.jobId || ''} ` +
      `request=${job?.requestId || ''} command=${debugPreview(command, 120)} cwd=${debugPreview(cwd, 120)}`,
  );

  await permissionGate.requireAllowed({
    operation: 'command.execute',
    command,
    directory: cwd,
    intent: normalizeText(intent?.intent) || '执行用户明确请求的本地命令。',
    requestedBy: 'desktop-connector-explicit-command',
    metadata: {
      route: 'explicit-local-command',
    },
  }, {
    route: 'explicit-local-command',
  });

  const executor = typeof executeCommand === 'function' ? executeCommand : executeShellCommand;
  const result = await executor({
    command,
    cwd,
    timeoutMs: positiveInteger(commandTimeoutMs, undefined),
    maxOutputChars: positiveInteger(commandMaxOutputChars, undefined),
  });
  return {
    content: formatLocalCommandResult({ command, cwd, result }),
    model: 'desktop-connector-local-command',
    done: true,
  };
}

function looksLikeExplicitCommandRequest(text) {
  return /(?:执行|运行|跑)(?:一下|一次|下)?(?:这个|这条|本地|电脑|终端|shell)?\s*(?:命令|command)\b/i.test(text)
    || /(?:命令|command)\s*(?:内容)?\s*[:：]/i.test(text)
    || /(?:命令|command)\s*(?:是|为|=)\s*/i.test(text)
    || /(?:终端|shell|terminal)\s*[:：]/i.test(text)
    || /(?:执行|运行|跑|输入|敲|打)(?:一下|一次|下)?\s*[:：]/i.test(text)
    || /(?:run|execute)\s+(?:this\s+)?(?:local\s+|desktop\s+|shell\s+)?command\b/i.test(text)
    || /(?:在|到)\s*(?:桌面|Desktop|电脑|本机|本地)[^，。；;\n]{0,40}(?:执行|运行|跑)(?:一下|一次|下)?/i.test(text);
}

function looksLikeCommandNegation(text) {
  return /(?:不要|别|先别|不用|无需|不需要)[^，。；;\n]{0,30}(?:执行|运行|跑)[^，。；;\n]{0,20}(?:命令|command)?/i.test(text);
}

function looksLikeCommandDiscussion(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (isSingleFencedCommand(normalized) || isSingleInlineCommand(normalized)) return false;
  if (extractLabeledCommand(normalized)) return false;
  return /(?:如果|假如|解释|说明|讲讲|风险|会发生什么|会不会|是否|可以.*吗|能不能|是什么|是什么意思|怎么|如何|写一段|生成|示例|例子|包含|别真的|不要真的|不要实际)/i.test(normalized)
    || /[？?]\s*$/.test(normalized);
}

function extractBareShellCommand(text) {
  const normalized = cleanCommandCandidate(text);
  if (!normalized || normalized.includes('\n')) return '';
  const singleInline = normalized.match(/^`([^`\n]{1,500})`$/);
  if (singleInline) return singleInline[1];
  if (/[。？?！!，、：；]/.test(normalized)) return '';
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:[A-Za-z0-9_./~-]+)(?:\s+.+)?$/.test(normalized)) return '';
  if (!hasKnownShellCommandStart(normalized)) return '';
  return normalized;
}

function selectExplicitCommandCandidate(text, { explicitRequest = false } = {}) {
  const candidates = [
    {
      command: extractFencedCommand(text),
      requireKnownStart: !explicitRequest,
      allowWithoutExplicitRequest: isSingleFencedCommand(text),
    },
    {
      command: extractInlineCommand(text),
      requireKnownStart: !explicitRequest,
      allowWithoutExplicitRequest: isSingleInlineCommand(text),
    },
    {
      command: extractLabeledCommand(text),
      requireKnownStart: false,
    },
    {
      command: extractVerbCommand(text),
      requireKnownStart: true,
      allowWithoutExplicitRequest: true,
    },
    {
      command: extractBareShellCommand(text),
      requireKnownStart: true,
      allowWithoutExplicitRequest: true,
    },
  ];

  for (const candidate of candidates) {
    if (!explicitRequest && !candidate.allowWithoutExplicitRequest) continue;
    const command = cleanCommandCandidate(candidate.command);
    if (!isLikelyShellCommand(command)) continue;
    if (candidate.requireKnownStart && !hasKnownShellCommandStart(command)) continue;
    return command;
  }
  return '';
}

function extractFencedCommand(text) {
  const match = text.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]{1,1000}?)\n```/);
  return match ? match[1] : '';
}

function isSingleFencedCommand(text) {
  return /^```(?:[a-zA-Z0-9_-]+)?\n[\s\S]{1,1000}?\n```$/.test(normalizeText(text));
}

function isSingleInlineCommand(text) {
  return /^`[^`\n]{1,500}`$/.test(normalizeText(text));
}

function extractInlineCommand(text) {
  for (const match of text.matchAll(/`([^`\n]{1,500})`/g)) {
    const candidate = cleanCommandCandidate(match[1]);
    if (isLikelyShellCommand(candidate)) return candidate;
  }
  return '';
}

function extractLabeledCommand(text) {
  const match = text.match(/(?:执行|运行|跑)?\s*(?:本地|电脑|桌面|终端|shell)?\s*(?:命令|command|cmd|终端|terminal|shell)\s*(?:内容)?\s*(?:[:：=]|是|为)\s*([^\n，。；;]+)/i);
  return match ? match[1] : '';
}

function extractVerbCommand(text) {
  const chinese = text.match(/(?:请|麻烦|帮我)?\s*(?:在|用)?\s*(?:本地|本机|电脑|桌面|终端|shell|Terminal)?(?:上|里|中)?\s*(?:执行|运行|跑|输入|敲|打)\s*(?:一下|一次|下)?\s*(?:这个|这条|本地|电脑|桌面|终端|shell)?\s*(?:命令|command)?\s*[:：]?\s*([^\n，。；;]+)/i);
  if (chinese) return chinese[1];
  const english = text.match(/(?:please\s+)?(?:run|execute|type)\s+(?:this\s+)?(?:local\s+|desktop\s+|shell\s+|terminal\s+)?(?:command\s*[:=]?\s*)?([^\n.;]+)/i);
  return english ? english[1] : '';
}

function cleanCommandCandidate(value) {
  let text = normalizeText(value);
  if (!text) return '';
  text = text
    .replace(/^```(?:[a-zA-Z0-9_-]+)?\n?/, '')
    .replace(/\n?```$/, '')
    .replace(/^\s*(?:[$#%❯➜]\s*)?/, '')
    .replace(/^(?:一?条|这个|这条|命令|command|内容|为|是)\s*[:：]?\s*/i, '')
    .replace(/[，。；;]+$/g, '')
    .trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function isLikelyShellCommand(command) {
  const text = normalizeText(command);
  if (!text || text.length > 1000) return false;
  if (/[\u0000-\u001f]/.test(text.replace(/\n/g, ''))) return false;
  const firstLine = text.split('\n').find((line) => line.trim()) || '';
  const firstToken = firstLine.trim().split(/\s+/)[0] || '';
  if (!firstToken || /[\u4e00-\u9fff]/.test(firstToken)) return false;
  return /[A-Za-z_./~-]/.test(firstToken);
}

function hasKnownShellCommandStart(command) {
  const token = firstExecutableToken(command);
  if (!token) return false;
  const commandName = token.split('/').pop();
  return new Set([
    'adb',
    'awk',
    'bash',
    'brew',
    'bun',
    'cargo',
    'cat',
    'cd',
    'chmod',
    'chown',
    'cp',
    'curl',
    'date',
    'deno',
    'df',
    'docker',
    'docker-compose',
    'du',
    'echo',
    'env',
    'false',
    'find',
    'git',
    'go',
    'gradle',
    'gradlew',
    'grep',
    'head',
    'hostname',
    'id',
    'java',
    'javac',
    'jq',
    'kill',
    'less',
    'ln',
    'lsof',
    'make',
    'ls',
    'mkdir',
    'mv',
    'netstat',
    'node',
    'npm',
    'npx',
    'open',
    'osascript',
    'perl',
    'pip',
    'pip3',
    'pnpm',
    'printf',
    'ps',
    'pwd',
    'python',
    'python3',
    'ruby',
    'rsync',
    'rg',
    'rm',
    'rmdir',
    'rtk',
    'sed',
    'sh',
    'sleep',
    'stat',
    'sw_vers',
    'tail',
    'tar',
    'tee',
    'test',
    'touch',
    'true',
    'uname',
    'unzip',
    'vim',
    'wc',
    'which',
    'whoami',
    'xargs',
    'yarn',
    'zip',
  ]).has(commandName);
}

function firstExecutableToken(command) {
  const tokens = normalizeText(command).split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.+/.test(tokens[index])) {
    index += 1;
  }
  if (tokens[index] === 'env') {
    index += 1;
    while (index < tokens.length && (/^-[A-Za-z]/.test(tokens[index]) || /^[A-Za-z_][A-Za-z0-9_]*=.+/.test(tokens[index]))) {
      index += 1;
    }
  }
  return normalizeText(tokens[index]).replace(/^command$/, '');
}

function inferExplicitCommandCwd(text) {
  if (/(?:桌面目录|桌面|Desktop)/i.test(text)) {
    return `${homedir()}/Desktop`;
  }

  const quotedPath = text.match(/(?:在|到)\s*`([^`\n]+)`\s*(?:目录|文件夹|路径|下)?[^，。；;\n]{0,20}(?:执行|运行|跑)/i);
  const plainPath = text.match(/(?:在|到)\s*((?:~\/|\/)[^，。；;\n\s]+)\s*(?:目录|文件夹|路径|下)?[^，。；;\n]{0,20}(?:执行|运行|跑)/i);
  return normalizeText(quotedPath?.[1] || plainPath?.[1]);
}

function resolveLocalCommandCwd(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return `${homedir()}${text.slice(1)}`;
  return text;
}

function formatLocalCommandResult({ command, cwd, result } = {}) {
  const normalizedResult = normalizeObject(result);
  const stdout = stripTrailingWhitespace(normalizedResult.stdout);
  const stderr = stripTrailingWhitespace(normalizedResult.stderr);
  const error = normalizeText(normalizedResult.error);
  const exitCode = normalizedResult.exitCode === undefined || normalizedResult.exitCode === null
    ? ''
    : String(normalizedResult.exitCode);
  const sections = [
    `${normalizedResult.ok === false ? '命令执行完成，但返回失败' : '命令已执行'}：${normalizeText(command)}`,
  ];
  if (cwd) sections.push(`目录：${cwd}`);
  if (exitCode) sections.push(`退出码：${exitCode}`);
  if (stdout) sections.push(`stdout:\n${stdout}`);
  if (stderr) sections.push(`stderr:\n${stderr}`);
  if (error) sections.push(`error:\n${error}`);
  if (!stdout && !stderr && !error) sections.push('没有输出。');
  return sections.join('\n\n');
}

function formatLocalFileDeleteResult({ path, result } = {}) {
  const normalizedResult = normalizeObject(result);
  const targetPath = normalizeText(path) || normalizeText(normalizedResult.path);
  const error = normalizeText(normalizedResult.error);
  const code = normalizeText(normalizedResult.code);
  if (normalizedResult.ok === false) {
    return [
      `文件删除失败：${targetPath}`,
      code ? `错误码：${code}` : '',
      error ? `error:\n${error}` : '',
    ].filter(Boolean).join('\n\n');
  }
  return `文件已删除：${targetPath}`;
}

function stripTrailingWhitespace(value) {
  return typeof value === 'string' ? value.replace(/\s+$/g, '') : normalizeText(value);
}

function createJobPermissionGate({
  job,
  permissionGate,
  permissionPolicy,
  confirmPermission,
  permissionDecisionStore,
  onPermissionDecision,
  onPermissionConfirmationRequired,
  permissionConfirmationMessage,
  emit,
}) {
  const jobContext = {
    jobId: job.jobId,
    requestId: job.requestId,
    conversationId: job.conversationId,
    fromDeviceId: job.fromDeviceId,
    emitFrame: emit,
  };
  const gate = permissionGate || createPermissionGate({
    policy: permissionPolicy,
    confirmPermission,
    decisionStore: permissionDecisionStore,
    onDecision: onPermissionDecision,
    onConfirmationRequired: async (event) => {
      if (typeof onPermissionConfirmationRequired === 'function') {
        await onPermissionConfirmationRequired(event);
      }
      await emit(createJobStatusFrame({
        jobId: job.jobId,
        requestId: job.requestId,
        conversationId: job.conversationId,
        targetDeviceId: job.fromDeviceId,
        phase: 'waiting_confirmation',
        message: buildPermissionConfirmationMessage(event.request, permissionConfirmationMessage),
      }));
    },
  });
  return wrapPermissionGateWithContext(gate, jobContext);
}

function wrapPermissionGateWithContext(gate, jobContext) {
  const wrapped = { ...normalizeObject(gate) };
  const decide = typeof gate?.decide === 'function' ? gate.decide.bind(gate) : null;
  const authorize = firstFunction(
    gate?.authorize,
    gate?.requireAllowed,
    gate?.enforce,
  )?.bind(gate);
  const run = firstFunction(gate?.run, gate?.gate)?.bind(gate);

  if (decide) {
    wrapped.decide = (request, context = {}) => decide(request, mergePermissionContext(jobContext, context));
  }
  if (authorize) {
    wrapped.authorize = (request, context = {}) => authorize(request, mergePermissionContext(jobContext, context));
    wrapped.requireAllowed = wrapped.authorize;
    wrapped.enforce = wrapped.authorize;
  }
  if (run) {
    wrapped.run = (request, action, context = {}) => run(request, action, mergePermissionContext(jobContext, context));
    wrapped.gate = wrapped.run;
  } else if (authorize) {
    wrapped.run = async (request, action, context = {}) => {
      const decision = await wrapped.authorize(request, context);
      if (typeof action !== 'function') return decision;
      return await action(decision);
    };
    wrapped.gate = wrapped.run;
  }
  return wrapped;
}

function buildPermissionConfirmationMessage(request, message) {
  const prefix = normalizeText(message) || DEFAULT_PERMISSION_CONFIRMATION_MESSAGE;
  const summary = formatPermissionRequest(request);
  return summary ? `${prefix}：${summary}` : prefix;
}

function mergePermissionContext(jobContext, context) {
  return {
    ...jobContext,
    ...normalizeObject(context),
  };
}

function firstFunction(...values) {
  return values.find((value) => typeof value === 'function') || null;
}

async function emitJobFailure(job, error, emit) {
  const normalizedError = normalizeError(error);
  const statusFrame = await emit(createJobStatusFrame({
    jobId: job.jobId,
    requestId: job.requestId,
    conversationId: job.conversationId,
    targetDeviceId: job.fromDeviceId,
    phase: 'failed',
    message: normalizedError.message,
  }));
  const resultFrame = await emit(createJobResultFrame({
    jobId: job.jobId,
    requestId: job.requestId,
    conversationId: job.conversationId,
    targetDeviceId: job.fromDeviceId,
    done: true,
    content: '',
    images: [],
    files: [],
    error: normalizedError,
  }));
  return { statusFrame, resultFrame };
}

function normalizeError(error) {
  const normalized = {
    code: normalizeText(error?.code) || 'agent_failed',
    message: normalizeText(error?.message) || String(error || 'Agent 调用失败。'),
    retriable: Boolean(error?.retriable),
  };
  const route = normalizeText(error?.route);
  const capability = normalizeText(error?.capability);
  const provider = normalizeText(error?.provider);
  if (route) normalized.route = route;
  if (capability) normalized.capability = capability;
  if (provider) normalized.provider = provider;
  if (error?.diagnostic && typeof error.diagnostic === 'object' && !Array.isArray(error.diagnostic)) {
    normalized.diagnostic = { ...error.diagnostic };
  }
  return normalized;
}

function normalizeResolvedAttachments(resolution) {
  if (Array.isArray(resolution)) return resolution;
  if (resolution && typeof resolution === 'object' && Array.isArray(resolution.attachments)) {
    return resolution.attachments;
  }
  return [];
}

function cloneList(value) {
  return Array.isArray(value) ? value.map((item) => cloneObject(item)) : [];
}

function cloneFrameList(value) {
  return Array.isArray(value) ? value.map((item) => cloneFrame(item)) : [];
}

function cloneObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
}

function cloneFrame(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : value;
}

function syncImageArtifactsWithPreparedImages(artifacts, images) {
  const normalizedArtifacts = cloneList(artifacts);
  const normalizedImages = cloneList(images);
  if (!normalizedImages.length) return normalizedArtifacts;
  if (!normalizedArtifacts.length) {
    return normalizedImages.map((image, index) => imageArtifactFromImage(image, index));
  }
  const byId = new Map(normalizedImages.map((image) => [normalizeText(image.id), image]));
  return normalizedArtifacts.map((artifact, index) => {
    if (normalizeText(artifact.type) !== 'image') return artifact;
    const image = byId.get(normalizeText(artifact.id)) || normalizedImages[index];
    if (!image) return artifact;
    return {
      ...artifact,
      url: normalizeText(image.url || image.remoteUrl) || normalizeText(artifact.url),
      objectKey: normalizeText(image.objectKey) || normalizeText(artifact.objectKey),
      mimeType: normalizeText(image.mimeType) || normalizeText(artifact.mimeType) || 'image/png',
      name: normalizeText(image.name) || normalizeText(artifact.name),
    };
  });
}

function imageArtifactFromImage(image, index) {
  const id = normalizeText(image.id) || `image-artifact-${index + 1}`;
  return Object.fromEntries(Object.entries({
    id,
    type: 'image',
    name: normalizeText(image.name) || `${id}.png`,
    mimeType: normalizeText(image.mimeType) || 'image/png',
    url: normalizeText(image.url || image.remoteUrl),
    objectKey: normalizeText(image.objectKey),
    localPath: normalizeText(image.localPath),
  }).filter(([, value]) => value));
}

function logConnectorDebug(logger, message) {
  const writer = logger?.info || logger?.log;
  if (typeof writer === 'function') {
    writer.call(logger, message);
  }
}

function debugPreview(value, maxChars = 160) {
  const text = normalizeText(value)
    .replace(/data:image\/[-+.a-zA-Z0-9]+;base64,[A-Za-z0-9+/=\r\n]+/g, 'data:image/[redacted]')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function debugImageSummary(image) {
  if (!image || typeof image !== 'object') return 'none';
  return JSON.stringify({
    id: normalizeText(image.id).slice(0, 48),
    mimeType: normalizeText(image.mimeType || image.mime_type),
    name: normalizeText(image.name).slice(0, 96),
    hasUrl: Boolean(normalizeText(image.url || image.remoteUrl)),
    hasLocalPath: Boolean(normalizeText(
      image.localPath || image.filePath || image.file_path || image.path || image.image,
    )),
    hasData: Boolean(normalizeText(image.dataBase64 || image.b64_json)),
    objectKey: normalizeText(image.objectKey || image.object_key).slice(0, 96),
    needsUpload: imageNeedsOutputUpload(image),
  });
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function getJobDeliveryError(result) {
  return result?.resultFrame?.error || result?.agentResult?.error || result?.error || null;
}
