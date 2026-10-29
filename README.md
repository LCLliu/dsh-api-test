# dsh API Test

用网页驱动 dsh（DeepSeek Harness）的 HTTP/RPC 接口，用来验证接口行为而不是靠手敲 curl。

- 后端 `src/server.ts`：Express 5 的 BFF。启动时用 `.env` 里的 `DSH_TOKEN` 换一次登录 cookie（cookie 绑定 authority，换到就缓存复用，失败自动重换），再带 `rpcId` 转发 `api/<method>` 请求。token 只留在服务端，浏览器拿不到。
- 前端 `web/src`：Vite + React 19。创建/续聊会话、`/` 命令补全、审批与提问卡片、按 cwd 分组的历史会话抽屉。
- 类型 `shared/dsh-type.ts`：前后端共用的 dsh 报文结构。

| 地址 | 作用 |
| --- | --- |
| http://localhost:5173 | 开发时打开这个（Vite 把接口代理到 3000，无需配跨域） |
| http://localhost:3000 | Express 后端 |

## 环境要求

- Node.js 18 及以上（当前使用 v24.18.0）
- npm

## 安装依赖

```bash
npm install
```

## 连接 dsh（环境变量）

后端启动时自动读取项目根目录的 `.env`（已在 `.gitignore` 中忽略，不要提交 token）：

```dotenv
DSH_URL=http://127.0.0.1:3081
DSH_TOKEN=<dsh web 启动时打印的 token>
```

- 本机 dsh 跑在 Docker 容器里时，容器内 3080 只监听 localhost，需通过 socat 转发到已发布到宿主机的 3081
- 修改 `.env` 后必须重启后端（`tsx watch` 重载代码不会重读环境变量）
- 容器重启后 socat 需要重新运行；dsh 重启后 token 可能变化，需同步更新 `.env`

## 开发模式（推荐）

```bash
npm run dev
```

会同时启动：

- 后端：http://localhost:3000（tsx watch，改后端自动重启）
- 前端：http://localhost:5173（Vite，改 React 代码自动热更新）

**开发时请打开 http://localhost:5173**，接口请求由 Vite 代理到 3000，无需手动配跨域。

也可以开两个终端分别启动：

```bash
npm run server   # 终端 1：后端 http://localhost:3000
npm run web      # 终端 2：前端 http://localhost:5173
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时启动前后端开发服务 |
| `npm run web` | 只启动 Vite 前端 |
| `npm run server` | 只启动 Express 后端 |
| `npm run build` | 构建前端到 `dist/web`、编译后端到 `dist/src` |
| `npm start` | 以生产模式运行 `dist/src/server.js` |
