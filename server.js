const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Card Utilities ────────────────────────────────────────────────────────────

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}${suit}` });
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardNumericValue(rank) {
  if (['J', 'Q', 'K'].includes(rank)) return [10];
  if (rank === 'A') return [1, 11];
  return [parseInt(rank)];
}

/** For pick-to-go-first ordering: A=14 (high), K=13, Q=12, J=11, 2-10=face value. */
function pickValue(rank) {
  if (rank === 'A') return 14;
  if (rank === 'K') return 13;
  if (rank === 'Q') return 12;
  if (rank === 'J') return 11;
  return parseInt(rank);
}

/** Max sum of a hand treating A=11 always (used for tiebreaker). */
function handMaxSum(hand) {
  return (hand || []).filter(Boolean).reduce((s, c) => {
    if (['J', 'Q', 'K'].includes(c.rank)) return s + 10;
    if (c.rank === 'A') return s + 11;
    return s + parseInt(c.rank);
  }, 0);
}

/**
 * Returns true if any assignment of Ace values (1 or 11) in this card subset sums to 21.
 * Requires at least 2 cards.
 */
function canSum21(cards) {
  if (cards.length < 2) return false;
  const aces = cards.filter(c => c.rank === 'A').length;
  const nonAceSum = cards
    .filter(c => c.rank !== 'A')
    .reduce((s, c) => s + cardNumericValue(c.rank)[0], 0);
  for (let a11 = 0; a11 <= aces; a11++) {
    if (nonAceSum + a11 * 11 + (aces - a11) === 21) return true;
  }
  return false;
}

/**
 * Returns all subsets of `cards` (by their ids) that sum to 21 with ≥ 2 cards.
 */
function findValidSets(cards) {
  const results = [];
  const n = cards.length;
  for (let mask = 3; mask < (1 << n); mask++) {
    const subset = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(cards[i]);
    }
    if (subset.length >= 2 && canSum21(subset)) {
      results.push(subset.map(c => c.id));
    }
  }
  return results;
}

/**
 * Returns true if the combined pool of hand + carcass contains any 21-sum
 * subset of ≥ 2 cards that includes at least one hand card.
 */
function canMakeAny21(hand, carcass) {
  const combined = [...hand, ...carcass];
  const n = combined.length;
  const hLen = hand.length;
  for (let mask = 3; mask < (1 << n); mask++) {
    const subset = [];
    let hasHand = false;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        subset.push(combined[i]);
        if (i < hLen) hasHand = true;
      }
    }
    if (subset.length >= 2 && hasHand && canSum21(subset)) return true;
  }
  return false;
}

// ─── AI Scoring ────────────────────────────────────────────────────────────────

function scoreHand(hand) {
  const sets = findValidSets(hand);
  let score = sets.length * 100;
  const n = hand.length;
  for (let mask = 3; mask < (1 << n); mask++) {
    const subset = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(hand[i]);
    }
    if (subset.length < 2) continue;
    const aces = subset.filter(c => c.rank === 'A').length;
    const nonAce = subset.filter(c => c.rank !== 'A').reduce((s, c) => s + cardNumericValue(c.rank)[0], 0);
    for (let a11 = 0; a11 <= aces; a11++) {
      const sum = nonAce + a11 * 11 + (aces - a11);
      if (sum < 21) score += Math.max(0, 6 - (21 - sum)) * 2;
    }
  }
  return score;
}

// ─── Room / Game Logic ─────────────────────────────────────────────────────────

function generateCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

class Room {
  constructor(code, mode) {
    this.code = code;
    this.mode = mode; // 'private' | 'ai' | 'random'
    this.players = [];
    this.deck = [];
    this.carcass = [];
    this.currentPlayerIndex = 0;
    this.phase = 'lobby'; // lobby | first_pick | playing | round_end | game_end
    this.hasActed = false;
    this.roundNumber = 1;
    this.log = [];

    // Deck-empty lap tracking
    this.deckEmptyLap = false;
    this.deckEmptyLapCount = 0;

    // First-pick state
    this.pickPool = [];          // face-down cards, one per player
    this.playerPicks = {};       // playerId → { index, card }
    this.pickReveal = null;      // set after all pick: { type:'winner'|'redeal', ... }

    // Round result tracking
    this.lastRoundTotalTie = false;
  }

  addPlayer(id, name, isAI = false) {
    this.players.push({ id, name, hand: [], sets: [], score: 0, isAI, isReady: false });
  }

  // ── Phase transitions ──────────────────────────────────────────────────────

  /** Called when host starts the game or after random match forms. Goes to first_pick. */
  startGame() {
    this.deck = shuffle(createDeck());
    for (const p of this.players) { p.hand = []; p.sets = []; }

    // Deal one face-down pick card per player
    this.pickPool = [];
    for (let i = 0; i < this.players.length; i++) {
      this.pickPool.push(this.deck.pop());
    }
    this.playerPicks = {};
    this.pickReveal = null;
    this.phase = 'first_pick';
    this.pushLog('Pick a card to see who goes first!');
  }

  /** Called after first_pick phase resolves: deal carcass + hands, begin playing. */
  setupPlayPhase() {
    this.carcass = [];
    for (let i = 0; i < 3; i++) {
      if (this.deck.length) this.carcass.push(this.deck.pop());
    }
    for (let i = 0; i < 5; i++) {
      for (const p of this.players) {
        if (this.deck.length) p.hand.push(this.deck.pop());
      }
    }
    this.phase = 'playing';
    this.hasActed = false;
    this.deckEmptyLap = false;
    this.deckEmptyLapCount = 0;
    this.pushLog(`Round ${this.roundNumber} — ${this.getCurrentPlayer().name} goes first!`);
  }

  // ── First-pick ─────────────────────────────────────────────────────────────

  pickFirstCard(playerId, cardIndex) {
    if (this.phase !== 'first_pick') return { success: false, error: 'Not in pick phase' };
    if (this.playerPicks[playerId]) return { success: false, error: 'Already picked' };
    if (cardIndex < 0 || cardIndex >= this.pickPool.length) return { success: false, error: 'Invalid card' };
    // Ensure slot not already taken
    if (Object.values(this.playerPicks).some(pk => pk.index === cardIndex)) {
      return { success: false, error: 'That card was already taken' };
    }

    this.playerPicks[playerId] = { index: cardIndex, card: this.pickPool[cardIndex] };
    const name = this.players.find(p => p.id === playerId)?.name || '?';
    this.pushLog(`${name} picked a card…`);

    const allPicked = Object.keys(this.playerPicks).length === this.players.length;
    if (allPicked) {
      this.pickReveal = this.resolvePickOrder();
      if (this.pickReveal.type === 'winner') {
        this.pushLog(`${this.pickReveal.firstPlayerName} goes first!`);
      } else {
        this.pushLog('All tied! Redealing pick cards…');
      }
      return { success: true, allPicked: true };
    }
    return { success: true, allPicked: false };
  }

  /**
   * Determine first player: find the highest value held by exactly ONE player.
   * If none (everyone is part of some tie), return 'redeal'.
   */
  resolvePickOrder() {
    const vals = this.players.map(p => ({
      id: p.id,
      name: p.name,
      card: this.playerPicks[p.id]?.card,
      val: this.playerPicks[p.id] ? pickValue(this.playerPicks[p.id].card.rank) : 0,
    }));

    const counts = {};
    for (const { val } of vals) counts[val] = (counts[val] || 0) + 1;

    // Unique values descending
    const uniqueVals = Object.keys(counts)
      .map(Number)
      .filter(v => counts[v] === 1)
      .sort((a, b) => b - a);

    if (uniqueVals.length > 0) {
      const winVal = uniqueVals[0];
      const winner = vals.find(x => x.val === winVal);
      this.currentPlayerIndex = this.players.findIndex(p => p.id === winner.id);
      return { type: 'winner', firstPlayerId: winner.id, firstPlayerName: winner.name, vals };
    }

    return { type: 'redeal', vals };
  }

  /** Put pick cards back, reshuffle, re-deal new pick cards. */
  redealPick() {
    this.deck.push(...this.pickPool);
    this.deck = shuffle(this.deck);
    this.pickPool = [];
    for (let i = 0; i < this.players.length; i++) {
      this.pickPool.push(this.deck.pop());
    }
    this.playerPicks = {};
    this.pickReveal = null;
    this.pushLog('Redealing — pick again!');
  }

  // ── Round management ───────────────────────────────────────────────────────

  pushLog(msg) {
    this.log.unshift(msg);
    if (this.log.length > 20) this.log.pop();
  }

  startNextRound(totalTie = false) {
    // Collect ALL cards back for a full reshuffle
    const allCards = [];
    for (const p of this.players) {
      for (const set of p.sets) allCards.push(...set);
      allCards.push(...p.hand);
      p.sets = [];
      p.hand = [];
      p.isReady = false;
    }
    allCards.push(...this.carcass, ...this.deck, ...this.pickPool);
    this.pickPool = [];
    this.deck = shuffle(allCards);
    this.carcass = [];

    if (!totalTie) {
      this.roundNumber++;
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    }
    // On total tie: same round number, same starting player

    // Deal fresh carcass and hands
    for (let i = 0; i < 3; i++) {
      if (this.deck.length) this.carcass.push(this.deck.pop());
    }
    for (let i = 0; i < 5; i++) {
      for (const p of this.players) {
        if (this.deck.length) p.hand.push(this.deck.pop());
      }
    }

    this.phase = 'playing';
    this.hasActed = false;
    this.deckEmptyLap = false;
    this.deckEmptyLapCount = 0;
    this.lastRoundTotalTie = false;

    const msg = totalTie
      ? `Round ${this.roundNumber} restarted (total tie — no points awarded)`
      : `Round ${this.roundNumber} started! ${this.getCurrentPlayer().name} goes first`;
    this.pushLog(msg);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  claimSet(playerId, cardIds) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'Player not found' };
    if (this.getCurrentPlayer().id !== playerId) return { success: false, error: 'Not your turn' };
    if (cardIds.length < 2) return { success: false, error: 'Need at least 2 cards' };

    const cards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length !== cardIds.length) return { success: false, error: 'Some cards are not in your hand' };
    if (!canSum21(cards)) return { success: false, error: 'Selected cards do not sum to 21' };

    player.hand = player.hand.filter(c => !cardIds.includes(c.id));
    player.sets.push(cards);
    this.pushLog(`${player.name} claimed a 21! (${cards.map(c => c.rank + c.suit).join(', ')})`);
    return { success: true };
  }

  swapWithCarcass(playerId, takeIds, giveIds) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'Player not found' };
    if (this.getCurrentPlayer().id !== playerId) return { success: false, error: 'Not your turn' };
    if (this.hasActed) return { success: false, error: 'Already swapped this turn' };
    if (takeIds.length === 0 || giveIds.length === 0) return { success: false, error: 'Must take and give at least 1 card' };
    if (takeIds.length !== giveIds.length) return { success: false, error: 'Must take and give the same number of cards' };

    const takeCards = takeIds.map(id => this.carcass.find(c => c.id === id)).filter(Boolean);
    if (takeCards.length !== takeIds.length) return { success: false, error: 'Some selected Carcass cards are not available' };

    const giveCards = giveIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (giveCards.length !== giveIds.length) return { success: false, error: 'Some selected hand cards not found' };

    player.hand = player.hand.filter(c => !giveIds.includes(c.id));
    this.carcass = this.carcass.filter(c => !takeIds.includes(c.id));
    player.hand.push(...takeCards);
    this.carcass.push(...giveCards);

    this.hasActed = true;
    this.pushLog(`${player.name} swapped ${takeIds.length} card(s) with the Carcass`);
    return { success: true };
  }

  /**
   * Replace hand: only valid when the player cannot make 21 from hand + carcass combined.
   * Old hand goes into deck, draw up to 5 new cards, then shuffle the deck.
   */
  replaceHand(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'Player not found' };
    if (this.getCurrentPlayer().id !== playerId) return { success: false, error: 'Not your turn' };
    if (this.hasActed) return { success: false, error: 'Already acted this turn' };
    if (this.deck.length === 0) return { success: false, error: 'Deck is empty — cannot replace hand' };
    if (canMakeAny21(player.hand, this.carcass)) {
      return { success: false, error: 'You can still make 21 with your cards or the Carcass — replace not allowed' };
    }

    const oldHand = [...player.hand];
    // Take top cards first
    const newCards = [];
    for (let i = 0; i < 5 && this.deck.length > 0; i++) {
      newCards.push(this.deck.pop());
    }
    player.hand = newCards;
    // Return old hand to deck and shuffle
    this.deck.push(...oldHand);
    this.deck = shuffle(this.deck);

    this.hasActed = true;
    this.pushLog(`${player.name} replaced their hand`);
    return { success: true };
  }

  endTurn(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { success: false, error: 'Player not found' };
    if (this.getCurrentPlayer().id !== playerId) return { success: false, error: 'Not your turn' };

    const prevDeckSize = this.deck.length;

    // Auto-draw to 5
    const drew = [];
    while (player.hand.length < 5 && this.deck.length > 0) {
      const card = this.deck.pop();
      player.hand.push(card);
      drew.push(card);
    }
    if (drew.length > 0) {
      this.pushLog(`${player.name} drew ${drew.length} card(s)`);
    }

    this.hasActed = false;

    // Detect when deck first empties
    if (prevDeckSize > 0 && this.deck.length === 0 && !this.deckEmptyLap) {
      this.deckEmptyLap = true;
      this.deckEmptyLapCount = 0;
      this.pushLog('⚠ Deck is empty! Each player gets one more turn.');
    }

    // Advance player
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;

    // If we're in the empty-deck lap, count turns
    if (this.deckEmptyLap) {
      this.deckEmptyLapCount++;
      if (this.deckEmptyLapCount >= this.players.length) {
        // Full lap complete — end the round
        return this.endRound();
      }
    }

    this.pushLog(`It's ${this.getCurrentPlayer().name}'s turn`);
    return { success: true, roundEnded: false };
  }

  endRound() {
    const n = this.players.length;
    this.pushLog('Round over! Scoring…');

    const sorted = [...this.players].sort((a, b) => b.sets.length - a.sets.length);
    const topSetCount = sorted[0].sets.length;
    const allSameSets = sorted.every(p => p.sets.length === topSetCount);

    if (allSameSets) {
      // Tiebreaker: compare max hand sums
      const withSums = this.players
        .map(p => ({ player: p, sum: handMaxSum(p.hand) }))
        .sort((a, b) => b.sum - a.sum);

      const topSum = withSums[0].sum;
      const allSameSum = withSums.every(x => x.sum === topSum);

      if (allSameSum) {
        // Complete tie — no points, round restarts
        this.lastRoundTotalTie = true;
        this.phase = 'round_end';
        this.pushLog('Total tie — nobody scores! Round restarts.');
        return { success: true, roundEnded: true, gameEnded: false, roundPoints: {}, totalTie: true, handSums: withSums.map(x => ({ id: x.player.id, name: x.player.name, sum: x.sum })) };
      }

      // Score by hand sum
      const roundPoints = {};
      let pts = n - 1;
      let prevSum = -1, prevPts = 0;
      for (const { player, sum } of withSums) {
        if (sum === prevSum) {
          roundPoints[player.id] = prevPts;
        } else {
          roundPoints[player.id] = Math.max(0, pts);
          prevPts = roundPoints[player.id];
        }
        prevSum = sum;
        pts--;
        player.score += roundPoints[player.id];
      }

      const winThreshold = 2 * n;
      const gameWinner = [...this.players].sort((a, b) => b.score - a.score).find(p => p.score >= winThreshold);
      if (gameWinner) {
        this.phase = 'game_end';
        return { success: true, roundEnded: true, gameEnded: true, winnerId: gameWinner.id, roundPoints, handSumTiebreaker: true, handSums: withSums.map(x => ({ id: x.player.id, name: x.player.name, sum: x.sum })) };
      }
      this.phase = 'round_end';
      return { success: true, roundEnded: true, gameEnded: false, roundPoints, handSumTiebreaker: true, handSums: withSums.map(x => ({ id: x.player.id, name: x.player.name, sum: x.sum })) };
    }

    // Normal scoring by set count
    const roundPoints = {};
    let pts = n - 1;
    let prevSets = -1, prevPts = 0;
    for (const p of sorted) {
      if (p.sets.length === prevSets) {
        roundPoints[p.id] = prevPts;
      } else {
        roundPoints[p.id] = Math.max(0, pts);
        prevPts = roundPoints[p.id];
      }
      prevSets = p.sets.length;
      pts--;
      p.score += roundPoints[p.id];
    }

    const winThreshold = 2 * n;
    const gameWinner = [...this.players].sort((a, b) => b.score - a.score).find(p => p.score >= winThreshold);
    if (gameWinner) {
      this.phase = 'game_end';
      return { success: true, roundEnded: true, gameEnded: true, winnerId: gameWinner.id, roundPoints };
    }
    this.phase = 'round_end';
    return { success: true, roundEnded: true, gameEnded: false, roundPoints };
  }

  // ── Public state ────────────────────────────────────────────────────────────

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  getPublicState(forPlayerId) {
    const allPicked = this.phase === 'first_pick' &&
      Object.keys(this.playerPicks).length === this.players.length;

    const myPlayer = this.players.find(p => p.id === forPlayerId);

    const state = {
      code: this.code,
      phase: this.phase,
      roundNumber: this.roundNumber,
      carcass: this.phase === 'first_pick' ? [] : this.carcass,
      deckCount: this.deck.length,
      currentPlayerIndex: this.currentPlayerIndex,
      hasActed: this.hasActed,
      deckEmptyLap: this.deckEmptyLap,
      deckEmptyLapCount: this.deckEmptyLapCount,
      log: this.log.slice(0, 8),
      // Can the current player replace their hand?
      canReplace: this.phase === 'playing' &&
        this.getCurrentPlayer()?.id === forPlayerId &&
        !this.hasActed &&
        this.deck.length > 0 &&
        myPlayer ? !canMakeAny21(myPlayer.hand, this.carcass) : false,
      players: this.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        hand: p.id === forPlayerId ? p.hand : p.hand.map(() => null),
        sets: p.id === forPlayerId ? p.sets : [],
        setCount: p.sets.length,
        score: p.score,
        isAI: p.isAI,
        isCurrentPlayer: idx === this.currentPlayerIndex,
        isReady: p.isReady,
      })),
    };

    // First-pick phase extras
    if (this.phase === 'first_pick') {
      state.pickPool = this.pickPool.map((card, i) => {
        const entry = Object.entries(this.playerPicks).find(([, pk]) => pk.index === i);
        const pickedByMe = entry && entry[0] === forPlayerId;
        return {
          index: i,
          picked: !!entry,
          pickedByPlayerName: entry ? (this.players.find(p => p.id === entry[0])?.name || '') : null,
          // Reveal the card only to whoever picked it, or to everyone once all have picked
          card: (pickedByMe || allPicked) ? card : null,
        };
      });
      state.myPickIndex = this.playerPicks[forPlayerId]?.index ?? null;
      state.allPicked = allPicked;
      state.pickReveal = this.pickReveal;
    }

    return state;
  }

  // ── AI Turn ────────────────────────────────────────────────────────────────

  aiTurn() {
    const ai = this.getCurrentPlayer();
    if (!ai?.isAI) return null;

    // 1. Claim all valid 21s
    let claimed = true;
    while (claimed) {
      claimed = false;
      const sets = findValidSets(ai.hand);
      if (sets.length > 0) {
        if (this.claimSet(ai.id, sets[0]).success) claimed = true;
      }
    }

    // 2. Try swap if beneficial
    if (!this.hasActed && this.carcass.length > 0 && ai.hand.length > 0) {
      let bestScore = scoreHand(ai.hand);
      let bestSwap = null;

      for (const cCard of this.carcass) {
        for (const hCard of ai.hand) {
          const newHand = [...ai.hand.filter(c => c.id !== hCard.id), cCard];
          const sc = scoreHand(newHand);
          if (sc > bestScore) { bestScore = sc; bestSwap = { take: [cCard.id], give: [hCard.id] }; }
        }
        for (let i = 0; i < ai.hand.length - 1; i++) {
          for (let j = i + 1; j < ai.hand.length; j++) {
            for (const cCard2 of this.carcass.filter(c => c.id !== cCard.id)) {
              const newHand = [
                ...ai.hand.filter(c => c.id !== ai.hand[i].id && c.id !== ai.hand[j].id),
                cCard, cCard2
              ];
              const sc = scoreHand(newHand);
              if (sc > bestScore) { bestScore = sc; bestSwap = { take: [cCard.id, cCard2.id], give: [ai.hand[i].id, ai.hand[j].id] }; }
            }
          }
        }
      }

      if (bestSwap) {
        this.swapWithCarcass(ai.id, bestSwap.take, bestSwap.give);
        let c2 = true;
        while (c2) {
          c2 = false;
          const sets = findValidSets(ai.hand);
          if (sets.length > 0 && this.claimSet(ai.id, sets[0]).success) c2 = true;
        }
      }
    }

    // 3. Replace hand if stuck and deck available
    if (!this.hasActed && !canMakeAny21(ai.hand, this.carcass) && this.deck.length > 0) {
      this.replaceHand(ai.id);
      // Try claiming after replacement
      let c3 = true;
      while (c3) {
        c3 = false;
        const sets = findValidSets(ai.hand);
        if (sets.length > 0 && this.claimSet(ai.id, sets[0]).success) c3 = true;
      }
    }

    // 4. End turn
    return this.endTurn(ai.id);
  }
}

// ─── Server State ───────────────────────────────────────────────────────────────

const rooms = new Map();
const waitingQueue = [];

function broadcastState(room) {
  for (const p of room.players) {
    if (p.isAI) continue;
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('game-state', room.getPublicState(p.id));
  }
}

function scheduleAI(room, delay = 1400) {
  setTimeout(() => {
    if (!room || room.phase !== 'playing') return;
    if (!room.getCurrentPlayer()?.isAI) return;
    const result = room.aiTurn();
    broadcastState(room);
    if (result?.roundEnded) return;
    if (result?.success && room.getCurrentPlayer()?.isAI) scheduleAI(room);
  }, delay);
}

/**
 * Called after all players have picked. Shows reveal for 3s, then either
 * redeals or transitions to play.
 */
function handlePickReveal(room) {
  broadcastState(room); // show all cards revealed
  if (room.pickReveal?.type === 'redeal') {
    setTimeout(() => {
      room.redealPick();
      broadcastState(room);
      // Schedule AI picks again
      scheduleAIPicks(room);
    }, 3000);
  } else {
    setTimeout(() => {
      room.setupPlayPhase();
      broadcastState(room);
      if (room.getCurrentPlayer()?.isAI) scheduleAI(room);
    }, 3000);
  }
}

/** Make AI players pick after a staggered delay. */
function scheduleAIPicks(room, baseDelay = 800) {
  room.players.forEach((p, i) => {
    if (!p.isAI) return;
    setTimeout(() => {
      if (room.phase !== 'first_pick') return;
      if (room.playerPicks[p.id]) return;
      // Pick a random available slot
      const taken = new Set(Object.values(room.playerPicks).map(pk => pk.index));
      const available = room.pickPool.map((_, idx) => idx).filter(idx => !taken.has(idx));
      if (available.length === 0) return;
      const chosenIdx = available[Math.floor(Math.random() * available.length)];
      const result = room.pickFirstCard(p.id, chosenIdx);
      if (result.allPicked) {
        handlePickReveal(room);
      } else {
        broadcastState(room);
      }
    }, baseDelay + i * 400);
  });
}

// ─── Socket Handlers ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('create-room', ({ name }) => {
    const code = generateCode();
    const room = new Room(code, 'private');
    rooms.set(code, room);
    room.addPlayer(socket.id, name);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;
    socket.emit('room-joined', { code });
    broadcastState(room);
  });

  socket.on('join-room', ({ code, name }) => {
    const room = rooms.get(code.toUpperCase().trim());
    if (!room) { socket.emit('error', { message: 'Room not found. Check the code and try again.' }); return; }
    if (room.phase !== 'lobby') { socket.emit('error', { message: 'Game already started — you cannot join mid-game.' }); return; }
    if (room.players.length >= 6) { socket.emit('error', { message: 'Room is full (6 players max).' }); return; }

    room.addPlayer(socket.id, name);
    socket.join(code.toUpperCase().trim());
    socket.data.roomCode = code.toUpperCase().trim();
    socket.data.name = name;

    socket.emit('room-joined', { code: room.code });
    socket.to(room.code).emit('player-joined', { name });
    broadcastState(room);
  });

  socket.on('join-ai', ({ name }) => {
    const code = generateCode();
    const room = new Room(code, 'ai');
    rooms.set(code, room);
    room.addPlayer(socket.id, name);
    room.addPlayer('ai-' + code, 'Computer', true);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;

    room.startGame();
    socket.emit('room-joined', { code });
    broadcastState(room);
    scheduleAIPicks(room, 1200);
  });

  socket.on('join-random', ({ name }) => {
    socket.data.name = name;
    const idx = waitingQueue.findIndex(s => s.connected);
    if (idx !== -1) {
      const other = waitingQueue.splice(idx, 1)[0];
      const code = generateCode();
      const room = new Room(code, 'random');
      rooms.set(code, room);

      room.addPlayer(other.id, other.data.name);
      room.addPlayer(socket.id, name);
      other.join(code);
      socket.join(code);
      other.data.roomCode = code;
      socket.data.roomCode = code;

      room.startGame();
      other.emit('room-joined', { code });
      socket.emit('room-joined', { code });
      broadcastState(room);
    } else {
      waitingQueue.push(socket);
      socket.emit('waiting', { message: 'Waiting for an opponent…' });
    }
  });

  socket.on('cancel-waiting', () => {
    const i = waitingQueue.indexOf(socket);
    if (i !== -1) waitingQueue.splice(i, 1);
    socket.emit('cancelled');
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.players[0].id !== socket.id) { socket.emit('error', { message: 'Only the host can start the game.' }); return; }
    if (room.players.length < 2) { socket.emit('error', { message: 'Need at least 2 players to start.' }); return; }
    if (room.phase !== 'lobby') return;

    room.startGame();
    broadcastState(room);
    scheduleAIPicks(room, 1200);
  });

  // ── First-pick action ──────────────────────────────────────────────────────
  socket.on('pick-first-card', ({ cardIndex }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'first_pick') return;

    const result = room.pickFirstCard(socket.id, cardIndex);
    if (!result.success) { socket.emit('error', { message: result.error }); return; }

    broadcastState(room);
    if (result.allPicked) handlePickReveal(room);
  });

  // ── Game actions ───────────────────────────────────────────────────────────
  socket.on('game-action', ({ type, ...data }) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.phase !== 'playing') return;

      let result;
      if (type === 'claim-set') {
        result = room.claimSet(socket.id, data.cardIds);
      } else if (type === 'swap-carcass') {
        result = room.swapWithCarcass(socket.id, data.takeIds, data.giveIds);
      } else if (type === 'replace-hand') {
        result = room.replaceHand(socket.id);
      } else if (type === 'end-turn') {
        result = room.endTurn(socket.id);
        if (result?.roundEnded) { broadcastState(room); return; }
        if (result?.success && room.getCurrentPlayer()?.isAI) {
          broadcastState(room);
          scheduleAI(room);
          return;
        }
      }

      if (result && !result.success) { socket.emit('error', { message: result.error }); return; }
      broadcastState(room);
    } catch (err) {
      console.error('game-action error:', err);
      socket.emit('error', { message: 'Server error processing action. Please try again.' });
    }
  });

  // ── Ready for next round ───────────────────────────────────────────────────
  socket.on('ready-next-round', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'round_end') return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.isReady = true;
    broadcastState(room);

    const humans = room.players.filter(p => !p.isAI);
    if (humans.every(p => p.isReady)) {
      const wasTotalTie = room.lastRoundTotalTie;
      room.startNextRound(wasTotalTie);
      broadcastState(room);
      if (room.getCurrentPlayer()?.isAI) scheduleAI(room);
    }
  });

  // ── Mod: set player stats ──────────────────────────────────────────────────
  socket.on('mod-set-stats', ({ playerId, score, sets }) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.phase !== 'playing') return;
      const player = room.players.find(p => p.id === playerId);
      if (!player) return;
      if (score !== undefined) player.score = Math.max(0, parseInt(score) || 0);
      if (sets !== undefined) {
        const target = Math.max(0, parseInt(sets) || 0);
        while (player.sets.length < target) player.sets.push([]);
        while (player.sets.length > target) player.sets.pop();
      }
      room.pushLog(`[MOD] Stats adjusted for ${player.name}`);
      broadcastState(room);
    } catch (err) {
      console.error('mod-set-stats error:', err);
    }
  });

  // ── Leave room (voluntary exit) ────────────────────────────────────────────
  socket.on('leave-room', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const name = socket.data.name || 'A player';
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(code);
    delete socket.data.roomCode;

    if (room.players.filter(p => !p.isAI).length === 0) {
      rooms.delete(code);
    } else {
      room.pushLog(`${name} left the game`);
      socket.to(code).emit('player-left', { name });
      broadcastState(room);
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const qi = waitingQueue.indexOf(socket);
    if (qi !== -1) waitingQueue.splice(qi, 1);

    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    room.pushLog(`${socket.data.name} disconnected`);

    if (room.players.filter(p => !p.isAI).length === 0) {
      rooms.delete(code);
    } else {
      socket.to(code).emit('player-left', { name: socket.data.name });
      broadcastState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nCarcass Card Game is running!`);
  console.log(`Open: http://localhost:${PORT}\n`);
});
