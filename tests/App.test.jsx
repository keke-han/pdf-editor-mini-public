// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/App.jsx'

const pdfJs = vi.hoisted(() => ({
  getDocument: vi.fn(),
}))
const clientPdf = vi.hoisted(() => ({
  exportPdfLocally: vi.fn(),
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: pdfJs.getDocument,
}))

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/pdf.worker.min.mjs',
}))

vi.mock('../src/lib/client-pdf-export.js', () => clientPdf)

function createPdfFile(name = '表单.pdf', size) {
  const file = new File(['%PDF-1.7'], name, { type: 'application/pdf' })
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { configurable: true, value: size })
  }
  return file
}

function createImageFile(name = '照片.png', type = 'image/png', size) {
  const file = new File(['image'], name, { type })
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { configurable: true, value: size })
  }
  return file
}

function createPdfDocument(pageCount = 2, {
  width = 600,
  height = 800,
  rotation = 0,
  renderPromiseFactory = () => Promise.resolve(),
} = {}) {
  const renderTasks = []
  const document = {
    renderTasks,
    numPages: pageCount,
    getPage: vi.fn(async (pageNumber) => ({
      pageNumber,
      view: [0, 0, width, height],
      rotate: rotation,
      getViewport: ({ scale }) => ({
        width: (rotation === 90 || rotation === 270 ? height : width) * scale,
        height: (rotation === 90 || rotation === 270 ? width : height) * scale,
        rotation,
        transform: rotation === 90
          ? [0, scale, scale, 0, 0, 0]
          : rotation === 180
            ? [-scale, 0, 0, scale, width * scale, 0]
            : rotation === 270
              ? [0, -scale, -scale, 0, height * scale, width * scale]
              : [scale, 0, 0, -scale, 0, height * scale],
        viewBox: [0, 0, width, height],
        convertToPdfPoint: (x, y) => (
          rotation === 90
            ? [y / scale, x / scale]
            : rotation === 180
              ? [width - x / scale, y / scale]
              : rotation === 270
                ? [width - y / scale, height - x / scale]
                : [x / scale, height - y / scale]
        ),
        convertToViewportPoint: (x, y) => (
          rotation === 90
            ? [y * scale, x * scale]
            : rotation === 180
              ? [(width - x) * scale, y * scale]
              : rotation === 270
                ? [(height - y) * scale, (width - x) * scale]
                : [x * scale, (height - y) * scale]
        ),
      }),
      render: vi.fn((parameters) => {
        if (parameters.canvas && parameters.canvasContext) {
          throw new Error('PDF.js 6 不能同时接收 canvas 和 canvasContext')
        }
        const task = {
          cancel: vi.fn(),
          promise: renderPromiseFactory(pageNumber),
        }
        renderTasks.push(task)
        return task
      }),
    })),
  }
  return document
}

function createLoadingTask(documentOrPromise) {
  return {
    promise: Promise.resolve(documentOrPromise),
    destroy: vi.fn(async () => {}),
  }
}

