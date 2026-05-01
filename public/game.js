// ─── Socket Setup ────────────────────────────────────────────────────────────
const socket = io();

// ─── App State ────────────────────────────────────────────────────────────────
let myId = null;
let myName = '';
let currentMode = null;
let roomCode = null;
let gameState = null;
let isMyTurn = false;

// Selection state
let selectedHandIds = new Set();
let swapMode = false;
let takeIds = new Set();
let giveIds = new Set();

// ─── Utility ─────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideOut 0.25s forwards';
    setTimeout(() => el.remove(), 250);
  }, duration);
}

function suitColor(suit) {
  return (suit === '♥' || suit === '♦') ? 'red' : 'black';
}

function cardValue(rank) {
  if (['J', 'Q', 'K'].includes(rank)) return [10];
  if (rank === 'A') return [1, 11];
  return [parseInt(rank)];
}

function selectionSum(cardObjects) {
  if (!cardObjects.length) return '';
  const aces = cardObjects.filter(c => c.rank === 'A').length;
  const nonAce = cardObjects.filter(c => c.rank !== 'A').reduce((s, c) => s + cardValue(c.rank)[0], 0);
  const sums = new Set();
  for (let a11 = 0; a11 <= aces; a11++) sums.add(nonAce + a11 * 11 + (aces - a11));
  return [...sums].sort((a, b) => a - b).join('/');
}

function canMake21(cardObjects) {
  if (cardObjects.length < 2) return false;
  const aces = cardObjects.filter(c => c.rank === 'A').length;
  const nonAce = cardObjects.filter(c => c.rank !== 'A').reduce((s, c) => s + cardValue(c.rank)[0], 0);
  for (let a11 = 0; a11 <= aces; a11++) {
    if (nonAce + a11 * 11 + (aces - a11) === 21) return true;
  }
  return false;
}

// ─── Card Rendering ──────────────────────────────────────────────────────────
function makeCard(card, opts = {}) {
  const { selectable = false, selected = false, takeSelected = false,
          giveSelected = false, faceDown = false, small = false } = opts;

  const el = document.createElement('div');
  if (faceDown) {
    el.className = `card card-back${small ? ' sm' : ''}`;
    return el;
  }

  el.className = `card ${suitColor(card.suit)}`;
  if (selected) el.classList.add('selected');
  if (takeSelected) el.classList.add('take-selected');
  if (giveSelected) el.classList.add('give-selected');
  if (!selectable) el.classList.add('not-your-turn');
  el.dataset.cardId = card.id;

  el.innerHTML = `
    <div class="card-corner top">
      <div class="card-rank">${card.rank}</div>
      <div class="card-suit-small">${card.suit}</div>
    </div>
    <div class="card-suit-big">${card.suit}</div>
    <div class="card-corner bottom">
      <div class="card-rank">${card.rank}</div>
      <div class="card-suit-small">${card.suit}</div>
    </div>`;
  return el;
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal(mode) {
  currentMode = mode;
  $('modal-error').textContent = '';
  $('inp-name').value = myName;
  $('inp-code').value = '';
  const titles = { create: 'Create Private Room', join: 'Join a Room', ai: 'Play vs Computer', random: 'Find Random Match' };
  $('modal-title').textContent = titles[mode] || 'Enter Your Name';
  $('inp-code').classList.toggle('hidden', mode !== 'join');
  $('modal-overlay').classList.remove('hidden');
  setTimeout(() => $('inp-name').focus(), 50);
}

function closeModal(e) {
  if (e && e.target !== $('modal-overlay')) return;
  $('modal-overlay').classList.add('hidden');
}

$('inp-name').addEventListener('keydown', e => { if (e.key === 'Enter') modalGo(); });
$('inp-code').addEventListener('keydown', e => { if (e.key === 'Enter') modalGo(); });

function modalGo() {
  const name = $('inp-name').value.trim();
  if (!name) { $('modal-error').textContent = 'Please enter your name.'; return; }
  myName = name;

  if (currentMode === 'create') {
    socket.emit('create-room', { name });
  } else if (currentMode === 'join') {
    const code = $('inp-code').value.trim().toUpperCase();
    if (!code) { $('modal-error').textContent = 'Please enter a room code.'; return; }
    socket.emit('join-room', { code, name });
  } else if (currentMode === 'ai') {
    socket.emit('join-ai', { name });
  } else if (currentMode === 'random') {
    socket.emit('join-random', { name });
    showScreen('screen-waiting');
    $('modal-overlay').classList.add('hidden');
    return;
  }
  $('modal-overlay').classList.add('hidden');
}

function cancelWaiting() {
  socket.emit('cancel-waiting');
  showScreen('screen-landing');
}

function goBack() { showScreen('screen-landing'); }

// ─── Lobby ────────────────────────────────────────────────────────────────────
function renderLobby(state) {
  $('lobby-code').textContent = state.code || roomCode || '——';
  const playersEl = $('lobby-players');
  playersEl.innerHTML = '';
  if (state.players) {
    state.players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'lobby-player-row';
      row.innerHTML = `<div class="player-dot"></div><span>${p.name}${i === 0 ? ' 👑' : ''}${p.id === myId ? ' (you)' : ''}</span>`;
      playersEl.appendChild(row);
    });
  }
  const isHost = state.players && state.players[0]?.id === myId;
  $('btn-start').style.display = isHost ? '' : 'none';
  $('lobby-status').style.display = isHost ? 'none' : '';
}

