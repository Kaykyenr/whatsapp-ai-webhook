/**
 * ============================================================================
 * CAPITAL MARKETING - WHATSAPP + WASCRIPT + GEMINI AI CLOUD WEBHOOK (v3.0 REAL)
 * ============================================================================
 * Integração 100% Real entre:
 * - Extensão WaScript no WhatsApp Web (WebHooks de Mensagens, Etiqueta, CRM, etc.)
 * - API Oficial WaScript (https://api-whatsapp.wascript.com.br)
 * - Inteligência Artificial Google Gemini (gemini-2.5-flash / gemini-2.0-flash)
 * - Banco de Dados Firestore em Tempo Real (leads, whatsapp_messages, reunioes, tasks)
 */

const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const DEFAULT_WASCRIPT_TOKEN = process.env.WASCRIPT_TOKEN || '1792635947267-ec34547a22788aba60e4935a35254255';
const WASCRIPT_BASE_URL = 'https://api-whatsapp.wascript.com.br';
const FIRESTORE_API_KEY = process.env.FIRESTORE_API_KEY || 'AIzaSyB1tH0WYb4FZtgGq8fSfRCWuB9_EZYY95s';
const FIRESTORE_PROJECT_ID = process.env.FIRESTORE_PROJECT_ID || 'agency-manager-308f9';
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents`;
const ENV_GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

let recentWebhookEvents = [];

// Mapeamento oficial de etiquetas WhatsApp (por ID ou Nome) -> Colunas do Kanban
const ETIQUETA_TO_COLUMN_MAP = {
    '8': 'Fechado',
    'cliente': 'Fechado',
    'fechado': 'Fechado',
    '20': 'Fechado',
    'produção': 'Fechado',
    'producao': 'Fechado',
    '19': 'Fechado',
    'programação': 'Fechado',
    'programacao': 'Fechado',
    '14': 'Qualificado',
    'lead em tratativa': 'Qualificado',
    'tratativa': 'Qualificado',
    'qualificado': 'Qualificado',
    '16': 'Qualificado',
    'aguardando proposta': 'Qualificado',
    '18': 'Qualificado',
    'alinhamento': 'Qualificado',
    'reunião': 'Qualificado',
    'reuniao': 'Qualificado',
    '15': 'Proposta Enviada',
    'proposta realizada': 'Proposta Enviada',
    'proposta': 'Proposta Enviada',
    '17': 'Proposta Enviada',
    'aguardando retorno': 'Proposta Enviada',
    '13': 'Prospecção',
    'lead mapeado': 'Prospecção',
    'prospecção': 'Prospecção',
    'prospeccao': 'Prospecção',
    'novo': 'Prospecção'
};

function mapEtiquetaToColumn(rawEtiqueta, customMapping = null) {
    if (!rawEtiqueta) return null;
    const clean = String(rawEtiqueta).trim().toLowerCase();
    if (!clean) return null;

    if (customMapping && typeof customMapping === 'object') {
        if (String(customMapping.fechado) === clean) return 'Fechado';
        if (String(customMapping.proposta) === clean) return 'Proposta Enviada';
        if (String(customMapping.qualificado) === clean || String(customMapping.reuniao) === clean) return 'Qualificado';
        if (String(customMapping.novo) === clean) return 'Prospecção';
    }

    if (ETIQUETA_TO_COLUMN_MAP[clean]) {
        return ETIQUETA_TO_COLUMN_MAP[clean];
    }
    for (const [key, col] of Object.entries(ETIQUETA_TO_COLUMN_MAP)) {
        if (key.length > 2 && clean.includes(key)) {
            return col;
        }
    }
    return null;
}

function normalizePhone(raw) {
    if (!raw) return '';
    const rawStr = String(raw);
    // Ignora IDs de grupos (@g.us) e status de transmissão
    if (rawStr.includes('@g.us') || rawStr.includes('@broadcast') || rawStr.includes('status@broadcast')) {
        return '';
    }

    let s = rawStr
        .replace(/@s\.whatsapp\.net/gi, '')
        .replace(/@c\.us/gi, '')
        .replace(/@lid/gi, '');
    let digits = s.replace(/\D/g, '');
    // Se tiver mais de 14 dígitos (típico de IDs de grupos sem @g.us), ignora
    if (!digits || digits.length < 8 || digits.length > 14) return '';
    if (digits.length === 10 || digits.length === 11) {
        digits = '55' + digits;
    }
    return digits;
}

/**
 * Extrator Universal e Case-Insensitive para qualquer formato de Webhook do WaScript
 * Lê: Numero, Nome, Dados do Evento, Etiqueta, Mensagens, CRM, Perfil do Contato, etc.
 */
function extractWhatsAppDataFromPayload(rawBody) {
    let body = rawBody;
    if (Array.isArray(body) && body.length > 0) {
        body = body[0];
    }
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) { body = { text: body }; }
    }
    if (!body || typeof body !== 'object') {
        return { phone: '', contactName: '', incomingText: '', incomingEtiqueta: '', isFromMe: false, isGroup: false, isBroadcast: false, eventType: 'unknown' };
    }

    // Identificar grupos do WhatsApp ou listas de transmissão
    const rawNumberStr = String(
        body.number || body.phone || body.Numero || body.id ||
        (body.eventDetails && body.eventDetails.id && body.eventDetails.id.remote && body.eventDetails.id.remote._serialized) ||
        (body.dadosEvento && body.dadosEvento.id && body.dadosEvento.id.remote && body.dadosEvento.id.remote._serialized) ||
        (body.data && body.data.key && body.data.key.remoteJid) || ''
    );

    const isGroup = Boolean(
        rawNumberStr.includes('@g.us') ||
        (body.eventDetails && body.eventDetails.id && body.eventDetails.id.remote && body.eventDetails.id.remote.server === 'g.us') ||
        (body.dadosEvento && body.dadosEvento.id && body.dadosEvento.id.remote && body.dadosEvento.id.remote.server === 'g.us')
    );

    const isBroadcast = Boolean(
        rawNumberStr.includes('@broadcast') || rawNumberStr.includes('status@broadcast') ||
        (body.dadosEvento && body.dadosEvento.key && body.dadosEvento.key.remoteJid && body.dadosEvento.key.remoteJid.includes('@broadcast'))
    );

    // Função auxiliar para buscar chaves ignorando maiúsculas/minúsculas e acentos
    function findKeyCI(obj, targetKeys) {
        if (!obj || typeof obj !== 'object') return undefined;
        const normTargets = targetKeys.map(k => k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''));
        for (const [k, v] of Object.entries(obj)) {
            const nk = k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
            if (normTargets.includes(nk) && v !== undefined && v !== null && v !== '') {
                return v;
            }
        }
        return undefined;
    }

    const dadosEvento = findKeyCI(body, ['Dados do Evento', 'dados_do_evento', 'dadosEvento', 'eventData', 'eventDetails', 'dados', 'data', 'evento_dados']) || {};
    const perfilContato = findKeyCI(body, ['Perfil do Contato', 'perfil_do_contato', 'perfilContato', 'contact', 'contato', 'chat', 'sender']) || {};
    const crmObj = findKeyCI(body, ['CRM', 'crm']) || {};

    // 1. Extrair Telefone (ignora grupos)
    let phone = '';
    if (!isGroup) {
        let phoneCandidates = [
            findKeyCI(body, ['Numero', 'numero', 'phone', 'number', 'telefone', 'celular', 'whatsapp', 'userID', 'chatId', 'remoteJid', 'jid', 'wid', 'from', 'remetente', 'id_contato']),
            findKeyCI(dadosEvento, ['Numero', 'numero', 'phone', 'number', 'userID', 'chatId', 'remoteJid', 'jid', 'wid', 'from', 'remetente', 'author', 'to', 'id']),
            findKeyCI(perfilContato, ['Numero', 'numero', 'phone', 'number', 'userID', 'id', 'wid', 'jid']),
            findKeyCI(crmObj, ['Numero', 'numero', 'phone', 'userID', 'id']),
            body.data && body.data.key && body.data.key.remoteJid,
            dadosEvento.key && dadosEvento.key.remoteJid
        ];

        for (const cand of phoneCandidates) {
            if (!cand) continue;
            if (typeof cand === 'object') {
                const sub = cand._serialized || cand.user || cand.id || cand.number || cand.phone || '';
                const norm = normalizePhone(sub);
                if (norm) { phone = norm; break; }
            } else {
                const norm = normalizePhone(cand);
                if (norm) { phone = norm; break; }
            }
        }

        if (!phone) {
            const jsonStr = JSON.stringify(body);
            const jidMatch = jsonStr.match(/(\d{10,14})@(?:c\.us|s\.whatsapp\.net)/i);
            if (jidMatch) {
                phone = normalizePhone(jidMatch[1]);
            } else {
                const numFieldMatch = jsonStr.match(/"(?:numero|phone|number|telefone|userID|remetente|celular)"\s*:\s*"(\+?[\d\s()-]{10,18})"/i);
                if (numFieldMatch) {
                    phone = normalizePhone(numFieldMatch[1]);
                }
            }
        }
    }

    // 2. Extrair Nome do Contato
    let nameCandidates = [
        findKeyCI(body, ['Nome', 'nome', 'name', 'pushName', 'senderName', 'contactName', 'nome_contato', 'formattedName']),
        findKeyCI(perfilContato, ['Nome', 'nome', 'name', 'pushName', 'formattedName', 'verifiedName', 'shortName']),
        findKeyCI(dadosEvento, ['Nome', 'nome', 'name', 'pushName', 'senderName', 'contactName', 'notifyName']),
        findKeyCI(crmObj, ['Nome', 'nome', 'name', 'title'])
    ];
    let contactName = '';
    for (const cand of nameCandidates) {
        if (cand && typeof cand === 'string' && cand.trim() && !/^\d+$/.test(cand.trim())) {
            contactName = cand.trim();
            break;
        }
    }

    // 3. Extrair Etiqueta(s)
    let rawEtiqueta = findKeyCI(body, ['Etiqueta', 'etiqueta', 'etiquetas', 'labels', 'label', 'tags', 'tag', 'nome_etiqueta', 'id_etiqueta'])
        || findKeyCI(dadosEvento, ['Etiqueta', 'etiqueta', 'etiquetas', 'labels', 'label', 'tags', 'tag', 'labelId', 'labelName'])
        || findKeyCI(perfilContato, ['Etiqueta', 'etiqueta', 'etiquetas', 'labels'])
        || findKeyCI(crmObj, ['Etiqueta', 'etiqueta', 'coluna', 'stage', 'status', 'fase']);

    let incomingEtiqueta = '';
    let allEtiquetas = [];
    function extractLabelsFromVal(val) {
        if (!val) return;
        if (typeof val === 'string' || typeof val === 'number') {
            const s = String(val).trim();
            if (s) allEtiquetas.push(s);
        } else if (Array.isArray(val)) {
            val.forEach(extractLabelsFromVal);
        } else if (typeof val === 'object') {
            const lbl = val.name || val.nome || val.label || val.title || val.id || val.labelId;
            if (lbl) allEtiquetas.push(String(lbl).trim());
        }
    }
    extractLabelsFromVal(rawEtiqueta);
    for (const et of allEtiquetas) {
        if (mapEtiquetaToColumn(et)) {
            incomingEtiqueta = et;
            break;
        }
    }
    if (!incomingEtiqueta && allEtiquetas.length > 0) {
        incomingEtiqueta = allEtiquetas[0];
    }

    // 4. Extrair Mensagem de Texto e direção (fromMe)
    let isFromMe = Boolean(
        findKeyCI(body, ['fromMe', 'isFromMe', 'enviadaPorMim', 'own']) ||
        findKeyCI(dadosEvento, ['fromMe', 'isFromMe', 'enviadaPorMim', 'own']) ||
        (dadosEvento.key && dadosEvento.key.fromMe) ||
        (body.data && body.data.key && body.data.key.fromMe) ||
        (dadosEvento.id && dadosEvento.id.fromMe)
    );

    let rawMsg = findKeyCI(body, ['lastMessage', 'last_message', 'Mensagens', 'mensagens', 'Mensagem', 'mensagem', 'message', 'text', 'texto', 'body', 'conteudo', 'content'])
        || findKeyCI(dadosEvento, ['lastMessage', 'last_message', 'Mensagens', 'mensagens', 'Mensagem', 'mensagem', 'message', 'text', 'texto', 'body', 'conteudo', 'content', 'conversation'])
        || (dadosEvento && dadosEvento.body);

    let incomingText = '';
    function extractTextFromVal(val) {
        if (!val) return '';
        if (typeof val === 'string') return val.trim();
        if (Array.isArray(val) && val.length > 0) {
            const last = val[val.length - 1];
            if (last && typeof last === 'object' && (last.fromMe === true || last.isFromMe === true)) {
                isFromMe = true;
            }
            return extractTextFromVal(last);
        }
        if (typeof val === 'object') {
            if (val.fromMe === true || val.isFromMe === true) isFromMe = true;
            return extractTextFromVal(
                val.text || val.texto || val.caption || val.subtitle || val.body || val.message || val.mensagem || val.conteudo || val.content ||
                val.conversation || (val.extendedTextMessage && val.extendedTextMessage.text) || ''
            );
        }
        return '';
    }
    incomingText = extractTextFromVal(rawMsg);

    const eventType = String(
        findKeyCI(body, ['eventID', 'evento', 'event', 'tipo', 'type', 'acao', 'action']) ||
        findKeyCI(dadosEvento, ['eventID', 'evento', 'event', 'tipo', 'type', 'acao', 'action']) ||
        (incomingEtiqueta && !incomingText ? 'etiqueta' : 'mensagem')
    );

    return {
        phone,
        contactName,
        incomingText,
        incomingEtiqueta,
        allEtiquetas,
        isFromMe,
        isGroup,
        isBroadcast,
        eventType
    };
}

/**
 * Busca as configurações salvas no Firestore (settings/wascript_ai_config)
 */
async function getPortalWascriptConfig() {
    try {
        const res = await fetch(`${FIRESTORE_BASE_URL}/settings/wascript_ai_config?key=${FIRESTORE_API_KEY}`);
        if (!res.ok) return {};
        const doc = await res.json();
        const f = doc.fields || {};
        const getStr = (k, def = '') => (f[k] && f[k].stringValue !== undefined) ? f[k].stringValue : def;
        const getBool = (k, def = true) => (f[k] && f[k].booleanValue !== undefined) ? f[k].booleanValue : def;

        let labelMapping = {};
        if (f.labelMapping && f.labelMapping.mapValue && f.labelMapping.mapValue.fields) {
            for (const [mk, mv] of Object.entries(f.labelMapping.mapValue.fields)) {
                labelMapping[mk] = mv.stringValue || '';
            }
        }

        return {
            token: getStr('token', DEFAULT_WASCRIPT_TOKEN) || DEFAULT_WASCRIPT_TOKEN,
            geminiApiKey: getStr('geminiApiKey', ENV_GEMINI_API_KEY) || ENV_GEMINI_API_KEY,
            systemPrompt: getStr('systemPrompt', ''),
            autoReplyEnabled: getBool('autoReplyEnabled', true),
            autoTagSyncEnabled: getBool('autoTagSyncEnabled', true),
            autoNoteSyncEnabled: getBool('autoNoteSyncEnabled', true),
            autoScheduleEnabled: getBool('autoScheduleEnabled', true),
            ignoreGroups: getBool('ignoreGroups', true),
            ignoreExistingClients: getBool('ignoreExistingClients', true),
            filterNonCommercialWithAi: getBool('filterNonCommercialWithAi', true),
            replyMode: getStr('replyMode', 'all_leads'), // 'all_leads' | 'tagged_only' | 'kanban_only'
            blacklist: getStr('blacklist', ''), // números ou nomes bloqueados separados por vírgula
            responseDelaySeconds: parseInt(getStr('responseDelaySeconds', '10'), 10) || 10,
            splitMessages: getBool('splitMessages', true),
            consultativeMode: getBool('consultativeMode', true),
            labelMapping
        };
    } catch (e) {
        return {
            token: DEFAULT_WASCRIPT_TOKEN,
            geminiApiKey: ENV_GEMINI_API_KEY,
            autoReplyEnabled: true,
            autoTagSyncEnabled: true,
            autoNoteSyncEnabled: true,
            autoScheduleEnabled: true,
            ignoreGroups: true,
            ignoreExistingClients: true,
            filterNonCommercialWithAi: true,
            replyMode: 'all_leads',
            blacklist: '',
            responseDelaySeconds: 10,
            splitMessages: true,
            consultativeMode: true,
            labelMapping: {}
        };
    }
}

/**
 * Verifica se o telefone ou nome está na Lista Negra (Blacklist) configurada
 */
function isContactBlacklisted(phone, name, blacklistStr) {
    if (!blacklistStr) return false;
    const tokens = blacklistStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const cleanP = normalizePhone(phone);
    const cleanN = (name || '').toLowerCase();
    for (const t of tokens) {
        const cleanT = t.replace(/\D/g, '');
        if (cleanT && cleanP && cleanP.includes(cleanT)) return true;
        if (cleanN && cleanN.includes(t)) return true;
    }
    return false;
}

/**
 * Verifica se o contato já é um Cliente Oficial Ativo da agência
 */
async function isExistingAgencyClient(cleanPhone, contactName, incomingEtiqueta) {
    if (incomingEtiqueta && (String(incomingEtiqueta) === '8' || String(incomingEtiqueta).toLowerCase().includes('cliente'))) {
        return true;
    }
    try {
        const res = await fetch(`${FIRESTORE_BASE_URL}/clients?key=${FIRESTORE_API_KEY}&pageSize=100`);
        if (!res.ok) return false;
        const data = await res.json();
        const docs = data.documents || [];
        for (const doc of docs) {
            const f = doc.fields || {};
            const cPhone = normalizePhone(f.phone && f.phone.stringValue);
            const cName = (f.name && f.name.stringValue || '').trim().toLowerCase();
            if (cleanPhone && cPhone && cleanPhone === cPhone) return true;
            if (contactName && cName && contactName.toLowerCase().includes(cName)) return true;
        }
    } catch (_) {}
    return false;
}

/**
 * Busca um lead existente no Firestore pelo telefone ou nome para atualizar sem duplicar
 */
async function findExistingLeadInFirestore(cleanPhone, contactName) {
    try {
        const res = await fetch(`${FIRESTORE_BASE_URL}/leads?key=${FIRESTORE_API_KEY}&pageSize=200`);
        if (!res.ok) return null;
        const data = await res.json();
        const docs = data.documents || [];
        for (const doc of docs) {
            const f = doc.fields || {};
            const docId = doc.name.split('/').pop();
            const lPhone = normalizePhone(f.phone && f.phone.stringValue);
            const lName = (f.name && f.name.stringValue || '').trim().toLowerCase();
            if (cleanPhone && lPhone && lPhone === cleanPhone) {
                return {
                    id: docId,
                    name: f.name && f.name.stringValue,
                    status: f.status && f.status.stringValue,
                    value: (f.value && (f.value.integerValue || f.value.doubleValue || f.value.stringValue)) || 3500,
                    notes: f.notes && f.notes.stringValue
                };
            }
            if (contactName && lName && lName === contactName.trim().toLowerCase()) {
                return {
                    id: docId,
                    name: f.name && f.name.stringValue,
                    status: f.status && f.status.stringValue,
                    value: (f.value && (f.value.integerValue || f.value.doubleValue || f.value.stringValue)) || 3500,
                    notes: f.notes && f.notes.stringValue
                };
            }
        }
    } catch (e) {
        console.warn('Erro ao buscar leads existentes:', e.message);
    }
    return null;
}

/**
 * Grava ou atualiza o Lead no Firestore
 */
async function saveLeadToFirestore({ phone, name, status, notes, value = 3500, lastMessage = '', etiqueta = '' }) {
    try {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone && !name) return null;

        const existing = await findExistingLeadInFirestore(cleanPhone, name);
        const leadId = existing ? existing.id : ('lead_wa_' + (cleanPhone || Date.now()));
        const finalName = name || (existing && existing.name) || `Contato WhatsApp (${cleanPhone.slice(-4)})`;
        const finalStatus = status || (existing && existing.status) || 'Prospecção';
        const finalValue = Math.round(Number(value || (existing && existing.value) || 3500));
        const finalNotes = notes || (existing && existing.notes) || 'Sincronizado via WhatsApp';

        const url = `${FIRESTORE_BASE_URL}/leads/${encodeURIComponent(leadId)}?key=${FIRESTORE_API_KEY}`;
        const body = {
            fields: {
                id: { stringValue: leadId },
                phone: { stringValue: cleanPhone || '' },
                name: { stringValue: finalName },
                status: { stringValue: finalStatus },
                notes: { stringValue: finalNotes },
                value: { integerValue: String(finalValue) },
                aiQualified: { booleanValue: true },
                lastMessage: { stringValue: lastMessage || '' },
                whatsappLabel: { stringValue: String(etiqueta || '') },
                updatedAt: { stringValue: new Date().toISOString() }
            }
        };

        const res = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        console.log(`✅ [Firestore Lead] ${leadId} (${finalName}) -> Coluna: "${finalStatus}"`);
        return { leadId, finalName, finalStatus, finalValue, data };
    } catch (err) {
        console.error('❌ Erro ao gravar Lead no Firestore:', err.message);
        return null;
    }
}

/**
 * Busca o histórico recente da conversa daquele telefone no Firestore para enviar ao Gemini
 */
async function getRecentConversationHistory(cleanPhone) {
    try {
        const res = await fetch(`${FIRESTORE_BASE_URL}/whatsapp_messages?key=${FIRESTORE_API_KEY}&pageSize=100`);
        if (!res.ok) return [];
        const data = await res.json();
        const docs = data.documents || [];
        const list = [];
        for (const d of docs) {
            const f = d.fields || {};
            if ((f.phone && f.phone.stringValue) === cleanPhone) {
                list.push({
                    role: (f.role && f.role.stringValue) || 'cliente',
                    text: (f.text && f.text.stringValue) || '',
                    createdAt: (f.createdAt && f.createdAt.stringValue) || ''
                });
            }
        }
        list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return list.slice(-15);
    } catch (_) {
        return [];
    }
}

/**
 * Salva mensagem recebida/enviada na coleção whatsapp_messages do Firestore
 * Com deduplicação inteligente e prevenção de eco (não salva como IA o texto que o cliente acabou de mandar)
 */
async function saveChatMessageToFirestore({ phone, contactName, role, text, stage = '' }) {
    try {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone || !text || !text.trim()) return;

        const cleanText = text.trim();

        // 1. Evitar salvar mensagem repetida ou eco do WaScript
        const recent = await getRecentConversationHistory(cleanPhone);
        if (recent.length > 0) {
            const last = recent[recent.length - 1];
            // Se o papel é 'ia', mas o texto é idêntico ao que o cliente acabou de falar, é eco falso!
            if (role === 'ia' && last.role === 'cliente' && last.text.trim() === cleanText) {
                console.log(`ℹ️ [Eco descartado]: não salva como IA texto do cliente ("${cleanText.slice(0, 30)}...")`);
                return;
            }
            // Se a última mensagem tem exatamente o mesmo texto e mesmo papel, ignora duplicata
            if (last.text.trim() === cleanText && last.role === role) {
                console.log(`ℹ️ [Duplicata descartada]: "${cleanText.slice(0, 30)}..."`);
                return;
            }
            // Mais ainda: se role === 'ia' e qualquer mensagem recente do cliente nos últimos minutos tiver o mesmo texto
            const matchedClientMsg = recent.slice(-5).find(m => m.role === 'cliente' && m.text.trim() === cleanText);
            if (role === 'ia' && matchedClientMsg) {
                console.log(`ℹ️ [Eco descartado nos últimos 5]: não salva como IA texto do cliente ("${cleanText.slice(0, 30)}...")`);
                return;
            }
        }

        const msgId = `msg_${cleanPhone}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const url = `${FIRESTORE_BASE_URL}/whatsapp_messages/${encodeURIComponent(msgId)}?key=${FIRESTORE_API_KEY}`;
        const nowIso = new Date().toISOString();

        const body = {
            fields: {
                id: { stringValue: msgId },
                phone: { stringValue: cleanPhone },
                contactName: { stringValue: contactName || `Lead ${cleanPhone.slice(-4)}` },
                role: { stringValue: role }, // 'cliente' | 'ia' | 'sistema'
                text: { stringValue: cleanText },
                stage: { stringValue: stage || '' },
                timestamp: { stringValue: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) },
                createdAt: { stringValue: nowIso }
            }
        };

        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (err) {
        console.warn('Aviso ao gravar mensagem no Firestore:', err.message);
    }
}

