// KINSY — background service worker (MV3).
//
// Thin-client architecture: this worker no longer plans gameplay.
// All gameplay logic lives in the kinsai-api backend. This file:
//   - manages Phantom wallet connect through the content script bridge
//   - performs the license sign-in (Solana challenge + signed verify against
//     api.kinsai.xyz) to acquire a short-lived JWT
//   - opens the agent WS to the backend, forwards observed kintara frames,
//     and executes inject commands sent down
//   - keeps an HTTP read of /auth/me running so the popup + HUD show live
//     gold / hp / $KINS / position

import { adapter, kintara as kintaraAdapter } from './adapter.js';
import { Uplink, fetchChallenge, submitVerify } from './uplink.js';

const STORAGE_KEY  = 'kinsai.state';
const KINTARA_URL  = 'https://kintara.com/';
const KINTARA_MATCH = /^https:\/\/(?:[^/]+\.)?kintara\.(?:com|gg)/;
const KINTARA_TAB_URLS = [
  'https://kintara.com/*',
  'https://*.kintara.com/*',
  'https://kintara.gg/*',
  'https://*.kintara.gg/*',
];
const TOOL_BY_POLICY = {
  harvest:       { label: 'axe', matcher: (t) => t.includes('axe') },
  harvest_wood:  { label: 'axe', matcher: (t) => t.includes('axe') },
  harvest_stone: { label: 'pickaxe', matcher: (t) => t.includes('pickaxe') },
  harvest_fish:  { label: 'fishing rod', matcher: (t) => t.includes('fish') || t.includes('rod') },
};

const INITIAL = {
  wallet:  null,                  // { address, connectedAt }
  license: null,                  // { jwt, expiresAt, balance, minHold }
  agent: {
    running: false,
    policy:  'observe',
    loop:    'idle',
    gold:    0,
    kins:    0.0,
    kinsBalance: null,
    holderBalance: null,
    feed:    [],
    snapshot: null,
    gate:     null,                // last { ok, balance, minHold } from backend
  },
};

const uplink = new Uplink({
  kintaraClient: kintaraAdapter.client,
  onFeed:  (msg)  => pushFeed(`[backend] ${msg}`),
  onGate:  (g)    => onGateUpdate(g),
  onInjectResult: (r) => {
    if (!r.ok) pushFeed(`[backend] inject failed · ${r.error || 'unknown'}`);
  },
});

let lastRealmRouteAt = 0;

// ---- state helpers ------------------------------------------------------

async function loadState() {
  const out = await chrome.storage.local.get(STORAGE_KEY);
  return { ...INITIAL, ...(out[STORAGE_KEY] || {}) };
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  broadcast(state);
  return state;
}

async function patch(mut) {
  const cur = await loadState();
  const next = await mut({ ...cur });
  return saveState(next);
}

function broadcast(state) {
  safeRuntimeMessage({ type: 'STATE_CHANGED', state });
  chrome.tabs.query({ url: KINTARA_TAB_URLS }, (tabs) => {
    for (const tab of tabs) safeTabMessage(tab.id, { type: 'STATE_CHANGED', state });
  });
}

function safeRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // No listener is fine; this is a best-effort state broadcast.
  }
}

function safeTabMessage(tabId, message) {
  if (!tabId) return;
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Tabs can close or be missing the content script during extension reloads.
  }
}

function pushFeed(msg) {
  patch(async (s) => {
    s.agent.feed.push({ ts: Date.now(), msg });
    if (s.agent.feed.length > 80) s.agent.feed = s.agent.feed.slice(-80);
    return s;
  });
}

async function refreshKinsBalance() {
  const balance = await fetchCurrentKinsBalance();
  if (balance == null) return null;
  await patch(async (s) => {
    s.agent.kinsBalance = balance;
    if (s.agent.snapshot) s.agent.snapshot = { ...s.agent.snapshot, kins: balance };
    return s;
  });
  return balance;
}

async function fetchCurrentKinsBalance() {
  try {
    const bal = await kintaraAdapter.client.tokenBalance();
    return readUiAmount(bal?.json);
  } catch (err) {
    console.warn('[kinsai/bg] token balance refresh failed', err);
    return null;
  }
}

async function onGateUpdate(g) {
  await patch(async (s) => {
    const balance = finiteNumber(g.balance);
    const minHold = finiteNumber(g.minHold);
    s.agent.gate = { ok: !!g.ok, balance: balance ?? g.balance, minHold: minHold ?? g.minHold };
    if (balance != null) {
      if (s.license) s.license.balance = balance;
    }
    if (minHold != null && s.license) s.license.minHold = minHold;
    if (!g.ok && s.agent.policy !== 'observe') {
      s.agent.policy = 'observe';
      s.agent.feed.push({ ts: Date.now(), msg: `gate · below threshold (${g.balance?.toLocaleString?.() ?? '?'} / ${g.minHold?.toLocaleString?.() ?? '?'}) — paused` });
    }
    return s;
  });
  uplink.setPolicy((await loadState()).agent.policy);
}

