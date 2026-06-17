import {
  createChatDeltaFrame,
  createChatErrorFrame,
  createChatStatusFrame,
  createJobCreatedFrame,
} from '../protocol/frames.mjs';

const DEFAULT_ANDROID_DEVICE_ID = 'migel-android';

export function createJobCreatedFrameFromChatRequest(chatRequest, {
  jobId,
  createId = defaultCreateId,
  version = undefined,
} = {}) {
  const requestId = normalizeText(chatRequest?.requestId) || createId('req');
  const conversationId = normalizeText(chatRequest?.conversationId)
    || normalizeText(chatRequest?.sessionId)
    || requestId;
  const content = normalizeText(chatRequest?.content)
    || normalizeText(chatRequest?.message)
    || normalizeText(chatRequest?.input);
  const attachments = cloneList(chatRequest?.attachments);
  const payload = {
    content,
    attachments,
    modelId: normalizeText(chatRequest?.modelId) || normalizeText(chatRequest?.model),
  };
  const hermesBridgeOss = cloneObject(chatRequest?.hermesBridgeOss);
  if (hermesBridgeOss) payload.hermesBridgeOss = hermesBridgeOss;
  const accountOss = cloneObject(chatRequest?.accountOss);
  if (accountOss) payload.accountOss = accountOss;
  const accountApiBaseUrl = normalizeText(chatRequest?.accountApiBaseUrl);
  if (accountApiBaseUrl) payload.accountApiBaseUrl = accountApiBaseUrl;
  const accountSessionToken = normalizeText(chatRequest?.accountSessionToken);
  if (accountSessionToken) payload.accountSessionToken = accountSessionToken;
  const frame = createJobCreatedFrame({
    jobId: normalizeText(jobId) || createId('job'),
    requestId,
    conversationId,
    fromDeviceId: normalizeText(chatRequest?.fromDeviceId)
      || normalizeText(chatRequest?.client)
      || DEFAULT_ANDROID_DEVICE_ID,
    content: payload.content,
    attachments: payload.attachments,
    modelId: payload.modelId,
    version: normalizeVersion(version),
  });
  return {
    ...frame,
    payload: {
      ...frame.payload,
      ...Object.fromEntries(
        Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ''),
      ),
    },
  };
}

export function createLegacyChatFrameFromJobFrame(jobFrame, {
  sessionId,
  bridge = 'Hermes Migel Bridge',
  gateway = 'Desktop Connector',
} = {}) {
  const frameType = normalizeText(jobFrame?.type);
  if (frameType === 'permission.request') {
    return cloneObject(jobFrame);
  }

  if (frameType === 'job.status') {
    return createChatStatusFrame({
      sessionId,
      phase: normalizeText(jobFrame.phase) || 'running',
      message: normalizeText(jobFrame.message) || normalizeText(jobFrame.phase) || 'Desktop Connector 正在处理任务',
      bridge,
    });
  }

  if (frameType !== 'job.result') return null;

  const errorMessage = normalizeJobErrorMessage(jobFrame.error);
  if (errorMessage) {
    return createChatErrorFrame({
      sessionId,
      message: errorMessage,
      bridge,
    });
  }

  return createChatDeltaFrame({
    sessionId,
    delta: '',
    content: normalizeText(jobFrame.content),
    images: cloneList(jobFrame.images),
    done: jobFrame.done !== false,
    model: normalizeText(jobFrame.modelId) || normalizeText(jobFrame.model) || undefined,
    bridge,
    gateway,
  });
}

export function canRoutePureTextChatRequest(chatRequest) {
  const content = normalizeText(chatRequest?.content)
    || normalizeText(chatRequest?.message)
    || normalizeText(chatRequest?.input);
  return Boolean(content) && cloneList(chatRequest?.attachments).length === 0;
}

function normalizeJobErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return normalizeText(error);
  return normalizeText(error.message) || normalizeText(error.reason) || normalizeText(error.code);
}

function normalizeVersion(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function cloneList(value) {
  return Array.isArray(value) ? value.map((item) => cloneObject(item)) : [];
}

function cloneObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
}

function defaultCreateId(prefix) {
  return `${prefix}-${Date.now().toString(36)}`;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
