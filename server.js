/**
 * FLOW WhatsApp Pairing Server
 * Deploy di Railway
 */

const crypto = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = crypto.webcrypto || crypto;
}
if (typeof global.crypto === 'undefined') {
    global.crypto = globalThis.crypto;
}

const express = require('express');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const sessions = {};

// Rate limit sederhana: 1 request per nomor per 60 detik
const rateLimit = {};
const RATE_LIMIT_MS = 60000;

// ============================================================
// BIKIN SESSION PAIRING (ANTI LOOP)
// ============================================================
async function createPairingSession(phone, username) {
    const sessionDir = path.join(__dirname, 'sessions', phone);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Safari'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 90000,
        defaultQueryTimeoutMs: 90000,
        emitOwnEvents: false,
        getMessage: async () => ({ conversation: '' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(`[${phone}] ✅ Connected to WhatsApp`);
            if (sessions[phone]) {
                sessions[phone].status = 'connected';
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'unknown';

            // Map status code ke penjelasan
            let reasonText = reason;
            if (statusCode === DisconnectReason.loggedOut) reasonText = 'Logged Out';
            else if (statusCode === 401) reasonText = 'Unauthorized';
            else if (statusCode === 428) reasonText = 'Connection Terminated (rate limit)';
            else if (statusCode === 440) reasonText = 'Conflict (paired elsewhere)';
            else if (statusCode === 500) reasonText = 'Server Error';
            else if (statusCode === 515) reasonText = 'Stream Error';

            console.log(`[${phone}] ❌ Connection closed. Code: ${statusCode} (${reasonText})`);

            if (sessions[phone]) {
                sessions[phone].status = 'offline';
                sessions[phone].lastError = reasonText;
            }

            // JANGAN auto-reconnect kalau:
            // - logged out
            // - rate limit (biar gak loop)
            // - konflik
            const DONT_RECONNECT = [
                DisconnectReason.loggedOut,
                401,  // unauthorized
                428,  // rate limit
                440,  // conflict
            ];

            const shouldReconnect = !DONT_RECONNECT.includes(statusCode);

            if (shouldReconnect && sessions[phone]) {
                console.log(`[${phone}] 🔄 Reconnecting in 5s...`);
                setTimeout(() => {
                    if (sessions[phone]) {
                        createPairingSession(phone, username).catch(err => {
                            console.error(`[${phone}] Reconnect error:`, err.message);
                        });
                    }
                }, 5000);
            } else {
                console.log(`[${phone}] 🚫 Not reconnecting (${reasonText})`);
                // JANGAN hapus session, biar kodenya masih bisa dipake
            }
        }
    });

    if (!sessions[phone]) {
        sessions[phone] = {
            sock,
            code: null,
            status: 'pending',
            username: username || 'unknown',
            createdAt: Date.now()
        };
    } else {
        sessions[phone].sock = sock;
        sessions[phone].status = 'pending';
    }

    if (!sock.authState.creds.registered) {
        await new Promise(r => setTimeout(r, 2000));

        try {
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            const code = await sock.requestPairingCode(cleanPhone);

            console.log(`[${phone}] 🔑 Pairing code: ${code}`);
            sessions[phone].code = code;
            sessions[phone].status = 'pending';

            return code;
        } catch (err) {
            console.error(`[${phone}] Gagal minta pairing code:`, err.message);
            throw err;
        }
    } else {
        sessions[phone].status = 'connected';
        return sessions[phone].code;
    }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'FLOW WhatsApp Pairing',
        nodeVersion: process.version,
        sessions: Object.keys(sessions).length,
        uptime: process.uptime()
    });
});

