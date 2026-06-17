import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

import {
  createImageCapabilityRegistry,
  IMAGE_EDIT_CAPABILITY,
  IMAGE_GENERATE_CAPABILITY,
} from '../capabilities/imageCapabilities.mjs';

const DEFAULT_BASE_URL = 'https://api.llm-token.cn/v1';
const DEFAULT_MODEL_ID = 'gpt-image-2';
const DEFAULT_SIZE = '1024x1024';
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_EDIT_INPUT_IMAGES = 4;
const DEFAULT_MAX_EDIT_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_OUTPUT_NAME_PREFIX = 'openai_gpt-image-2';
const DEFAULT_CONTENT = '已用 gpt-image-2 生成图片。';
const DEFAULT_EDIT_CONTENT = '已用 gpt-image-2 完成图生图。';
const DEFAULT_STARTED_CONTENT = '已切到本机 gpt-image-2，正在生成图片。';
const DEFAULT_EDIT_STARTED_CONTENT = '已切到本机 gpt-image-2，正在根据输入图片生成。';

const IMAGE_TARGET_MARKERS = [
  '图',
  '图片',
  '图像',
  '照片',
  '海报',
  '插画',
  '头像',
  '壁纸',
  'logo',
  '表情包',
  '贴纸',
  '漫画',
  '素材',
  'image',
  'picture',
  'photo',
  'poster',
  'illustration',
  'avatar',
  'wallpaper',
  'sticker',
];

const PROMPT_OPTIMIZATION_MARKERS = [
  '提示词',
  'prompt',
  '咒语',
  '改写',
  '优化',
  '润色',
  '怎么写',
  '如何写',
  '帮我想',
  '生成图片提示',
  '图片提示',
  'image prompt',
];

const CHAT_INTENT_MARKERS = [
  '分析',
  '解释',
  '总结',
  '识别',
  '描述这张',
  '评价',
  '代码',
  '教程',
  '怎么',
  '如何',
  'why',
  'how to',
  'analyze',
  'explain',
];

const IMAGE_EDIT_INTENT_MARKERS = [
  '图生图',
  '改图',
  '编辑图片',
  '修改图片',
  '重绘',
  '参考这张',
  '参考图片',
  '根据这张',
  '把这张',
  '这张图改',
  '换成',
  '变成',
  '保持构图',
  'image edit',
  'edit image',
  'image-to-image',
  'image to image',
  'turn this',
  'based on this image',
];

const IMAGE_CREATION_INTENT_MARKERS = [
  '生成',
  '画',
  '绘制',
  '做',
  '制作',
  '创建',
  '输出',
  '设计',
  '出图',
];

const IMAGE_CHARACTER_TARGET_MARKERS = [
  '形象',
  '角色',
  'ip',
  '动作',
  '动作组',
  '表情包',
  '贴纸',
  '素材',
  '立绘',
];

export const GPT_IMAGE_2_MODEL_ID = DEFAULT_MODEL_ID;
export const GPT_IMAGE_2_GENERATIONS_URL = `${DEFAULT_BASE_URL}/images/generations`;
export const GPT_IMAGE_2_EDITS_URL = `${DEFAULT_BASE_URL}/images/edits`;

export function createGptImage2CapabilityRegistry(options = {}) {
  return createImageCapabilityRegistry({
    generateProvider: (request, providerOptions) => generateGptImage2Capability({
      ...options,
      ...providerOptions,
      capabilityRequest: request,
    }),
    editProvider: (request, providerOptions) => editGptImage2Capability({
      ...options,
      ...providerOptions,
      capabilityRequest: request,
    }),
  });
}

