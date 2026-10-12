const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

const rooms = new Map();
const TEAM_NAMES = ["爆笑隊", "幸運隊", "吃貨隊", "摸魚隊", "冠軍隊"];
const QUESTIONS = [
  { q: "七里香誰唱的？", options: ["周杰倫", "周傳雄", "周華健", "以上皆是"], answer: 3, points: 100 },
  { q: "聽到「今年大家辛苦了」，下一秒最期待？", options: ["加薪通知", "年終獎金", "抽到大獎", "三個都要"], answer: 3, points: 100 },
  { q: "公司團隊合作的最佳狀態是？", options: ["互相支援", "一起解決問題", "一起領獎", "全部都對"], answer: 3, points: 100 },
  { q: "尾牙抽獎前最合理的儀式是？", options: ["握緊手機", "默念幸運數字", "先跟宇宙溝通", "全部都做"], answer: 3, points: 100 },
  { q: "如果同事說「我只想安靜吃飯」，代表？", options: ["真的想安靜", "正在觀察獎品", "還沒抽到大獎", "以上都有可能"], answer: 3, points: 100 }
  { q: "七里香誰唱的？", options: ["周杰倫", "周傳雄", "周華健", "以上皆是"], answer: 3, points: 100 },
  { q: "七里香誰唱的？", options: ["周杰倫", "周傳雄", "周華健", "以上皆是"], answer: 3, points: 100 },
  ];


function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function safeRoom(room) {
  return {
    code: room.code,
    started: room.started,
    phase: room.phase,
    questionIndex: room.questionIndex,
    question: room.phase === "question" ? QUESTIONS[room.questionIndex] : null,
    participants: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, score: p.score, connected: p.connected
    })),
    teams: room.teams,
    winner: room.winner,
    drawWinner: room.drawWinner,
    message: room.message
  };
}
function broadcast(room) {
  io.to(room.code).emit("state", safeRoom(room));
}
function teamTotals(room) {
  return TEAM_NAMES.map(name => ({
    name,
    score: [...room.players.values()].filter(p => p.team === name).reduce((s, p) => s + p.score, 0),
    members: [...room.players.values()].filter(p => p.team === name).length
  })).sort((a, b) => b.score - a.score);
}
function findRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

io.on("connection", socket => {
  socket.on("host:create", (_, cb) => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const room = {
      code, hostId: socket.id, players: new Map(), started: false,
      phase: "lobby", questionIndex: 0, answers: new Map(),
      teams: teamTotals({ players: new Map() }), winner: null, drawWinner: null,
      message: "主持人已建立遊戲，請玩家掃描 QR Code 或輸入房間碼加入。"
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "host";
    if (cb) cb({ ok: true, code });
    broadcast(room);
  });

  socket.on("player:join", (payload, cb) => {
    const code = String(payload?.code || "").trim();
    const name = String(payload?.name || "").trim().slice(0, 18);
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "找不到房間，請確認房間碼。" });
    if (!name) return cb?.({ ok: false, error: "請輸入暱稱。" });
    if (room.started) return cb?.({ ok: false, error: "遊戲已開始，暫時不能加入。" });
    if (room.players.size >= 50) return cb?.({ ok: false, error: "房間已滿（最多 50 人）。" });
    const duplicate = [...room.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
    if (duplicate) return cb?.({ ok: false, error: "這個暱稱已有人使用，請換一個。" });
    const counts = TEAM_NAMES.map(team => ({
      team, count: [...room.players.values()].filter(p => p.team === team).length
    })).sort((a, b) => a.count - b.count);
    const team = counts[0].team;
    const player = { id: socket.id, name, team, score: 0, connected: true };
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "player";
    cb?.({ ok: true, player: { id: player.id, name, team }, code });
    broadcast(room);
  });

  socket.on("host:start", (_, cb) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false, error: "只有主持人可以開始。" });
    if (room.players.size < 1) return cb?.({ ok: false, error: "至少需要一位玩家加入。" });
    room.started = true; room.phase = "question"; room.questionIndex = 0;
    room.message = "第一題開始！手機作答，答對即可替隊伍加分。";
    broadcast(room); cb?.({ ok: true });
  });

  socket.on("player:answer", (payload, cb) => {
    const room = findRoom(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.phase !== "question") return cb?.({ ok: false, error: "目前不是作答時間。" });
    if (room.answers.has(socket.id)) return cb?.({ ok: false, error: "你已經回答過這一題。" });
    const choice = Number(payload?.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return cb?.({ ok: false, error: "答案格式錯誤。" });
    room.answers.set(socket.id, choice);
    let earned = 0;
    if (choice === QUESTIONS[room.questionIndex].answer) {
      // modest speed bonus: server receipt time is used, not client-reported time
      earned = QUESTIONS[room.questionIndex].points;
      player.score += earned;
    }
    cb?.({ ok: true, correct: choice === QUESTIONS[room.questionIndex].answer, earned });
    io.to(room.code).emit("answerCount", { answered: room.answers.size, total: room.players.size });
    broadcast(room);
  });

  socket.on("host:next", (_, cb) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false, error: "只有主持人可以控制題目。" });
    if (room.phase !== "question") return cb?.({ ok: false, error: "目前無法切換題目。" });
    if (room.questionIndex < QUESTIONS.length - 1) {
      room.questionIndex++; room.answers.clear();
      room.message = `第 ${room.questionIndex + 1} 題開始！`;
      broadcast(room); cb?.({ ok: true });
    } else {
      room.phase = "results";
      room.teams = teamTotals(room);
      room.winner = room.teams[0]?.name || null;
      room.message = "競賽結束！恭喜冠軍隊伍。主持人可進行幸運抽獎。";
      broadcast(room); cb?.({ ok: true });
    }
  });

  socket.on("host:draw", (_, cb) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false, error: "只有主持人可以抽獎。" });
    const eligible = [...room.players.values()];
    if (!eligible.length) return cb?.({ ok: false, error: "目前沒有可抽獎的玩家。" });
    const winner = eligible[crypto.randomInt(eligible.length)];
    room.drawWinner = { name: winner.name, team: winner.team, id: winner.id };
    room.message = `恭喜 ${winner.name}！幸運降臨！`;
    broadcast(room); cb?.({ ok: true, winner: room.drawWinner });
  });

  socket.on("host:resetDraw", (_, cb) => {
    const room = findRoom(socket);
    if (!room || room.hostId !== socket.id) return cb?.({ ok: false, error: "只有主持人可以操作。" });
    room.drawWinner = null;
    room.message = "抽獎名單已重置，可再次抽獎。";
    broadcast(room); cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    const room = findRoom(socket);
    if (!room) return;
    if (room.hostId === socket.id) {
      // Keep room alive for briefly disconnected host; room state remains in memory.
      room.message = "主持人連線中斷，請重新整理主持頁面並重新建立房間。";
    } else {
      const player = room.players.get(socket.id);
      if (player) player.connected = false;
    }
    broadcast(room);
  });
});

server.listen(PORT, () => console.log(`Party game listening on ${PORT}`));
