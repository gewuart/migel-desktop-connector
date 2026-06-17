import { loadHermesApiServerKey } from '../agents/hermesAgent.mjs';

const DEFAULT_API_SERVER_URL = 'http://127.0.0.1:8642';
const API_SERVER_TIMEOUT_MS = 15000;

export async function loadApiServerHealth({
  apiServerUrl = DEFAULT_API_SERVER_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = API_SERVER_TIMEOUT_MS,
} = {}) {
  const response = await fetchWithTimeout(`${normalizeApiServerUrl(apiServerUrl)}/health`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  }, timeoutMs, fetchImpl);
  if (!response.ok) {
    throw new Error(`Hermes API Server health 返回 HTTP ${response.status}`);
  }
  return parseJsonFromOutput(await response.text()) || { status: 'ok' };
}

export async function loadApiServerModels({
  apiServerUrl = DEFAULT_API_SERVER_URL,
  hermesEnvPath,
  fetchImpl = globalThis.fetch,
  loadHermesApiServerKeyImpl = loadHermesApiServerKey,
  timeoutMs = API_SERVER_TIMEOUT_MS,
} = {}) {
  const apiKey = await loadHermesApiServerKeyImpl({ envPath: hermesEnvPath });
  if (!apiKey) return [];

  const response = await fetchWithTimeout(`${normalizeApiServerUrl(apiServerUrl)}/v1/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  }, timeoutMs, fetchImpl);
  if (!response.ok) return [];
  const payload = parseJsonFromOutput(await response.text());
  const models = Array.isArray(payload?.data) ? payload.data : [];
  return models
    .map((model) => normalizeApiServerModel(model))
    .filter(Boolean);
}

export function normalizeApiServerModel(model) {
  if (!model || typeof model !== 'object') return null;
  const id = normalizeText(model.id) || normalizeText(model.model) || normalizeText(model.name);
  if (!id) return null;
  return {
    id,
    title: normalizeText(model.title) || normalizeText(model.name) || humanizeModelId(id),
    provider: normalizeText(model.owned_by) || normalizeText(model.provider) || 'Hermes',
    contextWindow: formatContextWindow(model.contextWindow || model.context || model.maxContextTokens),
    summary: '当前模型由 Hermes API Server 暴露。',
  };
}

export function normalizeApiServerUrl(value) {
  return String(value || DEFAULT_API_SERVER_URL).replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境缺少 fetch，无法请求 Hermes API Server。');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Hermes API Server 请求超时（${timeoutMs} ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function humanizeModelId(value) {
  return String(value || '')
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0]?.toUpperCase() + part.slice(1)))
    .join(' ');
}

function formatContextWindow(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '未知';
  if (numeric >= 1000000) return `${Math.round((numeric / 1000000) * 10) / 10}M`;
  if (numeric >= 1000) return `${Math.round(numeric / 1000)}k`;
  return String(numeric);
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
