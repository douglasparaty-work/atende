// Atende — single-page app (vanilla JS, hash routing, SSE realtime).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } } };
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
const fmtTime = (s) => { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z'); const t = new Date(); return d.toDateString() === t.toDateString() ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const dur = (s) => { s = Number(s) || 0; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const ROLE_PT = { Member: 'Membro', Operator: 'Operador', Admin: 'Administrador', Owner: 'Proprietário' };
const ROLES = ['Member', 'Operator', 'Admin', 'Owner'];
const can = (role) => ROLES.indexOf(ME?.role) >= ROLES.indexOf(role);

let ME = null; const L = {}; // lookups
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(store.get('tk') && { authorization: 'Bearer ' + store.get('tk') }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && ME) { store.set('tk', null); location.reload(); }
  if (!r.ok) throw new Error(j.error || 'Erro ' + r.status);
  return j;
}
function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 3200); }
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };
async function refreshLookups() {
  const names = ['members', 'sectors', 'tags', 'channels', 'bots', 'ai_agents', 'quick_answers', 'knowledge_bases'];
  const res = await Promise.all(names.map(n => api('GET', '/api/v1/' + n).catch(() => [])));
  names.forEach((n, i) => L[n] = res[i].slice().sort((a, b) => a.id - b.id));
}
const opts = (list, label = 'name') => list.map(x => [x.id, x[label]]);
const nameOf = (list, id) => L[list]?.find(x => String(x.id) === String(id))?.name || '';

// ---------- forms & modal ----------
function field(f, v) {
  const id = 'f_' + f.k, val = v ?? f.default ?? '';
  const o = typeof f.options === 'function' ? f.options() : f.options || [];
  let input;
  switch (f.type) {
    case 'textarea': input = `<textarea id="${id}" rows="${f.rows || 4}" ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}>${esc(val)}</textarea>`; break;
    case 'select': input = `<select id="${id}">${f.empty !== false ? `<option value="">${esc(f.empty || 'Selecione')}</option>` : ''}${o.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`; break;
    case 'multi': { const set = new Set((val || []).map(String)); input = `<div id="${id}" class="row wrap">${o.map(([k, l]) => `<label class="chip"><input type="checkbox" value="${esc(k)}" ${set.has(String(k)) ? 'checked' : ''}> ${esc(l)}</label>`).join('') || '<span class="muted small">Nada cadastrado</span>'}</div>`; break; }
    case 'check': input = `<label class="row"><input type="checkbox" id="${id}" ${val && val !== '0' ? 'checked' : ''}> ${esc(f.text || '')}</label>`; break;
    case 'radio': input = `<div id="${id}">${o.map(([k, l]) => `<label class="row" style="margin:4px 0"><input type="radio" name="${id}" value="${esc(k)}" ${String(k) === String(val) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`; break;
    case 'qas': input = `<div id="${id}" class="qas">${(val || []).map(qaRow).join('')}</div><button type="button" class="btn sm" data-addqa="${id}">+ Pergunta e resposta</button>`; break;
    default: input = `<input id="${id}" type="${f.type || 'text'}" value="${esc(val)}" ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}>`;
  }
  return `<label class="f"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${input}${f.help ? `<div class="small muted" style="margin-top:4px">${f.help}</div>` : ''}</label>`;
}
const qaRow = (x = {}) => `<div class="card" style="padding:8px;margin-bottom:6px"><input placeholder="Pergunta" data-q value="${esc(x.q)}" style="margin-bottom:4px"><textarea rows="2" placeholder="Resposta" data-a>${esc(x.a)}</textarea><button type="button" class="btn sm danger" data-delqa>Remover</button></div>`;
function readForm(root, fields) {
  const out = {};
  for (const f of fields) {
    const el = $('#f_' + f.k, root); if (!el) continue;
    if (f.type === 'multi') out[f.k] = $$('input:checked', el).map(i => isNaN(i.value) ? i.value : Number(i.value));
    else if (f.type === 'check') out[f.k] = el.checked ? 1 : 0;
    else if (f.type === 'radio') out[f.k] = $('input:checked', el)?.value ?? '';
    else if (f.type === 'qas') out[f.k] = $$('.card', el).map(c => ({ q: $('[data-q]', c).value.trim(), a: $('[data-a]', c).value.trim() })).filter(x => x.q);
    else if (f.type === 'number') out[f.k] = el.value === '' ? null : Number(el.value);
    else if (f.type === 'select') out[f.k] = el.value === '' ? null : (isNaN(el.value) ? el.value : Number(el.value));
    else out[f.k] = el.value;
    if (f.required && (out[f.k] === '' || out[f.k] == null)) throw new Error(`Preencha: ${f.label}`);
  }
  return out;
}
document.addEventListener('click', (e) => {
  const add = e.target.closest('[data-addqa]'); if (add) $('#' + add.dataset.addqa).insertAdjacentHTML('beforeend', qaRow());
  const del = e.target.closest('[data-delqa]'); if (del) del.parentElement.remove();
});
function modal({ title, body = '', fields, values = {}, ok = 'Salvar', onOk, wide }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${wide ? 'style="width:min(820px,100%)"' : ''}><h2>${esc(title)}</h2>${body}${(fields || []).map(f => field(f, values[f.k])).join('')}
      <div class="actions"><button class="btn" data-x>Cancelar</button>${onOk ? `<button class="btn primary" data-ok>${esc(ok)}</button>` : ''}</div></div>`;
    document.body.append(bg);
    const close = (v) => { bg.remove(); resolve(v); };
    $('[data-x]', bg).onclick = () => close(null);
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(null); });
    bg.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    $('[data-ok]', bg)?.addEventListener('click', guard(async () => { const v = fields ? readForm(bg, fields) : {}; const r = await onOk(v, bg); if (r !== false) close(r ?? v); }));
    ($('input,textarea,select', bg) || $('[data-x]', bg)).focus();
  });
}
const confirmBox = (text) => modal({ title: 'Confirmar', body: `<p>${esc(text)}</p>`, ok: 'Confirmar', onOk: () => true });

// ---------- shell ----------
const ICON = {
  chats: '<path d="M4 5h16v11H8l-4 4z"/>', contacts: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  chatbots: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 13h.01M15 13h.01"/>', 'ai-agents': '<path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z"/>',
  bulksend: '<path d="M3 11l18-8-8 18-2-8z"/>', dashboard: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
};
const NAV = [['chats', 'Conversas'], ['contacts', 'Contatos'], ['chatbots', 'Chatbots'], ['ai-agents', 'Agentes de IA'], ['bulksend', 'Campanhas'], ['dashboard', 'Relatórios'], ['settings', 'Configurações']];
const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
function shell(section) {
  if (!$('.app')) {
    $('#root').innerHTML = `<div class="app"><nav class="side" aria-label="Menu principal"><div class="logo">A</div>
      ${NAV.map(([k, l]) => `<a href="#/${k}" data-nav="${k}" title="${l}" aria-label="${l}">${svg(k)}${k === 'chats' ? '<span class="badge hidden" id="nbadge"></span>' : ''}</a>`).join('')}
      <span class="sp"></span><a href="#/settings/profile" title="${esc(ME.name)}" aria-label="Meu perfil"><span class="avatar">${esc(initials(ME.name))}</span></a></nav><main id="main"></main></div>`;
  }
  $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === section));
  return $('#main');
}
async function updateBadge() { try { const c = await api('GET', '/api/v1/chats-counts'); const b = $('#nbadge'); if (b) { b.textContent = c.unread || c.waiting || ''; b.classList.toggle('hidden', !(c.unread || c.waiting)); } } catch { } }

// ---------- realtime ----------
let es;
function connectEvents() {
  es?.close();
  es = new EventSource('/api/v1/events?token=' + encodeURIComponent(store.get('tk')));
  es.addEventListener('message', (e) => onRealtime('message', JSON.parse(e.data)));
  es.addEventListener('chat', (e) => onRealtime('chat', JSON.parse(e.data)));
}
let listTimer;
function onRealtime(type, d) {
  clearTimeout(listTimer); listTimer = setTimeout(() => { if (CH.active) loadList(); updateBadge(); }, 250);
  if (type === 'message' && CH.chat && d.chat_id === CH.chat.id) appendMessage(d);
  if (type === 'chat' && CH.chat && d.id === CH.chat.id) { Object.assign(CH.chat, d); renderBar(); }
  if (type === 'message' && d.source === 'Contact' && !d.note) notify(d);
}
function notify(m) {
  const p = ME.prefs || {};
  if (p.sound !== 0) { try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = .06; o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + .15); } catch { } }
  if (p.notify === 'never' || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (p.notify === 'background' && document.hasFocus()) return;
  new Notification('Nova mensagem', { body: m.text });
}

// ---------- router ----------
async function route() {
  const [, sec = 'chats', a, b] = (location.hash || '#/chats').split('/');
  CH.active = false;
  const main = shell(sec);
  try {
    if (sec === 'chats') return pageChats(main, a);
    if (sec === 'contacts') return a ? pageContact(main, a) : pageCrud(main, 'contacts');
    if (sec === 'chatbots') return a ? pageBotEditor(main, a) : pageCrud(main, 'bots');
    if (sec === 'ai-agents') return pageCrud(main, 'ai_agents');
    if (sec === 'bulksend') return pageCrud(main, 'campaigns');
    if (sec === 'dashboard') return pageDashboard(main);
    if (sec === 'settings') return pageSettings(main, a || 'profile', b);
    main.innerHTML = '<div class="page"><h1>Página não encontrada</h1></div>';
  } catch (e) { main.innerHTML = `<div class="page"><h1>Erro</h1><p>${esc(e.message)}</p></div>`; }
}
window.addEventListener('hashchange', route);

