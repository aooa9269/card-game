"""
Apply all feature changes to the monolithic main-branch index.html and
write the result to /tmp/patched_index.html for inspection before push.
"""
import json, re, sys

SRC = '/tmp/current_main.html'

with open(SRC) as f:
    html = f.read()

def rep(old, new):
    global html
    count = html.count(old)
    assert count == 1, "Expected 1 match, got {} for: {!r}".format(count, old[:80])
    html = html.replace(old, new, 1)

# ── 1. onGameState: track prev phase, clear selection on new round, sim hooks ──
rep(
    'function onGameState(state) {\n  gameState = state;\n  switch (state.phase) {\n    case \'lobby\':\n      renderLobby(state);\n      if (!$(\'screen-lobby\').classList.contains(\'active\')) showScreen(\'screen-lobby\');\n      break;\n    case \'first_pick\':\n      showScreen(\'screen-first-pick\');\n      renderFirstPick(state);\n      break;\n    case \'playing\':\n      swapMode = false;\n      showScreen(\'screen-game\');\n      renderGame(state);\n      break;\n    case \'round_end\':\n      renderRoundEnd(state);\n      break;\n    case \'game_end\':\n      renderGameEnd(state);\n      break;\n  }\n}',
    """function onGameState(state) {
  const _prevPhase = gameState?.phase;
  gameState = state;
  switch (state.phase) {
    case 'lobby':
      renderLobby(state);
      if (!$('screen-lobby').classList.contains('active')) showScreen('screen-lobby');
      break;
    case 'first_pick':
      showScreen('screen-first-pick');
      renderFirstPick(state);
      break;
    case 'playing':
      if (_prevPhase !== 'playing') { selectedHandIds.clear(); takeIds.clear(); giveIds.clear(); }
      swapMode = false;
      showScreen('screen-game');
      renderGame(state);
      updateModGameBtn();
      if (simActive && isMyTurn) scheduleSimStep();
      break;
    case 'round_end':
      renderRoundEnd(state);
      if (simActive && simType === 'rounds') {
        simRemaining--;
        updateSimStatus();
        if (simRemaining > 0) setTimeout(readyNextRound, simSpeed());
        else stopSim();
      }
      break;
    case 'game_end':
      renderGameEnd(state);
      break;
  }
}"""
)

# ── 2. startNextRound: return pickPool cards to deck ──────────────────────────
rep(
    '    allCards.push(...this.carcass, ...this.deck);\n    this.deck = shuffle(allCards);\n    this.carcass = [];\n    if (!totalTie) {',
    """    allCards.push(...this.carcass, ...this.deck, ...this.pickPool);
    this.pickPool = [];
    this.deck = shuffle(allCards);
    this.carcass = [];
    if (!totalTie) {"""
)

# ── 3. handleAction: wrap in try-catch so errors don't silently disappear ─────
rep(
    "function handleAction(fromPeerId, action) {\n  let result;\n  switch (action.type) {",
    """function handleAction(fromPeerId, action) {
  let result;
  try {
  switch (action.type) {"""
)
# Close the try-catch just before the closing brace of handleAction
rep(
    "  if (result && !result.success) {\n    const errMsg = { type: 'error', message: result.error };\n    if (fromPeerId === myId) toast(result.error, 'error');\n    else sendToGuest(fromPeerId, errMsg);\n    return;\n  }\n  broadcastState();\n}",
    """  if (result && !result.success) {
    const errMsg = { type: 'error', message: result.error };
    if (fromPeerId === myId) toast(result.error, 'error');
    else sendToGuest(fromPeerId, errMsg);
    return;
  }
  broadcastState();
  } catch (err) {
    console.error('handleAction error:', err);
    const msg = 'Server error processing action. Please try again.';
    if (fromPeerId === myId) toast(msg, 'error');
    else sendToGuest(fromPeerId, { type: 'error', message: msg });
  }
}"""
)

# ── 4. Exit button in game header ─────────────────────────────────────────────
rep(
    '<button class="btn-icon" title="Rules (R)" onclick="openRulesModal()">❓</button>\n        <button class="btn-icon" title="Settings" onclick="toggleSettings()">⚙</button>',
    """<button class="btn-icon" title="Rules (R)" onclick="openRulesModal()">❓</button>
        <button class="btn-icon" title="Settings" onclick="toggleSettings()">⚙</button>
        <button class="btn-icon" id="btn-exit-game" title="Exit game" onclick="exitGame()" style="color:#ff7070">✕</button>"""
)