export async function callGptImage2ImageGeneration({
  agentRequest,
  request,
  onDelta,
  apiKey,
  env = globalThis.process?.env || {},
  envPath,
  homeDir = homedir(),
  cwd = globalThis.process?.cwd?.() || '',
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  outputDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  randomId = randomUUID,
  clock = () => new Date(),
  size = DEFAULT_SIZE,
} = {}) {
  const registry = createGptImage2CapabilityRegistry();
  const normalizedRequest = normalizeRequest(agentRequest?.request || agentRequest || request);
  return registry.run({
    capability: IMAGE_GENERATE_CAPABILITY,
    text: normalizedRequest.text,
    attachments: normalizedRequest.attachments,
    metadata: {
      agentRequest,
    },
  }, {
    onDelta,
    apiKey,
    env,
    envPath,
    homeDir,
    cwd,
    fetchImpl,
    readFileImpl,
    writeFileImpl,
    mkdirImpl,
    outputDir,
    timeoutMs,
    randomId,
    clock,
    size,
  });
}

export async function callGptImage2ImageEdit({
  agentRequest,
  request,
  onDelta,
  apiKey,
  env = globalThis.process?.env || {},
  envPath,
  homeDir = homedir(),
  cwd = globalThis.process?.cwd?.() || '',
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  outputDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  randomId = randomUUID,
  clock = () => new Date(),
  size = DEFAULT_SIZE,
} = {}) {
  const registry = createGptImage2CapabilityRegistry();
  const normalizedRequest = normalizeRequest(agentRequest?.request || agentRequest || request);
  return registry.run({
    capability: IMAGE_EDIT_CAPABILITY,
    text: normalizedRequest.text,
    attachments: normalizedRequest.attachments,
    metadata: {
      agentRequest,
    },
  }, {
    onDelta,
    apiKey,
    env,
    envPath,
    homeDir,
    cwd,
    fetchImpl,
    readFileImpl,
    writeFileImpl,
    mkdirImpl,
    outputDir,
    timeoutMs,
    randomId,
    clock,
    size,
  });
}

export async function generateGptImage2Capability({
  capabilityRequest,
  agentRequest,
  request,
  onDelta,
  apiKey,
  env = globalThis.process?.env || {},
  envPath,
  homeDir = homedir(),
  cwd = globalThis.process?.cwd?.() || '',
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  outputDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  randomId = randomUUID,
  clock = () => new Date(),
  size = DEFAULT_SIZE,
} = {}) {
  const normalizedRequest = normalizeRequest(agentRequest?.request || agentRequest || request);
  const normalizedCapabilityRequest = normalizeCapabilityRequest(capabilityRequest);
  const prompt = normalizeText(normalizedCapabilityRequest.prompt) || normalizeText(normalizedRequest.text);
  const attachments = normalizedCapabilityRequest.attachments.length
    ? normalizedCapabilityRequest.attachments
    : normalizeAttachments(normalizedRequest.attachments);
  if (!prompt) {
    throw new Error('gpt-image-2 本地图像生成缺少提示词。');
  }
  if (attachments.length) {
    throw new Error('gpt-image-2 本地直连当前只接管文生图；带图片附件的图生图仍交给 Hermes Agent。');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境缺少 fetch，无法请求 gpt-image-2 图片接口。');
  }

  const resolvedApiKey = normalizeText(apiKey)
    || await loadGptImage2ApiKey({ env, envPath, homeDir, cwd, readFileImpl });
  if (!resolvedApiKey) {
    throw new Error('gpt-image-2 API key 缺失：请在桌面端环境变量 OPENAI_API_KEY 中配置。');
  }

  await onDelta?.({
    delta: '',
    content: DEFAULT_STARTED_CONTENT,
    model: DEFAULT_MODEL_ID,
    modelId: DEFAULT_MODEL_ID,
    images: [],
  });

  const payload = await requestImageGeneration({
    prompt,
    size,
    apiKey: resolvedApiKey,
    fetchImpl,
    timeoutMs,
    randomId,
  });
  const imageBytes = await resolveGeneratedImageBytes(payload.image, {
    fetchImpl,
    timeoutMs,
  });
  const mimeType = normalizeImageMimeType(
    payload.image.mimeType
      || detectImageMimeType(imageBytes.bytes)
      || imageBytes.mimeType,
  );
  const finalOutputDir = resolveOutputDir({ outputDir, env, homeDir });
  await mkdirImpl(finalOutputDir, { recursive: true });
  const fileName = buildOutputFileName({
    mimeType,
    clock,
    randomId,
  });
  const localPath = join(finalOutputDir, fileName);
  await writeFileImpl(localPath, imageBytes.bytes);

  return {
    content: DEFAULT_CONTENT,
    model: DEFAULT_MODEL_ID,
    modelId: DEFAULT_MODEL_ID,
    images: [{
      id: `gpt-image-2-${randomId().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'image'}`,
      name: fileName,
      mimeType,
      localPath,
    }],
    done: true,
    metadata: {
      provider: 'image2.gpt-agent.cc',
      endpoint: GPT_IMAGE_2_GENERATIONS_URL,
      capability: IMAGE_GENERATE_CAPABILITY,
      revisedPrompt: normalizeText(payload.image.revisedPrompt),
    },
  };
}

