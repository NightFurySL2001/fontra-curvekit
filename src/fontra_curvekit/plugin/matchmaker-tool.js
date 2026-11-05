// Matchmaker tool:
//
// - While active, the glyph is shown in a schematic view: all masters (glyph
//   sources) side by side, spread along a "view angle" vector. Corresponding
//   nodes of compatible contours are connected; incompatible contours are red.
// - Drag the blue handle at the glyph origin to change the view angle.
// - Lasso-select (free-hand, closed by a straight line back to the start)
//   the matching nodes at one end of a segment across all masters (blue group), then at the other end (orange group). Click either
//   group (or press Enter) to make that segment compatible: nodes are added,
//   and lines become curves where other masters have curves. If the segment's
//   contour has a different number in some masters, it moves to its number in
//   the selected master.
// - Click a single node to put it into the current group. Escape clears.
// - Contour numbers are shown at each contour's start node. The panel lets you
//   hide masters from the schematic view and reorder a master's contours by
//   hand.
// - The Matchmaker panel shows the compatibility status (green/red) and the
//   issues. Against the selected master, "Reorder contours" only reorders
//   contours by bounding box; "Force match masters" reorders, fixes direction,
//   aligns start points and matches nodes automatically.
// - Start points follow the selected nodes: "Match segment" and "Align start
//   points" move each master's start point so it lies as many nodes before the
//   blue node as in the selected master.

import {
  alignContourStartsToReference,
  alignStartPoints,
  checkCompatibility,
  contourSignature,
  distance,
  isContourSetCompatible,
  isOnCurve,
  autoMatchContours,
  matchContourOrder,
  matchSegmentRun,
  matchOuterDirection,
  reverseContour,
  segmentRun,
  setContourStartPoint,
  signedArea,
  pointInPolygon,
} from "./contour-ops.js";
import {
  PluginTool,
  addContoursToPath2D,
  editingGlyphSelector,
  fillRoundNode,
  registerVisualizationLayer,
  setAllContours,
  shouldInitiateDrag,
  strokeLine,
  strokeRoundNode,
  unpackContours,
} from "./editor-glue.js";

const HANDLE_SIZE_PX = 12;

// Outline colors per master, cycled. Red, blue, orange and green are avoided:
// they mean "incompatible", the two groups and the matchable run.
const MASTER_COLORS = [
  "#8E44AD",
  "#00897B",
  "#C2185B",
  "#6D4C41",
  "#3949AB",
  "#827717",
];
const MASTER_COLORS_DARK = [
  "#C39BD3",
  "#4DB6AC",
  "#F06292",
  "#BCAAA4",
  "#9FA8DA",
  "#D4E157",
];

export class MatchmakerTool extends PluginTool {
  identifier = "curvekit-matchmaker-tool";
  title = "Matchmaker Tool";

  constructor(editor, pluginPath) {
    super(editor, pluginPath);
    this.iconPath = new URL("./images/matchmaker.svg", import.meta.url).href;
    this.viewVector = undefined; // initialized lazily from unitsPerEm
    this.matchWidth = false;
    this.hiddenLayers = new Set(); // layer names hidden in the schematic view
    this.highlightedContour = undefined; // { layerName, contourIndex }
    this.selectedLayerName = undefined; // master selected in the panel, synced
    // with the glyph source selected in the editor
    this.showIncompatible = true; // red halo around incompatible contours
    this.highlightAllMasters = false; // highlight a contour number in every master
    this.blueGroup = new Map(); // masterIndex -> { contourIndex, pointIndex }
    this.orangeGroup = new Map();
    this.activeGroup = "blue";
    this.feedback = {};
    this.message = "";
    this._listeners = new Set();
    registerVisualizationLayer(editor, this.visualizationLayer());
    this.installContextMenu();

    const glyphChanged = () => this.notify();
    this.sceneController.addCurrentGlyphChangeListener(glyphChanged);
    this.sceneSettingsController.addKeyListener("selectedGlyphName", () => {
      this.clearGroups(false);
      this.message = "";
      this.notify();
      this.syncSelectedMasterFromEditor();
    });
    // Follow the glyph source selected in the editor (sources panel, location)
    this.sceneSettingsController.addKeyListener(
      ["fontLocationSourceMapped", "glyphLocation", "editLayerName"],
      () => this.syncSelectedMasterFromEditor(),
    );
  }

  //
  // State shared with the panel
  //

  addListener(listener) {
    this._listeners.add(listener);
  }

  notify() {
    for (const listener of this._listeners) {
      listener(this);
    }
  }

  get unitsPerEm() {
    return this.editor.fontController.unitsPerEm || 1000;
  }

  getViewVector() {
    if (!this.viewVector) {
      this.resetViewVector(false);
    }
    return this.viewVector;
  }

  resetViewVector(update = true) {
    const d = Math.round(this.unitsPerEm * 0.06);
    this.viewVector = { x: d, y: d };
    if (update) {
      this.canvasController.requestUpdate();
    }
  }

