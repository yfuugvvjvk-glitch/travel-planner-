// ── UI helpers ───────────────────────────────────────────────────
const UI = (() => {

  function openModal(title = 'Adaugă locație') {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-overlay').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    document.getElementById('location-form').reset();
    document.getElementById('location-form').removeAttribute('data-resolved-lat');
    document.getElementById('location-form').removeAttribute('data-resolved-lng');
    document.getElementById('location-form').removeAttribute('data-resolved-display');
    document.getElementById('image-preview').innerHTML = '';
    document.getElementById('geocode-status').textContent = '';
    document.getElementById('geocode-status').className = '';
    document.getElementById('poi-suggestions').classList.add('hidden');
    document.getElementById('btn-poi-clear').classList.add('hidden');
    // Reset property section
    document.getElementById('f-land-type').value = '';
    document.getElementById('f-area').value = '';
    document.getElementById('f-price-total').value = '';
    document.getElementById('f-price-sqm').value = '';
    document.getElementById('f-price-ron').value = '';
    document.getElementById('price-calc-result').textContent = '';
    document.querySelector('input[name="f-house"][value="nu"]').checked = true;
    document.getElementById('house-details-section').style.display = 'none';
    ['f-house-floors','f-house-area','f-house-baths','f-house-kitchen'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    ['f-elec-pulled','f-water-pulled','f-land-config','f-access'].forEach(name => {
      const r = document.querySelector(`input[name="${name}"][value="ns"]`); if (r) r.checked = true;
    });
    ['h-annex-garage','h-annex-barn','h-annex-cellar','h-annex-shed','h-annex-fence','h-annex-pool','h-annex-unknown'].forEach(id => {
      const el = document.getElementById(id); if (el) el.checked = false;
    });
    ['u-water-network','u-water-well','u-water-river','u-water-none','u-water-unknown',
     'u-elec-onsite','u-elec-nearby','u-elec-none','u-elec-unknown',
     'u-gas-onsite','u-gas-nearby','u-gas-none','u-gas-unknown',
     'u-sewer-network','u-sewer-septic','u-sewer-none','u-sewer-unknown',
     'u-heat-central','u-heat-gas','u-heat-stove','u-heat-electric','u-heat-none','u-heat-unknown'].forEach(id => {
      const el = document.getElementById(id); if (el) el.checked = false;
    });
    document.getElementById('prop-section').style.display = 'none';
    document.getElementById('prop-chevron').classList.remove('open');
    LocationStore.setEditing(null);
  }

  function setGeocodeStatus(msg, type) {
    const el = document.getElementById('geocode-status');
    el.textContent = msg;
    el.className = type; // 'ok' | 'err' | 'loading'
  }

  function fillForm(loc) {
    document.getElementById('f-street').value = loc.street || '';
    document.getElementById('f-number').value = loc.number || '';
    document.getElementById('f-city').value = loc.city || '';
    document.getElementById('f-city-type').value = loc.cityType || '';
    document.getElementById('f-county').value = loc.county || '';
    document.getElementById('f-phone').value = loc.phone || '';
    document.getElementById('f-description').value = loc.description || '';
    document.getElementById('f-link').value = loc.link || '';
    if (loc.lat) setGeocodeStatus(`✓ Coordonate: ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`, 'ok');
  }

  function getFormData() {
    return {
      street: document.getElementById('f-street').value.trim(),
      number: document.getElementById('f-number').value.trim(),
      city: document.getElementById('f-city').value.trim(),
      cityType: document.getElementById('f-city-type').value,
      county: document.getElementById('f-county').value.trim(),
      phone: document.getElementById('f-phone').value.trim(),
      description: document.getElementById('f-description').value.trim(),
      link: document.getElementById('f-link').value.trim(),
    };
  }

  function buildLocationLabel(loc) {
    // Prefer city name; show street only if it adds meaningful info
    const city = loc.city || '';
    const street = loc.street || '';
    const number = loc.number || '';
    // If street looks like just a number or is same as city, skip it
    const streetIsJustNumber = /^\d+$/.test(street.trim());
    const streetSameAsCity = street.trim().toLowerCase() === city.trim().toLowerCase();
    if (!street || streetIsJustNumber || streetSameAsCity) {
      return city || street || 'Locație';
    }
    const streetPart = [street, number].filter(Boolean).join(' ');
    return city ? `${city} — ${streetPart}` : streetPart;
  }

  function buildLocationSub(loc) {
    const parts = [loc.cityType, loc.city, loc.county].filter(Boolean).join(', ');
    return parts;
  }

  function renderList(locations, startLoc) {
    const ul = document.getElementById('sortable-list');
    ul.innerHTML = '';

    if (startLoc) {
      const li = document.createElement('li');
      li.className = 'location-item';
      li.innerHTML = `
        <span class="loc-index start">S</span>
        <div class="loc-info">
          <div class="loc-name">${startLoc.label}</div>
          <div class="loc-sub">Punct de start</div>
        </div>
        <div class="loc-actions">
          <button class="del" data-action="remove-start" title="Șterge start"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
      ul.appendChild(li);
    }

    locations.forEach((loc, i) => {
      const li = document.createElement('li');
      li.className = 'location-item' + (loc.favorite ? ' is-favorite' : '');
      li.dataset.id = loc.id;
      li.innerHTML = `
        <input type="checkbox" class="loc-checkbox" data-id="${loc.id}" />
        <span class="drag-handle"><i class="fa-solid fa-grip-vertical"></i></span>
        <span class="loc-index">${i + 1}</span>
        <div class="loc-info loc-clickable" data-id="${loc.id}" title="Click: centrează pe hartă | Dublu-click: vreme">
          <div class="loc-name">${buildLocationLabel(loc)}</div>
          <div class="loc-sub">${buildLocationSub(loc)}${loc.colorLabel ? ` <span class="loc-color-badge" style="background:${loc.color}">${loc.colorLabel}</span>` : ''}</div>
        </div>
        <div class="loc-actions">
          <button data-action="favorite" data-id="${loc.id}" title="${loc.favorite ? 'Elimină din favorite' : 'Adaugă la favorite'}" class="${loc.favorite ? 'fav-active' : ''}"><i class="fa-${loc.favorite ? 'solid' : 'regular'} fa-star"></i></button>
          <button data-action="color" data-id="${loc.id}" title="Setează culoare/etichetă" class="color-btn" style="color:${loc.color || '#aaa'}"><i class="fa-solid fa-circle"></i></button>
          <button data-action="weather" data-id="${loc.id}" title="Vreme & trafic"><i class="fa-solid fa-cloud-sun"></i></button>
          <button data-action="edit" data-id="${loc.id}" title="Editează"><i class="fa-solid fa-pen"></i></button>
          <button class="del" data-action="delete" data-id="${loc.id}" title="Șterge"><i class="fa-solid fa-trash"></i></button>
        </div>`;
      ul.appendChild(li);
    });

    // Update calculate button
    const total = locations.length + (startLoc ? 1 : 0);
    document.getElementById('btn-calculate').disabled = total < 2;
    document.getElementById('btn-optimize').disabled = locations.length < 3;
  }

  function updateSummary(distanceM, durationS, profile, segments) {
    const el = document.getElementById('route-summary');
    el.classList.remove('hidden');
    document.getElementById('stat-distance').innerHTML =
      `<i class="fa-solid fa-road"></i> ${Routing.formatDistance(distanceM)}`;
    document.getElementById('stat-time').innerHTML =
      `<i class="fa-solid fa-clock"></i> ${Routing.formatDuration(durationS)}`;
    document.getElementById('stat-cost').innerHTML =
      `<i class="fa-solid fa-wallet"></i> ${segments ? Routing.totalCost(segments) : '--'}`;

    const list = document.getElementById('segments-list');
    list.innerHTML = '';
    if (!segments || !segments.length) return;

    segments.forEach((seg, i) => {
      // Divider between segments
      if (i > 0) {
        const div = document.createElement('div');
        div.className = 'seg-divider';
        div.innerHTML = `schimb la <b>${seg.from}</b>`;
        list.appendChild(div);
      }

      const item = document.createElement('div');
      item.className = 'segment-item';

      let waitHtml = '';
      if (seg.waitMin > 0) {
        waitHtml = `<span class="seg-time-chip seg-wait"><i class="fa-solid fa-hourglass-half"></i> Așteptare ${seg.waitMin} min</span>`;
      }

      item.innerHTML = `
        <div class="seg-header">
          <div class="seg-icon" style="background:${seg.color}"><i class="fa-solid ${seg.icon}"></i></div>
          <span class="seg-mode">${seg.modeName}</span>
          <span class="seg-time-chip" style="margin-left:auto"><i class="fa-solid fa-road"></i> ${seg.km} km</span>
        </div>
        <div class="seg-route">
          <i class="fa-solid fa-circle-dot"></i> ${seg.from}
          &nbsp;→&nbsp;
          <i class="fa-solid fa-location-dot"></i> ${seg.to}
        </div>
        <div class="seg-times">
          <span class="seg-time-chip"><i class="fa-solid fa-plane-departure"></i> ${Routing.formatTime(seg.departureTime)}</span>
          <span class="seg-time-chip"><i class="fa-solid fa-plane-arrival"></i> ${Routing.formatTime(seg.arrivalTime)}</span>
          <span class="seg-time-chip"><i class="fa-solid fa-clock"></i> ${Routing.formatDuration(seg.durationS)}</span>
          ${waitHtml}
          <span class="seg-cost-chip"><i class="fa-solid fa-wallet"></i> ${seg.cost.label}</span>
        </div>`;
      list.appendChild(item);
    });
  }

  function hideSummary() {
    document.getElementById('route-summary').classList.add('hidden');
  }

  function buildPopupHtml(loc) {
    const label = buildLocationLabel(loc);
    let html = `<div class="loc-popup"><h3>${label}</h3>`;
    if (loc.city) html += `<p><i class="fa-solid fa-location-dot"></i> ${[loc.cityType, loc.city, loc.county].filter(Boolean).join(', ')}</p>`;
    if (loc.phone) html += `<p><i class="fa-solid fa-phone"></i> <a href="tel:${loc.phone}">${loc.phone}</a></p>`;
    if (loc.description) html += `<div class="desc-text"><i class="fa-solid fa-circle-info"></i> ${loc.description}</div>`;
    if (loc.link) html += `<p><a href="${loc.link}" target="_blank" rel="noopener"><i class="fa-solid fa-link"></i> Deschide link</a></p>`;
    if (loc.property && (loc.property.landType || loc.property.area || loc.property.priceTotal)) {
      const p = loc.property;
      html += `<hr style="margin:5px 0;border:none;border-top:1px solid #eee">`;
      if (p.landType) html += `<p><i class="fa-solid fa-map"></i> Teren: <b>${p.landType}</b></p>`;
      if (p.area) html += `<p><i class="fa-solid fa-ruler-combined"></i> Suprafață: <b>${p.area} ${p.areaUnit||'mp'}</b></p>`;
      if (p.priceTotal) html += `<p><i class="fa-solid fa-euro-sign"></i> Preț: <b>${Number(p.priceTotal).toLocaleString()} €</b>${p.priceSqm ? ` (${p.priceSqm} €/mp)` : ''}</p>`;
      if (p.house && p.house !== 'nu') html += `<p><i class="fa-solid fa-house"></i> Construcție: <b>${p.house}</b>${p.houseFloors ? ` · ${p.houseFloors}` : ''}${p.houseArea ? ` · ${p.houseArea} mp` : ''}</p>`;
      if (p.houseBaths || p.houseKitchen) {
        const details = [p.houseBaths ? `${p.houseBaths} baie` : '', p.houseKitchen === 'da' ? 'bucătărie' : p.houseKitchen === 'bucatarie-vara' ? 'bucătărie vară' : ''].filter(Boolean);
        if (details.length) html += `<p><i class="fa-solid fa-door-open"></i> ${details.join(' · ')}</p>`;
      }
      if (p.annexes) {
        const ax = [];
        if (p.annexes.garage) ax.push('garaj'); if (p.annexes.barn) ax.push('grajd');
        if (p.annexes.cellar) ax.push('pivniță'); if (p.annexes.shed) ax.push('magazie');
        if (p.annexes.fence) ax.push('gard'); if (p.annexes.pool) ax.push('piscină');
        if (ax.length) html += `<p><i class="fa-solid fa-warehouse"></i> Anexe: ${ax.join(', ')}</p>`;
      }
      if (p.access && p.access !== 'ns') html += `<p><i class="fa-solid fa-road"></i> Acces: <b>${p.access}</b></p>`;
      if (p.landConfig && p.landConfig !== 'ns') html += `<p><i class="fa-solid fa-vector-square"></i> Teren: <b>${p.landConfig}</b></p>`;
      if (p.elecPulled && p.elecPulled !== 'ns') html += `<p><i class="fa-solid fa-plug"></i> Curent în casă: <b>${p.elecPulled === 'da' ? 'tras' : 'netras'}</b></p>`;
      if (p.waterPulled && p.waterPulled !== 'ns') html += `<p><i class="fa-solid fa-faucet"></i> Apă în casă: <b>${p.waterPulled === 'da' ? 'trasă' : 'netrasă'}</b></p>`;
      if (p.utilities) {
        const u = p.utilities;
        const utils = [];
        if (u.waterNetwork) utils.push('apă rețea');
        else if (u.waterWell) utils.push('fântână');
        else if (u.waterRiver) utils.push('apă râu');
        else if (u.waterNone) utils.push('fără apă');
        if (u.elecOnsite) utils.push('curent pe loc');
        else if (u.elecNearby) utils.push('curent aproape');
        else if (u.elecNone) utils.push('fără curent');
        if (u.gasOnsite) utils.push('gaze pe loc');
        else if (u.gasNearby) utils.push('gaze aproape');
        else if (u.gasNone) utils.push('fără gaze');
        if (u.sewerNetwork) utils.push('canalizare');
        else if (u.sewerSeptic) utils.push('fosă septică');
        else if (u.sewerNone) utils.push('fără canalizare');
        const heat = [];
        if (u.heatCentral) heat.push('centrală');
        if (u.heatGas) heat.push('gaze');
        if (u.heatStove) heat.push('sobă');
        if (u.heatElectric) heat.push('electric');
        if (heat.length) utils.push('încălzire: ' + heat.join('/'));
        if (utils.length) html += `<p><i class="fa-solid fa-plug"></i> Utilități: ${utils.join(', ')}</p>`;
      }
    }
    if (loc.images && loc.images.length) {
      html += `<div class="popup-images">`;
      loc.images.forEach(src => { html += `<img src="${src}" alt="imagine" onclick="window.open('${src}')" />`; });
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  return { openModal, closeModal, setGeocodeStatus, fillForm, getFormData, buildLocationLabel, renderList, updateSummary, hideSummary, buildPopupHtml };
})();
