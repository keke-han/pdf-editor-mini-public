import { useEffect, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsMerge,
  Check,
  CheckCircle,
  DownloadSimple,
  FilePdf,
  ImageSquare,
  LockKey,
  PencilSimpleLine,
  SpinnerGap,
  Scissors,
  TextT,
  Trash,
  UploadSimple,
  X,
} from '@phosphor-icons/react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

import { OriginalTextLayer } from './components/OriginalTextLayer.jsx'
import { OriginalTextProperties } from './components/OriginalTextProperties.jsx'
import { PdfToolsScreen } from './components/PdfToolsScreen.jsx'
import {
  analyzeOriginalText,
  preflightOriginalText,
  rewriteOriginalText,
} from './lib/original-text-api.js'
import { exportPdfLocally } from './lib/client-pdf-export.js'
import {
  OriginalTextStatus,
  applyOriginalEdit,
  createOriginalEdit,
  validateOriginalEdit,
} from './lib/original-text.js'
import { AnnotationType, toPdfViewportCoordinates } from './lib/pdf-form.js'

GlobalWorkerOptions.workerSrc = workerUrl

const MAX_PDF_BYTES = 30 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const DEFAULT_POSITION = { x: 80, y: 80 }
const FONT_SIZES = [12, 14, 16, 18, 24, 32]
const TEXT_FONT_OPTIONS = [
  { value: 'sans', label: '思源黑体' },
  { value: 'serif', label: '思源宋体' },
]
const STANDARD_COLORS = [
  '#222222', '#7f7f7f', '#c00000', '#ff0000', '#d97656', '#ffc000',
  '#ffff00', '#92d050', '#00b050', '#00b0f0', '#2563eb', '#7030a0',
]
const HISTORY_LIMIT = 50
const MAX_TEXT_LENGTH = 50
const TEXT_HORIZONTAL_PADDING = 12
const THUMBNAIL_WIDTH = 63
const THUMBNAIL_HEIGHT = 82
const destroyedLoadingTasks = new WeakSet()

function StandardColorPalette({ label, value, onChange }) {
  return (
    <div className="standard-color-palette" role="group" aria-label={`${label}标准色`}>
      <span>标准色</span>
      <div>
        {STANDARD_COLORS.map((color) => (
          <button
            key={color}
            className={`standard-color-button${value.toLowerCase() === color ? ' is-active' : ''}`}
            type="button"
            aria-label={`选择${label} ${color.toUpperCase()}`}
            aria-pressed={value.toLowerCase() === color}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  )
}

function cloneHistoryValue(value) {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(cloneHistoryValue)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneHistoryValue(item)]),
    )
  }
  return value
}

function createHistorySnapshot(annotations, originalEdits) {
  return cloneHistoryValue({ annotations, originalEdits })
}

function semanticSnapshotKey(snapshot) {
  const normalize = (value) => {
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return {
        $blob: true,
        name: value.name ?? '',
        size: value.size,
        type: value.type,
        lastModified: value.lastModified ?? null,
      }
    }
    if (Array.isArray(value)) {
      return value.map(normalize)
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, normalize(value[key])]),
      )
    }
    return value
  }
  return JSON.stringify(normalize(snapshot))
}

function destroyPdfLoadingTask(task) {
  if (
    !task
    || typeof task.destroy !== 'function'
    || destroyedLoadingTasks.has(task)
  ) {
    return
  }
  destroyedLoadingTasks.add(task)
  try {
    Promise.resolve(task.destroy()).catch(() => {})
  } catch {
    // PDF.js cleanup must never block replacing or leaving the current file.
  }
}

function getTextWidth(text, fontSize, pageWidth) {
  return Math.min(
    pageWidth,
    Math.max(160, text.length * fontSize + TEXT_HORIZONTAL_PADDING),
  )
}

function getTextFontFamily(fontFamily) {
  return fontFamily === 'serif'
    ? 'Qing PDF Serif, serif'
    : 'Qing PDF Sans, sans-serif'
}

function getTextError(annotation, page) {
  if (!annotation.text.trim()) {
    return '文字内容不能为空'
  }
  if (annotation.text.length > MAX_TEXT_LENGTH) {
    return `文字不能超过 ${MAX_TEXT_LENGTH} 个字符`
  }
  if (/[\r\n]/.test(annotation.text)) {
    return '文字内容仅支持单行'
  }
  if (
    annotation.text.length * annotation.fontSize + TEXT_HORIZONTAL_PADDING
    > page.width
  ) {
    return '当前字号下文字过长，请缩短内容'
  }
  return ''
}

function normalizeAnalysis(result) {
  return {
    ...result,
    pages: result.pages.map((page) => ({
      ...page,
      blocks: page.blocks
        .filter(({ editable }) => editable)
        .map((block) => ({ ...block, pageIndex: page.pageIndex })),
    })),
  }
}

function rectanglesOverlap(left, right) {
  return (
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
  )
}

function isValidOriginalBounds(bounds) {
  return (
    Number.isFinite(bounds?.x)
    && Number.isFinite(bounds?.y)
    && Number.isFinite(bounds?.width)
    && Number.isFinite(bounds?.height)
    && bounds.width > 0
    && bounds.height > 0
  )
}

function prepareOriginalDraft(edit, blocks, edits) {
  const appliedBounds = new Map(
    edits
      .filter(({ bounds }) => isValidOriginalBounds(bounds))
      .map(({ blockId, bounds }) => [blockId, bounds]),
  )
  return {
    ...edit,
    overlapsOtherBlock: Number.isFinite(edit.bounds.width)
      && Number.isFinite(edit.bounds.height)
      && blocks.some((block) => (
        block.blockId !== edit.blockId
        && block.pageIndex === edit.pageIndex
        && rectanglesOverlap(
          edit.bounds,
          appliedBounds.get(block.blockId) ?? block.bounds,
        )
      )),
  }
}

function getOriginalDraftError(draft) {
  if (
    !Number.isFinite(draft.bounds.width)
    || !Number.isFinite(draft.bounds.height)
    || draft.bounds.width <= 0
    || draft.bounds.height <= 0
  ) {
    return '请输入有效的文字框尺寸'
  }
  return validateOriginalEdit(draft)
}

function PdfCanvas({ page, pageNumber, onRenderError }) {
  const canvasRef = useRef(null)
  const renderErrorRef = useRef(onRenderError)
  renderErrorRef.current = onRenderError

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return undefined
    }

    const viewport = page.getViewport({ scale: 1 })
    const pixelRatio = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * pixelRatio)
    canvas.height = Math.floor(viewport.height * pixelRatio)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const renderTask = page.render({
      canvas,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    })
    renderTask.promise.catch((error) => {
      if (error?.name !== 'RenderingCancelledException') {
        renderErrorRef.current()
      }
    })

    return () => {
      renderTask.cancel?.()
    }
  }, [page])

  return (
    <canvas
      ref={canvasRef}
      className="pdf-canvas"
      data-testid="pdf-page-canvas"
      aria-label={`PDF 第 ${pageNumber} 页`}
    />
  )
}

