import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  extractChatCompletionDeltaText,
  extractChatCompletionImages,
  extractChatCompletionImagesFromText,
  extractChatCompletionText,
  mergeImages,
  sanitizeAssistantContent,
  stripImageReferencesFromText,
} from './outputParser.mjs';
import {
  createLocalToolController,
  localToolsSystemMessage,
} from './localTools.mjs';
import {
  buildHermesContentParts,
  DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  DEFAULT_PATH_FORWARD_FILE_MIME_TYPES,
  DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
} from './hermesContent.mjs';
import { createAgentRequest } from './agentTypes.mjs';

export {
  buildExtractedFileTextPart,
  buildHermesContentParts,
  DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  DEFAULT_PATH_FORWARD_FILE_MIME_TYPES,
  DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
  isPathForwardableFileAttachment,
  extractTextFromFileAttachment,
  isSupportedTextFileAttachment,
} from './hermesContent.mjs';

const DEFAULT_API_SERVER_URL = 'http://127.0.0.1:8642';
const DEFAULT_MODEL_ID = 'hermes-agent';
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_FILE_UPLOAD_BYTES = 4194304;
const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 60000;
const DEFAULT_HERMES_ENV_PATH = join(homedir(), '.hermes', '.env');
const DEFAULT_MAX_TOOL_ITERATIONS = 4;

