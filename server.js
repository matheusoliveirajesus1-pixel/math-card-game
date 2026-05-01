const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const HAND_SIZE = 5;
const TURNS_PER_PLAYER_PER_ROUND = 2;
const ROOM_CODE_LENGTH = 6;
const TARGET_SCORE = 10;
const ANSWER_TIME_MS = 60000;
const EPSILON = 0.0001;

const NUMBER_VALUES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
  10, 12, 15, 18, 20, 24, 25, 30,
  40, 50, 67, 99, 100
];

const SPECIAL_CARDS = [
  "skip_response",
  "skip_response",
  "memory_extra",
  "memory_extra",
  "bonus",
  "bonus"
];

const rooms = new Map();
const clients = new Map();

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    ok: true,
    service: "pilha-matematica-online",
    rooms: rooms.size
  }));
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  const playerId = createId();
  clients.set(ws, { playerId: playerId, roomCode: null });

  sendToSocket(ws, {
    type: "welcome",
    playerId: playerId
  });

  ws.on("message", (raw) => {
    handleMessage(ws, raw);
  });

  ws.on("close", () => {
    handleDisconnect(ws);
  });
});

server.listen(PORT, () => {
  console.log("Pilha Matematica Online ouvindo na porta " + PORT);
});

function handleMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    sendError(ws, "Mensagem invalida.");
    return;
  }

  const type = message.type;
  const data = message.data || {};

  if (type === "create_room") {
    createRoom(ws, data);
    return;
  }

  if (type === "join_room") {
    joinRoom(ws, data);
    return;
  }

  const room = getRoomForSocket(ws);
  if (!room) {
    sendError(ws, "Voce nao esta em uma sala.");
    return;
  }

  if (type === "update_settings") {
    updateSettings(ws, room, data);
    return;
  }

  if (type === "start_game") {
    startGame(ws, room);
    return;
  }

  if (type === "play_card") {
    playCard(ws, room, data);
    return;
  }

  if (type === "submit_answer") {
    submitAnswer(ws, room, data);
    return;
  }

  if (type === "next_round") {
    advanceRound(ws, room);
    return;
  }

  if (type === "leave_room") {
    removePlayer(ws, room);
    return;
  }

  sendError(ws, "Acao desconhecida.");
}

function createRoom(ws, data) {
  const name = sanitizeName(data.name) || "Host";
  const playerCount = clampPlayerCount(data.playerCount);
  const roomCode = createRoomCode();
  const player = buildPlayer(ws, name, true);

  const room = {
    code: roomCode,
    hostPlayerId: player.id,
    playerCount: playerCount,
    players: [player],
    phase: "lobby",
    round: 1,
    maxRounds: null,
    targetScore: TARGET_SCORE,
    turnIndex: 0,
    responderIndex: 0,
    stack: [],
    deck: [],
    discardPile: [],
    deckRemaining: 0,
    autoClosedRound: false,
    lastResult: null,
    winnerText: "",
    consecutiveDeadTurns: 0,
    pendingTargetWinnerId: null,
    answerDeadlineAt: null,
    answerTimerId: null,
    playedTurnsThisRound: 0,
    totalTurnsThisRound: 0
  };

  rooms.set(roomCode, room);
  clients.get(ws).roomCode = roomCode;
  broadcastRoom(room);
}

function joinRoom(ws, data) {
  const roomCode = String(data.roomCode || "").trim().toUpperCase();
  const name = sanitizeName(data.name) || "Jogador";
  const room = rooms.get(roomCode);

  if (!room) {
    sendError(ws, "Sala nao encontrada.");
    return;
  }

  if (room.phase !== "lobby") {
    sendError(ws, "A partida dessa sala ja comecou.");
    return;
  }

  if (room.players.length >= room.playerCount) {
    sendError(ws, "A sala ja esta cheia.");
    return;
  }

  const player = buildPlayer(ws, name, false);
  room.players.push(player);
  clients.get(ws).roomCode = roomCode;
  broadcastRoom(room);
}

