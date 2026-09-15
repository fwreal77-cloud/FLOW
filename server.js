const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

app.post('/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });

  const sessionId = 'sess_' + Date.now();
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_' + sessionId);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['FLOW', 'Chrome', '1.0']
    });

    sessions[sessionId] = { sock, connected: false, phone };

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') sessions[sessionId].connected = true;
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) sessions[sessionId].connected = false;
      }
    });

    const code = await sock.requestPairingCode(phone);
    res.json({ sessionId, code });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

app.get('/status/:sessionId', (req, res) => {
  const s = sessions[req.params.sessionId];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({ connected: s.connected, status: s.connected ? 'connected' : 'waiting' });
});

app.post('/send', async (req, res) => {
  const { sessionId, target, message } = req.body;
  const s = sessions[sessionId];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (!s.connected) return res.status(400).json({ error: 'Not connected' });
  try {
    await s.sock.sendMessage(target + '@s.whatsapp.net', { text: message });
    res.json({ success: true, status: 'sent' });
  } catch(e){
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
