import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const DEFAULT_ATTACHMENT_ROOT = join(tmpdir(), 'migel-desktop-connector', 'attachments');

export class DesktopAttachmentStoreError extends Error {
  constructor(message, {
    code = 'desktop_attachment_store_error',
    attachmentId = '',
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'DesktopAttachmentStoreError';
    this.code = code;
    this.attachmentId = attachmentId;
  }
}

export function createDesktopAttachmentStore({
  rootDir = DEFAULT_ATTACHMENT_ROOT,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  now = () => new Date(),
  createFileName = defaultCreateFileName,
} = {}) {
  const normalizedRootDir = normalizeRootDir(rootDir);
  const records = new Map();

  async function putAttachment(attachment, options = {}) {
    const normalized = normalizeDownloadedAttachmentForStore(attachment);
    const storedAt = normalizeTime(options.storedAt) || normalizeTime(now());
    const fileName = sanitizeFileName(createFileName(normalized, { storedAt }));
    const localPath = join(normalizedRootDir, fileName);

    await mkdirImpl(normalizedRootDir, { recursive: true });
    await writeFileImpl(localPath, normalized.data);

    const stored = {
      ...metadataFromAttachment(normalized),
      localPath,
      storedAt,
      dataBase64: normalized.data.toString('base64'),
    };
    records.set(stored.attachmentId, stored);
    return { ...stored };
  }

  async function saveAttachment(attachment, options = {}) {
    const stored = await putAttachment({
      ...normalizeObject(attachment),
      attachmentId: normalizeText(options.attachmentId) || normalizeText(attachment?.attachmentId),
    }, options);
    records.set(stored.attachmentId, stored);
    return metadataFromStoredAttachment(stored);
  }

  async function readAttachment(attachmentId) {
    const normalizedId = normalizeAttachmentId(attachmentId);
    const record = records.get(normalizedId);
    if (!record) {
      throw new DesktopAttachmentStoreError('本地附件记录不存在。', {
        code: 'missing_attachment',
        attachmentId: normalizedId,
      });
    }
    return { ...record };
  }

  async function removeAttachment(attachmentId, {
    rmImpl = rm,
  } = {}) {
    const normalizedId = normalizeAttachmentId(attachmentId);
    const record = records.get(normalizedId);
    if (!record) return null;
    records.delete(normalizedId);
    try {
      await rmImpl(record.localPath, { force: true });
    } catch {}
    return metadataFromStoredAttachment(record);
  }

  return {
    rootDir: normalizedRootDir,
    putAttachment,
    saveAttachment,
    readAttachment,
    removeAttachment,
  };
}

export function toAgentAttachment(storedAttachment) {
  const source = storedAttachment && typeof storedAttachment === 'object' ? storedAttachment : {};
  const mimeType = normalizeText(source.mimeType) || 'application/octet-stream';
  const kind = mimeType.toLowerCase().startsWith('image/') ? 'image' : 'file';
  const data = normalizeText(source.dataBase64);
  if (!data) {
    throw new DesktopAttachmentStoreError('本地附件缺少可交给 Agent 的 base64 内容。', {
      code: 'missing_agent_attachment_data',
      attachmentId: normalizeText(source.attachmentId),
    });
  }

  return {
    kind,
    attachmentId: normalizeText(source.attachmentId),
    name: normalizeText(source.name) || kind,
    mimeType,
    sizeBytes: positiveInteger(source.sizeBytes),
    sha256: normalizeText(source.sha256),
    localPath: normalizeText(source.localPath),
    data,
    encoding: 'base64',
  };
}

export function normalizeDownloadedAttachmentForStore(attachment) {
  const source = attachment && typeof attachment === 'object' && !Array.isArray(attachment)
    ? attachment
    : {};
  const attachmentId = normalizeText(source.attachmentId);
  if (!attachmentId) {
    throw new DesktopAttachmentStoreError('本地附件落盘缺少 attachmentId。', {
      code: 'missing_attachment_id',
    });
  }

  const data = Buffer.isBuffer(source.data)
    ? Buffer.from(source.data)
    : Buffer.from(normalizeText(source.dataBase64), 'base64');
  if (!data.byteLength) {
    throw new DesktopAttachmentStoreError('本地附件落盘缺少内容。', {
      code: 'missing_attachment_data',
      attachmentId,
    });
  }

  return {
    attachmentId,
    name: normalizeText(source.name) || attachmentId,
    mimeType: normalizeText(source.mimeType) || 'application/octet-stream',
    sizeBytes: positiveInteger(source.sizeBytes) || data.byteLength,
    sha256: normalizeText(source.sha256),
    uploadedByDeviceId: normalizeText(source.uploadedByDeviceId),
    conversationId: normalizeText(source.conversationId),
    createdAt: positiveInteger(source.createdAt),
    expiresAt: positiveInteger(source.expiresAt),
    data,
  };
}

function metadataFromAttachment(attachment) {
  return {
    attachmentId: attachment.attachmentId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    uploadedByDeviceId: attachment.uploadedByDeviceId,
    conversationId: attachment.conversationId,
    createdAt: attachment.createdAt,
    expiresAt: attachment.expiresAt,
  };
}

function metadataFromStoredAttachment(attachment) {
  const { dataBase64, ...metadata } = attachment;
  return metadata;
}

function normalizeAttachmentId(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new DesktopAttachmentStoreError('本地附件 attachmentId 不能为空。', {
      code: 'missing_attachment_id',
    });
  }
  return normalized;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function defaultCreateFileName(attachment, { storedAt } = {}) {
  return `${storedAt || Date.now()}-${attachment.attachmentId}-${basename(attachment.name)}`;
}

function sanitizeFileName(value) {
  return normalizeText(value)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 180) || 'attachment';
}

function normalizeRootDir(value) {
  const text = normalizeText(value);
  if (!text) {
    throw new DesktopAttachmentStoreError('Desktop Connector 附件临时目录不能为空。', {
      code: 'missing_attachment_root',
    });
  }
  return text;
}

function normalizeTime(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
