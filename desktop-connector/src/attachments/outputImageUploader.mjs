import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT_UPLOAD_PURPOSE = 'hermes_bridge_output';
const DEFAULT_MIME_TYPE = 'image/png';
const DEFAULT_NAME_PREFIX = 'hermes-output';
const MAX_OUTPUT_UPLOAD_BYTES = 20 * 1024 * 1024;
const DEFAULT_OUTPUT_UPLOAD_TIMEOUT_MS = 60_000;

export async function prepareOutputImagesForAndroid(images, {
  uploadContext,
  fetchImpl = globalThis.fetch,
  maxUploadBytes = MAX_OUTPUT_UPLOAD_BYTES,
  uploadTimeoutMs = DEFAULT_OUTPUT_UPLOAD_TIMEOUT_MS,
  cache,
  readFileImpl = readFile,
  allowedLocalImageRoots = defaultAllowedLocalImageRoots(),
} = {}) {
  const sourceImages = Array.isArray(images) ? images : [];
  if (!sourceImages.length) return [];

  const context = normalizeOutputUploadContext(uploadContext);
  const prepared = [];
  for (let index = 0; index < sourceImages.length; index += 1) {
    const image = await prepareSingleOutputImage(sourceImages[index], {
      index,
      uploadContext: context,
      fetchImpl,
      maxUploadBytes,
      uploadTimeoutMs,
      cache,
      readFileImpl,
      allowedLocalImageRoots,
    });
    if (image) prepared.push(image);
  }
  return prepared;
}

export function outputUploadContextFromPayload(payload, env = globalThis.process?.env || {}) {
  const source = payload?.hermesBridgeOss && typeof payload.hermesBridgeOss === 'object'
    ? payload.hermesBridgeOss
    : payload?.accountOss && typeof payload.accountOss === 'object'
      ? payload.accountOss
      : {};
  return normalizeOutputUploadContext({
    accountApiBaseUrl: source.accountApiBaseUrl
      || source.baseUrl
      || payload?.accountApiBaseUrl
      || env.HERMES_ACCOUNT_API_BASE_URL
      || env.MIGEL_ACCOUNT_API_BASE_URL,
    token: source.token
      || source.accountSessionToken
      || payload?.accountSessionToken
      || env.HERMES_ACCOUNT_SESSION_TOKEN,
  });
}

export function imageNeedsOutputUpload(image) {
  return Boolean(imageInlineBytes(image) || localImagePath(image));
}

async function prepareSingleOutputImage(image, {
  index,
  uploadContext,
  fetchImpl,
  maxUploadBytes,
  uploadTimeoutMs,
  cache,
  readFileImpl,
  allowedLocalImageRoots,
} = {}) {
  if (!image || typeof image !== 'object') return null;
  const remoteUrl = normalizeRemoteUrl(image.url) || normalizeRemoteUrl(image.remoteUrl);
  const inline = imageInlineBytes(image);
  const localPath = localImagePath(image);

  if (!inline && localPath) {
    const requiredUploadContext = requireOutputUploadContext(uploadContext);
    const local = await readLocalOutputImage(localPath, {
      image,
      maxUploadBytes,
      readFileImpl,
      allowedLocalImageRoots,
    });
    const cacheKey = outputImageCacheKey({ bytes: local.bytes });
    if (cacheKey && cache?.has?.(cacheKey)) {
      return cache.get(cacheKey);
    }
    const uploaded = await uploadOutputImage({
      uploadContext: requiredUploadContext,
      image: {
        ...image,
        name: normalizeText(image.name) || local.name,
      },
      index,
      bytes: local.bytes,
      mimeType: local.mimeType,
      fetchImpl,
      maxUploadBytes,
      uploadTimeoutMs,
    });
    if (cacheKey && cache?.set) {
      cache.set(cacheKey, uploaded);
    }
    return uploaded;
  }

  if (!inline) {
    if (!remoteUrl) return null;
    return {
      ...image,
      url: remoteUrl,
      remoteUrl,
      objectKey: normalizeText(image.objectKey),
    };
  }

  const requiredUploadContext = requireOutputUploadContext(uploadContext);
  const cacheKey = outputImageCacheKey(inline);
  if (cacheKey && cache?.has?.(cacheKey)) {
    return cache.get(cacheKey);
  }

  const uploaded = await uploadOutputImage({
    uploadContext: requiredUploadContext,
    image,
    index,
    bytes: inline.bytes,
    mimeType: inline.mimeType,
    fetchImpl,
    maxUploadBytes,
    uploadTimeoutMs,
  });
  if (cacheKey && cache?.set) {
    cache.set(cacheKey, uploaded);
  }
  return uploaded;
}