/**
 * Prepara e divide as mensagens para despacho humanizado no WhatsApp:
 * - Se a IA retornou replyMessages (array), usa diretamente
 * - Se retornou texto único, divide em 2 a 3 frases naturais
 */
function prepareMessagesToDispatch(qualification, cfg) {
    let msgs = [];
    if (Array.isArray(qualification.replyMessages) && qualification.replyMessages.length > 0) {
        msgs = qualification.replyMessages.map(m => String(m).trim()).filter(Boolean);
    } else if (qualification.replyMessage) {
        const full = String(qualification.replyMessage).trim();
        if (cfg.splitMessages !== false) {
            if (full.includes('\n\n')) {
                msgs = full.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
            } else if (full.length > 100 && full.includes('?')) {
                const parts = full.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú])/);
                if (parts.length >= 2) {
                    msgs = [parts[0], parts.slice(1).join(' ')];
                } else {
                    msgs = [full];
                }
            } else {
                msgs = [full];
            }
        } else {
            msgs = [full];
        }
    }
    return msgs.slice(0, 3);
}

/**
 * Cria Nota Interna no chat do WhatsApp via API oficial WaScript
 */
async function createWaScriptNote({ token, phone, text }) {
    if (!token || !phone || !text) return;
    try {
        const res = await fetch(`${WASCRIPT_BASE_URL}/api/criar-nota/${encodeURIComponent(token)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone: normalizePhone(phone),
                text: text.trim()
            })
        });
        const data = await res.json();
        console.log(`📝 [Nota Criada no WhatsApp] Para ${phone}: "${text.slice(0, 50)}..."`, data);
    } catch (e) {
        console.warn('⚠️ Erro ao criar nota no WaScript:', e.message);
    }
}

/**
 * Modifica etiquetas no WhatsApp Business via API WaScript (/api/modificar-etiquetas/{token})
 * Usado para aplicar Etiqueta "PESSOAL" (ID 10) ou "AGUARDANDO RETORNO" (ID 17)
 */
async function modifyWaScriptLabels({ token, phone, addLabelIds = [], removeLabelIds = [] }) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || !token) return null;

    const actions = [];
    addLabelIds.filter(Boolean).forEach(id => actions.push({ labelId: String(id), type: 'add' }));
    removeLabelIds.filter(Boolean).forEach(id => actions.push({ labelId: String(id), type: 'remove' }));

    if (actions.length === 0) return null;

    try {
        const endpoint = `${WASCRIPT_BASE_URL}/api/modificar-etiquetas/${encodeURIComponent(token)}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone: cleanPhone,
                actions: actions
            })
        });
        const data = await res.json();
        console.log(`🏷️ [Etiquetas WaScript] ${cleanPhone} ações:`, actions, data);
        return data;
    } catch (err) {
        console.warn('⚠️ Erro ao modificar etiquetas no WaScript:', err.message);
        return null;
    }
}

