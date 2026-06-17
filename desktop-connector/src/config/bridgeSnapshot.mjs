import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  loadApiServerHealth,
  loadApiServerModels,
  normalizeApiServerUrl,
} from './apiServerSnapshot.mjs';
import {
  createMigelComponentVersions,
  MIGEL_BRIDGE_VERSION,
  MIGEL_CONNECTOR_PROTOCOL_VERSION,
  MIGEL_DESKTOP_CONNECTOR_VERSION,
} from './componentVersions.mjs';
import { loadInstalledSkills } from './installedSkills.mjs';

const DEFAULT_API_SERVER_URL = 'http://127.0.0.1:8642';
const DEFAULT_CONFIG_PATH = '~/.hermes/hermes.json';
const DEFAULT_YAML_CONFIG_PATH = '~/.hermes/config.yaml';
const DEFAULT_AGENT_MODEL_ID = 'hermes-agent';
const COMPONENT_VERSIONS = createMigelComponentVersions();

export async function loadBridgeSnapshot({
  configPath = DEFAULT_CONFIG_PATH,
  apiServerUrl = DEFAULT_API_SERVER_URL,
  hermesEnvPath,
  handshakePath = '/gateway',
  e2eEncryption = false,
  selectedModelIds = [],
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  loadInstalledSkillsImpl = loadInstalledSkills,
  loadApiServerHealthImpl = loadApiServerHealth,
  loadApiServerModelsImpl = loadApiServerModels,
} = {}) {
  const config = await loadHermesConfig({ configPath, readFileImpl });
  const normalizedApiServerUrl = normalizeApiServerUrl(apiServerUrl);
  const apiServerHealth = await loadApiServerHealthImpl({
    apiServerUrl: normalizedApiServerUrl,
    fetchImpl,
  }).catch(() => null);
  const apiServerModels = await loadApiServerModelsImpl({
    apiServerUrl: normalizedApiServerUrl,
    hermesEnvPath,
    fetchImpl,
  }).catch(() => []);
  const configuredModels = extractModelsFromConfig(config);
  const mergedModels = applyAgentProxyModelLabels(mergeModels(configuredModels, apiServerModels), config);
  const activeModelId = findActiveModelId(mergedModels, selectedModelIds);
  const skills = await loadInstalledSkillsImpl();

  return {
    origin: 'Hermes Config Extractor',
    bridgeVersion: MIGEL_BRIDGE_VERSION,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    components: COMPONENT_VERSIONS.components,
    nodeName: config.nodeName || 'Hermes 本地节点',
    nodeId: config.nodeId || 'hermes-local',
    configFingerprint: [
      normalizedApiServerUrl,
      handshakePath,
      mergedModels.map((model) => model.id).join(','),
      skills.map((skill) => skill.id).join(','),
      normalizeText(config?.meta?.lastTouchedAt),
    ].join(':'),
    configuredSessionId: 'android:default',
    activeSessionId: null,
    models: mergedModels.map((model) => ({
      id: model.id,
      title: model.title,
      provider: model.provider,
      contextWindow: model.contextWindow,
      summary: model.summary,
      isConnected: model.id === activeModelId,
    })),
    skills,
    capabilities: defaultBridgeCapabilities({
      e2eEncryption,
    }),
    configSummary: buildConfigSummary({
      config,
      apiServerHealth,
      models: mergedModels,
      skills,
      configPath,
      apiServerUrl: normalizedApiServerUrl,
    }),
    sessionPolicy: {
      restoreOnLaunch: true,
      keepSameModelAcrossSessions: true,
      allowManualModelSelection: true,
    },
    gateway: {
      url: normalizedApiServerUrl,
      authMode: 'bearer',
      status: apiServerHealth ? 'reachable' : 'unknown',
    },
  };
}

