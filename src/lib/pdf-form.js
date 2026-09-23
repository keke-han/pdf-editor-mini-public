export const AnnotationType = Object.freeze({
  TEXT: 'text',
  COVER: 'cover',
  CHECKMARK: 'check',
  SIGNATURE: 'signature',
  IMAGE: 'image',
})

export function createAnnotation({ id, type, page, x, y, width, height, text, file }) {
  return {
    id,
    type,
    page,
    x,
    y,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(text === undefined ? {} : { text }),
    ...(file === undefined ? {} : { file }),
  }
}

export function toPdfCoordinates(point, canvasSize, pdfSize) {
  const width = point.width === undefined
    ? undefined
    : point.width * pdfSize.width / canvasSize.width
  const height = point.height === undefined
    ? undefined
    : point.height * pdfSize.height / canvasSize.height

  return {
    x: point.x * pdfSize.width / canvasSize.width,
    y: pdfSize.height - point.y * pdfSize.height / canvasSize.height - (height ?? 0),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  }
}

export function fromPdfCoordinates(point, pdfSize, canvasSize) {
  const width = point.width === undefined
    ? undefined
    : point.width * canvasSize.width / pdfSize.width
  const height = point.height === undefined
    ? undefined
    : point.height * canvasSize.height / pdfSize.height

  return {
    x: point.x * canvasSize.width / pdfSize.width,
    y: (pdfSize.height - point.y - (point.height ?? 0)) * canvasSize.height / pdfSize.height,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  }
}

export function fromPdfViewportRectangle(bounds, viewport) {
  if (
    !bounds
    || !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    throw new RangeError('无效的 PDF 矩形')
  }
  if (typeof viewport?.convertToViewportPoint !== 'function') {
    throw new RangeError('无效的 PDF viewport')
  }
  const first = viewport.convertToViewportPoint(bounds.x, bounds.y)
  const second = viewport.convertToViewportPoint(
    bounds.x + bounds.width,
    bounds.y + bounds.height,
  )
  if (
    !Array.isArray(first)
    || !Array.isArray(second)
    || first.length < 2
    || second.length < 2
  ) {
    throw new RangeError('无效的 viewport 矩形')
  }
  const [firstX, firstY] = first
  const [secondX, secondY] = second

  const rectangle = {
    x: Math.min(firstX, secondX),
    y: Math.min(firstY, secondY),
    width: Math.abs(secondX - firstX),
    height: Math.abs(secondY - firstY),
  }
  if (
    !Number.isFinite(rectangle.x)
    || !Number.isFinite(rectangle.y)
    || !Number.isFinite(rectangle.width)
    || !Number.isFinite(rectangle.height)
    || rectangle.width <= 0
    || rectangle.height <= 0
  ) {
    throw new RangeError('无效的 viewport 矩形')
  }
  return rectangle
}

export function toPdfViewportCoordinates(point, viewport) {
  const baselineY = point.baseline === undefined
    ? point.y
    : point.y + point.baseline
  const [anchorX, anchorY] = viewport.convertToPdfPoint(point.x, baselineY)

  if (point.width === undefined || point.height === undefined) {
    return { x: anchorX, y: anchorY }
  }

  const [cornerX, cornerY] = viewport.convertToPdfPoint(point.x, point.y)
  const [oppositeX, oppositeY] = viewport.convertToPdfPoint(
    point.x + point.width,
    point.y + point.height,
  )
  const rectangle = {
    width: Math.abs(oppositeX - cornerX),
    height: Math.abs(oppositeY - cornerY),
  }

  if (point.baseline !== undefined) {
    return {
      x: anchorX,
      y: anchorY,
      ...rectangle,
      boundsX: Math.min(cornerX, oppositeX),
      boundsY: Math.min(cornerY, oppositeY),
      boundsWidth: rectangle.width,
      boundsHeight: rectangle.height,
    }
  }

  return {
    x: Math.min(cornerX, oppositeX),
    y: Math.min(cornerY, oppositeY),
    ...rectangle,
  }
}

export function validateAnnotationInput({ type, page, x, y, width, height, text, file }) {
  if (!Object.values(AnnotationType).includes(type)) {
    return { valid: false, error: '不支持的注释类型' }
  }

  if (!Number.isInteger(page) || page < 1) {
    return { valid: false, error: '请选择有效页码' }
  }

  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    return { valid: false, error: '请输入有效坐标' }
  }

  if ((type === AnnotationType.TEXT || type === AnnotationType.COVER) && !text?.trim()) {
    return { valid: false, error: '请输入文本内容' }
  }

  const isImage = type === AnnotationType.SIGNATURE || type === AnnotationType.IMAGE
  if (isImage && !['image/png', 'image/jpeg'].includes(file?.type)) {
    return { valid: false, error: '仅支持 PNG 或 JPG 图片' }
  }

  if (
    isImage
    && (
      !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
    )
  ) {
    return { valid: false, error: '请输入有效尺寸' }
  }

  return { valid: true }
}
