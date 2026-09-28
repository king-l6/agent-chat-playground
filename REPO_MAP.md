# 仓库结构导读（Agent Chat Playground）

> **唯一官方导读**。代码团队摸底「仓库怎么组织」时优先读本文件；不要另写平行导读（如 `仓库组织导读.md`）。
> 定位：可下载的**本地 Agent 交付工作台**（Electron 桌面 + 网页双形态），不是 IDE、不是 Dify。
> 版本 0.2.0，ESM（`"type": "module"`），React 19 + Vite 前端，Express 5 后端，Electron 桌面壳。

## 一、根目录一览

```
.claude/ .env .env.example .github/ .gitignore .oxlintrc.json
README.md REPO_MAP.md 求职补充手册.md index.html sse-oral.html
package.json package-lock.json electron-builder.yml
tsconfig.json tsconfig.app.json tsconfig.server.json tsconfig.electron.json tsconfig.node.json
vite.config.ts
electron/   Electron 主进程 + preload.cjs（源码）
server/     Express 服务端（源码 + skills/ + scripts/）
src/        前端源码
public/     前端静态资源
dist/ dist-electron/ dist-server/ release/   构建产物，不要手改
```

`.github/workflows/` 里目前只有 `release.yml`：只在推 `v*` tag 时 `npm ci → npm run dist → 上传 zip/dmg`。**没有 PR / push 门禁**（改代码后没人自动跑 lint、类型检查、`eval:rag`）。

## 二、三运行时分层

一个仓库里跑三套运行时，改代码前先判断属于哪条线：

| 运行时 | 源码 | 入口 | 端口 / 产物 |
|---|---|---|---|
| Web 前端 | `src/`（React 19 + antd + xyflow + monaco） | `index.html` → `src/main.tsx` → `src/App.tsx` | dev `127.0.0.1:5176`，产物 `dist/` |
| Node 服务端 | `server/`（Express 5） | `server/src/index.ts` | `127.0.0.1:8790`，产物 `dist-server/` |
| Electron 桌面壳 | `electron/`（含 `preload.cjs`） | `package.json` 的 `main` = `dist-electron/main.js` | 加载 Vite，产物 `dist-electron/` |

配套脚本页：`public/`（静态资源）、`index.html`、`sse-oral.html`（SSE 口播演示页）。

## 三、前端 `src/`

- `App.tsx` — 路由/外壳。hash 路由共 **8** 页：
  - `#/` 对话（Chat）
  - `#/documents` 文档 / 知识库（`#/knowledge` 同页）
  - `#/memory` 长期记忆
  - `#/vectors` 向量库
  - `#/canvas` 编排画布（`#/workflow` 同页）
  - `#/delivery` 交付泳道
  - `#/video` 视频分镜
  - `#/settings` 配置（`#/config` 同页）
- **对话页是三列**（`App.tsx` 的 `.app__chat`，列定义在 `AppShell.css`）：
  `SessionList`（左，历史会话）｜ `.app__talk`（中，消息流 + 输入框）｜ `ChatOutline`（右，本轮会话的提问目录）。
  第三列是 `auto`：`ChatOutline` 提问不足 2 条时返回 `null`，该列宽度自动塌成 0，不需要条件类名。
  点目录项 → `scrollIntoView` 到 `MessageList` 里 `<article data-msg-id>` 那条；
  `data-msg-id` 是两边唯一的约定字符串，改名要同步 `ChatOutline.tsx` 与 `MessageList.tsx`。
- **输入框是「一个外框 + 框内两行」**（`AppShell.css` 的 `.composer`，grid 两行两列）：
  第一行 = `textarea`(`grid-area: ta`) + `.composer__actions`(`btns`，停止/发送)；
  第二行 `.composer-foot`(`foot foot`) = 左边**上下文用量环**（`.ctx`，SVG 印 `viewBox 0 0 24 24`）、右边 `WorkspaceBar`。
  所以白底/边框/圆角在 `.composer` 上，`textarea` 自己是透明的；宽度与居中也都由 `.composer`（`max-width: 860px; margin: 0 auto`）负责，
  `.composer-foot` 与 `.composer-wrap .wsbar` **不要再各算一次 margin**。
  `<form className="composer">` 里只有 `textarea` 和按钮（`WorkspaceBar` 内部只有 `div` 与 `type="button"`），不会形成嵌套表单。
  窄屏 640px 下 grid 改单列（`ta` / `btns` / `foot` 三行）。
