export const PERMISSION_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  CONFIRM: 'confirm',
  DENY: 'deny',
});

export const DEFAULT_SENSITIVE_OPERATIONS = Object.freeze([
  'command.execute',
  'directory.access',
  'file.delete',
  'file.read',
  'file.write',
  'tool.invoke',
]);

export const DEFAULT_SAFE_OPERATIONS = Object.freeze([
  'agent.invoke',
]);

const DEFAULT_POLICY_VERSION = 1;
const UNKNOWN_OPERATION = 'unknown';

const OPERATION_ALIASES = new Map([
  ['agent_invoke', 'agent.invoke'],
  ['agent_request', 'agent.invoke'],
  ['chat_completion', 'agent.invoke'],
  ['command_execute', 'command.execute'],
  ['code_execute', 'command.execute'],
  ['execute_code', 'command.execute'],
  ['execute_command', 'command.execute'],
  ['exec', 'command.execute'],
  ['run_command', 'command.execute'],
  ['shell', 'command.execute'],
  ['directory_access', 'directory.access'],
  ['directory_read', 'directory.access'],
  ['read_directory', 'directory.access'],
  ['file_delete', 'file.delete'],
  ['delete_file', 'file.delete'],
  ['file_read', 'file.read'],
  ['read_file', 'file.read'],
  ['file_write', 'file.write'],
  ['write_file', 'file.write'],
  ['external_tool', 'tool.invoke'],
  ['external_tool_invoke', 'tool.invoke'],
  ['invoke_tool', 'tool.invoke'],
  ['tool_invoke', 'tool.invoke'],
]);

export function createLocalPermissionPolicy({
  defaultDecision = PERMISSION_DECISIONS.ALLOW,
  defaultSensitiveDecision = PERMISSION_DECISIONS.CONFIRM,
  sensitiveOperations = DEFAULT_SENSITIVE_OPERATIONS,
  safeOperations = DEFAULT_SAFE_OPERATIONS,
  rules = [],
  version = DEFAULT_POLICY_VERSION,
} = {}) {
  return {
    type: 'desktop.permission-policy',
    version,
    defaultDecision: normalizeDecision(defaultDecision, PERMISSION_DECISIONS.ALLOW),
    defaultSensitiveDecision: normalizeDecision(
      defaultSensitiveDecision,
      PERMISSION_DECISIONS.CONFIRM,
    ),
    sensitiveOperations: normalizeOperationList(sensitiveOperations),
    safeOperations: normalizeOperationList(safeOperations),
    rules: [
      ...createRequiredSafetyRules(),
      ...normalizePermissionRules(rules),
      {
        id: 'allow-agent-invoke',
        decision: PERMISSION_DECISIONS.ALLOW,
        operations: ['agent.invoke'],
        reason: '普通 Agent 调用不直接访问本地敏感资源。',
      },
    ],
  };
}

export function normalizePermissionPolicy(policy = {}) {
  if (policy?.type === 'desktop.permission-policy') {
    return {
      ...policy,
      defaultDecision: normalizeDecision(policy.defaultDecision, PERMISSION_DECISIONS.ALLOW),
      defaultSensitiveDecision: normalizeDecision(
        policy.defaultSensitiveDecision,
        PERMISSION_DECISIONS.CONFIRM,
      ),
      sensitiveOperations: normalizeOperationList(policy.sensitiveOperations),
      safeOperations: normalizeOperationList(policy.safeOperations),
      rules: normalizePermissionRules(policy.rules),
    };
  }
  return createLocalPermissionPolicy(policy);
}

export function decidePermissionRequest(request = {}, policy = createLocalPermissionPolicy()) {
  const normalizedPolicy = normalizePermissionPolicy(policy);
  const normalizedRequest = normalizePermissionRequest(request);
  const matchedRule = normalizedPolicy.rules.find((rule) => matchesPermissionRule(rule, normalizedRequest));
  const sensitive = isSensitiveOperation(normalizedRequest.operation, normalizedPolicy);
  const decision = matchedRule?.decision
    || (sensitive ? normalizedPolicy.defaultSensitiveDecision : normalizedPolicy.defaultDecision);

  return {
    type: 'permission.decision',
    policyVersion: normalizedPolicy.version,
    decision,
    allowed: decision === PERMISSION_DECISIONS.ALLOW,
    requiresConfirmation: decision === PERMISSION_DECISIONS.CONFIRM,
    sensitive,
    request: normalizedRequest,
    reason: matchedRule?.reason || defaultDecisionReason(decision, sensitive),
    ruleId: matchedRule?.id || '',
  };
}

export function normalizePermissionRequest(request = {}) {
  const base = normalizeObject(request);
  const nestedOperation = normalizeObject(base.operation);
  const source = { ...nestedOperation, ...base };
  const operation = normalizeOperationKind(
    firstText(
      source.operationKind,
      source.kind,
      typeof source.operation === 'string' ? source.operation : '',
      source.type,
      source.action,
    ),
  );
  const command = normalizeCommand(source.command ?? source.cmd ?? source.argv);
  const path = firstText(source.path, source.filePath, source.file, source.targetPath);
  const directory = firstText(source.directory, source.dir, source.cwd);
  const toolName = firstText(source.toolName, source.tool, source.name);
  const target = firstText(source.target, path, directory, command, toolName);

  return {
    operation,
    target,
    command,
    path,
    directory,
    toolName,
    intent: firstText(source.intent, source.summary, source.reason, source.description),
    requestedBy: firstText(source.requestedBy, source.source, source.actor),
    metadata: normalizeObject(source.metadata),
  };
}

