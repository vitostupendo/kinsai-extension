// KINSY — uplink to the kinsai-api backend.
//
// Two responsibilities:
//   1) license sign-in: Solana challenge / signed verify / JWT
//   2) agent WS: stream observed kintara frames up, execute inject
//      commands sent down, surface feed lines from the server.
//
// The server is the brain. This module just plumbs.

const API_BASE = 'https://api.kinsai.xyz';
const WS_PATH  = '/ws/agent';

// ---- license HTTP ------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return body;
}

export async function fetchChallenge(wallet) {
  return api(`/api/license/challenge?wallet=${encodeURIComponent(wallet)}`);
}

export async function fetchWalletBalance(wallet) {
  return api(`/api/license/balance?wallet=${encodeURIComponent(wallet)}`);
}

export async function submitVerify({ publicKey, signature, message, challengeId }) {
  return api('/api/license/verify', {
    method: 'POST',
    body: JSON.stringify({ publicKey, signature, message, challengeId }),
  });
}

// ---- agent WS ----------------------------------------------------------

export class Uplink {
  constructor({ kintaraClient, onFeed, onGate, onInjectResult }) {
    this.kintaraClient = kintaraClient;
    this.onFeed   = onFeed   || (() => {});
    this.onGate   = onGate   || (() => {});
    this.onInjectResult = onInjectResult || (() => {});

    this.ws = null;
    this.token = null;
    this.sid = null;
    this.lastDrainAt = 0;
    this._drainTimer = null;
    this._pingTimer = null;
    this._closed = true;
    this._policy = 'observe';
    this._reconnectTimer = null;
    this._playerId = null;
    this._missingPresenceTicks = 0;
    this._lastPresenceReloadAt = 0;
  }

  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  async connect(token) {
    this.token = token;
    this._closed = false;
    this._openSocket();
  }

  setPolicy(policy) {
    this._policy = policy;
    if (this.isOpen()) this._send({ t: 'policy', policy });
  }

  setPlayerId(playerId) {
    const id = Number(playerId);
    if (!Number.isFinite(id) || id <= 0 || id === this._playerId) return;
    this._playerId = id;
    if (this.isOpen()) this._send({ t: 'player', id });
  }

  close(reason = 'client_close') {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._drainTimer)     { clearInterval(this._drainTimer); this._drainTimer = null; }
    if (this._pingTimer)      { clearInterval(this._pingTimer);  this._pingTimer  = null; }
    if (this.ws) {
      try { this.ws.close(1000, reason); } catch { /* */ }
      this.ws = null;
    }
  }

  _openSocket() {
    if (this._closed || !this.token) return;
    const url = `${API_BASE.replace(/^http/, 'ws')}${WS_PATH}?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.onFeed('uplink · connected');
      this._send({ t: 'hello', version: '0.1' });
      if (this._playerId) this._send({ t: 'player', id: this._playerId });
      this._send({ t: 'policy', policy: this._policy });
      this._send({ t: 'announce_sockets' }); // server ignores; we announce via drain loop instead
      this._startLoops();
    });

    this.ws.addEventListener('message', (ev) => this._onMessage(ev));

    this.ws.addEventListener('close', () => {
      this._stopLoops();
      if (this._closed) return;
      this.onFeed('uplink · disconnected, retrying…');
      this._reconnectTimer = setTimeout(() => this._openSocket(), 3000);
    });

    this.ws.addEventListener('error', () => {
      // 'close' will fire next; let that handle retry.
    });
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg?.t) {
      case 'hello':
        this.sid = msg.sid;
        if (msg.balance != null && msg.minHold != null) {
          this.onGate({ ok: msg.balance >= msg.minHold, balance: msg.balance, minHold: msg.minHold });
        }
        return;
      case 'feed':   return this.onFeed(msg.msg);
      case 'gate':   return this.onGate(msg);
      case 'inject': return this._handleInject(msg);
      case 'client_action': return this._handleClientAction(msg);
      case 'pong':   return;
    }
  }

  async _handleInject(msg) {
    try {
      await this.kintaraClient.wsSend(msg.socketId, msg.payload);
      this.onInjectResult({ ok: true });
    } catch (err) {
      this.onInjectResult({ ok: false, error: err?.message || String(err) });
    }
  }

  async _handleClientAction(msg) {
    const payload = msg.payload || {};
    try {
      if (payload.op === 'select_tool') {
        await this.kintaraClient.selectTool(payload.tool);
      } else {
        await this.kintaraClient.pageAction(payload);
      }
      this.onInjectResult({ ok: true });
    } catch (err) {
      const text = err?.message || String(err);
      if (payload.op === 'select_tool') {
        this.onFeed(text);
      } else {
        this.onFeed(`client action failed · ${text}`);
      }
      this.onInjectResult({ ok: false, error: err?.message || String(err) });
    }
  }

  _send(obj) {
    if (this.isOpen()) this.ws.send(JSON.stringify(obj));
  }

  _startLoops() {
    if (this._drainTimer) clearInterval(this._drainTimer);
    if (this._pingTimer)  clearInterval(this._pingTimer);

    // Drain observed kintara frames and forward them. ~5Hz.
    this._drainTimer = setInterval(() => this._forwardObservations().catch(() => {}), 200);
    this._pingTimer  = setInterval(() => this._send({ t: 'ping' }), 25_000);
  }

  _stopLoops() {
    if (this._drainTimer) { clearInterval(this._drainTimer); this._drainTimer = null; }
    if (this._pingTimer)  { clearInterval(this._pingTimer);  this._pingTimer  = null; }
  }

  async _forwardObservations() {
    if (!this.isOpen()) return;
    let drain;
    try { drain = await this.kintaraClient.wsDrain(this.lastDrainAt); }
    catch { return; }
    this.lastDrainAt = drain.now;
    await this._recoverMissingPresence(drain);

    // Announce sockets we know about (idempotent on server).
    for (const s of drain.sockets || []) {
      this._send({ t: 'socket_open', id: s.id, kind: { channel: s.kind, shard: s.shard } });
    }

    // Forward the latest pos (highest-rate signal — relevant for planner).
    if (drain.latestPos) {
      this._send({ t: 'obs', dir: 'send', data: drain.latestPos });
    }
    // Forward the latest snap.
    if (drain.latestSnap) {
      this._send({ t: 'obs', dir: 'recv', data: drain.latestSnap });
    }
    // Forward batched events.
    for (const ev of drain.events) {
      if (ev.event !== 'recv' && ev.event !== 'send') continue;
      this._send({ t: 'obs', id: ev.id, dir: ev.event, data: ev.data });
    }
  }

  async _recoverMissingPresence(drain) {
    if (!this._policy || this._policy === 'observe') {
      this._missingPresenceTicks = 0;
      return;
    }
    const hasPresence = (drain.sockets || []).some((s) => s.kind === 'presence');
    if (hasPresence) {
      this._missingPresenceTicks = 0;
      return;
    }
    this._missingPresenceTicks += 1;
    const now = Date.now();
    if (this._missingPresenceTicks < 25 || now - this._lastPresenceReloadAt < 45_000) return;

    this._missingPresenceTicks = 0;
    this._lastPresenceReloadAt = now;
    this.onFeed('presence socket missing · reloading Kintara tab');
    try {
      await this.kintaraClient.reloadGameTab();
      this.lastDrainAt = 0;
    } catch (err) {
      this.onFeed(`presence reload failed · ${err?.message || err}`);
    }
  }
}
