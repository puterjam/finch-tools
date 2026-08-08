# Image Gen (OpenAI)

Generate and edit images with OpenAI's image models, right inside a Finch conversation — text-to-image and image-to-image, saved as local files ready to view or share.

## What it does

- **Text-to-image** — describe what you want, get a picture.
- **Image-to-image** — hand it one or more reference images plus a prompt, and it generates a new image guided by them (restyle a photo, remix a product shot, follow a reference's composition, etc.).
- **Size / aspect ratio** — pick square, portrait, landscape, or let the model choose automatically.
- **Multiple images at once** — ask for up to 4 variations in one go.
- Every generated image is saved to a local file. Finch reports the file path back in the chat, so you can immediately ask to send it over WeChat, attach it to the composer, or open it.

## Setup

1. Install and enable this mini tool in Finch's Toolcase.
2. Open its settings and fill in your **OpenAI API key** (`OPENAI_API_KEY`). Finch stores it securely — it is never shown in chat or sent anywhere except OpenAI's API.
3. That's it. Just ask Finch to generate an image.

## Example prompts

- "Generate a poster for a coffee shop opening, warm tones, 1536x1024"
- "帮我把这张产品图换个背景，参考图见附件" (attach an image, then ask)
- "用这张照片的构图，生成一张赛博朋克风格的插画"
- "Give me 4 square icon variations of a friendly robot mascot"

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

## 使用前配置

1. 在 Finch 工具箱（Toolcase）中安装并启用本小工具。
2. 打开它的设置，填入你的 **OpenAI API Key**（`OPENAI_API_KEY`）。Finch 会安全存储该密钥，不会出现在聊天记录里，也只会用于请求 OpenAI 接口。
3. 之后直接让 Finch 帮你生成图片即可。

## 示例提示词

- "帮我生成一张咖啡店开业海报，暖色调，1536x1024"
- "帮我把这张产品图换个背景"（附上参考图后再说）
- "用这张照片的构图，生成一张赛博朋克风格的插画"
- "给我生成 4 张正方形的友好机器人吉祥物图标"

## 说明

- 参考图需要是本机已有的本地文件（模型直接从磁盘读取，不用手动上传）。
- 生成的文件保存在本小工具的私有存储目录中，可以安全地复制、移动或删除。
- 需要你自己的 OpenAI API Key 和账户余额，费用由 OpenAI 计费，与 Finch 无关。
