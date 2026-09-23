import { validateOriginalEdit } from './original-text.js'

const ERROR_MESSAGES = Object.freeze({
  PAYLOAD_TOO_LARGE: 'PDF 文件超过 20MB，请压缩后再试',
  PDF_PAGE_LIMIT_EXCEEDED: 'PDF 超过 100 页，请拆分后再试',
  INVALID_PDF: 'PDF 文件损坏或格式不正确，请更换文件',
  ENCRYPTED_PDF: 'PDF 已加密或需要密码，请先解锁后再试',
  NO_EDITABLE_TEXT: '未找到可安全修改的横排电子文字，仍可使用普通批注工具',
  MISSING_PDF: '未收到 PDF 文件，请重新选择文件',
  DOCUMENT_CHANGED: 'PDF 已变化，请重新分析后再试',
  EDIT_CONFLICT: '多个文字修改相互冲突，请重新分析后再试',
  SOURCE_BLOCK_CHANGED: '原文字块已变化，请重新分析 PDF 后再试',
  TEXT_OVERFLOW: '替换文字超出原区域，请缩短内容或调整字号和文字框',
  UNSUPPORTED_GLYPH: '替换文字包含无法显示的字符，请修改后再试',
  REWRITE_OUTPUT_TOO_LARGE: '修改后的 PDF 超过大小限制，请减少修改后再试',
  REWRITE_VERIFICATION_FAILED: '修改结果校验失败，请重新分析 PDF 后再试',
  PROCESSING_BUSY: 'PDF 服务正在处理其他文件，请稍后再试',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  PROCESSING_TIMEOUT: 'PDF 处理超时，请稍后重试或换用更小的文件',
  PROCESSING_INTERRUPTED: 'PDF 处理已中断，请重新尝试',
  MISSING_EDITS: '没有收到原文修改，请重新应用修改后再试',
  INVALID_EDITS: '原文修改数据无效，请重新分析后再试',
  TOO_MANY_EDITS: '一次最多修改 128 个原文字块，请减少修改后再试',
  INTERNAL_ERROR: 'PDF 处理失败，请稍后重试',
})

const pdfTextApiBaseUrl = (import.meta.env.VITE_PDF_TEXT_API_URL ?? '').replace(/\/$/, '')

function apiUrl(pathname) {
  return `${pdfTextApiBaseUrl}${pathname}`
}

function pagePrefix(pageIndex) {
  return Number.isInteger(pageIndex) ? `第 ${pageIndex + 1} 页：` : ''
}

function protocolError(cause) {
  const error = new Error('PDF 服务响应格式异常，请稍后重试', { cause })
  error.code = 'CLIENT_PROTOCOL_ERROR'
  return error
}

function responseType(response) {
  return response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
}

async function responseError(response) {
  let details = {}
  try {
    details = await response.json()
  } catch {
    details = {}
  }

  const error = new Error(
    `${pagePrefix(details.pageIndex)}${
      ERROR_MESSAGES[details.code] ?? 'PDF 处理失败，请稍后重试'
    }`,
  )
  error.code = details.code ?? 'HTTP_ERROR'
  error.pageIndex = details.pageIndex ?? null
  error.blockId = details.blockId ?? null
  error.status = response.status
  return error
}

async function request(url, form, signal) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    const networkError = new Error('网络连接中断，请检查网络后重试', { cause: error })
    networkError.code = 'NETWORK_ERROR'
    throw networkError
  }

  if (!response.ok) throw await responseError(response)
  return response
}

async function requestJson(url, form, signal) {
  const response = await request(url, form, signal)
  if (responseType(response) !== 'application/json') {
    throw protocolError()
  }
  try {
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw protocolError(error)
  }
}

async function requestPdf(url, form, signal) {
  const response = await request(url, form, signal)
  if (responseType(response) !== 'application/pdf') {
    throw protocolError()
  }
  try {
    return await response.blob()
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw protocolError(error)
  }
}

function rewriteEdit(edit) {
  return {
    blockId: edit.blockId,
    pageIndex: edit.pageIndex,
    originalText: edit.originalText,
    replacementText: edit.replacementText,
    bounds: edit.bounds,
    style: edit.style,
  }
}

export async function analyzeOriginalText(file, signal) {
  const form = new FormData()
  form.append('file', file, file.name)
  return requestJson(apiUrl('/api/pdf/analyze'), form, signal)
}

export async function preflightOriginalText(file, fingerprint, edits, signal) {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('edits', JSON.stringify({
    documentFingerprint: fingerprint,
    edits: edits.map(rewriteEdit),
  }))
  return requestJson(apiUrl('/api/pdf/preflight'), form, signal)
}

export async function rewriteOriginalText(file, fingerprint, edits, signal) {
  const validEdits = edits
    .filter((edit) => !validateOriginalEdit(edit))
    .map(rewriteEdit)
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('edits', JSON.stringify({
    documentFingerprint: fingerprint,
    edits: validEdits,
  }))
  return requestPdf(apiUrl('/api/pdf/rewrite'), form, signal)
}
