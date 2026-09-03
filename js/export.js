// Whole-palette PNG export: draws every base color's full ramp (reusing
// genRamp - the exact same computation that produces the on-screen
// swatches) onto an offscreen canvas, then triggers a download. No
// dependencies, no server.

function exportPaletteAsPng(state) {
  var X = state.X;
  var stepsPerRow = 2 * X + 1;
  var SWATCH = 96; // px per swatch at export resolution (crisper than the ~34px on-screen swatch)
  var GAP = 8;
  var PADDING = 32;
  var rowHeight = SWATCH;
  var rowGap = 20;

  var rows = state.colors.map(function (c) {
    var cfg = state.shiftConfigs[c.configIndex || 0];
    return genRamp(c.hex, X, cfg.hue, cfg.sat, cfg.val);
  });

  if (rows.length === 0) return;

  var width = PADDING * 2 + stepsPerRow * SWATCH + (stepsPerRow - 1) * GAP;
  var height = PADDING * 2 + rows.length * rowHeight + (rows.length - 1) * rowGap;

  var canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  var ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1a1522';
  ctx.fillRect(0, 0, width, height);

  rows.forEach(function (ramp, rowIdx) {
    var y = PADDING + rowIdx * (rowHeight + rowGap);
    ramp.forEach(function (hex, i) {
      var x = PADDING + i * (SWATCH + GAP);
      ctx.fillStyle = hex;
      ctx.fillRect(x, y, SWATCH, SWATCH);
    });
  });

  canvas.toBlob(function (blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'palette-forge.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}
