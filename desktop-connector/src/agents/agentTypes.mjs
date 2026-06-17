export const DEFAULT_AGENT_ID = 'hermes';
export const DEFAULT_AGENT_MODEL_ID = 'hermes-agent';

export function createAgentRequest({
  request = {},
  sessionId,
  sessionKey,
  modelId,
  agentId = DEFAULT_AGENT_ID,
  defaultModelId = DEFAULT_AGENT_MODEL_ID,
  metadata = {},
} = {}) {
  const source = request && typeof request === 'object' ? request : {};
  const resolvedSessionId = normalizeText(sessionId) || normalizeText(source.sessionId) || 'default';
  const resolvedSessionKey = normalizeText(sessionKey) || toAgentSessionKey(resolvedSessionId);
  const resolvedModelId = normalizeText(modelId)
    || normalizeText(source.modelId)
    || normalizeText(source.model)
    || normalizeText(defaultModelId)
    || DEFAULT_AGENT_MODEL_ID;
  const attachments = normalizeAttachments(source.attachments);
  const text = normalizeText(source.text);

  return {
    type: 'agent.request',
    agentId: normalizeText(agentId) || DEFAULT_AGENT_ID,
    sessionId: resolvedSessionId,
    sessionKey: resolvedSessionKey,
    modelId: resolvedModelId,
    text,
    attachments,
    gatewayText: normalizeText(source.gatewayText),
    gatewayMessage: normalizeObject(source.gatewayMessage),
    metadata: normalizeObject(metadata),
    request: {
      ...source,
      sessionId: resolvedSessionId,
      modelId: resolvedModelId,
      text,
      attachments,
    },
  };
}

export function createAgentResult({
  content = '',
  model,
  modelId,
  images = [],
  artifacts = [],
  done = true,
  status = 'completed',
  error = null,
  metadata = {},
} = {}) {
  const resolvedModelId = normalizeText(modelId) || normalizeText(model) || DEFAULT_AGENT_MODEL_ID;
  return {
    type: 'agent.result',
    status: normalizeText(status) || 'completed',
    content: normalizeText(content),
    model: resolvedModelId,
    modelId: resolvedModelId,
    images: normalizeImages(images),
    artifacts: normalizeArtifacts(artifacts),
    done: Boolean(done),
    error: error ? normalizeError(error) : null,
    metadata: normalizeObject(metadata),
  };
}

export function toAgentSessionKey(sessionId, { prefix = 'android' } = {}) {
  const safePrefix = normalizeText(prefix)
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .slice(0, 40) || 'android';
  const safeSessionId = normalizeText(sessionId)
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .slice(0, 120) || 'default';
  return `${safePrefix}:${safeSessionId}`;
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((attachment) => normalizeAttachment(attachment))
    .filter(Boolean);
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const kind = normalizeText(attachment.kind);
  if (kind !== 'image' && kind !== 'file') return null;
  const normalized = {
    ...attachment,
    kind,
    name: normalizeText(attachment.name) || kind,
    mimeType: normalizeText(attachment.mimeType) || normalizeText(attachment.mediaType),
    data: normalizeText(attachment.data) || normalizeText(attachment.dataBase64),
    encoding: normalizeText(attachment.encoding) || 'base64',
    sizeBytes: normalizePositiveNumber(attachment.sizeBytes),
    sha256: normalizeText(attachment.sha256),
  };
  return withOptionalReferenceFields(normalized, {
    remoteUrl: normalizeText(attachment.remoteUrl) || normalizeText(attachment.url),
    objectKey: normalizeText(attachment.objectKey),
  });
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((image) => {
      if (!image || typeof image !== 'object') return null;
      const normalized = {
        ...image,
        id: normalizeText(image.id),
        name: normalizeText(image.name),
        mimeType: normalizeText(image.mimeType) || normalizeText(image.mime_type) || 'image/png',
        dataBase64: normalizeText(image.dataBase64) || normalizeText(image.b64_json),
        url: normalizeText(image.url),
      };
      return withOptionalReferenceFields(normalized, {
        objectKey: normalizeText(image.objectKey),
      });
    })
    .filter(Boolean);
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((artifact) => {
      if (!artifact || typeof artifact !== 'object') return null;
      return compactObject({
        ...artifact,
        id: normalizeText(artifact.id),
        type: normalizeText(artifact.type),
        name: normalizeText(artifact.name),
        mimeType: normalizeText(artifact.mimeType),
        url: normalizeText(artifact.url),
        localPath: normalizeText(artifact.localPath),
        objectKey: normalizeText(artifact.objectKey),
        sizeBytes: optionalPositiveNumber(artifact.sizeBytes),
      });
    })
    .filter(Boolean);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function withOptionalReferenceFields(target, fields) {
  const normalized = { ...target };
  for (const [key, value] of Object.entries(fields)) {
    const text = normalizeText(value);
    if (text) normalized[key] = text;
    else delete normalized[key];
  }
  return normalized;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeError(error) {
  if (typeof error === 'string') {
    return {
      message: error,
    };
  }
  return {
    code: normalizeText(error?.code),
    message: normalizeText(error?.message) || String(error || 'unknown_error'),
  };
}

function normalizePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function optionalPositiveNumber(value) {
  const numeric = normalizePositiveNumber(value);
  return numeric > 0 ? numeric : undefined;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