function copyLink() {
  const code = $('lobby-code').textContent;
  const url = `${window.location.origin}/?join=${code}`;
  navigator.clipboard.writeText(url)
    .then(() => toast('Invite link copied!', 'success'))
    .catch(() => prompt('Copy this link:', url));
}

function sendStartGame() { socket.emit('start-game'); }

// ─── First-Pick Rendering ─────────────────────────────────────────────────────
function renderFirstPick(state) {
  const poolEl = $('pick-pool');
  poolEl.innerHTML = '';

  const alreadyPicked = state.myPickIndex !== null;
  const allPicked = state.allPicked;

  (state.pickPool || []).forEach((slot) => {
    const slotEl = document.createElement('div');
    slotEl.className = 'pick-slot';

    let cardEl;
    if (slot.card) {
      // Face-up (my pick revealed, or all revealed)
      cardEl = makeCard(slot.card, { selectable: false });
    } else {
      // Face-down
      cardEl = document.createElement('div');
      cardEl.className = `card card-back${alreadyPicked || slot.picked ? ' no-hover' : ''}`;
      if (!alreadyPicked && !slot.picked) {
        cardEl.addEventListener('click', () => socket.emit('pick-first-card', { cardIndex: slot.index }));
      }
    }
    slotEl.appendChild(cardEl);

    // Label below
    const label = document.createElement('div');
    if (slot.pickedByPlayerName) {
      label.className = `pick-slot-label${slot.pickedByPlayerName === myName ? ' mine' : ''}`;
      label.textContent = slot.pickedByPlayerName;
    } else if (!slot.picked) {
      label.className = 'pick-slot-label';
      label.textContent = '—';
    }
    slotEl.appendChild(label);
    poolEl.appendChild(slotEl);
  });

  const resultsEl = $('pick-results');
  resultsEl.innerHTML = '';

  if (allPicked && state.pickReveal) {
    const reveal = state.pickReveal;

    if (reveal.type === 'winner') {
      const isMe = reveal.firstPlayerId === myId;
      const msg = document.createElement('div');
      msg.className = 'pick-winner-msg';
      msg.textContent = isMe ? '🎉 You go first!' : `${reveal.firstPlayerName} goes first!`;
      resultsEl.appendChild(msg);
    } else {
      const msg = document.createElement('div');
      msg.className = 'pick-redeal-msg';
      msg.textContent = '🔁 All tied! Redealing in a moment…';
      resultsEl.appendChild(msg);
    }

    // Show each player's pick value
    if (reveal.vals) {
      const list = document.createElement('div');
      list.className = 'pick-reveal-list';
      const maxUniqueVal = (() => {
        const counts = {};
        reveal.vals.forEach(v => counts[v.val] = (counts[v.val] || 0) + 1);
        const unique = Object.keys(counts).filter(k => counts[k] === 1).map(Number).sort((a,b)=>b-a);
        return unique[0] ?? -1;
      })();
      reveal.vals.forEach(v => {
        const isTied = reveal.vals.filter(x => x.val === v.val).length > 1;
        const isWinner = v.val === maxUniqueVal;
        const item = document.createElement('div');
        item.className = `pick-reveal-item${isWinner ? ' winner' : isTied ? ' tied' : ''}`;
        item.innerHTML = `<span>${v.name === myName ? '(you)' : v.name}</span>
          <span>${v.card ? v.card.rank + v.card.suit : '?'} = ${v.val}</span>
          ${isTied ? '<span>tied</span>' : isWinner ? '<span>⭐ goes first</span>' : ''}`;
        list.appendChild(item);
      });
      resultsEl.appendChild(list);
    }
  } else if (alreadyPicked) {
    const msg = document.createElement('p');
    msg.style.color = 'rgba(255,255,255,0.5)';
    msg.textContent = 'Waiting for others to pick…';
    resultsEl.appendChild(msg);
  } else {
    const msg = document.createElement('p');
    msg.style.color = 'rgba(255,255,255,0.6)';
    msg.textContent = 'Click any face-down card to pick it';
    resultsEl.appendChild(msg);
  }
}

