# Agent Chat Playground

可下载的 **本地 Agent 交付工作台**：Electron 选仓库、产研泳道带闸门、内核仍是 SSE / 工具 / Skill / RAG / 画布。

仓库：https://github.com/king-l6/agent-chat-playground  
安装包：https://github.com/king-l6/agent-chat-playground/releases/tag/v0.2.0  
无 API Key 也能用 mock。网页和桌面都在 `#/settings` 填自己的 Key。

**不是 Cursor，也不是 Dify。** 控制面是人点的确认 / 撤回 / 放行 / 签字，不是模型自己往下跳。

## 90 秒演示（面试用）

打开安装包（或 `npm run electron:dev`）→ 选本仓库 → `#/delivery`。不要先去画布里乱点。

| 秒 | 打开 | 做什么 | 面试官应看到 |
|----|------|--------|--------------|
| 0–15 | 安装包 / 桌面窗 | 选本仓库 | 工作区条出现仓库名，不是系统浏览器 |
| 15–35 | `#/delivery` 身份=产品 | 说一句「给 RAG 评测加一道题」→ 点「让 AI 起草」→ 再聊一改 → 勾 1 条验收 → 交给研发 | 文档是聊出来的；没勾不能交；确认后正文冻住 |
| 35–55 | 身份=研发 | 点「让 AI 改一版」或直接说怎么改 → 看 git diff → 开发完成 | 按右边 PRD 改选中仓库里的真实代码；写挂了就接着说，不是加一道评测题 |
| 55–75 | 身份=测试 | 对照 diff 出意见 → 放行 → 在这个仓库跑验收 → 签字 | 意见带路径；报告里有真实命令退出码 |
| 75–90 | 指闸门 | 说「撤回才会解冻，带风险放行必须写理由」 | 状态是一句人话，不会自己往前跳 |

内核还在：`#/` 问「现在几点了？」看工具卡片；`#/canvas` 对照「人画的流程」。`npm run eval:rag` 原 8 题不能坏。

会话也进了路由：地址栏是 `#/c/<归属人>/<会话id>`，刷新能回到同一条；点会话行上的「分享」会把链接复制到剪贴板（同时把它设为可分享），别人打开是**只读**。后端每条 `/api/chat` 打 `[chat][<会话id>] start|done|error`，对链路时按这个前缀 grep 就能定位到具体会话。

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
| 对话 | `#/`、`#/c/<归属人>/<会话id>` | SSE；工具卡片；`load_skill` 读 `server/skills/*/SKILL.md`；可停止。会话存服务端（私密/可分享），链接可发给别人只读打开 |
| 文档 | `#/documents` | 上传 md/txt，增量进索引 |
| 向量库 | `#/vectors` | 看 chunk、向量是否已编码 |
| 编排 | `#/canvas` | 沿边执行；计算器节点；DAG；条件分流；图存 localStorage（不存运行结果） |
| 交付 | `#/delivery` | 产品和 AI 多轮聊出 PRD；确认才冻结；研发/测试对着选中仓库真改、真跑命令 |
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
- 自检：`npm run lint`（oxlint）。

Live：打开 `#/settings` 填自己的 API Key / Base URL / 模型，或切回 MOCK。网页和桌面同一页。也可以继续用 `.env` 的 `ANTHROPIC_*` / `OPENAI_*`。Embedding 走本地模型，不要把 chat 接口当成 `/embeddings`。

公司 HTTP MCP（Claude Code 里那套）：`#/settings` 点「从 Claude 导入」，或自己填 URL + Cookie。连上后对话页会把 `tools/list` 转成 function calling。要 VPN；Cookie 只写本机数据目录。交付页不会调 MCP。

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

## 服务器部署（内网团队形态）

同一套代码，靠环境变量切成「一个 URL 打开就能用」的服务：前端静态由后端自己托管，进门要一把共享令牌，交付泳道跑测试命令时**每条命令起一个一次性容器**，不再直接落在宿主机上。

```bash
# 1) 装沙箱镜像（它由宿主 daemon 按名字起，不是 compose 的 service）
docker build -f docker/sandbox.Dockerfile -t playground-sandbox:latest .

# 2) 配 .env：令牌、仓库目录、沙箱 uid
REPOS=/srv/repos                       # macOS 上换成你的真实路径
echo "PLAYGROUND_ACCESS_TOKENS=alice:$(openssl rand -hex 24)" >> .env
echo "PLAYGROUND_REPOS_ROOT=$REPOS"                           >> .env
# 取目录属主。Linux 用 stat -c，macOS 用 stat -f
echo "PLAYGROUND_SANDBOX_UID=$(stat -c '%u' "$REPOS")"        >> .env
echo "PLAYGROUND_SANDBOX_GID=$(stat -c '%g' "$REPOS")"        >> .env

# 3) 起
docker compose up -d --build
```

浏览器打开 `http://<这台机器>:8790` → 出登录页 → 拿令牌进去。变量含义见 `.env.example` 末段。

> 上面那三步里只有第 1 步需要网络（首次拉基础镜像 + 装 git/python3 那几样）。本机先跑通时
> `REPOS` 直接用你现有的仓库父目录即可 —— 不需要真去建 `/srv/repos`。

**必配的三样**（缺任何一个都会在起步阶段就拦下来，不会带病上线）：

| 变量 | 不配的后果 |
|---|---|
| `PLAYGROUND_ACCESS_TOKENS` | 身份是前端自拟的 `X-Playground-User` 头，改一下就能读走别人的 Key / 会话；且「非回环监听 + 没令牌」会被启动保险**直接拒绝启动** |
| `PLAYGROUND_WORKSPACE_ALLOWLIST` | 工作区能指到 `/etc`、`~/.ssh` —— 它会 bind mount 进沙箱、也会被 `workspace_read` 读，令牌门禁整个被绕过 |
| `PLAYGROUND_SANDBOX_UID/GID` | 兜底成 0:0，沙箱以 root 写你的仓库，留下一堆 root 属主的文件 |

