// Atende — multichannel customer-service platform (functional reconstruction of Umbler Talk).
// Zero-build: Node >= 22.13 built-ins (http, node:sqlite, crypto) + optional @anthropic-ai/sdk for AI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT || 3900);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const db = new DatabaseSync(process.env.DB_FILE || path.join(ROOT, 'atende.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

// ---------- schema ----------
// Generic resources: simple CRUD exposed at /api/v1/<name>. `json` fields are stored as JSON text.
const ROLES = ['Member', 'Operator', 'Admin', 'Owner'];
const R = {
  sectors: { fields: ['name', 'is_default'], role: 'Admin', log: 'Sector' },
  tags: { fields: ['name', 'color'], role: 'Operator', log: 'Tag' },
  quick_answers: { fields: ['shortcut', 'text'], role: 'Member', log: 'QuickAnswer' },
  channels: { fields: ['name', 'type', 'bot_id', 'active'], role: 'Admin', log: 'Channel' },
  members: { fields: ['name', 'email', 'phone', 'role', 'active', 'sector_ids', 'closing_message', 'prefs'], json: ['sector_ids', 'prefs'], role: 'Admin', hide: ['password_hash', 'session'], log: 'Member' },
  contacts: { fields: ['name', 'phone', 'email', 'blocked', 'custom'], json: ['custom'], role: 'Member', log: 'Contact' },
  bots: { fields: ['name', 'active', 'steps'], json: ['steps'], role: 'Admin', log: 'Bot' },
  ai_agents: { fields: ['name', 'prompt', 'status', 'kb_ids', 'transfer_sector_id'], json: ['kb_ids'], role: 'Admin', log: 'AIAgent' },
  knowledge_bases: { fields: ['name', 'qas'], json: ['qas'], role: 'Admin', log: 'KnowledgeBase' },
  campaigns: { fields: ['name', 'channel_id', 'tag_id', 'text', 'bot_id', 'scheduled_at', 'status', 'sent', 'total'], role: 'Admin', log: 'BulkSend' },
  scheduled_messages: { fields: ['contact_id', 'channel_id', 'type', 'text', 'bot_id', 'send_at', 'status', 'error'], role: 'Member', log: 'ScheduledMessage' },
  webhooks: { fields: ['name', 'url', 'events', 'active', 'secret'], json: ['events'], role: 'Admin', log: 'Webhook' },
};
for (const [t, d] of Object.entries(R))
  db.exec(`CREATE TABLE IF NOT EXISTS ${t}(id INTEGER PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')), ${[...d.fields, ...(d.hide || [])].join(',')})`);
db.exec(`
CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, channel_id, sector_id, member_id,
  state TEXT DEFAULT 'Open', private INTEGER DEFAULT 0, bot TEXT, ai_agent_id, unread INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), closed_at, first_response_at, last_message_at, last_contact_at, last_text);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE, source TEXT, member_id,
  type TEXT DEFAULT 'Text', text TEXT, note INTEGER DEFAULT 0, state TEXT DEFAULT 'Sent', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS contact_notes(id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, member_id, text, pinned INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS contact_tags(contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(contact_id, tag_id));
CREATE TABLE IF NOT EXISTS chat_tags(chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE, tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(chat_id, tag_id));
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, member_id, type, detail, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tokens(id INTEGER PRIMARY KEY, member_id, name, token_hash, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS webhook_logs(id INTEGER PRIMARY KEY, webhook_id, event, status, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS widget_sessions(token TEXT PRIMARY KEY, contact_id, channel_id);
`);
const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19); // same UTC format as SQLite datetime('now')

const DEFAULT_SETTINGS = {
  org_name: 'Minha empresa', signature: 'optional', // optional | always | never
  close_message: '', transfer_scope: 'all', read_on_open: true,
  inactivity_minutes: 0, inactivity_message: 'Encerramos a conversa por falta de resposta. Volte quando quiser!',
};
const getSettings = () => ({ ...DEFAULT_SETTINGS, ...JSON.parse(q1('SELECT value FROM settings WHERE key=?', 'org')?.value || '{}') });
if (!q1('SELECT id FROM sectors LIMIT 1')) run("INSERT INTO sectors(name,is_default) VALUES('Geral',1)");
if (!q1('SELECT id FROM channels LIMIT 1')) run("INSERT INTO channels(name,type,active) VALUES('Site (widget)','Widget',1)");

// ---------- helpers ----------
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const checkPw = (pw, stored) => { const [salt] = String(stored).split(':'); const a = Buffer.from(hash(pw, salt)), b = Buffer.from(String(stored)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const decode = (t, row) => { if (!row) return row; for (const f of R[t]?.json || []) try { row[f] = JSON.parse(row[f] ?? 'null'); } catch { } for (const f of R[t]?.hide || []) delete row[f]; return row; };
const encode = (t, f, v) => (R[t].json || []).includes(f) ? JSON.stringify(v ?? null) : (typeof v === 'boolean' ? Number(v) : v);
const logAct = (member_id, type, detail) => run('INSERT INTO activity(member_id,type,detail) VALUES(?,?,?)', member_id ?? null, type, String(detail).slice(0, 300));
const render = (text, ctx) => String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => k.split('.').reduce((o, p) => o?.[p], ctx) ?? '');
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const must = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

// ---------- realtime (SSE) ----------
const streams = new Set(); // {res, member} for attendants, {res, widgetChat} for contacts
function emit(type, data, { chatId } = {}) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of streams) {
    if (s.member) s.res.write(line);
    else if (chatId && s.widgetChat() === chatId && !(type === 'message' && data.note)) s.res.write(line);
  }
}

// ---------- webhooks ----------
async function dispatch(event, payload) {
  for (const w of q('SELECT * FROM webhooks').map(r => decode('webhooks', r))) {
    if (!truthy(w.active)) continue;
    if (Array.isArray(w.events) && w.events.length && !w.events.includes(event)) continue;
    const body = JSON.stringify({ type: event, eventDate: new Date().toISOString(), payload });
    const headers = { 'content-type': 'application/json' };
    if (w.secret) headers['x-signature'] = crypto.createHmac('sha256', w.secret).update(body).digest('hex');
    let status;
    try { status = (await fetch(w.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) })).status; }
    catch (e) { status = 'erro: ' + e.message; }
    run('INSERT INTO webhook_logs(webhook_id,event,status) VALUES(?,?,?)', w.id, event, String(status));
  }
}
const fire = (event, payload) => { dispatch(event, payload).catch(e => console.error('webhook', e)); };