function requireOutputUploadContext(uploadContext) {
  if (uploadContext) return uploadContext;
  throw new Error('Hermes 输出图片必须通过 OSS 返回，但 Android 本次请求未提供 OSS 上传授权。请先登录云账号并刷新 Hermes 配置。');
}

async function uploadOutputImage({
  uploadContext,
  image,
  index,
  bytes,
  mimeType,
  fetchImpl,
  maxUploadBytes,
  uploadTimeoutMs,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Desktop Connector 缺少 fetch，无法上传 Hermes 输出图片到 OSS。');
  }
  if (bytes.length > positiveInteger(maxUploadBytes, MAX_OUTPUT_UPLOAD_BYTES)) {
    throw new Error(`Hermes 输出图片 ${normalizeText(image?.name) || index + 1} 超过 OSS 上传上限。`);
  }
  const name = normalizeImageName(image?.name || image?.id || `${DEFAULT_NAME_PREFIX}-${index + 1}`, mimeType);
  const sha256 = sha256Hex(bytes);
  const signature = await presignOutputUpload(uploadContext, {
    name,
    mimeType,
    sizeBytes: bytes.length,
    sha256,
    fetchImpl,
    timeoutMs: uploadTimeoutMs,
  });
  await putOutputBytes(signature, {
    bytes,
    mimeType,
    name,
    fetchImpl,
    timeoutMs: uploadTimeoutMs,
  });
  return {
    id: normalizeText(image?.id) || `${DEFAULT_NAME_PREFIX}-${sha256.slice(0, 16)}`,
    name,
    mimeType,
    url: signature.downloadUrl,
    remoteUrl: signature.downloadUrl,
    objectKey: signature.objectKey,
  };
}

