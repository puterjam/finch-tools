# Image 2.5

Generate and edit images with OpenAI's GPT Image models, right inside a Finch conversation — text-to-image, image-to-image, masked edits and transparent cut-outs, saved as local files ready to view or share.

## What it does

- **Text-to-image** — describe what you want, get a picture.
- **Image-to-image** — hand it one or more reference images plus a prompt, and it generates a new image guided by them (restyle a photo, remix a product shot, follow a reference's composition, etc.).
- **Masked edits** — add a mask image and only the masked area changes.
- **Transparent cut-outs** — ask for a transparent background and get a PNG/WebP you can drop straight into a design.
- **Any size you need** — square, portrait, landscape, 2K or 4K, or a custom `WIDTHxHEIGHT`.
- **Quality you control** — from a cheap `low` draft up to `max` detail, so a quick idea doesn't cost what a final asset costs.
- **Live previews** — for a slow, high-quality render it can stream low-resolution previews while it works, so you can bail early instead of waiting two minutes for a miss.
- **Two models to pick from** — Sunburst when editing precision matters, Flare for fast everyday generation.
- **Cheap by default** — unless you ask for better, it stays on Flare + `low` + `1024x1024`, the cheapest combination.
- **Every image is kept** — a masonry gallery collects your generations, and you can send any of them straight back for another pass.
- Every generated image is saved to a local file. Finch reports the file path back in the chat, so you can immediately ask to send it over WeChat, attach it to the composer, or open it.
- **Custom / relay endpoint** — by default it talks to `https://api.openai.com/v1`, but you can point it at any OpenAI-compatible proxy or relay ("中转站") instead, either permanently or for a single request.

## Image gallery

Every generation lands in the gallery — open it from the **Image 2.5** entry in the left sidebar (full-screen App View), or from the **Image 2.5** panel inside a session.

- **Compact masonry** — cards never exceed 220px, with at most five columns. Narrow Panels reflow without stretching a lone image. Click the picture for the native preview.
- **Less chrome** — format and pixel size at the top-left; hover for two lines of prompt over a bottom gradient, and edit/remove buttons at the top-right. Session filters sit below the title, like the Artifacts library.
- **Edit in place** — the editor fills its Panel or App View. The picture gets the whole area and the tool capsule floats on top of it, with no fixed-width side panel.
- **Draw and comment** — freehand red lines and any number of numbered comments. Click the picture to drop a comment, which opens a small bubble right there to type into; drag its pin to move the comment, Escape to close. The editor height never changes.
- **A slim footer** — one instruction field and one button. Inside a session panel or on Home it **attaches the edits** to the input box; in the sidebar App View, which has no input box, the same button **sends them to a new chat**.
- **Drafts are saved**, and removing an image only removes its gallery entry — the original file is kept.

The attach buttons need a Composer to write into, so they appear when the gallery is opened from a session panel or Home. From the sidebar App View, which has no input box, the editor sends the edit into a chat instead — and if your Finch does not support that, it says where to open the gallery rather than showing a dead button.

## Setup

1. Install and enable this mini tool in Finch's Toolcase.
2. On the Image 2.5 card in Toolcase, click its **settings** (gear) menu → **OpenAI API Key**, paste your key, and save. The same menu has **API Base URL** if you want an OpenAI-compatible proxy or relay instead of the official `https://api.openai.com/v1` — leave it empty to use the default.
3. (Optional) In any Composer, the **Image 2.5** toolbar button holds the everyday generation defaults: **Default model**, **Default quality**, **Default size**. Those are only fallbacks — asking in chat still overrides them for a single request.
4. That's it. Just ask Finch to generate an image.

## Example prompts

- "Generate a poster for a coffee shop opening, warm tones, 1536x1024"
- "Quick low-quality draft of a friendly robot mascot, then redo it at high quality once I pick a design"
- "Cut this product out of the background and give me a transparent PNG"
- "Only change the pool in this photo — add a flamingo" (attach the photo and a mask)
- "帮我把这张产品图换个背景，参考图见附件" (attach an image, then ask)
- "Give me 4 square icon variations of a friendly robot mascot"

## Sizes and quality

| Want | Ask for |
| --- | --- |
| Square / landscape / portrait | `1024x1024` · `1536x1024` · `1024x1536` |
| Bigger | `2048x2048`, `2048x1152`, `2560x1440`, `3840x2160`, `2160x3840` |
| Something exact | any `WIDTHxHEIGHT` — edges are multiples of 16, aspect ratio within 3:1, no edge over 3840px |
| Drafts | `low` or `medium` quality |
| Final assets | `high`, `xhigh` or `max` quality |
| Transparent background | `background: transparent` (with `png` or `webp`) |
| Small file | `jpeg` or `webp`, optionally with a compression level |

Quality and size both drive cost and waiting time, so it's worth drafting low and only raising both for the version you keep.

## Using a proxy / relay endpoint

Click the **settings** (gear) menu on the Image 2.5 card in Toolcase → **API Base URL**, type the endpoint, and save. It applies to every future generation until you change it again (leave the field empty and save to go back to the official endpoint). For a one-off different endpoint on a single request, you can also just ask in chat, e.g. "这次用 https://my-relay.example.com/v1 生成" — that overrides only that call without touching the saved setting.

## Notes

- Reference images and masks must be local files already on your machine (the model reads them from disk — no need to upload manually). A mask has to match the image it applies to in format and size.
- GPT Image models may require OpenAI API organization verification on your account; if a generation fails with a permissions error, check that first.
- Generated files live in this mini tool's private storage folder and are safe to reuse, move, or delete.
- Requires your own OpenAI API key and account credit; usage is billed by OpenAI, not by Finch.
- The API key entered through the settings button is kept in this mini tool's private local storage (not chat, not the model), and is only ever sent to the configured API endpoint.

---

# Image 2.5 中文说明

在 Finch 对话里直接用 OpenAI 的 GPT Image 模型生成或编辑图片——支持文生图、图生图、局部遮罩编辑和透明底抠图，结果保存为本地文件，随时可以查看或分享。

## 功能

- **文生图**：描述你想要的画面，直接生成图片。
- **图生图**：提供一张或多张参考图加上提示词，模型会参考这些图生成新图（换风格、改背景、借鉴构图等）。
- **遮罩局部编辑**：再给一张遮罩图，就只改遮罩圈出来的区域。
- **透明底抠图**：要透明背景就能直接拿到可放进设计稿的 PNG/WebP。
- **尺寸自由**：方图、横版、竖版、2K、4K，或任意 `宽x高`。
- **画质可调**：从便宜快速的 `low` 草稿到细节拉满的 `max`，随手一试不用花成品的钱。
- **实时预览**：慢的高质量单图可以边生成边返回低分辨率预览，不满意能提前停，不用干等两分钟。
- **两个模型可选**：Sunburst 擅长精修编辑，Flare 适合日常快速生成。
- **默认最省**：不特意要求更好，就一直用 Flare + `low` + `1024x1024` 这个最便宜的组合。
- **生成的图都留着**：瀑布流图片库会收好你的每一张图，随时挑一张发回去继续改。
- 每张生成的图片都会保存为本地文件，Finch 会在对话中返回文件路径，之后可以直接要求通过微信发送、放进输入框附件，或打开查看。
- **自定义/中转接口**：默认请求 `https://api.openai.com/v1`，也可以换成任意兼容 OpenAI 接口格式的代理/中转站，可以永久生效也可以只用一次。

## 图片库

每张生成的图都会进图片库——从左侧边栏的 **Image 2.5** 入口打开（全屏 App View），或者在会话里打开 **Image 2.5** 面板。

- **紧凑瀑布流**：每张卡片最大 220px，每排最多五列；窄面板自动重排，只有一张图也不会撑满整行。点击图片用内置预览器查看。
- **轻量悬停信息**：格式与尺寸在左上角，悬停后底部渐变上显示最多两行提示词，右上角出现编辑、移除按钮。标题下方的筛选沿用成果库风格，不再提供搜索框。
- **区域内全屏编辑**：填满当前 Panel 或 App View，图片占满整个区域，工具条浮动在图片上方，不再有固定宽侧栏。
- **画线与多条评论**：自由画红线，点击图片就地弹出小气泡输入评论；拖动编号点可以改位置，Esc 关闭。底部高度不会因此变化。
- **精简底栏**：一个说明输入框加一个按钮。在会话面板或首页是**插入修改要求**（附到输入框）；在侧边栏 App View 没有输入框，同一个按钮变成**发送到新会话**（带原图和带标注的预览图发给 AI，并直接带你过去，之后继续改仍在同一会话）。
- **草稿自动保存**；移除图片只移除图库记录，原始文件仍保留。

插入按钮需要一个能写入的输入框，所以从会话面板或首页打开图片库时才会出现。从左侧边栏的 App View 打开时没有输入框可插，编辑器会把修改发到会话里；如果你的 Finch 版本不支持直接发送，它会说明去哪里打开图片库，而不是摆一个按了没反应的按钮。

## 使用前配置

1. 在 Finch 工具箱（Toolcase）中安装并启用本小工具。
2. 在工具箱里的 Image 2.5 卡片上点它的**设置**（齿轮）菜单 → **OpenAI API Key**，粘贴你的 Key 并保存。同一个菜单里还有 **API Base URL**——想用兼容 OpenAI 接口格式的代理/中转站代替官方地址 `https://api.openai.com/v1` 就填这里；留空即用官方默认地址。
3. （可选）任意对话的输入框工具栏里的 **Image 2.5** 按钮，管的是日常生图默认参数：**默认模型**、**默认画质**、**默认尺寸**。它们只是兜底值——在聊天里直接说仍然会覆盖本次请求。
4. 之后直接让 Finch 帮你生成图片即可。

## 尺寸与画质

| 需求 | 怎么说 |
| --- | --- |
| 方图 / 横版 / 竖版 | `1024x1024` · `1536x1024` · `1024x1536` |
| 更大 | `2048x2048`、`2048x1152`、`2560x1440`、`3840x2160`、`2160x3840` |
| 精确尺寸 | 任意 `宽x高`：边长为 16 的倍数、宽高比不超过 3:1、单边不超过 3840px |
| 试思路 | 画质 `low` 或 `medium` |
| 出成品 | 画质 `high`、`xhigh` 或 `max` |
| 透明背景 | `background: transparent`（配 `png` 或 `webp`） |
| 想要小文件 | `jpeg` 或 `webp`，可再指定压缩率 |

画质和尺寸同时决定费用和耗时，建议先用低画质试，定下来再调高跑成品。

## 示例提示词

- "帮我生成一张咖啡店开业海报，暖色调，1536x1024"
- "先出一张低画质的友好机器人吉祥物草稿，我选定造型后再跑高画质"
- "把这张产品图抠出来，给我透明底 PNG"
- "只改这张照片里的泳池，加一只火烈鸟"（附上照片和遮罩图）
- "帮我把这张产品图换个背景"（附上参考图后再说）
- "给我生成 4 张正方形的友好机器人吉祥物图标"

## 使用中转站/代理接口

点击工具箱里 Image 2.5 卡片上的**设置**（齿轮）菜单 → **API Base URL**，填入地址后保存即可——修改后对之后每次生成都生效，直到你再次修改（清空后保存即恢复官方地址）。如果只想某一次请求临时换个地址，也可以直接在聊天里说，例如 "这次用 https://my-relay.example.com/v1 生成"，这只影响这一次调用，不会改动已保存的设置。

## 说明

- 参考图和遮罩需要是本机已有的本地文件（模型直接从磁盘读取，不用手动上传）；遮罩要和被编辑的图格式、尺寸一致。
- GPT Image 模型可能需要先在 OpenAI 后台完成组织认证（organization verification）才能调用；如果报权限错误，先检查这一项。
- 生成的文件保存在本小工具的私有存储目录中，可以安全地复制、移动或删除。
- 需要你自己的 OpenAI API Key 和账户余额，费用由 OpenAI 计费，与 Finch 无关。
- 通过设置按钮填入的 API Key 保存在本小工具的私有本地存储中（不会出现在聊天记录或模型里），只会发送给你配置的接口地址。
