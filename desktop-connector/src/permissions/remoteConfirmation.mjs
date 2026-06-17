import { normalizeConfirmationResult } from './confirmation.mjs';
import {
  formatPermissionRequest,
  normalizePermissionRequest,
} from './policy.mjs';

const DEFAULT_REMOTE_CONFIRMATION_TIMEOUT_MS = 120000;
const DEFAULT_MAX_SESSION_GRANTS = 200;
const PERMISSION_SCOPE_ONCE = 'once';
const PERMISSION_SCOPE_SESSION_RELATED = 'session_related';
const PERMISSION_SCOPE_ADJUST = 'adjust';
const SESSION_GRANT_KEY_SEPARATOR = '\u001f';

export function createRemotePermissionConfirmer({
  sendFrame,
  timeoutMs = DEFAULT_REMOTE_CONFIRMATION_TIMEOUT_MS,
  maxSessionGrants = DEFAULT_MAX_SESSION_GRANTS,
  createPermissionId = defaultCreatePermissionId,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  now = () => Date.now(),
} = {}) {
  const pending = new Map();
  const sessionGrants = new Map();

  async function confirm(event = {}) {
    const context = normalizeObject(event.context);
    const request = normalizeObject(event.request || event.decision?.request);
    const sendPermissionFrame = typeof context.emitFrame === 'function'
      ? context.emitFrame
      : sendFrame;
    const permissionId = normalizeText(event.permissionId)
      || normalizeText(event.id)
      || createPermissionId('perm');
    const requestId = normalizeText(context.requestId);
    const jobId = normalizeText(context.jobId);
    if (!requestId || !jobId) {
      return normalizeConfirmationResult({
        allowed: false,
        reason: '远程权限确认不可用。',
        decidedBy: 'desktop-connector',
        metadata: {
          permissionId,
          requestId,
          jobId,
        },
      });
    }

    const sessionGrantKey = createSessionGrantKey({ context, request });
    const sessionGrant = sessionGrantKey ? sessionGrants.get(sessionGrantKey) : null;
    if (sessionGrant) {
      return normalizeConfirmationResult({
        allowed: true,
        reason: sessionGrant.reason || '本次会话已允许同类操作。',
        decidedBy: 'android-session-grant',
        metadata: {
          permissionId,
          requestId,
          jobId,
          scope: PERMISSION_SCOPE_SESSION_RELATED,
          grantPermissionId: sessionGrant.permissionId,
          conversationId: sessionGrant.conversationId,
        },
      });
    }

    if (typeof sendPermissionFrame !== 'function') {
      return normalizeConfirmationResult({
        allowed: false,
        reason: '远程权限确认不可用。',
        decidedBy: 'desktop-connector',
        metadata: {
          permissionId,
          requestId,
          jobId,
        },
      });
    }

    const expiresAtEpochMillis = Number(now()) + normalizeTimeoutMs(timeoutMs);
    const frame = createPermissionRequestFrame({
      permissionId,
      context,
      request,
      reason: event.decision?.reason || event.reason,
      expiresAtEpochMillis,
    });

    return await new Promise((resolve) => {
      const timer = createTimeout(() => {
        pending.delete(permissionId);
        resolve(normalizeConfirmationResult({
          allowed: false,
          reason: '远程权限确认超时。',
          decidedBy: 'android-timeout',
          metadata: {
            permissionId,
            requestId,
            jobId,
          },
        }));
      }, normalizeTimeoutMs(timeoutMs));

      pending.set(permissionId, {
        permissionId,
        requestId,
        jobId,
        context,
        request,
        sessionGrantKey,
        resolve,
        timer,
      });

      Promise.resolve(sendPermissionFrame(frame)).catch((error) => {
        pending.delete(permissionId);
        clearTimer(timer);
        resolve(normalizeConfirmationResult({
          allowed: false,
          reason: error instanceof Error ? error.message : '远程权限请求发送失败。',
          decidedBy: 'desktop-connector',
          metadata: {
            permissionId,
            requestId,
            jobId,
          },
        }));
      });
    });
  }

  async function handleDecision(frame = {}) {
    const permissionId = normalizeText(frame.permissionId || frame.id);
    const record = permissionId ? pending.get(permissionId) : null;
    if (!record) {
      return {
        handled: false,
        reason: 'missing_pending_permission',
        permissionId,
      };
    }
    pending.delete(permissionId);
    clearTimer(record.timer);
    const confirmation = normalizePermissionDecisionFrame(frame, record);
    if (
      confirmation.allowed
      && confirmation.metadata?.scope === PERMISSION_SCOPE_SESSION_RELATED
      && record.sessionGrantKey
    ) {
      sessionGrants.set(record.sessionGrantKey, {
        permissionId: record.permissionId,
        requestId: record.requestId,
        jobId: record.jobId,
        conversationId: normalizeText(record.context?.conversationId),
        reason: confirmation.reason,
        grantedAtEpochMillis: Number(now()) || Date.now(),
      });
      trimSessionGrants(sessionGrants, maxSessionGrants);
    }
    record.resolve(confirmation);
    return {
      handled: true,
      permissionId,
      confirmation,
    };
  }

  function createTimeout(callback, delayMs) {
    if (typeof setTimeoutImpl !== 'function') return null;
    const timer = setTimeoutImpl(callback, delayMs);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
    return timer;
  }

  function clearTimer(timer) {
    if (timer && typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(timer);
    }
  }

  return {
    confirm,
    handleDecision,
    pendingCount: () => pending.size,
    sessionGrantCount: () => sessionGrants.size,
  };
}

