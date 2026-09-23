export const OriginalTextStatus = Object.freeze({
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  READY: 'ready',
  EDITING: 'editing',
  DIRTY: 'dirty',
  REWRITING: 'rewriting',
  MERGING: 'merging',
  ERROR: 'error',
})

export function createOriginalEdit(block) {
  return {
    blockId: block.blockId,
    pageIndex: block.pageIndex,
    originalText: block.text,
    replacementText: block.text,
    bounds: { ...block.bounds },
    style: { ...block.style },
    unsupportedCharacters: [],
    overflow: false,
  }
}

export function validateOriginalEdit(edit) {
  if (!edit || typeof edit !== 'object') return '原文修改数据无效'
  if (typeof edit.blockId !== 'string' || !edit.blockId.trim()) {
    return '原文修改数据无效'
  }
  if (!Number.isInteger(edit.pageIndex) || edit.pageIndex < 0) {
    return '原文修改数据无效'
  }
  if (typeof edit.originalText !== 'string') return '原文修改数据无效'
  if (typeof edit.replacementText !== 'string') return '原文修改数据无效'
  if (!edit.replacementText.trim()) return '文字内容不能为空'

  const bounds = edit.bounds
  if (
    !bounds
    || !Number.isFinite(bounds.x)
    || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width)
    || !Number.isFinite(bounds.height)
    || bounds.width <= 0
    || bounds.height <= 0
  ) {
    return '原文修改数据无效'
  }

  const style = edit.style
  if (
    !style
    || typeof style.fontFamily !== 'string'
    || !style.fontFamily.trim()
    || style.fontFamily.length > 200
    || !Number.isFinite(style.fontSize)
    || style.fontSize < 6
    || style.fontSize > 96
    || typeof style.color !== 'string'
    || !/^#[0-9a-f]{6}$/i.test(style.color)
    || !['left', 'center', 'right'].includes(style.alignment)
  ) {
    return '原文修改数据无效'
  }

  if (
    edit.unsupportedCharacters !== undefined
    && !Array.isArray(edit.unsupportedCharacters)
  ) {
    return '原文修改数据无效'
  }
  if (edit.unsupportedCharacters?.length) {
    return `暂不支持字符：${edit.unsupportedCharacters.join(' ')}`
  }
  if (edit.overflow !== undefined && typeof edit.overflow !== 'boolean') {
    return '原文修改数据无效'
  }
  if (edit.overflow) {
    return '文字超出原区域，请缩小字号、扩大文本框或缩短内容'
  }
  return ''
}

export function applyOriginalEdit(edits, edit) {
  return [
    ...edits.filter(({ blockId }) => blockId !== edit.blockId),
    edit,
  ]
}
