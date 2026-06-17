export const DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS = Object.freeze([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.log',
]);

export const DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES = Object.freeze([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'application/json',
  'application/x-ndjson',
  'application/jsonlines',
]);

export const DEFAULT_PATH_FORWARD_FILE_EXTENSIONS = Object.freeze([
  '.pdf',
  '.doc',
  '.docx',
]);

export const DEFAULT_PATH_FORWARD_FILE_MIME_TYPES = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const DEFAULT_MAX_FILE_UPLOAD_BYTES = 4194304;
const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 60000;

export function buildDocumentFileTextPart(attachment, options = {}) {
  if (isSupportedTextFileAttachment(
    attachment,
    options.supportedTextFileExtensions,
    options.supportedTextFileMimeTypes,
  )) {
    const extractedText = extractTextFromFileAttachment(attachment, options);
    return [
      `移动端上传文件已由 Desktop Connector 抽取为文本：${attachmentName(attachment)}`,
      `MIME: ${attachmentMimeType(attachment)}；大小: ${formatBytes(attachment?.sizeBytes)}`,
      '',
      extractedText,
    ].join('\n');
  }

  if (isPathForwardableFileAttachment(
    attachment,
    options.supportedPathFileExtensions,
    options.supportedPathFileMimeTypes,
  )) {
    return buildLocalPathFileTextPart(attachment);
  }

  throw createUnsupportedFileError(attachment, options);
}

export function extractTextFromFileAttachment(attachment, options = {}) {
  const maxFileUploadBytes = positiveInteger(options.maxFileUploadBytes, DEFAULT_MAX_FILE_UPLOAD_BYTES);
  const maxExtractedTextChars = positiveInteger(options.maxExtractedTextChars, DEFAULT_MAX_EXTRACTED_TEXT_CHARS);

  if (!isSupportedTextFileAttachment(
    attachment,
    options.supportedTextFileExtensions,
    options.supportedTextFileMimeTypes,
  )) {
    throw createUnsupportedFileError(attachment, options);
  }

  const bytes = attachmentBytes(attachment);
  if (!bytes.length) {
    throw new Error(`文件 ${attachmentName(attachment)} 没有可抽取的文本内容。`);
  }
  if (bytes.length > maxFileUploadBytes) {
    throw new Error(`文件 ${attachmentName(attachment)} 超过上传抽取限制 ${formatBytes(maxFileUploadBytes)}。`);
  }

  let text = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const nullCount = (text.match(/\u0000/g) || []).length;
  if (nullCount > 0 || replacementCount > Math.max(8, text.length * 0.01)) {
    throw new Error(`文件 ${attachmentName(attachment)} 不是可安全按 UTF-8 解析的纯文本。`);
  }

  text = text.trim();
  if (!text) {
    throw new Error(`文件 ${attachmentName(attachment)} 抽取后没有可发送的文本。`);
  }

  if (text.length > maxExtractedTextChars) {
    return [
      text.slice(0, maxExtractedTextChars),
      '',
      `[Desktop Connector 已截断文件文本：原始 ${text.length} 字符，当前限制 ${maxExtractedTextChars} 字符。]`,
    ].join('\n');
  }
  return text;
}

export function isSupportedTextFileAttachment(
  attachment,
  supportedExtensions = DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  supportedMimeTypes = DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
) {
  const mimeType = attachmentMimeType(attachment);
  const extension = fileExtension(attachment?.name);
  return normalizeList(supportedMimeTypes).map(normalizeMimeType).includes(mimeType)
    || normalizeList(supportedExtensions).map(normalizeExtension).includes(extension);
}

export function isPathForwardableFileAttachment(
  attachment,
  supportedExtensions = DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  supportedMimeTypes = DEFAULT_PATH_FORWARD_FILE_MIME_TYPES,
) {
  const mimeType = attachmentMimeType(attachment);
  const extension = fileExtension(attachment?.name);
  return normalizeList(supportedMimeTypes).map(normalizeMimeType).includes(mimeType)
    || normalizeList(supportedExtensions).map(normalizeExtension).includes(extension);
}

export function formatAttachmentBytes(value) {
  return formatBytes(value);
}

function buildLocalPathFileTextPart(attachment) {
  const localPath = normalizeText(attachment?.localPath);
  if (!localPath) {
    throw new Error(`文件 ${attachmentName(attachment)} 可按本地路径交给 Agent，但缺少本地临时路径。`);
  }

  return [
    `移动端上传文件已由 Desktop Connector 保存到本地临时路径：${attachmentName(attachment)}`,
    `MIME: ${attachmentMimeType(attachment)}；大小: ${formatBytes(attachment?.sizeBytes)}`,
    `本地路径：${localPath}`,
    '',
    '该文件暂未抽取文本；请本地 Agent 在权限允许时读取这个路径。',
  ].join('\n');
}

function createUnsupportedFileError(attachment, options = {}) {
  const supportedTextFileExtensions = normalizeList(
    options.supportedTextFileExtensions || DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  );
  const supportedPathFileExtensions = normalizeList(
    options.supportedPathFileExtensions || DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  );

  return new Error([
    'Desktop Connector 目前只支持纯文本类文件抽取，或将 PDF/Word 文件以本地路径交给 Agent。',
    `支持文本扩展名：${supportedTextFileExtensions.join(', ')}`,
    `支持路径转交扩展名：${supportedPathFileExtensions.join(', ')}`,
    `未支持文件：${attachmentName(attachment)} (${attachmentMimeType(attachment)}, ${formatBytes(attachment?.sizeBytes)})`,
  ].join('\n'));
}

function attachmentBytes(attachment) {
  if (Buffer.isBuffer(attachment?.bytes)) return Buffer.from(attachment.bytes);
  if (attachment?.bytes instanceof Uint8Array) return Buffer.from(attachment.bytes);
  if (Buffer.isBuffer(attachment?.data)) return Buffer.from(attachment.data);
  if (attachment?.data instanceof Uint8Array) return Buffer.from(attachment.data);

  const base64 = normalizeText(attachment?.dataBase64)
    || normalizeText(attachment?.base64)
    || normalizeText(attachment?.data);
  return Buffer.from(base64, 'base64');
}

function attachmentName(attachment) {
  return normalizeText(attachment?.name) || normalizeText(attachment?.attachmentId) || 'attachment';
}

function attachmentMimeType(attachment) {
  return normalizeMimeType(attachment?.mimeType || attachment?.mediaType) || 'application/octet-stream';
}

function normalizeMimeType(value) {
  return normalizeText(value)
    .toLowerCase()
    .split(';')[0]
    .trim();
}

function fileExtension(name) {
  const value = normalizeText(name).toLowerCase();
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex < 0) return '';
  return value.slice(dotIndex);
}

function normalizeExtension(value) {
  const extension = normalizeText(value).toLowerCase();
  if (!extension) return '';
  return extension.startsWith('.') ? extension : `.${extension}`;
}

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeText(item)).filter(Boolean)
    : [];
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