function updateSettings(ws, room, data) {
  if (!isHost(ws, room)) {
    sendError(ws, "So o host pode alterar a configuracao.");
    return;
  }

  if (room.phase !== "lobby") {
    sendError(ws, "A configuracao so pode ser alterada no lobby.");
    return;
  }

  const playerCount = clampPlayerCount(data.playerCount);
  if (playerCount < room.players.length) {
    sendError(ws, "Nao e possivel reduzir abaixo do numero atual de jogadores.");
    return;
  }

  room.playerCount = playerCount;
  broadcastRoom(room);
}

function startGame(ws, room) {
  if (!isHost(ws, room)) {
    sendError(ws, "So o host pode iniciar a partida.");
    return;
  }

  if (room.phase !== "lobby") {
    sendError(ws, "A sala ja saiu do lobby.");
    return;
  }

  if (room.players.length !== room.playerCount) {
    sendError(ws, "A sala precisa estar completa antes de iniciar.");
    return;
  }

  room.deck = createDeck();
  room.discardPile = [];
  room.round = 1;
  room.lastResult = null;
  room.winnerText = "";
  room.pendingTargetWinnerId = null;
  clearAnswerTimer(room);

  room.players.forEach((player) => {
    player.score = 0;
    player.hand = [];
    player.bonusArmed = false;
    player.memoryPeek = null;
  });

  startRound(room);
}

function startRound(room) {
  resetRoundState(room);

  const initialCard = drawCard(room, (card) => card.type === "number");
  if (!initialCard) {
    finishGame(room, "A cava acabou e nao ha numero suficiente para abrir uma nova rodada.");
    return;
  }

  room.stack = [initialCard];

  room.players.forEach((player) => {
    topUpHand(room, player);
  });

  room.deckRemaining = room.deck.length;
  processForcedTurns(room);
}

function resetRoundState(room) {
  room.phase = "playing";
  room.turnIndex = 0;
  room.responderIndex = (room.round - 1) % room.players.length;
  room.stack = [];
  room.autoClosedRound = false;
  room.lastResult = null;
  room.consecutiveDeadTurns = 0;
  room.answerDeadlineAt = null;
  room.playedTurnsThisRound = 0;
  room.totalTurnsThisRound = room.players.length * TURNS_PER_PLAYER_PER_ROUND;

  room.players.forEach((player) => {
    player.bonusArmed = false;
    player.memoryPeek = null;
  });
}

function playCard(ws, room, data) {
  if (room.phase !== "playing") {
    sendError(ws, "A rodada nao esta aceitando jogadas agora.");
    return;
  }

  const player = getPlayerBySocket(ws, room);
  const currentPlayer = room.players[room.turnIndex];
  if (!player || !currentPlayer || player.id !== currentPlayer.id) {
    sendError(ws, "Nao e o seu turno.");
    return;
  }

  const cardIndex = player.hand.findIndex((card) => card.id === data.cardId);
  if (cardIndex === -1) {
    sendError(ws, "Carta nao encontrada.");
    return;
  }

  const card = player.hand[cardIndex];
  if (!isCardPlayable(room, player, card)) {
    sendError(ws, "Essa carta nao e valida neste momento.");
    return;
  }

  player.hand.splice(cardIndex, 1);
  room.consecutiveDeadTurns = 0;

  if (card.type === "special") {
    room.discardPile.push(card);
    applySpecialCard(room, player, card);
  } else {
    appendCardToStack(room, card);
  }

  topUpHand(room, player);
  room.deckRemaining = room.deck.length;

  if (room.phase === "finished") {
    broadcastRoom(room);
    return;
  }

  advanceTurn(room);
  processForcedTurns(room);
}

function processForcedTurns(room) {
  if (room.phase !== "playing") {
    broadcastRoom(room);
    return;
  }

  while (room.phase === "playing") {
    if (room.playedTurnsThisRound >= room.totalTurnsThisRound) {
      finishPlayPhase(room);
      break;
    }

    const player = room.players[room.turnIndex];
    if (!player) {
      break;
    }

    if (playerHasPlayableCard(room, player)) {
      break;
    }

    handleDeadTurn(room, player);
    if (room.phase !== "playing") {
      break;
    }
  }

  room.deckRemaining = room.deck.length;
  broadcastRoom(room);
}

