# Figma

Inspect and edit open Figma design files through the Unify Bridge development plugin: list pages, browse the layer tree, find nodes, read/set selection and node properties, capture node images, export PNG/JPG/SVG/PDF files to disk (one node or batches at several scales), and run Figma Plugin API JavaScript. Requires the Figma desktop app with the Unify Bridge plugin running (figma_install_plugin) and the pairing code entered.

- Author: raisinhvh
- Version: 1.0.0
- Category: Design
- License: MIT

## Tools

- `figma_instances` — List connected Figma files with their current page, editor, user, bridge version and the command each is busy with. Choose an instance id when several files are connected.
- `figma_install_plugin` — Install/update the bundled Unify Bridge Figma development plugin into the Unify data folder. Import the manifest once in Figma, then run the plugin and enter the pairing code.
- `figma_pages` — List pages or switch the current page. page accepts a page id or exact name.
- `figma_tree` — Read the layer tree with node ids, types, names, positions and sizes (x/y relative to the parent). root (a node) or page sets where to start; default is the current page. depth defaults to 3 and maxItems to 200. includeStyle adds fill/stroke hex, opacity, corner radius, auto layout, and text/font/fontSize for text nodes.
- `figma_find` — Find nodes by case-insensitive name substring and/or node type. scope page (default) searches page (or the current page); document loads and searches every page. Each result includes page and pageId.
- `figma_selection` — Get or set the selection on the current page. set switches to the page of the first node, selects the given ids and optionally zooms the viewport to them. Selection and the current page are shared with the user and other agents; prefer passing node ids to other tools.
- `figma_properties` — Read a node's properties (geometry, fills, strokes, effects, auto layout, text, component info). Pass set to assign properties, e.g. {"name":"Button","x":10,"opacity":0.5,"characters":"Hi","fills":[{"type":"SOLID","color":{"r":1,"g":0.5,"b":0},"opacity":0.8}]}. Colors are 0-1 {r,g,b} with opacity as a separate paint field; fills/strokes replace the whole array; x/y are relative to the parent; width/height resize the node; text fonts are loaded automatically. Returns the updated properties and per-key errors.
- `figma_capture_view` — Render a node to PNG and return it as an image plus its id, page, pixel size and effective scale. node defaults to page (if given), else the first selected node, else the current page. scale defaults to 1; the longest side is capped at maxSize.
- `figma_export` — Export one node to a file on disk as PNG, JPG, SVG or PDF. path must be absolute; existing files require overwrite:true. For many nodes or several scales use figma_export_batch.
- `figma_export_batch` — Export several nodes, optionally at several scales, into a folder (e.g. Roblox UI icons). Pass nodes (ids) or childrenOf (a frame/page id; exports its visible direct children). Files are named by pattern with {name}, {id}, {scale} and {ext}. The longest side is capped at maxSize (default 1024, the Roblox limit). Stops after about 45s and returns nextCursor; call again with the same arguments plus cursor to continue. Returns path, node, width, height and scale per file.
- `figma_output_log` — Read print output and errors recorded by figma_execute and other plugin commands. contains filters case-insensitively; default limit 50.
- `figma_execute` — Run JavaScript in the Figma plugin main thread as the body of an async function with figma and print(...values) in scope. Use await for async APIs; the document uses dynamic page loading. Example: const n = await figma.getNodeByIdAsync("12:34"); n.name = "Play"; return n.id. Returns print output and the returned value. Edits are not automatically grouped into one undo step.

## Install

In Unify, open the Hub, find this pack and choose Install. Unify downloads `pack.ts` from this folder, compiles it and writes it to your toolpacks folder. Then it runs `install.js`, which writes the Unify Bridge development plugin into the pack's data folder. The **Finish setup** checklist (from `setup.json`) shows how to import the plugin in Figma and pair it.
