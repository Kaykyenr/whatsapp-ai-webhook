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

const PERSONAL_LABEL_IDS = new Set(['10', '26']);

/**
 * Identifica se uma etiqueta ou nome é indicativo de contato pessoal
 */
function isPersonalLabelOrName(val) {
    if (!val) return false;
    const raw = String(val).trim();
    if (PERSONAL_LABEL_IDS.has(raw)) return true;
    const clean = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (/\b(pessoal|particular|amor da minha vida|familia|familiar|amigo|amiga|namorada|namorado|esposa|esposo|mae|pai|irmao|irma|caroco de abacate|vai casar|noiva|noivo|casamento|tia|tio|prima|primo|vo|vovo)\b/i.test(clean)) {
        return true;
    }
    return false;
}

/**
 * Identifica se a mensagem é um comando direto para o robô parar / sair / calar
 */
function isBotStopCommand(text) {
    if (!text) return false;
    const clean = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const stopRegexes = [
        /\b(sai|saaa+i)\s+(daqui\s+)?(robo|bot|ia)\b/i,
        /\b(sai\s+daqui|para\s+robo|chega\s+robo)\b/i,
        /\b(desobedecendo|nao\s+pode\s+responder|proibido\s+responder)\b/i,
        /\b(para\s+de\s+responder|pare\s+de\s+responder|deixa\s+de\s+responder)\b/i,
        /\b(nao\s+responde\s+mais|nao\s+fala\s+comigo|cala\s+a\s+boca|cala\s+boca)\b/i,
        /\b(fica\s+quiet[ao]|silencio\s+robo|desliga\s+robo|desativar?\s+robo)\b/i
    ];
    return stopRegexes.some(rx => rx.test(clean));
}

/**
 * Identifica conteúdo tipicamente pessoal/doméstico ou resposta indicando assunto pessoal na triagem
 */
function isPersonalContent(text) {
    if (!text) return false;
    const clean = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const patterns = [
        /\b(esqueci\s+de\s+pagar|conta\s+de\s+luz|pagar\s+a\s+luz|aluguel|comprar\s+pao|supermercado|farmacia)\b/i,
        /\b(vestido|shein|look|sapato|maquiagem|unha)\b/i,
        /\b(amor|vida|meu bem|beijo|beijos|saudade|saudades|lindo|linda|querido|querida|fofa|fofo)\b/i,
        /\b(churrasco|cerveja|balada|cinema|vamos\s+sair|almoco|jantar\s+em\s+casa|em\s+casa|jogar\s+bola|futebol)\b/i,
        /\b(mae|pai|irmao|irma|primo|prima|tio|tia|filho|filha|sogro|sogra|cunhad[ao]|namorad[ao]|espos[ao])\b/i,
        /\b(assunto\s+pessoal|assunto\s+particular|e\s+pessoal|e\s+particular|no\s+particular|no\s+pessoal|falar\s+no\s+pessoal)\b/i,
        /\b(sou\s+amig[ao]|amig[ao]\s+dele|amig[ao]\s+do\s+kayky|conhecid[ao]\s+dele|colega\s+dele|parente\s+dele)\b/i,
        /\b(nao\s+tenho\s+empresa|nao\s+e\s+empresa|nao\s+e\s+sobre\s+empresa|nao\s+e\s+comercial|outro\s+assunto)\b/i,
        /\b(vou\s+passar\s+seu\s+contato|sou\s+o\s+fotografo|fotos?\s+do\s+casamento|vai\s+casar)\b/i,
        /^(pessoal|particular|amigo|amiga|familia|outro assunto)$/i
    ];
    return patterns.some(rx => rx.test(clean));
}

/**
 * Avaliação unificada se um contato deve ser considerado pessoal
 */
function isStrictPersonalContact({ phone, contactName, incomingEtiqueta, allEtiquetas = [], session = null }) {
    if (session && (session.isPersonal || session.state === 'PESSOAL')) return true;
    if (isPersonalLabelOrName(incomingEtiqueta)) return true;
    if (allEtiquetas.some(isPersonalLabelOrName)) return true;
    if (isPersonalLabelOrName(contactName)) return true;
    return false;
}

