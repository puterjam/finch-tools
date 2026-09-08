# Finch Shell

Open a real interactive terminal inside Finch. It starts in the current workspace and supports full-screen terminal programs, colors, keyboard input, and resize events.

## Usage

Open **Shell** from Finch's Panel launcher, or ask Finch to open a terminal. Every open creates an independent Panel tab and shell process. Use **Restart** to replace the current shell process and the clear button to clear the visible terminal buffer.

## Platform support

The package includes node-pty runtimes for macOS (Apple Silicon and Intel) and Windows (x64 and ARM64). Linux uses the native runtime compiled during `npm install`, so Linux release tarballs must be built on the matching Linux architecture.

---

# Finch 终端

直接在 Finch 中打开真正的交互式终端。终端默认从当前工作区启动，支持全屏终端程序、彩色输出、键盘输入与窗口尺寸同步。

## 使用方式

从 Finch 的 Panel 启动器打开「终端」，也可以直接让 Finch 打开终端。每次打开都会新建独立的 Panel 标签和 shell 进程。使用「重新启动」替换当前 shell 进程，使用清空按钮清除当前可见缓冲区。

## 平台支持

安装包包含 macOS（Apple Silicon 与 Intel）和 Windows（x64 与 ARM64）的 node-pty 运行时。Linux 使用 `npm install` 时本机编译的原生模块，因此 Linux 发布包需要在对应架构的 Linux 环境构建。
