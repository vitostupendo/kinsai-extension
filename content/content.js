// KINSY — content script (ISOLATED world).
// Two jobs:
//   1) Bridge between extension and the page's window.solana (via phantom-bridge.js in MAIN world).
//   2) Inject and update the in-game HUD overlay on kintara.com.
//
// Idempotent: safe to re-inject. The first run sets globalThis.__KINSAI_CS__;
// subsequent runs (e.g. after extension reload + auto-reinject) bail.

if (!globalThis.__KINSAI_CS__) {
  globalThis.__KINSAI_CS__ = true;

const NS = 'kinsai';
const log = (...a) => console.log(`[${NS}/cs]`, ...a);

// ----- 1. Phantom bridge plumbing ----------------------------------------

const pending = new Map(); // id -> {resolve, reject, timeout}
let phantomReady = false;

// ----- WS bridge state (populated by ws-bridge.js in MAIN world) -------
const WS_RING_CAP = 400;
const wsRing = [];           // bounded array of {ts, event, id, t, data, kind}
const wsSockets = new Map(); // socket id -> { kind, opened, readyState }
let wsPendingInjects = new Map(); // reqId -> {resolve, reject, timeout}
let actionPending = new Map(); // reqId -> {resolve, reject, timeout}
let wsPendingLists = new Map(); // reqId -> {resolve, timeout}

function pushWsEvent(ev) {
  wsRing.push(ev);
  if (wsRing.length > WS_RING_CAP) wsRing.splice(0, wsRing.length - WS_RING_CAP);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.src !== NS) return;

  // Phantom bridge messages
  if (!msg.ch && msg.dir === 'bridge>cs') {
    if (msg.event === 'READY') {
      phantomReady = !!msg.phantom;
      log('bridge ready, phantom=', phantomReady);
      return;
    }
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timeout);
    msg.ok ? slot.resolve(msg.data) : slot.reject(new Error(msg.error));
    return;
  }

  // WS bridge messages
  if (msg.ch === 'ws' && msg.dir === 'bridge>cs') {
    const now = Date.now();
    if (msg.event === 'open') {
      wsSockets.set(msg.id, { kind: msg.kind, openedAt: now });
      pushWsEvent({ ts: now, event: 'open', id: msg.id, kind: msg.kind?.channel });
    } else if (msg.event === 'close') {
      wsSockets.delete(msg.id);
      pushWsEvent({ ts: now, event: 'close', id: msg.id });
    } else if (msg.event === 'send' || msg.event === 'recv') {
      // Drop the very high-frequency `snap`/`pos` from the ring (we still
      // surface the latest one separately).
      const t = msg.t;
      if (t === 'snap') {
        latestSnap = msg.data;
      } else if (t === 'pos' && msg.event === 'send') {
        latestPos = msg.data;
      } else {
        pushWsEvent({ ts: now, event: msg.event, id: msg.id, t, data: msg.data, kind: wsSockets.get(msg.id)?.kind?.channel });
      }
    } else if (msg.event === 'list') {
      for (const item of msg.list || []) {
        if (item.readyState === 1 && item.kind) {
          wsSockets.set(item.id, { kind: item.kind, openedAt: now });
        } else {
          wsSockets.delete(item.id);
        }
      }
      const slot = wsPendingLists.get(msg.reqId);
      if (slot) {
        wsPendingLists.delete(msg.reqId);
        clearTimeout(slot.timeout);
        slot.resolve();
      }
    } else if (msg.event === 'inject_ok' || msg.event === 'inject_err') {
      const slot = wsPendingInjects.get(msg.reqId);
      if (slot) {
        wsPendingInjects.delete(msg.reqId);
        clearTimeout(slot.timeout);
        msg.event === 'inject_ok' ? slot.resolve() : slot.reject(new Error(msg.error));
      }
    }
    return;
  }

  if (msg.ch === 'action' && msg.dir === 'bridge>cs') {
    const slot = actionPending.get(msg.reqId);
    if (!slot) return;
    actionPending.delete(msg.reqId);
    clearTimeout(slot.timeout);
    msg.ok ? slot.resolve(msg.data) : slot.reject(new Error(msg.error || 'action failed'));
  }
});

