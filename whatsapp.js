// WhatsApp channel via Baileys (unofficial WhatsApp Web protocol): QR login, receive text, send text.
// Unofficial = against WhatsApp's terms: the number can be banned. See README before using a real number.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

const quiet = { level: 'silent', child() { return this; }, trace() { }, debug() { }, info() { }, warn() { }, error() { }, fatal() { } };
const LOGGED_OUT = 401, TIMED_OUT = 408;

async function baileysFactory(authDir) {
  const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = await import('@whiskeysockets/baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir); // the auth dir IS the WhatsApp login: never serve or commit it
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* falls back to the bundled version */ }
  const sock = makeWASocket({ auth: state, version, browser: Browsers.macOS('Desktop'), logger: quiet, syncFullHistory: false, markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

export const textOf = (msg) => {
  msg = msg?.ephemeralMessage?.message || msg?.viewOnceMessage?.message || msg;
  if (!msg) return null;
  return msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || msg.documentMessage?.caption
    || (msg.imageMessage ? '[imagem]' : msg.audioMessage ? '[áudio]' : msg.videoMessage ? '[vídeo]' : msg.documentMessage ? '[documento]' : msg.stickerMessage ? '[figurinha]' : msg.locationMessage ? '[localização]' : msg.contactMessage ? '[contato]' : null);
};

export function createWhatsApp({ authRoot, onText, onChange = () => { }, reconnectMs = 2000 }) {
  let factory = baileysFactory;
  const conns = new Map(); // channelId -> { sock, state: connecting|qr|connected, qr, phone }
  const seen = new Set(); // recent message ids: WhatsApp redelivers on reconnect
  const stubs = new Set(); // ids already warned about as content-less
  const authDir = (id) => path.join(authRoot, String(id));
  const status = (id) => { const c = conns.get(Number(id)); return c ? { state: c.state, qr: c.qr, phone: c.phone } : { state: 'disconnected', qr: null, phone: null }; };
  const changed = (id) => onChange(Number(id), status(id));

  async function connect(id) {
    id = Number(id);
    if (conns.has(id)) return status(id);
    const c = { sock: null, state: 'connecting', qr: null, phone: null };
    conns.set(id, c); changed(id);
    try { c.sock = await factory(authDir(id)); } catch (e) { conns.delete(id); changed(id); throw e; }
    const sock = c.sock;
    sock.ev.on('connection.update', async (u) => {
      if (c.sock !== sock) return; // event from a replaced socket
      if (u.qr) { c.state = 'qr'; c.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }); changed(id); }
      if (u.connection === 'open') { c.state = 'connected'; c.qr = null; c.phone = String(sock.user?.id || '').split(':')[0].split('@')[0] || null; changed(id); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        const wasWaitingQr = c.state === 'qr';
        console.log(`whatsapp: conexão fechada (código ${code ?? '?'})`);
        c.sock = null; conns.delete(id);
        if (code === LOGGED_OUT) fs.rmSync(authDir(id), { recursive: true, force: true }); // phone removed the device
        else if (!(code === TIMED_OUT && wasWaitingQr)) setTimeout(() => connect(id).catch(e => console.error('whatsapp reconnect', e.message)), reconnectMs); // QR not scanned in time: stop until asked again
        changed(id);
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try {
          const jid = m.key?.remoteJid || '';
          const age = Date.now() / 1000 - Number(m.messageTimestamp || 0);
          // 'append' carries history sync: only take it when the message is fresh (missed while offline)
          const pj = m.key?.remoteJidAlt || (jid.endsWith('@s.whatsapp.net') ? jid : null); // newer WhatsApp hides the number behind a @lid id
          const who = { channelId: id, jid, phone: pj ? '+' + pj.split('@')[0].split(':')[0] : null, name: m.pushName };
          const direct = jid && !m.key?.fromMe && !/@(g\.us|broadcast|newsletter)$/.test(jid);
          // The envelope arrived but WhatsApp did not deliver the content (stub 2): Baileys asks the phone for it and the
          // real message may arrive later with the same id. Warn the attendant so the message is not lost silently.
          if (!m.message && direct && m.messageStubType === 2) {
            if (!stubs.has(m.key.id)) { stubs.add(m.key.id); if (stubs.size > 500) stubs.delete(stubs.values().next().value); await onText({ ...who, text: null }); }
            console.log('whatsapp: mensagem sem conteúdo, aguardando o celular reenviar'); continue;
          }
          const why = !m.message ? 'sem conteúdo' : m.key.fromMe ? 'enviada por você' : !direct ? 'grupo/status' : type !== 'notify' && !(type === 'append' && age < 600) ? `tipo ${type}` : seen.has(m.key.id) ? 'duplicada' : null;
          if (why) { console.log(`whatsapp: mensagem ignorada (${why})`); continue; }
          seen.add(m.key.id); if (seen.size > 2000) seen.delete(seen.values().next().value);
          const text = textOf(m.message); if (!text) { console.log(`whatsapp: mensagem sem texto ignorada (${Object.keys(m.message).join(',')})`); continue; } // reactions, protocol messages...
          await onText({ ...who, text });
        } catch (e) { console.error('whatsapp inbound', e.message); }
      }
    });
    return status(id);
  }

  async function send(id, to, text) {
    const c = conns.get(Number(id));
    if (c?.state !== 'connected') throw new Error('WhatsApp desconectado: reconecte o canal');
    await c.sock.sendMessage(to, { text });
  }

  async function logout(id) {
    id = Number(id); const c = conns.get(id);
    conns.delete(id);
    try { await c?.sock?.logout(); } catch { /* already gone */ }
    fs.rmSync(authDir(id), { recursive: true, force: true });
    changed(id);
  }

  const restore = (ids) => ids.filter(id => fs.existsSync(path.join(authDir(id), 'creds.json'))).forEach(id => connect(id).catch(e => console.error('whatsapp restore', e.message)));
  return { connect, send, logout, status, restore, useFactory: (f) => { factory = f; } };
}
