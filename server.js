const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const MAX_ROUNDS = 5;
const HAND_SIZE = 7;
const ROOM_CODE_LENGTH = 6;
const NUMBER_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const OPERATORS = ["+", "*", "x", "/", "%"];
const EPSILON = 0.0001;

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
    removePlayer(ws, room, false);
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
    maxRounds: MAX_ROUNDS,
    turnIndex: 0,
    responderIndex: 0,
    stack: [],
    autoClosedRound: false,
    lastResult: null,
    winnerText: ""
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

  if (room.players.length < 2) {
    sendError(ws, "A sala precisa de pelo menos 2 jogadores.");
    return;
  }

  if (room.players.length !== room.playerCount) {
    sendError(ws, "A sala precisa estar completa antes de iniciar.");
    return;
  }

  room.players.forEach((player) => {
    player.score = 0;
  });
  room.round = 1;
  room.winnerText = "";
  room.lastResult = null;
  startRound(room);
}

function startRound(room) {
  room.phase = "playing";
  room.turnIndex = 0;
  room.responderIndex = (room.round - 1) % room.players.length;
  room.stack = [drawNumberCard()];
  room.autoClosedRound = false;
  room.lastResult = null;

  room.players.forEach((player) => {
    player.hand = buildHand();
  });

  broadcastRoom(room);
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

  const expected = expectedType(room);
  const card = player.hand[cardIndex];
  if (card.type !== expected) {
    sendError(ws, "Essa carta nao e valida neste momento.");
    return;
  }

  room.stack.push(card);
  player.hand.splice(cardIndex, 1);
  room.turnIndex += 1;

  if (room.turnIndex >= room.players.length) {
    finishPlayPhase(room);
    return;
  }

  broadcastRoom(room);
}

function finishPlayPhase(room) {
  if (expectedType(room) === "number") {
    room.autoClosedRound = true;
    room.stack.push(drawNumberCard());
  }
  room.phase = "answer";
  broadcastRoom(room);
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
  if (correct) {
    responder.score += 2;
  }

  room.lastResult = {
    expression: evaluation.expression,
    result: evaluation.value,
    answer: normalizeNumber(answer),
    correct: correct,
    responderName: responder.name,
    autoClosedRound: room.autoClosedRound
  };

  room.phase = room.round >= room.maxRounds ? "finished" : "reveal";
  if (room.phase === "finished") {
    room.winnerText = computeWinnerText(room);
  }

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
    room.players.forEach((player) => {
      player.score = 0;
    });
    room.round = 1;
    room.winnerText = "";
    startRound(room);
    return;
  }

  room.round += 1;
  startRound(room);
}

function removePlayer(ws, room, disconnected) {
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
    room.players[0].isHost = true;
  }

  room.players.forEach((player) => {
    player.isHost = player.id === room.hostPlayerId;
  });

  if (room.phase !== "lobby") {
    room.phase = "lobby";
    room.round = 1;
    room.turnIndex = 0;
    room.responderIndex = 0;
    room.stack = [];
    room.lastResult = null;
    room.winnerText = "";
    room.autoClosedRound = false;
  }

  if (disconnected) {
    broadcastRoom(room);
  } else {
    broadcastRoom(room);
  }
}

function handleDisconnect(ws) {
  const room = getRoomForSocket(ws);
  if (room) {
    removePlayer(ws, room, true);
  } else {
    clients.delete(ws);
  }
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
  return top.type === "number" ? "operator" : "number";
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
    winnerText: room.winnerText
  };
}

function privateView(room, player) {
  const hand = player.hand.map((card) => ({
    id: card.id,
    type: card.type,
    value: card.value,
    playable: room.phase === "playing" && player.id === room.players[room.turnIndex].id && card.type === expectedType(room)
  }));

  const stack = room.stack.map((card, index) => {
    if (room.phase === "reveal" || room.phase === "finished") {
      return {
        type: card.type,
        value: card.value
      };
    }

    const isTop = index === room.stack.length - 1;
    if (!isTop) {
      return { hidden: true };
    }

    return {
      type: card.type,
      value: card.value
    };
  });

  return {
    you: {
      id: player.id,
      name: player.name
    },
    hand: room.phase === "lobby" ? [] : hand,
    stack: stack,
    canPlay: room.phase === "playing" && room.players[room.turnIndex] && room.players[room.turnIndex].id === player.id,
    canAnswer: room.phase === "answer" && room.players[room.responderIndex] && room.players[room.responderIndex].id === player.id,
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
      return "Seu turno. Jogue um " + labelType(expectedType(room)) + ".";
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
    isHost: isHostPlayer
  };
}

function buildHand() {
  const hand = [];
  for (let index = 0; index < HAND_SIZE; index += 1) {
    hand.push(Math.random() < 0.55 ? drawNumberCard() : drawOperatorCard());
  }

  if (!hand.some((card) => card.type === "number")) {
    hand[0] = drawNumberCard();
  }
  if (!hand.some((card) => card.type === "operator")) {
    hand[1] = drawOperatorCard();
  }

  return hand;
}

function drawNumberCard() {
  return {
    id: createId(),
    type: "number",
    value: NUMBER_VALUES[randomInt(0, NUMBER_VALUES.length - 1)]
  };
}

function drawOperatorCard() {
  return {
    id: createId(),
    type: "operator",
    value: OPERATORS[randomInt(0, OPERATORS.length - 1)]
  };
}

function evaluateExpression(cards) {
  let total = Number(cards[0].value);
  const tokens = [String(cards[0].value)];

  for (let index = 1; index < cards.length; index += 2) {
    const operator = cards[index].value;
    const nextValue = Number(cards[index + 1].value);
    tokens.push(displayOperator(operator), String(nextValue));

    if (operator === "+") total += nextValue;
    if (operator === "*") total *= nextValue;
    if (operator === "x") total *= nextValue;
    if (operator === "/") total /= nextValue;
    if (operator === "%") total %= nextValue;
  }

  return {
    value: normalizeNumber(total),
    expression: tokens.join(" ")
  };
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
  if (operator === "x") return "\u00d7";
  if (operator === "/") return "\u00f7";
  return operator;
}

function labelType(type) {
  return type === "number" ? "numero" : "operador";
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