export async function editGptImage2Capability({
  capabilityRequest,
  agentRequest,
  request,
  onDelta,
  apiKey,
  env = globalThis.process?.env || {},
  envPath,
  homeDir = homedir(),
  cwd = globalThis.process?.cwd?.() || '',
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  outputDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  randomId = randomUUID,
  clock = () => new Date(),
  size = DEFAULT_SIZE,
  maxInputImages = DEFAULT_MAX_EDIT_INPUT_IMAGES,
  maxInputBytes = DEFAULT_MAX_EDIT_INPUT_BYTES,
} = {}) {
  const normalizedRequest = normalizeRequest(agentRequest?.request || agentRequest || request);
  const normalizedCapabilityRequest = normalizeCapabilityRequest(capabilityRequest);
  const prompt = normalizeText(normalizedCapabilityRequest.prompt) || normalizeText(normalizedRequest.text);
  const attachments = normalizedCapabilityRequest.attachments.length
    ? normalizedCapabilityRequest.attachments
    : normalizeAttachments(normalizedRequest.attachments);
  if (!prompt) {
    throw new Error('gpt-image-2 本地图生图缺少提示词。');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境缺少 fetch，无法请求 gpt-image-2 图片接口。');
  }

  const resolvedApiKey = normalizeText(apiKey)
    || await loadGptImage2ApiKey({ env, envPath, homeDir, cwd, readFileImpl });
  if (!resolvedApiKey) {
    throw new Error('gpt-image-2 API key 缺失：请在桌面端环境变量 OPENAI_API_KEY 中配置。');
  }

  const inputImages = await resolveImageEditInputs(attachments, {
    fetchImpl,
    readFileImpl,
    timeoutMs,
    maxInputImages,
    maxInputBytes,
  });

  await onDelta?.({
    delta: '',
    content: DEFAULT_EDIT_STARTED_CONTENT,
    model: DEFAULT_MODEL_ID,
    modelId: DEFAULT_MODEL_ID,
    images: [],
  });

  const payload = await requestImageEdit({
    prompt,
    size,
    apiKey: resolvedApiKey,
    images: inputImages,
    fetchImpl,
    timeoutMs,
    randomId,
  });
  const imageBytes = await resolveGeneratedImageBytes(payload.image, {
    fetchImpl,
    timeoutMs,
  });
  const mimeType = normalizeImageMimeType(
    payload.image.mimeType
      || detectImageMimeType(imageBytes.bytes)
      || imageBytes.mimeType,
  );
  const finalOutputDir = resolveOutputDir({ outputDir, env, homeDir });
  await mkdirImpl(finalOutputDir, { recursive: true });
  const fileName = buildOutputFileName({
    mimeType,
    clock,
    randomId,
  });
  const localPath = join(finalOutputDir, fileName);
  await writeFileImpl(localPath, imageBytes.bytes);

  return {
    content: DEFAULT_EDIT_CONTENT,
    model: DEFAULT_MODEL_ID,
    modelId: DEFAULT_MODEL_ID,
    images: [{
      id: `gpt-image-2-${randomId().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'image'}`,
      name: fileName,
      mimeType,
      localPath,
    }],
    done: true,
    metadata: {
      provider: 'image2.gpt-agent.cc',
      endpoint: GPT_IMAGE_2_EDITS_URL,
      capability: IMAGE_EDIT_CAPABILITY,
      inputImageCount: inputImages.length,
      revisedPrompt: normalizeText(payload.image.revisedPrompt),
    },
  };
}

