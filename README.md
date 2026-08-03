# Agent Chat Playground

可演示的 **AI Agent 前端作品**：SSE 流式对话 + Tool Calling 卡片 + 简易知识库检索。

适合简历「个人项目」：无 API Key 也能用 mock 模式跑通全流程。

## 功能

- 流式 Chat（`text/event-stream`）
- Tool Calling 可视化卡片：`get_current_time` / `calculator` / `search_notes`
- 前端状态：streaming / tool_running / done / 停止生成
- Live 模式：配置公司网关 `ANTHROPIC_*` 或任意 OpenAI 兼容 Key
- Mock 模式：未配置 Key 时本地模拟流式与工具调用

## 快速开始

```bash
cd agent-chat-playground
cp .env.example .env   # 可选：填入 ANTHROPIC_API_KEY（或 OPENAI_API_KEY）
npm install
npm run dev
```

- 前端：http://127.0.0.1:5176
- 后端：http://127.0.0.1:8790

试着问：

- 现在几点了？
- 帮我算 123*456
- 这个项目的技术栈是什么？

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | 公司网关 Key；有则 live |
| `ANTHROPIC_BASE_URL` | 默认映射为 `{BASE}/v1`（OpenAI 兼容） |
| `ANTHROPIC_DEFAULT_*_MODEL` | 默认模型，如 `deepseek-v4-flash` |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | 可覆盖上面 |
| `PORT` | 后端端口，默认 `8790` |
| `VITE_API_BASE` | 前端 API 根地址，开发默认 `http://127.0.0.1:8790` |

## 目录

```
src/                 # React 前端
  api/chat.ts        # SSE 客户端
  components/        # 消息列表 / Tool 卡片
server/src/
  index.ts           # Express + SSE
  agent.ts           # Agent 循环（stream + tools）
  tools.ts           # 本地工具实现
```

## 简历可写要点

1. 基于 React + TypeScript 实现流式对话 UI，SSE 边收边渲染  
2. 实现 tool calling 状态机与工具卡片（调用中 / 结果 / 失败）  
3. Node 服务对接 OpenAI 兼容 API，支持多轮工具调用再汇总回答  
4. 内置简易检索工具，演示「检索 → 引用回答」链路  

## 下一步（Week 3）

- 上传文档做真·分块 RAG
- 引用角标点击跳转原文
- 部署（前端 Vercel + 后端任意 Node 主机）