/**
 * Remove Lead do Firestore (para não deixar contatos pessoais sujarem o Kanban)
 */
async function deleteLeadFromFirestore(leadIdOrPhone) {
    if (!leadIdOrPhone) return;
    const cleanPhone = normalizePhone(leadIdOrPhone);
    const directDocId = leadIdOrPhone.startsWith('lead_') ? leadIdOrPhone : `lead_wa_${cleanPhone}`;

    try {
        await fetch(`${FIRESTORE_BASE_URL}/leads/${encodeURIComponent(directDocId)}?key=${FIRESTORE_API_KEY}`, {
            method: 'DELETE'
        });
        console.log(`🗑️ Lead pessoal "${directDocId}" removido do Kanban.`);
    } catch (_) {}

    // Expurga também qualquer outro documento em "leads" que contenha o mesmo telefone
    if (cleanPhone) {
        try {
            const listRes = await fetch(`${FIRESTORE_BASE_URL}/leads?key=${FIRESTORE_API_KEY}&pageSize=150`);
            if (listRes.ok) {
                const listData = await listRes.json();
                const docs = listData.documents || [];
                for (const doc of docs) {
                    const fields = doc.fields || {};
                    const docPhone = normalizePhone((fields.phone && fields.phone.stringValue) || '');
                    if (docPhone && docPhone === cleanPhone) {
                        const docPath = doc.name;
                        await fetch(`https://firestore.googleapis.com/v1/${docPath}?key=${FIRESTORE_API_KEY}`, { method: 'DELETE' });
                        console.log(`🗑️ Expurgo de lead pessoal pelo telefone ${cleanPhone}: ${docPath}`);
                    }
                }
            }
        } catch (err) {
            console.warn('Aviso ao expurgar leads pessoais:', err.message);
        }
    }
}

// Armazenamento em memória das sessões ativas (sincronizadas com o Firestore)
let activeSessions = {};

async function getOrCreateSession(cleanPhone, contactName) {
    if (activeSessions[cleanPhone]) {
        return activeSessions[cleanPhone];
    }
    try {
        const res = await fetch(`${FIRESTORE_BASE_URL}/whatsapp_sessions/${encodeURIComponent(cleanPhone)}?key=${FIRESTORE_API_KEY}`);
        if (res.ok) {
            const data = await res.json();
            const f = data.fields || {};
            const session = {
                phone: cleanPhone,
                contactName: (f.contactName && f.contactName.stringValue) || contactName || '',
                state: (f.state && f.state.stringValue) || 'TRIAGEM',
                isPersonal: Boolean(f.isPersonal && f.isPersonal.booleanValue),
                personalMessageDispatched: Boolean(f.personalMessageDispatched && f.personalMessageDispatched.booleanValue),
                businessCategory: (f.businessCategory && f.businessCategory.stringValue) || '',
                businessObjective: (f.businessObjective && f.businessObjective.stringValue) || '',
                turnCount: parseInt((f.turnCount && (f.turnCount.integerValue || f.turnCount.stringValue)) || '0', 10),
                followUpStep: parseInt((f.followUpStep && (f.followUpStep.integerValue || f.followUpStep.stringValue)) || '0', 10),
                lastMessageReceivedAt: (f.lastMessageReceivedAt && f.lastMessageReceivedAt.stringValue) || new Date().toISOString(),
                lastMessageSentAt: (f.lastMessageSentAt && f.lastMessageSentAt.stringValue) || '',
                lastMessageRole: (f.lastMessageRole && f.lastMessageRole.stringValue) || '',
                lastCustomerMessage: (f.lastCustomerMessage && f.lastCustomerMessage.stringValue) || '',
                notes: (f.notes && f.notes.stringValue) || ''
            };
            activeSessions[cleanPhone] = session;
            return session;
        }
    } catch (_) {}

    const newSession = {
        phone: cleanPhone,
        contactName: contactName || '',
        state: 'TRIAGEM',
        isPersonal: false,
        personalMessageDispatched: false,
        businessCategory: '',
        businessObjective: '',
        turnCount: 0,
        followUpStep: 0,
        lastMessageReceivedAt: new Date().toISOString(),
        lastMessageSentAt: '',
        lastMessageRole: '',
        lastCustomerMessage: '',
        notes: ''
    };
    activeSessions[cleanPhone] = newSession;
    return newSession;
}

async function saveSession(session) {
    if (!session || !session.phone) return;
    activeSessions[session.phone] = session;

    try {
        const url = `${FIRESTORE_BASE_URL}/whatsapp_sessions/${encodeURIComponent(session.phone)}?key=${FIRESTORE_API_KEY}`;
        const body = {
            fields: {
                phone: { stringValue: session.phone },
                contactName: { stringValue: session.contactName || '' },
                state: { stringValue: session.state || 'TRIAGEM' },
                isPersonal: { booleanValue: Boolean(session.isPersonal) },
                personalMessageDispatched: { booleanValue: Boolean(session.personalMessageDispatched) },
                businessCategory: { stringValue: session.businessCategory || '' },
                businessObjective: { stringValue: session.businessObjective || '' },
                turnCount: { integerValue: String(session.turnCount || 0) },
                followUpStep: { integerValue: String(session.followUpStep || 0) },
                lastMessageReceivedAt: { stringValue: session.lastMessageReceivedAt || new Date().toISOString() },
                lastMessageSentAt: { stringValue: session.lastMessageSentAt || '' },
                lastMessageRole: { stringValue: session.lastMessageRole || '' },
                lastCustomerMessage: { stringValue: session.lastCustomerMessage || '' },
                notes: { stringValue: session.notes || '' },
                updatedAt: { stringValue: new Date().toISOString() }
            }
        };
        await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.warn('Aviso ao salvar sessão no Firestore:', e.message);
    }
}

/**
 * Extrai horários (ex: "às 14h", "15:30")
 */
function extractTimeFromText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const timeMatch = lower.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/);
    if (timeMatch) {
        const hh = String(Math.min(23, parseInt(timeMatch[1], 10))).padStart(2, '0');
        const mm = timeMatch[2] ? String(parseInt(timeMatch[2], 10)).padStart(2, '0') : '00';
        return `${hh}:${mm}`;
    }
    return null;
}

/**
 * Extrai datas (ex: "25/10", "amanhã")
 */
function extractDateFromText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const dateMatch = lower.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (dateMatch) {
        const day = String(dateMatch[1]).padStart(2, '0');
        const month = String(dateMatch[2]).padStart(2, '0');
        const year = dateMatch[3] ? (dateMatch[3].length === 2 ? '20' + dateMatch[3] : dateMatch[3]) : new Date().getFullYear();
        return `${year}-${month}-${day}`;
    }
    if (lower.includes('amanhã') || lower.includes('amanha')) {
        const tmr = new Date();
        tmr.setDate(tmr.getDate() + 1);
        return tmr.toISOString().split('T')[0];
    }
    return null;
}

/**
 * Detecta intenções semânticas detalhadas na mensagem do contato:
 * - Pessoal / Amizade / Família
 * - Brincadeira / Curiosidade sobre a IA / Pedido de Senha
 * - Pergunta sobre Experiência, Comprovação de Resultados e Portfólio
 * - Pergunta sobre Preço / Valores / Orçamento
 * - Aceite Explícito de Reunião (ou escolha de Meet / Presencial / Dia / Hora)
 * - Recusa ou adiamento de reunião ("prefiro por aqui")
 * - Pedido de contato direto com o Kayky
 * - Identificação de Nichos (climatização, edição de vídeo, estética, etc.)
 * - Identificação de Objetivos (mais leads, autoridade, vendas)
 */
