// ── Locations store ──────────────────────────────────────────────
const LocationStore = (() => {
  let locations = [];
  let startLocation = null; // { lat, lng, label }
  let editingId = null;

  function genId() {
    return '_' + Math.random().toString(36).slice(2, 9);
  }

  function add(data) {
    const loc = { id: genId(), ...data };
    locations.push(loc);
    return loc;
  }

  function update(id, data) {
    const idx = locations.findIndex(l => l.id === id);
    if (idx !== -1) locations[idx] = { ...locations[idx], ...data };
  }

  function remove(id) {
    locations = locations.filter(l => l.id !== id);
  }

  function reorder(newOrder) {
    // newOrder: array of ids
    locations = newOrder.map(id => locations.find(l => l.id === id)).filter(Boolean);
  }

  function getAll() { return [...locations]; }
  function getById(id) { return locations.find(l => l.id === id); }
  function count() { return locations.length; }
  function clear() { locations = []; startLocation = null; editingId = null; }

  function setStart(loc) { startLocation = loc; }
  function getStart() { return startLocation; }

  function setEditing(id) { editingId = id; }
  function getEditing() { return editingId; }

  return { add, update, remove, reorder, getAll, getById, count, clear, setStart, getStart, setEditing, getEditing };
})();