- `api/` — 后端出口，按域拆 **5 个**，新增接口放进对应文件（新域再开一个）：
  - `api/chat.ts` — SSE 客户端 + workflow POST + 健康检查 + 知识库/wiki/工作区/设置/MCP。长 SSE 收尾的 Network Error 在这里吞掉（已 `done` 不当失败）。
    **接口层的类型就是前后端契约**：`fetchHealth()` / `LlmSettingsPublic` / `saveSettings()` 必须带 `contextWindow`（见 3.1），漏一个就会让 `App.tsx` 与 `SettingsPage.tsx` 报「属性不存在」。
  - `api/delivery.ts` — 交付泳道。
  - `api/memory.ts` — 长期记忆。
  - `api/video.ts` — 分镜 / 配音 / 成片。
  - `api/image.ts` — 「一键生成美女图片」接口层（`fetchBeautyStyles` / `generateBeautyImage`，见第六节）。
- `pipelineFromGraph.ts` — DAG 拓扑序 + 分流节点编译。
- `canvasStore.ts` — 只存画布拓扑（localStorage），**不存运行结果**。
- `sessionStore.ts` — 会话状态（localStorage，key `agentos.sessions.v1`）；`uid()` 同时是消息锚点来源。
  `ChatSession` 有**两个**时间字段，别混用：
  - `lastUserAt` = 最后一次**用户提问**时间，且只在 `App.tsx` 的 `onSend` 里推进；
  - `updatedAt` = 最后一次活动时间，`patchAssistant` 每个 SSE 事件都会刷它。
  **左侧列表的排序 / 今天-昨天分组 / 列表里的日期一律用 `lastUserAt`**；拿 `updatedAt` 当排序键会让多个同时生成的会话互相超车、列表上下反复换位。老数据没有 `lastUserAt`，`revive()` 回退到 `updatedAt`。
  `blankSession()` 同时写两个字段（都取 `Date.now()`），所以新建会话的排序键一定存在。
- `components/` 要点：
  - `MessageList.tsx` — 消息流；思考默认收起；每条 `<article>` 带 `data-msg-id` 供右侧目录跳转。
    代码团队在这里画两处角色 UI：气泡顶部**四格进度条**（`TeamStrip`，走 `TEAM_ROLES`）与正文里的**角色小条**（`roleLabel()`）。
    两处名单都必须覆盖后端四段，漏一个的表现分别是「跑完了但进度条没这一格」与「正文里掉出英文的 `summary · 完成`」（见 3.3）。
  - `SessionList.tsx` + `SessionList.css` — 左侧历史会话：搜索框（匹配标题与消息正文）+ 按「今天/昨天/近 7 天/更早」分组；排序、分组、`<time>` 显示三处**共用同一个 `sortKey(s)`**（见 3.2），点击 `onSelect` 切会话。
  - `ChatOutline.tsx` + `ChatOutline.css` — 右侧**提问目录**：列本轮每条用户提问，点击跳转，`IntersectionObserver` 高亮当前读到的那条；≤1180px 隐藏。
  - `ToolCard.tsx` — 工具卡；写入批准用 `CodeDiff` 并排 diff。
  - `CodeDiff.tsx` — Monaco DiffEditor / 统一 diff（交付页 + 批准卡共用）。
  - `WorkspaceBar.tsx` — 工作区条；`folderName()` 取末级目录名，完整路径在 `title` 与 `.wsbar__full` 里（框内并排时该 span 被 CSS 隐藏）。
  - `DeliveryPage.tsx` — 交付泳道时间线与文件变更。
  - `VideoPage.tsx` / `MemoryPage.tsx` / `DocumentsPage.tsx` / `VectorsPage.tsx` / `CanvasPage.tsx` / `SettingsPage.tsx` / `BibleDrawer.tsx` / `ChatImage.tsx` / `CitationMarkdown.tsx` / `AppSidebar.tsx`。
  - `ResultGallery.tsx` — 通用结果画廊（props：`images` / `loading` / `downloadPrefix` / `style`，只依赖 react 类型）。
    它原来误装着一份「美女图」页面实现（含 `BeautyGenerator`，import 了两个不存在的 `../lib/styles`、`../lib/imageStore`，还自己 import 自己），会让 `tsconfig.app.json`（include `["src"]`）下的 `npm run typecheck` / `npm run build` 直接报「找不到模块」。
    那份重复实现已就地清掉，本文件改成自洽的展示组件；**目前没有调用方**（`BeautyImagePage.tsx` 自己渲染结果网格），要用就把那段网格替换成 `<ResultGallery images={images} loading={loading} />`。
  - `SettingsPage.tsx` — 保存后回调 `onSaved({ mode, model, contextWindow })`。**`contextWindow` 必须一起回调**：对话页用量环拿它当分母（见 3.1）。
    窗口输入框用 `windowTouched` 区分「用户没碰」与「用户清空」：没碰就不带这个字段（＝不动），清空才传 `0`（＝清掉面板值、回落环境变量）。
