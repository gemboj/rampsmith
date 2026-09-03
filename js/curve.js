// Curve/ramp math, ported verbatim from mockup/Main.dc.html, plus new
// decodeAnchor/decodeShift (inverse of the original encodeAnchor/encodeShift)
// needed for the real share-link. See project memory:
// [[curve-graph-no-fixed-center]], [[auto-mode-breaks-anchor-independence]],
// [[exact-base-color-invariant]], [[global-ramp-selection]] - none of this
// math should be "fixed" or re-derived, only relocated.

// Fixed logical plot size (the SVG uses viewBox="0 0 360 208" with
// width/height:100%, so this stays the coordinate space regardless of how
// large the card actually renders - see svgLocalPoint below).
var PLOT_W = 360, PLOT_H = 208, PLOT_MARGIN_X = 20, PLOT_MARGIN_Y = 52, PLOT_CX = 180;

function valToY(v, domainMin, domainMax) {
  var t = (v - domainMin) / (domainMax - domainMin);
  return (PLOT_H - PLOT_MARGIN_Y) - t * (PLOT_H - 2 * PLOT_MARGIN_Y);
}
function yToVal(y, domainMin, domainMax) {
  var t = ((PLOT_H - PLOT_MARGIN_Y) - y) / (PLOT_H - 2 * PLOT_MARGIN_Y);
  return domainMin + clamp(t, -0.5, 1.5) * (domainMax - domainMin);
}
function fracToPx(frac) { return PLOT_MARGIN_X + frac * (PLOT_W - 2 * PLOT_MARGIN_X); }
function pxToFrac(px) { return clamp((px - PLOT_MARGIN_X) / (PLOT_W - 2 * PLOT_MARGIN_X), 0, 1); }
var PLOT_HALF = PLOT_W / 2 - PLOT_MARGIN_X;
function handleFracToPx(frac, side) {
  return side === 'right' ? PLOT_CX + frac * PLOT_HALF : PLOT_CX - frac * PLOT_HALF;
}
function pxToHandleFrac(px, side) {
  var frac = side === 'right' ? (px - PLOT_CX) / PLOT_HALF : (PLOT_CX - px) / PLOT_HALF;
  return clamp(frac, -1, 1);
}
function pxToHandleVal(y, domainMin, domainMax) { return yToVal(y, domainMin, domainMax); }
function svgLocalPoint(e) {
  var svg = e.target.closest('svg');
  var rect = svg.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (PLOT_W / rect.width),
    y: (e.clientY - rect.top) * (PLOT_H / rect.height),
  };
}
function wheelLocalPoint(e, size) {
  var disc = e.target.closest('.wheel-disc');
  var rect = disc.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (size / rect.width),
    y: (e.clientY - rect.top) * (size / rect.height),
  };
}