// ---- kintara tab + bridge (Phantom only) --------------------------------

async function findKintaraTab() {
  // URL-filtered query is the reliable form: relies only on host_permissions,
  // not the `tabs` permission. Order: active tab in current window first, then
  // active in any window, then any matching tab.
  const tabs = await chrome.tabs.query({
    url: KINTARA_TAB_URLS,
  });
  if (!tabs.length) return null;
  const win = await getLastFocusedWindow();
  const inFocused = tabs.find((t) => win && t.windowId === win.id && t.active);
  if (inFocused) return inFocused;
  const anyActive = tabs.find((t) => t.active);
  if (anyActive) return anyActive;
  return tabs[0];
}

function getLastFocusedWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getLastFocused((win) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(win || null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function ensureKintaraTab() {
  const live = await findKintaraTab();
  if (live) {
    console.log('[kinsai/bg] reusing kintara tab', { id: live.id, url: live.url });
    await chrome.tabs.update(live.id, { active: true });
    await chrome.windows.update(live.windowId, { focused: true });
    return live;
  }
  console.log('[kinsai/bg] no kintara tab found — opening new one');
  return chrome.tabs.create({ url: KINTARA_URL, active: true });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('tab load timeout'));
    }, timeoutMs);
    const onUpdate = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdate);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

async function callBridge(op, payload = {}) {
  const tab = await ensureKintaraTab();
  if (!tab.status || tab.status !== 'complete') await waitForTabComplete(tab.id, 20_000);

  // Try once. If the content script isn't on the tab (typically because the
  // extension was reloaded while kintara.com was already open), inject it
  // on demand and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await sendBridgeMessage(tab.id, op, payload);
    } catch (err) {
      const msg = String(err?.message || '');
      const orphan = msg.includes('Receiving end does not exist') || msg.includes('Could not establish connection');
      if (!orphan || attempt === 1) throw err;
      console.log('[kinsai/bg] content script orphaned — re-injecting');
      await injectContentScripts(tab.id);
    }
  }
}

function sendBridgeMessage(tabId, op, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'BRIDGE_CALL', op, payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || 'bridge call failed'));
      resolve(res.data);
    });
  });
}

export async function injectContentScripts(tabId) {
  // MAIN world bridges first so they're installed before any later page
  // scripts try to use WebSocket / window.solana.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/ws-bridge.js', 'content/phantom-bridge.js'],
    world: 'MAIN',
  });
  // ISOLATED world content script + its CSS.
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js'],
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content/content.css'],
  });
  console.log('[kinsai/bg] content scripts re-injected', { tabId });
}

// ---- agent loop (HTTP state read + uplink lifecycle) -------------------

const ALARM = 'kinsai.tick';

async function startAgent() {
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.1 }); // ~6s
  await patch(async (s) => {
    s.agent.running = true;
    s.agent.feed.push({ ts: Date.now(), msg: 'KINSY started farming' });
    return s;
  });
  // Open uplink if we have a license.
  const cur = await loadState();
  if (cur.license?.jwt) {
    const policy = cur.agent.policy === 'observe' ? 'harvest_wood' : cur.agent.policy;
    if (policy !== cur.agent.policy) {
      await patch(async (s) => {
        s.agent.policy = policy;
        s.agent.feed.push({ ts: Date.now(), msg: `mode → ${policy}` });
        return s;
      });
    }
    await ensureRealmForPolicy(policy).catch((err) => {
      pushFeed(`route check skipped · ${err?.message || err}`);
    });
    await ensureToolForPolicy(policy).catch((err) => {
      pushFeed(`tool check skipped · ${err?.message || err}`);
    });
    uplink.connect(cur.license.jwt);
    uplink.setPolicy(policy);
  } else {
    pushFeed('no pass · wake KINSY first');
  }
}

