/**
 * gojs-annotation-adapter.js
 * ─────────────────────────────────────────────────────────────────
 * Adapter that connects a GoJS Diagram to AnnotationManager.
 *
 * Responsibilities:
 *   - Convert GoJS node positions (doc coords) → screen px inside container
 *   - Listen to GoJS events (click, pan, zoom, move) and forward to manager
 *   - Build annotation metadata from GoJS node data
 *
 * Usage:
 *   const adapter = new GoJSAnnotationAdapter(diagram, container, manager);
 *   adapter.setMetaBuilder(nodeData => ({ title, rows, note, color, status }));
 *   adapter.attach(); // wire up all GoJS listeners
 * ─────────────────────────────────────────────────────────────────
 */
class GoJSAnnotationAdapter {
  /**
   * @param {go.Diagram}         diagram    - GoJS diagram instance
   * @param {HTMLElement}        container  - Same container passed to AnnotationManager
   * @param {AnnotationManager}  manager    - Shared AnnotationManager instance
   */
  constructor(diagram, container, manager) {
    this._diagram   = diagram;
    this._container = container;
    this._manager   = manager;

    // Default meta builder — override with setMetaBuilder()
    this._metaBuilder = data => ({
      title:  data.key,
      color:  data.color || "#888",
      status: data.status || null,
      note:   data.note   || null,
      rows: [
        { label: "Key",  value: data.key },
      ],
    });
  }

  /**
   * Set a custom function that converts GoJS node.data → annotation metadata.
   * @param {function} fn  - (nodeData) => { title, color, status, note, rows[] }
   */
  setMetaBuilder(fn) {
    this._metaBuilder = fn;
  }

  /** Wire all GoJS event listeners. Call once after diagram is ready. */
  attach() {
    const diagram = this._diagram;
    const manager = this._manager;

    // Click on a node → toggle its annotation
    diagram.addDiagramListener("ObjectSingleClicked", e => {
      const part = e.subject.part;
      if (!(part instanceof go.Node)) return;

      const key  = part.data.key;
      const meta = this._metaBuilder(part.data);
      const pos  = this._nodeScreenPos(key);
      if (pos) manager.toggle(key, meta, pos);
    });

    // Pan / zoom → reposition all active annotations
    diagram.addDiagramListener("ViewportBoundsChanged", () => {
      manager.updateAll(key => this._nodeScreenPos(key));
    });

    // Layout finishes → reposition (initial render)
    diagram.addDiagramListener("LayoutCompleted", () => {
      manager.updateAll(key => this._nodeScreenPos(key));
    });

    // Node dragged → reposition its annotation
    diagram.addDiagramListener("SelectionMoved", () => {
      manager.updateAll(key => this._nodeScreenPos(key));
    });
  }

  /**
   * Convert a GoJS node's centre from diagram-doc coordinates
   * to pixel offset inside the container element.
   *
   * @param  {string} key  - GoJS node key
   * @returns {{x,y}|null}
   */
  _nodeScreenPos(key) {
    const node = this._diagram.findNodeForKey(key);
    if (!node) return null;

    const nb = node.actualBounds;
    // transformDocToView: doc coords → GoJS canvas viewport px
    const vp = this._diagram.transformDocToView(
      new go.Point(nb.centerX, nb.centerY)
    );

    // Adjust for container offset vs diagramDiv offset
    const diagramDiv = this._diagram.div;
    const dr = diagramDiv.getBoundingClientRect();
    const wr = this._container.getBoundingClientRect();

    return {
      x: dr.left - wr.left + vp.x,
      y: dr.top  - wr.top  + vp.y,
    };
  }
}
