import fontkit from '@pdf-lib/fontkit'
import { init, subset } from 'hb-subset-wasm'
import subsetWasmUrl from 'hb-subset-wasm/hb-subset.wasm?url'
import {
  PDFDocument,
  PDFName,
  degrees,
  rgb,
} from 'pdf-lib'

import sansRegularUrl from '../assets/fonts/NotoSansSC-Regular.ttf'
import sansBoldUrl from '../assets/fonts/NotoSansSC-Bold.ttf'
import serifRegularUrl from '../assets/fonts/NotoSerifSC-Regular.ttf'
import serifBoldUrl from '../assets/fonts/NotoSerifSC-Bold.ttf'
import { AnnotationType } from './pdf-form.js'

const FONT_URLS = {
  sans: { regular: sansRegularUrl, bold: sansBoldUrl },
  serif: { regular: serifRegularUrl, bold: serifBoldUrl },
}
let subsetReady

function parseHexColor(value = '#000000') {
  return rgb(
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  )
}

function getPageRotation(page) {
  return ((page.getRotation().angle % 360) + 360) % 360
}

function getPageUserUnit(page) {
  const value = page.node.get(PDFName.of('UserUnit'))?.asNumber?.() ?? 1
  return Number.isFinite(value) && value > 0 ? value : 1
}

function getOrientedBox(operation, rotation) {
  if (rotation === 90) {
    return { x: operation.x + operation.width, y: operation.y, width: operation.height, height: operation.width, angle: 90 }
  }
  if (rotation === 180) {
    return { x: operation.x + operation.width, y: operation.y + operation.height, width: operation.width, height: operation.height, angle: 180 }
  }
  if (rotation === 270) {
    return { x: operation.x, y: operation.y + operation.height, width: operation.height, height: operation.width, angle: 270 }
  }
  return { x: operation.x, y: operation.y, width: operation.width, height: operation.height, angle: 0 }
}

function transformOrientedPoint(operation, rotation, x, y) {
  if (rotation === 90) return { x: operation.x + operation.width - y, y: operation.y + x }
  if (rotation === 180) return { x: operation.x + operation.width - x, y: operation.y + operation.height - y }
  if (rotation === 270) return { x: operation.x + y, y: operation.y + operation.height - x }
  return { x: operation.x + x, y: operation.y + y }
}

async function loadFont(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('字体加载失败')
  return response.arrayBuffer()
}

async function loadSubsetFont(url, text, signal) {
  const fontBytes = await loadFont(url, signal)
  if (!text) return fontBytes

  try {
    if (!subsetReady) {
      subsetReady = init(fetch(subsetWasmUrl, { signal })).catch((error) => {
        subsetReady = undefined
        throw error
      })
    }
    await subsetReady
    throwIfAborted(signal)
    return await subset(new Uint8Array(fontBytes), { text })
  } catch {
    // If WebAssembly is unavailable, preserve export correctness with the full font.
    throwIfAborted(signal)
    return fontBytes
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError')
}

export async function exportPdfLocally({ pdf, operations, signal }) {
  throwIfAborted(signal)
  const document = await PDFDocument.load(await pdf.arrayBuffer())
  const fonts = new Map()
  const needsText = operations.some(({ type }) => (
    type === AnnotationType.TEXT || type === AnnotationType.COVER
  ))
  if (needsText) document.registerFontkit(fontkit)
  const fontTexts = new Map()
  for (const operation of operations) {
    if (operation.type !== AnnotationType.TEXT && operation.type !== AnnotationType.COVER) continue
    const fontKey = `${operation.fontFamily ?? 'sans'}-${operation.fontWeight ?? 'regular'}`
    fontTexts.set(fontKey, (fontTexts.get(fontKey) ?? '') + operation.text)
  }

  for (const operation of operations) {
    throwIfAborted(signal)
    const page = document.getPage(operation.page - 1)
    const rotation = getPageRotation(page)

    if (operation.type === AnnotationType.TEXT || operation.type === AnnotationType.COVER) {
      const fontFamily = operation.fontFamily ?? 'sans'
      const fontWeight = operation.fontWeight ?? 'regular'
      const fontKey = `${fontFamily}-${fontWeight}`
      if (!fonts.has(fontKey)) {
        fonts.set(fontKey, await document.embedFont(
          await loadSubsetFont(FONT_URLS[fontFamily][fontWeight], fontTexts.get(fontKey), signal),
          { subset: false },
        ))
      }
      if (operation.type === AnnotationType.COVER) {
        page.drawRectangle({
          x: operation.boundsX ?? operation.x,
          y: operation.boundsY ?? operation.y,
          width: operation.boundsWidth ?? operation.width,
          height: operation.boundsHeight ?? operation.height,
          color: parseHexColor(operation.backgroundColor),
        })
      }
      page.drawText(operation.text, {
        x: operation.x,
        y: operation.y,
        size: (operation.fontSize ?? 12) / getPageUserUnit(page),
        color: parseHexColor(operation.color),
        font: fonts.get(fontKey),
        rotate: degrees(rotation),
      })
      continue
    }

    if (operation.type === AnnotationType.CHECKMARK) {
      const width = operation.width ?? 13
      const height = operation.height ?? 11
      const color = rgb(0.1, 0.55, 0.3)
      const start = transformOrientedPoint(operation, rotation, 0, height * 0.4)
      const middle = transformOrientedPoint(operation, rotation, width * 0.35, 0)
      const end = transformOrientedPoint(operation, rotation, width, height)
      page.drawLine({ start, end: middle, thickness: 2, color })
      page.drawLine({ start: middle, end, thickness: 2, color })
      continue
    }

    if (operation.type === AnnotationType.SIGNATURE || operation.type === AnnotationType.IMAGE) {
      const bytes = await operation.file.arrayBuffer()
      const image = operation.file.type === 'image/png'
        ? await document.embedPng(bytes)
        : await document.embedJpg(bytes)
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

  throwIfAborted(signal)
  return new Blob([await document.save()], { type: 'application/pdf' })
}