function cubicAt(p0, p1, p2, p3, s) {
  var mt = 1 - s;
  return mt * mt * mt * p0 + 3 * mt * mt * s * p1 + 3 * mt * s * s * p2 + s * s * s * p3;
}
function solveSForStep(targetStep, p0x, p1x, p2x, p3x) {
  if (Math.abs(targetStep - p0x) < 1e-9) return 0;
  if (Math.abs(targetStep - p3x) < 1e-9) return 1;
  var N = 48, prevS = 0, prevF = p0x - targetStep, found = null;
  for (var i = 1; i <= N; i++) {
    var curS = i / N;
    var curF = cubicAt(p0x, p1x, p2x, p3x, curS) - targetStep;
    if ((prevF <= 0 && curF >= 0) || (prevF >= 0 && curF <= 0)) {
      var lo = prevS, hi = curS, loF = prevF;
      for (var k = 0; k < 30; k++) {
        var mid = (lo + hi) / 2;
        var midF = cubicAt(p0x, p1x, p2x, p3x, mid) - targetStep;
        if ((loF <= 0 && midF >= 0) || (loF >= 0 && midF <= 0)) { hi = mid; } else { lo = mid; loF = midF; }
      }
      found = (lo + hi) / 2;
      break;
    }
    prevS = curS; prevF = curF;
  }
  return found !== null ? found : clamp((targetStep - p0x) / (p3x - p0x), 0, 1);
}
function autoHandles(comp, X) {
  var leftSlope = (comp.center.range - comp.left.range) / X;
  var rightSlope = (comp.right.range - comp.center.range) / X;
  var centerSlope = (comp.right.range - comp.left.range) / (2 * X);
  var third = X / 3;
  return {
    leftHandle: { tFrac: 2 / 3, y: comp.left.range + leftSlope * third },
    centerHandleLeft: { tFrac: 1 / 3, y: comp.center.range - centerSlope * third },
    centerHandleRight: { tFrac: 1 / 3, y: comp.center.range + centerSlope * third },
    rightHandle: { tFrac: 2 / 3, y: comp.right.range - rightSlope * third },
  };
}
function resolveHandles(comp, X) {
  var auto = autoHandles(comp, X);
  return {
    leftHandle: comp.left.handleType === 'auto' ? auto.leftHandle : comp.leftHandle,
    centerHandleLeft: comp.center.handleType === 'auto' ? auto.centerHandleLeft : comp.centerHandleLeft,
    centerHandleRight: comp.center.handleType === 'auto' ? auto.centerHandleRight : comp.centerHandleRight,
    rightHandle: comp.right.handleType === 'auto' ? auto.rightHandle : comp.rightHandle,
  };
}
function curveValueAt(comp, X, step) {
  if (step === 0) return comp.center.range;
  var left = step < 0;
  var handles = resolveHandles(comp, X);
  var p0x, p1x, p2x, p3x, p0y, p1y, p2y, p3y;
  if (left) {
    p0x = -X; p1x = -handles.leftHandle.tFrac * X; p2x = -handles.centerHandleLeft.tFrac * X; p3x = 0;
    p0y = comp.left.range; p1y = handles.leftHandle.y; p2y = handles.centerHandleLeft.y; p3y = comp.center.range;
  } else {
    p0x = 0; p1x = handles.centerHandleRight.tFrac * X; p2x = handles.rightHandle.tFrac * X; p3x = X;
    p0y = comp.center.range; p1y = handles.centerHandleRight.y; p2y = handles.rightHandle.y; p3y = comp.right.range;
  }
  var s = solveSForStep(step, p0x, p1x, p2x, p3x);
  return cubicAt(p0y, p1y, p2y, p3y, s);
}
function targetRelativeShift(p, M, base) {
  if (Math.abs(p - M) < 1e-9) return 0;
  if (p < M) {
    if (M <= 1e-9) return -base;
    return base * (p / M) - base;
  }
  if (M >= 100 - 1e-9) return 100 - base;
  return ((p - M) / (100 - M)) * (100 - base);
}
function hueRotationSign(h, landmark) {
  var toYellow = ((landmark - h) % 360 + 360) % 360;
  return toYellow <= 180 ? 1 : -1;
}
function shiftFor(comp, X, step) {
  var M = curveValueAt(comp, X, 0);
  return curveValueAt(comp, X, step) - M;
}
function genRamp(hex, X, hue, sat, val) {
  var rgb = hexToRgb(hex);
  var oklch = rgbToOklch(rgb[0], rgb[1], rgb[2]);
  var L0 = oklch[0], C0 = oklch[1], H0 = oklch[2];
  var baseMaxC = maxChromaAt(L0, H0);
  var baseCFrac = baseMaxC > 1e-6 ? (C0 / baseMaxC) * 100 : 0;
  var baseLPct = L0 * 100;
  var satM = curveValueAt(sat, X, 0), valM = curveValueAt(val, X, 0);
  var ramp = [];
  for (var step = -X; step <= X; step++) {
    if (step === 0) { ramp.push(toHex(rgb[0], rgb[1], rgb[2])); continue; }
    var nh = ((H0 + hueRotationSign(H0, OKLCH_YELLOW_H) * shiftFor(hue, X, step)) % 360 + 360) % 360;
    var nLPct = clamp(baseLPct + targetRelativeShift(curveValueAt(val, X, step), valM, baseLPct), 0, 100);
    var nCFracPct = clamp(baseCFrac + targetRelativeShift(curveValueAt(sat, X, step), satM, baseCFrac), 0, 100);
    var nL = nLPct / 100;
    var nC = (nCFracPct / 100) * maxChromaAt(nL, nh);
    ramp.push(oklchToHex(nL, nC, nh));
  }
  return ramp;
}

