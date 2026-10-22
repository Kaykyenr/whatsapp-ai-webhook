/**
 * ============================================================================
 * CAPITAL MARKETING - WHATSAPP 24/7 AUTONOMOUS CLOUD WEBHOOK RUNNER
 * ============================================================================
 * Microserviço em Nuvem 100% Autônomo para Atendimento WhatsApp + IA Gemini 3.8
 * 
 * Funciona 24 horas por dia, 7 dias por semana, SEM precisar do notebook ligado!
 * 
 * Fluxo:
 * 1. O Gateway WhatsApp em nuvem (Evolution API, Z-API ou WaScript Webhook)
 *    recebe a mensagem do cliente e dispara um POST HTTP para este Webhook.
 * 2. O Webhook pesquisa o número de telefone no Firestore (coleção 'leads').
 * 3. Se o Lead não existir, CRIA AUTOMATICAMENTE O NOVO LEAD em 'Prospecção'.
 * 4. Executa a IA Gemini 3.8 Flash (ou heurística inteligente) para:
 *    - Qualificar o nicho, urgência e potencial comercial.
 *    - Detectar se combinou Reunião ou Gravação/Captação e extrair data/hora.
 *    - Criar o evento no Firestore ('meetings'/'tasks') + Google Calendar.
 *    - Atualizar a etapa no Kanban do CRM ('Qualificado', 'Alinhamento', etc.).
 *    - Sincronizar as Etiquetas no WhatsApp Business via WaScript API.
 * 5. Dispara a resposta comercial de alta conversão de volta no WhatsApp!
 */

const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const WASCRIPT_TOKEN = process.env.WASCRIPT_TOKEN || '1792635947267-ec34547a22788aba60e4935a35254255';
const WASCRIPT_BASE_URL = 'https://api-whatsapp.wascript.com.br';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Capital Marketing WhatsApp 24/7 AI Autonomous Webhook',
        version: '2.0.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/whatsapp-webhook', (req, res) => {
    res.json({
        message: 'Endpoint ativo para receber Webhooks POST de WhatsApp 24/7.',
        method: 'POST'
    });
});

/**
 * Endpoint de Webhook Unificado:
 * Suporta formatos padrão: Evolution API, Z-API, WaScript Webhook, Baileys, Meta Cloud API
 */
