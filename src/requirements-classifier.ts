import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { requirementItem } from '../shared/dsh-type.js';

const CONTENT_DIR = 'content';

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

  return {
    key,
    summary,
    ...(workItemID === undefined ? {} : { workItemID }),
    ...(prd === undefined ? {} : { prd }),
    ...(moduleName === undefined ? {} : { module: moduleName }),
    ...(contentPath === undefined ? {} : { requirement_content_path: contentPath }),
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

/** 读取 env 指向的需求 JSON，扫描 content 下的 HTML，并把匹配结果回写 JSON。 */
export const loadRequirements = async (source: string): Promise<requirementItem[]> => {
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

  if (changed) await writeRequirements(file, data);
  return items;
};
