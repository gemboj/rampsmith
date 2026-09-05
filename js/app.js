// Rampsmith - vanilla JS port of mockup/Main.dc.html.
//
// Rendering strategy: persistent DOM + imperative sync, not a virtual DOM
// and not full-tree-rebuild-per-change. Every dynamic DOM node that carries
// an in-progress interaction (setPointerCapture on curve/wheel drag
// handles, focus/cursor position in text or range inputs) is created ONCE
// and only ever has its attributes/values patched afterward - render() is
// safe to call on every single state change (including every pointermove
// during a drag) because it never destroys a node that might be mid-drag
// or mid-edit. Only collections whose membership actually changes (the
// color list, ramp swatches, wheel markers) create/destroy nodes, keyed by
// stable id.

var SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      if (k === 'className') el.className = attrs[k];
      else if (k === 'style') el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
  }
  if (children != null) {
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
  }
  return el;
}
function svgEl(tag, attrs) {
  var el = document.createElementNS(SVGNS, tag);
  if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
  return el;
}
function svgFromMarkup(svgString) {
  var wrap = document.createElement('div');
  wrap.innerHTML = svgString;
  return wrap.firstElementChild;
}

var STYLE_ACTIVE = 'background: oklch(24% 0.035 290); color: oklch(80% 0.15 195); cursor: pointer;';
var STYLE_DISABLED = 'background: oklch(19% 0.03 290); color: oklch(38% 0.02 290); cursor: default;';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
var state;
var refs = {};
var cardRefs = {};
var colorRefs = new Map();
var wheelRefs = new Map();
var lastAnchorClickAt = {};
var copyTimer = null;
var colorCopyTimer = null;
var colorCountSteppers = [];
var rampSizeSteppers = [];
var compactToggleInstances = [];
var sortBtnInstances = [];
var totalColorsTexts = [];

var WHEEL_SIZE = 380, WHEEL_MARKER_R = 7, WHEEL_HIT_R = 13;
var wheelCx = WHEEL_SIZE / 2, wheelCy = WHEEL_SIZE / 2;
var wheelEffR = WHEEL_SIZE / 2 - WHEEL_MARKER_R - 4;

function setState(patch) {
  Object.assign(state, patch);
  render();
  scheduleWriteStateToHash(state);
}

function currentCompFor(key) { return state.shiftConfigs[state.activeConfig || 0][key]; }
function withUpdatedComp(key, newCompForKey) {
  var ac = state.activeConfig || 0;
  var configs = state.shiftConfigs.slice();
  var patched = Object.assign({}, configs[ac]);
  patched[key] = newCompForKey;
  configs[ac] = patched;
  return configs;
}
function updateComp(key, patch) {
  setState({ shiftConfigs: withUpdatedComp(key, Object.assign({}, currentCompFor(key), patch)) });
}

function getColor(id) { return state.colors.find(function (c) { return c.id === id; }); }

