import { useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, DownloadSimple, FilePdf, Plus, Trash } from '@phosphor-icons/react'

import {
  MAX_TOOL_FILE_BYTES,
  MAX_TOOL_FILES,
  inspectPdf,
  mergePdfs,
  splitPdf,
} from '../lib/pdf-tools.js'

function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function PdfToolsScreen({ backLabel = '返回首页', initialMode = 'merge', onBack }) {
  const mode = initialMode
  const [files, setFiles] = useState([])
  const [range, setRange] = useState('1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mergeInputRef = useRef(null)
  const splitInputRef = useRef(null)

  const addMergeFiles = async (selected) => {
    setError('')
    try {
      const selectedFiles = [...selected]
      if (files.length + selectedFiles.length > MAX_TOOL_FILES) {
        throw new Error(`一次最多合并 ${MAX_TOOL_FILES} 个 PDF`)
      }
      const next = await Promise.all(selectedFiles.map(async (file) => ({ file, pages: await inspectPdf(file) })))
      setFiles((current) => [...current, ...next])
    } catch (reason) {
      setError(reason.message)
    }
  }

  const chooseSplitFile = async (selected) => {
    const file = selected?.[0]
    if (!file) return
    setError('')
    try {
      setFiles([{ file, pages: await inspectPdf(file) }])
      setRange('1')
    } catch (reason) {
      setError(reason.message)
    }
  }

  const run = async () => {
    setError('')
    setBusy(true)
    try {
      if (mode === 'merge') {
        download(await mergePdfs(files.map(({ file }) => file)), '合并后的文件.pdf')
      } else {
        const item = files[0]
        download(await splitPdf(item.file, range), `提取-${range.replaceAll(/\s+/g, '')}.pdf`)
      }
    } catch (reason) {
      setError(reason.message || '处理失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const splitFile = files[0]
  const canRun = mode === 'merge' ? files.length >= 2 : Boolean(splitFile && range.trim())
  const moveFile = (from, to) => setFiles((current) => {
    const next = [...current]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    return next
  })
  return (
    <main className="tools-screen">
      <header className="tools-header">
        <button className="back-button" type="button" onClick={onBack}><ArrowLeft /> {backLabel}</button>
        <div><strong>{mode === 'merge' ? '合并 PDF' : '拆分 PDF'}</strong><span>本地处理，不上传文件</span></div>
      </header>
      <section className="tools-card">
        {mode === 'merge' ? <>
          <h1>按顺序合并多个 PDF</h1><p>可用上下箭头调整合并顺序，最多 {MAX_TOOL_FILES} 个文件。</p>
          <input ref={mergeInputRef} className="hidden-file-input" type="file" accept="application/pdf,.pdf" multiple onChange={(event) => {
            const selected = [...event.target.files]
            event.target.value = ''
            void addMergeFiles(selected)
          }} />
          <button className="tool-dropzone" type="button" onClick={() => mergeInputRef.current?.click()}><Plus size={28} /><strong>添加 PDF 文件</strong><span>支持一次选择多个文件</span></button>
          <ol className="tool-file-list">{files.map(({ file, pages }, index) => <li key={`${file.name}-${index}`}><FilePdf /><span><strong>{file.name}</strong><small>{pages} 页</small></span><div className="tool-file-actions"><button type="button" aria-label={`上移 ${file.name}`} disabled={index === 0} onClick={() => moveFile(index, index - 1)}><ArrowUp /></button><button type="button" aria-label={`下移 ${file.name}`} disabled={index === files.length - 1} onClick={() => moveFile(index, index + 1)}><ArrowDown /></button><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash /></button></div></li>)}</ol>
        </> : <>
          <h1>提取指定页为新 PDF</h1><p>支持单页或范围，例如 <code>1-3, 5, 8-10</code>。</p>
          <input ref={splitInputRef} className="hidden-file-input" type="file" accept="application/pdf,.pdf" onChange={(event) => {
            const selected = [...event.target.files]
            event.target.value = ''
            void chooseSplitFile(selected)
          }} />
          <button className="tool-dropzone" type="button" onClick={() => splitInputRef.current?.click()}><FilePdf size={28} /><strong>{splitFile ? splitFile.file.name : '选择要拆分的 PDF'}</strong><span>{splitFile ? `${splitFile.pages} 页` : `单个文件最大 ${MAX_TOOL_FILE_BYTES / (1024 * 1024)}MB、最多 100 页`}</span></button>
          {splitFile && <label className="range-field"><span>提取页码</span><input aria-label="提取页码" value={range} onChange={(event) => setRange(event.target.value)} placeholder="例如 1-3, 5" /></label>}
        </>}
        {error && <p className="message error-message" role="alert">{error}</p>}
        <button className="primary-button tool-run" type="button" disabled={!canRun || busy} onClick={run}>{busy ? '正在处理…' : <><DownloadSimple /> {mode === 'merge' ? '下载合并后的 PDF' : '下载提取的 PDF'}</>}</button>
      </section>
    </main>
  )
}
