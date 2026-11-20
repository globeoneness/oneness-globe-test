// Oneness Globe — free Cloudflare Worker backend.
//
// Two jobs, both on Cloudflare's free tier (no credit card, no Google billing):
//   GET  /distance?from=..&to=..   -> road distance via free OpenStreetMap
//   POST /verify-journey           -> compare a TA/DA claim to 30-day GPS history
//
// Security: /verify-journey requires the caller's Firebase ID token. The Worker
// reads the GPS history straight from Firestore WITH THAT TOKEN, so Firestore
// security rules decide what the caller may see (HR/admins only). No service
// account key is stored here. For tamper-proof verification you can later switch
// to a Firebase Admin service account + a rule that blocks clients from writing
// `journeyVerification` (see JOURNEY_VERIFICATION_SETUP.md).

const UA = 'OnenessGlobe/1.0 (veterinary field app)';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/distance') return await distance(url);
      if (url.pathname === '/verify-journey' && request.method === 'POST') {
        return await verifyJourney(request);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: `${e}` }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ---------- free OpenStreetMap distance ----------
async function geocode(q) {
  if (!q || !q.trim()) return null;
  let query = q.trim();
  if (!query.toLowerCase().includes('bangladesh')) query += ', Bangladesh';
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=bd&q=${encodeURIComponent(query)}`;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const list = await r.json();
  if (!list.length) return null;
  return { lat: parseFloat(list[0].lat), lng: parseFloat(list[0].lon) };
}

async function distance(url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const a = await geocode(from);
  const b = await geocode(to);
  if (!a) return json({ error: 'from_not_found' }, 422);
  if (!b) return json({ error: 'to_not_found' }, 422);
  const ru = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
  const rr = await fetch(ru, { headers: { 'User-Agent': UA } });
  if (!rr.ok) return json({ error: 'route_service_busy' }, 503);
  const j = await rr.json();
  const route = (j.routes || [])[0];
  if (!route) return json({ error: 'no_route' }, 422);
  return json({
    km: Math.round((route.distance / 1000) * 10) / 10,
    originLat: a.lat, originLng: a.lng, destLat: b.lat, destLng: b.lng,
  });
}

// ---------- journey verification ----------
function metres(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function verifyJourney(request) {
  const body = await request.json();
  const idToken = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim()
    || body.idToken;
  const { projectId, prefix = '', claim } = body;
  if (!idToken) return json({ error: 'missing_token' }, 401);
  if (!projectId || !claim) return json({ error: 'missing_params' }, 400);

  const { userId, day, originLat, originLng, destLat, destLng } = claim;
  if (originLat == null || destLat == null) {
    return json({ status: 'insufficient', reason: 'Claim has no From/To map points to check.', nearFrom: 0, nearTo: 0, points: 0 });
  }

  // Read this employee's GPS points for the day, using the caller's token so
  // Firestore rules apply.
  const q = {
    structuredQuery: {
      from: [{ collectionId: `${prefix}location_history` }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            { fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: { stringValue: userId } } },
            { fieldFilter: { field: { fieldPath: 'day' }, op: 'EQUAL', value: { stringValue: day } } },
          ],
        },
      },
    },
  };
  const r = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
    { method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
  if (!r.ok) return json({ error: 'firestore_read_failed', detail: await r.text() }, 502);
  const rows = await r.json();
  const pts = rows.filter((x) => x.document).map((x) => {
    const f = x.document.fields;
    return { lat: +f.lat.doubleValue, lng: +f.lng.doubleValue, acc: f.acc ? +f.acc.doubleValue : 0 };
  });
  if (!pts.length) {
    return json({ status: 'insufficient', reason: 'No GPS journey recorded for this day.', nearFrom: 0, nearTo: 0, points: 0 });
  }

  let nearFrom = 0, nearTo = 0;
  for (const p of pts) {
    const tol = 500 + (p.acc || 0);
    if (metres(p.lat, p.lng, originLat, originLng) <= tol) nearFrom++;
    if (metres(p.lat, p.lng, destLat, destLng) <= tol) nearTo++;
  }
  let status, reason;
  if (nearFrom > 0 && nearTo > 0) { status = 'verified'; reason = 'GPS shows the employee near both From and To on this day.'; }
  else if (nearFrom > 0 || nearTo > 0) { status = 'partial'; reason = `GPS matches only ${nearFrom > 0 ? 'the From' : 'the To'} place.`; }
  else { status = 'mismatch'; reason = 'GPS was recorded but not near the claimed places.'; }
  return json({ status, reason, nearFrom, nearTo, points: pts.length });
}

// deploy: trigger Workers Build 20261120T002016Z
