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

Tool counts are in `index.json`; every pack ships `pack.ts`, its `README.md` and nothing else.

## Install a pack from Unify

1. Open Unify and go to the Hub screen.
2. Pick a pack, read its details and choose **Install** (this device, or all devices where Unify is set up).
3. Unify downloads `packs/<pack-id>/pack.ts`, compiles it, writes the pack to your toolpacks folder and runs
   the pack's install script if it has one (`install.js`, `install.ps1` or `install.sh`).
4. Enable the pack on the Toolpacks screen. Packs that drive a desktop app (Blender, Figma, Premiere,
   Roblox Studio) need that app installed, and its bridge add-on or plugin installed once from the pack.

An installed pack records its Hub id and version in `meta.json`. Installing again replaces the pack and
keeps its enabled setting.

## Repository layout

```
index.json                     the catalogue: packs, categories, featured, devices
packs/<pack-id>/pack.ts        the toolpack source the app compiles and installs
packs/<pack-id>/README.md      shown in the Hub detail view
publishers.json                the GitHub accounts allowed to publish
.github/CODEOWNERS             review ownership
.github/workflows/guard.yml    rejects pushes and pull requests from other accounts
```

`pack.ts` must `export default` an object with a lowercase `name`, a `description`, and a non-empty `tools`
array of `{ name, description, run }` entries. Hub ids are lowercase letters, digits and dashes; the
installed folder name is the same id with dashes replaced by underscores.

## Publishing

Publishing is limited to the accounts listed in `publishers.json`. `.github/CODEOWNERS` routes every change
to the owner, and `.github/workflows/guard.yml` fails any push or pull request whose actor is not listed.
Only the owner can merge or push; the app never writes to this repository, it only reads it.

## License

MIT. See `LICENSE`.

## Publisher guard workflow

`docs/guard.workflow.yml` is the Actions guard that rejects pushes and pull requests from accounts not in `publishers.json`. To enable it, move it to `.github/workflows/guard.yml` (pushing workflows needs a token with the `workflow` scope). Until then, writes are already limited by repository ownership and branch protection on `main`.