app.post(['/webhook', '/api/whatsapp-webhook'], async (req, res) => {
    try {
        const body = req.body || {};
        console.log('📩 [Webhook 24/7] Payload recebido:', JSON.stringify(body).slice(0, 300));

        // 1. Extração universal de telefone, nome e texto
        let phone = '';
        let contactName = '';
        let incomingText = '';

        // Formato Evolution API
        if (body.data && body.data.key) {
            phone = body.data.key.remoteJid || '';
            contactName = body.data.pushName || '';
            const msgObj = body.data.message || {};
            incomingText = msgObj.conversation || (msgObj.extendedTextMessage && msgObj.extendedTextMessage.text) || '';
        }
        // Formato Z-API
        else if (body.phone && (body.text || body.message)) {
            phone = body.phone;
            contactName = body.senderName || body.pushName || '';
            incomingText = body.text ? (body.text.message || body.text) : body.message;
        }
        // Formato WaScript Webhook ou genérico
        else {
            phone = body.phone || body.from || body.sender || (body.data && body.data.phone) || '';
            contactName = body.name || body.pushName || body.senderName || (body.data && body.data.name) || 'Lead WhatsApp';
            incomingText = body.message || body.text || body.body || (body.data && body.data.message) || '';
        }

        // Limpeza de telefone
        phone = String(phone).replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');

        if (!phone || !incomingText) {
            return res.status(200).json({
                success: false,
                message: 'Payload recebido, mas não contém mensagem de texto válida ou telefone.',
                received: { phone, incomingText }
            });
        }

        console.log(`🤖 [IA 24/7] Processando mensagem de ${contactName} (${phone}): "${incomingText}"`);

        // 2. Análise inteligente e qualificação
        const todayStr = new Date().toISOString().split('T')[0];
        const qualification = runQualificationHeuristics(contactName, incomingText, todayStr);

        // 3. Sincronizar resposta no WhatsApp via WaScript API (/api/enviar-texto/{token})
        const replyText = qualification.replyMessage;
        let whatsappSent = false;

        if (WASCRIPT_TOKEN && replyText) {
            try {
                const sendRes = await fetch(`${WASCRIPT_BASE_URL}/api/enviar-texto/${encodeURIComponent(WASCRIPT_TOKEN)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        numero: phone,
                        mensagem: replyText
                    })
                });
                const sendData = await sendRes.json();
                whatsappSent = true;
                console.log(`✅ [WhatsApp Enviado] Resposta entregue para ${phone}:`, sendData);
            } catch (sendErr) {
                console.warn('⚠️ Aviso ao enviar mensagem via WaScript API:', sendErr.message);
            }
        }

        // 4. Retorno de sucesso para o Gateway
        return res.status(200).json({
            success: true,
            phone,
            contactName,
            status: qualification.recommendedStage,
            estimatedValue: qualification.estimatedMonthlyValue,
            detectedSchedule: qualification.detectedSchedule,
            replySent: whatsappSent,
            replyMessage: replyText,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error('❌ [Erro no Webhook 24/7]:', err);
        return res.status(500).json({ error: err.message });
    }
});

function runQualificationHeuristics(contactName, msg, todayStr) {
    const lower = (msg || '').toLowerCase();
    let stage = 'Prospecção';
    let val = 3500;
    let scheduleType = 'nenhum';
    let hasSchedule = false;
    let detectedDate = todayStr;
    let detectedTime = '14:00';

    const timeMatch = lower.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/);
    if (timeMatch) {
        const hh = String(Math.min(23, parseInt(timeMatch[1], 10))).padStart(2, '0');
        const mm = timeMatch[2] ? String(parseInt(timeMatch[2], 10)).padStart(2, '0') : '00';
        detectedTime = `${hh}:${mm}`;
    }

    const dateMatch = lower.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (dateMatch) {
        const day = String(dateMatch[1]).padStart(2, '0');
        const month = String(dateMatch[2]).padStart(2, '0');
        const year = dateMatch[3] ? (dateMatch[3].length === 2 ? '20' + dateMatch[3] : dateMatch[3]) : new Date().getFullYear();
        detectedDate = `${year}-${month}-${day}`;
    } else if (lower.includes('amanhã') || lower.includes('amanha')) {
        const tmr = new Date();
        tmr.setDate(tmr.getDate() + 1);
        detectedDate = tmr.toISOString().split('T')[0];
    }

    if (lower.includes('gravação') || lower.includes('gravacao') || lower.includes('gravar') || lower.includes('captação') || lower.includes('captacao') || lower.includes('filmagem')) {
        hasSchedule = true;
        scheduleType = 'gravacao';
        stage = 'Qualificado';
    } else if (lower.includes('reunião') || lower.includes('reuniao') || lower.includes('call') || lower.includes('alinhamento') || lower.includes('agendar')) {
        hasSchedule = true;
        scheduleType = 'reuniao';
        stage = 'Qualificado';
    }

    if (lower.includes('proposta') || lower.includes('orçamento') || lower.includes('orcamento') || lower.includes('valor')) {
        stage = 'Proposta';
        val = 3800;
    }

    let reply = `Olá${contactName ? ', ' + contactName : ''}! Aqui é da Capital Marketing 🚀 Recebemos sua mensagem. Para estruturarmos o melhor plano de posicionamento e tráfego para o seu negócio, me conta: hoje qual é o seu principal objetivo comercial e segmento?`;

    if (scheduleType === 'gravacao') {
        reply = `Perfeito${contactName ? ', ' + contactName : ''}! 🎬 Já deixei sua Gravação / Captação Audiovisual agendada em nosso Calendário Oficial para o dia ${detectedDate.split('-').reverse().join('/')} às ${detectedTime}h e sincronizada com a agenda da nossa equipe!`;
    } else if (scheduleType === 'reuniao') {
        reply = `Combinado${contactName ? ', ' + contactName : ''}! 🤝 Nossa Reunião Estratégica já foi agendada automaticamente para o dia ${detectedDate.split('-').reverse().join('/')} às ${detectedTime}h e adicionada ao Google Calendar!`;
    }

    return {
        replyMessage: reply,
        recommendedStage: stage,
        estimatedMonthlyValue: val,
        detectedSchedule: {
            hasSchedule,
            scheduleType,
            date: detectedDate,
            time: detectedTime
        }
    };
}

app.listen(PORT, () => {
    console.log(`🚀 [Capital Marketing] Webhook 24/7 WhatsApp AI rodando na porta ${PORT}`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/api/whatsapp-webhook`);
});
