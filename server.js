const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const TICK_MS = 50;
const SNAPSHOT_MS = 80;
const CELL_SIZE = 48;
const MAP_GRID = [
  '................................',
  '................................',
  '............#################...',
  '............#################...',
  '............##         ##  ##...',
  '............## E     E ##  ##...',
  '............##         ##  ##...',
  '............##  E      ##  ##...',
  '............##    CCE E## E##...',
  '##############E   CC   ## E##...',
  '###############   #######  ##...',
  '##    ##    ###   #######  ##...',
  '##  A ##    ##         ##  ##...',
  '##        E ##  E      ##  ####.',
  '## S        ##       E ##  ####.',
  '##          ##         ##    ##.',
  '##    ##    ##         ##    ##.',
  '##    ##    ##  E      ##    ##.',
  '########    ##       E ##    ##.',
  '########    ##         ##    ##.',
  '##          ##    E    ## E  ##.',
  '##        E ##         ##    ##.',
  '## E        ##  E    E ##    ##.',
  '##          ##         ##  E ##.',
  '###   ########               ##.',
  '###   ########  E   E        ##.',
  '##                           ##.',
  '##      E         E    ## E ##..',
  '##                     ##    ##.',
  '###############################.',
  '###############################.',
  '................................'
];
const MAP_W = MAP_GRID[0].length * CELL_SIZE;
const MAP_H = MAP_GRID.length * CELL_SIZE;
const walls = [];
for (let row = 0; row < MAP_GRID.length; row += 1) {
  for (let col = 0; col < MAP_GRID[row].length; col += 1) {
    if (MAP_GRID[row][col] === '#') walls.push({ x: col * CELL_SIZE, y: row * CELL_SIZE, w: CELL_SIZE, h: CELL_SIZE });
  }
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    const body = JSON.stringify({ ok: true, service: 'gunshade-coop', phase: game.phase, players: players.filter(Boolean).length });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
    return;
  }
  if (request.method !== 'GET') { response.writeHead(405); response.end('Method Not Allowed'); return; }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { response.writeHead(403); response.end('Forbidden'); return; }
  fs.readFile(filePath, (error, file) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(error.code === 'ENOENT' ? 'Not Found' : 'Server Error'); return; }
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'cache-control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600' });
    response.end(file);
  });
});

const socketServer = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const clients = new Set();
let players = [null, null];
let waitingClient = null;
let game = null;
let snapshotCounter = 0;
let lastSnapshotAt = 0;
let fxEvents = [];

