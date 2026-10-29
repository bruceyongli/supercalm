import { escapeHtml as esc } from './common.js';
import { sessionFamilies, isLiveSession, needsSessionAttention } from './session-family.js';
import { splitSessionRecency } from './session-recency.js';
import { sessionIndicator } from './session-indicator.js';

const EXPANSION_KEY = 'aios.session-groups.v1';
let expansions = {};
try { const saved = JSON.parse(localStorage.getItem(EXPANSION_KEY) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) expansions = saved; } catch {}
const mounted = new WeakSet(), selected = new WeakMap();

function remember(key, open) {
  delete expansions[key]; expansions[key] = !!open;
  expansions = Object.fromEntries(Object.entries(expansions).slice(-256));
  try { localStorage.setItem(EXPANSION_KEY, JSON.stringify(expansions)); } catch {}
}

function nodeFor(spec) {
  const template = document.createElement('template'); template.innerHTML = spec.html.trim();
  const node = template.content.firstElementChild;
  node.dataset.key = spec.key; node.dataset.render = spec.html;
  return node;
}
// Session rows contain display-only elements. Patch in place so status pulses keep their phase.
function patchDisplay(current, next) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next); return; }
  if (current.nodeType === 3) { if (current.data !== next.data) current.data = next.data; return; }
  if (current.nodeType !== 1) return;
  for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  for (const attr of next.attributes) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  const old = [...current.childNodes], fresh = [...next.childNodes];
  fresh.forEach((child, index) => old[index] ? patchDisplay(old[index], child) : current.appendChild(child));
  old.slice(fresh.length).forEach(child => child.remove());
}