  setMatchWidth(onOff) {
    this.matchWidth = onOff;
    this.canvasController.requestUpdate();
  }

  // The selected glyph's masters: one entry per source layer, in source order.
  // `colorIndex` is that position, so a master keeps its color when others are
  // hidden.
  getMasters() {
    const varGlyph =
      this.sceneModel.getSelectedPositionedGlyph()?.varGlyph?.glyph;
    if (!varGlyph) {
      return [];
    }
    const masters = [];
    const seen = new Set();
    for (const source of varGlyph.sources) {
      const layer = varGlyph.layers[source.layerName];
      if (!layer || seen.has(source.layerName)) {
        continue;
      }
      seen.add(source.layerName);
      masters.push({
        name: source.name || source.layerName,
        layerName: source.layerName,
        colorIndex: masters.length,
        contours: unpackContours(layer.glyph.path),
        xAdvance: layer.glyph.xAdvance,
      });
    }
    return masters;
  }

  // The masters shown in the schematic view. Groups and "Match segment" work on
  // these; the compatibility report and "Match Masters" use all masters.
  getVisibleMasters() {
    return this.getMasters().filter((m) => !this.hiddenLayers.has(m.layerName));
  }

  isLayerVisible(layerName) {
    return !this.hiddenLayers.has(layerName);
  }

  setLayerVisible(layerName, onOff) {
    if (onOff) {
      this.hiddenLayers.delete(layerName);
    } else {
      this.hiddenLayers.add(layerName);
    }
    this.clearGroups(); // groups refer to positions among the visible masters
  }

  // Move a contour of one master (an undoable glyph edit), so contour order can
  // be made to correspond across masters.
  async moveContour(layerName, fromIndex, toIndex) {
    const master = this.getMasters().find((m) => m.layerName === layerName);
    const numContours = master?.contours.length ?? 0;
    if (
      fromIndex === toIndex ||
      !(fromIndex >= 0 && fromIndex < numContours) ||
      !(toIndex >= 0 && toIndex < numContours)
    ) {
      return;
    }
    this.sceneController.selection = new Set();
    await this.sceneController.editGlyphAndRecordChanges(
      (glyph) => {
        const path = glyph.layers[layerName].glyph.path;
        const contour = path.getUnpackedContour(fromIndex);
        path.deleteContour(fromIndex);
        path.insertUnpackedContour(toIndex, contour);
        return "Reorder contours";
      },
      undefined,
      false,
    );
    if (this.highlightedContour?.layerName === layerName) {
      this.highlightedContour = { layerName, contourIndex: toIndex };
    }
    this.clearGroups(); // groups refer to contour indices
  }

  // The master selected in the panel: the synced one, else the first master
  getSelectedLayerName(masters = this.getMasters()) {
    return masters.some((m) => m.layerName === this.selectedLayerName)
      ? this.selectedLayerName
      : masters[0]?.layerName;
  }

  // Select a master: also selects its glyph source in the editor, like clicking
  // it in the sources panel.
  async selectMaster(layerName) {
    this.selectedLayerName = layerName;
    this.notify();
    this.canvasController.requestUpdate();
    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();
    const sourceIndex = varGlyphController?.sources.findIndex(
      (source) => source.layerName === layerName,
    );
    if (sourceIndex >= 0) {
      await this.sceneController.setLocationFromSourceIndex(sourceIndex);
      this.sceneSettings.editLayerName = layerName;
    }
  }

  // The source layer the editor is at, or undefined at an interpolated location
  async getEditorSourceLayerName() {
    const varGlyphController =
      await this.sceneModel.getSelectedVariableGlyphController();
    if (!varGlyphController) {
      return undefined;
    }
    const editLayerName = this.sceneSettings.editLayerName;
    if (
      editLayerName &&
      varGlyphController.sources.some((s) => s.layerName === editLayerName)
    ) {
      return editLayerName;
    }
    const locationString =
      varGlyphController.getSparseLocationStringForSourceLocation({
        ...this.sceneSettings.fontLocationSourceMapped,
        ...this.sceneSettings.glyphLocation,
      });
    const sourceIndex =
      varGlyphController.getSourceIndexForSourceLocationString(locationString);
    return sourceIndex !== undefined
      ? varGlyphController.sources[sourceIndex]?.layerName
      : undefined;
  }

  async syncSelectedMasterFromEditor() {
    let layerName;
    try {
      layerName = await this.getEditorSourceLayerName();
    } catch (error) {
      return; // editor internals changed or glyph not loaded: just don't sync
    }
    if (layerName && layerName !== this.selectedLayerName) {
      this.selectedLayerName = layerName;
      this.notify();
      this.canvasController.requestUpdate();
    }
  }

  setShowIncompatible(onOff) {
    this.showIncompatible = onOff;
    this.canvasController.requestUpdate();
  }

  setHighlightAllMasters(onOff) {
    this.highlightAllMasters = onOff;
    this.canvasController.requestUpdate();
  }

