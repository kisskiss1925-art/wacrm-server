const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');
const axios    = require('axios');
const { Pool } = require('pg');

const app    = express();
const server = http.createServer(app);

// ══════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════
const PORT          = process.env.PORT          || 3000;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-e06fe.up.railway.app';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || '@Familia@';
const INSTANCE      = process.env.INSTANCE_NAME || 'meu-whatsapp';
const DATABASE_URL  = process.env.DATABASE_URL || 'postgresql://postgres:geecigwMqHiBGTussElRisotnzGauebb@ballast.proxy.rlwy.net:44165/railway';
const MY_URL        = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.MY_URL || 'https://wacrm-server-production-c61b.up.railway.app';

// ══════════════════════════════════════════════
// POSTGRES
// ══════════════════════════════════════════════
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB() {
  if (!pool) { console.log('⚠️  Sem DATABASE_URL — rodando sem banco'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id          TEXT PRIMARY KEY,
        phone       TEXT,
        name        TEXT,
        company     TEXT DEFAULT '',
        stage       TEXT DEFAULT 'lead',
        color       TEXT DEFAULT '#25d366',
        agent_id    TEXT,
        pinned      BOOLEAN DEFAULT false,
        unread      INT DEFAULT 0,
        tags        JSONB DEFAULT '[]',
        notes       JSONB DEFAULT '[]',
        products    JSONB DEFAULT '[]',
        wa_id       TEXT,
        last_ts     BIGINT DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        conv_id     TEXT NOT NULL,
        text        TEXT,
        from_me     BOOLEAN DEFAULT false,
        msg_time    TEXT,
        msg_date    TEXT,
        status      TEXT DEFAULT 'sent',
        media_url   TEXT,
        media_type  TEXT,
        is_bot      BOOLEAN DEFAULT false,
        timestamp   BIGINT DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (conv_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quick_messages (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        text        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_msg_conv    ON messages(conv_id);
      CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_phone  ON conversations(phone);
      CREATE INDEX IF NOT EXISTS idx_conv_ts     ON conversations(last_ts DESC);
    `);
    console.log('✅ Banco de dados inicializado!');
    await seedQuickMessages();
    await initAgentes();
  } catch(e) {
    console.error('❌ Erro ao inicializar banco:', e.message);
  }
}

async function seedQuickMessages() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM quick_messages');
  if (parseInt(rows[0].count) > 0) return;
  const defaults = [
    ['q1','Boas-vindas','Olá! Seja bem-vindo(a)! 😊 Como posso te ajudar hoje?'],
    ['q2','Aguardar','Um momento, por favor! Vou verificar isso agora mesmo.'],
    ['q3','Proposta','Preparei uma proposta especial para você! Posso enviar?'],
    ['q4','Fechamento','Para finalizar, poderia confirmar seus dados, por favor?'],
    ['q5','Agradecimento','Muito obrigado pela confiança! 🙏 Estamos à disposição!'],
    ['q6','Follow-up','Olá! Passando para verificar se ficou alguma dúvida. 😊'],
  ];
  for (const [id, label, text] of defaults) {
    await pool.query(
      'INSERT INTO quick_messages(id,label,text) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, label, text]
    );
  }
  console.log('✅ Mensagens rápidas padrão inseridas');
}

// ══════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

io.on('connection', socket => {
  console.log(`✅ CRM conectado: ${socket.id}`);
  socket.on('disconnect', () => console.log(`❌ CRM desconectado: ${socket.id}`));
});

// ══════════════════════════════════════════════
// MIDDLEWARES
// ══════════════════════════════════════════════
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
  if (req.path !== '/health')
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${req.method} ${req.path}`);
  next();
});

// ══════════════════════════════════════════════
// EVOLUTION API CLIENT
// ══════════════════════════════════════════════
const evo = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { 'apikey': EVOLUTION_KEY, 'Content-Type': 'application/json' },
  timeout: 20000
});

