# Agent Chat Playground

可演示的 **AI Agent 前端**：SSE 对话、Tool Calling 卡片、已连接 Skill、本地 RAG、编排画布。

仓库：https://github.com/king-l6/agent-chat-playground  
无 API Key 也能用 mock 跑通流式和工具卡片。

**不是 Dify。** 用来证明：流式协议、工具状态机、检索引用、画布执行器，都能自己落地，并说清和 Chatbot / Agent / 工作流的差别。

## 90 秒演示（面试用）

`npm run dev` 后按这个顺序，不要东点西点。

| 秒 | 打开 | 做什么 | 面试官应看到 |
|----|------|--------|--------------|
| 0–20 | http://127.0.0.1:5176/#/ | 「现在几点了？」 | 先出工具卡片，再出回答（不是纯 chatbot） |
| 20–40 | 同一页 | 「请按面试口径介绍这个项目」 | 先出紫色 Skill 卡片（`job-interview`），再出 `search_notes` 和带 `[1]` 的回答 |
| 40–55 | `#/vectors` | 扫一眼 | 有本地向量索引，不是「调了个搜索 API」 |
| 55–90 | `#/canvas` →「示例：按问题分流」 | 先跑 `123*456`，再跑「每天优先学什么」 | 同一张图，算式走计算器、问文档走检索 |

可选：终端再跑 `npm run eval:rag`，说「8 道黄金问题，向量 75% → hybrid 88% → rerank 100%」。

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

Live：填公司网关 `ANTHROPIC_*` 或任意 OpenAI 兼容 `OPENAI_*`。Embedding 走本地模型，不要把 chat 接口当成 `/embeddings`。

安装包（别人不用装 Node）：

```bash
npm run dist
```

产物在 `release/`：macOS arm64 的 zip / dmg。未签名，第一次打开用右键 → 打开。打包装载自带后端，先关掉本机已经占用 8790 的 `npm run dev`。  
挂到 GitHub：`git tag v0.1.0 && git push origin v0.1.0`，Actions 会上传到 https://github.com/king-l6/agent-chat-playground/releases

## 简历可写（须能演示）

- React + TS 实现 SSE 流式对话：边收边渲染、Abort 停止、工具卡片状态机
- Node 对接 OpenAI 兼容 API，多轮 tool calling 后再汇总回答；无 Key 时 mock 仍可演示
- Agent Skill 已连接：扫描 `server/skills/*/SKILL.md`，system 只放 name+description，正文经 `load_skill` 按需注入
- 本地 RAG：BGE 向量 + 关键词融合 + 重排；黄金集 8 题 Recall@3 从 75% 提到 100%；回答带引用
- 编排画布：拓扑序执行 DAG，条件边编译成 pipeline；图与一次运行结果分开存储

## 有意没做（问到要承认）

- 不是分布式向量库（pgvector / Pinecone）；索引在内存 + `server/data/index.json`
- 画布分流是正则，不是小模型路由；结果进共享黑板，不是沿边传变量
- 图画在浏览器 localStorage，不能跨设备协作
- 无登录、无多租户、无生产观测

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
