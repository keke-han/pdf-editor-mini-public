import { PDFDocument } from 'pdf-lib'

export const MAX_TOOL_FILES = 4
export const MAX_TOOL_FILE_BYTES = 30 * 1024 * 1024
export const MAX_TOOL_PAGES = 100

function assertPdf(file) {
  if (!file || (!(file.type ?? '').includes('pdf') && !file.name.toLowerCase().endsWith('.pdf'))) {
    throw new Error('请选择 PDF 文件')
  }
  if (file.size > MAX_TOOL_FILE_BYTES) throw new Error('单个 PDF 不能超过 30MB')
}

export async function inspectPdf(file) {
  assertPdf(file)
  try {
    const document = await PDFDocument.load(await file.arrayBuffer())
    if (document.getPageCount() > MAX_TOOL_PAGES) throw new Error('单个 PDF 最多 100 页')
    return document.getPageCount()
  } catch (error) {
    if (error instanceof Error && !error.message.startsWith('Failed to parse')) throw error
    throw new Error('无法读取该 PDF，请检查文件是否损坏或已加密')
  }
}

export async function mergePdfs(files) {
  if (files.length < 2) throw new Error('请至少选择两个 PDF')
  if (files.length > MAX_TOOL_FILES) throw new Error(`一次最多合并 ${MAX_TOOL_FILES} 个 PDF`)
  const merged = await PDFDocument.create()
  for (const file of files) {
    const count = await inspectPdf(file)
    const source = await PDFDocument.load(await file.arrayBuffer())
    const pages = await merged.copyPages(source, Array.from({ length: count }, (_, index) => index))
    pages.forEach((page) => merged.addPage(page))
  }
  return new Blob([await merged.save()], { type: 'application/pdf' })
}

export function parsePageRanges(input, pageCount) {
  const ranges = input.split(',').map((item) => item.trim()).filter(Boolean)
  if (!ranges.length) throw new Error('请输入要提取的页码')
  const pages = []
  for (const range of ranges) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(range)
    if (!match) throw new Error('页码格式示例：1-3, 5, 8-10')
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (start < 1 || end < start || end > pageCount) throw new Error(`页码需在 1-${pageCount} 之间`)
    for (let page = start; page <= end; page += 1) {
      if (!pages.includes(page)) pages.push(page)
    }
  }
  return pages
}

export async function splitPdf(file, ranges) {
  const pageCount = await inspectPdf(file)
  const pageNumbers = parsePageRanges(ranges, pageCount)
  const source = await PDFDocument.load(await file.arrayBuffer())
  const output = await PDFDocument.create()
  const pages = await output.copyPages(source, pageNumbers.map((page) => page - 1))
  pages.forEach((page) => output.addPage(page))
  return new Blob([await output.save()], { type: 'application/pdf' })
}