function now() { return Date.now(); }
function center(col, row) { return { x: (col + 0.5) * CELL_SIZE, y: (row + 0.5) * CELL_SIZE }; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function normalize(x, y) { const length = Math.hypot(x, y) || 1; return { x: x / length, y: y / length }; }
function circleHitsRect(x, y, radius, rect) { const closestX = clamp(x, rect.x, rect.x + rect.w); const closestY = clamp(y, rect.y, rect.y + rect.h); return Math.hypot(x - closestX, y - closestY) < radius; }
function blocked(x, y, radius = 14) { return walls.some((wall) => circleHitsRect(x, y, radius, wall)); }
function moveCircle(entity, dx, dy, radius = 14) {
  const nextX = clamp(entity.x + dx, radius, MAP_W - radius);
  if (!blocked(nextX, entity.y, radius)) entity.x = nextX;
  const nextY = clamp(entity.y + dy, radius, MAP_H - radius);
  if (!blocked(entity.x, nextY, radius)) entity.y = nextY;
}
function addFx(type, x, y, extra = {}) { fxEvents.push({ type, x, y, ...extra, id: `${now()}-${Math.random()}` }); }
function makeEnemies() {
  const cells = [[17,5],[21,5],[17,7],[24,8],[14,13],[19,13],[23,14],[17,17],[23,18],[12,21],[20,22],[24,22],[16,25],[20,25],[26,27]];
  return cells.map(([col, row], index) => ({ id: `enemy-${index}`, x: center(col, row).x, y: center(col, row).y, radius: 16, hp: 3, maxHp: 3, speed: 1.15, attackAt: 0, alerted: false, dead: false, hitFlash: 0 }));
}
function makeGame() {
  return {
    phase: 'waiting',
    startedAt: 0,
    players: [
      { id: null, x: center(3, 14).x, y: center(3, 14).y, hp: 100, maxHp: 100, angle: 0, weapon: 'pistol', ammo: 6, maxAmmo: 6, reloadAt: 0, nextFireAt: 0, knifeAt: 0, rocketAt: 0, armor: false, input: emptyInput(), lastInteract: false, dead: false, color: '#62a6ff' },
      { id: null, x: center(27, 14).x, y: center(27, 14).y, hp: 100, maxHp: 100, angle: Math.PI, weapon: 'pistol', ammo: 6, maxAmmo: 6, reloadAt: 0, nextFireAt: 0, knifeAt: 0, rocketAt: 0, armor: false, input: emptyInput(), lastInteract: false, dead: false, color: '#d58aff' }
    ],
    enemies: makeEnemies(),
    bullets: [],
    bloodStains: [],
    pickups: [
      { id: 'medkit', type: 'heal', x: center(8, 14).x, y: center(8, 14).y, amount: 35, active: true },
      { id: 'bazooka', type: 'bazooka', x: center(22, 27).x, y: center(22, 27).y, active: true },
      { id: 'armor', type: 'armor', x: center(4, 12).x, y: center(4, 12).y, active: true }
    ]
  };
}
function emptyInput() { return { moveX: 0, moveY: 0, angle: 0, fire: false, interact: false, switchWeapon: false }; }
function resetGame() {
  game = makeGame();
  players.forEach((player, index) => {
    if (player) { game.players[index].id = player.id; }
  });
  if (players.filter(Boolean).length === 2) {
    game.phase = 'playing';
    game.startedAt = now();
  }
}
resetGame();

function assignSeat(client) {
  const freeSeat = players.indexOf(null);
  if (freeSeat === -1) { waitingClient = client; client.seat = null; send(client, { type: 'queue' }); return; }
  client.seat = freeSeat;
  players[freeSeat] = client;
  game.players[freeSeat].id = client.id;
  if (players.filter(Boolean).length === 2) {
    game.phase = 'playing';
    game.startedAt = now();
  }
}
function publicState(client, fx) {
  return {
    type: 'snapshot', version: 1, serverTime: now(), phase: game.phase, mySeat: client.seat,
    map: { width: MAP_W, height: MAP_H, cell: CELL_SIZE, grid: MAP_GRID },
    players: game.players.map((player, index) => ({ ...player, input: undefined, connected: Boolean(players[index]) })),
    enemies: game.enemies,
    bullets: game.bullets,
    bloodStains: game.bloodStains,
    pickups: game.pickups,
    fx,
    snapshot: snapshotCounter
  };
}
function send(client, payload) { if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload)); }
function broadcast() { const fx = fxEvents.splice(0); for (const client of clients) send(client, publicState(client, fx)); }

