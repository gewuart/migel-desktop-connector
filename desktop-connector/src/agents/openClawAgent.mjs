import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createAgentRequest } from './agentTypes.mjs';
import {
  buildHermesContentParts,
  DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  DEFAULT_PATH_FORWARD_FILE_MIME_TYPES,
  callHermesChatCompletionsStream,
  DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
} from './hermesAgent.mjs';

export {
  DEFAULT_PATH_FORWARD_FILE_EXTENSIONS,
  DEFAULT_PATH_FORWARD_FILE_MIME_TYPES,
  DEFAULT_SUPPORTED_TEXT_FILE_EXTENSIONS,
  DEFAULT_SUPPORTED_TEXT_FILE_MIME_TYPES,
};
export const buildOpenClawContentParts = buildHermesContentParts;

const DEFAULT_OPENCLAW_API_SERVER_URL = 'http://127.0.0.1:8642';
const DEFAULT_OPENCLAW_MODEL_ID = 'openclaw-agent';

export async function callOpenClawChatCompletionsStream({
  agentRequest,
  request,
  sessionId,
  sessionKey,
  modelId,
  metadata = {},
  apiServerUrl,
  apiKey,
  envPath,
  env = globalThis.process?.env || {},
  readFileImpl = readFile,
  homeDir = homedir(),
  ...callOptions
} = {}) {
  const resolvedEnvPath = resolveOpenClawEnvPath({ envPath, env, homeDir });
  const resolvedApiKey = normalizeText(apiKey)
    || await loadOpenClawApiServerKey({ envPath: resolvedEnvPath, env, readFileImpl });
  if (!resolvedApiKey) {
    throw new Error(`OpenClaw API Server key 缺失：请在 ${resolvedEnvPath || 'OpenClaw .env'} 设置 OPENCLAW_API_SERVER_KEY 或 API_SERVER_KEY，或通过环境变量传入。`);
  }

  const normalizedRequest = createAgentRequest({
    request: agentRequest?.request || agentRequest || request,
    sessionId: agentRequest?.sessionId || sessionId,
    sessionKey: agentRequest?.sessionKey || sessionKey,
    modelId: agentRequest?.modelId || modelId,
    agentId: 'openclaw',
    defaultModelId: DEFAULT_OPENCLAW_MODEL_ID,
    metadata: {
      ...normalizeObject(agentRequest?.metadata),
      ...normalizeObject(metadata),
      adapter: 'openclaw',
    },
  });

  return await callHermesChatCompletionsStream({
    ...callOptions,
    agentRequest: normalizedRequest,
    apiServerUrl: resolveOpenClawApiServerUrl({ apiServerUrl, env }),
    apiKey: resolvedApiKey,
    envPath: resolvedEnvPath,
  });
}

export async function loadOpenClawApiServerKey({
  envPath,
  env = globalThis.process?.env || {},
  readFileImpl = readFile,
} = {}) {
  const envKey = normalizeText(env.OPENCLAW_API_SERVER_KEY) || normalizeText(env.API_SERVER_KEY);
  if (envKey) return envKey;
  const envText = await readOptionalText(envPath, readFileImpl);
  if (!envText) return '';
  return parseEnvValue(envText, 'OPENCLAW_API_SERVER_KEY')
    || parseEnvValue(envText, 'API_SERVER_KEY');
}

export function resolveOpenClawApiServerUrl({
  apiServerUrl,
  env = globalThis.process?.env || {},
} = {}) {
  return normalizeApiServerUrl(
    apiServerUrl
      || env.OPENCLAW_API_SERVER_URL
      || env.OPENCLAW_SERVER_URL
      || env.API_SERVER_URL
      || DEFAULT_OPENCLAW_API_SERVER_URL,
  );
}

export function resolveOpenClawEnvPath({
  envPath,
  env = globalThis.process?.env || {},
  homeDir = homedir(),
} = {}) {
  return normalizeText(envPath)
    || normalizeText(env.OPENCLAW_ENV_PATH)
    || normalizeText(env.HERMES_ENV_PATH)
    || join(homeDir, '.openclaw', '.env');
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

async function readOptionalText(filePath, readFileImpl) {
  if (!filePath) return null;
  try {
    return await readFileImpl(filePath, 'utf8');
  } catch {
    return null;
  }
}

function normalizeApiServerUrl(value) {
  return String(value || DEFAULT_OPENCLAW_API_SERVER_URL).replace(/\/+$/, '');
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
