export {}

declare global {
  interface Window {
    desktop?: {
      isElectron: boolean
      pickWorkspace: () => Promise<string | null>
      getWorkspace: () => Promise<string | null>
      listWorkspace: (rel?: string) => Promise<Array<{ name: string; kind: string; path: string }>>
      readWorkspace: (rel: string) => Promise<string>
      writeWorkspace: (rel: string, content: string) => Promise<{ path: string; bytes: number }>
      onWorkspaceChange: (fn: (root: string | null) => void) => () => void
    }
  }
}