// ---------- generic CRUD pages ----------
const yes = (v) => v && v !== '0' ? 'Sim' : 'Não';
const RES = {
  contacts: {
    title: 'Contatos', desc: 'Gerencie as informações dos seus contatos e acesse o histórico de mensagens.', add: 'Adicionar contato', search: true, href: (r) => '#/contacts/' + r.id,
    cols: [['name', 'Nome'], ['phone', 'Telefone'], ['email', 'E-mail'], ['blocked', 'Bloqueado', yes]],
    fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'phone', label: 'Telefone (com DDI, ex: +5511999990000)' }, { k: 'email', label: 'E-mail', type: 'email' }, { k: 'blocked', label: 'Bloqueio', type: 'check', text: 'Contato bloqueado (não pode enviar mensagens)' }],
    extra: () => `<button class="btn" id="importBtn">Importar CSV</button>`,
  },
  bots: {
    title: 'Chatbots', desc: 'Crie fluxos automáticos: menus, perguntas, etiquetas, transferências e integrações.', add: 'Novo chatbot', href: (r) => '#/chatbots/' + r.id,
    cols: [['name', 'Nome'], ['steps', 'Passos', v => (v || []).length], ['active', 'Ativo', yes], ['id', 'Canais', id => L.channels.filter(c => String(c.bot_id) === String(id)).map(c => esc(c.name)).join(', ') || '<span class="muted">—</span>', true]],
    fields: [{ k: 'name', label: 'Nome', required: true }], defaults: { active: 1, steps: [] },
  },
  ai_agents: {
    title: 'Agentes de IA', desc: 'Agentes que respondem seus contatos usando a IA configurada e as bases de conhecimento escolhidas. Sem chave de API configurada, a conversa vai para a fila.', add: 'Novo agente de IA',
    cols: [['name', 'Nome'], ['status', 'Status'], ['kb_ids', 'Bases', v => (v || []).map(id => nameOf('knowledge_bases', id)).join(', ')]],
    fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'status', label: 'Status', type: 'select', empty: false, options: [['Draft', 'Rascunho'], ['Published', 'Publicado']] },
      { k: 'prompt', label: 'Instruções (persona, tom, regras)', type: 'textarea', rows: 6, ph: 'Você é a Bia, atendente da loja. Seja simpática e objetiva...' },
      { k: 'kb_ids', label: 'Bases de conhecimento', type: 'multi', options: () => opts(L.knowledge_bases) },
      { k: 'transfer_sector_id', label: 'Setor para transferir quando precisar de humano', type: 'select', options: () => opts(L.sectors) }],
    note: () => ME.ai ? '' : '<div class="card" style="margin-bottom:12px;border-color:#f0e2a8;background:var(--note)">IA desativada: inicie o servidor com <code>GEMINI_API_KEY</code>, <code>NVIDIA_API_KEY</code> ou <code>AI_PROVIDER=ollama</code> para os agentes responderem.</div>',
  },
  campaigns: {
    title: 'Campanhas', desc: 'Envie mensagens ou inicie um chatbot para muitos contatos de uma vez, filtrando por etiqueta. Agende ou envie agora.', add: 'Nova campanha',
    cols: [['name', 'Nome'], ['tag_id', 'Público', v => v ? 'Etiqueta: ' + esc(nameOf('tags', v)) : 'Todos os contatos', true], ['scheduled_at', 'Agendada para', v => v ? new Date(v).toLocaleString('pt-BR') : 'Imediato'], ['status', 'Status', (v, r) => ({ Scheduled: 'Agendada', Sending: 'Enviando', Sent: 'Enviada' }[v] || v) + (r.total != null ? ` (${r.sent || 0}/${r.total})` : '')]],
    fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'channel_id', label: 'Canal', type: 'select', required: true, options: () => opts(L.channels) },
      { k: 'tag_id', label: 'Público', type: 'select', empty: 'Todos os contatos', options: () => opts(L.tags) },
      { k: 'text', label: 'Mensagem', type: 'textarea', help: 'Variáveis: {{contact.name}}, {{contact.email}}, {{org.org_name}}' },
      { k: 'bot_id', label: 'Ou iniciar chatbot', type: 'select', empty: 'Nenhum', options: () => opts(L.bots) },
      { k: 'scheduled_at', label: 'Agendar (vazio = enviar agora)', type: 'datetime-local' }], noEdit: (r) => r.status !== 'Scheduled',
  },
  members: {
    title: 'Atendentes', desc: 'Pessoas que atendem seus contatos. Defina permissões e setores.', add: 'Convidar atendente', lookup: 'members',
    cols: [['name', 'Atendente', (v, r) => `<div class="row"><span class="avatar">${esc(initials(v))}</span><div><b>${esc(v)}</b>${r.id === ME.id ? ' <span class="chip">Você</span>' : ''}<div class="small muted">${esc(r.email)}</div></div></div>`, true], ['role', 'Permissão', v => ROLE_PT[v] || v], ['sector_ids', 'Setores', v => (v || []).map(id => nameOf('sectors', id)).join(', ')], ['active', 'Ativo', yes]],
    fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'email', label: 'E-mail', type: 'email', required: true }, { k: 'password', label: 'Senha (6+ caracteres; deixe vazio para manter)', type: 'password' },
      { k: 'role', label: 'Permissão', type: 'select', empty: false, options: () => ROLES.filter(r => r !== 'Owner' || ME.role === 'Owner').map(r => [r, ROLE_PT[r]]) },
      { k: 'sector_ids', label: 'Setores', type: 'multi', options: () => opts(L.sectors) }, { k: 'active', label: 'Status', type: 'check', text: 'Ativo', default: 1 }],
  },
  sectors: { title: 'Setores', desc: 'Sub-divisões da sua organização (ex: Vendas, Suporte). Conversas novas entram no setor padrão.', add: 'Novo setor', lookup: 'sectors', cols: [['name', 'Nome'], ['is_default', 'Padrão', v => v && v !== '0' ? '<span class="chip">Setor padrão</span>' : '', true], ['id', 'Atendentes', id => L.members.filter(m => (m.sector_ids || []).map(String).includes(String(id))).map(m => esc(m.name)).join(', '), true]], fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'is_default', label: 'Padrão', type: 'check', text: 'Setor padrão para novas conversas' }] },
  channels: {
    title: 'Canais de atendimento', desc: 'Canais por onde seus contatos falam com você. O canal Widget gera um chat para o seu site; o canal API recebe mensagens de qualquer provedor (WhatsApp, Instagram...) via POST /api/v1/inbound.', add: 'Novo canal', lookup: 'channels',
    cols: [['name', 'Nome'], ['type', 'Tipo'], ['bot_id', 'Chatbot inicial', v => esc(nameOf('bots', v)) || '<span class="muted">—</span>', true], ['active', 'Ativo', yes], ['id', 'Testar', (id, r) => r.type === 'Widget' ? `<a href="/widget.html?c=${id}" target="_blank" rel="noopener">Abrir widget ↗</a>` : r.type === 'WhatsApp' ? `<button class="btn sm" data-wa="${id}">Conectar WhatsApp</button>` : '', true]],
    fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'type', label: 'Tipo', type: 'select', empty: false, options: [['Widget', 'Widget de site'], ['WhatsApp', 'WhatsApp (QR code)'], ['API', 'API / provedor externo']] },
      { k: 'bot_id', label: 'Chatbot iniciado em novas conversas', type: 'select', empty: 'Nenhum', options: () => opts(L.bots) }, { k: 'active', label: 'Status', type: 'check', text: 'Ativo', default: 1 }],
    note: () => `<div class="card" style="margin-bottom:12px;border-color:#f0e2a8;background:var(--note)"><b>WhatsApp por QR code</b> usa a conexão não oficial do WhatsApp Web: há risco de o número ser banido, principalmente com envio em massa. Teste primeiro com um chip secundário. Depois de criar o canal, clique em <b>Conectar WhatsApp</b>.</div><div class="card" style="margin-bottom:12px"><b>Instalar o widget no seu site</b><pre>&lt;iframe src="${location.origin}/widget.html?c=ID_DO_CANAL" style="position:fixed;bottom:16px;right:16px;width:360px;height:540px;border:0;border-radius:14px;box-shadow:0 8px 30px #0003"&gt;&lt;/iframe&gt;</pre></div>`,
  },
  tags: { title: 'Etiquetas', desc: 'Classifique conversas e contatos. Use etiquetas para filtrar e segmentar campanhas.', add: 'Nova etiqueta', lookup: 'tags', cols: [['name', 'Nome', (v, r) => `<span class="chip" style="background:${esc(r.color || '#eef0f4')}22;color:${esc(r.color || 'inherit')}">● ${esc(v)}</span>`, true]], fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'color', label: 'Cor', type: 'color', default: '#0f9d76' }] },
  quick_answers: { title: 'Respostas rápidas', desc: 'Mensagens prontas. No chat, digite "/" para buscar.', add: 'Nova resposta rápida', lookup: 'quick_answers', cols: [['shortcut', 'Atalho', v => '/' + esc(v), true], ['text', 'Mensagem']], fields: [{ k: 'shortcut', label: 'Atalho (sem /)', required: true }, { k: 'text', label: 'Mensagem', type: 'textarea', required: true, help: 'Variáveis: {{contact.name}}' }] },
  knowledge_bases: { title: 'Bases de conhecimento', desc: 'Perguntas e respostas que seus agentes de IA consultam ao atender.', add: 'Nova base de conhecimento', lookup: 'knowledge_bases', cols: [['name', 'Nome'], ['qas', 'Perguntas', v => (v || []).length]], fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'qas', label: 'Perguntas e respostas', type: 'qas' }] },
  scheduled_messages: {
    title: 'Mensagens agendadas', desc: 'Mensagens, notas internas ou chatbots programados para um contato.', add: 'Agendar',
    cols: [['send_at', 'Quando', v => new Date(v).toLocaleString('pt-BR')], ['contact_id', 'Contato', v => esc(CONTACT_NAMES[v] || '#' + v), true], ['type', 'Tipo'], ['text', 'Mensagem'], ['status', 'Status', (v, r) => ({ Pending: 'Pendente', Sent: 'Enviada', Error: 'Erro: ' + (r.error || ''), Canceled: 'Cancelada' }[v] || v)]],
    fields: [{ k: 'contact_id', label: 'Contato', type: 'select', required: true, options: () => Object.entries(CONTACT_NAMES) }, { k: 'channel_id', label: 'Canal', type: 'select', required: true, options: () => opts(L.channels) },
      { k: 'type', label: 'Tipo', type: 'select', empty: false, options: [['Message', 'Mensagem'], ['InternalNote', 'Nota interna'], ['Bot', 'Chatbot']] }, { k: 'text', label: 'Mensagem', type: 'textarea' },
      { k: 'bot_id', label: 'Chatbot', type: 'select', options: () => opts(L.bots) }, { k: 'send_at', label: 'Enviar em', type: 'datetime-local', required: true }],
    before: async () => { (await api('GET', '/api/v1/contacts')).forEach(c => CONTACT_NAMES[c.id] = c.name); },
  },
  webhooks: {
    title: 'Webhooks', desc: 'Receba eventos em tempo real no seu sistema (POST JSON). Com segredo, cada envio leva o cabeçalho X-Signature (HMAC-SHA256 do corpo).', add: 'Novo webhook', lookup: null,
    cols: [['name', 'Nome'], ['url', 'URL'], ['events', 'Eventos', v => (v || []).length ? v.join(', ') : 'Todos'], ['active', 'Ativo', yes]],
    fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'url', label: 'URL', type: 'url', required: true }, { k: 'secret', label: 'Segredo (opcional)' },
      { k: 'events', label: 'Eventos (nenhum = todos)', type: 'multi', options: ['Message', 'NewChat', 'ChatClosed', 'MemberTransfer', 'ChatSectorChanged', 'ChatTagChanged', 'ChatPrivateStatusChanged'].map(e => [e, e]) },
      { k: 'active', label: 'Status', type: 'check', text: 'Ativo', default: 1 }],
    after: async (el) => { const logs = await api('GET', '/api/v1/webhook-logs'); el.insertAdjacentHTML('beforeend', `<h2 style="margin-top:24px">Últimas entregas</h2>${table(logs, [['created_at', 'Quando', fmtTime], ['event', 'Evento'], ['status', 'Status HTTP']])}`); },
  },
};
const CONTACT_NAMES = {};
function table(rows, cols, { href, actions } = {}) {
  if (!rows.length) return '<div class="card empty">Nada por aqui ainda.</div>';
  return `<table><thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join('')}${actions ? '<th style="width:1%">Ações</th>' : ''}</tr></thead><tbody>${rows.map(r => `<tr ${href ? `class="click" data-href="${href(r)}"` : ''}>${cols.map(([k, , fn, raw]) => `<td>${fn ? (raw ? fn(r[k], r) : esc(fn(r[k], r))) : esc(r[k])}</td>`).join('')}${actions ? `<td>${actions(r)}</td>` : ''}</tr>`).join('')}</tbody></table>`;
}
async function pageCrud(main, key, wrapper) {
  const d = RES[key]; const el = wrapper || main;
  if (d.before) await d.before();
  const qs = d.search ? $('#crudq')?.value || '' : '';
  const rows = await api('GET', `/api/v1/${key}${qs ? '?q=' + encodeURIComponent(qs) : ''}`);
  if (d.lookup !== undefined && d.lookup) L[d.lookup] = rows.slice().sort((a, b) => a.id - b.id);
  const admin = can(key === 'quick_answers' || key === 'contacts' || key === 'scheduled_messages' ? 'Member' : key === 'tags' ? 'Operator' : 'Admin');
  el.innerHTML = `<div class="page"><div class="head"><div><h1>${d.title}</h1><p class="muted">${d.desc}</p></div><div class="row">${d.extra ? d.extra() : ''}${admin ? `<button class="btn primary" id="addBtn">${d.add}</button>` : ''}</div></div>
    ${d.note ? d.note() : ''}${d.search ? `<input id="crudq" placeholder="Buscar por nome, telefone ou e-mail" value="${esc(qs)}" style="margin-bottom:12px;max-width:360px">` : ''}
    <div id="crudtable">${table(rows, d.cols, { href: d.href, actions: admin ? (r) => `<div class="row">${d.noEdit?.(r) ? '' : `<button class="btn sm" data-edit="${r.id}">Editar</button>`}<button class="btn sm danger" data-del="${r.id}">Excluir</button></div>` : null })}</div></div>`;
  const reload = () => pageCrud(main, key, wrapper);
  $('#addBtn', el)?.addEventListener('click', async () => {
    const r = await modal({ title: d.add, fields: d.fields, values: {}, onOk: (v) => api('POST', '/api/v1/' + key, { ...(d.defaults || {}), ...v }) });
    if (r) { toast('Salvo'); if (d.href) location.hash = d.href(r); else reload(); }
  });
  $$('[data-edit]', el).forEach(b => b.onclick = async (e) => {
    e.stopPropagation(); const row = rows.find(r => String(r.id) === b.dataset.edit);
    const r = await modal({ title: 'Editar', fields: d.fields, values: row, onOk: (v) => { if (key === 'members' && !v.password) delete v.password; return api('PUT', `/api/v1/${key}/${row.id}`, v); } });
    if (r) { toast('Salvo'); reload(); }
  });
  $$('[data-del]', el).forEach(b => b.onclick = async (e) => {
    e.stopPropagation(); if (!await confirmBox('Excluir este item? Esta ação não pode ser desfeita.')) return;
    await guard(() => api('DELETE', `/api/v1/${key}/${b.dataset.del}`))(); reload();
  });
  $$('tr[data-href]', el).forEach(tr => tr.onclick = () => location.hash = tr.dataset.href);
  const qi = $('#crudq', el); if (qi) { qi.oninput = () => { clearTimeout(qi.t); qi.t = setTimeout(reload, 300); }; if (qs) { qi.focus(); qi.setSelectionRange(qs.length, qs.length); } }
  $('#importBtn', el)?.addEventListener('click', async () => {
    const r = await modal({ title: 'Importar contatos (CSV)', body: '<p class="small muted">Primeira linha é o cabeçalho. Colunas: nome;telefone;email</p>', fields: [{ k: 'csv', label: 'Conteúdo CSV', type: 'textarea', rows: 8, ph: 'nome;telefone;email\nAna;+5511999990000;ana@x.com' }], ok: 'Importar', onOk: (v) => api('POST', '/api/v1/contacts-import', v) });
    if (r) { toast(`${r.imported} contato(s) importado(s)`); reload(); }
  });
  if (d.after) await d.after($('.page', el));
}

