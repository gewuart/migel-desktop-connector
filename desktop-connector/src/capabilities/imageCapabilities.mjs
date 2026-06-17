export const IMAGE_GENERATE_CAPABILITY = 'image.generate';
export const IMAGE_EDIT_CAPABILITY = 'image.edit';
export const HERMES_LOCAL_ROUTE_ID = 'hermes-local';

export class CapabilityProviderError extends Error {
  constructor(message, {
    code = 'internal_error',
    route = HERMES_LOCAL_ROUTE_ID,
    capability = '',
    provider = '',
    retryable = false,
    diagnostic = {},
  } = {}) {
    super(normalizeText(message) || '能力调用失败。');
    this.name = 'CapabilityProviderError';
    this.code = normalizeText(code) || 'internal_error';
    this.route = normalizeText(route) || HERMES_LOCAL_ROUTE_ID;
    this.capability = normalizeText(capability);
    this.provider = normalizeText(provider);
    this.retryable = Boolean(retryable);
    this.diagnostic = normalizeObject(diagnostic);
  }
}

export function createImageCapabilityRegistry({
  generateProvider,
  editProvider,
  route = HERMES_LOCAL_ROUTE_ID,
} = {}) {
  const providers = new Map();
  if (typeof generateProvider === 'function') {
    providers.set(IMAGE_GENERATE_CAPABILITY, generateProvider);
  }
  if (typeof editProvider === 'function') {
    providers.set(IMAGE_EDIT_CAPABILITY, editProvider);
  }
  return {
    route,
    supports(capability) {
      return providers.has(normalizeText(capability));
    },
    health() {
      return {
        route,
        capabilities: {
          [IMAGE_GENERATE_CAPABILITY]: providers.has(IMAGE_GENERATE_CAPABILITY)
            ? { status: 'ok', providers: ['local-gpt-image-2'] }
            : { status: 'unsupported' },
          [IMAGE_EDIT_CAPABILITY]: providers.has(IMAGE_EDIT_CAPABILITY)
            ? { status: 'ok', providers: ['local-gpt-image-2'] }
            : { status: 'unsupported' },
        },
      };
    },
    async run(request, options = {}) {
      const normalized = normalizeImageCapabilityRequest(request);
      const provider = providers.get(normalized.capability);
      if (!provider) {
        throw new CapabilityProviderError('当前本机路线不支持这个图片能力。', {
          code: 'unsupported_capability',
          route,
          capability: normalized.capability,
          provider: 'local-gpt-image-2',
        });
      }
      try {
        const result = await provider(normalized, options);
        return normalizeImageCapabilityResult(result, {
          route,
          capability: normalized.capability,
          provider: 'local-gpt-image-2',
        });
      } catch (error) {
        throw normalizeImageCapabilityError(error, {
          route,
          capability: normalized.capability,
          provider: 'local-gpt-image-2',
        });
      }
    },
  };
}

export function normalizeImageCapabilityRequest(request = {}) {
  const source = normalizeObject(request);
  const capability = normalizeText(source.capability)
    || (normalizeAttachments(source.attachments).length ? IMAGE_EDIT_CAPABILITY : IMAGE_GENERATE_CAPABILITY);
  return {
    ...source,
    capability,
    route: normalizeText(source.route) || HERMES_LOCAL_ROUTE_ID,
    prompt: normalizeText(source.prompt || source.text || source.content),
    artifacts: normalizeArtifacts(source.artifacts),
    attachments: normalizeAttachments(source.attachments),
    params: normalizeObject(source.params),
    metadata: normalizeObject(source.metadata),
  };
}

export function normalizeImageCapabilityResult(result = {}, {
  route = HERMES_LOCAL_ROUTE_ID,
  capability = IMAGE_GENERATE_CAPABILITY,
  provider = '',
} = {}) {
  const source = normalizeObject(result);
  const images = normalizeImages(source.images);
  const artifacts = normalizeArtifacts(source.artifacts).length
    ? normalizeArtifacts(source.artifacts)
    : images.map((image, index) => imageToArtifact(image, {
      route,
      capability,
      provider,
      index,
    }));
  return {
    ...source,
    route,
    capability,
    provider,
    content: normalizeText(source.content),
    model: normalizeText(source.model),
    modelId: normalizeText(source.modelId || source.model),
    images,
    artifacts,
    done: source.done !== false,
    metadata: {
      route,
      capability,
      provider,
      ...normalizeObject(source.metadata),
    },
  };
}