- `BeautyImagePage.tsx` — 「一键生成美女图片」页面。**尚未接入 `App.tsx` 路由**（`App.tsx` 的 import 列表与 `pageFromHash()` 里都没有它）：要么在 `App.tsx` 加一个 `#/beauty` 分支 + 侧栏入口，要么整块删掉，别继续留在两者之间。
- **Next.js Pages Router 残留（已清空，建议 `git rm`）**：`src/pages/index.tsx`、`src/pages/api/images/index.ts`、`src/server/http.ts`。
  这批文件清空前都在 import 解析不到的东西——`src/pages/api/images/index.ts` 与 `src/server/http.ts` 都写着 `from '../../../server/http'`（往上三级已出仓库根；即便当作 `server/src/http.ts`，该文件也不存在，全仓无人导出 `handleBeautyRequest`），`ResultGallery.tsx` 见上。
  本项目没有 Next 运行时（`index.html` 只加载 `src/main.tsx`），没有 runner 会加载它们，但 `tsconfig.app.json` 的 `include` 是 `["src"]`，**这些残留就是类型检查/构建的硬失败点**，已清成只剩 `export {}` 的存根。
  `src/pages/index.tsx` 本身自洽（只 import react 的 type），未改动；它作为「应用外壳」和 `src/App.tsx` 是两套，删之前先确认没人当文档看。
- 另有 `lib/` `types.ts` `index.css` `assets/` `desktop.d.ts`（Electron 注入的类型声明）。
- `lib/contextUsage.ts` — **只服务用量环**（口径见 3.1）：`estimateOutgoingTokens` 是当前分子用的函数，`estimateMessagesTokens` 是旧的高估口径（别再用），`contextWarnOf` 是预警判定，`contextRatioOf` 只负责画环。

### 3.1 上下文用量环的口径（改这里之前必读）

气泡下方那个「x k / y k」环由 `src/lib/contextUsage.ts` + `src/App.tsx` 算，一条硬规矩：**分子必须与 `onSend` 真正发出去的 history 同集合**。

- 分子 = `estimateOutgoingTokens(toApiMessages(messages.filter(m => m.status !== 'streaming')))`。三个动作分别对应后端事实：
  1. `toApiMessages` 只留 `role` + `content` —— `server/src/agent.ts` 的 `runLive` 每轮用「system + 这份 history」重建 `ChatMessageInput`，工具结果（`role: tool`）只在本轮 `maxRounds` 循环里存在，**跨轮不保留**。所以工具卡片的 `arguments` / `result` 不能算进分子（算了就是虚高，前端看得见、后端收不到）。
  2. 排除 `status === 'streaming'` —— 与 `onSend` 里的 `prior` 同一个过滤条件，两处要一起改。
  3. `OUTGOING_CONTENT_LIMIT = 8000` —— 必须等于 `server/src/index.ts` 的 `/api/chat` 里 `content.slice(0, 8000)`。
