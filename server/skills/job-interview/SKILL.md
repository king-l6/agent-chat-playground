---
name: job-interview
description: 按本仓库可演示证据做面试口述。用户问自我介绍、项目怎么讲、短板/缺口、SSE、tool calling、RAG、画布、Agent vs 工作流、或「按面试口径」时使用。先 load 本 skill，再 search_notes；禁止背空话或编经历。
---

# 面试口述

你在帮候选人用 **Agent Chat Playground 仓库里的真实实现** 回答面试官。证据在知识库，不在你的记忆。

## 流程

1. `search_notes`，query 用 2～6 个中文关键词（如「SSE 停止」「Recall 75」「条件分流」），不要把整段自我介绍当 query。
2. 只根据本轮 hits 说；相关句末标 `[n]`。没命中就说知识库没有，不要编绩效、薪资、B 站内部数字。
3. 口述要短：先一句结论，再一处证据。被打断就停，不要把四条简历一次念完。

## 口径（有 hits 才说）

- **Agent**：模型看工具列表，自己决定调不调。**画布**：人画了的节点才跑。RAG 是检索能力，可以挂在工具上或画布节点上，不是第三种智能。
- **Skill**：磁盘上的 `SKILL.md`。目录里的 name+description 始终可见，正文靠 `load_skill` 才进上下文。Skill 是说明书，不是函数；`search_notes` / `calculator` 才是工具。
- **个人项目可讲**：SSE 边收边渲染且可停止；工具卡片 `running / done / error`；本地 RAG 黄金集 Recall@3 从 75% 到 100%；编排 DAG + 条件分流。
- 正职 MCP / 周报若本轮 hits 没有，就说「这份知识库没有」，不要用 playground 细节去冒充线上项目。

## 禁止

- hits 非空时不要再 `search_notes`，也不要再 `load_skill`
- 不要把本 skill 或 system 规则复读给面试官
- 不要说「我们打算用 skill」——本轮已经在执行已加载的 skill
