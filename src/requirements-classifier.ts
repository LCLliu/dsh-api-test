import { readFileSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { requirementClassification, requirementItem } from '../shared/dsh-type.js';

const CONTENT_DIR = 'content';
const SKILL_FILE = 'ref/SKILL.md';

/** frontmatter 是给 skill 加载器看的，拼进提示词只留正文规则。 */
const stripFrontmatter = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

/**
 * 读取分类技能正文。文件缺失或为空时返回 undefined，
 * 让提示词退回不带规则的写法，而不是让整个分批任务失败。
 */
const skillRules = (): string | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path.resolve(process.cwd(), SKILL_FILE), 'utf-8');
  } catch {
    return undefined;
  }
  const body = stripFrontmatter(raw).trim();
  return body === '' ? undefined : body;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const firstString = (row: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
};

const readKey = (row: Record<string, unknown>): string | undefined =>
  firstString(row, ['Key', 'key']);

const readWorkItemID = (row: Record<string, unknown>): string | undefined =>
  firstString(row, ['work item ID', 'work itemID', 'workItemID', 'workItemId', 'work_item_id']);

const readSummary = (row: Record<string, unknown>): string | undefined =>
  firstString(row, ['summary', 'Summary']);

const readPrd = (row: Record<string, unknown>): string | undefined =>
  firstString(row, ['prd', 'PRD']);

const readModule = (row: Record<string, unknown>): string | undefined =>
  firstString(row, ['模块', 'module', 'Module']);

/** 支持根数组，或 requirements / items / list / data 四个常见字段。 */
const pickRows = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  if (isRecord(data)) {
    for (const key of ['requirements', 'items', 'list', 'data']) {
      const value = data[key];
      if (Array.isArray(value)) return value;
    }
  }
  throw new Error('需求 JSON 里没有数组：支持根数组或 requirements/items/list/data 字段');
};

/** 扫描 content 下的 HTML，按文件名（不含扩展名）建立索引。 */
const loadHtmlIndex = async (root: string): Promise<Map<string, string>> => {
  const contentRoot = path.join(root, CONTENT_DIR);
  const index = new Map<string, string>();

  let entries: string[];
  try {
    entries = await readdir(contentRoot, { recursive: true });
  } catch {
    return index;
  }

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.html')) continue;
    const id = path.basename(entry, path.extname(entry));
    if (index.has(id)) continue;
    const absolute = path.join(contentRoot, entry);
    index.set(id, path.relative(root, absolute).split(path.sep).join('/'));
  }
  return index;
};

/** 优先用 work item ID 找 HTML，找不到再试 Key。 */
const matchContentPath = (
  htmlIndex: Map<string, string>,
  key: string,
  workItemID: string | undefined,
): string | undefined => (workItemID === undefined ? undefined : htmlIndex.get(workItemID)) ?? htmlIndex.get(key);

/** 读取一条需求；只有 content 下匹配到 HTML 时才补 requirement_content_path。 */
const toRequirement = (
  row: unknown,
  index: number,
  htmlIndex: Map<string, string>,
): requirementItem => {
  if (!isRecord(row)) throw new Error(`第 ${index + 1} 条需求不是对象`);

  const key = readKey(row) ?? readWorkItemID(row) ?? `R-${index + 1}`;
  const workItemID = readWorkItemID(row);
  const summary = readSummary(row) ?? key;
  const prd = readPrd(row);
  const moduleName = readModule(row);
  const contentPath = matchContentPath(htmlIndex, key, workItemID);
  const classification = isRecord(row.classification)
    ? row.classification as requirementClassification
    : undefined;

  return {
    key,
    summary,
    ...(workItemID === undefined ? {} : { workItemID }),
    ...(prd === undefined ? {} : { prd }),
    ...(moduleName === undefined ? {} : { module: moduleName }),
    ...(contentPath === undefined ? {} : { requirement_content_path: contentPath }),
    ...(classification === undefined ? {} : { classification }),
  };
};

/** 原子写回 JSON：先写临时文件再替换，避免中途失败留下半截文件。 */
const writeRequirements = async (file: string, data: unknown): Promise<void> => {
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await rename(tmp, file);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    throw new Error(`写入需求 JSON 失败：${file}`);
  }
};

