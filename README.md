# 轻量 PDF 编辑器

一个面向中文场景的浏览器端 PDF 工具：添加文字、勾选、视觉签名标记、图片、遮挡文字、合并与按页提取，处理结果直接下载。

**在线体验：** <https://pdf-editor-mini.pages.dev>

> 文件只在当前浏览器中读取和处理，不上传、不保存，也不需要登录或安装软件。

本仓库是公开的浏览器版源码快照。线上站点由维护者独立部署；向本仓库提交代码不会自动更新线上网站。

## 功能

- 添加文字：支持思源黑体、思源宋体、常规/粗体和标准颜色；双击文字即可直接修改。
- 添加勾选、PNG/JPG 图片与手写签名视觉标记。
- 遮挡文字：用可缩放的背景色矩形遮住旧内容，再添加新文字；可从 PDF 页面邻近位置取背景色。
- 合并 PDF：最多 4 个文件，可调整合并顺序。
- 拆分 PDF：按页码或页码范围提取新文件，例如 `1-3, 5, 8-10`。
- 导出：所有编辑、合并和拆分都在浏览器中完成并下载。

## 使用边界

- 单个 PDF 最大 30 MB、最多 100 页；合并最多 4 个 PDF。
- “遮挡文字”是视觉覆盖，不是删除或重写 PDF 原始文字；复杂纹理、渐变或图片背景需要自行检查最终效果。
- 手写签名是视觉文档标记，不是可靠电子签名或法律意义上的电子签章。
- 加密、损坏或无法解析的 PDF 可能无法处理。

## 本地开发

```bash
npm ci
npm run dev
```

常用命令：

```bash
npm test          # 前端单元测试
npm run build     # 构建静态站点产物
npm run test:sites # 验证 Cloudflare Pages/Sites 打包入口
```

构建后，浏览器静态文件位于 `dist/client/`。项目已经包含单页应用回退所需的 `worker/index.js` 与 `.openai/hosting.json`。

## 技术栈

- React + Vite
- PDF.js：页面预览
- pdf-lib：浏览器端导出、合并与拆分
- `@pdf-lib/fontkit`：中文字体嵌入
- `hb-subset-wasm`：在浏览器本地裁剪导出所需字形，减少 PDF 体积；不可用时回退到完整字体
- Cloudflare Pages：静态站点托管

## 字体许可

项目随附的思源字体遵循 SIL Open Font License 1.1，完整文本见 [src/assets/fonts/OFL.txt](src/assets/fonts/OFL.txt)。

## 参与贡献与安全问题

- 贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请遵循 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中披露可利用细节。

## 许可证

项目代码采用 [MIT License](LICENSE)。随附的思源字体遵循 [SIL Open Font License 1.1](src/assets/fonts/OFL.txt)；第三方依赖各自遵循其许可证。
