// SPDX-License-Identifier: GPL-3.0-or-later
// Safe DOM helpers. All text goes through textContent; no HTML string is ever parsed by these scripts.
(function () {
  'use strict';
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'class') node.className = String(v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function setText(node, s) { var t = String(s); if (node.textContent !== t) node.textContent = t; }
  window.Dom = { el: el, clear: clear, setText: setText };
})();
