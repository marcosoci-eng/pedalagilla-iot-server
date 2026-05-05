
Copia

const net = require('net');
const admin = require('firebase-admin');
 
// Firebase init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
 
const PASSWORD = process.env.DEVICE_PASSWORD || 'nabe5';
const TCP_PORT = process.env.PORT || 8020;
 
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
      const lng = parseFloat(parts[18]) || 0;  // longitudine
      const lat = parseFloat(parts[19]) || 0;  // latitudine
      const speed = parseFloat(parts[14]) || 0;
      const battery = parseInt(parts[27]) || 0;
      console.log(`GPS ${bikeId}: ${lat},${lng} speed:${speed}`);
      await db.collection('bikes').doc(bikeId).set({
        lat, lng, speed, battery,
        lastGPS: new Date().toISOString(),
      }, { merge: true });
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
    const pending = await cmdRef.where('status', '==', 'pending').limit(1).get();
    if (pending.empty) return;
    const cmdDoc = pending.docs[0];
    const cmd = cmdDoc.data();
    let atCmd = '';
    const sn = Math.floor(Math.random() * 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
    if (cmd.type === 'unlock') {
      atCmd = `AT+GTRTO=${PASSWORD},15,,,,,,,,${sn}$`;
    } else if (cmd.type === 'lock') {
      atCmd = `AT+GTRTO=${PASSWORD},16,,,,,,,,${sn}$`;
    } else if (cmd.type === 'beep') {
      // Comando suona: accende il fanale anteriore per 3 secondi
      atCmd = `AT+GTRTO=${PASSWORD},11,,,,,,,,${sn}$`;
    }
    if (atCmd) {
      console.log(`Invio comando ${cmd.type} a ${bikeId}:`, atCmd);
      socket.write(atCmd);
      await cmdDoc.ref.update({ status: 'sent', sentAt: new Date().toISOString() });
    }
  } catch (e) {
    console.error('Errore comando:', e.message);
  }
}
 
// Listener Firestore per comandi real-time
function watchCommands() {
  db.collectionGroup('commands').where('status', '==', 'pending')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const bikeId = change.doc.ref.parent.parent.id;
          const bike = await db.collection('bikes').doc(bikeId).get();
          const imei = bike.data()?.imei;
          if (imei && clients[imei]) {
            await checkPendingCommands(bikeId, imei, clients[imei]);
          }
        }
      });
    });
}
 
server.listen(TCP_PORT, () => {
  console.log(`Server TCP in ascolto sulla porta ${TCP_PORT}`);
  watchCommands();
});
