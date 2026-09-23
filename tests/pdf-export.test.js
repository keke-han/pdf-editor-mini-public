import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { access, readdir, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  degrees,
} from 'pdf-lib'
import { pdfExportPlugin } from '../src/lib/pdf-export.js'
import { toPdfViewportCoordinates } from '../src/lib/pdf-form.js'

let server
let baseUrl
const tempRoot = join(tmpdir(), `pdf-editor-test-${randomUUID()}`)

const PNG_BYTES = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))
const JPEG_BYTES = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
  'base64',
))
const FONT_URL = new URL('../src/assets/fonts/NotoSansSC-Regular.ttf', import.meta.url)

async function createBlankPdf(pageCount = 1) {
  const document = await PDFDocument.create()
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([595, 842])
  }
  return document.save()
}

async function createRotatedCroppedPdf(rotation) {
  const document = await PDFDocument.create()
  const page = document.addPage([320, 240])
  page.setCropBox(40, 30, 220, 160)
  page.setRotation(degrees(rotation))
  return document.save()
}

async function createPdfWithPageOptions({
  cropBox,
  rotation,
  userUnit,
} = {}) {
  const document = await PDFDocument.create()
  const page = document.addPage([320, 240])
  if (cropBox) {
    page.setCropBox(cropBox.x, cropBox.y, cropBox.width, cropBox.height)
  }
  if (rotation !== undefined) {
    page.setRotation(degrees(rotation))
  }
  if (userUnit !== undefined) {
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit))
  }
  return document.save()
}

async function createTextOperationFromViewport(pdfBytes, annotation) {
  const loadingTask = getDocument({ data: Uint8Array.from(pdfBytes) })
  try {
    const document = await loadingTask.promise
    const page = await document.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    return {
      viewport,
      operation: {
        type: 'text',
        page: 1,
        ...toPdfViewportCoordinates(annotation, viewport),
        text: annotation.text,
        fontSize: annotation.fontSize,
      },
    }
  } finally {
    await loadingTask.destroy()
  }
}

function readPageContent(document) {
  const contents = document.getPage(0).node.Contents()
  const entries = contents instanceof PDFArray ? contents.asArray() : [contents]

  return entries
    .map((entry) => document.context.lookup(entry))
    .map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    .join('\n')
}

function readMatrices(content, operator) {
  const number = '(-?\\d+(?:\\.\\d+)?)'
  return [...content.matchAll(new RegExp(
    `${number} ${number} ${number} ${number} ${number} ${number} ${operator}`,
    'g',
  ))].map((match) => match.slice(1).map(Number))
}

function expectMatrix(content, operator, expected) {
  const matrices = readMatrices(content, operator)
  expect(matrices.some((matrix) => (
    matrix.every((value, index) => (
      Math.abs(value - expected[index]) < 0.000001
    ))
  ))).toBe(true)
}

function applyLinearMatrix(matrix, [x, y]) {
  return [
    matrix[0] * x + matrix[2] * y,
    matrix[1] * x + matrix[3] * y,
  ]
}

function expectUprightOnScreen(content, rotation) {
  const pageMatrices = {
    90: [0, 1, 1, 0],
    180: [-1, 0, 0, 1],
    270: [0, -1, -1, 0],
  }
  const pageMatrix = pageMatrices[rotation]
  const [textMatrix] = readMatrices(content, 'Tm')
  const imageMatrices = readMatrices(content, 'cm').filter((matrix) => (
    Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2] - 1) < 0.000001
    && Math.abs(matrix[4]) < 0.000001
    && Math.abs(matrix[5]) < 0.000001
    && (
      Math.abs(matrix[0] - 1) > 0.000001
      || Math.abs(matrix[3] - 1) > 0.000001
    )
  ))

  for (const matrix of [textMatrix, ...imageMatrices]) {
    const screenRight = applyLinearMatrix(
      pageMatrix,
      applyLinearMatrix(matrix, [1, 0]),
    )
    const screenUp = applyLinearMatrix(
      pageMatrix,
      applyLinearMatrix(matrix, [0, 1]),
    )
    expect(screenRight[0]).toBeCloseTo(1)
    expect(screenRight[1]).toBeCloseTo(0)
    expect(screenUp[0]).toBeCloseTo(0)
    expect(screenUp[1]).toBeCloseTo(-1)
  }
  expect(imageMatrices.length).toBeGreaterThanOrEqual(2)
}