function handleDeadTurn(room, player) {
  discardRandomCard(player, room);
  const replacement = drawCard(room);
  if (replacement) {
    player.hand.push(replacement);
  }

  room.consecutiveDeadTurns += 1;

    if (room.consecutiveDeadTurns >= room.players.length) {
      if (isExpressionValid(room.stack)) {
        enterAnswerPhase(room);
      } else {
        finishGame(room, "A rodada travou e a cava nao conseguiu fechar uma expressao valida.");
      }
    return;
  }

  room.deckRemaining = room.deck.length;
  room.lastResult = null;
  room.autoClosedRound = false;

  advanceTurn(room);
}

function finishPlayPhase(room) {
  if (expectedType(room) === "number") {
    const closingCard = drawCard(room, (card) => card.type === "number");
    if (!closingCard) {
      finishGame(room, "A cava acabou e nao foi possivel fechar a expressao da rodada.");
      return;
    }
    room.autoClosedRound = true;
    room.stack.push(closingCard);
  }

  enterAnswerPhase(room);
}

function submitAnswer(ws, room, data) {
  if (room.phase !== "answer") {
    sendError(ws, "Nao ha resposta para validar agora.");
    return;
  }

  const responder = room.players[room.responderIndex];
  const player = getPlayerBySocket(ws, room);
  if (!player || !responder || player.id !== responder.id) {
    sendError(ws, "So o respondedor pode enviar a resposta.");
    return;
  }

  const answer = Number(data.answer);
  if (Number.isNaN(answer)) {
    sendError(ws, "Resposta invalida.");
    return;
  }

  const evaluation = evaluateExpression(room.stack);
  const correct = Math.abs(answer - evaluation.value) < EPSILON;
  const basePoints = calculateComplexityPoints(evaluation.operatorCount);
  let awardedPoints = 0;
  clearAnswerTimer(room);

  if (correct) {
    awardedPoints += basePoints;
    if (player.bonusArmed) {
      awardedPoints += 1;
    }
    responder.score += awardedPoints;
  }

  room.lastResult = {
    expression: evaluation.expression,
    result: evaluation.value,
    answer: normalizeNumber(answer),
    correct: correct,
    responderName: responder.name,
    autoClosedRound: room.autoClosedRound,
    basePoints: basePoints,
    awardedPoints: awardedPoints,
    operatorCount: evaluation.operatorCount,
    usedBonus: correct && player.bonusArmed
  };

  if (responder.score >= room.targetScore || room.pendingTargetWinnerId) {
    finishGame(room, computeWinnerText(room));
    return;
  }

  room.phase = "reveal";
  room.deckRemaining = room.deck.length;
  broadcastRoom(room);
}

function advanceRound(ws, room) {
  if (!isHost(ws, room)) {
    sendError(ws, "So o host pode avancar a rodada.");
    return;
  }

  if (room.phase !== "reveal" && room.phase !== "finished") {
    sendError(ws, "Nada para avancar agora.");
    return;
  }

  if (room.phase === "finished") {
    clearAnswerTimer(room);
    room.deck = createDeck();
    room.discardPile = [];
    room.round = 1;
    room.winnerText = "";
    room.lastResult = null;
    room.pendingTargetWinnerId = null;
    room.players.forEach((player) => {
      player.score = 0;
      player.hand = [];
      player.bonusArmed = false;
      player.memoryPeek = null;
    });
    startRound(room);
    return;
  }

  room.round += 1;
  startRound(room);
}

function removePlayer(ws, room) {
  const record = clients.get(ws);
  if (!record) return;

  const index = room.players.findIndex((player) => player.id === record.playerId);
  if (index !== -1) {
    room.players.splice(index, 1);
  }

  record.roomCode = null;
  clients.delete(ws);

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.hostPlayerId === record.playerId) {
    room.hostPlayerId = room.players[0].id;
  }

  room.players.forEach((player) => {
    player.isHost = player.id === room.hostPlayerId;
  });

  room.phase = "lobby";
  room.round = 1;
  room.turnIndex = 0;
  room.responderIndex = 0;
  room.stack = [];
  room.lastResult = null;
  room.winnerText = "";
  room.pendingTargetWinnerId = null;
  room.deck = [];
  room.discardPile = [];
  room.deckRemaining = 0;

  broadcastRoom(room);
}

function handleDisconnect(ws) {
  const room = getRoomForSocket(ws);
  if (room) {
    removePlayer(ws, room);
  } else {
    clients.delete(ws);
  }
}

