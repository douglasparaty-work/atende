// Checks the OpenAI-compatible AI path (Gemini / NVIDIA / Ollama) against a local mock server.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const calls = [];
const mock = http.createServer((req, res) => {
  let s = ''; req.on('data', c => s += c); req.on('end', () => {
    const body = JSON.parse(s); calls.push({ url: req.url, auth: req.headers.authorization, body });
    if (body.model === 'hang-model') return; // never answers
    if (body.model === 'bad-model') return res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'high demand' } }));
    if (req.url.startsWith('/fail')) return res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'quota exceeded' } }));
    const last = body.messages.at(-1).content;
    const content = /humano/.test(last) ? '[TRANSFERIR]' : 'Entregamos em até 7 dias úteis.';
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
await new Promise(r => mock.listen(0, r));
const dbFile = path.join(os.tmpdir(), `atende-ai-${Date.now()}.db`);
Object.assign(process.env, { DB_FILE: dbFile, AI_PROVIDER: 'custom', AI_BASE_URL: `http://localhost:${mock.address().port}/v1`, AI_API_KEY: 'test-key', AI_MODEL: 'mock-model' });
const { server, db } = await import('./server.js');
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
let token = '';
const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: b && JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
try {
  await api('POST', '/api/v1/setup', { name: 'D', email: 'd@x.com', password: 'secret1' });
  token = (await api('POST', '/api/v1/auth/login', { email: 'd@x.com', password: 'secret1' })).token;
  assert.equal((await api('GET', '/api/v1/me')).ai, true);
  const kb = await api('POST', '/api/v1/knowledge_bases', { name: 'FAQ', qas: [{ q: 'Entrega?', a: '7 dias úteis' }] });
  const agent = await api('POST', '/api/v1/ai_agents', { name: 'Bia', prompt: 'Seja gentil', status: 'Published', kb_ids: [kb.id] });
  const { chat_id } = await api('POST', '/api/v1/inbound', { channel_id: 1, phone: '+5511900000000', name: 'Rui', text: 'Oi' });
  await api('POST', `/api/v1/chats/${chat_id}/ai-agent`, { agent_id: agent.id });
  await api('POST', '/api/v1/inbound', { channel_id: 1, phone: '+5511900000000', text: 'Quanto tempo a entrega?' });
  let chat = await api('GET', `/api/v1/chats/${chat_id}`);
  assert.ok(chat.messages.some(m => m.source === 'Bot' && m.text === 'Entregamos em até 7 dias úteis.'));
  const c = calls.at(-1);
  assert.equal(c.url, '/v1/chat/completions'); assert.equal(c.auth, 'Bearer test-key'); assert.equal(c.body.model, 'mock-model');
  assert.equal(c.body.messages[0].role, 'system'); assert.match(c.body.messages[0].content, /7 dias úteis/);
  await api('POST', '/api/v1/inbound', { channel_id: 1, phone: '+5511900000000', text: 'quero falar com humano' });
  chat = await api('GET', `/api/v1/chats/${chat_id}`);
  assert.equal(chat.ai_agent_id, null, 'handoff to human');
  assert.equal((await api('POST', '/api/v1/ai/improve', { text: 'oi' })).text, 'Entregamos em até 7 dias úteis.');

  // fallback: first provider out of quota -> next answers; failed one is skipped while cooling down
  Object.assign(process.env, { AI_PROVIDERS: 'groq,custom', GROQ_BASE_URL: `http://localhost:${mock.address().port}/fail/v1`, GROQ_API_KEY: 'g-key', GROQ_MODEL: 'g-model' });
  calls.length = 0;
  assert.equal((await api('POST', '/api/v1/ai/improve', { text: 'oi' })).text, 'Entregamos em até 7 dias úteis.');
  assert.deepEqual(calls.map(c => c.url), ['/fail/v1/chat/completions', '/v1/chat/completions']);
  assert.equal(calls[0].auth, 'Bearer g-key'); assert.equal(calls[0].body.model, 'g-model'); assert.equal(calls[1].body.model, 'mock-model');
  calls.length = 0;
  await api('POST', '/api/v1/ai/improve', { text: 'oi' });
  assert.deepEqual(calls.map(c => c.url), ['/v1/chat/completions'], 'cooling provider skipped');
  // every provider failing -> clear 502 instead of a generic error
  process.env.AI_PROVIDERS = 'groq';
  await assert.rejects(api('POST', '/api/v1/ai/improve', { text: 'oi' }), /IA indisponível: groq\/g-model: quota exceeded/);
  // model list inside one provider: first model fails, second answers
  process.env.AI_PROVIDERS = 'custom'; process.env.AI_MODEL = 'bad-model,mock-model'; calls.length = 0;
  mock.badModel = true;
  assert.equal((await api('POST', '/api/v1/ai/improve', { text: 'oi' })).text, 'Entregamos em até 7 dias úteis.');
  assert.deepEqual(calls.map(c => c.body.model), ['bad-model', 'mock-model']);
  // a model that hangs (timeout) must not block the next model
  process.env.AI_MODEL = 'hang-model,mock-model'; process.env.AI_TIMEOUT_MS = '300'; calls.length = 0;
  assert.equal((await api('POST', '/api/v1/ai/improve', { text: 'oi' })).text, 'Entregamos em até 7 dias úteis.');
  assert.deepEqual(calls.map(c => c.body.model), ['hang-model', 'mock-model']);
  console.log('OK — AI provider checks passed');
} finally {
  server.close(); mock.close(); db.close();
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
