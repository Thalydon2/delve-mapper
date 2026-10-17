import { Plugin, TextFileView, PluginSettingTab, Setting, Notice, TFile, TFolder, Modal, normalizePath } from "obsidian";
import { mountEditor } from "./editor.js";

const VIEW_TYPE = "delve-mapper";
const EXT = "dungeon";
const DEFAULTS = { folder: "Maps", ppc: 70, autoPng: true };

const cleanName = s => s.replace(/[\\/:*?"<>|#^\[\]]/g, "").replace(/\.dungeon$/i, "").trim();

// Small dialog that asks for a map name. onSubmit returns an error message, or nothing on success.
class NameModal extends Modal {
  constructor(app, { title, value, cta, onSubmit }) {
    super(app);
    this.opts = { title, value, cta, onSubmit };
  }
  onOpen() {
    const { title, value, cta, onSubmit } = this.opts;
    this.titleEl.setText(title);
    const input = this.contentEl.createEl("input", { type: "text", value: value || "", placeholder: "e.g. Goblin warren" });
    input.style.width = "100%";
    const err = this.contentEl.createEl("div");
    err.style.cssText = "color: var(--text-error); font-size: var(--font-ui-small); min-height: 1.4em; margin-top: 6px;";
    const row = this.contentEl.createDiv();
    row.style.cssText = "display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;";
    const cancel = row.createEl("button", { text: "Cancel" });
    const ok = row.createEl("button", { text: cta, cls: "mod-cta" });
    const submit = async () => {
      ok.disabled = true;
      const msg = await onSubmit(input.value);
      ok.disabled = false;
      if (msg) err.setText(msg); else this.close();
    };
    ok.addEventListener("click", submit);
    cancel.addEventListener("click", () => this.close());
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

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
      id: "rename-map", name: "Rename current map",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(DungeonView);
        if (!view || !view.file) return false;
        if (!checking) this.renameMap(view.file);
        return true;
      },
    });
    // when a map is renamed or moved, take its PNG along (and update links to it)
    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      if (!(file instanceof TFile) || file.extension !== EXT) return;
      const oldPng = this.app.vault.getAbstractFileByPath(oldPath.replace(/\.dungeon$/i, ".png"));
      const newPng = file.path.replace(/\.dungeon$/i, ".png");
      if (oldPng instanceof TFile && !this.app.vault.getAbstractFileByPath(newPng)) {
        try { await this.app.fileManager.renameFile(oldPng, newPng); } catch (e) { console.error("Delve Mapper: couldn't rename PNG", e); }
      }
    }));
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
      if (file instanceof TFile && file.extension === EXT) {
        menu.addItem(item => item.setTitle("Rename map").setIcon("pencil").onClick(() => this.renameMap(file)));
        return;
      }
      if (!(file instanceof TFolder)) return;
      menu.addItem(item => item.setTitle("New dungeon map").setIcon("map").onClick(() => this.createMap(file.path)));
    }));
    this.addSettingTab(new DelveSettingTab(this.app, this));
  }

  createMap(folderPath) {
    const folder = normalizePath(folderPath || this.settings.folder || "/");
    const base = folder === "/" ? "" : folder + "/";
    new NameModal(this.app, {
      title: "New dungeon map", value: "", cta: "Create",
      onSubmit: async raw => {
        const name = cleanName(raw);
        if (!name) return "Enter a name for the map.";
        const vault = this.app.vault, path = base + name + "." + EXT;
        if (vault.getAbstractFileByPath(path)) return "A map called \u201c" + name + "\u201d already exists in " + (folder === "/" ? "the vault root" : folder) + ".";
        try {
          if (folder !== "/" && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
          const blank = { app: "delve-mapper", v: 2, cells: [], walls: [], doors: [], props: [], style: { ppc: this.settings.ppc } };
          const file = await vault.create(path, JSON.stringify(blank));
          await this.app.workspace.getLeaf(true).openFile(file);
        } catch (e) { return "Couldn't create the map: " + (e && e.message ? e.message : e); }
      },
    }).open();
  }

  renameMap(file) {
    new NameModal(this.app, {
      title: "Rename map", value: file.basename, cta: "Rename",
      onSubmit: async raw => {
        const name = cleanName(raw);
        if (!name) return "Enter a name for the map.";
        if (name === file.basename) return;
        const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
        const path = dir + name + "." + EXT;
        if (this.app.vault.getAbstractFileByPath(path)) return "A map called \u201c" + name + "\u201d already exists here.";
        try { await this.app.fileManager.renameFile(file, path); } // the PNG follows via the rename listener
        catch (e) { return "Couldn't rename the map: " + (e && e.message ? e.message : e); }
      },
    }).open();
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
