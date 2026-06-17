const DEFAULT_LIMITS = Object.freeze({
  maxAttachments: 6,
  maxImageInlineBytes: 1048576,
  maxFileUploadBytes: 4194304,
});

export function normalizeChatRequest(payload, options = {}) {
  const limits = normalizeLimits(options);
  const sessionId = normalizeText(payload?.sessionId);
  const modelId = normalizeText(payload?.model) || normalizeText(payload?.modelId) || null;
  const userMessage = extractFirstUserMessage(payload?.messages);
  const topLevelAttachments = normalizeAttachments(payload?.attachments, limits);
  const messageParts = normalizeContentParts(userMessage?.content);
  const legacyText = normalizeText(payload?.content)
    || normalizeText(payload?.message)
    || normalizeText(payload?.input)
    || contentPartsToText(messageParts);
  const attachments = [
    ...contentPartsToAttachments(messageParts, limits),
    ...topLevelAttachments,
  ].slice(0, limits.maxAttachments);
  const text = legacyText || attachmentFallbackText(attachments);
  const gatewayText = buildGatewayText(text, attachments);
  return {
    sessionId,
    modelId,
    text,
    attachments,
    gatewayText,
    gatewayMessage: {
      role: 'user',
      content: [
        ...(legacyText ? [{ type: 'text', text: legacyText }] : []),
        ...attachments.map((attachment) => ({
          type: attachment.kind === 'image' ? 'image' : 'file',
          name: attachment.name,
          mimeType: attachment.mimeType,
          data: attachment.data,
          encoding: attachment.encoding,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
          downloadUrl: attachment.downloadUrl,
          remoteUrl: attachment.remoteUrl,
          url: attachment.remoteUrl,
          objectKey: attachment.objectKey,
        })),
      ],
    },
  };
}

export function isPairingFrame(payload) {
  const type = normalizeText(payload?.type).toLowerCase();
  return type === 'pairing' || type === 'e2e.pairing' || type === 'e2e_pairing';
}

export function isEncryptedFrame(payload) {
  return Boolean(payload
    && typeof payload === 'object'
    && typeof payload.nonce === 'string'
    && typeof payload.ciphertext === 'string');
}

function normalizeLimits(options) {
  return {
    maxAttachments: positiveInteger(options.maxAttachments, DEFAULT_LIMITS.maxAttachments),
    maxImageInlineBytes: positiveInteger(
      options.maxImageInlineBytes,
      DEFAULT_LIMITS.maxImageInlineBytes,
    ),
    maxFileUploadBytes: positiveInteger(
      options.maxFileUploadBytes,
      DEFAULT_LIMITS.maxFileUploadBytes,
    ),
  };
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function extractFirstUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (normalizeText(message?.role) !== 'user') continue;
    return message;
  }
  return null;
}

function normalizeContentParts(content) {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'input_text', text: content.trim() }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (part && typeof part === 'object' ? part : null))
    .filter(Boolean);
}

function contentPartsToText(parts) {
  return parts
    .filter((part) => ['input_text', 'text'].includes(normalizeText(part.type)))
    .map((part) => normalizeText(part.text) || normalizeText(part.content))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function contentPartsToAttachments(parts, limits) {
  return normalizeAttachments(
    parts.filter((part) => {
      const type = normalizeText(part.type);
      return type === 'input_image' || type === 'image' || type === 'input_file' || type === 'file';
    }),
    limits,
  );
}

function normalizeAttachments(rawAttachments, limits) {
  if (!Array.isArray(rawAttachments)) return [];
  const attachments = [];
  for (const item of rawAttachments) {
    if (!item || typeof item !== 'object') continue;
    const type = normalizeText(item.type);
    const kind = normalizeText(item.kind)
      || (type === 'input_image' || type === 'image' ? 'image' : '')
      || (type === 'input_file' || type === 'file' ? 'file' : '');
    if (kind !== 'image' && kind !== 'file') continue;

    const data = normalizeText(item.data) || normalizeText(item.dataBase64) || normalizeText(item.base64);
    const remoteUrl = normalizeRemoteUrl(
      normalizeImageUrl(item.image_url)
        || normalizeText(item.remoteUrl)
        || normalizeText(item.url),
    );
    const downloadUrl = normalizeRemoteUrl(item.downloadUrl);
    const objectKey = normalizeText(item.objectKey);
    const encoding = normalizeText(item.encoding) || 'base64';
    const sizeBytes = Number(item.sizeBytes || estimateBase64Bytes(data));
    const maxBytes = kind === 'image' ? limits.maxImageInlineBytes : limits.maxFileUploadBytes;
    if (!remoteUrl) {
      if (!data || encoding !== 'base64') continue;
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes) continue;
    }

    attachments.push({
      kind,
      name: normalizeText(item.name) || (kind === 'image' ? 'image' : 'file'),
      mimeType: normalizeText(item.mimeType) || normalizeText(item.mediaType) || (kind === 'image' ? 'image/*' : 'application/octet-stream'),
      data,
      encoding,
      sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
      sha256: normalizeText(item.sha256),
      downloadUrl,
      remoteUrl,
      objectKey,
    });
    if (attachments.length >= limits.maxAttachments) break;
  }
  return attachments;
}

function estimateBase64Bytes(data) {
  const value = normalizeText(data);
  if (!value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function attachmentFallbackText(attachments) {
  if (!attachments.length) return '';
  return `请分析这些附件：${attachments.map((item) => item.name).join('、')}`;
}

function buildGatewayText(text, attachments) {
  const lines = [text].filter(Boolean);
  if (attachments.length) {
    lines.push('', '[移动端附件]');
    for (const attachment of attachments) {
      const location = attachment.remoteUrl ? 'OSS URL' : 'inline base64';
      lines.push(`- ${attachment.kind === 'image' ? '图片' : '文件'}：${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.sizeBytes)}，${location})`);
    }
    lines.push('Hermes Migel Bridge 会通过 Hermes API Server 原生转发图片；纯文本类文件会先在 bridge 层抽取为文本后再发送。');
  }
  return lines.join('\n').trim();
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function normalizeImageUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return normalizeText(value.url);
}

function normalizeRemoteUrl(value) {
  const url = normalizeText(value);
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return '';
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
