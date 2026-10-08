/**
 * 黄金集：
 * - gold.json：原 8 题（内置 project + handbook 回归，勿改）
 * - COMPANY_CASES：公司 wiki 已入库文档（评测默认走全量 index.json）
 * - PRODUCT_CASES：本仓库产品能力（rag/agent/…），可选对照
 *
 * 坑：query 必须和 contains 同域；docId 用 manifest 里的 w_*，别写文件名。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type GoldCase = {
  id: string
  query: string
  docId: string
  contains: string
}

const GOLD_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../eval/gold.json')

/**
 * 公司 wiki 黄金题（语料在 server/data/uploads，已进 index）。
 * 覆盖：新人 / Push / 召回 / 搜索国际化 / 流程规范 / 平台 / 稳定性 / 推荐 / 搜索架构。
 * 故意不收录「各平台账号」这类密钥文档。
 */
export const COMPANY_CASES: GoldCase[] = [
  {
    id: 'wiki-onboard',
    query: '推荐工程新人入职要申请哪些基础权限？',
    docId: 'w_6e37c57abb98a731',
    contains: 'blackhole.bilibili.co',
  },
  {
    id: 'wiki-onboard-bastion',
    query: '新人怎么登录堡垒机？',
    docId: 'w_6e37c57abb98a731',
    contains: 'relay.bilibili.co',
  },
  {
    id: 'wiki-push-coredump',
    query: 'Push线上排查手册：预发 coredump 去哪个目录找 core 文件？',
    docId: 'w_a6db062861429d92',
    contains: '/data/src/coredump',
  },
  {
    id: 'wiki-push-gdb',
    query: 'Push线上排查手册里用 gdb 看堆栈的常用命令？',
    docId: 'w_a6db062861429d92',
    contains: 'backtrace',
  },
  {
    id: 'wiki-push-release',
    query: 'Push线上发布流程里去哪个 Caster 容器平台发镜像？',
    docId: 'w_10877df57649c15f',
    contains: 'caster.bilibili.co',
  },
  {
    id: 'wiki-push-nyx',
    query: 'Push线上发布流程文档里 Nyx 构建平台链接是什么？',
    docId: 'w_10877df57649c15f',
    contains: 'nyx.bilibili.co',
  },
  {
    id: 'wiki-timeout',
    query: '搜索稳定性目录下「在线链路超时」表：mixer 到 rank-video 的超时参数名？',
    docId: 'w_50755c0ed6f844ef',
    contains: 'video_dynamic_rank_timeout',
  },
  {
    id: 'wiki-recall-skills',
    query: '召回SKILLs说明里 bili-recall-kit 有哪些 skill 目录？',
    docId: 'w_d469cdb4aea2fcb9',
    contains: 'recall-ann-config',
  },
  {
    id: 'wiki-recall-debug',
    query: '召回SKILLs说明里 debug 用什么脚本测 mid 和通路？',
    docId: 'w_d469cdb4aea2fcb9',
    contains: 'local-debug.sh',
  },
  {
    id: 'wiki-ann-gpu',
    query: 'ANN on GPU 文档里 cuVS 的 pip 包名是什么？',
    docId: 'w_7326c1da1cca2b36',
    contains: 'cuvs-cu12',
  },
  {
    id: 'wiki-bs-setup',
    query: '搜索 bs 服务搭建时增量索引靠什么带过来？',
    docId: 'w_29698f48d0aa8078',
    contains: 'rt 索引',
  },
  {
    id: 'wiki-intl-search',
    query: '国际化搜索服务端方案：英语 query 怎么匹配？',
    docId: 'w_2a37126773dcf3c7',
    contains: '中文翻译匹配',
  },
  {
    id: 'wiki-intl-block',
    query: '国际化搜索服务端方案要屏蔽哪些广告？',
    docId: 'w_2a37126773dcf3c7',
    contains: '品牌广告',
  },
  {
    id: 'wiki-pegasus-refresh',
    query: '天马降级手册里控制自动刷新的全局参数叫什么？',
    docId: 'w_05e22f77acdb3a78',
    contains: 'auto_refresh_time_by_active',
  },
  {
    id: 'wiki-bus',
    query: '推搜班车规范建立在哪个 Agileflow 机制上？',
    docId: 'w_f4c801b7f6354237',
    contains: 'Agileflow',
  },
  {
    id: 'wiki-agentos',
    query: 'AgentOS使用指南里平台访问地址是什么？',
    docId: 'w_67a16513e8d60ceb',
    contains: 'ai-fe.bilibili.co/agent-os',
  },
  {
    id: 'wiki-plan-toml',
    query: '预案平台使用文档里降级配置文件名规范？',
    docId: 'w_f69152593c23f39d',
    contains: 'ercdowngrade',
  },
  {
    id: 'wiki-search-arch',
    query: '搜索在线架构演进文档里主搜峰值大约多少 QPS？',
    docId: 'w_eb0feccfb682ccb5',
    contains: '9.3k',
  },
  {
    id: 'wiki-search-as',
    query: '搜索在线架构演进里早期 as 层有什么问题？',
    docId: 'w_eb0feccfb682ccb5',
    contains: '巨型单体',
  },
  {
    id: 'wiki-rec-scenes',
    query: '推荐系统架构梳理里天马 story pc 是几套系统？',
    docId: 'w_f3435dcc97b93a8f',
    contains: '三套独立',
  },
  {
    id: 'wiki-rec-mixer',
    query: '推荐系统架构梳理里天马混排代码库是哪个？',
    docId: 'w_f3435dcc97b93a8f',
    contains: 'AI/mixer',
  },
]

/** 本仓库产品说明（内置 rag/agent/…），占少数 */
export const PRODUCT_CASES: GoldCase[] = [
  {
    id: 'rag-rrf',
    query: '本仓库向量和关键词结果怎么融合？',
    docId: 'rag',
    contains: 'RRF',
  },
  {
    id: 'rag-bge',
    query: '本仓库本地 embedding 模型是哪个？',
    docId: 'rag',
    contains: 'BGE-small-zh',
  },
  {
    id: 'agent-code-team',
    query: '对话代码团队模式固定哪几段？',
    docId: 'agent',
    contains: 'explore',
  },
  {
    id: 'agent-write-gate',
    query: 'workspace_write 为什么要人批准？',
    docId: 'agent',
    contains: 'tool_approval',
  },
  {
    id: 'delivery-gate',
    query: '交付泳道确认后需求文档还能改吗？',
    docId: 'delivery',
    contains: '冻住',
  },
  {
    id: 'canvas-topo',
    query: '画布节点按什么顺序执行？',
    docId: 'canvas',
    contains: '拓扑序',
  },
]

/** @deprecated 兼容旧名；等于公司题 + 产品题 */
export const EXTRA_CASES: GoldCase[] = [...COMPANY_CASES, ...PRODUCT_CASES]

export function loadGoldCases(): { topK: number; cases: GoldCase[] } {
  const gold = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf8')) as {
    topK?: number
    cases: GoldCase[]
  }
  return { topK: gold.topK || 3, cases: [...gold.cases, ...EXTRA_CASES] }
}
