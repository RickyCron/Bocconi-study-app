import { state } from './store/store.js';
import { animateStaggerItems, animateProgressBars } from './lib/utils.js';

// ── View registry ─────────────────────────────────────────────────────────────
// Each entry: { mount(container, params), unmount? }
const _registry = new Map();
const _mounted  = new Map(); // viewId → cleanup fn

export function registerView(id, mod) {
  _registry.set(id, mod);
}

// ── Navigation ────────────────────────────────────────────────────────────────

export function navigate(viewId, params = {}) {
  // Unmount previous view
  const prev = state.currentView;
  if (prev && prev !== viewId && _mounted.has(prev)) {
    const cleanup = _mounted.get(prev);
    if (typeof cleanup === 'function') cleanup();
    _mounted.delete(prev);
  }

  state.currentView = viewId;

  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active', 'view-animate'));

  // Show the target view
  const domId = viewId === 'course-detail' ? 'view-course-detail' : `view-${viewId}`;
  const el = document.getElementById(domId);
  if (!el) { console.warn('[router] no DOM element for view:', viewId); return; }
  el.classList.add('active');

  // Update nav active state
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  const navKey = viewId === 'course-detail' ? 'courses' : viewId;
  document.getElementById(`nav-${navKey}`)?.classList.add('active');

  // Mount view module into its content container
  const mod = _registry.get(viewId);
  const container = el.querySelector('[data-view-content]') || el.firstElementChild;
  if (mod && container) {
    const cleanup = mod.mount(container, params);
    _mounted.set(viewId, cleanup || null);
  }

  // Animate on next frame
  requestAnimationFrame(() => {
    el.classList.add('view-animate');
    animateStaggerItems(el);
    animateProgressBars(el);
  });
}

// Expose globally so onclick="navigate(...)" in HTML still works during transition
window.navigate = navigate;
