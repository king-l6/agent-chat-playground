/**
 * 用 macOS 原生目录选择器选文件夹。
 *
 * 为什么放在服务端：网页里没有「打开系统目录选择器并告诉我磁盘路径」的能力。
 * 最接近的 File System Access API（showDirectoryPicker）只给一个 FileSystemDirectoryHandle，
 * 页面永远拿不到绝对路径；而这个应用真正干活的是服务端（git / fs / workspace.json 里存的全是绝对路径），
 * 只要路径。所以由服务端这边调 osascript，弹的是货真价实的系统弹窗，跟 Electron 里
 * dialog.showOpenDialog 是同一个 NSOpenPanel。
 *
 * 只在 macOS 上可用；其它平台调用方自己回落后备方案。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** AppleScript 字符串字面量里只有这两个字符需要转义 */
function escapeApplScript(text: string) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 一次只弹一个：连点不该叠出好几个系统弹窗 */
let picking = false

/**
 * 弹系统目录选择器。返回绝对路径；用户取消返回 null。
 * @param prompt 弹窗上的说明文字
 * @param timeoutMs 兜底超时，免得忘了关的弹窗把请求永远挂着
 */
export async function pickFolderNative(
  prompt = '选择目录',
  timeoutMs = 10 * 60 * 1000,
): Promise<string | null> {
  if (process.platform !== 'darwin') {
    throw new Error('系统目录选择器目前只在 macOS 上可用')
  }
  if (picking) {
    throw new Error('已经有一个选择窗口开着，先在上面选完或取消')
  }
  picking = true
  try {
    const { stdout } = await run(
      'osascript',
      ['-e', `POSIX path of (choose folder with prompt "${escapeApplScript(prompt)}")`],
      { timeout: timeoutMs, killSignal: 'SIGTERM' },
    )
    // POSIX path 末尾带 '/'，去掉；根目录 '/' 要留住
    const dir = stdout.trim().replace(/(.+?)\/+$/, '$1')
    return dir || null
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? '')
    // 用户点了取消，不是错误
    if (/User canceled/i.test(stderr) || /-128/.test(stderr)) return null
    if ((err as { killed?: boolean }).killed) {
      throw new Error('目录选择窗口等太久，已经关掉了')
    }
    throw new Error(stderr.trim() || (err instanceof Error ? err.message : String(err)))
  } finally {
    picking = false
  }
}
