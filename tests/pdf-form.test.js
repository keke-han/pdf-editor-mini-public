import { describe, expect, it } from 'vitest'

import {
  AnnotationType,
  createAnnotation,
  fromPdfCoordinates,
  fromPdfViewportRectangle,
  toPdfCoordinates,
  toPdfViewportCoordinates,
  validateAnnotationInput,
} from '../src/lib/pdf-form.js'

describe('PDF 表单基线', () => {
  it('使用 check 作为勾选操作的线协议值', () => {
    expect(AnnotationType.CHECKMARK).toBe('check')
  })

  it('创建保留页码和注释类型的文本注释数据', () => {
    expect(createAnnotation({
      id: 'name-field',
      type: AnnotationType.TEXT,
      page: 2,
      x: 36,
      y: 720,
      text: '张三',
    })).toEqual({
      id: 'name-field',
      type: 'text',
      page: 2,
      x: 36,
      y: 720,
      text: '张三',
    })
  })

  it('把浏览器画布坐标转换为 PDF 左下角坐标', () => {
    expect(toPdfCoordinates(
      { x: 150, y: 100 },
      { width: 600, height: 800 },
      { width: 300, height: 400 },
    )).toEqual({ x: 75, y: 350 })
  })

  it('把 PDF 坐标转换回浏览器画布坐标', () => {
    expect(fromPdfCoordinates(
      { x: 75, y: 350 },
      { width: 300, height: 400 },
      { width: 600, height: 800 },
    )).toEqual({ x: 150, y: 100 })
  })

  it('创建时保留矩形注释的宽高', () => {
    expect(createAnnotation({
      id: 'photo',
      type: AnnotationType.IMAGE,
      page: 1,
      x: 150,
      y: 100,
      width: 120,
      height: 40,
      file: 'photo',
    })).toEqual({
      id: 'photo',
      type: 'image',
      page: 1,
      x: 150,
      y: 100,
      width: 120,
      height: 40,
      file: 'photo',
    })
  })

  it('把 CSS 左上角矩形转换为 PDF 左下角矩形', () => {
    expect(toPdfCoordinates(
      { x: 150, y: 100, width: 120, height: 40 },
      { width: 600, height: 800 },
      { width: 300, height: 400 },
    )).toEqual({ x: 75, y: 330, width: 60, height: 20 })
  })

  it('把 PDF 左下角矩形转换回 CSS 左上角矩形', () => {
    expect(fromPdfCoordinates(
      { x: 75, y: 330, width: 60, height: 20 },
      { width: 300, height: 400 },
      { width: 600, height: 800 },
    )).toEqual({ x: 150, y: 100, width: 120, height: 40 })
  })

  it('用 viewport 逆变换处理 90 度旋转和非零裁切框', () => {
    const rotatedCroppedViewport = {
      rotation: 90,
      viewBox: [10, 20, 210, 120],
      convertToPdfPoint(x, y) {
        return [y + 10, x + 20]
      },
    }

    expect(toPdfViewportCoordinates(
      { x: 20, y: 30, width: 40, height: 50 },
      rotatedCroppedViewport,
    )).toEqual({
      x: 40,
      y: 40,
      width: 50,
      height: 40,
    })
  })

  it('把服务端 PDF 矩形转换为旋转后的视口矩形', () => {
    const viewport = {
      convertToViewportPoint: (x, y) => [260 - 2 * x, 3 * y - 20],
    }

    expect(fromPdfViewportRectangle(
      { x: 10, y: 20, width: 30, height: 40 },
      viewport,
    )).toEqual({ x: 180, y: 40, width: 60, height: 120 })
  })

  it('允许页面裁切框产生负的视口坐标', () => {
    const viewport = {
      convertToViewportPoint: (x, y) => [2 * x - 10, -2 * y + 20],
    }

    expect(fromPdfViewportRectangle(
      { x: -5, y: -10, width: 15, height: 25 },
      viewport,
    )).toEqual({ x: -20, y: -10, width: 30, height: 50 })
  })

  it.each([
    [{ x: Number.NaN, y: 0, width: 10, height: 10 }],
    [{ x: 0, y: 0, width: 0, height: 10 }],
    [{ x: 0, y: 0, width: 10, height: -1 }],
  ])('拒绝无效 PDF 矩形 %#', (bounds) => {
    expect(() => fromPdfViewportRectangle(bounds, {
      convertToViewportPoint: (x, y) => [x, y],
    })).toThrow('无效')
  })

  it.each([
    [[0, 0, Number.POSITIVE_INFINITY, 10]],
    [[0, 0, 0, 10]],
    [[0, 0, 10, 0]],
  ])('拒绝无效 viewport 矩形 %#', (converted) => {
    let callIndex = 0
    const convertToViewportPoint = () => {
      const point = converted.slice(callIndex, callIndex + 2)
      callIndex += 2
      return point
    }
    expect(() => fromPdfViewportRectangle(
      { x: 0, y: 0, width: 10, height: 10 },
      { convertToViewportPoint },
    )).toThrow('无效')
  })

  it('缺少 PDF.js 6 point converter 时稳定拒绝', () => {
    expect(() => fromPdfViewportRectangle(
      { x: 0, y: 0, width: 10, height: 10 },
      {},
    )).toThrow('无效')
  })

  it('用显式文字基线通过 viewport 转换导出点', () => {
    const rotatedCroppedViewport = {
      convertToPdfPoint(x, y) {
        return [y + 10, x + 20]
      },
    }

    expect(toPdfViewportCoordinates(
      { x: 20, y: 30, width: 120, height: 24, baseline: 18 },
      rotatedCroppedViewport,
    )).toEqual({
      x: 58,
      y: 40,
      width: 24,
      height: 120,
      boundsX: 40,
      boundsY: 40,
      boundsWidth: 24,
      boundsHeight: 120,
    })
  })

  it('拒绝空白文本注释', () => {
    expect(validateAnnotationInput({
      type: AnnotationType.TEXT,
      page: 1,
      x: 0,
      y: 0,
      text: '   ',
    })).toEqual({ valid: false, error: '请输入文本内容' })
  })

  it('拒绝不支持的图片格式', () => {
    expect(validateAnnotationInput({
      type: AnnotationType.IMAGE,
      page: 1,
      x: 0,
      y: 0,
      file: { type: 'image/gif' },
    })).toEqual({ valid: false, error: '仅支持 PNG 或 JPG 图片' })
  })

  it('拒绝没有有效页码的注释', () => {
    expect(validateAnnotationInput({
      type: AnnotationType.CHECKMARK,
      page: 0,
      x: 0,
      y: 0,
    })).toEqual({ valid: false, error: '请选择有效页码' })
  })

  it('拒绝负坐标的注释', () => {
    expect(validateAnnotationInput({
      type: AnnotationType.CHECKMARK,
      page: 1,
      x: -1,
      y: 0,
    })).toEqual({ valid: false, error: '请输入有效坐标' })
  })

  it('拒绝未知注释类型', () => {
    expect(validateAnnotationInput({
      type: 'unknown',
      page: 1,
      x: 0,
      y: 0,
    })).toEqual({ valid: false, error: '不支持的注释类型' })
  })

  it('拒绝没有有限正宽高的图片注释', () => {
    expect(validateAnnotationInput({
      type: AnnotationType.IMAGE,
      page: 1,
      x: 0,
      y: 0,
      width: 0,
      height: 20,
      file: { type: 'image/png' },
    })).toEqual({ valid: false, error: '请输入有效尺寸' })
  })

  it('拒绝不支持格式的签名图片', () => {
    expect(validateAnnotationInput({
      type: AnnotationType.SIGNATURE,
      page: 1,
      x: 0,
      y: 0,
      width: 20,
      height: 20,
      file: { type: 'image/gif' },
    })).toEqual({ valid: false, error: '仅支持 PNG 或 JPG 图片' })
  })
})
