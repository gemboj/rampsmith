// Color conversion helpers, ported verbatim from mockup/Main.dc.html.
// HSV <-> RGB <-> OKLCH conversions and the derived per-color field bundle
// the app's HSV/OKLCH tabs read from. Do not "clean up" this math when
// touching it - see [[hsv-oklch-slider-roundtrip-bug]] and
// [[exact-base-color-invariant]] in project memory for why the exact shape
// here matters.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return [
    parseInt(hex.substr(0, 2), 16) / 255,
    parseInt(hex.substr(2, 2), 16) / 255,
    parseInt(hex.substr(4, 2), 16) / 255,
  ];
}

function rgbToHsv(r, g, b) {
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var d = max - min;
  var h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  var s = max === 0 ? 0 : d / max;
  var v = max;
  return [h, s * 100, v * 100];
}

function roundedHsvFromHex(hex) {
  var rgb = hexToRgb(hex);
  var hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  return { h: Math.round(hsv[0]), s: Math.round(hsv[1]), v: Math.round(hsv[2]) };
}

function formatColorDisplay(hex, mode) {
  if (mode === 'hsv') {
    var hsv = roundedHsvFromHex(hex);
    return 'H:' + hsv.h + ' S:' + hsv.s + ' V:' + hsv.v;
  }
  if (mode === 'oklch') {
    var f = deriveColorFields(hex);
    return 'L:' + f.oklchL + ' C:' + f.oklchC + ' H:' + f.oklchH;
  }
  return hex.toUpperCase();
}

function hsvToRgb(h, s, v) {
  s = s / 100; v = v / 100;
  var c = v * s;
  var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  var m = v - c;
  var r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}

function toHex(r, g, b) {
  function c(v) {
    var n = Math.round(clamp(v, 0, 1) * 255).toString(16);
    return n.length === 1 ? '0' + n : n;
  }
  return '#' + c(r) + c(g) + c(b);
}

// OKLCH conversion (Bjorn Ottosson, 2020) - equal L means equal perceived
// lightness regardless of hue, unlike HSV's V.
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) {
  c = clamp(c, 0, 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function linearRgbToOklab(r, g, b) {
  var l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  var m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  var s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}
function oklabToLinearRgb(L, a, b) {
  var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  var s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
function rgbToOklch(r, g, b) {
  var lab = linearRgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
  var L = lab[0], a = lab[1], bb = lab[2];
  var C = Math.sqrt(a * a + bb * bb);
  var H = Math.atan2(bb, a) * 180 / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}
function oklchToLinearRgb(L, C, H) {
  var hr = H * Math.PI / 180;
  return oklabToLinearRgb(L, C * Math.cos(hr), C * Math.sin(hr));
}
function oklchInGamut(L, C, H) {
  var eps = 1e-4;
  var rgb = oklchToLinearRgb(L, C, H);
  return rgb[0] >= -eps && rgb[0] <= 1 + eps && rgb[1] >= -eps && rgb[1] <= 1 + eps && rgb[2] >= -eps && rgb[2] <= 1 + eps;
}
// Binary search for the per-hue/lightness chroma gamut ceiling - OKLCH
// chroma has no fixed 0..100 ceiling the way HSV's S does.
function maxChromaAt(L, H) {
  if (L <= 1e-4 || L >= 1 - 1e-4) return 0;
  var lo = 0, hi = 0.4;
  for (var i = 0; i < 28; i++) {
    var mid = (lo + hi) / 2;
    if (oklchInGamut(L, mid, H)) lo = mid; else hi = mid;
  }
  return lo;
}
function oklchToHex(L, C, H) {
  var rgb = oklchToLinearRgb(L, C, H);
  return toHex(linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2]));
}

function deriveColorFields(hex) {
  var rgb = hexToRgb(hex);
  var hsv = roundedHsvFromHex(hex);
  var oklch = rgbToOklch(rgb[0], rgb[1], rgb[2]);
  var maxC = maxChromaAt(oklch[0], oklch[2]);
  var cFrac = maxC > 1e-6 ? (oklch[1] / maxC) * 100 : 0;
  return {
    hsvH: hsv.h, hsvS: hsv.s, hsvV: hsv.v,
    oklchL: Math.round(oklch[0] * 100),
    oklchC: Math.round(clamp(cFrac, 0, 100)),
    oklchH: Math.round(oklch[2]),
  };
}
// OKLCH's wheel isn't uniformly spaced like HSV's, so yellow doesn't sit at
// a round number - computed from the real conversion rather than guessed.
var OKLCH_YELLOW_H = rgbToOklch(1, 1, 0)[2];