function PdfThumbnail({ page, pageNumber }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return undefined
    }

    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(
      THUMBNAIL_WIDTH / baseViewport.width,
      THUMBNAIL_HEIGHT / baseViewport.height,
    )
    const viewport = page.getViewport({ scale })
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.ceil(viewport.width * pixelRatio)
    canvas.height = Math.ceil(viewport.height * pixelRatio)
    canvas.style.width = `${Math.round(viewport.width * 100) / 100}px`
    canvas.style.height = `${Math.round(viewport.height * 100) / 100}px`

    const renderTask = page.render({
      canvas,
      viewport,
      transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    })
    renderTask.promise.catch(() => {})

    return () => {
      renderTask.cancel?.()
    }
  }, [page])

  return (
    <canvas
      ref={canvasRef}
      className="pdf-thumbnail-canvas"
      data-testid="pdf-thumbnail-canvas"
      aria-label={`第 ${pageNumber} 页缩略图`}
    />
  )
}

function Brand() {
  return (
    <div className="brand" aria-label="轻量 PDF 编辑器">
      <span className="brand-mark"><FilePdf weight="duotone" /></span>
      <span>轻量 PDF 编辑器</span>
    </div>
  )
}

function UploadScreen({ error, loading, onFile, onTools }) {
  const [isDragging, setIsDragging] = useState(false)

  const readFile = (files) => {
    const [file] = files ?? []
    if (file) {
      onFile(file)
    }
  }

  return (
    <main className="upload-screen">
      <header className="upload-header">
        <Brand />
      </header>

      <section className="upload-hero">
        <p className="eyebrow"><PencilSimpleLine weight="duotone" /> 无需安装 · 无需登录 · 打开即用</p>
        <h1>快速编辑 PDF，文件不留存</h1>
        <p className="hero-copy">文件只在浏览器处理，关闭页面即结束本次编辑。</p>

        <label
          className={`dropzone${isDragging ? ' is-dragging' : ''}`}
          data-testid="pdf-dropzone"
          onDragEnter={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setIsDragging(false)
            readFile(event.dataTransfer.files)
          }}
        >
          <input
            type="file"
            accept="application/pdf,.pdf"
            aria-label="选择 PDF 文件"
            onChange={(event) => readFile(event.target.files)}
            disabled={loading}
          />
          <span className="upload-icon">
            {loading ? <SpinnerGap className="spin" /> : <UploadSimple weight="duotone" />}
          </span>
          <strong>{loading ? '正在读取 PDF…' : '拖入 PDF，或点击选择文件'}</strong>
          <span>最大 30MB · 最多 100 页</span>
        </label>

        {error && <p className="message error-message" role="alert">{error}</p>}

        <div className="privacy-note">
          <LockKey size={21} weight="duotone" />
          <p>
            <strong>你的文件由你掌控</strong>
            <span>文件仅在当前浏览器内处理，不会上传或保存。</span>
          </p>
        </div>

        <section className="upload-tool-actions" aria-label="PDF 文件工具">
          <button type="button" onClick={() => onTools('merge')}>
            <ArrowsMerge weight="duotone" />
            <span>合并 PDF</span>
            <small>按顺序合并多个文件</small>
          </button>
          <button type="button" onClick={() => onTools('split')}>
            <Scissors weight="duotone" />
            <span>拆分 PDF</span>
            <small>按页码提取为新文件</small>
          </button>
        </section>
      </section>

      <footer className="upload-footer">无需登录 · 不保存历史 · 完成后直接下载</footer>
    </main>
  )
}

function SignatureDialog({ onClose, onConfirm }) {
  const canvasRef = useRef(null)
  const closeRef = useRef(null)
  const dialogRef = useRef(null)
  const drawingRef = useRef(false)
  const previousPointRef = useRef(null)
  const confirmedRef = useRef(false)
  const cancelledRef = useRef(false)
  const [hasStroke, setHasStroke] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    cancelledRef.current = false
    const returnFocus = document.activeElement
    closeRef.current?.focus()
    return () => {
      cancelledRef.current = true
      returnFocus?.focus()
    }
  }, [])

  const close = () => {
    cancelledRef.current = true
    onClose()
  }

  const pointFromEvent = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const scaleX = event.currentTarget.width / (bounds.width || event.currentTarget.width)
    const scaleY = event.currentTarget.height / (bounds.height || event.currentTarget.height)
    return {
      x: (event.clientX - bounds.left) * scaleX,
      y: (event.clientY - bounds.top) * scaleY,
    }
  }

  const beginStroke = (event) => {
    drawingRef.current = true
    previousPointRef.current = pointFromEvent(event)
  }

  const drawStroke = (event) => {
    if (!drawingRef.current) {
      return
    }
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    const nextPoint = pointFromEvent(event)
    if (
      nextPoint.x !== previousPointRef.current.x
      || nextPoint.y !== previousPointRef.current.y
    ) {
      setHasStroke(true)
    }
    if (context) {
      context.beginPath()
      context.moveTo(previousPointRef.current.x, previousPointRef.current.y)
      context.lineTo(nextPoint.x, nextPoint.y)
      context.strokeStyle = '#1f2937'
      context.lineWidth = 3
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.stroke()
    }
    previousPointRef.current = nextPoint
  }

  const endStroke = () => {
    drawingRef.current = false
    previousPointRef.current = null
  }

  const clear = () => {
    const canvas = canvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    setHasStroke(false)
  }

  const confirm = () => {
    if (confirming) {
      return
    }
    setConfirming(true)
    const canvas = canvasRef.current
    canvas.toBlob?.((blob) => {
      if (blob && !confirmedRef.current && !cancelledRef.current) {
        confirmedRef.current = true
        onConfirm(new File([blob], 'signature.png', { type: 'image/png' }))
      } else if (!blob) {
        setConfirming(false)
      }
    }, 'image/png')
  }

  const handleDialogKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') {
      return
    }
    const focusable = [...dialogRef.current.querySelectorAll(
      'button, canvas[tabindex]',
    )].filter((element) => !element.disabled)
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="signature-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signature-title"
        onKeyDown={handleDialogKeyDown}
      >
        <header>
          <div>
            <p className="eyebrow">鼠标书写</p>
            <h2 id="signature-title">手写签名</h2>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="关闭签名窗口"
            onClick={close}
          >
            <X />
          </button>
        </header>
        <canvas
          ref={canvasRef}
          className="signature-canvas"
          width="520"
          height="180"
          tabIndex="0"
          aria-label="签名画布"
          onMouseDown={beginStroke}
          onMouseMove={drawStroke}
          onMouseUp={endStroke}
          onMouseLeave={endStroke}
        />
        <p className="signature-disclaimer">
          该签名仅作为文档视觉标注，不代表法律认证或数字签名。
        </p>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={clear}>清空</button>
          <button
            className="primary-button"
            type="button"
            disabled={!hasStroke || confirming}
            onClick={confirm}
          >
            使用此签名
          </button>
        </div>
      </section>
    </div>
  )
}