// ---------- WhatsApp connection modal ----------
document.addEventListener('click', (e) => { const b = e.target.closest('[data-wa]'); if (b) openWaModal(b.dataset.wa); });
function openWaModal(id) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2>Conectar WhatsApp</h2><div id="waBody">Carregando…</div><div class="actions"><button class="btn danger hidden" id="waOut">Desconectar</button><button class="btn" id="waClose">Fechar</button></div></div>';
  document.body.append(bg);
  let timer, last; const close = () => { clearInterval(timer); bg.remove(); };
  $('#waClose', bg).onclick = close; bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  const draw = guard(async () => {
    const s = await api('GET', `/api/v1/channels/${id}/whatsapp`);
    const key = JSON.stringify(s); if (key === last) return; last = key; // redraw only on change: avoids QR flicker
    const body = $('#waBody', bg); if (!body) return;
    $('#waOut', bg).classList.toggle('hidden', s.state === 'disconnected');
    if (s.state === 'connected') body.innerHTML = `<p><b>✅ Conectado</b>${s.phone ? ' como +' + esc(s.phone) : ''}.</p><p class="small muted">As mensagens recebidas neste número aparecem em Conversas.</p>`;
    else if (s.state === 'qr') body.innerHTML = `<p>No celular: <b>WhatsApp › Aparelhos conectados › Conectar um aparelho</b> e leia o código.</p><img alt="QR code do WhatsApp" src="${s.qr}" style="display:block;margin:auto;width:280px;height:280px"><p class="small muted">O código é renovado sozinho a cada ~1 minuto.</p>`;
    else if (s.state === 'connecting') body.innerHTML = '<p>Conectando…</p>';
    else { body.innerHTML = '<p>Desconectado.</p><button class="btn primary" id="waGo">Gerar QR code</button>'; $('#waGo', bg).onclick = guard(async () => { await api('POST', `/api/v1/channels/${id}/whatsapp/connect`, {}); last = null; draw(); }); }
  });
  $('#waOut', bg).onclick = guard(async () => { if (await confirmBox('Desconectar o WhatsApp deste canal?')) { await api('POST', `/api/v1/channels/${id}/whatsapp/logout`, {}); last = null; draw(); } });
  draw(); timer = setInterval(draw, 2000);
}