function detectIntentAndCategory(text, contactName) {
    const raw = (text || '').trim();
    const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // 1. FORTES INDICADORES PESSOAIS / AMIGOS / FAMÍLIA (Assunto estritamente particular)
    const personalPatterns = [
        /\b(amiga?|amigos?|prim[ao]s?|parentes?|vizin[ao]s?)\b/i,
        /\b(sou|e)\s+(uma?\s+)?(amiga?|prim[ao]|parente|vizinh[ao])\b/i,
        /\b(nao tenho\s+(uma?\s+)?empresa|nem tenho empresa|sem empresa|nao sou empresa)\b/i,
        /\b(mae|pai|irmao|irma|familia|familiar|filho|filha|esposa|esposo|marido|namorada|namorado)\b/i,
        /\b(churrasco|cerveja|bora sair|vamos sair|jogar bola|festa|aniversario|balada|almo[cç]o)\b/i,
        /\b(assunto pessoal|no particular|no pessoal)\b/i,
        /\b(amor|vida|meu bem|lindo|linda|querido|querida|beijo|beijos|saudades?)\b/i,
        /\b(minha vida|sei la)\b/i
    ];
    const isExplicitlyPersonal = personalPatterns.some(rx => rx.test(lower));

    // 2. BRINCADEIRAS / COMENTÁRIOS SOBRE IA / PEDIDO DE SENHA
    const botJokingPatterns = [
        /(?:passa|manda|qual|cade)\s*(?:a|o)?\s*(?:senha|codigo|prompt|acesso)\s*(?:dessa|da|do)?\s*(?:ia|inteligencia|robo|bot)/i,
        /\b(senha\s+dessa\s+ia|senha\s+da\s+ia|senha\s+do\s+robo)\b/i,
        /\b(e\s+(uma?\s+)?(ia|robo|bot)|voce\s+e\s+(uma?\s+)?(ia|robo|bot)|inteligencia\s+artificial|bichao|bichão|ta\s+porra|tá\s+porra)\b/i,
        /\b(robozinho|ia\s+falando|quem\s+ta\s+falando|e\s+o\s+kayky\s+ou\s+robo|e\s+o\s+caique\s+ou\s+robo|resposta\s+automatica|chatgpt)\b/i
    ];
    const isJokingOrBotTest = botJokingPatterns.some(rx => rx.test(lower));

    // 3. DÚVIDA / OBJEÇÃO SOBRE EXPERIÊNCIA, COMPROVAÇÃO DE RESULTADOS E PORTFÓLIO
    const experiencePatterns = [
        /(?:como\s+(?:vc|voce)\s+tem\s+experiencia|comprovar|comprova|comprovacao)/i,
        /(?:trabalhos?\s+feitos?|deram\s+resultado|mostrar?\s+resultados?|tem\s+portfolio|portfolio)/i,
        /(?:cases?\s+de\s+sucesso|algum\s+resultado|algum\s+trabalho|cliente.*atendeu|prova\s+social|amostra|me\s+mandar?\s+exemplos?)/i,
        /(?:como\s+funciona\s+na\s+pratica|ja\s+fez\s+para|ja\s+atendeu|garantia)/i
    ];
    const isAskingExperienceOrPortfolio = experiencePatterns.some(rx => rx.test(lower));

    // 4. DÚVIDAS SOBRE PREÇO / VALORES / TABELA
    const pricingPatterns = [
        /(?:quanto\s+custa|qual\s+(?:o\s+)?valor|qual\s+(?:o\s+)?preco|quanto\s+cobra|tabela\s+(?:de\s+)?precos?|valores|investimento)/i
    ];
    const isAskingPricing = pricingPatterns.some(rx => rx.test(lower));

    // 5. RESPOSTA AFIRMATIVA / QUER SABER / ACEITE / ENVIO
    const affirmativePatterns = [
        /\b(sim|sim\s+por\s+favor|por\s+favor|claro|com\s+certeza|com\s+certeza\s+sim|quero|quero\s+sim|gostaria|gostaria\s+de\s+saber|sim\s+gostaria|sim\s+gostaria\s+de\s+saber|pode\s+ser|pode\s+mandar|manda|manda\s+ai|manda\s+os\s+cases|envia|mostra|topo|beleza|combinado|fechado|bora|vamos|vamos\s+marcar)\b/i
    ];
    const isAffirmative = affirmativePatterns.some(rx => rx.test(lower));

    // 6. RESPOSTA NEGATIVA / COMEÇANDO DO ZERO / NUNCA ANUNCIOU
    const negativePatterns = [
        /^(n|nao|não|nenhum|nada|nunca)$/i,
        /\b(nao\s+anuncio|nunca\s+anunciei|do\s+zero|comecando\s+do\s+zero|boca\s+a\s+boca)\b/i
    ];
    const isNegativeOrZero = negativePatterns.some(rx => rx.test(lower));

    // 7. ESCOLHA DE MODALIDADE DE REUNIÃO OU HORÁRIO
    const meetingAcceptPatterns = [
        /\b(meet|google\s+meet|presencial|presencialmente|em\s+bh|no\s+escritorio|vespasiano|online|call|video\s*chamada)\b/i,
        /\b(amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|as\s+\d{1,2}|de\s+(manha|tarde|noite))\b/i
    ];
    const isMeetingModalOrTime = meetingAcceptPatterns.some(rx => rx.test(lower));

    // 8. RECUSA OU PREFERÊNCIA POR ATENDIMENTO APENAS NO WHATSAPP
    const meetingDeclinePatterns = [
        /\b(nao\s+quero\s+reuniao|prefiro\s+por\s+aqui|fala\s+por\s+aqui|manda\s+por\s+aqui|sem\s+tempo|nao\s+tenho\s+tempo|sem\s+call)\b/i
    ];
    const isMeetingDeclined = meetingDeclinePatterns.some(rx => rx.test(lower));

    // 9. PEDIDO DE CONTATO DIRETO COM O KAYKY
    const kaykyDirectPatterns = [
        /\b(falar\s+com\s+o\s+(kayky|caique)|passa\s+pro\s+(kayky|caique)|chama\s+o\s+(kayky|caique)|falar\s+diretamente|com\s+o\s+dono)\b/i
    ];
    const isRequestingKaykyDirect = kaykyDirectPatterns.some(rx => rx.test(lower));

    // 10. INTERESSE ESPECÍFICO EM SERVIÇOS (Triagem)
    const wantsServicesFromTriage = /\b(servicos?|marketing|videos?|producao|saber|saber\s+mais|entender|ajuda)\b/i.test(lower);

    // 11. NICHOS IDENTIFICADOS
    const isClimatizacao = /\b(climatizaca|climatizacao|climatizacoes|climatizar|ar\s*condicionado|refrigeraca|refrigeracao|refrigeracoes|manutenca|manutencao|manutencoes|instalaca|instalacao|instalacoes|chiller|split|tecnico)\b/i.test(lower);
    const isVideo = /\b(edica|edicao|edicoes|audiovisual|videos?|reels|grava|gravacao|gravacoes|filmagem|filmagens|estudio|produtora|cinema|camera)\b/i.test(lower);
    const isTrafego = /\b(trafego|trafego\s+pago|anuncio|anuncios|leads?|meta\s+ads|google\s+ads|instagram\s+ads|captar\s+clientes|escalar\s+vendas)\b/i.test(lower);
    const isHealthBeauty = /\b(estetica|clinica|clinicas|odonto|dentista|dentistas|medico|medicos|dermatologista|harmonizaca|harmonizacao|harmonizacoes|nutri|salao)\b/i.test(lower);
    const isRealEstate = /\b(imoveis|imovel|imobiliaria|corretor|corretores|loteamento|construtora)\b/i.test(lower);

    // 12. OBJETIVOS
    const wantsMoreLeads = /\b(mais\s+leads|captar\s+clientes|orcamentos|novos\s+clientes|vender\s+mais|gerar\s+leads|clientes)\b/i.test(lower);
    const wantsAuthority = /\b(autoridade|posicionamento|branding|presenca\s+digital|seguidores|engajamento)\b/i.test(lower);

    // 13. SAUDAÇÕES SIMPLES
    const greetingWords = ['oi', 'ola', 'opa', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'fala', 'oie', 'salve', 'tudo bem', 'tudo joia', 'tudo bom', 'fechou', 'fechou meu caro', 'fala meu caro', 'fala chefe'];
    const isPureGreeting = greetingWords.some(w => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ',') || lower.startsWith(w + '!'));

    const isCommercial = Boolean(isVideo || isTrafego || isClimatizacao || isHealthBeauty || isRealEstate || wantsMoreLeads || wantsAuthority || isAskingPricing || isAskingExperienceOrPortfolio || wantsServicesFromTriage || /\b(empresa|negocio|loja|marca|servico|orcamento|proposta)\b/i.test(lower));

    return {
        raw,
        lower,
        isExplicitlyPersonal,
        isJokingOrBotTest,
        isAskingExperienceOrPortfolio,
        isAskingPricing,
        isAffirmative,
        isNegativeOrZero,
        isMeetingModalOrTime,
        isMeetingDeclined,
        isRequestingKaykyDirect,
        wantsServicesFromTriage,
        isClimatizacao,
        isVideo,
        isTrafego,
        isHealthBeauty,
        isRealEstate,
        wantsMoreLeads,
        wantsAuthority,
        isCommercial,
        isPureGreeting
    };
}

/**
 * MOTOR INTELIGENTE DE CONVERSAÇÃO (v4.1 AUTÔNOMO)
 * Trata o fluxo como um robô super inteligente:
 * - Triagem inicial (Pessoal vs Comercial)
 * - Se pessoal: Etiqueta 10 (PESSOAL), notifica uma vez e silencia
 * - Se comercial: qualificação dinâmica, contextual e adaptativa
 * - Resposta direta a perguntas (experiência, cases, valores, brincadeiras)
 * - Somente agenda reunião com aceite explícito
 * - Retomada após Aguardando Retorno (ID 17)
 */
