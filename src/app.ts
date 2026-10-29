import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { approvalsService } from './approvals.js';
import { createChatRouter } from './routes/chat.js';
import { createCommandsRouter } from './routes/commands.js';
import { createInteractionsRouter } from './routes/interactions.js';
import { createRequirementsRouter } from './routes/requirements.js';
import { createSessionsRouter } from './routes/sessions.js';

/** 组装 Express：中间件、各域路由、生产静态文件。 */
export const createApp = (approvals: approvalsService): Express => {
  const app = express();
  app.use(express.json());

  app.use('/api', createChatRouter());
  app.use('/api', createSessionsRouter());
  app.use('/api', createInteractionsRouter(approvals));
  app.use('/api', createCommandsRouter());
  app.use('/api', createRequirementsRouter());

  // npm scripts 都从项目根运行；开发模式下该目录通常不存在，直接跳过
  const webDir = path.resolve(process.cwd(), 'dist', 'web');
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
  }

  return app;
};
