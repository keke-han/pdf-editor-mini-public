import { useEffect, useRef, useState } from 'react'

import { fromPdfViewportRectangle } from '../lib/pdf-form.js'

function hasValidBounds(bounds) {
  return (
    Number.isFinite(bounds?.x)
    && Number.isFinite(bounds?.y)
    && Number.isFinite(bounds?.width)
    && Number.isFinite(bounds?.height)
    && bounds.width > 0
    && bounds.height > 0
  )
}

function contentRotationStyle(rotation, bounds) {
  const normalized = ((rotation % 360) + 360) % 360
  if (normalized === 90) {
    return {
      width: bounds.height,
      height: bounds.width,
      transform: `translate(${bounds.width}px, 0px) rotate(90deg)`,
      transformOrigin: '0 0',
    }
  }
  if (normalized === 180) {
    return {
      width: bounds.width,
      height: bounds.height,
      transform: `translate(${bounds.width}px, ${bounds.height}px) rotate(180deg)`,
      transformOrigin: '0 0',
    }
  }
  if (normalized === 270) {
    return {
      width: bounds.height,
      height: bounds.width,
      transform: `translate(0px, ${bounds.height}px) rotate(270deg)`,
      transformOrigin: '0 0',
    }
  }
  return {
    width: bounds.width,
    height: bounds.height,
  }
}

function toPdfBounds(bounds, viewport) {
  const first = viewport.convertToPdfPoint(bounds.x, bounds.y)
  const second = viewport.convertToPdfPoint(
    bounds.x + bounds.width,
    bounds.y + bounds.height,
  )
  return {
    x: Math.min(first[0], second[0]),
    y: Math.min(first[1], second[1]),
    width: Math.abs(second[0] - first[0]),
    height: Math.abs(second[1] - first[1]),
  }
}

function sampleCanvasBackground(element, bounds) {
  const canvas = element.closest('.page-shell')?.querySelector('.pdf-canvas')
  const box = canvas?.getBoundingClientRect()
  if (!canvas || !box?.width || !box.height) return null
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const scaleX = canvas.width / box.width
    const scaleY = canvas.height / box.height
    const image = context.getImageData(
      Math.max(0, Math.floor(bounds.x * scaleX)),
      Math.max(0, Math.floor(bounds.y * scaleY)),
      Math.max(1, Math.min(canvas.width, Math.ceil(bounds.width * scaleX))),
      Math.max(1, Math.min(canvas.height, Math.ceil(bounds.height * scaleY))),
    )
    const colors = new Map()
    for (let index = 0; index < image.data.length; index += 16) {
      const red = image.data[index]
      const green = image.data[index + 1]
      const blue = image.data[index + 2]
      const alpha = image.data[index + 3]
      if (alpha < 240 || Math.max(red, green, blue) - Math.min(red, green, blue) < 6 && red < 80) continue
      const key = `${red >> 4},${green >> 4},${blue >> 4}`
      const current = colors.get(key) ?? [0, 0, 0, 0]
      colors.set(key, [current[0] + red, current[1] + green, current[2] + blue, current[3] + 1])
    }
    const dominant = [...colors.values()].sort((first, second) => second[3] - first[3])[0]
    return dominant
      ? `rgb(${Math.round(dominant[0] / dominant[3])}, ${Math.round(dominant[1] / dominant[3])}, ${Math.round(dominant[2] / dominant[3])})`
      : null
  } catch {
    return null
  }
}

const resizeHandles = [
  ['n', '从上边调整文字框尺寸'],
  ['ne', '从右上角调整文字框尺寸'],
  ['e', '从右边调整文字框尺寸'],
  ['se', '从右下角调整文字框尺寸'],
  ['s', '从下边调整文字框尺寸'],
  ['sw', '从左下角调整文字框尺寸'],
  ['w', '从左边调整文字框尺寸'],
  ['nw', '从左上角调整文字框尺寸'],
]

function resizeViewportBounds(bounds, direction, deltaX, deltaY) {
  const minimum = 24
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  const next = { ...bounds }

  if (direction.includes('e')) {
    next.width = Math.max(minimum, bounds.width + deltaX)
  }
  if (direction.includes('s')) {
    next.height = Math.max(minimum, bounds.height + deltaY)
  }
  if (direction.includes('w')) {
    next.x = Math.min(right - minimum, bounds.x + deltaX)
    next.width = right - next.x
  }
  if (direction.includes('n')) {
    next.y = Math.min(bottom - minimum, bounds.y + deltaY)
    next.height = bottom - next.y
  }
  return next
}