# ── 5. Theme selector in settings panel ───────────────────────────────────────
rep(
    '<button class="btn btn-ghost" onclick="toggleSettings()" style="margin-top:8px;width:100%;font-size:0.78rem">Close</button>',
    """<div class="settings-row">
      <label>Table Theme</label>
      <select id="setting-felt-theme" onchange="applyFeltTheme(this.value)">
        <option value="green">Green</option>
        <option value="dark">Dark</option>
        <option value="blue">Blue</option>
        <option value="red">Red</option>
      </select>
    </div>
    <button class="btn btn-ghost" onclick="toggleSettings()" style="margin-top:8px;width:100%;font-size:0.78rem">Close</button>"""
)

# ── 6. Add sim state vars near isMyTurn declaration ───────────────────────────
rep(
    'let isMyTurn = false;\n\n// Host-side\nlet isHost = false;',
    """let isMyTurn = false;

// Sim state
let simActive = false;
let simType = 'turns';
let simRemaining = 0;
let simStepScheduled = false;

// Host-side
let isHost = false;"""
)

# ── 7. Add exitGame, applyFeltTheme, sim functions before goBack ──────────────
rep(
    'function goBack() {',
    """// ── Exit game ─────────────────────────────────────────────────────────────────
function exitGame() {
  if (!confirm('Leave the game? Your progress will be lost.')) return;
  stopSim();
  goBack();
}

// ── Felt theme switcher ───────────────────────────────────────────────────────
const FELT_THEMES = {
  green: { dark: '#1a3a1a', felt: '#2d5a27', mid: '#3a7a32' },
  dark:  { dark: '#0d0d14', felt: '#1a1a2e', mid: '#16213e' },
  blue:  { dark: '#0a1628', felt: '#0d2137', mid: '#163356' },
  red:   { dark: '#1a0808', felt: '#2e1010', mid: '#4a1818' },
};
function applyFeltTheme(name) {
  const t = FELT_THEMES[name] || FELT_THEMES.green;
  document.documentElement.style.setProperty('--green-darkest', t.dark);
  document.documentElement.style.setProperty('--green-dark', t.dark);
  document.documentElement.style.setProperty('--green-felt', t.felt);
  document.documentElement.style.setProperty('--green-mid', t.mid);
  localStorage.setItem('carcass-felt-theme', name);
  const sel = document.getElementById('setting-felt-theme');
  if (sel) sel.value = name;
}
(function() {
  const saved = localStorage.getItem('carcass-felt-theme');
  if (saved) applyFeltTheme(saved);
})();

// ── Sim AI helpers ─────────────────────────────────────────────────────────────
function _simFindBestClaim(hand) {
  const n = hand.length;
  for (let mask = 3; mask < (1 << n); mask++) {
    const sub = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sub.push(hand[i]);
    if (sub.length >= 2 && canSum21(sub)) return sub.map(c => c.id);
  }
  return null;
}
function _simFindBestSwap(hand, carcass) {
  if (!carcass.length || !hand.length) return null;
  for (const cc of carcass) {
    for (const hc of hand) {
      const nh = [...hand.filter(c => c.id !== hc.id), cc];
      if (_simFindBestClaim(nh)) return { takeIds: [cc.id], giveIds: [hc.id] };
    }
  }
  for (let i = 0; i < carcass.length - 1; i++) {
    for (let j = i + 1; j < carcass.length; j++) {
      for (let a = 0; a < hand.length - 1; a++) {
        for (let b = a + 1; b < hand.length; b++) {
          const nh = [...hand.filter(c => c.id !== hand[a].id && c.id !== hand[b].id), carcass[i], carcass[j]];
          if (_simFindBestClaim(nh)) return { takeIds: [carcass[i].id, carcass[j].id], giveIds: [hand[a].id, hand[b].id] };
        }
      }
    }
  }
  return null;
}
function simSpeed() { return parseInt(document.getElementById('sim-speed-sel')?.value ?? 700); }
function updateSimStatus() {
  const label = { turns: 'turn', moves: 'move', rounds: 'round' }[simType] || simType;
  const s = simRemaining !== 1 ? 's' : '';
  const el = document.getElementById('sim-status-text');
  if (el) el.textContent = simRemaining + ' ' + label + s + ' left';
}
function setSimType(type) {
  simType = type;
  document.querySelectorAll('.sim-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
}
function startSim() {
  const count = Math.max(1, parseInt(document.getElementById('sim-count')?.value) || 5);
  simRemaining = count; simActive = true;
  document.getElementById('sim-btn-row')?.classList.add('hidden');
  document.getElementById('sim-running-row')?.classList.remove('hidden');
  updateSimStatus();
  toast('Sim started: ' + count + ' ' + simType, 'info', 2000);
  if (isMyTurn && gameState?.phase === 'playing') scheduleSimStep();
}
function stopSim() {
  simActive = false; simStepScheduled = false;
  document.getElementById('sim-btn-row')?.classList.remove('hidden');
  document.getElementById('sim-running-row')?.classList.add('hidden');
}
function scheduleSimStep() {
  if (!simActive || simStepScheduled) return;
  simStepScheduled = true;
  setTimeout(doSimStep, simSpeed());
}
function doSimStep() {
  simStepScheduled = false;
  if (!simActive || simRemaining <= 0) { stopSim(); return; }
  if (!gameState || gameState.phase !== 'playing' || !isMyTurn) return;
  const me = gameState.players.find(p => p.id === myId);
  const hand = (me?.hand || []).filter(Boolean);
  const claimIds = _simFindBestClaim(hand);
  if (claimIds) {
    selectedHandIds.clear();
    sendAction({ type: 'claim-set', cardIds: claimIds });
    if (simType === 'moves') { simRemaining--; updateSimStatus(); }
    return;
  }
  if (!gameState.hasActed && (gameState.carcass || []).length > 0) {
    const swap = _simFindBestSwap(hand, gameState.carcass);
    if (swap) {
      swapMode = false; takeIds.clear(); giveIds.clear();
      sendAction({ type: 'swap-carcass', takeIds: swap.takeIds, giveIds: swap.giveIds });
      if (simType === 'moves') { simRemaining--; updateSimStatus(); }
      return;
    }
  }
  sendAction({ type: 'end-turn' });
  swapMode = false; takeIds.clear(); giveIds.clear(); selectedHandIds.clear();
  if (simType === 'turns' || simType === 'moves') { simRemaining--; updateSimStatus(); }
  if (simRemaining <= 0) stopSim();
}

function goBack() {"""
)