export async function callHermesChatCompletionsStream({
  agentRequest,
  request,
  sessionKey,
  modelId,
  onDelta,
  apiServerUrl = DEFAULT_API_SERVER_URL,
  apiKey,
  envPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stream = true,
  fetchImpl = globalThis.fetch,
  randomId = randomUUID,
  maxFileUploadBytes = DEFAULT_MAX_FILE_UPLOAD_BYTES,
  maxExtractedTextChars = DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  supportedTextFileExtensions = DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  supportedTextFileMimeTypes = DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
  supportedPathFileExtensions = DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  supportedPathFileMimeTypes = DEFAULT_PATH_FORWARD_FILE_MIME_TYPES,
  permissionGate,
  localToolsEnabled = true,
  localToolController,
  executeCommand,
  commandTimeoutMs,
  commandMaxOutputChars,
  maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  useRunsApi = false,
} = {}) {
  const resolvedApiKey = normalizeText(apiKey) || await loadHermesApiServerKey({ envPath });
  if (!resolvedApiKey) {
    throw new Error(`Hermes API Server key 缺失：请在 ${envPath || 'Hermes .env'} 设置 API_SERVER_KEY，或通过环境变量传入。`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境缺少 fetch，无法请求 Hermes API Server。');
  }

  const normalizedRequest = createAgentRequest({
    request: agentRequest?.request || agentRequest || request,
    sessionKey: agentRequest?.sessionKey || sessionKey,
    modelId: agentRequest?.modelId || modelId,
    defaultModelId: DEFAULT_MODEL_ID,
  });
  const fallbackModel = normalizedRequest.modelId;
  if (useRunsApi) {
    return await callHermesRunsStream({
      agentRequest: normalizedRequest,
      apiServerUrl,
      apiKey: resolvedApiKey,
      timeoutMs,
      fetchImpl,
      randomId,
      onDelta,
      permissionGate,
    });
  }

  const content = buildHermesContentParts(normalizedRequest.request, {
    maxFileUploadBytes,
    maxExtractedTextChars,
    supportedTextFileExtensions,
    supportedTextFileMimeTypes,
    supportedPathFileExtensions,
    supportedPathFileMimeTypes,
  });
  const toolController = localToolController || createLocalToolController({
    permissionGate,
    enabled: localToolsEnabled,
    executeCommand,
    commandTimeoutMs,
    commandMaxOutputChars,
  });
  const messages = [
    ...(toolController.hasTools() ? [{
      role: 'system',
      content: localToolsSystemMessage(),
    }] : []),
    {
      role: 'user',
      content,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let toolIteration = 0; toolIteration <= positiveInteger(maxToolIterations, DEFAULT_MAX_TOOL_ITERATIONS); toolIteration += 1) {
      const body = buildChatCompletionsBody({
        model: fallbackModel,
        messages,
        stream,
        tools: toolController.definitions,
      });
      const response = await fetchImpl(`${normalizeApiServerUrl(apiServerUrl)}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Idempotency-Key': randomId(),
          'X-Hermes-Session-Id': normalizedRequest.sessionKey,
          'X-Hermes-Session-Key': normalizedRequest.sessionKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseText = await response.text();
        const parsed = parseJsonFromOutput(responseText);
        const message = extractApiErrorMessage(parsed) || responseText || `HTTP ${response.status}`;
        throw new Error(`Hermes API Server 请求失败：${message}`);
      }

      const contentType = response.headers?.get?.('content-type') || '';
      const completion = contentType.toLowerCase().includes('text/event-stream')
        ? await readChatCompletionSse(response, onDelta, fallbackModel)
        : await readJsonCompletionResponse(response, onDelta, fallbackModel);
      const toolCalls = normalizeToolCalls(completion.toolCalls);
      if (!toolCalls.length) {
        return completion;
      }

      messages.push(createAssistantToolCallMessage({
        content: completion.rawContent || completion.content,
        toolCalls,
      }));
      for (const toolCall of toolCalls) {
        const toolResult = await toolController.executeToolCall(toolCall, {
          agentRequest: normalizedRequest,
          toolIteration,
        });
        messages.push({
          role: 'tool',
          tool_call_id: normalizeText(toolCall.id),
          name: normalizeText(toolCall.function?.name),
          content: toolResult,
        });
      }
    }

    throw new Error('Hermes API Server 连续请求本地工具，已超过安全上限。');
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Hermes API Server 请求超时（${timeoutMs} ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callHermesRunsStream({
  agentRequest,
  apiServerUrl = DEFAULT_API_SERVER_URL,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  randomId = randomUUID,
  onDelta,
  permissionGate,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境缺少 fetch，无法请求 Hermes API Server。');
  }
  const normalizedRequest = createAgentRequest({
    request: agentRequest?.request || agentRequest,
    sessionId: agentRequest?.sessionId,
    sessionKey: agentRequest?.sessionKey,
    modelId: agentRequest?.modelId,
    defaultModelId: DEFAULT_MODEL_ID,
  });
  if (normalizedRequest.attachments.length) {
    throw new Error('Hermes runs API 当前只支持纯文本请求，带附件请求请继续走 chat/completions。');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const run = await createHermesRun({
      apiServerUrl,
      apiKey,
      agentRequest: normalizedRequest,
      fetchImpl,
      randomId,
      signal: controller.signal,
    });
    return await readHermesRunEvents({
      apiServerUrl,
      apiKey,
      runId: run.runId,
      fallbackModel: normalizedRequest.modelId,
      agentRequest: normalizedRequest,
      fetchImpl,
      randomId,
      signal: controller.signal,
      onDelta,
      permissionGate,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Hermes API Server runs 请求超时（${timeoutMs} ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function createHermesRun({
  apiServerUrl,
  apiKey,
  agentRequest,
  fetchImpl,
  randomId,
  signal,
}) {
  const response = await fetchImpl(`${normalizeApiServerUrl(apiServerUrl)}/v1/runs`, {
    method: 'POST',
    headers: hermesJsonHeaders({
      apiKey,
      randomId,
      sessionKey: agentRequest.sessionKey,
      accept: 'application/json',
    }),
    body: JSON.stringify({
      model: agentRequest.modelId,
      input: agentRequest.text,
      session_id: agentRequest.sessionId,
    }),
    signal,
  });
  if (!response.ok) {
    const message = await hermesErrorMessage(response);
    throw new Error(`Hermes API Server runs 创建失败：${message}`);
  }
  const payload = parseJsonFromOutput(await response.text()) || {};
  const runId = normalizeText(payload.run_id || payload.runId || payload.id);
  if (!runId) {
    throw new Error('Hermes API Server runs 创建响应缺少 run_id。');
  }
  return { runId };
}

async function readHermesRunEvents({
  apiServerUrl,
  apiKey,
  runId,
  fallbackModel,
  agentRequest,
  fetchImpl,
  randomId,
  signal,
  onDelta,
  permissionGate,
}) {
  const response = await fetchImpl(`${normalizeApiServerUrl(apiServerUrl)}/v1/runs/${encodeURIComponent(runId)}/events`, {
    method: 'GET',
    headers: hermesJsonHeaders({
      apiKey,
      randomId,
      sessionKey: agentRequest.sessionKey,
      accept: 'text/event-stream',
    }),
    signal,
  });
  if (!response.ok) {
    const message = await hermesErrorMessage(response);
    throw new Error(`Hermes API Server runs 事件流失败：${message}`);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error('Hermes API Server runs 没有返回可读取的 SSE 响应体。');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let rawContent = '';
  let visibleContent = '';
  let model = fallbackModel;
  let completed = false;
  let completionOutput = '';
  let failedError = '';

  const publishVisibleContent = async ({ nextRawContent, payload }) => {
    rawContent = nextRawContent;
    const nextVisibleContent = sanitizeAssistantContent(rawContent);
    if (nextVisibleContent !== visibleContent) {
      const visibleDelta = nextVisibleContent.startsWith(visibleContent)
        ? nextVisibleContent.slice(visibleContent.length)
        : nextVisibleContent;
      visibleContent = nextVisibleContent;
      await onDelta?.({
        delta: visibleDelta,
        content: visibleContent,
        model,
        payload,
        images: [],
      });
    }
  };

  const processBufferedEvent = async (rawEvent) => {
    const data = parseSseData(rawEvent);
    if (!data) return;
    const payload = parseJsonFromOutput(data);
    if (!payload) {
      throw new Error('Hermes API Server runs SSE 返回了无法解析的 data 事件。');
    }
    const eventType = normalizeText(payload.event || payload.type);
    model = normalizeText(payload.model) || model;

    if (eventType === 'message.delta') {
      const delta = stringValue(payload.delta);
      if (delta) {
        await publishVisibleContent({
          nextRawContent: rawContent + delta,
          payload,
        });
      }
      return;
    }

    if (eventType === 'approval.request') {
      await bridgeHermesRunApproval({
        apiServerUrl,
        apiKey,
        runId,
        approval: payload,
        agentRequest,
        fetchImpl,
        randomId,
        signal,
        permissionGate,
      });
      return;
    }

    if (eventType === 'run.completed') {
      completed = true;
      completionOutput = stringValue(payload.output);
      if (completionOutput && completionOutput !== rawContent) {
        await publishVisibleContent({
          nextRawContent: completionOutput,
          payload,
        });
      }
      return;
    }

    if (eventType === 'run.failed' || eventType === 'run.cancelled') {
      failedError = normalizeText(payload.error)
        || (eventType === 'run.cancelled' ? 'Hermes run 已取消。' : 'Hermes run 执行失败。');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundaryIndex = buffer.indexOf('\n\n');
    while (boundaryIndex >= 0) {
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      await processBufferedEvent(rawEvent);
      boundaryIndex = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    await processBufferedEvent(buffer);
  }

  if (failedError) {
    throw new Error(failedError);
  }
  visibleContent = sanitizeAssistantContent(completionOutput || rawContent || visibleContent);
  if (!visibleContent && !completed) {
    throw new Error('Hermes API Server runs 没有返回可展示的助手文本。');
  }
  return {
    content: visibleContent,
    rawContent: completionOutput || rawContent,
    model,
    done: completed,
    images: [],
    toolCalls: [],
  };
}

async function bridgeHermesRunApproval({
  apiServerUrl,
  apiKey,
  runId,
  approval,
  agentRequest,
  fetchImpl,
  randomId,
  signal,
  permissionGate,
}) {
  const command = normalizeText(approval.command);
  const description = normalizeText(approval.description);
  const patternKey = normalizeText(approval.pattern_key || approval.patternKey);
  const operation = patternKey === 'execute_code' || /^execute[_\s.-]*code\b/i.test(command)
    ? 'execute_code'
    : 'command.execute';
  let choice = 'deny';
  if (typeof permissionGate?.requireAllowed === 'function'
    || typeof permissionGate?.authorize === 'function'
    || typeof permissionGate?.enforce === 'function') {
    const authorize = permissionGate.requireAllowed
      || permissionGate.authorize
      || permissionGate.enforce;
    try {
      const decision = await authorize.call(permissionGate, {
        operation,
        command,
        intent: description || 'Hermes 请求执行 execute_code 脚本。',
        requestedBy: 'hermes-run-approval',
        metadata: compactObject({
          runId,
          patternKey,
          approvalEvent: normalizeText(approval.event),
        }),
      }, {
        route: 'hermes-runs-approval',
        runId,
      });
      choice = hermesApprovalChoiceFromDecision(decision);
    } catch {
      choice = 'deny';
    }
  }

  await postHermesRunApproval({
    apiServerUrl,
    apiKey,
    runId,
    choice,
    fetchImpl,
    randomId,
    sessionKey: agentRequest.sessionKey,
    signal,
  });
}

async function postHermesRunApproval({
  apiServerUrl,
  apiKey,
  runId,
  choice,
  fetchImpl,
  randomId,
  sessionKey,
  signal,
}) {
  const response = await fetchImpl(`${normalizeApiServerUrl(apiServerUrl)}/v1/runs/${encodeURIComponent(runId)}/approval`, {
    method: 'POST',
    headers: hermesJsonHeaders({
      apiKey,
      randomId,
      sessionKey,
      accept: 'application/json',
    }),
    body: JSON.stringify({
      choice,
    }),
    signal,
  });
  if (!response.ok) {
    const message = await hermesErrorMessage(response);
    throw new Error(`Hermes API Server runs 审批回写失败：${message}`);
  }
}

function hermesApprovalChoiceFromDecision(decision = {}) {
  const scope = normalizeText(
    decision.confirmation?.metadata?.scope
      || decision.metadata?.scope
      || decision.scope,
  ).toLowerCase().replace(/[-\s]+/g, '_');
  if (scope === 'session' || scope === 'conversation' || scope === 'session_related' || scope === 'conversation_related') {
    return 'session';
  }
  if (scope === 'always' || scope === 'permanent') {
    return 'always';
  }
  return 'once';
}

function hermesJsonHeaders({
  apiKey,
  randomId,
  sessionKey,
  accept = 'application/json',
} = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: accept,
    'Idempotency-Key': randomId(),
    'X-Hermes-Session-Id': sessionKey,
    'X-Hermes-Session-Key': sessionKey,
  };
}

async function hermesErrorMessage(response) {
  const responseText = await response.text();
  const parsed = parseJsonFromOutput(responseText);
  return extractApiErrorMessage(parsed) || responseText || `HTTP ${response.status}`;
}

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

export async function loadHermesApiServerKey({
  envPath,
  env = globalThis.process?.env || {},
  readFileImpl = readFile,
} = {}) {
  const envKey = normalizeText(env.API_SERVER_KEY);
  if (envKey) return envKey;
  for (const candidate of defaultHermesEnvPaths(envPath, env)) {
    const envText = await readOptionalText(candidate, readFileImpl);
    const fileKey = parseEnvValue(envText, 'API_SERVER_KEY');
    if (fileKey) return fileKey;
  }
  return '';
}

export function defaultHermesEnvPaths(envPath, env = globalThis.process?.env || {}) {
  const paths = [
    normalizeText(envPath),
    normalizeText(env?.HERMES_ENV_PATH),
    normalizeText(env?.MIGEL_AGENT_ENV_PATH),
    DEFAULT_HERMES_ENV_PATH,
  ].filter(Boolean);
  return Array.from(new Set(paths));
}

export async function readChatCompletionSse(response, onDelta, fallbackModel = DEFAULT_MODEL_ID) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error('Hermes API Server 没有返回可读取的 SSE 响应体。');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let rawContent = '';
  let visibleContent = '';
  let model = fallbackModel;
  let done = false;
  let images = [];
  const toolCallState = new Map();

  const publishVisibleContent = async ({ nextRawContent, payload, nextImages }) => {
    rawContent = nextRawContent;
    const nextVisibleContent = sanitizeAssistantContent(rawContent);
    if (nextVisibleContent !== visibleContent || nextImages.length) {
      const visibleDelta = nextVisibleContent.startsWith(visibleContent)
        ? nextVisibleContent.slice(visibleContent.length)
        : nextVisibleContent;
      visibleContent = nextVisibleContent;
      await onDelta?.({
        delta: visibleDelta,
        content: visibleContent,
        model,
        payload,
        images,
      });
    }
  };

  const processBufferedEvent = async (rawEvent) => {
    const data = parseSseData(rawEvent);
    if (!data) return false;
    if (data === '[DONE]') return true;

    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error('Hermes API Server SSE 返回了无法解析的 data 事件。');
    }

    model = normalizeText(payload?.model) || normalizeText(payload?.response?.model) || model;
    mergeToolCallDeltas(toolCallState, extractChatCompletionToolCallDeltas(payload));
    const delta = extractChatCompletionDeltaText(payload);
    const fullContent = extractChatCompletionText(payload);
    const nextImages = extractChatCompletionImages(payload);
    if (nextImages.length) {
      images = mergeImages(images, nextImages);
    }
    if (delta || fullContent) {
      let nextRawContent = delta ? rawContent + delta : rawContent;
      if (fullContent && (
        isFinalContentPayload(payload)
        || !rawContent
        || fullContent.startsWith(rawContent)
        || !delta
      )) {
        nextRawContent = fullContent;
      }
      await publishVisibleContent({ nextRawContent, payload, nextImages });
    } else if (nextImages.length) {
      await onDelta?.({
        delta: '',
        content: visibleContent,
        model,
        payload,
        images,
      });
    }
    return false;
  };

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundaryIndex = buffer.indexOf('\n\n');
    while (boundaryIndex >= 0) {
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      done = await processBufferedEvent(rawEvent);
      if (done) break;
      boundaryIndex = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  if (!done && buffer.trim()) {
    done = await processBufferedEvent(buffer);
  }

  visibleContent = sanitizeAssistantContent(rawContent || visibleContent);
  const toolCalls = normalizeToolCalls(Array.from(toolCallState.values()));
  const textImages = extractChatCompletionImagesFromText(visibleContent);
  if (textImages.length) {
    images = mergeImages(images, textImages);
    visibleContent = stripImageReferencesFromText(visibleContent);
  }
  if (!visibleContent && images.length === 0 && toolCalls.length === 0) {
    throw new Error('Hermes API Server 没有返回可展示的助手文本或图片。');
  }

  return {
    content: visibleContent,
    rawContent,
    model,
    done,
    images,
    toolCalls,
  };
}

export function parseSseData(rawEvent) {
  const dataLines = [];
  for (const line of String(rawEvent || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.join('\n').trim();
}

function isFinalContentPayload(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const type = normalizeText(payload?.type).toLowerCase();
  return choice?.message?.content != null
    || Array.isArray(payload?.output)
    || Array.isArray(payload?.response?.output)
    || type === 'response.completed'
    || type.endsWith('.done');
}

async function readJsonCompletionResponse(response, onDelta, fallbackModel) {
  const responseText = await response.text();
  const parsed = parseJsonFromOutput(responseText);
  let replyText = sanitizeAssistantContent(extractChatCompletionText(parsed));
  let images = extractChatCompletionImages(parsed);
  const toolCalls = normalizeToolCalls(extractChatCompletionToolCalls(parsed));
  const textImages = extractChatCompletionImagesFromText(replyText);
  if (textImages.length) {
    images = mergeImages(images, textImages);
    replyText = stripImageReferencesFromText(replyText);
  }
  if (!replyText && !images.length && !toolCalls.length) {
    throw new Error('Hermes API Server 没有返回可解析的 SSE、JSON 文本或图片。');
  }
  const model = normalizeText(parsed?.model) || fallbackModel;
  if (replyText || images.length) {
    await onDelta?.({
      delta: replyText,
      content: replyText,
      model,
      payload: parsed,
      images,
    });
  }
  return {
    content: replyText,
    rawContent: extractChatCompletionText(parsed),
    model,
    images,
    toolCalls,
  };
}

function buildChatCompletionsBody({
  model,
  messages,
  stream,
  tools,
}) {
  const body = {
    model,
    messages,
    stream: Boolean(stream),
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

function createAssistantToolCallMessage({
  content,
  toolCalls,
}) {
  return {
    role: 'assistant',
    content: normalizeText(content) || null,
    tool_calls: normalizeToolCalls(toolCalls).map((toolCall) => ({
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    })),
  };
}

function extractChatCompletionToolCalls(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return normalizeToolCalls(
    choice?.message?.tool_calls
      || choice?.message?.toolCalls
      || payload?.message?.tool_calls
      || payload?.tool_calls
      || payload?.toolCalls
      || [],
  );
}

function extractChatCompletionToolCallDeltas(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return normalizeList(
    choice?.delta?.tool_calls
      || choice?.delta?.toolCalls
      || choice?.message?.tool_calls
      || payload?.delta?.tool_calls
      || payload?.tool_calls
      || [],
  );
}

function mergeToolCallDeltas(state, deltas) {
  for (const delta of normalizeList(deltas)) {
    if (!delta || typeof delta !== 'object') continue;
    const index = Number.isFinite(Number(delta.index)) ? Number(delta.index) : state.size;
    const key = Number.isFinite(Number(delta.index)) ? `index:${index}` : normalizeText(delta.id) || `index:${index}`;
    const existing = state.get(key) || {
      id: '',
      type: 'function',
      function: {
        name: '',
        arguments: '',
      },
    };
    const next = {
      id: normalizeText(existing.id) || normalizeText(delta.id) || key,
      type: normalizeText(delta.type) || normalizeText(existing.type) || 'function',
      function: {
        name: normalizeText(existing.function?.name) || normalizeText(delta.function?.name),
        arguments: `${existing.function?.arguments || ''}${toolArgumentsFragment(delta.function?.arguments)}`,
      },
    };
    state.set(key, next);
  }
}

function normalizeToolCalls(value) {
  return normalizeList(value)
    .map((toolCall, index) => {
      if (!toolCall || typeof toolCall !== 'object') return null;
      const functionValue = toolCall.function && typeof toolCall.function === 'object'
        ? toolCall.function
        : toolCall;
      const name = normalizeText(functionValue.name || toolCall.name || toolCall.toolName);
      if (!name) return null;
      return {
        id: normalizeText(toolCall.id) || `tool-call-${index + 1}`,
        type: normalizeText(toolCall.type) || 'function',
        function: {
          name,
          arguments: toolArgumentsFragment(functionValue.arguments || functionValue.args || '{}'),
        },
      };
    })
    .filter(Boolean);
}

function toolArgumentsFragment(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '';
}

function extractApiErrorMessage(payload) {
  const error = payload?.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  return normalizeText(error.message) || normalizeText(error.code) || normalizeText(error.type);
}

function parseEnvValue(text, key) {
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.*)$`);
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(pattern);
    if (!match) continue;
    return match[1]
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .trim();
  }
  return '';
}

function parseJsonFromOutput(output) {
  const trimmed = String(output || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

async function readOptionalText(filePath, readFileImpl) {
  if (!filePath) return null;
  try {
    return await readFileImpl(filePath, 'utf8');
  } catch {
    return null;
  }
}

function normalizeApiServerUrl(value) {
  return String(value || DEFAULT_API_SERVER_URL).replace(/\/+$/, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
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