export function normalizeOperationKind(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return UNKNOWN_OPERATION;
  const snake = text
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const dotted = snake.replace(/_/g, '.');
  return OPERATION_ALIASES.get(text)
    || OPERATION_ALIASES.get(snake)
    || OPERATION_ALIASES.get(dotted)
    || dotted
    || UNKNOWN_OPERATION;
}

export function isSensitiveOperation(operation, policy = createLocalPermissionPolicy()) {
  const normalizedOperation = normalizeOperationKind(operation);
  if (normalizedOperation === UNKNOWN_OPERATION) return true;
  const normalizedPolicy = normalizePermissionPolicy(policy);
  if (normalizedPolicy.sensitiveOperations.includes(normalizedOperation)) return true;
  if (normalizedPolicy.safeOperations.includes(normalizedOperation)) return false;
  return true;
}

export function normalizePermissionRules(rules = []) {
  return normalizeList(rules)
    .map((rule) => normalizePermissionRule(rule))
    .filter(Boolean);
}

export function formatPermissionRequest(request = {}) {
  const normalizedRequest = normalizePermissionRequest(request);
  const label = operationLabel(normalizedRequest.operation);
  const target = firstText(
    normalizedRequest.command,
    normalizedRequest.path,
    normalizedRequest.directory,
    normalizedRequest.toolName,
    normalizedRequest.target,
  );
  return target ? `${label}：${target}` : label;
}

function normalizePermissionRule(rule = {}) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const decision = normalizeDecision(
    rule.decision || rule.effect || rule.action,
    PERMISSION_DECISIONS.CONFIRM,
  );
  return {
    id: normalizeText(rule.id) || `rule:${decision}`,
    decision,
    operations: normalizeOperationList(
      rule.operations
        || rule.operationKinds
        || rule.operationKind
        || rule.operation
        || rule.kind,
    ),
    targets: normalizeTextList(rule.targets || rule.target),
    targetPrefixes: normalizeTextList(rule.targetPrefixes || rule.targetPrefix || rule.pathPrefixes),
    toolNames: normalizeTextList(rule.toolNames || rule.toolName || rule.tools || rule.tool),
    commandIncludes: normalizeTextList(rule.commandIncludes || rule.commandInclude),
    commandPatterns: normalizeList(rule.commandPatterns || rule.commandPattern),
    reason: normalizeText(rule.reason),
    match: typeof rule.match === 'function' ? rule.match : null,
  };
}

function createRequiredSafetyRules() {
  return [
    {
      id: 'deny-empty-command',
      decision: PERMISSION_DECISIONS.DENY,
      operations: ['command.execute'],
      reason: '缺少要执行的命令。',
      match: (request) => !request.command,
    },
    {
      id: 'deny-empty-tool',
      decision: PERMISSION_DECISIONS.DENY,
      operations: ['tool.invoke'],
      reason: '缺少要调用的外部工具名称。',
      match: (request) => !request.toolName,
    },
    {
      id: 'deny-empty-local-path',
      decision: PERMISSION_DECISIONS.DENY,
      operations: ['directory.access', 'file.delete', 'file.read', 'file.write'],
      reason: '缺少本地路径目标。',
      match: (request) => !request.path && !request.directory && !request.target,
    },
  ];
}

function matchesPermissionRule(rule, request) {
  if (!rule) return false;
  if (rule.operations.length && !rule.operations.includes(request.operation)) return false;
  if (rule.targets.length && !rule.targets.includes(request.target)) return false;
  if (rule.targetPrefixes.length && !rule.targetPrefixes.some((prefix) => matchesPrefix(request.target, prefix))) {
    return false;
  }
  if (rule.toolNames.length && !rule.toolNames.includes(request.toolName)) return false;
  if (rule.commandIncludes.length && !rule.commandIncludes.some((part) => request.command.includes(part))) {
    return false;
  }
  if (rule.commandPatterns.length && !rule.commandPatterns.some((pattern) => matchesPattern(request.command, pattern))) {
    return false;
  }
  if (typeof rule.match === 'function' && !rule.match(request)) return false;
  return true;
}

function matchesPrefix(value, prefix) {
  const target = normalizeText(value);
  const normalizedPrefix = normalizeText(prefix);
  if (!target || !normalizedPrefix) return false;
  if (target === normalizedPrefix) return true;
  const prefixWithSlash = normalizedPrefix.endsWith('/') ? normalizedPrefix : `${normalizedPrefix}/`;
  return target.startsWith(prefixWithSlash);
}

function matchesPattern(value, pattern) {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }
  const text = normalizeText(pattern);
  return Boolean(text && value.includes(text));
}

function defaultDecisionReason(decision, sensitive) {
  if (decision === PERMISSION_DECISIONS.ALLOW) return sensitive ? '本地策略允许敏感操作。' : '本地策略允许非敏感操作。';
  if (decision === PERMISSION_DECISIONS.DENY) return '本地策略拒绝该操作。';
  return '敏感操作需要本地确认。';
}

function operationLabel(operation) {
  return {
    'agent.invoke': 'Agent 调用',
    'command.execute': '命令执行',
    'directory.access': '目录访问',
    'file.delete': '文件删除',
    'file.read': '文件读取',
    'file.write': '文件写入',
    'tool.invoke': '外部工具调用',
  }[operation] || '本地操作';
}

function normalizeOperationList(value) {
  return normalizeList(value)
    .map((item) => normalizeOperationKind(item))
    .filter(Boolean);
}

function normalizeTextList(value) {
  return normalizeList(value)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function normalizeDecision(value, fallback) {
  const decision = normalizeText(value).toLowerCase();
  if (Object.values(PERMISSION_DECISIONS).includes(decision)) return decision;
  return fallback;
}

function normalizeCommand(value) {
  if (Array.isArray(value)) return value.map((part) => String(part || '')).join(' ').trim();
  return normalizeText(value);
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
