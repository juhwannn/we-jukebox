require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────────
let queue = [];
let nowPlaying = null;
let idCounter = 0;

// ── YouTube Search ─────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.json({ items: [] });

  if (!process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY === '여기에_유튜브_API_키_입력') {
    return res.status(503).json({ error: 'YouTube API 키가 설정되지 않았습니다. .env 파일을 확인하세요.' });
  }

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: process.env.YOUTUBE_API_KEY,
        q: q.trim(),
        part: 'snippet',
        type: 'video',
        maxResults: 8,
        videoCategoryId: '10',
        relevanceLanguage: 'ko',
        regionCode: 'KR',
      },
    });

    const items = response.data.items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
    }));

    res.json({ items });
  } catch (err) {
    console.error('[Search Error]', err.response?.data || err.message);
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

  // 재생 중인 곡이 없으면 플레이어에게 시작 신호
  if (!nowPlaying) {
    io.emit('player:play-next');
  }

  res.json({ success: true, song });
});

app.delete('/api/queue/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const before = queue.length;
  queue = queue.filter((s) => s.id !== id);

  if (queue.length === before) {
    return res.status(404).json({ error: '해당 곡을 찾을 수 없습니다.' });
  }

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

// 플레이어가 현재 진행 상황 브로드캐스트 (소켓 직접 사용)
// → player.html에서 socket.emit('player:progress', { currentTime, duration }) 로 전송

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] 연결:', socket.id);

  // 연결 즉시 현재 상태 전송
  socket.emit('state:update', { queue, nowPlaying });

  // 플레이어 → 전체 브로드캐스트 (progress)
  socket.on('player:progress', (data) => {
    socket.broadcast.emit('player:progress', data);
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
      nowPlaying = queue.shift();
      io.emit('state:update', { queue, nowPlaying });
      io.emit('player:play', nowPlaying);
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] 연결 해제:', socket.id);
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
