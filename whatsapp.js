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
        c.sock = null; conns.delete(id);
        if (code === LOGGED_OUT) fs.rmSync(authDir(id), { recursive: true, force: true }); // phone removed the device
        else if (!(code === TIMED_OUT && wasWaitingQr)) setTimeout(() => connect(id).catch(e => console.error('whatsapp reconnect', e.message)), reconnectMs); // QR not scanned in time: stop until asked again
        changed(id);
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          const jid = m.key?.remoteJid || '';
          if (!m.message || m.key.fromMe || !jid || /@(g\.us|broadcast|newsletter)$/.test(jid)) continue;
          if (seen.has(m.key.id)) continue;
          seen.add(m.key.id); if (seen.size > 2000) seen.delete(seen.values().next().value);
          const text = textOf(m.message); if (!text) continue; // reactions, protocol messages...
          const pj = m.key.remoteJidAlt || (jid.endsWith('@s.whatsapp.net') ? jid : null); // newer WhatsApp hides the number behind a @lid id
          await onText({ channelId: id, jid, phone: pj ? '+' + pj.split('@')[0].split(':')[0] : null, name: m.pushName, text });
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