async function exportPdf(
  operations,
  images = {},
  targetBaseUrl = baseUrl,
  pdfBytes,
) {
  const form = new FormData()
  form.append(
    'pdf',
    new Blob([pdfBytes ?? await createBlankPdf()], { type: 'application/pdf' }),
    'form.pdf',
  )
  form.append('operations', JSON.stringify(operations))

  for (const [name, file] of Object.entries(images)) {
    form.append(name, file, `${name}.png`)
  }

  return fetch(`${targetBaseUrl}/api/export`, {
    method: 'POST',
    body: form,
  })
}

async function expectExportError(operations, status, error, images = {}) {
  const response = await exportPdf(operations, images)
  await expectErrorResponse(response, status, error)
}

async function expectErrorResponse(response, status, error) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type') ?? '').toContain('application/json')
  await expect(response.json()).resolves.toEqual({ error })
}

async function postChunkedMultipart(parts) {
  const boundary = `pdf-editor-${randomUUID()}`
  const chunks = []

  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: ${disposition}\r\n`
      + `${part.type ? `Content-Type: ${part.type}\r\n` : ''}\r\n`,
    ))
    chunks.push(Buffer.from(part.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))

  return new Promise((resolve, reject) => {
    const target = new URL('/api/export', baseUrl)
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'transfer-encoding': 'chunked',
      },
    }, (response) => {
      const responseChunks = []
      response.on('data', (chunk) => responseChunks.push(chunk))
      response.on('end', () => {
        resolve(new Response(Buffer.concat(responseChunks), {
          status: response.statusCode,
          headers: response.headers,
        }))
      })
    })
    request.on('error', reject)
    for (const chunk of chunks) {
      request.write(chunk)
    }
    request.end()
  })
}

async function waitForTempEntries(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let entries = []

  do {
    entries = await readdir(tempRoot).catch(() => [])
    if (predicate(entries)) {
      return entries
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)

  return entries
}

beforeAll(async () => {
  process.env.PDF_EXPORT_TEMP_ROOT = tempRoot
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
    },
  })
  await server.listen()
  const address = server.httpServer.address()
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await server.close()
  delete process.env.PDF_EXPORT_TEMP_ROOT
  await rm(tempRoot, { recursive: true, force: true })
})

describe('POST /api/export', () => {
  it('限制同一来源在一分钟内的重复导出请求', async () => {
    const isolatedServer = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      logLevel: 'silent',
      configFile: false,
      plugins: [pdfExportPlugin({ requestsPerMinute: 3 })],
      server: { host: '127.0.0.1', port: 0 },
    })
    await isolatedServer.listen()
    const address = isolatedServer.httpServer.address()
    const isolatedBaseUrl = `http://127.0.0.1:${address.port}`

    try {
      for (let index = 0; index < 3; index += 1) {
        expect((await exportPdf([], {}, isolatedBaseUrl)).status).toBe(200)
      }
      const limited = await exportPdf([], {}, isolatedBaseUrl)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('60')
      await expect(limited.json()).resolves.toEqual({ error: '请求过于频繁，请稍后再试' })
    } finally {
      await isolatedServer.close()
    }
  })

  it('把空操作安全地识别为无效请求', async () => {
    await expectExportError([null], 400, '请求格式无效')
  })

  it('按负原点 CropBox 接受合法坐标', async () => {
    const pdfBytes = await createPdfWithPageOptions({
      cropBox: { x: -50, y: -30, width: 200, height: 150 },
    })
    const response = await exportPdf([
      {
        type: 'text',
        page: 1,
        x: -40,
        y: -10,
        text: '合法负坐标',
      },
      {
        type: 'check',
        page: 1,
        x: -30,
        y: 0,
        width: 20,
        height: 20,
      },
    ], {}, baseUrl, pdfBytes)

    expect(response.status).toBe(200)
  })

  it.each([
    {
      name: '裁切区外的文字基线',
      operation: {
        type: 'text',
        page: 1,
        x: -51,
        y: 0,
        text: '越界',
      },
    },
    {
      name: '超出裁切区的矩形',
      operation: {
        type: 'check',
        page: 1,
        x: 140,
        y: 0,
        width: 20,
        height: 20,
      },
    },
    {
      name: '超出裁切区的文字框',
      operation: {
        type: 'text',
        page: 1,
        x: 140,
        y: 0,
        width: 20,
        height: 20,
        text: '越界文字框',
      },
    },
  ])('拒绝 $name', async ({ operation }) => {
    const response = await exportPdf(
      [operation],
      {},
      baseUrl,
      await createPdfWithPageOptions({
        cropBox: { x: -50, y: -30, width: 200, height: 150 },
      }),
    )
    await expectErrorResponse(response, 400, '请求格式无效')
  })

  it.each([
    123,
    { value: '对象文本' },
    '第一行\n第二行',
    '文'.repeat(51),
  ])('拒绝非字符串、多行或过长文本 %#', async (text) => {
    await expectExportError([
      {
        type: 'text',
        page: 1,
        x: 40,
        y: 700,
        text,
      },
    ], 400, '请求格式无效')
  })

  it('按页面真实 UserUnit 换算导出字号', async () => {
    const response = await exportPdf([
      {
        type: 'text',
        page: 1,
        x: 40,
        y: 100,
        text: 'UserUnit',
        fontSize: 16,
      },
    ], {}, baseUrl, await createPdfWithPageOptions({ userUnit: 2 }))

    expect(response.status).toBe(200)
    const document = await PDFDocument.load(await response.arrayBuffer())
    expect(document.getPage(0).node.lookup(PDFName.of('UserUnit')).asNumber()).toBe(2)
    expect(readPageContent(document)).toContain('8 Tf')
  })

  it.each([
    { rotation: 0, edge: '顶部' },
    { rotation: 90, edge: '90 度顶部' },
    { rotation: 270, edge: '270 度右上角' },
  ])('真实 PDF.js 转换链路允许$edge贴边文字', async ({ rotation }) => {
    const pdfBytes = await createPdfWithPageOptions({
      cropBox: { x: 40, y: 30, width: 220, height: 160 },
      rotation,
    })
    const initial = await createTextOperationFromViewport(pdfBytes, {
      x: 0,
      y: 0,
      width: 80,
      height: 24,
      baseline: 18,
      text: '贴边文字',
      fontSize: 16,
    })
    const annotation = rotation === 270
      ? {
          x: initial.viewport.width - 80,
          y: 0,
          width: 80,
          height: 24,
          baseline: 18,
          text: '贴边文字',
          fontSize: 16,
        }
      : {
          x: 0,
          y: 0,
          width: 80,
          height: 24,
          baseline: 18,
          text: '贴边文字',
          fontSize: 16,
        }
    const { operation } = await createTextOperationFromViewport(pdfBytes, annotation)
    const response = await exportPdf([operation], {}, baseUrl, pdfBytes)

    expect(response.status).toBe(200)
  })

  it('真实 PDF.js 转换的 baseline 合法但 bounds 越界时返回 400', async () => {
    const pdfBytes = await createPdfWithPageOptions({
      cropBox: { x: 40, y: 30, width: 220, height: 160 },
      rotation: 0,
    })
    const { operation } = await createTextOperationFromViewport(pdfBytes, {
      x: 0,
      y: -1,
      width: 80,
      height: 24,
      baseline: 18,
      text: '越界文字',
      fontSize: 16,
    })
    expect(operation.y).toBeLessThanOrEqual(190)
    expect(operation.boundsY + operation.boundsHeight).toBeGreaterThan(190)

    const response = await exportPdf([operation], {}, baseUrl, pdfBytes)
    await expectErrorResponse(response, 400, '请求格式无效')
  })

  it.each([
    {
      rotation: 90,
      imageOrigin: [100, 50],
      imageSize: [20, 40],
      signatureOrigin: [190, 50],
      checkEnd: [120, 70],
      textMatrix: [0, 1, -1, 0, 60, 120],
    },
    {
      rotation: 180,
      imageOrigin: [100, 70],
      imageSize: [40, 20],
      signatureOrigin: [190, 70],
      checkEnd: [120, 50],
      textMatrix: [-1, 0, 0, -1, 60, 120],
    },
    {
      rotation: 270,
      imageOrigin: [60, 70],
      imageSize: [20, 40],
      signatureOrigin: [150, 70],
      checkEnd: [140, 50],
      textMatrix: [0, -1, 1, 0, 60, 120],
    },
  ])('按 PDF 页面的 /Rotate $rotation 和裁切框补偿四类标注', async ({
    rotation,
    imageOrigin,
    imageSize,
    signatureOrigin,
    checkEnd,
    textMatrix,
  }) => {
    const response = await exportPdf([
      {
        type: 'text',
        page: 1,
        x: 60,
        y: 120,
        width: 80,
        height: 20,
        boundsX: 60,
        boundsY: 100,
        boundsWidth: 80,
        boundsHeight: 20,
        text: `Rotate ${rotation}`,
      },
      {
        type: 'check',
        page: 1,
        x: 120,
        y: 50,
        width: 20,
        height: 20,
      },
      {
        type: 'signature',
        page: 1,
        x: 150,
        y: 50,
        width: 40,
        height: 20,
        file: 'signature',
      },
      {
        type: 'image',
        page: 1,
        x: 60,
        y: 50,
        width: 40,
        height: 20,
        file: 'photo',
      },
    ], {
      signature: new Blob([PNG_BYTES], { type: 'image/png' }),
      photo: new Blob([PNG_BYTES], { type: 'image/png' }),
    }, baseUrl, await createRotatedCroppedPdf(rotation))

    expect(response.status).toBe(200)
    const document = await PDFDocument.load(await response.arrayBuffer())
    const page = document.getPage(0)
    const content = readPageContent(document)
    const cropBox = page.getCropBox()

    expect(page.getRotation().angle).toBe(rotation)
    expect(cropBox).toMatchObject({ x: 40, y: 30, width: 220, height: 160 })
    expect(content).toContain(
      `1 0 0 1 ${imageOrigin[0]} ${imageOrigin[1]} cm`,
    )
    expect(content).toContain(
      `${imageSize[0]} 0 0 ${imageSize[1]} 0 0 cm`,
    )
    expect(content).toContain(
      `1 0 0 1 ${signatureOrigin[0]} ${signatureOrigin[1]} cm`,
    )
    expect(content).toContain(`${checkEnd[0]} ${checkEnd[1]} l`)
    expectMatrix(content, 'Tm', textMatrix)
    expectUprightOnScreen(content, rotation)
  })

  it('旋转页的旧版无尺寸勾选使用默认尺寸导出', async () => {
    const response = await exportPdf([
      {
        type: 'check',
        page: 1,
        x: 120,
        y: 50,
      },
    ], {}, baseUrl, await createRotatedCroppedPdf(90))

    expect(response.status).toBe(200)
    const document = await PDFDocument.load(await response.arrayBuffer())
    expect(readPageContent(document)).toContain('122 63 l')
  })

  it('把文本和勾选叠加到上传的 PDF', async () => {
    const response = await exportPdf([
      { type: 'text', page: 1, x: 40, y: 700, text: 'Alice' },
      { type: 'check', page: 1, x: 120, y: 650 },
    ])

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')

    const document = await PDFDocument.load(await response.arrayBuffer())
    const content = readPageContent(document)

    expect(content).toContain('BT')
    expect(content).toMatch(/\bm\b/)
    expect(content).toMatch(/\bl\b/)
    expect(content).toContain('S')
  })

  it('按可选字号和十六进制颜色导出文本', async () => {
    const response = await exportPdf([
      {
        type: 'text',
        page: 1,
        x: 40,
        y: 700,
        text: 'Styled',
        fontSize: 18,
        color: '#2563eb',
      },
    ])

    expect(response.status).toBe(200)
    const document = await PDFDocument.load(await response.arrayBuffer())
    const content = readPageContent(document)
    expect(content).toContain('18 Tf')
    expect(content).toContain('0.1450980392156863 0.38823529411764707 0.9215686274509803 rg')
  })

  it('按显式宽高绘制勾选标记', async () => {
    const response = await exportPdf([
      {
        type: 'check',
        page: 1,
        x: 100,
        y: 200,
        width: 26,
        height: 26,
      },
    ])

    expect(response.status).toBe(200)
    const document = await PDFDocument.load(await response.arrayBuffer())
    const content = readPageContent(document)
    expect(content).toContain('126 226 l')
  })

  it('把 PNG 签名和 JPG 图片叠加到上传的 PDF', async () => {
    const response = await exportPdf([
      {
        type: 'signature',
        page: 1,
        x: 40,
        y: 500,
        width: 120,
        height: 40,
        file: 'signature',
      },
      {
        type: 'image',
        page: 1,
        x: 200,
        y: 500,
        width: 80,
        height: 60,
        file: 'photo',
      },
    ], {
      signature: new Blob([PNG_BYTES], { type: 'image/png' }),
      photo: new Blob([JPEG_BYTES], { type: 'image/jpeg' }),
    })

    expect(response.status).toBe(200)

    const document = await PDFDocument.load(await response.arrayBuffer())
    const resources = document.getPage(0).node.Resources()
    expect(resources.has(PDFName.of('XObject'))).toBe(true)

    const xObjects = resources.lookup(PDFName.of('XObject'), PDFDict)
    expect(xObjects.keys()).toHaveLength(2)

    const content = readPageContent(document)
    expect(content).toContain('1 0 0 1 40 500 cm')
    expect(content).toContain('120 0 0 40 0 0 cm')
    expect(content).toContain('1 0 0 1 200 500 cm')
    expect(content).toContain('80 0 0 60 0 0 cm')
  })

  it('允许 3 张图片和 1 个签名同时导出', async () => {
    const operations = [
      {
        type: 'signature',
        page: 1,
        x: 20,
        y: 500,
        width: 120,
        height: 40,
        file: 'signature',
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        type: 'image',
        page: 1,
        x: 20 + index * 60,
        y: 400,
        width: 50,
        height: 50,
        file: `photo-${index}`,
      })),
    ]
    const images = {
      signature: new Blob([PNG_BYTES], { type: 'image/png' }),
      ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [
        `photo-${index}`,
        new Blob([PNG_BYTES], { type: 'image/png' }),
      ])),
    }

    const response = await exportPdf(operations, images)
    expect(response.status).toBe(200)
  })

  it('拒绝超过 1 个签名', async () => {
    const operations = Array.from({ length: 2 }, (_, index) => ({
      type: 'signature',
      page: 1,
      x: 20,
      y: 500 - index * 60,
      width: 120,
      height: 40,
      file: `signature-${index}`,
    }))
    const images = Object.fromEntries(Array.from({ length: 2 }, (_, index) => [
      `signature-${index}`,
      new Blob([PNG_BYTES], { type: 'image/png' }),
    ]))

    const response = await exportPdf(operations, images)
    await expectErrorResponse(response, 413, '上传内容超出限制')
  })

  it('使用项目内字体导出中文文本而不抛错', async () => {
    const response = await exportPdf([
      { type: 'text', page: 1, x: 40, y: 700, text: '张三' },
    ])

    expect(response.status).toBe(200)
    await expect(PDFDocument.load(await response.arrayBuffer())).resolves.toBeDefined()
    await expect(access(FONT_URL)).resolves.toBeUndefined()
  })

  it('使用思源宋体粗体嵌入中文文本', async () => {
    const response = await exportPdf([
      {
        type: 'text',
        page: 1,
        x: 40,
        y: 700,
        text: '重点内容',
        fontFamily: 'serif',
        fontWeight: 'bold',
      },
    ])

    expect(response.status).toBe(200)
    await expect(PDFDocument.load(await response.arrayBuffer())).resolves.toBeDefined()
  })

  it('成功导出后不在临时目录留下文件', async () => {
    const response = await exportPdf([])

    expect(response.status).toBe(200)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('导出失败后也不在临时目录留下文件', async () => {
    const form = new FormData()
    form.append('pdf', new Blob(['not a pdf'], { type: 'application/pdf' }), 'broken.pdf')
    form.append('operations', '[]')

    const response = await fetch(`${baseUrl}/api/export`, {
      method: 'POST',
      body: form,
    })

    expect(response.status).toBe(400)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('拒绝未知操作类型', async () => {
    await expectExportError(
      [{ type: 'unknown', page: 1, x: 0, y: 0 }],
      400,
      '请求格式无效',
    )
  })

  it('拒绝非数组 operations', async () => {
    await expectExportError({}, 400, '请求格式无效')
  })

  it('拒绝超出实际 PDF 页数的页码', async () => {
    await expectExportError(
      [{ type: 'check', page: 2, x: 0, y: 0 }],
      400,
      '请求格式无效',
    )
  })

  it.each([
    ['负数', -1, 0],
    ['非有限值', null, 0],
  ])('拒绝%s坐标', async (_label, x, y) => {
    await expectExportError(
      [{ type: 'check', page: 1, x, y }],
      400,
      '请求格式无效',
    )
  })

  it.each([
    ['零宽度', 0, 20],
    ['非有限高度', 20, null],
  ])('拒绝图片的%s', async (_label, width, height) => {
    await expectExportError(
      [{ type: 'image', page: 1, x: 0, y: 0, width, height, file: 'photo' }],
      400,
      '请求格式无效',
      { photo: new Blob([PNG_BYTES], { type: 'image/png' }) },
    )
  })

  it('拒绝缺失的图片字段', async () => {
    await expectExportError(
      [{ type: 'image', page: 1, x: 0, y: 0, width: 20, height: 20, file: 'photo' }],
      400,
      '请求格式无效',
    )
  })

  it('用 415 拒绝非 PNG/JPEG 图片', async () => {
    await expectExportError(
      [{ type: 'image', page: 1, x: 0, y: 0, width: 20, height: 20, file: 'photo' }],
      415,
      '不支持的媒体类型',
      { photo: new Blob(['plain text'], { type: 'text/plain' }) },
    )
  })

  it('没有文本操作时不加载字体', async () => {
    const isolatedTempRoot = join(tmpdir(), `pdf-editor-font-test-${randomUUID()}`)
    const isolatedServer = await createServer({
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      plugins: [pdfExportPlugin({
        tempRoot: isolatedTempRoot,
        fontUrl: new URL('../missing-font.ttf', import.meta.url),
      })],
      server: {
        host: '127.0.0.1',
        port: 0,
      },
    })

    try {
      await isolatedServer.listen()
      const address = isolatedServer.httpServer.address()
      const isolatedBaseUrl = `http://127.0.0.1:${address.port}`

      const textResponse = await exportPdf([
        { type: 'text', page: 1, x: 0, y: 0, text: '测试' },
      ], {}, isolatedBaseUrl)
      await expectErrorResponse(textResponse, 500, '导出失败')

      const imageResponse = await exportPdf([
        {
          type: 'image',
          page: 1,
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          file: 'photo',
        },
      ], {
        photo: new Blob([PNG_BYTES], { type: 'image/png' }),
      }, isolatedBaseUrl)
      expect(imageResponse.status).toBe(200)
    } finally {
      await isolatedServer.close()
      await rm(isolatedTempRoot, { recursive: true, force: true })
    }
  })

  it('清理失败时返回不泄露内部路径的稳定 500', async () => {
    const isolatedTempRoot = join(tmpdir(), `pdf-editor-cleanup-test-${randomUUID()}`)
    const secretPath = '/private/internal/pdf-export-file'
    const isolatedServer = await createServer({
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      plugins: [pdfExportPlugin({
        tempRoot: isolatedTempRoot,
        removeDirectory: async () => {
          throw new Error(`cannot remove ${secretPath}`)
        },
      })],
      server: {
        host: '127.0.0.1',
        port: 0,
      },
    })

    try {
      await isolatedServer.listen()
      const address = isolatedServer.httpServer.address()
      const isolatedBaseUrl = `http://127.0.0.1:${address.port}`
      const response = await exportPdf([], {}, isolatedBaseUrl)

      expect(response.status).toBe(500)
      expect(response.headers.get('content-type') ?? '').toContain('application/json')
      const body = await response.text()
      expect(body).toBe(JSON.stringify({ error: '导出失败' }))
      expect(body).not.toContain(secretPath)
    } finally {
      await isolatedServer.close()
      await rm(isolatedTempRoot, { recursive: true, force: true })
    }
  })

  it('不依赖 Content-Length 拒绝超过 20MB 的 PDF', async () => {
    const response = await postChunkedMultipart([
      {
        name: 'pdf',
        filename: 'large.pdf',
        type: 'application/pdf',
        data: new Uint8Array(20 * 1024 * 1024 + 1),
      },
      { name: 'operations', data: '[]' },
    ])

    await expectErrorResponse(response, 413, '上传内容超出限制')
  })

  it('拒绝超过 100 页的 PDF', async () => {
    const form = new FormData()
    form.append(
      'pdf',
      new Blob([await createBlankPdf(101)], { type: 'application/pdf' }),
      'too-many-pages.pdf',
    )
    form.append('operations', '[]')
    const response = await fetch(`${baseUrl}/api/export`, { method: 'POST', body: form })

    await expectErrorResponse(response, 413, '上传内容超出限制')
  })

  it('接受恰好 100 页的 PDF', async () => {
    const response = await exportPdf([], {}, baseUrl, await createBlankPdf(100))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/pdf')
  })

  it('拒绝超过 5MB 的单张图片', async () => {
    const response = await exportPdf([
      {
        type: 'image',
        page: 1,
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        file: 'photo',
      },
    ], {
      photo: new Blob(
        [new Uint8Array(5 * 1024 * 1024 + 1)],
        { type: 'image/png' },
      ),
    })

    await expectErrorResponse(response, 413, '上传内容超出限制')
  })

  it('拒绝超过 3 张图片', async () => {
    const operations = []
    const images = {}
    for (let index = 0; index < 4; index += 1) {
      const name = `photo-${index}`
      operations.push({
        type: 'image',
        page: 1,
        x: index * 20,
        y: 0,
        width: 20,
        height: 20,
        file: name,
      })
      images[name] = new Blob([PNG_BYTES], { type: 'image/png' })
    }

    const response = await exportPdf(operations, images)
    await expectErrorResponse(response, 413, '上传内容超出限制')
  })

  it('即使缺少 PDF 也把 multipart 总资产限制为最多 4 个', async () => {
    const response = await postChunkedMultipart([
      ...Array.from({ length: 5 }, (_, index) => ({
        name: `photo-${index}`,
        filename: `photo-${index}.png`,
        type: 'image/png',
        data: PNG_BYTES,
      })),
    ])

    await expectErrorResponse(response, 413, '上传内容超出限制')
  })

  it('拒绝超过 1MB 的 operations 字段', async () => {
    const form = new FormData()
    form.append('pdf', new Blob([await createBlankPdf()], { type: 'application/pdf' }), 'form.pdf')
    form.append('operations', `${' '.repeat(1024 * 1024 + 1)}[]`)
    const response = await fetch(`${baseUrl}/api/export`, { method: 'POST', body: form })

    await expectErrorResponse(response, 413, '上传内容超出限制')
  })

  it('拒绝重复 PDF 字段', async () => {
    const pdf = await createBlankPdf()
    const form = new FormData()
    form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'first.pdf')
    form.append('pdf', new Blob([pdf], { type: 'application/pdf' }), 'second.pdf')
    form.append('operations', '[]')
    const response = await fetch(`${baseUrl}/api/export`, { method: 'POST', body: form })

    await expectErrorResponse(response, 400, '请求格式无效')
  })

  it('拒绝重复图片字段', async () => {
    const form = new FormData()
    form.append('pdf', new Blob([await createBlankPdf()], { type: 'application/pdf' }), 'form.pdf')
    form.append('operations', JSON.stringify([
      {
        type: 'image',
        page: 1,
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        file: 'photo',
      },
    ]))
    form.append('photo', new Blob([PNG_BYTES], { type: 'image/png' }), 'first.png')
    form.append('photo', new Blob([PNG_BYTES], { type: 'image/png' }), 'second.png')
    const response = await fetch(`${baseUrl}/api/export`, { method: 'POST', body: form })

    await expectErrorResponse(response, 400, '请求格式无效')
  })

  it('客户端中断半包上传后清理临时目录', async () => {
    const boundary = `pdf-editor-abort-${randomUUID()}`
    const target = new URL('/api/export', baseUrl)
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'transfer-encoding': 'chunked',
      },
    })
    request.on('error', () => {})
    request.write(Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="pdf"; filename="partial.pdf"\r\n'
      + 'Content-Type: application/pdf\r\n\r\n',
    ))
    request.write(Buffer.alloc(64 * 1024))

    const entriesDuringUpload = await waitForTempEntries((entries) => entries.length > 0)
    expect(entriesDuringUpload).toHaveLength(1)

    const closed = new Promise((resolve) => request.once('close', resolve))
    request.destroy()
    await closed

    const entriesAfterAbort = await waitForTempEntries((entries) => entries.length === 0)
    expect(entriesAfterAbort).toEqual([])
  })
})
