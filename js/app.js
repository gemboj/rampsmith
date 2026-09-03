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
  var headerRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' }, [
    h('div', { style: 'display:flex;align-items:center;gap:10px;' }, [swatch, labelEl]),
    resetBtn,
  ]);

  var svg = svgEl('svg', { width: '100%', height: '100%', viewBox: '0 0 360 208', preserveAspectRatio: 'none', style: 'display:block;' });
  svg.appendChild(svgEl('rect', { x: 4, y: 52, width: 352, height: 104, fill: 'oklch(14% 0.03 290)', stroke: 'oklch(30% 0.04 290)', 'stroke-width': 1 }));
  svg.appendChild(svgEl('line', { x1: 20, y1: 104, x2: 340, y2: 104, stroke: 'oklch(30% 0.04 290)', 'stroke-width': 1, 'stroke-dasharray': '3,3' }));
  svg.appendChild(svgEl('line', { x1: 180, y1: 44, x2: 180, y2: 164, stroke: 'oklch(26% 0.035 290)', 'stroke-width': 1, 'stroke-dasharray': '2,3' }));
  var polyline = svgEl('polyline', { points: '', fill: 'none', stroke: lineColor, 'stroke-width': 2 });
  svg.appendChild(polyline);

  function makeAnchorVisual() {
    var hit = svgEl('circle', { class: 'curve-handle-hit', r: 12, fill: 'transparent' });
    var dot = svgEl('circle', { r: 4, stroke: lineColor, 'stroke-width': 2, style: 'pointer-events:none;' });
    svg.appendChild(hit); svg.appendChild(dot);
    return { hit: hit, dot: dot };
  }
  var leftAnchor = makeAnchorVisual(), centerAnchor = makeAnchorVisual(), rightAnchor = makeAnchorVisual();

  function makeHandleVisual() {
    var line = svgEl('line', { stroke: lineColor, 'stroke-width': 1, 'stroke-dasharray': '2,2', opacity: 0.5, style: 'display:none;' });
    var hit = svgEl('circle', { class: 'curve-handle-hit', r: 12, fill: 'transparent', style: 'display:none;' });
    var dot = svgEl('circle', { r: 4, fill: lineColor, stroke: 'oklch(11% 0.025 290)', 'stroke-width': 1.5, style: 'display:none;pointer-events:none;' });
    svg.appendChild(line); svg.appendChild(hit); svg.appendChild(dot);
    return { line: line, hit: hit, dot: dot };
  }
  var leftHandle = makeHandleVisual(), centerLeftHandle = makeHandleVisual(), centerRightHandle = makeHandleVisual(), rightHandle = makeHandleVisual();

  var plotWrap = h('div', { className: 'bevel-well curve-plot', style: 'width:100%;height:208px;background:oklch(11% 0.025 290);' }, svg);

  function rangeInput() { return h('input', { type: 'number', className: 'value-input pixel-text' }); }
  var leftRangeInput = rangeInput(), centerRangeInput = rangeInput(), rightRangeInput = rangeInput();
  var inputsRow = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [leftRangeInput, centerRangeInput, rightRangeInput]);

  var root = h('div', { style: 'background:oklch(23% 0.035 290);border:3px solid oklch(9% 0.02 290);padding:16px;display:flex;flex-direction:column;gap:12px;' }, [headerRow, plotWrap, inputsRow]);

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
        var pt = svgLocalPoint(e);
        setRange(sideName, clamp(Math.round(yToVal(pt.y, domainMin, domainMax)), domainMin, domainMax));
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
        var pt = svgLocalPoint(e);
        var patch = {};
        patch[handleName] = { tFrac: pxToHandleFrac(pt.x, side), y: pxToHandleVal(pt.y, domainMin, domainMax) };
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
        var pt = svgLocalPoint(e);
        var tFrac = pxToHandleFrac(pt.x, displaySide);
        var y = pxToHandleVal(pt.y, domainMin, domainMax);
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
    var curveData = computeCurveSvg(comp, X, absoluteTarget);
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
// Shift Settings panel (dice/info/delete header + the 3 curve cards).
// ---------------------------------------------------------------------------
function buildShiftPanel() {
  cardRefs.hue = buildCard('hue', 'HUE', 'background: linear-gradient(90deg, red, yellow, lime, cyan, blue, magenta, red);', 'oklch(80% 0.15 195)', false);
  cardRefs.sat = buildCard('sat', 'CHROMA', 'background: linear-gradient(90deg, oklch(55% 0 0), oklch(75% 0.18 345));', 'oklch(75% 0.18 345)', true);
  cardRefs.val = buildCard('val', 'LIGHTNESS', 'background: linear-gradient(90deg, #000000, #ffffff);', 'oklch(85% 0.17 95)', true);

  refs.activeDiceSvg = svgEl('svg', { width: 18, height: 18, viewBox: '0 0 20 20' });
  refs.activeDiceBtn = h('div', { className: 'bevel-raised', style: 'width:28px;height:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;' }, refs.activeDiceSvg);
  refs.activeDiceBtn.addEventListener('click', onCycleActiveConfig);

  var label = h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'SHIFT SETTINGS');

  var infoBtn = h('div', { className: 'info-btn' }, [
    h('div', { className: 'bevel-well', style: 'width:20px;height:20px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;cursor:help;' },
      h('span', { className: 'pixel-label', style: 'font-size:11px;color:oklch(70% 0.13 195);line-height:1;' }, 'i')),
    h('div', { className: 'info-popover' }, [
      h('div', {}, [
        h('div', { className: 'pixel-label', style: 'font-size:12px;color:oklch(80% 0.15 195);letter-spacing:1px;' }, 'GRAPHS'),
        h('div', { className: 'pixel-text', style: 'font-size:12px;color:oklch(80% 0.02 290);margin-top:4px;' }, 'Drag a dot on the graph or type a value. Double-click a dot to switch it between automatic (white) and manual (hollow) tangents.'),
      ]),
      h('div', {}, [
        h('div', { className: 'pixel-label', style: 'font-size:12px;color:oklch(80% 0.15 195);letter-spacing:1px;' }, 'CONFIGURATIONS'),
        h('div', { className: 'pixel-text', style: 'font-size:12px;color:oklch(80% 0.02 290);margin-top:4px;' }, "The dice icon (left) cycles through the configurations these cards edit - up to 6. Each base color has its own dice icon to assign it a configuration; colors sharing one share its shift settings. The + adds a new configuration; the X deletes the current one (at least one must remain)."),
      ]),
    ]),
  ]);

  refs.addConfigBtn = h('div', { className: 'bevel-raised action-btn' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M10 4v12M4 10h12"></path></svg>'));
  refs.addConfigBtn.addEventListener('click', onAddConfig);

  refs.deleteConfigBtn = h('div', { className: 'bevel-raised action-btn' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><path d="M4 4l12 12M16 4L4 16"></path></svg>'));
  refs.deleteConfigBtn.addEventListener('click', onDeleteActiveConfig);

  var headerRow = h('div', { style: 'display:flex;align-items:center;gap:8px;' }, [refs.activeDiceBtn, label, infoBtn, refs.addConfigBtn, refs.deleteConfigBtn]);

  return h('div', { className: 'bevel-raised', style: 'flex:1;background:oklch(19% 0.035 290);padding:20px;display:flex;flex-direction:column;gap:16px;' },
    [headerRow, cardRefs.hue.root, cardRefs.sat.root, cardRefs.val.root]);
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
  refs.addConfigBtn.style.cssText = (canAdd ? '' : STYLE_DISABLED) + 'margin-left:auto;';
  refs.addConfigBtn.title = 'Add a new configuration';
  var canDelete = state.shiftConfigs.length > 1;
  refs.deleteConfigBtn.style.cssText = canDelete ? '' : STYLE_DISABLED;
  refs.deleteConfigBtn.title = 'Delete Configuration ' + (activeConfigIndex + 1);
  cardRefs.hue.update();
  cardRefs.sat.update();
  cardRefs.val.update();
}

// ---------------------------------------------------------------------------
// Color wheel panel.
// ---------------------------------------------------------------------------
function buildWheelPanel() {
  var title = h('div', {}, [
    h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'COLOR WHEEL'),
    h('div', { className: 'pixel-text', style: 'font-size:13px;color:oklch(65% 0.02 290);margin-top:6px;' }, "Hue by angle, saturation by distance from center, value fixed at 100%. Drag a dot to retune that base color's hue/saturation."),
  ]);
  refs.wheelDisc = h('div', {
    className: 'wheel-disc',
    style: 'position:relative;width:min(' + WHEEL_SIZE + 'px, 100%);aspect-ratio:1;border-radius:50%;border:3px solid oklch(9% 0.02 290);background:radial-gradient(circle closest-side, oklch(100% 0 0) 0%, transparent 100%), conic-gradient(red, yellow, lime, cyan, blue, magenta, red);',
  });
  return h('div', { className: 'bevel-raised', style: 'flex:1;background:oklch(19% 0.035 290);padding:20px;display:flex;flex-direction:column;align-items:center;gap:14px;' }, [title, refs.wheelDisc]);
}

function ensureWheelMarker(id) {
  if (wheelRefs.has(id)) return wheelRefs.get(id);
  var dot = h('div', { style: 'width:' + (WHEEL_MARKER_R * 2) + 'px;height:' + (WHEEL_MARKER_R * 2) + 'px;border-radius:50%;border:2px solid oklch(11% 0.025 290);pointer-events:none;' });
  var hitPct = (WHEEL_HIT_R * 2 / WHEEL_SIZE * 100).toFixed(3) + '%';
  var hit = h('div', { className: 'wheel-dot-hit', style: 'position:absolute;width:' + hitPct + ';height:' + hitPct + ';' }, dot);
  hit.addEventListener('pointerdown', function (e) { try { e.target.setPointerCapture(e.pointerId); } catch (err) {} });
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

  var rightGroup = h('div', { style: 'display:flex;align-items:center;gap:6px;flex-shrink:0;' }, [diceBtn, copyIcon, removeBtn]);
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
  r.rampRow.style.cssText = 'display:flex;align-items:center;gap:' + (isCompact ? '2px' : '7px') + ';';

  r.rampRow.innerHTML = '';
  ramp.forEach(function (hexColor, i) {
    var sw = document.createElement('div');
    sw.className = i === X ? 'ramp-swatch ramp-swatch-center' : 'ramp-swatch';
    var style = 'background:' + hexColor + ';';
    if (!isCompact && hasSelection && i === selIndex) style += 'outline:2px solid oklch(80% 0.15 195); outline-offset:2px;';
    if (isCompact && i === X) style += 'width:34px;height:34px;';
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
    ? 'display:flex;flex-wrap:wrap;gap:0 2px;'
    : 'display:grid;grid-template-columns:repeat(auto-fill, minmax(min(380px, 100%), 1fr));gap:20px;';
  refs.noColorsMsg.style.display = state.colors.length === 0 ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Base colors panel header controls + right-column tabs + header share box.
// ---------------------------------------------------------------------------
function updateBaseColorsHeader() {
  refs.colorCountVal.textContent = String(state.colors.length);
  refs.colorDecBtn.style.cssText = state.colors.length === 0 ? STYLE_DISABLED : STYLE_ACTIVE;
  refs.xVal.textContent = String(state.X);
  refs.xDecBtn.style.cssText = state.X <= 1 ? STYLE_DISABLED : STYLE_ACTIVE;
  refs.xIncBtn.style.cssText = state.X >= 4 ? STYLE_DISABLED : STYLE_ACTIVE;
  refs.totalColorsText.textContent = '→ ' + (2 * state.X + 1) + ' COLORS PER RAMP';
  var isCompact = !!state.compactRamps;
  refs.compactInIcon.style.display = isCompact ? 'none' : '';
  refs.compactOutIcon.style.display = isCompact ? '' : 'none';
  refs.compactToggleBtn.title = isCompact ? 'Show base color details' : 'Compact view (ramps only)';
}

function updateRightTabs() {
  var isShift = (state.rightTab || 'shift') !== 'wheel';
  refs.tabShiftBtn.className = 'tab-btn pixel-label ' + (isShift ? 'tab-active' : 'tab-inactive');
  refs.tabWheelBtn.className = 'tab-btn pixel-label ' + (!isShift ? 'tab-active' : 'tab-inactive');
  refs.shiftPanel.style.display = isShift ? 'flex' : 'none';
  refs.wheelPanel.style.display = !isShift ? 'flex' : 'none';
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
  var anyOpen = state.colors.some(function (c) { return c.pickerOpen; });
  if (anyOpen) patch.colors = state.colors.map(function (c) { return c.pickerOpen ? Object.assign({}, c, { pickerOpen: false }) : c; });
  if (Object.keys(patch).length) setState(patch);
}

// ---------------------------------------------------------------------------
// Shell assembly.
// ---------------------------------------------------------------------------
function buildLeftColumn() {
  var col = h('div', { className: 'pf-left-col' });
  var panel = h('div', { className: 'bevel-raised', style: 'flex:1;min-width:0;background:oklch(19% 0.035 290);padding:20px;display:flex;flex-direction:column;' });

  var baseColorsLabel = h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'BASE COLORS');
  refs.colorDecBtn = h('div', { className: 'bevel-raised step-btn' }, svgFromMarkup('<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M13 4l-7 6 7 6"></path></svg>'));
  refs.colorCountVal = h('div', { className: 'bevel-raised step-val pixel-text', style: 'min-width:40px;' });
  refs.colorIncBtn = h('div', { className: 'bevel-raised step-btn', style: STYLE_ACTIVE }, svgFromMarkup('<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M7 4l7 6-7 6"></path></svg>'));
  var colorCountGroup = h('div', { style: 'display:flex;align-items:center;gap:4px;' }, [refs.colorDecBtn, refs.colorCountVal, refs.colorIncBtn]);

  var sep = h('div', { className: 'pixel-text', style: 'font-size:15px;color:oklch(40% 0.02 290);' }, '|');

  var rampSizeLabel = h('div', { className: 'pixel-label', style: 'font-size:14px;color:oklch(80% 0.15 195);' }, 'RAMP SIZE');
  refs.xDecBtn = h('div', { className: 'bevel-raised step-btn' }, svgFromMarkup('<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M13 4l-7 6 7 6"></path></svg>'));
  refs.xVal = h('div', { className: 'bevel-raised step-val pixel-text', style: 'min-width:50px;' });
  refs.xIncBtn = h('div', { className: 'bevel-raised step-btn' }, svgFromMarkup('<svg width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square"><path d="M7 4l7 6-7 6"></path></svg>'));
  var xGroup = h('div', { style: 'display:flex;align-items:center;gap:4px;' }, [refs.xDecBtn, refs.xVal, refs.xIncBtn]);

  refs.totalColorsText = h('div', { className: 'pixel-text', style: 'font-size:14px;color:oklch(80% 0.15 195);letter-spacing:1px;' });

  refs.compactInIcon = svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><polyline points="8,4 8,8 4,8"></polyline><polyline points="12,16 12,12 16,12"></polyline></svg>');
  refs.compactOutIcon = svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><polyline points="4,8 4,4 8,4"></polyline><polyline points="16,12 16,16 12,16"></polyline></svg>');
  refs.compactToggleBtn = h('div', { className: 'bevel-raised action-btn', style: 'color: oklch(80% 0.15 195); margin-left: auto;' }, [refs.compactInIcon, refs.compactOutIcon]);

  refs.sortBtn = h('div', { className: 'bevel-raised action-btn', style: 'color: oklch(80% 0.15 195);', title: 'Sort base colors by hue' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square"><line x1="4" y1="5" x2="10" y2="5"></line><line x1="4" y1="10" x2="14" y2="10"></line><line x1="4" y1="15" x2="18" y2="15"></line></svg>'));

  var controlsRow = h('div', { style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px;flex-shrink:0;' },
    [baseColorsLabel, colorCountGroup, sep, rampSizeLabel, xGroup, refs.totalColorsText, refs.compactToggleBtn, refs.sortBtn]);

  var divider = h('div', { style: 'height:1px;background:oklch(30% 0.04 290);flex-shrink:0;margin-bottom:18px;' });

  refs.colorList = h('div', {});
  refs.noColorsMsg = h('div', { className: 'pixel-text', style: 'font-size:14px;color:oklch(55% 0.02 290);padding:20px 0;text-align:center;' }, 'No base colors yet.');
  var colorListWrapper = h('div', { style: 'padding:5px;margin-bottom:16px;' }, [refs.colorList, refs.noColorsMsg]);

  panel.appendChild(controlsRow);
  panel.appendChild(divider);
  panel.appendChild(colorListWrapper);
  col.appendChild(panel);

  refs.colorDecBtn.addEventListener('click', function () {
    if (state.colors.length === 0) return;
    setState({ colors: state.colors.slice(0, -1) });
  });
  refs.colorIncBtn.addEventListener('click', function () {
    var hex = PRESET_HUES[state.nextId % PRESET_HUES.length];
    setState({ colors: state.colors.concat([makeColorEntry(state.nextId, hex)]), nextId: state.nextId + 1 });
  });
  refs.xDecBtn.addEventListener('click', function () { if (state.X > 1) setState({ X: state.X - 1 }); });
  refs.xIncBtn.addEventListener('click', function () { if (state.X < 4) setState({ X: state.X + 1 }); });
  refs.compactToggleBtn.addEventListener('click', function () { setState({ compactRamps: !state.compactRamps }); });
  refs.sortBtn.addEventListener('click', function () {
    setState({ colors: state.colors.slice().sort(function (a, b) { return (a.hsvH || 0) - (b.hsvH || 0); }) });
  });

  return col;
}

function buildRightColumn() {
  var col = h('div', { className: 'pf-right-col' });
  refs.tabShiftBtn = h('div', { className: 'tab-btn pixel-label', style: 'flex:1;text-align:center;font-size:12px;padding:10px 8px;' }, 'SHIFT SETTINGS');
  refs.tabWheelBtn = h('div', { className: 'tab-btn pixel-label', style: 'flex:1;text-align:center;font-size:12px;padding:10px 8px;' }, 'COLOR WHEEL');
  var tabsRow = h('div', { style: 'display:flex;gap:6px;flex-shrink:0;' }, [refs.tabShiftBtn, refs.tabWheelBtn]);
  refs.tabShiftBtn.addEventListener('click', function () { setState({ rightTab: 'shift' }); });
  refs.tabWheelBtn.addEventListener('click', function () { setState({ rightTab: 'wheel' }); });

  refs.shiftPanel = buildShiftPanel();
  refs.wheelPanel = buildWheelPanel();

  col.appendChild(tabsRow);
  col.appendChild(refs.shiftPanel);
  col.appendChild(refs.wheelPanel);
  return col;
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
    h('div', { className: 'pixel-text', style: 'font-size:13px;color:oklch(65% 0.02 290);letter-spacing:2px;text-transform:uppercase;margin-top:6px;white-space:nowrap;' }, 'Pixel-Art Ramp Generator'),
  ]);
  var headerLeft = h('div', { style: 'display:flex;align-items:center;gap:16px;flex-shrink:0;' }, [logoImg, titleBlock]);

  var shareLabel = h('div', { className: 'pixel-text', style: 'font-size:11px;color:oklch(65% 0.02 290);letter-spacing:2px;text-transform:uppercase;' }, 'Share Link — updates live');
  refs.shareText = h('div', { className: 'bevel-well pixel-text', style: 'width:min(460px, 100%);flex:1;min-width:0;height:40px;display:flex;align-items:center;padding:0 12px;background:oklch(11% 0.025 290);color:oklch(92% 0.01 290);font-size:14px;overflow:hidden;white-space:nowrap;' });
  refs.copyBtn = h('div', { className: 'bevel-raised copy-btn', title: 'Copy share link' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><rect x="7" y="7" width="10" height="10"></rect><path d="M4 13V4a1 1 0 0 1 1-1h9"></path></svg>'));
  refs.copyBtn.addEventListener('click', onCopyShare);
  var exportBtn = h('div', { className: 'bevel-raised copy-btn', title: 'Export palette as PNG' },
    svgFromMarkup('<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M10 3v9M6 8l4 4 4-4"></path><path d="M4 15v1a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1"></path></svg>'));
  exportBtn.addEventListener('click', function () { exportPaletteAsPng(state); });
  var shareRow = h('div', { style: 'display:flex;gap:8px;min-width:0;' }, [refs.shareText, refs.copyBtn, exportBtn]);
  var headerRight = h('div', { className: 'pf-header-right', style: 'display:flex;flex-direction:column;gap:6px;' }, [shareLabel, shareRow]);

  var header = h('div', { className: 'pf-header' }, [headerLeft, headerRight]);
  var content = h('div', { className: 'pf-content' }, [buildLeftColumn(), buildRightColumn()]);

  root.appendChild(header);
  root.appendChild(content);
}

function render() {
  updateHeader();
  updateBaseColorsHeader();
  updateColorList();
  updateRightTabs();
  updateShiftPanel();
  updateWheel();
}

function boot() {
  var initialPatch = readStateFromLocation();
  state = Object.assign(createDefaultState(), initialPatch || {});
  buildShell();
  render();
}
boot();
