import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import fontkit from '@pdf-lib/fontkit'
import Busboy from 'busboy'
import {
  PDFDocument,
  PDFName,
  degrees,
  rgb,
} from 'pdf-lib'

import { AnnotationType } from './pdf-form.js'

const FONT_URLS = Object.freeze({
  sans: Object.freeze({
    regular: new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url),
    bold: new URL('../assets/fonts/NotoSansSC-Bold.ttf', import.meta.url),
  }),
  serif: Object.freeze({
    regular: new URL('../assets/fonts/NotoSerifSC-Regular.ttf', import.meta.url),
    bold: new URL('../assets/fonts/NotoSerifSC-Bold.ttf', import.meta.url),
  }),
})
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_FIELD_BYTES = 1024 * 1024
const MAX_PDF_PAGES = 100
const MAX_TEXT_LENGTH = 50
const COORDINATE_EPSILON = 0.000001
const ERROR_MESSAGES = {
  400: '请求格式无效',
  413: '上传内容超出限制',
  415: '不支持的媒体类型',
  429: '请求过于频繁，请稍后再试',
  500: '导出失败',
}

class ExportError extends Error {
  constructor(statusCode) {
    super(ERROR_MESSAGES[statusCode])
    this.statusCode = statusCode
  }
}

class RequestRateLimiter {
  constructor(maximumRequests, windowMilliseconds) {
    this.maximumRequests = maximumRequests
    this.windowMilliseconds = windowMilliseconds
    this.windows = new Map()
  }

  tryAcquire(clientAddress) {
    const now = Date.now()
    const current = this.windows.get(clientAddress)
    if (!current || now - current.startedAt >= this.windowMilliseconds) {
      this.windows.set(clientAddress, { startedAt: now, requestCount: 1 })
      return true
    }
    if (current.requestCount >= this.maximumRequests) {
      return false
    }
    current.requestCount += 1
    return true
  }

  retryAfterSeconds() {
    return Math.ceil(this.windowMilliseconds / 1000)
  }
}

function setHigherPriorityError(current, next) {
  if (!current || next.statusCode === 413) {
    return next
  }
  return current
}

function parseHexColor(value = '#000000') {
  const red = Number.parseInt(value.slice(1, 3), 16) / 255
  const green = Number.parseInt(value.slice(3, 5), 16) / 255
  const blue = Number.parseInt(value.slice(5, 7), 16) / 255
  return rgb(red, green, blue)
}

function getPageRotation(page) {
  return ((page.getRotation().angle % 360) + 360) % 360
}

function getPageUserUnit(page) {
  const value = page.node.get(PDFName.of('UserUnit'))?.asNumber?.() ?? 1
  return Number.isFinite(value) && value > 0 ? value : 1
}

function isPointInsideCropBox(x, y, cropBox) {
  return (
    x >= cropBox.x - COORDINATE_EPSILON
    && x <= cropBox.x + cropBox.width + COORDINATE_EPSILON
    && y >= cropBox.y - COORDINATE_EPSILON
    && y <= cropBox.y + cropBox.height + COORDINATE_EPSILON
  )
}

function isRectangleInsideCropBox(operation, width, height, cropBox) {
  return (
    Number.isFinite(width)
    && Number.isFinite(height)
    && width > 0
    && height > 0
    && isPointInsideCropBox(operation.x, operation.y, cropBox)
    && operation.x + width
      <= cropBox.x + cropBox.width + COORDINATE_EPSILON
    && operation.y + height
      <= cropBox.y + cropBox.height + COORDINATE_EPSILON
  )
}

function getOrientedBox(operation, rotation) {
  if (rotation === 90) {
    return {
      x: operation.x + operation.width,
      y: operation.y,
      width: operation.height,
      height: operation.width,
      angle: 90,
    }
  }
  if (rotation === 180) {
    return {
      x: operation.x + operation.width,
      y: operation.y + operation.height,
      width: operation.width,
      height: operation.height,
      angle: 180,
    }
  }
  if (rotation === 270) {
    return {
      x: operation.x,
      y: operation.y + operation.height,
      width: operation.height,
      height: operation.width,
      angle: 270,
    }
  }
  return {
    x: operation.x,
    y: operation.y,
    width: operation.width,
    height: operation.height,
    angle: 0,
  }
}

