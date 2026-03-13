const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);

const PORT          = process.env.PORT || 3000;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-4551.up.railway.app';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'minhachave2025';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'meu-whatsapp';

const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
io.on('connection', s => {
  console.log('✅ CRM conectado:', s.id);
  s.on('disconnect', () => console.log('❌ Desconectado:', s.id));
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const evo = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { 'apikey': EVOLUTION_KEY, 'Content-Type': 'application/json' },
  timeout: 15000
});

app.get('/', (req, res) => res.json({
  status: '🟢 WA CRM Server rodando!',
  instancia: INSTANCE_NAME,
  clientes: io.engine.clientsCount,
  ts: new Date().toISOString()
}));

app.post('/conversas', async (req, res) => {
  try { const r = await evo.post(`/chat/findChats/${INSTANCE_NAME}`, req.body||{}); res.json(r.data); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/mensagens', async (req, res) => {
  try { const r = await evo.post(`/chat/findMessages/${INSTANCE_NAME}`, req.body); res.json(r.data); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/enviar', async (req, res) => {
  try {
    const { numero, texto } = req.body;
    if (!numero || !texto) return res.status(400).json({ erro: 'numero e texto obrigatorios' });
    const r = await evo.post(`/message/sendText/${INSTANCE_NAME}`, {
      number: numero.replace(/\D/g,''), text: texto
    });
    res.json({ sucesso: true, dados: r.data });
  } catch(e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.get('/status', async (req, res) => {
  try { const r = await evo.get(`/instance/connectionState/${INSTANCE_NAME}`); res.json(r.data); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

function extrairTexto(msg) {
  if (!msg) return '';
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || (msg.imageMessage    ? '📷 Imagem'    : '')
    || (msg.audioMessage    ? '🎵 Áudio'     : '')
    || (msg.videoMessage    ? '🎬 Vídeo'     : '')
    || (msg.documentMessage ? '📄 Documento' : '')
    || (msg.stickerMessage  ? '🖼️ Sticker'  : '')
    || (msg.reactionMessage ? '👍 Reação'    : '')
    || '';
}

function processarMsg(m) {
  try {
    if (!m) return null;
    const jid = m.key?.remoteJid || m.remoteJid || '';
    if (!jid.endsWith('@s.whatsapp.net')) return null;
    const txt = extrairTexto(m.message || m);
    if (!txt) return null;
    const numero = jid.replace('@s.whatsapp.net','');
    const ts = m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000);
    const d  = new Date(ts * 1000);
    return {
      id:        m.key?.id || ('m'+Date.now()+Math.random()),
      numero,    waId: jid, texto: txt,
      de:        m.key?.fromMe ? 'out' : 'in',
      nome:      m.pushName || m.verifiedName || m.notifyName || numero,
      horario:   d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
      timestamp: ts
    };
  } catch(e) { console.error('Erro processarMsg:', e.message); return null; }
}

// ── WEBHOOK ───────────────────────────────────
app.post('/webhook', (req, res) => {
  // Responde IMEDIATAMENTE para não dar timeout
  res.json({ recebido: true });

  try {
    const ev   = req.body;
    const tipo = String(ev?.event || ev?.type || '').toLowerCase();
    console.log('\n--- WEBHOOK:', tipo, '---');
    console.log(JSON.stringify(ev).slice(0, 800));

    if (!tipo.includes('message')) return;

    // Coleta todos os candidatos a mensagem
    const data = ev?.data;
    let lista  = [];

    if (Array.isArray(data?.messages))   lista = data.messages;
    else if (Array.isArray(data))        lista = data;
    else if (data?.key)                  lista = [data];
    else if (Array.isArray(ev?.messages))lista = ev.messages;
    else if (ev?.key)                    lista = [ev];

    console.log(`Candidatos: ${lista.length}`);

    lista.forEach(m => {
      const p = processarMsg(m);
      if (!p) return;
      console.log(`${p.de==='in'?'⬇️ RECEBIDA':'⬆️ ENVIADA'}: ${p.nome} → "${p.texto}"`);
      io.emit('nova_mensagem', p);
      console.log(`Emitido para ${io.engine.clientsCount} cliente(s)`);
    });

  } catch(e) {
    console.error('Erro no webhook:', e.message, e.stack);
  }
});

// ── CONFIGURAR WEBHOOK ───────────────────────
app.post('/configurar-webhook', async (req, res) => {
  try {
    const url = req.body?.url || `${req.protocol}://${req.get('host')}/webhook`;
    const r = await evo.post(`/webhook/set/${INSTANCE_NAME}`, {
      url,
      webhook_by_events: false,
      webhook_base64:    false,
      events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','SEND_MESSAGE']
    });
    console.log('✅ Webhook configurado:', url);
    res.json({ sucesso: true, url, dados: r.data });
  } catch(e) {
    console.error('Erro configurar webhook:', e.message);
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🟢 WA CRM Server | Porta ${PORT}`);
  console.log(`📡 Evolution: ${EVOLUTION_URL}`);
  console.log(`📱 Instância: ${INSTANCE_NAME}\n`);
  // Auto-configura webhook ao iniciar
  setTimeout(async () => {
    try {
      const host = `https://wacrm-server-production.up.railway.app`;
      await evo.post(`/webhook/set/${INSTANCE_NAME}`, {
        url: `${host}/webhook`,
        webhook_by_events: false,
        webhook_base64: false,
        events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','SEND_MESSAGE']
      });
      console.log('✅ Webhook auto-configurado para:', `${host}/webhook`);
    } catch(e) {
      console.log('⚠️ Auto-config webhook falhou:', e.message);
    }
  }, 3000);
});