function round2(n) { return Math.round(n * 100) / 100; }
function encodeAnchor(anchor, handle1, handle2) {
  if (anchor.handleType === 'auto') return 'a:' + anchor.range;
  var s = 'm:' + anchor.range + ':' + round2(handle1.tFrac) + ':' + round2(handle1.y);
  if (handle2) s += ':' + round2(handle2.tFrac) + ':' + round2(handle2.y);
  return s;
}
function encodeShift(comp) {
  return encodeAnchor(comp.left, comp.leftHandle) + '|' +
    encodeAnchor(comp.center, comp.centerHandleLeft, comp.centerHandleRight) + '|' +
    encodeAnchor(comp.right, comp.rightHandle);
}
// Inverse of encodeAnchor - 'a:<range>' or 'm:<range>:<tFrac>:<y>[:<tFrac>:<y>]'.
// Returns null on any malformed input so the caller can fall back to
// defaults rather than crash on a hand-edited/corrupt share link.
function decodeAnchor(str) {
  if (!str) return null;
  var parts = str.split(':');
  if (parts[0] === 'a') {
    var range = Number(parts[1]);
    if (!isFinite(range)) return null;
    return { anchor: { range: range, handleType: 'auto' }, handle1: null, handle2: null };
  }
  if (parts[0] === 'm') {
    var mRange = Number(parts[1]);
    var h1 = { tFrac: Number(parts[2]), y: Number(parts[3]) };
    if (!isFinite(mRange) || !isFinite(h1.tFrac) || !isFinite(h1.y)) return null;
    var h2 = null;
    if (parts.length > 4) {
      h2 = { tFrac: Number(parts[4]), y: Number(parts[5]) };
      if (!isFinite(h2.tFrac) || !isFinite(h2.y)) return null;
    }
    return { anchor: { range: mRange, handleType: 'manual' }, handle1: h1, handle2: h2 };
  }
  return null;
}
// Inverse of encodeShift - 'left|center|right', each an encodeAnchor string.
// Returns null (caller falls back to defaultComponent) on any parse failure.
function decodeShift(str) {
  if (!str) return null;
  var parts = str.split('|');
  if (parts.length !== 3) return null;
  var left = decodeAnchor(parts[0]);
  var center = decodeAnchor(parts[1]);
  var right = decodeAnchor(parts[2]);
  if (!left || !center || !right) return null;
  var comp = { left: left.anchor, center: center.anchor, right: right.anchor };
  comp.leftHandle = left.handle1 || { tFrac: 2 / 3, y: left.anchor.range };
  comp.centerHandleLeft = center.handle1 || { tFrac: 1 / 3, y: center.anchor.range };
  comp.centerHandleRight = center.handle2 || { tFrac: 1 / 3, y: center.anchor.range };
  comp.rightHandle = right.handle1 || { tFrac: 2 / 3, y: right.anchor.range };
  return comp;
}

// Factory defaults per component - identical to the mockup's
// DEFAULT_COMPONENTS/defaultComponent, used both to seed initial state and
// to power each card's Reset button.
var DEFAULT_COMPONENTS = {
  hue: {
    left: { range: -15, handleType: 'auto' }, center: { range: 0, handleType: 'auto' }, right: { range: 15, handleType: 'auto' },
    leftHandle: { tFrac: 2 / 3, y: -10 }, centerHandleLeft: { tFrac: 1 / 3, y: -5 },
    centerHandleRight: { tFrac: 1 / 3, y: 5 }, rightHandle: { tFrac: 2 / 3, y: 10 },
  },
  sat: {
    left: { range: 20, handleType: 'auto' }, center: { range: 50, handleType: 'auto' }, right: { range: 80, handleType: 'auto' },
    leftHandle: { tFrac: 2 / 3, y: 30 }, centerHandleLeft: { tFrac: 1 / 3, y: 40 },
    centerHandleRight: { tFrac: 1 / 3, y: 60 }, rightHandle: { tFrac: 2 / 3, y: 70 },
  },
  val: {
    left: { range: 15, handleType: 'auto' }, center: { range: 52.5, handleType: 'auto' }, right: { range: 90, handleType: 'auto' },
    leftHandle: { tFrac: 2 / 3, y: 27.5 }, centerHandleLeft: { tFrac: 1 / 3, y: 40 },
    centerHandleRight: { tFrac: 1 / 3, y: 65 }, rightHandle: { tFrac: 2 / 3, y: 77.5 },
  },
};
function defaultComponent(key) {
  var d = DEFAULT_COMPONENTS[key];
  return {
    left: Object.assign({}, d.left),
    center: Object.assign({}, d.center),
    right: Object.assign({}, d.right),
    leftHandle: Object.assign({}, d.leftHandle),
    centerHandleLeft: Object.assign({}, d.centerHandleLeft),
    centerHandleRight: Object.assign({}, d.centerHandleRight),
    rightHandle: Object.assign({}, d.rightHandle),
  };
}