// ---------------------------------------------------------------------------
// Curve card (HUE / CHROMA / LIGHTNESS) - one persistent instance per key.
// ---------------------------------------------------------------------------
function buildCard(key, label, swatchStyle, lineColor, absoluteTarget) {
  var domainMin = absoluteTarget ? 0 : -100, domainMax = 100;

  var swatch = h('div', { className: 'hsv-swatch', style: swatchStyle });
  var labelEl = h('div', { className: 'pixel-label', style: 'font-size:13px;color:oklch(92% 0.01 290);' }, label);
  var resetBtn = h('div', { className: 'bevel-raised step-btn', title: 'Reset to default' },
    svgFromMarkup('<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h5"></path><path d="M4.5 9a6.5 6.5 0 1 1 1.8 6.6"></path></svg>'));
  resetBtn.addEventListener('click', function () { updateComp(key, defaultComponent(key)); });
  var headerRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;flex-shrink:0;' }, [
    h('div', { style: 'display:flex;align-items:center;gap:10px;' }, [swatch, labelEl]),
    resetBtn,
  ]);

  // plotW/plotH track the SVG's actual rendered pixel size (kept in sync
  // via ResizeObserver below) so the viewBox always matches 1:1 - no
  // preserveAspectRatio scaling, which used to stretch the curve and turn
  // its round anchor/handle dots into ellipses whenever a card's aspect
  // ratio drifted from the old fixed 360x208 logical size.
  var plotW = PLOT_W, plotH = PLOT_H;
  var svg = svgEl('svg', { width: '100%', height: '100%', viewBox: '0 0 ' + plotW + ' ' + plotH, style: 'display:block;' });
  var frame = computeCurvePlotFrame(plotW, plotH);
  var frameRect = svgEl('rect', { x: frame.rect.x, y: frame.rect.y, width: frame.rect.width, height: frame.rect.height, fill: 'oklch(14% 0.03 290)', stroke: 'oklch(30% 0.04 290)', 'stroke-width': 1 });
  var hLine = svgEl('line', { x1: frame.hLine.x1, y1: frame.hLine.y, x2: frame.hLine.x2, y2: frame.hLine.y, stroke: 'oklch(30% 0.04 290)', 'stroke-width': 1, 'stroke-dasharray': '3,3' });
  var vLine = svgEl('line', { x1: frame.vLine.x, y1: frame.vLine.y1, x2: frame.vLine.x, y2: frame.vLine.y2, stroke: 'oklch(26% 0.035 290)', 'stroke-width': 1, 'stroke-dasharray': '2,3' });
  svg.appendChild(frameRect);
  svg.appendChild(hLine);
  svg.appendChild(vLine);
  var polyline = svgEl('polyline', { points: '', fill: 'none', stroke: lineColor, 'stroke-width': 2 });
  svg.appendChild(polyline);

  function makeAnchorVisual() {
    var hit = svgEl('circle', { class: 'curve-handle-hit', r: 20, fill: 'transparent' });
    var dot = svgEl('circle', { r: 4, stroke: lineColor, 'stroke-width': 2, style: 'pointer-events:none;' });
    svg.appendChild(hit); svg.appendChild(dot);
    return { hit: hit, dot: dot };
  }
  var leftAnchor = makeAnchorVisual(), centerAnchor = makeAnchorVisual(), rightAnchor = makeAnchorVisual();

  function makeHandleVisual() {
    var line = svgEl('line', { stroke: lineColor, 'stroke-width': 1, 'stroke-dasharray': '2,2', opacity: 0.5, style: 'display:none;' });
    var hit = svgEl('circle', { class: 'curve-handle-hit', r: 20, fill: 'transparent', style: 'display:none;' });
    var dot = svgEl('circle', { r: 4, fill: lineColor, stroke: 'oklch(11% 0.025 290)', 'stroke-width': 1.5, style: 'display:none;pointer-events:none;' });
    svg.appendChild(line); svg.appendChild(hit); svg.appendChild(dot);
    return { line: line, hit: hit, dot: dot };
  }
  var leftHandle = makeHandleVisual(), centerLeftHandle = makeHandleVisual(), centerRightHandle = makeHandleVisual(), rightHandle = makeHandleVisual();

  var plotWrap = h('div', { className: 'bevel-well curve-plot' }, svg);
  // touch-action:none (above) isn't reliably honored by every mobile browser's
  // scroll-gesture recognizer - see the same reasoning on wire()'s touchmove
  // listener below. Without this, a touch that lands just off a hit circle
  // still scrolls the page instead of doing nothing.
  plotWrap.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

  // Redraw at the plot's actual rendered size whenever it changes (card
  // width flexes with the viewport; see [[curve-plot-no-stretch]]) instead
  // of leaving the SVG to non-uniformly scale via viewBox/preserveAspectRatio.
  if (typeof ResizeObserver !== 'undefined') {
    var resizeObserver = new ResizeObserver(function (entries) {
      var entry = entries[entries.length - 1];
      var box = entry.contentBoxSize && entry.contentBoxSize[0]
        ? { width: entry.contentBoxSize[0].inlineSize, height: entry.contentBoxSize[0].blockSize }
        : entry.contentRect;
      var w = Math.round(box.width), h = Math.round(box.height);
      if (w <= 0 || h <= 0 || (w === plotW && h === plotH)) return;
      plotW = w; plotH = h;
      svg.setAttribute('viewBox', '0 0 ' + plotW + ' ' + plotH);
      var f = computeCurvePlotFrame(plotW, plotH);
      frameRect.setAttribute('x', f.rect.x); frameRect.setAttribute('y', f.rect.y);
      frameRect.setAttribute('width', f.rect.width); frameRect.setAttribute('height', f.rect.height);
      hLine.setAttribute('x1', f.hLine.x1); hLine.setAttribute('x2', f.hLine.x2);
      hLine.setAttribute('y1', f.hLine.y); hLine.setAttribute('y2', f.hLine.y);
      vLine.setAttribute('x1', f.vLine.x); vLine.setAttribute('x2', f.vLine.x);
      vLine.setAttribute('y1', f.vLine.y1); vLine.setAttribute('y2', f.vLine.y2);
      update();
    });
    resizeObserver.observe(plotWrap);
  }

  function rangeInput() { return h('input', { type: 'number', className: 'value-input pixel-text' }); }
  var leftRangeInput = rangeInput(), centerRangeInput = rangeInput(), rightRangeInput = rangeInput();
  var inputsRow = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;flex-shrink:0;' }, [leftRangeInput, centerRangeInput, rightRangeInput]);

  var root = h('div', { className: 'curve-card' }, [headerRow, plotWrap, inputsRow]);

  var stopClick = function (e) { e.stopPropagation(); };

  function clampHandleVal(v) {
    var handleOvershoot = (domainMax - domainMin) * 0.5;
    return clamp(v, domainMin - handleOvershoot, domainMax + handleOvershoot);
  }

  var ATTACHED_HANDLES = { left: ['leftHandle'], center: ['centerHandleLeft', 'centerHandleRight'], right: ['rightHandle'] };
  function setRange(sideName, newRange) {
    var latestComp = currentCompFor(key);
    var delta = newRange - latestComp[sideName].range;
    var patch = {};
    patch[sideName] = Object.assign({}, latestComp[sideName], { range: newRange });
    ATTACHED_HANDLES[sideName].forEach(function (handleName) {
      patch[handleName] = Object.assign({}, latestComp[handleName], { y: clampHandleVal(latestComp[handleName].y + delta) });
    });
    updateComp(key, patch);
  }

  function snapToAuto(sideName, latestComp) {
    var auto = autoHandles(latestComp, state.X);
    if (sideName === 'left') return { leftHandle: auto.leftHandle };
    if (sideName === 'right') return { rightHandle: auto.rightHandle };
    return { centerHandleLeft: auto.centerHandleLeft, centerHandleRight: auto.centerHandleRight };
  }

  function makeAnchorDrag(sideName) {
    return {
      onPointerDown: function (e) {
        e.preventDefault();
        try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
        var latestComp = currentCompFor(key);
        var anyOpen = state.colors.some(function (c) { return c.pickerOpen; });
        var patch = { selectedAnchor: { card: key, anchor: sideName } };
        if (anyOpen) patch.colors = state.colors.map(function (c) { return c.pickerOpen ? Object.assign({}, c, { pickerOpen: false }) : c; });
        var now = Date.now();
        var clickKey = key + '.' + sideName;
        var last = lastAnchorClickAt[clickKey];
        lastAnchorClickAt[clickKey] = now;
        if (last && (now - last) < 400) {
          lastAnchorClickAt[clickKey] = 0;
          var nextType = latestComp[sideName].handleType === 'auto' ? 'manual' : 'auto';
          var compChanges = {};
          compChanges[sideName] = Object.assign({}, latestComp[sideName], { handleType: nextType });
          if (nextType === 'manual') Object.assign(compChanges, snapToAuto(sideName, latestComp));
          patch.shiftConfigs = withUpdatedComp(key, Object.assign({}, latestComp, compChanges));
        }
        setState(patch);
      },
      onPointerMove: function (e) {
        if (e.buttons === 0) return;
        e.preventDefault();
        var pt = svgLocalPoint(e);
        setRange(sideName, clamp(Math.round(yToVal(pt.y, domainMin, domainMax, plotH)), domainMin, domainMax));
      },
      onPointerUp: function (e) { try { e.target.releasePointerCapture(e.pointerId); } catch (err) {} },
    };
  }

  var HANDLE_SIDE = { leftHandle: 'left', rightHandle: 'right' };
  function makeHandleDrag(handleName) {
    var side = HANDLE_SIDE[handleName];
    return {
      onPointerDown: function (e) { e.preventDefault(); try { e.target.setPointerCapture(e.pointerId); } catch (err) {} },
      onPointerMove: function (e) {
        if (e.buttons === 0) return;
        e.preventDefault();
        var pt = svgLocalPoint(e);
        var patch = {};
        patch[handleName] = { tFrac: pxToHandleFrac(pt.x, side, plotW), y: pxToHandleVal(pt.y, domainMin, domainMax, plotH) };
        updateComp(key, patch);
      },
      onPointerUp: function (e) { try { e.target.releasePointerCapture(e.pointerId); } catch (err) {} },
    };
  }

  function makeCenterHandleDrag(handleName, displaySide) {
    var otherName = handleName === 'centerHandleLeft' ? 'centerHandleRight' : 'centerHandleLeft';
    var otherSide = displaySide === 'left' ? 'right' : 'left';
    return {
      onPointerDown: function (e) { e.preventDefault(); try { e.target.setPointerCapture(e.pointerId); } catch (err) {} },
      onPointerMove: function (e) {
        if (e.buttons === 0) return;
        e.preventDefault();
        var pt = svgLocalPoint(e);
        var tFrac = pxToHandleFrac(pt.x, displaySide, plotW);
        var y = pxToHandleVal(pt.y, domainMin, domainMax, plotH);
        var latestComp = currentCompFor(key);
        var X = state.X;
        var signedDist = displaySide === 'right' ? tFrac * X : -tFrac * X;
        var slope = signedDist !== 0 ? (y - latestComp.center.range) / signedDist : 0;
        var otherTFrac = latestComp[otherName].tFrac;
        var otherSignedDist = otherSide === 'right' ? otherTFrac * X : -otherTFrac * X;
        var patch = {};
        patch[handleName] = { tFrac: tFrac, y: y };
        patch[otherName] = { tFrac: otherTFrac, y: clampHandleVal(latestComp.center.range + slope * otherSignedDist) };
        updateComp(key, patch);
      },
      onPointerUp: function (e) { try { e.target.releasePointerCapture(e.pointerId); } catch (err) {} },
    };
  }

  function wire(hitEl, drag) {
    hitEl.addEventListener('pointerdown', drag.onPointerDown);
    hitEl.addEventListener('pointermove', drag.onPointerMove);
    hitEl.addEventListener('pointerup', drag.onPointerUp);
    hitEl.addEventListener('click', stopClick);
    // touch-action:none (see .curve-handle-hit) and preventDefault() on the
    // pointer handlers above aren't reliably honored by every mobile
    // browser's scroll-gesture recognizer once a touch is already moving -
    // a non-passive touchmove listener is the one mechanism that is.
    hitEl.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  }
  wire(leftAnchor.hit, makeAnchorDrag('left'));
  wire(centerAnchor.hit, makeAnchorDrag('center'));
  wire(rightAnchor.hit, makeAnchorDrag('right'));
  wire(leftHandle.hit, makeHandleDrag('leftHandle'));
  wire(centerLeftHandle.hit, makeCenterHandleDrag('centerHandleLeft', 'left'));
  wire(centerRightHandle.hit, makeCenterHandleDrag('centerHandleRight', 'right'));
  wire(rightHandle.hit, makeHandleDrag('rightHandle'));

  function wireRange(input, sideName) {
    input.addEventListener('change', function (e) {
      var v = parseInt(e.target.value, 10);
      if (isNaN(v)) return;
      setRange(sideName, clamp(v, domainMin, domainMax));
    });
  }
  wireRange(leftRangeInput, 'left');
  wireRange(centerRangeInput, 'center');
  wireRange(rightRangeInput, 'right');

  var AUTO_FILL = 'oklch(92% 0.01 290)', MANUAL_FILL = 'transparent';

  function placeHandle(group, x, y, endX, endY, show) {
    group.line.style.display = show ? '' : 'none';
    group.hit.style.display = show ? '' : 'none';
    group.dot.style.display = show ? '' : 'none';
    if (!show) return;
    group.line.setAttribute('x1', x); group.line.setAttribute('y1', y);
    group.line.setAttribute('x2', endX); group.line.setAttribute('y2', endY);
    group.hit.setAttribute('cx', x); group.hit.setAttribute('cy', y);
    group.dot.setAttribute('cx', x); group.dot.setAttribute('cy', y);
  }

  function update() {
    var comp = currentCompFor(key);
    var X = state.X;
    var curveData = computeCurveSvg(comp, X, absoluteTarget, plotW, plotH);
    polyline.setAttribute('points', curveData.points);

    leftAnchor.hit.setAttribute('cx', curveData.leftAnchor.x); leftAnchor.hit.setAttribute('cy', curveData.leftAnchor.y);
    leftAnchor.dot.setAttribute('cx', curveData.leftAnchor.x); leftAnchor.dot.setAttribute('cy', curveData.leftAnchor.y);
    leftAnchor.dot.setAttribute('fill', comp.left.handleType === 'auto' ? AUTO_FILL : MANUAL_FILL);

    centerAnchor.hit.setAttribute('cx', curveData.centerX); centerAnchor.hit.setAttribute('cy', curveData.centerY);
    centerAnchor.dot.setAttribute('cx', curveData.centerX); centerAnchor.dot.setAttribute('cy', curveData.centerY);
    centerAnchor.dot.setAttribute('fill', comp.center.handleType === 'auto' ? AUTO_FILL : MANUAL_FILL);

    rightAnchor.hit.setAttribute('cx', curveData.rightAnchor.x); rightAnchor.hit.setAttribute('cy', curveData.rightAnchor.y);
    rightAnchor.dot.setAttribute('cx', curveData.rightAnchor.x); rightAnchor.dot.setAttribute('cy', curveData.rightAnchor.y);
    rightAnchor.dot.setAttribute('fill', comp.right.handleType === 'auto' ? AUTO_FILL : MANUAL_FILL);

    var selection = state.selectedAnchor;
    function isSelected(anchor) { return !!selection && selection.card === key && selection.anchor === anchor; }
    placeHandle(leftHandle, curveData.leftHandle.x, curveData.leftHandle.y, curveData.leftAnchor.x, curveData.leftAnchor.y, isSelected('left') && comp.left.handleType === 'manual');
    var showCenter = isSelected('center') && comp.center.handleType === 'manual';
    placeHandle(centerLeftHandle, curveData.centerHandleLeft.x, curveData.centerHandleLeft.y, curveData.centerX, curveData.centerY, showCenter);
    placeHandle(centerRightHandle, curveData.centerHandleRight.x, curveData.centerHandleRight.y, curveData.centerX, curveData.centerY, showCenter);
    placeHandle(rightHandle, curveData.rightHandle.x, curveData.rightHandle.y, curveData.rightAnchor.x, curveData.rightAnchor.y, isSelected('right') && comp.right.handleType === 'manual');

    leftRangeInput.value = String(comp.left.range);
    centerRangeInput.value = String(comp.center.range);
    rightRangeInput.value = String(comp.right.range);
  }

  return { root: root, update: update };
}

