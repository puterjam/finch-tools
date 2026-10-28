# Image Tool（生图工具）

Generate and edit images with OpenAI's GPT Image models, right inside a Finch conversation — text-to-image, image-to-image, masked edits and transparent cut-outs, saved as local files ready to view or share.

## What it does

- **Text-to-image** — describe what you want, get a picture.
- **Image-to-image** — hand it one or more reference images plus a prompt, and it generates a new image guided by them (restyle a photo, remix a product shot, follow a reference's composition, etc.). The API takes up to 16 references per request; enough for a real composite, and anything beyond that is refused before the call.
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

Every generation lands in the gallery — open it from the image tool entry in the left sidebar (full-screen App View), or from its panel inside a session.

Older Finch versions remain supported through image annotations containing the complete request. Editable message text is an optional enhancement only when the host exposes it; the released app does not gain it merely by updating this mini tool. Development stays on the published SDK 0.3.15, with no SDK update or publication required.

- **Compact masonry** — cards never exceed 220px, with at most five columns. Narrow Panels reflow without stretching a lone image, and the list keeps clear of the sticky filters above and the window edge below, so no row looks clipped. Reflow and resizing ease over 240ms, respect reduced motion, and keep the same decoded image nodes; shallow 12px edge shades appear only where more cards continue offscreen. Click the picture for the native preview.
- **Opens fast, stays fast** — the grid renders 4K originals from thumbnails it made itself, keeps them on disk, and shows the library 20 cards at a time as you scroll, and keeps paging on its own when the window is taller than one page. The title and the session filters stay pinned on top, with a divider once the grid passes under them.
- **Less chrome** — the card is just the picture; hover brings up two lines of prompt over a bottom gradient plus the action buttons, and click opens Finch's native preview. A wide picture makes a short card: the wording drops to one line and always stops below the buttons, so the two never collide. Session filters sit below the title, like the Artifacts library.
- **Attach in one click** — inside a session Panel, hovering a card offers **Attach**: the picture and its original prompt enter the input box together, as annotations on older hosts or editable text on capable hosts. The action uses a copy icon rather than a paperclip, and adds no toast of its own: Finch's own added-context confirmation is the signal, so only failures speak up. No editor detour for "look at this picture".
- **Edit in place** — the editor fills its Panel. The picture gets the whole area and the tool capsule floats on top of it, with no fixed-width side panel.
- **Draw and comment** — freehand red lines and any number of numbered comments. Click the picture to drop a comment, which opens a small bubble right there to type into; drag its pin to move the comment, Escape to close. Short tool hints appear only on hover, never in a footer row. Clear first becomes a warning-colored **Confirm clear** button; click again to clear, or Escape/click elsewhere to cancel. Clearing resets undo history. The editor height never changes. The capsule keeps the tools in the order you use them: **annotate / comment / size**, a divider, then **undo / clear** — clearing uses Lucide's `brush-cleaning` icon.
- **Ask for a different shape while you edit** — the toolbar's **Size** tool puts the aspect into the request it inserts ("Output size: 16:9 (1280x720)"), so that request carries its own size instead of quietly changing the tool's defaults. The line goes to the Composer, never into the editor's own instruction box — one copy, where the model reads it and you can still edit it. Picking the current size again takes it back.
- **Adjust from the App View** — the sidebar gallery browses; its cards hand an image back to the session that produced it. Click **Adjust** and Finch opens that session, with an already-open gallery panel dropping straight into the editor.
- **A slim footer** — one instruction field and one button. Inside a session panel or on Home, **Attach image + request** inserts a reference: `[quote src="<marked preview>"]` carries the picture to work from (the one showing your marks) and the generated wording — the numbered comments with their percentage positions; your own instruction stays ordinary prose above it. The marked preview is written to disk first, so exactly one picture reaches the input box instead of an extra attachment next to the original. Older Finch keeps the same content inside an image annotation. Successful insertion keeps the editor open and the instruction intact, but clears all marks and their undo history. Failed insertion preserves the marks for retry. A card's **Attach** also carries its original prompt. Older Finch builds keep using image annotations with the full request; no app update is required to use insertion. A panel scope with no input box of its own sends everything to a new chat instead.
- **Honest progress** — a long render shows Finch's image-generation animation with the requested pixel size as a badge, refreshed with elapsed time, and streaming previews report as they arrive. It only appears once the request is actually on the wire — reading and uploading your reference images first is a plain tool state, not a drawing. An `auto` size has no badge, because nobody knows the pixels yet.
- **Drafts are saved**, and removing an image only removes its gallery entry — the original file is kept.

Editing needs a Composer to write into, so the editor opens from a session panel or a Home panel. The sidebar App View, which has no input box, offers **Adjust** instead of **Edit**; a card whose image was not created in a session offers neither.

## Setup

1. Install and enable this mini tool in Finch's Toolcase.
2. On the image tool card in Toolcase, click its **settings** (gear) menu → **OpenAI API Key**, paste your key, and save. The same menu has **API Base URL** if you want an OpenAI-compatible proxy or relay instead of the official `https://api.openai.com/v1` — leave it empty to use the default.
3. (Optional) In any Composer, the **Image Tool** toolbar button holds the everyday generation defaults — **Default model**, **Default quality** and **Default size** — as hover submenus, so a change is one click and never a dialog. The size list is by aspect ratio (square 1:1, portrait 3:4, story 9:16, landscape 4:3, wide 16:9, or let the model decide). Those are only fallbacks — asking in chat still overrides them for a single request.
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

Click the **settings** (gear) menu on the image tool card in Toolcase → **API Base URL**, type the endpoint, and save. It applies to every future generation until you change it again (leave the field empty and save to go back to the official endpoint). For a one-off different endpoint on a single request, you can also just ask in chat, e.g. "这次用 https://my-relay.example.com/v1 生成" — that overrides only that call without touching the saved setting.

## Notes

- Reference images and masks must be local files already on your machine (the model reads them from disk — no need to upload manually). A mask has to match the image it applies to in format and size.
- GPT Image models may require OpenAI API organization verification on your account; if a generation fails with a permissions error, check that first.
- Generated files live in this mini tool's private storage folder and are safe to reuse, move, or delete.
- Requires your own OpenAI API key and account credit; usage is billed by OpenAI, not by Finch.
- The API key entered through the settings button is kept in this mini tool's private local storage (not chat, not the model), and is only ever sent to the configured API endpoint.

---

# 生图工具 中文说明

在 Finch 对话里直接用 OpenAI 的 GPT Image 模型生成或编辑图片——支持文生图、图生图、局部遮罩编辑和透明底抠图，结果保存为本地文件，随时可以查看或分享。

## 功能

- **文生图**：描述你想要的画面，直接生成图片。
- **图生图**：提供一张或多张参考图加上提示词，模型会参考这些图生成新图（换风格、改背景、借鉴构图等）。接口一次最多接受 16 张参考图，超过会在发请求前直接拒绝。
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

每张生成的图都会进图片库——从左侧边栏的 **生图工具** 入口打开（全屏 App View），或者在会话里打开 **生图工具** 面板。

**兼容旧版 Finch**：旧宿主使用图片批注承载完整说明，可以正常插入，但批注不是可编辑正文。只有宿主实际提供新能力时才增强为正文；单独更新小程序不会让旧 App 获得这项能力。开发依赖固定使用已发布的 SDK 0.3.15，不要求升级或发布 SDK。

- **紧凑瀑布流**：每张卡片最大 220px，每排最多五列；窄面板自动重排，只有一张图也不会撑满整行。列表上下都留白：首行不贴筛选栏，末行不贴窗口底，两端都不会像被裁掉。换列、变大变小都有 240ms 缓动，不重建图片，并尊重系统减少动态效果设置；列表边缘仅在还有内容时出现 12px 的浅遮挡阴影。点击图片用内置预览器查看。
- **打开快、翻得快**：网格不用 4K 原图，而是用页面自己生成的缩略图（存在本地，下次打开直接用），并且一次只渲染 20 张、滚到底再续；窗口比一页还高时会自己继续补页，不用先滚动。标题和会话筛选固定在顶部，网格滚到下面时出现一条分隔线。
- **轻量卡片**：卡片上只有图片本身，悬停时底部渐变上显示两行提示词、右上角出现操作按钮，点击图片用内置预览器查看。特别宽的图会压成矮卡片，此时提示词只留一行并停在按钮下方，两者不会互相遮挡。标题下方的筛选沿用成果库风格，不再提供搜索框。
- **一键插入**：在会话面板里悬停卡片会多出一个**插入**按钮，把图片和原始提示词一起插入（附件本身就是原图，正文不再重复原图路径）；旧宿主走图片批注，支持新能力的宿主才使用可编辑正文；图标改为复制而非别针；只想「让助手看看这张图」时不用绕进编辑器。插入成功不再多弹一条提示，宿主的「已添加上下文」就是确认；只有失败才提示。
- **区域内全屏编辑**：填满当前 Panel，图片占满整个区域，工具条浮动在图片上方，不再有固定宽侧栏。
- **画线与多条评论**：自由画红线，点击图片就地弹出小气泡输入评论；拖动编号点可以改位置，Esc 关闭。工具提示只在悬停时显示短气泡，不再占据底部。清除先变成警告色的「确认清除标记」按钮，再点一次执行；Esc 或点其他位置取消，清除后不保留撤销记录。底部高度不会因此变化。工具条按使用顺序排：**标注 / 评论 / 尺寸**，一条分割线，然后是**撤销 / 清除**——清除使用 `brush-cleaning` 清扫图标。
- **编辑时顺手改画幅**：工具栏的**尺寸**按钮把想要的画幅写进**插入的这次请求**（如「输出尺寸：16:9（1280x720）」），这次请求自带尺寸，不去改工具的默认值；这一行只进输入框，不再写进编辑器自己的说明框（否则要手动删重复）。再点一次当前尺寸就取消。
- **在 App View 里调整**：侧边栏图库只管浏览，卡片会把图片交回生成它的会话。点**调整**就会打开对应会话，已经开着图片库面板的会话还会直接进入编辑。
- **精简底栏**：一个说明输入框加一个按钮。在会话面板或首页点**插入图片和说明**，插入的是一条引用：`[quote src="标注预览"]` 带着要看的图片（带标注的那张）和生成的说明（编号评论，平台会把引用里的图片路径一并带给模型），你自己写的整体说明仍留在引用上方作为普通正文。标注预览会先写到磁盘，所以输入框里只会有**一张**图，不会在原图旁边再挂一个附件。旧版 Finch 仍把这些内容放进图片批注。插入成功后仍停留在当前编辑页，保留整体说明，自动清除全部标记和撤销记录；插入失败则保留标记供重试。卡片上的**插入**也带上原始提示词。旧版 Finch 正常使用图片批注携带完整说明，不强制更新 App。在没有自有输入框的面板作用域里，同一个按钮会改成**发送到新会话**。
- **进度如实反馈**：出图期间显示 Finch 的生图动效，角标是本次请求的像素尺寸，并逐秒刷新已用时间；开了流式预览就逐张上报。它只在请求真的发出去之后出现——之前读参考图、拼请求的阶段是普通的工具状态，不会假装已经在画。尺寸是 `auto` 时不给角标，因为这时谁都不知道像素。
- **草稿自动保存**；移除图片只移除图库记录，原始文件仍保留。

编辑需要一个能写入的输入框，所以编辑器从会话面板或首页面板打开。侧边栏 App View 没有输入框，卡片给的是**调整**而不是**编辑**；不是在会话里生成的图片则两个都不给。

## 使用前配置

1. 在 Finch 工具箱（Toolcase）中安装并启用本小工具。
2. 在工具箱里的生图工具卡片上点它的**设置**（齿轮）菜单 → **OpenAI API Key**，粘贴你的 Key 并保存。同一个菜单里还有 **API Base URL**——想用兼容 OpenAI 接口格式的代理/中转站代替官方地址 `https://api.openai.com/v1` 就填这里；留空即用官方默认地址。
3. （可选）任意对话的输入框工具栏里的 **生图工具** 按钮，管的是日常生图默认参数：**默认模型**、**默认画质**、**默认尺寸**——都是悬停展开的二级菜单，选一下就生效，不再弹窗。尺寸按画幅列：正方形 1:1、竖向 3:4、故事版式 9:16、横向 4:3、宽屏 16:9，也可以交给模型决定。它们只是兜底值——在聊天里直接说仍然会覆盖本次请求。
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

点击工具箱里生图工具卡片上的**设置**（齿轮）菜单 → **API Base URL**，填入地址后保存即可——修改后对之后每次生成都生效，直到你再次修改（清空后保存即恢复官方地址）。如果只想某一次请求临时换个地址，也可以直接在聊天里说，例如 "这次用 https://my-relay.example.com/v1 生成"，这只影响这一次调用，不会改动已保存的设置。

## 说明

- 参考图和遮罩需要是本机已有的本地文件（模型直接从磁盘读取，不用手动上传）；遮罩要和被编辑的图格式、尺寸一致。
- GPT Image 模型可能需要先在 OpenAI 后台完成组织认证（organization verification）才能调用；如果报权限错误，先检查这一项。
- 生成的文件保存在本小工具的私有存储目录中，可以安全地复制、移动或删除。
- 需要你自己的 OpenAI API Key 和账户余额，费用由 OpenAI 计费，与 Finch 无关。
- 通过设置按钮填入的 API Key 保存在本小工具的私有本地存储中（不会出现在聊天记录或模型里），只会发送给你配置的接口地址。
