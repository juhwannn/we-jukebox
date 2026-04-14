require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const yts = require('yt-search');
const path = require('path');

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────────
let queue = [];
let nowPlaying = null;
let idCounter = 0;
let users = new Map(); // socketId → { nickname, connectedAt }
let history = []; // { type, songTitle, requester, remover, timestamp }
const MAX_HISTORY = 50;
let boomStats = new Map(); // songId → { videoId, title, requester, boomUp, boomDown, upVoters: Set, downVoters: Set }

function getBoomPayload() {
  const result = {};
  boomStats.forEach((stat, songId) => {
    result[songId] = {
      songId,
      videoId: stat.videoId,
      title: stat.title,
      requester: stat.requester,
      boomUp: stat.boomUp,
      boomDown: stat.boomDown,
      upVoters: [...stat.upVoters],
      downVoters: [...stat.downVoters],
    };
  });
  return result;
}

function addHistory(event) {
  history.unshift({ ...event, timestamp: new Date().toISOString() });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  io.emit('history:update', history);
}

// ── YouTube Search ─────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json({ items: [] });

  try {
    const result = await yts(q.trim());
    const items = result.videos.slice(0, 5).map((v) => ({
      videoId: v.videoId,
      title: v.title,
      channel: v.author.name,
      thumbnail: v.thumbnail,
    }));
    res.json({ items });
  } catch (err) {
    console.error('[Search Error]', err.message);
    res.status(500).json({ error: '검색 중 오류가 발생했습니다.' });
  }
});

// ── Queue ──────────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json({ queue, nowPlaying });
});

app.post('/api/queue', (req, res) => {
  const { videoId, title, channel, thumbnail, requester } = req.body;

  if (!videoId || !title) {
    return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
  }

  // 중복 체크 (이미 큐에 있는 곡)
  const isDuplicate = queue.some((s) => s.videoId === videoId) ||
    nowPlaying?.videoId === videoId;

  if (isDuplicate) {
    return res.status(409).json({ error: '이미 신청된 곡입니다.' });
  }

  const song = {
    id: ++idCounter,
    videoId,
    title: decodeHtmlEntities(title),
    channel,
    thumbnail,
    requester: (requester || '익명').trim().slice(0, 20),
    requestedAt: new Date().toISOString(),
  };

  queue.push(song);
  io.emit('state:update', { queue, nowPlaying });
  addHistory({ type: 'add', songTitle: song.title, requester: song.requester });

  // 재생 중인 곡이 없으면 플레이어에게 시작 신호
  if (!nowPlaying) {
    io.emit('player:play-next');
  }

  res.json({ success: true, song });
});

app.delete('/api/queue/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const removed = queue.find((s) => s.id === id);

  if (!removed) {
    return res.status(404).json({ error: '해당 곡을 찾을 수 없습니다.' });
  }

  queue = queue.filter((s) => s.id !== id);
  const remover = (req.query.remover || '').trim().slice(0, 20) || removed.requester;
  addHistory({ type: 'remove', songTitle: removed.title, requester: removed.requester, remover });
  io.emit('state:update', { queue, nowPlaying });
  res.json({ success: true });
});

// ── Player API ─────────────────────────────────────────────────────────────
// 플레이어가 다음 곡 요청
app.get('/api/next', (req, res) => {
  if (queue.length === 0) {
    nowPlaying = null;
    io.emit('state:update', { queue, nowPlaying });
    return res.json({ song: null });
  }

  nowPlaying = queue.shift();
  io.emit('state:update', { queue, nowPlaying });
  res.json({ song: nowPlaying });
});

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] 연결:', socket.id);

  // 연결 즉시 현재 상태 전송
  socket.emit('state:update', { queue, nowPlaying });
  socket.emit('history:update', history);
  socket.emit('boom:update', getBoomPayload());

  // 유저 닉네임 등록
  socket.on('user:join', (nickname) => {
    const name = (nickname || '').trim().slice(0, 20) || '익명';
    users.set(socket.id, { nickname: name, connectedAt: new Date().toISOString() });
    io.emit('users:update', [...users.values()]);
  });

  // 플레이어 → 전체 브로드캐스트 (progress)
  socket.on('player:progress', (data) => {
    socket.broadcast.emit('player:progress', data);
  });

  // 볼륨 제어 → 모든 클라이언트에 동기화
  socket.on('player:setVolume', (volume) => {
    io.emit('player:setVolume', volume);
  });

  // 다음 곡 건너뛰기
  socket.on('player:skip', () => {
    io.emit('player:skip');
  });

  // 일시정지/재생 토글
  socket.on('player:pause', () => {
    io.emit('player:pause');
  });

  // 재생 상태 변경 브로드캐스트 (player → others)
  socket.on('player:playstate', (state) => {
    socket.broadcast.emit('player:playstate', state);
  });

  // 붐업 / 붐따 투표
  socket.on('boom:vote', ({ songId, videoId, title, requester, type }) => {
    const voter = users.get(socket.id)?.nickname;
    if (!voter) return;

    if (!boomStats.has(songId)) {
      boomStats.set(songId, {
        videoId, title, requester,
        boomUp: 0, boomDown: 0,
        upVoters: new Set(),
        downVoters: new Set(),
      });
    }

    const stat = boomStats.get(songId);

    if (type === 'up') {
      if (stat.upVoters.has(voter)) {
        stat.upVoters.delete(voter);
        stat.boomUp--;
      } else {
        if (stat.downVoters.has(voter)) {
          stat.downVoters.delete(voter);
          stat.boomDown--;
        }
        stat.upVoters.add(voter);
        stat.boomUp++;
      }
    } else if (type === 'down') {
      if (stat.downVoters.has(voter)) {
        stat.downVoters.delete(voter);
        stat.boomDown--;
      } else {
        if (stat.upVoters.has(voter)) {
          stat.upVoters.delete(voter);
          stat.boomUp--;
        }
        stat.downVoters.add(voter);
        stat.boomDown++;
      }
    }

    io.emit('boom:update', getBoomPayload());
  });

  // 플레이어가 재생 시작했을 때
  socket.on('player:started', (song) => {
    nowPlaying = song;
    queue = queue.filter((s) => s.id !== song.id);
    io.emit('state:update', { queue, nowPlaying });
  });

  // 플레이어가 재생 종료했을 때
  socket.on('player:ended', () => {
    nowPlaying = null;
    io.emit('state:update', { queue, nowPlaying });
    if (queue.length > 0) {
      io.emit('player:play-next');
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] 연결 해제:', socket.id);
    users.delete(socket.id);
    io.emit('users:update', [...users.values()]);
  });
});

// ── Utils ──────────────────────────────────────────────────────────────────
function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const divider = '─'.repeat(50);
  console.log(divider);
  console.log(`  🎵 Office Jukebox`);
  console.log(divider);
  console.log(`  신청 페이지: http://localhost:${PORT}`);
  console.log(`  플레이어:    http://localhost:${PORT}/player.html`);
  console.log(divider);

  if (!process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY === '여기에_유튜브_API_키_입력') {
    console.log('  ⚠️  .env 파일에 YOUTUBE_API_KEY를 설정하세요.');
    console.log(divider);
  }
});
