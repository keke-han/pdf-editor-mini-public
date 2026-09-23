import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'

describe('浏览器标签品牌信息', () => {
  it('显示产品名称和中文页面语言', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
    const document = new JSDOM(html).window.document

    expect(document.title).toBe('轻量 PDF 编辑器')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('提供可解析的自有 SVG 标签图标', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
    const document = new JSDOM(html).window.document
    const icon = document.querySelector('link[rel="icon"]')

    expect(icon?.getAttribute('href')).toBe('/favicon.svg')
    expect(icon?.getAttribute('type')).toBe('image/svg+xml')

    const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8')
    const iconDocument = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document
    expect(iconDocument.documentElement.tagName).toBe('svg')
    expect(iconDocument.querySelectorAll('path').length).toBeGreaterThan(0)
  })
})