export function OriginalTextLayer({
  viewport,
  blocks,
  edits,
  draft,
  selectedId,
  onSelect,
  onChange,
}) {
  const [editingId, setEditingId] = useState(null)
  const [maskColors, setMaskColors] = useState({})
  const contentRefs = useRef(new Map())

  useEffect(() => {
    if (selectedId !== editingId) {
      setEditingId(null)
    }
  }, [editingId, selectedId])

  const resizeBlock = (event, blockId, bounds, direction) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY

    let latestBounds = bounds
    const resize = (moveEvent) => {
      latestBounds = resizeViewportBounds(
        bounds,
        direction,
        moveEvent.clientX - startX,
        moveEvent.clientY - startY,
      )
      onChange({ bounds: toPdfBounds(latestBounds, viewport) })
    }
    const stopResize = () => {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', stopResize)
      const fitHeight = () => {
        const requiredHeight = contentRefs.current.get(blockId)?.scrollHeight
        if (Number.isFinite(requiredHeight) && requiredHeight > latestBounds.height) {
          onChange({
            bounds: toPdfBounds({
              ...latestBounds,
              height: Math.ceil(requiredHeight) + 4,
            }, viewport),
          })
        }
      }
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(fitHeight)
      } else {
        fitHeight()
      }
    }
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', stopResize, { once: true })
  }

  const selectBlock = (event, blockId, originalBounds) => {
    const color = sampleCanvasBackground(event.currentTarget, originalBounds)
    if (color) setMaskColors((current) => ({ ...current, [blockId]: color }))
    onSelect(blockId)
  }

  return (
    <div className="original-text-layer">
      {blocks.map((block) => {
        const applied = edits.find(({ blockId }) => block.blockId === blockId)
        const preview = draft?.blockId === block.blockId ? draft : applied
        const previewBounds = hasValidBounds(preview?.bounds) ? preview.bounds : block.bounds
        const bounds = fromPdfViewportRectangle(previewBounds, viewport)
        const originalBounds = fromPdfViewportRectangle(block.bounds, viewport)
        const style = preview?.style ?? block.style
        return (
          <div
            key={block.blockId}
            className={`original-text-block${
              selectedId === block.blockId ? ' is-selected' : ''
            }${preview?.overflow ? ' has-overflow' : ''}${
              preview ? ' has-preview' : ' is-pristine'
            }`}
            style={{
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              color: style.color,
              textAlign: style.alignment,
            }}
            role="button"
            tabIndex="0"
            aria-label={`编辑原文：${block.text}`}
            onClick={(event) => selectBlock(event, block.blockId, originalBounds)}
            onDoubleClick={(event) => {
              selectBlock(event, block.blockId, originalBounds)
              setEditingId(block.blockId)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(block.blockId)
                setEditingId(block.blockId)
              }
            }}
          >
            {preview && maskColors[block.blockId] && (
              <span
                className="original-text-mask"
                aria-hidden="true"
                style={{
                  left: originalBounds.x - bounds.x,
                  top: originalBounds.y - bounds.y,
                  width: originalBounds.width,
                  height: originalBounds.height,
                  backgroundColor: maskColors[block.blockId],
                }}
              />
            )}
            {editingId === block.blockId ? (
              <textarea
                className="original-text-input"
                aria-label={`直接编辑原文：${block.text}`}
                autoFocus
                value={preview?.replacementText ?? block.text}
                ref={(element) => {
                  if (element) contentRefs.current.set(block.blockId, element)
                  else contentRefs.current.delete(block.blockId)
                }}
                style={{
                  ...contentRotationStyle(viewport.rotation ?? 0, bounds),
                  backgroundColor: maskColors[block.blockId] ?? 'transparent',
                }}
                onChange={(event) => onChange({ replacementText: event.target.value })}
                onBlur={() => setEditingId(null)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                  event.stopPropagation()
                }}
              />
            ) : (
              <span
                className="original-text-content"
                ref={(element) => {
                  if (element) contentRefs.current.set(block.blockId, element)
                  else contentRefs.current.delete(block.blockId)
                }}
                style={contentRotationStyle(viewport.rotation ?? 0, bounds)}
              >
                {preview?.replacementText ?? block.text}
              </span>
            )}
            {selectedId === block.blockId && resizeHandles.map(([direction, label]) => (
              <button
                key={direction}
                className={`original-text-resize-handle original-text-resize-handle--${direction}`}
                type="button"
                aria-label={label}
                onPointerDown={(event) => resizeBlock(event, block.blockId, bounds, direction)}
                onClick={(event) => event.stopPropagation()}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
