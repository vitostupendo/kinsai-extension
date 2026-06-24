// KINSY — Kintara game adapter.
//
// Two implementations live here:
//   - simulated  — pure local feed generator, useful for demoing the UI
//                  without a live kintara.com tab.
//   - kintara    — real HTTP client driving the endpoints captured in
//                  extension/docs/kintara-api.md.
//
// Contract: adapter.tick(state) -> Promise<TickResult | null>
//   TickResult = { loop?, gold?, kins?, msg?, snapshot? }

import { KintaraClient } from './kintara-client.js';

// ============================================================
// Simulated adapter — used when no kintara.com tab is reachable
// ============================================================

const LOOPS  = ['daily-route', 'gathering', 'cooking', 'banking', 'marketplace-flip'];
const FLAVOR = [
  'banked oak logs before market run',
  'Pond objective nearly complete',
  'rerouted past crowded south spawn',
  'spinner-wheel timing 22s — passing',
  'rare drop · Whisperwood antler',
  'flip filled · 142g → 1.6 $KINS',
  'daily quest streak +1',
  'rebalanced inventory · 4 slots free',
];

let simTick = 0;
const simulated = {
  name: 'simulated',
  async tick() {
    simTick += 1;
    const loop = (simTick % 6 === 1) ? LOOPS[Math.floor(Math.random() * LOOPS.length)] : undefined;
    const r = Math.random();
    if (r < 0.20) return { loop, msg: 'idle · scanning' };
    if (r < 0.85) {
      const gold = 40 + Math.floor(Math.random() * 220);
      return { loop, gold, msg: `+${gold} gold · ${FLAVOR[Math.floor(Math.random() * FLAVOR.length)]}` };
    }
    const kins = +(0.5 + Math.random() * 3).toFixed(1);
    return { loop: 'marketplace-flip', kins, msg: `flip filled · +${kins} $KINS` };
  },
};

// ============================================================
// Real Kintara adapter
// ============================================================
//
// One tick:
//   1) Read `/auth/me` and compare to the prior snapshot.
//      Surface deltas for gold, hp, position, inventory.
//   2) If we haven't fetched the $KINS balance recently, refresh it.
//   3) Poll `/api/world/chat?after=<lastId>` and surface notable lines.
//   4) Optionally trigger a campaign donation when the local agent
//      policy says so (gated by config; default off).
//
// The HTTP layer is server-validated. We never invent gold — we just
// observe and surface what Kintara reports. Actual gameplay (moving,
// chopping, fighting) still flows through the WebSocket frames that
// the game client owns; this adapter rides next to that, not over it.

const client = new KintaraClient();

const CHAT = { region: 'world', shard: 21 };
const KEEP_TICKS_BETWEEN_BALANCE = 6; // refresh $KINS every ~36s
const CHAT_AUTHOR_MUTE = new Set([]); // populate if we want to filter spam

let lastSnap = null;        // last `/auth/me` payload digest
let lastBalance = null;     // last $KINS uiAmount
let ticksSinceBalance = 99;
let lastChatId = 0;
let chatBootstrapped = false;
let lastWsDrainAt = 0;      // last ts we read WS events from the content script
let selfPlayerId = null;    // discovered from /auth/me or WS frames
let liveResources = null;   // optimistic but server-accepted resource view from res_evt wear

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function readTokenBalance(body = {}) {
  return finiteNumber(
    body.uiAmount ??
    body.uiAmountString ??
    body.balance?.uiAmount ??
    body.balance?.uiAmountString ??
    body.balance ??
    body.data?.balance?.uiAmount ??
    body.data?.balance?.uiAmountString ??
    body.data?.balance ??
    body.data?.uiAmount ??
    body.data?.uiAmountString ??
    body.value?.uiAmount ??
    body.value?.uiAmountString ??
    body.tokenAmount?.uiAmount ??
    body.tokenAmount?.uiAmountString ??
    body.amount ??
    body
  );
}

function shortLoopFromMeta(meta) {
  if (!meta) return 'idle';
  const realm = meta.spawn?.realm || 'unknown';
  if (meta.wildShield > 0)      return 'wilderness';
  if (realm === 'bankShop')     return 'banking';
  if (realm === 'world')        return 'gathering';
  return realm;
}

function backpackHash(bp) {
  if (!bp) return '';
  return `${bp.wood}|${bp.stone}|${bp.coal}|${bp.metal}|${bp.gold}|${bp.fish}|${bp.cooked_fish_meat}`;
}

function backpackResources(bp = {}) {
  return {
    wood: bp.wood ?? 0,
    stone: bp.stone ?? 0,
    coal: bp.coal ?? 0,
    metal: bp.metal ?? 0,
    fish: bp.fish ?? 0,
    cookedFish: bp.cooked_fish_meat ?? 0,
    gold: bp.gold ?? 0,
  };
}