var SHIFT_CONFIG_COUNT_MAX = 6;
var SHIFT_CONFIG_COUNT_INITIAL = 2;
function makeDefaultShiftConfig() {
  return { hue: defaultComponent('hue'), sat: defaultComponent('sat'), val: defaultComponent('val') };
}
function makeDefaultShiftConfigs(n) {
  var configs = [];
  for (var i = 0; i < n; i++) configs.push(makeDefaultShiftConfig());
  return configs;
}
function isDefaultShiftConfig(cfg) {
  return JSON.stringify(cfg.hue) === JSON.stringify(defaultComponent('hue')) &&
    JSON.stringify(cfg.sat) === JSON.stringify(defaultComponent('sat')) &&
    JSON.stringify(cfg.val) === JSON.stringify(defaultComponent('val'));
}
function countDefaultShiftConfigs(configs) {
  var n = 0;
  for (var i = 0; i < configs.length; i++) if (isDefaultShiftConfig(configs[i])) n++;
  return n;
}

// Dice-face icon for each of the 6 configurations.
var DICE_COLORS = [
  'oklch(75% 0.16 140)', 'oklch(75% 0.18 345)', 'oklch(85% 0.17 95)',
  'oklch(70% 0.16 255)', 'oklch(75% 0.16 300)', 'oklch(72% 0.18 45)',
];
var DICE_PIP_LAYOUTS = [
  [[10, 10]],
  [[5, 5], [15, 15]],
  [[5, 5], [10, 10], [15, 15]],
  [[5, 5], [15, 5], [5, 15], [15, 15]],
  [[5, 5], [15, 5], [10, 10], [5, 15], [15, 15]],
  [[5, 5], [15, 5], [5, 10], [15, 10], [5, 15], [15, 15]],
];
function dicePips(configIndex) {
  var i = ((configIndex % SHIFT_CONFIG_COUNT_MAX) + SHIFT_CONFIG_COUNT_MAX) % SHIFT_CONFIG_COUNT_MAX;
  var color = DICE_COLORS[i];
  return DICE_PIP_LAYOUTS[i].map(function (p) { return { cx: p[0], cy: p[1], color: color }; });
}

// This function draws curveValueAt's own two Bezier segments exactly as
// constructed. absoluteTarget only picks the vertical domain (0..100 for
// Saturation/Value, -100..100 for Hue's signed degree deltas).
function computeCurveSvg(comp, X, absoluteTarget) {
  var N = 40;
  var domainMin = absoluteTarget ? 0 : -100, domainMax = 100;
  function raw(step) { return curveValueAt(comp, X, step); }
  var pts = [];
  for (var i = 0; i <= N; i++) {
    var frac = i / N;
    var step = -X + frac * 2 * X;
    pts.push(fracToPx(frac).toFixed(1) + ',' + valToY(raw(step), domainMin, domainMax).toFixed(1));
  }
  var handles = resolveHandles(comp, X);
  return {
    points: pts.join(' '),
    centerX: PLOT_CX.toFixed(1),
    centerY: valToY(comp.center.range, domainMin, domainMax).toFixed(1),
    leftAnchor: { x: fracToPx(0).toFixed(1), y: valToY(comp.left.range, domainMin, domainMax).toFixed(1) },
    rightAnchor: { x: fracToPx(1).toFixed(1), y: valToY(comp.right.range, domainMin, domainMax).toFixed(1) },
    leftHandle: { x: handleFracToPx(handles.leftHandle.tFrac, 'left').toFixed(1), y: valToY(handles.leftHandle.y, domainMin, domainMax).toFixed(1) },
    centerHandleLeft: { x: handleFracToPx(handles.centerHandleLeft.tFrac, 'left').toFixed(1), y: valToY(handles.centerHandleLeft.y, domainMin, domainMax).toFixed(1) },
    centerHandleRight: { x: handleFracToPx(handles.centerHandleRight.tFrac, 'right').toFixed(1), y: valToY(handles.centerHandleRight.y, domainMin, domainMax).toFixed(1) },
    rightHandle: { x: handleFracToPx(handles.rightHandle.tFrac, 'right').toFixed(1), y: valToY(handles.rightHandle.y, domainMin, domainMax).toFixed(1) },
  };
}
