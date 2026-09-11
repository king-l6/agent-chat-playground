# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV HF_ENDPOINT=https://huggingface.co/
RUN mkdir -p server/data/models && npx tsx -e "import { tryLoadEmbedder } from './server/src/embed.ts'; const ok = await tryLoadEmbedder(); if (!ok) throw new Error('embed warmup failed')"

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HF_ENDPOINT=https://huggingface.co/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/求职补充手册.md ./
EXPOSE 8080
CMD ["npx", "tsx", "server/src/index.ts"]
