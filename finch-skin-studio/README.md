# Skin Studio

Design and manage how Finch looks — Home background and color skins — from one place.

## What it does

- **Home background** — pick a local image for the Home background, choose whether it fills the window or tiles, and adjust its brightness. Clear it any time to go back to a plain theme surface.
- **AI-designed skins** — ask the assistant to design a color skin ("设计一个薄荷绿的深色皮肤" / "design a mint dark skin") and it applies instantly. Like it? Save it to your personal skin library with one click.
- **Extract your current skin** — already have a look you like? Save whatever is currently applied as a named custom skin, no need to remember the exact colors.
- **6 built-in presets** — 3 light (Snow White, Mint Morning, Peach Cream) and 3 dark (Graphite, Midnight Berry, Deep Teal), ready to use immediately.
- **Switch back to Finch's own theme** — not just custom skins: a segmented control lets you drop back to Finch's built-in Auto/Light/Dark system theme at any time.
- **Export & import skins** — export any custom skin as a small JSON file to back it up or share it, and import one someone else sent you back into your library.
- **Card gallery panel** — open the palette icon in the Composer toolbar (or the right Panel launcher) to browse every preset and custom skin as a rounded thumbnail card, switch with one click, and manage the background image — all without going through the AI.

## Using it

**From chat:** just describe what you want — "把首页背景换成这张图，铺满显示" or "apply the Deep Teal skin" or "save this as 'My Sunset'" or "switch back to the system dark theme". The assistant calls the right tool and it takes effect immediately, exactly like editing Appearance Settings yourself.

**From the panel:** click the palette icon in the Composer toolbar to open the Skin Studio panel. The background card lets you pick an image, toggle Fill/Tile, and adjust brightness. Above the skin gallery, a small Auto/Light/Dark control switches back to Finch's own built-in theme. The gallery itself shows built-in presets plus anything you've saved; click a card to apply it, hover a custom card to export or delete it, click "Save current skin" to name and keep whatever's currently applied, or click "Import skin" to load a `.json` file exported from Skin Studio.

**Picking a background image:** click "Choose image" (or the "Import skin" card) to open your operating system's own native file dialog — no more browsing through a Finch-themed file tree. You can also just **drag an image file and drop it onto the preview box**; that works for any image on disk regardless of where it lives. Dropped/picked images are copied into this mini tool's private storage (max 15MB), and the previous copy is cleaned up automatically once you set a new one.

## Notes

- Skin Studio can only "remember" a skin's exact colors if it was applied, saved, or imported through Skin Studio itself (a built-in preset, an AI-designed skin, or something you explicitly saved/imported) — it has no way to read an already-applied skin that came from somewhere else.
- Exported skin files only contain color values and a name — no personal data, background images, or paths.
- All data (saved skins, last-set background path, dropped background copies) is stored locally in this mini tool's private storage; nothing is sent over the network.
- Requires a Finch version whose Appearance API is enabled; older builds show a clear error instead of silently failing.

---

# 换肤工坊

在一处集中设计和管理 Finch 的外观——首页背景与配色皮肤。

## 功能

- **首页背景** — 选择一张本地图片作为首页背景，设置铺满或平铺，并调整明暗程度。随时可以清除，恢复为纯色主题底。
- **AI 设计皮肤** — 直接让 AI 帮你设计一套配色（比如"设计一个薄荷绿的深色皮肤"），会立刻生效。喜欢的话一键保存到自己的皮肤库。
- **提取当前皮肤** — 已经调出了满意的效果？把当前正在使用的配色保存为一个自定义皮肤，不用自己记颜色值。
- **6 套内置预设** — 明亮 3 套（简白、薄荷晨光、蜜桃奶油）、深色 3 套（石墨深邃、深夜莓果、深海青碧），开箱即用。
- **随时切回 Finch 自带主题** — 不只是自定义皮肤：一个分段控件可以随时切回 Finch 内置的跟随系统/浅色/深色主题。
- **导出与导入皮肤** — 把任意自定义皮肤导出为一个小小的 JSON 文件用于备份或分享，也可以把别人发来的皮肤文件导入到自己的皮肤库。
- **卡片画廊面板** — 点击 Composer 工具栏的调色板图标（或右侧面板启动器）打开换肤工坊，用圆角缩略卡片浏览所有预设与自定义皮肤，一键切换，也能可视化管理背景图——全程无需经过 AI。

## 使用方式

**在对话中：** 直接说出你想要的效果——"把首页背景换成这张图，铺满显示"、"应用深海青碧皮肤"、"把这个保存为『我的落日』"、"切回系统深色主题"，AI 会调用对应工具立即生效，效果等同于自己在外观设置里操作。

**在面板中：** 点击 Composer 工具栏的调色板图标打开换肤工坊面板。背景卡片可以选图、切换铺满/平铺、调整明暗；皮肤画廊上方有一个跟随系统/浅色/深色的小控件，可以切回 Finch 自带主题。画廊本身展示内置预设和已保存的自定义皮肤，点击卡片即可应用，鼠标悬停自定义卡片可导出或删除它，点击"保存当前皮肤"即可为当前效果命名保存，点击"导入皮肤"即可加载一个从换肤工坊导出的 `.json` 文件。

**选择背景图片：** 点击"选择图片"（或"导入皮肤"）会直接打开操作系统自带的原生文件选择框，不再是 Finch 自己的文件树浏览器。你也可以直接**把一张图片拖拽到预览框里**，不管它存在磁盘上哪个位置都能用。拖放/选中的图片会被复制一份保存到本小程序的私有存储里（最大 15MB），换新图后旧的那份会自动清理掉。

## 说明

- 换肤工坊只能"记住"通过它自己应用、保存或导入过的皮肤配色（内置预设、AI 设计的皮肤、或手动保存/导入过的皮肤）——无法读取从其他途径应用、从未经过换肤工坊的皮肤。
- 导出的皮肤文件只包含颜色值和名称，不含个人数据、背景图或路径信息。
- 所有数据（已保存的皮肤、最近设置的背景路径、拖放进来的背景图副本）都保存在本小程序的本地私有存储中，不会上传到网络。
- 需要 Finch 版本已启用外观（Appearance）API；旧版本会给出明确的错误提示，而不是静默失败。
