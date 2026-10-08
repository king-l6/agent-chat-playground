/**
 * ⚠️ 已弃用（Next.js Pages Router 残留，不要再 import 这个文件）。
 *
 * 清空前的原文是 Next.js API route 的写法：`export const config = { api: { bodyParser: false } }`、
 * `export const runtime = 'nodejs'`，以及一行
 * `import { handleBeautyRequest, sendJson, type HttpRequestLike, type HttpResponseLike }
 *  from '../../../server/http'`。
 *
 * 两个硬伤：
 *  1. 从 `src/server/` 往上三级已经出了仓库根，模块解析必然失败；
 *  2. 退一步说，就算它指向 `server/src/http.ts` —— 那个文件并不存在
 *     （`server/src/` 下只有 agent/codeTeam/delivery/…，没有 http.ts），
 *     全仓也没有任何地方导出过 `handleBeautyRequest`。
 *
 * 本项目是 Vite + hash 路由（index.html → src/main.tsx），没有 Next 运行时，
 * 也没有 runner 会加载这个文件。但 `tsconfig.app.json` 的 include 是 ["src"]，
 * 于是 `npm run typecheck` / `npm run build` 会被它带崩（找不到模块）。
 *
 * 本轮处理：内容清空成存根（`export {}` 保证仍是模块），不再引用任何不存在的路径。
 * 同一批残留还有 `src/pages/index.tsx`、`src/pages/api/images/index.ts`。
 * 建议直接 `git rm` 掉 `src/pages/` 整个目录与本文件——它们在 Vite 侧没有任何入口。
 *
 * 「一键生成美女图片」的真实接口在 Express 侧，见 server/src/index.ts：
 * `GET /api/image/styles`、`POST|GET /api/image/generate`、`GET /api/image/render/:id`。
 */
export {}
