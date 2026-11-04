// Sidebar panel for the Matchmaker tool: status circle and issues, the
// buttons (Align start points, Match segment, Reorder contours, Force match
// masters), master visibility and selection, the selected master's contour
// list, the view options and a short help.

import { contourSignature, isOnCurve } from "./contour-ops.js";

const PANEL_TAG = "curvekit-matchmaker-panel";

const EYE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.6 3.5M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>`;

const styles = `
  :host {
    display: block;
    height: 100%;
    overflow: hidden auto;
    color: var(--ui-element-foreground-color);
    font-size: 0.9em;
  }
  .section {
    padding: 1em;
    display: flex;
    flex-direction: column;
    gap: 0.6em;
  }
  .title {
    font-weight: bold;
  }
  .subtitle {
    font-weight: bold;
    margin-top: 0.4em;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.5em;
  }
  .status-dot {
    width: 0.9em;
    height: 0.9em;
    border-radius: 50%;
    background-color: #999;
    flex-shrink: 0;
  }
  .status-dot.ok {
    background-color: #1da346;
  }
  .status-dot.bad {
    background-color: #e5484d;
  }
  ul.issues {
    margin: 0;
    padding-left: 1.2em;
  }
  ul.issues li {
    margin: 0.15em 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid #8884;
    border-radius: 0.25em;
  }
  .row {
    display: grid;
    align-items: center;
    gap: 0.4em;
    padding: 0.2em 0.4em;
    margin: 0;
    user-select: none;
  }
  .row + .row {
    border-top: 1px solid #8882;
  }
  .master-row {
    grid-template-columns: auto auto 1fr auto;
    cursor: pointer;
  }
  .master-row.selected {
    background-color: #2f7cf622;
  }
  .master-row.hidden-layer .master-name,
  .master-row.hidden-layer .swatch {
    opacity: 0.4;
  }
  .contour-row {
    grid-template-columns: auto auto 1fr auto auto auto;
    cursor: grab;
  }
  .contour-row.dragging {
    opacity: 0.4;
  }
  .contour-row.drop-before {
    box-shadow: inset 0 2px 0 #2f7cf6;
  }
  .contour-row.drop-after {
    box-shadow: inset 0 -2px 0 #2f7cf6;
  }
  .grip {
    opacity: 0.5;
    letter-spacing: -0.15em;
  }
  .index {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
    min-width: 1.2em;
    text-align: right;
  }
  .info {
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .match.ok {
    color: #1da346;
  }
  .match.bad {
    color: #e5484d;
  }
  .swatch {
    display: inline-block;
    width: 1.2em;
    height: 0.3em;
    border-radius: 0.1em;
  }
  .master-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted {
    opacity: 0.6;
  }
  .groups {
    display: flex;
    gap: 1em;
  }
  .group::before {
    content: "";
    display: inline-block;
    width: 0.7em;
    height: 0.7em;
    border-radius: 50%;
    margin-right: 0.35em;
    vertical-align: -0.05em;
  }
  .group.blue::before {
    background-color: #2f7cf6;
  }
  .group.orange::before {
    background-color: #f5871f;
  }
  .group.active {
    font-weight: bold;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4em;
  }
  button {
    font: inherit;
    padding: 0.25em 0.7em;
    border-radius: 0.25em;
    border: 1px solid #8888;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .row button {
    padding: 0 0.35em;
    line-height: 1.3;
    border-color: transparent;
  }
  .row button:not(:disabled):hover {
    border-color: #8888;
  }
  .row button.eye {
    display: flex;
    padding: 0.1em 0.2em;
  }
  label.option {
    display: block;
    margin-top: 0.4em;
  }
  .message {
    opacity: 0.8;
    min-height: 1.2em;
  }
  .help {
    opacity: 0.7;
    line-height: 1.4;
  }
  .help-section + .help-section {
    margin-top: 0.8em;
  }
  .help-title {
    font-weight: bold;
    margin-bottom: 0.2em;
  }
  .help ul,
  .help ol {
    margin: 0;
    padding-left: 1.4em;
  }
  .help li + li {
    margin-top: 0.25em;
  }
  .help kbd {
    padding: 0 0.25em;
    border: 1px solid #8886;
    border-radius: 0.2em;
    font-size: 0.9em;
  }
`;

export class MatchmakerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setup(editor, tool, pluginPath) {
    this.editor = editor;
    this.tool = tool;
    this.identifier = "curvekit-matchmaker";
    this.iconPath = `${pluginPath}/images/matchmaker.svg`;
    this.build();
    tool.addListener(() => this.refresh());
    return this;
  }

  build() {
    this.shadowRoot.innerHTML = `
      <style>${styles}</style>
      <div class="section">
        <div class="title">Matchmaker</div>
        <div class="status"><span class="status-dot"></span><span class="status-text"></span></div>
        <ul class="issues"></ul>
        <div class="groups">
          <span class="group blue"></span><span class="group orange"></span>
        </div>
        <div class="buttons">
          <button class="activate" title="Switch to the Matchmaker tool">👁 Matchmaker tool</button>
          <button class="align-start" title="Set each master's start point so it lies as many nodes before the selected node as in the selected master">Align start points</button>
          <button class="match-segment">Match segment</button>
          <button class="reorder-contours" title="Put each master's contours in the same order as the selected master's, by their bounding boxes. Nothing else changes">Reorder contours</button>
          <button class="match-masters" title="Match every master to the selected one: reorder contours, reverse contours that run the other way, align start points, then add nodes and convert lines to curves">Force match masters</button>
          <button class="clear-groups">Clear groups</button>
          <button class="reset-view">Reset view angle</button>
        </div>
        <div class="message"></div>
        <div class="masters-section">
          <div class="subtitle">Masters</div>
          <ul class="list master-list"></ul>
        </div>
        <div class="contours-section">
          <div class="subtitle contours-title"></div>
          <ul class="list contour-list"></ul>
          <label class="option"><input type="checkbox" class="match-width"> Stretch masters width in preview</label>
          <label class="option"><input type="checkbox" class="show-incompatible"> Show incompatible contours in red</label>
          <label class="option"><input type="checkbox" class="highlight-all"> Highlight hovered contour in all masters</label>
        </div>
        <div class="help">
          <div class="help-section">
            <div class="help-title">Match segments</div>
            <ol>
              <li>Put the contours of every master in the same order: use <b>Reorder contours</b>, or drag them in the contour list.</li>
              <li>Draw a free-hand lasso around the nodes at one end of the segment in all shown masters (blue), then around the other end (orange). The lasso always closes with a straight line back to where you started.</li>
              <li>Click a group or press <kbd>Enter</kbd> to make the segment compatible.</li>
            </ol>
            <ul>
              <li>Drag the blue handle at the origin to change the view angle.</li>
              <li>Press <kbd>Escape</kbd> to clear the groups.</li>
            </ul>
          </div>
          <div class="help-section">
            <div class="help-title">Start points</div>
            <ul>
              <li>Right-click a node to set start point of the contour in that master.</li>
              <li>To align masters, select a node in all shown masters (blue), then use <b>Align start points</b>.</li>
            </ul>
          </div>
          <div class="help-section">
            <div class="help-title">Force match masters</div>
            <ul>
              <li>Matches every master to the selected one: reorders contours, reverses contours that run the other way, aligns start points, then adds nodes.</li>
              <li><b>Reorder contours</b> does only the first step: it puts each master's contours in the selected master's order, and changes nothing else.</li>
            </ul>
          </div>
        </div>
      </div>
    `;
    const $ = (selector) => this.shadowRoot.querySelector(selector);
    this.elements = {
      dot: $(".status-dot"),
      statusText: $(".status-text"),
      issues: $(".issues"),
      matchWidth: $(".match-width"),
      showIncompatible: $(".show-incompatible"),
      highlightAll: $(".highlight-all"),
      blue: $(".group.blue"),
      orange: $(".group.orange"),
      matchSegment: $(".match-segment"),
      matchMasters: $(".match-masters"),
      reorderContours: $(".reorder-contours"),
      alignStart: $(".align-start"),
      message: $(".message"),
      mastersSection: $(".masters-section"),
      masterList: $(".master-list"),
      contoursSection: $(".contours-section"),
      contoursTitle: $(".contours-title"),
      contourList: $(".contour-list"),
    };
    this.elements.matchWidth.onchange = (event) =>
      this.tool.setMatchWidth(event.target.checked);
    this.elements.showIncompatible.onchange = (event) =>
      this.tool.setShowIncompatible(event.target.checked);
    this.elements.highlightAll.onchange = (event) =>
      this.tool.setHighlightAllMasters(event.target.checked);
    $(".activate").onclick = () =>
      this.editor.setSelectedTool(this.tool.identifier);
    this.elements.matchSegment.onclick = () => this.tool.matchSelectedSegment();
    this.elements.matchMasters.onclick = () => this.tool.matchAllMasters();
    this.elements.reorderContours.onclick = () =>
      this.tool.reorderAllContours();
    this.elements.alignStart.onclick = () =>
      this.tool.alignStartPointsToGroup();
    $(".clear-groups").onclick = () => this.tool.clearGroups();
    $(".reset-view").onclick = () => this.tool.resetViewVector();
  }

  async toggle(on, focus) {
    if (on) {
      this.refresh();
    }
  }

  refresh() {
    if (!this.elements) {
      return;
    }
    const tool = this.tool;
    const masters = tool.getMasters();
    const visibleMasters = tool.getVisibleMasters();
    const report = tool.getReport(masters);
    const e = this.elements;

    e.dot.classList.toggle("ok", report.compatible === true);
    e.dot.classList.toggle("bad", report.compatible === false);
    if (!masters.length) {
      e.statusText.textContent = "No glyph selected";
    } else if (report.numMasters < 2) {
      e.statusText.textContent = "Only one master";
    } else {
      e.statusText.textContent = `${report.numMasters} masters — ${
        report.compatible ? "compatible" : "not compatible"
      }`;
    }
    e.issues.replaceChildren(
      ...report.issues.map((issue) => {
        const li = document.createElement("li");
        li.textContent =
          issue.contourIndex !== undefined
            ? `Contour ${issue.contourIndex}: ${issue.message}`
            : issue.message;
        return li;
      }),
    );
    e.matchWidth.checked = tool.matchWidth;
    e.showIncompatible.checked = tool.showIncompatible;
    e.highlightAll.checked = tool.highlightAllMasters;
    e.blue.textContent = `Blue ${tool.blueGroup.size}/${visibleMasters.length}`;
    e.orange.textContent = `Orange ${tool.orangeGroup.size}/${visibleMasters.length}`;
    e.blue.classList.toggle("active", tool.activeGroup === "blue");
    e.orange.classList.toggle("active", tool.activeGroup === "orange");
    e.matchSegment.disabled = !tool.getMatchableRun(visibleMasters);
    // also when compatible: it may still reorder contours or align starts
    e.matchMasters.disabled = report.numMasters < 2;
    e.reorderContours.disabled = !tool.canReorderContours(masters);
    e.alignStart.disabled = !tool.canAlignStartPoints(visibleMasters);
    e.message.textContent = tool.message;

    e.mastersSection.style.display = masters.length ? "" : "none";
    e.contoursSection.style.display = masters.length ? "" : "none";
    this.renderMasterList(masters);
    if (this._dragIndex === undefined) {
      this.renderContourList(masters);
    }
  }

  renderMasterList(masters) {
    const tool = this.tool;
    const rows = masters.map((master) => {
      const visible = tool.isLayerVisible(master.layerName);
      const row = document.createElement("li");
      row.className = "row master-row";
      row.classList.toggle(
        "selected",
        master.layerName === tool.getSelectedLayerName(masters),
      );
      row.classList.toggle("hidden-layer", !visible);
      row.title = "Click to select this source and list its contours";

      const eye = button(
        "",
        visible ? "Hide in schematic view" : "Show in schematic view",
        false,
        () => tool.setLayerVisible(master.layerName, !visible),
      );
      eye.classList.add("eye");
      eye.innerHTML = visible ? EYE_ICON : EYE_OFF_ICON;
      const swatch = span("swatch");
      swatch.style.backgroundColor = tool.masterColor(master);
      const name = span("master-name", master.name);
      const count = span("muted", `${master.contours.length} contours`);
      row.append(eye, swatch, name, count);
      row.onclick = () => tool.selectMaster(master.layerName);
      return row;
    });
    this.elements.masterList.replaceChildren(...rows);
  }

  // The contours of the selected master. A contour "matches" if it has the same
  // structure as the same-numbered contour in every other shown master.
  renderContourList(masters) {
    const tool = this.tool;
    const selected = tool.getSelectedLayerName(masters);
    const master = masters.find((m) => m.layerName === selected);
    const e = this.elements;
    if (!master) {
      e.contourList.replaceChildren();
      return;
    }
    e.contoursTitle.textContent = `Contours of ${master.name}`;
    const others = tool
      .getVisibleMasters()
      .filter((m) => m.layerName !== master.layerName);
    const count = master.contours.length;
    const layerName = master.layerName;
    const move = (from, to) => tool.moveContour(layerName, from, to);

    const rows = master.contours.map((contour, index) => {
      const row = document.createElement("li");
      row.className = "row contour-row";
      row.draggable = true;

      const numNodes = contour.points.filter(isOnCurve).length;
      const info = span(
        "info",
        `${numNodes} nodes${contour.isClosed ? "" : ", open"}`,
      );
      let match = span("match muted", "");
      if (others.length) {
        const signature = contourSignature(contour);
        const matches = others.every(
          (m) =>
            m.contours[index] &&
            contourSignature(m.contours[index]) === signature,
        );
        match = span(`match ${matches ? "ok" : "bad"}`, matches ? "✓" : "✗");
        match.title = matches
          ? "Matches the same-numbered contour in the other shown masters"
          : "Differs from the same-numbered contour in another shown master";
      }
      const up = button("▲", "Move up", index === 0, () =>
        move(index, index - 1),
      );
      const down = button("▼", "Move down", index === count - 1, () =>
        move(index, index + 1),
      );
      row.append(
        span("grip", "⋮⋮"),
        span("index", `${index}`),
        info,
        match,
        up,
        down,
      );

      row.addEventListener("mouseenter", () =>
        tool.setHighlightedContour(layerName, index),
      );
      row.addEventListener("mouseleave", () =>
        tool.setHighlightedContour(undefined),
      );
      row.addEventListener("dragstart", (event) => {
        this._dragIndex = index;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `${index}`);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        this._dragIndex = undefined;
        row.classList.remove("dragging");
        clearDropMarkers();
      });
      row.addEventListener("dragover", (event) => {
        if (this._dragIndex === undefined) {
          return;
        }
        event.preventDefault();
        clearDropMarkers();
        row.classList.add(
          isLowerHalf(event, row) ? "drop-after" : "drop-before",
        );
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const from = this._dragIndex;
        if (from === undefined) {
          return;
        }
        let to = index + (isLowerHalf(event, row) ? 1 : 0);
        if (from < to) {
          to -= 1; // removing the dragged row shifts the target up
        }
        clearDropMarkers();
        this._dragIndex = undefined; // let the refresh after the move re-render
        move(from, to);
      });
      return row;
    });
    const clearDropMarkers = () => {
      for (const row of rows) {
        row.classList.remove("drop-before", "drop-after");
      }
    };
    e.contourList.replaceChildren(...rows);
  }
}

function span(className, text = "") {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

function button(label, title, disabled, onclick) {
  const element = document.createElement("button");
  element.textContent = label;
  element.title = title;
  element.disabled = disabled;
  element.onclick = (event) => {
    event.stopPropagation();
    onclick();
  };
  return element;
}

function isLowerHalf(event, element) {
  const rect = element.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2;
}

if (!customElements.get(PANEL_TAG)) {
  customElements.define(PANEL_TAG, MatchmakerPanel);
}

export function createMatchmakerPanel(editor, tool, pluginPath) {
  return document.createElement(PANEL_TAG).setup(editor, tool, pluginPath);
}
