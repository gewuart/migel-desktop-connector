import { createHash } from 'node:crypto';

export class DesktopAttachmentClientError extends Error {
  constructor(message, {
    code = 'desktop_attachment_client_error',
    attachmentId = '',
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'DesktopAttachmentClientError';
    this.code = code;
    this.attachmentId = attachmentId;
  }
}

export async function downloadGatewayAttachment(reference, {
  attachmentBaseUrl = '',
  gatewayUrl = '',
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  const normalizedReference = normalizeGatewayAttachmentReference(reference);
  if (typeof fetchImpl !== 'function') {
    throw new DesktopAttachmentClientError('Desktop Connector 缺少 fetch，无法下载 Gateway 临时附件。', {
      code: 'missing_fetch',
      attachmentId: normalizedReference.attachmentId,
    });
  }

  const downloadUrl = resolveAttachmentDownloadUrl(normalizedReference, {
    attachmentBaseUrl: resolveAttachmentBaseUrl({ attachmentBaseUrl, gatewayUrl }),
  });
  const directImageUrl = Boolean(
    normalizedReference.downloadUrl
      && normalizedReference.kind === 'image'
      && !normalizeText(attachmentBaseUrl)
      && !normalizeText(gatewayUrl),
  );
  const response = await fetchImpl(downloadUrl, {
    method: 'GET',
    headers: {
      Accept: directImageUrl ? 'image/*,*/*' : 'application/json',
      ...normalizeHeaders(headers),
    },
  });
  if (!response?.ok) {
    throw new DesktopAttachmentClientError('Desktop Connector 下载 Gateway 临时附件失败。', {
      code: 'attachment_download_failed',
      attachmentId: normalizedReference.attachmentId,
    });
  }

  if (directImageUrl) {
    return normalizeDownloadedAttachment({
      attachment: normalizedReference,
      dataBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    }, normalizedReference);
  }

  const payload = await readJsonResponse(response);
  return normalizeDownloadedAttachment(payload, normalizedReference);
}

export function resolveAttachmentDownloadUrl(reference, {
  attachmentBaseUrl = '',
} = {}) {
  const normalizedReference = normalizeGatewayAttachmentReference(reference);
  if (normalizedReference.downloadUrl) return normalizedReference.downloadUrl;

  const baseUrl = normalizeHttpUrl(attachmentBaseUrl, {
    code: 'missing_attachment_base_url',
    attachmentId: normalizedReference.attachmentId,
  });
  return `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(normalizedReference.attachmentId)}`;
}

export function createGatewayAttachmentClient({
  attachmentBaseUrl = '',
  gatewayUrl = '',
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  const resolvedAttachmentBaseUrl = resolveAttachmentBaseUrl({ attachmentBaseUrl, gatewayUrl });
  return {
    attachmentBaseUrl: resolvedAttachmentBaseUrl,
    downloadAttachment: (reference) => downloadGatewayAttachment(reference, {
      attachmentBaseUrl: resolvedAttachmentBaseUrl,
      fetchImpl,
      headers,
    }),
  };
}

export function resolveAttachmentBaseUrl({
  attachmentBaseUrl = '',
  gatewayUrl = '',
} = {}) {
  const explicitBaseUrl = normalizeText(attachmentBaseUrl);
  if (explicitBaseUrl) {
    return normalizeHttpUrl(explicitBaseUrl, {
      code: 'invalid_attachment_base_url',
    }).replace(/\/+$/, '');
  }

  const text = normalizeText(gatewayUrl);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/attachments`;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (error) {
    throw new DesktopAttachmentClientError('Gateway URL 无法转换为附件下载地址。', {
      code: 'invalid_gateway_url',
      cause: error,
    });
  }
}

export function normalizeGatewayAttachmentReference(reference) {
  const source = reference && typeof reference === 'object' && !Array.isArray(reference)
    ? reference
    : {};
  const attachmentId = normalizeText(source.attachmentId) || normalizeText(source.id);
  if (!attachmentId) {
    throw new DesktopAttachmentClientError('Gateway 附件引用缺少 attachmentId。', {
      code: 'missing_attachment_id',
    });
  }

  return {
    attachmentId,
    name: normalizeText(source.name) || attachmentId,
    mimeType: normalizeText(source.mimeType) || normalizeText(source.mediaType) || 'application/octet-stream',
    sizeBytes: positiveInteger(source.sizeBytes),
    sha256: normalizeText(source.sha256).toLowerCase(),
    kind: normalizeText(source.kind).toLowerCase(),
    downloadUrl: optionalHttpUrl(source.downloadUrl || source.url, {
      code: 'invalid_attachment_download_url',
      attachmentId,
    }),
  };
}

export function normalizeDownloadedAttachment(payload, fallbackReference = {}) {
  const frame = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const metadata = frame.attachment && typeof frame.attachment === 'object'
    ? frame.attachment
    : frame;
  const reference = normalizeGatewayAttachmentReference({
    ...fallbackReference,
    ...metadata,
  });
  const dataBase64 = normalizeText(frame.dataBase64)
    || normalizeText(frame.base64)
    || normalizeText(metadata.dataBase64)
    || normalizeText(metadata.base64)
    || (frame.encoding === 'base64' ? normalizeText(frame.data) : '');
  const data = decodeBase64(dataBase64, reference.attachmentId);
  validateDownloadedAttachment({
    ...reference,
    data,
  });

  return {
    ...reference,
    uploadedByDeviceId: normalizeText(metadata.uploadedByDeviceId),
    conversationId: normalizeText(metadata.conversationId),
    createdAt: positiveInteger(metadata.createdAt),
    expiresAt: positiveInteger(metadata.expiresAt),
    data,
  };
}

function validateDownloadedAttachment(attachment) {
  if (attachment.sizeBytes > 0 && attachment.sizeBytes !== attachment.data.byteLength) {
    throw new DesktopAttachmentClientError('Gateway 附件 sizeBytes 与下载内容不一致。', {
      code: 'attachment_size_mismatch',
      attachmentId: attachment.attachmentId,
    });
  }
  if (attachment.sha256 && attachment.sha256 !== sha256Hex(attachment.data)) {
    throw new DesktopAttachmentClientError('Gateway 附件 sha256 与下载内容不一致。', {
      code: 'attachment_sha256_mismatch',
      attachmentId: attachment.attachmentId,
    });
  }
}

async function readJsonResponse(response) {
  if (typeof response.json === 'function') {
    return await response.json();
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new DesktopAttachmentClientError('Gateway 附件下载响应不是有效 JSON。', {
        code: 'invalid_attachment_json',
        cause: error,
      });
    }
  }
  throw new DesktopAttachmentClientError('Gateway 附件下载响应缺少 JSON body。', {
    code: 'missing_attachment_json',
  });
}

function decodeBase64(value, attachmentId) {
  const compact = normalizeText(value).replace(/\s/g, '');
  if (!compact) {
    throw new DesktopAttachmentClientError('Gateway 附件下载响应缺少 dataBase64。', {
      code: 'missing_attachment_data',
      attachmentId,
    });
  }
  const data = Buffer.from(compact, 'base64');
  if (data.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new DesktopAttachmentClientError('Gateway 附件 dataBase64 无效。', {
      code: 'invalid_attachment_base64',
      attachmentId,
    });
  }
  return data;
}

function optionalHttpUrl(value, errorOptions) {
  const text = normalizeText(value);
  if (!text) return '';
  return normalizeHttpUrl(text, errorOptions);
}

function normalizeHttpUrl(value, errorOptions) {
  const text = normalizeText(value);
  if (!text) {
    throw new DesktopAttachmentClientError('Desktop Connector 缺少 Gateway 附件下载地址。', errorOptions);
  }
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return url.toString();
  } catch (error) {
    throw new DesktopAttachmentClientError('Gateway 附件下载地址必须是 http:// 或 https:// URL。', {
      ...errorOptions,
      cause: error,
    });
  }
}

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => normalizeText(key) && item !== undefined && item !== null),
  );
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