// ---------- chat core ----------
function chatFull(id) {
  const c = q1(`SELECT ch.*, co.name contact_name, co.phone contact_phone, co.email contact_email, co.blocked contact_blocked,
    m.name member_name, s.name sector_name, cn.name channel_name, cn.type channel_type
    FROM chats ch JOIN contacts co ON co.id=ch.contact_id LEFT JOIN members m ON m.id=ch.member_id
    LEFT JOIN sectors s ON s.id=ch.sector_id LEFT JOIN channels cn ON cn.id=ch.channel_id WHERE ch.id=?`, id);
  if (!c) return null;
  c.tags = q('SELECT t.* FROM tags t JOIN chat_tags x ON x.tag_id=t.id WHERE x.chat_id=?', id);
  c.bot = c.bot ? JSON.parse(c.bot) : null;
  return c;
}
function addMessage(chatId, { source, member_id = null, text, note = 0, type = 'Text' }) {
  const chat = q1('SELECT * FROM chats WHERE id=?', chatId);
  must(chat, 404, 'Conversa não encontrada');
  const id = run('INSERT INTO messages(chat_id,source,member_id,type,text,note) VALUES(?,?,?,?,?,?)', chatId, source, member_id, type, text, note ? 1 : 0).lastInsertRowid;
  const t = now();
  if (!note) {
    run('UPDATE chats SET last_message_at=?, last_text=? WHERE id=?', t, String(text).slice(0, 120), chatId);
    if (source === 'Contact') run('UPDATE chats SET unread=unread+1, last_contact_at=? WHERE id=?', t, chatId);
    if (source === 'Member') run('UPDATE chats SET unread=0, first_response_at=coalesce(first_response_at, ?) WHERE id=?', t, chatId);
  }
  const msg = q1('SELECT m.*, mb.name member_name FROM messages m LEFT JOIN members mb ON mb.id=m.member_id WHERE m.id=?', id);
  emit('message', msg, { chatId });
  emit('chat', chatFull(chatId));
  if (!note) fire('Message', { chat: chatFull(chatId), message: msg });
  return msg;
}
function updateChat(id, fields, { by = null, event, activity } = {}) {
  const keys = Object.keys(fields);
  if (keys.length) run(`UPDATE chats SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => fields[k]), id);
  const c = chatFull(id);
  emit('chat', c);
  if (event) fire(event, { chat: c });
  if (activity) logAct(by, activity, `Conversa #${id} (${c.contact_name})`);
  return c;
}
const defaultSector = () => q1('SELECT id FROM sectors ORDER BY is_default DESC, id LIMIT 1')?.id ?? null;
function findOrCreateContact({ phone, name, email }) {
  let c = phone ? q1('SELECT * FROM contacts WHERE phone=?', phone) : null;
  if (!c) {
    const id = run("INSERT INTO contacts(name,phone,email,blocked,custom) VALUES(?,?,?,0,'{}')", name || phone || 'Visitante', phone || null, email || null).lastInsertRowid;
    c = q1('SELECT * FROM contacts WHERE id=?', id);
    logAct(null, 'ContactCreated', c.name);
  }
  return c;
}
function openChatFor(contactId, channelId, { byContact = false } = {}) {
  let chat = q1("SELECT * FROM chats WHERE contact_id=? AND channel_id=? AND state='Open'", contactId, channelId);
  if (chat) return { chat, created: false };
  const id = run('INSERT INTO chats(contact_id,channel_id,sector_id) VALUES(?,?,?)', contactId, channelId, defaultSector()).lastInsertRowid;
  chat = q1('SELECT * FROM chats WHERE id=?', id);
  logAct(null, 'ChatCreated', `Conversa #${id}`);
  fire('NewChat', { chat: chatFull(id), createdByContact: byContact });
  return { chat, created: true };
}

// Inbound message from a contact (widget, simulator, or provider webhook)
async function inbound({ channel_id, phone, name, email, text, contact_id }) {
  must(String(text || '').trim(), 400, 'Mensagem vazia');
  const channel = q1('SELECT * FROM channels WHERE id=?', channel_id);
  must(channel, 404, 'Canal não encontrado');
  const contact = contact_id ? q1('SELECT * FROM contacts WHERE id=?', contact_id) : findOrCreateContact({ phone, name, email });
  must(contact, 404, 'Contato não encontrado');
  if (truthy(contact.blocked)) return { blocked: true };
  const { chat, created } = openChatFor(contact.id, channel.id, { byContact: true });
  const msg = addMessage(chat.id, { source: 'Contact', text });
  if (created && channel.bot_id) await startBot(chat.id, channel.bot_id);
  else if (chat.bot) await continueBot(chat.id, text);
  else if (chat.ai_agent_id) await aiReply(chat.id);
  return { chat_id: chat.id, message: msg };
}

// ---------- chatbot engine ----------
// Bot = ordered steps {id, type, ...}. Branching via step ids (`goto`). Waiting steps: options, question.
function botCtx(chatId, vars = {}) {
  const c = chatFull(chatId);
  const contact = decode('contacts', q1('SELECT * FROM contacts WHERE id=?', c.contact_id));
  return { contact: { ...(contact.custom || {}), ...contact }, chat: c, vars, org: getSettings() };
}
const loadBot = (id) => decode('bots', q1('SELECT * FROM bots WHERE id=?', id));
const indexOf = (bot, id) => { const i = bot.steps.findIndex(s => String(s.id) === String(id)); return i < 0 ? bot.steps.length : i; };
async function startBot(chatId, botId) {
  const bot = loadBot(botId);
  if (!bot || !Array.isArray(bot.steps) || !bot.steps.length) return;
  updateChat(chatId, { bot: JSON.stringify({ bot_id: bot.id, pos: 0, vars: {} }) });
  return runBot(chatId);
}
const stopBot = (chatId) => updateChat(chatId, { bot: null });
async function continueBot(chatId, answer) {
  const chat = chatFull(chatId); const st = chat.bot; if (!st) return;
  const bot = loadBot(st.bot_id); const step = bot?.steps?.[st.pos];
  if (!step) return stopBot(chatId);
  const say = (t) => addMessage(chatId, { source: 'Bot', text: render(t, botCtx(chatId, st.vars)) });
  if (step.type === 'options') {
    const opts = step.options || [];
    const a = String(answer).trim().toLowerCase();
    const i = opts.findIndex((o, k) => a === String(k + 1) || a === String(o.label).trim().toLowerCase());
    if (i < 0) return say(step.error || 'Opção inválida. Responda com o número da opção.');
    st.vars[step.save_as || 'opcao'] = opts[i].label;
    st.pos = opts[i].goto ? indexOf(bot, opts[i].goto) : st.pos + 1;
  } else if (step.type === 'question') {
    let ok = true; try { ok = !step.regex || new RegExp(step.regex, 'i').test(String(answer).trim()); } catch { }
    if (!ok) return say(step.error || 'Resposta inválida, tente novamente.');
    const key = step.save_as || 'resposta';
    st.vars[key] = answer;
    if (['name', 'email', 'phone'].includes(key)) run(`UPDATE contacts SET ${key}=? WHERE id=?`, answer, chat.contact_id);
    else if (step.save_as) {
      const c = decode('contacts', q1('SELECT * FROM contacts WHERE id=?', chat.contact_id));
      run('UPDATE contacts SET custom=? WHERE id=?', JSON.stringify({ ...(c.custom || {}), [key]: answer }), chat.contact_id);
    }
    st.pos += 1;
  } else st.pos += 1;
  updateChat(chatId, { bot: JSON.stringify(st) });
  return runBot(chatId);
}
async function runBot(chatId) {
  for (let guard = 0; guard < 100; guard++) {
    const chat = chatFull(chatId); const st = chat?.bot; if (!st || chat.state !== 'Open') return;
    const bot = loadBot(st.bot_id); const step = bot?.steps?.[st.pos];
    if (!step || step.type === 'end') return stopBot(chatId);
    const ctx = botCtx(chatId, st.vars);
    const say = (t) => t && addMessage(chatId, { source: 'Bot', text: render(t, ctx) });
    const next = (pos = st.pos + 1) => { st.pos = pos; updateChat(chatId, { bot: JSON.stringify(st) }); };
    switch (step.type) {
      case 'message': say(step.text); next(); break;
      case 'options': say([step.text, ...(step.options || []).map((o, i) => `${i + 1} - ${o.label}`)].join('\n')); return; // waits for answer
      case 'question': say(step.text); return; // waits for answer
      case 'tag':
        if (step.tag_id) { run('INSERT OR IGNORE INTO chat_tags VALUES(?,?)', chatId, step.tag_id); run('INSERT OR IGNORE INTO contact_tags VALUES(?,?)', chat.contact_id, step.tag_id); fire('ChatTagChanged', { chat: chatFull(chatId) }); }
        next(); break;
      case 'sector': say(step.text); updateChat(chatId, { sector_id: step.sector_id, member_id: null, bot: null }, { event: 'ChatSectorChanged' }); return;
      case 'member': say(step.text); updateChat(chatId, { member_id: step.member_id, bot: null }, { event: 'MemberTransfer' }); return;
      case 'ai': say(step.text); updateChat(chatId, { ai_agent_id: step.agent_id, bot: null }); return aiReply(chatId);
      case 'close': say(step.text); closeChat(chatId, null, { silent: true }); return;
      case 'wait': next(); setTimeout(() => runBot(chatId).catch(console.error), Math.min(Number(step.seconds) || 1, 3600) * 1000); return;
      case 'hours': { // business hours check (server local time)
        const d = new Date(), hm = d.toTimeString().slice(0, 5);
        const open = (step.days || [1, 2, 3, 4, 5]).map(Number).includes(d.getDay()) && hm >= (step.from || '08:00') && hm < (step.to || '18:00');
        next(open ? st.pos + 1 : indexOf(bot, step.goto_else)); break;
      }
      case 'condition': {
        const v = String(render(`{{${step.field}}}`, ctx)).trim().toLowerCase();
        next(v === String(step.equals ?? '').trim().toLowerCase() ? st.pos + 1 : indexOf(bot, step.goto_else)); break;
      }
      case 'webhook': {
        try {
          const r = await fetch(step.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact: ctx.contact, chat_id: chatId, vars: st.vars }), signal: AbortSignal.timeout(8000) });
          const data = await r.json().catch(() => null);
          if (data && typeof data === 'object') st.vars.webhook = data;
        } catch { st.vars.webhook_error = true; }
        next(); break;
      }
      case 'goto': next(indexOf(bot, step.goto)); break;
      default: next();
    }
  }
}

