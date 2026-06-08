// ── Main App ─────────────────────────────────────────────────────
(function () {
  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  // Init map centered on Romania
  const map = L.map('map').setView([45.9432, 24.9668], 7);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19
  }).addTo(map);

  let markers = {};
  let routeLayer = null;
  let townMarkers = [];
  let currentMode = 'driving';
  let imageDataUrls = [];
  let addingWaypoint = false;

  // ── Icons ──
  function makeIcon(color, label) {
    return L.divIcon({
      className: '',
      html: `<div style="background:${color};color:#fff;border-radius:50% 50% 50% 0;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8rem;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);transform:rotate(-45deg)"><span style="transform:rotate(45deg)">${label}</span></div>`,
      iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -34]
    });
  }

  function refreshMarkerIcons() {
    LocationStore.getAll().forEach((loc, i) => {
      if (markers[loc.id]) markers[loc.id].setIcon(makeIcon('#1a73e8', i + 1));
    });
  }

  function addMarker(loc) {
    const allLocs = LocationStore.getAll();
    const idx = allLocs.findIndex(l => l.id === loc.id) + 1;
    const color = loc.favorite ? '#f57c00' : (loc.color || '#1a73e8');

    // Check for overlapping markers and apply small offset
    let lat = loc.lat, lng = loc.lng;
    const OFFSET = 0.0003;
    let offsetCount = 0;
    Object.values(markers).forEach(m => {
      const pos = m.getLatLng();
      if (Math.abs(pos.lat - lat) < 0.0005 && Math.abs(pos.lng - lng) < 0.0005) {
        offsetCount++;
      }
    });
    if (offsetCount > 0) {
      const angle = (offsetCount * 60) * Math.PI / 180;
      lat += OFFSET * Math.cos(angle);
      lng += OFFSET * Math.sin(angle);
    }

    const m = L.marker([lat, lng], { icon: makeIcon(color, idx) })
      .addTo(map).bindPopup(UI.buildPopupHtml(loc), { maxWidth: 300 });
    markers[loc.id] = m;
  }

  function removeMarker(id) {
    if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
  }

  let trafficMarkers = [];

  function clearRoute() {
    if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
    townMarkers.forEach(m => map.removeLayer(m));
    townMarkers = [];
    trafficMarkers.forEach(m => map.removeLayer(m));
    trafficMarkers = [];
    const gmBtn = document.getElementById('btn-gmaps');
    if (gmBtn) gmBtn.remove();
    document.getElementById('towns-panel').style.display = 'none';
    document.getElementById('towns-list').innerHTML = '';
    document.getElementById('variants-panel').style.display = 'none';
    document.getElementById('variants-list').innerHTML = '';
    UI.hideSummary();
  }

  // ── API persistence (MySQL via backend) + localStorage fallback ──
  const STORAGE_KEY = 'travel_planner_data';
  const API_BASE = window.location.origin;
  const HAS_BACKEND = window.location.protocol !== 'file:';

  // ── Cloud sync (JSONBin.io) ───────────────────────────────────────
  const CLOUD_KEY       = 'travel_planner_cloud_bin';   // ID bin JSONBin
  const CLOUD_APIKEY    = 'travel_planner_cloud_apikey'; // API key JSONBin
  const JSONBIN_BASE    = 'https://api.jsonbin.io/v3';

  function getCloudConfig() {
    return {
      binId:  localStorage.getItem(CLOUD_KEY)    || '',
      apiKey: localStorage.getItem(CLOUD_APIKEY) || ''
    };
  }

  async function cloudPush() {
    const { binId, apiKey } = getCloudConfig();
    if (!binId || !apiKey) return false;
    try {
      const locs = LocationStore.getAll().map(l => ({ ...l, images: [] }));
      const payload = { locations: locs, state: { start: LocationStore.getStart(), mode: currentMode } };
      const res = await fetch(`${JSONBIN_BASE}/b/${binId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
        body: JSON.stringify(payload)
      });
      return res.ok;
    } catch { return false; }
  }

  async function cloudPull() {
    const { binId, apiKey } = getCloudConfig();
    if (!binId || !apiKey) return null;
    try {
      const res = await fetch(`${JSONBIN_BASE}/b/${binId}/latest`, {
        headers: { 'X-Master-Key': apiKey }
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.record || null;
    } catch { return null; }
  }

  // Salvează O singură locație în API
  async function apiSaveLoc(loc) {
    if (!HAS_BACKEND) return;
    try {
      await fetch(`${API_BASE}/api/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loc)
      });
    } catch { /* silent */ }
  }

  // Șterge O singură locație din API
  async function apiDeleteLoc(id) {
    if (!HAS_BACKEND) return;
    try {
      await fetch(`${API_BASE}/api/locations/${id}`, { method: 'DELETE' });
    } catch { /* silent */ }
  }

  // Salvează starea (start + mode) în API
  async function apiSaveState() {
    if (!HAS_BACKEND) return;
    try {
      await fetch(`${API_BASE}/api/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: LocationStore.getStart() || null, mode: currentMode })
      });
    } catch { /* silent */ }
  }

  // Salvează ordinea locațiilor în API
  async function apiSaveOrder() {
    if (!HAS_BACKEND) return;
    try {
      await fetch(`${API_BASE}/api/locations/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: LocationStore.getAll().map(l => l.id) })
      });
    } catch { /* silent */ }
  }

  // saveToStorage — păstrează localStorage ca backup + salvează starea
  function saveToStorage() {
    try {
      const locs = LocationStore.getAll().map(l => ({ ...l, images: [] }));
      const start = LocationStore.getStart();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ locations: locs, start, mode: currentMode }));
    } catch { /* blocked by browser security when running from file:// */ }
    apiSaveState();
  }

  // ── Aplică datele încărcate (locații + stare) pe hartă ──────────
  function applyLoadedData(locations, state) {
    if (state && state.mode) {
      currentMode = state.mode;
      document.querySelectorAll('.transport-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === currentMode);
      });
    }
    if (state && state.start) {
      LocationStore.setStart(state.start);
      if (markers['__start__']) map.removeLayer(markers['__start__']);
      markers['__start__'] = L.marker([state.start.lat, state.start.lng], { icon: makeIcon('#34a853', 'S') })
        .addTo(map).bindPopup(`<b>${state.start.label}</b>`);
      document.getElementById('start-search-input').value = state.start.label;
      document.getElementById('btn-start-clear').classList.remove('hidden');
    }
    if (locations && locations.length) {
      locations.forEach(loc => {
        LocationStore.add(loc);
        addMarker(LocationStore.getAll().at(-1));
      });
      refreshMarkerIcons();
      const allPts = [...(state && state.start ? [state.start] : []), ...locations];
      if (allPts.length > 1) {
        const lats = allPts.map(p => p.lat), lngs = allPts.map(p => p.lng);
        map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [40, 40] });
      } else if (state && state.start) {
        map.setView([state.start.lat, state.start.lng], 12);
      }
    }
    renderAll();
  }

  async function loadFromStorage() {
    if (HAS_BACKEND) {
      try {
        // Încarcă locațiile și starea de pe server
        const locRes = await fetch(`${API_BASE}/api/locations`);
        const locData = await locRes.json();

        let state = {};
        try {
          const stateRes = await fetch(`${API_BASE}/api/state`);
          if (stateRes.ok) {
            const stateData = await stateRes.json();
            state = stateData.state || {};
          }
        } catch { /* state indisponibil */ }

        // ── Migrare automată din localStorage dacă serverul e gol ──
        if ((!locData.locations || locData.locations.length === 0) && !state.start) {
          try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
              const localData = JSON.parse(raw);
              if (localData.locations && localData.locations.length > 0) {
                // Trimite datele locale pe server
                await fetch(`${API_BASE}/api/import`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    locations: localData.locations,
                    start: localData.start || null,
                    mode: localData.mode || 'driving'
                  })
                });
                // Reîncarcă de pe server după migrare
                const locRes2 = await fetch(`${API_BASE}/api/locations`);
                const locData2 = await locRes2.json();
                const stateRes2 = await fetch(`${API_BASE}/api/state`);
                const stateData2 = await stateRes2.json();
                applyLoadedData(locData2.locations || [], stateData2.state || {});
                return;
              }
            }
          } catch { /* migrare eșuată, continuăm */ }
        }

        applyLoadedData(locData.locations || [], state);
        return;
      } catch (e) { /* fallback la localStorage */ }
    }

    // Fallback: localStorage
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      applyLoadedData(data.locations || [], { mode: data.mode, start: data.start });
    } catch { /* ignore corrupt data */ }
  }

  // ── Departure bar ──
  const departureTypeEl = document.getElementById('departure-type');
  const departureTimeEl = document.getElementById('departure-time');
  const intervalRow = document.getElementById('departure-interval-row');

  function nowLocalISO() {
    const d = new Date(); d.setSeconds(0, 0);
    return d.toISOString().slice(0, 16);
  }
  departureTimeEl.value = nowLocalISO();

  departureTypeEl.addEventListener('change', () => {
    const v = departureTypeEl.value;
    departureTimeEl.style.display = (v === 'depart' || v === 'arrive') ? 'block' : 'none';
    intervalRow.style.display = v === 'interval' ? 'flex' : 'none';
    clearRoute();
  });
  departureTimeEl.addEventListener('change', clearRoute);

  function getDepartureDate() {
    if (departureTypeEl.value === 'now') return new Date();
    return new Date(departureTimeEl.value);
  }

  // ── Transport mode ──
  document.querySelectorAll('.transport-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.transport-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      saveToStorage();
      clearRoute();
    });
  });

  // ── GPS ──
  document.getElementById('btn-use-gps').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Geolocalizarea nu este suportată.');
    navigator.geolocation.getCurrentPosition(pos => {
      setStartLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Locația mea curentă' });
    }, () => alert('Nu s-a putut obține locația.'));
  });

  // ── Start search with POI ──
  const startInput = document.getElementById('start-search-input');
  const startSuggestions = document.getElementById('start-suggestions');
  const btnStartClear = document.getElementById('btn-start-clear');
  let startTimer = null;

  startInput.addEventListener('input', () => {
    clearTimeout(startTimer);
    const q = startInput.value.trim();
    btnStartClear.classList.toggle('hidden', !q);
    if (q.length < 2) { startSuggestions.classList.add('hidden'); return; }
    startTimer = setTimeout(() => searchStartPOI(q), 450);
  });

  btnStartClear.addEventListener('click', () => {
    startInput.value = ''; btnStartClear.classList.add('hidden');
    startSuggestions.classList.add('hidden');
  });

  startInput.addEventListener('keydown', e => { if (e.key === 'Escape') startSuggestions.classList.add('hidden'); });

  document.addEventListener('click', e => {
    if (!document.getElementById('start-search-box').contains(e.target)) startSuggestions.classList.add('hidden');
    if (!document.getElementById('poi-search-wrap') || !document.getElementById('poi-search-wrap').contains(e.target))
      document.getElementById('poi-suggestions').classList.add('hidden');
  });

  async function searchStartPOI(q) {
    startSuggestions.innerHTML = '<li class="sug-empty"><i class="fa-solid fa-spinner fa-spin"></i> Se caută...</li>';
    startSuggestions.classList.remove('hidden');
    try {
      const results = await Routing.searchPOI(q, '', '');
      startSuggestions.innerHTML = '';
      if (!results.length) { startSuggestions.innerHTML = '<li class="sug-empty">Niciun rezultat</li>'; return; }
      results.forEach(r => {
        const li = document.createElement('li');
        const sub = r.displayName.split(',').slice(1, 3).join(',').trim();
        li.innerHTML = `<i class="fa-solid fa-location-dot"></i><div><div class="sug-name">${r.name}</div><div class="sug-sub">${sub}</div></div>`;
        li.addEventListener('click', () => {
          setStartLocation({ lat: r.lat, lng: r.lng, label: r.name });
          startInput.value = r.name;
          btnStartClear.classList.remove('hidden');
          startSuggestions.classList.add('hidden');
        });
        startSuggestions.appendChild(li);
      });
    } catch { startSuggestions.innerHTML = '<li class="sug-empty">Eroare</li>'; }
  }

  function setStartLocation(loc) {
    LocationStore.setStart(loc);
    if (markers['__start__']) map.removeLayer(markers['__start__']);
    markers['__start__'] = L.marker([loc.lat, loc.lng], { icon: makeIcon('#34a853', 'S') })
      .addTo(map).bindPopup(`<b>${loc.label}</b>`);
    map.setView([loc.lat, loc.lng], 13);
    startInput.value = loc.label;
    btnStartClear.classList.remove('hidden');
    renderAll(); clearRoute(); saveToStorage();
  }

  // ── POI search in modal ──
  const poiInput = document.getElementById('f-poi-search');
  const poiSuggestions = document.getElementById('poi-suggestions');
  const poiClear = document.getElementById('btn-poi-clear');
  let poiTimer = null;

  poiInput.addEventListener('input', () => {
    clearTimeout(poiTimer);
    const q = poiInput.value.trim();
    poiClear.classList.toggle('hidden', !q);
    if (q.length < 2) { poiSuggestions.classList.add('hidden'); return; }
    poiTimer = setTimeout(() => runPOISearch(q), 450);
  });

  poiClear.addEventListener('click', () => {
    poiInput.value = ''; poiClear.classList.add('hidden'); poiSuggestions.classList.add('hidden');
  });

  async function runPOISearch(q) {
    const city = document.getElementById('f-city').value.trim();
    const county = document.getElementById('f-county').value.trim();
    poiSuggestions.innerHTML = '<li class="sug-empty"><i class="fa-solid fa-spinner fa-spin"></i> Se caută...</li>';
    poiSuggestions.classList.remove('hidden');
    try {
      const results = await Routing.searchPOI(q, city, county);
      poiSuggestions.innerHTML = '';
      if (!results.length) { poiSuggestions.innerHTML = '<li class="sug-empty">Niciun rezultat</li>'; return; }
      results.forEach(r => {
        const li = document.createElement('li');
        const sub = r.displayName.split(',').slice(1, 3).join(',').trim();
        li.innerHTML = `<i class="fa-solid fa-location-dot"></i><div><div class="sug-name">${r.name}</div><div class="sug-sub">${sub}</div></div>`;
        li.addEventListener('click', () => {
          document.getElementById('f-street').value = r.street || '';
          document.getElementById('f-number').value = r.number || '';
          document.getElementById('f-city').value = r.city || '';
          document.getElementById('f-county').value = (r.county || '').replace(/ County| Județ/g, '');
          if (!document.getElementById('f-description').value) document.getElementById('f-description').value = r.name;
          poiInput.value = r.name; poiClear.classList.remove('hidden'); poiSuggestions.classList.add('hidden');
          document.getElementById('location-form').dataset.resolvedLat = r.lat;
          document.getElementById('location-form').dataset.resolvedLng = r.lng;
          document.getElementById('location-form').dataset.resolvedDisplay = r.displayName;
          UI.setGeocodeStatus(`✓ ${r.displayName.split(',').slice(0,3).join(',')}`, 'ok');
        });
        poiSuggestions.appendChild(li);
      });
    } catch { poiSuggestions.innerHTML = '<li class="sug-empty">Eroare</li>'; }
  }

  // ── Show/hide house details based on construction type ──
  document.querySelectorAll('input[name="f-house"]').forEach(r => {
    r.addEventListener('change', () => {
      const v = document.querySelector('input[name="f-house"]:checked')?.value || 'nu';
      const show = ['locuibila','renovabila','demolare'].includes(v);
      document.getElementById('house-details-section').style.display = show ? 'block' : 'none';
    });
  });

  // ── Property section toggle ──
  document.getElementById('prop-toggle').addEventListener('click', () => {
    const sec = document.getElementById('prop-section');
    const chev = document.getElementById('prop-chevron');
    const open = sec.style.display === 'none';
    sec.style.display = open ? 'block' : 'none';
    chev.classList.toggle('open', open);
  });

  // ── Price auto-calc ──
  const EUR_TO_RON = 4.97; // approximate

  function getAreaInSqm() {
    // Remove thousand separators (. or ,) that browsers may insert
    const raw = document.getElementById('f-area').value.replace(/[.,](?=\d{3})/g, '').replace(',', '.');
    const val = parseFloat(raw) || 0;
    const unit = document.getElementById('f-area-unit').value;
    if (unit === 'ha') return val * 10000;
    if (unit === 'ari') return val * 100;
    return val;
  }

  function updatePriceCalc(changedField) {
    const sqm = getAreaInSqm();
    const totalEur = parseFloat(document.getElementById('f-price-total').value) || 0;
    const sqmEur   = parseFloat(document.getElementById('f-price-sqm').value) || 0;
    const totalRon = parseFloat(document.getElementById('f-price-ron').value) || 0;
    const result   = document.getElementById('price-calc-result');

    if (changedField === 'total' && totalEur > 0) {
      if (sqm > 0) document.getElementById('f-price-sqm').value = (totalEur / sqm).toFixed(2);
      document.getElementById('f-price-ron').value = Math.round(totalEur * EUR_TO_RON);
      result.textContent = sqm > 0 ? `${(totalEur/sqm).toFixed(2)} €/mp · ${Math.round(totalEur * EUR_TO_RON).toLocaleString()} RON total` : `${Math.round(totalEur * EUR_TO_RON).toLocaleString()} RON total`;
    } else if (changedField === 'sqm' && sqmEur > 0 && sqm > 0) {
      const tot = sqmEur * sqm;
      document.getElementById('f-price-total').value = Math.round(tot);
      document.getElementById('f-price-ron').value = Math.round(tot * EUR_TO_RON);
      result.textContent = `${Math.round(tot).toLocaleString()} € total · ${Math.round(tot * EUR_TO_RON).toLocaleString()} RON total`;
    } else if (changedField === 'ron' && totalRon > 0) {
      const eur = totalRon / EUR_TO_RON;
      document.getElementById('f-price-total').value = Math.round(eur);
      if (sqm > 0) document.getElementById('f-price-sqm').value = (eur / sqm).toFixed(2);
      result.textContent = `${Math.round(eur).toLocaleString()} € total${sqm > 0 ? ` · ${(eur/sqm).toFixed(2)} €/mp` : ''}`;
    } else if (changedField === 'area' && sqm > 0) {
      if (totalEur > 0) {
        document.getElementById('f-price-sqm').value = (totalEur / sqm).toFixed(2);
        result.textContent = `${(totalEur/sqm).toFixed(2)} €/mp`;
      } else if (sqmEur > 0) {
        const tot = sqmEur * sqm;
        document.getElementById('f-price-total').value = Math.round(tot);
        document.getElementById('f-price-ron').value = Math.round(tot * EUR_TO_RON);
        result.textContent = `${Math.round(tot).toLocaleString()} € total · ${Math.round(tot * EUR_TO_RON).toLocaleString()} RON total`;
      }
    }
  }

  document.getElementById('f-price-total').addEventListener('input', () => updatePriceCalc('total'));
  document.getElementById('f-price-sqm').addEventListener('input', () => updatePriceCalc('sqm'));
  document.getElementById('f-price-ron').addEventListener('input', () => updatePriceCalc('ron'));
  document.getElementById('f-area').addEventListener('input', () => updatePriceCalc('area'));
  document.getElementById('f-area-unit').addEventListener('change', () => updatePriceCalc('area'));

  // ── Get/set property fields ──
  function getPropertyData() {
    const checkVal = id => document.getElementById(id)?.checked || false;
    const radioVal = name => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
    return {
      landType:    document.getElementById('f-land-type').value,
      area:        document.getElementById('f-area').value,
      areaUnit:    document.getElementById('f-area-unit').value,
      priceTotal:  document.getElementById('f-price-total').value,
      priceSqm:    document.getElementById('f-price-sqm').value,
      priceRon:    document.getElementById('f-price-ron').value,
      house:       radioVal('f-house'),
      houseFloors: document.getElementById('f-house-floors').value,
      houseArea:   document.getElementById('f-house-area').value,
      houseBaths:  document.getElementById('f-house-baths').value,
      houseKitchen:document.getElementById('f-house-kitchen').value,
      elecPulled:  radioVal('f-elec-pulled'),
      waterPulled: radioVal('f-water-pulled'),
      landConfig:  radioVal('f-land-config'),
      access:      radioVal('f-access'),
      annexes: {
        garage:  checkVal('h-annex-garage'),  barn:    checkVal('h-annex-barn'),
        cellar:  checkVal('h-annex-cellar'),  shed:    checkVal('h-annex-shed'),
        fence:   checkVal('h-annex-fence'),   pool:    checkVal('h-annex-pool'),
        unknown: checkVal('h-annex-unknown'),
      },
      utilities: {
        waterNetwork: checkVal('u-water-network'), waterWell:    checkVal('u-water-well'),
        waterRiver:   checkVal('u-water-river'),   waterNone:    checkVal('u-water-none'),
        waterUnknown: checkVal('u-water-unknown'),
        elecOnsite:   checkVal('u-elec-onsite'),   elecNearby:   checkVal('u-elec-nearby'),
        elecNone:     checkVal('u-elec-none'),      elecUnknown:  checkVal('u-elec-unknown'),
        gasOnsite:    checkVal('u-gas-onsite'),    gasNearby:    checkVal('u-gas-nearby'),
        gasNone:      checkVal('u-gas-none'),       gasUnknown:   checkVal('u-gas-unknown'),
        sewerNetwork: checkVal('u-sewer-network'), sewerSeptic:  checkVal('u-sewer-septic'),
        sewerNone:    checkVal('u-sewer-none'),     sewerUnknown: checkVal('u-sewer-unknown'),
        heatCentral:  checkVal('u-heat-central'),   heatGas:      checkVal('u-heat-gas'),
        heatStove:    checkVal('u-heat-stove'),      heatElectric: checkVal('u-heat-electric'),
        heatNone:     checkVal('u-heat-none'),       heatUnknown:  checkVal('u-heat-unknown'),
      }
    };
  }

  function setPropertyData(p) {
    if (!p) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
    const radio = (name, val) => { const r = document.querySelector(`input[name="${name}"][value="${val}"]`); if (r) r.checked = true; };
    set('f-land-type', p.landType); set('f-area', p.area); set('f-area-unit', p.areaUnit);
    set('f-price-total', p.priceTotal); set('f-price-sqm', p.priceSqm); set('f-price-ron', p.priceRon);
    if (p.house) radio('f-house', p.house);
    set('f-house-floors', p.houseFloors); set('f-house-area', p.houseArea);
    set('f-house-baths', p.houseBaths); set('f-house-kitchen', p.houseKitchen);
    if (p.elecPulled) radio('f-elec-pulled', p.elecPulled);
    if (p.waterPulled) radio('f-water-pulled', p.waterPulled);
    if (p.landConfig) radio('f-land-config', p.landConfig);
    if (p.access) radio('f-access', p.access);
    if (p.annexes) {
      const a = p.annexes;
      chk('h-annex-garage', a.garage); chk('h-annex-barn', a.barn);
      chk('h-annex-cellar', a.cellar); chk('h-annex-shed', a.shed);
      chk('h-annex-fence', a.fence);   chk('h-annex-pool', a.pool);
      chk('h-annex-unknown', a.unknown);
    }
    if (p.utilities) {
      const u = p.utilities;
      chk('u-water-network', u.waterNetwork); chk('u-water-well', u.waterWell);
      chk('u-water-river', u.waterRiver);     chk('u-water-none', u.waterNone);
      chk('u-water-unknown', u.waterUnknown);
      chk('u-elec-onsite', u.elecOnsite);     chk('u-elec-nearby', u.elecNearby);
      chk('u-elec-none', u.elecNone);         chk('u-elec-unknown', u.elecUnknown);
      chk('u-gas-onsite', u.gasOnsite);       chk('u-gas-nearby', u.gasNearby);
      chk('u-gas-none', u.gasNone);           chk('u-gas-unknown', u.gasUnknown);
      chk('u-sewer-network', u.sewerNetwork); chk('u-sewer-septic', u.sewerSeptic);
      chk('u-sewer-none', u.sewerNone);       chk('u-sewer-unknown', u.sewerUnknown);
      chk('u-heat-central', u.heatCentral);   chk('u-heat-gas', u.heatGas);
      chk('u-heat-stove', u.heatStove);       chk('u-heat-electric', u.heatElectric);
      chk('u-heat-none', u.heatNone);         chk('u-heat-unknown', u.heatUnknown);
    }
    // Show house details if needed
    const showHouse = ['locuibila','renovabila','demolare'].includes(p.house);
    document.getElementById('house-details-section').style.display = showHouse ? 'block' : 'none';
    // Auto-open section if has data
    if (p.landType || p.area || p.priceTotal) {
      document.getElementById('prop-section').style.display = 'block';
      document.getElementById('prop-chevron').classList.add('open');
    }
  }

  // ── Auto-detect city type from Nominatim ──
  let cityTypeTimer = null;
  document.getElementById('f-city').addEventListener('input', () => {
    clearTimeout(cityTypeTimer);
    const typeEl = document.getElementById('f-city-type');
    if (typeEl.value) return; // user already chose manually
    cityTypeTimer = setTimeout(async () => {
      const city = document.getElementById('f-city').value.trim();
      const county = document.getElementById('f-county').value.trim();
      if (city.length < 2) return;
      try {
        const q = [city, county, 'Romania'].filter(Boolean).join(', ');
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}&countrycodes=ro&addressdetails=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'ro' } });
        const data = await res.json();
        if (!data.length) return;
        const a = data[0].address || {};
        const type = data[0].type || data[0].class || '';
        let detected = '';
        if (a.city || type === 'city') detected = 'municipiu';
        else if (a.town || type === 'town') detected = 'oraș';
        else if (a.village || type === 'village') detected = 'sat';
        else if (a.municipality || type === 'municipality') detected = 'comună';
        else if (type === 'administrative') detected = 'comună';
        if (detected && !typeEl.value) typeEl.value = detected;
      } catch { /* ignore */ }
    }, 700);
  });

  // ── Add location button ──
  document.getElementById('btn-add-location').addEventListener('click', () => {
    LocationStore.setEditing(null); imageDataUrls = [];
    UI.openModal('Adaugă locație');
    restoreFormDraft();
  });

  // ── Form draft: save/restore/clear ──
  const DRAFT_KEY = 'travel_planner_form_draft';

  const DRAFT_TEXT_FIELDS = ['f-poi-search','f-comment','f-street','f-number','f-county','f-city','f-phone','f-description','f-link','f-area','f-price-total','f-price-sqm','f-price-ron','f-house-floors','f-house-area'];
  const DRAFT_SELECT_FIELDS = ['f-city-type','f-land-type','f-area-unit','f-house-baths','f-house-kitchen'];
  const DRAFT_RADIO_GROUPS = ['f-house','f-elec-pulled','f-water-pulled','f-land-config','f-access'];
  const DRAFT_CHECKBOXES = ['h-annex-garage','h-annex-barn','h-annex-cellar','h-annex-shed','h-annex-fence','h-annex-pool','h-annex-unknown','u-water-network','u-water-well','u-water-river','u-water-none','u-water-unknown','u-elec-onsite','u-elec-nearby','u-elec-none','u-elec-unknown','u-gas-onsite','u-gas-nearby','u-gas-none','u-gas-unknown','u-sewer-network','u-sewer-septic','u-sewer-none','u-sewer-unknown','u-heat-central','u-heat-gas','u-heat-stove','u-heat-electric','u-heat-none','u-heat-unknown'];

  function saveFormDraft() {
    // Only save draft for new locations (not edits)
    if (LocationStore.getEditing()) return;
    const draft = { text: {}, select: {}, radio: {}, check: {}, resolvedLat: null, resolvedLng: null, resolvedDisplay: null };
    DRAFT_TEXT_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) draft.text[id] = el.value; });
    DRAFT_SELECT_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) draft.select[id] = el.value; });
    DRAFT_RADIO_GROUPS.forEach(name => { const r = document.querySelector(`input[name="${name}"]:checked`); draft.radio[name] = r ? r.value : ''; });
    DRAFT_CHECKBOXES.forEach(id => { const el = document.getElementById(id); if (el) draft.check[id] = el.checked; });
    const form = document.getElementById('location-form');
    draft.resolvedLat = form.dataset.resolvedLat || null;
    draft.resolvedLng = form.dataset.resolvedLng || null;
    draft.resolvedDisplay = form.dataset.resolvedDisplay || null;
    // Only save if there's something meaningful filled in
    const hasContent = Object.values(draft.text).some(v => v && v.trim());
    if (hasContent) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    }
  }

  function restoreFormDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      // Check if there's actual content worth restoring
      const hasContent = Object.values(draft.text || {}).some(v => v && v.trim());
      if (!hasContent) return;

      DRAFT_TEXT_FIELDS.forEach(id => { const el = document.getElementById(id); if (el && draft.text[id]) el.value = draft.text[id]; });
      DRAFT_SELECT_FIELDS.forEach(id => { const el = document.getElementById(id); if (el && draft.select[id] !== undefined) el.value = draft.select[id]; });
      DRAFT_RADIO_GROUPS.forEach(name => { if (draft.radio[name]) { const r = document.querySelector(`input[name="${name}"][value="${draft.radio[name]}"]`); if (r) r.checked = true; } });
      DRAFT_CHECKBOXES.forEach(id => { const el = document.getElementById(id); if (el && draft.check[id] !== undefined) el.checked = draft.check[id]; });

      const form = document.getElementById('location-form');
      if (draft.resolvedLat) { form.dataset.resolvedLat = draft.resolvedLat; form.dataset.resolvedLng = draft.resolvedLng; form.dataset.resolvedDisplay = draft.resolvedDisplay; UI.setGeocodeStatus(`✓ ${draft.resolvedDisplay ? draft.resolvedDisplay.split(',').slice(0,3).join(',') : 'Coordonate salvate'}`, 'ok'); }

      // Show house details if needed
      const houseVal = draft.radio['f-house'];
      if (['locuibila','renovabila','demolare'].includes(houseVal)) document.getElementById('house-details-section').style.display = 'block';

      // Show property section if has data
      const hasPropData = draft.text['f-area'] || draft.text['f-price-total'] || draft.select['f-land-type'];
      if (hasPropData) { document.getElementById('prop-section').style.display = 'block'; document.getElementById('prop-chevron').classList.add('open'); }

      showToast('Draft restaurat — continuă de unde ai rămas.', 'info');
    } catch { /* ignore corrupt draft */ }
  }

  function clearFormDraft() {
    localStorage.removeItem(DRAFT_KEY);
  }

  // Auto-save draft on any input change inside the modal
  document.getElementById('location-form').addEventListener('input', saveFormDraft);
  document.getElementById('location-form').addEventListener('change', saveFormDraft);

  // ── Image preview ──
  document.getElementById('f-images').addEventListener('change', function () {
    imageDataUrls = []; document.getElementById('image-preview').innerHTML = '';
    Array.from(this.files).forEach(file => {
      const reader = new FileReader();
      reader.onload = e => {
        imageDataUrls.push(e.target.result);
        const img = document.createElement('img'); img.src = e.target.result;
        document.getElementById('image-preview').appendChild(img);
      };
      reader.readAsDataURL(file);
    });
  });

  // ── Modal close ──
  document.getElementById('modal-close').addEventListener('click', UI.closeModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', () => { clearFormDraft(); UI.closeModal(); });
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) UI.closeModal(); // draft kept intentionally
  });

  // ── Save location form ──
  document.getElementById('location-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const data = UI.getFormData();
    const resolvedLat = this.dataset.resolvedLat;
    const resolvedLng = this.dataset.resolvedLng;
    const resolvedDisplay = this.dataset.resolvedDisplay;
    const editId = LocationStore.getEditing();
    UI.setGeocodeStatus('Se caută adresa...', 'loading');
    document.getElementById('btn-save-location').disabled = true;
    try {
      let lat, lng, display;
      if (resolvedLat && resolvedLng) {
        // User picked from POI search — use those coords
        lat = parseFloat(resolvedLat); lng = parseFloat(resolvedLng); display = resolvedDisplay;
      } else if (editId) {
        // Editing existing location — keep existing coordinates, no re-geocode needed
        const existing = LocationStore.getById(editId);
        lat = existing.lat; lng = existing.lng; display = existing.city || data.city;
        UI.setGeocodeStatus(`✓ Coordonate păstrate`, 'ok');
      } else {
        try {
          const geo = await Routing.geocodeSmart(data.street, data.number, data.city, data.county);
          lat = geo.lat; lng = geo.lng; display = geo.display;
        } catch (geoErr) {
          // Retry once more before asking user
          let retryOk = false;
          try {
            await new Promise(r => setTimeout(r, 1500));
            const geo2 = await Routing.geocodeSmart(data.street, data.number, data.city, data.county);
            lat = geo2.lat; lng = geo2.lng; display = geo2.display;
            retryOk = true;
          } catch { /* still failing */ }

          if (!retryOk) {
            const isNetErr = !navigator.onLine;
            const msg = isNetErr
              ? `Nu există conexiune la internet.\n\nSalvezi locația fără coordonate? Va fi geocodată automat când revine internetul.`
              : `Geocodarea a eșuat: ${geoErr.message}\n\nSalvezi locația fără a o plasa pe hartă? Va fi reîncercată automat în fundal.`;
            const saveAnyway = confirm(`⚠️ ${msg}`);
            if (!saveAnyway) {
              UI.setGeocodeStatus('✗ ' + geoErr.message, 'err');
              document.getElementById('btn-save-location').disabled = false;
              return;
            }
            // Use approximate center of Romania as placeholder
            lat = 45.9432; lng = 24.9668; display = data.city || 'Locație nesituată';
            // Schedule background geocoding retry for this location
            setTimeout(runGeocodingRetry, 3000);
          }
        }
      }
      data.lat = lat; data.lng = lng;
      data.images = imageDataUrls.length ? [...imageDataUrls] : [];
      data.property = getPropertyData();
      // editId already declared above

      // ── Duplicate check ──
      if (!editId) {
        const duplicate = LocationStore.getAll().find(l => {
          const sameLoc = Math.abs(l.lat - lat) < 0.001 && Math.abs(l.lng - lng) < 0.001;
          const samePhone = data.phone && l.phone && data.phone.replace(/\s/g,'') === l.phone.replace(/\s/g,'');
          const sameLink = data.link && l.link && data.link.trim() === l.link.trim();
          return sameLoc || samePhone || sameLink;
        });
        if (duplicate) {
          const reason = Math.abs(duplicate.lat - lat) < 0.001 ? 'coordonate identice' :
                         duplicate.phone === data.phone ? 'același telefon' : 'același link';
          const proceed = confirm(`⚠️ Posibil duplicat!\n\nSimilară cu: "${UI.buildLocationLabel(duplicate)}" (${duplicate.city}, ${duplicate.county})\nMotiv: ${reason}\n\nAdaugi oricum?`);
          if (!proceed) {
            UI.setGeocodeStatus('', '');
            document.getElementById('btn-save-location').disabled = false;
            return;
          }
        }
      }
      if (editId) {
        LocationStore.update(editId, data);
        removeMarker(editId); addMarker(LocationStore.getById(editId));
        apiSaveLoc(LocationStore.getById(editId));
      } else {
        const loc = LocationStore.add(data); addMarker(loc);
        apiSaveLoc(loc);
      }
      UI.setGeocodeStatus(`✓ ${display.split(',').slice(0,3).join(',')}`, 'ok');
      map.setView([lat, lng], 14);
      refreshMarkerIcons(); renderAll(); clearRoute(); saveToStorage();
      delete this.dataset.resolvedLat; delete this.dataset.resolvedLng; delete this.dataset.resolvedDisplay;
      clearFormDraft();
      setTimeout(UI.closeModal, 600);
    } catch (err) {
      UI.setGeocodeStatus('✗ ' + err.message, 'err');
    } finally {
      document.getElementById('btn-save-location').disabled = false;
    }
  });

  // ── Google Maps button for real-time traffic ──
  function addGoogleMapsButton(allPoints) {
    // Remove existing button
    const existing = document.getElementById('btn-gmaps');
    if (existing) existing.remove();

    if (allPoints.length < 2) return;

    // Build Google Maps directions URL
    const origin = `${allPoints[0].lat},${allPoints[0].lng}`;
    const dest = `${allPoints[allPoints.length-1].lat},${allPoints[allPoints.length-1].lng}`;
    const waypts = allPoints.slice(1, -1).map(p => `${p.lat},${p.lng}`).join('|');
    let url = `https://www.google.com/maps/dir/${origin}/${dest}`;
    if (waypts) url = `https://www.google.com/maps/dir/${origin}/${waypts.replace(/\|/g,'/')}/${dest}`;

    const btn = document.createElement('button');
    btn.id = 'btn-gmaps';
    btn.innerHTML = '<img src="https://maps.google.com/favicon.ico" style="width:14px;height:14px"> Trafic live Google Maps';
    btn.title = 'Deschide traseul în Google Maps pentru trafic în timp real';
    btn.style.cssText = 'width:100%;margin-top:6px;padding:7px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;cursor:pointer;font-size:.78rem;color:#333;display:flex;align-items:center;justify-content:center;gap:6px;';
    btn.addEventListener('click', () => window.open(url, '_blank'));
    btn.addEventListener('mouseover', () => btn.style.background = '#f5f5f5');
    btn.addEventListener('mouseout', () => btn.style.background = '#fff');

    // Add after summary stats
    const summary = document.getElementById('route-summary');
    if (summary) summary.appendChild(btn);
  }

  // ── Traffic events on route ──
  async function showTrafficOnRoute(geometry) {
    if (!geometry || !geometry.coordinates) return;
    const coords = geometry.coordinates;
    // Sample points along route for bounding box
    const lats = coords.map(c => c[1]);
    const lngs = coords.map(c => c[0]);
    const minLat = Math.min(...lats) - 0.01;
    const maxLat = Math.max(...lats) + 0.01;
    const minLng = Math.min(...lngs) - 0.01;
    const maxLng = Math.max(...lngs) + 0.01;
    const bbox = `${minLat},${minLng},${maxLat},${maxLng}`;

    try {
      const query = `[out:json][timeout:15];(
        node["hazard"](${bbox});
        node["accident"](${bbox});
        node["highway"="speed_camera"](${bbox});
        node["enforcement"](${bbox});
        way["construction"](${bbox});
        way["highway"="construction"](${bbox});
      );out center 40;`;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: controller.signal });
      const data = await res.json();
      if (!data.elements) return;

      data.elements.forEach(ev => {
        const tags = ev.tags || {};
        const lat = ev.lat || ev.center?.lat;
        const lng = ev.lon || ev.center?.lon;
        if (!lat || !lng) return;

        // Only show if within ~200m of route
        if (!isNearRoute(lat, lng, coords, 0.002)) return;

        const cat = categorizeTraffic(tags);
        const icon = L.divIcon({
          className: '',
          html: `<div style="background:${cat.bg};border:2px solid ${cat.border};border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.3);cursor:pointer" title="${cat.label}">${cat.icon}</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14]
        });

        const name = tags.name || tags.description || tags.ref || '';
        const details = [
          tags.maxspeed ? `⚡ ${tags.maxspeed} km/h` : '',
          tags.opening_date ? `📅 Din: ${tags.opening_date}` : '',
          tags.end_date ? `📅 Până: ${tags.end_date}` : '',
          tags.note || ''
        ].filter(Boolean).join('<br>');

        const m = L.marker([lat, lng], { icon })
          .addTo(map)
          .bindPopup(`<div style="min-width:160px">
            <b style="color:${cat.border}">${cat.icon} ${cat.label}</b>
            ${name ? `<br><span style="font-size:.82rem">${name}</span>` : ''}
            ${details ? `<br><span style="font-size:.78rem;color:#666">${details}</span>` : ''}
          </div>`, { maxWidth: 220 });
        trafficMarkers.push(m);
      });
    } catch { /* silent */ }
  }

  function categorizeTraffic(tags) {
    if (tags.enforcement === 'speed_camera' || tags.highway === 'speed_camera')
      return { icon:'📷', label:'Radar viteză', bg:'#fff8e1', border:'#f57c00' };
    if (tags.enforcement === 'police' || tags.police)
      return { icon:'🚔', label:'Control poliție', bg:'#e3f2fd', border:'#1a73e8' };
    if (tags.accident || tags.hazard === 'accident')
      return { icon:'🚨', label:'Accident', bg:'#fce4ec', border:'#d32f2f' };
    if (tags.hazard === 'slippery_road')
      return { icon:'🌊', label:'Drum alunecos', bg:'#e3f2fd', border:'#0277bd' };
    if (tags.hazard === 'animal_crossing')
      return { icon:'🦌', label:'Traversare animale', bg:'#e8f5e9', border:'#388e3c' };
    if (tags.detour || tags.route === 'detour')
      return { icon:'🔄', label:'Ocolire', bg:'#f3e5f5', border:'#7b1fa2' };
    if (tags.construction || tags.highway === 'construction' || tags.hazard === 'road_works')
      return { icon:'🚧', label:'Lucrări', bg:'#fff3e0', border:'#f57c00' };
    if (tags.hazard)
      return { icon:'⚠️', label:`Pericol`, bg:'#fff8e1', border:'#e65100' };
    return { icon:'⚠️', label:'Restricție', bg:'#fff8e1', border:'#e65100' };
  }

  // Check if a point is within `threshold` degrees of any route segment
  function isNearRoute(lat, lng, coords, threshold) {
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((lng - x1) * dx + (lat - y1) * dy) / (dx*dx + dy*dy)));
      const nearLng = x1 + t * dx, nearLat = y1 + t * dy;
      if (Math.abs(lat - nearLat) < threshold && Math.abs(lng - nearLng) < threshold) return true;
    }
    return false;
  }

  // ── Click on location name → fly to map ──
  document.getElementById('sortable-list').addEventListener('click', e => {
    const clickable = e.target.closest('.loc-clickable');
    if (clickable && !e.target.closest('button')) {
      const id = clickable.dataset.id;
      const loc = LocationStore.getById(id);
      if (loc) {
        map.flyTo([loc.lat, loc.lng], 14, { duration: 1 });
        if (markers[id]) markers[id].openPopup();
      }
    }
  });

  // ── Weather & Traffic ──
  const WMO_CODES = {
    0:'☀️ Senin', 1:'🌤️ Parțial senin', 2:'⛅ Parțial noros', 3:'☁️ Noros',
    45:'🌫️ Ceață', 48:'🌫️ Ceață cu chiciură',
    51:'🌦️ Burniță ușoară', 53:'🌦️ Burniță', 55:'🌧️ Burniță intensă',
    61:'🌧️ Ploaie ușoară', 63:'🌧️ Ploaie', 65:'🌧️ Ploaie intensă',
    71:'🌨️ Ninsoare ușoară', 73:'❄️ Ninsoare', 75:'❄️ Ninsoare intensă',
    80:'🌦️ Averse ușoare', 81:'🌧️ Averse', 82:'⛈️ Averse puternice',
    95:'⛈️ Furtună', 96:'⛈️ Furtună cu grindină', 99:'⛈️ Furtună puternică'
  };

  function wmoDesc(code) { return WMO_CODES[code] || '🌡️ Necunoscut'; }
  function wmoIcon(code) { return (WMO_CODES[code] || '🌡️').split(' ')[0]; }

  async function openWeather(loc) {
    document.getElementById('weather-overlay').classList.remove('hidden');
    document.getElementById('weather-title').innerHTML = `<i class="fa-solid fa-cloud-sun"></i> ${UI.buildLocationLabel(loc)}`;
    document.getElementById('weather-subtitle').textContent = `${loc.city || ''}, ${loc.county || ''} · Actualizat acum`;

    // Reset tabs — start on hourly
    document.querySelectorAll('.wtab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.wtab-content').forEach(c => { c.classList.remove('active'); c.innerHTML = '<div class="weather-loading"><i class="fa-solid fa-spinner fa-spin"></i> Se încarcă...</div>'; });
    document.querySelector('.wtab[data-tab="hourly"]').classList.add('active');
    document.getElementById('wtab-hourly').classList.add('active');

    // Fetch weather and traffic in parallel
    Promise.all([fetchWeather(loc), renderTraffic(loc)]);
  }

  async function fetchWeather(loc) {
    // Fetch weather from Open-Meteo (free, no key)
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}&hourly=temperature_2m,precipitation_probability,weathercode,windspeed_10m&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&timezone=Europe%2FBucharest&forecast_days=7`;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.hourly || !data.daily) throw new Error('Date incomplete');
      renderHourly(data.hourly);
      renderDaily(data.daily);
      // Switch to hourly tab by default
      document.querySelectorAll('.wtab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.wtab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('.wtab[data-tab="hourly"]').classList.add('active');
      document.getElementById('wtab-hourly').classList.add('active');
    } catch (err) {
      const msg = err.name === 'AbortError' || err.message.includes('fetch')
        ? `<div class="weather-loading" style="color:#d32f2f">
            <i class="fa-solid fa-triangle-exclamation" style="font-size:2rem;color:#f57c00"></i><br><br>
            Datele meteo nu pot fi încărcate din <b>file://</b>.<br><br>
            Rulează aplicația de pe server:<br>
            <code style="background:#f5f5f5;padding:4px 8px;border-radius:4px;font-size:.8rem">python -m http.server 8000</code><br>
            apoi deschide <b>localhost:8000</b>
           </div>`
        : '<div class="weather-loading">Eroare la încărcarea datelor meteo.</div>';
      document.getElementById('wtab-hourly').innerHTML = msg;
      document.getElementById('wtab-daily').innerHTML = msg;
    }

    // Fetch traffic events from Overpass
    renderTraffic(loc);
  }

  function renderHourly(h) {
    const now = new Date();
    const el = document.getElementById('wtab-hourly');
    let html = '<div class="hourly-scroll">';
    for (let i = 0; i < Math.min(48, h.time.length); i++) {
      const t = new Date(h.time[i]);
      if (t < now - 3600000) continue;
      const hh = t.getHours().toString().padStart(2,'0') + ':00';
      const day = t.toLocaleDateString('ro-RO', { weekday:'short' });
      html += `<div class="hour-card">
        <div class="h-time">${day}<br>${hh}</div>
        <div class="h-icon">${wmoIcon(h.weathercode[i])}</div>
        <div class="h-temp">${Math.round(h.temperature_2m[i])}°C</div>
        <div class="h-rain">💧 ${h.precipitation_probability[i]}%</div>
        <div class="h-wind">💨 ${Math.round(h.windspeed_10m[i])} km/h</div>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function renderDaily(d) {
    const el = document.getElementById('wtab-daily');
    const days = ['Dum','Lun','Mar','Mie','Joi','Vin','Sâm'];
    let html = '';
    for (let i = 0; i < d.time.length; i++) {
      const dt = new Date(d.time[i]);
      const dayName = i === 0 ? 'Azi' : i === 1 ? 'Mâine' : days[dt.getDay()];
      html += `<div class="day-row">
        <div class="day-name">${dayName}<br><span style="font-size:.7rem;color:#aaa">${dt.toLocaleDateString('ro-RO',{day:'2-digit',month:'short'})}</span></div>
        <div class="day-icon">${wmoIcon(d.weathercode[i])}</div>
        <div class="day-desc">${wmoDesc(d.weathercode[i]).split(' ').slice(1).join(' ')}</div>
        <div class="day-rain">💧 ${d.precipitation_sum[i].toFixed(1)}mm</div>
        <div class="day-temps">${Math.round(d.temperature_2m_min[i])}° / ${Math.round(d.temperature_2m_max[i])}°</div>
      </div>`;
    }
    el.innerHTML = html;
  }

  async function renderTraffic(loc) {
    const el = document.getElementById('wtab-traffic');
    el.innerHTML = '<div class="weather-loading"><i class="fa-solid fa-spinner fa-spin"></i> Se caută evenimente...</div>';
    try {
      const r = 0.08;
      const bbox = `${loc.lat-r},${loc.lng-r},${loc.lat+r},${loc.lng+r}`;
      // Extended query: accidents, construction, hazards, speed cameras, police
      const query = `[out:json][timeout:15];(
        node["hazard"](${bbox});
        node["accident"](${bbox});
        node["highway"="speed_camera"](${bbox});
        node["enforcement"](${bbox});
        way["construction"](${bbox});
        way["highway"="construction"](${bbox});
        way["hazard"](${bbox});
        relation["construction"](${bbox});
      );out body 30;`;
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { signal: controller.signal });
      const data = await res.json();

      if (!data.elements || !data.elements.length) {
        el.innerHTML = `<div class="traffic-empty">
          <i class="fa-solid fa-circle-check" style="color:#34a853;font-size:2rem"></i><br><br>
          Nu sunt evenimente de trafic raportate în raza de 8 km.
        </div>`;
        return;
      }

      // Categorize and display
      const categorize = (tags) => {
        if (tags.enforcement === 'speed_camera' || tags.highway === 'speed_camera') return { icon:'📷', label:'Radar de viteză', color:'#f57c00' };
        if (tags.enforcement === 'police' || tags.police) return { icon:'🚔', label:'Control poliție', color:'#1a73e8' };
        if (tags.accident || tags.hazard === 'accident') return { icon:'🚨', label:'Accident', color:'#d32f2f' };
        if (tags.hazard === 'animal_crossing') return { icon:'🦌', label:'Traversare animale', color:'#388e3c' };
        if (tags.hazard === 'slippery_road') return { icon:'🌊', label:'Drum alunecos', color:'#0277bd' };
        if (tags.hazard === 'road_works' || tags.construction || tags.highway === 'construction') return { icon:'🚧', label:'Lucrări în desfășurare', color:'#f57c00' };
        if (tags.hazard === 'traffic_signals') return { icon:'🚦', label:'Semaforizare temporară', color:'#fbc02d' };
        if (tags.hazard === 'road_narrowing') return { icon:'⚠️', label:'Îngustare drum', color:'#e65100' };
        if (tags.detour || tags.route === 'detour') return { icon:'🔄', label:'Ocolire', color:'#7b1fa2' };
        if (tags.hazard) return { icon:'⚠️', label:`Pericol: ${tags.hazard}`, color:'#e65100' };
        return { icon:'🚧', label: tags.name || tags.description || 'Lucrări / Restricție', color:'#f57c00' };
      };

      let html = `<div style="font-size:.75rem;color:#888;padding:4px 6px 8px">
        ${data.elements.length} evenimente în raza de 8 km · Sursa: OpenStreetMap
      </div>`;

      data.elements.slice(0, 20).forEach(ev => {
        const tags = ev.tags || {};
        const cat = categorize(tags);
        const name = tags.name || tags.description || tags.ref || '';
        const details = [
          tags.maxspeed ? `Viteză max: ${tags.maxspeed} km/h` : '',
          tags.opening_date || tags.start_date ? `Din: ${tags.opening_date || tags.start_date}` : '',
          tags.end_date ? `Până: ${tags.end_date}` : '',
          tags.note || ''
        ].filter(Boolean).join(' · ');

        html += `<div class="traffic-item">
          <div class="traffic-icon" style="font-size:1.3rem">${cat.icon}</div>
          <div class="traffic-info">
            <div class="t-title" style="color:${cat.color}">${cat.label}</div>
            ${name ? `<div class="t-desc"><b>${name}</b></div>` : ''}
            ${details ? `<div class="t-desc">${details}</div>` : ''}
          </div>
        </div>`;
      });
      el.innerHTML = html;
    } catch (err) {
      if (err.name === 'AbortError') {
        el.innerHTML = '<div class="traffic-empty">Timeout — serverul de trafic nu a răspuns.</div>';
      } else {
        el.innerHTML = '<div class="traffic-empty">Nu s-au putut încărca datele de trafic.</div>';
      }
    }
  }

  // Weather modal close
  document.getElementById('weather-close').addEventListener('click', () => {
    document.getElementById('weather-overlay').classList.add('hidden');
  });
  document.getElementById('weather-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('weather-overlay'))
      document.getElementById('weather-overlay').classList.add('hidden');
  });

  // Weather tabs
  document.querySelectorAll('.wtab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.wtab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.wtab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`wtab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ── List actions ──
  document.getElementById('sortable-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'favorite') {
      const loc = LocationStore.getById(id);
      if (!loc) return;
      LocationStore.update(id, { favorite: !loc.favorite });
      renderAll();
      saveToStorage();
      apiSaveLoc(LocationStore.getById(id));
      if (markers[id]) {
        const updated = LocationStore.getById(id);
        markers[id].setIcon(makeIcon(updated.favorite ? '#f57c00' : '#1a73e8',
          LocationStore.getAll().findIndex(l => l.id === id) + 1));
      }
      return;
    }
    if (action === 'weather') {
      const loc = LocationStore.getById(id);
      if (loc) openWeather(loc);
      return;
    }
    if (action === 'delete') {
      removeMarker(id); 
      apiDeleteLoc(id);
      LocationStore.remove(id);
      refreshMarkerIcons(); renderAll(); clearRoute(); saveToStorage();
    }
    if (action === 'edit') {
      const loc = LocationStore.getById(id); if (!loc) return;
      LocationStore.setEditing(id); imageDataUrls = loc.images || [];
      UI.fillForm(loc);
      setPropertyData(loc.property || null);
      document.getElementById('image-preview').innerHTML = '';
      imageDataUrls.forEach(src => { const img = document.createElement('img'); img.src = src; document.getElementById('image-preview').appendChild(img); });
      UI.openModal('Editează locație');
    }
    if (action === 'remove-start') {
      if (markers['__start__']) { map.removeLayer(markers['__start__']); delete markers['__start__']; }
      LocationStore.setStart(null);
      startInput.value = ''; btnStartClear.classList.add('hidden');
      renderAll(); clearRoute(); saveToStorage();
    }
  });

  // ── Drag reorder ──
  Sortable.create(document.getElementById('sortable-list'), {
    handle: '.drag-handle', animation: 150, ghostClass: 'sortable-ghost',
    onEnd() {
      const newOrder = Array.from(document.querySelectorAll('#sortable-list .location-item[data-id]')).map(el => el.dataset.id);
      LocationStore.reorder(newOrder);
      refreshMarkerIcons();
      saveToStorage();
      apiSaveOrder();
      autoRecalculate();
    }
  });

  // ── Auto-recalculate after reorder ──
  let lastCalculatedMode = null;

  async function autoRecalculate() {
    const locs = LocationStore.getAll();
    const start = LocationStore.getStart();
    const allPoints = [];
    if (start) allPoints.push({ lat: start.lat, lng: start.lng, label: start.label });
    locs.forEach(l => allPoints.push({ lat: l.lat, lng: l.lng, label: UI.buildLocationLabel(l) }));
    if (allPoints.length < 2) { clearRoute(); return; }

    const modeToUse = lastCalculatedMode || currentMode;

    clearRoute();
    const btn = document.getElementById('btn-calculate');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Se actualizează...';
    btn.disabled = true;
    try {
      await calculateSingleRoute(allPoints, modeToUse, getDepartureDate());
      lastCalculatedMode = modeToUse;
    } catch { /* silent fail on auto-recalc */ }
    finally {
      btn.innerHTML = '<i class="fa-solid fa-map-marked-alt"></i> Calculează traseu';
      btn.disabled = locs.length < 1;
    }
  }

  // ── Calculate route ──
  document.getElementById('btn-calculate').addEventListener('click', async () => {
    const locs = LocationStore.getAll();
    const start = LocationStore.getStart();
    const allPoints = [];
    if (start) allPoints.push({ lat: start.lat, lng: start.lng, label: start.label });
    locs.forEach(l => allPoints.push({ lat: l.lat, lng: l.lng, label: UI.buildLocationLabel(l) }));
    if (allPoints.length < 2) return;
    clearRoute();
    document.getElementById('btn-calculate').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Se calculează...';
    document.getElementById('btn-calculate').disabled = true;
    try {
      if (departureTypeEl.value === 'interval') {
        await calculateAllVariants(allPoints);
      } else {
        await calculateSingleRoute(allPoints, currentMode, getDepartureDate());
      }
      lastCalculatedMode = currentMode;
    } catch (err) { alert('Eroare: ' + err.message); }
    finally {
      document.getElementById('btn-calculate').innerHTML = '<i class="fa-solid fa-map-marked-alt"></i> Calculează traseu';
      document.getElementById('btn-calculate').disabled = LocationStore.count() < 1;
    }
  });

  async function calculateSingleRoute(allPoints, profile, departureDate) {
    const fullRoute = await Routing.getRoute(allPoints, profile);

    // Build segment results from legs — legs may be fewer if duplicates were removed
    // Distribute legs back to original segments
    const segResults = [];
    let legIdx = 0;
    for (let i = 0; i < allPoints.length - 1; i++) {
      const prev = allPoints[i];
      const curr = allPoints[i + 1];
      const dist = Math.sqrt(Math.pow(prev.lat - curr.lat, 2) + Math.pow(prev.lng - curr.lng, 2));
      if (dist <= 0.0005) {
        // Duplicate point — zero distance segment
        segResults.push({ distanceM: 0, durationS: 0 });
      } else {
        const leg = fullRoute.legs[legIdx] || { distance: 0 };
        segResults.push({
          distanceM: leg.distance,
          durationS: Routing.calcDurationPublic(leg.distance, profile)
        });
        legIdx++;
      }
    }

    let dep = departureDate;
    if (departureTypeEl.value === 'arrive') {
      dep = new Date(departureDate.getTime() - segResults.reduce((s,r) => s + r.durationS, 0) * 1000);
    }
    const segments = Routing.buildSegments(allPoints, segResults, profile, dep);
    const colors = { walking:'#e65100', cycling:'#2e7d32', transit:'#7b1fa2', driving:'#1a73e8' };
    const coords = fullRoute.geometry.coordinates.map(c => [c[1], c[0]]);
    routeLayer = L.polyline(coords, { color: colors[profile]||'#1a73e8', weight: 5, opacity: 0.8 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    UI.updateSummary(fullRoute.distanceM, fullRoute.durationS, profile, segments);
    showTownsAlongRoute(fullRoute.geometry, allPoints);
    showTrafficOnRoute(fullRoute.geometry);
    addGoogleMapsButton(allPoints);
  }

  // ── All variants for interval ──
  const ALL_MODES = [
    { id:'driving',   label:'Mașină personală', icon:'fa-car',            color:'#1a73e8' },
    { id:'walking',   label:'Mers pe jos',       icon:'fa-person-walking', color:'#e65100' },
    { id:'cycling',   label:'Bicicletă',          icon:'fa-bicycle',        color:'#2e7d32' },
    { id:'transit',   label:'Autobuz / Tren',     icon:'fa-bus',            color:'#7b1fa2' },
    { id:'hitchhike', label:'Autostop',           icon:'fa-thumbs-up',      color:'#f57c00' },
    { id:'ferry',     label:'Vapor / Feribot',    icon:'fa-ferry',          color:'#0277bd' },
  ];

  async function calculateAllVariants(allPoints) {
    const today = new Date().toISOString().slice(0,10);
    const fromDate = new Date(`${today}T${document.getElementById('interval-from').value}`);
    const toDate   = new Date(`${today}T${document.getElementById('interval-to').value}`);
    const intervalMs = Math.max(0, toDate - fromDate);

    document.getElementById('variants-panel').style.display = 'block';
    document.getElementById('variants-loading').style.display = 'inline';
    document.getElementById('variants-list').innerHTML = '';
    UI.hideSummary();

    const baseRoute = await Routing.getRoute(allPoints, 'driving');
    const distM = baseRoute.distanceM;
    const coords = baseRoute.geometry.coordinates.map(c => [c[1], c[0]]);
    routeLayer = L.polyline(coords, { color:'#1a73e8', weight:4, opacity:0.4, dashArray:'8,6' }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding:[40,40] });

    const variants = [];
    for (const mode of ALL_MODES) {
      const durationS = Routing.calcDurationPublic(distM, mode.id);
      if (mode.id === 'transit') {
        for (let m = 0; m <= intervalMs / 60000; m += 30) {
          const dep = new Date(fromDate.getTime() + m * 60000);
          variants.push({ mode, distM, durationS, departure: dep,
            arrival: new Date(dep.getTime() + durationS * 1000),
            cost: Routing.segmentCost(distM, mode.id), combo: false });
        }
      } else {
        variants.push({ mode, distM, durationS, departure: new Date(fromDate),
          arrival: new Date(fromDate.getTime() + durationS * 1000),
          cost: Routing.segmentCost(distM, mode.id), combo: false });
      }
    }
    // Combo: jos + autobuz
    const walkM = Math.min(2000, distM * 0.1);
    const walkS = Routing.calcDurationPublic(walkM, 'walking');
    const busS  = Routing.calcDurationPublic(distM - walkM, 'transit');
    variants.push({ mode:{ id:'combo', label:'Jos + Autobuz', icon:'fa-person-walking', color:'#7b1fa2' },
      distM, durationS: walkS + busS, departure: new Date(fromDate),
      arrival: new Date(fromDate.getTime() + (walkS + busS) * 1000),
      cost: Routing.segmentCost(distM - walkM, 'transit'), combo: true,
      legs:[{ icon:'fa-person-walking', color:'#e65100', label:`${(walkM/1000).toFixed(1)} km jos` },
            { icon:'fa-bus', color:'#7b1fa2', label:'autobuz' }]
    });

    variants.sort((a,b) => a.arrival - b.arrival);
    document.getElementById('variants-loading').style.display = 'none';
    renderVariants(variants);
  }

  function renderVariants(variants) {
    const list = document.getElementById('variants-list');
    list.innerHTML = '';
    const minArr  = Math.min(...variants.map(v => v.arrival));
    const minCost = Math.min(...variants.map(v => v.cost.amount));
    variants.forEach(v => {
      const card = document.createElement('div');
      card.className = 'variant-card';
      let badge = '';
      if (v.arrival.getTime() === minArr) badge += `<span class="variant-badge badge-fast"><i class="fa-solid fa-bolt"></i> Cel mai rapid</span>`;
      if (v.cost.amount === minCost && v.cost.amount === 0) badge += `<span class="variant-badge badge-cheap"><i class="fa-solid fa-leaf"></i> Gratuit</span>`;
      else if (v.cost.amount === minCost) badge += `<span class="variant-badge badge-cheap"><i class="fa-solid fa-tag"></i> Cel mai ieftin</span>`;
      if (v.combo) badge += `<span class="variant-badge badge-combo"><i class="fa-solid fa-shuffle"></i> Combinat</span>`;
      const legsHtml = v.legs
        ? v.legs.map((l,i) => `${i>0?'<span class="leg-arrow"><i class="fa-solid fa-arrow-right"></i></span>':''}<span class="leg-chip"><i class="fa-solid ${l.icon}" style="color:${l.color}"></i> ${l.label}</span>`).join('')
        : `<span class="leg-chip"><i class="fa-solid ${v.mode.icon}" style="color:${v.mode.color}"></i> ${v.mode.label}</span>`;
      card.innerHTML = `
        <div class="variant-header">
          <div class="variant-mode-icon" style="background:${v.mode.color}"><i class="fa-solid ${v.mode.icon}"></i></div>
          <span class="variant-title">${v.mode.label}</span>${badge}
        </div>
        <div class="variant-body">
          <div class="variant-legs">${legsHtml}</div>
          <div class="variant-depart">
            <i class="fa-solid fa-plane-departure"></i> ${Routing.formatTime(v.departure)}
            &nbsp;→&nbsp;
            <i class="fa-solid fa-plane-arrival"></i> ${Routing.formatTime(v.arrival)}
          </div>
          <div class="variant-stats">
            <span><i class="fa-solid fa-clock"></i> ${Routing.formatDuration(v.durationS)}</span>
            <span><i class="fa-solid fa-road"></i> ${Routing.formatDistance(v.distM)}</span>
            <span><i class="fa-solid fa-wallet"></i> ${v.cost.label}</span>
          </div>
        </div>`;
      card.addEventListener('click', () => {
        document.querySelectorAll('.variant-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
      });
      list.appendChild(card);
    });
  }

  // ── Towns along route ──
  async function showTownsAlongRoute(geometry, existingPoints) {
    const panel = document.getElementById('towns-panel');
    const list  = document.getElementById('towns-list');
    const loading = document.getElementById('towns-loading');
    panel.style.display = 'block'; loading.style.display = 'inline'; list.innerHTML = '';
    try {
      const towns = await Routing.getTownsAlongRoute(geometry, 10);
      loading.style.display = 'none';
      if (!towns.length) { list.innerHTML = '<span style="color:#aaa;font-size:.78rem">Nu s-au detectat localități intermediare.</span>'; return; }
      const existingNames = existingPoints.map(p => (p.label||'').toLowerCase());
      const filtered = towns.filter(t => !existingNames.some(n => n.includes(t.name.toLowerCase())));
      filtered.forEach(town => {
        const chip = document.createElement('div');
        chip.className = 'town-chip';
        chip.title = `Adaugă ${town.name} ca oprire`;
        chip.innerHTML = `<i class="fa-solid fa-location-dot"></i> ${town.name} <span class="add-stop"><i class="fa-solid fa-plus"></i></span>`;
        chip.addEventListener('click', () => {
          const loc = LocationStore.add({ street: town.name, number:'', city: town.name, cityType:'', county:'', phone:'', description:'Oprire intermediară', link:'', images:[], lat: town.lat, lng: town.lng });
          addMarker(loc); refreshMarkerIcons(); renderAll(); clearRoute(); saveToStorage();
          apiSaveLoc(loc);
        });
        list.appendChild(chip);
        const m = L.circleMarker([town.lat, town.lng], { radius:5, color:'#1a73e8', fillColor:'#fff', fillOpacity:1, weight:2 })
          .addTo(map).bindTooltip(town.name, { permanent:false, direction:'top' });
        townMarkers.push(m);
      });
      if (!filtered.length) list.innerHTML = '<span style="color:#aaa;font-size:.78rem">Toate localitățile sunt deja în traseu.</span>';
    } catch { loading.style.display = 'none'; }
  }

  // ── Click on map to add waypoint ──
  const mapClickCtrl = L.control({ position: 'topright' });
  mapClickCtrl.onAdd = function () {
    const div = document.createElement('div');
    div.innerHTML = `<button id="btn-add-waypoint"><i class="fa-solid fa-map-pin"></i> Adaugă oprire pe hartă</button>`;
    return div;
  };
  mapClickCtrl.addTo(map);

  document.addEventListener('click', e => {
    const btn = e.target.closest('#btn-add-waypoint');
    if (!btn) return;
    addingWaypoint = !addingWaypoint;
    btn.classList.toggle('active', addingWaypoint);
    btn.innerHTML = addingWaypoint
      ? '<i class="fa-solid fa-xmark"></i> Anulează selecție'
      : '<i class="fa-solid fa-map-pin"></i> Adaugă oprire pe hartă';
    map.getContainer().style.cursor = addingWaypoint ? 'crosshair' : '';
  });

  map.on('click', async function (e) {
    if (!addingWaypoint) return;
    addingWaypoint = false;
    const btn = document.getElementById('btn-add-waypoint');
    if (btn) { btn.classList.remove('active'); btn.innerHTML = '<i class="fa-solid fa-map-pin"></i> Adaugă oprire pe hartă'; }
    map.getContainer().style.cursor = '';
    const { lat, lng } = e.latlng;
    try {
      const name = await Routing.reverseGeocode(lat, lng) || 'Oprire';
      const loc = LocationStore.add({ street: name, number:'', city: name, cityType:'', county:'', phone:'', description:'Oprire adăugată de pe hartă', link:'', images:[], lat, lng });
      addMarker(loc); refreshMarkerIcons(); renderAll(); clearRoute(); saveToStorage();
      apiSaveLoc(loc);
    } catch { /* ignore */ }
  });

  // ── Clear all ──
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Ștergi toate locațiile și traseul?')) return;
    Object.keys(markers).forEach(id => map.removeLayer(markers[id]));
    markers = {};
    LocationStore.clear();
    startInput.value = ''; btnStartClear.classList.add('hidden');
    clearRoute();
    lastCalculatedMode = null;
    renderAll();
    localStorage.removeItem(STORAGE_KEY);
    if (HAS_BACKEND) {
      fetch(`${API_BASE}/api/locations`, { method: 'DELETE' }).catch(() => {});
      fetch(`${API_BASE}/api/state`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ start: null, mode: 'driving' }) }).catch(() => {});
    }
  });

  // ── Export / Import locations ──
  document.getElementById('btn-export').addEventListener('click', () => {
    const data = {
      version: 1,
      exported: new Date().toISOString(),
      locations: LocationStore.getAll(),
      start: LocationStore.getStart(),
      mode: currentMode
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `traseu-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Locații exportate în fișier JSON.', 'success');
  });

  // ── Export Excel ──
  document.getElementById('btn-export-excel').addEventListener('click', () => {
    if (typeof XLSX === 'undefined') {
      showToast('Biblioteca Excel nu s-a încărcat. Verifică conexiunea.', 'info');
      return;
    }
    const locs = LocationStore.getAll();
    if (!locs.length) { showToast('Nu există locații de exportat.', 'info'); return; }

    const rows = locs.map((loc, i) => {
      const p = loc.property || {};
      const u = p.utilities || {};
      const ax = p.annexes || {};
      const waterParts = [u.waterNetwork?'rețea':null, u.waterWell?'fântână':null, u.waterRiver?'râu':null, u.waterNone?'lipsă':null].filter(Boolean);
      const elecParts  = [u.elecOnsite?'pe loc':null, u.elecNearby?'aproape':null, u.elecNone?'lipsă':null].filter(Boolean);
      const gasParts   = [u.gasOnsite?'pe loc':null, u.gasNearby?'aproape':null, u.gasNone?'lipsă':null].filter(Boolean);
      const sewerParts = [u.sewerNetwork?'rețea':null, u.sewerSeptic?'fosă':null, u.sewerNone?'lipsă':null].filter(Boolean);
      const heatParts  = [u.heatCentral?'centrală':null, u.heatGas?'gaze':null, u.heatStove?'sobă':null, u.heatElectric?'electric':null, u.heatNone?'lipsă':null].filter(Boolean);
      const annexParts = [ax.garage?'garaj':null, ax.barn?'grajd':null, ax.cellar?'pivniță':null, ax.shed?'magazie':null, ax.fence?'gard':null, ax.pool?'piscină':null].filter(Boolean);
      return {
        'Nr.': i + 1,
        'Județ': loc.county || '',
        'Localitate': loc.city || '',
        'Tip localitate': loc.cityType || '',
        'Stradă': loc.street || '',
        'Număr': loc.number || '',
        'Telefon': loc.phone || '',
        'Descriere': loc.description || '',
        'Comentariu': loc.comment || '',
        'Link': loc.link || '',
        'Latitudine': loc.lat || '',
        'Longitudine': loc.lng || '',
        'Favorit': loc.favorite ? 'Da' : '',
        'Etichetă': loc.colorLabel || '',
        'Tip teren': p.landType || '',
        'Suprafață': p.area ? `${p.area} ${p.areaUnit || 'mp'}` : '',
        'Preț (€)': p.priceTotal || '',
        '€/mp': p.priceSqm || '',
        'Preț (RON)': p.priceRon || '',
        'Construcție': p.house || '',
        'Etaje': p.houseFloors || '',
        'Suprafață casă (mp)': p.houseArea || '',
        'Băi': p.houseBaths || '',
        'Bucătărie': p.houseKitchen || '',
        'Curent în casă': p.elecPulled || '',
        'Apă în casă': p.waterPulled || '',
        'Configurație teren': p.landConfig || '',
        'Acces': p.access || '',
        'Anexe': annexParts.join(', '),
        'Apă': waterParts.join(', '),
        'Curent electric': elecParts.join(', '),
        'Gaze': gasParts.join(', '),
        'Canalizare': sewerParts.join(', '),
        'Încălzire': heatParts.join(', '),
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const colWidths = Object.keys(rows[0] || {}).map(key => ({
      wch: Math.max(key.length, ...rows.map(r => String(r[key] || '').length), 8)
    }));
    ws['!cols'] = colWidths;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Locații');
    const start = LocationStore.getStart();
    if (start) {
      const wsStart = XLSX.utils.json_to_sheet([{ 'Label': start.label, 'Latitudine': start.lat, 'Longitudine': start.lng }]);
      XLSX.utils.book_append_sheet(wb, wsStart, 'Start');
    }
    XLSX.writeFile(wb, `traseu-${new Date().toISOString().slice(0,10)}.xlsx`);
    showToast('Locații exportate în Excel!', 'success');
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('import-paste').value = '';
    document.getElementById('import-excel-preview').style.display = 'none';
    document.getElementById('import-excel-preview').innerHTML = '';
    document.getElementById('import-modal').classList.remove('hidden');
  });

  // import-choose-file și import-choose-excel sunt acum <label for="...">
  // deschid direct file picker-ul nativ — funcționează și pe mobil

  document.getElementById('import-modal-cancel').addEventListener('click', () => {
    document.getElementById('import-modal').classList.add('hidden');
    pendingExcelData = null;
  });

  let pendingExcelData = null; // holds parsed Excel rows before confirm

  document.getElementById('import-modal-ok').addEventListener('click', () => {
    if (pendingExcelData) {
      processExcelRows(pendingExcelData);
      pendingExcelData = null;
      document.getElementById('import-modal').classList.add('hidden');
      return;
    }
    const text = document.getElementById('import-paste').value.trim();
    if (text) {
      try {
        JSON.parse(text);
        processImportData(text);
        document.getElementById('import-modal').classList.add('hidden');
      } catch {
        alert('JSON invalid. Verifică că ai copiat tot conținutul fișierului.');
      }
    } else {
      // Pe mobil, .click() pe input e blocat — utilizatorul trebuie să folosească butoanele JSON/Excel din modal
      alert('Lipește conținut JSON în câmpul de text sau folosește butoanele JSON / Excel de mai sus.');
    }
  });

  document.getElementById('import-file').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      processImportData(e.target.result);
      document.getElementById('import-modal').classList.add('hidden');
    };
    reader.readAsText(file);
    this.value = '';
  });

  // ── Excel import ──
  document.getElementById('import-file-excel').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      alert('Biblioteca Excel nu s-a încărcat. Verifică conexiunea la internet.');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!rows.length) { alert('Fișierul Excel este gol sau nu are date în primul sheet.'); return; }

        // Preview
        const preview = document.getElementById('import-excel-preview');
        preview.style.display = 'block';
        preview.innerHTML = `<i class="fa-solid fa-table" style="color:#388e3c"></i> <b>${rows.length} rânduri</b> găsite în <b>${wb.SheetNames[0]}</b>. Coloane: ${Object.keys(rows[0]).slice(0,6).join(', ')}${Object.keys(rows[0]).length > 6 ? '...' : ''}`;

        pendingExcelData = rows;
        document.getElementById('import-paste').value = '';
      } catch (err) {
        alert('Eroare la citirea fișierului Excel: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
    this.value = '';
  });

  function processExcelRows(rows) {
    // Map Excel columns (exported by this app) back to location objects
    // Also handles manually created Excel files with flexible column names
    const col = (row, ...names) => {
      for (const n of names) {
        const key = Object.keys(row).find(k => k.trim().toLowerCase() === n.toLowerCase());
        if (key !== undefined && row[key] !== '') return String(row[key]).trim();
      }
      return '';
    };
    const chk = (row, ...names) => {
      const v = col(row, ...names).toLowerCase();
      return v === 'da' || v === 'yes' || v === 'true' || v === '1' || v === 'x';
    };
    const hasUtil = (row, label) => {
      const v = col(row, 'Apă', 'Curent electric', 'Gaze', 'Canalizare', 'Încălzire', 'Utilități').toLowerCase();
      return v.includes(label.toLowerCase());
    };

    const imported = [];
    rows.forEach(row => {
      const city   = col(row, 'Localitate', 'City', 'Oras', 'Oraș');
      const county = col(row, 'Județ', 'Judet', 'County');
      if (!city && !county) return; // skip empty rows

      const waterStr  = col(row, 'Apă', 'Apa', 'Water');
      const elecStr   = col(row, 'Curent electric', 'Curent', 'Electric');
      const gasStr    = col(row, 'Gaze', 'Gas');
      const sewerStr  = col(row, 'Canalizare', 'Sewer');
      const heatStr   = col(row, 'Încălzire', 'Incalzire', 'Heat');
      const annexStr  = col(row, 'Anexe', 'Annexes');

      const loc = {
        street:      col(row, 'Stradă', 'Strada', 'Street'),
        number:      col(row, 'Număr', 'Numar', 'Number'),
        city,
        county,
        cityType:    col(row, 'Tip localitate', 'Tip Localitate'),
        phone:       col(row, 'Telefon', 'Phone'),
        comment:     col(row, 'Comentariu', 'Comment'),
        description: col(row, 'Descriere', 'Description'),
        link:        col(row, 'Link', 'URL'),
        lat:         parseFloat(col(row, 'Latitudine', 'Lat', 'Latitude')) || 45.9432,
        lng:         parseFloat(col(row, 'Longitudine', 'Lng', 'Longitude')) || 24.9668,
        favorite:    chk(row, 'Favorit', 'Favorite'),
        colorLabel:  col(row, 'Etichetă', 'Eticheta', 'Label'),
        images: [],
        property: {
          landType:   col(row, 'Tip teren'),
          area:       col(row, 'Suprafață', 'Suprafata', 'Area').replace(/[^\d.,]/g, ''),
          areaUnit:   col(row, 'Suprafață', 'Suprafata').includes('ha') ? 'ha' : col(row, 'Suprafață', 'Suprafata').includes('ari') ? 'ari' : 'mp',
          priceTotal: col(row, 'Preț (€)', 'Pret EUR', 'Price EUR'),
          priceSqm:   col(row, '€/mp', 'EUR/mp'),
          priceRon:   col(row, 'Preț (RON)', 'Pret RON'),
          house:      col(row, 'Construcție', 'Constructie', 'House'),
          houseFloors:col(row, 'Etaje', 'Floors'),
          houseArea:  col(row, 'Suprafață casă (mp)', 'House Area'),
          houseBaths: col(row, 'Băi', 'Bai', 'Baths'),
          houseKitchen:col(row, 'Bucătărie', 'Bucatarie', 'Kitchen'),
          elecPulled: col(row, 'Curent în casă', 'Curent in casa'),
          waterPulled:col(row, 'Apă în casă', 'Apa in casa'),
          landConfig: col(row, 'Configurație teren', 'Configuratie teren'),
          access:     col(row, 'Acces'),
          annexes: {
            garage:  annexStr.includes('garaj'),
            barn:    annexStr.includes('grajd'),
            cellar:  annexStr.includes('pivniță') || annexStr.includes('pivnita'),
            shed:    annexStr.includes('magazie'),
            fence:   annexStr.includes('gard'),
            pool:    annexStr.includes('piscină') || annexStr.includes('piscina'),
          },
          utilities: {
            waterNetwork: waterStr.includes('rețea') || waterStr.includes('retea'),
            waterWell:    waterStr.includes('fântână') || waterStr.includes('fantana'),
            waterRiver:   waterStr.includes('râu') || waterStr.includes('rau'),
            waterNone:    waterStr.includes('lipsă') || waterStr.includes('lipsa'),
            elecOnsite:   elecStr.includes('pe loc'),
            elecNearby:   elecStr.includes('aproape'),
            elecNone:     elecStr.includes('lipsă') || elecStr.includes('lipsa'),
            gasOnsite:    gasStr.includes('pe loc'),
            gasNearby:    gasStr.includes('aproape'),
            gasNone:      gasStr.includes('lipsă') || gasStr.includes('lipsa'),
            sewerNetwork: sewerStr.includes('rețea') || sewerStr.includes('retea'),
            sewerSeptic:  sewerStr.includes('fosă') || sewerStr.includes('fosa'),
            sewerNone:    sewerStr.includes('lipsă') || sewerStr.includes('lipsa'),
            heatCentral:  heatStr.includes('centrală') || heatStr.includes('centrala'),
            heatGas:      heatStr.includes('gaze'),
            heatStove:    heatStr.includes('sobă') || heatStr.includes('soba'),
            heatElectric: heatStr.includes('electric'),
            heatNone:     heatStr.includes('lipsă') || heatStr.includes('lipsa'),
          }
        }
      };
      imported.push(loc);
    });

    if (!imported.length) { alert('Nu s-au găsit locații valide în fișier. Asigură-te că există coloanele "Localitate" și "Județ".'); return; }

    // Ask: replace or append
    const replace = confirm(`S-au găsit ${imported.length} locații în Excel.\n\nOK = Înlocuiește tot\nAnulează = Adaugă la cele existente`);
    if (replace) {
      Object.keys(markers).forEach(id => map.removeLayer(markers[id]));
      markers = {};
      LocationStore.clear();
      clearRoute();
    }

    imported.forEach(loc => {
      LocationStore.add(loc);
      addMarker(LocationStore.getAll().at(-1));
    });
    refreshMarkerIcons();
    renderAll();
    saveToStorage();

    const allLocs = LocationStore.getAll();
    if (allLocs.length > 1) {
      const lats = allLocs.map(p => p.lat).filter(v => v !== 45.9432);
      const lngs = allLocs.map(p => p.lng).filter(v => v !== 24.9668);
      if (lats.length > 1) map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [40, 40] });
    }

    // Schedule geocoding for rows without valid coords
    setTimeout(runGeocodingRetry, 2000);
    showToast(`${imported.length} locații importate din Excel!`, 'success');
  }

  function processImportData(text) {
    try {
      const data = JSON.parse(text);
      if (!data.locations) throw new Error('Format invalid');
      Object.keys(markers).forEach(id => map.removeLayer(markers[id]));
      markers = {};
      LocationStore.clear();
      clearRoute();
      if (data.mode) {
        currentMode = data.mode;
        document.querySelectorAll('.transport-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === currentMode);
        });
      }
      if (data.start) {
        LocationStore.setStart(data.start);
        markers['__start__'] = L.marker([data.start.lat, data.start.lng], { icon: makeIcon('#34a853', 'S') })
          .addTo(map).bindPopup(`<b>${data.start.label}</b>`);
        document.getElementById('start-search-input').value = data.start.label;
        document.getElementById('btn-start-clear').classList.remove('hidden');
      }
      data.locations.forEach(loc => {
        LocationStore.add(loc);
        addMarker(LocationStore.getAll().at(-1));
      });
      refreshMarkerIcons();
      renderAll();
      // Salvează în API (bulk) sau localStorage
      if (HAS_BACKEND) {
        fetch(`${API_BASE}/api/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locations: data.locations, start: data.start, mode: data.mode })
        }).catch(() => {});
      } else {
        saveToStorage();
      }
      const allPts = [...(data.start ? [data.start] : []), ...data.locations];
      if (allPts.length > 1) {
        const lats = allPts.map(p => p.lat), lngs = allPts.map(p => p.lng);
        map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [40, 40] });
      }
      showToast(`${data.locations.length} locații importate!`, 'success');
    } catch (err) {
      alert('Eroare la import: ' + err.message);
    }
  }

  // ── Save/Load buttons ──
  document.getElementById('btn-save-session').addEventListener('click', () => {
    saveToStorage();
    const btn = document.getElementById('btn-save-session');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Salvat!';
    setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvează'; }, 1500);
  });

  // ── Cloud Sync (JSONBin.io) ──
  const btnCloudSync = document.getElementById('btn-cloud-sync');
  if (btnCloudSync) {
    btnCloudSync.addEventListener('click', () => {
      const { binId, apiKey } = getCloudConfig();
      document.getElementById('cloud-binid-input').value = binId;
      document.getElementById('cloud-apikey-input').value = apiKey;
      document.getElementById('cloud-status').textContent = '';
      document.getElementById('cloud-modal').classList.remove('hidden');
    });

    document.getElementById('cloud-modal-cancel').addEventListener('click', () => {
      document.getElementById('cloud-modal').classList.add('hidden');
    });

    document.getElementById('cloud-modal-push').addEventListener('click', async () => {
      const binId  = document.getElementById('cloud-binid-input').value.trim();
      const apiKey = document.getElementById('cloud-apikey-input').value.trim();
      const statusEl = document.getElementById('cloud-status');
      if (!binId || !apiKey) { statusEl.textContent = 'Completează Bin ID și Master Key.'; return; }
      localStorage.setItem(CLOUD_KEY, binId);
      localStorage.setItem(CLOUD_APIKEY, apiKey);
      statusEl.textContent = 'Se trimite...';
      const ok = await cloudPush();
      if (ok) {
        statusEl.textContent = `✓ ${LocationStore.getAll().length} locații trimise în cloud!`;
        setTimeout(() => document.getElementById('cloud-modal').classList.add('hidden'), 1500);
      } else {
        statusEl.textContent = 'Eroare — verifică Bin ID și Master Key.';
      }
    });
  }

  // ── Route optimization (Nearest Neighbor + 2-opt) ──

  function haversineKm(a, b) {
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLng = (b.lng - a.lng) * Math.PI / 180;
    const x = Math.sin(dLat/2) ** 2 +
              Math.cos(a.lat * Math.PI/180) * Math.cos(b.lat * Math.PI/180) * Math.sin(dLng/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  }

  function totalDistance(points) {
    let d = 0;
    for (let i = 0; i < points.length - 1; i++) d += haversineKm(points[i], points[i+1]);
    return d;
  }

  // Nearest neighbor: fix startPoint, find best order for rest
  function nearestNeighbor(startPoint, points) {
    const unvisited = [...points];
    const route = [];
    let current = startPoint;
    while (unvisited.length) {
      let minDist = Infinity, minIdx = 0;
      unvisited.forEach((p, i) => {
        const d = haversineKm(current, p);
        if (d < minDist) { minDist = d; minIdx = i; }
      });
      current = unvisited.splice(minIdx, 1)[0];
      route.push(current);
    }
    return route;
  }

  // 2-opt: improve the ordered list with timeout protection
  function twoOpt(route) {
    let best = [...route];
    let improved = true;
    const deadline = Date.now() + 3000; // max 3 seconds
    while (improved && Date.now() < deadline) {
      improved = false;
      for (let i = 0; i < best.length - 1; i++) {
        for (let j = i + 1; j < best.length; j++) {
          const newRoute = [
            ...best.slice(0, i),
            ...best.slice(i, j + 1).reverse(),
            ...best.slice(j + 1)
          ];
          if (totalDistance(newRoute) < totalDistance(best) - 0.01) {
            best = newRoute;
            improved = true;
          }
        }
        if (Date.now() >= deadline) break;
      }
    }
    return best;
  }

  document.getElementById('btn-optimize').addEventListener('click', () => {
    const locs = LocationStore.getAll();
    if (locs.length < 2) return alert('Sunt necesare cel puțin 2 locații pentru optimizare.');

    const startLoc = LocationStore.getStart();
    const btn = document.getElementById('btn-optimize');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled = true;

    setTimeout(() => {
      try {
        const oldDist = totalDistance(
          [...(startLoc ? [startLoc] : [locs[0]]), ...locs].map(l => ({ lat: l.lat, lng: l.lng }))
        );

        // Start point for optimization
        const origin = startLoc || locs[0];

        // Run nearest neighbor from origin through all locations
        let optimized = nearestNeighbor(origin, locs.map(l => ({ ...l })));

        // 2-opt improvement — no location limit, max 3 seconds
        const withOrigin = [origin, ...optimized];
        const improved = twoOpt(withOrigin);
        optimized = improved.filter(p => p.id !== undefined);

        const newDist = totalDistance(
          [...(startLoc ? [startLoc] : []), ...optimized].map(l => ({ lat: l.lat, lng: l.lng }))
        );
        const saving = Math.round(oldDist - newDist);

        LocationStore.reorder(optimized.map(l => l.id));
        refreshMarkerIcons();
        renderAll();
        saveToStorage();

        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => {
          btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
          btn.disabled = false;
        }, 2000);

        showToast(
          saving > 1
            ? `Traseu optimizat! Economie: ~${saving} km față de ordinea anterioară.`
            : 'Ordinea curentă este deja aproape optimă.',
          saving > 1 ? 'success' : 'info'
        );

        autoRecalculate();
      } catch (e) {
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        btn.disabled = false;
        alert('Eroare la optimizare: ' + e.message);
      }
    }, 50);
  });

  function showToast(msg, type = 'info') {
    let toast = document.getElementById('app-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = `toast-${type} toast-visible`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('toast-visible'), 3500);
  }

  // ── Selection mode ──
  let selectionMode = false;
  let selectedIds = new Set();

  document.getElementById('btn-select-mode').addEventListener('click', () => {
    selectionMode = !selectionMode;
    const btn = document.getElementById('btn-select-mode');
    btn.classList.toggle('active', selectionMode);
    btn.title = selectionMode ? 'Ieși din modul selecție' : 'Selectează locații individuale pentru traseu personalizat';
    document.getElementById('selection-bar').style.display = selectionMode ? 'flex' : 'none';
    document.getElementById('sortable-list').classList.toggle('select-mode', selectionMode);
    if (!selectionMode) {
      selectedIds.clear();
      updateSelectionUI();
    }
  });

  document.getElementById('btn-select-all').addEventListener('click', () => {
    LocationStore.getAll().forEach(l => selectedIds.add(l.id));
    updateSelectionUI();
  });

  document.getElementById('btn-select-none').addEventListener('click', () => {
    selectedIds.clear();
    updateSelectionUI();
  });

  document.getElementById('sortable-list').addEventListener('change', e => {
    const cb = e.target.closest('.loc-checkbox');
    if (!cb) return;
    const id = cb.dataset.id;
    if (cb.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    updateSelectionUI();
  });

  // Also allow clicking the whole item in select mode
  document.getElementById('sortable-list').addEventListener('click', e => {
    if (!selectionMode) return;
    const item = e.target.closest('.location-item[data-id]');
    if (!item) return;
    if (e.target.closest('button') || e.target.closest('.loc-checkbox')) return;
    const id = item.dataset.id;
    const cb = item.querySelector('.loc-checkbox');
    if (!cb) return;
    cb.checked = !cb.checked;
    if (cb.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    updateSelectionUI();
  });

  function updateSelectionUI() {
    const count = selectedIds.size;
    document.getElementById('selection-count').textContent = `${count} selectate`;
    document.getElementById('btn-route-selected').disabled = count < 2;
    // Update item highlight and checkbox state
    document.querySelectorAll('#sortable-list .location-item[data-id]').forEach(item => {
      const id = item.dataset.id;
      const cb = item.querySelector('.loc-checkbox');
      if (cb) cb.checked = selectedIds.has(id);
      item.classList.toggle('sel-checked', selectedIds.has(id));
      // Marker opacity
      if (markers[id]) markers[id].setOpacity(selectedIds.size === 0 || selectedIds.has(id) ? 1 : 0.25);
    });
  }

  document.getElementById('btn-route-selected').addEventListener('click', async () => {
    if (selectedIds.size < 2) return;
    // Use start location only if set, otherwise start from first selected
    const start = LocationStore.getStart();
    const allPoints = [];
    if (start) allPoints.push({ lat: start.lat, lng: start.lng, label: start.label });
    // Keep order from current list, only selected
    LocationStore.getAll()
      .filter(l => selectedIds.has(l.id))
      .forEach(l => allPoints.push({ lat: l.lat, lng: l.lng, label: UI.buildLocationLabel(l) }));
    // If no start set, first selected becomes origin
    if (!start && allPoints.length < 2) return;
    if (allPoints.length < 2) return;

    clearRoute();
    const btn = document.getElementById('btn-route-selected');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled = true;
    try {
      await calculateSingleRoute(allPoints, currentMode, getDepartureDate());
      lastCalculatedMode = currentMode;
      showToast(`Traseu calculat pentru ${selectedIds.size} locații selectate.`, 'success');
    } catch (err) {
      alert('Eroare: ' + err.message);
    } finally {
      btn.innerHTML = '<i class="fa-solid fa-route"></i> Traseu din selectate';
      btn.disabled = selectedIds.size < 2;
    }
  });

  // ── Result panels collapse/expand ──
  document.getElementById('btn-toggle-segments').addEventListener('click', () => {
    const list = document.getElementById('segments-list');
    const btn = document.getElementById('btn-toggle-segments');
    list.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
  });

  document.getElementById('towns-header').addEventListener('click', () => {
    document.getElementById('towns-list').classList.toggle('collapsed');
    document.getElementById('towns-header').classList.toggle('collapsed');
  });

  // ── Color picker ──
  let colorTargetId = null;
  let selectedPresetColor = null;
  const colorPopup = document.getElementById('color-picker-popup');

  document.getElementById('sortable-list').addEventListener('click', e => {
    const colorBtn = e.target.closest('[data-action="color"]');
    if (!colorBtn) return;
    colorTargetId = colorBtn.dataset.id;
    const loc = LocationStore.getById(colorTargetId);
    // Position popup near button
    const rect = colorBtn.getBoundingClientRect();
    colorPopup.style.top = (rect.bottom + 6) + 'px';
    colorPopup.style.left = Math.min(rect.left, window.innerWidth - 230) + 'px';
    colorPopup.classList.remove('hidden');
    // Pre-select current color
    selectedPresetColor = loc?.color || null;
    document.getElementById('cp-custom-color').value = loc?.color || '#1a73e8';
    document.getElementById('cp-custom-label').value = loc?.colorLabel || '';
    document.querySelectorAll('.cp-preset').forEach(p => {
      p.classList.toggle('selected', p.dataset.color === selectedPresetColor);
    });
    e.stopPropagation();
  });

  document.querySelectorAll('.cp-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedPresetColor = btn.dataset.color;
      document.getElementById('cp-custom-color').value = btn.dataset.color;
      document.getElementById('cp-custom-label').value = btn.dataset.label;
      document.querySelectorAll('.cp-preset').forEach(p => p.classList.toggle('selected', p === btn));
    });
  });

  document.getElementById('cp-apply').addEventListener('click', () => {
    if (!colorTargetId) return;
    const color = document.getElementById('cp-custom-color').value;
    const label = document.getElementById('cp-custom-label').value.trim();
    LocationStore.update(colorTargetId, { color, colorLabel: label });
    if (markers[colorTargetId]) {
      const idx = LocationStore.getAll().findIndex(l => l.id === colorTargetId) + 1;
      markers[colorTargetId].setIcon(makeIcon(color, idx));
    }
    renderAll();
    saveToStorage();
    apiSaveLoc(LocationStore.getById(colorTargetId));
    colorPopup.classList.add('hidden');
  });

  document.getElementById('cp-clear').addEventListener('click', () => {
    if (!colorTargetId) return;
    LocationStore.update(colorTargetId, { color: null, colorLabel: null });
    const idx = LocationStore.getAll().findIndex(l => l.id === colorTargetId) + 1;
    if (markers[colorTargetId]) markers[colorTargetId].setIcon(makeIcon('#1a73e8', idx));
    renderAll();
    saveToStorage();
    apiSaveLoc(LocationStore.getById(colorTargetId));
    colorPopup.classList.add('hidden');
  });

  document.addEventListener('click', e => {
    if (!colorPopup.contains(e.target) && !e.target.closest('[data-action="color"]'))
      colorPopup.classList.add('hidden');
  });

  // ── Color filter ──
  let activeColorFilter = null;
  const COLOR_PRESETS = [
    { color: '#34a853', label: 'De văzut' },
    { color: '#f9ab00', label: 'Mă gândesc' },
    { color: '#d32f2f', label: 'Nu' },
    { color: '#f57c00', label: 'Favorit' },
  ];

  document.getElementById('btn-filter-by-color').addEventListener('click', e => {
    // Build color filter dropdown
    let dropdown = document.getElementById('color-filter-dropdown');
    if (dropdown) { dropdown.remove(); return; }
    dropdown = document.createElement('div');
    dropdown.id = 'color-filter-dropdown';
    dropdown.style.cssText = 'position:fixed;background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:9700;display:flex;flex-direction:column;gap:5px;min-width:150px;';
    const rect = e.target.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';

    // All option
    const allBtn = document.createElement('button');
    allBtn.style.cssText = 'background:#f5f5f5;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:.78rem;text-align:left;';
    allBtn.textContent = '● Toate culorile';
    allBtn.addEventListener('click', () => { activeColorFilter = null; applyFilters(); dropdown.remove(); });
    dropdown.appendChild(allBtn);

    // Get unique colors from locations
    const usedColors = [...new Set(LocationStore.getAll().filter(l => l.color).map(l => l.color))];
    usedColors.forEach(color => {
      const loc = LocationStore.getAll().find(l => l.color === color);
      const label = loc?.colorLabel || color;
      const btn = document.createElement('button');
      btn.style.cssText = `background:${color};border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:.78rem;color:#fff;font-weight:600;text-align:left;`;
      btn.textContent = label;
      btn.addEventListener('click', () => { activeColorFilter = color; applyFilters(); dropdown.remove(); });
      dropdown.appendChild(btn);
    });

    document.body.appendChild(dropdown);
    setTimeout(() => document.addEventListener('click', function h(ev) {
      if (!dropdown.contains(ev.target)) { dropdown.remove(); document.removeEventListener('click', h); }
    }), 100);
  });

  // ── Filter favorites ──
  let showOnlyFavorites = false;
  document.getElementById('btn-filter-favorites').addEventListener('click', () => {
    showOnlyFavorites = !showOnlyFavorites;
    const btn = document.getElementById('btn-filter-favorites');
    btn.classList.toggle('active', showOnlyFavorites);
    btn.innerHTML = showOnlyFavorites
      ? '<i class="fa-solid fa-star"></i>'
      : '<i class="fa-regular fa-star"></i>';
    btn.title = showOnlyFavorites ? 'Arată toate' : 'Arată doar favorite';
    applyFilters();
  });

  // ── Filter expand/collapse ──
  document.getElementById('filter-expand-btn').addEventListener('click', () => {
    const col = document.getElementById('filter-collapsible');
    const btn = document.getElementById('filter-expand-btn');
    const open = col.classList.toggle('open');
    btn.classList.toggle('open', open);
    btn.innerHTML = open
      ? '<i class="fa-solid fa-chevron-up"></i> Ascunde'
      : '<i class="fa-solid fa-chevron-down"></i> Filtre';
  });

  // ── Filter system ──
  const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  const REGIONS = {    'Moldova': ['Iași','Bacău','Neamț','Vaslui','Galați','Vrancea','Suceava','Botoșani'],
    'Muntenia': ['București','Ilfov','Prahova','Dâmbovița','Argeș','Teleorman','Giurgiu','Călărași','Ialomița','Buzău','Brăila'],
    'Oltenia': ['Dolj','Olt','Vâlcea','Gorj','Mehedinți'],
    'Transilvania': ['Cluj','Brașov','Sibiu','Mureș','Alba','Harghita','Covasna','Bistrița-Năsăud'],
    'Banat': ['Timiș','Caraș-Severin','Arad','Hunedoara'],
    'Crișana': ['Bihor','Satu Mare','Sălaj'],
    'Maramureș': ['Maramureș'],
    'Dobrogea': ['Constanța','Tulcea'],
  };

  let activeFilters = new Set(); // set of strings (county/city/region)

  function buildFilterOptions() {
    const locs = LocationStore.getAll();

    // Normalize diacritics for deduplication
    const normalize = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

    // Deduplicate counties and cities by normalized value, keep original display
    const countyMap = new Map();
    const cityMap = new Map();
    locs.forEach(l => {
      if (l.county) {
        const key = normalize(l.county);
        if (!countyMap.has(key)) countyMap.set(key, l.county);
      }
      if (l.city) {
        const key = normalize(l.city);
        if (!cityMap.has(key)) cityMap.set(key, l.city);
      }
    });
    const counties = [...countyMap.values()].sort((a,b) => normalize(a).localeCompare(normalize(b)));
    const cities   = [...cityMap.values()].sort((a,b) => normalize(a).localeCompare(normalize(b)));

    // Quick region buttons
    const quickEl = document.getElementById('filter-quick');
    quickEl.innerHTML = '';
    const usedRegions = Object.entries(REGIONS)
      .filter(([, cs]) => locs.some(l => cs.some(c => normalize(c) === normalize(l.county))))
      .map(([name]) => name);

    usedRegions.forEach(reg => {
      const btn = document.createElement('button');
      btn.className = 'filter-quick-btn' + (activeFilters.has(reg) ? ' active' : '');
      btn.textContent = reg;
      btn.addEventListener('click', () => toggleFilter(reg));
      quickEl.appendChild(btn);
    });

    // Chips
    const chipsEl = document.getElementById('filter-chips');
    chipsEl.innerHTML = '';
    counties.forEach(c => addChip(chipsEl, c, 'fa-map'));
    cities.forEach(c => addChip(chipsEl, c, 'fa-city'));
  }

  function addChip(container, label, icon) {
    const chip = document.createElement('div');
    chip.className = 'filter-chip' + (activeFilters.has(label) ? ' active' : '');
    chip.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
    chip.addEventListener('click', () => toggleFilter(label));
    container.appendChild(chip);
  }

  function toggleFilter(val) {
    if (activeFilters.has(val)) activeFilters.delete(val);
    else activeFilters.add(val);
    // Auto-open filter panel when something is selected
    if (activeFilters.size > 0) {
      document.getElementById('filter-collapsible').classList.add('open');
      document.getElementById('filter-expand-btn').classList.add('open');
      document.getElementById('filter-expand-btn').innerHTML = '<i class="fa-solid fa-chevron-up"></i> Ascunde';
    }
    applyFilters();
    buildFilterOptions();
    document.getElementById('btn-filter-clear').classList.toggle('hidden', activeFilters.size === 0);
    document.getElementById('filter-input').value = '';
  }

  function applyFilters() {
    const locs = LocationStore.getAll();
    const items = document.querySelectorAll('#sortable-list .location-item[data-id]');
    let visibleCount = 0;

    items.forEach(item => {
      const id = item.dataset.id;
      const loc = LocationStore.getById(id);
      if (!loc) return;

      if (activeFilters.size === 0) {
        item.classList.remove('filtered-out');
        if (markers[id]) markers[id].getElement() && markers[id].setOpacity(1);
        visibleCount++;
        return;
      }

      const matchesFilter = [...activeFilters].some(f => {
        if (REGIONS[f]) return REGIONS[f].some(rc => norm(rc) === norm(loc.county));
        return norm(loc.county) === norm(f) || norm(loc.city) === norm(f);
      });

      const matches = (activeFilters.size === 0 || matchesFilter) && (!showOnlyFavorites || loc.favorite)
        && (!activeColorFilter || loc.color === activeColorFilter);
      item.classList.toggle('filtered-out', !matches);
      if (markers[id]) markers[id].setOpacity(matches ? 1 : 0.2);
      if (matches) visibleCount++;
    });

    // Update count
    let countEl = document.getElementById('filter-count-label');
    if (!countEl) {
      countEl = document.createElement('div');
      countEl.id = 'filter-count-label';
      countEl.className = 'filter-count';
      document.getElementById('filter-bar').appendChild(countEl);
    }
    if (activeFilters.size > 0) {
      countEl.textContent = `${visibleCount} din ${locs.length} locații afișate`;
    } else {
      countEl.textContent = '';
    }

    // Recalculate route with visible locations only
    if (lastCalculatedMode) recalcWithVisibleLocs();
  }

  // Text search filter
  document.getElementById('filter-input').addEventListener('input', function () {
    const q = this.value.trim().toLowerCase();
    document.getElementById('btn-filter-clear').classList.toggle('hidden', !q && activeFilters.size === 0);
    if (!q) { applyFilters(); return; }

    const items = document.querySelectorAll('#sortable-list .location-item[data-id]');
    let visibleCount = 0;
    items.forEach(item => {
      const id = item.dataset.id;
      const loc = LocationStore.getById(id);
      if (!loc) return;
      const haystack = norm([loc.county, loc.city, loc.street, loc.description].join(' '));
      const regionMatch = Object.entries(REGIONS).some(([name, counties]) =>
        norm(name).includes(norm(q)) && counties.some(c => norm(c) === norm(loc.county))
      );
      const match = haystack.includes(norm(q)) || regionMatch;
      item.classList.toggle('filtered-out', !match);
      if (markers[id]) markers[id].setOpacity(match ? 1 : 0.2);
      if (match) visibleCount++;
    });

    let countEl = document.getElementById('filter-count-label');
    if (!countEl) {
      countEl = document.createElement('div');
      countEl.id = 'filter-count-label';
      countEl.className = 'filter-count';
      document.getElementById('filter-bar').appendChild(countEl);
    }
    countEl.textContent = `${visibleCount} din ${LocationStore.count()} locații afișate`;

    // Recalculate route with visible locations only
    if (lastCalculatedMode) recalcWithVisibleLocs();
  });

  document.getElementById('btn-filter-clear').addEventListener('click', () => {
    activeFilters.clear();
    document.getElementById('filter-input').value = '';
    document.getElementById('btn-filter-clear').classList.add('hidden');
    applyFilters();
    buildFilterOptions();
    const countEl = document.getElementById('filter-count-label');
    if (countEl) countEl.textContent = '';
  });

  // ── Recalc with only visible (non-filtered) locations ──
  let recalcTimer = null;
  function recalcWithVisibleLocs() {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(async () => {
      const start = LocationStore.getStart();
      const visibleIds = Array.from(document.querySelectorAll('#sortable-list .location-item[data-id]'))
        .filter(el => !el.classList.contains('filtered-out'))
        .map(el => el.dataset.id);
      const visibleLocs = visibleIds.map(id => LocationStore.getById(id)).filter(Boolean);

      const allPoints = [];
      if (start) allPoints.push({ lat: start.lat, lng: start.lng, label: start.label });
      visibleLocs.forEach(l => allPoints.push({ lat: l.lat, lng: l.lng, label: UI.buildLocationLabel(l) }));

      if (allPoints.length < 2) { clearRoute(); return; }

      clearRoute();
      const btn = document.getElementById('btn-calculate');
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Se actualizează...';
      btn.disabled = true;
      try {
        await calculateSingleRoute(allPoints, lastCalculatedMode, getDepartureDate());
      } catch { /* silent */ }
      finally {
        btn.innerHTML = '<i class="fa-solid fa-map-marked-alt"></i> Calculează traseu';
        btn.disabled = LocationStore.count() < 1;
      }
    }, 600); // debounce 600ms
  }

  // ── Render ──
  function renderAll() {
    UI.renderList(LocationStore.getAll(), LocationStore.getStart());
    buildFilterOptions();
    applyFilters();
  }

  // ── Auto-geocode: retry locations without valid coordinates ──
  // A location is considered "not geocoded" if it has the Romania fallback coords
  // or if lat/lng are missing. We retry in background whenever online.
  const ROMANIA_CENTER_LAT = 45.9432;
  const ROMANIA_CENTER_LNG = 24.9668;
  const GEOCODE_RETRY_INTERVAL = 30000; // 30s between full passes
  const GEOCODE_ITEM_DELAY = 1200;      // 1.2s between items (Nominatim rate limit)

  function isUngeocoded(loc) {
    if (!loc.lat || !loc.lng) return true;
    // Fallback coords = Romania center (within ~1km)
    return Math.abs(loc.lat - ROMANIA_CENTER_LAT) < 0.01 && Math.abs(loc.lng - ROMANIA_CENTER_LNG) < 0.01;
  }

  let geocodeRetryRunning = false;

  async function runGeocodingRetry() {
    if (geocodeRetryRunning) return;
    if (!navigator.onLine) return;
    const pending = LocationStore.getAll().filter(isUngeocoded);
    if (!pending.length) return;

    geocodeRetryRunning = true;
    let anyUpdated = false;

    for (const loc of pending) {
      if (!navigator.onLine) break;
      try {
        const geo = await Routing.geocodeSmart(loc.street, loc.number, loc.city, loc.county);
        // Only update if we got a real result (not Romania center)
        if (Math.abs(geo.lat - ROMANIA_CENTER_LAT) > 0.01 || Math.abs(geo.lng - ROMANIA_CENTER_LNG) > 0.01) {
          LocationStore.update(loc.id, { lat: geo.lat, lng: geo.lng });
          apiSaveLoc(LocationStore.getById(loc.id));
          // Update marker on map
          removeMarker(loc.id);
          addMarker(LocationStore.getById(loc.id));
          anyUpdated = true;
        }
      } catch { /* no internet or not found — will retry next pass */ }
      await new Promise(r => setTimeout(r, GEOCODE_ITEM_DELAY));
    }

    geocodeRetryRunning = false;
    if (anyUpdated) {
      refreshMarkerIcons();
      renderAll();
      saveToStorage();
      const stillPending = LocationStore.getAll().filter(isUngeocoded).length;
      showToast(
        stillPending
          ? `Geocodare: ${pending.length - stillPending} locații actualizate, ${stillPending} în așteptare.`
          : `Toate locațiile au fost geocodate automat.`,
        'success'
      );
    }
  }

  // Start retry loop: run immediately, then every 30s
  function startGeocodingRetryLoop() {
    runGeocodingRetry();
    setInterval(runGeocodingRetry, GEOCODE_RETRY_INTERVAL);
  }

  // Also trigger when coming back online
  window.addEventListener('online', () => {
    setTimeout(runGeocodingRetry, 2000);
  });

  // ── Render ──
  function renderAll() {
    UI.renderList(LocationStore.getAll(), LocationStore.getStart());
    buildFilterOptions();
    applyFilters();
  }

  // ── Init: load saved data ──
  loadFromStorage().then(() => {
    renderAll();
    startGeocodingRetryLoop();
  });
})();
