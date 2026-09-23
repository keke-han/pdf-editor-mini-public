# 字体来源

## Noto Serif SC Regular

- 上游版本：`Serif2.003`
- 官方发行页：<https://github.com/notofonts/noto-cjk/releases/tag/Serif2.003>
- 官方资产：`03_NotoSerifCJK-TTF-VF.zip`
- 官方资产 SHA-256：`ad58364bca7c70a15b40e941df0ce0da85b1e4a882ab176f14e661cf1a0af05e`
- 资产内部路径：`Variable/TTF/Subset/NotoSerifSC-VF.ttf`
- 上游 variable TTF SHA-256：`5326cfb097e3ab26fcb39329752b5c0a439bf8d5c4649520e4b492939c352a09`
- 转换工具：`fonttools 4.60.2`
- 转换命令：`fonttools varLib.instancer NotoSerifSC-VF.ttf wght=400 --update-name-table --output NotoSerifSC-Regular.ttf`
- 项目文件：`NotoSerifSC-Regular.ttf`
- 项目文件 SHA-256：`9622bf3e293ddcc12930a7d0d45d65d56bd259bc2979ea6306f7fc4c1856c895`
- 项目字体名称：family `Noto Serif SC`；style `Regular`；full name `Noto Serif SC Regular`；PostScript name `NotoSerifSC-Regular`
- 下载与转换日期：`2026-07-25`

项目文件是将官方 variable glyf TTF 的 `wght` 固化为 400 后得到的静态
glyf TTF；`fvar`、`gvar`、`avar` 和 `HVAR` 均已移除。此实例化文件属于
SIL Open Font License 1.1 所称的 Modified Version。官方资产内 `LICENSE`
未声明具体 Reserved Font Name，本目录保留完整 `OFL.txt`。

未采用同一发行版 `14_NotoSerifSC.zip` 中的 CFF OTF。Apache PDFBox 3.0.8
的 `PDType0Font.load` 无法写入该字体，且 PDFBox 的 OTF/PostScript 子集支持
仍未实现；派生静态 glyf TTF 可由 PDFBox 加载并按实际使用字形子集嵌入。

## Noto Sans SC / Noto Serif SC Bold

- Noto Sans 上游版本：`Sans2.004`；官方资产：`02_NotoSansCJK-TTF-VF.zip`；资产内部路径：`Variable/TTF/Subset/NotoSansSC-VF.ttf`；上游 variable TTF SHA-256：`d68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964`。
- Noto Serif 上游版本：`Serif2.003`；官方资产：`03_NotoSerifCJK-TTF-VF.zip`；资产内部路径：`Variable/TTF/Subset/NotoSerifSC-VF.ttf`；上游 variable TTF SHA-256：`5326cfb097e3ab26fcb39329752b5c0a439bf8d5c4649520e4b492939c352a09`。
- 官方发行页：<https://github.com/notofonts/noto-cjk/releases>；转换工具：`fonttools 4.60.2`；转换命令：`fonttools varLib.instancer <variable-font>.ttf wght=700 --update-name-table --output <static-font>.ttf`。
- 项目文件 SHA-256：`NotoSansSC-Bold.ttf` 为 `19c5dc453ea959e10011ee1d3eddf559eb4f56b4f2cbf3fd2eae50bf5898f0cb`；`NotoSerifSC-Bold.ttf` 为 `e87d27cf1b40cd16aff7ffa5e301cc93fd72cd2f305575dba1ba34868563a407`。
- 两份粗体均为静态 glyf TTF，避免 CFF OTF 在 PDF 阅读器中的嵌入兼容问题；项目继续保留同一上游的 `OFL.txt`。
