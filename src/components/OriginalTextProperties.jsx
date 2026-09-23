function numericValue(value) {
  return Number.isFinite(value) ? value : ''
}

export function OriginalTextProperties({
  block,
  draft,
  error,
  preflighting = false,
  onChange,
  onApply,
  onCancel,
}) {
  return (
    <div className="property-fields original-text-properties">
      <div className="original-font-summary">
        <span>当前字体</span>
        <strong>{block.style.fontFamily}</strong>
      </div>
      <label>
        <span>文字内容</span>
        <textarea
          aria-label="原文内容"
          rows="3"
          value={draft.replacementText}
          onChange={(event) => onChange({ replacementText: event.target.value })}
        />
      </label>
      <label>
        <span>字号</span>
        <input
          aria-label="原文字号"
          type="number"
          min="6"
          max="96"
          value={numericValue(draft.style.fontSize)}
          onChange={(event) => onChange({
            style: {
              ...draft.style,
              fontSize: event.target.value === '' ? Number.NaN : Number(event.target.value),
            },
          })}
        />
      </label>
      <label>
        <span>文字颜色</span>
        <span className="color-field">
          <input
            aria-label="原文颜色"
            type="color"
            value={draft.style.color}
            onChange={(event) => onChange({
              style: { ...draft.style, color: event.target.value },
            })}
          />
          <code>{draft.style.color.toUpperCase()}</code>
        </span>
      </label>
      <label>
        <span>对齐方式</span>
        <select
          aria-label="原文对齐"
          value={draft.style.alignment}
          onChange={(event) => onChange({
            style: { ...draft.style, alignment: event.target.value },
          })}
        >
          <option value="left">左对齐</option>
          <option value="center">居中</option>
          <option value="right">右对齐</option>
        </select>
      </label>
      <fieldset className="bounds-fields">
        <legend>文字框尺寸</legend>
        <label>
          <span>宽度</span>
          <input
            aria-label="文字框宽度"
            type="number"
            min="1"
            value={numericValue(draft.bounds.width)}
            onChange={(event) => onChange({
              bounds: {
                ...draft.bounds,
                width: event.target.value === '' ? Number.NaN : Number(event.target.value),
              },
            })}
          />
        </label>
        <label>
          <span>高度</span>
          <input
            aria-label="文字框高度"
            type="number"
            min="1"
            value={numericValue(draft.bounds.height)}
            onChange={(event) => onChange({
              bounds: {
                ...draft.bounds,
                height: event.target.value === '' ? Number.NaN : Number(event.target.value),
              },
            })}
          />
        </label>
      </fieldset>
      {block.fontPolicy !== 'original' && (
        <p className="font-fallback-warning">
          原字体不可写入，导出时将使用替代字体
        </p>
      )}
      {draft.overlapsOtherBlock && (
        <p className="overlap-warning">文字框与其他内容重叠，请确认排版</p>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <p className="layout-preview-note">页面内为近似预览，导出前会再次校验排版。</p>
      <div className="property-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>
          取消
        </button>
        <button
          className="primary-button"
          type="button"
          aria-busy={preflighting}
          disabled={Boolean(error) || preflighting}
          onClick={onApply}
        >
          应用修改
        </button>
      </div>
    </div>
  )
}
