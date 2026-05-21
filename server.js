const net = require('net');
const http = require('http');
const admin = require('firebase-admin');

// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PASSWORD = process.env.DEVICE_PASSWORD || 'nabe5';
const TCP_PORT = process.env.PORT || 8020;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const APP_URL = 'https://www.pedalagilla.it';

// Stripe via fetch (no dipendenza npm aggiuntiva)
async function stripeRequest(endpoint, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return res.json();
}

// ─── HELPER GEOFENCE ─────────────────────────────────────────────────────────
function haversineDist(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Carica le zone operative da Firestore (aggiornate ogni 5 min)
let operativeZones = [];
async function loadOperativeZones() {
  try {
    const snap = await db.collection('config').doc('zones').get();
    if (snap.exists) {
      const all = snap.data().zones || [];
      operativeZones = all.filter(z => z.type === 'operativa' && z.center && z.radius);
      console.log(`📍 Zone operative caricate: ${operativeZones.length}`);
    }
  } catch(e) { console.error('Errore caricamento zone:', e.message); }
}
setInterval(loadOperativeZones, 5 * 60 * 1000); // ricarica ogni 5 min

function isInsideOperativeZone(lat, lng) {
  if (operativeZones.length === 0) return true; // se non ci sono zone, non bloccare
  return operativeZones.some(z => haversineDist(lat, lng, z.center.lat, z.center.lng) <= z.radius);
}

// Traccia bici fuori zona per il beep ripetuto
const outOfZoneBeepIntervals = {}; // bikeId -> intervalId

function startOutOfZoneAlarm(bikeId, socket) {
  if (outOfZoneBeepIntervals[bikeId]) return; // già attivo
  console.log(`🚨 Allarme fuori zona avviato: ${bikeId}`);
  // Primo lock + beep immediato
  socket.write(buildAtCmd('lock'));
  socket.write(buildAtCmd('beep'));
  // Poi ogni 60 secondi
  outOfZoneBeepIntervals[bikeId] = setInterval(() => {
    if (clients[Object.keys(clients).find(imei => IMEI_MAP[imei] === bikeId)]) {
      const imei = Object.keys(clients).find(i => IMEI_MAP[i] === bikeId);
      if (imei && clients[imei]) {
        clients[imei].write(buildAtCmd('lock'));
        clients[imei].write(buildAtCmd('beep'));
        console.log(`🔔 Beep fuori zona: ${bikeId}`);
      }
    }
  }, 60 * 1000);
}

function stopOutOfZoneAlarm(bikeId) {
  if (outOfZoneBeepIntervals[bikeId]) {
    clearInterval(outOfZoneBeepIntervals[bikeId]);
    delete outOfZoneBeepIntervals[bikeId];
    console.log(`✅ Allarme fuori zona fermato: ${bikeId}`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── IMEI MAP ────────────────────────────────────────────────────────────────
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

const clients = {};

// ─── AT COMMANDS ─────────────────────────────────────────────────────────────
function buildAtCmd(type) {
  switch(type) {
    case 'unlock':       return `AT+GTRTO=${PASSWORD},15,,,,,,,,FFFF$`;
    case 'lock':         return `AT+GTRTO=${PASSWORD},16,,,,,,,,FFFF$`;
    case 'beep':         return `AT+GTRTO=${PASSWORD},11,,,,,,,,FFFF$`;
    case 'battery_open': return `AT+GTRTO=${PASSWORD},21,,0,,,,,,FFFF$`;
    case 'gps_high':     return `AT+GTFRI=${PASSWORD},1,0,300,60,240,,,,,,FFFF$`;
    case 'gps_normal':   return `AT+GTFRI=${PASSWORD},1,0,300,30,240,,,,,,FFFF$`;
    case 'stop_alarm':   return null; // gestito lato server (stopOutOfZoneAlarm)
    default: return null;
  }
}

// ─── HTTP SERVER (Stripe Checkout + Webhook) ──────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', APP_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      // ── POST /create-checkout ─────────────────────────────────────────────
      if (req.method === 'POST' && req.url === '/create-checkout') {
        const data = JSON.parse(body);
        const { amount, planLabel, bikeIds, userId, userName, userEmail, plan } = data;

        // Crea sessione Stripe Checkout
        const params = {
          'payment_method_types[]': 'card',
          'line_items[0][price_data][currency]': 'eur',
          'line_items[0][price_data][product_data][name]': `PedalAgilla — ${planLabel}`,
          'line_items[0][price_data][product_data][description]': `Bici: ${bikeIds.join(', ')}`,
          'line_items[0][price_data][unit_amount]': Math.round(amount * 100), // centesimi
          'line_items[0][quantity]': '1',
          'mode': 'payment',
          'customer_email': userEmail || '',
          'success_url': `${APP_URL}/?checkout_success=true&session_id={CHECKOUT_SESSION_ID}`,
          'cancel_url': `${APP_URL}/?checkout_cancelled=true`,
          'metadata[userId]': userId || '',
          'metadata[userName]': userName || '',
          'metadata[bikeIds]': bikeIds.join(','),
          'metadata[plan]': plan || 'minuti',
          'payment_intent_data[capture_method]': 'automatic',
        };

        // Pre-autorizzazione per piani a consumo (non giornata/settimana)
        if (plan === 'minuti') {
          params['payment_intent_data[capture_method]'] = 'manual'; // autorizza, non addebita subito
        }

        const session = await stripeRequest('checkout/sessions', params);

        if (session.error) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ error: session.error.message }));
          return;
        }

        // Salva la sessione su Firestore per ricollegarla alla corsa
        await db.collection('checkoutSessions').doc(session.id).set({
          userId, userName, userEmail,
          bikeIds, plan, amount,
          status: 'pending',
          createdAt: new Date().toISOString(),
        });

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ url: session.url, sessionId: session.id }));
        return;
      }

      // ── POST /checkout-status ─────────────────────────────────────────────
      // L'app chiama questo dopo il redirect success per verificare il pagamento
      if (req.method === 'POST' && req.url === '/checkout-status') {
        const { sessionId } = JSON.parse(body);
        const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
          headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
        });
        const session = await response.json();

        if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
          // Aggiorna la sessione su Firestore
          await db.collection('checkoutSessions').doc(sessionId).update({
            status: 'paid',
            paymentIntentId: session.payment_intent,
            paidAt: new Date().toISOString(),
          });

          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({
            paid: true,
            metadata: session.metadata,
            paymentIntentId: session.payment_intent,
          }));
        } else {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ paid: false, status: session.payment_status }));
        }
        return;
      }

      // ── POST /capture-payment ─────────────────────────────────────────────
      // Chiamato a fine corsa per addebitare l'importo finale (piano minuti)
      if (req.method === 'POST' && req.url === '/capture-payment') {
        const { paymentIntentId, finalAmount } = JSON.parse(body);
        const session = await stripeRequest(`payment_intents/${paymentIntentId}/capture`, {
          'amount_to_capture': Math.round(finalAmount * 100),
        });
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ success: !session.error, session }));
        return;
      }

      res.writeHead(404); res.end('Not found');
    } catch(e) {
      console.error('HTTP error:', e.message);
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

// HTTP su porta 3000 (Railway gestisce il routing)
const HTTP_PORT = 3000;
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP server (Stripe Checkout) porta ${HTTP_PORT}`);
});

// ─── TCP SERVER (IoT bici) ────────────────────────────────────────────────────
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
      await handleMessage(msg.trim() + '$', socket, (imei) => {
        deviceImei = imei;
        clients[imei] = socket;
      });
    }
  });

  socket.on('close', () => {
    if (deviceImei) { delete clients[deviceImei]; console.log('Disconnesso:', deviceImei); }
  });
  socket.on('error', (err) => console.error('Socket error:', err.message));
});

async function handleMessage(msg, socket, setImei) {
  if (msg.startsWith('+HBD:')) {
    const parts = msg.replace('$', '').split(',');
    const imei = parts[1];
    const countNum = parts[parts.length - 1];
    if (imei && /^\d{15}$/.test(imei)) {
      setImei(imei);
      const bikeId = IMEI_MAP[imei];
      console.log(`HBD ${bikeId||imei}`);
      socket.write(`+SHBD:${countNum}$`);
      if (bikeId) {
        await db.collection('bikes').doc(bikeId).set({
          imei, lastSeen: new Date().toISOString(), online: true,
          batteryPercent: parseInt(parts[5]) || 0,
          batteryVoltage: parseInt(parts[3]) || 0,
          signal: parseInt(parts[4]) || 0,
          charging: parts[6] === '1',
        }, { merge: true });
        await checkPendingCommands(bikeId, imei, socket);
      }
    }
    return;
  }

  if (msg.startsWith('+RESP:GTFRI')) {
    const parts = msg.replace('$', '').split(',');
    const imei = parts[2];
    const bikeId = IMEI_MAP[imei];
    if (bikeId) {
      const lng = parseFloat(parts[18]) || 0;
      const lat = parseFloat(parts[19]) || 0;
      const speed = parseFloat(parts[14]) || 0;
      const battery = parseInt(parts[27]) || 0;
      await db.collection('bikes').doc(bikeId).set({ lat, lng, speed, battery, lastGPS: new Date().toISOString() }, { merge: true });

      // ── Check zona operativa ─────────────────────────────────────────────────
      if (lat && lng && Math.abs(lat) > 0 && Math.abs(lng) > 0) {
        const inside = isInsideOperativeZone(lat, lng);
        const bikeDoc2 = await db.collection('bikes').doc(bikeId).get().catch(()=>null);
        const wasOutOfZone = bikeDoc2?.data()?.outOfZone || false;

        if (!inside) {
          // Fuori zona — aggiorna stato e avvia allarme
          await db.collection('bikes').doc(bikeId).update({
            outOfZone: true,
            outOfZoneAt: wasOutOfZone ? (bikeDoc2?.data()?.outOfZoneAt || new Date().toISOString()) : new Date().toISOString()
          });
          // Avvia allarme (lock + beep ogni 60s)
          startOutOfZoneAlarm(bikeId, socket);
        } else if (wasOutOfZone) {
          // Rientrata in zona — ferma allarme
          await db.collection('bikes').doc(bikeId).update({
            outOfZone: false,
            outOfZoneAt: null
          });
          stopOutOfZoneAlarm(bikeId);
          console.log(`✅ ${bikeId} rientrata in zona operativa`);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Auto-pausa dopo 15 min ferma
      if (lat && lng) {
        try {
          const bikeDoc = await db.collection('bikes').doc(bikeId).get();
          const bikeData = bikeDoc.data() || {};
          const paId = 'PA-' + bikeId.replace('PED', '');
          const statusDoc = await db.collection('bikesStatus').doc(paId).get();
          if (statusDoc.exists && statusDoc.data().inUse && speed <= 1) {
            const lastMoved = bikeData.lastMovedAt ? new Date(bikeData.lastMovedAt).getTime() : Date.now();
            const minutesFermo = (Date.now() - lastMoved) / 60000;
            if (minutesFermo >= 15 && !bikeData.autoPause) {
              console.log(`⏸️ Auto-pausa ${bikeId} — fermo da ${Math.round(minutesFermo)} min`);
              socket.write(buildAtCmd('lock'));
              await db.collection('bikes').doc(bikeId).update({ autoPause: true });
            }
          } else if (speed > 1) {
            await db.collection('bikes').doc(bikeId).update({ lastMovedAt: new Date().toISOString() });
          }
        } catch(e) { console.error('Auto-pausa error:', e.message); }

        // Aggiorna tracciato corsa
        try {
          const paId = 'PA-' + bikeId.replace('PED', '');
          const statusDoc = await db.collection('bikesStatus').doc(paId).get();
          if (statusDoc.exists && statusDoc.data().inUse) {
            const ridesSnap = await db.collection('rides')
              .where('userId', '==', statusDoc.data().userId)
              .where('status', '==', 'In corso').limit(1).get();
            if (!ridesSnap.empty) {
              const track = ridesSnap.docs[0].data().track || [];
              await ridesSnap.docs[0].ref.update({ track: [...track, { lat, lng, t: Date.now() }] });
            }
          }
        } catch(e) { console.error('Track error:', e.message); }
      }
    }
    return;
  }

  if (msg.startsWith('+ACK:')) { console.log('ACK:', msg.slice(0,60)); return; }
  if (msg.startsWith('+RESP:GTLKS')) {
    const parts = msg.replace('$', '').split(',');
    const imei = parts[2];
    const bikeId = IMEI_MAP[imei];
    if (bikeId) {
      await db.collection('bikes').doc(bikeId).set(
        { locked: parts[5] === '10', lastLockEvent: new Date().toISOString() }, { merge: true }
      );
    }
  }
}

async function checkPendingCommands(bikeId, imei, socket) {
  try {
    const snap = await db.collection('bikes').doc(bikeId).collection('commands')
      .where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(3).get();
    for (const doc of snap.docs) {
      const cmdType = doc.data().type;
      if (cmdType === 'stop_alarm') {
        // Ferma allarme fuori zona manualmente
        stopOutOfZoneAlarm(bikeId);
        await doc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
        console.log(`🛑 Allarme fermato manualmente: ${bikeId}`);
        continue;
      }
      const atCmd = buildAtCmd(cmdType);
      if (atCmd) {
        socket.write(atCmd);
        await doc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
      } else {
        await doc.ref.update({ status: 'unknown_type' });
      }
    }
  } catch(e) { console.error('checkPendingCommands:', e.message); }
}

function watchCommands() {
  db.collectionGroup('commands').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== 'added' || change.doc.data().status !== 'pending') return;
      const bikeId = change.doc.ref.parent.parent.id;
      const bikeDoc = await db.collection('bikes').doc(bikeId).get().catch(()=>null);
      const imei = bikeDoc?.data()?.imei;
      if (!imei || !clients[imei]) return;
      const atCmd = buildAtCmd(change.doc.data().type);
      if (!atCmd) return;
      setTimeout(async () => {
        try {
          const fresh = await change.doc.ref.get();
          if (fresh.data()?.status !== 'pending') return;
          console.log(`⚡ IMMEDIATO ${change.doc.data().type} → ${bikeId}`);
          clients[imei].write(atCmd);
          await change.doc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
        } catch(e) { console.error('watchCommands send:', e.message); }
      }, 200);
    });
  }, err => console.error('watchCommands error:', err.message));
}

server.listen(TCP_PORT, () => {
  console.log(`TCP IoT porta ${TCP_PORT}`);
  loadOperativeZones(); // carica zone operative subito
  watchCommands();
  autoLockInactive();
});

async function autoLockInactive() {
  const check = async () => {
    try {
      const snap = await db.collection('bikesStatus').get();
      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.inUse) continue;
        const elapsed = Date.now() - (data.updatedAt ? new Date(data.updatedAt).getTime() : 0);
        if (elapsed > 4 * 60 * 60 * 1000) {
          const pedId = 'PED' + doc.id.replace('PA-','');
          const bikeDoc = await db.collection('bikes').doc(pedId).get();
          const imei = bikeDoc.data()?.imei;
          if (imei && clients[imei]) {
            console.log(`🔒 Auto-blocco ${doc.id}`);
            clients[imei].write(buildAtCmd('lock'));
          }
        }
      }
    } catch(e) { console.error('autoLock:', e.message); }
  };
  setTimeout(() => { check(); setInterval(check, 30 * 60 * 1000); }, 5 * 60 * 1000);
}
