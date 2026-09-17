# FinchChan firmware · M5CoreS3 / StackChan

> **给使用者的烧录指南在 [`../firmware.md`](../firmware.md)**（环境准备、编译、刷机、配网、排错）。
> 本文是给改代码的人看的：模块划分、参数含义、诊断日志。

编译并归档产物（输出到 `firmware/release/finchchan-<版本>.bin`，加 `--no-full` 省磁盘、`--elf` 留调试符号）：

```sh
bash tools/build.sh
```

编译 + 上传一步完成（先退出串口监视器）：

```sh
bash tools/flash-all.sh [串口]
```

把 StackChan 变成 Finch 的桌面分身：眼睛表情、气泡文案、RGB 灯效，以及**在设备上直接处理等待中的权限卡与提问卡**。
固件不再打包任何位图资源——表情全部是矢量绘制，没有 LittleFS、没有素材分区。

## 它做什么

- 通过 `ws://<Finch-LAN-IP>:8267/` 连接局域网桥接，指数退避重连（1.5–30 秒）。
- 协议 v1：`hello` → `pair`/`auth` → 认证后的 `command` 帧；设备 token 存在 ESP32 NVS。
- 接收的状态只有固件内定义的几种（`idle`/`thinking`/`working`/`success`/`error`/`sleeping`/`speaking`/`waiting`），
  以及有长度上限的短文案；**永远不接受原始舵机角度或任意图形指令**。
- 收到等待卡片时全屏显示标题与最多 3 个选项，触摸选择后回传作答。
- 回调只入队，绘制/灯效/音频/StackChan 更新都在 Arduino loop 里跑。

## 表情系统（移植自 muspi）

