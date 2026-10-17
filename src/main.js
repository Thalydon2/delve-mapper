import { Plugin, TextFileView, PluginSettingTab, Setting, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { mountEditor } from "./editor.js";

const VIEW_TYPE = "delve-mapper";
const EXT = "dungeon";
const DEFAULTS = { folder: "Maps", ppc: 70, autoPng: true };

class DungeonView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.data = "";
    this.editor = null;
    this.pngTimer = 0;
    this.dirtyPng = false;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.file ? this.file.basename : "Dungeon map"; }
  getIcon() { return "map"; }
  canAcceptExtension(ext) { return ext === EXT; }

  ensureEditor() {
    if (this.editor) return this.editor;
    this.contentEl.empty();
    this.contentEl.addClass("dm-view");
    const root = this.contentEl.createDiv({ cls: "dm-root" });
    this.editor = mountEditor(root, {
      ppc: this.plugin.settings.ppc,
      onChange: data => {
        this.data = JSON.stringify(data);
        this.requestSave();
        if (this.plugin.settings.autoPng) this.schedulePng();
      },
      onExportPng: blob => this.writePng(blob, true),
    });
    return this.editor;
  }

  async onOpen() { this.ensureEditor(); }

  getViewData() { return this.data; }

  setViewData(data, clear) {
    this.data = data;
    let parsed = null;
    if (data && data.trim()) {
      try { parsed = JSON.parse(data); }
      catch (e) { new Notice("Delve Mapper couldn't read this map file, so it opened blank. Close it without drawing to keep the original file unchanged.", 8000); }
    }
    this.ensureEditor().setData(parsed);
  }

  clear() { this.data = ""; }

  schedulePng() {
    this.dirtyPng = true;
    window.clearTimeout(this.pngTimer);
    this.pngTimer = window.setTimeout(() => this.flushPng(), 2000);
  }

  async flushPng() {
    window.clearTimeout(this.pngTimer);
    if (!this.dirtyPng || !this.editor || !this.file) return;
    this.dirtyPng = false;
    const blob = await this.editor.renderPng();
    if (blob) await this.writePng(blob, false);
  }

  async writePng(blob, announce) {
    if (!this.file) return;
    const path = this.file.path.replace(/\.dungeon$/i, ".png");
    const buf = await blob.arrayBuffer();
    const vault = this.app.vault;
    try {
      const existing = vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await vault.modifyBinary(existing, buf);
      else await vault.createBinary(path, buf);
      if (announce) new Notice("Saved " + path);
    } catch (e) {
      console.error("Delve Mapper: PNG export failed", e);
      new Notice("Delve Mapper couldn't write " + path + ". " + (e && e.message ? e.message : ""));
    }
  }

  async onUnloadFile(file) {
    await this.flushPng();
    return super.onUnloadFile(file);
  }

  async onClose() {
    await this.flushPng();
    if (this.editor) { this.editor.destroy(); this.editor = null; }
  }
}

export default class DelveMapperPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.registerView(VIEW_TYPE, leaf => new DungeonView(leaf, this));
    this.registerExtensions([EXT], VIEW_TYPE);

    this.addRibbonIcon("map", "New dungeon map", () => this.createMap());
    this.addCommand({ id: "new-map", name: "Create new dungeon map", callback: () => this.createMap() });
    this.addCommand({
      id: "update-png", name: "Update PNG for current map",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(DungeonView);
        if (!view) return false;
        if (!checking) view.editor.renderPng().then(b => b ? view.writePng(b, true) : new Notice("Draw a room first, then export."));
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFolder)) return;
      menu.addItem(item => item.setTitle("New dungeon map").setIcon("map").onClick(() => this.createMap(file.path)));
    }));
    this.addSettingTab(new DelveSettingTab(this.app, this));
  }

  async createMap(folderPath) {
    const folder = normalizePath(folderPath || this.settings.folder || "/");
    const vault = this.app.vault;
    if (folder !== "/" && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
    const base = folder === "/" ? "" : folder + "/";
    let name = "Untitled map", i = 1;
    while (vault.getAbstractFileByPath(base + name + "." + EXT)) name = "Untitled map " + ++i;
    const blank = { app: "delve-mapper", v: 2, cells: [], walls: [], doors: [], props: [], style: { ppc: this.settings.ppc } };
    const file = await vault.create(base + name + "." + EXT, JSON.stringify(blank));
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async saveSettings() { await this.saveData(this.settings); }
}

class DelveSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Folder for new maps")
      .setDesc("New dungeon maps are created here. Leave blank for the vault root.")
      .addText(t => t.setPlaceholder("Maps").setValue(this.plugin.settings.folder).onChange(async v => { this.plugin.settings.folder = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("Pixels per square for new maps")
      .setDesc("Resolution of the PNG. Match your Atlas VTT grid size so maps line up. Each map can change this in its own panel.")
      .addDropdown(d => { ["50", "70", "100", "140"].forEach(v => d.addOption(v, v)); d.setValue(String(this.plugin.settings.ppc)).onChange(async v => { this.plugin.settings.ppc = +v; await this.plugin.saveSettings(); }); });
    new Setting(containerEl)
      .setName("Keep a PNG next to each map")
      .setDesc("Writes crypt.png beside crypt.dungeon a couple of seconds after each change, so ![[crypt.png]] and Atlas scenes stay current.")
      .addToggle(t => t.setValue(this.plugin.settings.autoPng).onChange(async v => { this.plugin.settings.autoPng = v; await this.plugin.saveSettings(); }));
  }
}