async function presignOutputUpload(uploadContext, {
  name,
  mimeType,
  sizeBytes,
  sha256,
  fetchImpl,
  timeoutMs,
}) {
  const response = await fetchWithTimeout(fetchImpl, `${uploadContext.accountApiBaseUrl}/oss/presign-upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${uploadContext.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType,
      kind: 'image',
      purpose: DEFAULT_OUTPUT_UPLOAD_PURPOSE,
      sizeBytes,
      sha256,
    }),
  }, timeoutMs, 'Hermes 输出图 OSS 签名请求超时。');
  const text = await response.text();
  const parsed = parseJsonObject(text);
  if (!response.ok) {
    throw new Error(`Hermes 输出图 OSS 签名失败（HTTP ${response.status}）：${serviceMessage(parsed) || text.slice(0, 240)}`);
  }
  const uploadUrl = normalizeText(parsed?.uploadUrl);
  const downloadUrl = normalizeText(parsed?.downloadUrl);
  const objectKey = normalizeText(parsed?.objectKey);
  if (!uploadUrl || !downloadUrl || !objectKey) {
    throw new Error('Hermes 输出图 OSS 签名响应缺少 uploadUrl/downloadUrl/objectKey。');
  }
  return {
    uploadUrl,
    downloadUrl,
    objectKey,
    method: normalizeText(parsed?.method) || 'PUT',
    uploadHeaders: parsed?.uploadHeaders && typeof parsed.uploadHeaders === 'object'
      ? parsed.uploadHeaders
      : {},
  };
}

async function putOutputBytes(signature, {
  bytes,
  mimeType,
  name,
  fetchImpl,
  timeoutMs,
}) {
  const headers = Object.keys(signature.uploadHeaders).length
    ? signature.uploadHeaders
    : { 'Content-Type': mimeType };
  const response = await fetchWithTimeout(fetchImpl, signature.uploadUrl, {
    method: signature.method || 'PUT',
    headers,
    body: bytes,
  }, timeoutMs, `Hermes 输出图 OSS 上传超时：${name}`);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Hermes 输出图 OSS 上传失败（HTTP ${response.status}）：${text.slice(0, 240) || name}`);
  }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, timeoutMessage) {
  const resolvedTimeoutMs = positiveInteger(timeoutMs, DEFAULT_OUTPUT_UPLOAD_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function imageInlineBytes(image) {
  const dataUrl = parseDataImageUrl(image?.url || image?.remoteUrl);
  const base64 = normalizeBase64Payload(image?.dataBase64 || image?.b64_json || dataUrl?.base64);
  if (!base64) return null;
  const bytes = decodeBase64Strict(base64);
  if (!bytes?.length) return null;
  return {
    base64,
    bytes,
    mimeType: normalizeImageMimeType(dataUrl?.mimeType || image?.mimeType || image?.mime_type),
  };
}

async function readLocalOutputImage(localPath, {
  image,
  maxUploadBytes,
  readFileImpl,
  allowedLocalImageRoots,
} = {}) {
  const resolvedPath = normalizeLocalImagePath(localPath);
  if (!resolvedPath) {
    throw new Error('Hermes 输出图本地路径无效。');
  }
  if (!isAllowedLocalImagePath(resolvedPath, allowedLocalImageRoots)) {
    throw new Error('Hermes 输出图本地路径不在允许的图片缓存目录内，已拒绝上传。');
  }
  const bytes = await readFileImpl(resolvedPath);
  if (!bytes?.length) {
    throw new Error('Hermes 输出图本地文件为空，无法上传 OSS。');
  }
  if (bytes.length > positiveInteger(maxUploadBytes, MAX_OUTPUT_UPLOAD_BYTES)) {
    throw new Error(`Hermes 输出图片 ${basename(resolvedPath)} 超过 OSS 上传上限。`);
  }
  return {
    bytes,
    name: basename(resolvedPath),
    mimeType: normalizeImageMimeType(image?.mimeType || mimeTypeFromPath(resolvedPath)),
  };
}

function localImagePath(image) {
  if (!image || typeof image !== 'object') return '';
  return normalizeLocalImagePath(
    image.localPath
      || image.filePath
      || image.file_path
      || image.path
      || image.image,
  );
}

function normalizeLocalImagePath(value) {
  const text = normalizeText(value).replace(/^<|>$/g, '');
  if (!looksLikeImagePath(text)) return '';
  if (text.startsWith('file://')) {
    try {
      return fileURLToPath(text);
    } catch {
      return '';
    }
  }
  return text.startsWith('/') ? text : '';
}

function isAllowedLocalImagePath(localPath, roots = []) {
  const resolvedPath = resolve(localPath);
  return roots
    .map((root) => normalizeText(root))
    .filter(Boolean)
    .map((root) => resolve(root))
    .some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`));
}

function defaultAllowedLocalImageRoots(env = globalThis.process?.env || {}) {
  const hermesHome = normalizeText(env.HERMES_HOME) || join(homedir(), '.hermes');
  const roots = [
    join(hermesHome, 'cache', 'images'),
    tmpdir(),
  ];
  if (sep === '/') {
    roots.push('/tmp', '/private/tmp');
  }
  return [...new Set(roots.map((root) => normalizeText(root)).filter(Boolean))];
}

function looksLikeImagePath(value) {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(normalizeText(value).split(/[?#]/, 1)[0]);
}

function mimeTypeFromPath(value) {
  switch (extname(normalizeText(value)).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.png':
      return 'image/png';
    default:
      return DEFAULT_MIME_TYPE;
  }
}

function normalizeOutputUploadContext(value) {
  const source = value && typeof value === 'object' ? value : {};
  const accountApiBaseUrl = normalizeBaseUrl(source.accountApiBaseUrl || source.baseUrl);
  const token = normalizeText(source.token || source.accountSessionToken);
  if (!accountApiBaseUrl || !token) return null;
  return { accountApiBaseUrl, token };
}

function parseDataImageUrl(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(normalizeText(value));
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    base64: match[2],
  };
}

function normalizeBase64Payload(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const dataUrl = parseDataImageUrl(text);
  return (dataUrl?.base64 || text).replace(/\s/g, '');
}

function decodeBase64Strict(value) {
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

function normalizeImageName(name, mimeType) {
  const rawName = normalizeText(name).replace(/[\r\n]/g, ' ') || DEFAULT_NAME_PREFIX;
  if (rawName.includes('.')) return rawName.slice(0, 96);
  const extension = normalizeImageMimeType(mimeType).split('/')[1]?.split('+')[0] || 'png';
  return `${rawName}.${extension}`.slice(0, 96);
}

function normalizeImageMimeType(value) {
  const text = normalizeText(value).toLowerCase();
  return text.startsWith('image/') ? text : DEFAULT_MIME_TYPE;
}

function normalizeRemoteUrl(value) {
  const text = normalizeText(value);
  return text.startsWith('http://') || text.startsWith('https://') ? text : '';
}

function normalizeBaseUrl(value) {
  const text = normalizeText(value);
  return text ? text.replace(/\/+$/g, '') : '';
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function outputImageCacheKey(inline) {
  if (!inline?.bytes?.length) return '';
  return sha256Hex(inline.bytes);
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function serviceMessage(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.message === 'string') return value.message;
  if (typeof value.error === 'string') return value.error;
  if (value.error && typeof value.error === 'object') {
    return normalizeText(value.error.message) || normalizeText(value.error.code);
  }
  return '';
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