发布前门禁（在喂过 wiki 的那台机器上跑）：

```bash
PLAYGROUND_EVAL_MIN_RECALL=0.8 npm run eval:rag   # 红了就别发
```

CI（lint / 四个 tsc 工程 / compose 校验 / 两个镜像构建 + 冒烟）见 `.github/workflows/ci.yml`。

### 风险：挂了 docker.sock，就等于把那台机器交出去了

沙箱容器是**宿主 daemon** 起的（DooD），所以 app 容器必须挂 `/var/run/docker.sock`。这意味着**能读这个 socket 的进程 ≈ 宿主 root** —— 拿到它就能 `docker run --privileged -v /:/host`，容器隔离对主进程自己不起作用。

也就是说：令牌一旦泄漏、或白名单没配严，攻击面不是「读别人 Key」，而是**整台机器**。目前的缓解手段就三条，都不是技术兜底，是纪律：

1. **令牌保密**，一人一把，别贴在群里；泄漏了就换（换掉 env 值即刻作废所有人的 cookie）。
2. **白名单配严**，只放行真要它干活的仓库目录。
3. **只在内网暴露**，别做端口映射到公网；能上 nginx 就顺手加个网段限制（`deploy/nginx.conf` 里有注释掉的 allow/deny）。

不做 DinD 是因为它要 `--privileged` 且慢一个数量级；不做 socket-proxy 是因为即使限制了动词，自由 `-v` 挂载照样能读宿主机 —— 内网几个人的场景下不值得多一层。

### 这一版还没验过的部分

说实话，下面这些是**写好了但没跑过**的，别当成已验证的能力：

- **`docker compose up` 全链路没跑过** —— 本机 Docker daemon 当时没起，两个镜像也还没 build 过。compose 文件只做过 `docker compose config` 的解析校验。
- **沙箱容器没真跑过一条命令**（`PLAYGROUND_SANDBOX=docker` 这条路）。`commands.ts` 的白名单命令仍在宿主机上跑。
- **DooD 路径对齐没实测**。这是最容易做错的一处：沙箱的 `-v <路径>:/work` 由宿主 daemon 解析，路径两边不一致会**静默挂上空目录**、命令「成功」跑在空气上。compose 里已经用 `create_host_path: false` 把「路径写错时替你建空目录」这个行为关掉了，但它只能挡住 app 容器**自己**那层挂载，挡不住 daemon 那层。第一次真跑通之后，用 `docker inspect` 核对实际的 `Source`。

已经验过的（本机实测）：令牌登录闭环（含浏览器里 cookie 真的被带上）、非回环无令牌拒绝启动、白名单在「新开需求」和「事后改绑」两条写入路径上都拦住、伪造 `X-Playground-User` 无效、静态托管与 COOP/COEP、启动清 `.tmp`、eval 门禁在完整语料上 100% 通过。

## 简历可写（须能演示）

- 用 Electron 做出可安装的本地 Agent 工作台：选仓库后受限读写文件，并读取 git status / diff
- 按产研泳道流转：产品把一句话打成带验收标准的需求文档，多轮改完确认后才到研发；评审对照 diff，测试只证明已确认的验收
- 对着本仓库跑通一条竖切（给 RAG 评测加题），评审能指出具体文件风险，测试报告含自动命令结果与人工步骤
- 内核复用 SSE 流式、tool calling、Skill、本地 RAG（Recall@3 75%→100%）与编排画布

## 有意没做（问到要承认）

- 不是 Cursor / 通用 IDE，写文件锁在已选工作区，不碰 `.git` / `.env` / `node_modules`
- **不是多租户。** 服务形态只加了「一层共享访问令牌」——它挡的是「内网随便谁打开就能读别人 Key」，
  不是账号体系：没有注册、没有权限分级、没有租户隔离。知识库 / wiki / 交付泳道 / 画布这些继续是
  **全团队共享**（只有会话、Key、MCP 配置按令牌归属人分开），所以 `POST /api/delivery/reset`
  是对所有人生效的。本地开发形态没有登录，单人切 pm / dev / qa
- 没有 Windows 安装包；macOS 包未签名
- 确认后不能悄悄改文档；撤回不会自动 git checkout
- 无理由不能跳过评审或测试
- 不是分布式向量库；画布分流是正则；图画在 localStorage
- MCP 要本机填 URL/Cookie（或从 Claude 导入），安装包里不带公司凭证；交付泳道不调 MCP
- **交付页的产物预览只支持 `npm run dev` / `electron:dev`**：预览要跨源隔离（COOP/COEP 响应头）才
  能跑 WebContainer，而打包后的安装包走 `file://`，响应头带不了，`crossOriginIsolated` 恒为 false。
  面板会显示这条边界并给出该用哪个命令，PRD / diff / 闸门全不受影响。另外沙箱启动要外网
  （运行时来自 StackBlitz CDN、`npm install` 走 registry），不通就报分类错误 + 原始日志，不挡交付

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
  mcp.ts              HTTP MCP 客户端：list → function calling
  skills.ts           扫描 SKILL.md，供 load_skill 读取
  retrieve.ts         hybrid + rerank + 邻接扩展
  workflow.ts         画布执行器（search / calc / answer）
  eval.ts             黄金集 Recall@K
server/skills/        已安装 Skill（如 job-interview）
```