  // Set the start point of one master's contour (an undoable glyph edit)
  async setStartPoint(layerName, contourIndex, pointIndex) {
    const master = this.getMasters().find((m) => m.layerName === layerName);
    const contour = master?.contours[contourIndex];
    const newContour = contour && setContourStartPoint(contour, pointIndex);
    if (!newContour) {
      return;
    }
    this.sceneController.selection = new Set();
    await this.sceneController.editGlyphAndRecordChanges(
      (glyph) => {
        glyph.layers[layerName].glyph.path.setUnpackedContour(
          contourIndex,
          newContour,
        );
        return "Set Start Point";
      },
      undefined,
      false,
    );
    this.message = `Start point set in ${master.name}, contour ${contourIndex}.`;
    this.clearGroups(); // groups refer to point indices
  }

  // While the tool is active, right-clicking a node in the schematic view shows
  // a menu for that node's master. Fontra's own glyph items act on the current
  // selection in the editing layers, so they don't apply here.
  installContextMenu() {
    const editor = this.editor;
    const buildContextMenuItems = editor.buildContextMenuItems?.bind(editor);
    if (!buildContextMenuItems) {
      return;
    }
    editor.buildContextMenuItems = (event) =>
      (this.isActive &&
        this.isEditingGlyph &&
        event &&
        this.getNodeContextMenuItems(event)) ||
      buildContextMenuItems(event);
  }

  getNodeContextMenuItems(event) {
    const masters = this.getVisibleMasters();
    const node = this.findNode(masters, this.glyphPoint(event));
    if (!node) {
      return undefined;
    }
    const master = masters[node.masterIndex];
    const contour = master.contours[node.contourIndex];
    const isStart = contour.points.findIndex(isOnCurve) === node.pointIndex;
    return [
      {
        title: `Set Start Point (${master.name}, contour ${node.contourIndex})`,
        enabled: () => !!setContourStartPoint(contour, node.pointIndex),
        checked: isStart,
        callback: () =>
          this.setStartPoint(
            master.layerName,
            node.contourIndex,
            node.pointIndex,
          ),
      },
    ];
  }

  setHighlightedContour(layerName, contourIndex) {
    this.highlightedContour =
      layerName === undefined ? undefined : { layerName, contourIndex };
    this.canvasController.requestUpdate();
  }

  getReport(masters = this.getMasters()) {
    if (masters.length < 2) {
      return { numMasters: masters.length, compatible: undefined, issues: [] };
    }
    return {
      numMasters: masters.length,
      ...checkCompatibility(
        masters.map((m) => m.contours),
        masters.map((m) => m.name),
      ),
    };
  }

  masterTransform(masters, masterIndex) {
    const v = this.getViewVector();
    const refAdvance = masters[0]?.xAdvance;
    const advance = masters[masterIndex]?.xAdvance;
    const sx =
      this.matchWidth && refAdvance && advance ? refAdvance / advance : 1;
    return (p) => ({
      x: p.x * sx + masterIndex * v.x,
      y: p.y + masterIndex * v.y,
    });
  }

  masterColor(master) {
    const palette = this.editor.visualizationLayers.darkTheme
      ? MASTER_COLORS_DARK
      : MASTER_COLORS;
    return palette[master.colorIndex % palette.length];
  }

  clearGroups(update = true) {
    this.blueGroup = new Map();
    this.orangeGroup = new Map();
    this.activeGroup = "blue";
    if (update) {
      this.canvasController.requestUpdate();
      this.notify();
    }
  }

  // If the blue and orange groups describe a segment run in every master,
  // return the per-master { contourIndex, from, to }, else undefined.
  getMatchableRun(masters) {
    if (
      masters.length < 2 ||
      this.blueGroup.size !== masters.length ||
      this.orangeGroup.size !== masters.length
    ) {
      return undefined;
    }
    const runs = [];
    for (let i = 0; i < masters.length; i++) {
      const blue = this.blueGroup.get(i);
      const orange = this.orangeGroup.get(i);
      if (!blue || !orange || blue.contourIndex !== orange.contourIndex) {
        return undefined;
      }
      const contour = masters[i].contours[blue.contourIndex];
      if (!contour) {
        return undefined;
      }
      let [from, to] = [blue.pointIndex, orange.pointIndex];
      if (!contour.isClosed && from > to) {
        [from, to] = [to, from];
      }
      if (!segmentRun(contour, from, to)) {
        return undefined;
      }
      runs.push({ contourIndex: blue.contourIndex, from, to });
    }
    return runs;
  }

  // The reference for aligning start points: the selected master if shown,
  // else the first shown master.
  referenceMasterIndex(masters) {
    const index = masters.findIndex(
      (m) => m.layerName === this.getSelectedLayerName(),
    );
    return index < 0 ? 0 : index;
  }

  // A group with a node in every shown master: blue, else orange
  getCompleteGroup(masters) {
    return [this.blueGroup, this.orangeGroup].find(
      (group) =>
        masters.length > 1 &&
        group.size === masters.length &&
        masters.every((m, i) => m.contours[group.get(i)?.contourIndex]),
    );
  }