function transformOrientedPoint(operation, rotation, x, y) {
  if (rotation === 90) {
    return {
      x: operation.x + operation.width - y,
      y: operation.y + x,
    }
  }
  if (rotation === 180) {
    return {
      x: operation.x + operation.width - x,
      y: operation.y + operation.height - y,
    }
  }
  if (rotation === 270) {
    return {
      x: operation.x + y,
      y: operation.y + operation.height - x,
    }
  }
  return {
    x: operation.x + x,
    y: operation.y + y,
  }
}

async function parseMultipart(request, workDirectory) {
  let parser
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fieldSize: MAX_FIELD_BYTES,
        fields: 1,
        fileSize: MAX_PDF_BYTES + 1,
        files: 6,
        parts: 7,
      },
    })
  } catch {
    throw new ExportError(400)
  }

  const fields = new Map()
  const uploads = new Map()
  const seenUploadNames = new Set()
  const activeFileStreams = new Set()
  const fileJobs = []
  let error
  let fileIndex = 0
  let assetCount = 0

  parser.on('field', (name, value, info) => {
    if (info.valueTruncated) {
      error = setHigherPriorityError(error, new ExportError(413))
      return
    }
    if (name !== 'operations' || fields.has(name)) {
      error = setHigherPriorityError(error, new ExportError(400))
      return
    }
    fields.set(name, value)
  })

  parser.on('file', (name, file, info) => {
    if (seenUploadNames.has(name)) {
      error = setHigherPriorityError(error, new ExportError(400))
    }
    seenUploadNames.add(name)
    activeFileStreams.add(file)

    const isPdf = name === 'pdf'
    if (!isPdf) {
      assetCount += 1
      if (assetCount > 4) {
        error = setHigherPriorityError(error, new ExportError(413))
      }
    }
    const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES
    const path = join(workDirectory, `upload-${fileIndex}`)
    fileIndex += 1

    if (
      (isPdf && info.mimeType !== 'application/pdf')
      || (!isPdf && !['image/png', 'image/jpeg'].includes(info.mimeType))
    ) {
      error = setHigherPriorityError(error, new ExportError(415))
    }

    let size = 0
    let overLimit = false
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > maxBytes) {
          overLimit = true
          callback()
          return
        }
        callback(null, chunk)
      },
    })

    const job = pipeline(file, limiter, createWriteStream(path))
      .then(() => {
        if (overLimit || file.truncated) {
          error = setHigherPriorityError(error, new ExportError(413))
        }
        uploads.set(name, {
          path,
          mimeType: info.mimeType,
        })
      })
      .catch(() => {
        error = setHigherPriorityError(error, new ExportError(500))
      })
      .finally(() => {
        activeFileStreams.delete(file)
      })
    fileJobs.push(job)
  })

  for (const event of ['partsLimit', 'filesLimit', 'fieldsLimit']) {
    parser.on(event, () => {
      error = setHigherPriorityError(error, new ExportError(413))
    })
  }

  const stopParsing = () => {
    error = setHigherPriorityError(error, new ExportError(400))
    for (const file of activeFileStreams) {
      file.destroy()
    }
    if (!parser.destroyed) {
      parser.destroy()
    }
  }
  request.once('aborted', stopParsing)
  request.once('error', stopParsing)

  try {
    await pipeline(request, parser)
  } catch {
    error = setHigherPriorityError(error, new ExportError(400))
  } finally {
    request.off('aborted', stopParsing)
    request.off('error', stopParsing)
    await Promise.allSettled(fileJobs)
  }

  if (error) {
    throw error
  }
  return { fields, uploads }
}

