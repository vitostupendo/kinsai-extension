// KINSY — Kintara HTTP client.
//
// The Kintara session cookie is set on the game origin. The MV3
// service worker runs on chrome-extension://, so its own fetches don't carry
// that cookie. Instead we proxy every Kintara call through the content
// script (which runs in the Kintara origin, so credentials flow naturally).

const KINTARA_HOST = 'kintara.com';
const FANOUT_HOST  = 'fanout.kintara.com';
const KINTARA_MATCH = /^https:\/\/(?:[^/]+\.)?kintara\.(?:com|gg)/;
const KINTARA_TAB_URLS = [
  'https://kintara.com/*',
  'https://*.kintara.com/*',
  'https://kintara.gg/*',
  'https://*.kintara.gg/*',
];
const TOOL_BY_ID = {
  tool_axe: {
    label: 'axe',
    matcher: (t) => t.includes('axe'),
  },
  tool_pickaxe: {
    label: 'pickaxe',
    matcher: (t) => t.includes('pickaxe'),
  },
  tool_fishing_rod: {
    label: 'fishing rod',
    matcher: (t) => t.includes('fish') || t.includes('rod'),
  },
};

export class KintaraClient {
  constructor() {
    this._tabIdHint = null;
  }

  async _findTab() {
    if (this._tabIdHint != null) {
      try {
        const tab = await chrome.tabs.get(this._tabIdHint);
        if (tab && KINTARA_MATCH.test(tab.url || '')) return this._normalizeTab(tab);
      } catch { /* tab closed */ }
      this._tabIdHint = null;
    }
    // URL-filtered query: relies on host_permissions, not `tabs` permission.
    const tabs = await chrome.tabs.query({
      url: KINTARA_TAB_URLS,
    });
    const t = tabs.find((x) => isCanonicalKintaraUrl(x.url) && x.active) ||
      tabs.find((x) => isCanonicalKintaraUrl(x.url)) ||
      tabs.find((x) => x.active) ||
      tabs[0] ||
      null;
    if (t) this._tabIdHint = t.id;
    return t ? this._normalizeTab(t) : null;
  }

  async _normalizeTab(tab) {
    if (!tab || !isLegacyKintaraUrl(tab.url)) return tab;
    const url = canonicalKintaraUrl(tab.url);
    const next = await chrome.tabs.update(tab.id, { url });
    await waitForComplete(tab.id, 20_000).catch(() => {});
    return next || { ...tab, url };
  }

  async _ensureTab(openIfMissing = false) {
    let tab = await this._findTab();
    if (tab) return tab;
    if (!openIfMissing) throw new Error('no kintara.com tab open');
    tab = await chrome.tabs.create({ url: 'https://kintara.com/', active: false });
    this._tabIdHint = tab.id;
    await waitForComplete(tab.id, 20_000);
    return tab;
  }

