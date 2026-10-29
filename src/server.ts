import 'dotenv/config';
import { createApp } from './app.js';
import { createApprovals } from './approvals.js';
import { DSH_URL, PORT } from './config.js';
import { getCookie, resetCookie } from './dsh/client.js';

const approvals = createApprovals({
  dshUrl: DSH_URL,
  getCookie,
  resetCookie,
});

const app = createApp(approvals);

approvals.start();

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  approvals.stop();
  server.close(() => process.exit(0));
});
