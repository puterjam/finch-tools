# Finch Shell

Open a real interactive terminal inside Finch. It starts in the current workspace and supports full-screen terminal programs, colors, keyboard input, and resize events.

## Usage

Open **Shell** from Finch's Panel launcher, or ask Finch to open a terminal. Every open creates an independent Panel tab and shell process. Use **Restart** to replace the current shell process and the clear button to clear the visible terminal buffer.

Select text with the mouse, then copy with `Ctrl+Shift+C` and paste with `Ctrl+Shift+V` (`Cmd+C` and `Cmd+V` on macOS). Plain `Ctrl+C` still sends an interrupt to the running program, as in any terminal.

## Platform support

The package includes native runtimes for macOS (Apple Silicon and Intel), Windows (x64 and ARM64), and Linux (x64, ARM64, ARM, and ia32). Linux variants for both glibc and musl are bundled across supported Node/Electron ABIs, so no compiler or first-launch download is needed.

---

# Finch 终端

直接在 Finch 中打开真正的交互式终端。终端默认从当前工作区启动，支持全屏终端程序、彩色输出、键盘输入与窗口尺寸同步。

## 使用方式

从 Finch 的 Panel 启动器打开「终端」，也可以直接让 Finch 打开终端。每次打开都会新建独立的 Panel 标签和 shell 进程。使用「重新启动」替换当前 shell 进程，使用清空按钮清除当前可见缓冲区。

用鼠标选中文本后，可用 `Ctrl+Shift+C` 复制、`Ctrl+Shift+V` 粘贴（macOS 为 `Cmd+C` 与 `Cmd+V`）。单独的 `Ctrl+C` 仍然向正在运行的程序发送中断信号，与常规终端一致。

## 平台支持

安装包内置 macOS（Apple Silicon 与 Intel）、Windows（x64 与 ARM64）及 Linux（x64、ARM64、ARM、ia32）的原生运行时。Linux 同时包含 glibc 和 musl 版本以及受支持的 Node/Electron ABI，无需编译器，也不会在首次启动时下载依赖。
