"""
Add full stat editing from Leaderboard, Stats panel, and Mod panel.
- Floating edit modal with all stat fields (wins, points, games, 21s, streaks)
- Edit (✎) button on every leaderboard / stats-panel row for mods
- Replace "Reset Stats" in mod panel with "✎ Edit Stats" (reset kept as separate action)
"""

with open('/tmp/current_main.html') as f:
    html = f.read()

def rep(old, new):
    global html
    count = html.count(old)
    assert count == 1, "Expected 1 match, got {} for: {!r}".format(count, old[:80])
    html = html.replace(old, new, 1)

# ── 1. CSS for the stat-edit overlay ─────────────────────────────────────────
rep(
    '.sim-type-btn.active { background:rgba(200,160,255,0.2); border-color:#c8a0ff; color:#c8a0ff; font-weight:bold; }',
    """.sim-type-btn.active { background:rgba(200,160,255,0.2); border-color:#c8a0ff; color:#c8a0ff; font-weight:bold; }
#stat-edit-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:9999; display:flex; align-items:center; justify-content:center; }
#stat-edit-overlay.hidden { display:none; }
.stat-edit-box { background:#1a2030; border:1px solid rgba(255,255,255,0.18); border-radius:12px; padding:22px; width:min(340px,92vw); }
.stat-edit-box h3 { color:var(--gold-bright); margin:0 0 14px; font-size:1rem; }
.stat-edit-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px 12px; margin-bottom:14px; }
.stat-edit-field label { display:block; font-size:0.71rem; color:rgba(255,255,255,0.4); margin-bottom:3px; }
.stat-edit-field input { width:100%; background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.18); border-radius:5px; color:#fff; padding:5px 7px; font-size:0.82rem; font-family:inherit; box-sizing:border-box; }
.stat-edit-btns { display:flex; gap:8px; justify-content:flex-end; }"""
)

# ── 2. Add modEditStats + modSaveEditStats before renderStatsLeaderboard ──────
rep(
    'function renderStatsLeaderboard(tab) {',
    """function modEditStats(name) {
  if (!hasPerm('reset-stats')) return;
  const e = getStatsEntry(name);
  let ov = document.getElementById('stat-edit-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'stat-edit-overlay';
    ov.className = 'hidden';
    ov.addEventListener('click', ev => { if (ev.target === ov) ov.classList.add('hidden'); });
    document.body.appendChild(ov);
  }
  ov.innerHTML = `<div class="stat-edit-box">
    <h3>✎ Edit Stats: ${escHtml(name)}</h3>
    <div class="stat-edit-grid">
      <div class="stat-edit-field"><label>Wins</label><input type="number" id="se-wins" value="${e.wins||0}" min="0"></div>
      <div class="stat-edit-field"><label>Games Played</label><input type="number" id="se-games" value="${e.gamesPlayed||0}" min="0"></div>
      <div class="stat-edit-field"><label>Total Points</label><input type="number" id="se-pts" value="${e.totalPoints||0}" min="0"></div>
      <div class="stat-edit-field"><label>Best Score</label><input type="number" id="se-best" value="${e.bestGameScore||0}" min="0"></div>
      <div class="stat-edit-field"><label>Total 21s</label><input type="number" id="se-claims" value="${e.totalClaims||0}" min="0"></div>
      <div class="stat-edit-field"><label>Win Streak</label><input type="number" id="se-streak" value="${e.currentWinStreak||0}" min="0"></div>
      <div class="stat-edit-field"><label>Best Streak</label><input type="number" id="se-beststreak" value="${e.longestWinStreak||0}" min="0"></div>
    </div>
    <div class="stat-edit-btns">
      <button class="btn btn-ghost" onclick="document.getElementById('stat-edit-overlay').classList.add('hidden')">Cancel</button>
      <button class="btn btn-primary" onclick="modSaveEditStats('${escHtml(name)}')">✓ Apply</button>
    </div>
  </div>`;
  ov.classList.remove('hidden');
}

function modSaveEditStats(name) {
  if (!hasPerm('reset-stats')) return;
  const n = id => Math.max(0, parseInt(document.getElementById(id)?.value) || 0);
  const e = getStatsEntry(name);
  e.wins             = n('se-wins');
  e.gamesPlayed      = n('se-games');
  e.totalPoints      = n('se-pts');
  e.bestGameScore    = n('se-best');
  e.totalClaims      = n('se-claims');
  e.currentWinStreak = n('se-streak');
  e.longestWinStreak = n('se-beststreak');
  saveLbEntry(e);
  document.getElementById('stat-edit-overlay')?.classList.add('hidden');
  toast('Stats updated for ' + name, 'success', 2000);
  loadLeaderboard();
  if (document.getElementById('screen-mod')?.classList.contains('active')) renderModUsers();
  if (document.getElementById('stats-modal') && !document.getElementById('stats-modal').classList.contains('hidden')) {
    const active = document.querySelector('.stats-tab.active');
    if (active) switchStatsTab(active.id.replace('stab-',''));
  }
}

function renderStatsLeaderboard(tab) {"""
)