function applySpecialCard(room, player, card) {
  if (card.value === "skip_response") {
    player.score += 1;
    room.responderIndex = (room.responderIndex + 1) % room.players.length;
    if (player.score >= room.targetScore) {
      room.pendingTargetWinnerId = player.id;
    }
    return;
  }

  if (card.value === "bonus") {
    player.bonusArmed = true;
    return;
  }

  if (card.value === "memory_extra") {
    const currentExpression = room.stack.length ? expressionFromCards(room.stack) : "Sem cartas na pilha";
    player.memoryPeek = {
      id: createId(),
      expression: currentExpression
    };
  }
}

function topUpHand(room, player) {
  while (player.hand.length < HAND_SIZE) {
    const card = drawCard(room);
    if (!card) break;
    player.hand.push(card);
  }
}

function drawCard(room, predicate) {
  const matcher = predicate || (() => true);
  const candidates = [];

  for (let index = 0; index < room.deck.length; index += 1) {
    if (matcher(room.deck[index])) {
      candidates.push(index);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const chosenIndex = candidates[randomInt(0, candidates.length - 1)];
  const card = room.deck.splice(chosenIndex, 1)[0];
  room.deckRemaining = room.deck.length;
  return card;
}

function discardRandomCard(player, room) {
  if (player.hand.length === 0) {
    return null;
  }

  const index = randomInt(0, player.hand.length - 1);
  const [card] = player.hand.splice(index, 1);
  if (card) {
    room.discardPile.push(card);
  }
  return card || null;
}

function playerHasPlayableCard(room, player) {
  return player.hand.some((card) => isCardPlayable(room, player, card));
}

function isCardPlayable(room, player, card) {
  const currentPlayer = room.players[room.turnIndex];
  if (!currentPlayer || currentPlayer.id !== player.id) {
    return false;
  }

  if (card.type === "special") {
    return true;
  }

  const expected = expectedType(room);
  if (expected === "operator") {
    return card.type === "operator" || card.type === "number";
  }

  return card.type === "number";
}

function isExpressionValid(stack) {
  if (!stack.length) return false;
  if (stack[0].type !== "number") return false;

  for (let index = 1; index < stack.length; index += 1) {
    const expected = index % 2 === 1 ? "operator" : "number";
    if (stack[index].type !== expected) {
      return false;
    }
  }

  return stack[stack.length - 1].type === "number";
}

function advanceTurn(room) {
  room.playedTurnsThisRound += 1;
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
}

function appendCardToStack(room, card) {
  const expected = expectedType(room);
  if (expected === "operator" && card.type === "number") {
    room.stack.push(makeCard("operator", "*", true));
  }
  room.stack.push(card);
}

function finishGame(room, reason) {
  clearAnswerTimer(room);
  room.phase = "finished";
  room.winnerText = reason === computeWinnerText(room) ? reason : computeWinnerText(room);
  room.deckRemaining = room.deck.length;
  if (!room.lastResult && reason && reason !== room.winnerText) {
    room.lastResult = {
      expression: room.stack.length ? expressionFromCards(room.stack) : "-",
      result: room.stack.length && isExpressionValid(room.stack) ? evaluateExpression(room.stack).value : "-",
      answer: "-",
      correct: false,
      responderName: room.players[room.responderIndex] ? room.players[room.responderIndex].name : "-",
      autoClosedRound: room.autoClosedRound,
      basePoints: 0,
      awardedPoints: 0,
      operatorCount: countOperators(room.stack),
      usedBonus: false,
      finishReason: reason
    };
  } else if (room.lastResult) {
    room.lastResult.finishReason = reason;
  }

  broadcastRoom(room);
}

function getRoomForSocket(ws) {
  const record = clients.get(ws);
  if (!record || !record.roomCode) return null;
  return rooms.get(record.roomCode) || null;
}

function getPlayerBySocket(ws, room) {
  const record = clients.get(ws);
  if (!record) return null;
  return room.players.find((player) => player.id === record.playerId) || null;
}

function isHost(ws, room) {
  const player = getPlayerBySocket(ws, room);
  return !!player && player.id === room.hostPlayerId;
}

function expectedType(room) {
  const top = room.stack[room.stack.length - 1];
  return top && top.type === "number" ? "operator" : "number";
}

function broadcastRoom(room) {
  room.players.forEach((player) => {
    sendToSocket(player.ws, {
      type: "room_state",
      room: publicRoomState(room),
      view: privateView(room, player)
    });
  });
}

function publicRoomState(room) {
  const responder = room.players[room.responderIndex] || null;
  const turnPlayer = room.players[room.turnIndex] || null;
  return {
    code: room.code,
    phase: room.phase,
    playerCount: room.playerCount,
    round: room.round,
    maxRounds: room.maxRounds,
    targetScore: room.targetScore,
    deckRemaining: room.deckRemaining,
    answerDeadlineAt: room.answerDeadlineAt,
    playedTurnsThisRound: room.playedTurnsThisRound,
    totalTurnsThisRound: room.totalTurnsThisRound,
    expectedType: room.phase === "playing" ? expectedType(room) : null,
    hostPlayerId: room.hostPlayerId,
    responderPlayerId: responder ? responder.id : null,
    responderPlayerName: responder ? responder.name : null,
    turnPlayerId: room.phase === "playing" && turnPlayer ? turnPlayer.id : null,
    turnPlayerName: room.phase === "playing" && turnPlayer ? turnPlayer.name : null,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      isHost: player.id === room.hostPlayerId
    })),
    lastResult: room.lastResult,
    winnerText: room.winnerText,
    consecutiveDeadTurns: room.consecutiveDeadTurns
  };
}

