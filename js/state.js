// App state shape + the real share-link encode/decode. The query format
// (?x=..&colors=hex:cfgIndex,...&cfg0=hue;sat;val&cfg1=...) is the same
// shape the mockup already built as a display-only string
// (Main.dc.html:2364-2369, using encodeShift) - this just also parses it
// back on load and writes it to location.hash instead of only displaying it.

var PRESET_HUES = ['#e63946', '#2a9d8f', '#f4a261', '#8338ec', '#ffbe0b', '#06d6a0', '#ff006e', '#4361ee'];

function makeColorEntry(id, hex) {
  var fields = deriveColorFields(hex);
  return Object.assign({
    id: id,
    hex: hex,
    pickerOpen: false,
    pickerMode: 'hsv',
    hexDraft: hex,
    configIndex: 0,
    actionsOpen: false,
  }, fields);
}

function createDefaultState() {
  var initialX = 4;
  return {
    colors: [
      makeColorEntry(1, '#ff8800'),
      makeColorEntry(2, '#3366cc'),
    ],
    nextId: 3,
    X: initialX,
    shiftConfigs: makeDefaultShiftConfigs(SHIFT_CONFIG_COUNT_INITIAL),
    activeConfig: 0,
    copied: false,
    colorDisplayMode: 'hsv',
    copiedColorId: null,
    rightTab: 'shift',
    compactRamps: false,
    selectedStep: 0,
    selectedAnchor: null,
    mobileTab: 'ramps',
    previewIndex: 0,
    infoOpen: false,
  };
}

// Builds the share query string from live state - same shape/order as the
// mockup's own shareQuery (only configurations actually assigned to a color
// are included, since an unused configuration is still just its defaults).
function encodeShareQuery(state) {
  var usedConfigIndexes = Array.from(new Set(state.colors.map(function (c) { return c.configIndex || 0; }))).sort();
  return 'x=' + state.X + '&colors=' + state.colors.map(function (c) {
    return c.hex.replace('#', '') + ':' + (c.configIndex || 0);
  }).join(',') +
    usedConfigIndexes.map(function (i) {
      var cfg = state.shiftConfigs[i];
      return '&cfg' + i + '=' + encodeURIComponent(encodeShift(cfg.hue) + ';' + encodeShift(cfg.sat) + ';' + encodeShift(cfg.val));
    }).join('');
}

// Parses a share query (the part after '#' or '?') back into a partial
// state patch, or null if it's missing/malformed - callers fall back to
// createDefaultState() in that case rather than showing a broken palette.
function decodeShareQuery(query) {
  if (!query) return null;
  try {
    var params = new URLSearchParams(query);
    var xRaw = params.get('x');
    var colorsRaw = params.get('colors');
    if (!xRaw || !colorsRaw) return null;
    var X = clamp(Math.round(Number(xRaw)), 1, 4);
    if (!isFinite(X)) return null;

    var configsByIndex = {};
    params.forEach(function (value, key) {
      var m = /^cfg(\d+)$/.exec(key);
      if (!m) return;
      var parts = value.split(';');
      if (parts.length !== 3) return;
      var hue = decodeShift(parts[0]) || defaultComponent('hue');
      var sat = decodeShift(parts[1]) || defaultComponent('sat');
      var val = decodeShift(parts[2]) || defaultComponent('val');
      configsByIndex[Number(m[1])] = { hue: hue, sat: sat, val: val };
    });

    var colorEntries = colorsRaw.split(',').filter(Boolean).map(function (token, idx) {
      var bits = token.split(':');
      var hex = '#' + bits[0];
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
      var configIndex = clamp(Math.round(Number(bits[1] || 0)) || 0, 0, SHIFT_CONFIG_COUNT_MAX - 1);
      var entry = makeColorEntry(idx + 1, hex.toLowerCase());
      entry.configIndex = configIndex;
      return entry;
    }).filter(Boolean);
    if (colorEntries.length === 0) return null;

    var maxConfigIndex = Math.max(0, colorEntries.reduce(function (m, c) { return Math.max(m, c.configIndex); }, 0));
    var configCount = Math.max(SHIFT_CONFIG_COUNT_INITIAL, maxConfigIndex + 1);
    var shiftConfigs = [];
    for (var i = 0; i < configCount; i++) {
      shiftConfigs.push(configsByIndex[i] || makeDefaultShiftConfig());
    }

    return {
      X: X,
      colors: colorEntries,
      nextId: colorEntries.length + 1,
      shiftConfigs: shiftConfigs,
      activeConfig: 0,
    };
  } catch (e) {
    return null;
  }
}

function readStateFromLocation() {
  var hash = location.hash.replace(/^#/, '');
  return decodeShareQuery(hash);
}

var _hashWriteTimer = null;
// Debounced so a drag (many state changes per second) doesn't spam
// history.replaceState; replaceState (not pushState) so it never pollutes
// back-button history.
function scheduleWriteStateToHash(state) {
  clearTimeout(_hashWriteTimer);
  _hashWriteTimer = setTimeout(function () {
    var query = encodeShareQuery(state);
    history.replaceState(null, '', '#' + query);
  }, 200);
}

function shareUrlFor(state) {
  return location.origin + location.pathname + '#' + encodeShareQuery(state);
}
