# Capital Marketing - Webhook 24/7 Autônomo WhatsApp + IA

Este servidor permite que o atendimento no WhatsApp, qualificação de leads por Inteligência Artificial (Gemini 3.8 Flash), agendamento de Reuniões/Gravações e movimentação no Kanban funcionem **24 horas por dia, 7 dias por semana, mesmo quando o seu computador estiver desligado ou em repouso**.

---

### Por que a Extensão do Chrome precisa do notebook ligado?
A extensão WaScript roda no navegador Google Chrome do seu computador. Quando você fecha a tampa do notebook ou desliga o aparelho, o Chrome hiberna e a conexão do WhatsApp é pausada.

---

### Como funciona o modo 24/7 em Nuvem (Sem Notebook)?

1. **Instância de WhatsApp em Nuvem (Gateway 24/7)**:
   - Você conecta o WhatsApp em uma instância na nuvem (Evolution API, Z-API ou WaScript Webhook Cloud).
   - Você lê o QR Code uma única vez no celular. A nuvem mantém a conexão online 24h.

2. **Webhook em Nuvem**:
   - Este servidor (`whatsapp-cloud-webhook.js`) fica hospedado na nuvem (ex: Render, Railway, Fly.io, Google Cloud Run ou VPS).
   - Quando qualquer cliente manda mensagem (mesmo às 03:00 da madrugada):
     - O Gateway envia a mensagem para a URL do Webhook: `https://seu-servidor.com/api/whatsapp-webhook`.
     - O Webhook consulta o Firestore. Se o lead não existir, **cria o lead automaticamente do zero**!
     - A IA analisa a demanda do cliente e qualifica o lead.
     - Se o cliente combinou uma data para **Gravação de Vídeos** ou **Reunião**, o sistema agenda automaticamente no Portal e gera a notificação no Google Calendar.
     - O Webhook envia a resposta de volta no WhatsApp usando a API (`/api/enviar-texto/{token}`).
     - Atualiza as etiquetas no WhatsApp Business.
     - Quando você acorda e abre o Portal (no notebook ou no celular), todos os novos leads e agendamentos já estão organizados no Kanban!

---

### Como fazer o deploy gratuito em 2 minutos (Exemplo no Render / Railway):
1. Crie uma conta gratuita em [render.com](https://render.com) ou [railway.app](https://railway.app).
2. Conecte este repositório e selecione a pasta `server`.
3. Variáveis de ambiente opcionais:
   - `WASCRIPT_TOKEN`: `1792635947267-ec34547a22788aba60e4935a35254255`
   - `PORT`: `3000`
4. Copie a URL pública gerada (ex: `https://capital-marketing-webhook.onrender.com/api/whatsapp-webhook`) e cole nas configurações de Webhook do seu WhatsApp!
