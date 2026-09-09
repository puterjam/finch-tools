import { pathToFileURL } from 'node:url';
import path from 'node:path';

const extensionRoot = process.argv[2];
if (!extensionRoot) throw new Error('Usage: node scripts/smoke-installed.mjs <installed-extension-root>');

let openPanelListener;
let registeredTool;
let panel;
const output = [];
const messageListeners = [];
const visibilityListeners = [];
const disposeListeners = [];

const disposable = () => ({ dispose() {} });
const ctx = {
  subscriptions: [],
  logger: {
    info() {},
    warn: console.warn,
    error: console.error,
    debug() {},
  },
  icons: {
    register() {
      return disposable();
    },
  },
  ui: {
    onDidOpenPanel(listener) {
      openPanelListener = listener;
      return disposable();
    },
    createPanel(options = {}) {
      panel = {
        id: 'smoke-panel',
        visible: true,
        payload: options.payload,
        view: 'session',
        async reveal() {},
        async postMessage(message) {
          output.push(message);
        },
        onDidReceiveMessage(listener) {
          messageListeners.push(listener);
          return disposable();
        },
        onDidChangeVisibility(listener) {
          visibilityListeners.push(listener);
          return disposable();
        },
        onDidDispose(listener) {
          disposeListeners.push(listener);
          return disposable();
        },
      };
      openPanelListener?.(panel);
      return panel;
    },
  },
  tools: {
    register(tool) {
      registeredTool = tool;
      return disposable();
    },
  },
};

const extension = await import(pathToFileURL(path.join(extensionRoot, 'dist/index.js')).href);
extension.activate(ctx);
if (!registeredTool || registeredTool.name !== 'finch_shell_open') throw new Error('Tool registration failed');
const contextCwd = path.join(process.cwd(), 'finch-shell');
await registeredTool.execute({}, { cwd: contextCwd });
if (!panel || messageListeners.length !== 1) throw new Error('Panel registration failed');
if (panel.payload?.cwd !== contextCwd) throw new Error(`Tool context cwd was not forwarded: ${JSON.stringify(panel.payload)}`);

const send = async (message) => {
  for (const listener of messageListeners) await listener(message);
};
await send({ type: 'panelReady', cwd: contextCwd, cols: 100, rows: 30 });
await new Promise((resolve) => setTimeout(resolve, 250));
await send({ type: 'terminalInput', data: "printf 'PANEL_SMOKE_OK\\n'\nexit\n" });

const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const transcript = output.filter((item) => item.type === 'terminalData').map((item) => item.data).join('');
  if (transcript.includes('PANEL_SMOKE_OK')) {
    for (const listener of disposeListeners) listener();
    extension.deactivate?.();
    console.log('INSTALLED_PANEL_PTY_OK');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
throw new Error(`PTY output was not bridged to the panel: ${JSON.stringify(output)}`);
