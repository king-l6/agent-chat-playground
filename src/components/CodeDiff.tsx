/**
 * Monaco Diff / 统一 diff 展示。
 * 批准写入：左右对照（before / after）
 * Delivery：git unified diff 着色
 */
import { DiffEditor, Editor } from '@monaco-editor/react'
import './CodeDiff.css'

function langOf(filePath?: string) {
  const p = (filePath || '').toLowerCase()
  if (p.endsWith('.tsx') || p.endsWith('.ts')) return 'typescript'
  if (p.endsWith('.jsx') || p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')) return 'javascript'
  if (p.endsWith('.json')) return 'json'
  if (p.endsWith('.css')) return 'css'
  if (p.endsWith('.html')) return 'html'
  if (p.endsWith('.md')) return 'markdown'
  if (p.endsWith('.py')) return 'python'
  return 'plaintext'
}

export function SideBySideDiff({
  path,
  before = '',
  after = '',
  height = 280,
}: {
  path?: string
  before?: string
  after?: string
  height?: number
}) {
  return (
    <div className="code-diff">
      {path ? <div className="code-diff__path">{path}</div> : null}
      <div className="code-diff__editors" style={{ height }}>
        <DiffEditor
          original={before}
          modified={after}
          language={langOf(path)}
          theme="vs"
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbers: 'on',
            wordWrap: 'on',
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  )
}

/** Delivery 里的 git diff 文本 */
export function UnifiedDiff({ text, height = 320 }: { text: string; height?: number }) {
  const clipped = text.length > 120_000 ? `${text.slice(0, 120_000)}\n…(已截断)` : text
  return (
    <div className="code-diff code-diff--unified">
      <div className="code-diff__editors" style={{ height }}>
        <Editor
          value={clipped}
          language="plaintext"
          theme="vs"
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbers: 'off',
            wordWrap: 'off',
            automaticLayout: true,
            renderLineHighlight: 'none',
          }}
          onMount={(editor, monaco) => {
            const model = editor.getModel()
            if (!model) return
            const decorations = clipped.split('\n').map((line, i) => {
              const n = i + 1
              let className = ''
              if (line.startsWith('+') && !line.startsWith('+++')) className = 'code-diff__add'
              else if (line.startsWith('-') && !line.startsWith('---')) className = 'code-diff__del'
              else if (line.startsWith('@@')) className = 'code-diff__hunk'
              if (!className) return null
              return {
                range: new monaco.Range(n, 1, n, 1),
                options: { isWholeLine: true, className },
              }
            }).filter((d): d is NonNullable<typeof d> => d != null)
            editor.createDecorationsCollection(decorations)
          }}
        />
      </div>
    </div>
  )
}