// ---------- chats ----------
const CH = { tab: 'inbox', q: '', chat: null, active: false, note: false, sector: '' };
async function pageChats(main, id) {
  CH.active = true;
  main.innerHTML = `<div class="inbox ${id ? 'chat-open' : ''}" id="inbox"><div class="list"><div class="top">
    <div class="row"><h2 class="grow" style="margin:0">Conversas</h2><button class="btn sm primary" id="newChat" title="Nova conversa">+ Nova</button></div>
    <div class="row" style="margin-top:10px"><input id="chq" placeholder="Buscar conversa" value="${esc(CH.q)}">
      <select id="chsec" style="width:120px" aria-label="Filtrar por setor"><option value="">Setores</option>${L.sectors.map(s => `<option value="${s.id}" ${String(s.id) === CH.sector ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="tabs" role="tablist">${[['inbox', 'Entrada'], ['waiting', 'Esperando'], ['closed', 'Finalizados']].map(([k, l]) => `<button role="tab" data-tab="${k}" class="${CH.tab === k ? 'on' : ''}">${l} <span data-count="${k}"></span></button>`).join('')}</div>
    </div><div class="items" id="items"></div></div><div class="conv" id="conv"><div class="placeholder"><div><h2>Selecione uma conversa</h2><p>As conversas atribuídas a você aparecem em <b>Entrada</b>; as sem atendente, em <b>Esperando</b>.</p></div></div></div><aside class="aside hidden" id="aside"></aside></div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => { CH.tab = b.dataset.tab; $$('[data-tab]').forEach(x => x.classList.toggle('on', x === b)); loadList(); });
  $('#chq').oninput = (e) => { CH.q = e.target.value; clearTimeout(CH.t); CH.t = setTimeout(loadList, 250); };
  $('#chsec').onchange = (e) => { CH.sector = e.target.value; loadList(); };
  $('#newChat').onclick = newChatModal;
  await loadList();
  if (id) await openChat(Number(id)); else { CH.chat = null; $('#inbox').classList.add('noside'); }
}
async function loadList() {
  if (!$('#items')) return;
  const [rows, counts] = await Promise.all([api('GET', `/api/v1/chats?tab=${CH.tab}&q=${encodeURIComponent(CH.q)}${CH.sector ? '&sector_id=' + CH.sector : ''}`), api('GET', '/api/v1/chats-counts')]);
  $$('[data-count]').forEach(s => s.textContent = counts[s.dataset.count] ? `(${counts[s.dataset.count]})` : '');
  $('#items').innerHTML = rows.length ? rows.map(c => `<div class="item ${CH.chat?.id === c.id ? 'on' : ''}" data-id="${c.id}" tabindex="0">
    <span class="avatar">${esc(initials(c.contact_name))}</span><div class="grow"><div class="t"><b>${esc(c.contact_name)}</b><span class="small muted">${fmtTime(c.last_message_at || c.created_at)}</span></div>
    <div class="t"><span class="p">${c.bot ? '🤖 ' : c.ai_agent_id ? '✨ ' : ''}${esc(c.last_text || 'Sem mensagens')}</span>${c.unread ? `<span class="badge">${c.unread}</span>` : ''}</div>
    <div class="small muted">${esc(c.sector_name || '')}${c.member_name ? ' · ' + esc(c.member_name) : ''}${c.private ? ' · 🔒' : ''} ${c.tags.map(t => `<span class="chip" style="color:${esc(t.color)}">${esc(t.name)}</span>`).join(' ')}</div></div></div>`).join('') : '<div class="empty">Nenhuma conversa encontrada</div>';
  $$('.item').forEach(i => { i.onclick = () => location.hash = '#/chats/' + i.dataset.id; i.onkeydown = (e) => e.key === 'Enter' && i.click(); });
}
async function openChat(id) {
  CH.chat = await api('GET', '/api/v1/chats/' + id);
  $('#inbox').classList.remove('noside'); $('#aside').classList.remove('hidden');
  $$('.item').forEach(i => i.classList.toggle('on', Number(i.dataset.id) === id));
  const sig = ME.settings.signature === 'optional';
  $('#conv').innerHTML = `<div class="bar" id="bar"></div><div class="msgs" id="msgs" aria-live="polite"></div>
    <div class="composer" id="composer"><div class="popup hidden" id="qa"></div>
      <textarea id="txt" placeholder="Digite uma mensagem — use / para respostas rápidas" aria-label="Mensagem"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn sm" id="noteBtn" title="Nota interna visível só para a equipe">📝 Nota interna</button>
      ${sig ? `<label class="row small"><input type="checkbox" id="sigChk" ${store.get('sig') === '1' ? 'checked' : ''}> Assinar</label>` : ''}
      ${ME.ai ? '<button class="btn sm" id="aiImprove">✨ Melhorar texto</button><button class="btn sm" id="aiSuggest">✨ Sugerir respostas</button>' : ''}
      <span class="grow"></span><button class="btn primary" id="send">Enviar</button></div></div>`;
  $('#msgs').innerHTML = CH.chat.messages.map(msgHtml).join('');
  scrollDown(); renderBar(); renderAside();
  const txt = $('#txt');
  txt.oninput = () => { txt.style.height = 'auto'; txt.style.height = txt.scrollHeight + 'px'; quickPopup(); };
  txt.onkeydown = (e) => {
    const pop = $('#qa');
    if (!pop.classList.contains('hidden') && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault(); const items = $$('div', pop); let i = items.findIndex(x => x.classList.contains('on'));
      if (e.key === 'Escape') return pop.classList.add('hidden');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { items[i]?.classList.remove('on'); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[i].classList.add('on'); return; }
      return items[Math.max(i, 0)]?.click();
    }
    const newline = (ME.prefs || {}).enter === 'newline';
    if (e.key === 'Enter' && !e.shiftKey && !newline) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && newline) { e.preventDefault(); send(); }
  };
  $('#send').onclick = send;
  $('#noteBtn').onclick = () => { CH.note = !CH.note; $('#composer').classList.toggle('note', CH.note); $('#noteBtn').classList.toggle('primary', CH.note); txt.focus(); };
  $('#sigChk')?.addEventListener('change', (e) => store.set('sig', e.target.checked ? '1' : '0'));
  $('#aiImprove')?.addEventListener('click', guard(async () => { if (!txt.value.trim()) return toast('Escreva algo primeiro'); $('#aiImprove').disabled = true; try { txt.value = (await api('POST', '/api/v1/ai/improve', { text: txt.value })).text; } finally { $('#aiImprove').disabled = false; } }));
  $('#aiSuggest')?.addEventListener('click', guard(async () => {
    $('#aiSuggest').disabled = true;
    try {
      const { suggestions } = await api('POST', '/api/v1/ai/suggest', { chat_id: CH.chat.id });
      const pop = $('#qa'); pop.innerHTML = suggestions.map(s => `<div>${esc(s)}</div>`).join(''); pop.classList.remove('hidden');
      $$('div', pop).forEach((d, i) => d.onclick = () => { txt.value = suggestions[i]; pop.classList.add('hidden'); txt.focus(); });
    } finally { $('#aiSuggest').disabled = false; }
  }));
  CH.note = false; txt.focus();
}
function quickPopup() {
  const txt = $('#txt'), pop = $('#qa'), v = txt.value;
  if (!v.startsWith('/')) return pop.classList.add('hidden');
  const term = v.slice(1).toLowerCase();
  const list = L.quick_answers.filter(x => x.shortcut.toLowerCase().includes(term) || x.text.toLowerCase().includes(term)).slice(0, 8);
  if (!list.length) return pop.classList.add('hidden');
  pop.innerHTML = list.map((x, i) => `<div class="${i ? '' : 'on'}"><b>/${esc(x.shortcut)}</b> <span class="muted">${esc(x.text.slice(0, 80))}</span></div>`).join('');
  pop.classList.remove('hidden');
  $$('div', pop).forEach((d, i) => d.onclick = () => { txt.value = list[i].text.replace(/\{\{\s*contact\.name\s*\}\}/g, CH.chat.contact_name); pop.classList.add('hidden'); txt.focus(); });
}
const send = guard(async () => {
  const txt = $('#txt'); const text = txt.value.trim(); if (!text) return;
  txt.value = ''; txt.style.height = 'auto';
  await api('POST', `/api/v1/chats/${CH.chat.id}/messages`, { text, note: CH.note, signature: $('#sigChk')?.checked });
  if (CH.note) $('#noteBtn').click();
});
function msgHtml(m) {
  const cls = m.note ? 'note' : m.source === 'Contact' ? 'in' : m.source === 'Bot' ? 'bot' : 'out';
  const who = m.note ? `📝 Nota${m.member_name ? ' de ' + m.member_name : ''}` : m.source === 'Bot' ? 'Bot' : m.source === 'Member' ? m.member_name || '' : '';
  const del = m.source === 'Member' && m.state !== 'Deleted' && (m.member_id === ME.id || can('Admin')) ? `<button class="btn ghost sm" data-delmsg="${m.id}" title="Apagar" style="padding:0">🗑</button>` : '';
  return `<div class="msg ${cls} ${m.state === 'Deleted' ? 'deleted' : ''}" data-mid="${m.id}">${esc(m.text)}<div class="meta">${who ? `<span>${esc(who)}</span>` : ''}<span>${fmtTime(m.created_at)}</span>${m.state === 'Failed' ? '<span style="color:var(--danger)">⚠ não enviada</span>' : ''}${del}</div></div>`;
}
function appendMessage(m) {
  const box = $('#msgs'); if (!box) return;
  const old = $(`[data-mid="${m.id}"]`, box);
  if (old) old.outerHTML = msgHtml({ ...CH.chat.messages.find(x => x.id === m.id), ...m });
  else { CH.chat.messages.push(m); const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120; box.insertAdjacentHTML('beforeend', msgHtml(m)); if (near || m.member_id === ME.id) scrollDown(); }
}
const scrollDown = () => { const b = $('#msgs'); if (b) b.scrollTop = b.scrollHeight; };
document.addEventListener('click', guard(async (e) => { const d = e.target.closest('[data-delmsg]'); if (d && await confirmBox('Apagar esta mensagem?')) await api('DELETE', '/api/v1/messages/' + d.dataset.delmsg); }));

