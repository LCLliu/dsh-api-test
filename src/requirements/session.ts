import fs from 'node:fs';
import path from 'node:path';
import { dsh } from '../dsh/client.js';

const classificationSessionFile = path.resolve(process.cwd(), 'data', 'classification-session.json');

const readClassificationSession = (): string | undefined => {
  try {
    const raw = fs.readFileSync(classificationSessionFile, 'utf-8');
    const value = JSON.parse(raw) as { sessionId?: unknown };
    return typeof value.sessionId === 'string' && value.sessionId.trim() !== ''
      ? value.sessionId.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

const saveClassificationSession = (sessionId: string): void => {
  fs.mkdirSync(path.dirname(classificationSessionFile), { recursive: true });
  fs.writeFileSync(classificationSessionFile, JSON.stringify({ sessionId }, null, 2) + '\n', 'utf-8');
};

/** 固定分类会话：第一次使用时创建，之后所有批次复用。 */
export const ensureClassificationSession = async (): Promise<string> => {
  const saved = readClassificationSession();
  if (saved !== undefined) return saved;
  const created = await dsh.createSession();
  saveClassificationSession(created.sessionId);
  return created.sessionId;
};

/** 重建固定分类会话，用于旧会话失效时。 */
export const resetClassificationSession = async (): Promise<string> => {
  const created = await dsh.createSession();
  saveClassificationSession(created.sessionId);
  return created.sessionId;
};