export function selectLocalGptImage2Capability(agentRequest, {
  enabled = true,
} = {}) {
  if (!enabled) return '';
  if (shouldRouteToLocalGptImage2Edit(agentRequest, { enabled })) return IMAGE_EDIT_CAPABILITY;
  if (shouldRouteToLocalGptImage2Generation(agentRequest, { enabled })) return IMAGE_GENERATE_CAPABILITY;
  return '';
}

export function shouldRouteToLocalGptImage2Generation(agentRequest, {
  enabled = true,
} = {}) {
  if (!enabled) return false;
  const request = normalizeRequest(agentRequest?.request || agentRequest);
  const text = normalizeText(request.text);
  if (!text) return false;
  if (normalizeAttachments(request.attachments).length) return false;

  const modelId = normalizeText(agentRequest?.modelId || request.modelId || request.model).toLowerCase();
  if (looksLikeImageModel(modelId)) return true;

  const compact = text.replace(/\s+/g, '').toLowerCase();
  const lower = text.toLowerCase();
  if (looksLikePromptOptimization(compact, lower)) return false;

  if (containsAny(compact, '文生图', '生成图', '图片生成', '图像生成', '出图')) return true;
  if (containsAny(lower, 'text to image', 'image generation', 'generate an image', 'generate image')) {
    return true;
  }
  if (/(?:生成|画|绘制|做|制作|创建|出|设计|来)(?:一张|一幅|个|张|幅|套)?[^。！？.!?\n]{0,28}(?:图|图片|图像|照片|海报|插画|头像|壁纸|logo|表情包|贴纸|漫画|素材)/i.test(text)) {
    return true;
  }
  if (/(?:图|图片|图像|照片|海报|插画|头像|壁纸|logo|表情包|贴纸|漫画|素材)[^。！？.!?\n]{0,28}(?:生成|画出来|做出来|制作|创建|设计)/i.test(text)) {
    return true;
  }
  if (/\b(?:generate|draw|create|make|design)\s+(?:an?\s+|the\s+)?(?:image|picture|photo|poster|illustration|logo|avatar|wallpaper|sticker)\b/i.test(text)) {
    return true;
  }
  return false;
}

export function shouldRouteToLocalGptImage2Edit(agentRequest, {
  enabled = true,
} = {}) {
  if (!enabled) return false;
  const request = normalizeRequest(agentRequest?.request || agentRequest);
  const text = normalizeText(request.text);
  const attachments = normalizeAttachments(request.attachments);
  if (!attachments.some(isImageAttachment)) return false;

  const modelId = normalizeText(agentRequest?.modelId || request.modelId || request.model).toLowerCase();
  if (looksLikeImageModel(modelId)) return true;

  const compact = text.replace(/\s+/g, '').toLowerCase();
  const lower = text.toLowerCase();
  if (looksLikePromptOptimization(compact, lower)) return false;
  if (containsAny(compact, ...IMAGE_EDIT_INTENT_MARKERS) || containsAny(lower, ...IMAGE_EDIT_INTENT_MARKERS)) {
    return true;
  }
  if (
    containsAny(compact, ...IMAGE_CREATION_INTENT_MARKERS) &&
    (
      containsAny(compact, ...IMAGE_TARGET_MARKERS) ||
      containsAny(compact, ...IMAGE_CHARACTER_TARGET_MARKERS)
    )
  ) {
    return true;
  }
  if (containsAny(compact, '文生图', '生成图', '图片生成', '图像生成', '出图')) return true;
  if (/\b(?:edit|modify|redraw|transform|restyle|turn|make)\b[\s\S]{0,80}\b(?:image|picture|photo|this)\b/i.test(text)) {
    return true;
  }
  if (containsAny(lower, ...CHAT_INTENT_MARKERS)) return false;
  return false;
}