function resourceDeltas(prev = {}, next = {}) {
  const labels = {
    wood: '🪵 wood',
    stone: '🪨 stone',
    coal: '⚫ coal',
    metal: '⛓ metal',
    fish: '🎣 fish',
    cookedFish: '🍲 cooked fish',
  };
  const out = [];
  for (const [key, label] of Object.entries(labels)) {
    const delta = Number(next[key] || 0) - Number(prev[key] || 0);
    if (delta > 0) out.push(`+${delta} ${label}`);
  }
  return out;
}

function resourceLabel(kind) {
  const labels = {
    tree: '🪵 wood',
    wood: '🪵 wood',
    rock: '🪨 stone',
    stone: '🪨 stone',
    coal: '⚫ coal',
    metal: '⛓ metal',
    gold: '🪙 gold',
    fish: '🎣 fish',
    cooked_fish_meat: '🍲 cooked fish',
  };
  return labels[kind] || kind;
}

function normalizeLootResource(kind) {
  if (kind === 'wood' || kind === 'stone' || kind === 'coal' || kind === 'metal' || kind === 'fish') return kind;
  if (kind === 'cooked_fish_meat') return 'cookedFish';
  return null;
}

// Compact human-friendly lines from WS events. Filter aggressively: the raw
// stream is mostly market reservations, queue positions, and frame chatter.
function summarizeWsEvents(events, selfPid) {
  const out = [];
  for (const ev of events) {
    if (ev.event !== 'recv' && ev.event !== 'send') continue;
    const d = ev.data || {};
    switch (ev.t) {
      case 'res_evt': {
        const ours = Number(d.by) === Number(selfPid);
        if (d.evt === 'clear' && ours) {
          out.push(`cleared ${resourceLabel(d.kind)} ${d.keys?.join('/') || ''}`);
        } else if (d.evt === 'wear' && ours && d.loot) {
          out.push(`+1 ${resourceLabel(d.loot)}`);
        } else if (d.evt === 'wear' && ours && d.l2t) {
          out.push(`L2 tool drop · ${d.l2t}`);
        }
        break;
      }
      case 'skill_xp': {
        const skill = d.skill || 'xp';
        const gained = (d.newLevel ?? 0) - (d.oldLevel ?? 0);
        if (gained > 0) out.push(`${skill} +${gained} level → ${d.newLevel}`);
        // Note: we don't surface XP-only ticks; too chatty.
        break;
      }
      case 'inv_grant': {
        if (d.grant) out.push(`granted: ${resourceLabel(d.grant)}`);
        break;
      }
      case 'bld': {
        if (ev.event === 'recv' && d.by === selfPid) {
          out.push(`built ${d.k} @ ${d.c},${d.r}`);
        }
        break;
      }
      case 'queue_ready':
        out.push('queue ready · joining');
        break;
      case 'queue_evicted':
        out.push(`queue evicted: ${d.reason || ''}`);
        break;
      case 'arena_lb':
        // top winner snapshot
        if (Array.isArray(d.rows) && d.rows.length) {
          out.push(`arena top · ${d.rows[0].name} ${d.rows[0].wins}w`);
        }
        break;
    }
  }
  // Keep the HUD readable; the planner/backend already reports movement.
  return out.slice(0, 2);
}

function pickChatLines(messages, selfPid) {
  const out = [];
  for (const m of messages) {
    if (m.playerId === selfPid) continue;        // skip our own lines
    if (CHAT_AUTHOR_MUTE.has(m.displayName)) continue;
    const txt = m.message?.trim();
    if (!txt) continue;
    // surface boss/drop/admin chatter
    const lower = txt.toLowerCase();
    const interesting =
      lower.includes('boss') || lower.includes('drop') || lower.includes('rare') ||
      lower.includes('admin') || lower.includes('claim') || lower.startsWith('!') ||
      m.region === 'world';
    if (interesting) out.push(`[${m.displayName}] ${txt}`);
  }
  return out.slice(-2); // at most 2 per tick
}

