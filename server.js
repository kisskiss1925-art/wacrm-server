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
app.use(express.json({ limit: '10mb' }));

const evo = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { 'apikey': EVOLUTION_KEY, 'Content-Type': 'application/json' },
  timeout: 15000
});

app.get('/', (req, res) => res.json({
  status: '🟢 WA CRM Server rodando!',
  instancia: INSTANCE_NAME,
  clientes_conectados: io.engine.clientsCount,
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
  const { numero, texto } = req.body;
  if (!numero || !texto) return res.status(400).json({ erro: 'numero e texto obrigatorios' });
  try {
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

// ── EXTRAIR TEXTO da mensagem ─────────────────
function extrairTexto(message) {
  if (!message) return '';
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || (message.imageMessage    ? '📷 Imagem'    : '')
    || (message.audioMessage    ? '🎵 Áudio'     : '')
    || (message.videoMessage    ? '🎬 Vídeo'     : '')
    || (message.documentMessage ? '📄 Documento' : '')
    || (message.stickerMessage  ? '🖼️ Sticker'  : '')
    || (message.reactionMessage ? '👍 Reação'    : '')
    || (message.contactMessage  ? '👤 Contato'   : '')
    || (message.locationMessage ? '📍 Localização': '')
    || (message.listResponseMessage ? '📋 Lista' : '')
    || (message.buttonsResponseMessage ? '🔘 Botão' : '')
    || '';
}

// ── PROCESSAR uma mensagem ───────────────────
function processarMensagem(m) {
  if (!m) return null;

  const jid = m.key?.remoteJid || m.remoteJid || '';
  // Ignora grupos e broadcasts
  if (!jid.endsWith('@s.whatsapp.net')) return null;

  const txt = extrairTexto(m.message || m);
  if (!txt) return null;

  const numero = jid.replace('@s.whatsapp.net', '');
  const ts     = m.messageTimestamp || m.timestamp || Math.floor(Date.now()/1000);
  const d      = new Date(ts * 1000);

  return {
    id:        m.key?.id || m.id || ('m' + Date.now()),
    numero,
    waId:      jid,
    texto:     txt,
    de:        m.key?.fromMe ? 'out' : 'in',
    nome:      m.pushName || m.verifiedName || m.notifyName || numero,
    horario:   d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    timestamp: ts
  };
}

// ── WEBHOOK ───────────────────────────────────
app.post('/webhook', (req, res) => {
  const ev   = req.body;
  const tipo = (ev?.event || ev?.type || '').toLowerCase();

  // Log completo para debug
  console.log('\n══════════════════════════════');
  console.log('📨 WEBHOOK RECEBIDO:', tipo);
  console.log('BODY:', JSON.stringify(ev).slice(0, 500));
  console.log('══════════════════════════════\n');

  // Trata TODOS os eventos que podem conter mensagens
  if (tipo.includes('message')) {
    const data = ev?.data || ev?.message || ev;

    // Formato 1: { data: { messages: [...] } }
    // Formato 2: { data: { key: ..., message: ... } } — mensagem única
    // Formato 3: { data: [...] } — array direto
    // Formato 4: a mensagem está direto em data

    let lista = [];

    if (Array.isArray(data?.messages))      lista = data.messages;
    else if (Array.isArray(data))            lista = data;
    else if (data?.key && data?.message)     lista = [data];
    else if (data?.key)                      lista = [data];
    else if (Array.isArray(ev?.messages))    lista = ev.messages;
    else lista = [ev]; // último recurso

    lista.forEach(m => {
      const payload = processarMensagem(m);
      if (!payload) return;

      const dir = payload.de === 'in' ? '⬇️  RECEBIDA' : '⬆️  ENVIADA';
      console.log(`${dir} | ${payload.nome} | ${payload.texto}`);
      io.emit('nova_mensagem', payload);
      console.log(`📡 Emitido para ${io.engine.clientsCount} cliente(s)`);
    });
  }

  if (tipo.includes('connection')) {
    const estado = ev?.data?.state || ev?.data?.connection || ev?.state;
    console.log('🔌 Conexão:', estado);
    io.emit('status_conexao', { estado, conectado: estado === 'open' });
  }

  res.json({ recebido: true });
});

// ── CONFIGURAR WEBHOOK ───────────────────────
app.post('/configurar-webhook', async (req, res) => {
  const url = req.body?.url || `${req.protocol}://${req.get('host')}/webhook`;
  try {
    const r = await evo.post(`/webhook/set/${INSTANCE_NAME}`, {
      url,
      webhook_by_events: false,
      webhook_base64:    false,
      events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','QRCODE_UPDATED','SEND_MESSAGE']
    });
    console.log('✅ Webhook configurado:', url);
    res.json({ sucesso: true, url, dados: r.data });
  } catch(e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🟢 WA CRM Server na porta ${PORT}`);
  console.log(`📡 Evolution: ${EVOLUTION_URL}`);
  console.log(`📱 Instância: ${INSTANCE_NAME}\n`);
});