function nearestLivingPlayer(enemy) {
  const available = game.players.filter((player, index) => players[index] && !player.dead);
  return available.sort((a, b) => distance(enemy, a) - distance(enemy, b))[0] || null;
}
function dropBlood(x, y, amount = 1) {
  game.bloodStains.push({ x, y, size: 7 + Math.random() * 9, amount });
  if (game.bloodStains.length > 240) game.bloodStains.splice(0, 20);
}
function hurtEnemy(enemy, damage, vx, vy, source) {
  if (enemy.dead) return;
  enemy.hp -= damage;
  enemy.hitFlash = 5;
  enemy.alerted = true;
  dropBlood(enemy.x, enemy.y, damage >= 3 ? 3 : 1);
  addFx(damage >= 3 ? 'blood-burst' : 'blood', enemy.x, enemy.y, { vx, vy, source });
  if (enemy.hp <= 0) {
    enemy.dead = true;
    addFx('death', enemy.x, enemy.y, { source });
    dropBlood(enemy.x, enemy.y, 4);
    if (source === 'knife') addFx('blood-jet', enemy.x, enemy.y, {});
  }
}
function firePistol(player, index) {
  const timestamp = now();
  if (timestamp < player.nextFireAt || player.reloadAt > timestamp) return;
  if (player.ammo <= 0) { player.reloadAt = timestamp + 1050; return; }
  const angle = player.angle;
  player.ammo -= 1;
  player.nextFireAt = timestamp + 190;
  game.bullets.push({ id: `${timestamp}-${index}-${Math.random()}`, type: 'bullet', owner: index, x: player.x + Math.cos(angle) * 24, y: player.y + Math.sin(angle) * 24, vx: Math.cos(angle) * 14, vy: Math.sin(angle) * 14, radius: 4, damage: 1 });
  addFx('muzzle', player.x + Math.cos(angle) * 24, player.y + Math.sin(angle) * 24, { angle, source: 'pistol' });
}
function fireRocket(player, index) {
  const timestamp = now();
  if (timestamp < player.rocketAt) return;
  const angle = player.angle;
  player.rocketAt = timestamp + 3000;
  game.bullets.push({ id: `${timestamp}-rocket-${index}`, type: 'rocket', owner: index, x: player.x + Math.cos(angle) * 25, y: player.y + Math.sin(angle) * 25, vx: Math.cos(angle) * 8, vy: Math.sin(angle) * 8, radius: 7, damage: 3 });
  addFx('muzzle', player.x + Math.cos(angle) * 25, player.y + Math.sin(angle) * 25, { angle, source: 'rocket' });
}
function fireKnife(player, index) {
  const timestamp = now();
  if (timestamp < player.knifeAt) return;
  player.knifeAt = timestamp + 650;
  addFx('slash', player.x, player.y, { angle: player.angle, source: index });
  game.enemies.forEach((enemy) => {
    if (enemy.dead || distance(player, enemy) > 68) return;
    const angle = Math.atan2(enemy.y - player.y, enemy.x - player.x);
    const delta = Math.atan2(Math.sin(angle - player.angle), Math.cos(angle - player.angle));
    if (Math.abs(delta) < 1.35) hurtEnemy(enemy, 2, Math.cos(player.angle) * 6, Math.sin(player.angle) * 6, 'knife');
  });
}
function explode(x, y, owner) {
  addFx('explosion', x, y, { source: owner });
  game.bloodStains.push({ x, y, size: 28, amount: 6 });
  game.enemies.forEach((enemy) => {
    if (!enemy.dead && Math.hypot(enemy.x - x, enemy.y - y) < 150) hurtEnemy(enemy, 3, enemy.x - x, enemy.y - y, 'rocket');
  });
}
function interact(player) {
  const pickup = game.pickups.find((item) => item.active && distance(player, item) < 48);
  if (!pickup) return;
  if (pickup.type === 'heal') player.hp = Math.min(player.maxHp, player.hp + pickup.amount);
  if (pickup.type === 'bazooka') player.weapon = 'bazooka';
  if (pickup.type === 'armor') player.armor = true;
  pickup.active = false;
  addFx('pickup', pickup.x, pickup.y, { pickup: pickup.type });
}
function updatePlayer(player, index) {
  if (!players[index] || player.dead) return;
  const input = player.input;
  player.angle = Number.isFinite(input.angle) ? input.angle : player.angle;
  const vector = normalize(input.moveX || 0, input.moveY || 0);
  const speed = player.hp <= 5 ? 1.35 : 2.7;
  moveCircle(player, vector.x * speed, vector.y * speed, 14);
  if (input.switchWeapon && !player.lastSwitch) {
    const available = player.weapon === 'bazooka' ? ['pistol', 'knife', 'bazooka'] : ['pistol', 'knife'];
    player.weapon = available[(available.indexOf(player.weapon) + 1) % available.length];
  }
  player.lastSwitch = input.switchWeapon;
  if (input.interact && !player.lastInteract) interact(player);
  player.lastInteract = input.interact;
  if (player.reloadAt && now() >= player.reloadAt) { player.reloadAt = 0; player.ammo = player.maxAmmo; }
  if (input.fire) {
    if (player.weapon === 'pistol') firePistol(player, index);
    else if (player.weapon === 'knife') fireKnife(player, index);
    else fireRocket(player, index);
  }
}
function updateEnemies() {
  game.enemies.forEach((enemy) => {
    if (enemy.dead) return;
    if (enemy.hitFlash > 0) enemy.hitFlash -= 1;
    const target = nearestLivingPlayer(enemy);
    if (!target) return;
    const dist = distance(enemy, target);
    if (dist < 360) enemy.alerted = true;
    if (!enemy.alerted) return;
    if (dist > enemy.radius + 18) {
      const direction = normalize(target.x - enemy.x, target.y - enemy.y);
      moveCircle(enemy, direction.x * enemy.speed, direction.y * enemy.speed, enemy.radius);
    } else if (now() >= enemy.attackAt) {
      enemy.attackAt = now() + 900;
      const targetIndex = game.players.indexOf(target);
      target.hp -= target.armor ? 10 : 25;
      if (target.hp <= 0) { target.hp = 0; target.dead = true; }
      dropBlood(target.x, target.y, 2);
      addFx('player-hit', target.x, target.y, { target: targetIndex });
      if (target.dead) addFx('player-death', target.x, target.y, { target: targetIndex });
    }
  });
}
function updateBullets() {
  for (let i = game.bullets.length - 1; i >= 0; i -= 1) {
    const bullet = game.bullets[i];
    bullet.x += bullet.vx;
    bullet.y += bullet.vy;
    if (blocked(bullet.x, bullet.y, bullet.radius) || bullet.x < 0 || bullet.y < 0 || bullet.x > MAP_W || bullet.y > MAP_H) {
      if (bullet.type === 'rocket') explode(bullet.x, bullet.y, bullet.owner);
      game.bullets.splice(i, 1);
      continue;
    }
    let hit = false;
    for (const enemy of game.enemies) {
      if (enemy.dead || distance(bullet, enemy) > bullet.radius + enemy.radius) continue;
      if (bullet.type === 'rocket') explode(bullet.x, bullet.y, bullet.owner);
      else hurtEnemy(enemy, bullet.damage, bullet.vx, bullet.vy, 'pistol');
      game.bullets.splice(i, 1); hit = true; break;
    }
    if (!hit && bullet.type === 'rocket') {
      for (const enemy of game.enemies) {
        if (!enemy.dead && distance(bullet, enemy) < 22) { explode(bullet.x, bullet.y, bullet.owner); game.bullets.splice(i, 1); break; }
      }
    }
  }
}
function updateGame() {
  if (game.phase !== 'playing') return;
  players.forEach((client, index) => updatePlayer(game.players[index], index));
  updateEnemies();
  updateBullets();
  if (players.filter(Boolean).length === 2 && game.players.every((player) => player.dead || !player.id)) game.phase = 'defeat';
}
function disconnect(client) {
  if (!clients.has(client)) return;
  clients.delete(client);
  if (waitingClient === client) waitingClient = null;
  if (client.seat !== null && players[client.seat] === client) {
    const seat = client.seat;
    players[seat] = null;
    if (waitingClient) { const promoted = waitingClient; waitingClient = null; promoted.seat = seat; players[seat] = promoted; game.players[seat].id = promoted.id; send(promoted, { type: 'welcome', seat }); }
    if (players.filter(Boolean).length < 2) { game.phase = 'waiting'; game.players.forEach((player, index) => { if (!players[index]) player.id = null; }); }
  }
  broadcast();
}

