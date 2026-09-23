// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OriginalTextStatus,
  applyOriginalEdit,
  createOriginalEdit,
  validateOriginalEdit,
} from '../src/lib/original-text.js'
import {
  analyzeOriginalText,
  rewriteOriginalText,
} from '../src/lib/original-text-api.js'

const block = {
  blockId: 'block-1',
  pageIndex: 1,
  text: '创始人手册 AI Native',
  bounds: { x: 72, y: 680, width: 360, height: 64 },
  style: {
    fontFamily: 'SourceHanSerifSC',
    fontSize: 32,
    color: '#111111',
    alignment: 'left',
  },
  fontPolicy: 'original',
  editable: true,
  warnings: [],
}

function pdfFile() {
  return new File(['%PDF-1.7'], '中英混排.pdf', {
    type: 'application/pdf',
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('原文编辑模型', () => {
  it('从分析文字块创建独立的原文修改草稿', () => {
    const edit = createOriginalEdit(block)

    expect(edit).toEqual({
      blockId: 'block-1',
      pageIndex: 1,
      originalText: '创始人手册 AI Native',
      replacementText: '创始人手册 AI Native',
      bounds: { x: 72, y: 680, width: 360, height: 64 },
      style: {
        fontFamily: 'SourceHanSerifSC',
        fontSize: 32,
        color: '#111111',
        alignment: 'left',
      },
      unsupportedCharacters: [],
      overflow: false,
    })
    expect(edit.bounds).not.toBe(block.bounds)
    expect(edit.style).not.toBe(block.style)
  })

  it('暴露完整的原文编辑生命周期状态', () => {
    expect(Object.values(OriginalTextStatus)).toEqual([
      'idle',
      'analyzing',
      'ready',
      'editing',
      'dirty',
      'rewriting',
      'merging',
      'error',
    ])
  })

  it.each([
    [{ replacementText: '   ' }, '文字内容不能为空'],
    [
      { replacementText: 'PDF 😀', unsupportedCharacters: ['😀'] },
      '暂不支持字符：😀',
    ],
    [
      { replacementText: '过长文字', overflow: true },
      '文字超出原区域，请缩小字号、扩大文本框或缩短内容',
    ],
  ])('拒绝无效原文修改 %#', (change, expected) => {
    expect(validateOriginalEdit({ ...createOriginalEdit(block), ...change }))
      .toBe(expected)
  })

  it.each([
    [{ blockId: null }, 'blockId'],
    [{ pageIndex: -1 }, 'pageIndex'],
    [{ originalText: null }, 'originalText'],
    [{ replacementText: null }, 'replacementText'],
    [{ bounds: { ...block.bounds, x: Number.NaN } }, 'bounds'],
    [{ bounds: { ...block.bounds, width: 0 } }, 'bounds'],
    [{ style: { ...block.style, fontFamily: '   ' } }, 'fontFamily'],
    [{ style: { ...block.style, fontSize: Number.POSITIVE_INFINITY } }, 'fontSize'],
    [{ style: { ...block.style, fontSize: 5 } }, 'fontSize'],
    [{ style: { ...block.style, fontSize: 97 } }, 'fontSize'],
    [{ style: { ...block.style, color: 'red' } }, 'color'],
    [{ style: { ...block.style, alignment: 'justify' } }, 'alignment'],
  ])('拒绝不完整或不可序列化的修改 DTO：%s', (change) => {
    expect(validateOriginalEdit({ ...createOriginalEdit(block), ...change }))
      .not.toBe('')
  })

  it('按文字块替换已应用修改且不改变原数组', () => {
    const first = {
      ...createOriginalEdit(block),
      replacementText: '创业者手册 AI Native',
    }
    const previous = [{ ...first, replacementText: '旧修改' }]

    const result = applyOriginalEdit(previous, first)

    expect(result).toEqual([first])
    expect(previous[0].replacementText).toBe('旧修改')
  })
})

describe('原文编辑 API', () => {
  it('把 PDF 和取消信号发送到分析接口', async () => {
    const analysis = {
      documentFingerprint: 'sha256',
      pageCount: 0,
      pages: [],
    }
    const fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(analysis),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ))
    vi.stubGlobal('fetch', fetch)
    const file = pdfFile()
    const controller = new AbortController()

    await expect(analyzeOriginalText(file, controller.signal))
      .resolves.toEqual(analysis)

    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe('/api/pdf/analyze')
    expect(request.method).toBe('POST')
    expect(request.signal).toBe(controller.signal)
    const uploaded = request.body.get('file')
    expect(uploaded.name).toBe(file.name)
    expect(await uploaded.text()).toBe('%PDF-1.7')
  })

  it('把一条草稿和取消信号发送到精确预检接口', async () => {
    const api = await import('../src/lib/original-text-api.js')
    expect(api.preflightOriginalText).toBeTypeOf('function')
    const response = {
      documentFingerprint: 'fingerprint',
      edits: [{
        blockId: 'block-1',
        pageIndex: 1,
        overflow: false,
        unsupportedCharacters: ['😀'],
      }],
    }
    const fetch = vi.fn().mockResolvedValue(jsonResponse(response))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const edit = {
      ...createOriginalEdit(block),
      replacementText: 'PDF 😀',
    }

    await expect(api.preflightOriginalText(
      pdfFile(),
      'fingerprint',
      [edit],
      controller.signal,
    )).resolves.toEqual(response)

    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe('/api/pdf/preflight')
    expect(request.signal).toBe(controller.signal)
    expect(JSON.parse(request.body.get('edits'))).toEqual({
      documentFingerprint: 'fingerprint',
      edits: [{
        blockId: 'block-1',
        pageIndex: 1,
        originalText: block.text,
        replacementText: 'PDF 😀',
        bounds: block.bounds,
        style: block.style,
      }],
    })
  })

  it('只把成功应用且未溢出的后端字段发送给重写接口', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(
      'rewritten-pdf',
      {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      },
    ))
    vi.stubGlobal('fetch', fetch)
    const validEdit = {
      ...createOriginalEdit(block),
      replacementText: '创业者手册 AI Native',
    }
    const overflowEdit = {
      ...createOriginalEdit({ ...block, blockId: 'block-2' }),
      replacementText: '这是一段放不下的文字',
      overflow: true,
    }
    const applied = applyOriginalEdit([], validEdit)
    const controller = new AbortController()

    const rewritten = await rewriteOriginalText(
      pdfFile(),
      'fingerprint',
      [...applied, overflowEdit],
      controller.signal,
    )

    expect(await rewritten.text()).toBe('rewritten-pdf')
    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe('/api/pdf/rewrite')
    expect(request.signal).toBe(controller.signal)
    expect(JSON.parse(request.body.get('edits'))).toEqual({
      documentFingerprint: 'fingerprint',
      edits: [{
        blockId: 'block-1',
        pageIndex: 1,
        originalText: '创始人手册 AI Native',
        replacementText: '创业者手册 AI Native',
        bounds: { x: 72, y: 680, width: 360, height: 64 },
        style: {
          fontFamily: 'SourceHanSerifSC',
          fontSize: 32,
          color: '#111111',
          alignment: 'left',
        },
      }],
    })
  })

  it('把服务端错误码映射为带页码和下一步的中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        code: 'SOURCE_BLOCK_CHANGED',
        message: 'source changed',
        pageIndex: 1,
        blockId: 'block-1',
      }),
      {
        status: 409,
        headers: { 'content-type': 'application/json' },
      },
    )))

    await expect(rewriteOriginalText(
      pdfFile(),
      'fingerprint',
      [createOriginalEdit(block)],
    )).rejects.toMatchObject({
      message: '第 2 页：原文字块已变化，请重新分析 PDF 后再试',
      code: 'SOURCE_BLOCK_CHANGED',
      pageIndex: 1,
      blockId: 'block-1',
    })
  })

  it.each([
    [
      'ENCRYPTED_PDF',
      'PDF 已加密或需要密码，请先解锁后再试',
    ],
    [
      'NO_EDITABLE_TEXT',
      '未找到可安全修改的横排电子文字，仍可使用普通批注工具',
    ],
  ])('把不支持文件的 %s 映射为可行动提示', async (code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code }),
      {
        status: 422,
        headers: { 'content-type': 'application/json' },
      },
    )))

    await expect(analyzeOriginalText(pdfFile())).rejects.toMatchObject({
      code,
      message,
    })
  })

  it('把明确的 128 项上限错误映射为可行动中文提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: 'TOO_MANY_EDITS' }),
      {
        status: 422,
        headers: { 'content-type': 'application/json' },
      },
    )))

    await expect(rewriteOriginalText(
      pdfFile(),
      'fingerprint',
      [createOriginalEdit(block)],
    )).rejects.toMatchObject({
      code: 'TOO_MANY_EDITS',
      message: '一次最多修改 128 个原文字块，请减少修改后再试',
    })
  })

  it.each([
    [
      'analyze',
      new Response('<html>代理错误</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ],
    [
      'analyze',
      new Response('{broken', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
    [
      'rewrite',
      new Response(JSON.stringify({ code: 'INTERNAL_ERROR' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
  ])('把 %s 的 200 错误页稳定映射为中文协议错误', async (operation, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const request = operation === 'analyze'
      ? analyzeOriginalText(pdfFile())
      : rewriteOriginalText(
          pdfFile(),
          'fingerprint',
          [createOriginalEdit(block)],
        )

    await expect(request).rejects.toMatchObject({
      message: 'PDF 服务响应格式异常，请稍后重试',
      code: 'CLIENT_PROTOCOL_ERROR',
    })
  })

  it('保留请求取消错误供调用方识别', async () => {
    const aborted = new DOMException('aborted', 'AbortError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted))

    await expect(analyzeOriginalText(pdfFile())).rejects.toBe(aborted)
  })

  it('不把 NaN 序列化为 null 发送到重写接口', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('pdf', {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }))
    vi.stubGlobal('fetch', fetch)
    const invalid = {
      ...createOriginalEdit(block),
      bounds: { ...block.bounds, width: Number.NaN },
    }

    await rewriteOriginalText(pdfFile(), 'fingerprint', [invalid])

    expect(JSON.parse(fetch.mock.calls[0][1].body.get('edits'))).toEqual({
      documentFingerprint: 'fingerprint',
      edits: [],
    })
  })
})

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