function defaultBridgeCapabilities({
  e2eEncryption = false,
} = {}) {
  return {
    version: MIGEL_BRIDGE_VERSION,
    bridgeVersion: MIGEL_BRIDGE_VERSION,
    desktopConnectorVersion: MIGEL_DESKTOP_CONNECTOR_VERSION,
    connectorProtocolVersion: MIGEL_CONNECTOR_PROTOCOL_VERSION,
    text: true,
    image: true,
    imageNative: true,
    file: true,
    fileTextExtraction: true,
    inlineAttachments: true,
    remoteAttachments: true,
    maxInlineBytes: 1_048_576,
    maxImageInlineBytes: 1_048_576,
    maxImageReceiveBytes: 20 * 1024 * 1024,
    maxNormalizedImageBytes: 1_048_576,
    maxImageEdge: 1_920,
    maxFileUploadBytes: 4 * 1024 * 1024,
    maxOutputInlineBytes: 1_048_576,
    maxOutputUploadBytes: 20 * 1024 * 1024,
    maxExtractedTextChars: 60_000,
    maxAttachments: 6,
    supportedFileMimeTypes: [
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/csv',
      'application/json',
      'application/x-ndjson',
      'application/jsonlines',
    ],
    supportedFileExtensions: ['.txt', '.md', '.markdown', '.json', '.csv', '.log'],
    uploadEndpoint: null,
    ossOutputUpload: true,
    e2eEncryption: Boolean(e2eEncryption),
    structuredForwarding: true,
    apiServer: true,
  };
}

export async function loadHermesConfig({
  configPath = DEFAULT_CONFIG_PATH,
  readFileImpl = readFile,
} = {}) {
  const loaded = await readHermesConfigFile(configPath, readFileImpl);
  if (!loaded) return createEmptyHermesConfig();

  const parsed = parseHermesConfigText(loaded.raw, loaded.path);
  parsed.nodeName = normalizeText(parsed.nodeName) || 'Hermes 本地节点';
  parsed.nodeId = normalizeText(parsed.nodeId) || 'hermes-local';
  parsed.meta = {
    ...(parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}),
    sourcePath: loaded.path,
  };
  parsed.agents = parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {};
  parsed.models = parsed.models && typeof parsed.models === 'object' ? parsed.models : {};
  parsed.plugins = parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
  parsed.tools = parsed.tools && typeof parsed.tools === 'object' ? parsed.tools : {};
  return parsed;
}

export function extractModelsFromConfig(config) {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== 'object') return [];

  const models = [];
  for (const [providerKey, providerConfig] of Object.entries(providers)) {
    const items = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
    for (const item of items) {
      const id = normalizeText(item?.id);
      if (!id) continue;
      models.push({
        id,
        title: normalizeText(item?.name) || normalizeText(item?.label) || humanizeModelId(id),
        provider: normalizeText(providerConfig?.provider) || humanizeProvider(providerKey),
        contextWindow: formatContextWindow(item?.contextWindow),
        summary: '当前模型信息来自 Hermes 本地配置。',
      });
    }
  }
  return models;
}

export function mergeModels(configModels, apiServerModels) {
  const merged = new Map();
  for (const model of configModels) {
    merged.set(model.id, model);
  }
  for (const model of apiServerModels) {
    const existing = merged.get(model.id);
    merged.set(model.id, {
      ...existing,
      ...model,
      summary: existing?.summary || model.summary,
    });
  }
  return Array.from(merged.values());
}

export function applyAgentProxyModelLabels(models, config = {}) {
  const primaryModel = resolvePrimaryModel(config, models);
  const primaryModelId = primaryModel.id;
  if (!primaryModelId || isAgentProxyModelId(primaryModelId)) return models;

  const configuredModel = models.find((model) => normalizeText(model?.id) === primaryModelId);
  const displayTitle = normalizeText(configuredModel?.title) || primaryModel.title || primaryModelId;
  return models.map((model) => {
    if (!isAgentProxyModel(model)) return model;
    return {
      ...model,
      title: displayTitle,
      provider: normalizeText(configuredModel?.provider) || primaryModel.provider || model.provider,
      contextWindow: normalizeUsefulContextWindow(configuredModel?.contextWindow)
        || primaryModel.contextWindow
        || model.contextWindow,
      summary: `通过 Hermes Agent 路由到 ${displayTitle}。`,
    };
  });
}

