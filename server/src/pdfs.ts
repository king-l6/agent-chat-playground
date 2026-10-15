/**
 * PDF 阅读器的落盘层：原文件 + 目录缓存。
 *
 * 单独放 DATA_DIR/pdfs，**不碰 index.json、不进 RAG**。这不是随手分的：
 * wiki 批量入库和 dev server 抢的是同一份 index.json，PDF 这边要是也写它，
 * 上传一份 PDF 就可能跟入库互相覆盖。PDF 只存不检索，物理隔开最省事。
 *
 * 目录是前端用 pdf.js 解出来的（浏览器里现成有文本层和书签），PUT 回来存着，
 * 下次打开直接读缓存——405 页扫一遍字号要好几秒，没必要每次重扫。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { DATA_DIR } from './knowledge.js'
import { readJsonFile, sweepStaleTmp, writeJsonAtomic } from './jsonStore.js'

export const PDF_DIR = path.join(DATA_DIR, 'pdfs')
const MANIFEST_PATH = path.join(PDF_DIR, 'manifest.json')

/** 目录里的一节。page 从 1 起，跟用户看到的页码一致 */
export type PdfTocNode = {
  title: string
  page: number
  /** 页内纵坐标，PDF 用户空间（原点左下，越大越靠上）；拿不到就 0 */
  y: number
  level: number
  children?: PdfTocNode[]
}

export type PdfMeta = {
  id: string
  /** 给人看的原名 */
  name: string
  /** 磁盘文件名，恒为 {id}.pdf。中文名不进路径，免得各平台编码打架 */
  storedAs: string
  bytes: number
  /** 页数。0 = 前端还没解析过 */
  pages: number
  /** 目录有没有算过 */
  hasToc: boolean
  /** outline = PDF 自带书签，infer = 按字号推的 */
  tocSource: 'outline' | 'infer' | null
  /** 目录顶级条目数，列表里显示用 */
  tocRoots: number
  addedAt: number
}

type ManifestFile = { pdfs: PdfMeta[] }

/** id 形状；路由里拿它当白名单，挡路径穿越 */
const ID_RE = /^p_[0-9a-f]{16}$/

export function isPdfId(id: string): boolean {
  return ID_RE.test(id)
}

export function ensurePdfDir() {
  fs.mkdirSync(PDF_DIR, { recursive: true })
}

function newPdfId(used: Set<string>): string {
  for (let i = 0; i < 32; i += 1) {
    const id = `p_${randomBytes(8).toString('hex')}`
    if (!used.has(id)) return id
  }
  throw new Error('无法生成唯一 PDF id')
}

function readManifest(): ManifestFile {
  const parsed = readJsonFile<ManifestFile>(MANIFEST_PATH)
  return parsed && Array.isArray(parsed.pdfs) ? parsed : { pdfs: [] }
}

function writeManifest(file: ManifestFile) {
  ensurePdfDir()
  writeJsonAtomic(MANIFEST_PATH, file)
}

/** 上传临时名。刻意凑成 `<名字>.<pid>.tmp` 的形状，好被 sweepStaleTmp 顺手扫掉 */
export function tempPdfFilename(): string {
  return `tmp-${Date.now()}-${randomBytes(3).toString('hex')}.${process.pid}.tmp`
}

export function listPdfs(): PdfMeta[] {
  // 新的排前面：用户上传完就想看见它
  return readManifest().pdfs.slice().sort((a, b) => b.addedAt - a.addedAt)
}

export function getPdf(id: string): PdfMeta | null {
  if (!isPdfId(id)) return null
  return readManifest().pdfs.find((p) => p.id === id) ?? null
}

/** 原文件的绝对路径；id 不合法或记录不在都返回 null */
export function pdfFilePath(id: string): string | null {
  const rec = getPdf(id)
  return rec ? path.join(PDF_DIR, rec.storedAs) : null
}

/**
 * 落盘：每次上传都是新记录。两份都叫「手册.pdf」但内容不同就必须是两条，
 * 不能按文件名覆盖——要换掉旧的，在列表里删。
 */
export function commitPdf(tmpPath: string, originalName: string, bytes: number): PdfMeta {
  ensurePdfDir()
  sweepStaleTmp(PDF_DIR)
  const file = readManifest()
  const id = newPdfId(new Set(file.pdfs.map((p) => p.id)))
  const storedAs = `${id}.pdf`
  fs.renameSync(tmpPath, path.join(PDF_DIR, storedAs))

  const rec: PdfMeta = {
    id,
    name: originalName,
    storedAs,
    bytes,
    pages: 0,
    hasToc: false,
    tocSource: null,
    tocRoots: 0,
    addedAt: Date.now(),
  }
  file.pdfs.push(rec)
  writeManifest(file)
  return rec
}

export function readPdfToc(id: string): { source: 'outline' | 'infer'; nodes: PdfTocNode[] } | null {
  if (!isPdfId(id)) return null
  const data = readJsonFile<{ source: 'outline' | 'infer'; nodes: PdfTocNode[] }>(
    path.join(PDF_DIR, `${id}.toc.json`),
  )
  return data && Array.isArray(data.nodes) ? data : null
}

export function savePdfToc(
  id: string,
  source: 'outline' | 'infer',
  nodes: PdfTocNode[],
  pages: number,
): PdfMeta {
  const rec = getPdf(id)
  if (!rec) throw new Error('PDF 不存在')
  ensurePdfDir()
  // 目录单独一个文件：manifest 要频繁重写（列表、删除），塞个几百节点的树进去不值当
  writeJsonAtomic(path.join(PDF_DIR, `${id}.toc.json`), { source, nodes })

  const file = readManifest()
  const idx = file.pdfs.findIndex((p) => p.id === id)
  if (idx >= 0) {
    file.pdfs[idx] = {
      ...file.pdfs[idx],
      pages: pages > 0 ? pages : file.pdfs[idx].pages,
      hasToc: nodes.length > 0,
      tocSource: nodes.length > 0 ? source : null,
      tocRoots: nodes.length,
    }
  }
  writeManifest(file)
  return file.pdfs[idx]
}

export function deletePdf(id: string): void {
  const rec = getPdf(id)
  if (!rec) throw new Error('PDF 不存在')
  for (const name of [rec.storedAs, `${id}.toc.json`]) {
    try {
      fs.unlinkSync(path.join(PDF_DIR, name))
    } catch {
      /* 文件早没了也算删成功 */
    }
  }
  const file = readManifest()
  file.pdfs = file.pdfs.filter((p) => p.id !== id)
  writeManifest(file)
}