// ─── Game Rendering ───────────────────────────────────────────────────────────
function renderGame(state) {
  gameState = state;
  const me = state.players.find(p => p.id === myId);
  if (!me) return;

  const current = state.players[state.currentPlayerIndex];
  isMyTurn = current?.id === myId;

  // Header
  $('header-round').textContent = `Round ${state.roundNumber}`;

  // Deck-empty lap badge
  const existing = document.querySelector('.last-lap-badge');
  if (existing) existing.remove();
  if (state.deckEmptyLap) {
    const badge = document.createElement('span');
    badge.className = 'last-lap-badge';
    badge.textContent = `⚠ Last lap (${state.players.length - (state.deckEmptyLapCount ?? 0)} turns left)`;
    $('game-header-left').appendChild(badge);
  }

  const scoresEl = $('header-scores');
  scoresEl.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = `score-chip${p.isCurrentPlayer ? ' current-player' : ''}`;
    chip.innerHTML = `<span class="chip-name">${p.name}</span><span class="chip-pts">${p.score}pts</span><span class="chip-name">${p.setCount ?? p.sets?.length ?? 0}✓</span>`;
    scoresEl.appendChild(chip);
  });

  $('turn-badge').textContent = isMyTurn ? '⭐ Your Turn' : `${current?.name}'s Turn`;
  $('turn-badge').style.borderColor = isMyTurn ? '#ffd700' : 'rgba(255,255,255,0.2)';

  // Opponents
  const oppsEl = $('opponents-row');
  oppsEl.innerHTML = '';
  state.players.filter(p => p.id !== myId).forEach(p => {
    const slot = document.createElement('div');
    slot.className = `opponent-slot${p.isCurrentPlayer ? ' opp-current' : ''}`;
    const cards = document.createElement('div');
    cards.className = 'opp-cards';
    for (let i = 0; i < (p.handCount ?? 5); i++) {
      cards.appendChild(makeCard(null, { faceDown: true, small: true }));
    }
    slot.innerHTML = `<div class="opp-name">${p.name}${p.isCurrentPlayer ? ' ⭐' : ''}</div>`;
    slot.appendChild(cards);
    slot.innerHTML += `<div class="opp-info">${p.setCount ?? 0} sets • ${p.score} pts</div>`;
    oppsEl.appendChild(slot);
  });

  // Deck
  $('deck-label').textContent = `${state.deckCount} card${state.deckCount !== 1 ? 's' : ''}`;
  $('deck-vis').innerHTML = state.deckCount > 0
    ? '<div class="card card-back"></div>'
    : '<div style="color:rgba(255,255,255,0.3);font-size:0.75rem;text-align:center">Empty</div>';

  renderCarcass(state.carcass);

  // Player info
  $('you-name').textContent = me.name || 'You';
  $('you-score').textContent = `${me.score} pts`;
  $('you-sets').textContent = `${me.sets?.length ?? 0} sets`;

  renderYourSets(me.sets || []);
  renderHand(me.hand || []);
  renderActionPanel(state.canReplace ?? false);

  // Log
  const logEl = $('game-log');
  logEl.innerHTML = '';
  (state.log || []).forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = `log-entry${i === 0 ? ' highlight' : ''}`;
    div.textContent = entry;
    logEl.appendChild(div);
  });
}

