# 🟢 WA CRM — Servidor Backend

Servidor Node.js para integrar o **WhatsApp CRM** com a **Evolution API**.

---

## 📋 PASSO A PASSO COMPLETO

### ETAPA 1 — Instalar a Evolution API (gratuita)

A Evolution API é o "motor" que conecta ao WhatsApp.
A forma mais fácil é usar o serviço deles na nuvem:

1. Acesse: https://github.com/EvolutionAPI/evolution-api
2. Ou use o serviço hospedado em: https://evolution-api.com

> 💡 **Dica para iniciantes:** Use o Evolution API Cloud (versão hospedada)
> que não precisa instalar nada. Tem plano gratuito para testar.

Após criar sua conta na Evolution API, você terá:
- **URL da API** → exemplo: `https://api.evolution-api.com`
- **Chave de API (apikey)** → uma chave secreta

Anote essas informações, você vai precisar no próximo passo.

---

### ETAPA 2 — Subir este servidor no Railway

1. **Crie uma conta** em https://railway.app (pode entrar com GitHub)

2. **Crie um repositório no GitHub** com os arquivos desta pasta:
   - Vá em github.com → New Repository → Nome: `wacrm-server`
   - Faça upload de todos os arquivos desta pasta

3. **No Railway**, clique em:
   - `New Project` → `Deploy from GitHub repo`
   - Selecione o repositório `wacrm-server`
   - Railway vai detectar automaticamente que é Node.js

4. **Adicione as variáveis de ambiente** no Railway:
   - Vá em seu projeto → aba `Variables`
   - Adicione cada variável do arquivo `.env.example`:

   | Variável | Valor |
   |----------|-------|
   | `EVOLUTION_URL` | URL da sua Evolution API |
   | `EVOLUTION_KEY` | Sua chave de API |
   | `INSTANCE_NAME` | meu-whatsapp (ou qualquer nome) |

5. **Deploy!** Railway vai iniciar o servidor automaticamente.

6. **Copie a URL** do seu servidor Railway:
   - Vai ser algo como: `https://wacrm-server-production.up.railway.app`

---

### ETAPA 3 — Configurar e conectar o WhatsApp

Com o servidor rodando no Railway, faça estas chamadas **uma única vez**:

**1. Criar a instância do WhatsApp:**
```
POST https://SUA-URL.railway.app/instancia/criar
```

**2. Configurar o Webhook** (para receber mensagens em tempo real):
```
POST https://SUA-URL.railway.app/instancia/configurar-webhook
Body: { "url": "https://SUA-URL.railway.app/webhook" }
```

**3. Buscar o QR Code para escanear:**
```
GET https://SUA-URL.railway.app/instancia/qrcode
```
Abra o WhatsApp no celular → Dispositivos conectados → Escanear QR Code

**4. Verificar se conectou:**
```
GET https://SUA-URL.railway.app/instancia/status
```
Se `conectado: true` → tudo certo! 🎉

---

### ETAPA 4 — Conectar o CRM ao servidor

No arquivo `whatsapp-crm.html`, adicione no início do `<script>`:

```javascript
// Substitua pela URL do seu servidor Railway
const SERVER_URL = 'https://SUA-URL.railway.app';

// Conecta Socket.IO para mensagens em tempo real
const socket = io(SERVER_URL);

socket.on('nova_mensagem', (msg) => {
  // Adiciona a mensagem na conversa correta
  receberMensagem(msg);
});

socket.on('status_conexao', (data) => {
  console.log('WhatsApp status:', data.estado);
});
```

---

## 🚀 Rotas disponíveis

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/` | Health check — servidor funcionando? |
| GET | `/instancia/status` | Status da conexão WhatsApp |
| GET | `/instancia/qrcode` | Buscar QR Code para conectar |
| POST | `/instancia/criar` | Criar instância do WhatsApp |
| POST | `/instancia/configurar-webhook` | Configurar webhook |
| POST | `/mensagem/enviar` | Enviar mensagem de texto |
| GET | `/conversas` | Listar conversas |
| GET | `/mensagens/:numero` | Histórico de mensagens |
| POST | `/webhook` | Recebe eventos da Evolution API |

---

## 📨 Enviar mensagem (exemplo)

```json
POST /mensagem/enviar
{
  "numero": "5511999990000",
  "texto": "Olá! Tudo bem? 😊"
}
```

---

## ❓ Dúvidas comuns

**O Railway é gratuito?**
Sim, tem plano gratuito com $5 de crédito por mês — suficiente para rodar.

**Precisa de cartão de crédito?**
Não para começar. Pode entrar só com GitHub.

**E a Evolution API, é gratuita?**
Sim, é open source. Você pode instalar em qualquer servidor ou usar a versão cloud deles.

---

## 🆘 Suporte

Se travar em algum passo, volte ao Claude com a mensagem de erro
e ele te ajuda a resolver! 😊