socketServer.on('connection', (client) => {
  client.id = `${now()}-${Math.random().toString(16).slice(2)}`;
  client.seat = null;
  clients.add(client);
  if (players.every(Boolean) && !waitingClient) assignSeat(client); else assignSeat(client);
  send(client, { type: 'welcome', seat: client.seat });
  if (client.seat !== null && players.filter(Boolean).length === 2) game.phase = 'playing';
  broadcast();
  client.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'input' && client.seat !== null && game.players[client.seat]) {
        const input = message.input || {};
        game.players[client.seat].input = {
          moveX: clamp(Number(input.moveX) || 0, -1, 1), moveY: clamp(Number(input.moveY) || 0, -1, 1),
          angle: Number.isFinite(Number(input.angle)) ? Number(input.angle) : game.players[client.seat].angle,
          fire: Boolean(input.fire), interact: Boolean(input.interact), switchWeapon: Boolean(input.switchWeapon)
        };
      }
      if (message.type === 'restart' && game.phase === 'defeat') resetGame();
    } catch { /* ignore malformed client packets */ }
  });
  client.on('close', () => disconnect(client));
  client.on('error', () => disconnect(client));
});
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  socketServer.handleUpgrade(request, socket, head, (client) => socketServer.emit('connection', client, request));
});
setInterval(() => updateGame(), TICK_MS);
setInterval(() => { if (now() - lastSnapshotAt >= SNAPSHOT_MS) { lastSnapshotAt = now(); snapshotCounter += 1; broadcast(); } }, 20);
server.listen(PORT, HOST, () => console.log(`Gunshade co-op listening on http://${HOST}:${PORT}`));