# ── 8. Add sim + stat-editor sections to renderModGameOverlay ─────────────────
# Inject into the top of the overlay body HTML string, after the global-actions block

OLD_MOD_HEADER = """  let html = `
    <div class="mod-global-actions">
      <b style="color:#ff5252;width:100%;font-size:0.82rem">Global Actions</b>
      <button class="btn-mod-sm btn-warn" onclick="modForceEndRound()">⏭ Force End Round</button>
      <button class="btn-mod-sm btn-danger" onclick="modRefillCarcass()">♻ Refill Carcass</button>
      <button class="btn-mod-sm btn-safe" onclick="modReshuffleDeck()">🔀 Reshuffle Deck</button>
    </div>`;"""

NEW_MOD_HEADER = """  let html = `
    <div class="mod-global-actions">
      <b style="color:#ff5252;width:100%;font-size:0.82rem">Global Actions</b>
      <button class="btn-mod-sm btn-warn" onclick="modForceEndRound()">⏭ Force End Round</button>
      <button class="btn-mod-sm btn-danger" onclick="modRefillCarcass()">♻ Refill Carcass</button>
      <button class="btn-mod-sm btn-safe" onclick="modReshuffleDeck()">🔀 Reshuffle Deck</button>
    </div>
    <div class="mod-sim-section">
      <b style="color:#c8a0ff;font-size:0.78rem;letter-spacing:.08em;text-transform:uppercase">🤖 Auto Simulation</b>
      <div class="sim-type-row" style="margin:6px 0">
        <button class="sim-type-btn active" data-type="turns"  onclick="setSimType('turns')">Turns</button>
        <button class="sim-type-btn"        data-type="moves"  onclick="setSimType('moves')">Moves</button>
        <button class="sim-type-btn"        data-type="rounds" onclick="setSimType('rounds')">Rounds</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:0.8rem">
        <label>Count <input type="number" id="sim-count" value="5" min="1" max="999" style="width:54px;margin-left:4px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;padding:3px 5px;font-size:0.78rem"></label>
        <label>Speed
          <select id="sim-speed-sel" style="margin-left:4px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;padding:3px 5px;font-size:0.78rem">
            <option value="250">Fast</option>
            <option value="700" selected>Normal</option>
            <option value="1500">Slow</option>
          </select>
        </label>
      </div>
      <div id="sim-btn-row" style="margin-top:6px"><button class="btn btn-primary" style="width:100%;font-size:0.78rem;padding:6px" onclick="startSim()">▶ Start Sim</button></div>
      <div id="sim-running-row" class="hidden" style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
        <span id="sim-status-text" style="color:#c8a0ff;font-size:0.8rem;font-weight:bold">—</span>
        <button class="btn btn-ghost" style="font-size:0.76rem;padding:4px 10px" onclick="stopSim()">■ Stop</button>
      </div>
    </div>`;"""

rep(OLD_MOD_HEADER, NEW_MOD_HEADER)

