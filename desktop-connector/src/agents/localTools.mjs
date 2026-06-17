import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DESKTOP_COMMAND_TOOL_NAME = 'execute_desktop_command';
export const EXECUTE_CODE_TOOL_NAME = 'execute_code';
export const DESKTOP_COMMAND_TOOL_NAMES = Object.freeze([
  DESKTOP_COMMAND_TOOL_NAME,
  EXECUTE_CODE_TOOL_NAME,
]);

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_CHARS = 20000;

export function createLocalToolController({
  permissionGate,
  enabled = true,
  executeCommand = executeShellCommand,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  commandMaxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  shell = defaultShell(),
} = {}) {
  const canConfirm = typeof permissionGate?.requireAllowed === 'function'
    || typeof permissionGate?.authorize === 'function'
    || typeof permissionGate?.enforce === 'function';
  const commandToolEnabled = Boolean(enabled && canConfirm && typeof executeCommand === 'function');
  const definitions = commandToolEnabled ? desktopCommandToolDefinitions() : [];

  async function executeToolCall(toolCall, context = {}) {
    const name = normalizeToolName(toolCall);
    if (!isDesktopCommandToolName(name)) {
      throw new Error(`Hermes 请求了不支持的本地工具：${name || 'unknown'}`);
    }
    if (!commandToolEnabled) {
      throw new Error('本地命令工具不可用：缺少权限确认入口。');
    }

    const args = parseToolArguments(toolCall?.function?.arguments);
    const command = normalizeText(args.command || args.cmd);
    if (!command) {
      throw new Error('本地命令工具缺少 command 参数。');
    }
    const cwd = normalizeText(args.cwd || args.directory || args.dir);
    const intent = normalizeText(args.intent || args.reason || args.summary)
      || normalizeText(context.agentRequest?.text)
      || '执行用户请求的本地命令。';

    const authorize = permissionGate.requireAllowed
      || permissionGate.authorize
      || permissionGate.enforce;
    await authorize.call(permissionGate, {
      operation: 'command.execute',
      command,
      directory: cwd,
      intent,
      requestedBy: 'hermes-tool-call',
      metadata: compactObject({
        toolName: DESKTOP_COMMAND_TOOL_NAME,
        requestedToolName: name === DESKTOP_COMMAND_TOOL_NAME ? '' : name,
        toolCallId: normalizeText(toolCall?.id),
      }),
    }, {
      toolName: name,
      toolCallId: normalizeText(toolCall?.id),
      toolIteration: context.toolIteration,
    });

    const result = await executeCommand({
      command,
      cwd: resolveCwd(cwd),
      timeoutMs: positiveInteger(args.timeoutMs, commandTimeoutMs),
      maxOutputChars: positiveInteger(args.maxOutputChars, commandMaxOutputChars),
      shell,
    });
    return JSON.stringify(normalizeCommandResult({
      ...result,
      command,
      cwd: cwd || result?.cwd || '',
    }));
  }

  return {
    definitions,
    hasTools: () => definitions.length > 0,
    executeToolCall,
  };
}

export function desktopCommandToolDefinition() {
  return commandToolDefinition(DESKTOP_COMMAND_TOOL_NAME, [
    'Execute a local shell command on the user desktop only when the user explicitly asks for a desktop command.',
    'Desktop Connector will request Android permission before the command runs.',
    'Do not claim a permission popup was triggered unless you call this tool.',
  ].join(' '));
}

export function executeCodeToolDefinition() {
  return commandToolDefinition(EXECUTE_CODE_TOOL_NAME, [
    'Execute code or a shell command on the user desktop only when the user explicitly asks for local execution.',
    'This is the same permission path as command.execute and Desktop Connector will request Android permission before it runs.',
    'Do not claim a permission popup was triggered unless you call this tool.',
  ].join(' '));
}

export function desktopCommandToolDefinitions() {
  return [
    desktopCommandToolDefinition(),
    executeCodeToolDefinition(),
  ];
}

function commandToolDefinition(name, description) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: {
            type: 'string',
            description: 'The exact shell command to run after permission is approved.',
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory. Use this when the user asks to run in Desktop or another directory.',
          },
          intent: {
            type: 'string',
            description: 'Short human-readable reason shown in the permission request.',
          },
        },
        required: ['command'],
      },
    },
  };
}

export function localToolsSystemMessage() {
  return [
    '你正在通过 Desktop Connector 帮用户操作本机。',
    `如果用户明确要求执行电脑命令、终端命令、shell 命令或在某个目录运行命令，必须调用 ${DESKTOP_COMMAND_TOOL_NAME}。`,
    `如果用户明确要求执行代码片段或使用 execute_code 路由，调用 ${EXECUTE_CODE_TOOL_NAME}；它与 ${DESKTOP_COMMAND_TOOL_NAME} 使用同一个 command.execute 权限确认。`,
    '不要只用文字声称已经触发权限弹窗；只有真实调用工具后 Desktop Connector 才会发送 permission.request。',
    '工具返回 stdout/stderr/exitCode 后，再用简短中文把真实结果告诉用户。',
  ].join('\n');
}

function isDesktopCommandToolName(value) {
  return DESKTOP_COMMAND_TOOL_NAMES.includes(normalizeText(value));
}

function compactObject(value = {}) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === '') continue;
    result[key] = item;
  }
  return result;
}

export async function executeShellCommand({
  command,
  cwd,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  shell = defaultShell(),
  execFileImpl = execFileAsync,
} = {}) {
  const startedAtEpochMillis = Date.now();
  try {
    const result = await execFileImpl(shell, ['-lc', command], {
      cwd: cwd || undefined,
      timeout: positiveInteger(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS),
      maxBuffer: Math.max(1024, positiveInteger(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS) * 4),
    });
    return normalizeCommandResult({
      ok: true,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      cwd,
      startedAtEpochMillis,
      finishedAtEpochMillis: Date.now(),
    }, maxOutputChars);
  } catch (error) {
    return normalizeCommandResult({
      ok: false,
      exitCode: Number.isFinite(Number(error?.code)) ? Number(error.code) : null,
      signal: normalizeText(error?.signal),
      stdout: error?.stdout,
      stderr: error?.stderr,
      error: normalizeText(error?.message) || '命令执行失败。',
      cwd,
      startedAtEpochMillis,
      finishedAtEpochMillis: Date.now(),
    }, maxOutputChars);
  }
}

function desktopCommandToolCallArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = normalizeText(value);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { command: text };
  }
}

function parseToolArguments(value) {
  return desktopCommandToolCallArguments(value);
}

function normalizeToolName(toolCall) {
  return normalizeText(toolCall?.function?.name || toolCall?.name || toolCall?.toolName);
}

function normalizeCommandResult(result = {}, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const limit = positiveInteger(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
  return {
    ok: result.ok !== false,
    exitCode: result.exitCode === null || result.exitCode === undefined
      ? null
      : Number(result.exitCode),
    signal: normalizeText(result.signal),
    stdout: truncateText(result.stdout, limit),
    stderr: truncateText(result.stderr, limit),
    error: normalizeText(result.error),
    command: normalizeText(result.command),
    cwd: normalizeText(result.cwd),
    startedAtEpochMillis: Number(result.startedAtEpochMillis) || undefined,
    finishedAtEpochMillis: Number(result.finishedAtEpochMillis) || undefined,
  };
}

function resolveCwd(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return `${homedir()}${text.slice(1)}`;
  return text;
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function defaultShell() {
  return normalizeText(globalThis.process?.env?.SHELL) || '/bin/zsh';
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