async function processIntelligentConversation({
    token,
    phone,
    contactName,
    incomingText,
    session,
    cfg,
    history = []
}) {
    const intent = detectIntentAndCategory(incomingText, contactName);
    console.log(`🧠 [IA Decisão] Phone: ${phone} | Estado: "${session.state}" | Turno: ${session.turnCount} | Brincadeira/IA: ${intent.isJokingOrBotTest} | Experiência: ${intent.isAskingExperienceOrPortfolio} | Pessoal: ${intent.isExplicitlyPersonal} | Afirmativa: ${intent.isAffirmative} | Negativa: ${intent.isNegativeOrZero} | ReuniãoAceita: ${intent.isMeetingModalOrTime}`);

    // ========================================================================
    // CASO 1: CONTATO PESSOAL (Família / Amigo estritamente particular)
    // ========================================================================
    if (intent.isExplicitlyPersonal || session.isPersonal || session.state === 'PESSOAL') {
        session.isPersonal = true;
        session.state = 'PESSOAL';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        await modifyWaScriptLabels({
            token,
            phone,
            addLabelIds: ['10'],
            removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
        });

        await deleteLeadFromFirestore(`lead_wa_${phone}`);

        if (session.turnCount <= 2 && !session.personalMessageDispatched) {
            session.personalMessageDispatched = true;
            await saveSession(session);

            const pMsg1 = `Ah, que bom te ver por aqui${contactName ? ', ' + contactName : ''}! 😊`;
            const pMsg2 = `Já anotei aqui que é assunto pessoal e vou avisar o Kayky para ele te responder no particular assim que liberar das gravações!`;

            await createWaScriptNote({
                token,
                phone,
                text: `📌 [Contato Pessoal] Identificado como amigo(a)/família ("${incomingText}"). Robô desativado.`
            });

            return {
                isCommercialLead: false,
                isPersonal: true,
                shouldAutoReply: true,
                replyMessages: [pMsg1, pMsg2],
                replyMessage: `${pMsg1}\n\n${pMsg2}`,
                recommendedStage: 'PESSOAL',
                internalNote: 'Contato pessoal/família - bot desativado.'
            };
        } else {
            console.log(`🤫 [Bot Silenciado]: Contato ${contactName || phone} é pessoal. Nenhuma resposta comercial enviada.`);
            return {
                isCommercialLead: false,
                isPersonal: true,
                shouldAutoReply: false,
                replyMessages: [],
                replyMessage: '',
                recommendedStage: 'PESSOAL',
                internalNote: 'Contato pessoal - bot silenciado.'
            };
        }
    }

    // ========================================================================
    // CASO 2: RETORNO APÓS "AGUARDANDO RETORNO" (O cliente sumiu e voltou agora)
    // ========================================================================
    if (session.state === 'AGUARDANDO_RETORNO') {
        console.log(`🔄 [Retomada Inteligente] Cliente ${contactName || phone} retornou após follow-up!`);
        session.followUpStep = 0;
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        await modifyWaScriptLabels({
            token,
            phone,
            addLabelIds: ['14'],
            removeLabelIds: ['17']
        });

        const rMsg1 = `Oi${contactName ? ', ' + contactName : ''}! Que bom que você retornou 😊`;
        let rMsg2 = `Vamos dar sequência sim! Para avançarmos no seu alinhamento, me conta: qual é o principal objetivo da sua empresa hoje?`;
        if (session.businessCategory) {
            rMsg2 = `Vamos continuar estruturando o projeto para sua ${session.businessCategory}! Você prefere que a gente marque uma breve call de 15 min esta semana?`;
        }

        return {
            isCommercialLead: true,
            isPersonal: false,
            shouldAutoReply: true,
            replyMessages: [rMsg1, rMsg2],
            replyMessage: `${rMsg1}\n\n${rMsg2}`,
            recommendedStage: 'Qualificado',
            internalNote: 'Cliente retornou contato após período de espera.'
        };
    }

    // ========================================================================
    // CASO 3: PEDIDO PARA FALAR DIRETAMENTE COM O KAYKY
    // ========================================================================
    if (intent.isRequestingKaykyDirect) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const kMsg1 = `Perfeito! O Kayky está em rotina de gravações e reuniões no momento, mas já sinalizei pra ele por aqui 📲`;
        const kMsg2 = `Se você quiser me adiantar qual o assunto ou a demanda da sua empresa, já deixo tudo mastigado pra ele te responder assim que liberar!`;

        await createWaScriptNote({
            token,
            phone,
            text: `📌 Solicitou falar diretamente com o Kayky. Notificado.`
        });

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [kMsg1, kMsg2],
            replyMessage: `${kMsg1}\n\n${kMsg2}`,
            recommendedStage: 'Prospecção',
            internalNote: 'Lead solicitou falar direto com o Kayky.'
        };
    }

    // ========================================================================
    // CASO 4: BRINCADEIRAS / COMENTÁRIOS SOBRE IA / PEDIDO DE SENHA
    // Ex: "Tá porra ,bichao passa a senha dessa ia, aí"
    // ========================================================================
    if (intent.isJokingOrBotTest) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.turnCount = Math.max(session.turnCount, 1);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const jMsg1 = `Haha, a senha é guardada a sete chaves! 🤖 Mas a tecnologia tá afiada justamente pra responder rápido e não deixar ninguém no vácuo.`;
        const jMsg2 = `Mas me conta: você quer dar uma acelerada no marketing e nos vídeos da sua empresa ou queria falar sobre outro assunto com o Kayky?`;

        await createWaScriptNote({
            token,
            phone,
            text: `📌 Lead comentou/brincou sobre a IA: "${incomingText}". Conduzido com humor.`
        });

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [jMsg1, jMsg2],
            replyMessage: `${jMsg1}\n\n${jMsg2}`,
            recommendedStage: 'Prospecção',
            internalNote: 'Interagiu sobre a IA. Direcionado para negócios.'
        };
    }

    // ========================================================================
    // CASO 5: DÚVIDA / OBJEÇÃO SOBRE EXPERIÊNCIA, COMPROVAÇÃO E PORTFÓLIO
    // Ex: "Como vc tem experiência? Como poderia me comprovar trabalhos feitos por vocês que deram resultado"
    // NUNCA PODE DIZER QUE PRÉ-AGENDOU REUNIÃO! RESPONDA COM AUTORIDADE E OFEREÇA PORTFÓLIO!
    // ========================================================================
    if (intent.isAskingExperienceOrPortfolio) {
        session.state = 'EMPRESARIAL_PROVANDO';
        session.turnCount = Math.max(session.turnCount, 3);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        let proofMsg1 = `Com certeza, faz total sentido você perguntar! A melhor forma de comprovar é mostrando o que a gente já colocou pra rodar e os resultados gerados 🤝`;
        let proofMsg2 = `Nós estruturamos campanhas de tráfego de alta intenção no Google e Meta focadas em fazer o WhatsApp apitar com orçamentos todo dia. E no audiovisual, gravamos com câmeras de cinema e roteiro estratégico pra passar autoridade imediata.\n\nConsigo te mandar aqui no WhatsApp alguns exemplos práticos de criativos e campanhas que geram orçamentos. Você prefere que eu te encaminhe?`;

        if (session.businessCategory && (session.businessCategory.toLowerCase().includes('climatiz') || session.businessCategory.toLowerCase().includes('ar condicionado') || intent.isClimatizacao)) {
            proofMsg2 = `Para empresas de climatização e serviços técnicos, o segredo é pegar o cliente na hora da necessidade (pesquisa de instalação/manutenção no Google) e ter vídeos curtos mostrando o padrão do serviço no Instagram.\n\nConsigo te mandar aqui no WhatsApp alguns exemplos práticos de criativos e campanhas que geram orçamentos. Você prefere que eu te encaminhe?`;
        }

        await createWaScriptNote({
            token,
            phone,
            text: `📌 [Dúvida/Objeção] Lead pediu comprovação de experiência/portfólio: "${incomingText}". Oferecido envio de cases.`
        });

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [proofMsg1, proofMsg2],
            replyMessage: `${proofMsg1}\n\n${proofMsg2}`,
            recommendedStage: 'Qualificado',
            internalNote: 'Dúvida sobre experiência/cases respondida. Oferecido envio de portfólio.'
        };
    }

    // ========================================================================
    // CASO 6: ESTÁ EM PROVANDO E O CLIENTE RESPONDEU AFIRMATIVAMENTE ("Sim", "Sim por favor", "Manda", "Quero ver")
    // ========================================================================
    if (session.state === 'EMPRESARIAL_PROVANDO' && intent.isAffirmative) {
        session.state = 'EMPRESARIAL_ALINHAMENTO';
        session.turnCount = Math.max(session.turnCount, 4);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const cMsg1 = `Maravilha${contactName ? ', ' + contactName : ''}! Já vou separar os materiais dos nossos projetos e cases pra você conferir 📁`;
        const cMsg2 = `Enquanto isso, você prefere dar uma olhada com calma por aqui ou quer reservar 15 minutos para bater um papo rápido com o Kayky pelo Google Meet ou presencial em BH?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [cMsg1, cMsg2],
            replyMessage: `${cMsg1}\n\n${cMsg2}`,
            recommendedStage: 'Qualificado',
            internalNote: 'Material de cases enviado/oferecido. Sugerido alinhamento de 15 min.'
        };
    }

    // ========================================================================
    // CASO 7: DÚVIDA SOBRE PREÇO / VALORES
    // Ex: "Quanto custa?", "Qual o valor?"
    // ========================================================================
    if (intent.isAskingPricing) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const prMsg1 = `Sobre os valores, nós não trabalhamos com planos engessados porque cada empresa tem uma demanda específica (volume de gravações, verba de tráfego, etc.) 💼`;
        const prMsg2 = `Pra gente te passar uma estimativa exata e sem desperdício: hoje o seu foco maior seria gerar orçamentos no tráfego pago ou a produção dos vídeos?`;

        await createWaScriptNote({
            token,
            phone,
            text: `📌 Lead perguntou valores/preços. Explicado modelo personalizado.`
        });

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [prMsg1, prMsg2],
            replyMessage: `${prMsg1}\n\n${prMsg2}`,
            recommendedStage: 'Prospecção',
            internalNote: 'Pergunta sobre preço respondida. Qualificando demanda.'
        };
    }

    // ========================================================================
    // CASO 8: ESCOLHA DE MODALIDADE OU ACEITE DE REUNIÃO DE 15 MIN
    // Ex: "Vamos marcar", "Pode ser Google Meet", "Quinta às 15h", "Presencial em BH"
    // ========================================================================
    if (intent.isMeetingModalOrTime || (session.state === 'EMPRESARIAL_ALINHAMENTO' && intent.isAffirmative)) {
        session.state = 'CONCLUIDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        await modifyWaScriptLabels({
            token,
            phone,
            addLabelIds: ['18'], // ALINHAMENTO
            removeLabelIds: ['13', '14']
        });

        const schedDate = extractDateFromText(incomingText) || new Date().toISOString().split('T')[0];
        const schedTime = extractTimeFromText(incomingText) || '14:00';
        const isPresencial = /presencial|em\s+bh|no\s+escritorio/i.test(incomingText);
        const modalidade = isPresencial ? 'Presencial em BH' : 'Google Meet';

        const conf1 = `Sensacional${contactName ? ', ' + contactName : ''}! Combinado 🤝`;
        const conf2 = `Já deixei pré-agendado em nossa agenda comercial (${modalidade}). Nossa equipe entrará em contato para confirmar o link e os detalhes do nosso papo. Qualquer dúvida estou por aqui!`;

        await createWaScriptNote({
            token,
            phone,
            text: `📌 [Reunião Confirmada] Alinhamento pré-agendado pelo cliente (${modalidade}). Mensagem: "${incomingText}"`
        });

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [conf1, conf2],
            replyMessage: `${conf1}\n\n${conf2}`,
            recommendedStage: 'Qualificado',
            internalNote: `Reunião confirmada pelo cliente: ${modalidade}`,
            detectedSchedule: {
                hasSchedule: true,
                scheduleType: 'reuniao',
                title: `Alinhamento Comercial - ${contactName || phone} (${modalidade})`,
                date: schedDate,
                time: schedTime,
                notes: `Canal: ${modalidade} | Mensagem: ${incomingText}`
            }
        };
    }

    // ========================================================================
    // CASO 9: LEAD INFORMOU O NICHO E/OU OBJETIVO (Climatização, Imobiliária, Vídeos, etc.)
    // Ex: "Trabalho com ,climatização fora edição de vídeos,objetivo alcançar mais leads" ou "Tenho uma imobiliária"
    // ========================================================================
    if (intent.isClimatizacao || intent.isVideo || intent.isTrafego || intent.isRealEstate || intent.isHealthBeauty || intent.wantsMoreLeads) {
        let niches = [];
        if (intent.isClimatizacao) niches.push('Climatização');
        if (intent.isVideo) niches.push('Edição/Vídeos');
        if (intent.isTrafego) niches.push('Tráfego Pago');
        if (intent.isRealEstate) niches.push('Imobiliária');
        if (intent.isHealthBeauty) niches.push('Saúde/Estética');

        session.businessCategory = niches.join(' e ') || session.businessCategory || 'Serviços';
        session.businessObjective = intent.wantsMoreLeads ? 'Mais Leads / Clientes' : (intent.wantsAuthority ? 'Autoridade e Posicionamento' : 'Crescimento');
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.turnCount = Math.max(session.turnCount, 2);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        await modifyWaScriptLabels({
            token,
            phone,
            addLabelIds: ['14'], // LEAD EM TRATATIVA
            removeLabelIds: ['13']
        });

        await createWaScriptNote({
            token,
            phone,
            text: `📌 [Qualificação] Segmento: ${session.businessCategory} | Objetivo: ${session.businessObjective} | Msg: "${incomingText}"`
        });

        if (intent.isClimatizacao) {
            const cMsg1 = `Muito bom! Serviços de climatização têm uma demanda gigantesca no Google e Meta Ads de gente precisando de orçamento imediato 🚀`;
            const cMsg2 = `E quando você combina isso com vídeos bem produzidos mostrando o trabalho de perto, a taxa de fechamento dispara. Hoje a sua captação vem mais no boca a boca ou você já roda anúncios online?`;
            return {
                isCommercialLead: true,
                shouldAutoReply: true,
                replyMessages: [cMsg1, cMsg2],
                replyMessage: `${cMsg1}\n\n${cMsg2}`,
                recommendedStage: 'Qualificado',
                internalNote: `Nicho: ${session.businessCategory} | Objetivo: ${session.businessObjective}`
            };
        } else if (intent.isRealEstate) {
            const rMsg1 = `Excelente! O mercado imobiliário é um dos setores que mais ganha tração com anúncios segmentados de alta intenção e vídeos dinâmicos dos imóveis 🏢`;
            const rMsg2 = `Para eu entender o momento da sua imobiliária: vocês já investem em anúncios no Google ou Meta hoje, ou estão querendo estruturar isso do zero?`;
            return {
                isCommercialLead: true,
                shouldAutoReply: true,
                replyMessages: [rMsg1, rMsg2],
                replyMessage: `${rMsg1}\n\n${rMsg2}`,
                recommendedStage: 'Qualificado',
                internalNote: `Nicho: Imobiliária. Coletando histórico de anúncios.`
            };
        } else if (intent.isVideo) {
            const vMsg1 = `Show de bola! Produção audiovisual e posicionamento em vídeo é justamente o nosso maior diferencial aqui na Capital Marketing 🎬`;
            const vMsg2 = `A gente grava com câmeras de cinema e iluminação de estúdio em BH e região. Hoje você busca mais vídeos curtos para Reels/Instagram ou vídeos institucionais?`;
            return {
                isCommercialLead: true,
                shouldAutoReply: true,
                replyMessages: [vMsg1, vMsg2],
                replyMessage: `${vMsg1}\n\n${vMsg2}`,
                recommendedStage: 'Qualificado',
                internalNote: `Interesse em Produção Audiovisual. Coletando formato.`
            };
        } else {
            const tMsg1 = `Excelente! Captação de novos clientes e escala de vendas é exatamente a nossa especialidade de performance 🚀`;
            const tMsg2 = `Para eu entender seu momento: vocês já investem em anúncios no Google ou Meta hoje, ou estão querendo estruturar isso do zero?`;
            return {
                isCommercialLead: true,
                shouldAutoReply: true,
                replyMessages: [tMsg1, tMsg2],
                replyMessage: `${tMsg1}\n\n${tMsg2}`,
                recommendedStage: 'Qualificado',
                internalNote: `Interesse comercial: ${session.businessCategory}. Coletando maturidade digital.`
            };
        }
    }

    // ========================================================================
    // CASO 10: LEAD RESPONDEU À TRIAGEM DIZENDO QUE QUER SABER DOS SERVIÇOS ("Sim gostaria de saber", "Quero saber")
    // ========================================================================
    if (session.state === 'AGUARDANDO_TRIAGEM' && (intent.isAffirmative || intent.wantsServicesFromTriage)) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.turnCount = 2;
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const m1 = `Maravilha${contactName ? ', ' + contactName : ''}! Vai ser um prazer te apresentar como podemos acelerar seu negócio 💼`;
        const m2 = `Me conta um pouquinho: qual é o segmento da sua empresa hoje e qual o principal objetivo comercial que você quer alcançar?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Prospecção',
            internalNote: 'Triagem aceita. Solicitado nicho e objetivo.'
        };
    }

    // ========================================================================
    // CASO 11: CLIENTE RESPONDEU SOBRE ANÚNCIOS ("Não", "N", "Começando do zero" ou "Já anuncio")
    // ========================================================================
    if (session.state === 'EMPRESARIAL_QUALIFICANDO' && (intent.isNegativeOrZero || intent.isAffirmative || incomingText.trim().length <= 15)) {
        session.state = 'EMPRESARIAL_ALINHAMENTO';
        session.turnCount = Math.max(session.turnCount, 3);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const aMsg1 = `Sensacional! Esse é exatamente o momento ideal para estruturar um processo previsível de captação de clientes e autoridade 🤝`;
        const aMsg2 = `Para te apresentarmos nossa estrutura, formatos e os planos personalizados, vamos marcar uma rápida conversa de 15 minutos? Você prefere Google Meet ou presencial em BH?`;

        await createWaScriptNote({
            token,
            phone,
            text: `📌 [Dados Coletados] Informações de anúncios/situação: "${incomingText}". Proposta reunião de 15 min.`
        });

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [aMsg1, aMsg2],
            replyMessage: `${aMsg1}\n\n${aMsg2}`,
            recommendedStage: 'Qualificado',
            internalNote: `Demanda alinhada. Convidado para alinhamento de 15 min.`
        };
    }

    // ========================================================================
    // CASO 12: RECUSA DE REUNIÃO ("Prefiro por aqui", "Não quero call")
    // ========================================================================
    if (intent.isMeetingDeclined) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const dec1 = `Sem problemas, super compreensível! Conseguimos tirar todas as dúvidas e adiantar tudo por aqui pelo WhatsApp mesmo 👍`;
        const dec2 = `Qual é o principal desafio que você enfrenta hoje na captação desses leads pra gente focar a solução?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [dec1, dec2],
            replyMessage: `${dec1}\n\n${dec2}`,
            recommendedStage: 'Qualificado',
            internalNote: 'Cliente preferiu atendimento no WhatsApp em vez de call.'
        };
    }

    // ========================================================================
    // CASO 13: SE A SESSÃO JÁ ESTAVA EM ANDAMENTO (NUNCA REPETIR SAUDAÇÃO INICIAL!)
    // ========================================================================
    if (session.turnCount > 0 || session.state !== 'TRIAGEM') {
        session.turnCount += 1;
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        if (session.state === 'EMPRESARIAL_ALINHAMENTO') {
            const reMsg1 = `Perfeito${contactName ? ', ' + contactName : ''}! Para alinharmos todos os detalhes do seu projeto 🤝`;
            const reMsg2 = `Você prefere que a gente marque esse papo de 15 minutos pelo Google Meet ou presencialmente em BH?`;
            return {
                isCommercialLead: true,
                shouldAutoReply: true,
                replyMessages: [reMsg1, reMsg2],
                replyMessage: `${reMsg1}\n\n${reMsg2}`,
                recommendedStage: 'Qualificado',
                internalNote: 'Aguardando preferência de alinhamento (Meet ou Presencial).'
            };
        }

        const cMsg1 = `Show de bola${contactName ? ', ' + contactName : ''}! Já anotei aqui.`;
        const cMsg2 = `Para eu estruturar a proposta certa para você: qual é o principal foco da sua empresa hoje (tráfego para novos clientes ou produção de vídeos)?`;
        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [cMsg1, cMsg2],
            replyMessage: `${cMsg1}\n\n${cMsg2}`,
            recommendedStage: 'Qualificado',
            internalNote: `Acompanhamento consultivo: "${incomingText}"`
        };
    }

    // ========================================================================
    // CASO 14: SAUDAÇÃO INICIAL / PRIMEIRO CONTATO (TURNO 0)
    // ========================================================================
    session.state = 'AGUARDANDO_TRIAGEM';
    session.turnCount = 1;
    session.lastMessageReceivedAt = new Date().toISOString();
    await saveSession(session);

    await modifyWaScriptLabels({
        token,
        phone,
        addLabelIds: ['13'] // LEAD MAPEADO
    });

    const gMsg1 = `Olá${contactName ? ', ' + contactName : ''}! Tudo bem? Aqui é da equipe da Capital Marketing 👋`;
    const gMsg2 = `Como posso te ajudar hoje? (Você gostaria de saber sobre nossos serviços de marketing e produção de vídeos, ou falar diretamente com o Kayky?)`;

    return {
        isCommercialLead: true,
        shouldAutoReply: true,
        replyMessages: [gMsg1, gMsg2],
        replyMessage: `${gMsg1}\n\n${gMsg2}`,
        recommendedStage: 'Prospecção',
        internalNote: 'Primeiro contato recebido. Triagem inicial enviada.'
    };
}

let followUpWorkerInterval = null;

/**
 * Worker em segundo plano que monitora o tempo de silêncio do cliente:
 * - 5 minutos sem resposta: manda um lembrete/follow-up educado
 * - 15 minutos após o follow-up: encerra temporariamente e aplica etiqueta "AGUARDANDO RETORNO" (ID 17)
 */
function startFollowUpWorker() {
    if (followUpWorkerInterval) return;
    console.log('⏱️ [Follow-Up Worker 24/7] Iniciado para monitorar silêncios (5 min e 15 min).');

    followUpWorkerInterval = setInterval(async () => {
        try {
            const now = Date.now();
            const cfg = await getPortalWascriptConfig();
            const token = cfg.token || DEFAULT_WASCRIPT_TOKEN;
            if (!token) return;

            for (const [phone, sess] of Object.entries(activeSessions)) {
                if (sess.isPersonal || sess.state === 'PESSOAL' || sess.state === 'CONCLUIDO') continue;
                if (!sess.state || !sess.state.startsWith('EMPRESARIAL_')) continue;
                if (sess.lastMessageRole !== 'ia') continue;

                const lastSentTime = sess.lastMessageSentAt ? new Date(sess.lastMessageSentAt).getTime() : 0;
                if (!lastSentTime) continue;

                const diffMinutes = (now - lastSentTime) / (1000 * 60);

                // 1. Follow-up 1: após 5 minutos de silêncio do cliente
                if (diffMinutes >= 5 && diffMinutes < 15 && sess.followUpStep === 0) {
                    console.log(`⏱️ [Follow-Up 5 min] Disparando para ${phone} (${sess.contactName || ''})...`);
                    sess.followUpStep = 1;
                    sess.lastMessageSentAt = new Date().toISOString();
                    await saveSession(sess);

                    const followUpMsg = `Oi${sess.contactName ? ', ' + sess.contactName : ''}! Tudo bem por aí? Conseguir dar uma olhada na mensagem anterior? Se tiver qualquer dúvida sobre os formatos ou projetos, estou por aqui! 😉`;
                    await sendHumanizedWhatsAppReply({
                        token,
                        phone,
                        messages: [followUpMsg],
                        contactName: sess.contactName,
                        delaySeconds: 0,
                        stage: 'Qualificado'
                    });
                }

                // 2. Follow-up 2: após 15 minutos do primeiro follow-up (ou ~20 min de silêncio total)
                else if (diffMinutes >= 15 && sess.followUpStep === 1) {
                    console.log(`⏱️ [Follow-Up 15 min - Aguardando Retorno] Disparando para ${phone} (${sess.contactName || ''})...`);
                    sess.followUpStep = 2;
                    sess.state = 'AGUARDANDO_RETORNO';
                    sess.lastMessageSentAt = new Date().toISOString();
                    await saveSession(sess);

                    const closeMsg = `Vou deixar nossa conversa em aberto por aqui para não te incomodar! Quando tiver um tempinho mais tranquilo, é só me responder que a gente continua de onde parou, combinado? Abraços e ótimo dia! 🚀`;
                    await sendHumanizedWhatsAppReply({
                        token,
                        phone,
                        messages: [closeMsg],
                        contactName: sess.contactName,
                        delaySeconds: 0,
                        stage: 'Proposta Enviada'
                    });

                    // Aplica etiqueta oficial "AGUARDANDO RETORNO" (ID 17) no WhatsApp
                    await modifyWaScriptLabels({
                        token,
                        phone,
                        addLabelIds: ['17'],
                        removeLabelIds: ['13', '14']
                    });

                    // Atualiza no CRM para Aguardando Retorno
                    await saveLeadToFirestore({
                        phone,
                        name: sess.contactName,
                        status: 'Proposta Enviada',
                        notes: 'Aguardando retorno do cliente após follow-ups.',
                        etiqueta: '17'
                    });
                }
            }
        } catch (workerErr) {
            console.warn('Aviso no worker de follow-up:', workerErr.message);
        }
    }, 60 * 1000);
}

/**
 * Envia resposta humanizada no WhatsApp via WaScript:
 * - Aguarda delay configurável (ex: 8 a 15 segundos) simulando leitura e digitação humana
 * - Divide a resposta em 2 mensagens curtas e espaçadas (estilo WhatsApp natural)
 */
async function sendHumanizedWhatsAppReply({ token, phone, messages, contactName, delaySeconds = 10, stage = '' }) {
    if (!token || !phone || !messages || messages.length === 0) return;

    // 1. Simulação de tempo de resposta humano (delay)
    if (delaySeconds > 0) {
        console.log(`⏳ [Delay Humanizado]: aguardando ${delaySeconds}s antes de enviar resposta para ${phone}...`);
        await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }

    // 2. Envio sequencial das mensagens com intervalo de digitação entre elas
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || !msg.trim()) continue;

        if (i > 0) {
            // Intervalo de 3.5 segundos entre mensagens para parecer digitação natural
            await new Promise(r => setTimeout(r, 3500));
        }

        try {
            const sendRes = await fetch(`${WASCRIPT_BASE_URL}/api/enviar-texto/${encodeURIComponent(token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: normalizePhone(phone),
                    message: msg.trim()
                })
            });
            const resJson = await sendRes.json();
            console.log(`🚀 [Mensagem Humanizada ${i + 1}/${messages.length} Enviada] Para ${phone}: "${msg.slice(0, 50)}..."`, resJson);

            await saveChatMessageToFirestore({
                phone,
                contactName,
                role: 'ia',
                text: msg.trim(),
                stage
            });
        } catch (sendErr) {
            console.warn(`⚠️ Erro ao enviar mensagem ${i + 1} para ${phone}:`, sendErr.message);
        }
    }
}