`src/EmotionFace.*` 是用户树莓派项目 [muspi](https://github.com/puterjam/muspi) `ui/emotion.py` 的移植：

- 原设计的关键特征是**脸上只有眼睛**，用 12 种眼型加遮罩雕刻情绪；
- 完整保留了随机眨眼（2–8 秒）、空闲时东张西望与皱眉抽动、以及 shake / shocked / breathe 三种附加动画；
- 屏幕从 80×32 单色 OLED 换成 320×240 彩屏：整脸放大，眼型带上颜色（暖白 / 苔绿 / 琥珀 / 玫瑰 / 雾灰）。
- **眼睛有抗锯齿**：屏幕是 16 位色、没有 alpha，矢量填充（`fillEllipse` / `fillArc` / 斜切三角形）
  画出来都是硬边，60px 的圆边上台阶很明显。所以 `drawEye()` 先在 **2 倍大的离屏画布**
  （`kEyeBufferSize` 160×160，PSRAM）上画形状，再用 `pushRotateZoomWithAA()` 按 0.5 缩放贴回：
  LovyanGFX 缩放时会按透明色算覆盖度做混合，于是**所有形状**（椭圆、弧、斜切三角、爱心）
  一次性都平滑，不用把每个形状都换成"平滑图元"。形状代码（`drawEyeShape()`）保持纯矢量不变；
  离屏画布建不起来时自动退回硬边绘制。

| 状态 | 表情 | 眼睛 |
|---|---|---|
| idle | Neutral | 睁开，随机眨眼与张望 |
| thinking | Thinking | 左睁右皱眉，缓慢呼吸 |
| working | Focused | 半闭眼（专注） |
| waiting | Asking | 睁大 + 震惊动画 |
| success（未读） | Happy | 弯眼笑 |
| 刚完成 | Delighted | 大笑 + 抖动 |
| error | Sad | 皱眉下垂 |
| speaking | Listening | 睁眼 + 眨眼型，呼吸 |

### working 的「动笔」动画

`working` 状态时右下角有一支铅笔（`drawPen()`）；**`thinking` 不画**（看着怪）：

- 图标是 Lucide 的 `pencil`，离线栅格化成点阵、**以笔尖为轴**旋转预渲染 9 帧
  （`firmware/src/pen_frames.h`，生成脚本 `tools/pen-frames.py`）——固件只做选帧 + blit，
  不需要 SVG 解析，也没有逐帧浮点旋转的开销。
- **抗锯齿**：帧是 **2 位/像素（4 档灰）**，固件用 `blitMaskN()` 把它映射到 `kPenGrayLut`（固定 16 档灰表）。
  纯 1 位阈值化在斜线上是一格一格的硬台阶；灰阶过渡把最扎眼的台阶磨掉，又不会像 16 档那样发糊。
  生成器里改 `BITS` 就能调（1 位最硬、2 位是当前值、4/8 位更柔但更占 Flash），固件不用动。
- **笔尖钉在屏幕坐标上**（`kPenTipScreenX/Y`，默认 `(253, 187)`），笔身绕它来回摆。
  调位置是调这个笔尖坐标，不是调整帧。
- **节奏**：摆 `kPenSwingsPerRound`（3）下，每下 `kPenSwingPeriodMs`（1400ms），
  然后停 `kPenRestMs`（3000ms）再继续；停顿期间停在正中那帧（= 初始化位置）。
- 摆幅用 `kPenSwingFrames` 缩放：取中心附近几帧来用，**9 = 满摆（预渲染的 ±6°）**、
  5 ≈ ±2.5°、3 ≈ ±1.4°、1 = 完全静止。想微调摆角就改这一个数，不用重新生成帧表。
- 颜色 `kPenColor`（默认白色，和眼睛一致）；有等待卡片时不画（让位给卡片）。
- 帧是 56×56 的方框，旋转余量留够，所以**任何角度下笔尾都不会被裁到**。

> 为什么不是 ±1°：这支笔 38px 长，±1° 时笔端只移动 0.66px，是亚像素级——
> 9 帧里有 4 帧和原位逐像素完全相同，肉眼看不见。±6° 时笔端约 4px，才有"在动"的感觉。

## 等待卡片与代答

### 表情的垂直位置

眼睛中心 = `kEyeY`(98) + 气泡下推（`inset/2`）+ `kBubbleOnlyDrop`(只有气泡时 +10) − 卡片抬升（`kPromptEyeLift` 26）− 未读抬升（`kUnreadEyeRaise` 16）。

| 状态 | 眼睛中心 | 说明 |
|---|---|---|
| idle（无气泡） | 98 | 基线 |
| thinking / working（1 行气泡） | 134 | 气泡推下来 + 补偿 10 |
| **未读**（气泡 + 「查看」按钮） | **118** | 在 134 的基础上净抬 16px（`kUnreadEyeRaise`） |
| 等待卡片（1 行标题） | 98 | 抬 26 抵消气泡的下推，和基线齐平 |

> 未读那次抬升是**净抬**：它不进 `bubbleDrop` 的淡出公式，所以「抬高 16px」就是肉眼看到的 16px；
> 卡片那次则是"抵消气泡下推"，让表情回到基线。两者目的不同，所以是两套独立的量。

小程序订阅 Finch 的全局等待（`ctx.events.onInteractionWait`），把卡片投影成一小段可显示内容下发：

```json
{"type":"command","id":"<requestId>","action":"prompt","kind":"permission",
 "title":"Bash","options":[{"id":"allow","label":"允许"},{"id":"deny","label":"拒绝","destructive":true},{"id":"open","label":"在 Finch 处理"}]}
```

设备端作答回传：

```json
{"type":"answer","id":"<requestId>","optionId":"allow"}
```

规则：

- 权限卡：允许 / 拒绝 / 在 Finch 处理。**destructive 卡不提供"允许"**——程序只能拒绝，批准必须由真人完成。
- 提问卡：选项不超过 3 个且为单选时，直接在设备上作答；选项过多或多选则退化为"在 Finch 处理"。
- 表单卡：需要输入文本，设备上只提示去桌面端处理。
- 卡片被别处（真人、超时）结算时，小程序会下发 `prompt_clear`，设备立即撤下卡片。
- **点了「去回复」不代表已作答**：卡片会留在屏幕上，直到真的结算（设备上选了 / 在 Finch 里作答了 / 取消 / 超时）。
  否则用户只是去桌面端看一眼就回不来了。小程序每 8 秒还会拿 `listWaits()` 对一次账，
  已经结算的卡片一定会被收走，漏事件也不会留下“幽灵卡片”。

隐私边界：下发的只有标题与选项文本。`toolInput`、工具输出、对话正文、本地路径、密钥一律不上设备，也不落盘。
设备回传的只有 `requestId` 与用户选中的 `optionId`。

## LED 灯环

| 状态 | 灯效 |
|---|---|
| idle / sleeping | 熄灭 |
| thinking | 蓝色慢呼吸（2.6 秒） |
| working | 蓝色快呼吸（1.5 秒） |
| waiting | 红色呼吸 |
| success（未读） | 绿色呼吸 |
| error | 红色双闪 |
| speaking | 琥珀常亮 |

`config.h` 里 `FINCHCHAN_LED_EFFECTS 0` 可整体关闭，`FINCHCHAN_LED_BRIGHTNESS`（默认 90）调峰值亮度。

## 气泡文案

`thinking` / `working` / `waiting` / 未读 四种状态会在眼睛上方显示气泡，文案来自小程序的
`i18n/*.json`（`bubble.*`），改词不需要重烧固件。设备端用 M5GFX 的 `efontCN_16` 渲染，最多两行自动折行。

`thinking` / `working` 各有 **5 句**（`bubble.thinking1..5` / `bubble.working1..5`），
**同一状态停留超过 5 秒（`BUBBLE_ROTATE_MS`）就换下一句**：小程序重发一次同状态命令，
只换气泡文本——设备端 `setState()` 即使状态没变也会更新气泡，而提示音按「状态是否变化」抑制，
所以换文案不会重复响。相邻两次不会挑到同一句（`nextBubbleIndex()`）。
轮换由一条独立的 1 秒定时器驱动（`bridge.rotateBubble()`），间隔就是 `BUBBLE_ROTATE_MS`。

## 配网（新用户从这里开始）

WiFi 凭证不再写死在固件里，设备把它存在 NVS，所以新用户烧完就能自己配网，不用改代码重编。

1. 烧完固件（或换过网络、按 `wifi-reset` 清过凭证）后，设备进入配网模式；
   屏幕上显示热点名，形如 `FinchChan-A3F1`。
2. 手机连上这个热点（默认开放，可用 `FINCHCHAN_AP_PASSWORD` 加密）。
   系统一般会自动弹出配网页；没弹就浏览器打开 `192.168.4.1`。
3. 选家里的 WiFi、输密码，点「保存并连接」。设备把凭证存进 NVS 并重启入网，屏幕回到眼睛表情。

密码写错也不会卡死：从没连上过时，试几次就会自己回到配网模式让你重填。

### 桥接主机不用填 IP

设备是 WS 客户端，本来必须知道「桥接在哪台电脑上」，但每个人的局域网 IP 都不一样。
现在设备开机后广播一句 `FINCHCHAN?`（UDP 8266），小程序收到就回 `FINCHCHAN! <端口>`，
设备用回包的来源 IP 作为连接目标——换网络、换电脑都不用重新配。
`config.h` 里的 `FINCHCHAN_WS_HOST` 只在发现不到桥接时作为兜底。

### 串口命令

```
status           # 打印 wifi 阶段、IP、桥接地址、relay 与配对状态
pair C039CD      # 把 Finch 生成的配对码交给设备
wifi-reset       # 清掉 NVS 里的凭证并重启进配网模式
```

## 设备身份（id / 热点名）

设备 id 与配网热点名都从芯片 MAC 低 16 位派生，不用手工维护：

| 用途 | 形式 | 例子 |
|---|---|---|
| 设备 id | `finchchan-XXXX` | `finchchan-A3F1` |
| 配网热点 | `FinchChan-XXXX` | `FinchChan-A3F1` |

`config.h` 里的 `FINCHCHAN_DEVICE_ID` 留空即自动生成（推荐）；只在需要固定 id 的调试场景才填。
**注意**：id 一变，桥接就把它当新设备，需要重新配对一次；设置菜单里旧的设备行可以点「取消配对」清掉。

## 编译期配置（可选）

```sh
cd finch-chan/firmware
cp config.h.example config.h
```

`FINCHCHAN_WIFI_SSID` / `FINCHCHAN_WIFI_PASSWORD` 只当「出厂种子」，而且**只在这台设备从没配过网时用一次**
（NVS 里会记一个 `configured` 标记）：否则点了「重新配网」→ 清掉 NVS → 下次开机又用旧 SSID 连回去，
配网流程就形同虚设。想给最终用户发布，把这两项留空即可，设备开箱就是配网热点。
`FINCHCHAN_WS_HOST` 同理，留空表示「一直广播找桥接」。`config.h` 已被 Git 忽略。

## 配对（Finch 先发起，设备上按「确认」）

设备没有键盘，所以配对不再靠输入配对码，而是**复用等待卡片的 UI**。
关键是：**卡片不是一直挂着的**，它是 Finch 侧发起配对后设备才弹的：

1. Finch 里点设置菜单的「配对」（或调 `finchchan_control({ action: "pair", device_id: "finchchan-A3F1" })`）；
2. 桥接向该设备的连接发一个 `pair_offer`（若设备当时不在线，下次 `hello` 回复里的 `pairing: true` 补上）；
3. 设备屏幕上弹出「要连上 Finch 吗？ / 确认 / 取消」；
4. 按 **Front 区**（左边那个）= 确认，设备把请求发给桥接、拿到 token 存进 NVS，卡片收起、回到眼睛表情；
   按 Middle / Back = 取消，卡片收起，重新在 Finch 里点配对会再弹。

没在 Finch 侧发起配对时，设备什么都不显示——不会出现“卡片一直在、按确认又没用”的情况。

配对成功后设备只用 token 重连，不再需要任何码。串口仍保留一条兜底路径（无屏设备/调试用），
配对码本身**不在界面上外显**：

```
pair C039CD      # 把 Finch 生成的配对码交给设备（大小写都行）
```

在 Finch 里点「取消配对」时，设备会收到 `unauthorized` 并清掉本地 token，回到未配对状态，
下次点配对重新走一遍即可。

## 重新配网

三种方式，任选：

1. **Finch 设置菜单**：「重新配网」→ 设备清掉 NVS 凭证并重启进配网模式（需要设备已配对在线）；
2. **串口**：`wifi-reset`；
3. **手机配网页面**：不需要，重配时会自动开热点。

重配的串口日志长这样（注意不会再用旧 SSID 连回去）：

```
[finchchan] wifi-reset requested from Finch: clearing credentials and restarting
[wifi] stored ssid=(none) configured=1
[wifi] already configured once, skipping build-config seed
[wifi] portal "FinchChan-A3F1" at 192.168.4.1 (up, open)
```

配网/配对都完成后，串口 `status` 应该看到 `wifi=connected ... relay=connected paired=yes`。

## 输入：两套触摸 + 拍头

StackChan 上有三个独立输入源，固件分开处理：

| 输入源 | API | 用途 |
|---|---|---|
| **屏幕触控面板** | `M5.Touch.getDetail()`（M5Unified，CoreS3 显示触摸） | 卡片按钮按**坐标**命中；点表情/空白处 = 跳去对应会话 |
| **顶部电容区** | `M5StackChan.TouchSensor`（Si12T，三个区 + 前后滑动） | 没屏幕时也能作答：Front = 选项一，Back = 选项二，Middle = 去 Finch |
| **拍头** | IMU 加速度尖峰 | 任意时候 = 亲密反应（睡着也会醒） |

卡片按钮的命中完全走屏幕坐标（`hitTestPrompt`）；顶部三个区只是把区位翻译成同一个选项 id，
两者走同一套分发逻辑，行为一致。

**点表情/空白处**（有卡片但没点中按钮）走 `openPromptSession()`：等价于卡片上的「去回复」，
`relay.notifyTap(promptId)` → 小程序打开这张卡片所属的会话。卡片**故意留着**（用户可能只是去看一眼，
不一定作答），只有真的结算了才收起。设备本地的配对确认卡没有对应会话，点表情不做事。

### 诊断日志

开机时会先报两个触摸硬件的状态（按钮点不动时先看这两行）：

```
[input] screen touch panel: enabled
[input] top touch zones: Si12T Front/Middle/Back via StackChan-BSP
```

之后每次点击都会带上“屏幕当时是什么状态”与“最终选中了什么”：

```
screen touch x=160 y=196 card=pair unread=0      # 屏幕点击（坐标）
screen touch -> confirm                          # 命中哪个按钮
screen touch -> not on a button                  # 点在卡片外
top touch zone 0 (i=1,2,0) card=<id> options=2   # 顶部电容区
 top touch zone 0 -> allow
screen touch while sleeping -> wake (friendly)   # 睡着时点一下只是唤醒
```

区位的语义（按外壳顺序）：`0=Front`，`1=Middle`，`2=Back`；滑动向前 = Front，向后 = Back。

## 音频动效（收听模式）

复刻 muspi 的 `screen/plugins/spectrum`：**真·FFT 频谱**，不是音量表。

| 环节 | muspi | 固件里 |
|---|---|---|
| 采样 | ALSA 44.1kHz | M5.Mic 16kHz（板载麦克风默认） |
| FFT | 2048 点 + Hann 窗 | 512 点 + Hann 窗（同样的幅度谱） |
| 分频 | 40Hz→Nyquist 等比 32 段，段内取最大 | **完全相同** |
| 归一化 | dB 窗口 -70 ~ -15，夹在 0..1 | **完全相同** |
| 条高 | `value^0.5` | **完全相同** |
| 平滑 | 上升 0.35 / 回落 0.65 / 峰值 0.02 | **完全相同** |
| 静音 | 峰值阈 + 特多久之后归零 | 同思路（0.01 / 400ms） |
| 画法 | 条 + 峰值线 + 底部平均电平条 | **相同**，但只占底部一行 |
| 位置 | 覆盖整屏（128px 小屏） | 底部一行，高度/边距与按钮行一致 |

每根条对应自己的频段，所以是跟着声音“长”出来的波形，而不是整体伸缩。

行为：

- **PWR 短按**切换（`M5.BtnPWR.wasClicked()`）；小程序设置菜单里的「律动模式」是**同一个开关**
  （`PetRenderer::setMusicMode()`），切完立刻 `relay.reportSettings()` 上报，所以两边状态永远一致。
- 小程序下发的功能设置走同一个命令通道：`{"type":"command","action":"settings","music":?,"gain":?,"beat":?}`
  —— 三个字段都可选，只改传了的；设备应用后回一份 `{"type":"settings",…}` 完整状态
  （连接建立时也会主动上报一次，设置菜单一打开就是当前值）。
  - **收音灵敏度**：`gain` 0/1/2 → 麦克风线性增益 1.8 / 2.4 / 3.0（`kGainLevelGains`，原先是编译期常量）。
  - **随节奏舞动**：`beat` 关掉后频谱照旧，只是不再跟拍点头（`beatDance_`）。
- 右上角常驻一条状态信息 **`♪ 🌕`**（`drawStatusBadge()`）：
  - **电量用一个字形表示，不显示数字**：用 QuinqueFive 的月相字符，填充量随电量递减
    （实测填充像素 189/162/135/108）：`74~100%` 实心（U+1F311）、`47~73%` 细缝（U+1F313）、
    `21~46%` 宽缝（U+1F314）、`<=20%` 空心（U+1F315）。
    判定写成 `(level - 20) * 3` 与 80 / 160 比较，即把 20~100 这 80 个点三等分（各约 26.7），
    不用浮点也不会在边界差一；想改最低档阈值就改 `kBadgeRedPercent`。
  - **颜色按红绿灯走**：音符与实心/细缝是薄荷绿（`kBadgeGreenColor`，和频谱条同色）、
    宽缝转黄（`kBadgeWarnColor`）、空心转红（`kBadgeLowColor`）。
  - 电量 10 秒轮询一次（`M5.Power.getBatteryLevel()`，I2C 读 AXP2101，别每帧读），
    读数变化时串口打 `[power] battery=NN%`；读不到（-1）就不显示电量。
  - **`♪` 只在音乐模式开着时出现，放在月相左边**，表示“现在是收听状态”。
  - **固定在右上角，气泡出现也不动**：状态栏在最后绘制（画在气泡/频谱/按钮之上）；
    气泡顶边也整体下移到 `kBubbleTopY`（= 状态栏高度 + 1，默认 14），
    所以哪怕气泡拉得很宽也不会和状态栏叠在一起。
  - 打瞌睡/惊醒动画期间不画。
  - 字形来自 muspi 的状态字体 `assets/fonts/QuinqueFive.ttf`，直接用它的**原生 5px**
    点阵（muspi 自己的状态栏就是这个字号，`screen/base.py` 里 `font_status = FONTS.size_5`），
    离线导出后内嵌成 `kMusicNote[]` / `kMoon*[]`：每行 1 字节、MSB 在左。
    和表情一样不需要运行时字体文件。想换尺寸就按整数倍重新导出点阵
    （`kBadgeGlyph` / `kBadgeRows` / `kBadgeStride` 跟着改）。
- 显示时**不上移表情**：频谱只占底部一行，不挡脸；只有等待卡片出现时才把表情顶上去（同一个 26px）。
- 频谱里没有多余的横向元素：既没有 muspi 那条底线，也没有底部按增益伸缩的电平长条，就一条条跳动的竖条。
- **笑脸只在 idle，而且是“听够了才笑”**（`idle` 的两个子状态）：
  - 安静 → 退回 idle 的普通表情，**音乐模式不变**（频谱照旧在下面跟）；
  - 连续收音达 5 秒（`kMusicSmileDelayMs`）→ 笑脸 😄，并开始随音乐轻微浮动；
  - 一旦安静下来立即退回普通表情，计时也清零；
  - `running` / `waiting` 等状态不受影响，始终保持它们自己的表情。
- **跟着鼓点点头**（只在音乐模式的 idle）：低频段的**谱通量**（相邻两帧的正向增量）起过近期平均就是“一拍”。
  参与检测的是前 12 段（对数分频下约为 40~370Hz）——不要只看最低几段，手机/电脑小喇叭 100Hz 以下几乎没能量。

  节奏感做了五件事：

  1. **跟住节拍周期**：用最近 5 次拍间隔的**中位数**估 BPM，并且只接受落在当前估计
     ±25%~+33% 带内的间隔——否则会被“抖拍”带着一路漂（估计周期变小 → 门变松 →
     更容易捕到更快间隔，是个正反馈）。

     **倍频错误单独处理**：间隔接近当前周期的 1/2 或 2 倍时（典型漏拍/多拍），
     只用来点头，**绝不拿来改周期估计**，也不算进重同步计数——否则 BPM 会在
     84↔267 之间来回跳。只有连着 3 次落在带外、又不是倍频关系的间隔才算真的变速：

     ```
     [beat] tempo resync -> 150 bpm    # 只在真的换节奏时出现
     ```

     最小间隔也跟着周期走（半个周期内不再算一拍）；
  2. **一次触发只播一个完整点头**：`下去 → 回中` 一气做完；动作没结束（`motion_.busy()`）
     或伺服还没回稳（帧表 + 50ms）之前，来的鼓点**排队跳过**；
  3. **点头时长按周期自适应**，保证每个拍子都能点满一次（以前隔一个点一次，节奏感只有一半）：

     | 估算周期 | 选用的动作 |
     |---|---|
     | ≤400ms（≥150BPM） | `beatNodFast`（短促），强拍用 `beatNod` |
     | 400–620ms | `beatNod`，强拍用 `beatNodStrong` |
     | ≥620ms（≤100BPM） | `beatNodStrong`（约 9°，点得深） |

  4. **表情同步小顿落**：拍点上表情在 150ms 内下顿 3.5px，和头部动作对齐；
  5. **跟拍期间头部保持稳**：关掉空闲的视线跟随与随机小动作（`setBeatMode`），免得抢拍。

  日志只留鼓点（逐帧舵机日志已由 `FINCHCHAN_MOTION_TRACE` 关掉，需要时改成 1 重开）：

  ```
  [beat] #49 x1.4 bpm=132 -> nod                        # 真播了一次踀头
  [beat] #50 x2.3 bpm=132 -> nodStrong                   # 强拍：幅度更大
  [beat] probe flux=0.62 thr=1.29 level=0.32 bpm=132 beats=53   # 每 2 秒现状；beats 含被跳过的
  ```

  调参：`kFluxTriggerFactor`（1.6，调小更敏感）、`kFluxMin`（0.06 绝对下限）、`kBeatBands`（12）、
  `kBeatMinGapMs`（240）；点头幅度在 `MotionDirector.cpp` 的 `beatNod` / `beatNodStrong` 帧表里。
- 左右两侧飘 ♪（向量绘制，不依赖字体）：**只在“正在收音”时才冒**，一安静就停并把在飞的收掉。
  位置与高度都随机：水平只落在两侧空带（`x ≤ 58` / `x ≥ 262`），而眼睛水平占据 82~238，
  所以永远不会遮住眼睛；起始高度在下半部 116~168 随机，速度、摆动、寿命也各带一点随机量。
- **卡片优先**：等待卡片出现时，按钮直接盖住频谱，音符也停画。
- **音乐模式下不会被音乐“叫醒式睡过去”**：有声音就一直重置空闲计时（不会睡）；
  只有特别安静（平均条高低于 0.05 且静音超过 400ms）才按普通 5/10 分钟计时睡。
  睡着时听到声音会**友好叫醒**（不演“惊醒”）。
- 省电：**只有显示时才 `M5.Mic.begin()`**，关掉立即 `end()`。

### 提示音与麦克风的冲突（已处理）

StackChan 上**麦克风与扬声器共用 `I2S_NUM_1`**（M5Unified 的 `board_M5StackChan` 两边都填了同一个
`i2s_port`，只是数据引脚不同），而且麦克风 16kHz、扬声器 48kHz。这带来几个坑：

| 现象 | 原因 | 处理 |
|---|---|---|
| 提示音“啪”一声（爆音） | `Speaker.tone()` 波形头尾突变 | 自绘正弦 + 10ms 淡入 / 30ms 淡出，走 `Speaker.playRaw` |
| **开过音乐模式后提示音变成爆音** | 麦克风正占着共用端口（16kHz 输入），扬声器往里写只能出噪声 | 播放前 `AudioVisualizer::beginPlayback()`：先 `Mic.end()` 让出端口，再把扬声器 `end()+begin()` 装回自己的配置 |
| **关掉音乐模式后提示音再也不出声** | `Mic.end()` 会把整个 I2S 驱动卸掉，而扬声器 `_begun` 仍是 true、不会重新初始化，于是永远是哑的 | 同上：只要麦克风动过端口（`speakerDirty_`），每次播放前都把扬声器重装一次 |
| 提示音后频谱“突然全满” | ① 提示音被自己的麦克风收进去；② 播放把 I2S 采样率改掉，麦风数据被按错误速率解释 | 播放期间门控麦克风（读掉丢弃）；播完自动 `Mic.end()+begin()` 重开一次，并再丢两帧残留 |

原则：**麦克风与扬声器谁都不长期占有端口**——麦克风只在音乐模式显示期间开着，
扬声器只在真的要出声前重装一次；两条播放路径（小程序推送的提示音、内置合成音）
都走同一个 `beginPlayback()`，不会再出现某一侧被另一侧搞哑的情况。

日志里能看到端口交接与麦克风自恢复：

```
[audio] speaker re-init (I2S shared with mic)   # 播放前把扬声器装回去
[audio] mic restarted after cue tone            # 提示音之后自恢复麦克风
```

串口日志：

```
[audio] spectrum ready: 32 bars, 512-pt FFT @ 16000Hz
[input] PWR clicked -> toggle audio visualizer
[audio] visualizer ON (PWR to toggle)
[audio] music mode: listening...                # 开始连续收音计时
[audio] music mode: quiet, back to idle face    # 安静了，退回 idle 表情
[audio] mic restarted after cue tone            # 提示音之后自恢复麦克风
[audio] visualizer OFF
```

> 麦克风不可用时（`[audio] mic NOT available`），动效仍然是开的，只是频谱一直是平的。

### 灵敏度调参（觉得太灵/太迟钝都改这里）

全在 `AudioVisualizer.cpp` 顶部：

| 常量 | 当前值 | 作用 |
|---|---|---|
| `kMicGain` | 2.2 | 进 FFT 前的线性增益；**调小 → 小声不显示** |
| `kDbFloor` | -60 | 显示下限（muspi 原值 -70）；**抬高 → 安静内容扁下去** |
| `kDbCeiling` | -15 | 显示上限 |
| `kSignalThreshold` | 0.025 | 峰值振幅低于它 = 静音，条直接归零（原 0.01 太敏感） |
| `kFluxMin` | 0.08 | 鼓点谱通量的绝对下限 |
| `kBeatMinLevel` | 0.06 | 鼓点要求的整体音量 |
| `kBeatMinLow` | 0.24 | 鼓点要求的低频段强度（拦安静时的碎噪声） |
| `kFluxTriggerFactor` | 1.6 | 相对阈值；调大更挑（更少假拍） |

> 灵敏度改完之后，`[beat] probe` 里的 `low=` / `level=` 数值也会跟着变小，
> 调门槛时对照看就知道当前一句音乐大概落在什么区间。

### 提示音：由小程序推送（不内置到固件）

小程序在 TS 里合成 PCM（`src/audio.ts`），设备认证后推三段二进制帧过来，
固件存 PSRAM 并在状态变化时播放：

| slot | 用途 | 触发时机 |
|---|---|---|
| 0 | 未读 / 有结果 | `success` |
| 1 | 需要你处理 | `waiting` |
| 2 | 出错 | `error` |

二进制帧格式（不走 JSON，省 base64 与解析开销）：

```
byte 0    'A' 魔数
byte 1    版本 = 1
byte 2    slot
byte 3    格式 = 1（PCM16 单声道）
byte 4-7  采样率 uint32 LE（16kHz）
byte 8-11 采样点数 uint32 LE
byte 12-15 保留
之后      PCM16 数据
```

要点：

- 每段容量 1.2 秒（16kHz 单声道 16bit ≈ 38KB），存在 PSRAM，内部 RAM 不受影。
- **改音色只改 `src/audio.ts` 的音符表**，重载小程序即可，不用重烧固件。
- 没推过（首次连接前、推送失败）时自动**回退到内置合成音**（含 `waiting`，之前它是没声的）。
- 播放时会自动门控麦克风 + 播完重开（两者共用 I2S，与 `cue()` 同一条路径）。

日志：

```
[sound] slot 0 <- 8960 samples @ 16000Hz (560ms)
```

## 功耗与休眠

待机分两层，都**保持联网**（否则 Finch 侧有任务就唤不醒它）：

| 状态 | 进入条件 | 做的事 |
|---|---|---|
| 打瞹睡 Dozing | 空闲 5 分钟 | 睡眼 + 舵机停在 0°附近微起伏；WiFi 开 **modem sleep**、熄电源 LED |
| 熄屏 DeepSleep | 空闲 10 分钟 | 背光 0 + 上面那些，再把 **CPU 降到 80MHz** |
| 唤醒 | 拍头 / 触摸 / 有任务 | 一帧内恢复 240MHz + 关 modem sleep + 亮回 LED |

切换时串口会打一行：`[power] save=1 deep=1 cpu=80MHz`。

**为什么不用 `M5.Power.deepSleep()`**：那是芯片断电重启，WiFi 断、WS 掉、RAM 全丢，
Finch 有任务时根本叫不醒它，醒来还要重连几秒。`powerOff()` 只适合做关机键。

## 舵机诊断

移动日志默认开着（只在位移超过阈值时打一行，不会刷屏）：

```
[motion] yaw=0.00 pitch=100 speed=420 home                  # 回中
[motion] auto torque release disabled, torque held           # 开机时关掉 BSP 的自动松力
[motion] dozing on (from yaw=-0.12 pitch=96)                 # 进入打瞌睡，从当前姿态 2.5 秒渐变
[motion] yaw=-0.12 pitch=90 speed=190 doze (dozing)          # 渐变中的每一帧
[motion] yaw=0.00 pitch=3 speed=220 doze (dozing)            # 睡姿 + 0~1° 慢起伏
[motion] motion=patShake                                     # 动作开始时的名字
```

睡着后如果看到 `[motion]` 日志，说明是我们下发的；如果头动了却没有日志，
那就是 BSP/舵机侧的事，可以在日志里对照 `sleep=` / `face=` 那几行定位。

> **已知雷区**：BSP 默认 `_auto_torque_release_enabled = true`（`servo.h`），静止 200ms 就松扭矩，
> 头会在重力下自己掉下去——表现为“睡着后突然位移”。固件已在开机时 `setAutoTorqueReleaseEnabled(false)`
> 并保持 `setTorqueEnabled(true)`。

## 构建与烧写

草图文件名必须与目录同名（`firmware.ino`）。把设备切到下载模式（按住 RST → 插 USB → 松开）后：

```sh
bash tools/flash-all.sh /dev/cu.usbmodem13201
```

等价的手工命令：

```sh
"/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli" \
  compile --fqbn m5stack:esp32:m5stack_cores3 -u -p /dev/cu.usbmodem13201 firmware
```

实测占用：Flash 1,992,615 字节（63%）、RAM 57,216 字节（17%）。
依赖库：`M5Unified 0.2.20`、`M5StackChan 1.0.1`、`ArduinoWebsockets 0.5.4`、`ArduinoJson 7.4.3`。
配网用的 `WebServer` / `DNSServer` 来自 ESP32 核心，无需额外依赖。
`M5Unified 0.2.21+` 改变了 IO 扩展接口，与当前 StackChan-BSP 不兼容。

## 目录

- `src/EmotionFace.*` — muspi 移植的表情系统（矢量，无资源文件）
- `src/LedRing.*` — 状态到灯效的映射表与动效
- `src/PetRenderer.*` — 气泡、等待卡片、触摸命中测试、离屏画布
- `src/pen_frames.h` — working 状态「动笔」动画的预渲染帧（由 `tools/pen-frames.py` 生成）
- `src/Log.h` — 串口日志分档（`FINCHCHAN_LOG_LEVEL`）+ 串口阻塞保护
- `src/WifiProvisioning.*` — NVS 凭证 + 首次开机热点配网页（captive portal）
- `src/HostDiscovery.*` — UDP 广播找桥接主机，免填 IP
- `src/WebSocketRelay.*` — 协议、NVS token、重连与应答回传
- `src/CommandQueue.*` — 定长回调→主循环队列
- `src/StackChanRuntime.*` — StackChan-BSP 生命周期桥
- `config.h.example` — 本地配置模板

## 已知限制

- 仅支持局域网 `ws://`，未做 TLS 证书配置。
- 运动只交给 StackChan-BSP 的 `begin/update`，网络消息不会驱动舵机。
- 多选提问卡与表单卡需要到桌面端完成。
- 单色 OLED 的像素风格字体未移植，屏幕上使用 M5GFX 自带字体。