function privateView(room, player) {
  const currentPlayer = room.players[room.turnIndex] || null;
  const hand = player.hand.map((card) => ({
    id: card.id,
    type: card.type,
    value: card.value,
    playable: room.phase === "playing" && currentPlayer && currentPlayer.id === player.id && isCardPlayable(room, player, card)
  }));

  const stack = room.stack.map((card, index) => {
    if (room.phase === "reveal" || room.phase === "finished") {
      return {
        type: card.type,
        value: card.value,
        autoInserted: !!card.autoInserted
      };
    }

    const isTop = index === room.stack.length - 1;
    if (!isTop) {
      return { hidden: true };
    }

    return {
      type: card.type,
      value: card.value,
      autoInserted: !!card.autoInserted
    };
  });

  return {
    you: {
      id: player.id,
      name: player.name
    },
    hand: room.phase === "lobby" ? [] : hand,
    stack: stack,
    canPlay: room.phase === "playing" && currentPlayer && currentPlayer.id === player.id,
    canAnswer: room.phase === "answer" && room.players[room.responderIndex] && room.players[room.responderIndex].id === player.id,
    memoryPeek: player.memoryPeek,
    infoMessage: makeInfoMessage(room, player)
  };
}

function makeInfoMessage(room, player) {
  if (room.phase === "lobby") {
    return "Lobby aberto. Aguarde o host iniciar a partida.";
  }

  if (room.phase === "playing") {
    const current = room.players[room.turnIndex];
    if (current && current.id === player.id) {
      return "Seu turno. Numeros sobre numeros viram multiplicacao automaticamente.";
    }
    return current ? current.name + " esta jogando agora." : "Aguardando turno.";
  }

  if (room.phase === "answer") {
    const responder = room.players[room.responderIndex];
    if (responder && responder.id === player.id) {
      return "Sua vez de responder o resultado da expressao.";
    }
    return responder ? responder.name + " esta respondendo de memoria." : "Aguardando resposta.";
  }

  if (room.phase === "reveal") {
    return "Rodada encerrada. O host pode iniciar a proxima rodada.";
  }

  if (room.phase === "finished") {
    return "Partida encerrada. O host pode comecar uma nova partida.";
  }

  return "Aguardando.";
}

function buildPlayer(ws, name, isHostPlayer) {
  return {
    id: clients.get(ws).playerId,
    ws: ws,
    name: name,
    score: 0,
    hand: [],
    isHost: isHostPlayer,
    bonusArmed: false,
    memoryPeek: null
  };
}

function createDeck() {
  const deck = [];

  NUMBER_VALUES.forEach((value) => {
    deck.push(makeCard("number", value));
  });

  for (let copies = 0; copies < 3; copies += 1) {
    deck.push(makeCard("operator", "+"));
    deck.push(makeCard("operator", "-"));
    deck.push(makeCard("operator", "*"));
    deck.push(makeCard("operator", "/"));
  }

  SPECIAL_CARDS.forEach((value) => {
    deck.push(makeCard("special", value));
  });

  return deck;
}

