import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { exportPdfLocally } from '../src/lib/client-pdf-export.js'

describe('浏览器本地 PDF 导出', () => {
  it('无需网络请求即可把勾选写入 PDF', async () => {
    const source = await PDFDocument.create()
    source.addPage([320, 480])
    const pdf = {
      arrayBuffer: async () => (await source.save()).buffer,
    }

    const result = await exportPdfLocally({
      pdf,
      operations: [{ type: 'check', page: 1, x: 80, y: 200, width: 26, height: 26 }],
    })

    expect(result.type).toBe('application/pdf')
    expect((await PDFDocument.load(await result.arrayBuffer())).getPageCount()).toBe(1)
  })

  it('把遮挡框背景和替换文字一起写入 PDF', async () => {
    const source = await PDFDocument.create()
    source.addPage([320, 480])
    const pdf = {
      arrayBuffer: async () => (await source.save()).buffer,
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url) => new Response(await readFile(
      String(url).includes('.wasm')
        ? new URL('../node_modules/hb-subset-wasm/dist/hb-subset.wasm', import.meta.url)
        : new URL('../src/assets/fonts/NotoSansSC-Regular.ttf', import.meta.url),
    ))
    try {
      const result = await exportPdfLocally({
        pdf,
        operations: [
          {
            type: 'cover', page: 1, x: 80, y: 200, width: 120, height: 30,
            boundsX: 80, boundsY: 180, boundsWidth: 120, boundsHeight: 30,
            text: '替换文字 English 123', fontSize: 16, color: '#222222', backgroundColor: '#ffffff',
            fontFamily: 'sans', fontWeight: 'regular',
          },
          {
            type: 'text', page: 1, x: 80, y: 100, text: '第二段新字',
            fontSize: 16, color: '#222222', fontFamily: 'sans', fontWeight: 'regular',
          },
        ],
      })

      expect(result).toBeInstanceOf(Blob)
      expect(result.size).toBeLessThan(200_000)
      const loadingTask = getDocument({ data: new Uint8Array(await result.arrayBuffer()) })
      try {
        const exportedPage = await (await loadingTask.promise).getPage(1)
        const text = (await exportedPage.getTextContent()).items.map((item) => item.str).join('')
        expect(text).toContain('替换文字 English 123')
        expect(text).toContain('第二段新字')
      } finally {
        await loadingTask.destroy()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
