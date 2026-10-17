export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 });
      const room = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!room) return new Response('Room code required', { status: 400 });
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    this.sockets = new Map();
    this.state = { code: '', players: [], started: false, round: 0 };
    this.readySet = new Set();
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get('state');
      if (saved) this.state = saved;
      this.state.players = [];
      this.state.started = false;
      this.readySet = new Set();
    });
  }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const url = new URL(request.url);
    const code = (url.searchParams.get('room') || '').toUpperCase();
    const name = (url.searchParams.get('name') || '玩家').trim().slice(0, 16) || '玩家';
    const key = crypto.randomUUID();
    this.state.code = code;
    const player = { id: key, name, score: 0, hand: [], ready: false };
    this.state.players.push(player);
    this.sockets.set(key, server);
    server.serializeAttachment({ id: key });
    server.addEventListener('message', event => this.onMessage(key, event.data));
    server.addEventListener('close', () => this.removePlayer(key));
    server.addEventListener('error', () => this.removePlayer(key));
    this.send(server, { type: 'welcome', id: key, state: this.publicState() });
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }
  publicState() {
    return { code: this.state.code, players: this.state.players.map(p => ({ ...p })), started: this.state.started, round: this.state.round };
  }
  send(ws, data) { try { ws.send(JSON.stringify(data)); } catch {} }
  broadcast() {
    const message = JSON.stringify({ type: 'state', state: this.publicState() });
    for (const ws of this.sockets.values()) { try { ws.send(message); } catch {} }
    this.ctx.storage.put('state', this.state).catch(() => {});
  }
  onMessage(id, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const player = this.state.players.find(p => p.id === id);
    if (!player) return;
    if (msg.type === 'ready') {
      player.ready = !!msg.value;
      if (this.state.players.length >= 2 && this.state.players.every(p => p.ready)) {
        this.state.started = true; this.state.round++;
        for (const p of this.state.players) p.hand = Array.from({ length: 5 }, () => ({ rank: ['A','2','3','4','5','6','7','8','9','10','J','Q','K'][Math.floor(Math.random()*13)], suit: ['♠','♥','♦','♣'][Math.floor(Math.random()*4)] }));
      }
      this.broadcast();
    } else if (msg.type === 'transfer') {
      const amount = Math.trunc(Number(msg.amount));
      const target = this.state.players.find(p => p.id === msg.to);
      if (!target || target.id === player.id || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
        this.send(this.sockets.get(id), { type: 'notice', text: '请选择其他玩家，并输入大于0的整数积分' }); return;
      }
      player.score -= amount; target.score += amount;
      this.broadcast();
    } else if (msg.type === 'next') {
      if (this.state.players.length < 2) { this.send(this.sockets.get(id), { type: 'notice', text: '至少需要2名玩家' }); return; }
      this.state.started = false;
      for (const p of this.state.players) { p.ready = false; p.hand = []; }
      this.broadcast();
    }
  }
  removePlayer(id) {
    this.sockets.delete(id);
    this.state.players = this.state.players.filter(p => p.id !== id);
    if (this.state.players.length < 2) this.state.started = false;
    this.broadcast();
  }
}
