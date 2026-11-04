// Fontra editor plug-in entry point (see plugin.json).
//
// Fontra calls init(editor, pluginPath) when the glyph editor opens. `editor`
// is the editor controller, `pluginPath` the plug-in's base URL without a
// trailing slash.

import { createCurvePointTool } from "./curve-point-tool.js";
import { MatchmakerTool } from "./matchmaker-tool.js";
import { ScissorsTool } from "./scissors-tool.js";
import { createMatchmakerPanel } from "./matchmaker-panel.js";
import { setToolButtonTitle } from "./editor-glue.js";

export function init(editor, pluginPath) {
  // first in the toolbar: a multi-tool with a cubic and a quadratic mode, like
  // the pen tool
  const curvePointTool = createCurvePointTool(editor, pluginPath);
  editor.addEditTool(curvePointTool);
  for (const tool of Object.values(editor.tools)) {
    if (tool.identifier?.startsWith(`${curvePointTool.identifier}-`)) {
      setToolButtonTitle(tool.identifier, tool.title);
    }
  }

  const scissorsTool = new ScissorsTool(editor, pluginPath);
  const matchmakerTool = new MatchmakerTool(editor, pluginPath);
  for (const tool of [scissorsTool, matchmakerTool]) {
    editor.addEditTool(tool);
    setToolButtonTitle(tool.identifier, tool.title);
  }

  editor.addSidebarPanel(
    createMatchmakerPanel(editor, matchmakerTool, pluginPath),
    "right",
  );
  const tab = document.querySelector(
    `.sidebar-tab[data-sidebar-name="curvekit-matchmaker"]`,
  );
  if (tab) {
    tab.title = "Matchmaker";
  }

  // Fontra's buttons are created "selected"; addEditTool leaves ours that way
  // until a tool is chosen, so restore the current selection.
  editor.setSelectedTool(editor.selectedToolIdentifier || "pointer-tool");
}
