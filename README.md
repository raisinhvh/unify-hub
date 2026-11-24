# Unify Toolpack Hub

The public catalogue of toolpacks for Unify. Unify reads `index.json` from
the `main` branch to show the packs on the Hub screen, and downloads one pack's source from
`packs/<pack-id>/` when the user installs it.

Packs in this repository:

| Pack | Category | Tools |
| --- | --- | --- |
| Blender | Studio & 3D | 17 |
| Figma | Design | 12 |
| Imaging | Media | 19 |
| Premiere | Media | 26 |
| Roblox | Studio | 25 |
| Sound | Media | 13 |

Tool counts are in `index.json`. Every pack ships `pack.ts` and its `README.md`; packs that need setup also
ship `setup.json`, an install script, and any companion files `setup.json` lists.

## Install a pack from Unify

1. Open Unify and go to the Hub screen.
2. Pick a pack, read its details and choose **Install** (this device, or all devices where Unify is set up).
3. Unify downloads `packs/<pack-id>/pack.ts`, compiles it, writes the pack to your toolpacks folder and runs
   the pack's install script if it has one (`install.js`, `install.ps1` or `install.sh`).
   The script runs with Unify's Node (`ELECTRON_RUN_AS_NODE`), in the pack folder, with `UNIFY_PACK_DIR` set.
   It does what it can by itself, e.g. copying the Roblox Studio plugin or installing the Blender add-on.
   Programs the pack needs (ImageMagick, ffmpeg, Python) are installed with winget/brew/pip when `setup.json`
   names them; the consent dialog lists each exact command first.
4. Unify shows a **Finish setup** checklist from the pack's `setup.json`: automatic steps say whether they
   worked, and manual steps (importing the Figma plugin, pairing Studio) say exactly what to do.

An installed pack records its Hub id and version in `meta.json`. Installing again replaces the pack and
keeps its enabled setting.

## Remove a pack

Removing a pack in Unify stops it, runs its uninstall script if it has one (`uninstall.js`, `uninstall.ps1` or
`uninstall.sh`, run the same way as the install script), then deletes the pack folder, `data/` included.
A pack whose install script puts anything outside its own folder must ship an uninstall script that undoes
exactly that: Roblox removes the Studio plugin, Blender removes the add-on from every Blender version,
Premiere removes the CEP panel and restores PlayerDebugMode to its value before the install, and Figma
reminds you to remove the development plugin in Figma. Programs installed through `setup.json` (ImageMagick,
ffmpeg, Python) stay, since other apps may use them. The install consent dialog shows the uninstall script too.

## Repository layout

```
index.json                     the catalogue: packs, categories, featured, devices
packs/<pack-id>/pack.ts        the toolpack source the app compiles and installs
packs/<pack-id>/README.md      shown in the Hub detail view
packs/<pack-id>/setup.json     optional: setup checklist and companion `files` to download
packs/<pack-id>/install.js     optional: runs after install (install.ps1 / install.sh also work)
packs/<pack-id>/uninstall.js   optional: runs on removal to undo install.js (uninstall.ps1 / .sh also work)
publishers.json                the GitHub accounts allowed to publish
.github/CODEOWNERS             review ownership
.github/workflows/guard.yml    rejects pushes and pull requests from other accounts
```

`pack.ts` must `export default` an object with a lowercase `name`, a `description`, and a non-empty `tools`
array of `{ name, description, run }` entries. Hub ids are lowercase letters, digits and dashes; the
installed folder name is the same id with dashes replaced by underscores.

`setup.json` is `{ "files"?: string[], "steps": Step[] }`. `files` are plain file names in the pack folder that
Unify downloads with the pack. Each step is `{ id, title, detail?, kind: "auto" | "manual", copy?, open?,
check?: { exists?, command? }, install?: { winget?, brew?, pip? }, optional?, platforms? }`. `detail`, `copy`,
`open` and `check.exists` expand `${PACK}`, `${HOME}` and environment variables such as `${LOCALAPPDATA}`.
`check.exists` is a path or a list of paths (done when any exists); `check.command` is a program name looked up
on PATH, the saved Windows PATH, WinGet's Links folder and pip's user Scripts folders. An automatic step with
`check` is done when it passes; without one, it is done when the install script exited with code 0.

`install` names a package Unify installs itself: `winget` on Windows, `brew` on macOS, otherwise `pip`
(`python -m pip install --user`). Always give a `check` so an existing install is skipped (only steps whose
check fails are listed). Every pending package appears in the dependency dialog before the pack installs:
required steps always install, `optional` steps only when ticked there or later with their **Install** button,
and are never shown as failed. A `pip` step needs no Python step of its own: when no Python is installed,
Unify adds Python 3.12 (`unify:python`) ahead of it. List Python yourself only when the install script needs
a specific Python (Sound builds a venv). Prefer an `install` step over downloading a program in the install
script; download only what no package manager has (pngquant on Windows, Real-ESRGAN).

## Publishing

Publishing is limited to the accounts listed in `publishers.json`. `.github/CODEOWNERS` routes every change
to the owner, and `.github/workflows/guard.yml` fails any push or pull request whose actor is not listed.
Only the owner can merge or push; the app never writes to this repository, it only reads it.

## License

MIT. See `LICENSE`.

## Publisher guard workflow

`docs/guard.workflow.yml` is the Actions guard that rejects pushes and pull requests from accounts not in `publishers.json`. To enable it, move it to `.github/workflows/guard.yml` (pushing workflows needs a token with the `workflow` scope). Until then, writes are already limited by repository ownership and branch protection on `main`.
