import 'dotenv/config';
import { createApp } from './app.js';
import { createApprovals } from './approvals.js';
import { DSH_URL, PORT, requirementsSource } from './config.js';
import { getCookie, resetCookie } from './dsh/client.js';
import { recoverStaleRunning } from './requirements-classifier.js';

const approvals = createApprovals({
  dshUrl: DSH_URL,
  getCookie,
  resetCookie,
});

const app = createApp(approvals);

approvals.start();

// 上一轮在跑的任务已经随进程没了，把假状态清掉，别让需求一直显示“进行中”
void recoverStaleRunning(requirementsSource()).then((count) => {
  if (count > 0) console.log(`[server] ${count} 条卡在 running 的需求已降级为 error，下次任务会重试`);
});

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  approvals.stop();
  server.close(() => process.exit(0));
});
