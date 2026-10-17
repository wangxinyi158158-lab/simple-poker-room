'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingInterval: 25000,
  pingTimeout: 20000
});

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 10; // 52张牌，每人5张，最多支持10人
const RECONNECT_GRACE_MS = 2 * 60 * 1000;
const rooms = new Map();

function cleanName(value) {
  const name = String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 12);
  return name || `玩家${Math.floor(100 + Math.random() * 900)}`;
}

function cleanClientKey(value) {
  const key = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(key) ? key : null;
}

function cleanRoomCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code) {
  return {
    code,
    players: new Map(),
    round: 0,
    logs: [],
    cleanupTimer: null
  };
}

function getPlayerFromSocket(socket) {
  const { roomCode, clientKey } = socket.data || {};
  if (!roomCode || !clientKey) return {};
  const room = rooms.get(roomCode);
  if (!room) return {};
  const player = room.players.get(clientKey);
  return { room, player, roomCode, clientKey };
}

function addLog(room, message) {
  room.logs.unshift({ id: crypto.randomUUID(), message, time: Date.now() });
  room.logs = room.logs.slice(0, 8);
}

function makeDeck() {
  const suits = [
    { name: '黑桃', symbol: '♠', color: 'black' },
    { name: '红桃', symbol: '♥', color: 'red' },
    { name: '梅花', symbol: '♣', color: 'black' },
    { name: '方块', symbol: '♦', color: 'red' }
  ];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit: suit.name, symbol: suit.symbol, color: suit.color, label: `${suit.symbol}${rank}` });
    }
  }
  // Fisher-Yates 洗牌
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function snapshot(room) {
  return {
    code: room.code,
    round: room.round,
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      ready: player.ready,
      cards: player.cards,
      online: player.sockets.size > 0
    })),
    logs: room.logs
  };
}

function publish(room) {
  io.to(`room:${room.code}`).emit('roomState', snapshot(room));
}

function removePlayer(room, clientKey, reason = '') {
  const player = room.players.get(clientKey);
  if (!player) return;
  if (player.cleanupTimer) clearTimeout(player.cleanupTimer);
  room.players.delete(clientKey);
  if (reason) addLog(room, `${player.name}${reason}`);
  if (room.players.size === 0) {
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    rooms.delete(room.code);
  } else {
    publish(room);
  }
}

function bindPlayer(socket, room, player) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  if (player.cleanupTimer) {
    clearTimeout(player.cleanupTimer);
    player.cleanupTimer = null;
  }
  player.sockets.add(socket.id);
  player.lastSeen = Date.now();
  socket.data.roomCode = room.code;
  socket.data.clientKey = player.id;
  socket.join(`room:${room.code}`);
}

function enterRoom(socket, room, clientKey, name) {
  let player = room.players.get(clientKey);
  if (!player) {
    if (room.players.size >= MAX_PLAYERS) return { ok: false, error: `房间最多容纳${MAX_PLAYERS}名玩家` };
    player = {
      id: clientKey,
      name,
      score: 0,
      ready: false,
      cards: [],
      sockets: new Set(),
      cleanupTimer: null,
      lastSeen: Date.now()
    };
    room.players.set(clientKey, player);
    addLog(room, `${name}加入了房间`);
  } else {
    player.name = name;
    if (player.sockets.size === 0) addLog(room, `${name}重新进入房间`);
  }
  bindPlayer(socket, room, player);
  publish(room);
  return { ok: true, code: room.code, playerId: player.id };
}

function tryDeal(room) {
  const players = [...room.players.values()];
  if (players.length < 2 || !players.every(p => p.ready && p.sockets.size > 0)) return false;
  const deck = makeDeck();
  let index = 0;
  for (const player of players) {
    player.cards = deck.slice(index, index + 5);
    index += 5;
    player.ready = false;
  }
  room.round += 1;
  addLog(room, `第${room.round}局已发牌，每人5张`);
  publish(room);
  return true;
}

io.on('connection', socket => {
  socket.on('createRoom', (payload = {}, callback = () => {}) => {
    const clientKey = cleanClientKey(payload.clientKey);
    if (!clientKey) return callback({ ok: false, error: '浏览器身份无效，请刷新页面重试' });
    const code = makeRoomCode();
    const room = newRoom(code);
    rooms.set(code, room);
    const result = enterRoom(socket, room, clientKey, cleanName(payload.name));
    callback(result);
  });

  socket.on('joinRoom', (payload = {}, callback = () => {}) => {
    const clientKey = cleanClientKey(payload.clientKey);
    const code = cleanRoomCode(payload.code);
    if (!clientKey) return callback({ ok: false, error: '浏览器身份无效，请刷新页面重试' });
    if (!/^[A-Z0-9]{6}$/.test(code)) return callback({ ok: false, error: '请输入6位房间号' });
    const room = rooms.get(code);
    if (!room) return callback({ ok: false, error: '房间不存在或已经关闭，请检查房间号' });
    const result = enterRoom(socket, room, clientKey, cleanName(payload.name));
    callback(result);
  });

  socket.on('setReady', (_payload, callback = () => {}) => {
    const { room, player } = getPlayerFromSocket(socket);
    if (!room || !player) return callback({ ok: false, error: '请先进入房间' });
    if (room.players.size < 2) return callback({ ok: false, error: '至少需要2名玩家才能开始' });
    player.ready = !player.ready;
    publish(room);
    const dealt = tryDeal(room);
    callback({ ok: true, dealt });
  });

  socket.on('transferPoints', (payload = {}, callback = () => {}) => {
    const { room, player } = getPlayerFromSocket(socket);
    if (!room || !player) return callback({ ok: false, error: '请先进入房间' });
    const recipientId = cleanClientKey(payload.to);
    const amount = Number(payload.amount);
    if (!recipientId || recipientId === player.id) return callback({ ok: false, error: '请选择另一名玩家' });
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
      return callback({ ok: false, error: '转让积分请输入1到1000000之间的整数' });
    }
    const recipient = room.players.get(recipientId);
    if (!recipient) return callback({ ok: false, error: '该玩家已离开房间' });
    player.score -= amount;
    recipient.score += amount;
    addLog(room, `${player.name}转给${recipient.name} ${amount}积分`);
    publish(room);
    callback({ ok: true });
  });

  socket.on('leaveRoom', (_payload, callback = () => {}) => {
    const { room, player, roomCode, clientKey } = getPlayerFromSocket(socket);
    if (!room || !player) return callback({ ok: true });
    socket.leave(`room:${roomCode}`);
    player.sockets.delete(socket.id);
    // 主动退出时立即移除该玩家；若另一个标签页仍在线则保留。
    if (player.sockets.size === 0) removePlayer(room, clientKey, '离开了房间');
    socket.data.roomCode = null;
    socket.data.clientKey = null;
    callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const { room, player, clientKey } = getPlayerFromSocket(socket);
    if (!room || !player) return;
    player.sockets.delete(socket.id);
    player.lastSeen = Date.now();
    if (player.sockets.size === 0) {
      player.ready = false;
      player.cleanupTimer = setTimeout(() => {
        const latest = rooms.get(room.code);
        if (latest && latest.players.get(clientKey) === player && player.sockets.size === 0) {
          removePlayer(latest, clientKey, '离开了房间（连接超时）');
        }
      }, RECONNECT_GRACE_MS);
      if (typeof player.cleanupTimer.unref === 'function') player.cleanupTimer.unref();
    }
    publish(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`多人扑克牌房间已启动：http://localhost:${PORT}`);
});
