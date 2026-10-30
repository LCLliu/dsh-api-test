import 'dotenv/config';

export const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';
export const DSH_TOKEN = process.env.DSH_TOKEN ?? '';
export const PORT = Number(process.env.PORT ?? 3000);

/** 分析后生成的工作 JSON；兼容拼写错误的历史变量名。 */
export const requirementsSource = (): string =>
  (process.env.REQUIREMNET_JSON_PATH ?? process.env.REQUIREMENTS_JSON_PATH ?? '').trim();

/** 原始需求清单 JSON：分析时从这里提取五个字段。 */
export const initialRequirementsSource = (): string =>
  (process.env.INIT_REQUIREMNET_LIST_PATH ?? process.env.INIT_REQUIREMENTS_LIST_PATH ?? '').trim();

/** 需求原文（HTML）所在根目录。 */
export const originalRequirementsSource = (): string =>
  (process.env.ORIGINAL_REQUIREMENT_PATH ?? '').trim();