/**
 * Chama a IA Real do Google Gemini (gemini-2.5-flash / gemini-2.0-flash) via generateContent
 * Analisa se o contato é comercial legítimo antes de criar na esteira do CRM!
 */
async function callRealGeminiAI({ apiKey, systemPrompt, contactName, cleanPhone, incomingText, history, isKnownLead = false }) {
    const todayStr = new Date().toISOString().split('T')[0];

    if (apiKey) {
        const historyFormatted = (history || [])
            .map(m => `${m.role === 'cliente' ? 'Cliente' : 'Capital Marketing'}: ${m.text}`)
            .join('\n');

        const defaultSysPrompt = `Você é o Consultor Comercial e Concierge de Atendimento da Capital Marketing (agência de marketing de performance, tráfego pago, posicionamento digital e produção audiovisual em Belo Horizonte e região).
Você atua no WhatsApp em nome do Kayky (Kayky Ribeiro) e da Capital Marketing.

SUA MISSÃO NO WHATSAPP É CONDUZIR UMA CONVERSA 100% INTELIGENTE, ADAPTATIVA E HUMANIZADA:
1. LEIA TODO O HISTÓRICO E RESPONDA AO QUE O CLIENTE FALOU:
   - Se o cliente fizer uma pergunta direta (ex: "como você tem experiência?", "como poderia me comprovar trabalhos feitos por vocês que deram resultado?", "quanto custa?", "tem portfólio?"), VOCÊ DEVE RESPONDER A DÚVIDA DE FORMA TRANSPARENTE, SEGURA E COMERCIAL!
   - NUNCA ignore a pergunta do cliente para tentar forçar reunião!
   - Sobre comprovação e experiência: explique que a agência estrutura campanhas no Google e Meta Ads focadas em orçamentos diretos para empresas de serviços/locais, e grava com equipamentos de cinema e roteiros estratégicos em BH. Ofereça enviar exemplos e cases de clientes pelo WhatsApp.
   - Sobre preço/valores: explique que não trabalha com tabelas engessadas porque cada cliente tem um escopo sob medida (volume de gravações, verba de tráfego), e pergunte qual é o objetivo prioritário dele hoje.
   - Se o cliente fizer uma piada sobre a IA ou pedir a senha (ex: "passa a senha dessa IA", "é robô?"): responda com simpatia e bom humor ("A senha é guardada a sete chaves haha 🤖 Mas o importante é atender rápido sem deixar ninguém esperando!") e conduza de volta para o negócio com naturalidade.

2. NUNCA INVENTE OU CONFIRME REUNIÃO SEM ACEITE EXPLÍCITO:
   - Só marque "detectedSchedule.hasSchedule": true e confirme agendamento se o cliente tiver respondido expressamente aceitando ("pode ser", "vamos", "fechado", "marca aí", escolheu "Google Meet" ou "Presencial", ou informou dia/horário).
   - Se o cliente fez uma pergunta, tirou dúvida ou fez objeção, "detectedSchedule.hasSchedule" DEVE SER false!

3. CONEXÃO COM O NICHO DO CLIENTE:
   - Se o cliente mencionar climatização/ar condicionado/serviços: destaque a força da busca no Google no momento da necessidade e vídeos mostrando a qualidade técnica no Instagram.
   - Se citar vídeos/audiovisual: mencione captação 4K, roteiro de autoridade e edição dinâmica.

4. FORMATO DAS MENSAGENS (ESTILO WHATSAPP):
   - Divida SEMPRE no campo "replyMessages" em 2 mensagens curtas e naturais:
     - Mensagem 1: Conexão calorosa e resposta direta ao ponto levantado.
     - Mensagem 2: Pergunta consultiva para avançar ou oferta prática (ex: envio de cases).
   - Linguagem natural de WhatsApp brasileiro, profissional e acolhedora, sem clichês de IA (evite "jornada", "transformar", "alavancar", "entendi perfeitamente").`;

        const promptText = `${systemPrompt || defaultSysPrompt}

Data de hoje: ${todayStr}
Contato no WhatsApp: ${contactName || 'Contato'} (${cleanPhone})
Histórico recente da conversa:
${historyFormatted || '(Início da conversa)'}

Nova mensagem recebida do contato: "${incomingText}"

Retorne APENAS um objeto JSON válido com a seguinte estrutura:
{
  "isCommercialLead": true,
  "shouldCreateLead": true,
  "shouldAutoReply": true,
  "filterReason": "motivo claro da classificação",
  "replyMessage": "sua resposta de vendas consultiva completa",
  "replyMessages": [
    "primeira mensagem curta e calorosa de acolhimento",
    "segunda mensagem com a pergunta consultiva progressiva"
  ],
  "internalNote": "informações coletadas do lead para salvar como nota no WhatsApp e CRM",
  "leadName": "nome do contato ou empresa identificada",
  "recommendedStage": "Prospecção" | "Qualificado" | "Proposta Enviada" | "Fechado",
  "estimatedMonthlyValue": 3500,
  "qualificationSummary": "resumo executivo do interesse/nicho do lead para o CRM",
  "detectedSchedule": {
    "hasSchedule": false,
    "scheduleType": "nenhum" | "reuniao" | "gravacao",
    "title": "título do compromisso",
    "date": "YYYY-MM-DD",
    "time": "HH:MM",
    "notes": "pauta da reunião ou detalhes da gravação"
  }
}`;

        const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
        for (const modelName of modelsToTry) {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
                const res = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: promptText }] }],
                        generationConfig: {
                            temperature: 0.3,
                            responseMimeType: 'application/json'
                        }
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    const rawText = data.candidates &&
                        data.candidates[0] &&
                        data.candidates[0].content &&
                        data.candidates[0].content.parts &&
                        data.candidates[0].content.parts[0] &&
                        data.candidates[0].content.parts[0].text;
                    if (rawText) {
                        const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                        const parsed = JSON.parse(cleaned);
                        if (parsed && (parsed.replyMessage || parsed.isCommercialLead !== undefined)) {
                            console.log(`🤖 [Gemini AI (${modelName})] Qualificação: isCommercial=${parsed.isCommercialLead} (${parsed.filterReason || ''})`);
                            return parsed;
                        }
                    }
                } else {
                    const errTxt = await res.text();
                    console.warn(`⚠️ Gemini (${modelName}) status ${res.status}:`, errTxt.slice(0, 200));
                }
            } catch (e) {
                console.warn(`⚠️ Erro ao chamar ${modelName}:`, e.message);
            }
        }
    }

    return null;
}

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Capital Marketing WhatsApp 24/7 AI Autonomous Webhook',
        version: '4.1.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/whatsapp-webhook', (req, res) => {
    res.json({
        status: 'online',
        message: 'Endpoint ativo para receber Webhooks POST do WaScript / WhatsApp 24/7.',
        recentEventsCount: recentWebhookEvents.length
    });
});