# ── 3. Leaderboard table: add edit column header for mods ────────────────────
rep(
    '          <th class="lb-rank">#</th>\n          <th>Player</th>\n          <th id="lb-col-wins">Wins</th>\n          <th id="lb-col-pts">Points</th>\n          <th id="lb-col-games">Games</th>',
    """          <th class="lb-rank">#</th>
          <th>Player</th>
          <th id="lb-col-wins">Wins</th>
          <th id="lb-col-pts">Points</th>
          <th id="lb-col-games">Games</th>
          ${hasPerm('reset-stats') ? '<th></th>' : ''}"""
)

# ── 4. Leaderboard rows: add edit button for mods ─────────────────────────────
rep(
    """    return `<tr${isMe ? ' class="lb-you"' : ''}>
      <td class="lb-rank"${rankClass}>${rankEmoji[i] || (i+1)}</td>
      <td class="lb-name">${escHtml(e.name)}${isMe ? ' 👈' : ''}</td>
      <td>${e.wins || 0}</td>
      <td>${e.totalPoints || 0}</td>
      <td>${e.gamesPlayed || 0}</td>
    </tr>`;""",
    """    return `<tr${isMe ? ' class="lb-you"' : ''}>
      <td class="lb-rank"${rankClass}>${rankEmoji[i] || (i+1)}</td>
      <td class="lb-name">${escHtml(e.name)}${isMe ? ' 👈' : ''}</td>
      <td>${e.wins || 0}</td>
      <td>${e.totalPoints || 0}</td>
      <td>${e.gamesPlayed || 0}</td>
      ${hasPerm('reset-stats') ? `<td><button class="btn-mod-sm btn-safe" style="font-size:0.7rem;padding:2px 8px" onclick="modEditStats('${escHtml(e.name)}')">✎</button></td>` : ''}
    </tr>`;"""
)

# ── 5. Stats leaderboard rows: add edit button for mods ──────────────────────
rep(
    """  rows.forEach((e,i) => {
    const me = currentUser?.name === e.name;
    html += `<tr${me?' class="winner"':''}>
      <td>${medals[i]||i+1}</td>
      <td>${e.name}${me?' ★':''}</td>
      <td>${e[f]||0}</td>
      <td>${e.gamesPlayed||0}</td>
    </tr>`;
  });""",
    """    rows.forEach((e,i) => {
    const me = currentUser?.name === e.name;
    html += `<tr${me?' class="winner"':''}>
      <td>${medals[i]||i+1}</td>
      <td>${e.name}${me?' ★':''}</td>
      <td>${e[f]||0}</td>
      <td>${e.gamesPlayed||0}</td>
      ${hasPerm('reset-stats') ? `<td><button class="btn-mod-sm btn-safe" style="font-size:0.7rem;padding:2px 8px" onclick="modEditStats('${escHtml(e.name)}')">✎</button></td>` : ''}
    </tr>`;
  });"""
)

# ── 6. Mod panel user card: add "Edit Stats" button, keep Reset Stats ─────────
rep(
    """            ${hasPerm('reset-stats') ? `
              <button class="btn-mod-sm btn-warn" onclick="modResetStats('${safeName}')">🔄 Reset Stats</button>` : ''}""",
    """            ${hasPerm('reset-stats') ? `
              <button class="btn-mod-sm btn-safe" onclick="modEditStats('${safeName}')">✎ Edit Stats</button>
              <button class="btn-mod-sm btn-warn" onclick="modResetStats('${safeName}')">🔄 Reset All</button>` : ''}"""
)

with open('/tmp/patched_index.html', 'w') as f:
    f.write(html)

# Verify
with open('/tmp/patched_index.html') as f:
    out = f.read()

checks = [
    ("stat-edit-overlay CSS", "#stat-edit-overlay {"),
    ("modEditStats function", "function modEditStats(name) {"),
    ("modSaveEditStats function", "function modSaveEditStats(name) {"),
    ("lb header edit col", "hasPerm('reset-stats') ? '<th></th>'"),
    ("lb row edit button", "onclick=\"modEditStats('${escHtml(e.name)}')\""),
    ("stats panel edit button", "onclick=\"modEditStats('${escHtml(e.name)}')\""),
    ("mod panel Edit Stats button", "✎ Edit Stats"),
    ("mod panel Reset All kept", "🔄 Reset All"),
]
for name, text in checks:
    print(f"{'✓' if text in out else '✗'} {name}")
print("Done. {} bytes".format(len(out.encode('utf-8'))))
