const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-4551.up.railway.app';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'minhachave2025';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'meu-whatsapp';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:hOnHZYydQKuXMVDDpeqpSeKtlbqmYTue@shinkansen.proxy.rlwy.net:30162/railway';

// ── POSTGRES ──────────────────────────────────
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

async function initDB() {
  if (!pool) { console.log('⚠️ Sem DATABASE_URL — dados em memória'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        phone TEXT, name TEXT, company TEXT,
        stage TEXT DEFAULT 'lead',
        color TEXT, pinned BOOLEAN DEFAULT false,
        tags JSONB DEFAULT '[]',
        notes JSONB DEFAULT '[]',
        unread INT DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conv_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        text TEXT, from_me BOOLEAN, msg_time TEXT,
        msg_date TEXT, status TEXT,
        timestamp BIGINT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS quick_messages (
        id TEXT PRIMARY KEY,
        label TEXT, text TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp DESC);
    `);
    console.log('✅ Banco de dados pronto!');

    // Seeds mensagens rápidas padrão
    const existing = await pool.query('SELECT id FROM quick_messages LIMIT 1');
    if (existing.rows.length === 0) {
      const defaults = [
        ['q1','Boas-vindas','Olá! Seja bem-vindo(a)! 😊 Como posso te ajudar hoje?'],
        ['q2','Aguardar','Um momento, por favor! Já vou verificar isso para você!'],
        ['q3','Proposta','Preparei uma proposta especial para você! Posso enviar agora?'],
        ['q4','Fechamento','Perfeito! Para finalizar, poderia me confirmar seus dados?'],
        ['q5','Agradecimento','Muito obrigado pela confiança! 🙏 Estamos sempre à disposição!'],
        ['q6','Follow-up','Olá! Passando para verificar se ficou alguma dúvida. Posso ajudar?'],
      ];
      for (const [id, label, text] of defaults)
        await pool.query('INSERT INTO quick_messages(id,label,text) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, label, text]);
      console.log('✅ Mensagens rápidas padrão inseridas');
    }
  } catch (e) { console.error('❌ Erro initDB:', e.message); }
}

// ── SOCKET.IO ─────────────────────────────────
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
io.on('connection', s => {
  console.log('✅ CRM conectado:', s.id);
  s.on('disconnect', () => console.log('❌ Desconectado:', s.id));
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const evo = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { 'apikey': EVOLUTION_KEY, 'Content-Type': 'application/json' },
  timeout: 15000
});

// ── HEALTH CHECK ──────────────────────────────
app.get('/', (req, res) => res.json({
  status: '🟢 WA CRM Server',
  instancia: INSTANCE_NAME,
  clientes: io.engine.clientsCount,
  db: pool ? 'postgres' : 'sem banco',
  ts: new Date().toISOString()
}));

// ── CONVERSAS ─────────────────────────────────
app.get('/db/conversas', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const convs = await pool.query('SELECT * FROM conversations ORDER BY updated_at DESC');
    const msgs = await pool.query('SELECT * FROM messages ORDER BY timestamp ASC');
    const msgMap = {};
    msgs.rows.forEach(m => {
      if (!msgMap[m.conv_id]) msgMap[m.conv_id] = [];
      msgMap[m.conv_id].push({
        id: m.id, text: m.text,
        from: m.from_me ? 'out' : 'in',
        time: m.msg_time, date: m.msg_date,
        status: m.status, timestamp: m.timestamp
      });
    });
    const result = convs.rows.map(c => ({
      id: c.id, phone: c.phone, name: c.name,
      company: c.company, stage: c.stage, color: c.color,
      pinned: c.pinned, tags: c.tags, notes: c.notes,
      unread: c.unread, messages: msgMap[c.id] || []
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/db/conversas', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    const c = req.body;
    await pool.query(`
      INSERT INTO conversations(id,phone,name,company,stage,color,pinned,tags,notes,unread,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name, stage=EXCLUDED.stage, color=EXCLUDED.color,
        pinned=EXCLUDED.pinned, tags=EXCLUDED.tags, notes=EXCLUDED.notes,
        unread=EXCLUDED.unread, updated_at=NOW()
    `, [c.id, c.phone, c.name, c.company || '', c.stage || 'lead', c.color || '#25d366',
      c.pinned || false, JSON.stringify(c.tags || []), JSON.stringify(c.notes || []), c.unread || 0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/db/conversas/:id', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    await pool.query('DELETE FROM conversations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MENSAGENS ─────────────────────────────────
app.post('/db/mensagens', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    const { convId, messages } = req.body;
    if (!messages?.length) return res.json({ ok: true });
    await pool.query('INSERT INTO conversations(id) VALUES($1) ON CONFLICT DO NOTHING', [convId]);
    for (const m of messages) {
      await pool.query(`
        INSERT INTO messages(id,conv_id,text,from_me,msg_time,msg_date,status,timestamp)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING
      `, [m.id, convId, m.text, m.from === 'out', m.time || '', m.date || '', m.status || '', m.timestamp || 0]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MSGS RÁPIDAS ──────────────────────────────
app.get('/db/quickmsgs', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const r = await pool.query('SELECT * FROM quick_messages ORDER BY created_at');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/db/quickmsgs', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    const { id, label, text } = req.body;
    await pool.query('INSERT INTO quick_messages(id,label,text) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET label=$2,text=$3',
      [id, label, text]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/db/quickmsgs/:id', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    await pool.query('DELETE FROM quick_messages WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── PROXIES EVOLUTION ─────────────────────────
app.post('/conversas', async (req, res) => {
  try { const r = await evo.post(`/chat/findChats/${INSTANCE_NAME}`, req.body || {}); res.json(r.data); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/mensagens', async (req, res) => {
  try { const r = await evo.post(`/chat/findMessages/${INSTANCE_NAME}`, req.body); res.json(r.data); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/enviar', async (req, res) => {
  try {
    const { numero, texto } = req.body;
    if (!numero || !texto) return res.status(400).json({ erro: 'numero e texto obrigatorios' });
    const r = await evo.post(`/message/sendText/${INSTANCE_NAME}`, { number: numero.replace(/\D/g, ''), text: texto });
    res.json({ sucesso: true, dados: r.data });
  } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

// ── WEBHOOK RECEIVER ──────────────────────────
function extrairTexto(msg) {
  if (!msg) return '';
  return msg.conversation || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || (msg.imageMessage ? '📷 Imagem' : '') || (msg.audioMessage ? '🎵 Áudio' : '')
    || (msg.videoMessage ? '🎬 Vídeo' : '') || (msg.documentMessage ? '📄 Documento' : '')
    || (msg.stickerMessage ? '🖼️ Sticker' : '') || '';
}

async function salvarMensagemDB(p) {
  if (!pool) return;
  try {
    await pool.query('INSERT INTO conversations(id,phone,name,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,updated_at=NOW()',
      ['wa_' + p.numero, '+' + p.numero, p.nome]);
    await pool.query('INSERT INTO messages(id,conv_id,text,from_me,msg_time,msg_date,status,timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',
      [p.id, 'wa_' + p.numero, p.texto, p.de === 'out', p.horario, 'Hoje', p.de === 'out' ? 'sent' : '', p.timestamp]);
  } catch (e) { console.error('Erro salvar msg DB:', e.message); }
}

app.post('/webhook', (req, res) => {
  res.json({ recebido: true });
  try {
    const ev = req.body;
    const tipo = String(ev?.event || ev?.type || '').toLowerCase();
    console.log('\n--- WEBHOOK:', tipo);
    if (!tipo.includes('message')) return;
    const data = ev?.data;
    let lista = [];
    if (Array.isArray(data?.messages)) lista = data.messages;
    else if (Array.isArray(data)) lista = data;
    else if (data?.key) lista = [data];
    else if (ev?.key) lista = [ev];
    lista.forEach(m => {
      try {
        const jid = m.key?.remoteJid || '';
        if (!jid.endsWith('@s.whatsapp.net')) return;
        const txt = extrairTexto(m.message || m);
        if (!txt) return;
        const numero = jid.replace('@s.whatsapp.net', '');
        const ts = m.messageTimestamp || Math.floor(Date.now() / 1000);
        const d = new Date(ts * 1000);
        const p = {
          id: m.key?.id || ('m' + Date.now() + Math.random()),
          numero, waId: jid, texto: txt,
          de: m.key?.fromMe ? 'out' : 'in',
          nome: m.pushName || numero,
          horario: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          timestamp: ts
        };
        console.log(`${p.de === 'in' ? '⬇️' : '⬆️'} ${p.nome}: ${p.texto}`);
        io.emit('nova_mensagem', p);
        salvarMensagemDB(p);
      } catch (e) { console.error('Erro processar msg:', e.message); }
    });
  } catch (e) { console.error('Erro webhook:', e.message); }
});

// ── CONFIGURAR WEBHOOK ────────────────────────
app.post('/configurar-webhook', async (req, res) => {
  try {
    const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN || 'wacrm-server-production.up.railway.app';
    const url = req.body?.url || `https://${publicDomain}/webhook`;

    const response = await evo.post(`/webhook/set/${INSTANCE_NAME}`, {
      enabled: true,
      url: url,
      webhook_by_events: false,
      webhook_base64: false,
      events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'SEND_MESSAGE']
    });

    console.log('✅ Webhook configurado com sucesso:', url);
    res.json({ sucesso: true, url, response: response.data });
  } catch (e) {
    const errorDetail = e.response?.data || e.message || 'Erro desconhecido';
    console.error('❌ Erro ao configurar webhook:', errorDetail);
    res.status(500).json({ sucesso: false, erro: errorDetail });
  }
});

// ── START ─────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🟢 WA CRM Server | Porta ${PORT}`);
  await initDB();
  console.log('Auto-config de webhook desativado — configure manualmente via POST /configurar-webhook ou diretamente na Evolution API');
});
