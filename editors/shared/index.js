// Barrel for the shared editor toolkit. Editors import everything from here
// (`/editors/shared/index.js`). Internals import each other DIRECTLY (never via
// this barrel) to avoid an import cycle.

export { SaveManager } from './saveManager.js';
export { PreviewCanvas, EditorPreviewCamera, createResizer } from './canvas.js';
export {
  THEMES, current, applyTheme, onThemeChange, initThemePicker, themeColor, themeColorRgba,
} from './theme.js';
export { loadManifest, getManifest } from './manifest.js';
export {
  NumberSlider, RangeInput, RandomizableSlider, ColorInput, Select, TextInput,
  Toggle, Button, ListEditor, PropertyGroup, TreeView, CoordEditor, TagListEditor,
  setCoordReadout,
} from './widgets.js';
export {
  isModalOpen, openModal, modalAlert, modalConfirm, modalPrompt, modalSelect,
  modalBtn, btnRow,
} from './modals.js';