- 分母 = `/api/health` 的 `contextWindow`（`server/src/settings.ts` 的 `resolveContextWindow`：llm.json → 环境变量 → 32k）。**更新时机只有两处**：App 挂载时的 `fetchHealth`（依赖 `[]`，App 是根组件、切 hash 不重新挂载）与配置页保存后的 `onSaved` 回调。少了后者就会出现「改了上下文窗口回对话页，分母还是旧值，只有刷新整页才对」。那个 32k **不对应任何具体模型**（后端注释也这么说），配置页留空就是它。
- **别按模型名做「窗口大小映射表」**：配置页的 model 是自由文本（占位 `deepseek-v4-flash`），拿它查表只会查出假数。要更准就填配置页的输入框，或在 `.env` 里给 `CONTEXT_WINDOW_TOKENS`。
- 即便如此它仍是**下限**：后端每轮还会带 `buildSystemPrompt()`（规则 1–10 全文 + skill 目录 + 工作区块〔根目录清单 + README 摘录 `README_EXCERPT_LIMIT = 2000`〕+ MCP 块 [`MCP_NOTES_LIMIT = 600`] + 记忆块）、`getToolDefinitions()` 的 10 个 function schema、以及 `preloadMatchedSkills` 注入的 skill 正文。前端拿不到这些量，所以环上标的是「下限」，别改成「估算」「实际占用」之类的词。
- 想做成「真实占用」只能在服务端算（例如加一个把 system prompt + tools schema 都估算进去的接口）。纯前端无论怎么调参都对齐不了。
- **预警线（环变黄 + 「接近上限，建议开新会话」）与环的角度分开算**，这是两个量：
  - 环的角度走 `contextRatioOf(used, window)` = 已用 ÷ **整个窗口**（收在 [0,1]，防 dashoffset 变负把环画反）；
  - 是否告警走 `contextWarnOf(used, window)`，基准是 `window − CONTEXT_RESERVE_TOKENS`（12k = 8k 单轮输出 + 4k 工具轮，两项都是量级估计，见该常量注释）。
  - 旧的 `CONTEXT_WARN_RATIO = 0.8` 已标 `@deprecated`，**不要再引用**：上下文窗口是输入和输出共用的，固定比例给不出「留多少余量」——8k 窗口下 80% 只留 1.6k、200k 窗口下留 40k，差 25 倍，回答不了「为什么现在该开新会话」。`window ≤ 预留` 时预算为 0，只要用过就告警。
- 环的几何分两处、必须一致：`App.tsx` 的 `RING_RADIUS = 9` / `RING_CIRCUMFERENCE`，`AppShell.css` 的 `.ctx__ring` 尺寸与 stroke 宽度（`viewBox 0 0 24 24`、圆心 12,12）。用 SVG 而不是 `conic-gradient`：20px 这个尺寸下 conic 边缘锯齿明显。
- `lib/contextUsage.ts` 里保留着旧口径 `estimateMessagesTokens`（正文 + 工具参数/返回）。它**高估**，新代码不要再用；要统计工具调用量请另开函数并改名，别悄悄复用它。

### 3.2 会话列表的排序键（已落地为 `lastUserAt`）

**结论：排序 / 分组 / 显示日期三个动作只认 `ChatSession.lastUserAt`，而它只有用户提问才推进。**

落地位置（三处，改动要一起看）：

1. **唯一写入点** —— `App.tsx` 的 `onSend`：追加 user 消息那一步同时写 `lastUserAt: Date.now()` 与 `updatedAt: Date.now()`。
   `patchAssistant`（每个 SSE 事件：`text_delta` / `reasoning_delta` / `tool_*` / `step` / `done` …）**只刷 `updatedAt`**，函数头有注释写明不许碰 `lastUserAt`。
   这样排序/分组键在「提问那一刻」就冻结了，之后吐多少 token 都不会让这个会话在列表里挪位、更不会换组。
2. **读取点收敛** —— `SessionList.tsx` 里定义 `sortKey(s)`：`lastUserAt` 不是有限数就回退 `updatedAt`。`sort` 的比较函数、`bucketOf(sortKey(s))` 的分组、右侧 `<time>{day(sortKey(session))}` 三条路径都走它，避免「排在这组但显示的是那天」这种自相矛盾。
3. **旧数据兜底** —— `sessionStore.ts` 的 `revive()` 对没有 `lastUserAt` 的历史记录回退到 `updatedAt`；`blankSession()` 两个字段都给初值。

**反例（曾经踩过）**：早期实现三处都读 `updatedAt`，而 `patchAssistant` 每个 token 都刷它——多个会话同时生成时谁刚吐字谁就窜到最前，列表上下反复换位。修复只需把读取点换成 `lastUserAt` + 在 `onSend` 写入，不需要动 `busyIds`（「生成中」标记与排序互不相干）。