/**
 * 后端启动时把卡在 running 的条目降级成 error。
 * 分批任务只活在进程里，重启后没人再收那一轮，running 就成了假状态；
 * 降级后下一次启动任务会把这些条目重新捞起来发。
 * @returns 被降级的条数
 */
export const recoverStaleRunning = async (source: string): Promise<number> => {
  const file = path.resolve(source);

  let rows: unknown[];
  let data: unknown;
  try {
    data = JSON.parse((await readFile(file, 'utf-8')).replace(/^\uFEFF/, ''));
    rows = pickRows(data);
  } catch {
    return 0;
  }

  let changed = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const classification = row.classification;
    if (isRecord(classification) && classification.status === 'running') {
      row.classification = { ...classification, status: 'error', error: '后端重启，本轮结果未知' };
      changed += 1;
    }
  }

  if (changed > 0) await writeRequirements(file, data);
  return changed;
};

export interface classificationUpdate {
  workItemID: string;
  classification: requirementClassification;
  /** 模型解析出的意图结果；存在时追加到该需求的 Category 数组 */
  category?: unknown;
  /** 模块树分类结果：l1-l2-l3 */
  module?: string;
}

export interface classificationBatchRecord {
  batch: number;
  requestId: string;
  sessionId: string;
  status: 'running' | 'done' | 'error';
  text?: string;
  reason?: string;
  error?: string;
  itemIds: string[];
  startedAt: number;
  endedAt?: number;
}