app.get('/api/recent-events', (req, res) => {
    res.json({
        total: recentWebhookEvents.length,
        events: recentWebhookEvents
    });
});

/**
 * Endpoint para importar em lote contatos/etiquetas reais extraídos do WhatsApp Web
 */
app.post('/api/import-whatsapp-contacts', async (req, res) => {
    try {
        const contacts = Array.isArray(req.body.contacts) ? req.body.contacts : [];
        const cfg = await getPortalWascriptConfig();
        const imported = [];

        for (const c of contacts) {
            const phone = normalizePhone(c.phone || c.numero || c.id);
            const name = (c.name || c.nome || '').trim();
            const etiqueta = c.etiqueta || c.label || '';
            const lastMessage = c.lastMessage || c.mensagem || '';
            if (!phone && !name) continue;

            const mappedCol = mapEtiquetaToColumn(etiqueta, cfg.labelMapping) || c.status || 'Prospecção';
            const saved = await saveLeadToFirestore({
                phone,
                name,
                status: mappedCol,
                notes: etiqueta ? `Sincronizado do WhatsApp Business (Etiqueta: ${etiqueta})${lastMessage ? ' | Última msg: ' + lastMessage : ''}` : (lastMessage || 'Sincronizado do WhatsApp Web'),
                value: c.value || 3500,
                lastMessage,
                etiqueta
            });
            if (saved) imported.push(saved);
        }

        return res.json({
            success: true,
            importedCount: imported.length,
            imported
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Endpoint de Notificações por E-mail do Portal Capital Marketing
 */
app.post('/api/send-email', (req, res) => {
    const { to, subject, message } = req.body || {};
    console.log(`📧 [Notificação E-mail] Para: ${to} | Assunto: ${subject}`);
    res.json({
        success: true,
        message: `Notificação enviada para ${to}`,
        to,
        subject,
        timestamp: new Date().toISOString()
    });
});

/**
 * Endpoint Principal de Webhook Unificado com Filtros Inteligentes:
 * 1. Bloqueio automático de Grupos (@g.us) e Broadcasts (@broadcast)
 * 2. Bloqueio por Lista Negra (Blacklist de números/nomes)
 * 3. Detecção de Clientes Ativos (não polui a esteira de novos leads)
 * 4. Filtro de Intenção Comercial via IA Gemini (descarta conversas pessoais e spam)
 * 5. Auto-Resposta 100% Autônoma via API Oficial WaScript
 */
app.post(['/webhook', '/api/whatsapp-webhook'], async (req, res) => {
    try {
        const body = req.body || {};
        const extracted = extractWhatsAppDataFromPayload(body);
        const { phone, contactName, incomingText, incomingEtiqueta, isFromMe, isGroup, isBroadcast, eventType } = extracted;

        const eventRecord = {
            timestamp: new Date().toISOString(),
            phone,
            contactName,
            incomingEtiqueta,
            incomingText,
            isFromMe,
            isGroup,
            eventType,
            rawPayload: body
        };
        recentWebhookEvents.unshift(eventRecord);
        if (recentWebhookEvents.length > 100) recentWebhookEvents.pop();

        // 1. FILTRO DE GRUPOS DO WHATSAPP (@g.us) E STATUS
        if (isGroup) {
            console.log(`🚫 [Grupo WhatsApp Ignorado]: "${contactName || phone}"`);
            return res.status(200).json({
                success: true,
                ignored: true,
                reason: 'whatsapp_group_ignored',
                groupName: contactName || phone
            });
        }
        if (isBroadcast) {
            return res.status(200).json({ success: true, ignored: true, reason: 'broadcast_ignored' });
        }

        if (!phone && !contactName) {
            return res.status(200).json({
                success: false,
                message: 'Evento recebido, mas sem número ou nome de contato identificável.',
                receivedKeys: Object.keys(body)
            });
        }

        // Grava o último evento no Firestore para diagnóstico em tempo real no Portal
        fetch(`${FIRESTORE_BASE_URL}/settings/wascript_last_webhook?key=${FIRESTORE_API_KEY}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    timestamp: { stringValue: eventRecord.timestamp },
                    phone: { stringValue: phone || '' },
                    contactName: { stringValue: contactName || '' },
                    incomingEtiqueta: { stringValue: String(incomingEtiqueta || '') },
                    incomingText: { stringValue: incomingText || '' },
                    rawJson: { stringValue: JSON.stringify(body).slice(0, 1500) }
                }
            })
        }).catch(() => {});

        const cfg = await getPortalWascriptConfig();
        const activeToken = cfg.token || DEFAULT_WASCRIPT_TOKEN;

        // 2. FILTRO DE LISTA NEGRA (BLACKLIST)
        if (isContactBlacklisted(phone, contactName, cfg.blacklist)) {
            console.log(`🚫 [Bloqueado pela Lista Negra]: "${contactName}" (${phone})`);
            if (incomingText) {
                await saveChatMessageToFirestore({ phone, contactName, role: 'cliente', text: incomingText });
            }
            return res.status(200).json({
                success: true,
                ignored: true,
                reason: 'contact_blacklisted',
                contact: contactName || phone
            });
        }

        // 3. FILTRO DE CLIENTES ATIVOS DA AGÊNCIA (Não criar lead de prospecção)
        const isClient = await isExistingAgencyClient(phone, contactName, incomingEtiqueta);
        if (isClient && cfg.ignoreExistingClients !== false) {
            console.log(`ℹ️ [Cliente Existente da Agência]: "${contactName}" (${phone}) - Mensagem registrada no chat sem abrir novo lead.`);
            if (incomingText) {
                await saveChatMessageToFirestore({ phone, contactName, role: 'cliente', text: incomingText });
            }
            return res.status(200).json({
                success: true,
                isClient: true,
                message: 'Mensagem do cliente ativo registrada no chat.',
                phone,
                contactName
            });
        }

        // ====================================================================
        // CASO A: EVENTO DE ETIQUETA / CRM (OU CONTATO COM ETIQUETA DEFINIDA)
        // ====================================================================
        const mappedColFromLabel = mapEtiquetaToColumn(incomingEtiqueta, cfg.labelMapping);
        if (incomingEtiqueta && (!incomingText || eventType.toLowerCase().includes('etiqueta') || eventType.toLowerCase().includes('crm') || eventType.toLowerCase().includes('label'))) {
            const targetCol = mappedColFromLabel || 'Prospecção';
            const notesText = `Sincronizado do WhatsApp (Etiqueta: ${incomingEtiqueta})`;

            await saveLeadToFirestore({
                phone,
                name: contactName,
                status: targetCol,
                notes: notesText,
                lastMessage: incomingText,
                etiqueta: incomingEtiqueta
            });

            return res.status(200).json({
                success: true,
                event: 'etiqueta_update',
                phone,
                contactName,
                etiqueta: incomingEtiqueta,
                columnMovedTo: targetCol
            });
        }

        // Se a mensagem foi enviada pelo próprio usuário (fromMe), apenas registra no histórico
        if (isFromMe && incomingText) {
            const cleanIncoming = incomingText.trim();
            const recent = phone ? await getRecentConversationHistory(phone) : [];
            // Se o WaScript marcou fromMe mas o texto é exatamente uma mensagem recente do cliente, é falso fromMe / eco de evento!
            const isClientEcho = recent.slice(-5).some(m => m.role === 'cliente' && m.text.trim() === cleanIncoming);
            if (isClientEcho) {
                console.log(`ℹ️ [Eco fromMe descartado]: webhook marcou fromMe mas texto é do cliente: "${cleanIncoming.slice(0, 30)}..."`);
                return res.status(200).json({ success: true, ignored: true, reason: 'client_echo_from_me' });
            }

            await saveChatMessageToFirestore({
                phone,
                contactName,
                role: 'ia',
                text: cleanIncoming
            });
            return res.status(200).json({
                success: true,
                event: 'outgoing_message_logged',
                phone,
                contactName
            });
        }

        // ====================================================================
        // CASO B: MENSAGEM RECEBIDA DO CLIENTE -> SALVAR CHAT + FILTRO IA GEMINI + AUTO-RESPOSTA
        // ====================================================================
        if (incomingText) {
            await saveChatMessageToFirestore({
                phone,
                contactName,
                role: 'cliente',
                text: incomingText
            });
        }

        // 4. MÁQUINA DE ESTADOS E INTELIGÊNCIA ARTIFICIAL CONVERSACIONAL (v4.0)
        const session = await getOrCreateSession(phone, contactName);
        session.lastCustomerMessage = incomingText || '';
        session.lastMessageReceivedAt = new Date().toISOString();
        session.lastMessageRole = 'cliente';

        const history = phone ? await getRecentConversationHistory(phone) : [];

        let qualification = null;

        // Se o usuário configurou chave do Gemini, chama Gemini com o contexto da sessão
        if (cfg.geminiApiKey) {
            qualification = await callRealGeminiAI({
                apiKey: cfg.geminiApiKey,
                systemPrompt: cfg.systemPrompt,
                contactName,
                cleanPhone: phone,
                incomingText: incomingText || 'Olá',
                history,
                isKnownLead: Boolean(session.turnCount > 0)
            });
        }

        // Se Gemini não estiver configurado ou não retornou objeto com replyMessages, usa o Motor de Decisão Inteligente
        if (!qualification || (!qualification.replyMessages && !qualification.replyMessage)) {
            qualification = await processIntelligentConversation({
                token: activeToken,
                phone,
                contactName,
                incomingText,
                session,
                cfg,
                history
            });
        }

        // 5. TRATAMENTO DE CONTATO PESSOAL / AMIGO / FAMÍLIA
        if (qualification.isPersonal || session.isPersonal) {
            session.isPersonal = true;
            session.state = 'PESSOAL';
            await saveSession(session);

            // Garante que a etiqueta PESSOAL (ID 10) está aplicada no WhatsApp
            await modifyWaScriptLabels({
                token: activeToken,
                phone,
                addLabelIds: ['10'],
                removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
            });

            // Remove do Kanban para não poluir esteira comercial
            await deleteLeadFromFirestore(`lead_wa_${phone}`);

            if (qualification.shouldAutoReply && qualification.replyMessages && qualification.replyMessages.length > 0) {
                console.log(`👤 [Aviso Pessoal Enviado] Para ${phone}: "Assunto pessoal identificado"`);
                sendHumanizedWhatsAppReply({
                    token: activeToken,
                    phone,
                    messages: qualification.replyMessages,
                    contactName,
                    delaySeconds: 5,
                    stage: 'PESSOAL'
                }).catch(() => {});
            }

            return res.status(200).json({
                success: true,
                isCommercialLead: false,
                isPersonal: true,
                reason: 'personal_contact_isolated',
                message: 'Contato pessoal identificado e etiquetado como PESSOAL (ID 10). Bot silenciado.'
            });
        }

        // 6. TRATAMENTO DE CONTATO EMPRESARIAL / COMERCIAL
        const finalStage = mappedColFromLabel || qualification.recommendedStage || 'Prospecção';

        await saveLeadToFirestore({
            phone,
            name: contactName || qualification.leadName,
            status: finalStage,
            notes: qualification.internalNote || qualification.qualificationSummary || incomingText || 'Oportunidade WhatsApp',
            value: qualification.estimatedMonthlyValue || 3500,
            lastMessage: incomingText,
            etiqueta: incomingEtiqueta
        });

        // Se detectou agendamento de Reunião ou Gravação, cria o compromisso
        if (cfg.autoScheduleEnabled && qualification.detectedSchedule && qualification.detectedSchedule.hasSchedule) {
            const sched = qualification.detectedSchedule;
            if (sched.scheduleType === 'reuniao') {
                const meetId = 'meet_wa_' + Date.now();
                const meetFields = {
                    fields: {
                        id: { stringValue: meetId },
                        title: { stringValue: sched.title || `Reunião Comercial - ${contactName || phone}` },
                        date: { stringValue: sched.date || new Date().toISOString().split('T')[0] },
                        time: { stringValue: sched.time || '14:00' },
                        link: { stringValue: sched.notes || `Agendada via WhatsApp (${phone})` },
                        phone: { stringValue: phone || '' },
                        createdByAi: { booleanValue: true },
                        createdAt: { stringValue: new Date().toISOString() }
                    }
                };
                await Promise.allSettled([
                    fetch(`${FIRESTORE_BASE_URL}/reunioes/${meetId}?key=${FIRESTORE_API_KEY}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meetFields) }),
                    fetch(`${FIRESTORE_BASE_URL}/meetings/${meetId}?key=${FIRESTORE_API_KEY}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meetFields) })
                ]);
            } else if (sched.scheduleType === 'gravacao') {
                const taskId = 'task_wa_' + Date.now();
                const taskFields = {
                    fields: {
                        id: { stringValue: taskId },
                        title: { stringValue: sched.title || `Gravação Audiovisual - ${contactName || phone}` },
                        type: { stringValue: 'cap_presencial' },
                        dateRec: { stringValue: sched.date || new Date().toISOString().split('T')[0] },
                        timeRec: { stringValue: sched.time || '10:00' },
                        desc: { stringValue: `<p><strong>Gravação agendada via WhatsApp IA</strong></p><p>Contato: ${contactName || ''} (${phone || ''})</p><p>${sched.notes || incomingText}</p>` },
                        column: { stringValue: 'col-todo' },
                        isCompleted: { booleanValue: false },
                        isArchived: { booleanValue: false },
                        createdByAi: { booleanValue: true },
                        updatedAt: { stringValue: new Date().toISOString() }
                    }
                };
                await fetch(`${FIRESTORE_BASE_URL}/tasks/${taskId}?key=${FIRESTORE_API_KEY}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskFields) });
            }
        }

        // 7. RESPONDER NO WHATSAPP COM CADÊNCIA HUMANIZADA (20 a 30s) E DIVISÃO EM 2 MENSAGENS
        const messagesToDispatch = prepareMessagesToDispatch(qualification, cfg);
        const delaySec = Number(cfg.responseDelaySeconds !== undefined ? cfg.responseDelaySeconds : 20);

        const shouldAutoReply = Boolean(
            cfg.autoReplyEnabled !== false &&
            cfg.replyMode !== 'kanban_only' &&
            qualification.shouldAutoReply !== false &&
            messagesToDispatch.length > 0 &&
            incomingText &&
            activeToken &&
            phone &&
            !session.isPersonal
        );

        if (shouldAutoReply) {
            console.log(`🤖 [Auto-Resposta Empresarial Agendada] Para ${phone}: ${messagesToDispatch.length} mensagens com delay de ${delaySec}s...`);

            session.lastMessageRole = 'ia';
            session.lastMessageSentAt = new Date().toISOString();
            session.followUpStep = 0;
            await saveSession(session);

            sendHumanizedWhatsAppReply({
                token: activeToken,
                phone: phone,
                messages: messagesToDispatch,
                contactName: contactName || qualification.leadName,
                delaySeconds: delaySec,
                stage: finalStage
            }).catch(sendErr => {
                console.warn('⚠️ Erro ao enviar mensagem humanizada via WaScript API:', sendErr.message);
            });

            // Cria nota no WaScript e no CRM
            const noteText = qualification.internalNote || (qualification.qualificationSummary ? `📌 ${qualification.qualificationSummary}` : '');
            if (noteText && cfg.autoNoteSyncEnabled !== false) {
                createWaScriptNote({
                    token: activeToken,
                    phone: phone,
                    text: noteText
                }).catch(err => console.warn('⚠️ Erro ao criar nota no WaScript:', err.message));
            }
        }

        return res.status(200).json({
            success: true,
            event: 'commercial_lead_qualified',
            phone,
            contactName: contactName || qualification.leadName,
            status: finalStage,
            sessionState: session.state,
            isCommercialLead: true,
            filterReason: qualification.filterReason,
            autoReplyScheduled: shouldAutoReply,
            messagesCount: messagesToDispatch.length,
            delaySeconds: delaySec,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error('❌ [Erro no Webhook 24/7]:', err);
        return res.status(500).json({ error: err.message });
    }
});

function runQualificationHeuristics(contactName, msg, todayStr, isKnownLead = false) {
    const raw = (msg || '').trim();
    const lower = raw.toLowerCase();
    let stage = 'Prospecção';
    let val = 3500;
    let scheduleType = 'nenhum';
    let hasSchedule = false;
    let detectedDate = todayStr;
    let detectedTime = '14:00';

    // Saudações e contatos iniciais no WhatsApp
    const greetings = [
        'oi', 'ola', 'olá', 'opa', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'tudo bom',
        'como vai', 'fala', 'e ai', 'e aí', 'oie', 'salve', 'ajuda', 'informação', 'informacao', 'informações'
    ];
    const isGreeting = greetings.some(g => lower === g || lower.startsWith(g + ' ') || lower.startsWith(g + ',') || lower.startsWith(g + '!') || lower.includes(g));

    // Heurística de caráter comercial
    const commercialKeywords = [
        'proposta', 'orçamento', 'orcamento', 'valor', 'preço', 'preco', 'plano', 'serviço', 'servico',
        'tráfego', 'trafego', 'anúncio', 'anuncio', 'post', 'social media', 'reels', 'gravação', 'gravacao',
        'vídeo', 'video', 'captação', 'captacao', 'reunião', 'reuniao', 'agendar', 'fechar', 'contrato',
        'empresa', 'negócio', 'negocio', 'clínica', 'clinica', 'loja', 'parceria', 'marketing', 'agência', 'agencia',
        'quanto', 'como funciona', 'quero', 'preciso', 'gostaria'
    ];
    const hasCommercialKw = commercialKeywords.some(kw => lower.includes(kw));

    const followUpKeywords = ['sim', 'pode ser', 'combinado', 'ok', 'beleza', 'vamos', 'perfeito', 'ótimo', 'otimo', 'tenho interesse', 'claro'];
    const isFollowUp = followUpKeywords.some(kw => lower === kw || lower.startsWith(kw + ' ') || lower.includes(kw));

    // Qualquer mensagem de quem já é lead, ou saudação, ou palavra comercial, ou resposta curta é um lead comercial!
    const isCommercialLead = Boolean(isKnownLead || isGreeting || hasCommercialKw || isFollowUp || lower.length >= 10);

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

    const isVideoInterest = lower.includes('gravação') || lower.includes('gravacao') || lower.includes('gravar') || lower.includes('vídeo') || lower.includes('video') || lower.includes('captação') || lower.includes('captacao') || lower.includes('reels');
    const isTrafegoInterest = lower.includes('tráfego') || lower.includes('trafego') || lower.includes('anúncio') || lower.includes('anuncio') || lower.includes('lead') || lower.includes('vendas');

    let replyMessages = [];
    let internalNote = '';

    if (isVideoInterest) {
        stage = 'Qualificado';
        val = 3800;
        replyMessages = [
            `Show de bola${contactName ? ', ' + contactName : ''}! A produção audiovisual e posicionamento em vídeo é justamente um dos nossos carros-chefe aqui na Capital Marketing 🎬`,
            `Para eu entender o formato ideal para o seu projeto: qual é o segmento do seu negócio e vocês buscam mais vídeos curtos para Reels/Instagram ou vídeos institucionais?`
        ];
        internalNote = `Interesse identificado: Produção Audiovisual / Vídeos. Aguardando nicho e formato desejado.`;
    } else if (isTrafegoInterest) {
        stage = 'Qualificado';
        val = 3500;
        replyMessages = [
            `Excelente${contactName ? ', ' + contactName : ''}! Gestão de tráfego pago e captação de clientes qualificados é a nossa principal especialidade de performance 🚀`,
            `Me conta um pouquinho: qual é o seu nicho de atuação e vocês já investem em anúncios hoje ou estão começando do zero?`
        ];
        internalNote = `Interesse identificado: Tráfego Pago / Performance. Aguardando histórico de anúncios e nicho.`;
    } else if (lower.includes('reunião') || lower.includes('reuniao') || lower.includes('call') || lower.includes('alinhamento') || lower.includes('agendar')) {
        hasSchedule = true;
        scheduleType = 'reuniao';
        stage = 'Qualificado';
        replyMessages = [
            `Combinado${contactName ? ', ' + contactName : ''}! 🤝`,
            `Nossa Reunião de Alinhamento Estratégico já está sendo registrada para o dia ${detectedDate.split('-').reverse().join('/')} às ${detectedTime}h. Você prefere que seja por Google Meet ou presencial em BH?`
        ];
        internalNote = `Reunião solicitada para ${detectedDate} às ${detectedTime}h.`;
    } else if (lower.includes('proposta') || lower.includes('orçamento') || lower.includes('orcamento') || lower.includes('valor') || lower.includes('preço') || lower.includes('plano')) {
        stage = 'Proposta Enviada';
        val = 3800;
        replyMessages = [
            `Perfeito${contactName ? ', ' + contactName : ''}! Nossos planos são totalmente personalizados de acordo com o porte e objetivo de cada cliente 💼`,
            `Para estruturarmos a proposta mais eficiente para você: me conta qual é o seu negócio e qual o principal canal que você quer acelerar agora?`
        ];
        internalNote = `Solicitou informações de planos/proposta. Coletando dados de escopo.`;
    } else if (lower.includes('fechar') || lower.includes('aprovado') || lower.includes('vamos fechar') || lower.includes('contrato')) {
        stage = 'Fechado';
        val = 4500;
        replyMessages = [
            `Seja muito bem-vindo(a) à Capital Marketing${contactName ? ', ' + contactName : ''}! 🎉`,
            `Já registrei sua aprovação em nosso sistema e nossa equipe entrará em contato para o onboarding e contrato!`
        ];
        internalNote = `Fechamento confirmado pelo cliente via WhatsApp.`;
    } else if (isFollowUp) {
        stage = 'Qualificado';
        replyMessages = [
            `Maravilha${contactName ? ', ' + contactName : ''}! 🤝`,
            `Já estou anotando tudo por aqui. Para estruturarmos uma proposta sob medida com nossos especialistas, qual seria o melhor dia e horário para um papo rápido de 15 minutos?`
        ];
        internalNote = `Lead confirmou interesse. Convidado para alinhamento comercial.`;
    } else {
        // Primeiro contato / saudação geral
        replyMessages = [
            `Olá${contactName ? ', ' + contactName : ''}! Tudo bem? Aqui é da equipe da Capital Marketing 👋`,
            `Recebemos sua mensagem! Me conta: qual é o segmento da sua empresa hoje e o que você gostaria de desenvolver conosco (tráfego pago, vídeos/reels ou posicionamento completo)?`
        ];
        internalNote = `Primeiro contato recebido. Aguardando informações sobre segmento e objetivo.`;
    }

    const reply = replyMessages.join('\n\n');

    return {
        isCommercialLead,
        shouldCreateLead: isCommercialLead,
        shouldAutoReply: Boolean(reply && isCommercialLead),
        filterReason: isCommercialLead ? (isGreeting ? 'Saudação / Primeiro Contato' : 'Interesse comercial identificado') : 'Mensagem sem termos comerciais claros',
        replyMessage: reply,
        replyMessages: replyMessages,
        internalNote: internalNote,
        leadName: contactName || '',
        recommendedStage: stage,
        estimatedMonthlyValue: val,
        qualificationSummary: `[Atendimento Consultivo WhatsApp] ${internalNote}`,
        detectedSchedule: {
            hasSchedule,
            scheduleType,
            title: scheduleType === 'gravacao' ? `Gravação Audiovisual - ${contactName || 'Cliente'}` : `Reunião Estratégica - ${contactName || 'Lead'}`,
            date: detectedDate,
            time: detectedTime,
            notes: msg
        }
    };
}

app.listen(PORT, () => {
    console.log(`🚀 [Capital Marketing] Webhook 24/7 WhatsApp AI v4.0 (Triagem + Sessões Inteligentes + Follow-up 5m/15m) rodando na porta ${PORT}`);
    startFollowUpWorker();
});