function validateOperations(operations, document, uploads) {
  if (!Array.isArray(operations)) {
    throw new ExportError(400)
  }
  if (operations.some((operation) => !operation || typeof operation !== 'object')) {
    throw new ExportError(400)
  }

  const imageCount = operations.filter(({ type }) => type === AnnotationType.IMAGE).length
  const signatureCount = operations.filter(
    ({ type }) => type === AnnotationType.SIGNATURE,
  ).length
  if (imageCount > 3 || signatureCount > 1) {
    throw new ExportError(413)
  }

  for (const operation of operations) {
    if (
      !operation
      || !Object.values(AnnotationType).includes(operation.type)
      || !Number.isInteger(operation.page)
      || operation.page < 1
      || operation.page > document.getPageCount()
      || !Number.isFinite(operation.x)
      || !Number.isFinite(operation.y)
    ) {
      throw new ExportError(400)
    }

    const page = document.getPage(operation.page - 1)
    const cropBox = page.getCropBox()
    if (!isPointInsideCropBox(operation.x, operation.y, cropBox)) {
      throw new ExportError(400)
    }

    if (operation.type === AnnotationType.TEXT) {
      if (
        typeof operation.text !== 'string'
        || !operation.text.trim()
        || operation.text.length > MAX_TEXT_LENGTH
        || /[\r\n]/.test(operation.text)
        || (operation.fontFamily !== undefined && !Object.hasOwn(FONT_URLS, operation.fontFamily))
        || (operation.fontWeight !== undefined && !['regular', 'bold'].includes(operation.fontWeight))
      ) {
        throw new ExportError(400)
      }
      const hasTextBounds = [
        operation.width,
        operation.height,
        operation.boundsX,
        operation.boundsY,
        operation.boundsWidth,
        operation.boundsHeight,
      ].some((value) => value !== undefined)
      if (hasTextBounds) {
        const bounds = {
          x: operation.boundsX,
          y: operation.boundsY,
        }
        if (
          !isRectangleInsideCropBox(
            bounds,
            operation.boundsWidth,
            operation.boundsHeight,
            cropBox,
          )
          || !Number.isFinite(operation.width)
          || !Number.isFinite(operation.height)
          || Math.abs(operation.width - operation.boundsWidth)
            > COORDINATE_EPSILON
          || Math.abs(operation.height - operation.boundsHeight)
            > COORDINATE_EPSILON
        ) {
          throw new ExportError(400)
        }
      }
    }
    if (
      operation.type === AnnotationType.TEXT
      && (
        (operation.fontSize !== undefined && (
          !Number.isFinite(operation.fontSize)
          || operation.fontSize < 8
          || operation.fontSize > 72
        ))
        || (operation.color !== undefined && !/^#[\da-f]{6}$/i.test(operation.color))
      )
    ) {
      throw new ExportError(400)
    }
    if (
      operation.type === AnnotationType.CHECKMARK
      && !isRectangleInsideCropBox(
        operation,
        operation.width ?? 13,
        operation.height ?? 11,
        cropBox,
      )
    ) {
      throw new ExportError(400)
    }

    if (
      operation.type === AnnotationType.SIGNATURE
      || operation.type === AnnotationType.IMAGE
    ) {
      if (
        !Number.isFinite(operation.width)
        || !Number.isFinite(operation.height)
        || operation.width <= 0
        || operation.height <= 0
        || typeof operation.file !== 'string'
        || !isRectangleInsideCropBox(
          operation,
          operation.width,
          operation.height,
          cropBox,
        )
      ) {
        throw new ExportError(400)
      }

      const file = uploads.get(operation.file)
      if (!file) {
        throw new ExportError(400)
      }
      if (!['image/png', 'image/jpeg'].includes(file.mimeType)) {
        throw new ExportError(415)
      }
    }
  }
}

export function createPdfExportHandler({
  tempRoot = process.env.PDF_EXPORT_TEMP_ROOT || tmpdir(),
  fontUrl,
  fontUrls = FONT_URLS,
  removeDirectory = rm,
  requestsPerMinute = 0,
} = {}) {
  const requestRateLimiter = requestsPerMinute > 0
    ? new RequestRateLimiter(requestsPerMinute, 60 * 1000)
    : null
  const resolvedFontUrls = fontUrl
    ? {
        ...fontUrls,
        sans: { ...fontUrls.sans, regular: fontUrl },
      }
    : fontUrls
  return async function handlePdfExport(request, response) {
        if (request.method !== 'POST') {
          response.statusCode = 405
          response.end('Method Not Allowed')
          return
        }
        if (
          requestRateLimiter
          && !requestRateLimiter.tryAcquire(request.socket.remoteAddress ?? 'unknown')
        ) {
          response.statusCode = 429
          response.setHeader('Content-Type', 'application/json; charset=utf-8')
          response.setHeader('Retry-After', requestRateLimiter.retryAfterSeconds())
          response.end(JSON.stringify({ error: ERROR_MESSAGES[429] }))
          return
        }

        let body
        let contentType
        let statusCode = 200
        let workDirectory

        try {
          await mkdir(tempRoot, { recursive: true })
          workDirectory = await mkdtemp(join(tempRoot, 'pdf-export-'))

          const { fields, uploads } = await parseMultipart(request, workDirectory)
          const pdf = uploads.get('pdf')
          let operations
          try {
            operations = JSON.parse(fields.get('operations'))
          } catch {
            throw new ExportError(400)
          }
          if (!pdf) {
            throw new ExportError(400)
          }

          let document
          try {
            document = await PDFDocument.load(await readFile(pdf.path))
          } catch {
            throw new ExportError(400)
          }
          if (document.getPageCount() > MAX_PDF_PAGES) {
            throw new ExportError(413)
          }
          validateOperations(operations, document, uploads)
          const fonts = new Map()
          if (operations.some(({ type }) => type === AnnotationType.TEXT)) {
            document.registerFontkit(fontkit)
          }

          for (const operation of operations) {
            const page = document.getPage(operation.page - 1)
            const rotation = getPageRotation(page)

            if (operation.type === AnnotationType.TEXT) {
              const userUnit = getPageUserUnit(page)
              const fontFamily = operation.fontFamily ?? 'sans'
              const fontWeight = operation.fontWeight ?? 'regular'
              const fontKey = `${fontFamily}-${fontWeight}`
              if (!fonts.has(fontKey)) {
                fonts.set(
                  fontKey,
                  await document.embedFont(
                    await readFile(resolvedFontUrls[fontFamily][fontWeight]),
                    { subset: false },
                  ),
                )
              }
              page.drawText(operation.text, {
                x: operation.x,
                y: operation.y,
                size: (operation.fontSize ?? 12) / userUnit,
                color: parseHexColor(operation.color),
                font: fonts.get(fontKey),
                rotate: degrees(rotation),
              })
            }

            if (operation.type === AnnotationType.CHECKMARK) {
              const color = rgb(0.1, 0.55, 0.3)
              const width = operation.width ?? 13
              const height = operation.height ?? 11
              const normalizedOperation = { ...operation, width, height }
              const firstStart = transformOrientedPoint(
                normalizedOperation,
                rotation,
                0,
                height * 0.4,
              )
              const middle = transformOrientedPoint(
                normalizedOperation,
                rotation,
                width * 0.35,
                0,
              )
              const secondEnd = transformOrientedPoint(
                normalizedOperation,
                rotation,
                width,
                height,
              )
              page.drawLine({
                start: firstStart,
                end: middle,
                thickness: 2,
                color,
              })
              page.drawLine({
                start: middle,
                end: secondEnd,
                thickness: 2,
                color,
              })
            }

            if (
              operation.type === AnnotationType.SIGNATURE
              || operation.type === AnnotationType.IMAGE
            ) {
              const file = uploads.get(operation.file)
              const bytes = Uint8Array.from(await readFile(file.path))
              let image
              try {
                image = file.mimeType === 'image/png'
                  ? await document.embedPng(bytes)
                  : await document.embedJpg(bytes)
              } catch {
                throw new ExportError(415)
              }

              const box = getOrientedBox(operation, rotation)
              page.drawImage(image, {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                rotate: degrees(box.angle),
              })
            }
          }

          const bytes = await document.save()
          body = Buffer.from(bytes)
          contentType = 'application/pdf'
        } catch (error) {
          statusCode = error instanceof ExportError ? error.statusCode : 500
          body = JSON.stringify({ error: ERROR_MESSAGES[statusCode] })
          contentType = 'application/json; charset=utf-8'
        } finally {
          if (workDirectory) {
            try {
              await removeDirectory(workDirectory, { recursive: true, force: true })
            } catch {
              statusCode = 500
              body = JSON.stringify({ error: ERROR_MESSAGES[500] })
              contentType = 'application/json; charset=utf-8'
            }
          }
        }

        response.statusCode = statusCode
        if (contentType) {
          response.setHeader('Content-Type', contentType)
        }
        response.end(body)
  }
}

export function pdfExportPlugin(options = {}) {
  const handler = createPdfExportHandler(options)
  return {
    name: 'pdf-export',
    configureServer(server) {
      server.middlewares.use('/api/export', handler)
    },
  }
}
