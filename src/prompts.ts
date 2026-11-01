import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadRequirementsForPrompt,
  type promptRequirement,
} from './requirements-classifier.js';
import type { moduleOption } from './requirements/module-classifier.js';

/**
 * 所有发往 dsh 的提示词都在这里拼装。
 *
 * 只放"怎么拼"，不放"数据怎么来"：需求和原文由 requirements-classifier 读，
 * 模块树由 module-classifier 解析，这里只把文本组织成最终提示词。
 * 新增一类提示词（如需求规格分析）就在下面加一节，不要再散回业务文件。
 */

const SKILL_FILE = 'ref/SKILL.md';
const MODULE_SKILL_FILE = 'ref/SKILL-module.md';

/** frontmatter 是给 skill 加载器看的，拼进提示词只留正文规则。 */
const stripFrontmatter = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

/**
 * 读取技能正文；文件缺失或为空时返回 undefined，
 * 让提示词退回不带规则的写法，而不是让整个分批任务失败。
 */
const loadSkill = (file: string): string | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path.resolve(process.cwd(), file), 'utf-8');
  } catch {
    return undefined;
  }
  const body = stripFrontmatter(raw).trim();
  return body === '' ? undefined : body;
};

// ---------------------------------------------------------------- 需求分类（阶段一）

/** 分类指令 = 角色 + 技能规则；预览和分批共用，保证看到的就是发出去的。 */
const classificationIntro = (): string => [
  '你是一位资深的车机工程师，请根据下面的技能规则对需求条目逐条分类。',
  loadSkill(SKILL_FILE)
    ?? '（未找到 ref/SKILL.md：请按模块、测试场景、文件依赖、计算逻辑分类，每条需求单独输出一个 JSON 对象。）',
].join('\n\n');

const renderPromptItem = (item: promptRequirement, index: number): string => {
  const lines = [
    `## ${index + 1}. ${item.workItemID ?? item.key}`,
    '',
    `- Key: ${item.key}`,
    `- work item ID: ${item.workItemID ?? ''}`,
    `- summary: ${item.summary}`,
  ];
  if (item.prd !== undefined) lines.push(`- prd: ${item.prd}`);
  const promptModule = item.sourceModule ?? item.module;
  if (promptModule !== undefined) lines.push(`- 模块: ${promptModule}`);
  lines.push('', '原文：', item.originalText ?? '（未找到原文）');
  return lines.join('\n');
};

export interface requirementsPrompt {
  prompt: string;
  count: number;
  missingContent: string[];
}

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

// ---------------------------------------------------------------- 模块树分类（阶段二）

/** 读取模块分类 skill；缺失时使用内置的最小提示。 */
export const loadModuleSkill = (): string =>
  loadSkill(MODULE_SKILL_FILE)
  ?? '你是智能座舱测试需求的模块分类器。根据需求原文，从模块树中选择唯一一个三级模块，只输出 JSON：{"workItemID":"...","module":"l1-l2-l3","confidence":0.0}。module 必须完整等于模块树中的某一行，无法判断时输出空字符串。';

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
