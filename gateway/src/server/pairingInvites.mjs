import {
  createHash,
  createHmac,
  randomBytes as defaultRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_TTL_MILLIS = 10 * 60 * 1000;
const MIN_TTL_MILLIS = 5 * 60 * 1000;
const MAX_TTL_MILLIS = 10 * 60 * 1000;
const DESKTOP_CLAIM_PREFIX = 'migel_dc_';
const DESKTOP_TOKEN_PREFIX = 'migel_desktop_dt_';
const ANDROID_TOKEN_PREFIX = 'migel_dt_';
const DESKTOP_CLAIM_TYP = 'migel.desktop.claim';
const DEFAULT_DESKTOP_CLAIM_SKEW_MILLIS = 2 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createPairingInviteStore({
  ttlMillis = DEFAULT_TTL_MILLIS,
  statePath = '',
  desktopClaimSecret = '',
  desktopClaims = [],
  desktopClaimSkewMillis = DEFAULT_DESKTOP_CLAIM_SKEW_MILLIS,
  now = () => Date.now(),
  randomBytes = defaultRandomBytes,
  logger = null,
} = {}) {
  const invitesById = new Map();
  const inviteIdsByCode = new Map();
  const loadedState = loadPairingState(statePath, logger);
  const devicesByTokenHash = new Map(loadedState.deviceRecords);
  const usedDesktopClaimsByHash = new Map(loadedState.desktopClaimRedemptions);
  const configuredDesktopClaimHashes = new Set(
    normalizeList(desktopClaims).map(hashDesktopClaim),
  );
  const effectiveTtlMillis = clampInteger(ttlMillis, MIN_TTL_MILLIS, MAX_TTL_MILLIS, DEFAULT_TTL_MILLIS);

  function createInvite({
    host,
    port,
    secure,
    path,
    name = '',
    bridge = '',
    nodeId = '',
    source = '',
    bridgePublicKey = '',
    ttlMillis: inviteTtlMillis,
  } = {}) {
    const endpoint = normalizeEndpoint({
      host,
      port,
      secure,
      path,
    });
    const ttl = clampInteger(inviteTtlMillis, MIN_TTL_MILLIS, MAX_TTL_MILLIS, effectiveTtlMillis);
    const createdAtEpochMillis = now();
    const expiresAtEpochMillis = createdAtEpochMillis + ttl;
    const inviteId = uniqueValue(invitesById, () => `inv_${base64Url(randomBytes(12))}`);
    const code = uniqueValue(inviteIdsByCode, () => formatManualCode(randomBytes));
    const invite = {
      inviteId,
      code,
      createdAtEpochMillis,
      expiresAtEpochMillis,
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      path: endpoint.path,
      name: normalizeText(name),
      bridge: normalizeText(bridge),
      nodeId: normalizeText(nodeId),
      source: normalizeText(source),
      bridgePublicKey: normalizeText(bridgePublicKey),
    };
    invitesById.set(inviteId, invite);
    inviteIdsByCode.set(normalizeManualCode(code), inviteId);
    return presentInvite(invite);
  }

  function redeem({
    inviteId = '',
    code = '',
    client = '',
    platform = '',
    deviceId = '',
  } = {}) {
    pruneExpired();
    const normalizedInviteId = normalizeText(inviteId);
    const normalizedCode = normalizeManualCode(code);
    const matchedInviteId = normalizedInviteId || inviteIdsByCode.get(normalizedCode) || '';
    const invite = matchedInviteId ? invitesById.get(matchedInviteId) : null;
    if (!invite) {
      return {
        ok: false,
        error: 'invalid_pairing_invite',
        message: '连接码无效或已过期。',
      };
    }
    if (invite.expiresAtEpochMillis <= now()) {
      deleteInvite(invite);
      return {
        ok: false,
        error: 'expired_pairing_invite',
        message: '连接码无效或已过期。',
      };
    }

    deleteInvite(invite);
    const deviceToken = `${ANDROID_TOKEN_PREFIX}${base64Url(randomBytes(32))}`;
    const tokenHash = hashDeviceToken(deviceToken);
    const deviceRecord = {
      tokenHash,
      role: 'android',
      pairedAtEpochMillis: now(),
      lastUsedAtEpochMillis: null,
      inviteId: invite.inviteId,
      code: invite.code,
      client: normalizeText(client),
      platform: normalizeText(platform),
      deviceId: normalizeText(deviceId),
      nodeId: invite.nodeId,
    };
    devicesByTokenHash.set(tokenHash, deviceRecord);
    persistPairingState(statePath, {
      devicesByTokenHash,
      usedDesktopClaimsByHash,
    }, logger);

    return {
      ok: true,
      invite: presentInvite(invite),
      deviceToken,
      deviceTokenId: tokenHash.slice(0, 16),
    };
  }

  function redeemDesktopClaim({
    claim = '',
    deviceId = '',
    client = '',
    platform = '',
    name = '',
  } = {}) {
    pruneExpiredDesktopClaimRedemptions();
    const verification = verifyDesktopClaim({
      claim,
      secret: desktopClaimSecret,
      configuredClaimHashes: configuredDesktopClaimHashes,
      now,
      skewMillis: desktopClaimSkewMillis,
    });
    if (!verification.ok) {
      return {
        ok: false,
        error: verification.error || 'invalid_desktop_claim',
        message: verification.message || '桌面连接凭证无效或已过期。',
      };
    }

    const claimHash = hashDesktopClaim(claim);
    if (usedDesktopClaimsByHash.has(claimHash)) {
      return {
        ok: false,
        error: 'desktop_claim_already_redeemed',
        message: '桌面连接凭证已被使用，请重新生成。',
      };
    }

    const requestedDeviceId = normalizeText(deviceId);
    const claimDeviceId = normalizeText(verification.deviceId);
    if (requestedDeviceId && claimDeviceId && requestedDeviceId !== claimDeviceId) {
      return {
        ok: false,
        error: 'desktop_claim_device_mismatch',
        message: '桌面连接凭证与当前设备不匹配。',
      };
    }

    const normalizedDeviceId = requestedDeviceId || claimDeviceId || 'desktop-1';
    const desktopToken = `${DESKTOP_TOKEN_PREFIX}${base64Url(randomBytes(32))}`;
    const tokenHash = hashDeviceToken(desktopToken);
    const nowMillis = now();
    const deviceRecord = {
      tokenHash,
      role: 'desktop',
      pairedAtEpochMillis: nowMillis,
      lastUsedAtEpochMillis: null,
      inviteId: '',
      code: '',
      client: normalizeText(client),
      platform: normalizeText(platform),
      deviceId: normalizedDeviceId,
      nodeId: normalizedDeviceId,
      name: normalizeText(name),
      claimId: verification.claimId,
    };
    const claimRedemption = {
      claimHash,
      claimId: verification.claimId,
      deviceId: normalizedDeviceId,
      redeemedAtEpochMillis: nowMillis,
      expiresAtEpochMillis: verification.expiresAtEpochMillis || null,
    };
    devicesByTokenHash.set(tokenHash, deviceRecord);
    usedDesktopClaimsByHash.set(claimHash, claimRedemption);
    persistPairingState(statePath, {
      devicesByTokenHash,
      usedDesktopClaimsByHash,
    }, logger);

    return {
      ok: true,
      desktopToken,
      desktopTokenId: tokenHash.slice(0, 16),
      deviceId: normalizedDeviceId,
      nodeId: normalizedDeviceId,
      claimId: verification.claimId,
      expiresAtEpochMillis: verification.expiresAtEpochMillis || null,
    };
  }

  function verifyDeviceToken(token, identity = null) {
    const normalized = normalizeText(token);
    if (!normalized) return false;
    const tokenHash = hashDeviceToken(normalized);
    const deviceRecord = devicesByTokenHash.get(tokenHash);
    if (!deviceRecord) return false;
    if (identity) {
      const role = normalizeText(identity.role);
      const deviceId = normalizeText(identity.deviceId);
      if (deviceRecord.role && role !== deviceRecord.role) return false;
      if (deviceRecord.deviceId && deviceRecord.deviceId !== deviceId) return false;
    }
    deviceRecord.lastUsedAtEpochMillis = now();
    return true;
  }

  function snapshot() {
    pruneExpired();
    return {
      pendingInvites: invitesById.size,
      deviceTokens: devicesByTokenHash.size,
      androidTokens: countDeviceRecords('android'),
      desktopTokens: countDeviceRecords('desktop'),
      usedDesktopClaims: usedDesktopClaimsByHash.size,
      ttlMillis: effectiveTtlMillis,
    };
  }

  function pruneExpired() {
    const currentTime = now();
    for (const invite of invitesById.values()) {
      if (invite.expiresAtEpochMillis <= currentTime) {
        deleteInvite(invite);
      }
    }
  }

  function deleteInvite(invite) {
    invitesById.delete(invite.inviteId);
    inviteIdsByCode.delete(normalizeManualCode(invite.code));
  }

  function pruneExpiredDesktopClaimRedemptions() {
    const currentTime = now();
    for (const [claimHash, redemption] of usedDesktopClaimsByHash.entries()) {
      const expiresAt = Number(redemption.expiresAtEpochMillis) || 0;
      if (expiresAt > 0 && expiresAt + desktopClaimSkewMillis <= currentTime) {
        usedDesktopClaimsByHash.delete(claimHash);
      }
    }
  }

  function countDeviceRecords(role) {
    let count = 0;
    for (const record of devicesByTokenHash.values()) {
      if (record.role === role) count += 1;
    }
    return count;
  }

  return {
    createInvite,
    redeem,
    redeemDesktopClaim,
    verifyDeviceToken,
    snapshot,
  };
}

export function createSignedDesktopClaim({
  secret,
  deviceId = '',
  expiresAtEpochMillis,
  issuedAtEpochMillis,
  notBeforeEpochMillis,
  claimId = '',
  randomBytes = defaultRandomBytes,
  metadata = {},
} = {}) {
  const normalizedSecret = normalizeText(secret);
  if (!normalizedSecret) {
    throw new Error('desktop claim secret is required.');
  }
  const payload = removeBlankValues({
    ...normalizeObject(metadata),
    typ: DESKTOP_CLAIM_TYP,
    jti: normalizeText(claimId) || `dc_${base64Url(randomBytes(12))}`,
    deviceId: normalizeText(deviceId),
    iat: normalizeEpochMillis(issuedAtEpochMillis),
    nbf: normalizeEpochMillis(notBeforeEpochMillis),
    exp: normalizeEpochMillis(expiresAtEpochMillis),
  });
  if (!payload.exp) {
    throw new Error('desktop claim expiresAtEpochMillis is required.');
  }
  const payloadPart = base64Url(Buffer.from(JSON.stringify(payload)));
  const signature = signDesktopClaimPayload(payloadPart, normalizedSecret);
  return `${DESKTOP_CLAIM_PREFIX}${payloadPart}.${signature}`;
}

export function buildMigelPairUri({
  host,
  port,
  secure,
  path,
  inviteId,
  bridgePublicKey,
  name = '',
  bridge = '',
  nodeId = '',
  source = '',
} = {}) {
  const endpoint = normalizeEndpoint({
    host,
    port,
    secure,
    path,
  });
  const params = new URLSearchParams({
    host: endpoint.host,
    port: String(endpoint.port),
    secure: String(endpoint.secure),
    path: endpoint.path,
    inviteId: normalizeText(inviteId),
  });
  const publicKey = normalizeText(bridgePublicKey);
  if (publicKey) params.set('bridgePublicKey', publicKey);
  if (normalizeText(name)) params.set('name', normalizeText(name));
  if (normalizeText(bridge)) params.set('bridge', normalizeText(bridge));
  if (normalizeText(nodeId)) params.set('nodeId', normalizeText(nodeId));
  if (normalizeText(source)) params.set('source', normalizeText(source));
  return `migel://pair?${params.toString()}`;
}

export function isPairingInvitePath(pathname) {
  return pathname === '/pairing/invite'
    || pathname === '/api/pairing/invite'
    || pathname === '/api/v1/pairing/invite';
}

export function isLoopbackAddress(address) {
  const normalized = normalizeText(address).toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === 'localhost';
}

function presentInvite(invite) {
  return {
    ...invite,
    qrContent: buildMigelPairUri(invite),
  };
}

function normalizeEndpoint({
  host,
  port,
  secure,
  path,
} = {}) {
  const normalizedHost = normalizeText(host);
  const normalizedPort = positiveInteger(port, 443);
  return {
    host: normalizedHost,
    port: normalizedPort,
    secure: parseBoolean(secure, true),
    path: normalizePath(path),
  };
}

function uniqueValue(existing, createValue) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const value = createValue();
    if (!existing.has(value)) return value;
  }
  throw new Error('无法生成唯一配对邀请。');
}

