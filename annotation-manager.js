/**
 * annotation-manager.js
 * ─────────────────────────────────────────────────────────────────
 * Chart-agnostic annotation framework.
 *
 * Responsibilities:
 *   - Render persistent Kendo-spec popover cards (.k-popover DOM)
 *   - Draw SVG connector lines from card → anchor point
 *   - Support multiple annotations visible simultaneously
 *   - Expose update(key, screenPos) so any adapter can reposition
 *     cards after pan / zoom / scroll
 *   - No knowledge of GoJS, Highcharts, or any specific chart lib
 *
 * Usage:
 *   const mgr = new AnnotationManager(containerEl);
 *   mgr.add(key, metadata, screenPos);   // show annotation
 *   mgr.remove(key);                     // hide annotation
 *   mgr.update(key, newScreenPos);       // reposition on pan/zoom
 *   mgr.toggle(key, metadata, screenPos);// add or remove
 *   mgr.clear();                         // remove all
 * ─────────────────────────────────────────────────────────────────
 */
class AnnotationManager {
  /**
   * @param {HTMLElement} container  - The positioned parent element
   *   (position:relative/absolute). Popovers are absolutely placed
   *   inside this element so they scroll/pan with the container.
   */
  constructor(container) {
    this._container = container;

    // Inject required CSS once (idempotent)
    AnnotationManager._injectStyles();

    // SVG layer for connector lines — sits above container content
    this._svg = this._createSVGLayer();
    container.appendChild(this._svg);

    // Popover DOM layer — sits above SVG
    this._layer = document.createElement("div");
    this._layer.className = "ann-layer";
    this._layer.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;";
    container.appendChild(this._layer);

    // Map of key → { el, line, meta, pos }
    this._annotations = {};
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Add a persistent annotation anchored at screenPos.
   * @param {string} key         - Unique ID (e.g. node key or point id)
   * @param {object} meta        - { title, rows: [{label,value}], note, color, status }
   * @param {{x,y}} screenPos    - Pixel offset inside container
   */
  add(key, meta, screenPos) {
    if (this._annotations[key]) this.remove(key); // replace if exists

    const el   = this._buildPopover(key, meta);
    const line = this._buildConnectorLine(meta.color || "#888");

    this._layer.appendChild(el);
    this._svg.appendChild(line);

    // Initial position — offset to the right of anchor by default
    const pos = this._clampPos(screenPos, el);
    el.style.left = (pos.x + 16) + "px";
    el.style.top  = (pos.y - 50) + "px";

    this._annotations[key] = { el, line, meta, pos: screenPos };
    this._updateLine(key);
  }

  /**
   * Remove annotation by key.
   * @param {string} key
   */
  remove(key) {
    const ann = this._annotations[key];
    if (!ann) return;
    this._layer.removeChild(ann.el);
    this._svg.removeChild(ann.line);
    delete this._annotations[key];
  }

  /**
   * Toggle annotation — add if absent, remove if present.
   * @param {string} key
   * @param {object} meta
   * @param {{x,y}} screenPos
   */
  toggle(key, meta, screenPos) {
    if (this._annotations[key]) {
      this.remove(key);
    } else {
      this.add(key, meta, screenPos);
    }
  }

  /**
   * Update anchor position (call this on pan / zoom / scroll).
   * @param {string} key
   * @param {{x,y}} newScreenPos - New pixel offset inside container
   */
  update(key, newScreenPos) {
    const ann = this._annotations[key];
    if (!ann) return;
    ann.pos = newScreenPos;
    this._updateLine(key);
  }

  /**
   * Update all annotation positions — call after a bulk viewport change.
   * @param {function} posResolver  - fn(key) => {x,y} | null
   */
  updateAll(posResolver) {
    Object.keys(this._annotations).forEach(key => {
      const pos = posResolver(key);
      if (pos) this.update(key, pos);
    });
  }

  /** Remove every annotation. */
  clear() {
    Object.keys(this._annotations).forEach(k => this.remove(k));
  }

  /** Returns true if an annotation exists for key. */
  has(key) {
    return !!this._annotations[key];
  }

  /** Returns array of active keys. */
  activeKeys() {
    return Object.keys(this._annotations);
  }

  // ─── Private helpers ───────────────────────────────────────────

  /**
   * Build a Kendo-spec .k-popover DOM element.
   * Matches exact class structure Kendo UI emits so real Kendo CSS
   * drops in without JS changes.
   */
  _buildPopover(key, meta) {
    const statusColors = { Healthy:"#1D9E75", Degraded:"#EF9F27", Down:"#E24B4A" };
    const statusDot = meta.status
      ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;
           background:${statusColors[meta.status]||'#aaa'};margin-right:4px;vertical-align:middle;"></span>`
      : "";

    // Build body rows from meta.rows array
    const rowsHTML = (meta.rows || []).map(r =>
      `<div class="k-pop-row">
        <span class="k-pop-label">${r.label}</span>
        <span class="k-pop-val">${r.value}</span>
      </div>`
    ).join("");

    const noteHTML = meta.note
      ? `<div class="k-pop-note">${meta.note}</div>` : "";

    const el = document.createElement("div");
    el.className = "k-popover k-popover-right";
    el.dataset.annKey = key;
    el.innerHTML = `
      <div class="k-popover-callout"></div>
      <div class="k-popover-inner">
        <div class="k-popover-header">
          <span class="k-popover-title">
            <span class="k-pop-dot" style="background:${meta.color||'#888'};"></span>
            ${meta.title || key}
          </span>
          <button class="k-popover-close" data-key="${key}" title="Close">×</button>
        </div>
        <div class="k-popover-body">
          ${rowsHTML}
          ${noteHTML}
        </div>
      </div>`;

    // Close button
    el.querySelector(".k-popover-close").addEventListener("click", e => {
      e.stopPropagation();
      this.remove(e.currentTarget.dataset.key);
    });

    // Make draggable — user can reposition cards freely
    this._makeDraggable(el, key);

    return el;
  }

  /** Create an SVG <line> element for the connector. */
  _buildConnectorLine(color) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-dasharray", "5,3");
    line.setAttribute("opacity", "0.55");
    return line;
  }

