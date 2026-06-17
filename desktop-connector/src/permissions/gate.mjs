import {
  createMemoryPermissionDecisionStore,
  normalizeConfirmationResult,
} from './confirmation.mjs';
import {
  createLocalPermissionPolicy,
  decidePermissionRequest,
  formatPermissionRequest,
  PERMISSION_DECISIONS,
} from './policy.mjs';

export class PermissionDeniedError extends Error {
  constructor(message, {
    code = 'permission_denied',
    retriable = false,
    decision = null,
    record = null,
  } = {}) {
    super(message);
    this.name = 'PermissionDeniedError';
    this.code = code;
    this.retriable = Boolean(retriable);
    this.decision = decision;
    this.record = record;
  }
}

export function createPermissionGate({
  policy = createLocalPermissionPolicy(),
  confirm,
  confirmPermission,
  decisionStore = createMemoryPermissionDecisionStore(),
  onDecision,
  onConfirmationRequired,
  clock = defaultClock,
} = {}) {
  const localConfirm = typeof confirm === 'function' ? confirm : confirmPermission;

  const decide = async (request, context = {}) => {
    const initialDecision = decidePermissionRequest(request, policy);
    if (initialDecision.decision === PERMISSION_DECISIONS.ALLOW) {
      const record = await recordDecision(decisionStore, {
        stage: 'policy',
        outcome: 'allowed',
        allowed: true,
        source: 'policy',
        decision: initialDecision,
        context,
        clock,
      });
      await onDecision?.(record);
      return {
        ...initialDecision,
        allowed: true,
        outcome: 'allowed',
        source: 'policy',
        record,
      };
    }

    if (initialDecision.decision === PERMISSION_DECISIONS.DENY) {
      const record = await recordDecision(decisionStore, {
        stage: 'policy',
        outcome: 'denied',
        allowed: false,
        source: 'policy',
        decision: initialDecision,
        context,
        clock,
      });
      await onDecision?.(record);
      return {
        ...initialDecision,
        allowed: false,
        outcome: 'denied',
        source: 'policy',
        record,
      };
    }

    const pendingRecord = await recordDecision(decisionStore, {
      stage: 'confirmation',
      outcome: 'waiting_confirmation',
      allowed: false,
      source: 'policy',
      decision: initialDecision,
      context,
      reason: initialDecision.reason,
      clock,
    });

    await onConfirmationRequired?.({
      decision: initialDecision,
      request: initialDecision.request,
      context,
      record: pendingRecord,
    });

    if (typeof localConfirm !== 'function') {
      const record = await recordDecision(decisionStore, {
        stage: 'confirmation',
        outcome: 'denied',
        allowed: false,
        source: 'missing-confirmer',
        decision: initialDecision,
        context,
        reason: '敏感操作需要本地确认，但当前没有确认入口。',
        confirmation: {
          allowed: false,
          reason: 'missing_confirmer',
          decidedBy: 'desktop-connector',
        },
        clock,
      });
      await onDecision?.(record);
      return {
        ...initialDecision,
        allowed: false,
        outcome: 'denied',
        source: 'missing-confirmer',
        reason: record.reason,
        record,
        pendingRecord,
      };
    }

    const confirmation = normalizeConfirmationResult(await localConfirm({
      decision: initialDecision,
      request: initialDecision.request,
      context,
    }));
    const record = await recordDecision(decisionStore, {
      stage: 'confirmation',
      outcome: confirmation.allowed ? 'allowed' : 'denied',
      allowed: confirmation.allowed,
      source: confirmation.decidedBy,
      decision: initialDecision,
      context,
      reason: confirmation.reason,
      confirmation,
      clock,
    });
    await onDecision?.(record);

    return {
      ...initialDecision,
      allowed: confirmation.allowed,
      outcome: confirmation.allowed ? 'allowed' : 'denied',
      source: confirmation.decidedBy,
      reason: confirmation.reason,
      confirmation,
      record,
      pendingRecord,
    };
  };

  const requireAllowed = async (request, context = {}) => {
    const result = await decide(request, context);
    if (!result.allowed) {
      throw createPermissionDeniedError(result);
    }
    return result;
  };

  const run = async (request, action, context = {}) => {
    const result = await requireAllowed(request, context);
    if (typeof action !== 'function') return result;
    return await action(result);
  };

  return {
    policy,
    decisionStore,
    decide,
    requireAllowed,
    authorize: requireAllowed,
    enforce: requireAllowed,
    run,
    gate: run,
    async listRecords(filter = {}) {
      if (typeof decisionStore?.list === 'function') return await decisionStore.list(filter);
      return [];
    },
  };
}

export function createPermissionDeniedError(decision) {
  const label = formatPermissionRequest(decision?.request);
  return new PermissionDeniedError(`本地权限拒绝：${label}`, {
    code: 'permission_denied',
    retriable: false,
    decision,
    record: decision?.record || null,
  });
}

async function recordDecision(decisionStore, {
  stage,
  outcome,
  allowed,
  source,
  decision,
  context,
  reason,
  confirmation,
  clock,
}) {
  const decidedAt = toIsoString(clock());
  const record = {
    id: createRecordId({ decision, context, stage, outcome, decidedAt }),
    stage,
    decision: decision.decision,
    outcome,
    allowed,
    source,
    sensitive: decision.sensitive,
    ruleId: decision.ruleId,
    reason: reason || decision.reason,
    request: decision.request,
    context: normalizeObject(context),
    confirmation: normalizeObject(confirmation),
    requestedAt: decidedAt,
    decidedAt,
  };
  if (typeof decisionStore?.append === 'function') {
    return await decisionStore.append(record);
  }
  return record;
}

function createRecordId({ decision, context, stage, outcome, decidedAt }) {
  return [
    normalizeText(context?.jobId) || 'job',
    normalizeText(context?.requestId) || 'request',
    normalizeText(stage) || 'stage',
    normalizeText(outcome) || 'outcome',
    decision.request.operation,
    decision.request.target || 'target',
    decidedAt,
  ]
    .join(':')
    .replace(/[^a-zA-Z0-9:._-]/g, '-')
    .slice(0, 240);
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item !== 'function'),
  );
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function defaultClock() {
  return new Date();
}