export function buildConfigSummary({
  config = {},
  apiServerHealth = null,
  models = [],
  skills = [],
  configPath = DEFAULT_CONFIG_PATH,
  apiServerUrl = DEFAULT_API_SERVER_URL,
} = {}) {
  const sourcePath = normalizeText(config?.meta?.sourcePath) || configPath;
  const primaryModel = normalizeText(config?.agents?.defaults?.model?.primary) || '未配置';
  const fallbackModels = Array.isArray(config?.agents?.defaults?.model?.fallbacks)
    ? config.agents.defaults.model.fallbacks.filter(Boolean)
    : [];
  const providerKeys = Object.keys(config?.models?.providers || {});
  const enabledPlugins = Object.entries(config?.plugins?.entries || {})
    .filter(([, value]) => value?.enabled !== false)
    .map(([key]) => key);

  return {
    sourcePath,
    sections: [
      {
        title: '配置来源',
        items: [
          { label: '配置文件', value: sourcePath },
          { label: '最近更新', value: normalizeText(config?.meta?.lastTouchedAt) || '未知' },
          { label: '工作区', value: normalizeText(config?.agents?.defaults?.workspace) || '未配置' },
        ],
      },
      {
        title: '模型路由',
        items: [
          { label: '默认主模型', value: primaryModel },
          { label: '回退模型', value: formatPreviewList(fallbackModels, '未配置') },
          { label: '提供方', value: formatPreviewList(providerKeys, '未配置') },
          { label: '模型总数', value: String(models.length) },
        ],
      },
      {
        title: 'Skills 与插件',
        items: [
          { label: 'Skills', value: `${skills.length} 个` },
          { label: '插件', value: formatPreviewList(enabledPlugins, '未启用') },
          { label: '工具权限', value: [
            normalizeText(config?.tools?.profile) || 'default',
            normalizeText(config?.tools?.exec?.security) || 'unknown',
          ].join(' · ') },
        ],
      },
      {
        title: 'API Server',
        items: [
          { label: '地址', value: normalizeApiServerUrl(apiServerUrl) },
          { label: '状态', value: apiServerHealth ? 'reachable' : 'unknown' },
          { label: '鉴权', value: 'Bearer API_SERVER_KEY' },
          { label: '图片', value: '原生 image_url data URL' },
        ],
      },
    ],
  };
}

function findActiveModelId(models, selectedModelIds) {
  const selected = Array.isArray(selectedModelIds) ? selectedModelIds.filter(Boolean).at(-1) : '';
  if (selected && models.some((model) => model.id === selected)) return selected;
  return models[0]?.id || null;
}

function isAgentProxyModel(model) {
  const id = normalizeText(model?.id);
  const title = normalizeText(model?.title);
  return isAgentProxyModelId(id) || title.toLowerCase() === 'hermes agent';
}

function isAgentProxyModelId(modelId) {
  return normalizeText(modelId).toLowerCase() === DEFAULT_AGENT_MODEL_ID;
}

function resolvePrimaryModel(config, models = []) {
  const modelDefaults = config?.agents?.defaults?.model || {};
  const id = normalizeText(modelDefaults.primary);
  if (!id) {
    return {
      id: '',
      title: '',
      provider: '',
      contextWindow: '',
    };
  }

  const configuredModel = models.find((model) => normalizeText(model?.id) === id);
  const providerKey = normalizeText(modelDefaults.provider);
  const providerConfig = providerKey ? config?.models?.providers?.[providerKey] : null;
  const provider = normalizeText(configuredModel?.provider)
    || normalizeText(providerConfig?.provider)
    || normalizeText(providerConfig?.name)
    || (providerKey ? humanizeProvider(providerKey) : '');
  return {
    id,
    title: normalizeText(configuredModel?.title) || id,
    provider,
    contextWindow: normalizeUsefulContextWindow(configuredModel?.contextWindow)
      || normalizeUsefulContextWindow(modelDefaults.contextWindow),
  };
}

async function readHermesConfigFile(configPath, readFileImpl) {
  for (const candidate of configPathCandidates(configPath)) {
    const raw = await readOptionalText(candidate, readFileImpl);
    if (raw) {
      return {
        path: candidate,
        raw,
      };
    }
  }
  return null;
}

function configPathCandidates(configPath) {
  const expanded = expandHomePath(configPath || DEFAULT_CONFIG_PATH);
  const candidates = [expanded];
  if (expanded.endsWith('/hermes.json')) {
    candidates.push(join(dirname(expanded), 'config.yaml'));
    candidates.push(join(dirname(expanded), 'config.yml'));
  }
  candidates.push(expandHomePath(DEFAULT_YAML_CONFIG_PATH));
  return [...new Set(candidates.filter(Boolean))];
}

