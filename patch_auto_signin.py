"""
Fix: sync currentUser from lobby name in modalGo() so that:
1. Mod permissions work (hasPerm checks currentUser)
2. Stats are saved to leaderboard (saveGameStatsExtended checks currentUser)
3. Lobby name input pre-fills from currentUser so returning players don't re-type
"""

with open('/tmp/current_main.html') as f:
    html = f.read()

def rep(old, new):
    global html
    count = html.count(old)
    assert count == 1, "Expected 1 match, got {} for: {!r}".format(count, old[:80])
    html = html.replace(old, new, 1)

# ── 1. modalGo: sync currentUser to lobby name ────────────────────────────────
rep(
    """  myName = name;
  $('modal-overlay').classList.add('hidden');""",
    """  myName = name;
  // Sync identity so mod perms + stat tracking work without explicit sign-in
  if (!currentUser || currentUser.name !== name) {
    currentUser = { name };
    lsSet(LS_PLAYER, { name });
    checkModStatus();
    updateAccountButton();
  }
  $('modal-overlay').classList.add('hidden');"""
)

# ── 2. openModal: pre-fill name from currentUser if available ─────────────────
rep(
    "  $('inp-name').value = myName;",
    "  $('inp-name').value = currentUser?.name || myName;"
)

with open('/tmp/patched_index.html', 'w') as f:
    f.write(html)

print("Done. {} chars, {} bytes".format(len(html), len(html.encode('utf-8'))))