export async function loadGptImage2ApiKey({
  apiKey,
  env = globalThis.process?.env || {},
  envPath,
  homeDir = homedir(),
  cwd = globalThis.process?.cwd?.() || '',
  readFileImpl = readFile,
} = {}) {
  const directKey = normalizeText(apiKey)
    || normalizeText(env.OPENAI_API_KEY)
    || normalizeText(env.QIMOGUAGUA_API_KEY)
    || normalizeText(env.GPT_IMAGE_2_API_KEY);
  if (directKey) return directKey;

  for (const candidate of defaultGptImage2EnvPaths({ envPath, env, homeDir, cwd })) {
    const text = await readOptionalText(candidate, readFileImpl);
    const fileKey = parseEnvValue(text, 'OPENAI_API_KEY')
      || parseEnvValue(text, 'QIMOGUAGUA_API_KEY')
      || parseEnvValue(text, 'GPT_IMAGE_2_API_KEY');
    if (fileKey) return fileKey;
  }
  return '';
}

export function defaultGptImage2EnvPaths({
  envPath,
  env = globalThis.process?.env || {},
  homeDir = homedir(),
  cwd = globalThis.process?.cwd?.() || '',
} = {}) {
  const hermesHome = normalizeText(env.HERMES_HOME);
  const paths = [
    normalizeText(envPath),
    normalizeText(env.GPT_IMAGE_2_ENV_PATH),
    normalizeText(env.HERMES_ENV_PATH),
    normalizeText(env.MIGEL_AGENT_ENV_PATH),
    hermesHome ? join(hermesHome, '.env') : '',
    join(homeDir, '.hermes', '.env'),
    join(homeDir, '.hermes-openclaw', '.env'),
    join(homeDir, '.openclaw', '.env'),
    cwd ? join(cwd, '.env') : '',
  ].filter(Boolean);
  return Array.from(new Set(paths));
}