  canAlignStartPoints(masters = this.getVisibleMasters()) {
    const group = this.getCompleteGroup(masters);
    return (
      !!group &&
      masters.every((m, i) => m.contours[group.get(i).contourIndex].isClosed)
    );
  }

  //
  // Edits
  //

  // Move the start points so they correspond relative to the selected nodes
  async alignStartPointsToGroup() {
    const masters = this.getVisibleMasters();
    const group = this.getCompleteGroup(masters);
    if (!group) {
      return;
    }
    const contourIndices = masters.map((m, i) => group.get(i).contourIndex);
    const contours = masters.map((m, i) => m.contours[contourIndices[i]]);
    const aligned = alignStartPoints(
      contours,
      masters.map((m, i) => group.get(i).pointIndex),
      this.referenceMasterIndex(masters),
    );
    const changed = aligned.filter((c, i) => c !== contours[i]).length;
    if (changed) {
      await this.editMasters(masters, "Align start points", (i) =>
        aligned[i] !== contours[i] ? [[contourIndices[i], aligned[i]]] : [],
      );
    }
    this.message = changed
      ? `Start points aligned in ${changed} master(s).`
      : "Start points were already aligned.";
    this.clearGroups();
  }

  async matchSelectedSegment() {
    const masters = this.getVisibleMasters();
    const runs = this.getMatchableRun(masters);
    if (!runs) {
      return;
    }
    const contours = masters.map((m, i) => m.contours[runs[i].contourIndex]);
    const result = matchSegmentRun(
      contours,
      runs.map((r) => r.from),
      runs.map((r) => r.to),
    );
    if (!result) {
      this.message = "This segment can't be matched.";
      this.notify();
      return;
    }
    // then align the start points relative to the blue nodes, which keep
    // their positions
    const blueIndices = masters.map((m, i) =>
      findNodeIndex(
        result[i],
        contours[i].points[this.blueGroup.get(i).pointIndex],
      ),
    );
    const referenceIndex = this.referenceMasterIndex(masters);
    const matched = alignStartPoints(result, blueIndices, referenceIndex);
    const changed = matched.map(
      (c, i) =>
        contourSignature(c) !== contourSignature(contours[i]) ||
        c !== result[i],
    );
    // the groups may be on different contours in different masters: move
    // each master's contour to the position it has in the selected master
    const target = runs[referenceIndex].contourIndex;
    const moves = masters.map((master, i) => {
      const to = Math.min(target, master.contours.length - 1);
      return runs[i].contourIndex !== to ? to : undefined;
    });
    const lists = masters.map((master, i) => {
      const list = [...master.contours];
      const from = runs[i].contourIndex;
      if (changed[i]) {
        list[from] = matched[i];
      }
      if (moves[i] !== undefined) {
        const [contour] = list.splice(from, 1);
        list.splice(moves[i], 0, contour);
      }
      return list;
    });
    const moved = moves.filter((to) => to !== undefined).length;
    const edited = masters.map((_, i) => changed[i] || moves[i] !== undefined);
    if (edited.some((e) => e)) {
      await this.editMasterContours(
        masters.filter((_, i) => edited[i]),
        lists.filter((_, i) => edited[i]),
        "Match segment",
      );
    }
    const parts = [
      changed.some((c) => c)
        ? "Segment matched."
        : "Segment was already compatible.",
    ];
    if (moved) {
      parts.push(
        `Moved the contour to position ${target} in ${moved} master(s).`,
      );
    }
    this.message = parts.join(" ");
    this.clearGroups();
  }