function EditorScreen({ file, pdfDocument, pages, onReset, onTools, isHidden = false }) {
  const [annotations, setAnnotations] = useState([])
  const [history, setHistory] = useState([])
  const [future, setFuture] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [editingTextId, setEditingTextId] = useState(null)
  const [samplingCoverId, setSamplingCoverId] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [signatureOpen, setSignatureOpen] = useState(false)
  const [message, setMessage] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [exportStage, setExportStage] = useState(null)
  const [originalMode, setOriginalMode] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [analysisStatus, setAnalysisStatus] = useState(OriginalTextStatus.IDLE)
  const [analysisError, setAnalysisError] = useState('')
  const [originalEdits, setOriginalEdits] = useState([])
  const [selectedOriginalBlockId, setSelectedOriginalBlockId] = useState(null)
  const [originalDraft, setOriginalDraft] = useState(null)
  const [preflightingOriginalDraft, setPreflightingOriginalDraft] = useState(false)
  const [exportBaselineKey, setExportBaselineKey] = useState(() => (
    semanticSnapshotKey(createHistorySnapshot([], []))
  ))
  const dragRef = useRef(null)
  const imageInputRef = useRef(null)
  const pageElementsRef = useRef(new Map())
  const assetUrlsRef = useRef(new Set())
  const pendingAssetUrlsRef = useRef(new Set())
  const annotationsRef = useRef([])
  const originalEditsRef = useRef([])
  const exportControllerRef = useRef(null)
  const analysisControllerRef = useRef(null)
  const analysisStartedRef = useRef(false)
  const preflightControllerRef = useRef(null)
  const preflightVersionRef = useRef(0)
  const idRef = useRef(0)
  const pendingImageCountRef = useRef(0)
  const signatureReservedRef = useRef(false)
  const textEditSnapshotRef = useRef(null)
  const canvasTextInputRef = useRef(null)

  const selected = annotations.find(({ id }) => id === selectedId)
  const originalBlocks = analysis?.pages.flatMap(({ blocks }) => blocks) ?? []
  const selectedOriginalBlock = originalBlocks.find(
    ({ blockId }) => blockId === selectedOriginalBlockId,
  )
  const hasSignature = annotations.some(({ type }) => type === AnnotationType.SIGNATURE)
  const hasInvalidText = annotations.some(
    (annotation) => (
      (annotation.type === AnnotationType.TEXT || annotation.type === AnnotationType.COVER)
      && getTextError(annotation, pages[annotation.page - 1])
    ),
  )
  const selectedTextError = (
    selected?.type === AnnotationType.TEXT || selected?.type === AnnotationType.COVER
  )
    ? getTextError(selected, pages[selected.page - 1])
    : ''
  const originalDraftError = originalDraft ? getOriginalDraftError(originalDraft) : ''
  const hasInvalidOriginalText = originalEdits.some(validateOriginalEdit)
    || Boolean(originalMode && (originalDraftError || preflightingOriginalDraft))

  const abortOriginalPreflight = (updateState = true) => {
    preflightVersionRef.current += 1
    const controller = preflightControllerRef.current
    preflightControllerRef.current = null
    controller?.abort()
    if (updateState) {
      setPreflightingOriginalDraft(false)
    }
  }

  const snapshot = () => createHistorySnapshot(
    annotationsRef.current,
    originalEditsRef.current,
  )
  const currentSnapshotKey = semanticSnapshotKey(
    createHistorySnapshot(annotations, originalEdits),
  )

  const restoreSnapshot = (nextSnapshot) => {
    abortOriginalPreflight()
    const restored = createHistorySnapshot(
      nextSnapshot.annotations,
      nextSnapshot.originalEdits,
    )
    annotationsRef.current = restored.annotations
    originalEditsRef.current = restored.originalEdits
    setAnnotations(restored.annotations)
    setOriginalEdits(restored.originalEdits)
    setSelectedId(null)
    setSelectedOriginalBlockId(null)
    setOriginalDraft(null)
  }

  const recordHistory = (before) => {
    setHistory((items) => [
      ...items,
      createHistorySnapshot(before.annotations, before.originalEdits),
    ].slice(-HISTORY_LIMIT))
    setFuture([])
  }

  useEffect(() => {
    const move = (event) => {
      if (!dragRef.current) {
        return
      }
      const drag = dragRef.current
      const page = pages[drag.page - 1]
      if (drag.kind === 'resize') {
        const minimumWidth = 32
        const minimumHeight = 24
        const deltaX = event.clientX - drag.startX
        const deltaY = event.clientY - drag.startY
        const resizeLeft = drag.direction.includes('w')
        const resizeTop = drag.direction.includes('n')
        const resizeRight = drag.direction.includes('e')
        const resizeBottom = drag.direction.includes('s')
        const right = drag.originX + drag.width
        const bottom = drag.originY + drag.height
        const x = resizeLeft
          ? Math.max(0, Math.min(right - minimumWidth, drag.originX + deltaX))
          : drag.originX
        const y = resizeTop
          ? Math.max(0, Math.min(bottom - minimumHeight, drag.originY + deltaY))
          : drag.originY
        const width = resizeLeft
          ? right - x
          : Math.max(minimumWidth, Math.min(page.width - drag.originX, drag.width + (resizeRight ? deltaX : 0)))
        const height = resizeTop
          ? bottom - y
          : Math.max(minimumHeight, Math.min(page.height - drag.originY, drag.height + (resizeBottom ? deltaY : 0)))
        if (x === drag.originX && y === drag.originY && width === drag.width && height === drag.height) return
        drag.moved = true
        setAnnotations((items) => {
          const nextItems = items.map((item) => item.id === drag.id
            ? { ...item, x, y, width, height }
            : item)
          annotationsRef.current = nextItems
          return nextItems
        })
        return
      }
      const nextX = Math.min(
        Math.max(0, drag.originX + event.clientX - drag.startX),
        Math.max(0, page.width - drag.width),
      )
      const nextY = Math.min(
        Math.max(0, drag.originY + event.clientY - drag.startY),
        Math.max(0, page.height - drag.height),
      )
      if (nextX === drag.originX && nextY === drag.originY) {
        return
      }
      drag.moved = true
      setAnnotations((items) => {
        const nextItems = items.map((item) => (
        item.id === drag.id
          ? {
              ...item,
              x: nextX,
              y: nextY,
            }
          : item
        ))
        annotationsRef.current = nextItems
        return nextItems
      })
    }
    const end = () => {
      if (dragRef.current?.moved) {
        recordHistory(dragRef.current.before)
      }
      dragRef.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
    }
  }, [pages])

  useEffect(() => {
    if (editingTextId) {
      canvasTextInputRef.current?.focus()
      canvasTextInputRef.current?.select()
    }
  }, [editingTextId])

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return undefined
    }
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter(({ isIntersecting }) => isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)
      if (visible[0]) {
        setCurrentPage(Number(visible[0].target.dataset.pageNumber))
      }
    }, { rootMargin: '-15% 0px -55%', threshold: [0.1, 0.5, 0.8] })
    for (const element of pageElementsRef.current.values()) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [pages])

  useEffect(() => {
    const reachableUrls = new Set(pendingAssetUrlsRef.current)
    for (const historySnapshot of [
      createHistorySnapshot(annotations, originalEdits),
      ...history,
      ...future,
    ]) {
      for (const annotation of historySnapshot.annotations) {
        if (annotation.previewUrl) {
          reachableUrls.add(annotation.previewUrl)
        }
      }
    }
    for (const url of assetUrlsRef.current) {
      if (!reachableUrls.has(url)) {
        URL.revokeObjectURL(url)
        assetUrlsRef.current.delete(url)
      }
    }
  }, [annotations, originalEdits, history, future])

  useEffect(() => {
    if (currentSnapshotKey === exportBaselineKey) {
      return undefined
    }
    const preventUnload = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [currentSnapshotKey, exportBaselineKey])

  useEffect(() => () => {
    exportControllerRef.current?.abort()
    analysisControllerRef.current?.abort()
    abortOriginalPreflight(false)
    for (const url of assetUrlsRef.current) {
      URL.revokeObjectURL(url)
    }
  }, [])

  const startOriginalAnalysis = () => {
    if (analysisStartedRef.current) {
      return
    }
    analysisStartedRef.current = true
    const controller = new AbortController()
    analysisControllerRef.current = controller
    setAnalysisStatus(OriginalTextStatus.ANALYZING)
    setAnalysisError('')
    void analyzeOriginalText(file, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || analysisControllerRef.current !== controller) {
          return
        }
        setAnalysis(normalizeAnalysis(result))
        setAnalysisStatus(OriginalTextStatus.READY)
      })
      .catch((error) => {
        if (
          error?.name === 'AbortError'
          || controller.signal.aborted
          || analysisControllerRef.current !== controller
        ) {
          return
        }
        if (error?.code === 'NO_EDITABLE_TEXT') {
          setAnalysis({
            documentFingerprint: '',
            pageCount: pages.length,
            pages: pages.map((_, pageIndex) => ({
              pageIndex,
              blocks: [],
              warnings: [],
            })),
          })
          setAnalysisStatus(OriginalTextStatus.READY)
          return
        }
        analysisStartedRef.current = false
        setAnalysisError(
          error?.code
            ? `无法识别原文：${error.message}`
            : '无法识别原文，请稍后重试或继续使用普通编辑工具',
        )
        setAnalysisStatus(OriginalTextStatus.ERROR)
      })
      .finally(() => {
        if (analysisControllerRef.current === controller) {
          analysisControllerRef.current = null
        }
      })
  }

  const toggleOriginalMode = () => {
    if (originalMode) {
      abortOriginalPreflight()
      setOriginalMode(false)
      setSelectedOriginalBlockId(null)
      setOriginalDraft(null)
      return
    }
    setOriginalMode(true)
    setSelectedId(null)
    setMessage(null)
    startOriginalAnalysis()
  }

  const leaveEditor = () => {
    abortOriginalPreflight()
    analysisControllerRef.current?.abort()
    onReset()
  }

  const selectOriginalBlock = (blockId) => {
    const block = originalBlocks.find((item) => item.blockId === blockId)
    if (!block) {
      return
    }
    abortOriginalPreflight()
    const applied = originalEdits.find((edit) => edit.blockId === blockId)
    setCurrentPage(block.pageIndex + 1)
    setSelectedOriginalBlockId(blockId)
    setOriginalDraft(prepareOriginalDraft(
      applied ? {
        ...applied,
        bounds: { ...applied.bounds },
        style: { ...applied.style },
      } : createOriginalEdit(block),
      originalBlocks,
      originalEdits,
    ))
  }

  const updateOriginalDraft = (changes) => {
    abortOriginalPreflight()
    setOriginalDraft((current) => (
      current
        ? prepareOriginalDraft({
            ...current,
            ...changes,
            overflow: false,
            unsupportedCharacters: [],
          }, originalBlocks, originalEdits)
        : current
    ))
  }

  const applyOriginalDraft = async (closeAfterApply = false) => {
    if (
      !originalDraft
      || getOriginalDraftError(originalDraft)
      || preflightControllerRef.current
    ) {
      return
    }
    const draft = cloneHistoryValue(originalDraft)
    const controller = new AbortController()
    const version = preflightVersionRef.current + 1
    preflightVersionRef.current = version
    preflightControllerRef.current = controller
    setPreflightingOriginalDraft(true)
    setMessage(null)
    try {
      const result = await preflightOriginalText(
        file,
        analysis.documentFingerprint,
        [draft],
        controller.signal,
      )
      if (
        controller.signal.aborted
        || preflightControllerRef.current !== controller
        || preflightVersionRef.current !== version
      ) {
        return
      }
      const exact = result?.edits?.find((edit) => (
        edit.blockId === draft.blockId
        && edit.pageIndex === draft.pageIndex
      ))
      if (
        result?.documentFingerprint !== analysis.documentFingerprint
        || !exact
        || typeof exact.overflow !== 'boolean'
        || !Array.isArray(exact.unsupportedCharacters)
        || exact.unsupportedCharacters.some((character) => typeof character !== 'string')
      ) {
        throw new Error('PDF 服务响应格式异常，请稍后重试')
      }
      const checkedDraft = prepareOriginalDraft({
        ...draft,
        overflow: exact.overflow,
        unsupportedCharacters: [...exact.unsupportedCharacters],
      }, originalBlocks, originalEditsRef.current)
      setOriginalDraft(checkedDraft)
      if (getOriginalDraftError(checkedDraft)) {
        return
      }
      recordHistory(snapshot())
      const nextEdits = applyOriginalEdit(
        originalEditsRef.current,
        cloneHistoryValue(checkedDraft),
      )
      originalEditsRef.current = nextEdits
      setOriginalEdits(nextEdits)
      if (closeAfterApply) {
        setSelectedOriginalBlockId(null)
        setOriginalDraft(null)
      }
    } catch (error) {
      if (
        error?.name !== 'AbortError'
        && !controller.signal.aborted
        && preflightControllerRef.current === controller
      ) {
        setMessage({
          type: 'error',
          text: error?.code
            ? error.message
            : 'PDF 服务响应格式异常，请稍后重试',
        })
      }
    } finally {
      if (preflightControllerRef.current === controller) {
        preflightControllerRef.current = null
        setPreflightingOriginalDraft(false)
      }
    }
  }

  const cancelOriginalDraft = () => {
    abortOriginalPreflight()
    setSelectedOriginalBlockId(null)
    setOriginalDraft(null)
  }

  const commit = (nextAnnotations) => {
    recordHistory(snapshot())
    annotationsRef.current = nextAnnotations
    setAnnotations(nextAnnotations)
  }

  const addAnnotation = (type, values = {}) => {
    const page = pages[currentPage - 1]
    const fittedValues = { ...values }
    if (Number.isFinite(values.width) && Number.isFinite(values.height)) {
      if (type === AnnotationType.TEXT || type === AnnotationType.COVER) {
        fittedValues.width = Math.min(values.width, page.width)
        fittedValues.height = Math.min(values.height, page.height)
        fittedValues.baseline = Math.min(values.baseline ?? 0, fittedValues.height)
      } else {
        const scale = Math.min(
          1,
          page.width / values.width,
          page.height / values.height,
        )
        fittedValues.width = values.width * scale
        fittedValues.height = values.height * scale
      }
    }
    const x = Math.min(
      Math.max(0, values.x ?? DEFAULT_POSITION.x),
      Math.max(0, page.width - (fittedValues.width ?? 0)),
    )
    const y = Math.min(
      Math.max(0, values.y ?? DEFAULT_POSITION.y),
      Math.max(0, page.height - (fittedValues.height ?? 0)),
    )
    idRef.current += 1
    const annotation = {
      id: `annotation-${idRef.current}`,
      type,
      page: currentPage,
      ...fittedValues,
      x,
      y,
    }
    commit([...annotationsRef.current, annotation])
    setSelectedId(annotation.id)
    setMessage(null)
  }

  const updateSelected = (changes, record = true) => {
    if (!selectedId) {
      return
    }
    const currentItems = annotationsRef.current
    const current = currentItems.find(({ id }) => id === selectedId)
    const nextChanges = { ...changes }
    if (
      (current.type === AnnotationType.TEXT && changes.text !== undefined)
      || changes.fontSize !== undefined
      || changes.fontFamily !== undefined
      || changes.fontWeight !== undefined
    ) {
      const page = pages[current.page - 1]
      const text = changes.text ?? current.text
      const fontSize = changes.fontSize ?? current.fontSize
      nextChanges.width = getTextWidth(text, fontSize, page.width)
      nextChanges.height = Math.min(fontSize * 1.5, page.height)
      nextChanges.baseline = Math.min(fontSize * 1.125, nextChanges.height)
      nextChanges.x = Math.min(
        current.x,
        Math.max(0, page.width - nextChanges.width),
      )
      nextChanges.y = Math.min(
        current.y,
        Math.max(0, page.height - nextChanges.height),
      )
    }
    if (Object.entries(nextChanges).every(([key, value]) => current[key] === value)) {
      return
    }
    const nextItems = currentItems.map((item) => (
      item.id === selectedId ? { ...item, ...nextChanges } : item
    ))
    if (record) {
      commit(nextItems)
    } else {
      annotationsRef.current = nextItems
      setAnnotations(nextItems)
    }
  }

  const beginCanvasTextEdit = (annotation) => {
    setSelectedId(annotation.id)
    textEditSnapshotRef.current ??= snapshot()
    setEditingTextId(annotation.id)
  }

  const endTextEdit = () => {
    setEditingTextId(null)
    const before = textEditSnapshotRef.current
    textEditSnapshotRef.current = null
    if (
      before
      && semanticSnapshotKey(before) !== semanticSnapshotKey(createHistorySnapshot(
        annotationsRef.current,
        originalEditsRef.current,
      ))
    ) {
      recordHistory(before)
    }
  }

  const removeSelected = () => {
    if (!selectedId) {
      return
    }
    commit(annotationsRef.current.filter(({ id }) => id !== selectedId))
    setSelectedId(null)
  }

  const undo = () => {
    const previous = history.at(-1)
    if (!previous) {
      return
    }
    const current = snapshot()
    setFuture((items) => [current, ...items].slice(0, HISTORY_LIMIT))
    restoreSnapshot(previous)
    setHistory((items) => items.slice(0, -1))
  }

  const redo = () => {
    const next = future[0]
    if (!next) {
      return
    }
    const current = snapshot()
    setHistory((items) => [...items, current].slice(-HISTORY_LIMIT))
    restoreSnapshot(next)
    setFuture((items) => items.slice(1))
  }

  const addImage = async (image) => {
    setMessage(null)
    if (!['image/png', 'image/jpeg'].includes(image?.type)) {
      setMessage({ type: 'error', text: '仅支持 PNG 或 JPG 图片' })
      return
    }
    if (image.size > MAX_IMAGE_BYTES) {
      setMessage({ type: 'error', text: '单张图片不能超过 5MB' })
      return
    }
    const imageCount = annotationsRef.current.filter(
      ({ type }) => type === AnnotationType.IMAGE,
    ).length
    if (imageCount + pendingImageCountRef.current >= 3) {
      setMessage({ type: 'error', text: '最多添加 3 张图片' })
      return
    }
    pendingImageCountRef.current += 1
    const previewUrl = URL.createObjectURL(image)
    assetUrlsRef.current.add(previewUrl)
    pendingAssetUrlsRef.current.add(previewUrl)
    try {
      const dimensions = await new Promise((resolve, reject) => {
        const probe = new Image()
        probe.onload = () => resolve({
          width: probe.naturalWidth,
          height: probe.naturalHeight,
        })
        probe.onerror = reject
        probe.src = previewUrl
      })
      const page = pages[currentPage - 1]
      const scale = Math.min(
        1,
        160 / dimensions.width,
        page.width / dimensions.width,
        page.height / dimensions.height,
      )
      const width = dimensions.width * scale
      addAnnotation(AnnotationType.IMAGE, {
        width,
        height: dimensions.height * scale,
        file: image,
        previewUrl,
      })
    } catch {
      assetUrlsRef.current.delete(previewUrl)
      URL.revokeObjectURL(previewUrl)
      setMessage({ type: 'error', text: '无法读取该图片' })
    } finally {
      pendingAssetUrlsRef.current.delete(previewUrl)
      pendingImageCountRef.current -= 1
    }
  }

  const addSignature = (signature) => {
    if (
      signatureReservedRef.current
      || annotationsRef.current.some(({ type }) => type === AnnotationType.SIGNATURE)
    ) {
      setMessage({ type: 'error', text: '最多添加 1 个签名' })
      return
    }
    signatureReservedRef.current = true
    try {
      const previewUrl = URL.createObjectURL(signature)
      assetUrlsRef.current.add(previewUrl)
      addAnnotation(AnnotationType.SIGNATURE, {
        width: 180,
        height: 64,
        file: signature,
        previewUrl,
      })
      setSignatureOpen(false)
    } finally {
      signatureReservedRef.current = false
    }
  }

  const exportPdf = async () => {
    if (exportControllerRef.current) {
      return
    }
    const controller = new AbortController()
    exportControllerRef.current = controller
    const exportingSnapshot = snapshot()
    setExporting(true)
    setExportStage('validating')
    setMessage(null)
    try {
      if (hasInvalidText) {
        throw new Error('文字内容不能为空')
      }
      setExportStage('merging')
      const operations = exportingSnapshot.annotations.map((annotation) => {
        const page = pages[annotation.page - 1]
        const coordinates = toPdfViewportCoordinates(annotation, page.viewport)
        const operation = {
          type: annotation.type,
          page: annotation.page,
          ...coordinates,
          pageRotation: page.rotation,
        }

        if (annotation.type === AnnotationType.TEXT || annotation.type === AnnotationType.COVER) {
          operation.text = annotation.text
          operation.fontSize = annotation.fontSize
          operation.color = annotation.color
          operation.fontFamily = annotation.fontFamily ?? 'sans'
          operation.fontWeight = annotation.fontWeight ?? 'regular'
          operation.backgroundColor = annotation.backgroundColor
        }
        if (
          annotation.type === AnnotationType.SIGNATURE
          || annotation.type === AnnotationType.IMAGE
        ) {
          operation.file = annotation.file
        }
        return operation
      })
      const blob = await exportPdfLocally({
        pdf: file,
        operations,
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${file.name.replace(/\.pdf$/i, '')}-已填写.pdf`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 100)
      setExportBaselineKey(semanticSnapshotKey(exportingSnapshot))
      setMessage({ type: 'success', text: '导出完成，文件仅在浏览器内处理' })
    } catch (error) {
      if (!controller.signal.aborted) {
        const safeDetails = (
          error?.code
          || error?.message === '文字内容不能为空'
          || /^第 \d+ 页：/.test(error?.message)
        )
        setMessage({
          type: 'error',
          text: safeDetails
            ? `导出失败：${error.message}`
            : '导出失败，请稍后重试',
        })
      }
    } finally {
      if (exportControllerRef.current === controller) {
        exportControllerRef.current = null
        setExporting(false)
        setExportStage(null)
      }
    }
  }

  const moveAnnotationWithKeyboard = (event, annotation) => {
    const directions = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    }
    const direction = directions[event.key]
    if (!direction) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const page = pages[annotation.page - 1]
    const step = event.shiftKey ? 10 : 1
    const x = Math.min(
      Math.max(0, annotation.x + direction[0] * step),
      Math.max(0, page.width - annotation.width),
    )
    const y = Math.min(
      Math.max(0, annotation.y + direction[1] * step),
      Math.max(0, page.height - annotation.height),
    )
    setSelectedId(annotation.id)
    if (x === annotation.x && y === annotation.y) {
      return
    }
    commit(annotationsRef.current.map((item) => (
      item.id === annotation.id ? { ...item, x, y } : item
    )))
  }

  return (
    <main className="editor-screen" style={{ display: isHidden ? 'none' : undefined }}>
      <header className="editor-header">
        <Brand />
        <div className="file-identity">
          <FilePdf weight="fill" />
          <div>
            <h1 className="sr-only">编辑 PDF</h1>
            <strong>{file.name}</strong>
            <span>{pdfDocument.numPages} 页</span>
          </div>
        </div>
        <div className="header-actions">
          <button className="secondary-button" type="button" onClick={leaveEditor}>更换文件</button>
          <button
            className="primary-button export-button"
            type="button"
            disabled={exporting || hasInvalidText || hasInvalidOriginalText}
            onClick={exportPdf}
          >
            {exporting
              ? <><SpinnerGap className="spin" /> {{
                merging: '正在生成 PDF…',
              }[exportStage] ?? '正在生成 PDF…'}</>
              : <><DownloadSimple weight="bold" /> 导出 PDF</>}
          </button>
        </div>
      </header>

      <div className="editor-toolbar" role="toolbar" aria-label="编辑工具栏">
        <div className="tool-group">
          <button
            className="tool-button"
            type="button"
            disabled={originalMode}
            onClick={() => addAnnotation(AnnotationType.TEXT, {
              text: '输入文字',
              fontSize: 16,
              color: '#222222',
              fontFamily: 'sans',
              fontWeight: 'regular',
              width: 160,
              height: 24,
              baseline: 18,
            })}
          >
            <TextT weight="bold" /> 添加文字
          </button>
          <button
            className="tool-button"
            type="button"
            disabled={originalMode}
            onClick={() => addAnnotation(AnnotationType.COVER, {
              text: '输入文字',
              fontSize: 16,
              color: '#222222',
              backgroundColor: '#ffffff',
              fontFamily: 'sans',
              fontWeight: 'regular',
              width: 180,
              height: 30,
              baseline: 21,
            })}
          >
            <TextT weight="bold" /> 遮挡文字
          </button>
          <button
            className="tool-button"
            type="button"
            disabled={originalMode}
            onClick={() => addAnnotation(AnnotationType.CHECKMARK, {
              width: 26,
              height: 26,
            })}
          >
            <Check weight="bold" /> 添加勾选
          </button>
          <button
            className="tool-button"
            type="button"
            disabled={originalMode || hasSignature}
            onClick={(event) => {
              event.currentTarget.focus()
              setSignatureOpen(true)
            }}
          >
            <PencilSimpleLine weight="bold" /> 手写签名
          </button>
          <button
            className="tool-button"
            type="button"
            disabled={originalMode}
            onClick={() => imageInputRef.current?.click()}
          >
            <ImageSquare weight="bold" /> 添加图片
          </button>
          <input
            ref={imageInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/png,image/jpeg"
            aria-label="选择 PNG 或 JPG 图片"
              onChange={(event) => {
                const [image] = event.target.files
                if (image) {
                  void addImage(image)
              }
              event.target.value = ''
            }}
          />
          <div className="tool-group file-tools" aria-label="PDF 文件工具">
            <button className="tool-button" type="button" onClick={() => onTools('merge')}>
              <ArrowsMerge weight="bold" /> 合并 PDF
            </button>
            <button className="tool-button" type="button" onClick={() => onTools('split')}>
              <Scissors weight="bold" /> 拆分 PDF
            </button>
          </div>
        </div>
        <div className="tool-group history-tools">
          <button className="tool-button" type="button" disabled={!history.length} onClick={undo}>
            <ArrowCounterClockwise weight="bold" /> 撤销
          </button>
          <button className="tool-button" type="button" disabled={!future.length} onClick={redo}>
            <ArrowClockwise weight="bold" /> 重做
          </button>
          <button
            className="tool-button danger-tool"
            type="button"
            disabled={!selected}
            onClick={removeSelected}
          >
            <Trash weight="bold" /> 删除所选元素
          </button>
        </div>
      </div>

      {message && (
        <div className={`editor-message ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>
          {message.type === 'success'
            ? <CheckCircle weight="fill" />
            : <X weight="bold" />}
          {message.text}
        </div>
      )}

      <div className="editor-layout">
        <aside className="page-rail" aria-label="PDF 页面">
          <p className="panel-label">页面</p>
          {pages.map((page) => (
            <button
              key={page.pageNumber}
              className={`thumbnail${currentPage === page.pageNumber ? ' is-current' : ''}`}
              type="button"
              aria-label={`第 ${page.pageNumber} 页`}
              onClick={() => {
                setCurrentPage(page.pageNumber)
                document.getElementById(`page-${page.pageNumber}`)?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'start',
                })
              }}
            >
              <span className="thumbnail-paper">
                <PdfThumbnail page={page.page} pageNumber={page.pageNumber} />
              </span>
              <span>{page.pageNumber}</span>
            </button>
          ))}
        </aside>

        <section className="document-stage" aria-label="PDF 编辑画布">
          {pages.map((page) => (
            <article
              key={page.pageNumber}
              ref={(element) => {
                if (element) {
                  pageElementsRef.current.set(page.pageNumber, element)
                } else {
                  pageElementsRef.current.delete(page.pageNumber)
                }
              }}
              id={`page-${page.pageNumber}`}
              data-testid={`page-shell-${page.pageNumber}`}
              data-page-number={page.pageNumber}
              className={`page-shell${samplingCoverId ? ' is-sampling-color' : ''}`}
              style={{ width: page.width, height: page.height }}
              onMouseDown={(event) => {
                setCurrentPage(page.pageNumber)
                if (samplingCoverId) {
                  const canvas = event.currentTarget.querySelector('.pdf-canvas')
                  const bounds = canvas?.getBoundingClientRect()
                  if (!canvas || !bounds) return
                  const x = Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width)
                  const y = Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)
                  const [red, green, blue] = canvas.getContext('2d')?.getImageData(x, y, 1, 1).data ?? []
                  if ([red, green, blue].every(Number.isFinite)) {
                    const backgroundColor = `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`
                    const nextItems = annotationsRef.current.map((item) => (
                      item.id === samplingCoverId ? { ...item, backgroundColor } : item
                    ))
                    commit(nextItems)
                  }
                  setSamplingCoverId(null)
                  setMessage(null)
                  return
                }
                if (originalMode && !event.target.closest('.original-text-block')) {
                  void applyOriginalDraft(true)
                } else if (!originalMode && !event.target.closest('.annotation')) {
                  setSelectedId(null)
                }
              }}
            >
              {Math.abs(page.pageNumber - currentPage) <= 1
                ? (
                  <PdfCanvas
                    page={page.page}
                    pageNumber={page.pageNumber}
                    onRenderError={() => {
                      setMessage({ type: 'error', text: 'PDF 页面渲染失败，请重试' })
                    }}
                  />
                )
                : <div className="pdf-page-placeholder" aria-hidden="true" />}
              <div className={`annotation-layer${originalMode ? ' is-inactive' : ''}`}>
                {annotations
                  .filter(({ page: annotationPage }) => annotationPage === page.pageNumber)
                  .map((annotation) => (
                    <div
                      key={annotation.id}
                      className={`annotation annotation-${annotation.type}${
                        selectedId === annotation.id ? ' is-selected' : ''
                      }`}
                      data-testid={`annotation-${annotation.type}`}
                      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                      aria-label={
                        (annotation.type === AnnotationType.TEXT || annotation.type === AnnotationType.COVER)
                          ? `文字：${annotation.text}`
                          : annotation.type === AnnotationType.CHECKMARK
                            ? '勾选标记'
                            : annotation.type === AnnotationType.SIGNATURE
                              ? '手写签名（视觉标注）'
                              : '插入图片'
                      }
                      style={{
                        left: annotation.x,
                        top: annotation.y,
                        width: annotation.width,
                        height: annotation.height,
                        fontSize: annotation.fontSize,
                        color: annotation.color,
                        backgroundColor: annotation.type === AnnotationType.COVER
                          ? annotation.backgroundColor
                          : undefined,
                        fontFamily: getTextFontFamily(annotation.fontFamily),
                        fontWeight: annotation.fontWeight === 'bold' ? 700 : 400,
                      }}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        if (editingTextId === annotation.id) {
                          return
                        }
                        setCurrentPage(annotation.page)
                        if (selectedId !== annotation.id) {
                          setSelectedId(annotation.id)
                        }
                        dragRef.current = {
                          id: annotation.id,
                          page: annotation.page,
                          startX: event.clientX,
                          startY: event.clientY,
                          originX: annotation.x,
                          originY: annotation.y,
                          width: annotation.width,
                          height: annotation.height,
                          before: snapshot(),
                          moved: false,
                        }
                      }}
                      onDoubleClick={(event) => {
                        if (
                          annotation.type !== AnnotationType.TEXT
                          && annotation.type !== AnnotationType.COVER
                        ) {
                          return
                        }
                        event.preventDefault()
                        event.stopPropagation()
                        beginCanvasTextEdit(annotation)
                      }}
                      onKeyDown={(event) => moveAnnotationWithKeyboard(event, annotation)}
                    >
                      {(annotation.type === AnnotationType.TEXT || annotation.type === AnnotationType.COVER) && (
                        editingTextId === annotation.id
                          ? <input
                              ref={canvasTextInputRef}
                              className="annotation-text-input"
                              aria-label="画布文字内容"
                              maxLength={MAX_TEXT_LENGTH}
                              value={annotation.text}
                              onMouseDown={(event) => event.stopPropagation()}
                              onChange={(event) => updateSelected({ text: event.target.value }, false)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  event.currentTarget.blur()
                                }
                                event.stopPropagation()
                              }}
                              onBlur={endTextEdit}
                            />
                          : annotation.text
                      )}
                      {annotation.type === AnnotationType.COVER && selectedId === annotation.id && [
                        'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw',
                      ].map((direction) => (
                        <button
                          key={direction}
                          className={`cover-resize-handle cover-resize-handle--${direction}`}
                          type="button"
                          aria-label={`调整遮挡框${{
                            n: '上边', ne: '右上角', e: '右边', se: '右下角',
                            s: '下边', sw: '左下角', w: '左边', nw: '左上角',
                          }[direction]}`}
                          onMouseDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            dragRef.current = {
                              kind: 'resize', direction, id: annotation.id, page: annotation.page,
                              startX: event.clientX, startY: event.clientY,
                              originX: annotation.x, originY: annotation.y,
                              width: annotation.width, height: annotation.height,
                              before: snapshot(), moved: false,
                            }
                          }}
                        />
                      ))}
                      {annotation.type === AnnotationType.CHECKMARK && <Check weight="bold" />}
                      {(annotation.type === AnnotationType.SIGNATURE
                        || annotation.type === AnnotationType.IMAGE) && (
                        <img src={annotation.previewUrl} alt="" draggable="false" />
                      )}
                    </div>
                  ))}
              </div>
              {originalMode && analysisStatus === OriginalTextStatus.READY && (
                <OriginalTextLayer
                  viewport={page.viewport}
                  blocks={analysis.pages.find(
                    ({ pageIndex }) => pageIndex === page.pageNumber - 1,
                  )?.blocks ?? []}
                  edits={originalEdits}
                  draft={originalDraft}
                  selectedId={selectedOriginalBlockId}
                  onSelect={selectOriginalBlock}
                  onChange={updateOriginalDraft}
                />
              )}
            </article>
          ))}
        </section>

        <aside className="properties-panel" aria-label="元素属性">
          <p className="panel-label">{originalMode ? '编辑原文' : '元素属性'}</p>
          {originalMode && analysisStatus === OriginalTextStatus.ANALYZING && (
            <div className="original-mode-state" role="status">
              <SpinnerGap className="spin" />
              <p><strong>正在识别可编辑文字</strong><span>文档仅在本次分析中上传处理。</span></p>
            </div>
          )}
          {originalMode && analysisStatus === OriginalTextStatus.ERROR && (
            <div className="original-mode-state is-error" role="alert">
              <X weight="bold" />
              <p>
                <strong>分析未完成</strong>
                <span>{analysisError}</span>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={startOriginalAnalysis}
                >
                  重新分析
                </button>
              </p>
            </div>
          )}
          {originalMode
            && analysisStatus === OriginalTextStatus.READY
            && originalBlocks.length === 0 && (
            <div className="original-mode-state">
              <TextT weight="duotone" />
              <p>
                <strong>没有识别到可编辑文字</strong>
                <span>扫描件或已转曲文字暂不支持，仍可退出后添加内容。</span>
              </p>
            </div>
          )}
          {originalMode
            && analysisStatus === OriginalTextStatus.READY
            && originalBlocks.length > 0
            && !selectedOriginalBlock && (
            <div className="original-mode-state">
              <PencilSimpleLine weight="duotone" />
              <p><strong>选择一段原文</strong><span>双击文字即可直接修改；选中后拖拽边框或四角可调整文本框。</span></p>
            </div>
          )}
          {originalMode && selectedOriginalBlock && originalDraft && (
            <OriginalTextProperties
              block={selectedOriginalBlock}
              draft={originalDraft}
              error={originalDraftError}
              preflighting={preflightingOriginalDraft}
              onChange={updateOriginalDraft}
              onApply={() => applyOriginalDraft()}
              onCancel={cancelOriginalDraft}
            />
          )}
          {!originalMode && !selected && (
            <div className="empty-properties">
              <PencilSimpleLine weight="duotone" />
              <p><strong>选择一个元素</strong><span>点击画布中的内容后可调整。</span></p>
            </div>
          )}
          {!originalMode && (selected?.type === AnnotationType.TEXT || selected?.type === AnnotationType.COVER) && (
            <div className="property-fields">
              <label>
                <span>文字内容</span>
                <textarea
                  aria-label="文字内容"
                  rows="1"
                  maxLength={MAX_TEXT_LENGTH}
                  value={selected.text}
                  onFocus={() => {
                    textEditSnapshotRef.current ??= snapshot()
                  }}
                  onChange={(event) => updateSelected(
                    { text: event.target.value },
                    false,
                  )}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                    }
                  }}
                  onBlur={endTextEdit}
                  aria-invalid={Boolean(selectedTextError)}
                />
                {selectedTextError && (
                  <span className="field-error" role="alert">{selectedTextError}</span>
                )}
              </label>
              <label>
                <span>字号</span>
                <select
                  aria-label="字号"
                  value={selected.fontSize}
                  onChange={(event) => updateSelected({ fontSize: Number(event.target.value) })}
                >
                  {FONT_SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
                </select>
              </label>
              <label>
                <span>字体</span>
                <select
                  aria-label="字体"
                  value={selected.fontFamily ?? 'sans'}
                  onChange={(event) => updateSelected({ fontFamily: event.target.value })}
                >
                  {TEXT_FONT_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <div className="font-style-field">
                <span>文字样式</span>
                <button
                  className={`font-weight-button${selected.fontWeight === 'bold' ? ' is-active' : ''}`}
                  type="button"
                  aria-label="加粗"
                  aria-pressed={selected.fontWeight === 'bold'}
                  onClick={() => updateSelected({
                    fontWeight: selected.fontWeight === 'bold' ? 'regular' : 'bold',
                  })}
                >
                  <strong>B</strong> 加粗
                </button>
              </div>
              <div className="property-field">
                <span>文字颜色</span>
                <span className="color-field">
                  <span
                    className="color-swatch"
                    aria-label="文字颜色"
                    style={{ backgroundColor: selected.color }}
                  />
                  <code>{selected.color.toUpperCase()}</code>
                </span>
                <StandardColorPalette
                  label="文字颜色"
                  value={selected.color}
                  onChange={(color) => updateSelected({ color })}
                />
              </div>
              {selected.type === AnnotationType.COVER && (
                <div className="property-field">
                  <span>遮挡背景颜色</span>
                  <span className="color-field">
                    <span
                      className="color-swatch"
                      aria-label="遮挡背景颜色"
                      style={{ backgroundColor: selected.backgroundColor }}
                    />
                    <code>{selected.backgroundColor.toUpperCase()}</code>
                  </span>
                  <StandardColorPalette
                    label="遮挡背景颜色"
                    value={selected.backgroundColor}
                    onChange={(backgroundColor) => updateSelected({ backgroundColor })}
                  />
                  <button
                    className={`secondary-button sample-color-button${samplingCoverId === selected.id ? ' is-active' : ''}`}
                    type="button"
                    aria-pressed={samplingCoverId === selected.id}
                    onClick={async () => {
                      setSamplingCoverId(selected.id)
                      setMessage({ type: 'success', text: '请用画笔光标点击 PDF 邻近背景取色' })
                    }}
                  >{samplingCoverId === selected.id ? '正在取色…' : '从页面取色'}</button>
                </div>
              )}
            </div>
          )}
          {!originalMode && selected?.type === AnnotationType.CHECKMARK && (
            <div className="selection-summary"><CheckCircle weight="duotone" /><strong>勾选标记</strong><span>拖动即可调整位置。</span></div>
          )}
          {!originalMode && selected?.type === AnnotationType.SIGNATURE && (
            <div className="selection-summary"><PencilSimpleLine weight="duotone" /><strong>手写签名</strong><span>仅作为视觉标注。</span></div>
          )}
          {!originalMode && selected?.type === AnnotationType.IMAGE && (
            <div className="selection-summary"><ImageSquare weight="duotone" /><strong>图片</strong><span>拖动即可调整位置。</span></div>
          )}
        </aside>
      </div>

      {signatureOpen && (
        <SignatureDialog onClose={() => setSignatureOpen(false)} onConfirm={addSignature} />
      )}
    </main>
  )
}

