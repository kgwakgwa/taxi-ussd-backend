// Express USSD backend for QuickRide (FULL)
// Features:
// - Loads CSV from ./data/locations.csv
// - Supports Town -> Zone -> DropTown -> DropZone flow (Option C)
// - Paging for long lists
// - If CSV contains latitude/longitude columns, applies distance filter (default 30 km)
// - Simple in-memory session store (replace with Redis for production)

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ----------------------------
// CONFIG
// ----------------------------
const CSV_PATH = './data/locations.csv';
const PAGE_SIZE = 6;
const MAX_DISTANCE_KM = 30; // used only when lat/lon available

// ----------------------------
// LOAD CSV INTO MEMORY
// ----------------------------
let locations = []; // each item: {zone_id,town,zone_name,zone_type,approx_distance_km,notes, latitude?, longitude?}

function loadCsv() {
  locations = [];
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV file not found at ${CSV_PATH}`);
    return;
  }

  fs.createReadStream(CSV_PATH)
    .pipe(csv())
    .on('data', (row) => {
      // Normalize keys to lower-case for easier access
      const normalized = {};
      Object.keys(row).forEach(k => normalized[k.trim().toLowerCase()] = row[k].trim());

      const item = {
        zone_id: normalized['zone_id'] || normalized['id'] || null,
        town: normalized['town'] || normalized['city'] || normalized['place'] || '',
        zone_name: normalized['zone_name'] || normalized['location'] || normalized['name'] || '',
        zone_type: normalized['zone_type'] || '',
        approx_distance_km: normalized['approx_distance_km'] ? parseFloat(normalized['approx_distance_km']) : null,
        notes: normalized['notes'] || ''
      };

      // optional lat/lon if present
      if (normalized['latitude'] && normalized['longitude']) {
        item.latitude = parseFloat(normalized['latitude']);
        item.longitude = parseFloat(normalized['longitude']);
      }

      locations.push(item);
    })
    .on('end', () => {
      console.log(`CSV loaded: ${locations.length} locations`);
    })
    .on('error', (err) => {
      console.error('Error loading CSV:', err.message);
    });
}

loadCsv();

// ----------------------------
// UTIL: haversine distance
// ----------------------------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ----------------------------
// SESSION STORE (in-memory)
// ----------------------------
const sessions = {}; // sessionId -> session object

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      step: 'MAIN',
      page: 1
    };
  }
  return sessions[sessionId];
}

// ----------------------------
// HELPERS: lists, paging
// ----------------------------
function uniqueTowns() {
  const map = {};
  locations.forEach(l => {
    const t = l.town || 'Unknown';
    map[t] = true;
  });
  return Object.keys(map).sort();
}

function zonesForTown(town) {
  return locations.filter(l => (l.town || '').toLowerCase() === (town || '').toLowerCase());
}

function paginate(items, page = 1, perPage = PAGE_SIZE) {
  const total = items.length;
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const slice = items.slice(start, end);
  const hasMore = end < total;
  return { slice, hasMore, total };
}

function buildMenuFromArray(items, page = 1, perPage = PAGE_SIZE, title = '') {
  const { slice, hasMore } = paginate(items, page, perPage);
  let txt = title ? `${title}
` : '';
  slice.forEach((it, idx) => {
    txt += `${idx + 1}. ${it}
`;
  });
  if (hasMore) txt += `0. More`;
  return txt.trim();
}

function buildZoneMenuFromObjects(zoneObjs, page = 1, perPage = PAGE_SIZE, title = '') {
  const { slice, hasMore } = paginate(zoneObjs, page, perPage);
  let txt = title ? `${title}
` : '';
  slice.forEach((z, idx) => {
    txt += `${idx + 1}. ${z.zone_name}`;
    if (z.zone_type) txt += ` (${z.zone_type})`;
    txt += `
`;
  });
  if (hasMore) txt += `0. More`;
  return txt.trim();
}

// ----------------------------
// MAIN USSD CALLBACK
// ----------------------------
app.post('/api/ussd/callback', (req, res) => {
  // Africa's Talking usually sends: sessionId, serviceCode, phoneNumber, text
  const { sessionId, serviceCode, phoneNumber } = req.body;
  // For robustness, accept both 'text' and 'userText' etc.
  const text = (req.body.text || req.body.userText || '').toString();
  const userRaw = text.trim();

  const session = getSession(sessionId || phoneNumber || 'anon');
  let response = '';

  // Helper to send
  function send(resp) {
    res.set('Content-Type', 'text/plain');
    return res.send(resp);
  }

  // MAIN menu
  if (session.step === 'MAIN') {
    if (!userRaw) {
      response = `CON Welcome to QuickRide
1. Book Taxi
2. My Rides
3. Help`;
    } else if (userRaw === '1') {
      session.step = 'PICK_TOWN';
      session.page = 1;
      const towns = uniqueTowns();
      response = `CON Select PICK-UP town:
` + buildMenuFromArray(towns, 1, PAGE_SIZE);
    } else if (userRaw === '2') {
      response = `END Feature not implemented yet.`;
    } else if (userRaw === '3') {
      response = `END For help call 0800-000-000`;
    } else {
      response = `END Invalid option`;
    }
    return send(response);
  }

  // PICK_TOWN
  if (session.step === 'PICK_TOWN') {
    const towns = uniqueTowns();
    const page = session.page || 1;
    const parsed = parseInt(userRaw);
    if (isNaN(parsed)) return send('END Invalid selection');

    // More
    if (parsed === 0) {
      session.page = page + 1;
      response = `CON Select PICK-UP town:
` + buildMenuFromArray(towns, session.page, PAGE_SIZE);
      return send(response);
    }

    const index = (page - 1) * PAGE_SIZE + (parsed - 1);
    if (index < 0 || index >= towns.length) return send('END Invalid selection');

    session.pickupTown = towns[index];
    session.step = 'PICK_ZONE';
    session.page = 1;
    const zones = zonesForTown(session.pickupTown);
    response = `CON Select PICK-UP zone in ${session.pickupTown}:
` + buildZoneMenuFromObjects(zones, 1, PAGE_SIZE);
    return send(response);
  }

  // PICK_ZONE
  if (session.step === 'PICK_ZONE') {
    const zones = zonesForTown(session.pickupTown);
    const page = session.page || 1;
    const parsed = parseInt(userRaw);
    if (isNaN(parsed)) return send('END Invalid selection');

    if (parsed === 0) {
      session.page = page + 1;
      response = `CON Select PICK-UP zone in ${session.pickupTown}:
` + buildZoneMenuFromObjects(zones, session.page, PAGE_SIZE);
      return send(response);
    }

    const idx = (page - 1) * PAGE_SIZE + (parsed - 1);
    if (idx < 0 || idx >= zones.length) return send('END Invalid selection');

    session.pickupZone = zones[idx]; // object
    session.step = 'DROP_TOWN';
    session.page = 1;

    // Build drop town list: if lat/lon available we can filter by distance
    let candidateTowns;
    if (session.pickupZone.latitude && session.pickupZone.longitude) {
      // compute distances to each zone, then unique towns whose ANY zone is within MAX_DISTANCE_KM
      const withinTowns = {};
      locations.forEach(l => {
        if (l.latitude && l.longitude) {
          const d = haversineKm(session.pickupZone.latitude, session.pickupZone.longitude, l.latitude, l.longitude);
          if (d <= MAX_DISTANCE_KM) withinTowns[l.town] = true;
        }
      });
      candidateTowns = Object.keys(withinTowns).sort();
      if (candidateTowns.length === 0) {
        // fallback: allow all towns
        candidateTowns = uniqueTowns();
      }
    } else {
      // no lat/lon: allow all towns
      candidateTowns = uniqueTowns();
    }

    session.candidateTowns = candidateTowns; // store for drop selection
    response = `CON Select DROP-OFF town:
` + buildMenuFromArray(candidateTowns, 1, PAGE_SIZE);
    return send(response);
  }

  // DROP_TOWN
  if (session.step === 'DROP_TOWN') {
    const towns = session.candidateTowns || uniqueTowns();
    const page = session.page || 1;
    const parsed = parseInt(userRaw);
    if (isNaN(parsed)) return send('END Invalid selection');

    if (parsed === 0) {
      session.page = page + 1;
      response = `CON Select DROP-OFF town:
` + buildMenuFromArray(towns, session.page, PAGE_SIZE);
      return send(response);
    }

    const index = (page - 1) * PAGE_SIZE + (parsed - 1);
    if (index < 0 || index >= towns.length) return send('END Invalid selection');

    session.dropTown = towns[index];
    session.step = 'DROP_ZONE';
    session.page = 1;

    const zones = zonesForTown(session.dropTown);
    response = `CON Select DROP-OFF zone in ${session.dropTown}:
` + buildZoneMenuFromObjects(zones, 1, PAGE_SIZE);
    return send(response);
  }

  // DROP_ZONE
  if (session.step === 'DROP_ZONE') {
    const zones = zonesForTown(session.dropTown);
    const page = session.page || 1;
    const parsed = parseInt(userRaw);
    if (isNaN(parsed)) return send('END Invalid selection');

    if (parsed === 0) {
      session.page = page + 1;
      response = `CON Select DROP-OFF zone in ${session.dropTown}:
` + buildZoneMenuFromObjects(zones, session.page, PAGE_SIZE);
      return send(response);
    }

    const idx = (page - 1) * PAGE_SIZE + (parsed - 1);
    if (idx < 0 || idx >= zones.length) return send('END Invalid selection');

    session.dropZone = zones[idx];
    session.step = 'CONFIRM';

    response = `CON Confirm Ride:
From: ${session.pickupZone.zone_name} (${session.pickupTown})
To: ${session.dropZone.zone_name} (${session.dropTown})
1. Confirm
2. Cancel`;
    return send(response);
  }

  // CONFIRM
  if (session.step === 'CONFIRM') {
    if (userRaw === '1') {
      // create ride request placeholder -- here you would save to DB / notify drivers
      session.step = 'DONE';
      response = `END Your ride request has been received. We will notify drivers nearby.`;
    } else {
      session.step = 'MAIN';
      response = `END Ride cancelled.`;
    }

    return send(response);
  }

  // fallback
  return send('END Unexpected error');
});

// Admin endpoints (optional) -- reload CSV without restart
app.post('/admin/reload-csv', (req, res) => {
  loadCsv();
  return res.json({ ok: true, locations: locations.length });
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`USSD backend running on port ${PORT}`));
