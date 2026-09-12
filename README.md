# Agent Chat Playground

可下载的 **本地 Agent 交付工作台**：Electron 选仓库、产研泳道带闸门、内核仍是 SSE / 工具 / Skill / RAG / 画布。

仓库：https://github.com/king-l6/agent-chat-playground  
安装包：https://github.com/king-l6/agent-chat-playground/releases/tag/v0.1.0  
无 API Key 也能用 mock。网页和桌面都在 `#/settings` 填自己的 Key。

**不是 Cursor，也不是 Dify。** 控制面是人点的确认 / 撤回 / 放行 / 签字，不是模型自己往下跳。

## 90 秒演示（面试用）

打开安装包（或 `npm run electron:dev`）→ 选本仓库 → `#/delivery`。不要先去画布里乱点。

| 秒 | 打开 | 做什么 | 面试官应看到 |
|----|------|--------|--------------|
| 0–15 | 安装包 / 桌面窗 | 选本仓库 | 工作区条出现仓库名，不是系统浏览器 |
| 15–35 | `#/delivery` 身份=产品 | 一句话「给 RAG 评测加一道题」→ 出产物 → 勾 1 条验收 → 确认流转 | 没勾确认被拒；确认后正文变灰 |
| 35–55 | 身份=研发 | 出产物 → 开发完成 | 只改 `server/src/eval-cases.ts`；改不了 `agent.ts` |
| 55–75 | 身份=测试 | 出评审（带路径）→ 放行 → 出测试报告 → 签字 | 意见能点到文件；报告里有 `eval:rag` 退出码 |
| 75–90 | 指闸门 | 说「撤回才会解冻，带风险放行必须写理由」 | 进度条不会自己往前跳 |

内核还在：`#/` 问「现在几点了？」看工具卡片；`#/canvas` 对照「人画的流程」。`npm run eval:rag` 原 8 题不能坏。

## 三套机制（口述核心）

```
对话 Agent     模型看工具列表，自己选要不要 search_notes / calculator
Skill          磁盘上的 SKILL.md；目录始终可见，正文靠 load_skill 才进上下文
编排 DAG       人画了就能走到的节点，按拓扑序全跑
编排分流       人写死 if（问题里有没有算式）；分流节点编译掉，不发给后端
```

Skill 是说明书，不是函数。`calculator` / `search_notes` 才会改状态或取数据。  
RAG 是能力（切块 / 向量 / 关键词 / 重排 / 引用），可以挂在 Agent 的工具上，也可以挂在画布的「检索」节点上。不是第三种「智能」。

## 功能对照

| 页 | 地址 | 实际做了什么 |
|----|------|----------------|
| 对话 | `#/` | SSE；工具卡片；`load_skill` 读 `server/skills/*/SKILL.md`；可停止 |
| 文档 | `#/documents` | 上传 md/txt，增量进索引 |
| 向量库 | `#/vectors` | 看 chunk、向量是否已编码 |
| 编排 | `#/canvas` | 沿边执行；计算器节点；DAG；条件分流；图存 localStorage（不存运行结果） |
| 交付 | `#/delivery` | 单人切 pm/dev/qa；确认才冻结；研发白名单写文件；评审带路径；测试只证明已勾验收 |
| 配置 | `#/settings` | MOCK / LIVE；填自己的 API Key，网页和桌面同一页 |

检索链路（`search_notes` / 画布检索节点同一套）：切块 280/重叠 60 → 本地 BGE-small-zh → 向量+关键词 RRF → ngram 重排 → 命中块左右邻接拼给模型。

## 怎么跑

```bash
cp .env.example .env   # 不填 Key 则 mock
npm install
npm run dev
```

- 前端 http://127.0.0.1:5176
- 后端 http://127.0.0.1:8790
- 桌面壳：`npm run electron:dev`（本应用窗口，不是系统浏览器）。网页模式仍是 `npm run dev`。  
  若 `electron` 命令没有二进制：`npm run electron:download`。不要和已经占用 5176 的 `npm run dev` 叠开两份 Vite。  
  打开后菜单「文件 → 打开工作区」选本仓库，再问「读一下 README.md」或「当前改了什么？」。路径逃出根目录会被拒绝；git 工具只读，不会 checkout。

Live：打开 `#/settings` 填自己的 API Key / Base URL / 模型，或切回 MOCK。网页和桌面同一页。也可以继续用 `.env` 的 `ANTHROPIC_*` / `OPENAI_*`。Embedding 走本地模型，不要把 chat 接口当成 `/embeddings`。

安装包（别人不用装 Node）：

```bash
npm run dist
```

产物在 `release/`：macOS arm64 的 zip / dmg。未签名，从网上下下来会被系统标成「已损坏」，右键打开不够，拖进「应用程序」后在终端执行：

```bash
xattr -cr "/Applications/Agent Chat Playground.app"
```

再双击即可。打包装载自带后端，先关掉本机已经占用 8790 的 `npm run dev`。  
下载：https://github.com/king-l6/agent-chat-playground/releases/tag/v0.2.0

## 简历可写（须能演示）

- 用 Electron 做出可安装的本地 Agent 工作台：选仓库后受限读写文件，并读取 git status / diff
- 按产研泳道流转：产品把一句话打成带验收标准的需求文档，多轮改完确认后才到研发；评审对照 diff，测试只证明已确认的验收
- 对着本仓库跑通一条竖切（给 RAG 评测加题），评审能指出具体文件风险，测试报告含自动命令结果与人工步骤
- 内核复用 SSE 流式、tool calling、Skill、本地 RAG（Recall@3 75%→100%）与编排画布

## 有意没做（问到要承认）

- 不是 Cursor / 通用 IDE，实现只能改白名单文件
- 不是多租户、无登录；单人切 pm / dev / qa
- 没有 Windows 安装包；macOS 包未签名
- 确认后不能悄悄改文档；撤回不会自动 git checkout
- 无理由不能跳过评审或测试
- 不是分布式向量库；画布分流是正则；图画在 localStorage

## 目录

```
src/                  React：对话 / 文档 / 向量 / 画布
  api/chat.ts         SSE 客户端 + workflow POST
  pipelineFromGraph.ts  DAG 拓扑序 + 分流编译
  canvasStore.ts      只存拓扑，不存上一轮输出
electron/             桌面壳：主进程加载 Vite；文件菜单打开工作区；网页 dev 不走这里
server/src/
  index.ts            Express：SSE / 知识库 / 跑图
  agent.ts            Agent 循环
  skills.ts           扫描 SKILL.md，供 load_skill 读取
  retrieve.ts         hybrid + rerank + 邻接扩展
  workflow.ts         画布执行器（search / calc / answer）
  eval.ts             黄金集 Recall@K
server/skills/        已安装 Skill（如 job-interview）
```
