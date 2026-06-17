import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_PERMISSION_DENIED_MESSAGE = '这次操作需要电脑端权限确认，但本地执行被拒绝了。';
const UNBACKED_PERMISSION_CONFIRMATION_MESSAGE = '没有收到真实的权限请求：本地模型只是输出了“已触发审核弹窗”的文字，Desktop Connector 没有发出 permission.request。请改用真实工具执行链路测试审批。';

export function extractChatCompletionDeltaText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return contentValueToText(choice?.delta?.content)
    || contentValueToText(choice?.delta?.text)
    || contentValueToText(choice?.delta)
    || contentValueToText(choice?.text)
    || contentValueToText(choice?.message?.content)
    || contentValueToText(payload?.delta?.content)
    || contentValueToText(payload?.delta?.text)
    || contentValueToText(payload?.delta)
    || contentValueToText(payload?.text)
    || contentValueToText(payload?.content)
    || contentValueToText(payload?.output_text);
}

export function extractChatCompletionText(completion) {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const candidates = [
    choice?.message?.content,
    choice?.text,
    choice?.delta?.content,
    completion?.message?.content,
    completion?.content,
    completion?.text,
    completion?.output_text,
  ];
  for (const candidate of candidates) {
    const text = contentValueToText(candidate, { separator: '\n\n' }).trim();
    if (text) return text;
  }
  return extractResponseOutputText(completion).trim()
    || extractResponseOutputText(completion?.response).trim();
}

export function sanitizeAssistantContent(value) {
  let text = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  if (!text.trim()) return '';

  const withoutLeading = text.trimStart();
  if (/^(?:\u26A0\uFE0F?\s*)?Compression model\b/.test(withoutLeading)) {
    const thresholdCleaned = text.replace(
      /^\s*(?:\u26A0\uFE0F?\s*)?Compression model\b[\s\S]*?^\s*threshold:\s*\d+(?:\.\d+)?\s*$\s*/m,
      '',
    );
    if (thresholdCleaned !== text) {
      text = thresholdCleaned;
    } else {
      const blankCleaned = text.replace(
        /^\s*(?:\u26A0\uFE0F?\s*)?Compression model\b[\s\S]*?\n\s*\n\s*/m,
        '',
      );
      if (blankCleaned !== text) {
        text = blankCleaned;
      }
    }
  }

  text = stripLeadingPermissionTranscript(text).trimStart();
  if (looksLikeUnbackedPermissionConfirmationClaim(text)) {
    return UNBACKED_PERMISSION_CONFIRMATION_MESSAGE;
  }
  return text;
}

export function extractChatCompletionImages(payload) {
  const images = [];
  collectImageParts(payload, images);
  return mergeImages([], images);
}

export function extractChatCompletionImagesFromText(text) {
  const images = [];
  const seen = new Set();
  for (const reference of extractImageReferencesFromText(text)) {
    const image = referenceToImage(reference);
    const key = image?.dataBase64?.slice(0, 96) || image?.url || image?.localPath || image?.id;
    if (!image || !key || seen.has(key)) continue;
    seen.add(key);
    images.push(image);
  }
  return images;
}

export function stripImageReferencesFromText(text) {
  let stripped = normalizeText(text);
  if (!stripped) return '';
  for (const reference of extractImageReferencesFromText(stripped)) {
    stripped = stripped.split(reference).join('');
  }
  stripped = stripped
    .replace(/!\[[^\]]*]\(\s*\)/g, '')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      return !/^(?:图片|图像|image|generated image|saved image|已生成|已保存|已生成图片|已保存图片|图片已生成|图片已保存|保存路径|文件路径)\s*[:：-]?\s*$/i.test(line);
    })
    .join('\n')
    .trim();
  return stripped;
}

export function mergeImages(existing, incoming) {
  const merged = new Map();
  for (const image of [...existing, ...incoming]) {
    if (!image) continue;
    const key = image.dataBase64?.slice(0, 96) || image.url || image.localPath || image.id;
    if (!key) continue;
    merged.set(key, image);
  }
  return Array.from(merged.values());
}

