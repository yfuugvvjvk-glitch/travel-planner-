// ── Geocoding & Routing ──────────────────────────────────────────
const Routing = (() => {

  async function geocode(street, number, city, county) {
    const q = [street, number, city, county, 'Romania'].filter(Boolean).join(', ');
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}&countrycodes=ro`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'ro' } });
    const data = await res.json();
    if (!data.length) throw new Error('Adresa nu a fost găsită.');
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
  }

  // Geocode with street optional — fallback to city center
  async function geocodeSmart(street, number, city, county) {
    // Try full address first
    if (street) {
      try {
        return await geocode(street, number, city, county);
      } catch { /* fallback */ }
    }
    // Fallback: just city + county center
    const q = [city, county, 'Romania'].filter(Boolean).join(', ');
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}&countrycodes=ro`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'ro' } });
    const data = await res.json();
    if (!data.length) throw new Error('Localitatea nu a fost găsită.');
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
  }

  // Search POI/address — returns array of suggestions
  async function searchPOI(query, city, county) {
    // Build contextual query
    const context = [city, county, 'Romania'].filter(Boolean).join(', ');
    const q = context ? `${query}, ${context}` : `${query}, Romania`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=7&q=${encodeURIComponent(q)}&countrycodes=ro&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'ro' } });
    const data = await res.json();
    return data.map(item => {
      const a = item.address || {};
      return {
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        displayName: item.display_name,
        name: item.name || item.display_name.split(',')[0],
        street: a.road || a.pedestrian || a.footway || '',
        number: a.house_number || '',
        city: a.city || a.town || a.village || a.municipality || '',
        county: a.county || '',
        type: item.type || item.class || ''
      };
    });
  }

  // Get route for full path — also returns steps with town names
  async function getRoute(waypoints, profile) {
    const osrmProfile = (profile === 'transit') ? 'driving' : profile;

    // Deduplicate consecutive waypoints that are identical or too close (<50m)
    const deduped = [waypoints[0]];
    for (let i = 1; i < waypoints.length; i++) {
      const prev = deduped[deduped.length - 1];
      const curr = waypoints[i];
      const dist = Math.sqrt(Math.pow(prev.lat - curr.lat, 2) + Math.pow(prev.lng - curr.lng, 2));
      if (dist > 0.0005) deduped.push(curr); // ~50m threshold
    }
    if (deduped.length < 2) throw new Error('Sunt necesare cel puțin 2 locații diferite pentru a calcula traseul.');

    const coords = deduped.map(w => `${w.lng},${w.lat}`).join(';');

    const endpoints = [
      `https://router.project-osrm.org/route/v1/${osrmProfile}/${coords}?overview=full&geometries=geojson&steps=true`,
      `https://routing.openstreetmap.de/routed-${osrmProfile === 'driving' ? 'car' : osrmProfile === 'walking' ? 'foot' : 'bike'}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`,
    ];

    let data = null;
    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) continue;
        data = await res.json();
        if (data.code === 'Ok') break;
      } catch { continue; }
    }

    if (!data || data.code !== 'Ok') throw new Error('Serverul de rutare nu răspunde. Verifică conexiunea la internet și încearcă din nou.');

    const route = data.routes[0];
    const towns = extractTownsFromSteps(route.legs);
    return {
      distanceM: route.distance,
      durationS: calcDuration(route.distance, profile),
      geometry: route.geometry,
      towns,
      legs: (route.legs || []).map(leg => ({ distance: leg.distance, duration: leg.duration }))
    };
  }

  // Extract locality names from OSRM step names (road names contain town hints)
  function extractTownsFromSteps(legs) {
    const seen = new Set();
    const towns = [];
    if (!legs) return towns;
    legs.forEach(leg => {
      if (!leg.steps) return;
      leg.steps.forEach(step => {
        // OSRM step.ref or step.name sometimes contains locality
        const name = step.name || '';
        // Filter out road codes (DN, E, A) and keep locality-like names
        if (name && name.length > 2 && !/^(DN|DJ|DC|E\d|A\d|\d)/.test(name) && !seen.has(name)) {
          seen.add(name);
          towns.push({ name, lat: step.maneuver.location[1], lng: step.maneuver.location[0] });
        }
      });
    });
    return towns;
  }

  // Reverse geocode a coordinate to get locality name
  async function reverseGeocode(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&accept-language=ro`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.address) return null;
    const a = data.address;
    return a.city || a.town || a.village || a.municipality || a.county || null;
  }

  // Sample points along GeoJSON LineString and reverse geocode to find towns
  async function getTownsAlongRoute(geometry, maxSamples = 8) {
    const coords = geometry.coordinates;
    if (!coords || coords.length < 2) return [];
    const step = Math.max(1, Math.floor(coords.length / maxSamples));
    const samples = [];
    for (let i = step; i < coords.length - step; i += step) {
      samples.push({ lat: coords[i][1], lng: coords[i][0] });
    }
    const towns = [];
    const seen = new Set();
    // Sequential to respect Nominatim rate limit
    for (const pt of samples) {
      try {
        const name = await reverseGeocode(pt.lat, pt.lng);
        if (name && !seen.has(name)) {
          seen.add(name);
          towns.push({ name, lat: pt.lat, lng: pt.lng });
        }
        await new Promise(r => setTimeout(r, 300)); // rate limit
      } catch { /* skip */ }
    }
    return towns;
  }

  // Get route for a single segment (A -> B)
  async function getSegment(from, to, profile) {
    const osrmProfile = (profile === 'transit') ? 'driving' : profile;
    const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok') return { distanceM: 0, durationS: 0 };
    const distanceM = data.routes[0].distance;
    // Always recalculate duration based on realistic speed for the profile
    const durationS = calcDuration(distanceM, profile);
    return { distanceM, durationS };
  }

  // Realistic speeds per profile
  const SPEED_KMH = { driving: 70, walking: 5, cycling: 15, transit: 60, hitchhike: 55, ferry: 25 };

  function calcDuration(distanceM, profile) {
    const speedKmh = SPEED_KMH[profile] || 50;
    return (distanceM / 1000) / speedKmh * 3600;
  }

  // Public alias used by interval variants
  function calcDurationPublic(distanceM, profile) {
    return calcDuration(distanceM, profile);
  }

  // ── Cost & transport details per segment ──
  const FUEL_L_PER_100KM = 7;
  const FUEL_PRICE_RON = 7.5;
  const BUS_RON_PER_KM = 0.18;   // ~18 bani/km autobuz interurban
  const TRAIN_RON_PER_KM = 0.14; // ~14 bani/km tren CFR clasa 2
  const WALK_SPEED_KMH = 5;
  const BIKE_SPEED_KMH = 15;

  function segmentCost(distanceM, profile) {
    const km = distanceM / 1000;
    if (profile === 'driving') {
      const cost = (km * FUEL_L_PER_100KM / 100) * FUEL_PRICE_RON;
      return { amount: cost, label: `~${cost.toFixed(1)} RON combustibil` };
    }
    if (profile === 'transit') {
      // Estimate: bus for short (<80km), train for long
      if (km < 80) {
        const cost = km * BUS_RON_PER_KM;
        return { amount: cost, label: `~${cost.toFixed(1)} RON autobuz` };
      } else {
        const cost = km * TRAIN_RON_PER_KM;
        return { amount: cost, label: `~${cost.toFixed(1)} RON tren` };
      }
    }
    return { amount: 0, label: 'gratuit' };
  }

  function transitType(distanceM) {
    return distanceM / 1000 < 80 ? 'bus' : 'train';
  }

  // Generate realistic departure times based on departure time + elapsed
  // Returns array of segment details
  function buildSegments(waypoints, segResults, profile, departureDatetime) {
    const segments = [];
    let currentTime = new Date(departureDatetime);

    for (let i = 0; i < segResults.length; i++) {
      const seg = segResults[i];
      const from = waypoints[i];
      const to = waypoints[i + 1];
      const km = seg.distanceM / 1000;
      const cost = segmentCost(seg.distanceM, profile);

      let icon, modeName, color, waitMin = 0;

      if (profile === 'driving') {
        icon = 'fa-car'; modeName = 'Mașină personală'; color = '#1a73e8';
      } else if (profile === 'walking') {
        icon = 'fa-person-walking'; modeName = 'Mers pe jos'; color = '#e65100';
      } else if (profile === 'cycling') {
        icon = 'fa-bicycle'; modeName = 'Bicicletă'; color = '#2e7d32';
      } else if (profile === 'transit') {
        const tt = transitType(seg.distanceM);
        if (tt === 'bus') {
          icon = 'fa-bus'; modeName = 'Autobuz'; color = '#7b1fa2';
          // Round departure to next bus (every 30 min)
          waitMin = roundToNext(currentTime, 30);
        } else {
          icon = 'fa-train'; modeName = 'Tren CFR'; color = '#c62828';
          // Round departure to next train (every 60 min)
          waitMin = roundToNext(currentTime, 60);
        }
      }

      const departureTime = new Date(currentTime.getTime() + waitMin * 60000);
      const arrivalTime = new Date(departureTime.getTime() + seg.durationS * 1000);

      segments.push({
        from: from.label || `Punct ${i + 1}`,
        to: to.label || `Punct ${i + 2}`,
        distanceM: seg.distanceM,
        durationS: seg.durationS,
        waitMin,
        departureTime: new Date(departureTime),
        arrivalTime: new Date(arrivalTime),
        cost,
        icon,
        modeName,
        color,
        km: km.toFixed(1)
      });

      // Next segment starts after arrival + small buffer (5 min)
      currentTime = new Date(arrivalTime.getTime() + 5 * 60000);
    }
    return segments;
  }

  // Round time to next interval (e.g. next 30 min slot) and return wait minutes
  function roundToNext(date, intervalMin) {
    const mins = date.getMinutes();
    const rem = intervalMin - (mins % intervalMin);
    return rem === intervalMin ? 0 : rem;
  }

  function formatTime(date) {
    return date.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDistance(m) {
    if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
    return Math.round(m) + ' m';
  }

  function formatDuration(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}min`;
    return `${m} min`;
  }

  function totalCost(segments) {
    const total = segments.reduce((s, seg) => s + seg.cost.amount, 0);
    return total > 0 ? `~${total.toFixed(1)} RON` : 'gratuit';
  }

  return {
    geocode, geocodeSmart, searchPOI,
    getRoute, getSegment, buildSegments,
    formatDistance, formatDuration, formatTime, totalCost,
    segmentCost, transitType, calcDurationPublic,
    getTownsAlongRoute, reverseGeocode
  };
})();
