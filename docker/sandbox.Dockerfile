# syntax=docker/dockerfile:1

# 交付泳道跑「危险命令」的一次性容器：eval:rag / tsc / lint。
#
# 为什么是 bookworm（glibc）而不是 alpine（musl）：
# 目标仓库的 node_modules 由这个镜像里的 npm 装（见 sandbox/docker.ts 的两段式），
# 而 onnxruntime-node 只有 glibc 预编译产物；musl 上得现编，等于把「跑个 lint」
# 变成一次源码构建。镜像大一点换确定性，值得。
#
# 镜像**不装**业务依赖：依赖走 per-repo 的命名卷 pg-nm-*，挂在 /work/node_modules。
# 这里的 apt 包是给「装依赖」那一段兜底的：git 给 git+https 依赖，
# python3/make/g++ 给没有预编译产物的 node-gyp 包。

FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# 默认保持 root：准备依赖那一段刻意以 root 跑（装完 chown 给目标 uid/gid），
# 执行段由 sandbox/docker.ts 传 --user <uid>:<gid> 显式降权。
# 这里如果写死 USER node，准备段就没法 chown 卷，执行段又写不进去。
WORKDIR /work
CMD ["node", "--version"]