function renderCarcass(cards) {
  const el = $('carcass-cards');
  el.innerHTML = '';
  (cards || []).forEach(card => {
    const cardEl = makeCard(card, {
      selectable: isMyTurn && swapMode,
      takeSelected: takeIds.has(card.id),
    });
    if (isMyTurn && swapMode) {
      cardEl.addEventListener('click', () => toggleTake(card.id, cardEl));
    }
    el.appendChild(cardEl);
  });
}

function renderHand(cards) {
  const el = $('hand-cards');
  el.innerHTML = '';
  (cards || []).filter(Boolean).forEach(card => {
    const isSelected = !swapMode && selectedHandIds.has(card.id);
    const isGive = swapMode && giveIds.has(card.id);
    const cardEl = makeCard(card, {
      selectable: isMyTurn,
      selected: isSelected,
      giveSelected: isGive,
    });
    if (isMyTurn) {
      cardEl.addEventListener('click', () => {
        if (swapMode) toggleGive(card.id, cardEl);
        else toggleHandSelect(card.id, cardEl);
      });
    }
    el.appendChild(cardEl);
  });
}

function renderYourSets(sets) {
  const el = $('your-sets-row');
  el.innerHTML = '';
  sets.forEach(set => {
    const group = document.createElement('div');
    group.className = 'your-set-group';
    set.forEach(card => group.appendChild(makeCard(card, { selectable: false })));
    el.appendChild(group);
  });
}

function renderActionPanel(canReplace) {
  $('panel-swap').classList.toggle('hidden', !swapMode);
  $('panel-normal').classList.toggle('hidden', swapMode);

  if (!swapMode) {
    const me = gameState?.players.find(p => p.id === myId);
    const handCards = (me?.hand || []).filter(c => c && selectedHandIds.has(c.id));

    let infoText = 'Select cards from your hand to make 21';
    if (selectedHandIds.size > 0) {
      const sum = selectionSum(handCards);
      infoText = `Selected: ${handCards.map(c => c.rank + c.suit).join(' + ')} = ${sum}`;
      if (canMake21(handCards)) infoText += ' ✓';
    }
    $('sel-info').textContent = infoText;

    $('btn-claim').disabled = !isMyTurn || !canMake21(handCards);
    $('btn-swap-mode').disabled = !isMyTurn || (gameState?.hasActed ?? false);

    // Replace hand: only when server says it's valid (canReplace flag)
    const replaceBtn = $('btn-replace');
    replaceBtn.disabled = !isMyTurn || !(canReplace);
    replaceBtn.style.opacity = replaceBtn.disabled ? '0.35' : '1';
    replaceBtn.title = canReplace
      ? 'Replace your 5 cards with 5 new ones from the deck (deck is reshuffled)'
      : 'Only available when you cannot make 21 with any combination of your hand + Carcass';

    $('btn-end-turn').disabled = !isMyTurn;
  } else {
    const tc = takeIds.size, gc = giveIds.size;
    let swapInfo = tc === 0 && gc === 0
      ? 'Click Carcass cards (yellow) and hand cards (orange) to swap'
      : `Taking ${tc} from Carcass, giving ${gc} from hand${tc > 0 && gc > 0 && tc !== gc ? ' — must be equal!' : ''}`;
    $('swap-info').textContent = swapInfo;
    $('btn-confirm-swap').disabled = tc === 0 || gc === 0 || tc !== gc;
  }
}

// ─── Card Selection ───────────────────────────────────────────────────────────
function toggleHandSelect(id, el) {
  if (selectedHandIds.has(id)) { selectedHandIds.delete(id); el.classList.remove('selected'); }
  else { selectedHandIds.add(id); el.classList.add('selected'); }
  renderActionPanel(gameState?.canReplace ?? false);
}

function toggleTake(id, el) {
  if (takeIds.has(id)) { takeIds.delete(id); el.classList.remove('take-selected'); }
  else { takeIds.add(id); el.classList.add('take-selected'); }
  renderActionPanel(gameState?.canReplace ?? false);
}