// ══════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/', async (req, res) => {
  const dbOk = pool ? await pool.query('SELECT 1').then(()=>true).catch(()=>false) : false;
  res.json({
    status:   '🟢 WA CRM Server v4',
    instance: INSTANCE,
    database: dbOk ? 'postgres ✅' : 'sem banco ⚠️',
    clients:  io.engine.clientsCount,
    ts:       new Date().toISOString()
  });
});

// ══════════════════════════════════════════════
// DB ROUTES — Conversas
// ══════════════════════════════════════════════
app.get('/db/conversas', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows: convs } = await pool.query(
      'SELECT * FROM conversations ORDER BY last_ts DESC, updated_at DESC'
    );
    const { rows: msgs } = await pool.query(
      'SELECT * FROM messages ORDER BY timestamp ASC'
    );
    const msgMap = {};
    msgs.forEach(m => {
      if (!msgMap[m.conv_id]) msgMap[m.conv_id] = [];
      msgMap[m.conv_id].push({
        id:       m.id,
        text:     m.text,
        from:     m.from_me ? 'out' : 'in',
        time:     m.msg_time,
        date:     m.msg_date,
        status:   m.status,
        mediaUrl: m.media_url,
        isBot:    m.is_bot,
        timestamp:m.timestamp
      });
    });
    res.json(convs.map(c => ({
      id:       c.id,
      phone:    c.phone,
      name:     c.name,
      company:  c.company,
      stage:    c.stage,
      color:    c.color,
      agentId:  c.agent_id,
      pinned:   c.pinned,
      unread:   c.unread,
      tags:     c.tags,
      notes:    c.notes,
      products: c.products,
      waId:     c.wa_id,
      lastTs:   c.last_ts,
      messages: msgMap[c.id] || []
    })));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/db/conversas', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    const c = req.body;
    await pool.query(`
      INSERT INTO conversations
        (id,phone,name,company,stage,color,agent_id,pinned,unread,tags,notes,products,wa_id,last_ts,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name, stage=EXCLUDED.stage, color=EXCLUDED.color,
        agent_id=EXCLUDED.agent_id, pinned=EXCLUDED.pinned, unread=EXCLUDED.unread,
        tags=EXCLUDED.tags, notes=EXCLUDED.notes, products=EXCLUDED.products,
        last_ts=EXCLUDED.last_ts, updated_at=NOW()
    `, [
      c.id, c.phone, c.name, c.company||'', c.stage||'lead', c.color||'#25d366',
      c.agentId||null, c.pinned||false, c.unread||0,
      JSON.stringify(c.tags||[]), JSON.stringify(c.notes||[]),
      JSON.stringify(c.products||[]), c.waId||null, c.lastTs||0
    ]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/db/conversas/:id', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    await pool.query('DELETE FROM conversations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════
// DB ROUTES — Mensagens
// ══════════════════════════════════════════════
app.post('/db/mensagens', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    const { convId, messages } = req.body;
    if (!messages?.length) return res.json({ ok: true });

    // Garante que conversa existe
    await pool.query(
      'INSERT INTO conversations(id,phone) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [convId, convId.replace('wa_','+')]
    );

    for (const m of messages) {
      await pool.query(`
        INSERT INTO messages(id,conv_id,text,from_me,msg_time,msg_date,status,media_url,media_type,is_bot,timestamp)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(id) DO UPDATE SET
          status=EXCLUDED.status, text=EXCLUDED.text
      `, [
        m.id, convId, m.text||'', m.from==='out',
        m.time||'', m.date||'', m.status||'sent',
        m.mediaUrl||null, m.mediaType||null,
        m.isBot||false, m.timestamp||0
      ]);
    }
    // Atualiza last_ts da conversa
    if (messages.length) {
      const lastTs = Math.max(...messages.map(m=>m.timestamp||0));
      if (lastTs > 0)
        await pool.query('UPDATE conversations SET last_ts=$1,updated_at=NOW() WHERE id=$2', [lastTs, convId]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════
// DB ROUTES — Quick Messages
// ══════════════════════════════════════════════
app.get('/db/quickmsgs', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT * FROM quick_messages ORDER BY created_at');
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/db/quickmsgs', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    const { id, label, text } = req.body;
    await pool.query(
      'INSERT INTO quick_messages(id,label,text) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET label=$2,text=$3',
      [id, label, text]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/db/quickmsgs/:id', async (req, res) => {
  if (!pool) return res.json({ ok: true });
  try {
    await pool.query('DELETE FROM quick_messages WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════
// PROXY — Evolution API
// ══════════════════════════════════════════════
app.post('/conversas', async (req, res) => {
  try { const r = await evo.post(`/chat/findChats/${INSTANCE}`, req.body||{}); res.json(r.data); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/mensagens', async (req, res) => {
  try { const r = await evo.post(`/chat/findMessages/${INSTANCE}`, req.body); res.json(r.data); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/enviar', async (req, res) => {
  try {
    const { numero, texto } = req.body;
    if (!numero||!texto) return res.status(400).json({ erro: 'numero e texto obrigatórios' });
    const r = await evo.post(`/message/sendText/${INSTANCE}`, {
      number: numero.replace(/\D/g,''), text: texto
    });
    // Salva no banco
    if (pool && r.data?.key) {
      const num  = numero.replace(/\D/g,'');
      const cid  = 'wa_'+num;
      const now  = new Date();
      const time = now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
      await pool.query(
        'INSERT INTO conversations(id,phone) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [cid, '+'+num]
      ).catch(()=>{});
      await pool.query(
        'INSERT INTO messages(id,conv_id,text,from_me,msg_time,msg_date,status,timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
        [r.data.key.id||('m'+Date.now()), cid, texto, true, time, 'Hoje', 'sent', Math.floor(Date.now()/1000)]
      ).catch(()=>{});
    }
    res.json({ sucesso: true, dados: r.data });
  } catch(e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.post('/enviar-midia', async (req, res) => {
  try {
    const { numero, media, mediatype, caption } = req.body;
    if (!numero||!media) return res.status(400).json({ erro: 'numero e media obrigatórios' });
    const r = await evo.post(`/message/sendMedia/${INSTANCE}`, {
      number: numero.replace(/\D/g,''), media, mediatype: mediatype||'image', caption: caption||''
    });
    res.json({ sucesso: true, dados: r.data });
  } catch(e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.get('/status', async (req, res) => {
  try { const r = await evo.get(`/instance/connectionState/${INSTANCE}`); res.json(r.data); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════
// WEBHOOK — mensagens em tempo real
// ══════════════════════════════════════════════
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
    || '';
}

async function salvarMensagem(payload) {
  if (!pool) return;
  try {
    const cid = 'wa_' + payload.numero;
    // Upsert conversa
    await pool.query(`
      INSERT INTO conversations(id,phone,name,wa_id,last_ts,updated_at)
      VALUES($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(id) DO UPDATE SET
        name=CASE WHEN conversations.name IS NULL OR conversations.name='' THEN EXCLUDED.name ELSE conversations.name END,
        wa_id=EXCLUDED.wa_id, last_ts=EXCLUDED.last_ts, updated_at=NOW()
    `, [cid, '+'+payload.numero, payload.nome||'+'+payload.numero, payload.waId, payload.timestamp]);

    // Insert mensagem
    await pool.query(`
      INSERT INTO messages(id,conv_id,text,from_me,msg_time,msg_date,status,timestamp)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING
    `, [payload.id, cid, payload.texto, payload.de==='out', payload.horario, 'Hoje', 'sent', payload.timestamp]);

    // Incrementa unread se recebida
    if (payload.de === 'in') {
      await pool.query('UPDATE conversations SET unread=unread+1 WHERE id=$1', [cid]);
    }
  } catch(e) {
    console.error('Erro salvarMensagem:', e.message);
  }
}

// Aceita /webhook e /webhook/nome-do-evento (Webhook por Eventos ativado)
app.post('/webhook', handleWebhook);
app.post('/webhook/:evento', handleWebhook);

function handleWebhook(req, res) {
  // Responde imediatamente
  res.json({ recebido: true });

  try {
    const ev   = req.body;
    const tipo = String(ev?.event || ev?.type || '').toLowerCase();

    console.log(`\n📨 Webhook: ${tipo}`);

    if (!tipo.includes('message')) return;

    const data = ev?.data;
    let lista  = [];
    if (Array.isArray(data?.messages)) lista = data.messages;
    else if (Array.isArray(data))       lista = data;
    else if (data?.key)                 lista = [data];
    else if (ev?.key)                   lista = [ev];

    lista.forEach(m => {
      try {
        // Evolution API v2: usa @lid internamente mas remoteJidAlt tem o número real
        const jidLid  = m.key?.remoteJid  || m.remoteJid  || '';
        const jidAlt  = m.key?.remoteJidAlt || m.remoteJidAlt || '';
        // jidReal = prefere @s.whatsapp.net, fallback para @lid
        const jidReal = jidAlt.endsWith('@s.whatsapp.net') ? jidAlt
                      : jidLid.endsWith('@s.whatsapp.net') ? jidLid
                      : jidAlt || jidLid;

        // Ignora grupos e status
        if (jidLid.endsWith('@g.us') || jidAlt.endsWith('@g.us')) return;
        if (jidLid.includes('status@broadcast')) return;
        // Só contatos pessoais: @s.whatsapp.net ou @lid
        const isPersonal = jidReal.endsWith('@s.whatsapp.net') || jidLid.endsWith('@lid');
        if (!isPersonal) return;

        const txt = extrairTexto(m.message || m);
        if (!txt) return;

        const numero = jidReal.replace('@s.whatsapp.net','').replace('@lid','');
        if (!numero || numero.length < 8) return;
        const ts     = m.messageTimestamp || Math.floor(Date.now()/1000);
        const d      = new Date(ts * 1000);

        const payload = {
          id:        m.key?.id || ('m'+Date.now()+Math.random()),
          numero,
          waId:      numero+'@s.whatsapp.net',
          texto:     txt,
          de:        m.key?.fromMe ? 'out' : 'in',
          nome:      m.pushName || m.verifiedName || m.notifyName || numero,
          horario:   d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
          timestamp: ts
        };

        const dir = payload.de === 'in' ? '⬇️ RECEBIDA' : '⬆️ ENVIADA';
        console.log(`${dir} | ${payload.nome} (${payload.numero}) | ${payload.texto.slice(0,60)}`);

        // Emite via Socket.IO para o CRM
        io.emit('nova_mensagem', payload);
        console.log(`📡 Emitido para ${io.engine.clientsCount} cliente(s)`);

        // Salva no banco de dados
        salvarMensagem(payload);

      } catch(e) { console.error('Erro processar msg:', e.message); }
    });

    // Status de conexão
    if (tipo.includes('connection')) {
      const estado = ev?.data?.state || ev?.data?.connection;
      console.log('🔌 Conexão:', estado);
      io.emit('status_conexao', { estado, conectado: estado === 'open' });
    }

  } catch(e) {
    console.error('Erro webhook:', e.message);
  }
}

// ══════════════════════════════════════════════
// CONFIGURAR WEBHOOK na Evolution API
// ══════════════════════════════════════════════
app.post('/configurar-webhook', async (req, res) => {
  try {
    const url = req.body?.url || `${MY_URL}/webhook`;
    const r = await evo.post(`/webhook/set/${INSTANCE}`, {
      webhook: {
        url,
        webhook_by_events: false,
        webhook_base64:    false,
        enabled: true,
        events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','SEND_MESSAGE']
      }
    });
    console.log('✅ Webhook configurado:', url);
    res.json({ sucesso: true, url, dados: r.data });
  } catch(e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
server.listen(PORT, async () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║      🟢 WA CRM SERVER v4.0           ║');
  console.log(`║      Porta: ${PORT}                      ║`);
  console.log('╚══════════════════════════════════════╝\n');
  console.log(`📡 Evolution API: ${EVOLUTION_URL}`);
  console.log(`📱 Instância:     ${INSTANCE}`);
  console.log(`🌐 Meu URL:       ${MY_URL || '(não configurado)'}`);
  console.log('');

  await initDB();

  // Auto-configura webhook após 5s
  setTimeout(async () => {
    if (!MY_URL) { console.log('⚠️  MY_URL não configurado — webhook manual necessário'); return; }
    try {
      await evo.post(`/webhook/set/${INSTANCE}`, {
        webhook: {
          url: `${MY_URL}/webhook`,
          webhook_by_events: false,
          webhook_base64:    false,
          enabled: true,
          events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','SEND_MESSAGE']
        }
      });
      console.log(`✅ Webhook auto-configurado: ${MY_URL}/webhook`);
    } catch(e) {
      console.log('⚠️  Auto-webhook falhou:', e.message);
    }
  }, 5000);
});

// ══════════════════════════════════════════════
// AGENTES — rotas de autenticação
// ══════════════════════════════════════════════
const crypto = require('crypto');

function hashSenha(senha) {
  return crypto.createHash('sha256').update(senha + 'fds_salt_2025').digest('hex');
}

async function initAgentes() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        role       TEXT DEFAULT 'atendente',
        color      TEXT DEFAULT '#25d366',
        password   TEXT NOT NULL,
        active     BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Cria admin padrão se não existir
    const { rows } = await pool.query("SELECT id FROM agents WHERE id='a1'");
    if (!rows.length) {
      await pool.query(
        "INSERT INTO agents(id,name,role,color,password) VALUES('a1','Admin','admin','#25d366',$1)",
        [hashSenha('@Familia@')]
      );
      console.log('✅ Admin criado — senha: @Familia@');
    }
  } catch(e) { console.error('Erro initAgentes:', e.message); }
}

// Login
app.post('/auth/login', async (req, res) => {
  const { agentId, senha } = req.body;
  if (!pool) return res.status(503).json({ ok: false, erro: 'Banco não disponível' });
  try {
    const { rows } = await pool.query(
      'SELECT id,name,role,color FROM agents WHERE id=$1 AND password=$2 AND active=true',
      [agentId, hashSenha(senha)]
    );
    if (!rows.length) return res.status(401).json({ ok: false, erro: 'Credenciais inválidas' });
    res.json({ ok: true, agent: rows[0] });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Lista agentes (só admin)
app.get('/auth/agentes', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT id,name,role,color,active,created_at FROM agents ORDER BY created_at'
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar agente (só admin)
app.post('/auth/agentes', async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  try {
    const { name, senha, role, color } = req.body;
    if (!name || !senha) return res.status(400).json({ ok: false, erro: 'Nome e senha obrigatórios' });
    const id = 'a' + Date.now();
    await pool.query(
      'INSERT INTO agents(id,name,role,color,password) VALUES($1,$2,$3,$4,$5)',
      [id, name.trim(), role||'atendente', color||'#3b82f6', hashSenha(senha)]
    );
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Atualizar agente (só admin)
app.put('/auth/agentes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  try {
    const { name, senha, color, active } = req.body;
    const { id } = req.params;
    if (senha) {
      await pool.query(
        'UPDATE agents SET name=$1,color=$2,active=$3,password=$4 WHERE id=$5',
        [name, color, active, hashSenha(senha), id]
      );
    } else {
      await pool.query(
        'UPDATE agents SET name=$1,color=$2,active=$3 WHERE id=$4',
        [name, color, active, id]
      );
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// Deletar agente (só admin, não pode deletar a si mesmo)
app.delete('/auth/agentes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false });
  if (req.params.id === 'a1') return res.status(403).json({ ok: false, erro: 'Não pode deletar o Admin' });
  try {
    await pool.query('DELETE FROM agents WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, erro: e.message }); }
});
