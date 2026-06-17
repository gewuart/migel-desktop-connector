const DEFAULT_BRIDGE_LABEL = 'Hermes Migel Bridge';
const DEFAULT_GATEWAY_LABEL = 'Hermes API Server';
const DEFAULT_PROTOCOL_VERSION = 3;

export function createChatRequestFrame({
  requestId,
  conversationId,
  targetDeviceId,
  content = '',
  attachments = [],
  fromDeviceId = undefined,
  modelId = undefined,
  version = DEFAULT_PROTOCOL_VERSION,
} = {}) {
  return compactFrame({
    type: 'chat.request',
    version,
    requestId: String(requestId || ''),
    conversationId: String(conversationId || ''),
    targetDeviceId: String(targetDeviceId || ''),
    fromDeviceId,
    content: String(content || ''),
    attachments: cloneList(attachments),
    modelId,
  });
}

export function createJobCreatedFrame({
  jobId,
  requestId,
  conversationId,
  fromDeviceId,
  content = '',
  attachments = [],
  modelId = undefined,
  version = DEFAULT_PROTOCOL_VERSION,
} = {}) {
  return compactFrame({
    type: 'job.created',
    version,
    jobId: String(jobId || ''),
    requestId: String(requestId || ''),
    conversationId: String(conversationId || ''),
    fromDeviceId: String(fromDeviceId || ''),
    payload: compactFrame({
      content: String(content || ''),
      attachments: cloneList(attachments),
      modelId,
    }),
  });
}

export function createJobStatusFrame({
  jobId,
  requestId = undefined,
  conversationId = undefined,
  targetDeviceId = undefined,
  phase,
  message = '',
  version = DEFAULT_PROTOCOL_VERSION,
} = {}) {
  return compactFrame({
    type: 'job.status',
    version,
    jobId: String(jobId || ''),
    requestId,
    conversationId: optionalString(conversationId),
    targetDeviceId: optionalString(targetDeviceId),
    phase: String(phase || 'running'),
    message: String(message || ''),
  });
}

export function createJobResultFrame({
  jobId,
  requestId,
  conversationId = undefined,
  targetDeviceId = undefined,
  done = true,
  content = '',
  model,
  modelId,
  images = [],
  artifacts = [],
  files = [],
  error = undefined,
  version = DEFAULT_PROTOCOL_VERSION,
} = {}) {
  const resolvedModelId = String(modelId || model || '').trim() || undefined;
  const resolvedArtifacts = cloneList(artifacts);
  return compactFrame({
    type: 'job.result',
    version,
    jobId: String(jobId || ''),
    requestId: String(requestId || ''),
    conversationId: optionalString(conversationId),
    targetDeviceId: optionalString(targetDeviceId),
    done: Boolean(done),
    content: String(content || ''),
    model: resolvedModelId,
    modelId: resolvedModelId,
    images: cloneList(images),
    artifacts: resolvedArtifacts.length ? resolvedArtifacts : undefined,
    files: cloneList(files),
    error,
  });
}

export function createChatErrorFrame({
  sessionId = undefined,
  message,
  bridge = DEFAULT_BRIDGE_LABEL,
} = {}) {
  return compactFrame({
    type: 'chat_error',
    sessionId,
    message: String(message || '未知错误'),
    bridge,
  });
}

export function createChatStatusFrame({
  sessionId = undefined,
  phase,
  message,
  bridge = DEFAULT_BRIDGE_LABEL,
} = {}) {
  return compactFrame({
    type: 'chat_status',
    sessionId,
    phase: String(phase || 'running'),
    message: String(message || ''),
    bridge,
  });
}

export function createChatDeltaFrame({
  sessionId = undefined,
  delta = '',
  content = '',
  images = [],
  done = false,
  model = undefined,
  bridge = DEFAULT_BRIDGE_LABEL,
  gateway = DEFAULT_GATEWAY_LABEL,
} = {}) {
  return compactFrame({
    type: 'chat_delta',
    sessionId,
    delta: String(delta || ''),
    content: String(content || ''),
    images: Array.isArray(images) ? [...images] : [],
    done: Boolean(done),
    model,
    bridge,
    gateway,
  });
}

function compactFrame(frame) {
  return Object.fromEntries(
    Object.entries(frame).filter(([, value]) => value !== undefined && value !== null),
  );
}

function optionalString(value) {
  const text = String(value || '').trim();
  return text || undefined;
}

function cloneList(value) {
  return Array.isArray(value) ? value.map((item) => cloneObject(item)) : [];
}

function cloneObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : value;
}