function renderBar() {
  const c = CH.chat, bar = $('#bar'); if (!bar) return;
  const open = c.state === 'Open';
  bar.innerHTML = `<a href="#/chats" class="btn sm ghost" aria-label="Voltar">←</a><span class="avatar">${esc(initials(c.contact_name))}</span>
    <div class="grow"><b>${esc(c.contact_name)}</b> ${c.private ? '🔒' : ''}<div class="small muted">${esc(c.channel_name || '')} · ${esc(c.sector_name || '')} · ${c.member_name ? esc(c.member_name) : 'Sem atendente'}${c.bot ? ' · 🤖 chatbot ativo' : ''}${c.ai_agent_id ? ' · ✨ ' + esc(nameOf('ai_agents', c.ai_agent_id)) : ''}${open ? '' : ' · Finalizada'}</div></div>
    ${open && c.member_id !== ME.id ? '<button class="btn sm primary" data-act="assign">Atender</button>' : ''}
    ${open ? `<button class="btn sm" data-act="transfer">Transferir</button><button class="btn sm" data-act="bot">${c.bot ? 'Parar bot' : 'Chatbot'}</button>${L.ai_agents.length ? '<button class="btn sm" data-act="ai">IA</button>' : ''}<button class="btn sm" data-act="private">${c.private ? 'Tornar pública' : 'Privar'}</button>${ME.ai ? '<button class="btn sm" data-act="summary">Resumo</button>' : ''}<button class="btn sm primary" data-act="close">Finalizar</button>` : '<button class="btn sm primary" data-act="reopen">Reabrir</button>'}`;
  $$('[data-act]', bar).forEach(b => b.onclick = guard(() => ACT[b.dataset.act]()));
}
const ACT = {
  assign: () => api('PUT', `/api/v1/chats/${CH.chat.id}/assign`, {}),
  reopen: () => api('PUT', `/api/v1/chats/${CH.chat.id}/reopen`, {}),
  private: () => api('PUT', `/api/v1/chats/${CH.chat.id}/private`, { private: !CH.chat.private }),
  transfer: async () => {
    const mine = ME.settings.transfer_scope === 'mine' && !can('Admin');
    const sectors = mine ? L.sectors.filter(s => (ME.sector_ids || []).map(String).includes(String(s.id))) : L.sectors;
    await modal({ title: 'Transferir conversa', fields: [{ k: 'sector_id', label: 'Setor', type: 'select', options: () => opts(sectors), }, { k: 'member_id', label: 'Atendente (vazio = fila do setor)', type: 'select', empty: 'Fila do setor', options: () => opts(L.members.filter(m => m.active && m.active !== '0')) }, { k: 'note', label: 'Nota interna (opcional)', type: 'textarea', rows: 2 }], values: { sector_id: CH.chat.sector_id }, ok: 'Transferir', onOk: (v) => api('PUT', `/api/v1/chats/${CH.chat.id}/transfer`, v) });
  },
  bot: async () => {
    if (CH.chat.bot) return api('PUT', `/api/v1/chats/${CH.chat.id}/stop-bot`, {});
    await modal({ title: 'Iniciar chatbot', fields: [{ k: 'bot_id', label: 'Chatbot', type: 'select', required: true, options: () => opts(L.bots) }], ok: 'Iniciar', onOk: (v) => api('POST', `/api/v1/chats/${CH.chat.id}/start-bot`, v) });
  },
  ai: async () => {
    await modal({ title: 'Agente de IA', body: '<p class="small muted">O agente responde o contato até resolver ou pedir um humano. Escolha "Nenhum" para remover.</p>', fields: [{ k: 'agent_id', label: 'Agente', type: 'select', empty: 'Nenhum', options: () => opts(L.ai_agents) }], values: { agent_id: CH.chat.ai_agent_id }, ok: 'Aplicar', onOk: (v) => api('POST', `/api/v1/chats/${CH.chat.id}/ai-agent`, v) });
  },
  summary: async () => { const { text } = await api('POST', '/api/v1/ai/summarize', { chat_id: CH.chat.id }); modal({ title: 'Resumo da conversa', body: `<pre>${esc(text)}</pre>` }); },
  close: async () => {
    await modal({ title: 'Finalizar conversa', fields: [{ k: 'message', label: 'Mensagem de encerramento (opcional)', type: 'textarea', rows: 3 }, { k: 'bot_id', label: 'Iniciar chatbot após finalizar (ex: avaliação)', type: 'select', empty: 'Nenhum', options: () => opts(L.bots) }],
      values: { message: ME.closing_message || ME.settings.close_message }, ok: 'Finalizar', onOk: (v) => api('PUT', `/api/v1/chats/${CH.chat.id}/close`, { message: v.message, bot_id: v.bot_id }) });
  },
};
async function renderAside() {
  const c = CH.chat; const d = await api('GET', `/api/v1/contacts/${c.contact_id}/details`);
  const custom = Object.entries(d.custom || {});
  $('#aside').innerHTML = `<div style="text-align:center"><span class="avatar" style="width:56px;height:56px;margin:auto;font-size:18px">${esc(initials(d.name))}</span><h2 style="margin-top:8px">${esc(d.name)}</h2>
    <div class="small muted">${esc(d.phone || '')}<br>${esc(d.email || '')}</div><div class="row" style="justify-content:center;margin-top:8px"><a class="btn sm" href="#/contacts/${d.id}">Ver contato</a></div></div>
    <section><h3>Etiquetas da conversa</h3><div class="row wrap">${c.tags.map(t => `<span class="chip" style="color:${esc(t.color)}">${esc(t.name)} <button data-untag="${t.id}" aria-label="Remover">✕</button></span>`).join('')}
      <select id="addTag" style="width:auto"><option value="">+ etiqueta</option>${L.tags.filter(t => !c.tags.some(x => x.id === t.id)).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div></section>
    ${custom.length ? `<section><h3>Campos</h3>${custom.map(([k, v]) => `<div class="small"><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')}</section>` : ''}
    <section><h3>Notas do contato</h3><div class="row"><input id="noteTxt" placeholder="Adicionar nota"><button class="btn sm" id="addNote">+</button></div>
      ${d.notes.map(n => `<div class="card" style="padding:8px;margin-top:6px">${n.pinned ? '📌 ' : ''}${esc(n.text)}<div class="small muted">${esc(n.member_name || '')} · ${fmtTime(n.created_at)}</div></div>`).join('')}</section>
    <section><h3>Histórico</h3>${d.chats.map(h => `<div class="small"><a href="#/chats/${h.id}">#${h.id}</a> · ${h.state === 'Open' ? 'Aberta' : 'Finalizada'} · ${fmtTime(h.created_at)}</div>`).join('')}</section>`;
  $('#addTag').onchange = guard(async (e) => { if (e.target.value) { await api('POST', `/api/v1/chats/${c.id}/tags`, { tag_id: Number(e.target.value) }); CH.chat = await api('GET', '/api/v1/chats/' + c.id); renderAside(); } });
  $$('[data-untag]').forEach(b => b.onclick = guard(async () => { await api('DELETE', `/api/v1/chats/${c.id}/tags/${b.dataset.untag}`); CH.chat.tags = CH.chat.tags.filter(t => String(t.id) !== b.dataset.untag); renderAside(); }));
  $('#addNote').onclick = guard(async () => { const t = $('#noteTxt').value.trim(); if (!t) return; await api('POST', `/api/v1/contacts/${c.contact_id}/notes`, { text: t }); renderAside(); });
}
async function newChatModal() {
  const contacts = await api('GET', '/api/v1/contacts');
  const r = await modal({ title: 'Nova conversa', fields: [
    { k: 'contact_id', label: 'Contato existente', type: 'select', empty: 'Novo contato', options: () => contacts.map(c => [c.id, `${c.name}${c.phone ? ' · ' + c.phone : ''}`]) },
    { k: 'name', label: 'Nome (novo contato)' }, { k: 'phone', label: 'Telefone (novo contato)' },
    { k: 'channel_id', label: 'Canal', type: 'select', empty: false, options: () => opts(L.channels) }, { k: 'text', label: 'Primeira mensagem', type: 'textarea', rows: 3 }],
    ok: 'Iniciar', onOk: (v) => { if (!v.contact_id && !v.name && !v.phone) throw new Error('Escolha um contato ou informe nome/telefone'); return api('POST', '/api/v1/chats', v); } });
  if (r) { CH.tab = 'inbox'; location.hash = '#/chats/' + r.id; }
}

// ---------- contact page ----------
async function pageContact(main, id) {
  const d = await api('GET', `/api/v1/contacts/${id}/details`);
  main.innerHTML = `<div class="page"><a href="#/contacts">← Contatos</a><div class="head" style="margin-top:10px"><div class="row"><span class="avatar" style="width:52px;height:52px;font-size:18px">${esc(initials(d.name))}</span><div><h1>${esc(d.name)}</h1><div class="muted">${esc(d.phone || '')} ${d.email ? '· ' + esc(d.email) : ''} ${d.blocked && d.blocked !== '0' ? '· <b style="color:var(--danger)">Bloqueado</b>' : ''}</div></div></div>
    <div class="row"><button class="btn" id="edit">Editar</button><button class="btn" id="block">${d.blocked && d.blocked !== '0' ? 'Desbloquear' : 'Bloquear'}</button><button class="btn primary" id="start">Iniciar conversa</button></div></div>
    <div class="charts"><div class="card"><h2>Etiquetas</h2><div class="row wrap">${d.tags.map(t => `<span class="chip" style="color:${esc(t.color)}">${esc(t.name)} <button data-untag="${t.id}" aria-label="Remover">✕</button></span>`).join('')}
      <select id="addTag" style="width:auto"><option value="">+ etiqueta</option>${L.tags.filter(t => !d.tags.some(x => x.id === t.id)).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
      <h2 style="margin-top:16px">Campos personalizados</h2><div id="custom">${Object.entries(d.custom || {}).map(([k, v]) => `<div class="row" style="margin-bottom:4px"><input value="${esc(k)}" data-ck><input value="${esc(v)}" data-cv></div>`).join('')}</div>
      <div class="row"><button class="btn sm" id="addField">+ Campo</button><button class="btn sm primary" id="saveFields">Salvar campos</button></div></div>
    <div class="card"><h2>Notas</h2><div class="row"><input id="noteTxt" placeholder="Nova nota"><button class="btn" id="addNote">Adicionar</button></div>
      ${d.notes.map(n => `<div class="card" style="padding:8px;margin-top:6px">${n.pinned ? '📌 ' : ''}${esc(n.text)}<div class="row small muted"><span class="grow">${esc(n.member_name || '')} · ${fmtTime(n.created_at)}</span><button class="btn sm ghost" data-pin="${n.id}">${n.pinned ? 'Desafixar' : 'Fixar'}</button><button class="btn sm ghost danger" data-delnote="${n.id}">Excluir</button></div></div>`).join('')}</div>
    <div class="card"><h2>Conversas</h2>${d.chats.map(h => `<div style="margin:6px 0"><a href="#/chats/${h.id}">Conversa #${h.id}</a> · ${h.state === 'Open' ? 'Aberta' : 'Finalizada'} · ${fmtTime(h.created_at)}<div class="small muted">${esc(h.last_text || '')}</div></div>`).join('') || '<p class="muted">Nenhuma conversa.</p>'}</div></div></div>`;
  const reload = () => pageContact(main, id);
  $('#edit').onclick = async () => { if (await modal({ title: 'Editar contato', fields: RES.contacts.fields, values: d, onOk: (v) => api('PUT', '/api/v1/contacts/' + id, v) })) reload(); };
  $('#block').onclick = guard(async () => { await api('PUT', '/api/v1/contacts/' + id, { blocked: d.blocked && d.blocked !== '0' ? 0 : 1 }); reload(); });
  $('#start').onclick = async () => { const r = await modal({ title: 'Iniciar conversa', fields: [{ k: 'channel_id', label: 'Canal', type: 'select', empty: false, options: () => opts(L.channels) }, { k: 'text', label: 'Mensagem', type: 'textarea', rows: 3 }], ok: 'Iniciar', onOk: (v) => api('POST', '/api/v1/chats', { ...v, contact_id: Number(id) }) }); if (r) location.hash = '#/chats/' + r.id; };
  $('#addTag').onchange = guard(async (e) => { if (e.target.value) { await api('POST', `/api/v1/contacts/${id}/tags`, { tag_id: Number(e.target.value) }); reload(); } });
  $$('[data-untag]').forEach(b => b.onclick = guard(async () => { await api('DELETE', `/api/v1/contacts/${id}/tags/${b.dataset.untag}`); reload(); }));
  $('#addField').onclick = () => $('#custom').insertAdjacentHTML('beforeend', '<div class="row" style="margin-bottom:4px"><input placeholder="campo" data-ck><input placeholder="valor" data-cv></div>');
  $('#saveFields').onclick = guard(async () => { const custom = {}; $$('#custom .row').forEach(r => { const k = $('[data-ck]', r).value.trim(); if (k) custom[k] = $('[data-cv]', r).value; }); await api('PUT', '/api/v1/contacts/' + id, { custom }); toast('Campos salvos'); });
  $('#addNote').onclick = guard(async () => { const t = $('#noteTxt').value.trim(); if (t) { await api('POST', `/api/v1/contacts/${id}/notes`, { text: t }); reload(); } });
  $$('[data-pin]').forEach(b => b.onclick = guard(async () => { await api('PUT', `/api/v1/contacts/${id}/notes/${b.dataset.pin}/pin`, {}); reload(); }));
  $$('[data-delnote]').forEach(b => b.onclick = guard(async () => { await api('DELETE', `/api/v1/contacts/${id}/notes/${b.dataset.delnote}`); reload(); }));
}

// ---------- chatbot editor ----------
const STEP = {
  message: ['Enviar mensagem', [['text', 'Texto', 'textarea']]],
  options: ['Menu de opções (aguarda)', [['text', 'Pergunta', 'textarea'], ['save_as', 'Salvar escolha na variável'], ['error', 'Mensagem se a opção for inválida']]],
  question: ['Pergunta (aguarda)', [['text', 'Pergunta', 'textarea'], ['save_as', 'Salvar em (name, email, phone ou um campo novo)'], ['regex', 'Validação (regex, opcional)'], ['error', 'Mensagem se inválido']]],
  tag: ['Adicionar etiqueta', [['tag_id', 'Etiqueta', 'tags']]],
  condition: ['Condição', [['field', 'Valor a testar (ex: vars.opcao, contact.email)'], ['equals', 'É igual a'], ['goto_else', 'Senão, ir para', 'step']]],
  hours: ['Horário de atendimento', [['from', 'Abre às (HH:MM)'], ['to', 'Fecha às (HH:MM)'], ['days', 'Dias (0=dom … 6=sáb, separados por vírgula)', 'days'], ['goto_else', 'Fora do horário, ir para', 'step']]],
  webhook: ['Chamar webhook (POST)', [['url', 'URL']]],
  wait: ['Aguardar', [['seconds', 'Segundos', 'number']]],
  goto: ['Ir para passo', [['goto', 'Passo', 'step']]],
  sector: ['Transferir para setor (fim)', [['sector_id', 'Setor', 'sectors'], ['text', 'Mensagem', 'textarea']]],
  member: ['Transferir para atendente (fim)', [['member_id', 'Atendente', 'members'], ['text', 'Mensagem', 'textarea']]],
  ai: ['Passar para agente de IA (fim)', [['agent_id', 'Agente', 'ai_agents'], ['text', 'Mensagem', 'textarea']]],
  close: ['Finalizar conversa (fim)', [['text', 'Mensagem final', 'textarea']]],
  end: ['Encerrar chatbot (fim)', []],
};
async function pageBotEditor(main, id) {
  const bot = await api('GET', '/api/v1/bots/' + id); bot.steps ||= [];
  const nid = () => 's' + Math.random().toString(36).slice(2, 6);
  const stepSel = (val, path) => `<select data-p="${path}"><option value="">Próximo passo</option>${bot.steps.map((s, i) => `<option value="${esc(s.id)}" ${String(s.id) === String(val) ? 'selected' : ''}>${i + 1}. ${esc(STEP[s.type]?.[0] || s.type)} (${esc(s.id)})</option>`).join('')}</select>`;
  const input = (s, i, [k, label, type]) => {
    const path = `${i}.${k}`, v = s[k] ?? '';
    let el;
    if (type === 'textarea') el = `<textarea rows="3" data-p="${path}">${esc(v)}</textarea>`;
    else if (type === 'step') el = stepSel(v, path);
    else if (['tags', 'sectors', 'members', 'ai_agents'].includes(type)) el = `<select data-p="${path}" data-num><option value="">Selecione</option>${L[type].map(o => `<option value="${o.id}" ${String(o.id) === String(v) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
    else if (type === 'days') el = `<input data-p="${path}" data-days value="${esc(Array.isArray(v) ? v.join(',') : v || '1,2,3,4,5')}">`;
    else el = `<input data-p="${path}" ${type === 'number' ? 'type="number" data-num' : ''} value="${esc(v)}">`;
    return `<label class="f"><span>${esc(label)}</span>${el}</label>`;
  };
  const draw = () => {
    main.innerHTML = `<div class="page"><a href="#/chatbots">← Chatbots</a><div class="head" style="margin-top:10px"><div class="grow"><input id="bname" value="${esc(bot.name)}" style="font-size:20px;font-weight:600;max-width:420px" aria-label="Nome do chatbot">
      <p class="muted small">Os passos rodam em ordem. Menus e perguntas aguardam a resposta do contato. Variáveis nos textos: <code>{{contact.name}}</code>, <code>{{vars.opcao}}</code>, <code>{{vars.webhook.campo}}</code>.</p></div>
      <div class="row"><label class="row"><input type="checkbox" id="bactive" ${bot.active && bot.active !== '0' ? 'checked' : ''}> Ativo</label><button class="btn primary" id="bsave">Salvar</button></div></div>
      <div id="steps">${bot.steps.map((s, i) => `<div class="step"><div class="h"><b>${i + 1}.</b><select data-type="${i}" style="width:auto">${Object.entries(STEP).map(([k, [l]]) => `<option value="${k}" ${k === s.type ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="id" title="ID do passo">${esc(s.id)}</span><span class="grow"></span>
        <button class="btn sm" data-mv="${i}:-1" aria-label="Subir">↑</button><button class="btn sm" data-mv="${i}:1" aria-label="Descer">↓</button><button class="btn sm danger" data-rm="${i}">Remover</button></div>
        <div class="grid2">${(STEP[s.type]?.[1] || []).map(f => input(s, i, f)).join('')}</div>
        ${s.type === 'options' ? `<h3>Opções</h3>${(s.options || []).map((o, j) => `<div class="row" style="margin-bottom:6px"><b>${j + 1}</b><input data-p="${i}.options.${j}.label" value="${esc(o.label)}" placeholder="Rótulo">${stepSel(o.goto, `${i}.options.${j}.goto`)}<button class="btn sm danger" data-rmopt="${i}:${j}">✕</button></div>`).join('')}<button class="btn sm" data-addopt="${i}">+ Opção</button>` : ''}
      </div>`).join('') || '<div class="card empty">Nenhum passo ainda.</div>'}</div>
      <div class="row wrap"><select id="newType" style="width:auto">${Object.entries(STEP).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn" id="addStep">+ Adicionar passo</button>
      <span class="grow"></span><span class="small muted">Para testar: ligue este bot a um canal Widget em Configurações › Canais e abra o widget.</span></div></div>`;
    $$('[data-p]', main).forEach(el => el.oninput = el.onchange = () => {
      const parts = el.dataset.p.split('.'); let o = bot.steps; while (parts.length > 1) o = o[parts.shift()];
      let v = el.value; if ('num' in el.dataset) v = v === '' ? null : Number(v); if ('days' in el.dataset) v = v.split(',').map(x => x.trim()).filter(Boolean).map(Number);
      o[parts[0]] = v;
    });
    $$('[data-type]', main).forEach(el => el.onchange = () => { bot.steps[el.dataset.type].type = el.value; if (el.value === 'options') bot.steps[el.dataset.type].options ||= [{ label: 'Opção 1' }]; draw(); });
    $$('[data-mv]', main).forEach(b => b.onclick = () => { const [i, d] = b.dataset.mv.split(':').map(Number); const j = i + d; if (j < 0 || j >= bot.steps.length) return; [bot.steps[i], bot.steps[j]] = [bot.steps[j], bot.steps[i]]; draw(); });
    $$('[data-rm]', main).forEach(b => b.onclick = () => { bot.steps.splice(Number(b.dataset.rm), 1); draw(); });
    $$('[data-addopt]', main).forEach(b => b.onclick = () => { const s = bot.steps[b.dataset.addopt]; (s.options ||= []).push({ label: 'Opção ' + (s.options.length + 1) }); draw(); });
    $$('[data-rmopt]', main).forEach(b => b.onclick = () => { const [i, j] = b.dataset.rmopt.split(':').map(Number); bot.steps[i].options.splice(j, 1); draw(); });
    $('#addStep').onclick = () => { const type = $('#newType').value; bot.steps.push({ id: nid(), type, ...(type === 'options' ? { options: [{ label: 'Opção 1' }, { label: 'Opção 2' }] } : {}) }); draw(); };
    $('#bname').oninput = (e) => bot.name = e.target.value;
    $('#bactive').onchange = (e) => bot.active = e.target.checked ? 1 : 0;
    $('#bsave').onclick = guard(async () => { await api('PUT', '/api/v1/bots/' + id, { name: bot.name, active: bot.active, steps: bot.steps }); await refreshLookups(); toast('Chatbot salvo'); });
  };
  draw();
}

// ---------- dashboard ----------
async function pageDashboard(main) {
  const today = new Date(), from = new Date(today - 7 * 864e5);
  const iso = (d) => d.toLocaleDateString('sv-SE'); // local YYYY-MM-DD
  const utc = (day, end) => new Date(`${day}T${end ? '23:59:59' : '00:00:00'}`).toISOString().replace('T', ' ').slice(0, 19);
  main.innerHTML = `<div class="page"><div class="head"><div><h1>Relatórios</h1><p class="muted">Conversas, atendentes, tempos de resposta e distribuição por canal, setor, etiqueta e horário.</p></div>
    <div class="row"><input type="date" id="dfrom" value="${iso(from)}" aria-label="De"><input type="date" id="dto" value="${iso(today)}" aria-label="Até"><button class="btn" id="dgo">Filtrar</button></div></div><div id="dash"></div></div>`;
  const load = guard(async () => {
    const r = await api('GET', `/api/v1/reports?from=${encodeURIComponent(utc($('#dfrom').value))}&to=${encodeURIComponent(utc($('#dto').value, true))}`);
    const bars = (title, rows) => { const max = Math.max(1, ...rows.map(x => x.n)); return `<div class="card"><h2>${title}</h2><div class="bars">${rows.map(x => `<div><span title="${esc(x.label)}">${esc(x.label)}</span><i style="width:${x.n / max * 100}%"></i><b>${x.n}</b></div>`).join('') || '<p class="muted">Sem dados no período.</p>'}</div></div>`; };
    const kpi = (l, v, h) => `<div class="card kpi"><span class="small muted">${l}</span><b>${v}</b><span class="small muted">${h}</span></div>`;
    $('#dash').innerHTML = `<div class="kpis">${kpi('Total de conversas', r.total, 'iniciadas no período')}${kpi('Abertas', r.open, 'ainda em andamento')}${kpi('Finalizadas', r.closed, 'encerradas')}${kpi('Com interação', r.interacted, 'atendente respondeu')}${kpi('Primeira resposta', dur(r.avg_first_response_s), 'tempo médio')}${kpi('Finalizar atendimento', dur(r.avg_close_s), 'tempo médio')}</div>
      <div class="charts">${bars('Conversas por atendente', r.by_member)}${bars('Conversas por canal', r.by_channel)}${bars('Conversas por setor', r.by_sector)}${bars('Conversas por etiqueta', r.by_tag)}${bars('Conversas iniciadas por dia', r.by_day)}${bars('Conversas iniciadas por hora', r.by_hour.map(x => ({ ...x, label: String((Number(x.label) - new Date().getTimezoneOffset() / 60 + 24) % 24).padStart(2, '0') + 'h' })).sort((x, y) => x.label.localeCompare(y.label)))}${bars('Conversas por DDD', r.by_ddd)}${bars('Mensagens por origem', r.messages)}</div>`;
  });
  $('#dgo').onclick = load; load();
}

// ---------- settings ----------
const SNAV = [
  ['MINHA CONTA', [['profile', 'Perfil'], ['preferences', 'Preferências pessoais'], ['tokens', 'Tokens de acesso']]],
  ['EMPRESA', [['organization', 'Dados da empresa'], ['members', 'Atendentes'], ['sectors', 'Setores'], ['channels', 'Canais de atendimento'], ['tags', 'Etiquetas']]],
  ['ATENDIMENTO', [['quick_answers', 'Respostas rápidas'], ['chats', 'Conversas'], ['inactivity', 'Inatividade'], ['all-chats', 'Listar todas as conversas']]],
  ['AUTOMAÇÃO E IA', [['#/ai-agents', 'Agentes de IA'], ['#/chatbots', 'Chatbots'], ['knowledge_bases', 'Bases de conhecimento'], ['scheduled_messages', 'Agendamentos']]],
  ['RELATÓRIOS E DADOS', [['#/dashboard', 'Relatórios'], ['activity', 'Atividades']]],
  ['INTEGRAÇÕES', [['webhooks', 'Webhooks'], ['api', 'API']]],
];
async function pageSettings(main, sec) {
  main.innerHTML = `<div class="settings"><nav class="snav" aria-label="Configurações">${SNAV.map(([g, items]) => `<b>${g}</b>${items.map(([k, l]) => `<a href="${k.startsWith('#') ? k : '#/settings/' + k}" class="${k === sec ? 'on' : ''}">${l}</a>`).join('')}`).join('')}
    <div class="small muted" style="margin:16px 10px">Atende · ${esc(ME.settings.org_name)}</div><button class="btn sm" id="logout" style="margin:0 10px">Sair</button></nav><div id="sbody" style="overflow:auto"></div></div>`;
  $('#logout').onclick = guard(async () => { await api('POST', '/api/v1/auth/logout', {}); store.set('tk', null); location.hash = ''; location.reload(); });
  const body = $('#sbody');
  if (RES[sec]) return pageCrud(main, sec, body);
  const S = SETTINGS_PAGES[sec]; if (!S) { body.innerHTML = '<div class="page"><h1>Seção não encontrada</h1></div>'; return; }
  await S(body);
}
const formPage = (body, { title, desc, fields, values, onSave, after = '' }) => {
  body.innerHTML = `<div class="page" style="max-width:720px"><h1>${title}</h1><p class="muted">${desc}</p><div class="card" id="fp">${fields.map(f => field(f, values[f.k])).join('')}<button class="btn primary" id="fsave">Salvar</button></div>${after}</div>`;
  $('#fsave').onclick = guard(async () => { await onSave(readForm($('#fp'), fields)); toast('Salvo'); });
};
const SETTINGS_PAGES = {
  profile: (b) => formPage(b, { title: 'Perfil', desc: 'Seus dados pessoais e mensagem de encerramento.', values: ME,
    fields: [{ k: 'name', label: 'Nome', required: true }, { k: 'phone', label: 'Telefone' }, { k: 'closing_message', label: 'Mensagem de finalização de conversa', type: 'textarea', help: 'Se definida, tem precedência sobre a mensagem de finalização da organização.' }, { k: 'password', label: 'Nova senha (opcional)', type: 'password' }],
    onSave: async (v) => { if (!v.password) delete v.password; Object.assign(ME, await api('PUT', '/api/v1/me', v)); } }),
  preferences: (b) => formPage(b, { title: 'Preferências pessoais', desc: 'Notificações e comportamento do campo de mensagem.', values: { ...{ enter: 'send', notify: 'background', sound: 1 }, ...(ME.prefs || {}) },
    fields: [{ k: 'enter', label: 'Ação da tecla Enter ao digitar', type: 'radio', options: [['send', 'Enviar a mensagem (Shift+Enter quebra a linha)'], ['newline', 'Quebrar a linha (Ctrl+Enter envia)']] },
      { k: 'notify', label: 'Notificações do navegador', type: 'radio', options: [['always', 'Mostrar sempre'], ['background', 'Só com o app em segundo plano'], ['never', 'Nunca mostrar']] },
      { k: 'sound', label: 'Som', type: 'check', text: 'Tocar som ao receber mensagens' }],
    onSave: async (prefs) => { if (prefs.notify !== 'never' && 'Notification' in window) Notification.requestPermission(); Object.assign(ME, await api('PUT', '/api/v1/me', { prefs })); } }),
  organization: (b) => formPage(b, { title: 'Dados da empresa', desc: 'Nome exibido no widget e nas variáveis {{org.org_name}}.', values: ME.settings, fields: [{ k: 'org_name', label: 'Nome da empresa', required: true }], onSave: async (v) => { ME.settings = await api('PUT', '/api/v1/settings', v); } }),
  chats: (b) => formPage(b, { title: 'Configurações de conversas', desc: 'Comportamento padrão das conversas.', values: ME.settings,
    fields: [{ k: 'signature', label: 'Assinatura do atendente', type: 'radio', options: [['optional', 'O atendente escolhe mostrar ou não'], ['always', 'Sempre mostrar'], ['never', 'Nunca mostrar']] },
      { k: 'close_message', label: 'Mensagem padrão ao finalizar', type: 'textarea', rows: 3 },
      { k: 'transfer_scope', label: 'Transferência', type: 'radio', options: [['all', 'Exibir todos os setores para transferência'], ['mine', 'Exibir apenas os setores do atendente (admins veem todos)']] },
      { k: 'read_on_open', label: 'Leitura', type: 'check', text: 'Marcar mensagens como lidas ao abrir a conversa' }],
    onSave: async (v) => { v.read_on_open = !!v.read_on_open; ME.settings = await api('PUT', '/api/v1/settings', v); } }),
  inactivity: (b) => formPage(b, { title: 'Fluxo de inatividade', desc: 'Finaliza automaticamente conversas em que o contato não respondeu após um tempo.', values: ME.settings,
    fields: [{ k: 'inactivity_minutes', label: 'Minutos sem resposta do contato (0 = desligado)', type: 'number' }, { k: 'inactivity_message', label: 'Mensagem enviada ao finalizar', type: 'textarea', rows: 3 }],
    onSave: async (v) => { ME.settings = await api('PUT', '/api/v1/settings', v); } }),
  tokens: async (b) => {
    const list = await api('GET', '/api/v1/tokens');
    b.innerHTML = `<div class="page" style="max-width:820px"><div class="head"><div><h1>Tokens de acesso</h1><p class="muted">Use na API pública: <code>Authorization: Bearer &lt;token&gt;</code>. O token só é mostrado uma vez.</p></div><button class="btn primary" id="newTok">Novo token</button></div>
      ${table(list, [['name', 'Nome'], ['created_at', 'Criado', fmtTime]], { actions: (r) => `<button class="btn sm danger" data-deltok="${r.id}">Revogar</button>` })}</div>`;
    $('#newTok').onclick = async () => { const r = await modal({ title: 'Novo token', fields: [{ k: 'name', label: 'Nome', required: true }], ok: 'Criar', onOk: (v) => api('POST', '/api/v1/tokens', v) }); if (r) { await modal({ title: 'Token criado', body: `<p>Copie agora — ele não será exibido novamente.</p><pre>${esc(r.token)}</pre>` }); SETTINGS_PAGES.tokens(b); } };
    $$('[data-deltok]').forEach(x => x.onclick = guard(async () => { if (await confirmBox('Revogar este token?')) { await api('DELETE', '/api/v1/tokens/' + x.dataset.deltok); SETTINGS_PAGES.tokens(b); } }));
  },
  'all-chats': async (b) => {
    must(can('Admin'), 'Apenas administradores');
    const draw = async () => {
      const st = $('#acst')?.value || 'all', ch = $('#acch')?.value || '';
      const rows = await api('GET', `/api/v1/chats?tab=${st}${ch ? '&channel_id=' + ch : ''}`);
      b.innerHTML = `<div class="page"><h1>Listar todas as conversas</h1><p class="muted">Todas as conversas da organização, de qualquer atendente.</p>
        <div class="row" style="margin:12px 0;max-width:520px"><select id="acst"><option value="all">Todos os status</option><option value="waiting" ${st === 'waiting' ? 'selected' : ''}>Esperando</option><option value="closed" ${st === 'closed' ? 'selected' : ''}>Finalizadas</option></select>
        <select id="acch"><option value="">Todos os canais</option>${L.channels.map(c => `<option value="${c.id}" ${String(c.id) === ch ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        ${table(rows, [['contact_name', 'Contato'], ['channel_name', 'Canal'], ['sector_name', 'Setor'], ['member_name', 'Atendente'], ['state', 'Status', v => v === 'Open' ? 'Aberta' : 'Finalizada'], ['created_at', 'Criada', fmtTime]], { href: (r) => '#/chats/' + r.id })}</div>`;
      $('#acst').onchange = $('#acch').onchange = draw; $$('tr[data-href]', b).forEach(tr => tr.onclick = () => location.hash = tr.dataset.href);
    };
    await draw();
  },
  activity: async (b) => {
    const rows = await api('GET', '/api/v1/activity');
    b.innerHTML = `<div class="page"><h1>Logs de atividade</h1><p class="muted">Registro das atividades realizadas na organização.</p>${table(rows, [['created_at', 'Quando', fmtTime], ['member_name', 'Atendente', v => v || 'Sistema'], ['type', 'Atividade'], ['detail', 'Detalhe']])}</div>`;
  },
  api: (b) => {
    const o = location.origin;
    b.innerHTML = `<div class="page" style="max-width:860px"><h1>API</h1><p class="muted">REST/JSON em <code>${o}/api/v1</code>. Autentique com um token pessoal (Configurações › Tokens de acesso).</p>
      <div class="card"><h2>Receber mensagem de um provedor (WhatsApp, Instagram, SMS...)</h2><p class="small muted">Aponte o webhook do seu provedor para um pequeno adaptador que chame:</p>
      <pre>curl -X POST ${o}/api/v1/inbound \\
  -H "Authorization: Bearer SEU_TOKEN" -H "Content-Type: application/json" \\
  -d '{"channel_id":1,"phone":"+5511999990000","name":"Ana","text":"Olá!"}'</pre>
      <p class="small muted">Para enviar as respostas ao provedor, cadastre um webhook com o evento <b>Message</b> e filtre <code>payload.message.source != "Contact"</code>.</p></div>
      <div class="card" style="margin-top:12px"><h2>Recursos</h2><pre>GET/POST            /api/v1/{contacts|tags|sectors|channels|members|quick_answers|bots|ai_agents|knowledge_bases|campaigns|scheduled_messages|webhooks}
GET/PUT/DELETE      /api/v1/{recurso}/{id}
GET                 /api/v1/chats?tab=inbox|waiting|closed|all&q=&sector_id=&channel_id=&tag_id=
POST                /api/v1/chats                      {contact_id | phone,name} channel_id text
GET                 /api/v1/chats/{id}                 (com mensagens)
POST                /api/v1/chats/{id}/messages        {text, note}
PUT                 /api/v1/chats/{id}/assign|transfer|close|reopen|private|read
POST/DELETE         /api/v1/chats/{id}/tags[/{tagId}]
POST                /api/v1/chats/{id}/start-bot       {bot_id}
POST                /api/v1/chats/{id}/ai-agent        {agent_id}
GET                 /api/v1/contacts/{id}/details      (tags, notas, conversas)
POST                /api/v1/contacts/{id}/notes|tags
GET                 /api/v1/reports?from=AAAA-MM-DD&to=AAAA-MM-DD
GET                 /api/v1/activity
GET (SSE)           /api/v1/events?token=…            eventos "message" e "chat" em tempo real</pre></div></div>`;
  },
};
function must(c, msg) { if (!c) throw new Error(msg); }

// ---------- boot ----------
async function authScreen() {
  const { needsSetup } = await api('GET', '/api/v1/setup');
  $('#root').innerHTML = `<div class="login"><form class="card" id="lf"><div class="logo" style="width:44px;height:44px;border-radius:12px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:700;margin-bottom:14px">A</div>
    <h1>${needsSetup ? 'Criar sua conta' : 'Entrar no Atende'}</h1><p class="muted">${needsSetup ? 'Primeiro acesso: crie a conta do proprietário.' : 'Atendimento multicanal com chatbots e IA.'}</p>
    ${needsSetup ? field({ k: 'org_name', label: 'Nome da empresa' }) + field({ k: 'name', label: 'Seu nome' }) : ''}${field({ k: 'email', label: 'E-mail', type: 'email' })}${field({ k: 'password', label: 'Senha', type: 'password' })}
    <button class="btn primary" style="width:100%">${needsSetup ? 'Criar conta' : 'Entrar'}</button></form></div>`;
  $('#lf').onsubmit = guard(async (e) => {
    e.preventDefault(); const v = Object.fromEntries(['org_name', 'name', 'email', 'password'].map(k => [k, $('#f_' + k)?.value]));
    if (needsSetup) await api('POST', '/api/v1/setup', v);
    store.set('tk', (await api('POST', '/api/v1/auth/login', v)).token); boot();
  });
}
async function boot() {
  if (!store.get('tk')) return authScreen();
  try { ME = await api('GET', '/api/v1/me'); } catch { store.set('tk', null); return authScreen(); }
  await refreshLookups(); connectEvents(); route(); updateBadge();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* needs https or localhost */ });
boot();
