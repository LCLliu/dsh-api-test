import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 分类结果落盘目录，相对需求 JSON 所在目录。 */
const DOCS_DIR = '.agentGraDocs';

export type classificationResult = Record<string, unknown>;

const isRecord = (value: unknown): value is classificationResult =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 带 modules 数组才算一条可用的分类结果。 */
const isResult = (value: unknown): value is classificationResult =>
  isRecord(value) && Array.isArray(value.modules);

/**
 * 按出现顺序抽出文本里的顶层 JSON 对象。
 * 用括号配对扫描而不是正则，才能容忍嵌套对象、字符串里的花括号，
 * 以及模型没忍住加上的代码块围栏和说明文字；解析不了的片段直接跳过。
 */
export const extractJsonObjects = (text: string): unknown[] => {
  const found: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          found.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // 片段不是合法 JSON，跳过这条，不影响其余
        }
        start = -1;
      }
    }
  }

  return found;
};

/**
 * 把回复里的 JSON 对回本批需求：优先按 workItemID；
 * 完全没写 id 的对象按出现顺序补位，写了但不属于本批的 id 直接丢弃，
 * 免得把分析结果挂到别的需求上。
 */
export const matchBatchResults = (itemIds: string[], text: string): Map<string, classificationResult> => {
  const matched = new Map<string, classificationResult>();
  const anonymous: classificationResult[] = [];

  for (const value of extractJsonObjects(text)) {
    if (!isResult(value)) continue;
    const id = typeof value.workItemID === 'string' ? value.workItemID.trim() : '';
    if (id === '') anonymous.push(value);
    else if (itemIds.includes(id) && !matched.has(id)) matched.set(id, value);
  }

  const free = itemIds.filter((id) => !matched.has(id));
  anonymous.forEach((result, index) => {
    const id = free[index];
    if (id !== undefined) matched.set(id, result);
  });

  return matched;
};

/** workItemID 会进文件名：换掉分隔符等字符、去掉开头的点，避免跳出目录。 */
const safeFileName = (id: string): string => {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned === '' ? 'unnamed' : cleaned;
};

/**
 * 每条需求写一个 JSON 文件到 `<需求 JSON 目录>/.agentGraDocs/`。
 * 先写临时文件再改名，避免中断留下半截文件。
 * @returns id 到相对路径的映射，相对路径直接写回 requirement.json
 */
export const writeAgentDocs = async (
  source: string,
  results: Map<string, classificationResult>,
): Promise<Map<string, string>> => {
  const root = path.dirname(path.resolve(source));
  const dir = path.join(root, DOCS_DIR);
  await mkdir(dir, { recursive: true });

  const written = new Map<string, string>();
  for (const [id, result] of results) {
    const name = `${safeFileName(id)}.json`;
    const file = path.join(dir, name);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(result, null, 2) + '\n', 'utf-8');
    await rename(tmp, file);
    written.set(id, `${DOCS_DIR}/${name}`);
  }

  return written;
};
