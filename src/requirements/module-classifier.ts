import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { promptRequirement } from '../requirements-classifier.js';
import { extractJsonObjects } from './agent-docs.js';

const MODULE_TABLE_FILE = 'ref/模块参考表.md';
const MODULE_SKILL_FILE = 'ref/SKILL-module.md';

export interface moduleOption {
  l1: string;
  l2: string;
  l3: string;
  /** 写入需求 JSON 的 module 字段：l1-l2-l3 */
  path: string;
}

export interface moduleResult {
  module: string;
  confidence?: number;
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

/** 读取模块分类 skill；缺失时使用内置的最小提示。 */
export const loadModuleSkill = async (): Promise<string> => {
  const file = path.resolve(process.cwd(), MODULE_SKILL_FILE);
  try {
    return (await readFile(file, 'utf-8')).trim();
  } catch {
    return '你是智能座舱测试需求的模块分类器。根据需求原文，从模块树中选择唯一一个三级模块，只输出 JSON：{"workItemID":"...","module":"l1-l2-l3","confidence":0.0}。module 必须完整等于模块树中的某一行，无法判断时输出空字符串。';
  }
};

/** 拼一页模块分类提示词：模块树只出现一次，后面跟本批需求。 */
export const buildModulePrompt = (
  items: promptRequirement[],
  options: moduleOption[],
  skill: string,
  batchIndex: number,
  batchTotal: number,
): string => {
  const tree = options.map((option) => `- ${option.path}`).join('\n');
  const requirementBlocks = items.map((item, index) => {
    const lines = [
      `## ${index + 1}. ${item.workItemID ?? item.key}`,
      `- summary: ${item.summary}`,
    ];
    if (item.prd !== undefined) lines.push(`- prd: ${item.prd}`);
    const text = (item.originalText ?? '（未找到原文）').slice(0, 6000);
    lines.push('原文：', text);
    return lines.join('\n');
  }).join('\n\n');

  return [
    skill,
    `【模块树】\n${tree}`,
    `【需求】（第 ${batchIndex}/${batchTotal} 批，本批 ${items.length} 条）\n${requirementBlocks}`,
    '现在为每条需求选择模块，只输出 JSON 对象，每条需求一个，对象之间空行；module 必须是模块树中的完整 l1-l2-l3 路径。',
  ].join('\n\n');
};

/** 把回复里的模块分类对回本批需求，并校验 l1-l2-l3 确实在模块树里。 */
export const matchModuleResults = (
  itemIds: string[],
  text: string,
  options: moduleOption[],
): Map<string, moduleResult> => {
  const valid = new Set(options.map((option) => option.path));
  const matched = new Map<string, moduleResult>();
  const anonymous: moduleResult[] = [];

  for (const value of extractJsonObjects(text)) {
    if (!isRecord(value)) continue;

    const raw = typeof value.module === 'string'
      ? value.module.trim()
      : [value.l1, value.l2, value.l3]
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .map((part) => part.trim())
        .join('-');
    const modulePath = raw.replace(/\s*\/\s*/g, '-').trim();
    if (modulePath === '' || !valid.has(modulePath)) continue;

    const result: moduleResult = {
      module: modulePath,
      ...(typeof value.confidence === 'number' ? { confidence: value.confidence } : {}),
    };
    const id = typeof value.workItemID === 'string' ? value.workItemID.trim() : '';

    if (id === '') anonymous.push(result);
    else if (itemIds.includes(id) && !matched.has(id)) matched.set(id, result);
  }

  const free = itemIds.filter((id) => !matched.has(id));
  anonymous.forEach((result, index) => {
    const id = free[index];
    if (id !== undefined) matched.set(id, result);
  });

  return matched;
};
