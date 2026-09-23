import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { inspectPdf, mergePdfs, parsePageRanges, splitPdf } from '../src/lib/pdf-tools.js'

async function pdfFile(name, pages) {
  const document = await PDFDocument.create()
  Array.from({ length: pages }, () => document.addPage([200, 200]))
  return new File([await document.save()], name, { type: 'application/pdf' })
}

async function pageCount(blob) {
  return (await PDFDocument.load(await blob.arrayBuffer())).getPageCount()
}

describe('PDF 文件工具', () => {
  it('按选择顺序合并 PDF', async () => {
    expect(await pageCount(await mergePdfs([
      await pdfFile('一.pdf', 2),
      await pdfFile('二.pdf', 3),
    ]))).toBe(5)
  })

  it('允许合并四个文件，拒绝第五个', async () => {
    const files = await Promise.all(['一', '二', '三', '四', '五'].map((name) => pdfFile(`${name}.pdf`, 1)))
    expect(await pageCount(await mergePdfs(files.slice(0, 4)))).toBe(4)
    await expect(mergePdfs(files)).rejects.toThrow('一次最多合并 4 个 PDF')
  })

  it('接受 30MB 文件并拒绝更大的文件', async () => {
    const file = await pdfFile('原件.pdf', 1)
    Object.defineProperty(file, 'size', { configurable: true, value: 30 * 1024 * 1024 })
    await expect(inspectPdf(file)).resolves.toBe(1)
    Object.defineProperty(file, 'size', { configurable: true, value: 30 * 1024 * 1024 + 1 })
    await expect(inspectPdf(file)).rejects.toThrow('单个 PDF 不能超过 30MB')
  })

  it('提取逗号分隔的单页和范围', async () => {
    expect(parsePageRanges('1-3, 5, 3', 5)).toEqual([1, 2, 3, 5])
    expect(await pageCount(await splitPdf(await pdfFile('原件.pdf', 6), '2-4, 6'))).toBe(4)
  })

  it('拒绝越界或无效页码格式', () => {
    expect(() => parsePageRanges('0', 3)).toThrow('页码需在 1-3 之间')
    expect(() => parsePageRanges('1;2', 3)).toThrow('页码格式示例')
  })
})
