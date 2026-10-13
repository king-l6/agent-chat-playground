# syntax=docker/dockerfile:1

# 服务形态的单镜像：前端静态 + Express API 由同一个进程托管。
#
# 为什么是一个镜像而不是两个服务：交付页的 WebContainer 需要跨源隔离，
# 那两个 COOP/COEP 头必须和后端在同一个响应管线上发（见 server/src/index.ts
# attachStaticFrontend）。拆成 nginx 静态 + node 后端反而要把这对头复制到两处。
# nginx 在本方案里的位置是「内网入口反代」，不是静态服务器，见 deploy/nginx.conf。
#
# 注意：**这个镜像里没有 .env**。配置一律走环境变量（compose 的 environment / env_file），
# 密钥不进镜像层；而且 server/src/index.ts 的 dotenv 是 override:true，
# 真放一个 .env 进去反而会盖掉你在 compose 里设的值。

########## 1. 前端构建 ##########
FROM node:22-bookworm-slim AS web
WORKDIR /app
# 镜像里只 build 前端，不拉 Electron 那一百多兆的二进制
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
# 刻意不注入 VITE_API_BASE：留空 = 前端走同源相对路径，
# 于是「内网哪个 IP 打开都对」，不像桌面壳那样把 127.0.0.1:8790 焊死在产物里。
RUN npx vite build

########## 2. 后端编译 ##########
FROM node:22-bookworm-slim AS server
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.server.json ./
RUN npm ci
COPY server ./server
# rootDir=server，outDir=dist-server → 产物是 dist-server/src/index.js
RUN npx tsc -p tsconfig.server.json

########## 3. 运行时依赖（只有 production） ##########
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

########## 4. 运行时 ##########
FROM node:22-bookworm-slim AS runtime

# docker CLI 从官方 cli 镜像里搬一个静态二进制。
# 必须有：沙箱容器不是本进程起的，是**宿主 daemon** 起的（DooD），
# 而跟 daemon 说话的唯一途径就是 socket + 这个 CLI。
# 不用 apt 的 docker.io —— 那会把 containerd 和整个 daemon 塞进来，白搭两百兆。
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# git 给交付页的 git status / git diff 用；ca-certificates 给 HTTPS 网关和 npm 源用。
# 视频页的 ffmpeg / swift 这里不装：渲染链依赖 macOS 的 swift，容器形态下视频页降级，
# 交付链不经过它。要开视频再说。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PLAYGROUND_ROOT=/app \
    PLAYGROUND_DATA=/app/server/data \
    PLAYGROUND_SKILLS=/app/server/skills \
    PLAYGROUND_HANDBOOK=/app/求职补充手册.md
# 上面这些是照 paths.ts 的默认值写的，写出来是为了让「运行时数据在哪」一眼可见。
# PLAYGROUND_DATA 必须是挂卷的位置，否则重启就丢索引、丢会话。

COPY --from=deps /app/node_modules ./node_modules
COPY --from=server /app/dist-server ./dist-server
COPY --from=web /app/dist ./dist
# package.json 有两个用途：npm 元信息，以及 /api/health 报的 version
COPY package.json ./
COPY server/skills ./server/skills
COPY 求职补充手册.md ./

# 数据目录先建出来：初次启动挂的是空卷，目录不存在的话索引/会话写入会直接 ENOENT。
RUN mkdir -p /app/server/data

# 刻意**不写 USER**，主进程以 root 跑。
#
# 不是偷懒，是因为挂进来的 docker.sock 已经让这个容器等价于宿主 root 了：
# 能读 socket 就能 `docker run --privileged -v /:/host`，降到 uid 1000 挡不住这件事，
# 却会立刻带来两个麻烦：sock 的属组（宿主 docker 组）在容器里没有对应成员，
# 于是沙箱直接起不来；还得额外配 group_add。收益是零，成本是「起不来 + 难排查」。
# 真正的缓解手段是令牌保密 + workspace 白名单 + 只在内网暴露，见 README 的风险章节。
#
# 由 root 跑带来一个必须显式处理的后果：PLAYGROUND_SANDBOX_UID/GID 的兜底值
# 是 process.getuid() = 0，也就是沙箱容器以 root 写宿主仓库，留下一堆 root 属主的文件。
# 所以 compose 里必须显式给这个值，别让兜底生效。
EXPOSE 8790
# listen 地址由 PLAYGROUND_LISTEN_HOST 决定，compose 里设 0.0.0.0。
# 只绑回环的话容器外一个请求都进不来 —— 而「非回环且没配令牌」会被启动保险直接拒绝，
# 所以这里不设默认值，让 compose 显式给。
CMD ["node", "dist-server/src/index.js"]