// One keyed pool for the entire list, including Older and Stopped. Moving between these containers
// preserves the row, live CPU values, status dot, keyboard focus and disclosure state.
function reconcileTree(container, specs, patchRow) {
  const pool = new Map([...container.querySelectorAll('[data-key]')].map(node => [node.dataset.key, node]));
  const used = new Set();
  const focus = container.contains(document.activeElement) ? document.activeElement : null;
  function visit(target, items) {
    items.forEach((spec, index) => {
      let node = pool.get(spec.key);
      if (!node) { node = nodeFor(spec); spec.created?.(node); }
      else if (node.dataset.render !== spec.html) {
        const fresh = nodeFor(spec);
        if (!patchRow?.(node, fresh)) patchDisplay(node, fresh);
        node.dataset.render = spec.html;
      }
      used.add(spec.key);
      if (target.children[index] !== node) target.insertBefore(node, target.children[index] || null);
      spec.update?.(node);
      for (const [selector, children] of spec.slots || []) visit(node.querySelector(selector), children);
    });
  }
  visit(container, specs);
  for (const [key, node] of pool) if (!used.has(key)) node.remove();
  if (focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
}

export function renderGroupedSessionList(container, sessions, {
  rowSpec, patchRow = null, mode = 'rail', activeId = null, stoppedExpanded = false, onStoppedToggle = null,
} = {}) {
  if (!container) return;
  if (!mounted.has(container)) {
    mounted.add(container);
    // Native `toggle` is queued: an immediate navigation can happen before it saves.
    // Commit the user's choice in the click (also emitted by Enter/Space), while
    // retaining toggle for programmatic opening and the telemetry visibility hook.
    container.addEventListener('click', event => {
      const summary = event.target.closest?.('summary');
      const details = summary?.parentElement;
      const key = details?.dataset?.agentDisclosure;
      if (!key || event.defaultPrevented || event.button > 0 || event.target.closest?.('a,button,input,select,textarea')) return;
      event.preventDefault();
      details.open = !details.open;
      remember(key, details.open);
    });
    container.addEventListener('toggle', event => {
      const key = event.target?.dataset?.agentDisclosure;
      if (key) remember(key, event.target.open);
    }, true);
  }
  const followSelected = selected.get(container) !== activeId;
  selected.set(container, activeId);
  const all = sessionFamilies(sessions);
  const live = all.filter(f => f.live.length);
  const stopped = all.filter(f => !f.live.length);
  const row = s => ({ ...rowSpec(s), key: `row:${s.id}` });
  const restoreDisclosure = (node, key) => { node.dataset.agentDisclosure = key; node.open = expansions[key] === true; };
  const familySpec = family => {
    if (!family.helpers.length) return row(family.root);
    const active = family.helpers.filter(isLiveSession), inactive = family.helpers.filter(s => !isLiveSession(s));
    const needs = family.helpers.filter(s => needsSessionAttention(s) && !sessionIndicator(s).blocked).length;
    const blocked = family.helpers.filter(s => sessionIndicator(s).blocked).length;
    return {
      key: `family:${family.id}`,
      html: `<section class="dk-agent-group" data-agent-family="${esc(family.id)}">
        <div data-agent-root></div>
        <details class="dk-agent-helpers"><summary><span data-helper-count></span><span class="dk-helper-alerts"><span data-helper-needs></span><span data-helper-blocked></span></span></summary>
          <div class="dk-agent-children" data-agent-active></div>
          <details class="dk-agent-stopped"><summary>Stopped helpers <span data-helper-stopped-count></span></summary><div class="dk-agent-children" data-agent-stopped></div></details>
        </details>
      </section>`,
      created(node) {
        restoreDisclosure(node.querySelector('.dk-agent-helpers'), `${mode}:${family.id}`);
        restoreDisclosure(node.querySelector('.dk-agent-stopped'), `${mode}:stopped:${family.id}`);
      },
      update(node) {
        node.querySelector('[data-helper-count]').textContent = `${family.helpers.length} ${family.helpers.length === 1 ? 'helper' : 'helpers'}`;
        node.querySelector('[data-helper-needs]').textContent = needs ? `${needs} needs you` : '';
        node.querySelector('[data-helper-blocked]').textContent = blocked ? `${blocked} blocked` : '';
        node.querySelector('[data-helper-stopped-count]').textContent = inactive.length;
        node.querySelector('.dk-agent-stopped').hidden = !inactive.length;
        if (followSelected && family.helpers.some(s => s.id === activeId)) {
          node.querySelector('.dk-agent-helpers').open = true;
          if (inactive.some(s => s.id === activeId)) node.querySelector('.dk-agent-stopped').open = true;
        }
      },
      slots: [['[data-agent-root]', [row(family.root)]], ['[data-agent-active]', active.map(row)], ['[data-agent-stopped]', inactive.map(row)]],
    };
  };
  const { recent, older } = splitSessionRecency(live);
  const specs = recent.map(familySpec);
  if (older.length) specs.push({
    key: 'older:live',
    html: `<details class="dk-older ${mode === 'rail' ? 'dk-older-rail' : ''}" id="${mode === 'rail' ? 'dk-older-side' : 'dk-older-live'}"><summary>Older sessions <span data-older-count></span></summary><div class="dk-sessions" data-older-rows></div></details>`,
    update(node) {
      node.querySelector('[data-older-count]').textContent = older.reduce((n, family) => n + family.live.length, 0);
      if (followSelected && older.some(f => f.members.some(s => s.id === activeId))) node.open = true;
    },
    slots: [['[data-older-rows]', older.map(familySpec)]],
  });
  if (mode !== 'rail' && stopped.length) {
    specs.push({ key: 'stopped:header', html: `<div class="dk-sec-row dk-sec-row-sub">STOPPED · ${stopped.reduce((n, f) => n + f.members.length, 0)}</div>` });
    specs.push(...(stoppedExpanded ? stopped : stopped.slice(0, 10)).map(familySpec));
    if (stopped.length > 10) specs.push({ key: 'stopped:toggle', html: `<button class="dk-show-more" data-dk-stopped-toggle>${stoppedExpanded ? 'show fewer' : `show all ${stopped.length} stopped tasks`}</button>` });
  }
  if (!specs.length && mode === 'rail') specs.push({ key: 'empty', html: '<div class="dk-empty-side">no live sessions</div>' });
  reconcileTree(container, specs, patchRow);
  const toggle = container.querySelector('[data-dk-stopped-toggle]');
  if (toggle) toggle.onclick = onStoppedToggle;
}

export function parentContextHtml(session, sessions) {
  if (!session?.parent_session_id || session.parent_session_id === session.id) return '';
  const parent = sessions.find(s => s.id === session.parent_session_id);
  const label = String(parent?.title || parent?.project || session.parent_session_id).trim().split('\n')[0];
  return `<div class="dk-parent-context">Helper for <a href="session?id=${esc(session.parent_session_id)}" title="${esc(label)}">${esc(label)}</a></div>`;
}