export function normalizeImageCapabilityError(error, {
  route = HERMES_LOCAL_ROUTE_ID,
  capability = '',
  provider = '',
} = {}) {
  if (error instanceof CapabilityProviderError) return error;
  const rawMessage = normalizeText(error?.message) || String(error || 'unknown_error');
  const code = imageCapabilityErrorCode(rawMessage, error?.code);
  return new CapabilityProviderError(imageCapabilityErrorMessage(code, rawMessage), {
    code,
    route,
    capability,
    provider,
    retryable: ['provider_unavailable', 'provider_timeout', 'artifact_download_failed', 'artifact_upload_failed', 'internal_error'].includes(code),
    diagnostic: {
      upstreamCode: normalizeText(error?.code) || extractUpstreamErrorName(rawMessage),
    },
  });
}

export function imagesToArtifacts(images, defaults = {}) {
  return normalizeImages(images).map((image, index) => imageToArtifact(image, { ...defaults, index }));
}

function imageToArtifact(image, {
  route = HERMES_LOCAL_ROUTE_ID,
  capability = IMAGE_GENERATE_CAPABILITY,
  provider = '',
  index = 0,
} = {}) {
  const id = normalizeText(image.id) || `image-artifact-${index + 1}`;
  return compactObject({
    id,
    type: 'image',
    name: normalizeText(image.name) || `${id}.png`,
    mimeType: normalizeText(image.mimeType) || 'image/png',
    url: normalizeText(image.url) || normalizeText(image.remoteUrl),
    localPath: normalizeText(image.localPath),
    objectKey: normalizeText(image.objectKey),
    sizeBytes: optionalPositiveNumber(image.sizeBytes),
    route,
    capability,
    provider,
  });
}

function imageCapabilityErrorCode(message, explicitCode) {
  const rawCode = normalizeText(explicitCode).toLowerCase();
  const lower = normalizeText(message).toLowerCase();
  if (rawCode.includes('auth') || lower.includes('api key') || lower.includes('unauthorized')) return 'auth_required';
  if (rawCode.includes('timeout') || lower.includes('timeout') || lower.includes('超时')) return 'provider_timeout';
  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource exhausted')) return 'provider_quota_exceeded';
  if (lower.includes('unsupported') || lower.includes('不支持')) return 'unsupported_capability';
  if (lower.includes('download') || lower.includes('下载')) return 'artifact_download_failed';
  if (lower.includes('upload') || lower.includes('oss') || lower.includes('上传')) return 'artifact_upload_failed';
  if (lower.includes('provider') || lower.includes('falclienthttperror') || lower.includes('fal')) return 'provider_unavailable';
  return 'internal_error';
}

function imageCapabilityErrorMessage(code, fallback) {
  if (code === 'auth_required') return '图片能力鉴权失败，请检查 API Key 或登录状态。';
  if (code === 'provider_timeout') return '图片服务请求超时。';
  if (code === 'provider_quota_exceeded') return '图片服务额度不足或被限流。';
  if (code === 'unsupported_capability') return '当前路线不支持这个图片能力。';
  if (code === 'artifact_download_failed') return '图片输入或输出下载失败。';
  if (code === 'artifact_upload_failed') return '图片输出上传失败。';
  if (code === 'provider_unavailable') return '图片服务暂不可用。';
  return normalizeText(fallback).replace(/FalClientHTTPError/g, 'provider_error') || '图片能力调用失败。';
}

function extractUpstreamErrorName(message) {
  return normalizeText(message).match(/\b[A-Z][A-Za-z0-9_]*Error\b/)?.[0] || '';
}

function normalizeImages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((image) => image && typeof image === 'object' ? { ...image } : null)
    .filter(Boolean);
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((artifact) => artifact && typeof artifact === 'object' ? compactObject({
      ...artifact,
      id: normalizeText(artifact.id),
      type: normalizeText(artifact.type),
      name: normalizeText(artifact.name),
      mimeType: normalizeText(artifact.mimeType),
      url: normalizeText(artifact.url),
      localPath: normalizeText(artifact.localPath),
      objectKey: normalizeText(artifact.objectKey),
      sizeBytes: optionalPositiveNumber(artifact.sizeBytes),
    }) : null)
    .filter(Boolean);
}

function normalizeAttachments(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizePositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function optionalPositiveNumber(value) {
  const numeric = normalizePositiveNumber(value);
  return numeric > 0 ? numeric : undefined;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
