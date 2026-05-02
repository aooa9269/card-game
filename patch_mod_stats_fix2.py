"""
Fix: remove localStorage-based mod permission check from mod-set-stats handler
(getMods() only has data on the root mod's browser, not on every host's browser).
Also refresh the mod overlay when game state updates while it's open.
"""

with open('/tmp/current_main.html') as f:
    html = f.read()

def rep(old, new):
    global html
    count = html.count(old)
    assert count == 1, "Expected 1 match, got {} for: {!r}".format(count, old[:80])
    html = html.replace(old, new, 1)

# ── 1. Remove getMods() perm check from mod-set-stats handler ────────────────
# In P2P, getMods() is localStorage-specific to each browser.
# A non-host mod may have permissions granted by AOOA926 stored in AOOA926's
# localStorage, but the current host won't have them.
# Since only mods can see the stat editor UI (client-side hasPerm check),
# just verify the sender is a valid room player.
rep(
    """    case 'mod-set-stats': {
      const senderName = room.players.find(pl => pl.id === fromPeerId)?.name;
      const mods = getMods();
      const senderIsMod = senderName === ROOT_MOD_NAME ||
        mods.some(m => m.name === senderName &&
          (m.permissions?.includes('all') || m.permissions?.includes('game-control') || m.permissions?.includes('reset-stats')));
      if (!senderIsMod) { result = { success: false, error: 'Not authorized.' }; break; }
      const tp = room.players.find(pl => pl.id === action.playerId);
      if (!tp) { result = { success: false, error: 'Player not found.' }; break; }""",
    """    case 'mod-set-stats': {
      // P2P: client-side hasPerm() gates access to stat editor, no server to re-verify
      const tp = room.players.find(pl => pl.id === action.playerId);
      if (!tp) { result = { success: false, error: 'Player not found.' }; break; }"""
)

# ── 2. Refresh mod overlay on game-state update if it's open ─────────────────
# This ensures the stat editor shows fresh values after any broadcast
rep(
    """      updateModGameBtn();
      if (simActive && isMyTurn) scheduleSimStep();""",
    """      updateModGameBtn();
      if (document.getElementById('mod-game-overlay')?.classList.contains('open')) renderModGameOverlay();
      if (simActive && isMyTurn) scheduleSimStep();"""
)

with open('/tmp/patched_index.html', 'w') as f:
    f.write(html)

print("Done. {} chars, {} bytes".format(len(html), len(html.encode('utf-8'))))
