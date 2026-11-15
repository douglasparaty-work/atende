// WhatsApp channel check with a fake socket: QR, inbound (incl. hidden-number @lid ids), replies, failures, reconnect, logout.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tag = Date.now();
const dbFile = path.join(os.tmpdir(), `atende-wa-${tag}.db`), authRoot = path.join(os.tmpdir(), `atende-wa-auth-${tag}`);
Object.assign(process.env, { DB_FILE: dbFile, WA_AUTH_DIR: authRoot, WA_RECONNECT_MS: '150', WA_CAMPAIGN_DELAY_MS: '0' });
delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY;
const { server, db, wa } = await import('./server.js');
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
let token = '';
const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: b && JSON.stringify(b) }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fakes = [];
wa.useFactory(async () => {
  const ev = new EventEmitter();
  const sock = { ev: { on: (n, f) => ev.on(n, f), emit: (n, a) => ev.emit(n, a) }, user: { id: '5511988887777:12@s.whatsapp.net' }, sent: [], failNext: false, loggedOut: false,
    async sendMessage(to, c) { if (sock.failNext) { sock.failNext = false; throw new Error('boom'); } sock.sent.push([to, c.text]); },
    async logout() { sock.loggedOut = true; } };
  fakes.push(sock); return sock;
});
const upsert = (sock, id, key, message, extra = {}) => sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id, ...key }, message, ...extra }] });
const closeEvt = (sock, code) => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });

try {
  await api('POST', '/api/v1/setup', { name: 'D', email: 'd@x.com', password: 'secret1' });
  token = (await api('POST', '/api/v1/auth/login', { email: 'd@x.com', password: 'secret1' })).token;
  const ch = await api('POST', '/api/v1/channels', { name: 'Zap', type: 'WhatsApp', active: 1 });
  await assert.rejects(api('POST', '/api/v1/channels/1/whatsapp/connect', {}), /não é do tipo WhatsApp/); // channel 1 is the site widget
  assert.equal((await api('GET', `/api/v1/channels/${ch.id}/whatsapp`)).state, 'disconnected');

  // QR login
  assert.equal((await api('POST', `/api/v1/channels/${ch.id}/whatsapp/connect`, {})).state, 'connecting');
  fakes[0].ev.emit('connection.update', { qr: '2@fake-qr-payload' }); await sleep(80);
  let st = await api('GET', `/api/v1/channels/${ch.id}/whatsapp`);
  assert.equal(st.state, 'qr'); assert.match(st.qr, /^data:image\/png;base64,/);
  fakes[0].ev.emit('connection.update', { connection: 'open' }); await sleep(30);
  st = await api('GET', `/api/v1/channels/${ch.id}/whatsapp`);
  assert.deepEqual([st.state, st.phone, st.qr], ['connected', '5511988887777', null]);

  // inbound: number hidden behind @lid, with the real number as alternate id
  const lid = { remoteJid: '123456@lid', remoteJidAlt: '5521977776666@s.whatsapp.net' };
  upsert(fakes[0], 'A1', lid, { conversation: 'Oi, quero comprar' }, { pushName: 'Ana' }); await sleep(80);
  let waiting = await api('GET', '/api/v1/chats?tab=waiting');
  assert.equal(waiting.length, 1); assert.equal(waiting[0].contact_phone, '+5521977776666'); assert.equal(waiting[0].contact_name, 'Ana');
  const chatId = waiting[0].id;
  // ignored: duplicate id, group, own message, reaction
  upsert(fakes[0], 'A1', lid, { conversation: 'Oi, quero comprar' });
  upsert(fakes[0], 'G1', { remoteJid: '999@g.us' }, { conversation: 'grupo' });
  upsert(fakes[0], 'M1', { ...lid, fromMe: true }, { conversation: 'eu mesmo' });
  upsert(fakes[0], 'R1', lid, { reactionMessage: { text: '👍' } });
  // media placeholders / captions, then a second message from the same @lid without the alternate id
  upsert(fakes[0], 'I1', lid, { imageMessage: { caption: 'foto do produto' } });
  upsert(fakes[0], 'U1', { remoteJid: '123456@lid' }, { audioMessage: {} }); await sleep(120);
  let chat = await api('GET', `/api/v1/chats/${chatId}`);
  assert.deepEqual(chat.messages.filter(m => m.source === 'Contact').map(m => m.text), ['Oi, quero comprar', 'foto do produto', '[áudio]']);
  assert.equal((await api('GET', '/api/v1/contacts')).length, 1, 'same contact reused');

  // outbound: reply goes to the id the contact wrote from; notes never leave
  await api('POST', `/api/v1/chats/${chatId}/messages`, { text: 'Olá Ana' });
  await api('POST', `/api/v1/chats/${chatId}/messages`, { text: 'nota interna', note: true }); await sleep(50);
  assert.deepEqual(fakes[0].sent, [['123456@lid', 'Olá Ana']]);

  // chatbot on the channel answers a new contact over WhatsApp
  const bot = await api('POST', '/api/v1/bots', { name: 'Boas-vindas', active: 1, steps: [{ id: 's1', type: 'message', text: 'Bem-vindo, {{contact.name}}!' }] });
  await api('PUT', `/api/v1/channels/${ch.id}`, { bot_id: bot.id });
  upsert(fakes[0], 'B1', { remoteJid: '5531900001111@s.whatsapp.net' }, { conversation: 'oi' }, { pushName: 'Beto' }); await sleep(120);
  assert.deepEqual(fakes[0].sent.at(-1), ['5531900001111@s.whatsapp.net', 'Bem-vindo, Beto!']);

  // a send that fails is flagged, not lost silently
  fakes[0].failNext = true;
  await api('POST', `/api/v1/chats/${chatId}/messages`, { text: 'vai falhar' }); await sleep(80);
  chat = await api('GET', `/api/v1/chats/${chatId}`);
  assert.equal(chat.messages.find(m => m.text === 'vai falhar').state, 'Failed');

  // connection drop (not logout) reconnects by itself; sending while offline is flagged
  closeEvt(fakes[0], 500); await sleep(5);
  assert.equal((await api('GET', `/api/v1/channels/${ch.id}/whatsapp`)).state, 'disconnected');
  await api('POST', `/api/v1/chats/${chatId}/messages`, { text: 'offline' }); await sleep(50);
  assert.equal((await api('GET', `/api/v1/chats/${chatId}`)).messages.find(m => m.text === 'offline').state, 'Failed');
  await sleep(300); assert.equal(fakes.length, 2, 'reconnected');
  fakes[1].ev.emit('connection.update', { connection: 'open' }); await sleep(30);
  assert.equal((await api('GET', `/api/v1/channels/${ch.id}/whatsapp`)).state, 'connected');

  // phone removed the device (401): no reconnect loop
  closeEvt(fakes[1], 401); await sleep(400);
  assert.equal(fakes.length, 2, 'no reconnect after logout'); assert.equal((await api('GET', `/api/v1/channels/${ch.id}/whatsapp`)).state, 'disconnected');

  // explicit disconnect from the panel
  await api('POST', `/api/v1/channels/${ch.id}/whatsapp/connect`, {}); await sleep(20);
  fakes[2].ev.emit('connection.update', { connection: 'open' }); await sleep(30);
  assert.equal((await api('POST', `/api/v1/channels/${ch.id}/whatsapp/logout`, {})).state, 'disconnected'); assert.equal(fakes[2].loggedOut, true);
  console.log('OK — WhatsApp channel checks passed');
} finally {
  server.close(); db.close();
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  fs.rmSync(authRoot, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
