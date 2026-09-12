/**
 * Electron 主进程：开窗口 + 工作区 IPC。
 * 开发：加载 Vite 5176。打包：自己拉起 Express，再 loadFile(dist)。
 */
import { app, BrowserWindow, Menu, ipcMain, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  getWorkspaceRoot,
  notifyServer,
  pickWorkspace,
  workspaceList,
  workspaceRead,
  workspaceWrite,
} from './workspace.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8790)

function rendererUrls() {
  if (process.env.ELECTRON_RENDERER_URL) return [process.env.ELECTRON_RENDERER_URL]
  return ['http://127.0.0.1:5176', 'http://localhost:5176']
}

async function waitHealth() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`后端未在 127.0.0.1:${PORT} 起来`)
}

async function ensurePackagedServer() {
  if (!app.isPackaged) return
  process.env.PLAYGROUND_EMBEDDED = '1'
  process.env.PLAYGROUND_ROOT = app.getAppPath()
  process.env.PLAYGROUND_DATA = app.getPath('userData')
  process.env.PLAYGROUND_SKILLS = path.join(process.resourcesPath, 'skills')
  process.env.PLAYGROUND_HANDBOOK = path.join(process.resourcesPath, '求职补充手册.md')
  process.env.PORT = String(PORT)
  const serverEntry = path.join(__dirname, '../dist-server/src/index.js')
  const mod = (await import(pathToFileURL(serverEntry).href)) as {
    startServer: () => Promise<void>
  }
  await mod.startServer()
  await waitHealth()
}

async function loadRenderer(win: BrowserWindow) {
  if (app.isPackaged) {
    await win.loadFile(path.join(__dirname, '../dist/index.html'))
    return
  }
  let last: unknown
  for (const url of rendererUrls()) {
    try {
      await win.loadURL(url)
      return
    } catch (err) {
      last = err
    }
  }
  console.error('Failed to load renderer', last)
}

function broadcastRoot(root: string | null) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('workspace:changed', root)
  }
}

async function openWorkspace(win: BrowserWindow | null | undefined) {
  const root = await pickWorkspace(win)
  if (!root) return null
  await notifyServer(root)
  broadcastRoot(root)
  return root
}

function registerWorkspaceIpc() {
  ipcMain.handle('workspace:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return openWorkspace(win)
  })
  ipcMain.handle('workspace:get', () => getWorkspaceRoot())
  ipcMain.handle('workspace:list', (_e, rel: string) => workspaceList(rel))
  ipcMain.handle('workspace:read', (_e, rel: string) => workspaceRead(rel))
  ipcMain.handle('workspace:write', (_e, rel: string, content: string) =>
    workspaceWrite(rel, content),
  )
}

function installMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开工作区…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            try {
              await openWorkspace(BrowserWindow.getFocusedWindow())
            } catch (err) {
              console.error(err)
            }
          },
        },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Agent Chat Playground',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void loadRenderer(win)
}

app.whenReady().then(async () => {
  try {
    await ensurePackagedServer()
  } catch (err) {
    console.error(err)
  }
  registerWorkspaceIpc()
  installMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