async function stopAgent() {
  await chrome.alarms.clear(ALARM);
  uplink.close('agent_stop');
  await patch(async (s) => {
    s.agent.running = false;
    s.agent.feed.push({ ts: Date.now(), msg: 'KINSY paused' });
    return s;
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const state = await loadState();
  if (!state.agent.running) return;

  // License expired → stop the uplink + flip back to observe.
  if (state.license && state.license.expiresAt <= Date.now()) {
    pushFeed('pass expired · wake KINSY again');
    uplink.close('license_expired');
    await patch(async (s) => { s.license = null; return s; });
  }

  // Adapter tick: HTTP read of /auth/me for popup state. No planner.
  try {
    const tick = await adapter.tick(state);
    if (tick) {
      await patch(async (s) => {
        if (tick.loop)     s.agent.loop = tick.loop;
        if (tick.gold)     s.agent.gold += tick.gold;
        if (tick.snapshot) {
          s.agent.snapshot = tick.snapshot;
          const kinsBalance = finiteNumber(tick.snapshot.kins);
          if (kinsBalance != null) s.agent.kinsBalance = kinsBalance;
        } else if (tick.kins) {
          s.agent.kins += tick.kins;
        }
        if (tick.msg)      s.agent.feed.push({ ts: Date.now(), msg: tick.msg });
        if (s.agent.feed.length > 80) s.agent.feed = s.agent.feed.slice(-80);
        return s;
      });
      if (tick.snapshot?.pid) uplink.setPlayerId(tick.snapshot.pid);
    }
  } catch (err) {
    console.error('[kinsai/bg] adapter tick', err);
  }
});

// ---- message router -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const out = await dispatch(msg);
      sendResponse(out);
    } catch (err) {
      console.error(`[kinsai/bg] dispatch ${msg?.type} failed`, err);
      pushFeed(`error · ${msg?.type}: ${err?.message || err}`);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

async function dispatch(msg) {
  switch (msg?.type) {
    case 'STATE_GET': {
      const state = await loadState();
      if (state.license?.expiresAt > Date.now() && state.agent?.kinsBalance == null) {
        refreshKinsBalance().catch(() => {});
      }
      return { ok: true, state };
    }

    case 'PHANTOM_CONNECT': {
      console.log('[kinsai/bg] PHANTOM_CONNECT begin');
      const tab = await ensureKintaraTab();
      console.log('[kinsai/bg] PHANTOM_CONNECT tab', { id: tab?.id, status: tab?.status, url: tab?.url });
      const result = await callBridge('CONNECT');
      console.log('[kinsai/bg] PHANTOM_CONNECT bridge result', result);
      const { publicKey } = result;
      if (!publicKey) throw new Error('phantom returned no publicKey');
      const state = await patch(async (s) => {
        s.wallet = { address: publicKey, connectedAt: Date.now() };
        s.agent.holderBalance = null;
        s.agent.feed.push({ ts: Date.now(), msg: `wallet connected · ${publicKey.slice(0, 4)}…${publicKey.slice(-4)}` });
        return s;
      });
      return { ok: true, state };
    }

    case 'WALLET_DISCONNECT': {
      try { await callBridge('DISCONNECT'); } catch { /* */ }
      uplink.close('wallet_disconnect');
      await stopAgent();
      const state = await patch(async (s) => {
        s.wallet = null;
        s.license = null;
        s.agent = { ...INITIAL.agent };
        s.agent.feed.push({ ts: Date.now(), msg: 'wallet disconnected' });
        return s;
      });
      return { ok: true, state };
    }

    case 'SESSION_AUTHORIZE': {
      // New flow: server-issued challenge + signed verify → JWT.
      const cur = await loadState();
      if (!cur.wallet?.address) throw new Error('wallet not connected');

      const challenge = await fetchChallenge(cur.wallet.address);
      const signed = await callBridge('SIGN_MESSAGE', { message: challenge.message });
      // signed.signature is base64 from the bridge — decode to byte array
      const sigBytes = Array.from(b64ToBytes(signed.signature));

      const verified = await submitVerify({
        publicKey:   cur.wallet.address,
        signature:   sigBytes,
        message:     challenge.message,
        challengeId: challenge.challengeId,
      });

      const balance = readUiAmount(verified.balance);
      const minHold = finiteNumber(verified.balance?.minHold);
      const currentKinsBalance = await fetchCurrentKinsBalance();
      const state = await patch(async (s) => {
        s.license = {
          jwt: verified.jwt,
          expiresAt: verified.expiresAt,
          balance: balance ?? verified.balance?.uiAmount ?? 0,
          minHold: minHold ?? verified.balance?.minHold ?? 0,
          mint:    verified.balance?.mint,
          decimals: verified.balance?.decimals,
        };
        s.agent.kinsBalance = currentKinsBalance;
        s.agent.holderBalance = null;
        s.agent.gate = { ok: true, balance: balance ?? verified.balance?.uiAmount ?? 0, minHold: minHold ?? verified.balance?.minHold ?? 0 };
        s.agent.feed = s.agent.feed.filter((event) => !isStaleSessionFeed(event?.msg));
        s.agent.feed.push({ ts: Date.now(), msg: `pass ready · ${Math.floor(balance ?? 0).toLocaleString()} $KINSY` });
        return s;
      });
      return { ok: true, state };
    }

    case 'SESSION_REVOKE': {
      uplink.close('session_revoke');
      await stopAgent();
      const state = await patch(async (s) => {
        s.license = null;
        s.agent.feed.push({ ts: Date.now(), msg: 'KINSY pass revoked' });
        return s;
      });
      return { ok: true, state };
    }

    case 'AGENT_TOGGLE': {
      const cur = await loadState();
      if (!cur.license || cur.license.expiresAt <= Date.now()) {
        throw new Error('no active license');
      }
      if (cur.agent.running) await stopAgent();
      else                   await startAgent();
      return { ok: true };
    }

    case 'AGENT_POLICY': {
      const next = String(msg.payload?.policy || 'observe');
      const allowed = new Set(['observe', 'harvest', 'harvest_wood', 'harvest_stone', 'harvest_fish']);
      if (!allowed.has(next)) throw new Error(`unknown policy: ${next}`);
      await ensureRealmForPolicy(next).catch((err) => {
        pushFeed(`route check skipped · ${err?.message || err}`);
      });
      await ensureToolForPolicy(next).catch((err) => {
        pushFeed(`tool check skipped · ${err?.message || err}`);
      });
      await patch(async (s) => {
        s.agent.policy = next;
        s.agent.feed.push({ ts: Date.now(), msg: `mode → ${next}` });
        return s;
      });
      uplink.setPolicy(next);
      return { ok: true };
    }

    case 'OPEN_TELEGRAM': {
      await chrome.tabs.create({ url: 'https://t.me/KINSBotSolana' });
      return { ok: true };
    }

    case 'OPEN_KINTARA': {
      await ensureKintaraTab();
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown type: ${msg?.type}` };
  }
}

async function ensureRealmForPolicy(policy) {
  const targetRealm = realmForPolicy(policy);
  if (!targetRealm) return;

  const res = await kintaraAdapter.client.me();
  const json = res?.json || res;
  const spawn = json?.meta?.spawn || {};
  if (spawn.realm === targetRealm) return;

  const now = Date.now();
  if (lastRealmRouteAt && now - lastRealmRouteAt < 20_000) return;
  lastRealmRouteAt = now;

  const point = spawnPointForRealm(targetRealm);
  pushFeed(`routing · ${targetRealm}`);
  await kintaraAdapter.client.saveSpawn(targetRealm, point.col, point.row);
  await kintaraAdapter.client.reloadGameTab();
}

function realmForPolicy(policy) {
  if (policy === 'harvest_wood' || policy === 'harvest_stone' || policy === 'harvest') return 'world';
  if (policy === 'harvest_fish') return 'pond';
  return null;
}

function spawnPointForRealm() {
  return { col: 18, row: 13 };
}

async function ensureToolForPolicy(policy) {
  const req = TOOL_BY_POLICY[policy];
  if (!req) return;
  const toolByPolicy = {
    harvest: 'tool_axe',
    harvest_wood: 'tool_axe',
    harvest_stone: 'tool_pickaxe',
    harvest_fish: 'tool_fishing_rod',
  };
  try {
    const selected = await kintaraAdapter.client.selectTool(toolByPolicy[policy]);
    pushFeed(`selected ${selected.label}`);
  } catch (err) {
    pushFeed(`tool missing · equip a ${req.label} for this mode`);
    console.warn('[kinsai/bg] hotbar select failed', err);
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function readUiAmount(balance = {}) {
  return finiteNumber(
    balance.uiAmount ??
    balance.uiAmountString ??
    balance.balance?.uiAmount ??
    balance.balance?.uiAmountString ??
    balance.balance ??
    balance.data?.balance?.uiAmount ??
    balance.data?.balance?.uiAmountString ??
    balance.data?.balance ??
    balance.data?.uiAmount ??
    balance.data?.uiAmountString ??
    balance.value?.uiAmount ??
    balance.value?.uiAmountString ??
    balance.tokenAmount?.uiAmount ??
    balance.tokenAmount?.uiAmountString ??
    balance.amount ??
    balance
  );
}

function isStaleSessionFeed(msg = '') {
  const lower = String(msg).toLowerCase();
  return lower.includes('session revoked') ||
    lower.includes('pass revoked') ||
    lower.includes('wallet disconnected') ||
    lower.includes('no pass');
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await loadState();
  await saveState(cur);
});
