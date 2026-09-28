/**
 * 沙箱预加载必须是 CJS。渲染进程只能走这里暴露的方法，不能直接 fs。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  listWorkspace: (rel) => ipcRenderer.invoke('workspace:list', rel),
  readWorkspace: (rel) => ipcRenderer.invoke('workspace:read', rel),
  writeWorkspace: (rel, content) => ipcRenderer.invoke('workspace:write', rel, content),
  onWorkspaceChange: (fn) => {
    const listener = (_event, root) => fn(root)
    ipcRenderer.on('workspace:changed', listener)
    return () => ipcRenderer.removeListener('workspace:changed', listener)
  },
})