export function createPermissionRequestFrame({
  permissionId,
  context = {},
  request = {},
  reason = '',
  expiresAtEpochMillis,
  version = 1,
} = {}) {
  const normalizedContext = normalizeObject(context);
  const normalizedRequest = normalizeObject(request);
  const message = formatPermissionRequest(normalizedRequest);
  return compactObject({
    type: 'permission.request',
    version,
    permissionId: normalizeText(permissionId),
    jobId: normalizeText(normalizedContext.jobId),
    requestId: normalizeText(normalizedContext.requestId),
    conversationId: normalizeText(normalizedContext.conversationId),
    targetDeviceId: normalizeText(normalizedContext.fromDeviceId),
    message: message || '敏感操作需要确认。',
    reason: normalizeText(reason),
    operation: normalizeText(normalizedRequest.operation),
    target: normalizeText(normalizedRequest.target),
    command: normalizeText(normalizedRequest.command),
    path: normalizeText(normalizedRequest.path),
    directory: normalizeText(normalizedRequest.directory),
    toolName: normalizeText(normalizedRequest.toolName),
    intent: normalizeText(normalizedRequest.intent),
    requestedBy: normalizeText(normalizedRequest.requestedBy),
    request: normalizedRequest,
    expiresAtEpochMillis: Number(expiresAtEpochMillis) || undefined,
  });
}

function normalizePermissionDecisionFrame(frame, record) {
  const action = normalizeText(frame.decision || frame.action || frame.outcome).toLowerCase();
  const scope = normalizePermissionScope(frame.scope);
  const approved = frame.approved === true
    || frame.allowed === true
    || frame.confirmed === true
    || ['allow', 'allowed', 'approve', 'approved', 'confirm', 'confirmed'].includes(action);
  const denied = frame.approved === false
    || frame.allowed === false
    || frame.confirmed === false
    || ['deny', 'denied', 'reject', 'rejected'].includes(action);
  const allowed = denied ? false : approved;
  return normalizeConfirmationResult({
    allowed,
    reason: normalizeText(frame.reason || frame.message) || (allowed ? '用户已在安卓端确认。' : '用户已在安卓端拒绝。'),
    decidedBy: normalizeText(frame.decidedBy || frame.source || frame.user) || 'android-user',
    metadata: {
      permissionId: record.permissionId,
      requestId: record.requestId,
      jobId: record.jobId,
      scope,
      conversationId: normalizeText(record.context?.conversationId),
    },
  });
}

function createSessionGrantKey({ context = {}, request = {} } = {}) {
  const conversationId = normalizeText(context.conversationId);
  if (!conversationId) return '';
  const normalizedRequest = normalizePermissionRequest(request);
  const operation = normalizeText(normalizedRequest.operation);
  if (!operation || operation === 'unknown') return '';
  const target = firstText(
    normalizedRequest.command,
    normalizedRequest.path,
    normalizedRequest.directory,
    normalizedRequest.toolName,
    normalizedRequest.target,
  );
  if (!target) return '';
  return [conversationId, operation, target].join(SESSION_GRANT_KEY_SEPARATOR);
}

function normalizePermissionScope(value) {
  const text = normalizeText(value).toLowerCase().replace(/[-\s]+/g, '_');
  if (['session', 'conversation', 'conversation_related', PERMISSION_SCOPE_SESSION_RELATED].includes(text)) {
    return PERMISSION_SCOPE_SESSION_RELATED;
  }
  if (['adjust', 'revise', 'modify', PERMISSION_SCOPE_ADJUST].includes(text)) {
    return PERMISSION_SCOPE_ADJUST;
  }
  return PERMISSION_SCOPE_ONCE;
}

function trimSessionGrants(sessionGrants, maxSessionGrants) {
  const max = Number.isFinite(Number(maxSessionGrants))
    ? Math.max(1, Math.floor(Number(maxSessionGrants)))
    : DEFAULT_MAX_SESSION_GRANTS;
  while (sessionGrants.size > max) {
    const firstKey = sessionGrants.keys().next().value;
    if (firstKey === undefined) return;
    sessionGrants.delete(firstKey);
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(normalizeObject(value)).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function normalizeTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1000) return DEFAULT_REMOTE_CONFIRMATION_TIMEOUT_MS;
  return Math.floor(numeric);
}

function defaultCreatePermissionId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
