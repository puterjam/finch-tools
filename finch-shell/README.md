# Finch Shell

Open a real interactive terminal inside Finch. It starts in the current workspace and supports full-screen terminal programs, colors, keyboard input, and resize events.

## Usage

Open **Shell** from Finch's Panel launcher, or ask Finch to open a terminal. Every open creates an independent Panel tab and shell process. Use **Restart** to replace the current shell process and the clear button to clear the visible terminal buffer.

Select text with the mouse, then copy with `Ctrl+Shift+C` and paste with `Ctrl+Shift+V` (`Cmd+C` and `Cmd+V` on macOS). Plain `Ctrl+C` still sends an interrupt to the running program, as in any terminal.

Hold `Ctrl` (`Cmd` on macOS) to turn URLs in the output into underlined links, and click one to open it in Finch's browser panel. Without the modifier held, the text behaves like ordinary output, so selecting and copying is unaffected.

When Finch opens a terminal for you, it can also type a command at the prompt. The command is left there unexecuted so you can read and edit it before pressing Enter; Finch only runs it immediately when you ask it to.

## Platform support

The package includes native runtimes for macOS (Apple Silicon and Intel), Windows (x64 and ARM64), and Linux (x64, ARM64, ARM, and ia32). Linux variants for both glibc and musl are bundled across supported Node/Electron ABIs, so no compiler or first-launch download is needed.

---

# Finch 终端

直接在 Finch 中打开真正的交互式终端。终端默认从当前工作区启动，支持全屏终端程序、彩色输出、键盘输入与窗口尺寸同步。

## 使用方式

从 Finch 的 Panel 启动器打开「终端」，也可以直接让 Finch 打开终端。每次打开都会新建独立的 Panel 标签和 shell 进程。使用「重新启动」替换当前 shell 进程，使用清空按钮清除当前可见缓冲区。

用鼠标选中文本后，可用 `Ctrl+Shift+C` 复制、`Ctrl+Shift+V` 粘贴（macOS 为 `Cmd+C` 与 `Cmd+V`）。单独的 `Ctrl+C` 仍然向正在运行的程序发送中断信号，与常规终端一致。

按住 `Ctrl`（macOS 为 `Cmd`），输出中的网址会变成带下划线的链接，点击即在 Finch 的浏览器面板中打开。不按修饰键时它与普通文本无异，不影响选中和复制。

Finch 为你打开终端时，还可以把一条命令直接敲在提示符上。命令默认不会执行，你可以先看清楚、改一改再回车；只有你明确要求时，Finch 才会直接运行它。

## 平台支持

安装包内置 macOS（Apple Silicon 与 Intel）、Windows（x64 与 ARM64）及 Linux（x64、ARM64、ARM、ia32）的原生运行时。Linux 同时包含 glibc 和 musl 版本以及受支持的 Node/Electron ABI，无需编译器，也不会在首次启动时下载依赖。
