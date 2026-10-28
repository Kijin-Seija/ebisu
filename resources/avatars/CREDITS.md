# 头像与商标来源

七种模型头像为 ZipZipPipe 的社区娘化形象，不是模型厂商官方角色。
素材来自 [ai-girls](https://github.com/shuaizenge/ai-girls)，原作品为
[《大 AI 和小 AI 们》](https://www.bilibili.com/video/BV1tE9XBbErS/)，
作者 [ZipZipPipe](https://space.bilibili.com/4168597)。

本项目从公开截帧裁切头像、缩放至 256×256，并转换为 WebP。
固定来源提交、每张原图 URL、SHA-256、时间位置和裁切范围见 `sources.json`。
上游完整署名说明保存在 `UPSTREAM-NOTICE.md`。

`backgrounds/model-*.png` 是用于主窗口卡片装饰的透明轮廓衍生图，沿用上述来源、作者和许可。
通过 `python3 scripts/make-avatar-backgrounds.py`（依赖 Pillow）从本地 WebP 生成：
移除与画面边缘连通的浅色底色，保留人物主体并柔化边缘。原始小头像不受影响。
自定义头像若用于轮廓叠放，建议选择带透明背景的 PNG/WebP；程序不会猜测任意照片的主体。

`q-version/model-*.webp` 是基于上述角色形象生成的 Q 版托盘素材，`tray/model-*.png`
是水平线以下桌面白底已抠除、仅保留手与装饰的透明衍生图，供托盘卡片底部溢出显示。通过
`python3 scripts/make-tray-avatars.py`（依赖 Pillow）生成；主窗口不使用这些文件。
Q 版素材仍属于上述角色形象的衍生作品，沿用原作者署名与相应用许可条件，
不代表模型厂商官方角色。

DeepSeek 形象原始创作者为上善无形，女仆二次设计为 ZipZipPipe。
其头像和裁切衍生图依 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
保留署名、非商业与相同方式共享条件。其他角色按作者公开的分享和再创作声明使用，
没有额外声称属于 MIT 或 CC0。应用源代码的 MIT 许可不重新授权这些图片。

终端商标：

- Codex 使用 OpenAI 标识、Claude Code 使用 Claude 标识、Grok 与 Qoder 使用各自标识。
  SVG 来自 [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons)
  中的 `openai.svg`、`claude-color.svg`、`grok.svg`、`qoder.svg`。
  图标库代码采用 MIT，品牌及商标权归相应公司。
- WorkBuddy 图标提取自本机官方 `WorkBuddy.app/Contents/Resources/icon.icns`，
  用于识别已安装的应用，权利归 WorkBuddy / 腾讯。
- DeepSeek Harness 图标提取自官方 `DeepSeek Harness.app/Contents/Resources/icon.png`，
  仅缩放为 128×128 PNG，用于识别已安装的应用；权利归 DeepSeek。
- Ebisu 应用图标与托盘图标由本项目绘制，随代码采用 MIT。
