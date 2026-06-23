// KINSY — WebSocket bridge (MAIN world).
//
// Runs at document_start so it can wrap window.WebSocket before the Kintara
// game client constructs its connection. Once installed:
//
//   - every WebSocket the page opens to kintara.com is observed
//   - inbound frames are JSON.parsed and posted to the content script
//   - outbound frames sent by the game client are also observed
//   - the content script can ask us to inject outbound frames on a
//     specific connection
//
// We never replace the page's WebSocket — we wrap it. The game still
// controls its own connection. We just listen and, when commanded,
// piggy-back.

(() => {
  const HOOK_VERSION = '2026-06-23-tool-select-v4';
  window.__KINTARA_E2E__ = true;

  if (window.__KINSAI_WS_HOOKED__ === HOOK_VERSION) return;
  window.__KINSAI_WS_HOOKED__ = HOOK_VERSION;

  const NS = 'kinsai';
  const Native = window.__KINSAI_NATIVE_WS__ || window.WebSocket;
  window.__KINSAI_NATIVE_WS__ = Native;

  let nextId = 1;
  const sockets = new Map(); // id -> WebSocket
  const posOverrides = new Map(); // id -> { payload, expiresAt }
  let visualPos = null; // { playerId, payload, expiresAt }

  function postOut(payload) {
    window.postMessage({ src: NS, ch: 'ws', dir: 'bridge>cs', ...payload }, '*');
  }

  function classify(url) {
    try {
      const u = new URL(url, location.href);
      if (!isKintaraHost(u.hostname)) return null;
      const path = u.pathname.toLowerCase();
      const channel = path.includes('queue') ? 'queue' : 'presence';
      const shard = Number(path.match(/(?:^|\/)s(\d+)(?:\/|$)/)?.[1] || 0);
      return { channel, shard, url };
    } catch { return null; }
  }

  function isKintaraHost(hostname) {
    return hostname === 'kintara.com' ||
      hostname.endsWith('.kintara.com') ||
      hostname === 'kintara.gg' ||
      hostname.endsWith('.kintara.gg');
  }

  function tryParse(data) {
    if (typeof data !== 'string') return null;
    try { return JSON.parse(data); } catch { return null; }
  }

  function withPosOverride(id, json) {
    if (!json || json.t !== 'pos') return json;
    const slot = posOverrides.get(id);
    if (!slot) return json;
    if (slot.expiresAt <= Date.now()) {
      posOverrides.delete(id);
      return json;
    }
    return { ...json, ...slot.payload, t: 'pos' };
  }

  function dispatchPointerLike(target, type, x, y, extra = {}) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      button: 0,
      buttons: type === 'pointerup' || type === 'mouseup' || type === 'click' ? 0 : 1,
      ...extra,
    };
    let ev;
    if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
      ev = new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true });
    } else {
      ev = new MouseEvent(type, base);
    }
    target.dispatchEvent(ev);
  }

  function clickTile(payload) {
    const c = Number(payload?.c);
    const r = Number(payload?.r);
    if (!Number.isFinite(c) || !Number.isFinite(r)) throw new Error('bad tile');
    const helper = window.__kintaraTest;
    if (!helper || typeof helper.tileToScreen !== 'function') {
      throw new Error('kintara click hook unavailable; reload the Kintara tab');
    }
    const pt = helper.tileToScreen(c, r);
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new Error('tile projection failed');
    const baseX = Math.round(pt.x);
    const baseY = Math.round(pt.y);
    const kind = String(payload?.kind || '');
    const points = kind === 'tree'
      ? [[0, -72], [0, -58], [0, -44], [-10, -50], [10, -50]]
      : kind === 'rock'
        ? [[0, -28], [0, -18], [-8, -22], [8, -22], [0, -10]]
        : [[0, -12]];
    let last = null;
    for (const [dx, dy] of points) {
      const x = baseX + dx;
      const y = baseY + dy;
      const target = document.elementFromPoint(x, y) || document.querySelector('canvas') || document.body;
      if (!target) continue;
      dispatchPointerLike(target, 'pointerdown', x, y);
      dispatchPointerLike(target, 'mousedown', x, y);
      dispatchPointerLike(target, 'pointerup', x, y);
      dispatchPointerLike(target, 'mouseup', x, y);
      dispatchPointerLike(target, 'click', x, y);
      last = { x, y, dx, dy };
    }
    if (!last) throw new Error('no click target');
    return { ...last, c, r, clicks: points.length };
  }

  function dispatchKeyboardLike(target, type, key, code, keyCode) {
    const ev = new KeyboardEvent(type, {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    target.dispatchEvent(ev);
  }

  function selectHotbar(payload) {
    const slot = Number(payload?.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error('bad hotbar slot');
    const keyNum = slot + 1;
    const key = String(keyNum);
    const code = `Digit${keyNum}`;
    const keyCode = 48 + keyNum;
    const canvas = document.querySelector('canvas');
    if (canvas) {
      canvas.setAttribute('tabindex', canvas.getAttribute('tabindex') || '0');
      canvas.focus?.();
    } else {
      document.body?.focus?.();
    }
    const targets = [
      document.activeElement,
      canvas,
      document.body,
      document,
      window,
    ].filter(Boolean);
    for (const target of targets) {
      dispatchKeyboardLike(target, 'keydown', key, code, keyCode);
      dispatchKeyboardLike(target, 'keypress', key, code, keyCode);
      dispatchKeyboardLike(target, 'keyup', key, code, keyCode);
    }
    return { slot, key };
  }

  function playerMatches(player, playerId) {
    if (!player || playerId == null) return false;
    return player.id === playerId || String(player.id) === String(playerId);
  }

  function withVisualPos(json) {
    if (!json || json.t !== 'snap' || !visualPos) return json;
    if (visualPos.expiresAt <= Date.now()) {
      visualPos = null;
      return json;
    }
    if (!Array.isArray(json.players)) return json;

    let changed = false;
    const { playerId, payload } = visualPos;
    const players = json.players.map((player) => {
      if (!playerMatches(player, playerId)) return player;
      changed = true;
      return {
        ...player,
        x: payload.x ?? player.x,
        z: payload.z ?? player.z,
        ry: payload.ry ?? player.ry,
        mov: payload.mov ?? player.mov,
        act: payload.act ?? player.act,
        eq: payload.eq ?? player.eq,
      };
    });

    return changed ? { ...json, players } : json;
  }

  function eventWithData(ev, data) {
    if (data === ev.data) return ev;
    return new MessageEvent('message', {
      data,
      origin: ev.origin,
      lastEventId: ev.lastEventId,
      source: ev.source,
      ports: ev.ports,
    });
  }

  function wrap(ws, kind, id) {
    sockets.set(id, ws);

    const nativeAddEventListener = ws.addEventListener.bind(ws);
    const nativeRemoveEventListener = ws.removeEventListener.bind(ws);
    const listenerMap = new WeakMap();
    let wrappedOnMessage = null;
    let rawOnMessage = null;

    function transformMessageEvent(ev) {
      const json = tryParse(ev.data);
      const transformed = withVisualPos(json);
      if (transformed === json) return ev;
      return eventWithData(ev, JSON.stringify(transformed));
    }

    function wrapMessageListener(listener) {
      if (!listener || (typeof listener !== 'function' && typeof listener.handleEvent !== 'function')) return listener;
      const existing = listenerMap.get(listener);
      if (existing) return existing;
      const wrapped = function onKinsaiMessage(ev) {
        const nextEv = transformMessageEvent(ev);
        if (typeof listener === 'function') return listener.call(this, nextEv);
        return listener.handleEvent.call(listener, nextEv);
      };
      listenerMap.set(listener, wrapped);
      return wrapped;
    }

    ws.addEventListener = (type, listener, options) => {
      const nextListener = type === 'message' ? wrapMessageListener(listener) : listener;
      return nativeAddEventListener(type, nextListener, options);
    };
    ws.removeEventListener = (type, listener, options) => {
      const nextListener = type === 'message' ? (listenerMap.get(listener) || listener) : listener;
      return nativeRemoveEventListener(type, nextListener, options);
    };
    try {
      Object.defineProperty(ws, 'onmessage', {
        configurable: true,
        enumerable: true,
        get() { return rawOnMessage; },
        set(listener) {
          if (wrappedOnMessage) nativeRemoveEventListener('message', wrappedOnMessage);
          rawOnMessage = listener;
          wrappedOnMessage = wrapMessageListener(listener);
          if (wrappedOnMessage) nativeAddEventListener('message', wrappedOnMessage);
        },
      });
    } catch {
      // Some browser implementations may not allow per-instance onmessage
      // descriptors. addEventListener wrapping still covers the common path.
    }

    // Inbound frames: tap "message" listeners. Use addEventListener so we
    // don't fight with the game client which may use onmessage=.
    nativeAddEventListener('message', (ev) => {
      const json = tryParse(ev.data);
      if (json && json.t) {
        postOut({ event: 'recv', id, kind, t: json.t, data: json });
      } else {
        postOut({ event: 'recv', id, kind, t: '?', dataRaw: typeof ev.data === 'string' ? ev.data.slice(0, 200) : `[${typeof ev.data}]` });
      }
    });

    nativeAddEventListener('close', (ev) => {
      sockets.delete(id);
      posOverrides.delete(id);
      postOut({ event: 'close', id, kind, code: ev.code, reason: ev.reason });
    });

    nativeAddEventListener('error', () => {
      postOut({ event: 'error', id, kind });
    });

    // Outbound frames: monkeypatch send().
    const origSend = ws.send.bind(ws);
    ws.send = (data) => {
      const json = tryParse(data);
      if (json && json.t) {
        const outbound = withPosOverride(id, json);
        postOut({ event: 'send', id, kind, t: outbound.t, data: outbound });
        if (outbound !== json) return origSend(JSON.stringify(outbound));
      }
      return origSend(data);
    };

    postOut({ event: 'open', id, kind });
  }

  function Patched(url, protocols) {
    const ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
    const meta = classify(url);
    if (meta) {
      const id = nextId++;
      wrap(ws, meta, id);
    }
    return ws;
  }

  // Preserve constants + prototype so instanceof and CONNECTING/OPEN/... work.
  Patched.prototype = Native.prototype;
  Patched.CONNECTING = Native.CONNECTING;
  Patched.OPEN       = Native.OPEN;
  Patched.CLOSING    = Native.CLOSING;
  Patched.CLOSED     = Native.CLOSED;
  Object.defineProperty(Patched, 'name', { value: 'WebSocket' });

  window.WebSocket = Patched;

  // Inbound from the content script: inject outgoing frames.
  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || m.src !== NS || m.dir !== 'cs>bridge') return;
    if (m.ch === 'action') {
      try {
        if (m.payload?.op === 'click_tile') {
          const data = clickTile(m.payload);
          postAction({ reqId: m.reqId, ok: true, data });
        } else if (m.payload?.op === 'select_hotbar') {
          const data = selectHotbar(m.payload);
          postAction({ reqId: m.reqId, ok: true, data });
        } else {
          throw new Error(`unknown action ${m.payload?.op || '?'}`);
        }
      } catch (err) {
        postAction({ reqId: m.reqId, ok: false, error: err?.message || String(err) });
      }
      return;
    }
    if (m.ch !== 'ws') return;
    if (m.op === 'drive_pos' && m.payload?.t === 'pos') {
      visualPos = {
        playerId: m.playerId,
        payload: m.payload,
        expiresAt: Date.now() + 1800,
      };
      return;
    }
    if (m.op === 'send' && m.id != null && m.payload) {
      const ws = sockets.get(m.id);
      if (!ws || ws.readyState !== Native.OPEN) {
        postOut({ event: 'inject_err', id: m.id, reqId: m.reqId, error: 'socket not open' });
        return;
      }
      try {
        if (typeof m.payload !== 'string' && m.payload?.t === 'pos') {
          posOverrides.set(m.id, {
            payload: m.payload,
            expiresAt: Date.now() + 1200,
          });
        }
        const data = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
        ws.send(data);                           // calls our patched send → logs the inject
        postOut({ event: 'inject_ok', id: m.id, reqId: m.reqId });
      } catch (err) {
        postOut({ event: 'inject_err', id: m.id, reqId: m.reqId, error: err?.message || String(err) });
      }
    } else if (m.op === 'list') {
      const list = [];
      for (const [id, ws] of sockets) {
        list.push({ id, kind: classify(ws.url), readyState: ws.readyState });
      }
      postOut({ event: 'list', reqId: m.reqId, list });
    }
  });

  console.log('[kinsai/ws] hook installed');

  function postAction(payload) {
    window.postMessage({ src: NS, ch: 'action', dir: 'bridge>cs', ...payload }, '*');
  }
})();
