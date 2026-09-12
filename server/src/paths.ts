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
