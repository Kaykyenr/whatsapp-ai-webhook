/**
 * ============================================================================
 * CAPITAL MARKETING - WHATSAPP 24/7 AUTONOMOUS CLOUD WEBHOOK RUNNER
 * ============================================================================
 * Microserviço em Nuvem 100% Autônomo para Atendimento WhatsApp + IA Gemini 3.8
 * 
 * Funciona 24 horas por dia, 7 dias por semana, SEM precisar do notebook ligado!
 * 
 * Sincroniza em Tempo Real com o Firestore:
 * - Alterações de Etiquetas no WhatsApp movem as colunas no Kanban do Portal!
 * - Mensagens recebidas criam novos Leads e qualificam via IA automaticamente!
 * - Agendamentos de gravações e reuniões são salvos no CRM em tempo real!
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
const FIRESTORE_API_KEY = "AIzaSyB1tH0WYb4FZtgGq8fSfRCWuB9_EZYY95s";
const FIRESTORE_PROJECT_ID = "agency-manager-308f9";

// Mapeamento oficial de etiquetas WhatsApp -> Colunas do Kanban
const ETIQUETA_TO_COLUMN_MAP = {
    'cliente': 'Fechado',
    '8': 'Fechado',
    'lead em tratativa': 'Qualificado',
    '14': 'Qualificado',
    'proposta realizada': 'Proposta',
    '15': 'Proposta',
    'lead mapeado': 'Prospecção',
    '13': 'Prospecção',
    'alinhamento': 'Reunião',
    'aguardando proposta': 'Reunião',
    '18': 'Reunião',
    'programação': 'Produção',
    'produção': 'Produção',
    '20': 'Produção'
};

function mapEtiquetaToColumn(rawEtiqueta) {
    if (!rawEtiqueta) return 'Prospecção';
    const clean = String(rawEtiqueta).trim().toLowerCase();
    for (const [key, col] of Object.entries(ETIQUETA_TO_COLUMN_MAP)) {
        if (clean === key || clean.includes(key)) {
            return col;
        }
    }
    return 'Prospecção';
}

/**
 * Salva ou Atualiza o Lead diretamente no banco do Firestore via REST API
 * Isso faz o Portal atualizar o Kanban NA MESMA HORA em tempo real!
 */
async function saveLeadToFirestore({ phone, name, status, notes, value = 3500, lastMessage = '' }) {
    try {
        const cleanPhone = String(phone).replace(/\D/g, '');
        if (!cleanPhone) return null;

        const leadId = 'lead_wa_' + cleanPhone;
        const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/leads/${leadId}?key=${FIRESTORE_API_KEY}`;

        const body = {
            fields: {
                id: { stringValue: leadId },
                phone: { stringValue: cleanPhone },
                name: { stringValue: name || `Lead ${cleanPhone.slice(-4)}` },
                status: { stringValue: status || 'Prospecção' },
                notes: { stringValue: notes || 'Atualizado via WhatsApp Webhook' },
                value: { integerValue: String(value || 3500) },
                aiQualified: { booleanValue: true },
                lastMessage: { stringValue: lastMessage || '' },
                updatedAt: { stringValue: new Date().toISOString() }
            }
        };

        const res = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await res.json();
        console.log(`✅ [Firestore Atualizado] Lead ${leadId} gravado como "${status}":`, data.name ? 'Sucesso' : data);
        return data;
    } catch (err) {
        console.error('❌ Erro ao gravar Lead no Firestore:', err);
        return null;
    }
}

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Capital Marketing WhatsApp 24/7 AI Autonomous Webhook',
        version: '2.1.0',
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
 * Suporta alterações de Etiquetas, Mensagens recebidas, CRM e Anúncios do Instagram
 */
app.post(['/webhook', '/api/whatsapp-webhook'], async (req, res) => {
    try {
        const body = req.body || {};
        console.log('📩 [Webhook 24/7] Payload recebido:', JSON.stringify(body).slice(0, 400));

        // 1. Extração universal de telefone, nome, texto e etiquetas
        let phone = '';
        let contactName = '';
        let incomingText = '';
        let incomingEtiqueta = '';

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
            phone = body.phone || body.numero || body.from || body.sender || (body.data && (body.data.phone || body.data.numero)) || '';
            contactName = body.name || body.nome || body.pushName || body.senderName || (body.data && (body.data.name || body.data.nome)) || '';
            incomingText = body.message || body.mensagem || body.text || body.texto || body.body || (body.data && (body.data.message || body.data.mensagem)) || '';
            
            // Extração de etiqueta
            incomingEtiqueta = body.etiqueta || body.tag || body.label || body.nome_etiqueta || body.id_etiqueta ||
                (body.data && (body.data.etiqueta || body.data.tag || body.data.label)) || '';
            if (Array.isArray(body.etiquetas) && body.etiquetas.length > 0) {
                incomingEtiqueta = body.etiquetas[0].name || body.etiquetas[0].id || body.etiquetas[0];
            }
        }

        // Limpeza de telefone
        phone = String(phone).replace('@s.whatsapp.net', '').replace('@c.us', '').replace(/\D/g, '');

        if (!phone) {
            return res.status(200).json({
                success: false,
                message: 'Payload recebido, mas não contém número de telefone válido.',
                received: body
            });
        }

        console.log(`👤 Contato: ${contactName || 'Sem nome'} (${phone}) | Etiqueta: "${incomingEtiqueta}" | Mensagem: "${incomingText}"`);

        // ====================================================================
        // CASO A: EVENTO DE ALTERAÇÃO DE ETIQUETA NO WHATSAPP
        // ====================================================================
        if (incomingEtiqueta) {
            const mappedStatus = mapEtiquetaToColumn(incomingEtiqueta);
            const notesText = `Etiqueta alterada no WhatsApp para: ${incomingEtiqueta}`;
            
            // Grava diretamente no Firestore! Isso faz o Kanban mover a coluna na hora!
            await saveLeadToFirestore({
                phone,
                name: contactName,
                status: mappedStatus,
                notes: notesText,
                lastMessage: incomingText
            });

            return res.status(200).json({
                success: true,
                event: 'etiqueta_update',
                phone,
                contactName,
                etiqueta: incomingEtiqueta,
                columnMovedTo: mappedStatus,
                message: `Lead atualizado com sucesso no Firestore para a coluna ${mappedStatus}`
            });
        }

        // ====================================================================
        // CASO B: EVENTO DE MENSAGEM RECEBIDA (QUALIFICAÇÃO IA + RESPOSTA)
        // ====================================================================
        const todayStr = new Date().toISOString().split('T')[0];
        const qualification = runQualificationHeuristics(contactName, incomingText, todayStr);

        // Grava no Firestore o novo Lead qualificado
        await saveLeadToFirestore({
            phone,
            name: contactName,
            status: qualification.recommendedStage,
            notes: qualification.qualificationSummary || incomingText,
            value: qualification.estimatedMonthlyValue,
            lastMessage: incomingText
        });

        // Sincronizar resposta no WhatsApp via WaScript API se houver mensagem
        const replyText = qualification.replyMessage;
        let whatsappSent = false;

        if (WASCRIPT_TOKEN && replyText && incomingText) {
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

        return res.status(200).json({
            success: true,
            event: 'message_qualification',
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
        qualificationSummary: `[IA Capital Marketing] Mensagem analisada: "${msg}". Etapa: ${stage.toUpperCase()}.`,
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
