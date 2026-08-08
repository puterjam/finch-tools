# Image Gen (OpenAI)

Generate and edit images with OpenAI's image models, right inside a Finch conversation — text-to-image and image-to-image, saved as local files ready to view or share.

## What it does

- **Text-to-image** — describe what you want, get a picture.
- **Image-to-image** — hand it one or more reference images plus a prompt, and it generates a new image guided by them (restyle a photo, remix a product shot, follow a reference's composition, etc.).
- **Size / aspect ratio** — pick square, portrait, landscape, or let the model choose automatically.
- **Multiple images at once** — ask for up to 4 variations in one go.
- Every generated image is saved to a local file. Finch reports the file path back in the chat, so you can immediately ask to send it over WeChat, attach it to the composer, or open it.
- **Custom / relay endpoint** — by default it talks to `https://api.openai.com/v1`, but you can point it at any OpenAI-compatible proxy or relay ("中转站") instead, either permanently or for a single request.

## Setup

1. Install and enable this mini tool in Finch's Toolcase.
2. Open its card in Toolcase and fill in your **OpenAI API key** (`OPENAI_API_KEY`). Finch stores it securely — it is never shown in chat or sent anywhere except OpenAI's API.
3. (Optional) In any Composer, click the **Image Gen settings** button (gear icon) in the toolbar → **API Base URL** if you want to use an OpenAI-compatible proxy/relay instead of the official `https://api.openai.com/v1`. Leave it empty to use the default.
4. That's it. Just ask Finch to generate an image.

## Example prompts

- "Generate a poster for a coffee shop opening, warm tones, 1536x1024"
- "帮我把这张产品图换个背景，参考图见附件" (attach an image, then ask)
- "用这张照片的构图，生成一张赛博朋克风格的插画"
- "Give me 4 square icon variations of a friendly robot mascot"

## Using a proxy / relay endpoint

Click the **Image Gen settings** button (gear icon) in the Composer toolbar → **API Base URL**, type the endpoint, and save. It applies to every future generation until you change it again (leave the field empty and save to go back to the official endpoint). For a one-off different endpoint on a single request, you can also just ask in chat, e.g. "这次用 https://my-relay.example.com/v1 生成" — that overrides only that call without touching the saved setting.

## Notes

- Reference images must be local files already on your machine (the model reads them from disk — no need to upload manually).
- Generated files live in this mini tool's private storage folder and are safe to reuse, move, or delete.
- Requires your own OpenAI API key and account credit; usage is billed by OpenAI, not by Finch.

---

# Image Gen (OpenAI) 中文说明

在 Finch 对话里直接用 OpenAI 图像模型生成或编辑图片——支持文生图和图生图，生成结果保存为本地文件，随时可以查看或分享。

## 功能

- **文生图**：描述你想要的画面，直接生成图片。
- **图生图**：提供一张或多张参考图加上提示词，模型会参考这些图生成新图（换风格、改背景、借鉴构图等）。
- **尺寸/比例**：可选正方形、竖版、横版，或让模型自动选择。
- **一次多张**：一次最多可生成 4 张变体。
- 每张生成的图片都会保存为本地文件，Finch 会在对话中返回文件路径，之后可以直接要求通过微信发送、放进输入框附件，或打开查看。
- **自定义/中转接口**：默认请求 `https://api.openai.com/v1`，也可以换成任意兼容 OpenAI 接口格式的代理/中转站，可以永久生效也可以只用一次。

## 使用前配置

1. 在 Finch 工具箱（Toolcase）中安装并启用本小工具。
2. 打开它的卡片，填入你的 **OpenAI API Key**（`OPENAI_API_KEY`）。Finch 会安全存储该密钥，不会出现在聊天记录里，也只会用于请求 OpenAI 接口。
3. （可选）在任意对话的输入框工具栏里，点击 **Image Gen 设置**（齿轮图标）→ **API Base URL**，如果你想用兼容 OpenAI 接口格式的代理/中转站代替官方地址 `https://api.openai.com/v1`；留空即用官方默认地址。
4. 之后直接让 Finch 帮你生成图片即可。

## 示例提示词

- "帮我生成一张咖啡店开业海报，暖色调，1536x1024"
- "帮我把这张产品图换个背景"（附上参考图后再说）
- "用这张照片的构图，生成一张赛博朋克风格的插画"
- "给我生成 4 张正方形的友好机器人吉祥物图标"

## 使用中转站/代理接口

点击输入框工具栏里的 **Image Gen 设置**（齿轮图标）→ **API Base URL**，填入地址后保存即可——修改后对之后每次生成都生效，直到你再次修改（清空后保存即恢复官方地址）。如果只想某一次请求临时换个地址，也可以直接在聊天里说，例如 "这次用 https://my-relay.example.com/v1 生成"，这只影响这一次调用，不会改动已保存的设置。

## 说明

- 参考图需要是本机已有的本地文件（模型直接从磁盘读取，不用手动上传）。
- 生成的文件保存在本小工具的私有存储目录中，可以安全地复制、移动或删除。
- 需要你自己的 OpenAI API Key 和账户余额，费用由 OpenAI 计费，与 Finch 无关。
