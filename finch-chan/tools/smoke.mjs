import assert from 'node:assert/strict';
import { PET_STATES, parseClientMessage, sanitizeText } from '../dist/index.js';

// Public helpers make protocol compatibility testable without starting Finch.
assert.deepEqual(PET_STATES, ['idle', 'thinking', 'working', 'waiting', 'happy', 'error']);
assert.deepEqual(parseClientMessage({ type: 'hello', protocol: 1, deviceId: 'm5-a' }), { type: 'hello', protocol: 1, deviceId: 'm5-a' });
assert.deepEqual(parseClientMessage({ type: 'ack', state: 'happy' }), { type: 'ack', state: 'happy' });
assert.equal(parseClientMessage({ type: 'command', shell: 'rm -rf /' }), undefined);
assert.equal(parseClientMessage({ type: 'ack', state: 'unbounded' }), undefined);
assert.equal(sanitizeText(`  Ready${String.fromCharCode(10)}${String.fromCharCode(0)}now  `), 'Ready now');
assert.equal(sanitizeText('x'.repeat(121)).length, 120);
console.log('smoke: bundled protocol helpers passed');