所以：**要按什么排序，就只在那个事件上推进对应的字段**。新增排序维度时别顺手拿 `updatedAt` 顶替，也别在 `patchAssistant` 里推进 `lastUserAt`。

### 3.3 代码团队的「四段」与前端名单（改角色前必读）

`server/src/codeTeam.ts` 的 `stages` 是**固定四段**，写死的：

```
explore（探索，只读） → implement（改码，唯一能写） → review（评审，只读） → summary（总结，无工具）
```

两个容易踩的点：

- **summary 不是可选项，也不是靠用户那句话触发的**。它是第四段固定跑：`SUMMARY_TOOLS: string[] = []`（一个工具都不给），`maxToolRounds('summary')` 返回 1 只是让它进一次纯文本轮；它的素材是前三段拼进 transcript 的 `【explore】【implement】【review】` 结论。mock（`runMock`）也走这一段，否则「没配 Key 时改完没总结」照样复现。
  想改「改完没有总结」，先看后端有没有跑 summary，再看前端名单有没有跟上——**别再往提示词里加一句「记得总结」**。
- **前端有两份平行的名称名单，必须与四段同步**（都在 `src/components/MessageList.tsx`）：
  - `TEAM_ROLES`（气泡顶部四格进度条 `TeamStrip` 的数据源）；
  - `roleLabel()`（进度格与正文角色小条的**中文名**；缺分支会直接返回英文 role 串）。
  配套 CSS 在 `MessageList.css`：`.msg__role-bar--explore / --implement / --review / --summary`，漏一个只是撞色、不报错（原样就是 `--review` 的绿，summary 会看不出是第四段）。
  `src/types.ts` 与 `server/src/types.ts` 的 `AgentRole` 都已包含 `'summary'`，所以**类型层不报错，只有肉眼能看出来**——这正是它漏了一轮的原因。

### 3.4 「要不要查知识库」的意图识别（在 `codeTeam.ts` 里，纯正则）

代码团队**没有模型级意图识别**：走不走 code_team 由对话页那个「代码团队」勾选框决定（`App.tsx` 的 `codeTeam` → `mode: 'code_team'`），后端 `index.ts` 只认这个字段（`req.body?.mode === 'code_team' ? 'code_team' : 'default'`）。

链路内部唯一沾「意图」的是**工具白名单**，而且是启发式不是模型判断：

- `WORKSPACE_READ_TOOLS = ['workspace_list', 'workspace_read', 'git_status', 'git_diff']`（三段共用的只读底座）；
- `IMPLEMENT_TOOLS = [...WORKSPACE_READ_TOOLS, 'workspace_write']`；
- `exploreToolsFor(userTask)`：只有 `KNOWLEDGE_HINT` 正则命中（知识库 / 文档 / 手册 / wiki / 周报 / 月报 / 纪要 / 简历 / 面经 / 学习路线 / 怎么学）时，才给 explore 追加 `search_notes`。
  这就是「改代码时别去查文档」的落地点：**改码链路默认没有 `search_notes`**，改哪几个文件就读那几个文件。

有意设计，别顺手「优化」成模型判意图：要分开的只是「读工作区」和「读知识库」两组工具，正则够用；多一次模型往返只会让演示现场不可复现（对齐 `agent.ts` 规则 3/9：知识库 ≠ 已连接的代码库）。

## 四、后端 `server/`

- `server/src/index.ts` — Express 入口：SSE / 知识库 / 跑图 / 视频 / 记忆 / 批准写入。**单文件已相当长**，里面混了三类东西：
  1. 路由定义（chat/delivery/video/memory/knowledge/wiki/workspace/image）；
  2. 业务逻辑（「一键生成美女图片」整块：`BEAUTY_*` 常量、`checkBeautyPrompt`、`buildBeautySvg`、`createBeautyRecord`、`withBeautyTimeout`，以及 `parseExpires` / `memoryTypeOf` / `parseContextWindow` 等小工具）；
  3. 启动流程（`startServer()`）。
  想拆的话，先把「美女图」整块搬到独立模块，再把路由按域拆 `routes/*.ts`。