// ---------------------------------------------------------------------------
// Shift Settings panel - just the 3 curve cards side by side. The
// dice/info/add/delete config controls live in the vertical-tabs sidebar
// (buildBottomPanel) instead of a repeated in-panel header, since the tab
// itself already says "SHIFT SETTINGS".
// ---------------------------------------------------------------------------
function buildShiftPanel() {
  cardRefs.hue = buildCard('hue', 'HUE', 'background: linear-gradient(90deg, red, yellow, lime, cyan, blue, magenta, red);', 'oklch(80% 0.15 195)', false);
  cardRefs.sat = buildCard('sat', 'CHROMA', 'background: linear-gradient(90deg, oklch(55% 0 0), oklch(75% 0.18 345));', 'oklch(75% 0.18 345)', true);
  cardRefs.val = buildCard('val', 'LIGHTNESS', 'background: linear-gradient(90deg, #000000, #ffffff);', 'oklch(85% 0.17 95)', true);
  return h('div', { className: 'curve-card-row' }, [cardRefs.hue.root, cardRefs.sat.root, cardRefs.val.root]);
}

// ---------------------------------------------------------------------------
// Mobile-only: pins one base color's ramp above (outside) the bottom-panel
// box on the Shift Settings, Color Wheel and Settings tabs, sticky-positioned
// so it stays visible while scrolling through each tab's own content. A
// left/right swipe (Pointer Events, so touch/mouse/pen all just work) steps
// state.previewIndex through state.colors - no separate prev/next buttons
// needed. The dice button mirrors refs.activeDiceBtn's plain bevel look and
// 28px size (see buildBottomPanel) - same control, so same appearance.
// ---------------------------------------------------------------------------
function buildMobileShiftPreview() {
  refs.shiftPreviewRow = h('div', { className: 'shift-preview-row', style: 'display:flex;gap:4px;flex-wrap:wrap;align-items:center;justify-content:center;' });
  refs.previewDiceSvg = svgEl('svg', { width: 18, height: 18, viewBox: '0 0 20 20' });
  refs.previewDiceBtn = h('div', { className: 'bevel-raised', style: 'width:28px;height:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;' }, refs.previewDiceSvg);
  refs.previewDiceBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var colors = state.colors;
    if (colors.length === 0) return;
    var idx = clamp(state.previewIndex || 0, 0, colors.length - 1);
    onCycleConfig(colors[idx].id);
  });
  refs.shiftPreviewWrap = h('div', { className: 'mobile-shift-preview' }, [refs.previewDiceBtn, refs.shiftPreviewRow]);

  var previewSwipeStartX = null;
  refs.shiftPreviewWrap.addEventListener('pointerdown', function (e) { previewSwipeStartX = e.clientX; });
  refs.shiftPreviewWrap.addEventListener('pointerup', function (e) {
    if (previewSwipeStartX == null) return;
    var dx = e.clientX - previewSwipeStartX;
    previewSwipeStartX = null;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) onPreviewNext(); else onPreviewPrev();
  });

  return refs.shiftPreviewWrap;
}

function onPreviewPrev() {
  var len = state.colors.length;
  if (len === 0) return;
  setState({ previewIndex: ((state.previewIndex || 0) - 1 + len) % len });
}
function onPreviewNext() {
  var len = state.colors.length;
  if (len === 0) return;
  setState({ previewIndex: ((state.previewIndex || 0) + 1) % len });
}

function updateShiftPreview() {
  var colors = state.colors;
  var hasColors = colors.length > 0;
  refs.shiftPreviewWrap.style.display = hasColors ? '' : 'none';
  if (!hasColors) return;
  var idx = clamp(state.previewIndex || 0, 0, colors.length - 1);
  var c = colors[idx];
  refs.shiftPreviewRow.innerHTML = '';
  var cfg = state.shiftConfigs[c.configIndex || 0];
  var ramp = genRamp(c.hex, state.X, cfg.hue, cfg.sat, cfg.val);
  ramp.forEach(function (hexColor, i) {
    var sw = document.createElement('div');
    sw.className = i === state.X ? 'ramp-swatch ramp-swatch-center' : 'ramp-swatch';
    sw.style.background = hexColor;
    refs.shiftPreviewRow.appendChild(sw);
  });
  refs.previewDiceSvg.innerHTML = '';
  dicePips(c.configIndex || 0).forEach(function (pip) {
    refs.previewDiceSvg.appendChild(svgEl('circle', { cx: pip.cx, cy: pip.cy, r: 2.4, fill: pip.color }));
  });
  refs.previewDiceBtn.title = 'Configuration ' + ((c.configIndex || 0) + 1) + ' — click to switch which configuration this color follows';
}

function onCycleActiveConfig() {
  var configs = state.shiftConfigs;
  var current = state.activeConfig || 0;
  setState({ activeConfig: (current + 1) % configs.length });
}
function onAddConfig() {
  var configs = state.shiftConfigs;
  if (configs.length >= SHIFT_CONFIG_COUNT_MAX) return;
  setState({ shiftConfigs: configs.concat([makeDefaultShiftConfig()]), activeConfig: configs.length });
}
function onDeleteActiveConfig() {
  var configs = state.shiftConfigs;
  if (configs.length <= 1) return;
  var deletedIndex = state.activeConfig || 0;
  var newConfigs = configs.slice(0, deletedIndex).concat(configs.slice(deletedIndex + 1));
  var newColors = state.colors.map(function (c) {
    var ci = c.configIndex || 0;
    if (ci === deletedIndex) return Object.assign({}, c, { configIndex: 0 });
    if (ci > deletedIndex) return Object.assign({}, c, { configIndex: ci - 1 });
    return c;
  });
  setState({ shiftConfigs: newConfigs, colors: newColors, activeConfig: Math.min(deletedIndex, newConfigs.length - 1) });
}

function updateShiftPanel() {
  var activeConfigIndex = state.activeConfig || 0;
  refs.activeDiceSvg.innerHTML = '';
  dicePips(activeConfigIndex).forEach(function (pip) {
    refs.activeDiceSvg.appendChild(svgEl('circle', { cx: pip.cx, cy: pip.cy, r: 2.4, fill: pip.color }));
  });
  refs.activeDiceBtn.title = 'Configuration ' + (activeConfigIndex + 1) + ' — click to switch which configuration these cards edit';
  var canAdd = state.shiftConfigs.length < SHIFT_CONFIG_COUNT_MAX;
  refs.addConfigBtn.style.cssText = canAdd ? '' : STYLE_DISABLED;
  refs.addConfigBtn.title = 'Add a new configuration';
  var canDelete = state.shiftConfigs.length > 1;
  refs.deleteConfigBtn.style.cssText = canDelete ? '' : STYLE_DISABLED;
  refs.deleteConfigBtn.title = 'Delete Configuration ' + (activeConfigIndex + 1);
  refs.infoPopover.style.display = state.infoOpen ? 'flex' : '';
  cardRefs.hue.update();
  cardRefs.sat.update();
  cardRefs.val.update();
  updateShiftPreview();
}

