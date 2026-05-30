const net = require('net');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  preflightContinue: false,
  optionsSuccessStatus: 204
}));
app.options('*', cors()); // Gestione esplicita preflight
app.use(express.json());

// Endpoint per creare PaymentIntent
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, paymentMethodId, bikeId, plan, userId, userName } = req.body;
    if (!amount || !paymentMethodId) return res.status(400).json({ error: 'Parametri mancanti' });
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // in centesimi
      currency: 'eur',
      payment_method: paymentMethodId,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { bikeId, plan, userId, userName }
    });
    
    res.json({ success: true, paymentIntentId: paymentIntent.id });
  } catch(e) {
    console.error('Stripe error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Endpoint pre-autorizzazione (hold €10 per bici)
app.post('/create-pre-auth', async (req, res) => {
  try {
    const { paymentMethodId, amount, bikeIds } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'eur',
      payment_method: paymentMethodId,
      confirm: true,
      capture_method: 'manual', // solo autorizza, non addebita
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { bikeIds: bikeIds?.join(',') }
    });
    res.json({ success: true, paymentIntentId: paymentIntent.id });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// Porta HTTP FISSA a 3000: corrisponde al dominio HTTP di Railway (web-...railway.app -> Port 3000).
// NON usare process.env.HTTP_PORT/PORT perché su Railway può valere 8020 e collidere col TCP.
const HTTP_PORT = 3000;
app.listen(HTTP_PORT, () => console.log(`✅ HTTP server on port ${HTTP_PORT}`));


// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PASSWORD = process.env.DEVICE_PASSWORD || 'nabe5';
// IMPORTANTE: il TCP proxy di Railway inoltra l'esterno (es. :45415) -> porta interna :8020.
// Porta TCP FISSA a 8020 (target del proxy). Diversa dalla HTTP (3000), così non collidono mai.
const TCP_PORT = 8020;

// Mappa IMEI -> ID bici
const IMEI_MAP = {
  '867689060859347': 'PED001', '867689060859412': 'PED002',
  '867689060842285': 'PED003', '867689060851666': 'PED004',
  '867689060842608': 'PED005', '867689060842509': 'PED006',
  '867689060859115': 'PED007', '867689060861632': 'PED008',
  '867689060842558': 'PED009', '867689060865401': 'PED010',
  '867689060865245': 'PED011', '867689060851997': 'PED012',
  '867689060840412': 'PED013', '867689060859040': 'PED014',
  '867689060851021': 'PED015', '867689060850932': 'PED016',
  '867689060859610': 'PED017', '867689060842350': 'PED018',
  '867689060851724': 'PED019', '867689060859404': 'PED020',
  '867689060859818': 'PED021', '867689060850924': 'PED022',
  '867689060858828': 'PED023', '867689060861657': 'PED024',
  '867689060867357': 'PED025', '867689060863505': 'PED026',
  '867689060859974': 'PED027', '867689060855816': 'PED028',
  '867689060860378': 'PED029', '867689060863745': 'PED030',
  '867689060842525': 'PED031', '867689060842533': 'PED032',
  '867689060860329': 'PED033', '867689060860105': 'PED034',
  '867689060842178': 'PED035', '867689060851641': 'PED036',
  '867689060868421': 'PED037', '867689060859958': 'PED038',
  '867689060850957': 'PED039', '867689060855915': 'PED040',
};

const clients = {}; // imei -> socket

const server = net.createServer((socket) => {
  console.log('Nuova connessione:', socket.remoteAddress);
  let buffer = '';
  let deviceImei = null;

  socket.on('data', async (data) => {
    buffer += data.toString();
    const messages = buffer.split('$');
    buffer = messages.pop();

    for (const msg of messages) {
      if (!msg.trim()) continue;
      const full = msg.trim() + '$';
      console.log('RX:', full);
      await handleMessage(full, socket, (imei) => {
        deviceImei = imei;
        clients[imei] = socket;
      });
    }
  });

  socket.on('close', () => {
    if (deviceImei) {
      delete clients[deviceImei];
      console.log('Disconnesso:', deviceImei);
    }
  });

  socket.on('error', (err) => console.error('Socket error:', err.message));
});

async function handleMessage(msg, socket, setImei) {
  // Heartbeat +HBD
  if (msg.startsWith('+HBD:')) {
    const parts = msg.replace('$', '').split(',');
    const imei = parts[1];
    const countNum = parts[parts.length - 1];
    if (imei && imei.match(/^\d{15}$/)) {
      setImei(imei);
      const bikeId = IMEI_MAP[imei];
      console.log(`HBD da ${bikeId || imei}`);
      socket.write(`+SHBD:${countNum}$`);
      if (bikeId) {
        await db.collection('bikes').doc(bikeId).set({
          imei, lastSeen: new Date().toISOString(), online: true,
          vehicleStatus: parseInt(parts[2]) || 0,
          batteryVoltage: parseInt(parts[3]) || 0,
          signal: parseInt(parts[4]) || 0,
          batteryPercent: parseInt(parts[5]) || 0,
          charging: parts[6] === '1',
        }, { merge: true });
        await checkPendingCommands(bikeId, imei, socket);
      }
    }
    return;
  }

  // Report posizione +RESP:GTFRI
  if (msg.startsWith('+RESP:GTFRI')) {
    const parts = msg.replace('$', '').split(',');
    const imei = parts[2];
    const bikeId = IMEI_MAP[imei];
    if (bikeId) {
      const lng = parseFloat(parts[18]) || 0;
      const lat = parseFloat(parts[19]) || 0;
      const speed = parseFloat(parts[14]) || 0;
      const battery = parseInt(parts[27]) || 0;
      console.log(`GPS ${bikeId}: ${lat},${lng} speed:${speed}`);
      
      // Aggiorna posizione bici su Firebase
      await db.collection('bikes').doc(bikeId).set({
        lat, lng, speed, battery,
        lastGPS: new Date().toISOString(),
      }, { merge: true });

      // Aggiorna tracciato sulla corsa attiva
      if (lat && lng && lat !== 0 && lng !== 0 && lng < 180) {
        try {
          const paId = 'PA-' + bikeId.replace('PED', '');
          // Controlla se la bici è in uso
          const statusDoc = await db.collection('bikesStatus').doc(paId).get();
          if (statusDoc.exists && statusDoc.data().inUse) {
            const userId = statusDoc.data().userId;
            // Cerca la corsa attiva
            const ridesSnap = await db.collection('rides')
              .where('userId', '==', userId)
              .where('status', '==', 'In corso')
              .limit(1)
              .get();
            if (!ridesSnap.empty) {
              const rideDoc = ridesSnap.docs[0];
              const currentTrack = rideDoc.data().track || [];
              const newPoint = { lat, lng, t: Date.now() };
              await rideDoc.ref.update({ track: [...currentTrack, newPoint] });
              console.log(`📍 Track IoT aggiornato: ${rideDoc.id} → ${lat},${lng}`);
            }
          }
        } catch(e) {
          console.error('Errore track IoT:', e.message);
        }
      }
    }
    return;
  }

  // ACK comandi
  if (msg.startsWith('+ACK:')) {
    console.log('ACK ricevuto:', msg);
    return;
  }

  // Lock/Unlock response
  if (msg.startsWith('+RESP:GTLKS')) {
    const parts = msg.replace('$', '').split(',');
    const imei = parts[2];
    const bikeId = IMEI_MAP[imei];
    const reportId = parts[5];
    console.log(`GTLKS ${bikeId} reportId:${reportId}`);
    if (bikeId) {
      const locked = reportId === '10';
      await db.collection('bikes').doc(bikeId).set({
        locked, lastLockEvent: new Date().toISOString()
      }, { merge: true });
    }
  }
}

async function checkPendingCommands(bikeId, imei, socket) {
  try {
    const cmdRef = db.collection('bikes').doc(bikeId).collection('commands');
    // Pulisci comandi vecchi SOLO se la bici non è in uso (evita di cancellare unlock durante corsa)
    const paId = 'PA-' + bikeId.replace('PED','');
    const statusDoc = await db.collection('bikesStatus').doc(paId).get();
    const bikeInUse = statusDoc.exists && statusDoc.data().inUse;
    if (!bikeInUse) {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const staleCmds = await cmdRef.orderBy('createdAt', 'asc').get();
      for (const d of staleCmds.docs) {
        const data = d.data();
        // Elimina solo lock/gps_normal/gps_high vecchi — MAI unlock (potrebbe servire ancora)
        const safeToDelete = ['lock','gps_normal','gps_high','beep','battery_open'];
        if (safeToDelete.includes(data.type) && (data.status === 'pending' || data.status === 'sent') && data.createdAt < twoHoursAgo) {
          await d.ref.delete();
          console.log(`🗑️ Comando stantio eliminato: ${bikeId} ${data.type}`);
        }
      }
    }
    // Process ALL pending commands in order, not just the first one
    const freshCmds = await cmdRef.orderBy('createdAt', 'asc').get();
    const pendingDocs = freshCmds.docs.filter(d => d.data().status === 'pending' && d.data().status !== 'cancelled');
    if (pendingDocs.length === 0) return;
    const pendingDoc = pendingDocs[0]; // Process oldest first
    const cmd = pendingDoc.data();
    let atCmd = '';
    if (cmd.type === 'unlock') {
      atCmd = `AT+GTRTO=${PASSWORD},15,,,,,,,,FFFF$`;
    } else if (cmd.type === 'lock') {
      atCmd = `AT+GTRTO=${PASSWORD},16,,,,,,,,FFFF$`;
    } else if (cmd.type === 'beep') {
      // Comando corretto confermato da Navee
      atCmd = `AT+GTRTO=${PASSWORD},11,,,,,,,,FFFF$`;
    } else if (cmd.type === 'battery_open') {
      // Comando corretto confermato da Navee (era 12, corretto è 21)
      atCmd = `AT+GTRTO=${PASSWORD},21,,0,,,,,,FFFF$`;
    } else if (cmd.type === 'gps_high') {
      // Alta frequenza GPS: ogni 60 secondi in movimento (meno beep)
      atCmd = `AT+GTFRI=${PASSWORD},1,0,300,60,240,,,,,,FFFF$`;
    } else if (cmd.type === 'gps_normal') {
      // Ritorna a frequenza normale: ogni 30 secondi
      atCmd = `AT+GTFRI=${PASSWORD},1,0,300,30,240,,,,,,FFFF$`;
    }
    if (atCmd) {
      console.log(`Invio comando ${cmd.type} a ${bikeId}:`, atCmd);
      socket.write(atCmd);
      await pendingDoc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
    }
  } catch (e) {
    console.error('Errore comando:', e.message);
  }
}

function watchCommands() {
  // Ascolta nuovi comandi su ogni bici connessa
  db.collectionGroup('commands')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added' && change.doc.data().status === 'pending') {
          const bikeId = change.doc.ref.parent.parent.id;
          const bike = await db.collection('bikes').doc(bikeId).get();
          const imei = bike.data()?.imei;
          if (imei && clients[imei]) {
            console.log(`Nuovo comando per ${bikeId}, invio...`);
            await checkPendingCommands(bikeId, imei, clients[imei]);
          } else {
            console.log(`Comando per ${bikeId} ma bici non connessa (imei: ${imei})`);
          }
        }
      });
    }, err => console.error('watchCommands error:', err.message));
}