- `/api/health` 返回 `{ ok, mode, model, contextWindow, rag, skills, mcp, workspace }`。`contextWindow` 就是用量环的分母，**只在这里和 `/api/settings` 给**（都走 `settings.resolveContextWindow()`，不在路由里重复判断）。
- 「一键生成美女图片」现存接口：`GET /api/image/styles`、`POST|GET /api/image/generate`（也挂 `/api/images/generate`）、`GET /api/image/render/:id`。注意两点：①它和视频分镜的图片缓存是**两套**东西，缓存接口 `GET /api/image/cache/:id` 走的是 `imageCache.ts`，别混；②`index.ts` 末尾有一段自欺代码——把 `BEAUTY_RENDER_CACHE`（一个 `Map`）强转成 `{ registerRoutes? }` 再调用 `registerRoutes?.(app)`，注释还指向不存在的 `server/src/image.ts`，永远走不到，属于可删死代码。GET 触发有副作用生成、缓存只按 TTL 清理无容量上限，也建议一并收拾。
- `agent.ts` — 默认 Chat Agent 循环（模型看工具列表自行选择调用）。`runLive` 里有两件与「上下文」相关、但**不是**上下文裁剪的事：`maxRounds`（有 MCP 时 6，否则 4）与 `codeTeam.ts` 的 `maxToolRounds` 都是**工具调用轮次**上限。目前没有「按上下文裁剪 history」的策略。
- `codeTeam.ts` — Chat「代码团队」：固定 explore → implement → review → summary（见 3.3）；工具白名单按意图给（见 3.4）；`workspace_write` 需用户批准；挂起写入可落盘，热重载后仍可批准（`/api/chat/approve` 的 orphan 路径）；批准不设超时。
- `settings.ts` — LLM 面板配置（`llm.json`）：mode / apiKey / baseURL / model / **contextWindow**。`DEFAULT_CONTEXT_WINDOW = 32_000`、`MIN/MAX_CONTEXT_WINDOW`、`resolveContextWindow()` 是唯一的优先级实现（面板 → 环境变量 → 兜底）。`publicLlmSettings()` 只回 `hasKey`，**不回显 Key**。
- `skills.ts` + `server/skills/*/SKILL.md` — Skill 是磁盘上的说明书，目录常驻可见（`skillsCatalogText()` 进 system prompt 规则 8），正文靠 `load_skill` 才进上下文。
- `retrieve.ts` — hybrid 检索：切块 280 / 重叠 60 → 本地 BGE-small-zh → 向量 + 关键词 RRF → ngram 重排 → 邻接扩展。
- `workflow.ts` — 画布执行器（search / calc / answer）。
- `eval.ts` — 黄金集 Recall@K 评测（`npm run eval:rag`，原 8 题不许坏）。
- `delivery/` — 交付泳道（PM / Dev / Review / QA）；`implement.ts` 写补丁。
- `video/` — 分镜 / 静帧 / TTS 等。
- `memory/` — 长期记忆召回（`memoryBlockFor()` 的结果作为「记忆规则」注入 system prompt）。
- `server/scripts/` — 运维脚本，全部走 tsx 直跑 TS：`resync-index.ts`、`wiki-ingest.ts`、`wework-crawler.ts`。
- `mcp.ts` — HTTP MCP 客户端：`tools/list` → function calling。

## 五、构建产物（**不要手改**）

`dist/`（前端）、`dist-electron/`（桌面）、`dist-server/`（后端）、`release/`（electron-builder 输出的 macOS zip/dmg）。

## 六、五份 tsconfig 即「路线图」

`tsconfig.app.json`(前端) / `tsconfig.server.json`(服务端) / `tsconfig.electron.json`(桌面) / `tsconfig.node.json`(vite 配置) / `tsconfig.json`(根引用)。改动落在哪条线，先对齐对应 tsconfig。

注意：根 `tsconfig.json` 的 `references` **只挂了 app + node**，所以 `npm run build`（`tsc -b && vite build`）**不检查** `server/` 和 `electron/`——这两条线以前只在 `electron:compile` / `pack:app` 才编译，类型错误会拖到打包才炸。现在补了 `npm run typecheck` 覆盖四条线：