function formatManualCode(randomBytes) {
  const bytes = randomBytes(8);
  let text = '';
  for (const byte of bytes) {
    text += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    if (text.length >= 8) break;
  }
  return `${text.slice(0, 4)}-${text.slice(4, 8)}`;
}

function loadPairingState(statePath, logger) {
  const normalizedPath = normalizeText(statePath);
  if (!normalizedPath || !existsSync(normalizedPath)) {
    return {
      deviceRecords: [],
      desktopClaimRedemptions: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(normalizedPath, 'utf8'));
    return {
      deviceRecords: (Array.isArray(parsed?.deviceTokens) ? parsed.deviceTokens : [])
      .filter((record) => normalizeText(record?.tokenHash))
      .map((record) => [normalizeText(record.tokenHash), {
        tokenHash: normalizeText(record.tokenHash),
        role: normalizeText(record.role) || 'android',
        pairedAtEpochMillis: Number(record.pairedAtEpochMillis) || null,
        lastUsedAtEpochMillis: Number(record.lastUsedAtEpochMillis) || null,
        inviteId: normalizeText(record.inviteId),
        code: normalizeText(record.code),
        client: normalizeText(record.client),
        platform: normalizeText(record.platform),
        deviceId: normalizeText(record.deviceId),
        nodeId: normalizeText(record.nodeId),
        name: normalizeText(record.name),
        claimId: normalizeText(record.claimId),
      }]),
      desktopClaimRedemptions: (Array.isArray(parsed?.desktopClaimRedemptions) ? parsed.desktopClaimRedemptions : [])
        .filter((record) => normalizeText(record?.claimHash))
        .map((record) => [normalizeText(record.claimHash), {
          claimHash: normalizeText(record.claimHash),
          claimId: normalizeText(record.claimId),
          deviceId: normalizeText(record.deviceId),
          redeemedAtEpochMillis: Number(record.redeemedAtEpochMillis) || null,
          expiresAtEpochMillis: Number(record.expiresAtEpochMillis) || null,
        }]),
    };
  } catch (error) {
    logger?.warn?.({
      code: 'pairing_state_load_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      deviceRecords: [],
      desktopClaimRedemptions: [],
    };
  }
}

function persistPairingState(statePath, {
  devicesByTokenHash,
  usedDesktopClaimsByHash,
}, logger) {
  const normalizedPath = normalizeText(statePath);
  if (!normalizedPath) return;
  try {
    mkdirSync(dirname(normalizedPath), {
      recursive: true,
      mode: 0o700,
    });
    const payload = JSON.stringify({
      version: 2,
      deviceTokens: Array.from(devicesByTokenHash.values()),
      desktopClaimRedemptions: Array.from(usedDesktopClaimsByHash.values()),
    }, null, 2);
    const tempPath = `${normalizedPath}.tmp`;
    writeFileSync(tempPath, `${payload}\n`, {
      mode: 0o600,
    });
    renameSync(tempPath, normalizedPath);
  } catch (error) {
    logger?.warn?.({
      code: 'pairing_state_persist_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function hashDeviceToken(token) {
  return createHash('sha256')
    .update(normalizeText(token))
    .digest('hex');
}

function hashDesktopClaim(claim) {
  return createHash('sha256')
    .update(normalizeText(claim))
    .digest('hex');
}

function verifyDesktopClaim({
  claim,
  secret,
  configuredClaimHashes,
  now,
  skewMillis,
} = {}) {
  const normalizedClaim = normalizeText(claim);
  if (!normalizedClaim) {
    return {
      ok: false,
      error: 'missing_desktop_claim',
      message: '缺少桌面连接凭证。',
    };
  }

  const claimHash = hashDesktopClaim(normalizedClaim);
  if (configuredClaimHashes?.has(claimHash)) {
    return {
      ok: true,
      source: 'configured_claim',
      claimId: claimHash.slice(0, 16),
      expiresAtEpochMillis: null,
      deviceId: '',
    };
  }

  const normalizedSecret = normalizeText(secret);
  if (!normalizedSecret) {
    return {
      ok: false,
      error: 'desktop_claim_verifier_not_configured',
      message: 'Relay 尚未配置桌面连接凭证校验器。',
    };
  }
  if (!normalizedClaim.startsWith(DESKTOP_CLAIM_PREFIX)) {
    return {
      ok: false,
      error: 'invalid_desktop_claim_format',
      message: '桌面连接凭证格式无效。',
    };
  }

  const body = normalizedClaim.slice(DESKTOP_CLAIM_PREFIX.length);
  const [payloadPart, signature] = body.split('.', 2);
  if (!payloadPart || !signature) {
    return {
      ok: false,
      error: 'invalid_desktop_claim_format',
      message: '桌面连接凭证格式无效。',
    };
  }
  const expectedSignature = signDesktopClaimPayload(payloadPart, normalizedSecret);
  if (!safeEqual(signature, expectedSignature)) {
    return {
      ok: false,
      error: 'invalid_desktop_claim_signature',
      message: '桌面连接凭证签名无效。',
    };
  }

  const payload = parseJsonBuffer(base64UrlDecode(payloadPart));
  if (!payload || (normalizeText(payload.typ) && normalizeText(payload.typ) !== DESKTOP_CLAIM_TYP)) {
    return {
      ok: false,
      error: 'invalid_desktop_claim_payload',
      message: '桌面连接凭证内容无效。',
    };
  }

  const currentTime = now();
  const skew = positiveInteger(skewMillis, DEFAULT_DESKTOP_CLAIM_SKEW_MILLIS);
  const expiresAtEpochMillis = normalizeEpochMillis(payload.exp || payload.expiresAtEpochMillis);
  if (!expiresAtEpochMillis || expiresAtEpochMillis + skew <= currentTime) {
    return {
      ok: false,
      error: 'expired_desktop_claim',
      message: '桌面连接凭证已过期。',
    };
  }
  const notBeforeEpochMillis = normalizeEpochMillis(payload.nbf || payload.notBeforeEpochMillis);
  if (notBeforeEpochMillis && notBeforeEpochMillis - skew > currentTime) {
    return {
      ok: false,
      error: 'desktop_claim_not_active',
      message: '桌面连接凭证尚未生效。',
    };
  }

  return {
    ok: true,
    source: 'signed_claim',
    claimId: normalizeText(payload.jti || payload.claimId) || claimHash.slice(0, 16),
    expiresAtEpochMillis,
    deviceId: normalizeText(payload.deviceId || payload.desktopDeviceId || payload.nodeId),
  };
}

function signDesktopClaimPayload(payloadPart, secret) {
  return base64Url(createHmac('sha256', secret).update(payloadPart).digest());
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlDecode(value) {
  const text = normalizeText(value);
  const padded = `${text}${'='.repeat((4 - (text.length % 4)) % 4)}`;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(Buffer.from(buffer).toString('utf8'));
  } catch {
    return null;
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizeManualCode(value) {
  return normalizeText(value)
    .replace(/\s+/g, '')
    .toUpperCase();
}

function normalizePath(value) {
  const normalized = normalizeText(value);
  if (!normalized) return '/gateway';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function normalizeEpochMillis(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 10_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function removeBlankValues(value) {
  return Object.fromEntries(
    Object.entries(normalizeObject(value)).filter(([, entry]) => entry !== '' && entry != null),
  );
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  return normalizeText(value)
    .split(',')
    .map(normalizeText)
    .filter(Boolean);
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return Boolean(fallback);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeText(value) {
  if (value == null) return '';
  return String(value).trim();
}