server.listen(TCP_PORT, () => {
  console.log(`✅ Server TCP in ascolto sulla porta ${TCP_PORT}`);
  console.log(`   (Railway TCP proxy deve puntare a questa porta: shuttle.proxy.rlwy.net:XXXXX -> :${TCP_PORT})`);
  watchCommands();
  autoLockInactive();
});

// Auto-blocco bici ferme da più di 4 ore dopo fine corsa
async function autoLockInactive() {
  const CHECK_INTERVAL = 30 * 60 * 1000; // controlla ogni 30 minuti
  const LOCK_AFTER_MS = 4 * 60 * 60 * 1000; // 4 ore

  const check = async () => {
    try {
      const snap = await db.collection('bikesStatus').get();
      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.inUse) continue; // in uso, skip
        const updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
        const elapsed = Date.now() - updatedAt;
        if (elapsed > LOCK_AFTER_MS) {
          // Cerca l'IMEI della bici
          const bikeId = doc.id; // es. PA-027
          const pedId = 'PED' + bikeId.replace('PA-','').replace('-','');
          const bikeDoc = await db.collection('bikes').doc(pedId).get();
          const imei = bikeDoc.data()?.imei;
          if (imei && clients[imei]) {
            console.log(`🔒 Auto-blocco ${bikeId} — ferma da ${Math.round(elapsed/3600000)}h`);
            const sn = Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4,'0');
            clients[imei].write(`AT+GTRTO=${PASSWORD},16,,,,,,,,${sn}$`);
          }
        }
      }
    } catch(e) {
      console.error('Errore auto-lock:', e.message);
    }
  };

  // Prima esecuzione dopo 5 minuti, poi ogni 30 minuti
  setTimeout(() => {
    check();
    setInterval(check, CHECK_INTERVAL);
  }, 5 * 60 * 1000);
}
