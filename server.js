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
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${req.method} ${req.path}`);
  next();
});

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
  const { numero, texto } = req.body;
  if (!numero || !texto) return res.status(400).json({ erro: 'numero e texto obrigatorios' });
  try {
    const r = await evo.post(`/message/sendText/${INSTANCE_NAME}`, { number: numero.replace(/\D/g,''), text: texto });
    res.json({ sucesso: true, dados: r.data });
  } catch(e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.get('/status', async (req, res) => {
  try { const r = await evo.get(`/instance/connectionState/${INSTANCE_NAME}`); res.json(r.data); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

// WEBHOOK — coração do tempo real
app.post('/webhook', (req, res) => {
  const ev   = req.body;
  const tipo = ev?.event || ev?.type || '';
  console.log('📨 Webhook:', tipo);

  if (tipo === 'messages.upsert' || tipo === 'MESSAGES_UPSERT') {
    const msgs = ev?.data?.messages || ev?.data || [];
    const lista = Array.isArray(msgs) ? msgs : [msgs];
    lista.forEach(m => {
      const txt = m.message?.conversation
        || m.message?.extendedTextMessage?.text
        || (m.message?.imageMessage    ? '📷 Imagem'    : '')
        || (m.message?.audioMessage    ? '🎵 Áudio'     : '')
        || (m.message?.videoMessage    ? '🎬 Vídeo'     : '')
        || (m.message?.documentMessage ? '📄 Documento' : '')
        || (m.message?.stickerMessage  ? '🖼️ Sticker'  : '')
        || '';
      if (!txt) return;
      const jid    = m.key?.remoteJid || '';
      const numero = jid.replace('@s.whatsapp.net','').replace('@g.us','');
      const d      = new Date((m.messageTimestamp || Date.now()/1000) * 1000);
      const payload = {
        id:        m.key?.id || ('m'+Date.now()),
        numero, waId: jid,
        texto:     txt,
        de:        m.key?.fromMe ? 'out' : 'in',
        nome:      m.pushName || m.verifiedName || numero,
        horario:   d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
        timestamp: m.messageTimestamp || Math.floor(Date.now()/1000)
      };
      console.log(`📩 ${payload.de==='in'?'⬇️ RECEBIDA':'⬆️ ENVIADA'} de ${payload.nome}: ${payload.texto}`);
      io.emit('nova_mensagem', payload);
    });
  }

  if (tipo === 'messages.update' || tipo === 'MESSAGES_UPDATE') io.emit('status_mensagem', ev?.data);
  if (tipo === 'connection.update' || tipo === 'CONNECTION_UPDATE') {
    const estado = ev?.data?.state || ev?.data?.connection;
    io.emit('status_conexao', { estado, conectado: estado === 'open' });
  }

  res.json({ recebido: true });
});

app.post('/configurar-webhook', async (req, res) => {
  const url = req.body.url || `${req.protocol}://${req.get('host')}/webhook`;
  try {
    const r = await evo.post(`/webhook/set/${INSTANCE_NAME}`, {
      url, webhook_by_events: false, webhook_base64: false,
      events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','QRCODE_UPDATED']
    });
    console.log('✅ Webhook configurado:', url);
    res.json({ sucesso: true, url, dados: r.data });
  } catch(e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

server.listen(PORT, () => {
  console.log(`\n🟢 WA CRM Server na porta ${PORT}`);
  console.log(`📡 Evolution: ${EVOLUTION_URL}`);
  console.log(`📱 Instância: ${INSTANCE_NAME}\n`);
});
