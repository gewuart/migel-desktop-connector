import { createGatewayAttachmentClient } from './attachmentClient.mjs';
import {
  createDesktopAttachmentStore,
  toAgentAttachment,
} from './attachmentStore.mjs';

export class DesktopJobAttachmentError extends Error {
  constructor(message, {
    code = 'desktop_job_attachment_error',
    attachmentId = '',
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'DesktopJobAttachmentError';
    this.code = code;
    this.attachmentId = attachmentId;
  }
}

export function canResolveJobAttachments(options = {}) {
  return typeof options.resolveJobAttachments === 'function'
    || typeof options.downloadAttachment === 'function'
    || options.attachmentClient
    || normalizeText(options.attachmentBaseUrl)
    || normalizeText(options.gatewayUrl);
}

export async function resolveJobAttachments(references, options = {}) {
  const attachmentReferences = normalizeAttachmentReferences(references);
  if (!attachmentReferences.length) {
    return {
      attachments: [],
      records: [],
      cleanup: async () => [],
    };
  }

  if (typeof options.resolveJobAttachments === 'function') {
    const resolved = await options.resolveJobAttachments(attachmentReferences);
    return normalizeResolvedJobAttachments(resolved);
  }

  let client = null;
  let downloadAttachment = null;
  let store = null;

  const records = [];
  const attachments = [];
  for (const reference of attachmentReferences) {
    const remoteAttachment = toRemoteAgentAttachment(reference);
    if (remoteAttachment) {
      attachments.push(remoteAttachment);
      continue;
    }

    if (!downloadAttachment) {
      client = options.attachmentClient || createOptionalAttachmentClient(options);
      downloadAttachment = typeof options.downloadAttachment === 'function'
        ? options.downloadAttachment
        : client?.downloadAttachment;
      if (typeof downloadAttachment !== 'function') {
        throw new DesktopJobAttachmentError('Desktop Connector 缺少附件下载客户端，无法处理附件引用。', {
          code: 'attachment_client_missing',
        });
      }
    }
    if (!store) {
      store = options.attachmentStore || options.store || createDesktopAttachmentStore(options.attachmentStoreOptions);
      if (!store || (typeof store.putAttachment !== 'function' && typeof store.saveAttachment !== 'function')) {
        throw new DesktopJobAttachmentError('Desktop Connector 缺少附件临时 store。', {
          code: 'attachment_store_missing',
        });
      }
    }

    const downloaded = await downloadAttachment(reference, {
      attachmentBaseUrl: options.attachmentBaseUrl,
      gatewayUrl: options.gatewayUrl,
      fetchImpl: options.fetchImpl,
      headers: options.attachmentHeaders,
    });
    const record = typeof store.putAttachment === 'function'
      ? await store.putAttachment(downloaded, { attachmentId: reference.attachmentId })
      : await store.saveAttachment(downloaded, { attachmentId: reference.attachmentId });
    records.push(record);
    const storedAttachment = typeof store.readAttachment === 'function'
      ? await readStoredAttachmentForAgent(store, record)
      : record;
    const agentAttachment = toAgentAttachment(storedAttachment);
    attachments.push({
      ...reference,
      ...agentAttachment,
      kind: normalizeAttachmentKind(agentAttachment.kind || reference.kind, agentAttachment.mimeType),
    });
  }

  return {
    attachments,
    records,
    cleanup: async () => store ? cleanupResolvedAttachments(store, records) : [],
  };
}

async function readStoredAttachmentForAgent(store, record) {
  if (record?.dataBase64) return record;
  try {
    const stored = await store.readAttachment(record.attachmentId);
    return stored?.dataBase64 ? stored : record;
  } catch {
    return record;
  }
}

export async function resolveGatewayAttachments(references, options = {}) {
  const resolved = await resolveJobAttachments(references, options);
  try {
    return resolved.attachments;
  } finally {
    await resolved.cleanup();
  }
}

function normalizeResolvedJobAttachments(resolved) {
  if (Array.isArray(resolved)) {
    return {
      attachments: resolved.map((attachment) => ({ ...attachment })),
      records: [],
      cleanup: async () => [],
    };
  }
  const source = resolved && typeof resolved === 'object' ? resolved : {};
  return {
    attachments: Array.isArray(source.attachments)
      ? source.attachments.map((attachment) => ({ ...attachment }))
      : [],
    records: Array.isArray(source.records)
      ? source.records.map((record) => ({ ...record }))
      : [],
    cleanup: typeof source.cleanup === 'function' ? source.cleanup : async () => [],
  };
}

async function cleanupResolvedAttachments(store, records) {
  const removed = [];
  for (const record of records) {
    if (!record?.attachmentId || typeof store.removeAttachment !== 'function') continue;
    removed.push(await store.removeAttachment(record.attachmentId));
  }
  return removed.filter(Boolean);
}

function createOptionalAttachmentClient(options) {
  if (!normalizeText(options.attachmentBaseUrl) && !normalizeText(options.gatewayUrl)) return null;
  return createGatewayAttachmentClient({
    attachmentBaseUrl: options.attachmentBaseUrl,
    gatewayUrl: options.gatewayUrl,
    fetchImpl: options.fetchImpl,
    headers: options.attachmentHeaders,
  });
}

function normalizeAttachmentReferences(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((reference) => normalizeAttachmentReference(reference))
    .filter(Boolean);
}

function normalizeAttachmentReference(reference) {
  if (!reference || typeof reference !== 'object') return null;
  const attachmentId = normalizeText(reference.attachmentId);
  const remoteUrl = normalizeHttpUrl(reference.remoteUrl) || normalizeHttpUrl(reference.url);
  const downloadUrl = normalizeHttpUrl(reference.downloadUrl);
  const kind = normalizeAttachmentKind(reference.kind, reference.mimeType);
  if (!attachmentId && (!remoteUrl || kind !== 'image')) return null;
  return {
    attachmentId,
    kind,
    name: normalizeText(reference.name) || attachmentId,
    mimeType: normalizeText(reference.mimeType) || normalizeText(reference.mediaType) || 'application/octet-stream',
    sizeBytes: normalizePositiveInteger(reference.sizeBytes),
    sha256: normalizeText(reference.sha256).toLowerCase(),
    downloadUrl,
    remoteUrl,
    url: remoteUrl,
    objectKey: normalizeText(reference.objectKey),
    uploadedByDeviceId: normalizeText(reference.uploadedByDeviceId),
    conversationId: normalizeText(reference.conversationId),
    createdAt: normalizeTimestamp(reference.createdAt),
    expiresAt: normalizeTimestamp(reference.expiresAt),
  };
}

function toRemoteAgentAttachment(reference) {
  const remoteUrl = normalizeHttpUrl(reference?.remoteUrl) || normalizeHttpUrl(reference?.url);
  if (!remoteUrl) return null;
  const kind = normalizeAttachmentKind(reference.kind, reference.mimeType);
  if (kind !== 'image') return null;
  const downloadUrl = normalizeHttpUrl(reference.downloadUrl);
  const { downloadUrl: _downloadUrl, ...referenceWithoutDownloadUrl } = reference;
  return {
    ...referenceWithoutDownloadUrl,
    kind,
    name: normalizeText(reference.name) || normalizeText(reference.attachmentId) || kind,
    mimeType: normalizeText(reference.mimeType) || normalizeText(reference.mediaType) || 'application/octet-stream',
    data: '',
    encoding: 'url',
    ...(downloadUrl ? { downloadUrl } : {}),
    remoteUrl,
    url: remoteUrl,
    objectKey: normalizeText(reference.objectKey),
  };
}

function normalizeAttachmentKind(value, mimeType) {
  const kind = normalizeText(value).toLowerCase();
  if (kind === 'image' || kind === 'file') return kind;
  return normalizeText(mimeType).toLowerCase().startsWith('image/') ? 'image' : 'file';
}

function normalizePositiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeHttpUrl(value) {
  const text = normalizeText(value);
  return text.startsWith('http://') || text.startsWith('https://') ? text : '';
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
