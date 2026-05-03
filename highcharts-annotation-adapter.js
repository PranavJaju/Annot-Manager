/**
 * highcharts-annotation-adapter.js
 * ─────────────────────────────────────────────────────────────────
 * Adapter that connects a Highcharts chart to AnnotationManager.
 *
 * Responsibilities:
 *   - Convert Highcharts point pixel position → screen px inside container
 *   - Listen to point click and chart redraw/zoom/pan events
 *   - Build annotation metadata from Highcharts point data
 *
 * Usage:
 *   const adapter = new HighchartsAnnotationAdapter(chart, container, manager);
 *   adapter.setMetaBuilder(point => ({ title, rows, note, color, status }));
 *   adapter.attach(); // wire up all Highcharts listeners
 *
 * Note: Highcharts does not fire a single "viewport changed" event for pan/zoom.
 *   We use chart.redraw + setExtremes callbacks instead. For smooth connector
 *   tracking during zoom animations, requestAnimationFrame polling is used
 *   temporarily.
 * ─────────────────────────────────────────────────────────────────
 */
class HighchartsAnnotationAdapter {
  /**
   * @param {Highcharts.Chart}   chart      - Highcharts chart instance
   * @param {HTMLElement}        container  - Same container passed to AnnotationManager
   * @param {AnnotationManager}  manager    - Shared AnnotationManager instance
   */
  constructor(chart, container, manager) {
    this._chart     = chart;
    this._container = container;
    this._manager   = manager;

    // Map of annotation key → Highcharts point reference
    // Needed so we can re-resolve positions after zoom/pan
    this._pointMap = {};

    // Default meta builder — override via setMetaBuilder()
    this._metaBuilder = point => ({
      title:  point.name || point.category || String(point.index),
      color:  point.color || point.series?.color || "#378ADD",
      status: null,
      note:   null,
      rows: [
        { label: "Series", value: point.series?.name || "—"   },
        { label: "Value",  value: point.y             ?? "—"  },
        { label: "X",      value: point.x             ?? "—"  },
      ],
    });

    // rAF handle for zoom animation tracking
    this._rafHandle = null;
  }

  /**
   * Set a custom function that converts a Highcharts point → annotation metadata.
   * @param {function} fn  - (point) => { title, color, status, note, rows[] }
   */
  setMetaBuilder(fn) {
    this._metaBuilder = fn;
  }

  /** Wire all Highcharts event listeners. Call once after chart is rendered. */
  attach() {
    const chart   = this._chart;
    const manager = this._manager;

    // ── Point click → toggle annotation ───────────────────────────
    chart.series.forEach(series => {
      series.points.forEach(point => this._bindPointClick(point));
    });

    // Also handle future series/points added dynamically
    Highcharts.addEvent(chart, "addSeries", () => {
      // Re-bind after series is added (Highcharts defers point creation)
      setTimeout(() => {
        chart.series.forEach(s =>
          s.points.forEach(p => { if (!p._annBound) this._bindPointClick(p); })
        );
      }, 100);
    });

    // ── Zoom / pan → reposition annotations ───────────────────────
    // Highcharts fires 'afterSetExtremes' on each axis when zoomed/panned
    chart.axes.forEach(axis => {
      Highcharts.addEvent(axis, "afterSetExtremes", () => {
        this._trackDuringAnimation();
      });
    });

    // Catch chart redraws (resize, responsive reflow, etc.)
    Highcharts.addEvent(chart, "redraw", () => {
      this._updateAll();
    });

    // Catch chart resize
    Highcharts.addEvent(chart, "render", () => {
      this._updateAll();
    });
  }

  // ─── Private helpers ───────────────────────────────────────────

  /** Bind click handler to a single point (idempotent). */
  _bindPointClick(point) {
    if (point._annBound) return;
    point._annBound = true;

    Highcharts.addEvent(point, "click", () => {
      // Unique key: seriesName + pointIndex
      const key  = `${point.series.name}::${point.index}`;
      const meta = this._metaBuilder(point);
      const pos  = this._pointScreenPos(point);

      if (pos) {
        // Store point reference for later repositioning
        this._pointMap[key] = point;
        this._manager.toggle(key, meta, pos);
      }
    });
  }

  /**
   * Convert a Highcharts point's pixel position → offset inside container.
   * Highcharts exposes point.plotX / point.plotY (relative to plot area),
   * and chart.plotLeft / chart.plotTop for the plot area offset.
   *
   * @param  {Highcharts.Point} point
   * @returns {{x,y}|null}
   */
  _pointScreenPos(point) {
    if (point.plotX == null || point.plotY == null) return null;

    const chart = this._chart;
    // plotX/Y are relative to the plot area; add plotLeft/Top for chart offset
    const chartX = chart.plotLeft + point.plotX;
    const chartY = chart.plotTop  + point.plotY;

    // chart.container is the Highcharts root div
    const cr = chart.container.getBoundingClientRect();
    const wr = this._container.getBoundingClientRect();

    return {
      x: cr.left - wr.left + chartX,
      y: cr.top  - wr.top  + chartY,
    };
  }

  /** Reposition all active Highcharts annotations. */
  _updateAll() {
    this._manager.updateAll(key => {
      const point = this._pointMap[key];
      return point ? this._pointScreenPos(point) : null;
    });
  }

  /**
   * During zoom animations Highcharts redraws multiple frames.
   * We poll with rAF for ~400ms to keep connectors smooth.
   */
  _trackDuringAnimation() {
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    const end = Date.now() + 400;
    const tick = () => {
      this._updateAll();
      if (Date.now() < end) this._rafHandle = requestAnimationFrame(tick);
    };
    tick();
  }
}
