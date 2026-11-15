// End-to-end self-check: boots the server on a temp DB and drives the main flows over HTTP.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dbFile = path.join(os.tmpdir(), `atende-test-${Date.now()}.db`);
process.env.DB_FILE = dbFile;
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.AI_ENABLED;
const { server, tick, db } = await import('./server.js');
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
let token = '';
const api = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// webhook receiver
const hooks = [];
const hookSrv = http.createServer((req, res) => { let s = ''; req.on('data', c => s += c); req.on('end', () => { hooks.push(JSON.parse(s)); res.end('{}'); }); });
await new Promise(r => hookSrv.listen(0, r));

try {
  assert.equal((await api('GET', '/api/v1/setup')).needsSetup, true);
  await api('POST', '/api/v1/setup', { name: 'Dona', email: 'dona@x.com', password: 'secret1', org_name: 'Loja' });
  await assert.rejects(api('POST', '/api/v1/auth/login', { email: 'dona@x.com', password: 'wrong' }), /inválidos/);
  token = (await api('POST', '/api/v1/auth/login', { email: 'dona@x.com', password: 'secret1' })).token;
  const me = await api('GET', '/api/v1/me'); assert.equal(me.role, 'Owner'); assert.equal(me.settings.org_name, 'Loja');

  const sales = await api('POST', '/api/v1/sectors', { name: 'Vendas' });
  const vip = await api('POST', '/api/v1/tags', { name: 'VIP', color: '#f59e0b' });
  await api('POST', '/api/v1/webhooks', { name: 'h', url: `http://localhost:${hookSrv.address().port}/`, events: ['NewChat', 'ChatClosed'], active: 1 });
  const bot = await api('POST', '/api/v1/bots', { name: 'Triagem', active: 1, steps: [
    { id: 's1', type: 'message', text: 'Olá {{contact.name}}!' },
    { id: 's2', type: 'options', text: 'Escolha:', options: [{ label: 'Comprar', goto: 's4' }, { label: 'Suporte', goto: 's3' }] },
    { id: 's3', type: 'close', text: 'Tchau' },
    { id: 's4', type: 'question', text: 'Seu e-mail?', save_as: 'email', regex: '^\\S+@\\S+$' },
    { id: 's5', type: 'tag', tag_id: vip.id },
    { id: 's6', type: 'sector', sector_id: sales.id, text: 'Transferindo para Vendas' },
  ] });
  const channel = (await api('GET', '/api/v1/channels'))[0];
  await api('PUT', `/api/v1/channels/${channel.id}`, { bot_id: bot.id });

  // contact side via widget
  const sess = await (await fetch(`${base}/widget/${channel.id}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ana', phone: '+5511999990000' }) })).json();
  const say = (text) => fetch(`${base}/widget/messages?t=${sess.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then(r => r.json());
  const { chat_id } = await say('oi');
  let hist = await (await fetch(`${base}/widget/history?t=${sess.token}`)).json();
  assert.match(hist.map(m => m.text).join('|'), /Olá Ana!.*1 - Comprar/s);
  await say('9'); // invalid option
  await say('1');
  await say('nao-e-email'); // regex fails
  await say('ana@x.com');
  const chat = await api('GET', `/api/v1/chats/${chat_id}`);
  assert.equal(chat.sector_id, sales.id); assert.equal(chat.bot, null); assert.equal(chat.member_id, null);
  assert.deepEqual(chat.tags.map(t => t.name), ['VIP']);
  assert.equal((await api('GET', `/api/v1/contacts/${chat.contact_id}`)).email, 'ana@x.com');
  assert.ok(chat.messages.some(m => /Opção inválida/.test(m.text)) && chat.messages.some(m => /Resposta inválida/.test(m.text)));

  // attendant side
  assert.equal((await api('GET', '/api/v1/chats?tab=waiting')).length, 1);
  await api('PUT', `/api/v1/chats/${chat_id}/assign`, {});
  assert.equal((await api('GET', '/api/v1/chats?tab=inbox')).length, 1);
  await api('POST', `/api/v1/chats/${chat_id}/messages`, { text: 'Oi Ana, tudo bem?' });
  await api('POST', `/api/v1/chats/${chat_id}/messages`, { text: 'nota interna', note: true });
  hist = await (await fetch(`${base}/widget/history?t=${sess.token}`)).json();
  assert.ok(hist.some(m => m.text === 'Oi Ana, tudo bem?') && !hist.some(m => m.text === 'nota interna'));
  await api('PUT', `/api/v1/chats/${chat_id}/close`, { message: 'Obrigado!' });
  assert.equal((await api('GET', '/api/v1/chats?tab=closed')).length, 1);
  await assert.rejects(api('POST', `/api/v1/chats/${chat_id}/messages`, { text: 'x' }), /finalizada/);

  // contact notes, roles
  await api('POST', `/api/v1/contacts/${chat.contact_id}/notes`, { text: 'Cliente antigo' });
  assert.equal((await api('GET', `/api/v1/contacts/${chat.contact_id}/details`)).notes.length, 1);
  await api('POST', '/api/v1/members', { name: 'Op', email: 'op@x.com', password: 'secret2', role: 'Member' });
  const owner = token; token = (await api('POST', '/api/v1/auth/login', { email: 'op@x.com', password: 'secret2' })).token;
  await assert.rejects(api('POST', '/api/v1/sectors', { name: 'x' }), /permissão/);
  token = owner;

  // campaign to tagged contacts + scheduled message
  await api('POST', '/api/v1/campaigns', { name: 'Promo', channel_id: channel.id, tag_id: vip.id, text: 'Promo para {{contact.name}}' });
  await api('POST', '/api/v1/scheduled_messages', { contact_id: chat.contact_id, channel_id: channel.id, type: 'Message', text: 'Lembrete', send_at: '2000-01-01T00:00' });
  await tick();
  const camp = (await api('GET', '/api/v1/campaigns'))[0]; assert.equal(camp.status, 'Sent'); assert.equal(Number(camp.sent), 1);
  assert.equal((await api('GET', '/api/v1/scheduled_messages'))[0].status, 'Sent');
  hist = await (await fetch(`${base}/widget/history?t=${sess.token}`)).json();
  assert.ok(hist.some(m => m.text === 'Promo para Ana') && hist.some(m => m.text === 'Lembrete'));

  // personal access token for the public API
  const pat = (await api('POST', '/api/v1/tokens', { name: 'ci' })).token;
  token = pat; assert.equal((await api('GET', '/api/v1/me')).email, 'dona@x.com'); token = owner;

  // reports + webhooks + activity
  const rep = await api('GET', '/api/v1/reports');
  assert.equal(rep.total, 2); assert.equal(rep.closed, 1); assert.equal(rep.interacted, 1);
  await sleep(300);
  assert.ok(hooks.some(h => h.type === 'NewChat') && hooks.some(h => h.type === 'ChatClosed'));
  assert.ok(!hooks.some(h => h.type === 'Message'), 'event filter respected');
  assert.ok((await api('GET', '/api/v1/activity')).length > 5);

  // AI without key degrades to queue
  const agent = await api('POST', '/api/v1/ai_agents', { name: 'Bia', prompt: 'x', status: 'Published', kb_ids: [] });
  const c2 = (await api('GET', '/api/v1/chats?tab=waiting'))[0]; // campaign reopened a chat in the queue
  await api('POST', `/api/v1/chats/${c2.id}/ai-agent`, { agent_id: agent.id });
  assert.equal((await api('GET', `/api/v1/chats/${c2.id}`)).ai_agent_id, null);
  // installable app assets are served with the right types
  const mf = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(mf.display, 'standalone'); assert.ok(mf.icons.some(i => i.purpose === 'maskable'));
  for (const i of mf.icons) { const r = await fetch(base + i.src); assert.equal(r.headers.get('content-type'), 'image/png'); assert.ok((await r.arrayBuffer()).byteLength > 500); }
  assert.match(await (await fetch(base + '/sw.js')).text(), /caches.open/);

  // brute force guard: 8 wrong passwords lock that e-mail from this address (even with the right password); others are unaffected
  token = '';
  for (let i = 0; i < 8; i++) await assert.rejects(api('POST', '/api/v1/auth/login', { email: 'dona@x.com', password: 'bad' + i }), /inválidos/);
  await assert.rejects(api('POST', '/api/v1/auth/login', { email: 'dona@x.com', password: 'secret1' }), /Muitas tentativas/);
  assert.ok((await api('POST', '/api/v1/auth/login', { email: 'op@x.com', password: 'secret2' })).token);
  // several devices at once: a second login must not sign out the first; logout ends only its own session
  const login = async (email, password) => (await api('POST', '/api/v1/auth/login', { email, password })).token;
  const as = async (tk, m, u, b) => { const prev = token; token = tk; try { return await api(m, u, b); } finally { token = prev; } };
  const phone = await login('op@x.com', 'secret2'), laptop = await login('op@x.com', 'secret2');
  assert.equal((await as(phone, 'GET', '/api/v1/me')).email, 'op@x.com'); assert.equal((await as(laptop, 'GET', '/api/v1/me')).email, 'op@x.com');
  await as(phone, 'POST', '/api/v1/auth/logout', {});
  await assert.rejects(as(phone, 'GET', '/api/v1/me'), /autenticado/); assert.equal((await as(laptop, 'GET', '/api/v1/me')).email, 'op@x.com');
  // a new password signs out the other devices but keeps the current one
  const other = await login('op@x.com', 'secret2');
  await as(laptop, 'PUT', '/api/v1/me', { password: 'secret3' });
  await assert.rejects(as(other, 'GET', '/api/v1/me'), /autenticado/); assert.equal((await as(laptop, 'GET', '/api/v1/me')).email, 'op@x.com');
  console.log('OK — all checks passed');
} finally {
  server.close(); hookSrv.close(); db.close();
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
