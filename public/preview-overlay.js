/**
 * CMS preview overlay — injected by the preview sidecar into every page
 * served from <branch>.BASE_DOMAIN. Plain ES2020, no build step. It must
 * NEVER break the host page: everything is wrapped in try/catch and the
 * script stays dormant unless it runs inside the CMS workspace iframe.
 *
 * Protocol (postMessage to window.parent, targetOrigin '*', no secrets):
 *   → {type:'cms:navigation', url, route}
 *   → {type:'cms:selection', anchor:{exact,prefix,suffix,cssPath}, url, route}
 *   → {type:'cms:element', element:{tag,id,classes,headingPath,outerHtmlExcerpt}, url, route}
 *   → {type:'cms:pick-cancel'}                      (Esc during element pick)
 *   ← {type:'cms:start-element-pick'}               (from the workspace)
 */
(function () {
  'use strict';

  try {
    if (window.parent === window) return; // not framed → dormant
  } catch (e) {
    return;
  }

  var MAX_EXACT = 500;
  var MAX_AFFIX = 30;

  function post(msg) {
    try {
      window.parent.postMessage(msg, '*');
    } catch (e) { /* ignore */ }
  }

  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) { /* never break the host page */ }
    };
  }

  // ── Styles ────────────────────────────────────────────────────────────
  try {
    var style = document.createElement('style');
    style.setAttribute('data-cms-overlay', '');
    style.textContent =
      '.cms-ov-btn{position:absolute;z-index:2147483646;padding:4px 10px;border-radius:999px;' +
      'border:1px solid #7852ee;background:#1e1e1e;color:#eee;font:12px/1.4 system-ui,sans-serif;' +
      'cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap}' +
      '.cms-ov-btn:hover{background:#2a2a2a}' +
      '.cms-ov-hl{position:fixed;z-index:2147483645;pointer-events:none;' +
      'outline:2px solid #7852ee;outline-offset:-1px;background:rgba(120,82,238,.12);border-radius:2px}';
    (document.head || document.documentElement).appendChild(style);
  } catch (e) { /* ignore */ }

  function isOurs(node) {
    return !!(node && node.getAttribute &&
      (node.hasAttribute('data-cms-overlay') || (node.closest && node.closest('[data-cms-overlay]'))));
  }

  // ── Navigation reporting ──────────────────────────────────────────────
  var nav = safe(function () {
    post({ type: 'cms:navigation', url: location.href, route: location.pathname });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', nav);
  } else {
    nav();
  }
  document.addEventListener('astro:page-load', nav);
  window.addEventListener('popstate', nav);
  try {
    var origPushState = history.pushState;
    history.pushState = function () {
      var r = origPushState.apply(this, arguments);
      nav();
      return r;
    };
  } catch (e) { /* ignore */ }

  // ── Simple CSS path ───────────────────────────────────────────────────
  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + '#' + node.id);
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = 0, index = 0, children = parent.children;
        for (var i = 0; i < children.length; i++) {
          if (children[i].tagName === node.tagName) {
            sameTag++;
            if (children[i] === node) index = sameTag;
          }
        }
        if (sameTag > 1) part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // ── Text selection → "Chat about this" button ─────────────────────────
  var selBtn = null;
  var selDebounce = null;

  function hideSelBtn() {
    if (selBtn && selBtn.parentNode) selBtn.parentNode.removeChild(selBtn);
    selBtn = null;
  }

  function buildAnchor(sel) {
    var exact = sel.toString();
    if (!exact.trim()) return null;
    var anchor = { exact: exact.slice(0, MAX_EXACT), prefix: '', suffix: '' };
    try {
      var range = sel.getRangeAt(0);
      var sc = range.startContainer, ec = range.endContainer;
      if (sc.nodeType === 3) {
        anchor.prefix = (sc.textContent || '').slice(Math.max(0, range.startOffset - MAX_AFFIX), range.startOffset);
      }
      if (ec.nodeType === 3) {
        anchor.suffix = (ec.textContent || '').slice(range.endOffset, range.endOffset + MAX_AFFIX);
      }
      var el = sc.nodeType === 1 ? sc : sc.parentElement;
      if (el) anchor.cssPath = cssPath(el);
    } catch (e) { /* partial anchor is fine */ }
    return anchor;
  }

  var showSelBtn = safe(function () {
    hideSelBtn();
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var anchor = buildAnchor(sel);
    if (!anchor) return;

    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cms-ov-btn';
    btn.setAttribute('data-cms-overlay', '');
    btn.textContent = '💬 Chat about this';
    btn.style.left = Math.max(4, rect.left + window.scrollX) + 'px';
    btn.style.top = Math.max(4, rect.bottom + window.scrollY + 6) + 'px';
    btn.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
    btn.addEventListener('click', safe(function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      post({ type: 'cms:selection', anchor: anchor, url: location.href, route: location.pathname });
      hideSelBtn();
      try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
    }));
    document.body.appendChild(btn);
    selBtn = btn;
  });

  function queueSelBtn() {
    if (selDebounce) clearTimeout(selDebounce);
    selDebounce = setTimeout(showSelBtn, 250);
  }

  document.addEventListener('mouseup', safe(function (ev) {
    if (isOurs(ev.target)) return;
    queueSelBtn();
  }));
  document.addEventListener('selectionchange', safe(function () {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) hideSelBtn();
    else queueSelBtn();
  }));

  // ── Element picker ────────────────────────────────────────────────────
  var picking = false;
  var hlBox = null;

  function ensureHlBox() {
    if (!hlBox) {
      hlBox = document.createElement('div');
      hlBox.className = 'cms-ov-hl';
      hlBox.setAttribute('data-cms-overlay', '');
      document.body.appendChild(hlBox);
    }
    return hlBox;
  }

  function moveHlBox(el) {
    var box = ensureHlBox();
    var r = el.getBoundingClientRect();
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    box.style.display = 'block';
  }

  function stopPick(cancelled) {
    picking = false;
    if (hlBox && hlBox.parentNode) hlBox.parentNode.removeChild(hlBox);
    hlBox = null;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
    if (cancelled) post({ type: 'cms:pick-cancel' });
  }

  function headingPathFor(el) {
    var headings = [];
    try {
      var all = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
      for (var i = 0; i < all.length; i++) {
        var h = all[i];
        // headings that precede (or contain) the element in document order
        var pos = h.compareDocumentPosition(el);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING || pos & Node.DOCUMENT_POSITION_CONTAINED_BY) {
          headings.push((h.textContent || '').trim().slice(0, 120));
        }
      }
    } catch (e) { /* ignore */ }
    return headings.slice(-3);
  }

  function elementInfo(el) {
    var info = { tag: el.tagName.toLowerCase() };
    if (el.id) info.id = el.id;
    try {
      var classes = Array.prototype.slice.call(el.classList, 0, 5);
      if (classes.length) info.classes = classes;
    } catch (e) { /* ignore */ }
    info.headingPath = headingPathFor(el);
    try {
      var html = el.outerHTML || '';
      html = html.replace(/<script[\s\S]*?(?:<\/script>|$)/gi, '');
      info.outerHtmlExcerpt = html.slice(0, 500);
    } catch (e) { /* ignore */ }
    return info;
  }

  var onPickMove = safe(function (ev) {
    if (!picking) return;
    var el = ev.target;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    moveHlBox(el);
  });

  var onPickClick = safe(function (ev) {
    if (!picking) return;
    ev.preventDefault();
    ev.stopPropagation();
    var el = ev.target;
    if (!el || el.nodeType !== 1 || isOurs(el)) return;
    post({
      type: 'cms:element',
      element: elementInfo(el),
      url: location.href,
      route: location.pathname,
    });
    stopPick(false);
  });

  var onPickKey = safe(function (ev) {
    if (picking && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      stopPick(true);
    }
  });

  var startPick = safe(function () {
    if (picking) return;
    picking = true;
    ensureHlBox();
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
  });

  window.addEventListener('message', safe(function (ev) {
    var data = ev.data;
    if (data && typeof data === 'object' && data.type === 'cms:start-element-pick') {
      startPick();
    }
  }));
})();