let latestSnap = null;  // most recent server snap
let latestPos  = null;  // most recent client pos heartbeat we observed
let latestState = null; // most recent extension state, used for local player id
let latestPlayerId = null;

function callBridge(op, payload = {}, timeoutMs = 60_000) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`bridge timeout for ${op}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    window.postMessage({ src: NS, dir: 'cs>bridge', id, op, ...payload }, '*');
  });
}

function injectWsFrame(id, payload, timeoutMs = 5_000) {
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wsPendingInjects.delete(reqId);
      reject(new Error('ws inject timeout'));
    }, timeoutMs);
    wsPendingInjects.set(reqId, { resolve, reject, timeout });
    driveLocalAvatar(payload);
    window.postMessage({ src: NS, ch: 'ws', dir: 'cs>bridge', op: 'send', id, reqId, payload }, '*');
  });
}

function driveLocalAvatar(payload) {
  if (!payload || payload.t !== 'pos') return;
  const playerId = latestPlayerId || latestState?.agent?.snapshot?.pid;
  if (!playerId) return;
  window.postMessage({
    src: NS,
    ch: 'ws',
    dir: 'cs>bridge',
    op: 'drive_pos',
    playerId,
    payload,
  }, '*');
}

function listWsSockets() {
  const out = [];
  for (const [id, meta] of wsSockets) out.push({ id, kind: meta.kind?.channel, shard: meta.kind?.shard });
  return out;
}

function syncWsSocketList(timeoutMs = 250) {
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      wsPendingLists.delete(reqId);
      resolve();
    }, timeoutMs);
    wsPendingLists.set(reqId, { resolve, timeout });
    try {
      window.postMessage({ src: NS, ch: 'ws', dir: 'cs>bridge', op: 'list', reqId }, '*');
    } catch {
      clearTimeout(timeout);
      wsPendingLists.delete(reqId);
      resolve();
    }
  });
}

function runKintaraAction(payload, timeoutMs = 4_000) {
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      actionPending.delete(reqId);
      reject(new Error('action timeout'));
    }, timeoutMs);
    actionPending.set(reqId, { resolve, reject, timeout });
    window.postMessage({ src: NS, ch: 'action', dir: 'cs>bridge', reqId, payload }, '*');
  });
}

// Background talks to us; we relay to the page's window.solana via the bridge,
// and proxy HTTP calls into the Kintara API (we run in the kintara.com origin so
// the session cookie is automatically attached by the browser).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'BRIDGE_CALL') {
    (async () => {
      try {
        const data = await callBridge(msg.op, msg.payload || {});
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'KINTARA_FETCH') {
    (async () => {
      try {
        const data = await kintaraFetch(msg.payload || {});
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'WS_DRAIN') {
    (async () => {
      await syncWsSocketList();
      const since = Number(msg.since || 0);
      const events = wsRing.filter((e) => e.ts > since);
      sendResponse({
        ok: true,
        data: {
          events,
          sockets: listWsSockets(),
          latestSnap,
          latestPos,
          now: Date.now(),
        },
      });
    })();
    return true;
  }

  if (msg?.type === 'WS_SEND') {
    (async () => {
      try {
        const { socketId, payload } = msg;
        await injectWsFrame(socketId, payload);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'KINTARA_ACTION') {
    (async () => {
      try {
        const data = await runKintaraAction(msg.payload || {});
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
});

async function kintaraFetch({ host = 'kintara.com', method = 'GET', path, body, timeoutMs = 15_000 }) {
  if (!path) throw new Error('path required');
  const usePageOrigin = isKintaraPageHost(location.hostname) && isKintaraApiHost(host);
  const requestHost = usePageOrigin ? location.hostname : host;
  const url = `https://${requestHost}${path}`;
  const sameOrigin = requestHost === location.hostname;
  const credentials = host === 'fanout.kintara.com' ? 'omit' : 'include';
  const init = {
    method,
    credentials,
    headers: { 'Accept': 'application/json' },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;
  let res;
  try {
    try {
      res = await fetch(sameOrigin ? path : url, init);
    } catch (err) {
      if (!sameOrigin) throw err;
      res = await fetch(url, init);
    }
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  return { status: res.status, ok: res.ok, json, text };
}

function isKintaraPageHost(hostname) {
  return hostname === 'kintara.com' ||
    hostname.endsWith('.kintara.com') ||
    hostname === 'kintara.gg' ||
    hostname.endsWith('.kintara.gg');
}

function isKintaraApiHost(hostname) {
  return hostname === 'kintara.com' ||
    hostname.endsWith('.kintara.com') ||
    hostname === 'kintara.gg' ||
    hostname.endsWith('.kintara.gg');
}

// ----- 2. HUD overlay ----------------------------------------------------

let hud, hudState, hudTitle, hudSetup, hudConnect, hudAuthorize, hudLoop, hudGold, hudResources, hudFeed;
let hudToggle, hudStart, hudDisconnect, hudRevoke, hudModeCards;
let hudLevel = 'mid';

function mountHud() {
  if (hud) return;
  hud = document.createElement('div');
  hud.id = 'kinsai-hud';
  hud.innerHTML = `
    <div class="kinsai-hud-head">
      <img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="" />
      <div>
        <strong>KINSY</strong>
        <span id="kinsai-hud-state">idle</span>
      </div>
      <button id="kinsai-hud-toggle" type="button" aria-label="Minimize KINSY panel">▾</button>
    </div>
    <div class="kinsai-hud-body">
      <div class="kinsai-hud-title" id="kinsai-hud-title">connect KINSY</div>
      <div class="kinsai-hud-setup" id="kinsai-hud-setup">
        <button id="kinsai-hud-connect" type="button">Connect Phantom</button>
        <button id="kinsai-hud-authorize" type="button">Wake KINSY</button>
      </div>
      <dl class="kinsai-hud-stats">
        <div><dt>Loop</dt><dd id="kinsai-hud-loop">—</dd></div>
        <div><dt>Gold</dt><dd id="kinsai-hud-gold">+0</dd></div>
      </dl>
      <div id="kinsai-hud-resources" class="kinsai-hud-resources" aria-label="Backpack resources"></div>
      <ol id="kinsai-hud-feed"></ol>
      <div class="kinsai-hud-expanded" aria-label="Agent controls">
        <div class="kinsai-hud-status-row">
          <span>● Wallet</span>
          <span>● Session</span>
          <span>🔒 Holder</span>
        </div>
        <div class="kinsai-hud-mode-panel">
          <div class="kinsai-hud-label">Mode</div>
          <div class="kinsai-hud-tabs">
            <button class="is-disabled" type="button" disabled>🌱 Smart soon</button>
            <button type="button">🛠 Gather</button>
            <button class="is-disabled" type="button" disabled>⚔ Combat</button>
          </div>
          <div class="kinsai-hud-mode-grid">
            <button type="button" data-policy="observe"><span>🔭</span><b>Observe</b></button>
            <button type="button" data-policy="harvest_wood"><span>🪓</span><b>Wood</b></button>
            <button type="button" data-policy="harvest_stone"><span>⛏</span><b>Rocks</b></button>
            <button type="button" data-policy="harvest_fish"><span>🐟</span><b>Fish</b></button>
            <button class="is-disabled" type="button" disabled><span>⚔</span><b>Battle</b><em>Soon</em></button>
            <button class="is-disabled" type="button" disabled><span>📊</span><b>Market</b><em>Soon</em></button>
            <button class="is-disabled" type="button" disabled><span>⚖</span><b>Trade</b><em>Soon</em></button>
            <button class="is-disabled" type="button" disabled><span>🌱</span><b>Smart</b><em>Soon</em></button>
          </div>
        </div>
        <div class="kinsai-hud-actions">
          <button id="kinsai-hud-start" type="button">Start</button>
          <button id="kinsai-hud-revoke" type="button">Revoke</button>
        </div>
        <div class="kinsai-hud-safety">
          <div class="kinsai-hud-label">Safety & automation</div>
          <section><span>🛡 Loot Safety</span><em>Soon</em></section>
          <section><span>🎒 Inventory Safe</span><em>Soon</em></section>
          <section><span>❤️ Low HP Retreat</span><em>Soon</em></section>
          <section><span>✈ Telegram Alerts</span><em>Soon</em></section>
          <div class="kinsai-hud-setting-card">
            <div class="kinsai-hud-setting-copy">
              <div class="kinsai-hud-setting-title">
                <span class="kinsai-hud-setting-icon" aria-hidden="true">🚶</span>
                <span>Human-Like Mode</span>
                <span class="kinsai-hud-info" tabindex="0" role="button" aria-label="Human-Like Mode details">
                  i
                  <span class="kinsai-hud-tooltip" role="tooltip">
                    <span>Natural pacing & movement</span>
                    <span>Short random idle breaks</span>
                    <span>Ambient walking around</span>
                    <span>Simple friendly replies when mentioned</span>
                  </span>
                </span>
              </div>
            </div>
            <label class="kinsai-hud-switch" aria-label="Human-Like Mode">
              <input id="kinsai-hud-human-like-mode" type="checkbox" checked />
              <span></span>
            </label>
          </div>
          <div class="kinsai-hud-setting-card">
            <div class="kinsai-hud-setting-copy">
              <div class="kinsai-hud-setting-title">
                <span class="kinsai-hud-setting-icon" aria-hidden="true">💬</span>
                <span>Auto Reply</span>
              </div>
              <div class="kinsai-hud-setting-subtitle">Reply when your player name is mentioned</div>
            </div>
            <label class="kinsai-hud-switch" aria-label="Auto Reply">
              <input id="kinsai-hud-auto-reply" type="checkbox" checked />
              <span></span>
            </label>
          </div>
        </div>
        <button id="kinsai-hud-disconnect" class="kinsai-hud-disconnect" type="button">Disconnect wallet</button>
      </div>
    </div>
  `;
  document.documentElement.append(hud);

  hudState = hud.querySelector('#kinsai-hud-state');
  hudTitle = hud.querySelector('#kinsai-hud-title');
  hudSetup = hud.querySelector('#kinsai-hud-setup');
  hudConnect = hud.querySelector('#kinsai-hud-connect');
  hudAuthorize = hud.querySelector('#kinsai-hud-authorize');
  hudLoop  = hud.querySelector('#kinsai-hud-loop');
  hudGold  = hud.querySelector('#kinsai-hud-gold');
  hudResources = hud.querySelector('#kinsai-hud-resources');
  hudFeed  = hud.querySelector('#kinsai-hud-feed');
  hudToggle = hud.querySelector('#kinsai-hud-toggle');
  hudStart = hud.querySelector('#kinsai-hud-start');
  hudRevoke = hud.querySelector('#kinsai-hud-revoke');
  hudDisconnect = hud.querySelector('#kinsai-hud-disconnect');
  hudModeCards = Array.from(hud.querySelectorAll('[data-policy]'));

  setHudLevel('mid');
  hudToggle.addEventListener('click', () => {
    const next = hudLevel === 'max' ? 'mid' : hudLevel === 'mid' ? 'min' : 'max';
    setHudLevel(next);
  });
  hudStart.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'AGENT_TOGGLE' }, () => {});
  });
  hudConnect.addEventListener('click', () => runHudAction(hudConnect, 'Waiting for Phantom…', 'Connect Phantom', async () => {
    const res = await sendRuntime('PHANTOM_CONNECT');
    if (!res?.ok) throw new Error(res?.error || 'connect failed');
  }));
  hudAuthorize.addEventListener('click', () => runHudAction(hudAuthorize, 'Signing…', 'Wake KINSY', async () => {
    const res = await sendRuntime('SESSION_AUTHORIZE');
    if (!res?.ok) throw new Error(res?.error || 'session refused');
  }));
  hudRevoke.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SESSION_REVOKE' }, () => {});
  });
  hudDisconnect.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'WALLET_DISCONNECT' }, () => {});
  });
  for (const card of hudModeCards) {
    card.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'AGENT_POLICY', payload: { policy: card.dataset.policy } }, () => {});
    });
  }
}

