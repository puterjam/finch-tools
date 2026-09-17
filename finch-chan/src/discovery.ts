import * as dgram from 'node:dgram';

/** UDP 端口：设备广播探测用的，与固件 FINCHCHAN_DISCOVERY_PORT 保持一致。 */
export const DISCOVERY_PORT = 8266;

const PROBE = 'FINCHCHAN?';
const REPLY_PREFIX = 'FINCHCHAN!';

export interface DiscoveryHandle {
  port: number;
  close(): void;
}

/**
 * 让设备自己找到这台电脑。
 *
 * 设备是 WS 客户端，必须知道桥接在哪台机器上；而每个人的电脑局域网 IP 都不一样，
 * 写死在固件里一换网络就废。所以：设备开机向 255.255.255.255:8266 广播
 * `FINCHCHAN?`，我们收到就回 `FINCHCHAN! <wsPort>`，设备以回包的来源 IP
 * 作为连接目标。用户全程不用知道 IP。
 */
export function startDiscovery(options: { wsPort: number; log: (message: string) => void }): DiscoveryHandle {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const answered = new Set<string>();
  let closed = false;

  socket.on('message', (message, remote) => {
    if (message.toString('utf8').trim() !== PROBE) return;
    const reply = Buffer.from(`${REPLY_PREFIX} ${options.wsPort}`, 'utf8');
    socket.send(reply, remote.port, remote.address, (error) => {
      if (error || closed) return;
      // 同一个地址只在第一次回包时记一行日志，免得设备定时广播把日志刷满。
      const key = `${remote.address}:${remote.port}`;
      if (answered.has(key)) return;
      answered.add(key);
      options.log(`[finch-chan] answered device probe from ${key}`);
    });
  });

  socket.on('error', (error) => {
    // 端口占用之类不该拖垮桥接：WS 服务照常工作，只是设备得走兜底地址。
    if (!closed) options.log(`[finch-chan] discovery socket error: ${error.message}`);
  });

  socket.on('listening', () => options.log(`[finch-chan] discovery listening on udp/${DISCOVERY_PORT}`));
  socket.bind(DISCOVERY_PORT);

  return {
    port: DISCOVERY_PORT,
    close: () => {
      closed = true;
      try {
        socket.close();
      } catch {
        // 已经关掉了，忽略。
      }
    },
  };
}
