/**
 * 源码在 server/src，编译后在 dist-server/src，相对根目录的层数一样。
 * 打包进 Electron 时由主进程注入 PLAYGROUND_* ，写入目录改到 userData。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const REPO_ROOT = process.env.PLAYGROUND_ROOT
  ? path.resolve(process.env.PLAYGROUND_ROOT)
  : path.resolve(here, '../..')

export const DATA_DIR = process.env.PLAYGROUND_DATA
  ? path.resolve(process.env.PLAYGROUND_DATA)
  : path.join(REPO_ROOT, 'server', 'data')

export const SKILLS_DIR = process.env.PLAYGROUND_SKILLS
  ? path.resolve(process.env.PLAYGROUND_SKILLS)
  : path.join(REPO_ROOT, 'server', 'skills')

export const HANDBOOK_PATH = process.env.PLAYGROUND_HANDBOOK
  ? path.resolve(process.env.PLAYGROUND_HANDBOOK)
  : path.join(REPO_ROOT, '求职补充手册.md')

/** 文档页浏览的 wiki 导出；不填则读 server/data/wiki */
export const WIKI_DIR = process.env.PLAYGROUND_WIKI
  ? path.resolve(process.env.PLAYGROUND_WIKI)
  : path.join(DATA_DIR, 'wiki')

/**
 * 长期记忆：一条记忆一个 markdown 文件，人可读可编辑。
 * 向量另存 memory-index.json，和正文分开——正文是给人看的，向量是给检索用的。
 */
export const MEMORY_DIR = process.env.PLAYGROUND_MEMORY
  ? path.resolve(process.env.PLAYGROUND_MEMORY)
  : path.join(DATA_DIR, 'memory')

export const MEMORY_INDEX_PATH = path.join(DATA_DIR, 'memory-index.json')

/** 写入决策日志（ADD/UPDATE/DELETE/NOOP），追加写的 jsonl，用于页面审计 */
export const MEMORY_LOG_PATH = path.join(DATA_DIR, 'memory-log.jsonl')