  // Force match masters. Against the reference master (the selected one):
  // 0. if a master's outermost contour runs the other way, reverse all its
  //    contours, so every master follows the same direction convention;
  // 1. reorder each master's contours to match by bounding box, preferring
  //    contours that run the same way;
  // 2. reverse contours that still run the other way;
  // 3. align start points by comparing the outlines;
  // 4. insert nodes and unify segment types (autoMatchContours).
  // So the matched contours correspond and don't spin. One undo step.
  async matchAllMasters() {
    const masters = this.getMasters();
    if (!this.canMatchAllMasters(masters)) {
      return;
    }
    const referenceIndex = this.referenceMasterIndex(masters);
    const reference = masters[referenceIndex].contours;

    // 0. overall direction, from the outermost contour
    let flippedCount = 0;
    const directed = masters.map((master, i) => {
      const flipped =
        i === referenceIndex
          ? undefined
          : matchOuterDirection(reference, master.contours);
      if (!flipped) {
        return master;
      }
      flippedCount++;
      return { ...master, contours: flipped };
    });

    // 1. contour order
    const ordered = reorderedContourLists(directed, referenceIndex);
    const reorderedCount = ordered.reorderedCount;
    let lists = ordered.lists;

    // 2. direction
    let reversedCount = 0;
    lists = lists.map((list, i) =>
      i === referenceIndex
        ? list
        : list.map((contour, k) => {
            const referenceContour = reference[k];
            if (!referenceContour?.isClosed || !contour.isClosed) {
              return contour;
            }
            const a = Math.sign(signedArea(referenceContour));
            const b = Math.sign(signedArea(contour));
            if (a && b && a !== b) {
              reversedCount++;
              return reverseContour(contour);
            }
            return contour;
          }),
    );

    // 3. start points, 4. nodes and segment types
    const numContours = Math.min(...lists.map((list) => list.length));
    const failed = [];
    let alignedCount = 0;
    let matchedCount = 0;
    lists = lists.map((list) => [...list]);
    for (let contourIndex = 0; contourIndex < numContours; contourIndex++) {
      const contours = lists.map((list) => list[contourIndex]);
      const aligned = alignContourStartsToReference(contours, referenceIndex);
      let result = aligned;
      if (!isContourSetCompatible(aligned)) {
        result = autoMatchContours(aligned);
        if (result && isContourSetCompatible(result)) {
          matchedCount++;
        } else {
          failed.push(contourIndex);
          result = aligned;
        }
      }
      if (aligned.some((contour, i) => contour !== contours[i])) {
        alignedCount++;
      }
      lists.forEach((list, i) => (list[contourIndex] = result[i]));
    }

    const changed = lists.map(
      (list, i) =>
        list.length !== masters[i].contours.length ||
        list.some((contour, k) => contour !== masters[i].contours[k]),
    );
    if (changed.some((c) => c)) {
      await this.editMasterContours(
        masters.filter((_, i) => changed[i]),
        lists.filter((_, i) => changed[i]),
        "Match masters",
      );
    }
    const parts = [];
    if (flippedCount) {
      parts.push(`Reversed all contours in ${flippedCount} master(s).`);
    }
    if (reorderedCount) {
      parts.push(`Reordered contours in ${reorderedCount} master(s).`);
    }
    if (reversedCount) {
      parts.push(`Reversed ${reversedCount} contour(s).`);
    }
    if (alignedCount) {
      parts.push(`Aligned starts in ${alignedCount} contour(s).`);
    }
    if (matchedCount) {
      parts.push(`Matched ${matchedCount} contour(s).`);
    }
    if (failed.length) {
      parts.push(`Couldn't match contour(s) ${failed.join(", ")}.`);
    }
    this.message = parts.join(" ") || "Masters are already compatible.";
    this.clearGroups();
  }

  // Reorder only: each master's contours in the order of the reference
  // master's (the selected one), by bounding box. Nothing else changes.
  async reorderAllContours() {
    const masters = this.getMasters();
    if (!this.canReorderContours(masters)) {
      return;
    }
    const referenceIndex = this.referenceMasterIndex(masters);
    const { lists, reorderedCount } = reorderedContourLists(
      masters,
      referenceIndex,
    );
    if (reorderedCount) {
      const changed = lists.map((list, i) => list !== masters[i].contours);
      await this.editMasterContours(
        masters.filter((_, i) => changed[i]),
        lists.filter((_, i) => changed[i]),
        "Reorder contours",
      );
    }
    this.message = reorderedCount
      ? `Reordered contours in ${reorderedCount} master(s).`
      : "Contours are already in the same order.";
    this.clearGroups();
  }

  // Needs 2+ masters with the same number of contours. Also enabled when
  // compatible: it may still reorder contours or align start points.
  canMatchAllMasters(masters = this.getMasters()) {
    return masters.length > 1 && haveSameContourCount(masters);
  }

  canReorderContours(masters = this.getMasters()) {
    return (
      masters.length > 1 &&
      masters[0].contours.length > 1 &&
      haveSameContourCount(masters)
    );
  }

  // Replace all contours of each given master (an undoable glyph edit)
  async editMasterContours(masters, contourLists, undoLabel) {
    this.sceneController.selection = new Set();
    await this.sceneController.editGlyphAndRecordChanges(
      (glyph) => {
        masters.forEach((master, i) => {
          const path = glyph.layers[master.layerName].glyph.path;
          setAllContours(path, contourLists[i]);
        });
        return undoLabel;
      },
      undefined,
      false,
    );
  }

  // contoursForMaster(i) returns [[contourIndex, newContour], ...]
  async editMasters(masters, undoLabel, contoursForMaster) {
    this.sceneController.selection = new Set();
    await this.sceneController.editGlyphAndRecordChanges(
      (glyph) => {
        masters.forEach((master, i) => {
          const path = glyph.layers[master.layerName].glyph.path;
          for (const [contourIndex, contour] of contoursForMaster(i)) {
            path.setUnpackedContour(contourIndex, contour);
          }
        });
        return undoLabel;
      },
      undefined,
      false,
    );
  }

  //
  // Events
  //

  activate() {
    super.activate();
    this.notify();
    this.syncSelectedMasterFromEditor();
  }

  deactivate() {
    this.feedback = {};
    super.deactivate();
  }

  handleKeyDown(event) {
    if (event.key === "Escape") {
      this.clearGroups();
    } else if (event.key === "Enter") {
      this.matchSelectedSegment();
    }
  }