// ---------- AI: fallback chain over Claude (Anthropic SDK) and OpenAI-compatible APIs ----------
// Order: AI_PROVIDERS=gemini,groq,... (or AI_PROVIDER=x); else every provider with a key, in the order below.
// Per provider: <NAME>_API_KEY, <NAME>_MODEL, <NAME>_BASE_URL. Default models can go stale: override <NAME>_MODEL.
const AI_PRESETS = {
  anthropic: { key: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY', model: 'gemini-2.5-flash' },
  groq: { url: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile' },
  openrouter: { url: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1', key: 'NVIDIA_API_KEY', model: 'meta/llama-3.3-70b-instruct' },
  custom: { key: 'AI_API_KEY' }, // any OpenAI-compatible server: AI_BASE_URL + AI_MODEL
  ollama: { url: 'http://localhost:11434/v1', key: null, model: 'qwen2.5:7b' }, // only when listed explicitly
};
const penv = (n, k) => process.env[`${n.toUpperCase()}_${k}`];
const hasKey = (n) => n === 'anthropic' ? !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.AI_ENABLED)
  : n === 'custom' ? !!process.env.AI_BASE_URL : n !== 'ollama' && !!process.env[AI_PRESETS[n].key];
function aiChain() {
  const listed = (process.env.AI_PROVIDERS || process.env.AI_PROVIDER || '').split(',').map(s => s.trim().toLowerCase()).filter(n => AI_PRESETS[n]);
  return listed.length ? listed : Object.keys(AI_PRESETS).filter(hasKey);
}
const aiCooldown = new Map(); // provider -> timestamp until which it is skipped after a failure
async function callOpenAI(n, system, messages, max_tokens, single) {
  const p = AI_PRESETS[n];
  const url = (penv(n, 'BASE_URL') || (n === 'custom' ? process.env.AI_BASE_URL : p.url) || '').replace(/\/$/, '') + '/chat/completions';
  const key = (p.key && process.env[p.key]) || (single && process.env.AI_API_KEY);
  const r = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', ...(key && { authorization: 'Bearer ' + key }) },
    body: JSON.stringify({ model: penv(n, 'MODEL') || ((single || n === 'custom') && process.env.AI_MODEL) || p.model, max_tokens, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${n}: ${j.error?.message || j[0]?.error?.message || 'HTTP ' + r.status}`), { status: r.status });
  return String(j.choices?.[0]?.message?.content || '').trim() || null;
}
let anthropic = null;
async function callAnthropic(n, system, messages, max_tokens, single) {
  if (!anthropic) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = new Anthropic(); // resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile
  }
  const r = await anthropic.beta.messages.create({
    model: penv(n, 'MODEL') || (single && process.env.AI_MODEL) || AI_PRESETS.anthropic.model, max_tokens, system, messages,
    output_config: { effort: 'low' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  });
  if (r.stop_reason === 'refusal') return null;
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
// Tries each provider in order; a failed one (quota, outage, bad model) is skipped for a while and the next answers.
async function claude(system, messages, max_tokens = 2000) {
  const chain = aiChain(), ready = chain.filter(n => !(aiCooldown.get(n) > Date.now()));
  let lastErr = null;
  for (const n of ready.length ? ready : chain) {
    try {
      const out = await (n === 'anthropic' ? callAnthropic : callOpenAI)(n, system, messages, max_tokens, chain.length === 1);
      if (out) return out; // empty answer or refusal: try the next provider
    } catch (e) {
      lastErr = e; aiCooldown.set(n, Date.now() + (e.status === 429 ? 60000 : 15000));
      console.warn('IA falhou, tentando o próximo provedor:', e.message);
    }
  }
  if (lastErr) throw new HttpError(502, 'IA indisponível: ' + lastErr.message);
  return null;
}
const aiAvailable = () => aiChain().length > 0;
const transcript = (chatId, limit = 30) => q('SELECT source,text FROM messages WHERE chat_id=? AND note=0 ORDER BY id DESC LIMIT ?', chatId, limit).reverse();
async function aiReply(chatId) {
  const chat = chatFull(chatId);
  const agent = decode('ai_agents', q1('SELECT * FROM ai_agents WHERE id=?', chat?.ai_agent_id));
  if (!agent) return;
  if (!aiAvailable()) {
    addMessage(chatId, { source: 'Bot', text: 'IA indisponível (configure a chave da IA). Conversa enviada para a fila.', note: 1 });
    return updateChat(chatId, { ai_agent_id: null });
  }
  const kb = (agent.kb_ids || []).map(id => decode('knowledge_bases', q1('SELECT * FROM knowledge_bases WHERE id=?', id))).filter(Boolean)
    .flatMap(k => (k.qas || []).map(x => `P: ${x.q}\nR: ${x.a}`)).join('\n\n');
  const system = `${agent.prompt || 'Você é um atendente virtual educado.'}\n\nEmpresa: ${getSettings().org_name}. Cliente: ${chat.contact_name}.\n` +
    (kb ? `Base de conhecimento (use como fonte principal):\n${kb}\n` : '') +
    'Responda em português, de forma curta, como mensagem de chat. Se o cliente pedir um humano ou você não souber responder, responda exatamente [TRANSFERIR].';
  const msgs = [];
  for (const m of transcript(chatId)) {
    const role = m.source === 'Contact' ? 'user' : 'assistant';
    if (msgs.length && msgs.at(-1).role === role) msgs.at(-1).content += '\n' + m.text; else msgs.push({ role, content: m.text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs.at(-1).role !== 'user') return;
  let text;
  try { text = await claude(system, msgs, 1000); }
  catch (e) { addMessage(chatId, { source: 'Bot', text: 'Erro da IA: ' + e.message, note: 1 }); text = '[TRANSFERIR]'; }
  if (!text || text.includes('[TRANSFERIR]')) {
    addMessage(chatId, { source: 'Bot', text: 'Vou te transferir para um atendente, só um momento.' });
    return updateChat(chatId, { ai_agent_id: null, member_id: null, sector_id: agent.transfer_sector_id || chat.sector_id }, { event: 'MemberTransfer' });
  }
  addMessage(chatId, { source: 'Bot', text });
}

function closeChat(id, by, { message, silent } = {}) {
  const s = getSettings();
  const member = by ? q1('SELECT closing_message FROM members WHERE id=?', by) : null;
  const msg = message ?? (member?.closing_message || s.close_message);
  if (msg && !silent) addMessage(id, { source: by ? 'Member' : 'Bot', member_id: by, text: msg });
  return updateChat(id, { state: 'Closed', closed_at: now(), bot: null, ai_agent_id: null }, { by, event: 'ChatClosed', activity: 'ChatClosed' });
}

// ---------- scheduler: campaigns, scheduled messages, inactivity ----------
async function sendToContact(contactId, channelId, { text, bot_id }) {
  const { chat } = openChatFor(contactId, channelId);
  if (text) addMessage(chat.id, { source: 'Bot', text: render(text, botCtx(chat.id)) });
  if (bot_id) await startBot(chat.id, bot_id);
  return chat.id;
}
const due = (col) => `(${col} IS NULL OR ${col}='' OR datetime(replace(${col},'T',' '),'utc')<=datetime('now'))`; // UI sends local time
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    for (const c of q(`SELECT * FROM campaigns WHERE status='Scheduled' AND ${due('scheduled_at')}`)) {
      run("UPDATE campaigns SET status='Sending' WHERE id=?", c.id);
      const contacts = c.tag_id ? q('SELECT c.id FROM contacts c JOIN contact_tags x ON x.contact_id=c.id WHERE x.tag_id=? AND coalesce(c.blocked,0) IN (0,\'0\')', c.tag_id) : q("SELECT id FROM contacts WHERE coalesce(blocked,0) IN (0,'0')");
      run('UPDATE campaigns SET total=?, sent=0 WHERE id=?', contacts.length, c.id);
      let sent = 0;
      for (const k of contacts) { try { await sendToContact(k.id, c.channel_id, c); sent++; } catch (e) { console.error('campaign', e.message); } run('UPDATE campaigns SET sent=? WHERE id=?', sent, c.id); }
      run("UPDATE campaigns SET status='Sent' WHERE id=?", c.id);
      logAct(null, 'BulkSendFinished', `${c.name}: ${sent}/${contacts.length}`);
    }
    for (const m of q(`SELECT * FROM scheduled_messages WHERE status='Pending' AND ${due('send_at')}`)) {
      try {
        if (m.type === 'InternalNote') { const { chat } = openChatFor(m.contact_id, m.channel_id); addMessage(chat.id, { source: 'Bot', text: m.text, note: 1 }); }
        else await sendToContact(m.contact_id, m.channel_id, { text: m.type === 'Bot' ? '' : m.text, bot_id: m.type === 'Bot' ? m.bot_id : null });
        run("UPDATE scheduled_messages SET status='Sent' WHERE id=?", m.id);
      } catch (e) { run("UPDATE scheduled_messages SET status='Error', error=? WHERE id=?", e.message, m.id); }
    }
    const s = getSettings();
    if (Number(s.inactivity_minutes) > 0) { // close chats whose last message was ours and the contact never answered
      for (const c of q("SELECT id FROM chats WHERE state='Open' AND last_message_at < datetime('now', ?) AND (last_contact_at IS NULL OR last_contact_at < last_message_at)", `-${Number(s.inactivity_minutes)} minutes`))
        closeChat(c.id, null, { message: s.inactivity_message });
    }
  } finally { ticking = false; }
}

// ---------- reports ----------
function reports({ from, to }) {
  // Accepts dates (YYYY-MM-DD, whole UTC day) or UTC datetimes (the UI sends local-day bounds converted to UTC).
  from = from || '1970-01-01'; to = !to ? '9999-12-31 23:59:59' : to.length > 10 ? to : to + ' 23:59:59';
  const w = 'c.created_at BETWEEN ? AND ?';
  const one = (sql) => q1(sql, from, to)?.n ?? 0;
  const list = (sql) => q(sql, from, to);
  return {
    total: one(`SELECT count(*) n FROM chats c WHERE ${w}`),
    open: one(`SELECT count(*) n FROM chats c WHERE ${w} AND state='Open'`),
    closed: one(`SELECT count(*) n FROM chats c WHERE ${w} AND state='Closed'`),
    interacted: one(`SELECT count(*) n FROM chats c WHERE ${w} AND first_response_at IS NOT NULL`),
    avg_first_response_s: Math.round(one(`SELECT avg((julianday(first_response_at)-julianday(created_at))*86400) n FROM chats c WHERE ${w} AND first_response_at IS NOT NULL`) || 0),
    avg_close_s: Math.round(one(`SELECT avg((julianday(closed_at)-julianday(created_at))*86400) n FROM chats c WHERE ${w} AND closed_at IS NOT NULL`) || 0),
    by_member: list(`SELECT coalesce(m.name,'Sem atendente') label, count(*) n FROM chats c LEFT JOIN members m ON m.id=c.member_id WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`),
    by_channel: list(`SELECT coalesce(ch.name,'?') label, count(*) n FROM chats c LEFT JOIN channels ch ON ch.id=c.channel_id WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`),
    by_sector: list(`SELECT coalesce(s.name,'?') label, count(*) n FROM chats c LEFT JOIN sectors s ON s.id=c.sector_id WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`),
    by_tag: list(`SELECT t.name label, count(*) n FROM chat_tags x JOIN tags t ON t.id=x.tag_id JOIN chats c ON c.id=x.chat_id WHERE ${w} GROUP BY 1 ORDER BY 2 DESC`),
    by_day: list(`SELECT substr(c.created_at,1,10) label, count(*) n FROM chats c WHERE ${w} GROUP BY 1 ORDER BY 1`),
    by_hour: list(`SELECT substr(c.created_at,12,2) label, count(*) n FROM chats c WHERE ${w} GROUP BY 1 ORDER BY 1`),
    by_ddd: list(`SELECT substr(replace(replace(co.phone,'+',''),' ',''),3,2) label, count(*) n FROM chats c JOIN contacts co ON co.id=c.contact_id WHERE ${w} AND replace(co.phone,'+','') LIKE '55%' GROUP BY 1 ORDER BY 2 DESC`),
    messages: list(`SELECT source label, count(*) n FROM messages c WHERE ${w} AND note=0 GROUP BY 1`),
  };
}

// ---------- HTTP ----------
async function readBody(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 5e6) throw new HttpError(413, 'Corpo muito grande'); }
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new HttpError(400, 'JSON inválido'); }
}
function auth(req, u) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : u.searchParams.get('token') || (req.headers.cookie || '').match(/sid=([\w-]+)/)?.[1];
  if (!tok) return null;
  let m = q1('SELECT * FROM members WHERE session=?', sha(tok));
  if (!m) { const t = q1('SELECT member_id FROM tokens WHERE token_hash=?', sha(tok)); if (t) m = q1('SELECT * FROM members WHERE id=?', t.member_id); }
  return m && truthy(m.active) ? decode('members', m) : null;
}
const can = (me, role) => ROLES.indexOf(me.role) >= ROLES.indexOf(role);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

const routes = []; // [method, regex, handler, {public}]
const on = (method, pattern, handler, opts = {}) => routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler, opts]);

// setup + auth
on('GET', '/api/v1/setup', () => ({ needsSetup: !q1('SELECT id FROM members LIMIT 1'), ai: aiAvailable() }), { public: true });
on('POST', '/api/v1/setup', ({ b }) => {
  must(!q1('SELECT id FROM members LIMIT 1'), 400, 'Já configurado');
  must(b.name && b.email && String(b.password || '').length >= 6, 400, 'Nome, e-mail e senha (6+) obrigatórios');
  run("INSERT INTO members(name,email,role,active,sector_ids,password_hash) VALUES(?,?,'Owner',1,'[]',?)", b.name, String(b.email).toLowerCase(), hash(b.password));
  if (b.org_name) run("INSERT OR REPLACE INTO settings VALUES('org',?)", JSON.stringify({ ...getSettings(), org_name: b.org_name }));
  return { ok: true };
}, { public: true });
on('POST', '/api/v1/auth/login', ({ b, res }) => {
  const m = q1('SELECT * FROM members WHERE email=?', String(b.email || '').toLowerCase());
  must(m && checkPw(String(b.password || ''), m.password_hash) && truthy(m.active), 401, 'E-mail ou senha inválidos');
  const tok = crypto.randomUUID();
  run('UPDATE members SET session=? WHERE id=?', sha(tok), m.id);
  res.setHeader('set-cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/`);
  logAct(m.id, 'Login', m.email);
  return { token: tok, member: decode('members', m) };
}, { public: true });
on('POST', '/api/v1/auth/logout', ({ me, res }) => { run('UPDATE members SET session=NULL WHERE id=?', me.id); res.setHeader('set-cookie', 'sid=; Max-Age=0; Path=/'); return { ok: true }; });
on('GET', '/api/v1/me', ({ me }) => ({ ...me, settings: getSettings(), ai: aiAvailable() }));
on('PUT', '/api/v1/me', ({ me, b }) => {
  for (const f of ['name', 'phone', 'closing_message']) if (f in b) run(`UPDATE members SET ${f}=? WHERE id=?`, b[f], me.id);
  if ('prefs' in b) run('UPDATE members SET prefs=? WHERE id=?', JSON.stringify(b.prefs), me.id);
  if (b.password) { must(String(b.password).length >= 6, 400, 'Senha precisa de 6+ caracteres'); run('UPDATE members SET password_hash=? WHERE id=?', hash(b.password), me.id); }
  return decode('members', q1('SELECT * FROM members WHERE id=?', me.id));
});
on('GET', '/api/v1/tokens', ({ me }) => q('SELECT id,name,created_at FROM tokens WHERE member_id=?', me.id));
on('POST', '/api/v1/tokens', ({ me, b }) => { const t = 'atk_' + crypto.randomBytes(24).toString('hex'); run('INSERT INTO tokens(member_id,name,token_hash) VALUES(?,?,?)', me.id, b.name || 'Token', sha(t)); return { token: t }; });
on('DELETE', '/api/v1/tokens/:id', ({ me, p }) => { run('DELETE FROM tokens WHERE id=? AND member_id=?', p.id, me.id); return { ok: true }; });
on('GET', '/api/v1/settings', () => getSettings());
on('PUT', '/api/v1/settings', ({ me, b }) => {
  must(can(me, 'Admin'), 403, 'Sem permissão');
  const clean = Object.fromEntries(Object.entries(b).filter(([k]) => k in DEFAULT_SETTINGS));
  run("INSERT OR REPLACE INTO settings VALUES('org',?)", JSON.stringify({ ...getSettings(), ...clean }));
  logAct(me.id, 'OrganizationUpdated', Object.keys(clean).join(','));
  return getSettings();
});

// realtime
on('GET', '/api/v1/events', ({ me, req, res }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const s = { res, member: me }; streams.add(s); res.write('event: hello\ndata: {}\n\n');
  const ka = setInterval(() => res.write(': ka\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); streams.delete(s); });
});

// chats
on('GET', '/api/v1/chats', ({ me, u }) => {
  const tab = u.searchParams.get('tab') || 'inbox', s = `%${u.searchParams.get('q') || ''}%`;
  const where = { inbox: "c.state='Open' AND c.member_id=?", waiting: "c.state='Open' AND c.member_id IS NULL", closed: "c.state='Closed'", all: '1=1' }[tab] || '1=1';
  const args = tab === 'inbox' ? [me.id] : [];
  let extra = '';
  for (const [k, sql] of [['sector_id', ' AND c.sector_id=?'], ['channel_id', ' AND c.channel_id=?'], ['member_id', ' AND c.member_id=?'], ['tag_id', ' AND c.id IN (SELECT chat_id FROM chat_tags WHERE tag_id=?)']])
    if (u.searchParams.get(k)) { extra += sql; args.push(u.searchParams.get(k)); }
  if (!can(me, 'Admin')) { extra += ' AND (c.private=0 OR c.member_id=?)'; args.push(me.id); }
  return q(`SELECT c.id FROM chats c JOIN contacts co ON co.id=c.contact_id WHERE ${where}${extra} AND (co.name LIKE ? OR coalesce(co.phone,'') LIKE ? OR coalesce(c.last_text,'') LIKE ?)
    ORDER BY coalesce(c.last_message_at,c.created_at) DESC LIMIT 200`, ...args, s, s, s).map(r => chatFull(r.id));
});
on('GET', '/api/v1/chats-counts', ({ me }) => ({
  inbox: q1("SELECT count(*) n FROM chats WHERE state='Open' AND member_id=?", me.id).n,
  waiting: q1("SELECT count(*) n FROM chats WHERE state='Open' AND member_id IS NULL").n,
  unread: q1("SELECT coalesce(sum(unread),0) n FROM chats WHERE state='Open' AND member_id=?", me.id).n,
}));
on('POST', '/api/v1/chats', ({ me, b }) => {
  const contact = b.contact_id ? q1('SELECT * FROM contacts WHERE id=?', b.contact_id) : findOrCreateContact(b);
  must(contact, 404, 'Contato não encontrado');
  const channelId = b.channel_id || q1('SELECT id FROM channels ORDER BY id LIMIT 1')?.id;
  must(channelId, 400, 'Nenhum canal configurado');
  const { chat } = openChatFor(contact.id, channelId);
  if (!chat.member_id) updateChat(chat.id, { member_id: me.id });
  if (b.text) addMessage(chat.id, { source: 'Member', member_id: me.id, text: b.text });
  return chatFull(chat.id);
});
on('GET', '/api/v1/chats/:id', ({ me, p }) => {
  const c = chatFull(p.id); must(c, 404, 'Conversa não encontrada');
  must(!truthy(c.private) || c.member_id === me.id || can(me, 'Admin'), 403, 'Conversa privada');
  if (getSettings().read_on_open && c.member_id === me.id) { run('UPDATE chats SET unread=0 WHERE id=?', p.id); c.unread = 0; }
  c.messages = q('SELECT m.*, mb.name member_name FROM messages m LEFT JOIN members mb ON mb.id=m.member_id WHERE chat_id=? ORDER BY m.id', p.id);
  return c;
});
on('POST', '/api/v1/chats/:id/messages', ({ me, p, b }) => {
  must(String(b.text || '').trim(), 400, 'Mensagem vazia');
  const chat = chatFull(p.id); must(chat, 404, 'Conversa não encontrada');
  must(chat.state === 'Open' || b.note, 400, 'Conversa finalizada — reabra para responder');
  let text = String(b.text); const sig = getSettings().signature;
  if (!b.note && (sig === 'always' || (sig === 'optional' && b.signature))) text = `*${me.name}:*\n${text}`;
  if (!b.note) {
    const f = {}; if (chat.bot) f.bot = null; if (!chat.member_id) f.member_id = me.id; if (chat.ai_agent_id) f.ai_agent_id = null; // a human reply takes over
    if (Object.keys(f).length) updateChat(p.id, f);
  }
  return addMessage(p.id, { source: 'Member', member_id: me.id, text, note: b.note });
});
on('PUT', '/api/v1/chats/:id/assign', ({ me, p, b }) => updateChat(p.id, { member_id: 'member_id' in b ? b.member_id : me.id }, { by: me.id, event: 'MemberTransfer', activity: 'ChatTransfered' }));
on('PUT', '/api/v1/chats/:id/transfer', ({ me, p, b }) => {
  const f = { member_id: b.member_id || null }; if (b.sector_id) f.sector_id = b.sector_id;
  if (b.note) addMessage(p.id, { source: 'Member', member_id: me.id, text: b.note, note: 1 });
  return updateChat(p.id, f, { by: me.id, event: b.sector_id ? 'ChatSectorChanged' : 'MemberTransfer', activity: 'ChatTransfered' });
});
on('PUT', '/api/v1/chats/:id/close', async ({ me, p, b }) => {
  const c = closeChat(p.id, me.id, { message: b.message });
  if (b.bot_id) { updateChat(p.id, { state: 'Open', closed_at: null, member_id: null }); await startBot(p.id, b.bot_id); }
  return chatFull(p.id) || c;
});
on('PUT', '/api/v1/chats/:id/reopen', ({ me, p }) => updateChat(p.id, { state: 'Open', closed_at: null, member_id: me.id }, { by: me.id, activity: 'ChatReopened' }));
on('PUT', '/api/v1/chats/:id/private', ({ me, p, b }) => updateChat(p.id, { private: b.private ? 1 : 0 }, { by: me.id, event: 'ChatPrivateStatusChanged', activity: b.private ? 'ChatPrivated' : 'ChatPublic' }));
on('PUT', '/api/v1/chats/:id/read', ({ p }) => updateChat(p.id, { unread: 0 }));
on('POST', '/api/v1/chats/:id/tags', ({ p, b }) => { run('INSERT OR IGNORE INTO chat_tags VALUES(?,?)', p.id, b.tag_id); return updateChat(p.id, {}, { event: 'ChatTagChanged' }); });
on('DELETE', '/api/v1/chats/:id/tags/:tag', ({ p }) => { run('DELETE FROM chat_tags WHERE chat_id=? AND tag_id=?', p.id, p.tag); return updateChat(p.id, {}, { event: 'ChatTagChanged' }); });
on('POST', '/api/v1/chats/:id/start-bot', async ({ p, b }) => { await startBot(p.id, b.bot_id); return chatFull(p.id); });
on('PUT', '/api/v1/chats/:id/stop-bot', ({ p }) => stopBot(p.id));
on('POST', '/api/v1/chats/:id/ai-agent', async ({ p, b }) => { updateChat(p.id, { ai_agent_id: b.agent_id || null, member_id: null }); if (b.agent_id) await aiReply(p.id); return chatFull(p.id); });
on('DELETE', '/api/v1/messages/:id', ({ me, p }) => {
  const m = q1('SELECT * FROM messages WHERE id=?', p.id); must(m, 404, 'Mensagem não encontrada');
  must(m.member_id === me.id || can(me, 'Admin'), 403, 'Sem permissão');
  run("UPDATE messages SET state='Deleted', text='Mensagem apagada' WHERE id=?", p.id);
  emit('message', q1('SELECT * FROM messages WHERE id=?', p.id), { chatId: m.chat_id });
  return { ok: true };
});

// contacts extras
on('GET', '/api/v1/contacts/:id/details', ({ p }) => {
  const c = decode('contacts', q1('SELECT * FROM contacts WHERE id=?', p.id)); must(c, 404, 'Contato não encontrado');
  c.tags = q('SELECT t.* FROM tags t JOIN contact_tags x ON x.tag_id=t.id WHERE x.contact_id=?', p.id);
  c.notes = q('SELECT n.*, m.name member_name FROM contact_notes n LEFT JOIN members m ON m.id=n.member_id WHERE contact_id=? ORDER BY pinned DESC, n.id DESC', p.id);
  c.chats = q('SELECT id,state,created_at,closed_at,last_text FROM chats WHERE contact_id=? ORDER BY id DESC', p.id);
  return c;
});
on('POST', '/api/v1/contacts/:id/notes', ({ me, p, b }) => { must(String(b.text || '').trim(), 400, 'Nota vazia'); run('INSERT INTO contact_notes(contact_id,member_id,text) VALUES(?,?,?)', p.id, me.id, b.text); return { ok: true }; });
on('PUT', '/api/v1/contacts/:id/notes/:nid/pin', ({ p }) => { run('UPDATE contact_notes SET pinned=1-pinned WHERE id=? AND contact_id=?', p.nid, p.id); return { ok: true }; });
on('DELETE', '/api/v1/contacts/:id/notes/:nid', ({ p }) => { run('DELETE FROM contact_notes WHERE id=? AND contact_id=?', p.nid, p.id); return { ok: true }; });
on('POST', '/api/v1/contacts/:id/tags', ({ p, b }) => { run('INSERT OR IGNORE INTO contact_tags VALUES(?,?)', p.id, b.tag_id); return { ok: true }; });
on('DELETE', '/api/v1/contacts/:id/tags/:tag', ({ p }) => { run('DELETE FROM contact_tags WHERE contact_id=? AND tag_id=?', p.id, p.tag); return { ok: true }; });
on('POST', '/api/v1/contacts-import', ({ me, b }) => { // CSV: name;phone;email with a header row
  let n = 0;
  for (const line of String(b.csv || '').split(/\r?\n/).slice(1)) {
    const [name, phone, email] = line.split(/[;,]/).map(s => s?.trim());
    if (!phone && !name) continue;
    if (phone && q1('SELECT id FROM contacts WHERE phone=?', phone)) continue;
    run("INSERT INTO contacts(name,phone,email,blocked,custom) VALUES(?,?,?,0,'{}')", name || phone, phone || null, email || null); n++;
  }
  logAct(me.id, 'ContactsImported', n); return { imported: n };
});

// inbound from a provider/simulator (authenticated with a member token)
on('POST', '/api/v1/inbound', ({ b }) => inbound(b));
// widget (public, contact side)
on('GET', '/widget/:channel/info', ({ p }) => { const ch = q1('SELECT id,name,type,active FROM channels WHERE id=?', p.channel); must(ch && truthy(ch.active), 404, 'Canal indisponível'); return { ...ch, org_name: getSettings().org_name }; }, { public: true });
on('POST', '/widget/:channel/session', ({ p, b }) => {
  const ch = q1('SELECT * FROM channels WHERE id=?', p.channel); must(ch && truthy(ch.active), 404, 'Canal indisponível');
  must(String(b.name || '').trim(), 400, 'Informe seu nome');
  const c = findOrCreateContact({ name: b.name, phone: b.phone, email: b.email });
  const token = crypto.randomUUID(); run('INSERT INTO widget_sessions VALUES(?,?,?)', token, c.id, ch.id);
  return { token, contact: { id: c.id, name: c.name } };
}, { public: true });
const widgetSession = (u) => q1('SELECT * FROM widget_sessions WHERE token=?', u.searchParams.get('t') || '');
const widgetChatId = (s) => q1('SELECT id FROM chats WHERE contact_id=? AND channel_id=? ORDER BY id DESC LIMIT 1', s.contact_id, s.channel_id)?.id;
on('POST', '/widget/messages', ({ u, b }) => { const s = widgetSession(u); must(s, 401, 'Sessão inválida'); return inbound({ channel_id: s.channel_id, contact_id: s.contact_id, text: b.text }); }, { public: true });
on('GET', '/widget/history', ({ u }) => { const s = widgetSession(u); must(s, 401, 'Sessão inválida'); const id = widgetChatId(s); return id ? q('SELECT id,source,text,created_at,state FROM messages WHERE chat_id=? AND note=0 ORDER BY id', id) : []; }, { public: true });
on('GET', '/widget/events', ({ u, req, res }) => {
  const s = widgetSession(u); must(s, 401, 'Sessão inválida');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const st = { res, widgetChat: () => widgetChatId(s) }; streams.add(st);
  const ka = setInterval(() => res.write(': ka\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); streams.delete(st); });
}, { public: true });

// AI assistant for attendants
const needAI = () => must(aiAvailable(), 400, 'IA não configurada (defina GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY, AI_PROVIDERS=ollama ou ANTHROPIC_API_KEY)');
on('POST', '/api/v1/ai/improve', async ({ b }) => { needAI(); return { text: await claude('Reescreva a mensagem do atendente melhorando gramática, clareza e cordialidade, mantendo sentido e idioma. Responda só com o texto reescrito.', [{ role: 'user', content: String(b.text || '') }], 800) }; });
on('POST', '/api/v1/ai/suggest', async ({ b }) => {
  needAI();
  const t = transcript(b.chat_id).map(m => `${m.source === 'Contact' ? 'Cliente' : 'Atendente'}: ${m.text}`).join('\n');
  const out = await claude('Você ajuda um atendente de suporte. Sugira exatamente 3 respostas curtas e diferentes para a próxima mensagem do atendente, uma por linha, sem numeração.', [{ role: 'user', content: t || '(conversa vazia)' }], 800);
  return { suggestions: String(out || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3) };
});
on('POST', '/api/v1/ai/summarize', async ({ b }) => { needAI(); const t = transcript(b.chat_id, 200).map(m => `${m.source}: ${m.text}`).join('\n'); return { text: await claude('Resuma a conversa de atendimento em até 5 tópicos curtos, em português.', [{ role: 'user', content: t || '(vazia)' }], 800) }; });

on('GET', '/api/v1/reports', ({ u }) => reports(Object.fromEntries(u.searchParams)));
on('GET', '/api/v1/activity', ({ me, u }) => q(`SELECT a.*, m.name member_name FROM activity a LEFT JOIN members m ON m.id=a.member_id ${can(me, 'Admin') ? '' : 'WHERE a.member_id=' + Number(me.id)} ORDER BY a.id DESC LIMIT ?`, Math.min(Number(u.searchParams.get('limit') || 200), 1000)));
on('GET', '/api/v1/webhook-logs', () => q('SELECT * FROM webhook_logs ORDER BY id DESC LIMIT 100'));
on('GET', '/api/v1/online', () => [...new Set([...streams].filter(s => s.member).map(s => s.member.id))]);

// generic CRUD
for (const [t, d] of Object.entries(R)) {
  on('GET', `/api/v1/${t}`, ({ u }) => {
    const s = u.searchParams.get('q'); const sf = d.fields.filter(f => !(d.json || []).includes(f)).slice(0, 3);
    return (s ? q(`SELECT * FROM ${t} WHERE ${sf.map(f => f + ' LIKE ?').join(' OR ')} ORDER BY id DESC LIMIT 500`, ...sf.map(() => `%${s}%`)) : q(`SELECT * FROM ${t} ORDER BY id DESC LIMIT 1000`)).map(r => decode(t, r));
  });
  on('GET', `/api/v1/${t}/:id`, ({ p }) => { const r = decode(t, q1(`SELECT * FROM ${t} WHERE id=?`, p.id)); must(r, 404, 'Não encontrado'); return r; });
  on('POST', `/api/v1/${t}`, ({ me, b }) => {
    must(can(me, d.role), 403, 'Sem permissão');
    if (t === 'members') {
      must(b.email && String(b.password || '').length >= 6, 400, 'E-mail e senha (6+) obrigatórios');
      must(!q1('SELECT id FROM members WHERE email=?', String(b.email).toLowerCase()), 400, 'E-mail já cadastrado');
      must(b.role !== 'Owner' || me.role === 'Owner', 403, 'Só o proprietário cria proprietários');
      b.email = String(b.email).toLowerCase(); b.active ??= 1; b.role ||= 'Member';
    }
    if (t === 'contacts') { b.blocked ??= 0; b.custom ??= {}; must(!b.phone || !q1('SELECT id FROM contacts WHERE phone=?', b.phone), 400, 'Já existe contato com este telefone'); }
    if (t === 'campaigns') { b.status = 'Scheduled'; must(b.channel_id && (b.text || b.bot_id), 400, 'Canal e mensagem (ou chatbot) obrigatórios'); }
    if (t === 'scheduled_messages') { b.status = 'Pending'; must(b.contact_id && b.channel_id && b.send_at, 400, 'Contato, canal e data obrigatórios'); }
    const f = d.fields.filter(k => k in b);
    const cols = [...f, ...(t === 'members' ? ['password_hash'] : [])];
    const vals = [...f.map(k => encode(t, k, b[k])), ...(t === 'members' ? [hash(b.password)] : [])];
    const id = run(`INSERT INTO ${t}(${cols.join(',') || 'id'}) VALUES(${cols.map(() => '?').join(',') || 'NULL'})`, ...vals).lastInsertRowid;
    logAct(me.id, d.log + 'Created', b.name || b.shortcut || b.text || id);
    return decode(t, q1(`SELECT * FROM ${t} WHERE id=?`, id));
  });
  on('PUT', `/api/v1/${t}/:id`, ({ me, p, b }) => {
    must(can(me, d.role), 403, 'Sem permissão');
    must(q1(`SELECT id FROM ${t} WHERE id=?`, p.id), 404, 'Não encontrado');
    if (t === 'members') { const target = q1('SELECT role FROM members WHERE id=?', p.id); must((target.role !== 'Owner' && b.role !== 'Owner') || me.role === 'Owner', 403, 'Sem permissão'); if (b.email) b.email = String(b.email).toLowerCase(); }
    if (t === 'campaigns') delete b.status;
    const f = d.fields.filter(k => k in b);
    if (f.length) run(`UPDATE ${t} SET ${f.map(k => k + '=?').join(',')} WHERE id=?`, ...f.map(k => encode(t, k, b[k])), p.id);
    if (t === 'members' && b.password) { must(String(b.password).length >= 6, 400, 'Senha precisa de 6+ caracteres'); run('UPDATE members SET password_hash=? WHERE id=?', hash(b.password), p.id); }
    logAct(me.id, d.log + 'Updated', b.name || p.id);
    return decode(t, q1(`SELECT * FROM ${t} WHERE id=?`, p.id));
  });
  on('DELETE', `/api/v1/${t}/:id`, ({ me, p }) => {
    must(can(me, d.role), 403, 'Sem permissão');
    if (t === 'members') must(q1('SELECT role FROM members WHERE id=?', p.id)?.role !== 'Owner', 400, 'Não é possível remover o proprietário');
    if (t === 'sectors') {
      const other = q1('SELECT id FROM sectors WHERE id<>? ORDER BY is_default DESC, id LIMIT 1', p.id);
      must(other, 400, 'Mantenha ao menos um setor');
      run('UPDATE chats SET sector_id=? WHERE sector_id=?', other.id, p.id);
    }
    run(`DELETE FROM ${t} WHERE id=?`, p.id);
    logAct(me.id, d.log + 'Deleted', p.id);
    return { ok: true };
  });
}

function serveStatic(u, res) {
  let file = path.join(PUBLIC, path.normalize(decodeURIComponent(u.pathname)).replace(/^[/\\]+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(PUBLIC, 'index.html'); // SPA fallback
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/widget/')) return serveStatic(u, res);
    for (const [method, re, handler, opts] of routes) {
      if (method !== req.method) continue;
      const m = u.pathname.match(re); if (!m) continue;
      const me = opts.public ? null : auth(req, u);
      must(opts.public || me, 401, 'Não autenticado');
      const b = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await handler({ req, res, u, me, b, p: m.groups || {} });
      if (out === undefined) return; // streaming handler owns the response
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    throw new HttpError(404, 'Rota não encontrada');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'Erro interno' }));
  }
});

export { server, db, tick };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setInterval(() => tick().catch(e => console.error('tick', e)), 5000);
  server.listen(PORT, () => console.log(`Atende rodando em http://localhost:${PORT}`));
}
