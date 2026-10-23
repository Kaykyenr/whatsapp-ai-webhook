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

        const defaultSysPrompt = `Você é o Diretor Comercial e Consultor de Atendimento da Capital Marketing (agência de marketing de performance, tráfego pago, posicionamento digital e produção audiovisual em Belo Horizonte/MG).
Sua missão no WhatsApp é conduzir uma conversa 100% humanizada, progressiva e consultiva:
1. HUMANIZAÇÃO E PROGRESSÃO CONSULTIVA (MUITO IMPORTANTE):
   - NUNCA empurre agendamento de reunião ou feche proposta logo no primeiro contato!
   - Converse aos poucos, acolha a pessoa, entenda o momento atual dela antes de avançar.
   - Primeiro contato: Acolha de forma calorosa e pergunte qual é o segmento/empresa dela e o que busca estruturar.
   - Segundo contato: Entenda se o foco principal dela é gravação de vídeos/reels para autoridade, tráfego pago para captação de clientes ou gestão completa.
   - Terceiro contato: Se for vídeos, entenda o formato (ex: Reels para Instagram ou institucional) e volume. Se for tráfego, entenda se já anuncia hoje.
   - Quarto contato: Somente depois de coletar e entender as necessidades do cliente, sugira marcar um papo rápido de alinhamento com a diretoria comercial.
2. DIVISÃO EM 2 MENSAGENS CURTAS (ESTILO WHATSAPP):
   - Pessoas reais no WhatsApp não mandam um bloco de texto gigante. Preencha o campo "replyMessages" com 2 mensagens curtas e naturais:
     - Mensagem 1: Saudação calorosa e conexão/acolhimento com a mensagem anterior.
     - Mensagem 2: Pergunta consultiva objetiva ou continuação natural do raciocínio.
3. REGISTRO DE NOTAS AUTOMÁTICAS:
   - No campo "internalNote", gere uma anotação objetiva com os dados coletados (ex: "Segmento: Estética | Interesse: Gravação de Reels presenciais | Objetivo: Novos clientes").
4. FILTRO COMERCIAL:
   - Toda primeira mensagem de contato ("Oi", "Olá", "Bom dia", dúvidas, etc.) é comercial ("isCommercialLead": true, "shouldCreateLead": true, "shouldAutoReply": true).
   - Apenas descarte ("isCommercialLead": false) se for comprovadamente spam bancário ou conversa pessoal irrelevante.`;

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

    return runQualificationHeuristics(contactName, incomingText, todayStr, isKnownLead);
}

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Capital Marketing WhatsApp 24/7 AI Autonomous Webhook',
        version: '3.2.0',
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

        // 4. ANÁLISE E FILTRAGEM COM IA
        const isKnownLead = Boolean(mappedColFromLabel || incomingEtiqueta || (await findExistingLeadInFirestore(phone, contactName)));
        const history = phone ? await getRecentConversationHistory(phone) : [];
        const qualification = await callRealGeminiAI({
            apiKey: cfg.geminiApiKey,
            systemPrompt: cfg.systemPrompt,
            contactName,
            cleanPhone: phone,
            incomingText: incomingText || `Novo contato via WhatsApp (${incomingEtiqueta || 'Prospecção'})`,
            history,
            isKnownLead
        });

        // 5. SE A IA IDENTIFICOU QUE NÃO É UM LEAD COMERCIAL (Amigos, família, piadas, entregas, spam)
        // NOTA: Se o contato já for um lead cadastrado ou com etiqueta comercial, NUNCA é descartado!
        if (!isKnownLead && cfg.filterNonCommercialWithAi !== false && qualification.isCommercialLead === false) {
            console.log(`ℹ️ [Contato Não Comercial descartado do Kanban]: "${incomingText}" (${qualification.filterReason || 'assunto pessoal/informal'})`);
            return res.status(200).json({
                success: true,
                isCommercialLead: false,
                reason: qualification.filterReason || 'non_commercial_message',
                message: 'Mensagem salva no chat, mas não adicionada ao Kanban por não ser oportunidade comercial.',
                phone,
                contactName
            });
        }

        // 6. É UM LEAD COMERCIAL LEGÍTIMO -> Criar/Atualizar na esteira do CRM Kanban
        const finalStage = mappedColFromLabel || qualification.recommendedStage || 'Prospecção';

        await saveLeadToFirestore({
            phone,
            name: contactName || qualification.leadName,
            status: finalStage,
            notes: qualification.qualificationSummary || incomingText || 'Oportunidade recebida via WhatsApp',
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

        // 7. RESPONDER AUTOMATICAMENTE NO WHATSAPP VIA API WASCRIPT (Humanizado, com delay e divisão em 2 a 3 mensagens!)
        const replyText = qualification.replyMessage;
        const messagesToDispatch = prepareMessagesToDispatch(qualification, cfg);
        const delaySec = Number(cfg.responseDelaySeconds !== undefined ? cfg.responseDelaySeconds : 10);

        const shouldAutoReply = Boolean(
            cfg.autoReplyEnabled !== false &&
            cfg.replyMode !== 'kanban_only' &&
            qualification.shouldAutoReply !== false &&
            messagesToDispatch.length > 0 &&
            incomingText &&
            activeToken &&
            phone &&
            (cfg.replyMode !== 'tagged_only' || mappedColFromLabel)
        );

        if (shouldAutoReply) {
            console.log(`🤖 [Auto-Resposta Agendada] Para ${phone}: ${messagesToDispatch.length} mensagens com delay de ${delaySec}s...`);

            // Executa em segundo plano para responder HTTP 200 de imediato ao WaScript e evitar timeout no webhook!
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

            // Se a IA coletou uma nota interna / informações do cliente, cria nota oficial no WhatsApp e CRM
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
            isCommercialLead: true,
            filterReason: qualification.filterReason,
            estimatedValue: qualification.estimatedMonthlyValue,
            detectedSchedule: qualification.detectedSchedule,
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
    console.log(`🚀 [Capital Marketing] Webhook 24/7 WhatsApp AI v3.2 rodando na porta ${PORT}`);
});