  handleHover(event) {
    if (!this.isEditingGlyph) {
      this.pointerTool.handleHover(event);
      return;
    }
    const point = this.glyphPoint(event);
    const masters = this.getVisibleMasters();
    if (this.hitsHandle(point)) {
      this.setCursor("grab");
      this.feedback = { hoverHandle: true };
    } else {
      const node = this.findNode(masters, point);
      this.setCursor(node ? "pointer" : "crosshair");
      this.feedback = { hoverNode: node };
    }
    this.canvasController.requestUpdate();
  }

  async handleDrag(eventStream, initialEvent) {
    if (!this.isEditingGlyph) {
      await this.pointerTool.handleDrag(eventStream, initialEvent);
      return;
    }
    const startPoint = this.glyphPoint(initialEvent);
    const masters = this.getVisibleMasters();
    const onHandle = this.hitsHandle(startPoint);
    const node = onHandle ? undefined : this.findNode(masters, startPoint);

    if (!(await shouldInitiateDrag(eventStream, initialEvent))) {
      if (node) {
        await this.clickNode(masters, node);
      }
      return;
    }

    if (onHandle) {
      await this.dragHandle(eventStream);
    } else {
      await this.dragLasso(
        eventStream,
        masters,
        startPoint,
        initialEvent.shiftKey,
      );
    }
  }

  async clickNode(masters, node) {
    const key = (n) => n && `${n.contourIndex}/${n.pointIndex}`;
    const nodeKey = key(node);
    const inGroup =
      key(this.blueGroup.get(node.masterIndex)) === nodeKey ||
      key(this.orangeGroup.get(node.masterIndex)) === nodeKey;
    if (inGroup && this.getMatchableRun(masters)) {
      await this.matchSelectedSegment();
      return;
    }
    const group =
      this.activeGroup === "blue" ? this.blueGroup : this.orangeGroup;
    group.set(node.masterIndex, {
      contourIndex: node.contourIndex,
      pointIndex: node.pointIndex,
    });
    if (group.size === masters.length && this.activeGroup === "blue") {
      this.activeGroup = "orange";
    }
    this.canvasController.requestUpdate();
    this.notify();
  }

  async dragHandle(eventStream) {
    this.setCursor("grabbing");
    for await (const event of eventStream) {
      const point = this.glyphPoint(event);
      if (point?.x === undefined) {
        continue;
      }
      let v = { x: Math.round(point.x), y: Math.round(point.y) };
      if (event.shiftKey) {
        // constrain to horizontal or vertical
        v = Math.abs(v.x) > Math.abs(v.y) ? { x: v.x, y: 0 } : { x: 0, y: v.y };
      }
      this.viewVector = v;
      this.canvasController.requestUpdate();
    }
    this.setCursor("grab");
  }

  // Free-hand selection: the pointer's path, always closed by a straight
  // line from the current point back to the start
  async dragLasso(eventStream, masters, startPoint, addToGroup) {
    if (!addToGroup && this.activeGroup === "blue") {
      this.clearGroups(false);
    }
    const lasso = [startPoint];
    let selection = new Map();
    for await (const event of eventStream) {
      const point = this.glyphPoint(event);
      if (point?.x === undefined) {
        continue;
      }
      if (distance(point, lasso.at(-1)) < this.onePixelUnit) {
        continue; // skip sub-pixel moves
      }
      lasso.push(point);
      selection = this.nodesInLasso(masters, lasso);
      this.feedback = {
        lasso: [...lasso],
        lassoSelection: [...selection.values()],
      };
      this.canvasController.requestUpdate();
    }
    this.feedback = {};
    if (selection.size) {
      const isBlue = this.activeGroup === "blue";
      const group = isBlue ? this.blueGroup : this.orangeGroup;
      if (!addToGroup) {
        group.clear();
      }
      for (const [masterIndex, node] of selection) {
        group.set(masterIndex, {
          contourIndex: node.contourIndex,
          pointIndex: node.pointIndex,
        });
      }
      if (!addToGroup) {
        this.activeGroup = isBlue ? "orange" : "blue";
      }
    }
    this.canvasController.requestUpdate();
    this.notify();
  }

  //
  // Hit testing in schematic space
  //

  hitsHandle(point) {
    const v = this.getViewVector();
    return distance(point, v) <= HANDLE_SIZE_PX * this.onePixelUnit;
  }