function parseHermesConfigText(raw, sourcePath) {
  const text = String(raw || '');
  if (sourcePath.endsWith('.yaml') || sourcePath.endsWith('.yml')) {
    return normalizeHermesYamlConfig(parseSimpleYamlObject(text));
  }
  return JSON.parse(text);
}

function normalizeHermesYamlConfig(yamlConfig = {}) {
  const model = yamlConfig.model && typeof yamlConfig.model === 'object' ? yamlConfig.model : {};
  const providerKey = normalizeText(model.provider);
  const primaryModelId = normalizeText(model.default);
  const providers = normalizeYamlProviders(yamlConfig.providers);
  if (providerKey && !providers[providerKey]) {
    providers[providerKey] = {
      provider: humanizeProvider(providerKey),
      models: [],
    };
  }
  const terminal = yamlConfig.terminal && typeof yamlConfig.terminal === 'object' ? yamlConfig.terminal : {};

  return {
    nodeName: normalizeText(yamlConfig.nodeName) || 'Hermes 本地节点',
    nodeId: normalizeText(yamlConfig.nodeId) || 'hermes-local',
    meta: {},
    agents: {
      defaults: {
        workspace: normalizeText(terminal.cwd),
        model: {
          primary: primaryModelId,
          provider: providerKey,
          contextWindow: model.context_length,
          fallbacks: Array.isArray(yamlConfig.fallback_models) ? yamlConfig.fallback_models : [],
        },
      },
    },
    models: {
      providers,
    },
    plugins: {},
    tools: {},
  };
}

function normalizeYamlProviders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const providers = {};
  for (const [key, config] of Object.entries(value)) {
    const providerKey = normalizeText(key);
    if (!providerKey) continue;
    const providerConfig = config && typeof config === 'object' ? config : {};
    providers[providerKey] = {
      provider: normalizeText(providerConfig.name) || humanizeProvider(providerKey),
      name: normalizeText(providerConfig.name),
      models: [],
    };
  }
  return providers;
}

function parseSimpleYamlObject(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const originalLine of String(raw || '').split(/\r?\n/g)) {
    const uncommented = stripYamlComment(originalLine);
    if (!uncommented.trim()) continue;
    const indent = uncommented.match(/^\s*/)?.[0]?.length || 0;
    const line = uncommented.trim();
    if (line.startsWith('- ')) continue;
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    while (stack.length > 1 && stack.at(-1).indent >= indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) continue;
    if (!rawValue) {
      const next = {};
      parent[key] = next;
      stack.push({ indent, value: next });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
  }
  return root;
}

function stripYamlComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\') {
      quote = quote === char ? '' : (quote || char);
    }
    if (char === '#' && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseYamlScalar(value) {
  const normalized = value.trim();
  if (normalized === '[]') return [];
  if (normalized === '{}') return {};
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized === 'null' || normalized === '~') return null;
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1);
  }
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(normalized)) return numeric;
  return normalized;
}

function createEmptyHermesConfig() {
  return {
    nodeName: 'Hermes 本地节点',
    nodeId: 'hermes-local',
    meta: {},
    agents: {},
    models: {},
    plugins: {},
    tools: {},
  };
}

async function readOptionalText(filePath, readFileImpl) {
  try {
    return await readFileImpl(expandHomePath(filePath), 'utf8');
  } catch {
    return null;
  }
}

function expandHomePath(filePath) {
  const value = normalizeText(filePath);
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function humanizeProvider(value) {
  return String(value || '')
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || 'Hermes';
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

function normalizeUsefulContextWindow(value) {
  const text = normalizeText(value);
  const formatted = text || formatContextWindow(value);
  return formatted && formatted !== '未知' ? formatted : '';
}

function formatPreviewList(values, fallback) {
  if (!Array.isArray(values) || values.length === 0) return fallback;
  const preview = values
    .map((value) => normalizeText(String(value)))
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');
  const extra = values.length - 3;
  return extra > 0 ? `${preview} +${extra}` : preview;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
