import 'dotenv/config';

export const DSH_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080';
export const DSH_TOKEN = process.env.DSH_TOKEN ?? '';
export const PORT = Number(process.env.PORT ?? 3000);

/** 需求 JSON 的路径；同时兼容拼写错误的历史变量名。 */
export const requirementsSource = (): string =>
  (process.env.REQUIREMENTS_JSON_PATH ?? process.env.REQUIREMNET_JSON_PATH ?? '').trim();