const kintara = {
  name: 'kintara',

  async tick(state) {
    // 1) snapshot
    const me = await client.me().catch((err) => ({ _err: err }));
    if (me._err) {
      if (String(me._err.message).includes('no kintara.com tab')) {
        return { loop: 'offline', msg: 'no kintara.com tab open — open the game' };
      }
      throw me._err;
    }
    if (!me.json || me.json.ok !== true) {
      return { msg: 'kintara · session expired? open kintara.com and refresh' };
    }
    const j = me.json;
    const snap = {
      pid:    j.player?.id,
      hp:     j.meta?.hp,
      spawn:  j.meta?.spawn,
      gold:   j.backpack?.gold ?? 0,
      bpHash: backpackHash(j.backpack),
      stateSeq: j.stateSeq,
      tutorial: j.tutorialStep,
    };

    // 2) deltas vs prior snapshot
    let goldDelta = 0;
    const msgs = [];
    const prevSnap = lastSnap;
    if (prevSnap) {
      goldDelta = snap.gold - prevSnap.gold;
      if (snap.spawn && prevSnap.spawn && snap.spawn.realm !== prevSnap.spawn.realm) {
        msgs.push(`moved → ${snap.spawn.realm}`);
      }
      if (snap.hp !== prevSnap.hp) {
        const arrow = snap.hp > prevSnap.hp ? '+' : '';
        msgs.push(`hp ${arrow}${snap.hp - prevSnap.hp} → ${snap.hp}`);
      }
      if (snap.bpHash !== prevSnap.bpHash && goldDelta === 0) {
        msgs.push('inventory changed');
      }
    } else {
      msgs.push(`signed in · ${j.player?.display_name || j.player?.id}`);
    }
    const baseResources = backpackResources(j.backpack);
    if (!liveResources) liveResources = { ...baseResources };
    const resourceDeltaLines = prevSnap?.resources ? resourceDeltas(prevSnap.resources, baseResources) : [];
    for (const [key, value] of Object.entries(baseResources)) {
      liveResources[key] = Math.max(Number(liveResources[key] || 0), Number(value || 0));
    }
    for (const line of resourceDeltaLines) msgs.push(line);

    // Track self-id for filtering WS events
    if (snap.pid) selfPlayerId = snap.pid;

    // 2b) Drain recent WebSocket events. The ws-bridge logs drops, XP gains,
    //     resource events, and queue movement on the game's own socket.
    try {
      const drain = await client.wsDrain(lastWsDrainAt);
      lastWsDrainAt = drain.now;
      applyAcceptedResourceWear(drain.events, selfPlayerId);
      for (const line of summarizeWsEvents(drain.events, selfPlayerId)) {
        msgs.push(line);
      }
    } catch { /* tolerate — no kintara tab or ws not yet up */ }

    // 3) $KINS balance (less frequent)
    ticksSinceBalance += 1;
    let kinsDelta = 0;
    if (ticksSinceBalance >= KEEP_TICKS_BETWEEN_BALANCE) {
      ticksSinceBalance = 0;
      try {
        const bal = await client.tokenBalance();
        const next = readTokenBalance(bal?.json);
        if (next != null) {
          if (lastBalance != null) kinsDelta = +(next - lastBalance).toFixed(3);
          lastBalance = next;
        }
      } catch { /* tolerate */ }
    }

    // 4) chat
    try {
      if (!chatBootstrapped) {
        const bs = await client.chatBootstrap(CHAT.region, CHAT.shard);
        lastChatId = bs?.json?.maxId || 0;
        chatBootstrapped = true;
      } else {
        const c = await client.chatSince(CHAT.region, CHAT.shard, lastChatId);
        const cj = c?.json;
        if (cj?.ok && Array.isArray(cj.messages) && cj.messages.length) {
          lastChatId = cj.maxId || lastChatId;
          for (const line of pickChatLines(cj.messages, snap.pid)) msgs.push(line);
        }
      }
    } catch { /* tolerate */ }

    // 5) compose tick result
    const loop = shortLoopFromMeta(j.meta);
    const tick = {
      loop,
      snapshot: {
        pid:        snap.pid,
        displayName: j.player?.display_name || j.player?.username,
        hp:         snap.hp,
        wildShield: j.meta?.wildShield ?? 0,
        spawn:      snap.spawn,
        gold:       snap.gold,
        kins:       lastBalance,
        resources:  liveResources || baseResources,
        tutorial:   snap.tutorial,
      },
    };
    if (goldDelta > 0) tick.gold = goldDelta;
    if (kinsDelta !== 0) tick.kins = kinsDelta;
    if (msgs.length) tick.msg = msgs.join(' · ');
    lastSnap = snap;
    lastSnap.resources = { ...baseResources };
    return tick;
  },

  // Expose select helpers so the background can react to specific buttons.
  client,
};

function applyAcceptedResourceWear(events, selfPid) {
  if (!liveResources || !selfPid) return;
  for (const ev of events || []) {
    const d = ev.data || {};
    if (ev.event !== 'recv' || ev.t !== 'res_evt') continue;
    if (d.evt !== 'wear' || Number(d.by) !== Number(selfPid)) continue;
    const key = normalizeLootResource(d.loot);
    if (!key) continue;
    liveResources[key] = Number(liveResources[key] || 0) + 1;
  }
}

// Pick which one. Switch to the real adapter by default; if no kintara.com
// tab is open or auth fails, the first tick gracefully reports it and the
// agent will pause itself.
export const adapter = kintara;

// Keep simulated exported so a future popup toggle could swap them.
export { simulated, kintara };