// ---------------------------------------------------------------------------
// Color wheel panel. No repeated "COLOR WHEEL" title - the tab already
// says that; just a short caption and the disc itself.
// ---------------------------------------------------------------------------
function buildWheelPanel() {
  refs.wheelDisc = h('div', { className: 'wheel-disc' });
  var discWrap = h('div', { className: 'wheel-disc-wrap' }, refs.wheelDisc);
  return h('div', { className: 'wheel-panel-root' }, [discWrap]);
}

function ensureWheelMarker(id) {
  if (wheelRefs.has(id)) return wheelRefs.get(id);
  var dot = h('div', { style: 'width:' + (WHEEL_MARKER_R * 2) + 'px;height:' + (WHEEL_MARKER_R * 2) + 'px;border-radius:50%;border:2px solid oklch(11% 0.025 290);pointer-events:none;' });
  var hitPct = (WHEEL_HIT_R * 2 / WHEEL_SIZE * 100).toFixed(3) + '%';
  var hit = h('div', { className: 'wheel-dot-hit', style: 'position:absolute;width:' + hitPct + ';height:' + hitPct + ';' }, dot);
  hit.addEventListener('pointerdown', function (e) {
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    var idx = state.colors.findIndex(function (c) { return c.id === id; });
    if (idx !== -1) setState({ previewIndex: idx });
  });
  hit.addEventListener('pointermove', function (e) {
    if (e.buttons === 0) return;
    var pt = wheelLocalPoint(e, WHEEL_SIZE);
    var dx = pt.x - wheelCx, dy = pt.y - wheelCy;
    var dist = clamp(Math.sqrt(dx * dx + dy * dy), 0, wheelEffR);
    var newS = clamp(Math.round((dist / wheelEffR) * 100), 0, 100);
    var newH = Math.round((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360);
    commitWheelHsv(id, newH, newS);
  });
  hit.addEventListener('pointerup', function (e) { try { e.target.releasePointerCapture(e.pointerId); } catch (err) {} });
  var refsObj = { hit: hit, dot: dot };
  wheelRefs.set(id, refsObj);
  return refsObj;
}
function commitWheelHsv(id, hueDeg, satPct) {
  setState({ colors: state.colors.map(function (x) {
    if (x.id !== id) return x;
    var vPct = x.hsvV != null ? x.hsvV : 0;
    var rgbOut = hsvToRgb(hueDeg, satPct, vPct);
    var newHex = toHex(rgbOut[0], rgbOut[1], rgbOut[2]);
    return Object.assign({}, x, { hex: newHex, hexDraft: newHex }, deriveColorFields(newHex), { hsvH: hueDeg, hsvS: satPct, hsvV: vPct });
  }) });
}
function updateWheel() {
  var liveIds = new Set(state.colors.map(function (c) { return c.id; }));
  wheelRefs.forEach(function (r, id) {
    if (!liveIds.has(id)) { r.hit.remove(); wheelRefs.delete(id); }
  });
  state.colors.forEach(function (c) {
    var r = ensureWheelMarker(c.id);
    if (!r.hit.parentNode) refs.wheelDisc.appendChild(r.hit);
    var hueDeg = c.hsvH || 0, satPct = c.hsvS || 0;
    var theta = hueDeg * Math.PI / 180;
    var rr = (satPct / 100) * wheelEffR;
    var mx = wheelCx + rr * Math.sin(theta);
    var my = wheelCy - rr * Math.cos(theta);
    r.hit.style.left = ((mx - WHEEL_HIT_R) / WHEEL_SIZE * 100).toFixed(3) + '%';
    r.hit.style.top = ((my - WHEEL_HIT_R) / WHEEL_SIZE * 100).toFixed(3) + '%';
    r.dot.style.background = c.hex;
  });
}

// ---------------------------------------------------------------------------
// Base color list item (ramp + swatch/popover/label/action buttons).
// ---------------------------------------------------------------------------
function channelRow(labelText, min, max) {
  var numberInput = h('input', { type: 'number', className: 'value-input pixel-text' });
  var rangeInput = h('input', { type: 'range', className: 'pixel-slider', min: String(min), max: String(max), step: '1' });
  var row = h('div', { className: 'channel-row' }, [
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;' }, [
      h('div', { className: 'pixel-text', style: 'font-size:11px;color:oklch(60% 0.02 290);letter-spacing:1px;' }, labelText),
      numberInput,
    ]),
    rangeInput,
  ]);
  return { row: row, numberInput: numberInput, rangeInput: rangeInput };
}