```
tsc -p tsconfig.app.json && tsc -p tsconfig.node.json
  && tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.electron.json --noEmit
```

改代码后至少跑一次 `npm run typecheck`；想把门禁固化，就往 `.github/workflows/` 加一条 PR job（当前不存在）。

## 七、脚本清单（`package.json` scripts，改动落点）

```
dev            并行起 dev:server(tsx watch server/src/index.ts) + dev:web(vite:5176)
dev:web        vite
dev:server     tsx watch server/src/index.ts
electron:compile   tsc -p tsconfig.electron.json && cp electron/preload.cjs dist-electron/preload.cjs
electron:download  经 npmmirror 镜像装 Electron 二进制
electron:dev   server + web + wait-on http://localhost:5176 → electron:compile → electron .
pack:app       electron:compile → tsc -p tsconfig.server.json → ELECTRON_BUILD=1 VITE_API_BASE=... vite build
dist           pack:app → CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac --publish never
build          tsc -b && vite build
preview        vite preview
eval:rag       tsx server/src/eval.ts（RAG 黄金集评测）
index:sync     tsx server/scripts/resync-index.ts
wiki:ingest    tsx server/scripts/wiki-ingest.ts
crawl:wework   tsx server/scripts/wework-crawler.ts
lint           oxlint（**不是 eslint**，勿按 eslint 规则改）
typecheck      四条 tsconfig 线全量类型检查（见第六节）
```

仓库里**没有测试目录 / `test` 脚本**（`playwright` 在 devDependencies 里但看不到用例）。

## 八、依赖地图（`package.json` 实况）

- 前端 UI：`react` / `react-dom` 19、`antd` 6 + `@ant-design/icons`、`@xyflow/react`(画布)、`@monaco-editor/react` + `monaco-editor`、`react-markdown` + `remark-gfm`。
- 服务端：`express` 5、`cors`、`multer`(上传)、`zod`(校验)、`dotenv`、`axios`。
- 模型与检索：`openai`(兼容多家的 chat 接口)、`@huggingface/transformers`(本地 BGE embedding)、`@modelcontextprotocol/client`(MCP)。
- 构建/开发：`vite` 8 + `@vitejs/plugin-react`、`typescript` ~6.0、`tsx`、`concurrently`、`wait-on`、`electron` 44 + `electron-builder` 26、`oxlint`、`turndown`(+`@types/turndown`)、`playwright`。

## 九、配置与硬编码

- 配置：`.env` / `.env.example`（`ANTHROPIC_*` / `OPENAI_*` / `CONTEXT_WINDOW_TOKENS`；不填 Key 走 MOCK）。Embedding 用本地模型，别把 chat 接口当 `/embeddings`。
- **端口 5176 / 8790 散落在至少 5 处**，改端口要同步：`package.json` 的 scripts、`vite.config.ts`（`port: 5176` + `/api` → 8790 代理，长 SSE 用 `timeout: 0`）、`electron/main.ts`（`PORT = Number(process.env.PORT || 8790)` 与 `/api/health` 探测）、`electron/workspace.ts`（`fetch('http://127.0.0.1:8790/api/workspace')` 写死）、`.env` 的 `VITE_API_BASE`。
- `vite.config.ts` 的 `base` 由 `ELECTRON_BUILD=1` 切换为 `./`；打包时 `VITE_API_BASE=http://127.0.0.1:8790`。
- 公司 LLM 网关（MaaS）不支持 `tool_choice: "required"`，代码团队用提示词催工具，不要再传该字段。
- 后端无鉴权，且 CORS 是 `origin: true`（放行任意来源），服务只绑 `127.0.0.1`——浏览器里任意页面都能打到本机 8790 上的写接口（切工作区根、改 API Key、改 MCP Cookie、读写文件）。收紧 CORS 白名单 + 启动时注入一次性 token 是明确的待办，不要在没加固的前提下把端口暴露出去。

## 十、改动注意事项

