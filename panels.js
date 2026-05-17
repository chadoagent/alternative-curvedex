// =============================================================================
// CurveDEX — Resizable & Collapsible Side Panels
// Implements items 1-2 from @Alexey_Petryashev UX feedback (msg 95).
//
// Item 1: Drag borders between left/center/right panels to widen/narrow.
// Item 2: Collapse buttons in left + right panels (sliver remains for re-expand).
//
// (Per-column resizing in pool sidebar removed by Nik msg 260: /yield should be
// a single uniform table without per-column scaling.)
//
// All state persists to localStorage with prefix `curvedex_`.
// Mobile (<=1024px): handles + collapse buttons hidden via CSS, panels stack.
//
// Implementation note: the layout DOM is NOT a clean
// [sidebar | center | right] sequence — it's interleaved per-route. So we
// don't insert handles into grid tracks. Instead we override the grid-template
// to a flat 3-col template controlled by --left-w / --right-w CSS vars, and
// place resize-handles as absolutely positioned overlays at the panel edges.
// =============================================================================
(function () {
  'use strict';

  // ---------- localStorage helpers (safe-fail if storage unavailable) ----------
  const STORAGE_KEY_WIDTHS = 'curvedex_panel_widths';
  const STORAGE_KEY_COLLAPSED = 'curvedex_panel_collapsed';
  // Legacy key (column widths) — clear once on load to remove stale entries.
  const STORAGE_KEY_COLS_LEGACY = 'curvedex_yield_cols';
  try { localStorage.removeItem(STORAGE_KEY_COLS_LEGACY); } catch (e) {}

  function loadJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (!v) return fallback;
      return JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  // ---------- Width constraints (px) ----------
  // LEFT_DEFAULT_YIELD 632 fits /yield columns POOL/TVL/APY/CRV/Ext/Total/WT/ΔW/FW
  // without truncation (msg 282 Alexandr 2026-05-01). LEFT_MAX 720 caps manual
  // resize. /trade sidebar holds only token-list+filters → 360 default. /pools
  // shows TVL/Vol/24H without emission columns → 440 default.
  const LEFT_MIN = 180, LEFT_MAX = 720;
  const RIGHT_MIN = 200, RIGHT_MAX = 600, RIGHT_DEFAULT = 380;

  // Per-route content-aware defaults (Ник 2026-05-01 21:56).
  const LEFT_DEFAULT_YIELD = 632;
  const LEFT_DEFAULT_TRADE = 360;
  const LEFT_DEFAULT_POOLS = 440;
  const LEFT_DEFAULT_OTHER = 440; // root / unknown route

  // ---------- Viewport-adaptive defaults (yield only) ----------
  // Audit finding #3: on ≤1400px viewports 632px sidebar + 380px right-panel
  // leaves only ~268px center-panel — pool name 'DAI / USDC / USDT' gets clipped.
  // Shrink yield default to 540 on narrow viewports; trade/pools defaults
  // already comfortable, no narrow-viewport variants needed.
  const NARROW_VIEWPORT_PX = 1400;
  const LEFT_DEFAULT_YIELD_NARROW = 540;
  const RIGHT_DEFAULT_NARROW = 360;
  const isNarrow = (typeof window !== 'undefined' && window.innerWidth <= NARROW_VIEWPORT_PX);

  function getRouteKey() {
    // Prefer body.page-* class (set by switchView in app.js — authoritative).
    const cls = (typeof document !== 'undefined' && document.body) ? document.body.className : '';
    if (cls.indexOf('page-yield') !== -1) return 'yield';
    if (cls.indexOf('page-trade') !== -1) return 'trade';
    if (cls.indexOf('page-pools') !== -1) return 'pools';
    if (cls.indexOf('page-swap') !== -1 || cls.indexOf('page-portfolio') !== -1) return 'other';
    // Fallback: parse hash before body class is set (e.g. very early init).
    const h = (typeof window !== 'undefined' && window.location && window.location.hash) || '';
    if (h.indexOf('#/yield') === 0) return 'yield';
    if (h.indexOf('#/pools') === 0 || h.indexOf('#/pool/') === 0) return 'pools';
    if (h.indexOf('#/trade') === 0) return 'trade';
    if (h.indexOf('#/swap') === 0 || h.indexOf('#/portfolio') === 0) return 'other';
    return 'trade'; // app.js default view
  }

  function getRouteDefaultLeftWidth(routeKey) {
    if (routeKey === 'yield') return isNarrow ? LEFT_DEFAULT_YIELD_NARROW : LEFT_DEFAULT_YIELD;
    if (routeKey === 'trade') return LEFT_DEFAULT_TRADE;
    if (routeKey === 'pools') return LEFT_DEFAULT_POOLS;
    return LEFT_DEFAULT_OTHER;
  }

  const SAVED_WIDTHS = loadJSON(STORAGE_KEY_WIDTHS, {});

  // ---------- Migrate legacy widths.left (number) → per-route object ----------
  // v<=20260501af stored widths.left as a single number applied to all routes.
  // Promote it to widths.left.yield (since it was tuned for /yield columns)
  // and let trade/pools fall back to per-route defaults. If user had the old
  // 450 phase-1.5 default, drop it entirely so they get the new yield default.
  let savedLeftMap = {};
  let savedRight = SAVED_WIDTHS.right;
  if (typeof SAVED_WIDTHS.left === 'number') {
    const legacyLeft = SAVED_WIDTHS.left;
    const LEFT_PHASE15_DEFAULT = 450;
    if (legacyLeft !== LEFT_PHASE15_DEFAULT && Math.abs(legacyLeft - LEFT_PHASE15_DEFAULT) > 1) {
      // Treat as user-tuned-for-yield only. Trade/pools start at their content-aware defaults.
      savedLeftMap.yield = legacyLeft;
    }
  } else if (SAVED_WIDTHS.left && typeof SAVED_WIDTHS.left === 'object') {
    savedLeftMap = Object.assign({}, SAVED_WIDTHS.left);
  }

  // ---------- State ----------
  const state = {
    widths: {
      // left is a per-route map: { yield: 632, trade: 360, pools: 440, other: 440 }
      // Missing keys fall back to getRouteDefaultLeftWidth at apply time.
      left: savedLeftMap,
      right: typeof savedRight === 'number' ? savedRight : (isNarrow ? RIGHT_DEFAULT_NARROW : RIGHT_DEFAULT),
    },
    collapsed: Object.assign({ left: false, right: false }, loadJSON(STORAGE_KEY_COLLAPSED, {})),
  };
  // Clamp every saved per-route value into [LEFT_MIN, LEFT_MAX].
  for (const k in state.widths.left) {
    state.widths.left[k] = Math.max(LEFT_MIN, Math.min(LEFT_MAX, state.widths.left[k] || getRouteDefaultLeftWidth(k)));
  }
  state.widths.right = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, state.widths.right || RIGHT_DEFAULT));

  function getLeftWidthForRoute(routeKey) {
    const saved = state.widths.left[routeKey];
    if (typeof saved === 'number') return saved;
    return getRouteDefaultLeftWidth(routeKey);
  }

  // ---------- DOM refs ----------
  let layoutEl = null;
  let leftSidebarEl = null;
  let tradeSidebarEl = null;
  let rightPanelEls = [];

  let leftHandle = null;
  let rightHandle = null;

  // ---------- State application ----------
  function applyWidths() {
    if (!layoutEl) return;
    const routeKey = getRouteKey();
    // When collapsed, force a thin sliver instead of saved width
    const effLeft = state.collapsed.left ? 24 : getLeftWidthForRoute(routeKey);
    const effRight = state.collapsed.right ? 24 : state.widths.right;
    layoutEl.style.setProperty('--left-w', effLeft + 'px');
    layoutEl.style.setProperty('--right-w', effRight + 'px');
    positionHandles();
  }

  function applyCollapsed() {
    if (!layoutEl) return;
    layoutEl.classList.toggle('left-collapsed', !!state.collapsed.left);
    layoutEl.classList.toggle('right-collapsed', !!state.collapsed.right);
    if (leftSidebarEl) leftSidebarEl.classList.toggle('panel-collapsed', !!state.collapsed.left);
    if (tradeSidebarEl) tradeSidebarEl.classList.toggle('panel-collapsed', !!state.collapsed.left);
    rightPanelEls.forEach(el => el.classList.toggle('panel-collapsed', !!state.collapsed.right));
    applyWidths(); // re-apply width vars (collapsed state changes effective width)
  }

  // ---------- Position handles based on current visible panel ----------
  function getEffectiveLeftWidth() {
    if (state.collapsed.left) return 24;
    return getLeftWidthForRoute(getRouteKey());
  }
  function getEffectiveRightWidth() {
    if (state.collapsed.right) return 24;
    return state.widths.right;
  }

  function positionHandles() {
    if (!layoutEl) return;
    const w = window.innerWidth;
    const isMobile = w <= 1024;
    if (isMobile) {
      if (leftHandle) leftHandle.style.display = 'none';
      if (rightHandle) rightHandle.style.display = 'none';
      return;
    }
    // Determine layout class state
    const hasLeftPanel = !layoutEl.classList.contains('no-sidebar') &&
                        !layoutEl.classList.contains('swap-active') &&
                        !layoutEl.classList.contains('portfolio-active');
    const hasRightPanel = !layoutEl.classList.contains('portfolio-active') &&
                         !(layoutEl.classList.contains('swap-active') && layoutEl.classList.contains('no-sidebar'));

    const leftW = hasLeftPanel ? getEffectiveLeftWidth() : 0;
    const rightW = hasRightPanel ? getEffectiveRightWidth() : 0;

    if (leftHandle) {
      if (hasLeftPanel) {
        leftHandle.style.display = '';
        // Place handle centered on the boundary at x = leftW (relative to layout's left edge).
        leftHandle.style.left = (leftW - 2) + 'px';
      } else {
        leftHandle.style.display = 'none';
      }
    }
    if (rightHandle) {
      if (hasRightPanel) {
        rightHandle.style.display = '';
        // Place handle centered on the boundary at right = rightW.
        rightHandle.style.right = (rightW - 2) + 'px';
      } else {
        rightHandle.style.display = 'none';
      }
    }
  }

  // ---------- Build resize handles + collapse buttons ----------
  function buildHandle(side) {
    const h = document.createElement('div');
    h.className = 'resize-handle resize-handle--' + side;
    h.dataset.resizeSide = side;
    h.title = side === 'left' ? 'Drag to resize left panel' : 'Drag to resize right panel';
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-orientation', 'vertical');
    return h;
  }

  function buildCollapseBtn(side, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-collapse-btn panel-collapse-btn--' + side;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const iconId = side === 'left' ? 'icon-chevron-left' : 'icon-chevron-right';
    btn.innerHTML = '<svg class="icon"><use href="#' + iconId + '"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse(side);
    });
    return btn;
  }

  function toggleCollapse(side) {
    state.collapsed[side] = !state.collapsed[side];
    applyCollapsed();
    saveJSON(STORAGE_KEY_COLLAPSED, state.collapsed);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 220);
  }

  // ---------- Drag logic for panels ----------
  // `routeKey` is captured at drag-start so the user can navigate mid-drag and
  // the resize still applies to the route they were on when they grabbed the
  // handle. Only used for side='left' (right panel is global).
  function startDragPanel(side, startX, startW, routeKey) {
    document.body.classList.add('resize-dragging');
    const min = side === 'left' ? LEFT_MIN : RIGHT_MIN;
    const max = side === 'left' ? LEFT_MAX : RIGHT_MAX;
    function onMove(e) {
      const x = e.clientX != null ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX);
      if (x == null) return;
      const delta = x - startX;
      let next = side === 'left' ? startW + delta : startW - delta;
      next = Math.max(min, Math.min(max, next));
      const rounded = Math.round(next);
      if (side === 'left') {
        state.widths.left[routeKey] = rounded;
      } else {
        state.widths.right = rounded;
      }
      applyWidths();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.body.classList.remove('resize-dragging');
      document.querySelectorAll('.resize-handle.active').forEach(h => h.classList.remove('active'));
      saveJSON(STORAGE_KEY_WIDTHS, state.widths);
      window.dispatchEvent(new Event('resize'));
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onUp);
  }

  function attachPanelHandle(handle) {
    const onDown = (e) => {
      if (e.type === 'mousedown' && e.button !== 0) return;
      const side = handle.dataset.resizeSide;
      // If panel is collapsed, expand on click instead of starting drag
      if (state.collapsed[side]) {
        toggleCollapse(side);
        e.preventDefault();
        return;
      }
      const x = e.clientX != null ? e.clientX : (e.touches && e.touches[0] && e.touches[0].clientX);
      const routeKey = getRouteKey();
      const startW = side === 'left' ? getLeftWidthForRoute(routeKey) : state.widths.right;
      handle.classList.add('active');
      startDragPanel(side, x, startW, routeKey);
      e.preventDefault();
    };
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }

  // ---------- Init ----------
  function init() {
    layoutEl = document.querySelector('.main-layout');
    if (!layoutEl) return;
    leftSidebarEl = document.getElementById('sidebar');
    tradeSidebarEl = document.getElementById('tradeTokenSidebar');
    rightPanelEls = Array.from(document.querySelectorAll('.right-panel'));

    // Mark layout as user-resized: enables CSS-driven width via --left-w/--right-w vars.
    layoutEl.classList.add('user-resized');

    // Build handles. They live as children of .main-layout, absolutely positioned.
    leftHandle = buildHandle('left');
    rightHandle = buildHandle('right');
    layoutEl.appendChild(leftHandle);
    layoutEl.appendChild(rightHandle);
    attachPanelHandle(leftHandle);
    attachPanelHandle(rightHandle);

    // Add collapse buttons to all side panels.
    if (leftSidebarEl) {
      leftSidebarEl.appendChild(buildCollapseBtn('left', 'Collapse pool sidebar'));
    }
    if (tradeSidebarEl) {
      tradeSidebarEl.appendChild(buildCollapseBtn('left', 'Collapse token sidebar'));
    }
    rightPanelEls.forEach(el => {
      el.appendChild(buildCollapseBtn('right', 'Collapse right panel'));
    });

    applyWidths();
    applyCollapsed();

    // Reposition panel handles when layout class changes (route changes toggle classes).
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.target === layoutEl) {
          positionHandles();
          break;
        }
      }
    });
    obs.observe(layoutEl, { attributes: true, attributeFilter: ['class', 'style'] });

    // Re-apply per-route default sidebar width on body.page-* class change
    // (set by app.js switchView). This is what makes /trade → /pools → /yield
    // update the left sidebar to its content-aware default. applyWidths reads
    // getRouteKey() from body class, so we just trigger it on every relevant change.
    let lastRouteKey = getRouteKey();
    const bodyObs = new MutationObserver(() => {
      const cur = getRouteKey();
      if (cur !== lastRouteKey) {
        lastRouteKey = cur;
        applyWidths();
      }
    });
    bodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // Reposition handles on window resize / route change
    window.addEventListener('resize', positionHandles);
    // Also re-apply width on route change (covers cases where hashchange fires
    // before body.page-* updates — applyWidths re-reads getRouteKey).
    window.addEventListener('hashchange', () => setTimeout(() => { applyWidths(); positionHandles(); }, 50));

    // Expose minimal API for debug / tests
    window.__curvedexPanels = {
      getState: () => JSON.parse(JSON.stringify(state)),
      getRouteKey,
      getRouteDefaultLeftWidth,
      getLeftWidthForRoute,
      reset: () => {
        state.widths = { left: {}, right: RIGHT_DEFAULT };
        state.collapsed = { left: false, right: false };
        try { localStorage.removeItem(STORAGE_KEY_WIDTHS); } catch(e){}
        try { localStorage.removeItem(STORAGE_KEY_COLLAPSED); } catch(e){}
        applyWidths();
        applyCollapsed();
      },
      toggle: (side) => toggleCollapse(side),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
