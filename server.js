/**
 * FLOW WhatsApp Pairing Server
 * Deploy di Railway
 */

// FIX: Polyfill crypto buat Node.js lama / environment yang kurang Web Crypto
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

// ============================================================
// STORAGE SESSION
// ============================================================
const sessions = {};

// ============================================================
// HELPER: BIKIN SESSION PAIRING
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
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`[${phone}] ❌ Connection closed. Reconnect: ${shouldReconnect}`);

            if (sessions[phone]) {
                sessions[phone].status = 'offline';
            }

            if (shouldReconnect) {
                setTimeout(() => {
                    createPairingSession(phone, username).catch(err => {
                        console.error(`[${phone}] Reconnect error:`, err.message);
                    });
                }, 3000);
            } else {
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
                delete sessions[phone];
            }
        }
    });

    sessions[phone] = {
        sock,
        code: sessions[phone]?.code || null,
        status: 'pending',
        username: username || 'unknown',
        createdAt: Date.now()
    };

    if (!sock.authState.creds.registered) {
        await new Promise(r => setTimeout(r, 1500));

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

    res.json({ success: true, message: `Session ${cleanPhone} dihapus` });
});

app.get('/sessions', (req, res) => {
    const list = Object.keys(sessions).map(phone => ({
        phone,
        status: sessions[phone].status,
        code: sessions[phone].code,
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

// Auto-restore sessions dari disk saat startup
(async () => {
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) return;

    const phones = fs.readdirSync(sessionsDir);
    for (const phone of phones) {
        try {
            console.log(`🔄 Restoring session: ${phone}`);
            await createPairingSession(phone, 'restored');
        } catch (e) {
            console.error(`Gagal restore ${phone}:`, e.message);
        }
    }
})();
