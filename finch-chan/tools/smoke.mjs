import assert from 'node:assert/strict';
import { PET_STATES, parseClientMessage, sanitizeText } from '../dist/index.js';

// Public helpers make protocol compatibility testable without starting Finch.
assert.deepEqual(PET_STATES, ['idle', 'thinking', 'working', 'waiting', 'happy', 'error']);
assert.deepEqual(parseClientMessage({ type: 'hello', protocol: 1, deviceId: 'm5-a' }), { type: 'hello', protocol: 1, deviceId: 'm5-a' });
assert.deepEqual(parseClientMessage({ type: 'ack', state: 'happy' }), { type: 'ack', state: 'happy' });
assert.equal(parseClientMessage({ type: 'command', shell: 'rm -rf /' }), undefined);
assert.equal(parseClientMessage({ type: 'ack', state: 'unbounded' }), undefined);
// 功能设置上报：三个字段都要有，且 gain 必须在 0..2，否则整条丢弃。
assert.deepEqual(parseClientMessage({ type: 'settings', deviceId: 'm5-a', music: true, gain: 2, beat: false }),
  { type: 'settings', deviceId: 'm5-a', music: true, gain: 2, beat: false });
assert.equal(parseClientMessage({ type: 'settings', deviceId: 'm5-a', music: true, gain: 5, beat: false }), undefined);
assert.equal(parseClientMessage({ type: 'settings', deviceId: 'm5-a', music: 'yes', gain: 1, beat: false }), undefined);
// ack 里的设备内部词汇要归一化，不能因此判成 bad_message（存量固件会发 success/sleeping/speaking）。
assert.deepEqual(parseClientMessage({ type: 'ack', id: 'x', state: 'success' }), { type: 'ack', state: 'happy', id: 'x' });
assert.deepEqual(parseClientMessage({ type: 'ack', state: 'speaking' }), { type: 'ack', state: 'working' });
assert.deepEqual(parseClientMessage({ type: 'ack', state: 'sleeping' }), { type: 'ack', state: 'idle' });
assert.deepEqual(parseClientMessage({ type: 'ack', id: 'y' }), { type: 'ack', id: 'y' });
assert.equal(parseClientMessage({ type: 'ack', state: 'nonsense' }), undefined);
assert.equal(sanitizeText(`  Ready${String.fromCharCode(10)}${String.fromCharCode(0)}now  `), 'Ready now');
assert.equal(sanitizeText('x'.repeat(121)).length, 120);
console.log('smoke: bundled protocol helpers passed');