1. 先分清「源码 vs 产物」，别编辑 `dist*/`、`release/`。
2. UI 改动先确认形态：网页（`src/`）与桌面（`electron/`）共用前端，桌面另走主进程。
3. 安全边界：写文件锁在已选工作区，禁止碰 `.git` / `.env` / `node_modules`；路径逃出根目录被拒绝；git 工具只读，不 checkout。
4. 业务约束（属有意设计，勿「顺手优化」）：确认后才冻结 PRD、撤回不自动 git checkout、无理由不能跳过评审/测试、画布分流是正则、图画在 localStorage。
5. 交付泳道（`#/delivery`）不调 MCP。
6. 只出 macOS 包且未签名（`--mac` 写死），跨平台分发受限。
7. 代码团队结论只能基于本轮 tool 返回；缺证据写「未核实」，禁止另造平行导读文件。
8. 「一键生成美女图片」（`index.ts` 的 `BEAUTY_*` 块 + `src/api/image.ts` + `src/components/BeautyImagePage.tsx`）与工作台主线无关，当前是半接状态（页面没挂路由）。动它之前先定去留，别顺手改一半；同名的重复实现（`BeautyGenerator`）已从 `ResultGallery.tsx` 清掉，别再往回加。
9. 对话页三列布局的两个约定：①`MessageList` 的 `<article data-msg-id>` 必须保留（`ChatOutline` 靠它做跳转锚点，`ChatOutline.css` 里 `scroll-margin-top` 也挂在 `[data-msg-id]` 上）；②`App.tsx` 的 `mainRef` 既是消息滚动容器又是 `IntersectionObserver` 的 root，换成别的滚动容器要同步三处（`onMainScroll`、`ChatOutline` 的 `containerRef`、`scrollIntoView`）。
10. **上下文用量环的三个联动点**（详见 3.1）：`App.tsx` 里分子用的过滤条件要与 `onSend` 的 `prior` 一致；`OUTGOING_CONTENT_LIMIT` 要与后端 `/api/chat` 的 `slice(0, 8000)` 一致；分母要在配置页 `onSaved` 里刷新，否则改了窗口要刷新整页才生效。三处任一漂移，环上的数字就和模型看到的不是一回事。另外**预警线与环的角度是两个量**：角度用 `contextRatioOf`（÷ 整个窗口），告警用 `contextWarnOf`（对比 `window − CONTEXT_RESERVE_TOKENS`）；别再引入固定百分比阈值（`CONTEXT_WARN_RATIO` 已废弃）。
11. **会话列表的排序键**（详见 3.2）：`SessionList` 只经 `sortKey()` 取键（`lastUserAt`，缺失回退 `updatedAt`）；`lastUserAt` 只在 `onSend` 里推进；`patchAssistant` 里的 `updatedAt` 是活动时间，不要拿来排序。
12. **代码团队的角色名单有四处副本**（详见 3.3）：后端 `codeTeam.ts` 的 `stages`、两侧 `types.ts` 的 `AgentRole`、前端 `MessageList.tsx` 的 `TEAM_ROLES` 与 `roleLabel()`、以及 `MessageList.css` 的 `.msg__role-bar--*`。加/删角色要一起动；只动后端的话类型层不报错，只有肉眼能看出「进度条少一格 / 正文是英文」。
13. **`contextWindow` 的四处传递链**（详见 3.1）：`server/src/settings.ts`（`resolveContextWindow` / `publicLlmSettings` / `saveLlmSettings`）→ `server/src/index.ts`（`/api/health`、`PUT /api/settings` 的 `parseContextWindow`）→ `src/api/chat.ts`（`fetchHealth` 返回类型、`LlmSettingsPublic`、`saveSettings` 参数）→ `src/App.tsx` / `SettingsPage.tsx`。**接口层那一环最容易漏**：后端加了字段、前端页面已经在用，但 `api/chat.ts` 的类型没跟，`tsc` 会报一串「属性不存在」。加字段时四处一起看。
14. 提交前看一眼 `git status`：`src/lib/contextUsage.ts` 目前**未被跟踪**（`??`），而 `src/App.tsx` 已经 import 它——只提交已暂存内容会得到一个「引用了不存在模块」的提交。同一批暂存里还混着上面说的 Next 残留（`A src/pages/**`、`A src/server/http.ts`）。

## 十一、进一步阅读顺序

`README.md`（官方说明，含 90 秒演示脚本）→ `REPO_MAP.md`（本文件）→ `求职补充手册.md` → `vite.config.ts` → `server/src/index.ts` → `src/App.tsx` 路由 → 按需进 `src/components/`、`server/src/*.ts`。