app.post('/pair', async (req, res) => {
    const { phone, username } = req.body || {};

    if (!phone) {
        return res.status(400).json({ error: 'phone wajib diisi' });
    }

    const cleanPhone = String(phone).replace(/[^0-9]/g, '');

    if (cleanPhone.length < 10) {
        return res.status(400).json({ error: 'Nomor tidak valid' });
    }

    // RATE LIMIT
    const now = Date.now();
    if (rateLimit[cleanPhone] && (now - rateLimit[cleanPhone]) < RATE_LIMIT_MS) {
        const waitSec = Math.ceil((RATE_LIMIT_MS - (now - rateLimit[cleanPhone])) / 1000);
        return res.status(429).json({
            error: `Terlalu banyak request. Tunggu ${waitSec} detik lagi.`,
            waitSeconds: waitSec
        });
    }

    // Kalau masih pending dengan code valid → return code lama
    if (sessions[cleanPhone] && sessions[cleanPhone].code && sessions[cleanPhone].status === 'pending') {
        return res.json({
            code: sessions[cleanPhone].code,
            status: 'pending',
            cached: true
        });
    }

    if (sessions[cleanPhone] && sessions[cleanPhone].status === 'connected') {
        return res.json({
            code: sessions[cleanPhone].code,
            status: 'connected',
            cached: true
        });
    }

    // Kalau ada session lama (offline), hapus dulu
    if (sessions[cleanPhone]) {
        try {
            if (sessions[cleanPhone].sock) {
                await sessions[cleanPhone].sock.logout().catch(() => {});
            }
        } catch (e) {}
        delete sessions[cleanPhone];
    }

    rateLimit[cleanPhone] = now;

    try {
        const code = await createPairingSession(cleanPhone, username);
        res.json({
            code: code,
            status: 'pending',
            cached: false
        });
    } catch (err) {
        console.error('Pair error:', err);
        res.status(500).json({
            error: 'Gagal membuat pairing code',
            details: err.message
        });
    }
});

app.get('/status/:phone', (req, res) => {
    const cleanPhone = String(req.params.phone).replace(/[^0-9]/g, '');
    const s = sessions[cleanPhone];

    if (!s) {
        return res.json({ connected: false, status: 'not_found' });
    }

    res.json({
        connected: s.status === 'connected',
        status: s.status,
        code: s.code,
        lastError: s.lastError || null,
        createdAt: s.createdAt
    });
});

app.delete('/session/:phone', async (req, res) => {
    const cleanPhone = String(req.params.phone).replace(/[^0-9]/g, '');
    const s = sessions[cleanPhone];

    if (!s) {
        return res.status(404).json({ error: 'Session tidak ditemukan' });
    }

    try {
        if (s.sock) {
            await s.sock.logout().catch(() => {});
        }
    } catch (e) {}

    const sessionDir = path.join(__dirname, 'sessions', cleanPhone);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}

    delete sessions[cleanPhone];
    delete rateLimit[cleanPhone];

    res.json({ success: true, message: `Session ${cleanPhone} dihapus` });
});

app.get('/sessions', (req, res) => {
    const list = Object.keys(sessions).map(phone => ({
        phone,
        status: sessions[phone].status,
        code: sessions[phone].code,
        lastError: sessions[phone].lastError || null,
        username: sessions[phone].username,
        createdAt: sessions[phone].createdAt
    }));
    res.json({ total: list.length, sessions: list });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 FLOW WhatsApp Pairing Server running on port ${PORT}`);
    console.log(`📦 Node version: ${process.version}`);
    console.log(`📡 Endpoint: http://localhost:${PORT}`);
});

// JANGAN auto-restore session — biar gak crash loop
// Uncomment kalau perlu
// (async () => {
//     const sessionsDir = path.join(__dirname, 'sessions');
//     if (!fs.existsSync(sessionsDir)) return;
//     const phones = fs.readdirSync(sessionsDir);
//     for (const phone of phones) {
//         try {
//             console.log(`🔄 Restoring session: ${phone}`);
//             await createPairingSession(phone, 'restored');
//         } catch (e) {
//             console.error(`Gagal restore ${phone}:`, e.message);
//         }
//     }
// })();
