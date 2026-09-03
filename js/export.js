// Whole-palette PNG export: draws every base color's full ramp (reusing
// genRamp - the exact same computation that produces the on-screen
// swatches) onto an offscreen canvas, then triggers a download. Each
// swatch is a single pixel and each ramp is its own row, so the file is
// just the raw grid of colors with no padding, gaps, or background.

function exportPaletteAsPng(state) {
  var X = state.X;
  var stepsPerRow = 2 * X + 1;

  var rows = state.colors.map(function (c) {
    var cfg = state.shiftConfigs[c.configIndex || 0];
    return genRamp(c.hex, X, cfg.hue, cfg.sat, cfg.val);
  });

  if (rows.length === 0) return;

  var canvas = document.createElement('canvas');
  canvas.width = stepsPerRow;
  canvas.height = rows.length;
  var ctx = canvas.getContext('2d');

  rows.forEach(function (ramp, rowIdx) {
    ramp.forEach(function (hex, i) {
      ctx.fillStyle = hex;
      ctx.fillRect(i, rowIdx, 1, 1);
    });
  });

  canvas.toBlob(function (blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'rampsmith.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
}