function setHudLevel(level) {
  hudLevel = level;
  hud.dataset.level = level;
  hud.classList.toggle('kinsai-hud-expanded-open', level === 'max');
  hud.classList.toggle('kinsai-hud-minimized', level === 'min');

  if (!hudToggle) return;
  const labels = {
    max: ['▴', 'Show compact KINSY panel'],
    mid: ['▾', 'Minimize KINSY to one row'],
    min: ['▴', 'Show full KINSY panel'],
  };
  const [glyph, label] = labels[level] || labels.mid;
  hudToggle.textContent = glyph;
  hudToggle.title = label;
  hudToggle.setAttribute('aria-label', label);
  hudToggle.setAttribute('aria-expanded', String(level !== 'min'));
}

function sendRuntime(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}

async function runHudAction(button, busyText, doneText, fn) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await fn();
    pullAndRender();
  } catch (err) {
    pushLocalHudMessage(err?.message || String(err));
  } finally {
    button.disabled = false;
    button.textContent = doneText || oldText;
  }
}

function pushLocalHudMessage(msg) {
  if (!hudFeed || !msg) return;
  const li = document.createElement('li');
  li.innerHTML = `<time>${fmtTime(Date.now())}</time><span></span>`;
  li.querySelector('span').textContent = msg;
  hudFeed.prepend(li);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const HUD_RESOURCE_ITEMS = [
  ['wood', '🪵', 'Wood'],
  ['stone', '🪨', 'Stone'],
  ['coal', '⚫', 'Coal'],
  ['metal', '⛓', 'Metal'],
  ['fish', '🎣', 'Fish'],
  ['cookedFish', '🍲', 'Cooked'],
];

function renderHudResources(resources = {}) {
  if (!hudResources) return;
  hudResources.innerHTML = '';
  for (const [key, icon, label] of HUD_RESOURCE_ITEMS) {
    const item = document.createElement('div');
    item.className = 'kinsai-hud-resource';
    item.innerHTML = '<span></span><strong></strong><em></em>';
    item.querySelector('span').textContent = icon;
    item.querySelector('strong').textContent = (resources[key] ?? 0).toLocaleString();
    item.querySelector('em').textContent = label;
    hudResources.append(item);
  }
}

function cleanFeedMessage(msg = '') {
  const raw = String(msg).replace(/^\[backend\]\s*/, '').trim();
  const lower = raw.toLowerCase();

  if (!raw) return null;

  const gathered = gatheredMessage(raw);
  if (gathered) return gathered;

  if (
    lower.includes('kintara data unavailable') ||
    (lower.includes('route check skipped') && lower.includes('failed to fetch'))
  ) {
    return 'Refresh Kintara tab';
  }

  if (lower.includes('wrong tool') || lower.includes('tool missing')) {
    const need = raw.match(/need ([^(·]+)/i)?.[1]?.trim() || raw.match(/equip an? ([^·]+)/i)?.[1]?.trim();
    return need ? `Needs ${need}` : 'Needs the right tool';
  }
  if (lower.includes('inject failed') || lower.includes('socket not open')) return null;
  if (lower.includes('client action failed') && lower.includes('socket')) return null;
  if (lower.includes('failed') || lower.includes('error') || lower.includes('expired')) return raw;
  if (lower.includes('wallet connected')) return 'Wallet connected';
  if (lower.includes('wallet disconnected')) return 'Wallet disconnected';
  if (lower.includes('pass ready') || lower.includes('licensed')) return 'Session ready';
  if (lower.includes('pass revoked') || lower.includes('session revoked')) return 'Session revoked';
  if (lower.includes('no ') && lower.includes(' in current snap')) return null;
  if (lower.includes('retarget · no')) return 'Looking for another node';

  const hiddenPrefixes = [
    'planner ·',
    'target →',
    'moving →',
    'policy →',
    'mode →',
    'queue ',
    'queue ·',
    'arena ',
    'presence ',
    'uplink ·',
    'signed in ·',
    'kintara ·',
    'region →',
    'agent started',
    'agent paused',
    'kinsy started',
    'kinsy paused',
    'equipped ',
    'syncing ',
  ];
  if (hiddenPrefixes.some((prefix) => lower.startsWith(prefix))) return null;
  if (lower.includes('waiting for')) return null;
  if (lower.includes('scanning')) return null;
  if (lower.includes('busy · retargeting')) return null;

  return null;
}

function gatheredMessage(raw) {
  const lower = raw.toLowerCase();
  if (!/(grant(?:ed)?|\+1)/i.test(raw)) return null;
  const resource = raw.match(/(?:grant(?:ed)?|\+1)\s*[·:]?\s*([^\d@]+)/i)?.[1] || raw;
  if (lower.includes('wood') || lower.includes('tree')) return '🪵 Wood gathered';
  if (lower.includes('stone') || lower.includes('rock')) return '🪨 Stone gathered';
  if (lower.includes('coal')) return '⚫ Coal gathered';
  if (lower.includes('metal')) return '⛓ Metal gathered';
  if (lower.includes('fish') && !lower.includes('cooked')) return '🎣 Fish gathered';
  if (lower.includes('cooked')) return '🍲 Cooked fish added';
  if (resource !== raw) return `${resource.trim()} gathered`;
  return null;
}

function visibleFeed(feed = []) {
  const out = [];
  const seen = new Set();
  for (let i = feed.length - 1; i >= 0 && out.length < 6; i -= 1) {
    const event = feed[i];
    const msg = cleanFeedMessage(event?.msg);
    if (!msg) continue;
    const key = `${msg}:${Math.floor((event.ts || 0) / 10_000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...event, msg });
  }
  return out;
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function renderHud(state) {
  if (!hud) return;
  latestState = state;
  if (state?.agent?.snapshot?.pid) latestPlayerId = state.agent.snapshot.pid;
  const { wallet, license, agent } = state;
  const connected  = !!wallet?.address;
  const authorized = !!license && license.expiresAt > Date.now();
  const running    = !!agent?.running;

  hud.dataset.running = String(running);
  hud.dataset.connected = String(connected);
  if (hudStart) {
    hudStart.textContent = running ? 'Ⅱ Pause' : '▶ Start';
    hudStart.disabled = !authorized;
  }
  if (hudSetup) {
    hudSetup.hidden = authorized;
    hudConnect.hidden = connected;
    hudAuthorize.hidden = !connected || authorized;
  }
  for (const card of hudModeCards || []) {
    card.classList.toggle('is-selected', card.dataset.policy === agent?.policy);
  }

  if (!connected) {
    hudState.textContent = 'wallet · connect';
    hudTitle.textContent = 'Connect Phantom to start';
  } else if (!authorized) {
    hudState.textContent = 'wallet · needs pass';
    hudTitle.textContent = `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)} · wake KINSY`;
  } else {
    hudState.textContent = running ? 'farming · live' : 'companion · ready';
    hudTitle.textContent = `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`;
  }

  hudLoop.textContent = agent?.loop || 'idle';
  const snap = agent?.snapshot;
  if (snap) {
    hudGold.textContent = `${snap.gold ?? 0}`;
    renderHudResources(snap.resources);
  } else {
    hudGold.textContent = `+${(agent?.gold || 0).toLocaleString()}`;
    renderHudResources();
  }
  hudFeed.innerHTML = '';
  for (const event of visibleFeed(agent?.feed || [])) {
    const li = document.createElement('li');
    li.innerHTML = `<time>${fmtTime(event.ts)}</time><span></span>`;
    li.querySelector('span').textContent = event.msg;
    hudFeed.append(li);
  }
}

function pullAndRender() {
  chrome.runtime.sendMessage({ type: 'STATE_GET' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res?.state) renderHud(res.state);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATE_CHANGED') {
    const pid = msg.state?.agent?.snapshot?.pid;
    if (pid) latestPlayerId = pid;
    renderHud(msg.state);
  }
});

mountHud();
pullAndRender();

} // end __KINSAI_CS__ guard
