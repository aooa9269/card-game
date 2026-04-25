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
  const cdrawMode = gameState?.waitingForCarcassDraw;
  (cards || []).forEach(card => {
    const cardEl = makeCard(card, {
      selectable: isMyTurn && (swapMode || cdrawMode),
      takeSelected: takeIds.has(card.id),
    });
    if (isMyTurn && swapMode) {
      cardEl.addEventListener('click', () => toggleTake(card.id, cardEl));
    } else if (isMyTurn && cdrawMode) {
      cardEl.addEventListener('click', () => drawFromCarcass(card.id));
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
  const cdrawMode = gameState?.waitingForCarcassDraw;
  $('panel-normal').classList.toggle('hidden', swapMode || cdrawMode);
  $('panel-swap').classList.toggle('hidden', !swapMode);
  $('panel-carcass-draw').classList.toggle('hidden', !cdrawMode);

  if (cdrawMode) {
    const me = gameState?.players.find(p => p.id === myId);
    const handSize = me?.hand?.length ?? 0;
    $('cdraw-info').textContent = handSize >= 5
      ? 'Hand full (5 cards). Click Done Drawing.'
      : `Hand has ${handSize} card${handSize !== 1 ? 's' : ''} — click a Carcass card to draw it`;
  } else if (!swapMode) {
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
    $('btn-swap-mode').disabled = !isMyTurn;

    // Replace hand: only when server says it's valid (canReplace flag)
    const replaceBtn = $('btn-replace');
    replaceBtn.disabled = !isMyTurn || !canReplace;
    replaceBtn.style.opacity = replaceBtn.disabled ? '0.35' : '1';
    replaceBtn.title = canReplace
      ? 'Replace your 5 cards with 5 new ones from the deck'
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
  if (!isMyTurn) return;
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

function drawFromCarcass(cardId) {
  if (!isMyTurn || !gameState?.waitingForCarcassDraw) return;
  socket.emit('game-action', { type: 'draw-from-carcass', cardId });
}

function finishCarcassDraw() {
  if (!isMyTurn) return;
  socket.emit('game-action', { type: 'finish-carcass-draw' });
}

// ─── Round / Game End Screens ─────────────────────────────────────────────────
function renderRoundEnd(state) {
  const n = state.players.length;
  const sorted = [...state.players].sort((a, b) => (b.setCount ?? 0) - (a.setCount ?? 0));

  const isTotalTie = !!(state.totalTie);

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
  gameState = state;

  if (state.phase === 'lobby') {
    renderLobby(state);
    if (!$('screen-lobby').classList.contains('active')) showScreen('screen-lobby');

  } else if (state.phase === 'first_pick') {
    showScreen('screen-first-pick');
    renderFirstPick(state);

  } else if (state.phase === 'playing') {
    swapMode = false;
    showScreen('screen-game');
    renderGame(state);

  } else if (state.phase === 'round_end') {
    renderRoundEnd(state);

  } else if (state.phase === 'game_end') {
    renderGameEnd(state);
  }
});

socket.on('error', ({ message }) => { toast(message, 'error'); });

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Deck Theme System ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const LS_DECK = 'carcass-deck-theme';

const DECK_PRESETS = [
  {
    id: 'classic-blue', name: 'Classic Blue',
    faceBackground: '#fffef5', faceRedColor: '#cc2222', faceBlackColor: '#111111', faceBorderColor: '#cccccc',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#1a4a8a 0%,#0d2a5a 100%)', backBorderColor: '#2a6aaa',
    backPattern: 'diamonds', backPatternColor: 'rgba(255,255,255,0.13)', customBackImage: null,
  },
  {
    id: 'crimson', name: 'Crimson',
    faceBackground: '#fff8f8', faceRedColor: '#aa0000', faceBlackColor: '#111111', faceBorderColor: '#e0b0b0',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#8b0000 0%,#3d0000 100%)', backBorderColor: '#cc3333',
    backPattern: 'crosshatch', backPatternColor: 'rgba(255,200,200,0.11)', customBackImage: null,
  },
  {
    id: 'midnight', name: 'Midnight',
    faceBackground: '#1a1a2e', faceRedColor: '#ff6b6b', faceBlackColor: '#c8c8ff', faceBorderColor: '#444466',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#16213e 0%,#0f3460 50%,#533483 100%)', backBorderColor: '#8888cc',
    backPattern: 'stars', backPatternColor: 'rgba(160,160,255,0.15)', customBackImage: null,
  },
  {
    id: 'gold-rush', name: 'Gold Rush',
    faceBackground: '#fffde7', faceRedColor: '#b71c1c', faceBlackColor: '#3e2723', faceBorderColor: '#d4a017',
    fontFamily: "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
    backGradient: 'linear-gradient(135deg,#b8860b 0%,#8b6914 40%,#c9a227 100%)', backBorderColor: '#d4af37',
    backPattern: 'diamonds', backPatternColor: 'rgba(255,255,160,0.15)', customBackImage: null,
  },
  {
    id: 'forest', name: 'Forest',
    faceBackground: '#f1f8e9', faceRedColor: '#880000', faceBlackColor: '#1b5e20', faceBorderColor: '#81c784',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#1b5e20 0%,#2e7d32 50%,#1b5e20 100%)', backBorderColor: '#66bb6a',
    backPattern: 'waves', backPatternColor: 'rgba(144,238,144,0.14)', customBackImage: null,
  },
  {
    id: 'ocean', name: 'Ocean',
    faceBackground: '#e8f4f8', faceRedColor: '#c62828', faceBlackColor: '#006064', faceBorderColor: '#80deea',
    fontFamily: "'Trebuchet MS', sans-serif",
    backGradient: 'linear-gradient(135deg,#006064 0%,#00838f 50%,#004d40 100%)', backBorderColor: '#4dd0e1',
    backPattern: 'waves', backPatternColor: 'rgba(100,220,255,0.13)', customBackImage: null,
  },
  {
    id: 'fire', name: 'Fire',
    faceBackground: '#fff8f0', faceRedColor: '#bf360c', faceBlackColor: '#3e2723', faceBorderColor: '#ff8a65',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#bf360c 0%,#e64a19 40%,#ff6f00 100%)', backBorderColor: '#ff8a50',
    backPattern: 'stripes', backPatternColor: 'rgba(255,200,80,0.13)', customBackImage: null,
  },
  {
    id: 'neon', name: 'Neon',
    faceBackground: '#0d0d0d', faceRedColor: '#ff0080', faceBlackColor: '#00ff88', faceBorderColor: '#00ff88',
    fontFamily: "'Courier New', monospace",
    backGradient: 'linear-gradient(135deg,#050510 0%,#0d0d1a 100%)', backBorderColor: '#00ff88',
    backPattern: 'grid', backPatternColor: 'rgba(0,255,136,0.09)', customBackImage: null,
  },
  {
    id: 'royal', name: 'Royal Purple',
    faceBackground: '#faf5ff', faceRedColor: '#880088', faceBlackColor: '#4a0080', faceBorderColor: '#ce93d8',
    fontFamily: "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
    backGradient: 'linear-gradient(135deg,#4a148c 0%,#6a1b9a 50%,#38006b 100%)', backBorderColor: '#ce93d8',
    backPattern: 'diamonds', backPatternColor: 'rgba(220,170,255,0.14)', customBackImage: null,
  },
  {
    id: 'minimal', name: 'Minimal',
    faceBackground: '#ffffff', faceRedColor: '#d32f2f', faceBlackColor: '#212121', faceBorderColor: '#bdbdbd',
    fontFamily: 'Arial, Helvetica, sans-serif',
    backGradient: 'linear-gradient(135deg,#e0e0e0 0%,#bdbdbd 100%)', backBorderColor: '#9e9e9e',
    backPattern: 'none', backPatternColor: 'transparent', customBackImage: null,
  },
  {
    id: 'retro', name: 'Retro',
    faceBackground: '#f5e6cc', faceRedColor: '#8b1a1a', faceBlackColor: '#2c1810', faceBorderColor: '#a0785a',
    fontFamily: "'Times New Roman', Times, serif",
    backGradient: 'linear-gradient(135deg,#6b4226 0%,#8b5e3c 50%,#5c3317 100%)', backBorderColor: '#d2a679',
    backPattern: 'crosshatch', backPatternColor: 'rgba(255,220,170,0.12)', customBackImage: null,
  },
  {
    id: 'cyberpunk', name: 'Cyberpunk',
    faceBackground: '#0a0a1a', faceRedColor: '#ff2d78', faceBlackColor: '#00e5ff', faceBorderColor: '#ff2d78',
    fontFamily: "'Courier New', monospace",
    backGradient: 'linear-gradient(135deg,#0a0a1a 0%,#1a0a2e 100%)', backBorderColor: '#ff2d78',
    backPattern: 'grid', backPatternColor: 'rgba(255,45,120,0.09)', customBackImage: null,
  },
  {
    id: 'rose', name: 'Rose',
    faceBackground: '#fff0f5', faceRedColor: '#c2185b', faceBlackColor: '#880e4f', faceBorderColor: '#f48fb1',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#c2185b 0%,#e91e8c 50%,#880e4f 100%)', backBorderColor: '#f48fb1',
    backPattern: 'dots', backPatternColor: 'rgba(255,180,210,0.18)', customBackImage: null,
  },
  {
    id: 'arctic', name: 'Arctic',
    faceBackground: '#f0f8ff', faceRedColor: '#1565c0', faceBlackColor: '#0d47a1', faceBorderColor: '#90caf9',
    fontFamily: "'Trebuchet MS', sans-serif",
    backGradient: 'linear-gradient(135deg,#90caf9 0%,#bbdefb 50%,#42a5f5 100%)', backBorderColor: '#42a5f5',
    backPattern: 'dots', backPatternColor: 'rgba(100,180,255,0.2)', customBackImage: null,
  },
  {
    id: 'obsidian', name: 'Obsidian',
    faceBackground: '#1a1a1a', faceRedColor: '#ff4444', faceBlackColor: '#d4af37', faceBorderColor: '#333333',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#000000 0%,#1a1a1a 100%)', backBorderColor: '#d4af37',
    backPattern: 'diamonds', backPatternColor: 'rgba(212,175,55,0.13)', customBackImage: null,
  },
  {
    id: 'sakura', name: 'Sakura',
    faceBackground: '#fff5f9', faceRedColor: '#d63384', faceBlackColor: '#6f42c1', faceBorderColor: '#ffb3d1',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#f8a5c2 0%,#f368a9 50%,#f8a5c2 100%)', backBorderColor: '#f368a9',
    backPattern: 'dots', backPatternColor: 'rgba(255,255,255,0.3)', customBackImage: null,
  },
  {
    id: 'slate', name: 'Slate',
    faceBackground: '#f8f9fa', faceRedColor: '#dc3545', faceBlackColor: '#343a40', faceBorderColor: '#adb5bd',
    fontFamily: "'Trebuchet MS', sans-serif",
    backGradient: 'linear-gradient(135deg,#495057 0%,#343a40 100%)', backBorderColor: '#6c757d',
    backPattern: 'stripes', backPatternColor: 'rgba(255,255,255,0.07)', customBackImage: null,
  },
  {
    id: 'halloween', name: 'Halloween',
    faceBackground: '#1a0a00', faceRedColor: '#ff6600', faceBlackColor: '#cc33ff', faceBorderColor: '#ff6600',
    fontFamily: 'Georgia, serif',
    backGradient: 'linear-gradient(135deg,#1a0a00 0%,#3d1a00 50%,#0d0020 100%)', backBorderColor: '#ff6600',
    backPattern: 'stars', backPatternColor: 'rgba(255,102,0,0.18)', customBackImage: null,
  },
];

// ── Pattern generator ─────────────────────────────────────────────────────────
function generatePatternURL(type, color) {
  if (!type || type === 'none') return 'none';
  const enc = s => s.replace(/#/g, '%23').replace(/"/g, "'");
  const svg = (body, w = 20, h = 20) =>
    `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>${enc(body)}</svg>")`;
  switch (type) {
    case 'diamonds':
      return svg(`<polygon points="10,1 19,10 10,19 1,10" fill="${color}"/>`);
    case 'dots':
      return svg(`<circle cx="10" cy="10" r="3.5" fill="${color}"/>`);
    case 'stripes':
      return svg(`<line x1="0" y1="0" x2="10" y2="10" stroke="${color}" stroke-width="1.8"/>` +
                 `<line x1="10" y1="0" x2="20" y2="10" stroke="${color}" stroke-width="1.8"/>`);
    case 'crosshatch':
      return svg(`<line x1="0" y1="0" x2="20" y2="20" stroke="${color}" stroke-width="1"/>` +
                 `<line x1="20" y1="0" x2="0" y2="20" stroke="${color}" stroke-width="1"/>`);
    case 'grid':
      return svg(`<line x1="10" y1="0" x2="10" y2="20" stroke="${color}" stroke-width="0.6"/>` +
                 `<line x1="0" y1="10" x2="20" y2="10" stroke="${color}" stroke-width="0.6"/>`);
    case 'waves':
      return svg(`<path d="M0 10 Q5 3 10 10 Q15 17 20 10" stroke="${color}" stroke-width="1.5" fill="none"/>`, 20, 20);
    case 'stars':
      return svg(`<text x="3" y="15" font-size="14" fill="${color}">✦</text>`);
    default: return 'none';
  }
}

// ── Apply theme to CSS vars ───────────────────────────────────────────────────
function applyDeckTheme(theme) {
  let el = document.getElementById('deck-theme-style');
  if (!el) { el = document.createElement('style'); el.id = 'deck-theme-style'; document.head.appendChild(el); }

  const backBg = theme.customBackImage
    ? `url(${theme.customBackImage}) center/cover no-repeat`
    : theme.backGradient;
  const pat = generatePatternURL(theme.backPattern, theme.backPatternColor);

  el.textContent = `:root {
    --card-face-bg:     ${theme.faceBackground};
    --card-red:         ${theme.faceRedColor};
    --card-black:       ${theme.faceBlackColor};
    --card-face-border: ${theme.faceBorderColor};
    --card-font:        ${theme.fontFamily};
    --back-bg:          ${backBg};
    --back-border:      ${theme.backBorderColor};
    --back-pattern:     ${pat};
  }`;
}

// ── Active & pending theme state ──────────────────────────────────────────────
let _savedTheme   = null;   // last confirmed saved theme
let _pendingTheme = null;   // unsaved edits while modal is open

function loadSavedTheme() {
  try { _savedTheme = JSON.parse(localStorage.getItem(LS_DECK)); } catch(e) {}
  if (!_savedTheme) _savedTheme = DECK_PRESETS[0];
  applyDeckTheme(_savedTheme);
}

// ── Modal open / close ────────────────────────────────────────────────────────
function openDeckModal() {
  _pendingTheme = JSON.parse(JSON.stringify(_savedTheme));
  applyDeckTheme(_pendingTheme);
  switchDeckTab('presets');
  renderPresetGrid();
  $('deck-modal').classList.remove('hidden');
}

function closeDeckModal(e) {
  if (e && e.target !== $('deck-modal')) return;
  cancelDeckModal();
}

function cancelDeckModal() {
  applyDeckTheme(_savedTheme);   // revert
  $('deck-modal').classList.add('hidden');
}

function saveDeckTheme() {
  _savedTheme = JSON.parse(JSON.stringify(_pendingTheme));
  try { localStorage.setItem(LS_DECK, JSON.stringify(_savedTheme)); } catch(e) {}
  applyDeckTheme(_savedTheme);
  $('deck-modal').classList.add('hidden');
  toast('Deck style saved!', 'success');
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchDeckTab(tab) {
  ['presets','custom'].forEach(t => {
    $(`dtab-${t}`).classList.toggle('active', t === tab);
    $(`deck-tab-${t}`).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'custom') syncCustomInputsToTheme(_pendingTheme);
}

// ── Preset grid ───────────────────────────────────────────────────────────────
function renderPresetGrid() {
  const grid = $('deck-presets-grid');
  grid.innerHTML = '';
  DECK_PRESETS.forEach(preset => {
    const item = document.createElement('div');
    item.className = 'deck-preset-item' + (_pendingTheme.id === preset.id ? ' selected' : '');
    item.onclick = () => selectPreset(preset);

    // Mini card-back preview
    const pat = generatePatternURL(preset.backPattern, preset.backPatternColor);
    const mini = document.createElement('div');
    mini.className = 'deck-preset-back';
    mini.style.cssText = `background:${preset.backGradient}; border-color:${preset.backBorderColor};`;
    mini.style.setProperty('--mini-pat', pat);
    mini.style.setProperty('background-image', pat === 'none' ? 'none' : pat + `, ${preset.backGradient}`);
    // Fallback: just use gradient
    mini.style.background = preset.backGradient;
    if (pat !== 'none') {
      mini.style.backgroundImage = `${pat}, ${preset.backGradient}`;
      mini.style.backgroundSize = '14px 14px, 100% 100%';
    }

    const label = document.createElement('div');
    label.className = 'deck-preset-name';
    label.textContent = preset.name;

    item.appendChild(mini);
    item.appendChild(label);
    grid.appendChild(item);
  });
}

function selectPreset(preset) {
  _pendingTheme = JSON.parse(JSON.stringify(preset));
  applyDeckTheme(_pendingTheme);
  // Refresh selection highlight
  document.querySelectorAll('.deck-preset-item').forEach((el, i) => {
    el.classList.toggle('selected', DECK_PRESETS[i]?.id === preset.id);
  });
}

// ── Custom tab sync ───────────────────────────────────────────────────────────
function hexFromGradient(grad, which) {
  // Extract first/last colour from "linear-gradient(..., #hex ..." strings
  const matches = grad.match(/#[0-9a-fA-F]{3,6}/g);
  if (!matches) return '#000000';
  return which === 'end' ? matches[matches.length - 1] : matches[0];
}

function syncCustomInputsToTheme(theme) {
  $('cust-back-c1').value    = hexFromGradient(theme.backGradient, 'start');
  $('cust-back-c2').value    = hexFromGradient(theme.backGradient, 'end');
  $('cust-back-border').value = theme.backBorderColor.startsWith('#') ? theme.backBorderColor : '#2a6aaa';
  $('cust-back-pattern').value = theme.backPattern || 'none';
  // Pattern color: extract a hex from rgba or use fallback
  const pcMatch = theme.backPatternColor?.match(/#[0-9a-fA-F]{3,6}/);
  $('cust-pattern-color').value = pcMatch ? pcMatch[0] : '#ffffff';
  $('cust-face-bg').value     = theme.faceBackground.startsWith('#') ? theme.faceBackground : '#fffef5';
  $('cust-face-red').value    = theme.faceRedColor;
  $('cust-face-black').value  = theme.faceBlackColor;
  $('cust-face-border').value = theme.faceBorderColor.startsWith('#') ? theme.faceBorderColor : '#cccccc';
  // Font: find matching option
  const fontSel = $('cust-font');
  const match = [...fontSel.options].find(o => o.value === theme.fontFamily);
  fontSel.value = match ? match.value : fontSel.options[0].value;
  // Back image thumb
  const thumb = $('cust-back-thumb');
  if (theme.customBackImage) { thumb.src = theme.customBackImage; thumb.style.display = 'block'; }
  else { thumb.style.display = 'none'; }
}

function updateCustomTheme() {
  const c1 = $('cust-back-c1').value;
  const c2 = $('cust-back-c2').value;
  const pHex = $('cust-pattern-color').value;
  const pat = $('cust-back-pattern').value;

  _pendingTheme = {
    ..._pendingTheme,
    id: 'custom',
    name: 'Custom',
    faceBackground:  $('cust-face-bg').value,
    faceRedColor:    $('cust-face-red').value,
    faceBlackColor:  $('cust-face-black').value,
    faceBorderColor: $('cust-face-border').value,
    fontFamily:      $('cust-font').value,
    backGradient:    `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`,
    backBorderColor: $('cust-back-border').value,
    backPattern:     pat,
    backPatternColor: pHex + '33',  // add ~20% opacity
  };
  applyDeckTheme(_pendingTheme);
  // Deselect presets
  document.querySelectorAll('.deck-preset-item').forEach(el => el.classList.remove('selected'));
}

// ── Back image upload ─────────────────────────────────────────────────────────
function handleBackImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('Image must be under 2 MB', 'error'); return; }
  const reader = new FileReader();
  reader.onload = ev => {
    _pendingTheme = { ..._pendingTheme, id: 'custom', name: 'Custom', customBackImage: ev.target.result };
    const thumb = $('cust-back-thumb');
    thumb.src = ev.target.result;
    thumb.style.display = 'block';
    applyDeckTheme(_pendingTheme);
    document.querySelectorAll('.deck-preset-item').forEach(el => el.classList.remove('selected'));
  };
  reader.readAsDataURL(file);
}

function clearBackImage() {
  _pendingTheme = { ..._pendingTheme, customBackImage: null };
  $('cust-back-thumb').style.display = 'none';
  $('cust-back-image').value = '';
  applyDeckTheme(_pendingTheme);
}

// ─── URL-based auto-join ──────────────────────────────────────────────────────
window.addEventListener('load', () => {
  loadSavedTheme();

  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get('join');
  if (joinCode) {
    $('join-link-hint').textContent = `Joining room ${joinCode.toUpperCase()}…`;
    currentMode = 'join';
    openModal('join');
    $('inp-code').value = joinCode.toUpperCase();
  }
});