  *iterSchematicNodes(masters) {
    for (let masterIndex = 0; masterIndex < masters.length; masterIndex++) {
      const transform = this.masterTransform(masters, masterIndex);
      const contours = masters[masterIndex].contours;
      for (
        let contourIndex = 0;
        contourIndex < contours.length;
        contourIndex++
      ) {
        const points = contours[contourIndex].points;
        for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
          if (isOnCurve(points[pointIndex])) {
            yield {
              masterIndex,
              contourIndex,
              pointIndex,
              ...transform(points[pointIndex]),
            };
          }
        }
      }
    }
  }

  findNode(masters, point) {
    let best;
    let bestDistance = this.clickMargin;
    for (const node of this.iterSchematicNodes(masters)) {
      const d = distance(node, point);
      if (d <= bestDistance) {
        bestDistance = d;
        best = node;
      }
    }
    return best;
  }

  // At most one node per master: the one nearest to the center of the
  // lasso's bounding box
  nodesInLasso(masters, lasso) {
    const result = new Map();
    if (lasso.length < 3) {
      return result;
    }
    const xs = lasso.map((p) => p.x);
    const ys = lasso.map((p) => p.y);
    const center = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
    for (const node of this.iterSchematicNodes(masters)) {
      if (!pointInPolygon(node, lasso)) {
        continue;
      }
      const current = result.get(node.masterIndex);
      if (!current || distance(node, center) < distance(current, center)) {
        result.set(node.masterIndex, node);
      }
    }
    return result;
  }

  //
  // Drawing
  //

  visualizationLayer() {
    return {
      identifier: "curvekit.matchmaker.schematic",
      name: "Matchmaker schematic view",
      selectionFunc: editingGlyphSelector,
      userSwitchable: false,
      zIndex: 600,
      screenParameters: {
        strokeWidth: 1,
        nodeSize: 6,
        groupNodeSize: 13,
        handleSize: HANDLE_SIZE_PX,
        labelFontSize: 11,
        labelOffset: 7,
      },
      colors: {
        backdropColor: "#FFFFFFE0",
        masterColors: MASTER_COLORS,
        connectorColor: "#888A",
        errorColor: "#E5484D",
        errorHaloColor: "#E5484D55",
        blueColor: "#2F7CF6",
        orangeColor: "#F5871F",
        runColor: "#1DA346",
        marqueeColor: "#8888",
      },
      colorsDarkMode: {
        backdropColor: "#1E1E1EE0",
        masterColors: MASTER_COLORS_DARK,
        connectorColor: "#999A",
        errorColor: "#FF6369",
        errorHaloColor: "#FF636966",
        blueColor: "#5C9BFF",
        orangeColor: "#FFA24D",
        runColor: "#3DD068",
        marqueeColor: "#AAA8",
      },
      draw: ({ context, parameters }) => {
        if (this.isActive) {
          this.drawSchematic(context, parameters);
        }
      },
    };
  }

  drawSchematic(context, parameters) {
    const masters = this.getVisibleMasters();
    if (!masters.length) {
      return;
    }
    const transforms = masters.map((_, i) => this.masterTransform(masters, i));
    const upm = this.unitsPerEm;

    // Backdrop, hiding the regular glyph rendering
    context.fillStyle = parameters.backdropColor;
    context.fillRect(-50 * upm, -50 * upm, 100 * upm, 100 * upm);

    const numContours = Math.min(...masters.map((m) => m.contours.length));
    const compatibleContours = new Set();
    for (let ci = 0; ci < numContours; ci++) {
      if (isContourSetCompatible(masters.map((m) => m.contours[ci]))) {
        compatibleContours.add(ci);
      }
    }

    // Dashed connectors between corresponding nodes of compatible contours
    context.strokeStyle = parameters.connectorColor;
    context.lineWidth = parameters.strokeWidth;
    context.setLineDash([
      4 * parameters.strokeWidth,
      3 * parameters.strokeWidth,
    ]);
    for (const ci of compatibleContours) {
      masters[0].contours[ci].points.forEach((p, pi) => {
        if (!isOnCurve(p)) {
          return;
        }
        context.beginPath();
        masters.forEach((m, i) => {
          const q = transforms[i](m.contours[ci].points[pi]);
          i ? context.lineTo(q.x, q.y) : context.moveTo(q.x, q.y);
        });
        context.stroke();
      });
    }
    context.setLineDash([]);

    // Outlines and nodes, one color per master; incompatible contours get a
    // red halo underneath
    const selectedLayerName = this.getSelectedLayerName(masters);
    masters.forEach((master, i) => {
      const color =
        parameters.masterColors[
          master.colorIndex % parameters.masterColors.length
        ];
      const isSelectedMaster =
        masters.length > 1 && master.layerName === selectedLayerName;
      master.contours.forEach((contour, ci) => {
        const path2d = new Path2D();
        addContoursToPath2D(path2d, [contour], transforms[i]);
        if (
          this.showIncompatible &&
          masters.length > 1 &&
          !compatibleContours.has(ci)
        ) {
          context.strokeStyle = parameters.errorHaloColor;
          context.lineWidth = parameters.strokeWidth * 5;
          context.stroke(path2d);
        }
        const isHighlighted =
          this.highlightedContour?.contourIndex === ci &&
          (this.highlightAllMasters ||
            this.highlightedContour.layerName === master.layerName);
        context.strokeStyle = color;
        context.lineWidth =
          parameters.strokeWidth *
          (isHighlighted ? 3 : isSelectedMaster ? 2 : 1);
        context.stroke(path2d);
        context.fillStyle = color;
        for (const p of contour.points) {
          if (isOnCurve(p)) {
            fillRoundNode(context, transforms[i](p), parameters.nodeSize);
          }
        }
      });
    });

    // Contour numbers at each contour's start node, to compare contour order
    context.save();
    context.scale(1, -1); // text is drawn upright: flip y
    context.font = `${parameters.labelFontSize}px fontra-ui-regular, sans-serif`;
    context.textBaseline = "bottom";
    masters.forEach((master, i) => {
      context.fillStyle =
        parameters.masterColors[
          master.colorIndex % parameters.masterColors.length
        ];
      master.contours.forEach((contour, ci) => {
        const start = contour.points.find(isOnCurve);
        if (start) {
          const q = transforms[i](start);
          context.fillText(
            `${ci}`,
            q.x + parameters.labelOffset,
            -q.y - parameters.labelOffset * 0.5,
          );
        }
      });
    });
    context.restore();

    // The segment run that would be matched
    const runs = this.getMatchableRun(masters);
    if (runs) {
      context.strokeStyle = parameters.runColor;
      context.lineWidth = parameters.strokeWidth * 3;
      masters.forEach((master, i) => {
        const { contourIndex, from, to } = runs[i];
        const runContour = extractRun(master.contours[contourIndex], from, to);
        const path2d = new Path2D();
        addContoursToPath2D(path2d, [runContour], transforms[i]);
        context.stroke(path2d);
      });
    }

    // Groups
    context.lineWidth = parameters.strokeWidth * 2;
    for (const [group, color] of [
      [this.blueGroup, parameters.blueColor],
      [this.orangeGroup, parameters.orangeColor],
    ]) {
      context.strokeStyle = color;
      context.fillStyle = color;
      for (const [masterIndex, { contourIndex, pointIndex }] of group) {
        const p =
          masters[masterIndex]?.contours[contourIndex]?.points[pointIndex];
        if (p) {
          const q = transforms[masterIndex](p);
          strokeRoundNode(context, q, parameters.groupNodeSize);
          fillRoundNode(context, q, parameters.nodeSize * 1.4);
        }
      }
    }

    // Hover / lasso feedback
    const f = this.feedback;
    if (f.hoverNode) {
      context.strokeStyle =
        this.activeGroup === "blue"
          ? parameters.blueColor
          : parameters.orangeColor;
      context.lineWidth = parameters.strokeWidth;
      strokeRoundNode(context, f.hoverNode, parameters.groupNodeSize);
    }
    if (f.lasso) {
      context.strokeStyle = parameters.marqueeColor;
      context.lineWidth = parameters.strokeWidth;
      context.setLineDash([
        4 * parameters.strokeWidth,
        4 * parameters.strokeWidth,
      ]);
      context.beginPath();
      context.moveTo(f.lasso[0].x, f.lasso[0].y);
      for (const p of f.lasso.slice(1)) {
        context.lineTo(p.x, p.y);
      }
      context.closePath(); // straight line back to the start
      context.stroke();
      context.setLineDash([]);
      context.strokeStyle =
        this.activeGroup === "blue"
          ? parameters.blueColor
          : parameters.orangeColor;
      for (const node of f.lassoSelection) {
        strokeRoundNode(context, node, parameters.groupNodeSize);
      }
    }

    // View angle handle at the origin
    const v = this.getViewVector();
    context.strokeStyle = parameters.blueColor;
    context.fillStyle = parameters.blueColor;
    context.lineWidth = parameters.strokeWidth * (f.hoverHandle ? 2 : 1);
    strokeLine(context, { x: 0, y: 0 }, v);
    fillRoundNode(context, { x: 0, y: 0 }, parameters.nodeSize);
    strokeRoundNode(context, v, parameters.handleSize);
    if (f.hoverHandle) {
      fillRoundNode(context, v, parameters.handleSize * 0.6);
    }
  }
}

