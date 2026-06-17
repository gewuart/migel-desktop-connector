export function createMemoryPermissionDecisionStore({ clock = defaultClock, maxRecords = 1000 } = {}) {
  const records = [];
  return {
    async append(record) {
      const normalizedRecord = normalizePermissionDecisionRecord(record, { clock });
      records.push(normalizedRecord);
      while (records.length > maxRecords) records.shift();
      return cloneRecord(normalizedRecord);
    },
    async list(filter = {}) {
      const normalizedFilter = normalizeRecordFilter(filter);
      return records
        .filter((record) => matchesRecordFilter(record, normalizedFilter))
        .map((record) => cloneRecord(record));
    },
    async clear() {
      records.length = 0;
    },
  };
}

export function normalizeConfirmationResult(result) {
  if (result === true) {
    return {
      allowed: true,
      reason: '用户已确认。',
      decidedBy: 'local-user',
      metadata: {},
    };
  }
  if (result === false || result === null || result === undefined) {
    return {
      allowed: false,
      reason: '用户已拒绝。',
      decidedBy: 'local-user',
      metadata: {},
    };
  }

  const source = normalizeObject(result);
  const decision = normalizeText(source.decision || source.action || source.outcome).toLowerCase();
  const allowed = source.allowed === true
    || source.approved === true
    || source.confirmed === true
    || ['allow', 'allowed', 'approve', 'approved', 'confirm', 'confirmed'].includes(decision);
  const denied = source.allowed === false
    || source.approved === false
    || source.confirmed === false
    || ['deny', 'denied', 'reject', 'rejected'].includes(decision);
  const resolvedAllowed = denied ? false : allowed;

  return {
    allowed: resolvedAllowed,
    reason: normalizeText(source.reason || source.message) || (resolvedAllowed ? '用户已确认。' : '用户已拒绝。'),
    decidedBy: normalizeText(source.decidedBy || source.user || source.source) || 'local-user',
    metadata: normalizeObject(source.metadata),
  };
}

export function createStaticPermissionConfirmer(result = false) {
  return async () => normalizeConfirmationResult(result);
}

export function normalizePermissionDecisionRecord(record = {}, { clock = defaultClock } = {}) {
  const requestedAt = normalizeText(record.requestedAt) || toIsoString(clock());
  const decidedAt = normalizeText(record.decidedAt) || toIsoString(clock());
  return compactObject({
    type: 'permission.record',
    id: normalizeText(record.id),
    stage: normalizeText(record.stage),
    decision: normalizeText(record.decision),
    outcome: normalizeText(record.outcome),
    allowed: typeof record.allowed === 'boolean' ? record.allowed : undefined,
    source: normalizeText(record.source),
    sensitive: typeof record.sensitive === 'boolean' ? record.sensitive : undefined,
    ruleId: normalizeText(record.ruleId),
    reason: normalizeText(record.reason),
    request: normalizeRecordObject(record.request),
    context: normalizeRecordObject(record.context),
    confirmation: normalizeRecordObject(record.confirmation),
    requestedAt,
    decidedAt,
    recordedAt: normalizeText(record.recordedAt) || toIsoString(clock()),
  });
}

function normalizeRecordFilter(filter = {}) {
  const source = normalizeObject(filter);
  return {
    id: normalizeText(source.id),
    jobId: normalizeText(source.jobId),
    requestId: normalizeText(source.requestId),
    decision: normalizeText(source.decision),
    outcome: normalizeText(source.outcome),
    stage: normalizeText(source.stage),
  };
}

function matchesRecordFilter(record, filter) {
  if (filter.id && record.id !== filter.id) return false;
  if (filter.jobId && record.context?.jobId !== filter.jobId) return false;
  if (filter.requestId && record.context?.requestId !== filter.requestId) return false;
  if (filter.decision && record.decision !== filter.decision) return false;
  if (filter.outcome && record.outcome !== filter.outcome) return false;
  if (filter.stage && record.stage !== filter.stage) return false;
  return true;
}

function cloneRecord(record) {
  return {
    ...record,
    request: cloneObject(record.request),
    context: cloneObject(record.context),
    confirmation: cloneObject(record.confirmation),
  };
}

function normalizeRecordObject(value) {
  return cloneObject(normalizeObject(value));
}

function cloneObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  const text = normalizeText(value);
  if (text) return text;
  return new Date(value).toISOString();
}

function defaultClock() {
  return new Date();
}
