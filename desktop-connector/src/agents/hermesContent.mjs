import {
  buildDocumentFileTextPart,
} from '../attachments/documentTextExtractor.mjs';

export {
  buildDocumentFileTextPart,
  DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  DEFAULT_PATH_FORWARD_FILE_MIME_TYPES,
  DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
  extractTextFromFileAttachment,
  formatAttachmentBytes,
  isPathForwardableFileAttachment,
  isSupportedTextFileAttachment,
} from '../attachments/documentTextExtractor.mjs';

export function buildHermesContentParts(request, options = {}) {
  const parts = [];
  const text = normalizeText(request?.text);
  if (text) {
    parts.push({
      type: 'text',
      text,
    });
  }

  const attachments = Array.isArray(request?.attachments) ? request.attachments : [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      const data = normalizeText(attachment.data) || normalizeText(attachment.dataBase64);
      if (data) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${normalizeImageMimeType(attachment.mimeType)};base64,${data}`,
          },
        });
        continue;
      }

      const remoteUrl = normalizeRemoteUrl(attachment.remoteUrl)
        || normalizeRemoteUrl(attachment.downloadUrl)
        || normalizeRemoteUrl(attachment.url);
      if (remoteUrl) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: remoteUrl,
          },
        });
        continue;
      }

      throw new Error(`图片 ${normalizeText(attachment.name) || 'image'} 缺少 inline base64 或 remoteUrl。`);
    }

    if (attachment.kind === 'file') {
      parts.push({
        type: 'text',
        text: buildExtractedFileTextPart(attachment, options),
      });
    }
  }

  if (!parts.length) {
    throw new Error('Hermes Migel Bridge 没有可发送到 Hermes API Server 的文本或图片内容。');
  }
  return parts;
}

export function buildExtractedFileTextPart(attachment, options = {}) {
  return buildDocumentFileTextPart(attachment, options);
}

function normalizeImageMimeType(value) {
  const mimeType = normalizeText(value).toLowerCase();
  return mimeType.startsWith('image/') ? mimeType : 'image/png';
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