async function uploadPdf(
  file = createPdfFile(),
  pageCount = 2,
  document = createPdfDocument(pageCount),
) {
  const loadingTask = createLoadingTask(document)
  pdfJs.getDocument.mockReturnValue(loadingTask)
  render(<App />)
  fireEvent.change(screen.getByLabelText('选择 PDF 文件'), {
    target: { files: [file] },
  })
  await screen.findByRole('heading', { name: '编辑 PDF' })
  return { document, loadingTask }
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function analysisResponse({
  pages = [
    {
      pageIndex: 0,
      width: 600,
      height: 800,
      rotation: 0,
      blocks: [
        {
          blockId: 'mixed-block',
          text: '创始人手册 AI Native',
          bounds: { x: 72, y: 680, width: 360, height: 64 },
          style: {
            fontFamily: 'Source Han Serif SC',
            fontSize: 32,
            color: '#111111',
            alignment: 'left',
          },
          fontPolicy: 'fallback',
          editable: true,
          warnings: [],
        },
        {
          blockId: 'neighbour-block',
          text: '相邻内容',
          bounds: { x: 450, y: 680, width: 90, height: 64 },
          style: {
            fontFamily: 'Source Han Sans SC',
            fontSize: 16,
            color: '#222222',
            alignment: 'left',
          },
          fontPolicy: 'original',
          editable: true,
          warnings: [],
        },
      ],
      warnings: [],
    },
  ],
} = {}) {
  return {
    documentFingerprint: 'sha256-document',
    pageCount: pages.length,
    pages,
  }
}

function pdfResponse(content) {
  return new Response(content, {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  })
}

function preflightResponse(request, changes = {}) {
  const payload = JSON.parse(request.body.get('edits'))
  return jsonResponse({
    documentFingerprint: payload.documentFingerprint,
    edits: payload.edits.map(({ blockId, pageIndex }) => ({
      blockId,
      pageIndex,
      overflow: false,
      unsupportedCharacters: [],
      ...changes,
    })),
  })
}

function originalTextFetch(analysis = analysisResponse()) {
  return vi.fn((url, request) => {
    if (url === '/api/pdf/analyze') {
      return Promise.resolve(jsonResponse(analysis))
    }
    if (url === '/api/pdf/preflight') {
      return Promise.resolve(preflightResponse(request))
    }
    throw new Error(`unexpected request: ${url}`)
  })
}

async function confirmOriginalDraft() {
  const button = screen.getByRole('button', { name: '应用修改' })
  fireEvent.click(button)
  expect(button).toHaveAttribute('aria-busy', 'true')
  await waitFor(() => expect(button).toHaveAttribute('aria-busy', 'false'))
}

async function applyOriginalText(replacementText = '创业者手册 AI Native') {
  fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
  const block = await screen.findByRole('button', {
    name: '编辑原文：创始人手册 AI Native',
  })
  fireEvent.click(block)
  fireEvent.change(screen.getByLabelText('原文内容'), {
    target: { value: replacementText },
  })
  await confirmOriginalDraft()
  expect(block).toHaveTextContent(replacementText)
  return block
}

const intersectionObservers = []
let blobUrlSequence = 0
let currentBlobUrl

beforeEach(() => {
  clientPdf.exportPdfLocally.mockReset()
  clientPdf.exportPdfLocally.mockResolvedValue(new Blob(['result'], {
    type: 'application/pdf',
  }))
  vi.restoreAllMocks()
  pdfJs.getDocument.mockReset()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    stroke: vi.fn(),
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['png'], { type: 'image/png' }))
  })
  currentBlobUrl = `blob:download-${blobUrlSequence += 1}`
  URL.createObjectURL = vi.fn(() => currentBlobUrl)
  URL.revokeObjectURL = vi.fn()
  intersectionObservers.length = 0
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) {
      this.callback = callback
      this.observe = vi.fn()
      this.disconnect = vi.fn()
      intersectionObservers.push(this)
    }
  })
  vi.stubGlobal('Image', class {
    naturalWidth = 400
    naturalHeight = 200

    set src(_value) {
      queueMicrotask(() => this.onload?.())
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('中文 PDF 编辑器', () => {
  it('公开本地版不提供原文重写，并明确文件只在浏览器内处理', async () => {
    render(<App />)
    expect(screen.getByText('文件仅在当前浏览器内处理，不会上传或保存。')).toBeInTheDocument()
    cleanup()

    await uploadPdf()

    expect(screen.queryByRole('button', { name: '编辑原文' })).not.toBeInTheDocument()
  })

  it('可添加带背景色的遮挡文字框，并可直接选择标准背景色', async () => {
    await uploadPdf()

    fireEvent.click(screen.getByRole('button', { name: '遮挡文字' }))

    expect(screen.getByTestId('annotation-cover')).toHaveTextContent('输入文字')
    expect(screen.getByText('#FFFFFF')).toBeInTheDocument()
    expect(screen.getByLabelText('遮挡背景颜色')).not.toHaveAttribute('type', 'color')
    fireEvent.click(screen.getByRole('button', { name: '选择遮挡背景颜色 #D97656' }))
    expect(screen.getByTestId('annotation-cover')).toHaveStyle({ backgroundColor: '#d97656' })
    const sampler = screen.getByRole('button', { name: '从页面取色' })
    expect(sampler).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(sampler)
    expect(sampler).toHaveAttribute('aria-pressed', 'true')
    expect(sampler).toHaveTextContent('正在取色…')
  })

  it('遮挡文字框可拖动右下角放大并保持尺寸', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '遮挡文字' }))
    const cover = screen.getByTestId('annotation-cover')
    const handle = within(cover).getByLabelText('调整遮挡框右下角')

    fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 160, clientY: 130 })
    fireEvent.mouseUp(window)

    expect(cover).toHaveStyle({ width: '240px', height: '60px' })
  })

  it('导出时只调用浏览器内导出器，不请求公开 API', async () => {
    await uploadPdf(createPdfFile('申请表.pdf'), 1)
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    fireEvent.change(screen.getByLabelText('文字内容'), {
      target: { value: '已填写' },
    })
    const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const request = vi.fn()
    vi.stubGlobal('fetch', request)

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))

    await screen.findByText('导出完成，文件仅在浏览器内处理')
    expect(clientPdf.exportPdfLocally).toHaveBeenCalledWith(expect.objectContaining({
      pdf: expect.objectContaining({ name: '申请表.pdf' }),
      operations: [expect.objectContaining({
        type: 'text',
        page: 1,
        text: '已填写',
        x: 80,
        y: 702,
      })],
    }))
    expect(request).not.toHaveBeenCalled()
    expect(downloadClick).toHaveBeenCalledTimes(1)
  })

  it('首页以独立入口进入本地合并与拆分工具', () => {
    render(<App />)

    expect(screen.getByRole('button', { name: /合并 PDF/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /拆分 PDF/ }))

    expect(screen.getByText('拆分 PDF')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '合并 PDF' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '拆分 PDF' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '提取指定页为新 PDF' })).toBeInTheDocument()
  })

  it('文件工具显示新的单文件大小和合并数量限制', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /合并 PDF/ }))
    expect(screen.getByText('可用上下箭头调整合并顺序，最多 4 个文件。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '返回首页' }))
    fireEvent.click(screen.getByRole('button', { name: /拆分 PDF/ }))
    expect(screen.getByText('单个文件最大 30MB、最多 100 页')).toBeInTheDocument()
  })

  it.each(['合并 PDF', '拆分 PDF'])('从编辑页打开%s再返回时保留未导出的文字', async (tool) => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    fireEvent.change(screen.getByLabelText('文字内容'), {
      target: { value: '待导出的内容' },
    })

    fireEvent.click(screen.getByRole('button', { name: tool }))
    fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))

    expect(screen.getByTestId('annotation-text')).toHaveTextContent('待导出的内容')
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled()
  })

  it('显示上传限制、隐私说明并支持拖拽 PDF', async () => {
    pdfJs.getDocument.mockReturnValue(createLoadingTask(createPdfDocument(2)))
    render(<App />)

    expect(screen.getByRole('heading', { name: '快速编辑 PDF，文件不留存' })).toBeInTheDocument()
    expect(screen.getByText('无需安装 · 无需登录 · 打开即用')).toBeInTheDocument()
    expect(screen.getByText('文件只在浏览器处理，关闭页面即结束本次编辑。')).toBeInTheDocument()
    expect(screen.getByText('最大 30MB · 最多 100 页')).toBeInTheDocument()
    expect(screen.getByText('文件仅在当前浏览器内处理，不会上传或保存。')).toBeInTheDocument()

    fireEvent.drop(screen.getByTestId('pdf-dropzone'), {
      dataTransfer: { files: [createPdfFile()] },
    })

    expect(await screen.findByRole('heading', { name: '编辑 PDF' })).toBeInTheDocument()
    expect(pdfJs.getDocument).toHaveBeenCalledTimes(1)
  })

  it('拒绝错误格式、超过 30MB 或超过 100 页的 PDF', async () => {
    const { unmount } = render(<App />)
    fireEvent.change(screen.getByLabelText('选择 PDF 文件'), {
      target: { files: [new File(['text'], '说明.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('请选择 PDF 文件')

    fireEvent.change(screen.getByLabelText('选择 PDF 文件'), {
      target: { files: [createPdfFile('过大.pdf', 30 * 1024 * 1024 + 1)] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF 不能超过 30MB')

    unmount()
    pdfJs.getDocument.mockReturnValue(createLoadingTask(createPdfDocument(101)))
    render(<App />)
    fireEvent.change(screen.getByLabelText('选择 PDF 文件'), {
      target: { files: [createPdfFile('页数过多.pdf')] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF 不能超过 100 页')
  })

  it('用 PDF.js 渲染多页预览并提供四类编辑工具', async () => {
    await uploadPdf(createPdfFile(), 3, createPdfDocument(3))

    expect(screen.getByRole('button', { name: '第 1 页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 2 页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 3 页' })).toBeInTheDocument()
    expect(screen.getAllByTestId('pdf-page-canvas')).toHaveLength(2)
    expect(screen.getAllByTestId('pdf-thumbnail-canvas')).toHaveLength(3)
    expect(screen.getByLabelText('第 1 页缩略图')).toHaveStyle({
      width: '61.5px',
      height: '82px',
    })
    expect(screen.getByRole('button', { name: '添加文字' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加勾选' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '手写签名' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加图片' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '合并 PDF' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拆分 PDF' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '合并 / 拆分' })).not.toBeInTheDocument()
  })

  it('添加文字并编辑内容、字号和标准颜色', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))

    const properties = screen.getByRole('complementary', { name: '元素属性' })
    fireEvent.change(within(properties).getByLabelText('文字内容'), {
      target: { value: '张三' },
    })
    fireEvent.change(within(properties).getByLabelText('字号'), {
      target: { value: '18' },
    })
    fireEvent.click(within(properties).getByRole('button', { name: '选择文字颜色 #2563EB' }))

    const annotation = screen.getByTestId('annotation-text')
    expect(annotation).toHaveTextContent('张三')
    expect(annotation).toHaveStyle({ fontSize: '18px', color: '#2563eb' })
  })

  it('长文字同步扩展并夹紧预览，多行和过长内容阻止导出', async () => {
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    const input = screen.getByLabelText('文字内容')
    const annotation = screen.getByTestId('annotation-text')
    expect(input).toHaveAttribute('maxlength', '50')

    fireEvent.mouseDown(annotation, { clientX: 80, clientY: 80 })
    fireEvent.mouseMove(window, { clientX: 1000, clientY: 80 })
    fireEvent.mouseUp(window)
    fireEvent.change(input, { target: { value: '文'.repeat(31) } })
    expect(annotation).toHaveStyle({ left: '92px', width: '508px' })

    fireEvent.change(input, { target: { value: '第一行\n第二行' } })
    expect(screen.getByRole('alert')).toHaveTextContent('文字内容仅支持单行')
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeDisabled()

    fireEvent.change(input, { target: { value: '文'.repeat(51) } })
    expect(screen.getByRole('alert')).toHaveTextContent('文字不能超过 50 个字符')
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeDisabled()
  })

  it('可选中拖拽、删除元素并撤销', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))

    const annotation = screen.getByTestId('annotation-check')
    fireEvent.mouseDown(annotation, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 150, clientY: 130 })
    fireEvent.mouseUp(window)
    expect(annotation).toHaveStyle({ left: '130px', top: '110px' })

    fireEvent.click(screen.getByRole('button', { name: '删除所选元素' }))
    expect(screen.queryByTestId('annotation-check')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByTestId('annotation-check')).toHaveStyle({
      left: '130px',
      top: '110px',
    })
  })

  it('用鼠标绘制签名并声明其仅为视觉标注', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '手写签名' }))

    expect(screen.getByText(/仅作为文档视觉标注/)).toBeInTheDocument()
    const canvas = screen.getByLabelText('签名画布')
    fireEvent.mouseDown(canvas, { clientX: 12, clientY: 18 })
    fireEvent.mouseMove(canvas, { clientX: 64, clientY: 34 })
    fireEvent.mouseUp(canvas)
    fireEvent.click(screen.getByRole('button', { name: '使用此签名' }))

    expect(screen.getByTestId('annotation-signature')).toBeInTheDocument()
  })

  it('图片只接受 PNG/JPG、单张不超过 5MB 且最多 3 张', async () => {
    await uploadPdf()
    const imageInput = screen.getByLabelText('选择 PNG 或 JPG 图片')

    fireEvent.change(imageInput, {
      target: { files: [createImageFile('动画.gif', 'image/gif')] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('仅支持 PNG 或 JPG 图片')

    fireEvent.change(imageInput, {
      target: { files: [createImageFile('过大.png', 'image/png', 5 * 1024 * 1024 + 1)] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('单张图片不能超过 5MB')

    for (let index = 0; index < 3; index += 1) {
      fireEvent.change(imageInput, {
        target: { files: [createImageFile(`照片-${index}.png`)] },
      })
    }
    expect(await screen.findAllByTestId('annotation-image')).toHaveLength(3)

    fireEvent.change(imageInput, {
      target: { files: [createImageFile('第4张.png')] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('最多添加 3 张图片')
  })

  it.skip('按 PDF 坐标协议导出、触发下载并提示临时文件已删除', async () => {
    await uploadPdf(createPdfFile('申请表.pdf'), 1)
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    fireEvent.change(screen.getByLabelText('文字内容'), {
      target: { value: '已填写' },
    })
    fireEvent.change(screen.getByLabelText('字体'), {
      target: { value: 'serif' },
    })
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))

    let resolveFetch
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => fetchPromise))
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    expect(screen.getByRole('button', { name: '正在合并批注…' })).toBeDisabled()

    await act(async () => {
      resolveFetch(new Response(new Blob(['result'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }))
    })

    expect(await screen.findByText('导出完成，临时文件已删除')).toBeInTheDocument()
    expect(downloadClick).toHaveBeenCalledTimes(1)
    const [, request] = fetch.mock.calls[0]
    expect(fetch.mock.calls[0][0]).toBe('/api/export')
    expect(request.method).toBe('POST')
    expect(request.body.get('pdf').name).toBe('申请表.pdf')
    expect(JSON.parse(request.body.get('operations'))).toEqual([
      expect.objectContaining({
        type: 'text',
        page: 1,
        x: 80,
        y: 702,
        text: '已填写',
        fontSize: 16,
        color: '#222222',
        fontFamily: 'serif',
        fontWeight: 'bold',
      }),
    ])
  })

  it.skip('导出期间更换文件会取消请求且旧响应不会触发下载', async () => {
    await uploadPdf(createPdfFile(), 1)
    let resolveFetch
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => fetchPromise))
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    const { signal } = fetch.mock.calls[0][1]
    fireEvent.click(screen.getByRole('button', { name: '更换文件' }))
    expect(screen.getByRole('heading', { name: '快速编辑 PDF，文件不留存' })).toBeInTheDocument()
    expect(signal.aborted).toBe(true)

    await act(async () => {
      resolveFetch(new Response(new Blob(['old-result'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }))
    })
    expect(downloadClick).not.toHaveBeenCalled()
  })

  it.skip('导出失败时只显示安全中文错误', async () => {
    await uploadPdf(createPdfFile(), 1)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new Error('/private/internal/token=secret'),
    ))

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('导出失败，请稍后重试')
    })
    expect(document.body).not.toHaveTextContent('/private/internal')
    expect(document.body).not.toHaveTextContent('secret')
  })

  it('为文字和勾选建立尺寸与基线，空白文字即时阻止导出', async () => {
    await uploadPdf()
    expect(screen.getByRole('toolbar', { name: '编辑工具栏' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    expect(screen.getByTestId('annotation-text')).toHaveStyle({
      width: '160px',
      height: '24px',
    })
    expect(screen.getByTestId('annotation-text')).toHaveAttribute('aria-label', '文字：输入文字')

    fireEvent.change(screen.getByLabelText('文字内容'), { target: { value: '   ' } })
    expect(screen.getByRole('alert')).toHaveTextContent('文字内容不能为空')
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('文字内容'), { target: { value: '姓名' } })
    expect(screen.queryByText('文字内容不能为空')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))
    expect(screen.getByTestId('annotation-check')).toHaveStyle({
      width: '26px',
      height: '26px',
    })
    expect(screen.getByTestId('annotation-check')).toHaveAttribute('aria-label', '勾选标记')
  })

  it('按图片天然宽高等比建立矩形', async () => {
    await uploadPdf()
    fireEvent.change(screen.getByLabelText('选择 PNG 或 JPG 图片'), {
      target: { files: [createImageFile()] },
    })

    expect(await screen.findByTestId('annotation-image')).toHaveStyle({
      width: '160px',
      height: '80px',
    })
  })

  it('为异步图片加载预留名额，快速选择也不会超过 3 张', async () => {
    const probes = []
    vi.stubGlobal('Image', class {
      naturalWidth = 400
      naturalHeight = 200

      set src(_value) {
        probes.push(this)
      }
    })
    await uploadPdf()
    const input = screen.getByLabelText('选择 PNG 或 JPG 图片')

    for (let index = 0; index < 4; index += 1) {
      fireEvent.change(input, {
        target: { files: [createImageFile(`并发-${index}.png`)] },
      })
    }

    expect(probes).toHaveLength(3)
    expect(screen.getByRole('alert')).toHaveTextContent('最多添加 3 张图片')
    await act(async () => {
      probes.forEach((probe) => probe.onload())
    })
    expect(await screen.findAllByTestId('annotation-image')).toHaveLength(3)
  })

  it('在极小页面内等比缩放图片并夹紧新元素位置', async () => {
    const tinyDocument = createPdfDocument(1, { width: 100, height: 40 })
    await uploadPdf(createPdfFile(), 1, tinyDocument)

    fireEvent.change(screen.getByLabelText('选择 PNG 或 JPG 图片'), {
      target: { files: [createImageFile()] },
    })
    expect(await screen.findByTestId('annotation-image')).toHaveStyle({
      left: '20px',
      top: '0px',
      width: '80px',
      height: '40px',
    })

    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))
    expect(screen.getByTestId('annotation-check')).toHaveStyle({
      left: '74px',
      top: '14px',
    })
  })

  it('删除图片后保留撤销资源，历史淘汰后才释放 Blob URL', async () => {
    await uploadPdf()
    fireEvent.change(screen.getByLabelText('选择 PNG 或 JPG 图片'), {
      target: { files: [createImageFile()] },
    })
    await screen.findByTestId('annotation-image')
    const imageUrl = currentBlobUrl

    fireEvent.click(screen.getByRole('button', { name: '删除所选元素' }))
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(imageUrl)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByTestId('annotation-image')).toBeInTheDocument()
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(imageUrl)

    fireEvent.mouseDown(screen.getByTestId('annotation-image'))
    fireEvent.click(screen.getByRole('button', { name: '删除所选元素' }))
    for (let index = 0; index < 50; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))
    }
    await waitFor(() => {
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(imageUrl)
    })
  })

  it('拖拽按页面和元素尺寸夹紧，空白画布取消选择', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))
    const annotation = screen.getByTestId('annotation-check')

    fireEvent.mouseDown(annotation, { clientX: 80, clientY: 80 })
    fireEvent.mouseMove(window, { clientX: 1000, clientY: 1000 })
    fireEvent.mouseUp(window)
    expect(annotation).toHaveStyle({ left: '574px', top: '774px' })

    fireEvent.mouseDown(screen.getAllByTestId('pdf-page-canvas')[0])
    expect(screen.getByRole('button', { name: '删除所选元素' })).toBeDisabled()
  })

  it('注释支持方向键移动、加速步长和页面边界', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))
    const annotation = screen.getByTestId('annotation-check')
    expect(annotation).toHaveAttribute(
      'aria-keyshortcuts',
      'ArrowUp ArrowDown ArrowLeft ArrowRight',
    )

    annotation.focus()
    fireEvent.keyDown(annotation, { key: 'ArrowRight' })
    expect(annotation).toHaveStyle({ left: '81px' })
    fireEvent.keyDown(annotation, { key: 'ArrowDown', shiftKey: true })
    expect(annotation).toHaveStyle({ top: '90px' })
    for (let index = 0; index < 9; index += 1) {
      fireEvent.keyDown(annotation, { key: 'ArrowLeft', shiftKey: true })
    }
    expect(annotation).toHaveStyle({ left: '0px' })
  })

  it('上传区为键盘焦点提供清晰样式', () => {
    render(<App />)
    const input = screen.getByLabelText('选择 PDF 文件')
    input.focus()

    expect(input).toHaveFocus()
    expect(screen.getByTestId('pdf-dropzone')).toContainElement(input)
  })

  it('点击页面与 IntersectionObserver 同步活动页并只渲染相邻页', async () => {
    await uploadPdf(createPdfFile(), 5)
    expect(screen.getAllByTestId('pdf-page-canvas')).toHaveLength(2)

    fireEvent.mouseDown(screen.getByTestId('page-shell-3'))
    expect(screen.getByRole('button', { name: '第 3 页' })).toHaveClass('is-current')
    expect(screen.getAllByTestId('pdf-page-canvas')).toHaveLength(3)

    const pageFive = screen.getByTestId('page-shell-5')
    act(() => intersectionObservers[0].callback([
      { isIntersecting: true, intersectionRatio: 0.8, target: pageFive },
    ]))
    expect(screen.getByRole('button', { name: '第 5 页' })).toHaveClass('is-current')
    expect(screen.getAllByTestId('pdf-page-canvas')).toHaveLength(2)
  })

  it('签名必须真实移动后才能确认，最多添加一个', async () => {
    await uploadPdf()
    const opener = screen.getByRole('button', { name: '手写签名' })
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: '手写签名' })
    const close = screen.getByRole('button', { name: '关闭签名窗口' })
    expect(close).toHaveFocus()
    const canvas = screen.getByLabelText('签名画布')
    fireEvent.mouseDown(canvas, { clientX: 12, clientY: 18 })
    fireEvent.mouseUp(canvas)
    expect(screen.getByRole('button', { name: '使用此签名' })).toBeDisabled()

    fireEvent.mouseDown(canvas, { clientX: 12, clientY: 18 })
    fireEvent.mouseMove(canvas, { clientX: 64, clientY: 34 })
    fireEvent.mouseUp(canvas)
    fireEvent.click(screen.getByRole('button', { name: '使用此签名' }))
    expect(await screen.findByTestId('annotation-signature')).toHaveAttribute(
      'aria-label',
      '手写签名（视觉标注）',
    )
    expect(opener).toBeDisabled()

    expect(dialog).not.toBeInTheDocument()
  })

  it('签名弹窗约束焦点、Escape 关闭并恢复触发按钮焦点', async () => {
    await uploadPdf()
    const opener = screen.getByRole('button', { name: '手写签名' })
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '手写签名' })
    const close = screen.getByRole('button', { name: '关闭签名窗口' })
    const clear = screen.getByRole('button', { name: '清空' })

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(clear).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '手写签名' })).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('签名确认可用后动态约束首尾焦点，并立即阻止重复确认', async () => {
    const callbacks = []
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callbacks.push(callback)
    })
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '手写签名' }))
    const dialog = screen.getByRole('dialog', { name: '手写签名' })
    const close = screen.getByRole('button', { name: '关闭签名窗口' })
    const canvas = screen.getByLabelText('签名画布')
    fireEvent.mouseDown(canvas, { clientX: 12, clientY: 18 })
    fireEvent.mouseMove(canvas, { clientX: 64, clientY: 34 })
    fireEvent.mouseUp(canvas)
    const confirm = screen.getByRole('button', { name: '使用此签名' })

    close.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(close).toHaveFocus()

    fireEvent.click(confirm)
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(callbacks).toHaveLength(1)
    await act(async () => {
      const blob = new Blob(['png'], { type: 'image/png' })
      callbacks[0](blob)
      callbacks[0](blob)
    })
    expect(await screen.findAllByTestId('annotation-signature')).toHaveLength(1)
  })

  it.skip('导出时把签名和图片的完整坐标、文件名及文件写入 FormData', async () => {
    await uploadPdf(createPdfFile('素材表.pdf'), 1)
    fireEvent.click(screen.getByRole('button', { name: '手写签名' }))
    const canvas = screen.getByLabelText('签名画布')
    fireEvent.mouseDown(canvas, { clientX: 12, clientY: 18 })
    fireEvent.mouseMove(canvas, { clientX: 64, clientY: 34 })
    fireEvent.mouseUp(canvas)
    fireEvent.click(screen.getByRole('button', { name: '使用此签名' }))
    await screen.findByTestId('annotation-signature')

    fireEvent.change(screen.getByLabelText('选择 PNG 或 JPG 图片'), {
      target: { files: [createImageFile('产品图.png')] },
    })
    await screen.findByTestId('annotation-image')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Blob(['result'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    ))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    await screen.findByText('导出完成，临时文件已删除')
    const form = fetch.mock.calls[0][1].body
    const operations = JSON.parse(form.get('operations'))
    expect(operations).toEqual([
      expect.objectContaining({
        type: 'signature',
        x: 80,
        y: 656,
        width: 180,
        height: 64,
        file: 'asset-annotation-1',
      }),
      expect.objectContaining({
        type: 'image',
        x: 80,
        y: 640,
        width: 160,
        height: 80,
        file: 'asset-annotation-2',
      }),
    ])
    expect(form.get('asset-annotation-1')).toBeInstanceOf(File)
    expect(form.get('asset-annotation-1').name).toBe('signature.png')
    expect(form.get('asset-annotation-2')).toBeInstanceOf(File)
    expect(form.get('asset-annotation-2').name).toBe('产品图.png')
  })

  it('只忽略 PDF.js 取消错误，其他渲染失败显示安全中文提示', async () => {
    const renderFailure = Object.assign(new Error('/private/render-secret'), {
      name: 'UnexpectedRenderError',
    })
    const failedDocument = createPdfDocument(1, {
      renderPromiseFactory: () => Promise.reject(renderFailure),
    })
    await uploadPdf(createPdfFile(), 1, failedDocument)

    expect(await screen.findByRole('alert')).toHaveTextContent('PDF 页面渲染失败，请重试')
    expect(document.body).not.toHaveTextContent('/private/render-secret')
  })

  it('PDF.js 主动取消渲染时不显示错误', async () => {
    const cancellation = Object.assign(new Error('cancelled'), {
      name: 'RenderingCancelledException',
    })
    const cancelledDocument = createPdfDocument(1, {
      renderPromiseFactory: () => Promise.reject(cancellation),
    })
    await uploadPdf(createPdfFile(), 1, cancelledDocument)
    await act(async () => {})

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('把一次文字编辑会话合并为一条撤销历史', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    const input = screen.getByLabelText('文字内容')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '姓' } })
    fireEvent.change(input, { target: { value: '姓名' } })
    fireEvent.change(input, { target: { value: '姓名：张三' } })
    fireEvent.blur(input)

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByTestId('annotation-text')).toHaveTextContent('输入文字')
  })

  it('双击新增文字框可在画布内输入，并在失焦后保存为一条撤销历史', async () => {
    await uploadPdf()
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    const annotation = screen.getByTestId('annotation-text')

    fireEvent.doubleClick(annotation)
    const input = screen.getByLabelText('画布文字内容')
    fireEvent.change(input, { target: { value: '姓名：张三' } })
    fireEvent.blur(input)

    expect(annotation).toHaveTextContent('姓名：张三')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(annotation).toHaveTextContent('输入文字')
  })

  it.skip('文字拖到底部后增大字号仍夹紧在页面内并可导出', async () => {
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    const annotation = screen.getByTestId('annotation-text')
    fireEvent.mouseDown(annotation, { clientX: 80, clientY: 80 })
    fireEvent.mouseMove(window, { clientX: 80, clientY: 1000 })
    fireEvent.mouseUp(window)
    expect(annotation).toHaveStyle({ top: '776px' })

    fireEvent.change(screen.getByLabelText('字号'), {
      target: { value: '32' },
    })
    expect(annotation).toHaveStyle({ top: '752px', height: '48px' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Blob(['result'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    ))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    await screen.findByText('导出完成，临时文件已删除')

    const operations = JSON.parse(fetch.mock.calls[0][1].body.get('operations'))
    expect(operations[0]).toMatchObject({
      type: 'text',
      y: 12,
      height: 48,
      fontSize: 32,
    })
  })

  it('签名异步生成期间关闭弹窗，延迟回调不会偷偷添加签名', async () => {
    const callbacks = []
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callbacks.push(callback)
    })
    await uploadPdf()
    const opener = screen.getByRole('button', { name: '手写签名' })
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '手写签名' })
    const canvas = screen.getByLabelText('签名画布')
    fireEvent.mouseDown(canvas, { clientX: 12, clientY: 18 })
    fireEvent.mouseMove(canvas, { clientX: 64, clientY: 34 })
    fireEvent.mouseUp(canvas)
    fireEvent.click(screen.getByRole('button', { name: '使用此签名' }))

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '手写签名' })).not.toBeInTheDocument()
    await act(async () => {
      callbacks[0](new Blob(['png'], { type: 'image/png' }))
    })
    expect(screen.queryByTestId('annotation-signature')).not.toBeInTheDocument()
    expect(opener).toBeEnabled()
  })

  it('并发选择时取消旧 loadingTask 且旧结果不能覆盖新文件', async () => {
    let resolveFirst
    let resolveSecond
    const firstDocument = createPdfDocument(1)
    const secondDocument = createPdfDocument(2)
    const firstTask = {
      promise: new Promise((resolve) => { resolveFirst = resolve }),
      destroy: vi.fn(async () => {}),
    }
    const secondTask = {
      promise: new Promise((resolve) => { resolveSecond = resolve }),
      destroy: vi.fn(async () => {}),
    }
    pdfJs.getDocument.mockReturnValueOnce(firstTask).mockReturnValueOnce(secondTask)
    render(<App />)

    const input = screen.getByLabelText('选择 PDF 文件')
    fireEvent.change(input, { target: { files: [createPdfFile('旧文件.pdf')] } })
    await waitFor(() => expect(pdfJs.getDocument).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { files: [createPdfFile('新文件.pdf')] } })
    await waitFor(() => expect(pdfJs.getDocument).toHaveBeenCalledTimes(2))
    expect(firstTask.destroy).toHaveBeenCalled()

    await act(async () => resolveSecond(secondDocument))
    expect(await screen.findByText('新文件.pdf')).toBeInTheDocument()
    await act(async () => resolveFirst(firstDocument))
    expect(screen.queryByText('旧文件.pdf')).not.toBeInTheDocument()
    expect(firstTask.destroy).toHaveBeenCalledTimes(1)
  })

  it('卸载时只销毁 loadingTask、取消渲染并释放 Blob URL', async () => {
    const { document: pdfDocument, loadingTask } = await uploadPdf()
    fireEvent.change(screen.getByLabelText('选择 PNG 或 JPG 图片'), {
      target: { files: [createImageFile()] },
    })
    await screen.findByTestId('annotation-image')

    cleanup()
    expect(loadingTask.destroy).toHaveBeenCalled()
    expect(pdfDocument.renderTasks.every(({ cancel }) => cancel.mock.calls.length > 0)).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(currentBlobUrl)
  })

  it.skip('下载链接挂入 DOM 并延迟释放，点击未移动不产生历史记录', async () => {
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))
    const annotation = screen.getByTestId('annotation-check')
    fireEvent.mouseDown(annotation, { clientX: 80, clientY: 80 })
    fireEvent.mouseUp(window)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.queryByTestId('annotation-check')).not.toBeInTheDocument()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(new Blob(['result'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    ))
    const attachedDuringClick = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      attachedDuringClick.push(document.body.contains(this))
    })

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    await screen.findByText('导出完成，临时文件已删除')
    expect(attachedDuringClick).toEqual([true])
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(currentBlobUrl)
    await new Promise((resolve) => setTimeout(resolve, 110))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(currentBlobUrl)
  })

  describe.skip('已下线的后端原文编辑', () => {
  it('进入独立原文模式并编辑中英混排文字块的内容和排版', async () => {
    vi.stubGlobal('fetch', originalTextFetch())
    await uploadPdf(createPdfFile(), 1)

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(screen.getByRole('status')).toHaveTextContent('正在识别可编辑文字')

    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    expect(screen.getByRole('button', { name: '添加文字' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加勾选' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '手写签名' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加图片' })).toBeDisabled()

    fireEvent.click(block)
    const properties = screen.getByRole('complementary', { name: '元素属性' })
    expect(within(properties).getByText('原字体不可写入，导出时将使用替代字体'))
      .toBeInTheDocument()
    fireEvent.change(within(properties).getByLabelText('原文内容'), {
      target: { value: '创业者手册 AI Native' },
    })
    fireEvent.change(within(properties).getByLabelText('原文字号'), {
      target: { value: '24' },
    })
    fireEvent.change(within(properties).getByLabelText('原文颜色'), {
      target: { value: '#2563eb' },
    })
    fireEvent.change(within(properties).getByLabelText('原文对齐'), {
      target: { value: 'center' },
    })
    fireEvent.change(within(properties).getByLabelText('文字框宽度'), {
      target: { value: '410' },
    })
    fireEvent.change(within(properties).getByLabelText('文字框高度'), {
      target: { value: '72' },
    })
    expect(block).toHaveTextContent('创业者手册 AI Native')
    expect(block).toHaveStyle({ width: '410px', height: '72px' })

    await confirmOriginalDraft()
    expect(block).toHaveTextContent('创业者手册 AI Native')
    expect(block).toHaveStyle({
      width: '410px',
      height: '72px',
      fontSize: '24px',
      color: '#2563eb',
      textAlign: 'center',
    })

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(screen.queryByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).toHaveTextContent('创业者手册 AI Native')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('原文框可从四边和四角缩放，松手后的尺寸保持在草稿中', async () => {
    vi.stubGlobal('fetch', originalTextFetch())
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))

    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    fireEvent.click(block)

    const handles = [
      '从上边调整文字框尺寸',
      '从右上角调整文字框尺寸',
      '从右边调整文字框尺寸',
      '从右下角调整文字框尺寸',
      '从下边调整文字框尺寸',
      '从左下角调整文字框尺寸',
      '从左边调整文字框尺寸',
      '从左上角调整文字框尺寸',
    ]
    handles.forEach((name) => expect(screen.getByRole('button', { name })).toBeInTheDocument())

    const rightHandle = screen.getByRole('button', { name: '从右边调整文字框尺寸' })
    fireEvent.pointerDown(rightHandle, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 180, clientY: 100 })
    fireEvent.pointerUp(window)
    fireEvent.click(rightHandle)

    expect(block).toHaveStyle({ width: '440px', height: '64px' })
    expect(screen.getByLabelText('文字框宽度')).toHaveValue(440)
    expect(screen.getByLabelText('文字框高度')).toHaveValue(64)
  })

  it('点击原文页面空白处会确认草稿并保留调整过的换行尺寸', async () => {
    vi.stubGlobal('fetch', originalTextFetch())
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))

    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    fireEvent.click(block)
    fireEvent.change(screen.getByLabelText('文字框宽度'), {
      target: { value: '480' },
    })

    expect(block).toHaveStyle({ width: '480px' })
    fireEvent.mouseDown(screen.getByTestId('page-shell-1'))
    await waitFor(() => expect(screen.queryByLabelText('文字框宽度')).not.toBeInTheDocument())
    expect(block).toHaveStyle({ width: '480px' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('未改动的普通单行分析框不会被前端近似算法立即判为溢出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      analysisResponse({
        pages: [{
          pageIndex: 0,
          width: 600,
          height: 800,
          rotation: 0,
          blocks: [{
            blockId: 'ordinary-line',
            text: 'OLD',
            bounds: { x: 72, y: 697.52, width: 25, height: 11.1 },
            style: {
              fontFamily: 'Helvetica',
              fontSize: 12,
              color: '#000000',
              alignment: 'left',
            },
            fontPolicy: 'original',
            editable: true,
            warnings: [],
          }],
          warnings: [],
        }],
      }),
    )))
    await uploadPdf(createPdfFile(), 1)

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const block = await screen.findByRole('button', {
      name: '编辑原文：OLD',
    })
    fireEvent.click(block)

    expect(block).not.toHaveClass('has-overflow')
    expect(screen.getByRole('button', { name: '应用修改' })).toBeEnabled()
    expect(screen.queryByText('文字超出原区域')).not.toBeInTheDocument()
  })

  it('应用前调用精确预检且通过后才保存原文修改', async () => {
    let resolvePreflight
    const fetch = vi.fn((url) => {
      if (url === '/api/pdf/analyze') {
        return Promise.resolve(jsonResponse(analysisResponse()))
      }
      if (url === '/api/pdf/preflight') {
        return new Promise((resolve) => {
          resolvePreflight = resolve
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    fireEvent.click(block)
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '预检后的文字' },
    })

    fireEvent.click(screen.getByRole('button', { name: '应用修改' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch.mock.calls[1][0]).toBe('/api/pdf/preflight')
    expect(screen.getByRole('button', { name: '应用修改' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(block).toHaveTextContent('创始人手册 AI Native')

    fireEvent.click(block)
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '预检后的文字' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用修改' }))
    await act(async () => resolvePreflight(jsonResponse({
      documentFingerprint: 'sha256-document',
      edits: [{
        blockId: 'mixed-block',
        pageIndex: 0,
        overflow: false,
        unsupportedCharacters: [],
      }],
    })))
    expect(block).toHaveTextContent('预检后的文字')
  })

  it('草稿变化会取消进行中的预检且陈旧响应不能保存修改', async () => {
    const preflights = []
    vi.stubGlobal('fetch', vi.fn((url, request) => {
      if (url === '/api/pdf/analyze') {
        return Promise.resolve(jsonResponse(analysisResponse()))
      }
      return new Promise((resolve) => {
        preflights.push({ resolve, signal: request.signal })
      })
    }))
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    fireEvent.click(block)
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '第一次草稿' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用修改' }))
    await waitFor(() => expect(preflights).toHaveLength(1))

    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '第二次草稿' },
    })
    expect(preflights[0].signal.aborted).toBe(true)
    await act(async () => preflights[0].resolve(jsonResponse({
      documentFingerprint: 'sha256-document',
      edits: [{
        blockId: 'mixed-block',
        pageIndex: 0,
        overflow: false,
        unsupportedCharacters: [],
      }],
    })))
    expect(block).toHaveTextContent('第二次草稿')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(block).toHaveTextContent('创始人手册 AI Native')
  })

  it('切换文字块、退出原文模式和卸载都会取消进行中的预检', async () => {
    const preflights = []
    vi.stubGlobal('fetch', vi.fn((url, request) => {
      if (url === '/api/pdf/analyze') {
        return Promise.resolve(jsonResponse(analysisResponse()))
      }
      return new Promise((resolve) => {
        preflights.push({ resolve, signal: request.signal })
      })
    }))
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const first = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    const neighbour = screen.getByRole('button', { name: '编辑原文：相邻内容' })

    fireEvent.click(first)
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '切块前草稿' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用修改' }))
    await waitFor(() => expect(preflights).toHaveLength(1))
    fireEvent.click(neighbour)
    expect(preflights[0].signal.aborted).toBe(true)

    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '退出前草稿' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用修改' }))
    await waitFor(() => expect(preflights).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(preflights[1].signal.aborted).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    fireEvent.click(screen.getByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    }))
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '卸载前草稿' },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用修改' }))
    await waitFor(() => expect(preflights).toHaveLength(3))
    cleanup()
    expect(preflights[2].signal.aborted).toBe(true)
  })

  it('取消只丢弃当前草稿并保留已应用原文修改', async () => {
    vi.stubGlobal('fetch', originalTextFetch())
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    fireEvent.click(block)
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '第一次修改' },
    })
    await confirmOriginalDraft()
    expect(block).toHaveTextContent('第一次修改')

    fireEvent.click(block)
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '未应用草稿' },
    })
    expect(block).toHaveTextContent('未应用草稿')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(block).toHaveTextContent('第一次修改')
    fireEvent.click(block)
    expect(screen.getByLabelText('原文内容')).toHaveValue('第一次修改')
  })

  it('溢出和无效数字显示错误并阻止导出，相交只警告且允许应用', async () => {
    let preflightCount = 0
    vi.stubGlobal('fetch', vi.fn((url, request) => {
      if (url === '/api/pdf/analyze') {
        return Promise.resolve(jsonResponse(analysisResponse()))
      }
      preflightCount += 1
      return Promise.resolve(preflightResponse(request, {
        overflow: preflightCount === 1,
      }))
    }))
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })
    fireEvent.click(block)

    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '这是一段明显无法放进狭窄文字框的超长中英文 PDF content' },
    })
    fireEvent.change(screen.getByLabelText('文字框宽度'), {
      target: { value: '20' },
    })
    expect(screen.queryByText('文字超出原区域')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用修改' })).toBeEnabled()
    await confirmOriginalDraft()
    expect(await screen.findByRole('alert')).toHaveTextContent('文字超出原区域')
    expect(block).toHaveClass('has-overflow')
    expect(screen.getByRole('button', { name: '应用修改' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('文字框宽度'), {
      target: { value: '' },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('请输入有效的文字框尺寸')
    fireEvent.change(screen.getByLabelText('文字框宽度'), {
      target: { value: '480' },
    })
    fireEvent.change(screen.getByLabelText('文字框高度'), {
      target: { value: '64' },
    })
    fireEvent.change(screen.getByLabelText('原文字号'), {
      target: { value: '6' },
    })
    expect(screen.getByText('文字框与其他内容重叠，请确认排版')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用修改' })).toBeEnabled()
    await confirmOriginalDraft()
    await waitFor(() => expect(
      screen.getByRole('button', { name: '导出 PDF' }),
    ).toBeEnabled())
  })

  it('快速切换原文模式只分析一次，扫描件和分析失败仍可退出', async () => {
    let resolveAnalysis
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      resolveAnalysis = resolve
    })))
    await uploadPdf(createPdfFile(), 1)
    const toggle = screen.getByRole('button', { name: '编辑原文' })

    fireEvent.click(toggle)
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => resolveAnalysis(jsonResponse(analysisResponse({ pages: [{
      pageIndex: 0,
      width: 600,
      height: 800,
      rotation: 0,
      blocks: [],
      warnings: [],
    }] }))))
    expect(await screen.findByText('没有识别到可编辑文字')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: '添加文字' })).toBeEnabled()

    cleanup()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret path')))
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法识别原文')
    expect(document.body).not.toHaveTextContent('secret path')
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(screen.getByRole('button', { name: '添加文字' })).toBeEnabled()
  })

  it('瞬时分析失败保留安全提示并允许同一文件快速重试', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 'PROCESSING_BUSY',
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse(analysisResponse()))
    vi.stubGlobal('fetch', fetch)
    await uploadPdf(createPdfFile(), 1)

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PDF 服务正在处理其他文件，请稍后再试',
    )
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }))

    expect(await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('NO_EDITABLE_TEXT 进入稳定不支持状态且不显示重试', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'NO_EDITABLE_TEXT' }),
      {
        status: 422,
        headers: { 'content-type': 'application/json' },
      },
    )))
    await uploadPdf(createPdfFile(), 1)

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))

    expect(await screen.findByText('没有识别到可编辑文字')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新分析' }))
      .not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('更换文件和卸载会取消旧分析并忽略陈旧响应', async () => {
    const requests = []
    vi.stubGlobal('fetch', vi.fn((_url, request) => new Promise((resolve) => {
      requests.push({ resolve, signal: request.signal })
    })))
    const first = await uploadPdf(createPdfFile('旧文件.pdf'), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(requests).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '更换文件' }))
    expect(requests[0].signal.aborted).toBe(true)
    pdfJs.getDocument.mockReturnValue(createLoadingTask(createPdfDocument(1)))
    fireEvent.change(screen.getByLabelText('选择 PDF 文件'), {
      target: { files: [createPdfFile('新文件.pdf')] },
    })
    await screen.findByText('新文件.pdf')
    await act(async () => requests[0].resolve(jsonResponse(analysisResponse())))
    expect(screen.queryByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).not.toBeInTheDocument()
    expect(first.loadingTask.destroy).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(requests).toHaveLength(2)
    cleanup()
    expect(requests[1].signal.aborted).toBe(true)
  })

  it('loadingTask 销毁异步失败也会先退出编辑器并取消分析', async () => {
    const rejectedDestroy = Promise.reject(new Error('destroy failed'))
    rejectedDestroy.catch(() => {})
    const loadingTask = createLoadingTask(createPdfDocument(1))
    loadingTask.destroy.mockReturnValue(rejectedDestroy)
    pdfJs.getDocument.mockReturnValue(loadingTask)
    const requests = []
    vi.stubGlobal('fetch', vi.fn((_url, request) => new Promise((resolve) => {
      requests.push({ resolve, signal: request.signal })
    })))
    render(<App />)
    fireEvent.change(screen.getByLabelText('选择 PDF 文件'), {
      target: { files: [createPdfFile()] },
    })
    await screen.findByRole('heading', { name: '编辑 PDF' })
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))

    fireEvent.click(screen.getByRole('button', { name: '更换文件' }))
    expect(screen.getByRole('heading', { name: '快速编辑 PDF，文件不留存' })).toBeInTheDocument()
    expect(requests[0].signal.aborted).toBe(true)
    expect(loadingTask.destroy).toHaveBeenCalledTimes(1)
    await act(async () => requests[0].resolve(jsonResponse(analysisResponse())))
    expect(screen.queryByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).not.toBeInTheDocument()
  })

  it('分析页索引补到文字块，跨页选择始终使用当前块的独立草稿', async () => {
    const pageStyle = {
      fontFamily: 'Source Han Sans SC',
      fontSize: 18,
      color: '#222222',
      alignment: 'left',
    }
    vi.stubGlobal('fetch', originalTextFetch(analysisResponse({
      pages: [
        {
          pageIndex: 0,
          width: 600,
          height: 800,
          rotation: 0,
          blocks: [{
            blockId: 'page-one',
            text: '第一页姓名',
            bounds: { x: 80, y: 700, width: 160, height: 32 },
            style: pageStyle,
            fontPolicy: 'original',
            editable: true,
            warnings: [],
          }],
          warnings: [],
        },
        {
          pageIndex: 1,
          width: 600,
          height: 800,
          rotation: 0,
          blocks: [{
            blockId: 'page-two',
            text: '第二页日期',
            bounds: { x: 80, y: 700, width: 160, height: 32 },
            style: pageStyle,
            fontPolicy: 'original',
            editable: true,
            warnings: [],
          }],
          warnings: [],
        },
      ],
    })))
    await uploadPdf(createPdfFile(), 2)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const first = await screen.findByRole('button', { name: '编辑原文：第一页姓名' })
    const second = screen.getByRole('button', { name: '编辑原文：第二页日期' })

    fireEvent.click(first)
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '第一页已修改' },
    })
    await confirmOriginalDraft()
    expect(first).toHaveTextContent('第一页已修改')
    fireEvent.click(second)
    expect(screen.getByLabelText('原文内容')).toHaveValue('第二页日期')
    fireEvent.change(screen.getByLabelText('原文内容'), {
      target: { value: '第二页已修改' },
    })
    await confirmOriginalDraft()
    expect(second).toHaveTextContent('第二页已修改')
    expect(first).toHaveTextContent('第一页已修改')
  })

  it.each([
    [90, { left: '20px', top: '10px', width: '40px', height: '30px' }, 'translate(40px, 0px) rotate(90deg)'],
    [180, { left: '560px', top: '20px', width: '30px', height: '40px' }, 'translate(30px, 40px) rotate(180deg)'],
    [270, { left: '740px', top: '560px', width: '40px', height: '30px' }, 'translate(0px, 30px) rotate(270deg)'],
  ])('旋转 %i 度页面保留轴对齐命中框并旋转内部文字', async (
    rotation,
    expectedBounds,
    expectedTransform,
  ) => {
    vi.stubGlobal('fetch', originalTextFetch(analysisResponse({
      pages: [{
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation,
        blocks: [{
          blockId: `rotated-${rotation}`,
          text: `旋转 ${rotation}`,
          bounds: { x: 10, y: 20, width: 30, height: 40 },
          style: {
            fontFamily: 'Source Han Sans SC',
            fontSize: 12,
            color: '#222222',
            alignment: 'left',
          },
          fontPolicy: 'original',
          editable: true,
          warnings: [],
        }],
        warnings: [],
      }],
    })))
    await uploadPdf(
      createPdfFile(`旋转-${rotation}.pdf`),
      1,
      createPdfDocument(1, { rotation }),
    )
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const block = await screen.findByRole('button', { name: `编辑原文：旋转 ${rotation}` })
    expect(block).toHaveStyle(expectedBounds)
    expect(block.querySelector('.original-text-content')).toHaveStyle({
      transform: expectedTransform,
      transformOrigin: '0 0',
    })
  })

  it('重叠判断使用其他文字块已应用的当前边界', async () => {
    const style = {
      fontFamily: 'Source Han Sans SC',
      fontSize: 12,
      color: '#222222',
      alignment: 'left',
    }
    vi.stubGlobal('fetch', originalTextFetch(analysisResponse({
      pages: [{
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        blocks: [
          {
            blockId: 'block-b',
            text: '块 B',
            bounds: { x: 0, y: 680, width: 50, height: 32 },
            style,
            fontPolicy: 'original',
            editable: true,
            warnings: [],
          },
          {
            blockId: 'block-a',
            text: '块 A',
            bounds: { x: 100, y: 680, width: 60, height: 32 },
            style,
            fontPolicy: 'original',
            editable: true,
            warnings: [],
          },
        ],
        warnings: [],
      }],
    })))
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const blockB = await screen.findByRole('button', { name: '编辑原文：块 B' })
    const blockA = screen.getByRole('button', { name: '编辑原文：块 A' })

    fireEvent.click(blockB)
    fireEvent.change(screen.getByLabelText('文字框宽度'), { target: { value: '120' } })
    await confirmOriginalDraft()
    expect(blockB).toHaveStyle({ width: '120px' })
    fireEvent.click(blockA)
    expect(screen.getByText('文字框与其他内容重叠，请确认排版')).toBeInTheDocument()

    fireEvent.click(blockB)
    fireEvent.change(screen.getByLabelText('文字框宽度'), { target: { value: '50' } })
    await confirmOriginalDraft()
    expect(blockB).toHaveStyle({ width: '50px' })
    fireEvent.click(blockA)
    expect(screen.queryByText('文字框与其他内容重叠，请确认排版')).not.toBeInTheDocument()
  })

  it('原文字块键盘聚焦清晰且 Enter 可选择', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(analysisResponse())))
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    const block = await screen.findByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })

    block.focus()
    expect(block).toHaveFocus()
    fireEvent.keyDown(block, { key: 'Enter' })
    expect(screen.getByLabelText('原文内容')).toHaveValue('创始人手册 AI Native')
  })

  it('按真实操作顺序统一撤销重做原文修改和批注，新操作清空重做', async () => {
    vi.stubGlobal('fetch', originalTextFetch())
    await uploadPdf(createPdfFile(), 1)
    await applyOriginalText()
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.queryByTestId('annotation-check')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    expect(screen.getByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).toHaveTextContent('创业者手册 AI Native')

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).toHaveTextContent('创始人手册 AI Native')
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(screen.getByRole('button', {
      name: '编辑原文：创始人手册 AI Native',
    })).toHaveTextContent('创业者手册 AI Native')

    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    expect(screen.getByRole('button', { name: '重做' })).toBeDisabled()
  })

  it('历史快照深拷贝原文边界，后续草稿不会污染撤销和重做', async () => {
    vi.stubGlobal('fetch', originalTextFetch())
    await uploadPdf(createPdfFile(), 1)
    const block = await applyOriginalText()
    fireEvent.change(screen.getByLabelText('文字框宽度'), {
      target: { value: '410' },
    })
    await confirmOriginalDraft()
    expect(block).toHaveStyle({ width: '410px' })
    fireEvent.change(screen.getByLabelText('文字框宽度'), {
      target: { value: '450' },
    })

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(block).toHaveStyle({ width: '360px' })
    fireEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(block).toHaveStyle({ width: '410px' })
  })

  it('先重写原文，再把重写 Blob 交给现有批注导出', async () => {
    let resolveRewrite
    let resolveExport
    vi.stubGlobal('fetch', vi.fn((url, request) => {
      if (url === '/api/pdf/analyze') {
        return Promise.resolve(jsonResponse(analysisResponse()))
      }
      if (url === '/api/pdf/preflight') {
        return Promise.resolve(preflightResponse(request))
      }
      if (url === '/api/pdf/rewrite') {
        return new Promise((resolve) => {
        resolveRewrite = resolve
        })
      }
      if (url === '/api/export') {
        return new Promise((resolve) => {
        resolveExport = resolve
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await uploadPdf(createPdfFile('混合编辑.pdf'), 1)
    await applyOriginalText()
    fireEvent.click(screen.getByRole('button', { name: '编辑原文' }))
    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    expect(screen.getByRole('button', { name: '正在校验原文…' })).toBeDisabled()
    expect(await screen.findByRole('button', { name: '正在替换原文…' })).toBeDisabled()
    await act(async () => resolveRewrite(pdfResponse('rewritten-pdf')))
    expect(await screen.findByRole('button', { name: '正在合并批注…' })).toBeDisabled()

    expect(fetch).toHaveBeenCalledTimes(4)
    expect(fetch.mock.calls[2][0]).toBe('/api/pdf/rewrite')
    expect(fetch.mock.calls[3][0]).toBe('/api/export')
    expect(await fetch.mock.calls[3][1].body.get('pdf').text()).toBe('rewritten-pdf')
    await act(async () => resolveExport(pdfResponse('final-pdf')))
    await screen.findByText('导出完成，临时文件已删除')
  })

  it('原文重写失败时不合并、不下载且保留修改', async () => {
    vi.stubGlobal('fetch', vi.fn((url, request) => {
      if (url === '/api/pdf/analyze') {
        return Promise.resolve(jsonResponse(analysisResponse()))
      }
      if (url === '/api/pdf/preflight') {
        return Promise.resolve(preflightResponse(request))
      }
      return Promise.resolve(new Response(JSON.stringify({
        code: 'REWRITE_VERIFICATION_FAILED',
        pageIndex: 0,
      }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }))
    }))
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    await uploadPdf(createPdfFile(), 1)
    const block = await applyOriginalText()

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('导出失败')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(downloadClick).not.toHaveBeenCalled()
    expect(block).toHaveTextContent('创业者手册 AI Native')
  })

  it('没有原文修改时沿用单阶段批注导出且不请求重写', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pdfResponse('final-pdf')))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await uploadPdf(createPdfFile(), 1)
    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    await screen.findByText('导出完成，临时文件已删除')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('/api/export')
  })

  it('只在当前语义快照不同于最近成功导出基线时阻止离开', async () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pdfResponse('final-pdf')))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await uploadPdf(createPdfFile(), 1)

    fireEvent.click(screen.getByRole('button', { name: '添加勾选' }))
    await waitFor(() => expect(
      addListener.mock.calls.some(([type]) => type === 'beforeunload'),
    ).toBe(true))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }))
    await screen.findByText('导出完成，临时文件已删除')
    await waitFor(() => expect(
      removeListener.mock.calls.some(([type]) => type === 'beforeunload'),
    ).toBe(true))

    const addCount = addListener.mock.calls.filter(([type]) => type === 'beforeunload').length
    fireEvent.click(screen.getByRole('button', { name: '添加文字' }))
    await waitFor(() => expect(
      addListener.mock.calls.filter(([type]) => type === 'beforeunload').length,
    ).toBeGreaterThan(addCount))
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    const cleanEvent = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanEvent)
    expect(cleanEvent.defaultPrevented).toBe(false)
  })

  it('快速双击只启动一次导出，卸载会取消正在重写的请求', async () => {
    const requests = []
    vi.stubGlobal('fetch', vi.fn((url, request) => {
      if (url === '/api/pdf/analyze') {
        return Promise.resolve(jsonResponse(analysisResponse()))
      }
      if (url === '/api/pdf/preflight') {
        return Promise.resolve(preflightResponse(request))
      }
      return new Promise((resolve) => requests.push({ url, request, resolve }))
    }))
    await uploadPdf(createPdfFile(), 1)
    await applyOriginalText()
    const button = screen.getByRole('button', { name: '导出 PDF' })

    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].url).toBe('/api/pdf/rewrite')
    cleanup()
    expect(requests[0].request.signal.aborted).toBe(true)
  })
  })
})