async function requestImageGeneration({
  prompt,
  size,
  apiKey,
  fetchImpl,
  timeoutMs,
  randomId,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(GPT_IMAGE_2_GENERATIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': randomId(),
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL_ID,
        prompt,
        n: 1,
        size: normalizeText(size) || DEFAULT_SIZE,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJsonObject(text);
    if (!response.ok) {
      throw new Error(`gpt-image-2 图片接口失败（HTTP ${response.status}）：${extractServiceMessage(parsed) || text.slice(0, 240)}`);
    }
    const image = firstGeneratedImage(parsed);
    if (!image) {
      throw new Error('gpt-image-2 图片接口没有返回可用图片。');
    }
    return {
      raw: parsed,
      image,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`gpt-image-2 图片接口超时（${positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS)} ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestImageEdit({
  prompt,
  size,
  apiKey,
  images,
  fetchImpl,
  timeoutMs,
  randomId,
}) {
  const boundary = `migel-gpt-image-2-${randomId().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'edit'}`;
  const body = buildImageEditMultipartBody(boundary, {
    model: DEFAULT_MODEL_ID,
    prompt,
    n: '1',
    size: normalizeText(size) || DEFAULT_SIZE,
    response_format: 'b64_json',
  }, images);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(GPT_IMAGE_2_EDITS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'api-key': apiKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Accept: 'application/json, text/plain, */*',
        'Idempotency-Key': randomId(),
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = parseJsonObject(text);
    if (!response.ok) {
      throw new Error(`gpt-image-2 图生图接口失败（HTTP ${response.status}）：${extractServiceMessage(parsed) || text.slice(0, 240)}`);
    }
    const image = firstGeneratedImage(parsed);
    if (!image) {
      throw new Error('gpt-image-2 图生图接口没有返回可用图片。');
    }
    return {
      raw: parsed,
      image,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`gpt-image-2 图生图接口超时（${positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS)} ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveImageEditInputs(attachments, {
  fetchImpl,
  readFileImpl,
  timeoutMs,
  maxInputImages,
  maxInputBytes,
} = {}) {
  const imageAttachments = normalizeAttachments(attachments).filter(isImageAttachment);
  if (!imageAttachments.length) {
    throw new Error('gpt-image-2 本地图生图至少需要一张输入图片。');
  }
  const limit = positiveInteger(maxInputImages, DEFAULT_MAX_EDIT_INPUT_IMAGES);
  if (imageAttachments.length > limit) {
    throw new Error(`gpt-image-2 本地图生图最多支持 ${limit} 张输入图片。`);
  }

  const inputs = [];
  for (let index = 0; index < imageAttachments.length; index += 1) {
    inputs.push(await resolveSingleImageEditInput(imageAttachments[index], {
      index,
      fetchImpl,
      readFileImpl,
      timeoutMs,
      maxInputBytes,
    }));
  }
  return inputs;
}

async function resolveSingleImageEditInput(attachment, {
  index,
  fetchImpl,
  readFileImpl,
  timeoutMs,
  maxInputBytes,
} = {}) {
  const inlineBase64 = normalizeBase64Payload(
    attachment.dataBase64
      || attachment.data
      || attachment.base64
      || parseDataImageUrl(attachment.url || attachment.remoteUrl || attachment.downloadUrl)?.base64,
  );
  if (inlineBase64) {
    const bytes = Buffer.from(inlineBase64, 'base64');
    return normalizeImageEditInputBytes(attachment, bytes, {
      index,
      maxInputBytes,
      fallbackMimeType: parseDataImageUrl(attachment.url || attachment.remoteUrl || attachment.downloadUrl)?.mimeType,
    });
  }

  const localPath = normalizeLocalImagePath(attachment.localPath || attachment.filePath || attachment.path);
  if (localPath) {
    if (typeof readFileImpl !== 'function') {
      throw new Error('gpt-image-2 本地图生图缺少本地图片读取能力。');
    }
    const bytes = await readFileImpl(localPath);
    return normalizeImageEditInputBytes(attachment, bytes, {
      index,
      maxInputBytes,
      fallbackName: localPath.split('/').pop(),
      fallbackMimeType: mimeTypeFromPath(localPath),
    });
  }

  const remoteUrl = normalizeRemoteUrl(attachment.remoteUrl || attachment.downloadUrl || attachment.url);
  if (remoteUrl) {
    const downloaded = await downloadImageEditInput(remoteUrl, {
      fetchImpl,
      timeoutMs,
      maxInputBytes,
    });
    return normalizeImageEditInputBytes(attachment, downloaded.bytes, {
      index,
      maxInputBytes,
      fallbackMimeType: downloaded.mimeType,
    });
  }

  throw new Error(`gpt-image-2 本地图生图第 ${index + 1} 张输入图片缺少 base64、URL 或本地路径。`);
}

function normalizeImageEditInputBytes(attachment, bytes, {
  index,
  maxInputBytes,
  fallbackName,
  fallbackMimeType,
} = {}) {
  const data = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes || []);
  if (!data.length) {
    throw new Error(`gpt-image-2 本地图生图第 ${index + 1} 张输入图片为空。`);
  }
  const maxBytes = positiveInteger(maxInputBytes, DEFAULT_MAX_EDIT_INPUT_BYTES);
  if (data.length > maxBytes) {
    throw new Error(`gpt-image-2 本地图生图第 ${index + 1} 张输入图片超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB。`);
  }
  const mimeType = normalizeImageMimeType(
    attachment?.mimeType
      || attachment?.mediaType
      || fallbackMimeType
      || detectImageMimeType(data),
  );
  return {
    name: normalizeImageFileName(attachment?.name || fallbackName || `image-${index + 1}`, mimeType),
    mimeType,
    bytes: data,
  };
}

async function downloadImageEditInput(url, {
  fetchImpl,
  timeoutMs,
  maxInputBytes,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境缺少 fetch，无法下载图生图输入图片。');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'image/*,*/*',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      throw new Error(`下载 gpt-image-2 图生图输入图片失败（HTTP ${response.status}）：${text.slice(0, 180) || url}`);
    }
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    const maxBytes = positiveInteger(maxInputBytes, DEFAULT_MAX_EDIT_INPUT_BYTES);
    if (contentLength > maxBytes) {
      throw new Error(`gpt-image-2 图生图输入图片超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB。`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`gpt-image-2 图生图输入图片超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB。`);
    }
    return {
      bytes,
      mimeType: normalizeImageMimeType(response.headers?.get?.('content-type')),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`下载 gpt-image-2 图生图输入图片超时（${positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS)} ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildImageEditMultipartBody(boundary, fields, images) {
  const chunks = [];
  const pushText = (name, value) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(Buffer.from(`${String(value)}\r\n`));
  };
  for (const [name, value] of Object.entries(fields)) {
    pushText(name, value);
  }
  images.forEach((image, index) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="image"; filename="${escapeMultipartFileName(image.name || `image-${index + 1}.png`)}"\r\n`));
    chunks.push(Buffer.from(`Content-Type: ${normalizeImageMimeType(image.mimeType)}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes || []));
    chunks.push(Buffer.from('\r\n'));
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function resolveGeneratedImageBytes(image, {
  fetchImpl,
  timeoutMs,
} = {}) {
  const base64 = normalizeBase64Payload(image.base64);
  if (base64) {
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length) throw new Error('gpt-image-2 返回的 base64 图片为空。');
    return {
      bytes,
      mimeType: normalizeImageMimeType(image.mimeType),
    };
  }

  const url = normalizeRemoteUrl(image.url);
  if (!url) {
    throw new Error('gpt-image-2 返回图片缺少 b64_json 或 url。');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'image/*',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      throw new Error(`gpt-image-2 图片下载失败（HTTP ${response.status}）：${text.slice(0, 180) || url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('gpt-image-2 下载图片为空。');
    return {
      bytes,
      mimeType: normalizeImageMimeType(response.headers?.get?.('content-type') || image.mimeType),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`gpt-image-2 图片下载超时（${positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS)} ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function firstGeneratedImage(payload) {
  const candidates = [];
  collectGeneratedImages(payload, candidates);
  return candidates[0] || null;
}

function collectGeneratedImages(value, candidates) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectGeneratedImages(item, candidates));
    return;
  }
  const base64 = normalizeText(value.b64_json)
    || normalizeText(value.dataBase64)
    || (normalizeText(value.type).toLowerCase().includes('image') ? normalizeText(value.data) : '');
  const url = normalizeRemoteUrl(value.url) || normalizeRemoteUrl(value.remoteUrl);
  if (base64 || url) {
    candidates.push({
      base64,
      url,
      mimeType: normalizeImageMimeType(value.mimeType || value.mime_type),
      revisedPrompt: normalizeText(value.revised_prompt) || normalizeText(value.revisedPrompt),
    });
  }
  Object.values(value).forEach((item) => collectGeneratedImages(item, candidates));
}

function buildOutputFileName({
  mimeType,
  clock,
  randomId,
}) {
  const timestamp = toTimestamp(clock);
  const suffix = randomId().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'image';
  return `${DEFAULT_OUTPUT_NAME_PREFIX}_${timestamp}_${suffix}${extensionForMimeType(mimeType)}`;
}

function toTimestamp(valueOrClock) {
  const value = typeof valueOrClock === 'function' ? valueOrClock() : valueOrClock;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'now';
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function resolveOutputDir({ outputDir, env, homeDir }) {
  const explicit = normalizeText(outputDir) || normalizeText(env.MIGEL_GPT_IMAGE_OUTPUT_DIR);
  if (explicit) return explicit;
  const hermesHome = normalizeText(env.HERMES_HOME) || join(homeDir, '.hermes');
  return join(hermesHome, 'cache', 'images');
}

async function readOptionalText(filePath, readFileImpl) {
  if (!filePath) return '';
  try {
    return await readFileImpl(filePath, 'utf8');
  } catch {
    return '';
  }
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

function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function extractServiceMessage(value) {
  if (!value || typeof value !== 'object') return '';
  const error = value.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    return normalizeText(error.message) || normalizeText(error.code) || normalizeText(error.type);
  }
  return normalizeText(value.message);
}

function normalizeRequest(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    text: normalizeText(source.text || source.content || source.prompt),
    modelId: normalizeText(source.modelId || source.model),
    attachments: normalizeAttachments(source.attachments),
  };
}

function normalizeCapabilityRequest(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    prompt: normalizeText(source.prompt || source.text || source.content),
    attachments: normalizeAttachments(source.attachments),
  };
}

function normalizeAttachments(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function isImageAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return false;
  const kind = normalizeText(attachment.kind).toLowerCase();
  const mimeType = normalizeText(attachment.mimeType || attachment.mediaType).toLowerCase();
  if (kind === 'image') return true;
  return mimeType.startsWith('image/');
}

function looksLikeImageModel(modelId) {
  const text = normalizeText(modelId).toLowerCase();
  return text === DEFAULT_MODEL_ID || /^gpt-image\b/.test(text) || text.includes('image-generation');
}

function looksLikePromptOptimization(compact, lower) {
  if (!containsAny(compact, ...PROMPT_OPTIMIZATION_MARKERS)) return false;
  if (containsAny(compact, '文生图', '图片生成接口')) return false;
  return containsAny(lower, ...IMAGE_TARGET_MARKERS)
    || containsAny(lower, ...CHAT_INTENT_MARKERS)
    || containsAny(compact, '提示词', 'prompt', '咒语');
}

function containsAny(value, ...needles) {
  return needles.some((needle) => normalizeText(needle) && value.includes(needle.toLowerCase()));
}

function normalizeImageMimeType(value) {
  const text = normalizeText(value).toLowerCase().split(';', 1)[0];
  return text.startsWith('image/') ? text : 'image/png';
}

function parseDataImageUrl(value) {
  const match = normalizeText(value).match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  return {
    mimeType: normalizeImageMimeType(match[1]),
    base64: match[2],
  };
}

function detectImageMimeType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return '';
}

function extensionForMimeType(mimeType) {
  const normalized = normalizeImageMimeType(mimeType);
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  const extension = extname(normalized);
  return extension || '.png';
}

function normalizeImageFileName(name, mimeType) {
  const extension = extensionForMimeType(mimeType);
  const raw = normalizeText(name)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120) || 'image';
  if (/\.(?:png|jpe?g|webp|gif)$/i.test(raw)) return raw;
  return `${raw}${extension}`;
}

function normalizeLocalImagePath(value) {
  const text = normalizeText(value);
  if (!text || !looksLikeImagePath(text)) return '';
  if (text.startsWith('file://')) {
    try {
      return new URL(text).pathname;
    } catch {
      return '';
    }
  }
  return text.startsWith('/') ? text : '';
}

function looksLikeImagePath(value) {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(normalizeText(value).split(/[?#]/, 1)[0]);
}

function mimeTypeFromPath(value) {
  const lower = normalizeText(value).split(/[?#]/, 1)[0].toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function escapeMultipartFileName(value) {
  return normalizeText(value)
    .replace(/[\r\n"]/g, '_')
    .slice(0, 180) || 'image.png';
}

function normalizeBase64Payload(value) {
  const text = normalizeText(value);
  const dataUrl = text.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  return (dataUrl ? dataUrl[2] : text).replace(/\s/g, '');
}

function normalizeRemoteUrl(value) {
  const text = normalizeText(value);
  return text.startsWith('http://') || text.startsWith('https://') ? text : '';
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
