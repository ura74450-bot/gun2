const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const WebSocket = require('ws');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}
function waitFor(socket, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeListener('message', onMessage); reject(new Error('WebSocket state timeout')); }, timeout);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer); socket.removeListener('message', onMessage); resolve(message);
    }
    socket.on('message', onMessage);
  });
}

test('health endpoint and two-player co-op room start', async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 3000);
    child.stdout.on('data', (chunk) => { if (chunk.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    child.on('error', reject);
  });
  const health = await getJson(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200); assert.equal(health.body.ok, true); assert.equal(health.body.service, 'gunshade-coop');
  const first = new WebSocket(`ws://127.0.0.1:${port}/ws`); const second = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => { first.close(); second.close(); });
  const firstStarted = waitFor(first, (m) => m.type === 'snapshot' && m.phase === 'playing' && m.players[0].connected && m.players[1].connected);
  const secondStarted = waitFor(second, (m) => m.type === 'snapshot' && m.phase === 'playing' && m.players[0].connected && m.players[1].connected);
  await Promise.all([
    new Promise((resolve, reject) => { first.once('open', resolve); first.once('error', reject); }),
    new Promise((resolve, reject) => { second.once('open', resolve); second.once('error', reject); })
  ]);
  const [a, b] = await Promise.all([firstStarted, secondStarted]);
  assert.deepEqual(new Set([a.mySeat, b.mySeat]), new Set([0, 1]));
  assert.equal(a.players.length, 2); assert.ok(Array.isArray(a.enemies)); assert.ok(a.enemies.length > 0); assert.ok(Array.isArray(a.bloodStains));
  first.send(JSON.stringify({ type: 'input', input: { moveX: 1, moveY: 0, angle: 0, fire: true, interact: false, switchWeapon: false } }));
  const withProjectile = await waitFor(first, (m) => m.type === 'snapshot' && m.bullets.length > 0);
  assert.equal(withProjectile.bullets[0].owner, a.mySeat);
});