function toggleGive(id, el) {
  if (giveIds.has(id)) { giveIds.delete(id); el.classList.remove('give-selected'); }
  else { giveIds.add(id); el.classList.add('give-selected'); }
  renderActionPanel(gameState?.canReplace ?? false);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
function claimSet() {
  if (!isMyTurn || selectedHandIds.size < 2) return;
  socket.emit('game-action', { type: 'claim-set', cardIds: [...selectedHandIds] });
  selectedHandIds.clear();
}

function enterSwapMode() {
  if (!isMyTurn || (gameState?.hasActed ?? false)) return;
  swapMode = true;
  takeIds.clear(); giveIds.clear(); selectedHandIds.clear();
  if (gameState) renderGame(gameState);
}

function cancelSwapMode() {
  swapMode = false;
  takeIds.clear(); giveIds.clear();
  if (gameState) renderGame(gameState);
}

function confirmSwap() {
  if (takeIds.size === 0 || giveIds.size === 0 || takeIds.size !== giveIds.size) return;
  socket.emit('game-action', { type: 'swap-carcass', takeIds: [...takeIds], giveIds: [...giveIds] });
  swapMode = false; takeIds.clear(); giveIds.clear();
}

function replaceHand() {
  if (!isMyTurn) return;
  socket.emit('game-action', { type: 'replace-hand' });
  selectedHandIds.clear();
}

function endTurn() {
  if (!isMyTurn) return;
  socket.emit('game-action', { type: 'end-turn' });
  swapMode = false; takeIds.clear(); giveIds.clear(); selectedHandIds.clear();
}

// ─── Round / Game End Screens ─────────────────────────────────────────────────
function renderRoundEnd(state) {
  const n = state.players.length;
  const sorted = [...state.players].sort((a, b) => (b.setCount ?? 0) - (a.setCount ?? 0));

  // Check for total tie flag in log
  const isTotalTie = state.log && state.log.some(l => l.includes('Total tie'));

  let html = '';

  if (isTotalTie) {
    html += `<div style="color:#ff9800;font-size:1rem;margin-bottom:12px">🤝 Total tie — no points awarded, round restarts!</div>`;
  }

  html += `<table class="scores-table">
    <thead><tr><th>Player</th><th>Sets</th><th>Score</th></tr></thead><tbody>`;
  sorted.forEach((p, i) => {
    html += `<tr${i === 0 && !isTotalTie ? ' class="winner"' : ''}>
      <td>${p.name}${p.id === myId ? ' (you)' : ''}</td>
      <td>${p.setCount ?? 0}</td>
      <td>${p.score} pts</td>
    </tr>`;
  });
  html += `</tbody></table><p style="margin-top:12px;font-size:0.78rem;color:rgba(255,255,255,0.4)">Win at ${2 * n} points</p>`;
  $('round-results').innerHTML = html;
  $('ready-status').textContent = '';
  $('btn-ready').disabled = false;
  showScreen('screen-round-end');
}

function renderGameEnd(state) {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  $('game-end-title').textContent = winner.id === myId ? '🏆 You Win!' : `${winner.name} Wins!`;
  $('winner-display').textContent = winner.id === myId ? '🎉' : '🃏';

  let html = `<table class="scores-table">
    <thead><tr><th>Player</th><th>Score</th></tr></thead><tbody>`;
  sorted.forEach((p, i) => {
    html += `<tr${i === 0 ? ' class="winner"' : ''}>
      <td>${p.name}${p.id === myId ? ' (you)' : ''}</td>
      <td>${p.score} pts</td>
    </tr>`;
  });
  html += '</tbody></table>';
  $('final-scores').innerHTML = html;
  showScreen('screen-game-end');
}

function readyNextRound() {
  $('btn-ready').disabled = true;
  $('ready-status').textContent = 'Waiting for others…';
  socket.emit('ready-next-round');
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('connect', () => { myId = socket.id; });

socket.on('room-joined', ({ code }) => {
  roomCode = code;
  showScreen('screen-lobby');
  $('lobby-code').textContent = code;
});

socket.on('cancelled', () => { showScreen('screen-landing'); });

socket.on('player-joined', ({ name }) => { toast(`${name} joined the room!`); });
socket.on('player-left', ({ name }) => { toast(`${name} left the game`); });
socket.on('player-disconnected', ({ name }) => { toast(`${name} disconnected`); });

socket.on('game-state', (state) => {
  const prevPhase = gameState?.phase;
  gameState = state;

  if (state.phase === 'lobby') {
    renderLobby(state);
    if (!$('screen-lobby').classList.contains('active')) showScreen('screen-lobby');

  } else if (state.phase === 'first_pick') {
    showScreen('screen-first-pick');
    renderFirstPick(state);

  } else if (state.phase === 'playing') {
    // Clear all selection state when entering a fresh playing phase
    if (prevPhase !== 'playing') {
      selectedHandIds.clear();
      takeIds.clear();
      giveIds.clear();
    }
    swapMode = false;
    showScreen('screen-game');
    renderGame(state);
    // Refresh mod stats panel if open
    if (modPanelOpen) renderModStatsPanel(state);
    // Trigger sim step if active and it's our turn
    if (simActive && isMyTurn) scheduleSimStep();

  } else if (state.phase === 'round_end') {
    renderRoundEnd(state);
    // Sim auto-ready for next round
    if (simActive && simType === 'rounds') {
      simRemaining--;
      updateSimStatus();
      if (simRemaining > 0) {
        setTimeout(readyNextRound, simSpeed());
      } else {
        stopSim();
      }
    }

  } else if (state.phase === 'game_end') {
    renderGameEnd(state);
  }
});

socket.on('error', ({ message }) => { toast(message, 'error'); });

// ─── Exit Game ───────────────────────────────────────────────────────────────
function exitGame() {
  const confirmed = confirm('Leave the game? Your progress will be lost.');
  if (!confirmed) return;
  socket.emit('leave-room');
  // Reset local state
  swapMode = false;
  selectedHandIds.clear();
  takeIds.clear();
  giveIds.clear();
  gameState = null;
  roomCode = null;
  showScreen('screen-landing');
}

// ─── Theme Switcher ───────────────────────────────────────────────────────────
const THEMES = ['theme-green', 'theme-dark', 'theme-blue', 'theme-red'];
const THEME_LABELS = { 'theme-green': '🟢', 'theme-dark': '⚫', 'theme-blue': '🔵', 'theme-red': '🔴' };
let currentTheme = localStorage.getItem('carcass-theme') || 'theme-green';

function applyTheme(theme) {
  THEMES.forEach(t => document.body.classList.remove(t));
  document.body.classList.add(theme);
  currentTheme = theme;
  localStorage.setItem('carcass-theme', theme);
  const btn = $('btn-theme');
  if (btn) btn.textContent = THEME_LABELS[theme] + ' Theme';
}

function cycleTheme() {
  const idx = THEMES.indexOf(currentTheme);
  applyTheme(THEMES[(idx + 1) % THEMES.length]);
}

// Apply saved theme on load
applyTheme(currentTheme);

// ─── Sim AI Helpers ───────────────────────────────────────────────────────────
function simFindBestClaim(hand) {
  const n = hand.length;
  for (let mask = 3; mask < (1 << n); mask++) {
    const subset = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(hand[i]);
    if (subset.length >= 2 && canMake21(subset)) return subset.map(c => c.id);
  }
  return null;
}

function simFindBestSwap(hand, carcass) {
  if (!carcass.length || !hand.length) return null;
  // 1-for-1: find swap that enables a 21 claim
  for (const cCard of carcass) {
    for (const hCard of hand) {
      const newHand = [...hand.filter(c => c.id !== hCard.id), cCard];
      if (simFindBestClaim(newHand)) return { takeIds: [cCard.id], giveIds: [hCard.id] };
    }
  }
  // 2-for-2
  for (let i = 0; i < carcass.length - 1; i++) {
    for (let j = i + 1; j < carcass.length; j++) {
      for (let a = 0; a < hand.length - 1; a++) {
        for (let b = a + 1; b < hand.length; b++) {
          const newHand = [...hand.filter(c => c.id !== hand[a].id && c.id !== hand[b].id), carcass[i], carcass[j]];
          if (simFindBestClaim(newHand)) return { takeIds: [carcass[i].id, carcass[j].id], giveIds: [hand[a].id, hand[b].id] };
        }
      }
    }
  }
  return null;
}

// ─── Sim Mode ─────────────────────────────────────────────────────────────────
let simActive = false;
let simType = 'turns';
let simRemaining = 0;
let simStepScheduled = false;

function simSpeed() { return parseInt($('sim-speed-sel')?.value ?? 700); }

function updateSimStatus() {
  const typeLabel = { turns: 'turn', moves: 'move', rounds: 'round' }[simType] || simType;
  const plural = simRemaining !== 1 ? 's' : '';
  $('sim-status-text').textContent = `${simRemaining} ${typeLabel}${plural} left`;
}

function setSimType(type) {
  simType = type;
  document.querySelectorAll('.sim-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
}

function startSim() {
  const count = Math.max(1, parseInt($('sim-count')?.value) || 5);
  simRemaining = count;
  simActive = true;
  $('sim-btn-row').classList.add('hidden');
  $('sim-running-row').classList.remove('hidden');
  updateSimStatus();
  toast(`Sim started: ${count} ${simType}`, 'info', 2000);
  if (isMyTurn && gameState?.phase === 'playing') scheduleSimStep();
}

function stopSim() {
  simActive = false;
  simStepScheduled = false;
  $('sim-btn-row').classList.remove('hidden');
  $('sim-running-row').classList.add('hidden');
  toast('Sim stopped', 'info', 1500);
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

  // 1. Claim any 21 in current hand
  const claimIds = simFindBestClaim(hand);
  if (claimIds) {
    selectedHandIds.clear();
    socket.emit('game-action', { type: 'claim-set', cardIds: claimIds });
    if (simType === 'moves') { simRemaining--; updateSimStatus(); }
    return; // next step fires from game-state update
  }

  // 2. Swap if it would enable a 21
  if (!gameState.hasActed && (gameState.carcass || []).length > 0) {
    const swap = simFindBestSwap(hand, gameState.carcass);
    if (swap) {
      swapMode = false; takeIds.clear(); giveIds.clear();
      socket.emit('game-action', { type: 'swap-carcass', takeIds: swap.takeIds, giveIds: swap.giveIds });
      if (simType === 'moves') { simRemaining--; updateSimStatus(); }
      return;
    }
  }

  // 3. End turn
  socket.emit('game-action', { type: 'end-turn' });
  swapMode = false; takeIds.clear(); giveIds.clear(); selectedHandIds.clear();
  if (simType === 'turns' || simType === 'moves') {
    simRemaining--;
    updateSimStatus();
  }
  if (simRemaining <= 0) stopSim();
}

// ─── Mod Panel ────────────────────────────────────────────────────────────────
let modPanelOpen = false;

function toggleModPanel() {
  modPanelOpen = !modPanelOpen;
  $('mod-panel').classList.toggle('hidden', !modPanelOpen);
  if (modPanelOpen && gameState) renderModStatsPanel(gameState);
}

function closeModPanel() {
  modPanelOpen = false;
  $('mod-panel').classList.add('hidden');
}

function renderModStatsPanel(state) {
  const el = $('mod-stats-list');
  if (!el || !state?.players) return;
  el.innerHTML = '';
  state.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'mod-player-row';
    row.innerHTML = `
      <div class="mod-player-name">${p.name}${p.id === myId ? ' (you)' : ''}${p.isAI ? ' 🤖' : ''}</div>
      <div class="mod-stat-fields">
        <label>Score<input type="number" class="mod-score" value="${p.score}" min="0" max="9999" data-id="${p.id}"></label>
        <label>Sets<input type="number" class="mod-sets" value="${p.setCount ?? 0}" min="0" max="99" data-id="${p.id}"></label>
      </div>
      <button class="btn btn-amber mod-apply-btn" data-id="${p.id}">Apply</button>`;
    row.querySelector('.mod-apply-btn').addEventListener('click', () => applyModStats(p.id, row));
    el.appendChild(row);
  });
}

function applyModStats(playerId, row) {
  const score = parseInt(row.querySelector('.mod-score').value);
  const sets  = parseInt(row.querySelector('.mod-sets').value);
  socket.emit('mod-set-stats', { playerId, score, sets });
  toast('Stats updated', 'success', 1500);
}

// ─── URL-based auto-join ──────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    $('join-link-hint').textContent = `Joining room ${joinCode.toUpperCase()}…`;
    currentMode = 'join';
    openModal('join');
    $('inp-code').value = joinCode.toUpperCase();
  }
});
