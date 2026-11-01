import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractJsonObjects } from './agent-docs.js';

const MODULE_TABLE_FILE = 'ref/模块参考表.md';

export interface moduleOption {
  l1: string;
  l2: string;
  l3: string;
  /** 写入需求 JSON 的 module 字段：l1-l2-l3 */
  path: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 把模块参考表的缩进列表解析成 l1/l2/l3 路径。 */
const parseModuleTable = (text: string): moduleOption[] => {
  const stack: string[] = [];
  const seen = new Set<string>();
  const options: moduleOption[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = /^(\s*)-\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;

    const indent = match[1].length;
    const name = match[2].trim();
    if (name === '') continue;

    const level = indent === 0 ? 0 : indent <= 4 ? 1 : 2;
    stack[level] = name;
    stack.length = level + 1;
    if (level !== 2) continue;

    const [l1, l2, l3] = stack;
    if (l1 === undefined || l2 === undefined || l3 === undefined) continue;

    const modulePath = `${l1}-${l2}-${l3}`;
    if (seen.has(modulePath)) continue;
    seen.add(modulePath);
    options.push({ l1, l2, l3, path: modulePath });
  }

  return options;
};

/** 读取 ref/模块参考表.md；没有 l1/l2/l3 选项直接报错。 */
export const loadModuleOptions = async (): Promise<moduleOption[]> => {
  const file = path.resolve(process.cwd(), MODULE_TABLE_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf-8');
  } catch {
    throw new Error(`读取模块参考表失败：${file}`);
  }

  const options = parseModuleTable(text);
  if (options.length === 0) throw new Error(`模块参考表里没有 l1-l2-l3 选项：${file}`);
  return options;
};

/** 把回复里的模块分类对回本批需求：只认带 workItemID、且 l1-l2-l3 确实在模块树里的对象。 */
export const matchModuleResults = (
  itemIds: string[],
  text: string,
  options: moduleOption[],
): Map<string, string> => {
  const valid = new Set(options.map((option) => option.path));
  const matched = new Map<string, string>();

  for (const value of extractJsonObjects(text)) {
    if (!isRecord(value)) continue;

    const raw = typeof value.module === 'string'
      ? value.module.trim()
      : [value.l1, value.l2, value.l3]
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .map((part) => part.trim())
        .join('-');
    const modulePath = raw.replace(/\s*\/\s*/g, '-').trim();
    const id = typeof value.workItemID === 'string' ? value.workItemID.trim() : '';

    if (modulePath === '' || !valid.has(modulePath)) continue;
    if (id === '' || !itemIds.includes(id) || matched.has(id)) continue;

    matched.set(id, modulePath);
  }

  return matched;
};