  async _call(payload) {
    const tab = await this._ensureTab(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._sendOnce(tab.id, { type: 'KINTARA_FETCH', payload });
      } catch (err) {
        if (this._isOrphan(err) && attempt === 0) {
          await this._reinject(tab.id);
          continue;
        }
        throw err;
      }
    }
  }

  _sendOnce(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!res) return reject(new Error('no response from content script'));
        if (!res.ok) return reject(new Error(res.error || 'fetch failed'));
        resolve(res.data);
      });
    });
  }

  _isOrphan(err) {
    const msg = String(err?.message || '');
    return msg.includes('Receiving end does not exist') ||
           msg.includes('Could not establish connection');
  }

  async _reinject(tabId) {
    console.log('[kinsai/cl] content script orphaned — re-injecting');
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/ws-bridge.js', 'content/phantom-bridge.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css'],
    });
  }

  async reloadGameTab() {
    const tab = await this._ensureTab(false);
    await chrome.tabs.reload(tab.id, { bypassCache: true });
    await waitForComplete(tab.id, 20_000);
    this._tabIdHint = tab.id;
  }

  // --- Auth & player state -----------------------------------------------

  challenge()         { return this._call({ host: KINTARA_HOST, path: '/api/auth/challenge' }); }
  verify(body)        { return this._call({ host: KINTARA_HOST, path: '/api/auth/verify', method: 'POST', body }); }
  me()                { return this._call({ host: KINTARA_HOST, path: '/api/auth/me' }); }
  dashboard()         { return this._call({ host: KINTARA_HOST, path: '/api/auth/dashboard-summary' }); }
  tokenBalance()      { return this._call({ host: KINTARA_HOST, path: '/api/auth/game-token-balance' }); }
  viewerLevel()       { return this._call({ host: KINTARA_HOST, path: '/api/auth/viewer-level' }); }
  gateCheck(shard)    { return this._call({ host: KINTARA_HOST, path: `/api/auth/gate-check?shard=${shard}` }); }
  clubStatus()        { return this._call({ host: KINTARA_HOST, path: '/api/club/status' }); }

  // --- World (lobby / fan-out) ------------------------------------------

  servers()           { return this._call({ host: FANOUT_HOST,  path: '/api/servers' }); }
  siteStats()         { return this._call({ host: FANOUT_HOST,  path: '/api/site/stats' }); }
  blimpStats()        { return this._call({ host: FANOUT_HOST,  path: '/api/token/blimp-stats' }); }
  expansionTribute()  { return this._call({ host: FANOUT_HOST,  path: '/api/world/expansion-tribute' }); }
  merchantCampaign()  { return this._call({ host: FANOUT_HOST,  path: '/api/world/merchant-campaign' }); }

  chatBootstrap(region, shard)   { return this._call({ host: FANOUT_HOST, path: `/api/world/chat/bootstrap?region=${region}&shard=${shard}` }); }
  chatSince(region, shard, after){ return this._call({ host: FANOUT_HOST, path: `/api/world/chat?after=${after}&region=${region}&shard=${shard}` }); }

  // --- Player mutations --------------------------------------------------

  saveSpawn(realm, col, row) {
    return this._call({ host: KINTARA_HOST, path: '/api/auth/save-spawn', method: 'POST', body: { realm, col, row } });
  }
  saveHp(hp, wildShield = 0, le = 1) {
    return this._call({ host: KINTARA_HOST, path: '/api/auth/save-hp', method: 'POST', body: { hp, wildShield, le } });
  }
  grantTool(type) {
    return this._call({ host: KINTARA_HOST, path: '/api/auth/grant-tool', method: 'POST', body: { type } });
  }
  dailyQuestProgress() {
    return this._call({ host: KINTARA_HOST, path: '/api/auth/daily-quest-progress', method: 'POST', body: {} });
  }
  merchantContribute(deltas) {
    return this._call({ host: KINTARA_HOST, path: '/api/world/merchant-campaign/contribute', method: 'POST', body: deltas });
  }

  // --- WebSocket bridge --------------------------------------------------

  async wsDrain(since = 0) {
    const tab = await this._ensureTab(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._sendOnce(tab.id, { type: 'WS_DRAIN', since });
      } catch (err) {
        if (this._isOrphan(err) && attempt === 0) {
          await this._reinject(tab.id);
          continue;
        }
        throw err;
      }
    }
  }

  async wsSend(socketId, payload) {
    const tab = await this._ensureTab(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this._sendOnce(tab.id, { type: 'WS_SEND', socketId, payload });
        return;
      } catch (err) {
        if (this._isOrphan(err) && attempt === 0) {
          await this._reinject(tab.id);
          continue;
        }
        throw err;
      }
    }
  }

  async pageAction(payload) {
    const tab = await this._ensureTab(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this._sendOnce(tab.id, { type: 'KINTARA_ACTION', payload });
      } catch (err) {
        if (this._isOrphan(err) && attempt === 0) {
          await this._reinject(tab.id);
          continue;
        }
        if (String(err?.message || '').includes('unknown action') && attempt === 0) {
          await this._reinject(tab.id);
          continue;
        }
        if (String(err?.message || '').includes('click hook unavailable') && attempt === 0) {
          await this.reloadGameTab();
          continue;
        }
        throw err;
      }
    }
  }

  async selectTool(tool) {
    const req = TOOL_BY_ID[tool];
    if (!req) throw new Error(`unknown tool: ${tool}`);

    const res = await this.me();
    const json = res?.json || res;
    const backpack = json?.backpack || {};
    const hotbar = Array.isArray(backpack.hotbar) ? backpack.hotbar : [];
    const slot = hotbar.findIndex((item) => req.matcher(String(item?.t || '')));
    if (slot < 0) throw new Error(`tool missing · equip a ${req.label}`);

    const data = await this.pageAction({ op: 'select_hotbar', slot, tool });
    return { ...data, slot, label: req.label };
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('tab load timeout'));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isCanonicalKintaraUrl(url = '') {
  try {
    const { hostname } = new URL(url);
    return hostname === 'kintara.com' || hostname.endsWith('.kintara.com');
  } catch {
    return false;
  }
}

function isLegacyKintaraUrl(url = '') {
  try {
    const { hostname } = new URL(url);
    return hostname === 'kintara.gg' || hostname.endsWith('.kintara.gg');
  } catch {
    return false;
  }
}

function canonicalKintaraUrl(url = '') {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.replace(/kintara\.gg$/i, 'kintara.com');
    u.protocol = 'https:';
    return u.toString();
  } catch {
    return 'https://kintara.com/';
  }
}
