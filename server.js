const net = require('net');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PASSWORD = process.env.DEVICE_PASSWORD || 'nabe5';
const TCP_PORT = process.env.PORT || 8020;
const AUTO_PAUSE_MINUTES = 15; // minuti fermi prima dell'auto-pausa

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

function buildAtCmd(type) {
  switch(type) {
    case 'unlock':       return `AT+GTRTO=${PASSWORD},15,,,,,,,,FFFF$`;
    case 'lock':         return `AT+GTRTO=${PASSWORD},16,,,,,,,,FFFF$`;
    case 'beep':         return `AT+GTRTO=${PASSWORD},11,,,,,,,,FFFF$`;
    case 'battery_open': return `AT+GTRTO=${PASSWORD},21,,0,,,,,,FFFF$`;
    case 'gps_high':     return `AT+GTFRI=${PASSWORD},1,0,300,60,240,,,,,,FFFF$`;
    case 'gps_normal':   return `AT+GTFRI=${PASSWORD},1,0,300,30,240,,,,,,FFFF$`;
    default: return null;
  }
}

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
  // Heartbeat
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

  // Posizione GPS
  if (msg.startsWith('+RESP:GTFRI')) {
    const parts = msg.replace('$', '').split(',');
    const imei = parts[2];
    const bikeId = IMEI_MAP[imei];
    if (bikeId) {
      const lng = parseFloat(parts[18]) || 0;
      const lat = parseFloat(parts[19]) || 0;
      const speed = parseFloat(parts[14]) || 0;
      const battery = parseInt(parts[27]) || 0;
      const now = new Date().toISOString();
      console.log(`GPS ${bikeId}: ${lat},${lng} speed:${speed}`);

      // Aggiorna posizione
      const updateData = { lat, lng, speed, battery, lastGPS: now };

      // Aggiorna lastMovedAt solo se la bici si sta muovendo
      if (speed > 1) {
        updateData.lastMovedAt = now;
        updateData.autoPause = false; // si è rimessa in moto — cancella auto-pausa
      } else {
        // Fermo: controlla se è ora di mettere in auto-pausa
        updateData.lastStoppedAt = now;
      }

      await db.collection('bikes').doc(bikeId).set(updateData, { merge: true });

      // ── AUTO-PAUSA dopo 15 minuti fermi durante una corsa ──
      if (speed <= 1) {
        try {
          const paId = 'PA-' + bikeId.replace('PED', '');
          const statusDoc = await db.collection('bikesStatus').doc(paId).get();
          if (statusDoc.exists && statusDoc.data().inUse) {
            // Legge lastMovedAt dalla bici
            const bikeDoc = await db.collection('bikes').doc(bikeId).get();
            const bikeData = bikeDoc.data();
            const lastMoved = bikeData.lastMovedAt ? new Date(bikeData.lastMovedAt).getTime() : null;
            const alreadyAutoPaused = bikeData.autoPause === true;

            if (!alreadyAutoPaused && lastMoved) {
              const minutesFermo = (Date.now() - lastMoved) / 60000;
              if (minutesFermo >= AUTO_PAUSE_MINUTES) {
                console.log(`⏸️ AUTO-PAUSA ${bikeId} — ferma da ${Math.round(minutesFermo)} min`);
                // Scrive autoPause:true — l'app lo legge e mette in pausa il timer
                await db.collection('bikes').doc(bikeId).set(
                  { autoPause: true, autoPausedAt: now },
                  { merge: true }
                );
                // Blocca fisicamente la bici
                if (clients[bikeData.imei]) {
                  clients[bikeData.imei].write(buildAtCmd('lock'));
                }
              }
            }
          }
        } catch(e) { console.error('Errore auto-pausa:', e.message); }
      }

      // Aggiorna tracciato corsa attiva
      if (lat && lng && Math.abs(lat) > 0 && Math.abs(lng) < 180) {
        try {
          const paId = 'PA-' + bikeId.replace('PED', '');
          const statusDoc = await db.collection('bikesStatus').doc(paId).get();
          if (statusDoc.exists && statusDoc.data().inUse) {
            const userId = statusDoc.data().userId;
            const ridesSnap = await db.collection('rides')
              .where('userId', '==', userId)
              .where('status', '==', 'In corso')
              .limit(1).get();
            if (!ridesSnap.empty) {
              const rideDoc = ridesSnap.docs[0];
              const track = rideDoc.data().track || [];
              await rideDoc.ref.update({ track: [...track, { lat, lng, t: Date.now() }] });
            }
          }
        } catch(e) { console.error('Errore track IoT:', e.message); }
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
      const locked = parts[5] === '10';
      await db.collection('bikes').doc(bikeId).set(
        { locked, lastLockEvent: new Date().toISOString() },
        { merge: true }
      );
    }
  }
}

async function checkPendingCommands(bikeId, imei, socket) {
  try {
    const snap = await db.collection('bikes').doc(bikeId).collection('commands')
      .where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(3).get();
    for (const doc of snap.docs) {
      const cmd = doc.data();
      const atCmd = buildAtCmd(cmd.type);
      if (atCmd) {
        console.log(`→ CMD ${cmd.type} a ${bikeId}`);
        socket.write(atCmd);
        await doc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
      } else {
        await doc.ref.update({ status: 'unknown_type' });
      }
    }
  } catch (e) { console.error('Errore checkPendingCommands:', e.message); }
}

function watchCommands() {
  db.collectionGroup('commands').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type !== 'added') return;
      const data = change.doc.data();
      if (data.status !== 'pending') return;

      const bikeId = change.doc.ref.parent.parent.id;
      const bikeDoc = await db.collection('bikes').doc(bikeId).get().catch(()=>null);
      const imei = bikeDoc?.data()?.imei;

      if (!imei || !clients[imei]) {
        console.log(`CMD ${data.type} per ${bikeId}: offline`);
        return;
      }

      const atCmd = buildAtCmd(data.type);
      if (!atCmd) return;

      setTimeout(async () => {
        try {
          const fresh = await change.doc.ref.get();
          if (fresh.data()?.status !== 'pending') return;
          console.log(`⚡ IMMEDIATO ${data.type} → ${bikeId}`);
          clients[imei].write(atCmd);
          await change.doc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
        } catch(e) { console.error('Errore invio immediato:', e.message); }
      }, 200);
    });
  }, err => console.error('watchCommands error:', err.message));
}

server.listen(TCP_PORT, () => {
  console.log(`Server TCP porta ${TCP_PORT}`);
  watchCommands();
  autoLockInactive();
});

async function autoLockInactive() {
  const CHECK_INTERVAL = 30 * 60 * 1000;
  const LOCK_AFTER_MS = 4 * 60 * 60 * 1000;
  const check = async () => {
    try {
      const snap = await db.collection('bikesStatus').get();
      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.inUse) continue;
        const elapsed = Date.now() - (data.updatedAt ? new Date(data.updatedAt).getTime() : 0);
        if (elapsed > LOCK_AFTER_MS) {
          const pedId = 'PED' + doc.id.replace('PA-','');
          const bikeDoc = await db.collection('bikes').doc(pedId).get();
          const bData = bikeDoc.data();
          if (bData?.imei && clients[bData.imei]) {
            console.log(`🔒 Auto-lock ${doc.id}`);
            clients[bData.imei].write(buildAtCmd('lock'));
          }
        }
      }
    } catch(e) { console.error('autoLock error:', e.message); }
  };
  setTimeout(() => { check(); setInterval(check, CHECK_INTERVAL); }, 5 * 60 * 1000);
}
