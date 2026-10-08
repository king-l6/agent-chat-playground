/**
 * ⚠️ 已弃用（Next.js Pages Router 残留，不要再 import 这个文件）。
 *
 * 清空前的原文是一个 Next API route：`export const runtime = 'nodejs'` +
 * `export default async function handler(req: IncomingMessage, res: ServerResponse)`，
 * 并且 `import { handleBeautyRequest, sendJson, type HttpRequestLike,
 * type HttpResponseLike } from '../../../server/http'`。
 * 那条相对路径解析到 `src/server/http.ts`（存在，但导出的东西一个都没有，
 * 且它自己也 import 了仓库外的 `../../../server/http`）。
 *
 * 文件头注释还写着自己服务 `/api/beauty/*` —— 和实际后端路径也对不上：
 * Express 侧挂的是 `/api/image/styles`、`/api/image/generate`、
 * `/api/image/render/:id`（见 server/src/index.ts）。
 *
 * 本项目是 Vite + hash 路由，没有 Next 运行时，没有 runner 会加载它；
 * 但 `tsconfig.app.json` 的 include 是 ["src"]，留着会让
 * `npm run typecheck` / `npm run build` 报错。本轮清空成存根（`export {}`）。
 * 建议连同 `src/pages/` 整个目录、`src/server/http.ts` 一起 `git rm`。
 */
export {}