function ensureColorRefs(id) {
  if (colorRefs.has(id)) return colorRefs.get(id);

  var rampRow = h('div', {});

  var swatchBtn = h('div', { className: 'bevel-raised color-input' });
  swatchBtn.addEventListener('click', function (e) { onTogglePicker(id, e); });

  var eyedropperInput = h('input', { type: 'color', className: 'eyedropper-input' });
  eyedropperInput.addEventListener('change', function (e) { commitHexAndResync(id, e.target.value); });
  var eyedropperIcon = h('div', { className: 'bevel-raised remove-btn', style: 'pointer-events:none;color:oklch(80% 0.15 195);' },
    svgFromMarkup('<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><path d="M14 4l2 2-9 9-3 1 1-3z"></path><path d="M12 6l2 2"></path></svg>'));
  var eyedropperWrap = h('div', { className: 'eyedropper-wrap' }, [eyedropperIcon, eyedropperInput]);
  var closeBtn = h('div', { className: 'bevel-raised remove-btn' },
    svgFromMarkup('<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M4 4l12 12M16 4L4 16"></path></svg>'));
  closeBtn.addEventListener('click', function () { onClosePicker(id); });
  var popoverTopRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' }, [eyedropperWrap, closeBtn]);

  var hsvTab = h('div', { className: 'tab-btn mode-tab' }, 'HSV');
  var oklchTab = h('div', { className: 'tab-btn mode-tab' }, 'OKLCH');
  var hexTab = h('div', { className: 'tab-btn mode-tab' }, 'HEX');
  hsvTab.addEventListener('click', function () { setMode(id, 'hsv'); });
  oklchTab.addEventListener('click', function () { setMode(id, 'oklch'); });
  hexTab.addEventListener('click', function () { setMode(id, 'hex'); });
  var tabsRow = h('div', { style: 'display:flex;gap:4px;' }, [hsvTab, oklchTab, hexTab]);

  var hRow = channelRow('H', 0, 359), sRow = channelRow('S', 0, 100), vRow = channelRow('V', 0, 100);
  var hsvPanel = h('div', { style: 'display:flex;flex-direction:column;gap:10px;' }, [hRow.row, sRow.row, vRow.row]);

  var lRow = channelRow('L', 0, 100), cRow = channelRow('C', 0, 100), ohRow = channelRow('H', 0, 360);
  var oklchPanel = h('div', { style: 'display:flex;flex-direction:column;gap:10px;' }, [lRow.row, cRow.row, ohRow.row]);

  var hexInput = h('input', { type: 'text', className: 'value-input pixel-text', style: 'width:100%;height:32px;font-size:15px;text-align:left;' });
  var hexPanel = h('div', { className: 'channel-row' }, [
    h('div', { className: 'pixel-text', style: 'font-size:11px;color:oklch(60% 0.02 290);letter-spacing:1px;text-transform:uppercase;' }, 'Hex Code'),
    hexInput,
  ]);

  function wireChannel(row, channelIdx, maxVal, commitFn) {
    function commit(e) {
      var v = parseFloat(e.target.value);
      if (isNaN(v)) return;
      commitFn(id, channelIdx, clamp(v, 0, maxVal));
    }
    row.numberInput.addEventListener('change', commit);
    row.rangeInput.addEventListener('input', commit);
  }
  wireChannel(hRow, 0, 359, commitHsvChannel); wireChannel(sRow, 1, 100, commitHsvChannel); wireChannel(vRow, 2, 100, commitHsvChannel);
  wireChannel(lRow, 0, 100, commitOklchChannel); wireChannel(cRow, 1, 100, commitOklchChannel); wireChannel(ohRow, 2, 360, commitOklchChannel);

  hexInput.addEventListener('input', function (e) { onHexDraftChange(id, e.target.value); });

  var popover = h('div', { className: 'popover' }, [popoverTopRow, tabsRow, oklchPanel, hsvPanel, hexPanel]);
  popover.addEventListener('click', function (e) { e.stopPropagation(); });

  var swatchWrap = h('div', { style: 'position:relative;' }, [swatchBtn, popover]);

  var displayLabel = h('div', { className: 'pixel-text', style: 'font-size:14px;color:oklch(92% 0.01 290);letter-spacing:0.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
  var selectedLabel = h('div', { className: 'pixel-text', style: 'font-size:12px;color:oklch(80% 0.15 195);letter-spacing:0.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
  var labelBlock = h('div', { style: 'display:flex;flex-direction:column;justify-content:center;gap:2px;flex:1;min-width:0;padding:4px 8px;cursor:pointer;' }, [displayLabel, selectedLabel]);
  labelBlock.addEventListener('click', onCycleColorDisplay);

  var leftGroup = h('div', { style: 'display:flex;align-items:center;gap:12px;flex:1;min-width:0;' }, [swatchWrap, labelBlock]);

  var diceSvg = svgEl('svg', { width: 18, height: 18, viewBox: '0 0 20 20' });
  var diceBtn = h('div', { className: 'bevel-raised action-btn' }, diceSvg);
  diceBtn.addEventListener('click', function () { onCycleConfig(id); });

  var copyIcon = h('div', { className: 'bevel-raised action-btn' },
    svgFromMarkup('<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><rect x="7" y="7" width="10" height="10"></rect><path d="M4 13V4a1 1 0 0 1 1-1h9"></path></svg>'));
  copyIcon.addEventListener('click', function () { onCopyHex(id); });

  var removeBtn = h('div', { className: 'bevel-raised action-btn' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M4 4l12 12M16 4L4 16"></path></svg>'));
  removeBtn.addEventListener('click', function () { onRemoveColor(id); });

  // On mobile the dice/copy/remove trio collapses behind a per-item kebab
  // button (see .color-kebab-btn / .color-actions-menu); on desktop that
  // CSS just renders actionsMenu as the plain inline row it always was.
  var actionsMenu = h('div', { className: 'color-actions-menu' }, [diceBtn, copyIcon, removeBtn]);
  actionsMenu.addEventListener('click', function (e) { e.stopPropagation(); });
  var kebabBtn = h('div', { className: 'bevel-raised action-btn color-kebab-btn' },
    svgFromMarkup('<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><circle cx="10" cy="4" r="1.8"></circle><circle cx="10" cy="10" r="1.8"></circle><circle cx="10" cy="16" r="1.8"></circle></svg>'));
  kebabBtn.addEventListener('click', function (e) { onToggleActionsMenu(id, e); });
  var rightGroup = h('div', { className: 'color-actions-wrap' }, [kebabBtn, actionsMenu]);
  var detailsRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;' }, [leftGroup, rightGroup]);

  var itemRoot = h('div', {}, [rampRow, detailsRow]);

  var refsObj = {
    root: itemRoot, rampRow: rampRow, detailsRow: detailsRow,
    swatchBtn: swatchBtn, popover: popover,
    hsvTab: hsvTab, oklchTab: oklchTab, hexTab: hexTab,
    hsvPanel: hsvPanel, oklchPanel: oklchPanel, hexPanel: hexPanel,
    hRow: hRow, sRow: sRow, vRow: vRow, lRow: lRow, cRow: cRow, ohRow: ohRow,
    hexInput: hexInput, eyedropperInput: eyedropperInput,
    displayLabel: displayLabel, selectedLabel: selectedLabel,
    diceSvg: diceSvg, diceBtn: diceBtn, copyIcon: copyIcon,
    actionsMenu: actionsMenu,
  };
  colorRefs.set(id, refsObj);
  return refsObj;
}

function commitHexAndResync(id, newHex) {
  var fields = deriveColorFields(newHex);
  setState({ colors: state.colors.map(function (x) {
    return x.id === id ? Object.assign({}, x, { hex: newHex, hexDraft: newHex }, fields) : x;
  }) });
}
function commitHsv(id, hueDeg, satPct, valPct) {
  var rgbOut = hsvToRgb(hueDeg, satPct, valPct);
  var newHex = toHex(rgbOut[0], rgbOut[1], rgbOut[2]);
  var fields = deriveColorFields(newHex);
  setState({ colors: state.colors.map(function (x) {
    return x.id === id ? Object.assign({}, x, { hex: newHex, hexDraft: newHex }, fields, { hsvH: hueDeg, hsvS: satPct, hsvV: valPct }) : x;
  }) });
}
function commitHsvChannel(id, channelIdx, v) {
  var c = getColor(id);
  var arr = [c.hsvH || 0, c.hsvS || 0, c.hsvV || 0];
  arr[channelIdx] = v;
  commitHsv(id, arr[0], arr[1], arr[2]);
}
function commitOklch(id, lPct, cPct, hueDeg) {
  var L = clamp(lPct, 0, 100) / 100;
  var H = ((clamp(hueDeg, 0, 360) % 360) + 360) % 360;
  var maxC = maxChromaAt(L, H);
  var newHex = oklchToHex(L, (clamp(cPct, 0, 100) / 100) * maxC, H);
  var fields = deriveColorFields(newHex);
  setState({ colors: state.colors.map(function (x) {
    return x.id === id ? Object.assign({}, x, { hex: newHex, hexDraft: newHex }, fields, { oklchL: lPct, oklchC: cPct, oklchH: hueDeg }) : x;
  }) });
}
function commitOklchChannel(id, channelIdx, v) {
  var c = getColor(id);
  var arr = [c.oklchL || 0, c.oklchC || 0, c.oklchH || 0];
  arr[channelIdx] = v;
  commitOklch(id, arr[0], arr[1], arr[2]);
}
function setMode(id, mode) {
  setState({ colors: state.colors.map(function (x) { return x.id === id ? Object.assign({}, x, { pickerMode: mode }) : x; }) });
}
function onHexDraftChange(id, v) {
  var trimmed = v.trim();
  var isValid = /^#?[0-9a-fA-F]{6}$/.test(trimmed);
  setState({ colors: state.colors.map(function (x) {
    if (x.id !== id) return x;
    var next = Object.assign({}, x, { hexDraft: v });
    if (isValid) {
      var newHex = (trimmed[0] === '#' ? trimmed : '#' + trimmed).toLowerCase();
      next.hex = newHex;
      Object.assign(next, deriveColorFields(newHex));
    }
    return next;
  }) });
}
function onTogglePicker(id, e) {
  e.stopPropagation();
  setState({
    selectedAnchor: null,
    colors: state.colors.map(function (x) {
      if (x.id === id) return Object.assign({}, x, { pickerOpen: !x.pickerOpen });
      return x.pickerOpen ? Object.assign({}, x, { pickerOpen: false }) : x;
    }),
  });
}
function onClosePicker(id) {
  setState({ colors: state.colors.map(function (x) { return x.id === id ? Object.assign({}, x, { pickerOpen: false }) : x; }) });
}
function onToggleActionsMenu(id, e) {
  e.stopPropagation();
  setState({
    colors: state.colors.map(function (x) {
      if (x.id === id) return Object.assign({}, x, { actionsOpen: !x.actionsOpen });
      return x.actionsOpen ? Object.assign({}, x, { actionsOpen: false }) : x;
    }),
  });
}
function onCopyHex(id) {
  var c = getColor(id);
  try { navigator.clipboard.writeText(c.hex); } catch (e) {}
  clearTimeout(colorCopyTimer);
  setState({ copiedColorId: id });
  colorCopyTimer = setTimeout(function () { setState({ copiedColorId: null }); }, 350);
}
function onRemoveColor(id) {
  setState({ colors: state.colors.filter(function (x) { return x.id !== id; }) });
}
function onCycleConfig(id) {
  setState({ colors: state.colors.map(function (x) {
    if (x.id !== id) return x;
    var len = state.shiftConfigs.length;
    return Object.assign({}, x, { configIndex: ((x.configIndex || 0) + 1) % len });
  }) });
}
function onCycleColorDisplay(e) {
  e.stopPropagation();
  var order = ['hex', 'hsv', 'oklch'];
  var idx = order.indexOf(state.colorDisplayMode);
  setState({ colorDisplayMode: order[(idx + 1) % order.length] });
}

function updateColorItem(id) {
  var r = ensureColorRefs(id);
  var c = getColor(id);
  var X = state.X;
  var isCompact = !!state.compactRamps;
  var colorConfigIndex = c.configIndex || 0;
  var colorConfig = state.shiftConfigs[colorConfigIndex];
  var ramp = genRamp(c.hex, X, colorConfig.hue, colorConfig.sat, colorConfig.val);

  var hasSelection = state.selectedStep !== null && state.selectedStep !== undefined;
  var selStep = hasSelection ? clamp(state.selectedStep, -X, X) : 0;
  var selIndex = selStep + X;

  r.root.style.cssText = isCompact
    ? 'display:flex;flex-direction:column;gap:4px;'
    : 'display:flex;flex-direction:column;gap:8px;padding-bottom:16px;border-bottom:1px solid oklch(30% 0.04 290);';
  r.rampRow.style.cssText = 'display:flex;align-items:center;gap:' + (isCompact ? '0' : '7px') + ';';

  r.rampRow.innerHTML = '';
  ramp.forEach(function (hexColor, i) {
    var sw = document.createElement('div');
    sw.className = (i === X && !isCompact) ? 'ramp-swatch ramp-swatch-center' : 'ramp-swatch';
    var style = 'background:' + hexColor + ';';
    if (!isCompact && hasSelection && i === selIndex) style += 'outline:2px solid oklch(80% 0.15 195); outline-offset:2px;';
    sw.style.cssText = style;
    sw.addEventListener('click', function (e) {
      e.stopPropagation();
      setState({ selectedStep: i - X });
    });
    r.rampRow.appendChild(sw);
  });

  r.detailsRow.style.display = isCompact ? 'none' : 'flex';
  if (isCompact) return;

  r.displayLabel.textContent = formatColorDisplay(c.hex, state.colorDisplayMode);
  r.selectedLabel.textContent = hasSelection ? formatColorDisplay(ramp[selIndex], state.colorDisplayMode) : ' ';
  r.selectedLabel.style.visibility = hasSelection ? 'visible' : 'hidden';

  r.swatchBtn.style.background = c.hex;
  r.popover.style.display = c.pickerOpen ? 'flex' : 'none';
  r.actionsMenu.style.display = c.actionsOpen ? 'flex' : '';
  if (document.activeElement !== r.eyedropperInput) r.eyedropperInput.value = c.hex;

  var mode = c.pickerMode || 'hsv';
  r.hsvTab.className = 'tab-btn mode-tab ' + (mode === 'hsv' ? 'tab-active' : 'tab-inactive');
  r.oklchTab.className = 'tab-btn mode-tab ' + (mode === 'oklch' ? 'tab-active' : 'tab-inactive');
  r.hexTab.className = 'tab-btn mode-tab ' + (mode === 'hex' ? 'tab-active' : 'tab-inactive');
  r.hsvPanel.style.display = mode === 'hsv' ? 'flex' : 'none';
  r.oklchPanel.style.display = mode === 'oklch' ? 'flex' : 'none';
  r.hexPanel.style.display = mode === 'hex' ? 'flex' : 'none';

  var hInt = c.hsvH != null ? c.hsvH : 0, sInt = c.hsvS != null ? c.hsvS : 0, vInt = c.hsvV != null ? c.hsvV : 0;
  var lInt = c.oklchL != null ? c.oklchL : 0, cInt = c.oklchC != null ? c.oklchC : 0, ohInt = c.oklchH != null ? c.oklchH : 0;
  function syncChannel(row, val) {
    if (document.activeElement !== row.numberInput) row.numberInput.value = String(val);
    if (document.activeElement !== row.rangeInput) row.rangeInput.value = String(val);
  }
  syncChannel(r.hRow, hInt); syncChannel(r.sRow, sInt); syncChannel(r.vRow, vInt);
  syncChannel(r.lRow, lInt); syncChannel(r.cRow, cInt); syncChannel(r.ohRow, ohInt);

  var hexDraft = c.hexDraft != null ? c.hexDraft : c.hex;
  if (document.activeElement !== r.hexInput) r.hexInput.value = hexDraft;

  r.diceSvg.innerHTML = '';
  dicePips(colorConfigIndex).forEach(function (pip) {
    r.diceSvg.appendChild(svgEl('circle', { cx: pip.cx, cy: pip.cy, r: 2.4, fill: pip.color }));
  });
  r.diceBtn.title = 'Configuration ' + (colorConfigIndex + 1) + ' — click to switch which configuration this color follows';

  r.copyIcon.style.cssText = c.id === state.copiedColorId
    ? 'background: oklch(80% 0.15 195); color: oklch(14% 0.03 290);'
    : 'background: oklch(24% 0.035 290); color: oklch(80% 0.15 195);';
}

function updateColorList() {
  var liveIds = state.colors.map(function (c) { return c.id; });
  var liveSet = new Set(liveIds);
  colorRefs.forEach(function (r, id) {
    if (!liveSet.has(id)) { r.root.remove(); colorRefs.delete(id); }
  });
  liveIds.forEach(function (id, idx) {
    var r = ensureColorRefs(id);
    var expectedNode = refs.colorList.children[idx];
    if (expectedNode !== r.root) refs.colorList.insertBefore(r.root, expectedNode || null);
    updateColorItem(id);
  });
  refs.colorList.style.cssText = state.compactRamps
    ? 'display:flex;flex-wrap:wrap;gap:0;'
    : 'display:grid;grid-template-columns:repeat(auto-fill, minmax(min(380px, 100%), 1fr));gap:20px;';
  refs.noColorsMsg.style.display = state.colors.length === 0 ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Base colors panel header controls + right-column tabs + header share box.
// ---------------------------------------------------------------------------
function updateBaseColorsHeader() {
  var colorDecStyle = state.colors.length === 0 ? STYLE_DISABLED : STYLE_ACTIVE;
  colorCountSteppers.forEach(function (s) {
    s.val.textContent = String(state.colors.length);
    s.dec.style.cssText = colorDecStyle;
  });
  var xDecStyle = state.X <= 1 ? STYLE_DISABLED : STYLE_ACTIVE;
  var xIncStyle = state.X >= 4 ? STYLE_DISABLED : STYLE_ACTIVE;
  rampSizeSteppers.forEach(function (s) {
    s.val.textContent = String(state.X);
    s.dec.style.cssText = xDecStyle;
    s.inc.style.cssText = xIncStyle;
  });
  var totalText = '→ ' + (2 * state.X + 1) + ' COLORS PER RAMP';
  totalColorsTexts.forEach(function (el) { el.textContent = totalText; });
  var isCompact = !!state.compactRamps;
  compactToggleInstances.forEach(function (inst) {
    inst.inIcon.style.display = isCompact ? 'none' : '';
    inst.outIcon.style.display = isCompact ? '' : 'none';
    inst.btn.title = isCompact ? 'Show base color details' : 'Compact view (ramps only)';
  });
}

function updateMobileNav() {
  var active = state.mobileTab || 'ramps';
  Object.keys(refs.mobileNavBtns).forEach(function (key) {
    refs.mobileNavBtns[key].className = 'mobile-nav-btn' + (key === active ? ' mobile-nav-btn-active' : '');
  });
  refs.pfContent.setAttribute('data-mobile-tab', active);
}

function updateRightTabs() {
  var isShift = (state.rightTab || 'shift') !== 'wheel';
  refs.tabShiftBtn.className = 'tab-btn vtab-icon-btn ' + (isShift ? 'tab-active' : 'tab-inactive');
  refs.tabWheelBtn.className = 'tab-btn vtab-icon-btn ' + (!isShift ? 'tab-active' : 'tab-inactive');
  refs.shiftPanel.style.display = isShift ? 'flex' : 'none';
  refs.wheelPanel.style.display = !isShift ? 'flex' : 'none';
  refs.configControlsRow.style.display = isShift ? 'flex' : 'none';
}

function updateHeader() {
  var url = shareUrlFor(state);
  refs.shareText.textContent = state.copied ? 'COPIED TO CLIPBOARD!' : url;
  refs.shareText.title = url;
  refs.copyBtn.style.cssText = state.copied
    ? 'background: oklch(80% 0.15 195); color: oklch(14% 0.03 290);'
    : 'background: oklch(24% 0.035 290); color: oklch(80% 0.15 195);';
}
function onCopyShare() {
  try { navigator.clipboard.writeText(shareUrlFor(state)); } catch (e) {}
  clearTimeout(copyTimer);
  setState({ copied: true });
  copyTimer = setTimeout(function () { setState({ copied: false }); }, 350);
}

function onRootClick() {
  var patch = {};
  if (state.selectedAnchor !== null) patch.selectedAnchor = null;
  if (state.selectedStep !== null && state.selectedStep !== undefined) patch.selectedStep = null;
  if (state.infoOpen) patch.infoOpen = false;
  var anyOpen = state.colors.some(function (c) { return c.pickerOpen || c.actionsOpen; });
  if (anyOpen) patch.colors = state.colors.map(function (c) {
    return (c.pickerOpen || c.actionsOpen) ? Object.assign({}, c, { pickerOpen: false, actionsOpen: false }) : c;
  });
  if (Object.keys(patch).length) setState(patch);
}

// ---------------------------------------------------------------------------
// Shell assembly.
// ---------------------------------------------------------------------------
function buildStepper(minWidth) {
  var dec = h('div', { className: 'bevel-raised step-btn' }, svgFromMarkup('<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M13 4l-7 6 7 6"></path></svg>'));
  var val = h('div', { className: 'bevel-well step-val pixel-text', style: 'min-width:' + minWidth + 'px;' });
  var inc = h('div', { className: 'bevel-raised step-btn', style: STYLE_ACTIVE }, svgFromMarkup('<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M7 4l7 6-7 6"></path></svg>'));
  var root = h('div', { style: 'display:flex;align-items:center;gap:4px;' }, [dec, val, inc]);
  return { root: root, dec: dec, val: val, inc: inc };
}
// Each of these factories creates a fresh, independently-wired instance -
// the same stepper/toggle appears in up to three places (desktop header,
// mobile burger menu, mobile Settings tab), and since a DOM node can only
// live in one place, each surface gets its own instance; all instances are
// kept in module-level arrays so a single state change updates every copy.
function makeColorCountStepper() {
  var s = buildStepper(40);
  s.dec.addEventListener('click', function () {
    if (state.colors.length === 0) return;
    setState({ colors: state.colors.slice(0, -1) });
  });
  s.inc.addEventListener('click', function () {
    var hex = PRESET_HUES[state.nextId % PRESET_HUES.length];
    setState({ colors: state.colors.concat([makeColorEntry(state.nextId, hex)]), nextId: state.nextId + 1 });
  });
  colorCountSteppers.push(s);
  return s;
}
function makeRampSizeStepper() {
  var s = buildStepper(40);
  s.dec.addEventListener('click', function () { if (state.X > 1) setState({ X: state.X - 1 }); });
  s.inc.addEventListener('click', function () { if (state.X < 4) setState({ X: state.X + 1 }); });
  rampSizeSteppers.push(s);
  return s;
}
function makeTotalColorsText() {
  var el = h('div', { className: 'pixel-text', style: 'font-size:14px;color:oklch(80% 0.15 195);letter-spacing:1px;' });
  totalColorsTexts.push(el);
  return el;
}
function makeCompactToggleBtn() {
  var inIcon = svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><polyline points="8,4 8,8 4,8"></polyline><polyline points="12,16 12,12 16,12"></polyline></svg>');
  var outIcon = svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><polyline points="4,8 4,4 8,4"></polyline><polyline points="16,12 16,16 12,16"></polyline></svg>');
  var btn = h('div', { className: 'bevel-raised action-btn', style: 'color: oklch(80% 0.15 195);' }, [inIcon, outIcon]);
  btn.addEventListener('click', function () { setState({ compactRamps: !state.compactRamps }); });
  var instance = { btn: btn, inIcon: inIcon, outIcon: outIcon };
  compactToggleInstances.push(instance);
  return instance;
}
function makeSortBtn() {
  var btn = h('div', { className: 'bevel-raised action-btn', style: 'color: oklch(80% 0.15 195);', title: 'Sort base colors by hue' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><line x1="4" y1="5" x2="10" y2="5"></line><line x1="4" y1="10" x2="14" y2="10"></line><line x1="4" y1="15" x2="18" y2="15"></line></svg>'));
  btn.addEventListener('click', function () {
    setState({ colors: state.colors.slice().sort(function (a, b) { return (a.hsvH || 0) - (b.hsvH || 0); }) });
  });
  sortBtnInstances.push(btn);
  return btn;
}

function buildColorsPanel() {
  var col = h('div', { className: 'colors-panel' });
  var panel = h('div', { className: 'bevel-raised', style: 'flex:1;min-width:0;min-height:0;background:oklch(19% 0.035 290);padding:20px;display:flex;flex-direction:column;' });

  // ---- Desktop controls row (hidden on mobile - see .desktop-controls-row) ----
  var baseColorsLabel = h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'BASE COLORS');
  var colorCountStepper = makeColorCountStepper();
  var sep = h('div', { className: 'pixel-text', style: 'font-size:15px;color:oklch(40% 0.02 290);' }, '|');
  var rampSizeLabel = h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'RAMP SIZE');
  var rampSizeStepper = makeRampSizeStepper();
  var totalColorsText = makeTotalColorsText();
  var compactToggle = makeCompactToggleBtn();
  compactToggle.btn.style.marginLeft = 'auto';
  var sortBtn = makeSortBtn();

  var desktopControlsRow = h('div', { className: 'desktop-controls-row', style: 'align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px;flex-shrink:0;' },
    [baseColorsLabel, colorCountStepper.root, sep, rampSizeLabel, rampSizeStepper.root, totalColorsText, compactToggle.btn, sortBtn]);

  // ---- Mobile controls row: BASE COLORS label + compact/sort, directly
  // visible (color count and ramp size live only in the Settings tab). ----
  var mobileCompactToggle = makeCompactToggleBtn();
  var mobileSortBtn = makeSortBtn();
  var mobileControlsRow = h('div', { className: 'mobile-controls-row' }, [
    h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'BASE COLORS'),
    h('div', { style: 'display:flex;gap:8px;margin-left:auto;' }, [mobileCompactToggle.btn, mobileSortBtn]),
  ]);

  var divider = h('div', { style: 'height:1px;background:oklch(30% 0.04 290);flex-shrink:0;margin-bottom:18px;' });

  refs.colorList = h('div', {});
  refs.noColorsMsg = h('div', { className: 'pixel-text', style: 'font-size:14px;color:oklch(55% 0.02 290);padding:20px 0;text-align:center;' }, 'No base colors yet.');
  var colorListWrapper = h('div', { className: 'colors-scroll' }, [refs.colorList, refs.noColorsMsg]);

  panel.appendChild(desktopControlsRow);
  panel.appendChild(mobileControlsRow);
  panel.appendChild(divider);
  panel.appendChild(colorListWrapper);
  col.appendChild(panel);

  return col;
}

// ---------------------------------------------------------------------------
// Mobile-only Settings tab: base-color-count and ramp-size steppers again,
// as their own instances (see buildStepper's comment above).
// ---------------------------------------------------------------------------
function buildMobileSettingsPanel() {
  var panel = h('div', { className: 'bevel-raised mobile-settings-panel', style: 'background:oklch(19% 0.035 290);padding:20px;flex-direction:column;gap:20px;' });
  var title = h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'SETTINGS');

  var settingsColorCountStepper = makeColorCountStepper();
  var settingsRampSizeStepper = makeRampSizeStepper();
  var settingsTotalColorsText = makeTotalColorsText();

  function settingBlock(labelText, trailingEl) {
    return h('div', { style: 'display:flex;flex-direction:column;gap:8px;' }, [
      h('div', { className: 'pixel-text', style: 'font-size:11px;color:oklch(60% 0.02 290);letter-spacing:1px;text-transform:uppercase;' }, labelText),
      trailingEl,
    ]);
  }
  var rampSizeRow = h('div', { style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;' },
    [settingsRampSizeStepper.root, settingsTotalColorsText]);

  var divider = h('div', { style: 'height:1px;background:oklch(30% 0.04 290);' });

  panel.appendChild(title);
  panel.appendChild(settingBlock('Base Colors', settingsColorCountStepper.root));
  panel.appendChild(divider);
  panel.appendChild(settingBlock('Ramp Size', rampSizeRow));
  return panel;
}

// ---------------------------------------------------------------------------
// Mobile-only bottom nav bar: Color Ramps / Shift Settings / Color Wheel /
// Settings. Desktop ignores this entirely (hidden via CSS); tapping Shift or
// Wheel also drives state.rightTab so the existing bottom-panel show/hide
// logic (updateRightTabs) just works unmodified.
// ---------------------------------------------------------------------------
function buildMobileNav() {
  var nav = h('div', { className: 'mobile-nav' });
  var ramspIcon = svgFromMarkup('<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"><rect x="1" y="7.5" width="5" height="5"></rect><rect x="7.5" y="7.5" width="5" height="5"></rect><rect x="14" y="7.5" width="5" height="5"></rect></svg>');
  var shiftIcon = svgFromMarkup('<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="1" y="1" width="18" height="18" stroke="currentColor" stroke-width="1.4"></rect><polyline points="3.5,15 8,6.5 11,11.5 16.5,3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>');
  var wheelIcon = svgFromMarkup('<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="8"></circle><circle cx="10" cy="10" r="4"></circle></svg>');
  var settingsIcon = svgFromMarkup('<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="5" x2="17" y2="5"></line><circle cx="12" cy="5" r="2" fill="currentColor"></circle><line x1="3" y1="10" x2="17" y2="10"></line><circle cx="7" cy="10" r="2" fill="currentColor"></circle><line x1="3" y1="15" x2="17" y2="15"></line><circle cx="14" cy="15" r="2" fill="currentColor"></circle></svg>');

  var items = [
    { key: 'ramps', label: 'RAMPS', icon: ramspIcon },
    { key: 'shift', label: 'SHIFT', icon: shiftIcon },
    { key: 'wheel', label: 'WHEEL', icon: wheelIcon },
    { key: 'settings', label: 'SETTINGS', icon: settingsIcon },
  ];
  refs.mobileNavBtns = {};
  items.forEach(function (item) {
    var btn = h('div', { className: 'mobile-nav-btn' }, [
      h('div', { className: 'mobile-nav-icon' }, item.icon),
      h('div', { className: 'mobile-nav-label pixel-text' }, item.label),
    ]);
    btn.addEventListener('click', function () {
      var patch = { mobileTab: item.key };
      if (item.key === 'shift' || item.key === 'wheel') patch.rightTab = item.key;
      setState(patch);
    });
    refs.mobileNavBtns[item.key] = btn;
    nav.appendChild(btn);
  });
  return nav;
}

// ---------------------------------------------------------------------------
// Bottom panel: a slim vertical-tabs sidebar (SHIFT SETTINGS / COLOR WHEEL,
// doubling as the only place those names appear - no repeated in-panel
// titles) plus the active panel's content. The dice/info/add/delete
// shift-config controls live in that same sidebar, below the tabs.
// ---------------------------------------------------------------------------
function buildBottomPanel() {
  var panel = h('div', { className: 'bevel-raised bottom-panel', style: 'background:oklch(19% 0.035 290);' });

  var shiftIcon = svgFromMarkup('<svg width="34" height="34" viewBox="0 0 20 20" fill="none"><rect x="1" y="1" width="18" height="18" stroke="currentColor" stroke-width="1.4"></rect><polyline points="3.5,15 8,6.5 11,11.5 16.5,3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>');
  refs.tabShiftBtn = h('div', { className: 'tab-btn vtab-icon-btn', title: 'Shift Settings' }, shiftIcon);

  var wheelIcon = svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="8"></circle><circle cx="10" cy="10" r="4"></circle></svg>');
  refs.tabWheelBtn = h('div', { className: 'tab-btn vtab-icon-btn', title: 'Color Wheel' }, wheelIcon);

  refs.tabShiftBtn.addEventListener('click', function () { setState({ rightTab: 'shift' }); });
  refs.tabWheelBtn.addEventListener('click', function () { setState({ rightTab: 'wheel' }); });
  var tabsCol = h('div', { className: 'vtabs-col' }, [refs.tabShiftBtn, refs.tabWheelBtn]);

  var tabsDivider = h('div', { className: 'tabs-divider' });

  refs.activeDiceSvg = svgEl('svg', { width: 18, height: 18, viewBox: '0 0 20 20' });
  refs.activeDiceBtn = h('div', { className: 'bevel-raised', style: 'width:28px;height:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;', title: 'Cycle configuration' }, refs.activeDiceSvg);
  refs.activeDiceBtn.addEventListener('click', onCycleActiveConfig);

  var infoIcon = h('div', { className: 'bevel-well', style: 'width:20px;height:20px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;cursor:help;' },
    h('span', { className: 'pixel-label', style: 'font-size:11px;color:oklch(70% 0.13 195);line-height:1;' }, 'i'));
  refs.infoPopover = h('div', { className: 'info-popover' }, [
    h('div', {}, [
      h('div', { className: 'pixel-label', style: 'font-size:12px;color:oklch(80% 0.15 195);letter-spacing:1px;' }, 'GRAPHS'),
      h('div', { className: 'pixel-text', style: 'font-size:12px;color:oklch(80% 0.02 290);margin-top:4px;' }, 'Drag a dot on the graph or type a value. Double-click a dot to switch it between automatic (white) and manual (hollow) tangents.'),
    ]),
    h('div', {}, [
      h('div', { className: 'pixel-label', style: 'font-size:12px;color:oklch(80% 0.15 195);letter-spacing:1px;' }, 'CONFIGURATIONS'),
      h('div', { className: 'pixel-text', style: 'font-size:12px;color:oklch(80% 0.02 290);margin-top:4px;' }, "The dice icon cycles through the configurations these cards edit - up to 6. Each base color has its own dice icon to assign it a configuration; colors sharing one share its shift settings. The + adds a new configuration; the X deletes the current one (at least one must remain)."),
    ]),
  ]);
  // :hover (below) covers mouse users; touch devices have no real hover, so
  // the icon also toggles state.infoOpen directly - see updateShiftPanel's
  // '' vs 'flex' pattern (empty falls back to the CSS :hover rule).
  refs.infoPopover.addEventListener('click', function (e) { e.stopPropagation(); });
  infoIcon.addEventListener('click', function (e) { e.stopPropagation(); setState({ infoOpen: !state.infoOpen }); });
  var infoBtn = h('div', { className: 'info-btn' }, [infoIcon, refs.infoPopover]);

  refs.addConfigBtn = h('div', { className: 'bevel-raised action-btn action-btn-sm' },
    svgFromMarkup('<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M10 4v12M4 10h12"></path></svg>'));
  refs.addConfigBtn.addEventListener('click', onAddConfig);

  refs.deleteConfigBtn = h('div', { className: 'bevel-raised action-btn action-btn-sm' },
    svgFromMarkup('<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M4 4l12 12M16 4L4 16"></path></svg>'));
  refs.deleteConfigBtn.addEventListener('click', onDeleteActiveConfig);

  var configDivider = h('div', { className: 'config-controls-divider' });
  refs.configControlsRow = h('div', { className: 'config-controls-row' },
    [refs.activeDiceBtn, infoBtn, configDivider, refs.addConfigBtn, refs.deleteConfigBtn]);

  var verticalTabs = h('div', { className: 'vertical-tabs' }, [tabsCol, tabsDivider, refs.configControlsRow]);

  refs.shiftPanel = buildShiftPanel();
  refs.wheelPanel = buildWheelPanel();
  var content = h('div', { className: 'bottom-content' }, [refs.shiftPanel, refs.wheelPanel]);

  panel.appendChild(verticalTabs);
  panel.appendChild(content);
  return panel;
}

function buildShell() {
  var root = document.getElementById('app-root');
  root.innerHTML = '';
  root.id = 'app-root';
  root.addEventListener('click', onRootClick);

  var logoImg = h('img', {
    src: 'assets/logo.png',
    alt: 'Rampsmith logo',
    style: 'width:48px;height:48px;flex-shrink:0;image-rendering:crisp-edges;image-rendering:pixelated;'
  });
  var titleBlock = h('div', {}, [
    h('div', { className: 'pixel-label', style: 'font-size:20px;color:oklch(80% 0.15 195);line-height:1;' }, 'RAMPSMITH'),
    h('div', { className: 'pixel-text app-tagline', style: 'font-size:13px;color:oklch(65% 0.02 290);letter-spacing:2px;text-transform:uppercase;margin-top:6px;white-space:nowrap;' }, 'Pixel-Art Ramp Generator'),
  ]);
  var headerLeft = h('div', { style: 'display:flex;align-items:center;gap:16px;flex-shrink:0;' }, [logoImg, titleBlock]);

  var shareLabel = h('div', { className: 'pixel-text share-label', style: 'font-size:11px;color:oklch(65% 0.02 290);letter-spacing:2px;text-transform:uppercase;' }, 'Share Link — updates live');
  refs.shareText = h('div', { className: 'bevel-well pixel-text share-url-bar', style: 'width:min(460px, 100%);flex:1;min-width:0;height:40px;display:flex;align-items:center;padding:0 12px;background:oklch(11% 0.025 290);color:oklch(92% 0.01 290);font-size:14px;overflow:hidden;white-space:nowrap;' });
  refs.copyBtn = h('div', { className: 'bevel-raised copy-btn', title: 'Copy share link' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><rect x="7" y="7" width="10" height="10"></rect><path d="M4 13V4a1 1 0 0 1 1-1h9"></path></svg>'));
  refs.copyBtn.addEventListener('click', onCopyShare);
  var exportBtn = h('div', { className: 'bevel-raised copy-btn', title: 'Export palette as PNG' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M10 3v9M6 8l4 4 4-4"></path><path d="M4 15v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1"></path></svg>'));
  exportBtn.addEventListener('click', function () { exportPaletteAsPng(state); });
  var shareRow = h('div', { style: 'display:flex;gap:8px;min-width:0;' }, [refs.shareText, refs.copyBtn, exportBtn]);
  var headerRight = h('div', { className: 'pf-header-right', style: 'display:flex;flex-direction:column;gap:6px;' }, [shareLabel, shareRow]);

  var header = h('div', { className: 'pf-header' }, [headerLeft, headerRight]);
  refs.pfContent = h('div', { className: 'pf-content' },
    [buildColorsPanel(), buildMobileShiftPreview(), buildBottomPanel(), buildMobileSettingsPanel()]);
  var mobileNav = buildMobileNav();

  root.appendChild(header);
  root.appendChild(refs.pfContent);
  root.appendChild(mobileNav);
}

function render() {
  updateHeader();
  updateBaseColorsHeader();
  updateColorList();
  updateRightTabs();
  updateShiftPanel();
  updateWheel();
  updateMobileNav();
}

function boot() {
  var initialPatch = readStateFromLocation();
  state = Object.assign(createDefaultState(), initialPatch || {});
  buildShell();
  render();
}
boot();
