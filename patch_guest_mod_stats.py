"""
Patch to allow non-host moderators to edit player stats.
Applies on top of the already-patched main branch index.html.
"""

with open('/tmp/current_main.html') as f:
    html = f.read()

def rep(old, new):
    global html
    count = html.count(old)
    assert count == 1, "Expected 1 match, got {} for: {!r}".format(count, old[:80])
    html = html.replace(old, new, 1)

# ── 1. renderModGameOverlay: show stat editor to non-host mods ────────────────
rep(
    'if (!isHost || !room) {\n    body.innerHTML = `<p style="color:rgba(255,255,255,0.4);text-align:center;padding:32px">\n      In-game controls are only available when you are the <b>host</b> of the room.</p>`;\n    return;\n  }',
    """if (!isHost || !room) {
    if (!hasPerm('game-control') || !gameState || gameState.phase !== 'playing') {
      body.innerHTML = `<p style="color:rgba(255,255,255,0.4);text-align:center;padding:32px">
        In-game controls are only available when you are the <b>host</b> of the room.</p>`;
      return;
    }
    // Non-host mod: show stat editor only, sourced from gameState
    let ghtml = '<div style="padding:6px 0 2px;font-size:0.74rem;color:rgba(255,255,255,0.4);text-align:center;margin-bottom:8px">📊 Stat editor (mod)</div>';
    (gameState.players || []).forEach(p => {
      ghtml += `
        <div class="mod-player-block">
          <h4>${escHtml(p.name)}${p.isAI?' 🤖':''}${p.id===myId?' (you)':''}</h4>
          <div class="mod-stat-editor" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px">
            <label style="font-size:0.74rem;color:rgba(255,255,255,0.5)">Score <input type="number" id="mod-score-${escHtml(p.id)}" value="${p.score}" min="0" max="9999" style="width:52px;margin-left:3px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;padding:3px 5px;font-size:0.78rem"></label>
            <label style="font-size:0.74rem;color:rgba(255,255,255,0.5)">Sets <input type="number" id="mod-sets-${escHtml(p.id)}" value="${p.setCount ?? 0}" min="0" max="99" style="width:44px;margin-left:3px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:#fff;padding:3px 5px;font-size:0.78rem"></label>
            <button class="btn-mod-sm btn-safe" onclick="modApplyStatsGuest('${escHtml(p.id)}')">✓ Apply</button>
          </div>
        </div>`;
    });
    body.innerHTML = ghtml;
    return;
  }"""
)

# ── 2. handleAction: add mod-set-stats case (before default) ─────────────────
rep(
    '    default: return;\n  }',
    """    case 'mod-set-stats': {
      const senderName = room.players.find(pl => pl.id === fromPeerId)?.name;
      const mods = getMods();
      const senderIsMod = senderName === ROOT_MOD_NAME ||
        mods.some(m => m.name === senderName &&
          (m.permissions?.includes('all') || m.permissions?.includes('game-control') || m.permissions?.includes('reset-stats')));
      if (!senderIsMod) { result = { success: false, error: 'Not authorized.' }; break; }
      const tp = room.players.find(pl => pl.id === action.playerId);
      if (!tp) { result = { success: false, error: 'Player not found.' }; break; }
      if (action.score !== undefined) tp.score = Math.max(0, parseInt(action.score) || 0);
      if (action.sets !== undefined) {
        const target = Math.max(0, parseInt(action.sets) || 0);
        while (tp.sets.length < target) tp.sets.push([]);
        while (tp.sets.length > target) tp.sets.pop();
      }
      room.pushLog('[MOD] Stats adjusted for ' + tp.name);
      broadcastState();
      if (fromPeerId !== myId) sendToGuest(fromPeerId, { type: 'mod-stats-applied', name: tp.name });
      return;
    }
    default: return;
  }"""
)

# ── 3. Add modApplyStatsGuest next to modApplyStats ───────────────────────────
rep(
    'function modApplyStats(playerId) {\n  if (!isHost || !room) return;',
    """function modApplyStatsGuest(playerId) {
  const scoreEl = document.getElementById('mod-score-' + playerId);
  const setsEl  = document.getElementById('mod-sets-' + playerId);
  sendAction({
    type: 'mod-set-stats',
    playerId,
    score: scoreEl ? parseInt(scoreEl.value) : undefined,
    sets:  setsEl  ? parseInt(setsEl.value)  : undefined,
  });
  toast('Stat change sent to host…', 'info', 1500);
}

function modApplyStats(playerId) {
  if (!isHost || !room) return;"""
)

# ── 4. Handle mod-stats-applied confirmation message from host ────────────────
rep(
    "      case 'error':\n        toast(data.message, 'error');\n        break;",
    """      case 'error':
        toast(data.message, 'error');
        break;
      case 'mod-stats-applied':
        toast('Stats updated for ' + data.name, 'success', 1500);
        break;"""
)

with open('/tmp/patched_index.html', 'w') as f:
    f.write(html)

print("Done. Output length: {} chars, {} bytes".format(len(html), len(html.encode('utf-8'))))
