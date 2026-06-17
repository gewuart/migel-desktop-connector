import { homedir } from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_SUMMARY_MAX_LENGTH = 78;

export async function loadInstalledSkills({
  skillRoot = join(homedir(), '.hermes'),
  readFileImpl = readFile,
  readdirImpl = readdir,
} = {}) {
  const collected = [
    ...(await collectSkillsFromDirectory(join(skillRoot, 'workspace', 'skills'), '工作区', { readFileImpl, readdirImpl })),
    ...(await collectSkillsFromDirectory(join(skillRoot, 'skills'), '用户', { readFileImpl, readdirImpl })),
    ...(await collectExtensionSkills(join(skillRoot, 'extensions'), { readFileImpl, readdirImpl })),
  ];

  const deduped = new Map();
  for (const skill of collected) {
    if (skill?.id && !deduped.has(skill.id)) {
      deduped.set(skill.id, skill);
    }
  }
  return Array.from(deduped.values());
}

export async function collectSkillsFromDirectory(rootDir, sourceLabel, {
  readFileImpl = readFile,
  readdirImpl = readdir,
} = {}) {
  const entries = await safeReadDir(rootDir, readdirImpl);
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.includes('.disabled')) continue;
    const skill = await loadSkillFromDirectory(join(rootDir, entry.name), sourceLabel, entry.name, { readFileImpl });
    if (skill) skills.push(skill);
  }

  return skills;
}

export async function collectExtensionSkills(rootDir, {
  readFileImpl = readFile,
  readdirImpl = readdir,
} = {}) {
  const entries = await safeReadDir(rootDir, readdirImpl);
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const packageJson = await readJsonFile(join(rootDir, entry.name, 'package.json'), readFileImpl);
    const refs = Array.isArray(packageJson?.hermes?.skills)
      ? packageJson.hermes.skills
      : Array.isArray(packageJson?.openclaw?.skills)
        ? packageJson.openclaw.skills
        : [];
    const sourceLabel = `插件 · ${normalizeText(packageJson?.hermes?.id) || normalizeText(packageJson?.openclaw?.id) || entry.name}`;
    for (const ref of refs) {
      const fallbackName = String(ref).split('/').at(-1) || entry.name;
      const skill = await loadSkillFromDirectory(join(rootDir, entry.name, ref), sourceLabel, fallbackName, { readFileImpl });
      if (skill) skills.push(skill);
    }
  }

  return skills;
}

export async function loadSkillFromDirectory(skillDir, sourceLabel, fallbackName, {
  readFileImpl = readFile,
} = {}) {
  const markdown = await readOptionalText(join(skillDir, 'SKILL.md'), readFileImpl);
  if (!markdown) return null;

  const name = extractFrontmatterScalar(markdown, 'name') || normalizeText(fallbackName);
  const description = extractFrontmatterScalar(markdown, 'description') || extractSkillBodySummary(markdown);
  const id = normalizeSkillId(name || fallbackName);
  if (!id) return null;

  return {
    id,
    title: name || humanizeModelId(fallbackName),
    summary: truncateText(description || '当前 skill 已安装，可在 Hermes 中直接调用。', DEFAULT_SUMMARY_MAX_LENGTH),
    source: sourceLabel,
  };
}

export function normalizeSkillId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function safeReadDir(dir, readdirImpl) {
  try {
    return await readdirImpl(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJsonFile(filePath, readFileImpl) {
  const raw = await readOptionalText(filePath, readFileImpl);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readOptionalText(filePath, readFileImpl) {
  try {
    return await readFileImpl(filePath, 'utf8');
  } catch {
    return null;
  }
}

function extractFrontmatterScalar(markdown, key) {
  const match = String(markdown || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return '';
  const regex = new RegExp(`(?:^|\\n)${key}:\\s*(.+)$`, 'm');
  const value = match[1].match(regex)?.[1] || '';
  if (!value || value === '>' || value === '|') return '';
  return value.replace(/^['"]|['"]$/g, '').trim();
}

function extractSkillBodySummary(markdown) {
  return String(markdown || '')
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/^#.*$/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !line.startsWith('```') && !line.startsWith('- ') && !line.startsWith('|')) || '';
}

function humanizeModelId(value) {
  return String(value || '')
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0]?.toUpperCase() + part.slice(1)))
    .join(' ');
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