function makeCard(type, value, autoInserted) {
  return {
    id: createId(),
    type: type,
    value: value,
    autoInserted: !!autoInserted
  };
}

function evaluateExpression(cards) {
  let total = Number(cards[0].value);
  const tokens = [String(cards[0].value)];
  let operatorCount = 0;

  for (let index = 1; index < cards.length; index += 2) {
    const operator = cards[index].value;
    const nextValue = Number(cards[index + 1].value);
    operatorCount += 1;
    tokens.push(displayOperator(operator), String(nextValue));

    if (operator === "+") total += nextValue;
    if (operator === "-") total -= nextValue;
    if (operator === "*") total *= nextValue;
    if (operator === "/") total /= nextValue;
  }

  return {
    value: normalizeNumber(total),
    expression: tokens.join(" "),
    operatorCount: operatorCount
  };
}

function expressionFromCards(cards) {
  return cards.map((card) => {
    if (card.type === "operator") return displayOperator(card.value);
    if (card.type === "special") return specialLabel(card.value);
    return String(card.value);
  }).join(" ");
}

function calculateComplexityPoints(operatorCount) {
  if (operatorCount <= 0) return 0;
  if (operatorCount === 1) return 1;
  if (operatorCount === 2) return 2;
  return 4;
}

function countOperators(cards) {
  return cards.filter((card) => card.type === "operator").length;
}

function computeWinnerText(room) {
  const bestScore = Math.max.apply(null, room.players.map((player) => player.score));
  const winners = room.players.filter((player) => player.score === bestScore);
  if (winners.length === 1) {
    return winners[0].name + " venceu com " + bestScore + " pontos.";
  }
  return "Empate entre " + winners.map((player) => player.name).join(", ") + " com " + bestScore + " pontos.";
}

function clampPlayerCount(value) {
  const parsed = Number(value);
  if (parsed <= 2) return 2;
  if (parsed >= 4) return 4;
  return 3;
}

function sanitizeName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function createRoomCode() {
  let code = "";
  do {
    code = randomString(ROOM_CODE_LENGTH);
  } while (rooms.has(code));
  return code;
}

function randomString(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += chars[randomInt(0, chars.length - 1)];
  }
  return out;
}

function createId() {
  return crypto.randomBytes(8).toString("hex");
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function displayOperator(operator) {
  if (operator === "*") return "\u00d7";
  return operator;
}

function specialLabel(kind) {
  if (kind === "skip_response") return "Pular";
  if (kind === "memory_extra") return "Memoria";
  if (kind === "bonus") return "Bonus";
  return "Especial";
}

function normalizeNumber(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function sendToSocket(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendError(ws, message) {
  sendToSocket(ws, {
    type: "error",
    message: message
  });
}

function enterAnswerPhase(room) {
  clearAnswerTimer(room);
  room.phase = "answer";
  room.answerDeadlineAt = Date.now() + ANSWER_TIME_MS;
  room.answerTimerId = setTimeout(() => {
    handleAnswerTimeout(room);
  }, ANSWER_TIME_MS);
}

function clearAnswerTimer(room) {
  if (room.answerTimerId) {
    clearTimeout(room.answerTimerId);
    room.answerTimerId = null;
  }
  room.answerDeadlineAt = null;
}

function handleAnswerTimeout(room) {
  if (room.phase !== "answer") {
    return;
  }

  clearAnswerTimer(room);
  const evaluation = evaluateExpression(room.stack);

  room.lastResult = {
    expression: evaluation.expression,
    result: evaluation.value,
    answer: "Tempo esgotado",
    correct: false,
    responderName: room.players[room.responderIndex] ? room.players[room.responderIndex].name : "-",
    autoClosedRound: room.autoClosedRound,
    basePoints: calculateComplexityPoints(evaluation.operatorCount),
    awardedPoints: 0,
    operatorCount: evaluation.operatorCount,
    usedBonus: false,
    finishReason: "O tempo de resposta de 60 segundos acabou."
  };

  if (room.pendingTargetWinnerId) {
    finishGame(room, computeWinnerText(room));
    return;
  }

  room.phase = "reveal";
  room.deckRemaining = room.deck.length;
  broadcastRoom(room);
}