export function App() {
  const [file, setFile] = useState(null)
  const [pdfDocument, setPdfDocument] = useState(null)
  const [pages, setPages] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsMode, setToolsMode] = useState('merge')
  const loadVersionRef = useRef(0)
  const loadingTaskRef = useRef(null)

  useEffect(() => () => {
    loadVersionRef.current += 1
    const loadingTask = loadingTaskRef.current
    loadingTaskRef.current = null
    destroyPdfLoadingTask(loadingTask)
  }, [])

  const loadPdf = async (nextFile) => {
    setError('')
    if (
      nextFile.type !== 'application/pdf'
      && !nextFile.name.toLowerCase().endsWith('.pdf')
    ) {
      setError('请选择 PDF 文件')
      return
    }
    if (nextFile.size > MAX_PDF_BYTES) {
      setError('PDF 不能超过 30MB')
      return
    }

    const version = loadVersionRef.current + 1
    loadVersionRef.current = version
    const previousLoadingTask = loadingTaskRef.current
    loadingTaskRef.current = null
    destroyPdfLoadingTask(previousLoadingTask)
    setLoading(true)
    let candidateLoadingTask
    try {
      const bytes = await nextFile.arrayBuffer()
      if (version !== loadVersionRef.current) {
        return
      }
      const loadingTask = getDocument({ data: new Uint8Array(bytes) })
      candidateLoadingTask = loadingTask
      loadingTaskRef.current = loadingTask
      const document = await loadingTask.promise
      if (version !== loadVersionRef.current) {
        if (loadingTaskRef.current === loadingTask) {
          loadingTaskRef.current = null
        }
        destroyPdfLoadingTask(loadingTask)
        return
      }
      if (document.numPages > 100) {
        loadingTaskRef.current = null
        destroyPdfLoadingTask(loadingTask)
        setError('PDF 不能超过 100 页')
        return
      }
      const nextPages = await Promise.all(
        Array.from({ length: document.numPages }, async (_, index) => {
          const page = await document.getPage(index + 1)
          const viewport = page.getViewport({ scale: 1 })
          return {
            page,
            pageNumber: index + 1,
            width: viewport.width,
            height: viewport.height,
            viewport,
            transform: [...viewport.transform],
            view: [...page.view],
            rotation: page.rotate,
          }
        }),
      )
      if (version !== loadVersionRef.current) {
        if (loadingTaskRef.current === loadingTask) {
          loadingTaskRef.current = null
        }
        destroyPdfLoadingTask(loadingTask)
        return
      }
      setFile(nextFile)
      setPdfDocument(document)
      setPages(nextPages)
    } catch {
      if (loadingTaskRef.current === candidateLoadingTask) {
        loadingTaskRef.current = null
      }
      destroyPdfLoadingTask(candidateLoadingTask)
      if (version === loadVersionRef.current) {
        setError('无法读取该 PDF，请检查文件是否损坏')
      }
    } finally {
      if (version === loadVersionRef.current) {
        setLoading(false)
      }
    }
  }

  const reset = () => {
    loadVersionRef.current += 1
    const loadingTask = loadingTaskRef.current
    loadingTaskRef.current = null
    setFile(null)
    setPdfDocument(null)
    setPages([])
    setError('')
    destroyPdfLoadingTask(loadingTask)
  }

  const openTools = (mode = 'merge') => {
    setToolsMode(mode)
    setToolsOpen(true)
  }

  if (!file || !pdfDocument) {
    return toolsOpen
      ? <PdfToolsScreen backLabel="返回首页" initialMode={toolsMode} onBack={() => setToolsOpen(false)} />
      : <UploadScreen error={error} loading={loading} onFile={loadPdf} onTools={openTools} />
  }

  return (
    <>
      <EditorScreen
        file={file}
        pdfDocument={pdfDocument}
        pages={pages}
        onReset={reset}
        onTools={openTools}
        isHidden={toolsOpen}
      />
      {toolsOpen && (
        <PdfToolsScreen
          backLabel="返回编辑器"
          initialMode={toolsMode}
          onBack={() => setToolsOpen(false)}
        />
      )}
    </>
  )
}