// ============================================================================
// FILA DE DEBOUNCE E CONCORRÊNCIA ANTI-FLOOD POR TELEFONE
// ============================================================================
const messageBuffers = new Map(); // phone -> { timer, messages: [], contactName, incomingEtiqueta, allEtiquetas, cfg, activeToken }
const processingPhones = new Set(); // phone -> lock de execução
const DEBOUNCE_WAIT_MS = 6000; // 6 segundos de silêncio para consolidar mensagens

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
        if (cleanPhone) {
            const directRes = await fetch(`${FIRESTORE_BASE_URL}/leads/lead_wa_${encodeURIComponent(cleanPhone)}?key=${FIRESTORE_API_KEY}`);
            if (directRes.ok) {
                const doc = await directRes.json();
                const f = doc.fields || {};
                const rawVal = Number((f.value && (f.value.integerValue || f.value.doubleValue || f.value.stringValue)) || 0);
                return {
                    id: `lead_wa_${cleanPhone}`,
                    name: f.name && f.name.stringValue,
                    status: f.status && f.status.stringValue,
                    value: rawVal === 3500 ? 0 : rawVal,
                    notes: f.notes && f.notes.stringValue
                };
            }
        }
        const res = await fetch(`${FIRESTORE_BASE_URL}/leads?key=${FIRESTORE_API_KEY}&pageSize=150`);
        if (!res.ok) return null;
        const data = await res.json();
        const docs = data.documents || [];
        for (const doc of docs) {
            const f = doc.fields || {};
            const docId = doc.name.split('/').pop();
            const lPhone = normalizePhone(f.phone && f.phone.stringValue);
            const lName = (f.name && f.name.stringValue || '').trim().toLowerCase();
            const rawVal = Number((f.value && (f.value.integerValue || f.value.doubleValue || f.value.stringValue)) || 0);
            if (cleanPhone && lPhone && lPhone === cleanPhone) {
                return {
                    id: docId,
                    name: f.name && f.name.stringValue,
                    status: f.status && f.status.stringValue,
                    value: rawVal === 3500 ? 0 : rawVal,
                    notes: f.notes && f.notes.stringValue
                };
            }
            if (contactName && lName && lName === contactName.trim().toLowerCase()) {
                return {
                    id: docId,
                    name: f.name && f.name.stringValue,
                    status: f.status && f.status.stringValue,
                    value: rawVal === 3500 ? 0 : rawVal,
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
 * Grava ou atualiza o Lead no Firestore (SEM valor fictício obrigatório; value padrão = 0)
 */
async function saveLeadToFirestore({ phone, name, status, notes, value = 0, lastMessage = '', etiqueta = '' }) {
    try {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone && !name) return null;

        const existing = await findExistingLeadInFirestore(cleanPhone, name);
        const leadId = existing ? existing.id : ('lead_wa_' + (cleanPhone || Date.now()));
        const finalName = name || (existing && existing.name) || `Contato WhatsApp (${cleanPhone.slice(-4)})`;
        const finalStatus = status || (existing && existing.status) || 'Prospecção';
        const passedVal = Number(value) || 0;
        const finalValue = passedVal > 0 ? Math.round(passedVal) : Math.round(Number((existing && existing.value) || 0));
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
        console.log(`✅ [Firestore Lead] ${leadId} (${finalName}) -> Coluna: "${finalStatus}" | Valor: R$ ${finalValue}`);
        return { leadId, finalName, finalStatus, finalValue, data };
    } catch (err) {
        console.error('❌ Erro ao gravar Lead no Firestore:', err.message);
        return null;
    }
}

/**
 * Busca o histórico recente da conversa daquele telefone de forma direta O(1) via sessão
 * (evita perder o histórico quando whatsapp_messages tem centenas de documentos de outros números)
 */
async function getRecentConversationHistory(cleanPhone) {
    if (!cleanPhone) return [];
    try {
        const sess = await getOrCreateSession(cleanPhone, '');
        if (sess && Array.isArray(sess.history) && sess.history.length > 0) {
            return sess.history.slice(-18);
        }
    } catch (_) {}

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
        return list.slice(-18);
    } catch (_) {
        return [];
    }
}

/**
 * Salva mensagem recebida/enviada na coleção whatsapp_messages E dentro da sessão do contato (O(1))
 * Com deduplicação inteligente e prevenção de eco
 */
async function saveChatMessageToFirestore({ phone, contactName, role, text, stage = '' }) {
    try {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone || !text || !text.trim()) return;

        const cleanText = text.trim();
        const session = await getOrCreateSession(cleanPhone, contactName);
        const recent = Array.isArray(session.history) ? session.history : [];

        if (recent.length > 0) {
            const last = recent[recent.length - 1];
            if (role === 'ia' && last.role === 'cliente' && last.text.trim() === cleanText) {
                console.log(`ℹ️ [Eco descartado]: não salva como IA texto do cliente ("${cleanText.slice(0, 30)}...")`);
                return;
            }
            if (last.text.trim() === cleanText && last.role === role) {
                console.log(`ℹ️ [Duplicata descartada]: "${cleanText.slice(0, 30)}..."`);
                return;
            }
            const matchedClientMsg = recent.slice(-5).find(m => m.role === 'cliente' && m.text.trim() === cleanText);
            if (role === 'ia' && matchedClientMsg) {
                console.log(`ℹ️ [Eco descartado nos últimos 5]: não salva como IA texto do cliente ("${cleanText.slice(0, 30)}...")`);
                return;
            }
        }

        const nowIso = new Date().toISOString();
        const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

        // Atualiza imediatamente o histórico O(1) dentro da sessão do telefone
        if (!Array.isArray(session.history)) session.history = [];
        session.history.push({
            role,
            text: cleanText,
            timestamp: timeStr,
            createdAt: nowIso
        });
        if (session.history.length > 24) {
            session.history = session.history.slice(-24);
        }
        await saveSession(session);

        const msgId = `msg_${cleanPhone}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const url = `${FIRESTORE_BASE_URL}/whatsapp_messages/${encodeURIComponent(msgId)}?key=${FIRESTORE_API_KEY}`;

        const body = {
            fields: {
                id: { stringValue: msgId },
                phone: { stringValue: cleanPhone },
                contactName: { stringValue: contactName || session.contactName || `Lead ${cleanPhone.slice(-4)}` },
                role: { stringValue: role },
                text: { stringValue: cleanText },
                stage: { stringValue: stage || '' },
                timestamp: { stringValue: timeStr },
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
    return msgs.slice(0, 2);
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
 * Usado para aplicar Etiqueta "PESSOAL" (ID 10), "LEAD EM TRATATIVA" (ID 14), etc., com retry automático
 */
async function modifyWaScriptLabels({ token, phone, addLabelIds = [], removeLabelIds = [] }) {
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || !token) return null;

    const actions = [];
    addLabelIds.filter(Boolean).forEach(id => actions.push({ labelId: String(id), type: 'add' }));
    removeLabelIds.filter(Boolean).forEach(id => actions.push({ labelId: String(id), type: 'remove' }));

    if (actions.length === 0) return null;

    const endpoint = `${WASCRIPT_BASE_URL}/api/modificar-etiquetas/${encodeURIComponent(token)}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: cleanPhone,
                    actions: actions
                })
            });
            const data = await res.json();
            console.log(`🏷️ [Etiquetas WaScript (tentativa ${attempt})] ${cleanPhone} ações:`, actions, data);
            if (res.ok && data && data.success !== false) {
                return data;
            }
            if (attempt === 1) {
                await new Promise(r => setTimeout(r, 2500));
            }
        } catch (err) {
            console.warn(`⚠️ Erro ao modificar etiquetas no WaScript (tentativa ${attempt}):`, err.message);
            if (attempt === 1) {
                await new Promise(r => setTimeout(r, 2500));
            }
        }
    }
    return null;
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
        if (contactName && !activeSessions[cleanPhone].contactName) {
            activeSessions[cleanPhone].contactName = contactName;
        }
        return activeSessions[cleanPhone];
    }
    try {
        const res = await fetch(`${FIRESTORE_BASE_URL}/whatsapp_sessions/${encodeURIComponent(cleanPhone)}?key=${FIRESTORE_API_KEY}`);
        if (res.ok) {
            const data = await res.json();
            const f = data.fields || {};
            let parsedHistory = [];
            try {
                if (f.historyJson && f.historyJson.stringValue) {
                    parsedHistory = JSON.parse(f.historyJson.stringValue);
                }
            } catch (_) { parsedHistory = []; }

            const session = {
                phone: cleanPhone,
                contactName: (f.contactName && f.contactName.stringValue) || contactName || '',
                state: (f.state && f.state.stringValue) || 'TRIAGEM',
                isPersonal: Boolean(f.isPersonal && f.isPersonal.booleanValue),
                personalMessageDispatched: Boolean(f.personalMessageDispatched && f.personalMessageDispatched.booleanValue),
                companyName: (f.companyName && f.companyName.stringValue) || '',
                businessCategory: (f.businessCategory && f.businessCategory.stringValue) || '',
                businessObjective: (f.businessObjective && f.businessObjective.stringValue) || '',
                adsMaturity: (f.adsMaturity && f.adsMaturity.stringValue) || '',
                turnCount: parseInt((f.turnCount && (f.turnCount.integerValue || f.turnCount.stringValue)) || '0', 10),
                followUpStep: parseInt((f.followUpStep && (f.followUpStep.integerValue || f.followUpStep.stringValue)) || '0', 10),
                lastMessageReceivedAt: (f.lastMessageReceivedAt && f.lastMessageReceivedAt.stringValue) || new Date().toISOString(),
                lastMessageSentAt: (f.lastMessageSentAt && f.lastMessageSentAt.stringValue) || '',
                lastMessageRole: (f.lastMessageRole && f.lastMessageRole.stringValue) || '',
                lastCustomerMessage: (f.lastCustomerMessage && f.lastCustomerMessage.stringValue) || '',
                notes: (f.notes && f.notes.stringValue) || '',
                history: Array.isArray(parsedHistory) ? parsedHistory : []
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
        companyName: '',
        businessCategory: '',
        businessObjective: '',
        adsMaturity: '',
        turnCount: 0,
        followUpStep: 0,
        lastMessageReceivedAt: new Date().toISOString(),
        lastMessageSentAt: '',
        lastMessageRole: '',
        lastCustomerMessage: '',
        notes: '',
        history: []
    };
    activeSessions[cleanPhone] = newSession;
    return newSession;
}

async function saveSession(session) {
    if (!session || !session.phone) return;
    activeSessions[session.phone] = session;

    try {
        const url = `${FIRESTORE_BASE_URL}/whatsapp_sessions/${encodeURIComponent(session.phone)}?key=${FIRESTORE_API_KEY}`;
        const historyJsonStr = JSON.stringify(Array.isArray(session.history) ? session.history.slice(-24) : []);
        const body = {
            fields: {
                phone: { stringValue: session.phone },
                contactName: { stringValue: session.contactName || '' },
                state: { stringValue: session.state || 'TRIAGEM' },
                isPersonal: { booleanValue: Boolean(session.isPersonal) },
                personalMessageDispatched: { booleanValue: Boolean(session.personalMessageDispatched) },
                companyName: { stringValue: session.companyName || '' },
                businessCategory: { stringValue: session.businessCategory || '' },
                businessObjective: { stringValue: session.businessObjective || '' },
                adsMaturity: { stringValue: session.adsMaturity || '' },
                turnCount: { integerValue: String(session.turnCount || 0) },
                followUpStep: { integerValue: String(session.followUpStep || 0) },
                lastMessageReceivedAt: { stringValue: session.lastMessageReceivedAt || new Date().toISOString() },
                lastMessageSentAt: { stringValue: session.lastMessageSentAt || '' },
                lastMessageRole: { stringValue: session.lastMessageRole || '' },
                lastCustomerMessage: { stringValue: session.lastCustomerMessage || '' },
                notes: { stringValue: session.notes || '' },
                historyJson: { stringValue: historyJsonStr },
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
 * Extrai fatos comerciais da mensagem e do histórico e salva na sessão para NUNCA repetir perguntas:
 * - companyName (ex: "HC Imóveis")
 * - businessCategory (ex: "Imobiliária", "Climatização", "Estética", etc.)
 * - businessObjective (ex: "Estrutura completa (Tráfego + Vídeos)", "Produção de Vídeos", "Tráfego Pago")
 * - adsMaturity (ex: "Já investe em Google e Meta", "Começando do zero")
 */
function extractAndPersistConversationFacts(session, text, history = []) {
    if (!session) return;
    const allTexts = [
        ...(history || []).filter(m => m.role === 'cliente').map(m => m.text || ''),
        text || ''
    ];

    for (const rawMsg of allTexts) {
        const raw = (rawMsg || '').trim();
        if (!raw) continue;
        const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // 1. Segmento / Nicho e Nome da Empresa
        if (/\b(imoveis|imovel|imobiliaria|corretor|corretores|loteamento|construtora|locacao)\b/i.test(lower)) {
            session.businessCategory = 'Imobiliária / Ramo Imobiliário';
            const compMatch = raw.match(/^([A-Za-zÀ-ÿ0-9\s&.-]{2,35}?)(?:,|\s+-\s+|\s+ramo|\s+setor)/i);
            if (compMatch && compMatch[1] && compMatch[1].trim().length >= 2) {
                session.companyName = compMatch[1].trim();
            } else if (/hc\s+im[oó]veis/i.test(raw)) {
                session.companyName = 'HC Imóveis';
            }
        } else if (/\b(climatizaca|climatizacao|ar\s*condicionado|refrigeraca|refrigeracao|manutencao|instalacao|chiller|split)\b/i.test(lower)) {
            session.businessCategory = 'Climatização e Serviços Técnicos';
        } else if (/\b(estetica|clinica|odonto|dentista|medico|dermatologista|harmonizacao|saude|nutri|salao|beleza)\b/i.test(lower)) {
            session.businessCategory = 'Saúde / Estética / Clínica';
        } else if (/\b(advocacia|advogado|juridico|escritorio|contabilidade|contador|engenharia|arquitetura)\b/i.test(lower)) {
            session.businessCategory = 'Serviços Profissionais / Consultoria';
        } else if (/\b(restaurante|hamburgueria|pizzaria|delivery|gastronomia|bar|cafeteria|alimentacao|supermercado)\b/i.test(lower)) {
            session.businessCategory = 'Gastronomia / Alimentação';
        } else if (/\b(loja|ecommerce|e-commerce|varejo|atacado|moda|roupa|calcados|acessorios|oficina|concessionaria|veiculos|carros)\b/i.test(lower)) {
            session.businessCategory = 'Comércio / Varejo';
        }

        // 2. Objetivo / Foco ("Estrutura completa", "Os dois", "Vídeos", "Tráfego Pago")
        if (/\b(estrutura\s+completa|completa|completo|os\s+dois|as\s+duas|ambos|ambas|tudo|trafego\s+e\s+video|video\s+e\s+trafego)\b/i.test(lower)) {
            session.businessObjective = 'Estrutura Completa (Tráfego Pago + Produção Audiovisual)';
        } else if (!session.businessObjective && /\b(trafego|trafego\s+pago|anuncios?|captar\s+clientes|captacao|leads|vender\s+mais)\b/i.test(lower)) {
            session.businessObjective = 'Tráfego Pago e Captação de Leads';
        } else if (!session.businessObjective && /\b(videos?|producao|audiovisual|reels|gravacao|filmagens?|posicionamento)\b/i.test(lower)) {
            session.businessObjective = 'Produção de Vídeos e Posicionamento';
        }

        // 3. Maturidade em Anúncios ("Google e Meta", "Google", "Meta", "Já investimos", "Do zero")
        if (/\b(google\s+e\s+meta|meta\s+e\s+google|nos\s+dois|nas\s+duas|google\s*,\s*meta|ja\s+investimos|ja\s+anunciamos|ja\s+rodamos|ja\s+fazemos|google\s+ads|meta\s+ads|facebook\s+ads|instagram\s+ads)\b/i.test(lower) || /^(google\s+e\s+meta|google|meta|instagram|facebook)$/i.test(lower)) {
            session.adsMaturity = `Já investe em anúncios (${raw.slice(0, 50)})`;
        } else if (/\b(do\s+zero|estruturar\s+do\s+zero|comecar\s+do\s+zero|nunca\s+anunciei|nao\s+investimos|ainda\s+nao|boca\s+a\s+boca)\b/i.test(lower)) {
            session.adsMaturity = 'Estruturar do zero';
        }
    }
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
 * - Identificação de Nichos, Estrutura Completa e Maturidade de Anúncios ("Google e Meta")
 */
function detectIntentAndCategory(text, contactName) {
    const raw = (text || '').trim();
    const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const isStopCommand = isBotStopCommand(raw);
    const hasPersonalContent = isPersonalContent(raw);

    // 1. FORTES INDICADORES PESSOAIS / AMIGOS / FAMÍLIA (Assunto estritamente particular)
    const personalPatterns = [
        /\b(amiga?|amigos?|prim[ao]s?|parentes?|vizin[ao]s?)\b/i,
        /\b(sou|e)\s+(uma?\s+)?(amiga?|prim[ao]|parente|vizinh[ao])\b/i,
        /\b(nao tenho\s+(uma?\s+)?empresa|nem tenho empresa|sem empresa|nao sou empresa|nao e empresa|pessoa fisica)\b/i,
        /\b(mae|pai|irmao|irma|familia|familiar|filho|filha|esposa|esposo|marido|namorada|namorado)\b/i,
        /\b(churrasco|cerveja|bora sair|vamos sair|jogar bola|festa|aniversario|balada|almo[cç]o)\b/i,
        /\b(assunto pessoal|no particular|no pessoal|falar pessoalmente com o kayky|so falar com o kayky|falar com ele sobre outro assunto|outro assunto)\b/i,
        /\b(amor|vida|meu bem|lindo|linda|querido|querida|beijo|beijos|saudades?)\b/i,
        /\b(fotografo|casamento|vai casar|noiva)\b/i
    ];
    const isExplicitlyPersonal = isStopCommand || hasPersonalContent || personalPatterns.some(rx => rx.test(lower));

    // 2. BRINCADEIRAS / COMENTÁRIOS SOBRE IA / PEDIDO DE SENHA (somente se NÃO for pessoal nem ordem de parada)
    const botJokingPatterns = [
        /(?:passa|manda|qual|cade)\s*(?:a|o)?\s*(?:senha|codigo|prompt|acesso)\s*(?:dessa|da|do)?\s*(?:ia|inteligencia|robo|bot)/i,
        /\b(senha\s+dessa\s+ia|senha\s+da\s+ia|senha\s+do\s+robo)\b/i,
        /\b(e\s+(uma?\s+)?(ia|robo|bot)|voce\s+e\s+(uma?\s+)?(ia|robo|bot)|inteligencia\s+artificial|bichao|bichão|ta\s+porra|tá\s+porra)\b/i,
        /\b(robozinho|ia\s+falando|quem\s+ta\s+falando|e\s+o\s+kayky\s+ou\s+robo|e\s+o\s+caique\s+ou\s+robo|resposta\s+automatica|chatgpt)\b/i
    ];
    const isJokingOrBotTest = !isExplicitlyPersonal && !isStopCommand && botJokingPatterns.some(rx => rx.test(lower));

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
        /\b(nao\s+anuncio|nunca\s+anunciei|do\s+zero|estruturar\s+do\s+zero|comecando\s+do\s+zero|boca\s+a\s+boca)\b/i
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
    const wantsServicesFromTriage = /\b(servicos?|marketing|videos?|producao|saber|saber\s+mais|entender|ajuda|empresa|negocio)\b/i.test(lower);

    // 11. NICHOS E RESPOSTAS DE FOCO / PLATAFORMA DE ANÚNCIOS
    const isClimatizacao = /\b(climatizaca|climatizacao|climatizacoes|climatizar|ar\s*condicionado|refrigeraca|refrigeracao|refrigeracoes|manutenca|manutencao|manutencoes|instalaca|instalacao|instalacoes|chiller|split|tecnico)\b/i.test(lower);
    const isVideo = /\b(edica|edicao|edicoes|audiovisual|videos?|reels|grava|gravacao|gravacoes|filmagem|filmagens|estudio|produtora|cinema|camera)\b/i.test(lower);
    const isTrafego = /\b(trafego|trafego\s+pago|anuncio|anuncios|leads?|meta\s+ads|google\s+ads|instagram\s+ads|captar\s+clientes|escalar\s+vendas)\b/i.test(lower);
    const isHealthBeauty = /\b(estetica|clinica|clinicas|odonto|dentista|dentistas|medico|medicos|dermatologista|harmonizaca|harmonizacao|harmonizacoes|nutri|salao)\b/i.test(lower);
    const isRealEstate = /\b(imoveis|imovel|imobiliaria|corretor|corretores|loteamento|construtora|locacao)\b/i.test(lower);

    // 12. ESCOLHA DE FOCO ("Estrutura completa", "Os dois", "Ambos") E PLATAFORMA ("Google e Meta", "Google", "Meta")
    const isFullStructureChoice = /\b(estrutura\s+completa|completa|completo|os\s+dois|as\s+duas|ambos|ambas|duas\s+frentes)\b/i.test(lower);
    const isAdsPlatformChoice = /\b(google\s+e\s+meta|meta\s+e\s+google|google|meta|instagram|facebook|ja\s+investimos|ja\s+anunciamos|ja\s+rodamos|do\s+zero|estruturar\s+do\s+zero)\b/i.test(lower);

    // 13. OBJETIVOS
    const wantsMoreLeads = /\b(mais\s+leads|captar\s+clientes|orcamentos|novos\s+clientes|vender\s+mais|gerar\s+leads|clientes|captacao|gestao|vendas)\b/i.test(lower);
    const wantsAuthority = /\b(autoridade|posicionamento|branding|presenca\s+digital|seguidores|engajamento)\b/i.test(lower);

    // 14. SAUDAÇÕES SIMPLES
    const greetingWords = ['oi', 'ola', 'opa', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'fala', 'oie', 'salve', 'tudo bem', 'tudo joia', 'tudo bom', 'fechou', 'fechou meu caro', 'fala meu caro', 'fala chefe'];
    const isPureGreeting = greetingWords.some(w => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ',') || lower.startsWith(w + '!'));

    const isCommercial = Boolean(isVideo || isTrafego || isClimatizacao || isHealthBeauty || isRealEstate || isFullStructureChoice || isAdsPlatformChoice || wantsMoreLeads || wantsAuthority || isAskingPricing || isAskingExperienceOrPortfolio || wantsServicesFromTriage || /\b(empresa|negocio|loja|marca|servico|orcamento|proposta)\b/i.test(lower));

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
        isFullStructureChoice,
        isAdsPlatformChoice,
        wantsMoreLeads,
        wantsAuthority,
        isCommercial,
        isPureGreeting
    };
}

/**
 * MOTOR INTELIGENTE DE CONVERSAÇÃO (v4.2 AUTÔNOMO SEM LOOPS)
 * Máquina de estados estritamente progressiva:
 * - Triagem inicial (Pessoal vs Comercial)
 * - Se pessoal: Etiqueta 10 (PESSOAL), notifica uma única vez, remove do Kanban e silencia
 * - Se comercial: Etiqueta 14 (LEAD EM TRATATIVA), extrai fatos e NUNCA repete perguntas já respondidas!
 *   Progressão linear:
 *   1. Coletar Empresa / Segmento (se ainda não tiver `session.businessCategory`)
 *   2. Coletar Foco / Escopo (Vídeos, Tráfego ou Estrutura Completa - se ainda não tiver `session.businessObjective`)
 *   3. Coletar Maturidade em Anúncios (Google/Meta ou do zero - se ainda não tiver `session.adsMaturity`)
 *   4. Convidar para Reunião de Alinhamento de 15 min (Google Meet ou Presencial em BH)
 *   5. Confirmar Reunião (`CONCLUIDO`, Etiqueta 18 `ALINHAMENTO`)
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
    extractAndPersistConversationFacts(session, incomingText, history);
    const intent = detectIntentAndCategory(incomingText, contactName);
    console.log(`🧠 [IA Decisão] Phone: ${phone} | Estado: "${session.state}" | Turno: ${session.turnCount} | Empresa: "${session.companyName || ''}" | Nicho: "${session.businessCategory || ''}" | Foco: "${session.businessObjective || ''}" | Ads: "${session.adsMaturity || ''}" | Pessoal: ${intent.isExplicitlyPersonal}`);

    // ========================================================================
    // CASO 1: CONTATO PESSOAL (Família / Amigo / Assunto Particular com Kayky)
    // ========================================================================
    const isPersonalRequestToKayky = intent.isRequestingKaykyDirect && !intent.isCommercial && !session.businessCategory;
    if (intent.isExplicitlyPersonal || isPersonalRequestToKayky || session.isPersonal || session.state === 'PESSOAL') {
        session.isPersonal = true;
        session.state = 'PESSOAL';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        await deleteLeadFromFirestore(`lead_wa_${phone}`);

        if (!session.personalMessageDispatched) {
            session.personalMessageDispatched = true;
            await saveSession(session);

            const pMsg1 = `Oi${contactName ? ', ' + contactName : ''}! Tudo bem? 😊`;
            const pMsg2 = `Já anotei aqui que é assunto pessoal e avisei o Kayky no particular para ele te responder assim que liberar das gravações, tá bom? 👋`;

            return {
                isCommercialLead: false,
                isPersonal: true,
                shouldAutoReply: true,
                replyMessages: [pMsg1, pMsg2],
                replyMessage: `${pMsg1}\n\n${pMsg2}`,
                recommendedStage: 'PESSOAL',
                internalNote: 'Contato pessoal/particular - etiqueta PESSOAL (10) aplicada e bot silenciado.'
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
    // CASO 2: RETORNO APÓS "AGUARDANDO RETORNO"
    // ========================================================================
    if (session.state === 'AGUARDANDO_RETORNO') {
        console.log(`🔄 [Retomada Inteligente] Cliente ${contactName || phone} retornou!`);
        session.followUpStep = 0;
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);
    }

    // ========================================================================
    // CASO 3: BRINCADEIRAS / COMENTÁRIOS SOBRE IA / PEDIDO DE SENHA
    // ========================================================================
    if (intent.isJokingOrBotTest) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.turnCount = Math.max(session.turnCount, 1);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const jMsg1 = `Haha, a senha é guardada a sete chaves! 🤖 Mas a tecnologia tá afiada justamente pra atender rápido e não deixar ninguém no vácuo.`;
        const jMsg2 = `Me conta: você fala em nome de alguma empresa e quer acelerar o marketing e os vídeos de vocês, ou é assunto pessoal com o Kayky?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [jMsg1, jMsg2],
            replyMessage: `${jMsg1}\n\n${jMsg2}`,
            recommendedStage: 'Prospecção',
            internalNote: 'Interagiu sobre a IA. Triagem comercial/pessoal enviada.'
        };
    }

    // ========================================================================
    // CASO 4: DÚVIDA / OBJEÇÃO SOBRE EXPERIÊNCIA, COMPROVAÇÃO E PORTFÓLIO
    // ========================================================================
    if (intent.isAskingExperienceOrPortfolio) {
        session.state = 'EMPRESARIAL_PROVANDO';
        session.turnCount = Math.max(session.turnCount, 3);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        let proofMsg1 = `Com certeza, faz total sentido você perguntar! A melhor forma de comprovar é mostrando os projetos que já colocamos pra rodar e os resultados gerados 🤝`;
        let proofMsg2 = `Nós estruturamos campanhas de tráfego pago de alta intenção no Google e Meta focadas em gerar oportunidades reais todos os dias, além de produção audiovisual com equipamentos de cinema e roteiro estratégico.\n\nConsigo te mandar aqui no WhatsApp alguns exemplos práticos de criativos e campanhas. Você quer que eu te encaminhe?`;

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
    // CASO 5: ESTÁ EM PROVANDO E O CLIENTE RESPONDEU AFIRMATIVAMENTE
    // ========================================================================
    if (session.state === 'EMPRESARIAL_PROVANDO' && intent.isAffirmative) {
        session.state = 'EMPRESARIAL_ALINHAMENTO';
        session.turnCount = Math.max(session.turnCount, 4);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const cMsg1 = `Maravilha${contactName ? ', ' + contactName : ''}! Já separei os materiais dos nossos projetos e cases pra você conferir 📁`;
        const cMsg2 = `Enquanto isso, você prefere reservar 15 minutinhos para bater um papo rápido com o Kayky pelo Google Meet ou presencial em BH para desenharmos o plano da sua empresa?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [cMsg1, cMsg2],
            replyMessage: `${cMsg1}\n\n${cMsg2}`,
            recommendedStage: 'Qualificado',
            internalNote: 'Material de cases solicitado. Sugerido alinhamento de 15 min.'
        };
    }

    // ========================================================================
    // CASO 6: DÚVIDA SOBRE PREÇO / VALORES
    // ========================================================================
    if (intent.isAskingPricing) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const prMsg1 = `Sobre os valores, nós montamos propostas sob medida porque cada operação tem uma necessidade diferente (volume de gravações, gestão de Google/Meta Ads, etc.) 💼`;
        const prMsg2 = session.businessCategory
            ? `Para montarmos o orçamento ideal para ${session.companyName || 'sua empresa'}: vocês preferem focar em tráfego pago, produção de vídeos ou na estrutura completa?`
            : `Para te passarmos uma estimativa certeira: qual é o segmento da sua empresa hoje e se o foco é tráfego pago, produção de vídeos ou a estrutura completa?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [prMsg1, prMsg2],
            replyMessage: `${prMsg1}\n\n${prMsg2}`,
            recommendedStage: 'Prospecção',
            internalNote: 'Pergunta sobre preço respondida. Qualificando escopo.'
        };
    }

    // ========================================================================
    // CASO 7: ESCOLHA DE MODALIDADE OU ACEITE DE REUNIÃO DE 15 MIN
    // ========================================================================
    if (intent.isMeetingModalOrTime || (session.state === 'EMPRESARIAL_ALINHAMENTO' && intent.isAffirmative && !intent.isAdsPlatformChoice)) {
        session.state = 'CONCLUIDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const schedDate = extractDateFromText(incomingText) || new Date().toISOString().split('T')[0];
        const schedTime = extractTimeFromText(incomingText) || '14:00';
        const isPresencial = /presencial|em\s+bh|no\s+escritorio/i.test(incomingText);
        const modalidade = isPresencial ? 'Presencial em BH' : 'Google Meet';

        const conf1 = `Sensacional${contactName ? ', ' + contactName : ''}! Combinado 🤝`;
        const conf2 = `Já deixei pré-agendado nosso alinhamento (${modalidade}) e passei todos os detalhes da ${session.companyName || session.businessCategory || 'sua empresa'} para o Kayky confirmar o horário com você. Qualquer dúvida estou por aqui!`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [conf1, conf2],
            replyMessage: `${conf1}\n\n${conf2}`,
            recommendedStage: 'Qualificado',
            recommendedLabelId: '18',
            internalNote: `Reunião solicitada/confirmada pelo cliente: ${modalidade}`,
            detectedSchedule: {
                hasSchedule: true,
                scheduleType: 'reuniao',
                title: `Alinhamento Comercial - ${session.companyName || contactName || phone} (${modalidade})`,
                date: schedDate,
                time: schedTime,
                notes: `Canal: ${modalidade} | Segmento: ${session.businessCategory || ''} | Foco: ${session.businessObjective || ''} | Ads: ${session.adsMaturity || ''}`
            }
        };
    }

    // ========================================================================
    // CASO 8: RECUSA DE REUNIÃO ("Prefiro por aqui", "Não quero call")
    // ========================================================================
    if (intent.isMeetingDeclined) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const dec1 = `Sem problemas, super compreensível! Conseguimos alinhar tudo por aqui pelo WhatsApp mesmo 👍`;
        const dec2 = `Já passei o resumo da ${session.companyName || 'sua empresa'} para o Kayky te enviar os formatos por aqui assim que finalizar a gravação atual!`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [dec1, dec2],
            replyMessage: `${dec1}\n\n${dec2}`,
            recommendedStage: 'Qualificado',
            internalNote: 'Cliente preferiu atendimento direto no WhatsApp.'
        };
    }

    // ========================================================================
    // CASO 9: PROGRESSÃO COMERCIAL LINEAR SEM LOOPS (BASEADA NOS FATOS JÁ COLETADOS!)
    // ========================================================================
    if (session.businessCategory && session.businessObjective && session.adsMaturity) {
        session.state = 'EMPRESARIAL_ALINHAMENTO';
        session.turnCount = Math.max(session.turnCount, 4);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const compLabel = session.companyName ? `da ${session.companyName}` : `da sua empresa`;
        const m1 = `Perfeito${contactName ? ', ' + contactName : ''}! Como vocês já têm presença em ${session.adsMaturity.replace(/^Já investe em anúncios\s*\(|\)$/g, '')}, conseguimos otimizar muito a qualidade dos leads e escalar a captação ${compLabel} com criativos em vídeo de alta conversão 🚀`;
        const m2 = `Para o Kayky te apresentar um diagnóstico prático e o plano ideal para vocês, podemos agendar um bate-papo rápido de 15 minutos pelo Google Meet ou presencial em BH? Qual dia e turno fica melhor para você?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Qualificado',
            recommendedLabelId: '14',
            internalNote: `Qualificação completa -> Empresa: ${session.companyName || 'N/A'} | Ramo: ${session.businessCategory} | Foco: ${session.businessObjective} | Anúncios: ${session.adsMaturity}`
        };
    }

    if (session.businessCategory && session.businessObjective && !session.adsMaturity) {
        session.state = 'EMPRESARIAL_MATURIDADE';
        session.turnCount = Math.max(session.turnCount, 3);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const compLabel = session.companyName ? `na ${session.companyName}` : `no negócio de vocês`;
        const m1 = `Perfeito${contactName ? ', ' + contactName : ''}! Unir ${session.businessObjective.toLowerCase()} é o caminho mais sólido para gerar demanda qualificada e autoridade ao mesmo tempo 🤝`;
        const m2 = `Para eu entender o momento atual ${compLabel}: vocês já investem em anúncios no Google ou Meta hoje, ou querem estruturar essa captação do zero?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Qualificado',
            recommendedLabelId: '14',
            internalNote: `Empresa: ${session.companyName || 'N/A'} | Ramo: ${session.businessCategory} | Foco: ${session.businessObjective}. Coletando maturidade de anúncios.`
        };
    }

    if (session.businessCategory && !session.businessObjective) {
        session.state = 'EMPRESARIAL_FOCO';
        session.turnCount = Math.max(session.turnCount, 2);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const compText = session.companyName ? `${session.companyName} (${session.businessCategory})` : session.businessCategory;
        const m1 = `Excelente${contactName ? ', ' + contactName : ''}! Muito bom conhecer a ${session.companyName || 'sua operação'} no setor de ${session.businessCategory.toLowerCase()} 🤝`;
        const m2 = `Hoje, para vocês, o foco principal está em produção de vídeos para posicionamento, tráfego pago para captação de clientes, ou uma estrutura completa com as duas frentes?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Qualificado',
            recommendedLabelId: '14',
            internalNote: `Segmento identificado: ${compText}. Perguntado foco principal.`
        };
    }

    if (session.businessObjective && !session.adsMaturity) {
        session.state = 'EMPRESARIAL_MATURIDADE';
        session.turnCount = Math.max(session.turnCount, 2);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const m1 = `Perfeito${contactName ? ', ' + contactName : ''}! A ${session.businessObjective.toLowerCase()} costuma ser o caminho ideal para dar tração sólida 🚀`;
        const m2 = `Para eu entender o momento da sua empresa: vocês já investem em anúncios no Google ou Meta hoje, ou estão querendo estruturar isso do zero?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Qualificado',
            recommendedLabelId: '14',
            internalNote: `Foco definido: ${session.businessObjective}. Perguntado sobre anúncios.`
        };
    }

    if (session.adsMaturity) {
        session.state = 'EMPRESARIAL_ALINHAMENTO';
        session.turnCount = Math.max(session.turnCount, 3);
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const m1 = `Excelente${contactName ? ', ' + contactName : ''}! Já anotei aqui que vocês atuam com ${session.adsMaturity.replace(/^Já investe em anúncios\s*\(|\)$/g, '')} 🚀`;
        const m2 = `Para o Kayky te apresentar nossa estrutura e desenharmos um plano sob medida, vamos marcar uma conversa rápida de 15 minutos pelo Google Meet ou presencial em BH?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Qualificado',
            recommendedLabelId: '14',
            internalNote: `Maturidade de anúncios: ${session.adsMaturity}. Convidado para call.`
        };
    }

    // ========================================================================
    // CASO 10: LEAD RESPONDEU À TRIAGEM QUERENDO CONHECER OS SERVIÇOS
    // ========================================================================
    if (session.state === 'AGUARDANDO_TRIAGEM' && (intent.isAffirmative || intent.wantsServicesFromTriage)) {
        session.state = 'EMPRESARIAL_QUALIFICANDO';
        session.turnCount = 2;
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const m1 = `Maravilha${contactName ? ', ' + contactName : ''}! Vai ser um prazer te apresentar como podemos acelerar seu negócio 💼`;
        const m2 = `Me conta: qual é o nome da sua empresa e qual o segmento de atuação de vocês hoje?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Prospecção',
            recommendedLabelId: '14',
            internalNote: 'Triagem comercial confirmada. Solicitado nome da empresa e segmento.'
        };
    }

    // ========================================================================
    // CASO 11: SE JÁ PERGUNTOU NOME DA EMPRESA NO TURNO ANTERIOR E O CLIENTE RESPONDEU O NOME/RAMO LIVREMENTE
    // ========================================================================
    if (session.turnCount >= 1 && !intent.isPureGreeting && incomingText.trim().length >= 3) {
        session.businessCategory = incomingText.trim().slice(0, 60);
        session.state = 'EMPRESARIAL_FOCO';
        session.turnCount += 1;
        session.lastMessageReceivedAt = new Date().toISOString();
        await saveSession(session);

        const m1 = `Legal${contactName ? ', ' + contactName : ''}! Muito bom conhecer mais sobre a operação de vocês (${session.businessCategory}) 🤝`;
        const m2 = `Para vocês hoje, o foco maior está em produção de vídeos para posicionamento, tráfego pago para captação, ou uma estrutura completa com as duas frentes?`;

        return {
            isCommercialLead: true,
            shouldAutoReply: true,
            replyMessages: [m1, m2],
            replyMessage: `${m1}\n\n${m2}`,
            recommendedStage: 'Qualificado',
            recommendedLabelId: '14',
            internalNote: `Empresa/Ramo informado: "${session.businessCategory}". Perguntado foco.`
        };
    }

    // ========================================================================
    // CASO 12: SAUDAÇÃO INICIAL / PRIMEIRO CONTATO (TRIAGEM CLARA ENTRE COMERCIAL E PESSOAL)
    // ========================================================================
    session.state = 'AGUARDANDO_TRIAGEM';
    session.turnCount = 1;
    session.lastMessageReceivedAt = new Date().toISOString();
    await saveSession(session);

    const gMsg1 = `Olá${contactName ? ', ' + contactName : ''}! Tudo bem por aí? 👋`;
    const gMsg2 = `Pra eu te direcionar certinho por aqui: você fala em nome de alguma empresa (qual o nome e segmento?) ou gostaria de falar sobre um assunto pessoal com o Kayky?`;

    return {
        isCommercialLead: false,
        isTriage: true,
        shouldAutoReply: true,
        replyMessages: [gMsg1, gMsg2],
        replyMessage: `${gMsg1}\n\n${gMsg2}`,
        recommendedStage: 'Prospecção',
        recommendedLabelId: '13',
        internalNote: 'Primeiro contato recebido. Triagem inicial (Empresa vs Pessoal) enviada.'
    };
}

let followUpWorkerInterval = null;

/**
 * Worker em segundo plano que:
 * 1. Mantém o servidor Render acordado 24/7 (self-ping a cada 5 minutos para evitar hibernação após 15 min)
 * 2. Monitora silêncio prolongado de forma não-intrusiva (apenas após 120 minutos sem resposta em qualificação ativa)
 */
function startFollowUpWorker() {
    if (followUpWorkerInterval) return;
    console.log('⏱️ [Worker 24/7] Keep-alive anti-hibernação + monitor de silêncio iniciado.');

    followUpWorkerInterval = setInterval(async () => {
        try {
            const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
            fetch(`${selfUrl}/`).catch(() => {});

            const now = Date.now();
            const cfg = await getPortalWascriptConfig();
            const token = cfg.token || DEFAULT_WASCRIPT_TOKEN;
            if (!token) return;

            for (const [phone, sess] of Object.entries(activeSessions)) {
                if (sess.isPersonal || sess.state === 'PESSOAL' || sess.state === 'CONCLUIDO' || sess.state === 'AGUARDANDO_TRIAGEM') continue;
                if (!sess.state || !sess.state.startsWith('EMPRESARIAL_')) continue;
                if (sess.lastMessageRole !== 'ia') continue;

                const lastSentTime = sess.lastMessageSentAt ? new Date(sess.lastMessageSentAt).getTime() : 0;
                if (!lastSentTime) continue;

                const diffMinutes = (now - lastSentTime) / (1000 * 60);

                if (diffMinutes >= 120 && sess.followUpStep === 0) {
                    sess.followUpStep = 2;
                    sess.state = 'AGUARDANDO_RETORNO';
                    await saveSession(sess);

                    await modifyWaScriptLabels({
                        token,
                        phone,
                        addLabelIds: ['17'],
                        removeLabelIds: ['13', '14']
                    });
                }
            }
        } catch (workerErr) {
            console.warn('Aviso no worker 24/7:', workerErr.message);
        }
    }, 5 * 60 * 1000);
}

/**
 * Envia resposta humanizada no WhatsApp via WaScript:
 * - Aguarda delay configurável simulando leitura e digitação humana
 * - Divide a resposta em 2 mensagens curtas e espaçadas (estilo WhatsApp natural)
 */
async function sendHumanizedWhatsAppReply({ token, phone, messages, contactName, delaySeconds = 10, stage = '' }) {
    if (!token || !phone || !messages || messages.length === 0) return;

    if (delaySeconds > 0) {
        console.log(`⏳ [Delay Humanizado]: aguardando ${delaySeconds}s antes de enviar resposta para ${phone}...`);
        await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || !msg.trim()) continue;

        if (i > 0) {
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
 * Analisa se o contato é comercial legítimo ou pessoal, e garante progressão linear SEM LOOPS!
 */
async function callRealGeminiAI({ apiKey, systemPrompt, contactName, cleanPhone, incomingText, history, session = null, isKnownLead = false }) {
    const todayStr = new Date().toISOString().split('T')[0];

    if (apiKey) {
        const historyFormatted = (history || [])
            .map(m => `${m.role === 'cliente' ? 'Cliente' : 'Capital Marketing'}: ${m.text}`)
            .join('\n');

        const knownFactsSummary = session ? [
            session.companyName ? `- Nome da Empresa já informado: "${session.companyName}" (PROIBIDO perguntar o nome da empresa novamente!)` : '',
            session.businessCategory ? `- Segmento/Ramo já informado: "${session.businessCategory}" (PROIBIDO perguntar o segmento/ramo de atuação novamente!)` : '',
            session.businessObjective ? `- Foco/Escopo já escolhido: "${session.businessObjective}" (PROIBIDO perguntar se prefere vídeos, tráfego ou estrutura completa novamente!)` : '',
            session.adsMaturity ? `- Maturidade em Anúncios já informada: "${session.adsMaturity}" (PROIBIDO perguntar se já investe em Google/Meta novamente! Convide para call de 15 min!)` : ''
        ].filter(Boolean).join('\n') : '';

        const nextStepInstruction = (() => {
            if (!session) return 'Descubra se fala em nome de uma empresa (nome e segmento) ou se é assunto pessoal com o Kayky.';
            if (session.businessCategory && session.businessObjective && session.adsMaturity) {
                return 'PRÓXIMO PASSO OBRIGATÓRIO: Você já tem Empresa/Ramo, Foco e Maturidade de Anúncios! Valide a resposta do cliente e convide para um bate-papo rápido de 15 minutos com o Kayky (Google Meet ou presencial em BH), perguntando qual dia/turno fica melhor.';
            }
            if (session.businessCategory && session.businessObjective && !session.adsMaturity) {
                return 'PRÓXIMO PASSO OBRIGATÓRIO: Você já sabe a empresa/ramo e que o foco é "' + session.businessObjective + '". Agora pergunte APENAS se eles já investem em anúncios no Google ou Meta hoje ou se querem estruturar isso do zero. NÃO pergunte o nome da empresa nem o segmento de novo!';
            }
            if (session.businessCategory && !session.businessObjective) {
                return 'PRÓXIMO PASSO OBRIGATÓRIO: Você já sabe a empresa/ramo (' + session.businessCategory + '). Agora pergunte se o foco principal hoje é produção de vídeos para posicionamento, tráfego pago para captação, ou uma estrutura completa com as duas frentes.';
            }
            return 'Se for o primeiro contato ("Oi", "Olá", "Boa tarde"), acolha com simpatia e pergunte se fala em nome de alguma empresa (qual o nome e segmento) ou se é assunto pessoal com o Kayky.';
        })();

        const defaultSysPrompt = `Você é o Consultor Comercial e Concierge de Atendimento da Capital Marketing (agência de marketing de performance, tráfego pago, posicionamento digital e produção audiovisual em Belo Horizonte e região).
Você atua no WhatsApp em nome do Kayky (Kayky Ribeiro) e da Capital Marketing.

SUA MISSÃO NO WHATSAPP É CONDUZIR UMA CONVERSA 100% INTELIGENTE, PROGRESSIVA E SEM LOOPS:
1. PROIBIÇÃO ABSOLUTA DE REPETIR PERGUNTAS (ANTI-LOOP):
   - Antes de formular sua pergunta, verifique o Histórico e os FATOS JÁ COLETADOS NA SESSÃO abaixo.
   - Se o cliente já disse o nome da empresa e ramo (ex: "HC imóveis, ramo imobiliário"), NUNCA mais pergunte o nome da empresa ou ramo!
   - Se o cliente já escolheu "Estrutura completa", "Vídeos" ou "Tráfego", avance para perguntar se já investem em Google/Meta Ads hoje ou querem estruturar do zero.
   - Se o cliente já respondeu "Google e Meta", "Já investimos" ou "Do zero", avance convidando para uma rápida reunião de alinhamento de 15 minutos (Google Meet ou presencial em BH).

2. DISTINÇÃO CLARA ENTRE CONTATO PESSOAL (ETIQUETA 10) E LEAD COMERCIAL (ETIQUETA 14):
   - Se o contato disser que é assunto pessoal, amigo, família, casamento, fotógrafo, não tem empresa, ou quer falar com o Kayky sobre assunto particular:
     Defina OBRIGATORIAMENTE "isCommercialLead": false, "isPersonal": true.
   - Se for lead comercial qualificando empresa/negócio:
     Defina OBRIGATORIAMENTE "isCommercialLead": true, "isPersonal": false.
   - Sobre "estimatedMonthlyValue": defina sempre 0 (zero) por padrão, a menos que um valor específico em reais tenha sido acordado na conversa.

3. NUNCA INVENTE OU CONFIRME REUNIÃO SEM ACEITE EXPLÍCITO:
   - Só marque "detectedSchedule.hasSchedule": true se o cliente aceitar expressamente a reunião ou informar modalidade/dia/horário.

4. FORMATO DAS MENSAGENS (ESTILO WHATSAPP):
   - Divida SEMPRE no campo "replyMessages" em 2 mensagens curtas e naturais:
     - Mensagem 1: Conexão calorosa validando exatamente o que o cliente acabou de responder.
     - Mensagem 2: A pergunta consultiva do PRÓXIMO PASSO OBRIGATÓRIO.`;

        const strictSecurityRules = `
FATOS JÁ COLETADOS NESTA CONVERSA (PROIBIDO PERGUNTAR NOVAMENTE):
${knownFactsSummary || '- Nenhum fato comercial coletado ainda.'}

DIRETRIZ DO PRÓXIMO PASSO DESTE TURNO:
${nextStepInstruction}

REGRAS DE SEGURANÇA PARA CONTATOS PESSOAIS E ORDENS DE PARADA:
1. Se o contato mandar parar ("sai daqui robo", "para de responder", "desobedecendo"):
   Defina "isCommercialLead": false, "isPersonal": true, "shouldAutoReply": false, "replyMessages": [], "replyMessage": "".
2. Se o contato revelar que é amigo, familiar ou assunto particular/pessoal com o Kayky:
   Defina "isCommercialLead": false, "isPersonal": true, "shouldCreateLead": false.`;

        const promptText = `${defaultSysPrompt}
${systemPrompt ? '\nInstruções adicionais configuradas: ' + systemPrompt : ''}

${strictSecurityRules}

Data de hoje: ${todayStr}
Contato no WhatsApp: ${contactName || 'Contato'} (${cleanPhone})
Histórico recente da conversa:
${historyFormatted || '(Início da conversa)'}

Nova mensagem recebida do contato: "${incomingText}"

Retorne APENAS um objeto JSON válido com a seguinte estrutura:
{
  "isCommercialLead": true,
  "isPersonal": false,
  "shouldCreateLead": true,
  "shouldAutoReply": true,
  "filterReason": "motivo claro da classificação",
  "replyMessage": "sua resposta de vendas consultiva completa",
  "replyMessages": [
    "primeira mensagem curta e calorosa validando a resposta do cliente",
    "segunda mensagem com a pergunta progressiva (sem repetir perguntas anteriores)"
  ],
  "internalNote": "resumo objetivo do que o cliente respondeu neste turno",
  "leadName": "nome do contato ou empresa identificada",
  "recommendedStage": "Prospecção" | "Qualificado" | "Proposta Enviada" | "Fechado",
  "estimatedMonthlyValue": 0,
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

        const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.5-flash-lite'];
        for (const modelName of modelsToTry) {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);
                const res = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: promptText }] }],
                        generationConfig: {
                            temperature: 0.2,
                            responseMimeType: 'application/json'
                        }
                    })
                });
                clearTimeout(timeoutId);

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
                        if (parsed && (parsed.replyMessage || (parsed.replyMessages && parsed.replyMessages.length > 0) || parsed.isCommercialLead !== undefined)) {
                            const combinedReply = ((parsed.replyMessages || []).join(' ') + ' ' + (parsed.replyMessage || '')).toLowerCase();
                            if (session && session.businessCategory && /qual\s+(?:é\s+|e\s+)?o\s+nome\s+da\s+sua\s+empresa|qual\s+(?:é\s+|e\s+)?o\s+segmento\s+de\s+atua/i.test(combinedReply)) {
                                console.warn(`🛡️ [Anti-Loop Ativado]: Gemini tentou repetir pergunta de empresa/segmento para ${cleanPhone}. Usando progressão determinística!`);
                                return null;
                            }
                            if (session && session.businessObjective && /foco\s+maior\s+est[aá]\s+em\s+produ[cç][aã]o\s+de\s+v[ií]deos.*ou\s+uma\s+estrutura\s+completa/i.test(combinedReply)) {
                                console.warn(`🛡️ [Anti-Loop Ativado]: Gemini tentou repetir pergunta de foco/estrutura para ${cleanPhone}. Usando progressão determinística!`);
                                return null;
                            }
                            console.log(`🤖 [Gemini AI (${modelName})] Qualificação: isCommercial=${parsed.isCommercialLead}, isPersonal=${parsed.isPersonal} (${parsed.filterReason || ''})`);
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
        version: '4.2.0',
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
                value: c.value !== undefined ? Number(c.value) : 0,
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
 * 4. Filtro de Intenção Comercial via IA Gemini (descarta conversas pessoais e aplica Etiqueta 10 PESSOAL)
 * 5. Auto-Resposta 100% Autônoma via API Oficial WaScript sem loops
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
        // CASO A: EVENTO EXCLUSIVO DE MUDANÇA DE ETIQUETA (QUANDO NÃO HÁ TEXTO DE MENSAGEM!)
        // ====================================================================
        const mappedColFromLabel = mapEtiquetaToColumn(incomingEtiqueta, cfg.labelMapping);
        if (incomingEtiqueta && !incomingText) {
            if (isPersonalLabelOrName(incomingEtiqueta) || String(incomingEtiqueta).trim() === '10') {
                await deleteLeadFromFirestore(`lead_wa_${phone}`);
                return res.status(200).json({
                    success: true,
                    event: 'personal_etiqueta_removed_from_crm',
                    phone,
                    etiqueta: incomingEtiqueta
                });
            }

            const targetCol = mappedColFromLabel || 'Prospecção';
            const notesText = `Sincronizado do WhatsApp (Etiqueta: ${incomingEtiqueta})`;

            await saveLeadToFirestore({
                phone,
                name: contactName,
                status: targetCol,
                notes: notesText,
                lastMessage: '',
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
        // CASO B: MENSAGEM RECEBIDA DO CLIENTE -> SALVAR CHAT + FILTRO PESSOAL + FILA ANTI-FLOOD
        // ====================================================================
        if (incomingText) {
            await saveChatMessageToFirestore({
                phone,
                contactName,
                role: 'cliente',
                text: incomingText
            });
        }

        const session = await getOrCreateSession(phone, contactName);
        session.lastCustomerMessage = incomingText || '';
        session.lastMessageReceivedAt = new Date().toISOString();
        session.lastMessageRole = 'cliente';

        // --------------------------------------------------------------------
        // FILTRO IMEDIATO 1: ORDEM DE PARADA / CRÍTICA AO ROBÔ ("sai daqui robo")
        // --------------------------------------------------------------------
        if (incomingText && isBotStopCommand(incomingText)) {
            console.log(`🛑 [Ordem de Parada]: Robô desativado imediatamente para "${contactName}" (${phone})`);
            session.isPersonal = true;
            session.personalMessageDispatched = true;
            session.state = 'PESSOAL';
            await saveSession(session);

            if (messageBuffers.has(phone)) {
                const b = messageBuffers.get(phone);
                if (b && b.timer) clearTimeout(b.timer);
                messageBuffers.delete(phone);
            }

            await modifyWaScriptLabels({
                token: activeToken,
                phone,
                addLabelIds: ['10'],
                removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
            });
            await deleteLeadFromFirestore(`lead_wa_${phone}`);

            return res.status(200).json({
                success: true,
                stopped: true,
                reason: 'bot_stop_command',
                message: 'Comando de parada recebido. Robô desligado e Etiqueta PESSOAL (10) aplicada.'
            });
        }

        // --------------------------------------------------------------------
        // FILTRO IMEDIATO 2: CONTATO PESSOAL JÁ IDENTIFICADO / ETIQUETA PESSOAL
        // --------------------------------------------------------------------
        const isStrictPersonal = isStrictPersonalContact({
            phone,
            contactName,
            incomingEtiqueta,
            allEtiquetas: extracted.allEtiquetas || [],
            session
        });

        if (isStrictPersonal) {
            session.isPersonal = true;
            session.state = 'PESSOAL';

            modifyWaScriptLabels({
                token: activeToken,
                phone,
                addLabelIds: ['10'],
                removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
            }).catch(() => {});
            deleteLeadFromFirestore(`lead_wa_${phone}`).catch(() => {});

            if (session.personalMessageDispatched) {
                console.log(`🤫 [Silêncio Absoluto]: Contato pessoal "${contactName}" (${phone}) já notificado. Nenhuma mensagem enviada.`);
                await saveSession(session);
                return res.status(200).json({
                    success: true,
                    ignored: true,
                    reason: 'personal_contact_silent',
                    message: 'Contato pessoal em silêncio absoluto.'
                });
            }

            session.personalMessageDispatched = true;
            await saveSession(session);

            const pMsg = `Oi${contactName ? ', ' + contactName : ''}! O Kayky está em gravações agora, mas já avisei ele no particular para te dar um retorno assim que liberar, tá bom? 👋`;
            console.log(`👤 [Aviso Único Pessoal Enviado] Para ${phone}: "${pMsg}"`);
            (async () => {
                await sendHumanizedWhatsAppReply({
                    token: activeToken,
                    phone,
                    messages: [pMsg],
                    contactName,
                    delaySeconds: 2,
                    stage: 'PESSOAL'
                });
                await new Promise(r => setTimeout(r, 1500));
                await modifyWaScriptLabels({
                    token: activeToken,
                    phone,
                    addLabelIds: ['10'],
                    removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
                });
            })().catch(() => {});

            return res.status(200).json({
                success: true,
                isPersonal: true,
                firstNoticeSent: true,
                message: 'Primeiro e único aviso pessoal enviado e Etiqueta PESSOAL (10) aplicada.'
            });
        }

        // --------------------------------------------------------------------
        // FILTRO IMEDIATO 3: CONTEÚDO RECONHECIDAMENTE PESSOAL NO TEXTO
        // --------------------------------------------------------------------
        if (incomingText && isPersonalContent(incomingText)) {
            console.log(`👤 [Conteúdo Pessoal no Texto]: "${incomingText}" de ${contactName} (${phone})`);
            session.isPersonal = true;
            session.state = 'PESSOAL';
            await deleteLeadFromFirestore(`lead_wa_${phone}`);

            if (!session.personalMessageDispatched) {
                session.personalMessageDispatched = true;
                await saveSession(session);

                const pMsg = `Oi${contactName ? ', ' + contactName : ''}! O Kayky está em gravações agora, mas já avisei ele no particular para te dar um retorno assim que liberar, tá bom? 👋`;
                (async () => {
                    await sendHumanizedWhatsAppReply({
                        token: activeToken,
                        phone,
                        messages: [pMsg],
                        contactName,
                        delaySeconds: 2,
                        stage: 'PESSOAL'
                    });
                    await new Promise(r => setTimeout(r, 1500));
                    await modifyWaScriptLabels({
                        token: activeToken,
                        phone,
                        addLabelIds: ['10'],
                        removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
                    });
                })().catch(() => {});
            } else {
                await saveSession(session);
                await modifyWaScriptLabels({
                    token: activeToken,
                    phone,
                    addLabelIds: ['10'],
                    removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
                });
            }

            return res.status(200).json({
                success: true,
                isPersonal: true,
                reason: 'personal_content_isolated',
                message: 'Assunto pessoal isolado e Etiqueta PESSOAL (10) aplicada.'
            });
        }

        // --------------------------------------------------------------------
        // FILTRO IMEDIATO 4: SE AUTO-RESPOSTA ESTIVER DESATIVADA GLOBALMENTE
        // --------------------------------------------------------------------
        if (cfg.autoReplyEnabled === false) {
            return res.status(200).json({
                success: true,
                autoReplyDisabled: true,
                message: 'Auto-resposta desativada no painel.'
            });
        }

        // --------------------------------------------------------------------
        // FILA DE DEBOUNCE E AGREGAÇÃO DE MENSAGENS COMERCIAIS
        // --------------------------------------------------------------------
        let buf = messageBuffers.get(phone);
        if (!buf) {
            buf = {
                phone,
                contactName,
                incomingEtiqueta,
                allEtiquetas: extracted.allEtiquetas || [],
                messages: [incomingText || ''],
                timer: null,
                cfg,
                activeToken
            };
            messageBuffers.set(phone, buf);
        } else {
            if (incomingText) buf.messages.push(incomingText);
            if (contactName && !buf.contactName) buf.contactName = contactName;
            if (incomingEtiqueta) buf.incomingEtiqueta = incomingEtiqueta;
            if (buf.timer) {
                clearTimeout(buf.timer);
                buf.timer = null;
            }
        }

        console.log(`📦 [Mensagem Enfileirada (${buf.messages.length})]: De ${contactName || phone} - aguardando ${DEBOUNCE_WAIT_MS / 1000}s de silêncio para consolidar...`);

        buf.timer = setTimeout(() => {
            processAggregatedMessagesForPhone(phone).catch(err => {
                console.error(`❌ Erro no processamento agregado para ${phone}:`, err);
            });
        }, DEBOUNCE_WAIT_MS);

        return res.status(200).json({
            success: true,
            queued: true,
            queueLength: buf.messages.length,
            message: 'Mensagem recebida e agrupada na fila com sucesso.'
        });

    } catch (err) {
        console.error('❌ [Erro no Webhook 24/7]:', err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Processa mensagens agregadas após o período de debounce (6 segundos sem novas mensagens).
 * Garante uma única chamada à IA, progressão sem loops e aplicação confiável das etiquetas WaScript (10 Pessoal vs 14 Lead em Tratativa).
 */
async function processAggregatedMessagesForPhone(phone) {
    const buf = messageBuffers.get(phone);
    if (!buf) return;

    if (processingPhones.has(phone)) {
        console.log(`⏳ [Lock Ativo]: Telefone ${phone} já está em processamento. Reagendando para 4s...`);
        buf.timer = setTimeout(() => processAggregatedMessagesForPhone(phone), 4000);
        return;
    }

    processingPhones.add(phone);
    messageBuffers.delete(phone);

    try {
        const fullIncomingText = buf.messages.filter(Boolean).join('\n').trim();
        const contactName = buf.contactName;
        const incomingEtiqueta = buf.incomingEtiqueta;
        const activeToken = buf.activeToken;
        const cfg = buf.cfg || await getPortalWascriptConfig();

        console.log(`🚀 [Executando IA Consolidada] Telefone: ${phone} | Contato: "${contactName}" | Texto Consolidado (${buf.messages.length} msgs):\n"${fullIncomingText}"`);

        const session = await getOrCreateSession(phone, contactName);
        session.lastCustomerMessage = fullIncomingText;
        session.lastMessageReceivedAt = new Date().toISOString();
        session.lastMessageRole = 'cliente';

        const history = phone ? await getRecentConversationHistory(phone) : [];
        extractAndPersistConversationFacts(session, fullIncomingText, history);

        if (session.isPersonal || isBotStopCommand(fullIncomingText) || isPersonalContent(fullIncomingText)) {
            session.isPersonal = true;
            session.state = 'PESSOAL';
            await deleteLeadFromFirestore(`lead_wa_${phone}`);
            if (!session.personalMessageDispatched && !isBotStopCommand(fullIncomingText)) {
                session.personalMessageDispatched = true;
                await saveSession(session);
                const pMsg = `Oi${contactName ? ', ' + contactName : ''}! O Kayky está em gravações agora, mas já avisei ele no particular para te dar um retorno assim que liberar, tá bom? 👋`;
                await sendHumanizedWhatsAppReply({ token: activeToken, phone, messages: [pMsg], contactName, delaySeconds: 2, stage: 'PESSOAL' });
                await new Promise(r => setTimeout(r, 1200));
            } else {
                await saveSession(session);
            }
            await modifyWaScriptLabels({ token: activeToken, phone, addLabelIds: ['10'], removeLabelIds: ['13', '14', '15', '16', '17', '18', '20'] });
            return;
        }

        let qualification = null;
        const effectiveApiKey = cfg.geminiApiKey || ENV_GEMINI_API_KEY;
        const deterministicQualification = await processIntelligentConversation({
            token: activeToken,
            phone,
            contactName,
            incomingText: fullIncomingText,
            session,
            cfg,
            history
        });

        if (deterministicQualification && (deterministicQualification.isPersonal || session.businessCategory || session.businessObjective || session.adsMaturity || deterministicQualification.isTriage)) {
            qualification = deterministicQualification;
        } else if (effectiveApiKey) {
            qualification = await callRealGeminiAI({
                apiKey: effectiveApiKey,
                systemPrompt: cfg.systemPrompt,
                contactName,
                cleanPhone: phone,
                incomingText: fullIncomingText || 'Olá',
                history,
                session,
                isKnownLead: Boolean(session.turnCount > 0)
            });
        }

        if (!qualification || (!qualification.replyMessages && !qualification.replyMessage)) {
            qualification = deterministicQualification;
        }

        // ====================================================================
        // TRATAMENTO DE CONTATO PESSOAL DETECTADO (APLICA ETIQUETA 10 SEMPRE!)
        // ====================================================================
        if (qualification.isPersonal || session.isPersonal) {
            session.isPersonal = true;
            session.state = 'PESSOAL';
            await saveSession(session);
            await deleteLeadFromFirestore(`lead_wa_${phone}`);

            if (!session.personalMessageDispatched && qualification.shouldAutoReply && qualification.replyMessages && qualification.replyMessages.length > 0) {
                session.personalMessageDispatched = true;
                await saveSession(session);
                const safeMsgs = prepareMessagesToDispatch(qualification, cfg);
                await sendHumanizedWhatsAppReply({
                    token: activeToken,
                    phone,
                    messages: safeMsgs,
                    contactName,
                    delaySeconds: 2,
                    stage: 'PESSOAL'
                });
                await new Promise(r => setTimeout(r, 1200));
            } else {
                console.log(`🤫 [Silêncio Pessoal da IA]: Contato ${contactName || phone} classificado como pessoal. Aplicando Etiqueta 10 (PESSOAL).`);
            }

            await modifyWaScriptLabels({
                token: activeToken,
                phone,
                addLabelIds: ['10'],
                removeLabelIds: ['13', '14', '15', '16', '17', '18', '20']
            });
            return;
        }

        // ====================================================================
        // TRATAMENTO DE TRIAGEM INICIAL ("Oi", "Boa tarde") E LEAD COMERCIAL
        // ====================================================================
        const mappedColFromLabel = mapEtiquetaToColumn(incomingEtiqueta, cfg.labelMapping);
        const finalStage = mappedColFromLabel || qualification.recommendedStage || 'Prospecção';
        const targetLabelId = qualification.recommendedLabelId || (finalStage === 'Qualificado' ? '14' : '13');

        session.turnCount = (session.turnCount || 0) + 1;
        session.lastMessageSentAt = new Date().toISOString();
        session.lastMessageRole = 'ia';
        session.followUpStep = 0;
        await saveSession(session);

        if (qualification.isCommercialLead || session.businessCategory || session.businessObjective) {
            const leadDisplayName = session.companyName
                ? `${contactName || phone} - ${session.companyName}`
                : (contactName || qualification.leadName || phone);

            await saveLeadToFirestore({
                phone,
                name: leadDisplayName,
                status: finalStage,
                notes: qualification.internalNote || qualification.qualificationSummary || fullIncomingText,
                value: Number(qualification.estimatedMonthlyValue) > 0 ? Number(qualification.estimatedMonthlyValue) : 0,
                lastMessage: fullIncomingText,
                etiqueta: targetLabelId
            });
        }

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
                        desc: { stringValue: `<p><strong>Gravação agendada via WhatsApp IA</strong></p><p>Contato: ${contactName || ''} (${phone || ''})</p><p>${sched.notes || fullIncomingText}</p>` },
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

        const messagesToDispatch = prepareMessagesToDispatch(qualification, cfg);
        const delaySec = Number(cfg.responseDelaySeconds !== undefined ? cfg.responseDelaySeconds : 3);

        const shouldAutoReply = Boolean(
            cfg.autoReplyEnabled !== false &&
            cfg.replyMode !== 'kanban_only' &&
            qualification.shouldAutoReply !== false &&
            messagesToDispatch.length > 0 &&
            fullIncomingText &&
            activeToken &&
            phone &&
            !session.isPersonal
        );

        if (shouldAutoReply) {
            console.log(`🤖 [Auto-Resposta Consolidada] Enviando ${messagesToDispatch.length} mensagens para ${phone}...`);
            await sendHumanizedWhatsAppReply({
                token: activeToken,
                phone: phone,
                messages: messagesToDispatch,
                contactName: contactName || qualification.leadName,
                delaySeconds: delaySec,
                stage: finalStage
            });

            await new Promise(r => setTimeout(r, 1200));
            if (targetLabelId === '18') {
                await modifyWaScriptLabels({
                    token: activeToken,
                    phone,
                    addLabelIds: ['18'],
                    removeLabelIds: ['10', '13', '14', '17']
                });
            } else if (targetLabelId === '14' || qualification.isCommercialLead) {
                await modifyWaScriptLabels({
                    token: activeToken,
                    phone,
                    addLabelIds: ['14'],
                    removeLabelIds: ['10', '13', '17']
                });
            } else if (targetLabelId === '13') {
                await modifyWaScriptLabels({
                    token: activeToken,
                    phone,
                    addLabelIds: ['13'],
                    removeLabelIds: []
                });
            }

            const noteText = qualification.internalNote || (qualification.qualificationSummary ? `📌 ${qualification.qualificationSummary}` : '');
            if (noteText && cfg.autoNoteSyncEnabled !== false) {
                createWaScriptNote({
                    token: activeToken,
                    phone: phone,
                    text: noteText
                }).catch(err => console.warn('⚠️ Erro ao criar nota no WaScript:', err.message));
            }
        }

    } finally {
        processingPhones.delete(phone);
        if (messageBuffers.has(phone)) {
            const nextBuf = messageBuffers.get(phone);
            if (!nextBuf.timer) {
                nextBuf.timer = setTimeout(() => processAggregatedMessagesForPhone(phone), 3000);
            }
        }
    }
}

app.listen(PORT, () => {
    console.log(`🚀 [Capital Marketing] Webhook 24/7 WhatsApp AI v4.2 (Triagem + Anti-Loop + Etiqueta 10/14) rodando na porta ${PORT}`);
    startFollowUpWorker();
});