// The index of the on-curve node of `contour` at `point`'s position (nodes
// don't move when segments are split or converted), or -1
function findNodeIndex(contour, point) {
  return contour.points.findIndex(
    (p) => isOnCurve(p) && p.x === point.x && p.y === point.y,
  );
}

function haveSameContourCount(masters) {
  return masters.every(
    (m) => m.contours.length === masters[0].contours.length,
  );
}

// Each master's contour list in the order of the reference master's
// (matchContourOrder). Unchanged lists are returned as they are.
function reorderedContourLists(masters, referenceIndex) {
  const reference = masters[referenceIndex].contours;
  const sameCount = haveSameContourCount(masters);
  let reorderedCount = 0;
  const lists = masters.map((master, i) => {
    const order =
      sameCount && i !== referenceIndex
        ? matchContourOrder(reference, master.contours)
        : undefined;
    if (!order || order.every((from, to) => from === to)) {
      return master.contours;
    }
    reorderedCount++;
    return order.map((from) => master.contours[from]);
  });
  return { lists, reorderedCount };
}

// The points from node `from` to node `to` (walking forward) as an open contour
function extractRun(contour, from, to) {
  const points = [];
  const n = contour.points.length;
  for (let i = from; ; i = (i + 1) % n) {
    points.push(contour.points[i]);
    if (i === to || points.length > n) {
      break;
    }
  }
  return { points, isClosed: false };
}