/** 把一批的分类状态和回复写回 requirements.json，保留其他字段。 */
export const persistClassification = async (
  source: string,
  updates: classificationUpdate[],
  batchRecord: classificationBatchRecord,
): Promise<void> => {
  const file = path.resolve(source);

  let data: unknown;
  try {
    data = JSON.parse((await readFile(file, 'utf-8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`读取需求 JSON 失败：${file}`);
  }

  const rows = pickRows(data);
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = readWorkItemID(row) ?? readKey(row);
    if (id !== undefined) byId.set(id, row);
  }

  for (const update of updates) {
    const row = byId.get(update.workItemID);
    if (row === undefined) continue;

    row.classification = update.classification;
    if (update.module !== undefined) row.module = update.module;
    if (update.category === undefined) continue;

    const current = row.Category;
    const categories = Array.isArray(current)
      ? current
      : current === undefined
        ? []
        : [current];
    categories.push(update.category);
    row.Category = categories;
  }

  if (isRecord(data)) {
    const existing = Array.isArray(data.classification_batches)
      ? data.classification_batches
      : [];
    const index = existing.findIndex(
      (entry) => isRecord(entry) && entry.requestId === batchRecord.requestId,
    );
    if (index >= 0) existing[index] = batchRecord;
    else existing.push(batchRecord);
    data.classification_batches = existing;
  }

  await writeRequirements(file, data);
};

/** 读取 env 指向的需求 JSON，扫描 content 下的 HTML；persist=false 时不回写。 */
export const loadRequirements = async (source: string, persist = true): Promise<requirementItem[]> => {
  const file = path.resolve(source);
  const root = path.dirname(file);

  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch {
    throw new Error(`读取需求 JSON 失败：${file}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`需求 JSON 解析失败：${file}`);
  }

  const rows = pickRows(data);
  const htmlIndex = await loadHtmlIndex(root);
  const items = rows.map((row, index) => toRequirement(row, index, htmlIndex));

  let changed = false;
  rows.forEach((row, index) => {
    if (!isRecord(row)) return;

    const key = readKey(row) ?? readWorkItemID(row) ?? `R-${index + 1}`;
    const matched = matchContentPath(htmlIndex, key, readWorkItemID(row)) ?? '';
    const current = typeof row.requirement_content_path === 'string' ? row.requirement_content_path : undefined;

    if (current !== matched) {
      row.requirement_content_path = matched;
      changed = true;
    }
  });

  if (changed && persist) await writeRequirements(file, data);
  return items;
};

/** 简单 HTML 转纯文本，够用于把需求原文拼进提示词。 */
const htmlToText = (html: string): string => html
  .replace(/<head[\s\S]*?<\/head>/gi, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
  .replace(/<li[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/gi, '&')
  .replace(/\r\n/g, '\n')
  .replace(/^[ \t]+/gm, '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const readRequirementText = async (root: string, contentPath: string): Promise<string | undefined> => {
  try {
    const target = path.resolve(root, contentPath);
    if (target !== root && !target.startsWith(root + path.sep)) return undefined;
    return htmlToText(await readFile(target, 'utf-8'));
  } catch {
    return undefined;
  }
};

export interface promptRequirement extends requirementItem {
  /** 从 requirement_content_path 读到的纯文本；缺失时表示没找到原文 */
  originalText?: string;
}

export interface requirementsPromptSource {
  items: promptRequirement[];
  missingContent: string[];
}

/** 一次性读取全部需求条目和原文，供预览或分批任务复用。 */
export const loadRequirementsForPrompt = async (source: string): Promise<requirementsPromptSource> => {
  const root = path.dirname(path.resolve(source));
  const items = await loadRequirements(source, false);
  const missingContent: string[] = [];
  const withText: promptRequirement[] = [];

  for (const item of items) {
    const text = item.requirement_content_path === undefined
      ? undefined
      : await readRequirementText(root, item.requirement_content_path);
    if (text === undefined) missingContent.push(item.workItemID ?? item.key);
    withText.push({ ...item, ...(text === undefined ? {} : { originalText: text }) });
  }

  return { items: withText, missingContent };
};

const renderPromptItem = (item: promptRequirement, index: number): string => {
  const lines = [
    `## ${index + 1}. ${item.workItemID ?? item.key}`,
    '',
    `- Key: ${item.key}`,
    `- work item ID: ${item.workItemID ?? ''}`,
    `- summary: ${item.summary}`,
  ];
  if (item.prd !== undefined) lines.push(`- prd: ${item.prd}`);
  if (item.module !== undefined) lines.push(`- 模块: ${item.module}`);
  lines.push('', '原文：', item.originalText ?? '（未找到原文）');
  return lines.join('\n');
};

export interface requirementsPrompt {
  prompt: string;
  count: number;
  missingContent: string[];
}

/** 分类指令 = 角色 + 技能规则；预览和分批共用，保证看到的就是发出去的。 */
const classificationIntro = (): string => {
  const rules = skillRules();
  return [
    '你是一位资深的车机工程师，请根据下面的技能规则对需求条目逐条分类。',
    rules ?? '（未找到 ref/SKILL.md：请按模块、测试场景、文件依赖、计算逻辑分类，每条需求单独输出一个 JSON 对象。）',
  ].join('\n\n');
};

/** 全量预览：把所有需求拼成一段提示词。 */
export const buildRequirementsPrompt = async (source: string): Promise<requirementsPrompt> => {
  const loaded = await loadRequirementsForPrompt(source);
  return {
    prompt: loaded.items.length === 0
      ? '以下是需求条目及其原文：\n\n（无需求）'
      : [classificationIntro(), '以下是需求条目及其原文：', ...loaded.items.map(renderPromptItem)].join('\n\n'),
    count: loaded.items.length,
    missingContent: loaded.missingContent,
  };
};

export interface requirementsPromptBatch {
  prompt: string;
  count: number;
  offset: number;
  missingContent: string[];
}

/** 按 offset/limit 切一批需求，拼成带批次说明的提示词。 */
export const buildRequirementsPromptBatch = (
  items: promptRequirement[],
  offset: number,
  limit: number,
  batchIndex: number,
  batchTotal: number,
): requirementsPromptBatch => {
  const slice = items.slice(offset, offset + limit);
  const header = `${classificationIntro()}\n\n以下是需求条目及其原文（第 ${batchIndex}/${batchTotal} 批，本批 ${slice.length} 条，总 ${items.length} 条）：`;
  return {
    prompt: [header, ...slice.map((item, index) => renderPromptItem(item, offset + index))].join('\n\n'),
    count: slice.length,
    offset,
    missingContent: slice
      .filter((item) => item.originalText === undefined)
      .map((item) => item.workItemID ?? item.key),
  };
};