  /**
   * Recalculate connector line endpoints.
   * Line runs from anchor (node/point centre) → left edge of popover card.
   */
  _updateLine(key) {
    const ann = this._annotations[key];
    if (!ann) return;

    const { el, line, pos } = ann;
    const cardLeft = parseFloat(el.style.left) || 0;
    const cardTop  = parseFloat(el.style.top)  || 0;
    const cardH    = el.offsetHeight || 120;

    // Connect to vertical midpoint on card's left edge
    const endX = cardLeft;
    const endY = cardTop + cardH / 2;

    line.setAttribute("x1", pos.x);
    line.setAttribute("y1", pos.y);
    line.setAttribute("x2", endX);
    line.setAttribute("y2", endY);
  }

  /**
   * Clamp initial popover position so it doesn't overflow the container.
   */
  _clampPos(screenPos, el) {
    const cw = this._container.offsetWidth;
    const ch = this._container.offsetHeight;
    const pw = 210, ph = 150; // estimated popover size
    return {
      x: Math.max(4, Math.min(cw - pw - 20, screenPos.x)),
      y: Math.max(4, Math.min(ch - ph - 4,  screenPos.y)),
    };
  }

  /** Make a popover card draggable within the container. */
  _makeDraggable(el, key) {
    el.style.cursor = "move";
    let startX, startY, startL, startT;

    el.addEventListener("mousedown", e => {
      // Don't drag when clicking the close button
      if (e.target.classList.contains("k-popover-close")) return;
      e.stopPropagation();

      startX = e.clientX;
      startY = e.clientY;
      startL = parseFloat(el.style.left) || 0;
      startT = parseFloat(el.style.top)  || 0;

      const onMove = ev => {
        el.style.left = (startL + ev.clientX - startX) + "px";
        el.style.top  = (startT + ev.clientY - startY) + "px";
        this._updateLine(key); // keep connector in sync while dragging
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  /** Create the SVG overlay layer for connector lines. */
  _createSVGLayer() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;";
    return svg;
  }

  /** Inject Kendo-spec CSS once into the document head. */
  static _injectStyles() {
    if (document.getElementById("ann-manager-styles")) return; // idempotent
    const style = document.createElement("style");
    style.id = "ann-manager-styles";
    style.textContent = `
      /* ── Kendo Popover spec ───────────────────────────── */
      .k-popover {
        position: absolute;
        width: 200px;
        background: #fff;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        box-shadow: 0 3px 12px rgba(0,0,0,0.12);
        pointer-events: all;
        font-size: 12px;
        font-family: sans-serif;
        z-index: 100;
      }
      .k-popover.k-popover-right  { margin-left: 10px; }
      .k-popover.k-popover-left   { margin-right: 10px; }
      .k-popover.k-popover-top    { margin-bottom: 10px; }
      .k-popover.k-popover-bottom { margin-top: 10px; }

      /* Arrow: rotated square mimicking Kendo's callout */
      .k-popover-callout {
        position: absolute;
        width: 10px; height: 10px;
        background: #fff;
        border: 1px solid #e0e0e0;
        transform: rotate(45deg);
      }
      .k-popover-right  .k-popover-callout { left:-6px; top:50%; margin-top:-5px; border-right:none; border-top:none; }
      .k-popover-left   .k-popover-callout { right:-6px; top:50%; margin-top:-5px; border-left:none; border-bottom:none; }
      .k-popover-top    .k-popover-callout { bottom:-6px; left:50%; margin-left:-5px; border-left:none; border-top:none; }
      .k-popover-bottom .k-popover-callout { top:-6px; left:50%; margin-left:-5px; border-right:none; border-bottom:none; }

      .k-popover-inner  { border-radius: 6px; overflow: hidden; }
      .k-popover-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 7px 10px 5px;
        border-bottom: 1px solid #f0f0f0;
        background: #fafafa;
      }
      .k-popover-title {
        font-size: 12px; font-weight: 600;
        color: #222;
        display: flex; align-items: center; gap: 6px;
      }
      .k-pop-dot {
        display: inline-block; width: 9px; height: 9px;
        border-radius: 50%; flex-shrink: 0;
      }
      .k-popover-close {
        background: none; border: none; cursor: pointer;
        font-size: 15px; line-height: 1; padding: 0 2px; color: #aaa;
      }
      .k-popover-close:hover { color: #333; }
      .k-popover-body { padding: 6px 10px 8px; }
      .k-pop-row {
        display: flex; justify-content: space-between;
        padding: 3px 0;
        border-bottom: 0.5px solid #f0f0f0;
        font-size: 11px;
      }
      .k-pop-row:last-of-type { border-bottom: none; }
      .k-pop-label { color: #888; }
      .k-pop-val   { font-weight: 500; color: #222; }
      .k-pop-note  { font-size: 10px; color: #aaa; font-style: italic; margin-top: 5px; }
    `;
    document.head.appendChild(style);
  }
}