function contentValueToText(value, { separator = '' } = {}) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return contentPartToText(value, { separator });
  return value
    .map((part) => contentPartToText(part, { separator }))
    .filter(Boolean)
    .join(separator);
}

function contentPartToText(part, { separator = '' } = {}) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.text?.value === 'string') return part.text.value;
  if (typeof part.content === 'string') return part.content;
  if (Array.isArray(part.content)) return contentValueToText(part.content, { separator });
  if (typeof part.output_text === 'string') return part.output_text;
  if (typeof part.summary === 'string') return part.summary;
  return '';
}

function extractResponseOutputText(value) {
  if (!value || typeof value !== 'object') return '';
  const outputText = contentValueToText(value.output_text, { separator: '\n\n' }).trim();
  if (outputText) return outputText;
  if (!Array.isArray(value.output)) return '';
  return value.output
    .map((item) => {
      if (typeof item === 'string') return item;
      return contentValueToText(item?.content, { separator: '\n\n' }).trim()
        || contentValueToText(item?.text, { separator: '\n\n' }).trim()
        || contentValueToText(item?.summary, { separator: '\n\n' }).trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

function stripLeadingPermissionTranscript(value) {
  const text = String(value || '').trimStart();
  if (!looksLikePermissionTranscript(text)) return text;

  const deniedMatch = text.match(/\bChoice\s*\[o\/s\/D\]\s*:\s*(?:\n\s*)?Denied\b/i);
  if (!deniedMatch) return '';

  const afterDenied = text.slice(deniedMatch.index + deniedMatch[0].length);
  const cleaned = stripLeadingCommandEcho(afterDenied).trimStart();
  return cleaned || LOCAL_PERMISSION_DENIED_MESSAGE;
}

function looksLikePermissionTranscript(value) {
  return /^(?:DANGEROUS COMMAND:\s*)?Security scan\b/i.test(value)
    || /^DANGEROUS COMMAND\b/i.test(value);
}

function looksLikeUnbackedPermissionConfirmationClaim(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (looksLikeUnbackedExecuteCodeApprovalClaim(text)) return true;
  if (looksLikeUnbackedFileDeleteApprovalClaim(text)) return true;
  const claimsPrompt = /(?:已\s*触发|已经\s*触发|触发了|已\s*发起|已经\s*发起)[\s\S]{0,100}(?:审核|审批|权限|命令)[\s\S]{0,60}(?:弹窗|窗口|确认)/i.test(text)
    || /(?:审核|审批|权限|命令)[\s\S]{0,60}(?:弹窗|窗口|确认)[\s\S]{0,40}(?:已\s*)?(?:触发|发起)/i.test(text);
  if (!claimsPrompt) return false;
  if (/\btool_calls_made\s*=\s*0\b/i.test(text) || /(?:还没|尚未|没有)[\s\S]{0,20}(?:执行|产生请求|消耗额度)/i.test(text)) {
    return true;
  }
  return /(?:安卓端|手机端|移动端|你)[\s\S]{0,80}(?:点|点击|确认|同意|批准|approve)[\s\S]{0,80}(?:后|才能|等待|等)/i.test(text)
    || /(?:等你|等待你|需要你)[\s\S]{0,60}(?:点|点击|确认|同意|批准|approve)/i.test(text)
    || /才能拿到真实结果|拿到真实结果/i.test(text);
}

function looksLikeUnbackedExecuteCodeApprovalClaim(text) {
  const executeCodeClaim = /\bexecute[_\s.-]*code\b[\s\S]{0,120}(?:asking\s+the\s+user\s+for\s+approval|approval\s+(?:request|required|needed|pending)|permission\s+(?:request|required|needed|pending))/i.test(text);
  const toolCallMissing = /\btool_calls_made\s*=\s*0\b/i.test(text)
    || /(?:没有|未|还没|尚未)[\s\S]{0,30}(?:产生请求|执行|消耗额度|真正执行)/i.test(text);
  return executeCodeClaim || (toolCallMissing && /(?:approval|permission|审批|权限|批准|确认)/i.test(text));
}

function looksLikeUnbackedFileDeleteApprovalClaim(text) {
  const mentionsFileDelete = /(?:删除|删掉|删了|移除|delete|remove)[\s\S]{0,240}(?:~\/|\/Users\/|\/private\/tmp\/|\/tmp\/)/i.test(text)
    || /(?:~\/|\/Users\/|\/private\/tmp\/|\/tmp\/)[\s\S]{0,160}(?:删除|删掉|删了|移除|delete|remove)/i.test(text);
  if (!mentionsFileDelete) return false;
  const claimsApproval = /(?:已\s*触发|已经\s*触发|触发了|已\s*发起|已经\s*发起)[\s\S]{0,100}(?:审核|审批|权限)/i.test(text)
    || /(?:审核|审批|权限)[\s\S]{0,80}(?:已\s*)?(?:触发|发起)/i.test(text);
  const claimsPendingApproval = claimsApproval
    || /(?:当前状态|状态)[\s\S]{0,80}(?:等待|pending)[\s\S]{0,40}(?:批准|确认|approval)/i.test(text)
    || /(?:等待|等|需要)[\s\S]{0,80}(?:安卓端|手机端|移动端|你)[\s\S]{0,80}(?:确认|同意|批准|approve)/i.test(text)
    || /(?:只要|等到)[\s\S]{0,40}(?:你|安卓端|手机端|移动端)[\s\S]{0,80}(?:点|点击|确认|同意|批准|approve)/i.test(text);
  if (!claimsPendingApproval) return false;
  return /(?:安卓端|手机端|移动端|你)[\s\S]{0,80}(?:点|点击|确认|同意|批准|approve)[\s\S]{0,80}(?:后|才能|等待|等|才会)/i.test(text)
    || /(?:等你|等待你|需要你)[\s\S]{0,60}(?:点|点击|确认|同意|批准|approve)/i.test(text)
    || /(?:当前状态|状态)[\s\S]{0,80}(?:等待|pending)[\s\S]{0,40}(?:批准|确认|approval)/i.test(text)
    || /才会(?:继续|真正)?执行|才能真正执行|还没真正删|拿真实结果|真实结果|\bDELETED\b|\bNOT_FOUND\b/i.test(text);
}

function stripLeadingCommandEcho(value) {
  let text = String(value || '').trimStart();
  let previous = '';
  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(/^\s*`{3,}[a-zA-Z0-9_-]*\n[\s\S]*?\n`{3,}\s*/m, '')
      .replace(/^\s*`(?:curl|python3?|node|bash|sh|tirith|vet)\b[^`\n]*`\s*/i, '')
      .replace(/^\s*(?:[$#]\s*)?(?:curl|python3?|node|bash|sh|tirith|vet)\b[^\n]*(?:\n|$)\s*/i, '')
      .trimStart();
  }
  return text;
}

function collectImageParts(value, images) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageParts(item, images));
    return;
  }

  const image = objectToImage(value);
  if (image) images.push(image);
  Object.values(value).forEach((item) => collectImageParts(item, images));
}

function objectToImage(value) {
  const type = normalizeText(value.type).toLowerCase();
  const imageValue = normalizeText(value.image)
    || normalizeText(value.filePath)
    || normalizeText(value.file_path)
    || normalizeText(value.path);
  const imageUrl = typeof value.image_url === 'string'
    ? value.image_url
    : normalizeText(value.image_url?.url);
  const url = normalizeText(value.url) || imageUrl || imageValue;
  const dataUrl = url.startsWith('data:image/') ? url : '';
  const dataUrlParts = dataUrl ? parseDataImageUrl(dataUrl) : null;
  const localPath = normalizeLocalImagePath(imageValue) || normalizeLocalImagePath(url);
  const base64 = dataUrlParts?.data
    || normalizeText(value.b64_json)
    || normalizeText(value.dataBase64)
    || (type.includes('image') ? normalizeText(value.data) || normalizeText(value.result) : '');
  const remoteUrl = url.startsWith('http://') || url.startsWith('https://') ? url : '';
  if (!base64 && !remoteUrl && !localPath) return null;

  const mimeType = dataUrlParts?.mimeType
    || normalizeText(value.mimeType)
    || normalizeText(value.mime_type)
    || mimeTypeFromReference(remoteUrl || localPath)
    || 'image/png';
  const keySource = base64.slice(0, 96) || remoteUrl || localPath;
  const id = `image-${createHash('sha1').update(keySource).digest('hex').slice(0, 12)}`;
  return {
    id,
    name: normalizeText(value.name) || nameFromReference(remoteUrl || localPath, id, mimeType),
    mimeType,
    dataBase64: base64 || undefined,
    url: remoteUrl || undefined,
    localPath: localPath || undefined,
  };
}

function referenceToImage(reference) {
  const normalized = normalizeText(reference).replace(/^<|>$/g, '');
  const dataUrlParts = parseDataImageUrl(normalized);
  const base64 = dataUrlParts?.data || '';
  const remoteUrl = normalized.startsWith('http://') || normalized.startsWith('https://')
    ? normalized
    : '';
  const localPath = normalizeLocalImagePath(normalized);
  if (!base64 && !remoteUrl && !localPath) return null;

  const mimeType = dataUrlParts?.mimeType || mimeTypeFromReference(remoteUrl || localPath) || 'image/png';
  const keySource = base64.slice(0, 96) || remoteUrl || localPath;
  const id = `image-${createHash('sha1').update(keySource).digest('hex').slice(0, 12)}`;
  return {
    id,
    name: nameFromReference(remoteUrl || localPath, id, mimeType),
    mimeType,
    dataBase64: base64 || undefined,
    url: remoteUrl || undefined,
    localPath: localPath || undefined,
  };
}

function extractImageReferencesFromText(value) {
  const text = normalizeText(value);
  if (!text) return [];

  const references = [];
  const markdownPattern = /!\[[^\]]*]\(([^)\s]+?\.(?:png|jpe?g|webp|gif))(?:\s+"[^"]*")?\)/gi;
  let match = markdownPattern.exec(text);
  while (match) {
    references.push(match[1]);
    match = markdownPattern.exec(text);
  }

  const pathPattern = /(?:file:\/\/)?\/[^\s)\]'"<>]+?\.(?:png|jpe?g|webp|gif)\b/gi;
  match = pathPattern.exec(text);
  while (match) {
    references.push(match[0]);
    match = pathPattern.exec(text);
  }

  const urlPattern = /https?:\/\/[^\s)\]'"<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s)\]'"<>]*)?/gi;
  match = urlPattern.exec(text);
  while (match) {
    references.push(match[0]);
    match = urlPattern.exec(text);
  }

  return references;
}

function normalizeLocalImagePath(value) {
  const text = normalizeText(value).replace(/^<|>$/g, '');
  if (!looksLikeImageFile(text)) return '';
  if (text.startsWith('file://')) {
    try {
      return fileURLToPath(text);
    } catch {
      return '';
    }
  }
  return text.startsWith('/') ? text : '';
}

function looksLikeImageFile(value) {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(normalizeText(value).split(/[?#]/, 1)[0]);
}

function mimeTypeFromReference(value) {
  const lower = normalizeText(value).split(/[?#]/, 1)[0].toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.png')) return 'image/png';
  return '';
}

function nameFromReference(reference, id, mimeType) {
  const path = normalizeText(reference).split(/[?#]/, 1)[0];
  const name = basename(path);
  if (name && name.includes('.')) return name.slice(0, 96);
  return `${id}.${mimeType.split('/')[1]?.split('+')[0] || 'png'}`;
}

function parseDataImageUrl(value) {
  const match = normalizeText(value).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