# ── 9. Add Score/Sets inputs to each player block in renderModGameOverlay ──────
OLD_PLAYER_BTNS = """        <div class="mod-player-btns">
          <button class="btn-mod-sm btn-safe" onclick="modDealCard('${escHtml(p.id)}')">+ Deal Card</button>
          <button class="btn-mod-sm btn-warn" onclick="modClearHand('${escHtml(p.id)}','${escHtml(p.name)}')">🗑 Clear Hand</button>
          ${!p.isAI && p.id !== myId ? `<button class="btn-mod-sm btn-danger" onclick="modKickPlayer('${escHtml(p.id)}','${escHtml(p.name)}')">🚫 Kick</button>` : ''}
        </div>
      </div>`;"""

NEW_PLAYER_BTNS = """        <div class="mod-player-btns">
          <button class="btn-mod-sm btn-safe" onclick="modDealCard('${escHtml(p.id)}')">+ Deal Card</button>
          <button class="btn-mod-sm btn-warn" onclick="modClearHand('${escHtml(p.id)}','${escHtml(p.name)}')">🗑 Clear Hand</button>
          ${!p.isAI && p.id !== myId ? `<button class="btn-mod-sm btn-danger" onclick="modKickPlayer('${escHtml(p.id)}','${escHtml(p.name)}')">🚫 Kick</button>` : ''}
        </div>
        <div class="mod-stat-editor" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <label style="font-size:0.74rem;color:rgba(255,255,255,0.5)">Score <input type="number" id="mod-score-${escHtml(p.id)}" value="${p.score}" min="0" max="9999" style="width:52px;margin-left:3px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;padding:3px 5px;font-size:0.78rem"></label>
          <label style="font-size:0.74rem;color:rgba(255,255,255,0.5)">Sets <input type="number" id="mod-sets-${escHtml(p.id)}" value="${p.sets.length}" min="0" max="99" style="width:44px;margin-left:3px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;padding:3px 5px;font-size:0.78rem"></label>
          <button class="btn-mod-sm btn-safe" onclick="modApplyStats('${escHtml(p.id)}')">✓ Apply</button>
        </div>
      </div>`;"""

rep(OLD_PLAYER_BTNS, NEW_PLAYER_BTNS)

# ── 10. Add modApplyStats function after modClearHand ────────────────────────
OLD_AFTER_MOD_CLEAR = """function modClearHand(playerId, name) {
  if (!confirm(`Clear ${name}'s hand?`)) return;
  if (!isHost || !room) return;
  const p = room.players.find(p => p.id === playerId);
  if (!p) return;"""

NEW_AFTER_MOD_CLEAR = """function modApplyStats(playerId) {
  if (!isHost || !room) return;
  const p = room.players.find(pl => pl.id === playerId);
  if (!p) return;
  const scoreEl = document.getElementById('mod-score-' + playerId);
  const setsEl  = document.getElementById('mod-sets-' + playerId);
  if (scoreEl) p.score = Math.max(0, parseInt(scoreEl.value) || 0);
  if (setsEl) {
    const target = Math.max(0, parseInt(setsEl.value) || 0);
    while (p.sets.length < target) p.sets.push([]);
    while (p.sets.length > target) p.sets.pop();
  }
  room.pushLog('[MOD] Stats adjusted for ' + p.name);
  broadcastState();
  toast('Stats updated for ' + p.name, 'success', 1500);
  renderModGameOverlay();
}

function modClearHand(playerId, name) {
  if (!confirm(`Clear ${name}'s hand?`)) return;
  if (!isHost || !room) return;
  const p = room.players.find(p => p.id === playerId);
  if (!p) return;"""

rep(OLD_AFTER_MOD_CLEAR, NEW_AFTER_MOD_CLEAR)

# ── 11. Add CSS for new elements in the <style> block ────────────────────────
# Append before closing </style>
OLD_STYLE_END = '</style>\n</head>\n<body>'
NEW_STYLE_END = """.sim-type-row { display:flex; gap:4px; }
.sim-type-btn { flex:1; padding:5px 0; background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.15); border-radius:5px; color:rgba(255,255,255,0.6); cursor:pointer; font-size:0.76rem; font-family:inherit; transition:all .15s; }
.sim-type-btn:hover { background:rgba(255,255,255,0.12); color:#fff; }
.sim-type-btn.active { background:rgba(200,160,255,0.2); border-color:#c8a0ff; color:#c8a0ff; font-weight:bold; }
.mod-sim-section { padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.08); margin-bottom:10px; display:flex; flex-direction:column; gap:6px; }
#btn-exit-game { color:#ff7070; }
</style>
</head>
<body>"""
rep(OLD_STYLE_END, NEW_STYLE_END)

with open('/tmp/patched_index.html', 'w') as f:
    f.write(html)

print(f"Done. Output length: {len(html)}")
print("Saved to /tmp/patched_index.html")
