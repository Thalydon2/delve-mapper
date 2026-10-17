# Delve Mapper

Grid dungeon and outdoor map editor for Obsidian. Maps are `.dungeon` files (JSON); a PNG with the same name is kept beside each one for embedding in notes and using as Atlas VTT scenes.

## Layout

- `src/editor.js` – the map editor (drawing, textures, hatching, props, undo). Mounted into a container element.
- `src/markup.html` – the editor's toolbar and side panel markup.
- `src/main.js` – the Obsidian plugin: `.dungeon` file view, commands, PNG writing, settings.
- `styles.css` – editor styles, scoped under `.dm-root` and using Obsidian theme variables.
- `manifest.json` – plugin manifest.
- `web/index.html` – the original standalone browser version.

## Build and install

```sh
npm install
npm run build    # writes dist/main.js, dist/manifest.json, dist/styles.css
npm run deploy   # builds and copies into ~/The Luggage/.obsidian/plugins/delve-mapper/
```

Then reload the plugin in Obsidian (toggle it off and on in Community plugins).
