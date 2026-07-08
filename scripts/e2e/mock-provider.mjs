// Tiny OpenAI-compatible mock for the e2e install test: /v1/models + /v1/chat/completions echo.
import http from 'node:http';
const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 18099);
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'e2e-mini' }, { id: 'e2e-pro' }] }));
    if (req.url === '/v1/audio/speech') {
      res.setHeader('content-type', 'audio/mpeg');
      return res.end(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(400, 1)])); // fake-but-plausible mp3
    }
    if (req.url === '/v1/audio/transcriptions') {
      return res.end(JSON.stringify({ text: 'e2e transcript' }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(b || '{}');
      const last = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
      const text = typeof last?.content === 'string' ? last.content : '';
      return res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'e2e-ok: ' + text.slice(0, 60) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
}).listen(PORT, '127.0.0.1', () => console.log('mock provider on', PORT));
