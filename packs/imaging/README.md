# Imaging

Headless image editing with ImageMagick: trim, resize, pad, outline, drop shadow, layer, text, color adjust, sprite sheets, tile slicing, icon sets, format conversion and PNG optimization, plus optional AI background removal and upscaling. All paths are absolute; results include a small preview image.

- Author: raisinhvh
- Version: 1.0.0
- Category: Media
- License: MIT

## Tools

- `imaging_tools_status` — Show which image tools are installed (ImageMagick, pngquant, oxipng, rembg, Real-ESRGAN) and which folders this pack may read and write.
- `imaging_info` — Read image facts: format, width x height, frames, colorspace, whether it has alpha and whether any pixel is transparent, file size.
- `imaging_trim` — Crop away the uniform or transparent border around the subject, then optionally add even padding back. Example: {input, fuzz:5, padding:8}.
- `imaging_resize` — Resize to a width and/or height in pixels. fit: contain (fit inside, keep aspect, default), cover (fill then center-crop to exactly WxH), exact (stretch). Use filter "point" for pixel art.
- `imaging_canvas` — Place the image on a canvas without scaling: pad to WxH or to a square (square:true), or crop if smaller. Anchored by gravity.
- `imaging_outline` — Add a solid stroke around the opaque shape of a transparent image (sticker/icon outline). The canvas grows so the stroke is not clipped. Example: {input, size:4, color:"#000000"}.
- `imaging_drop_shadow` — Add a soft drop shadow behind a transparent image. The canvas grows to fit the shadow.
- `imaging_composite` — Layer images onto a base image in order. Each layer: {file, x, y, gravity, width, height, opacity 0-100, blend}. x/y are px offsets from the gravity anchor (default NorthWest = top-left).
- `imaging_text` — Draw text onto an image. size is in points (≈px at 72 dpi). x/y offset from the gravity anchor. Example: {input, text:"LEVEL 5", gravity:"North", y:20, size:48, color:"white", strokeColor:"black", strokeWidth:3}.
- `imaging_adjust` — Color adjustments; transparency is kept. brightness/saturation/contrast are -100..100 (0 = unchanged; saturation -100 = grayscale), hue rotates -180..180 degrees, tint blends toward a color by tintAmount %.
- `imaging_sprite_sheet` — Pack frames into a grid sprite sheet (row by row, in the given order) and write a JSON frame map next to it (<output>.json with x/y/w/h per frame). Cells default to the largest frame; larger frames are shrunk to fit.
- `imaging_slice_grid` — Cut a sheet into tiles, either by grid (columns x rows) or tile size in px, left-to-right then top-to-bottom. Files are named <prefix>_000.png, <prefix>_001.png ...
- `imaging_icon_set` — Export square PNG icons at several sizes from one image (fit inside, centered on transparent). Files are <stem>_<size>.png. Example: {input, sizes:[512,256,128,64]}.
- `imaging_convert` — Convert to another format chosen by the output extension (.png .jpg .webp .gif .bmp .tga .tif .ico). Formats without alpha (jpg, bmp) are flattened onto background.
- `imaging_optimize` — Shrink a file for upload. PNG: pngquant (lossy, unless lossless:true) then oxipng when installed, else ImageMagick recompression. JPG/WebP: strip metadata and re-encode at quality. Reports before/after size.
- `imaging_remove_background` — Cut out the subject onto transparency with rembg (AI). Requires rembg: `pip install "rembg[cli]"`. Output is PNG.
- `imaging_upscale` — AI upscale 2x/3x/4x with realesrgan-ncnn-vulkan (GPU). model: anime (flat/cartoon art, default) or photo. Output is PNG. Large inputs may exceed the 50s limit; keep inputs under ~512px.
- `imaging_magick_raw` — Escape hatch: run ImageMagick with your own argument list (no shell), e.g. ["C:/in.png","-blur","0x3","C:/out.png"]. Input/output paths must be absolute and inside the allowed folders; the last argument is the output. @files, URLs, script coders, -script and %[...] are refused. Prefer the dedicated tools.
- `imaging_pipeline` — Run several one-image edits in order in one call: each step's output is the next step's input, in-between files are temporary, and only the final file is listed and previewed. Steps: trim, resize, canvas, outline, drop_shadow, composite, text, adjust, convert, optimize, remove_background, upscale; each is {op, ...that tool's arguments without input/output}. Example: {input, output, steps:[{op:"trim",padding:8},{op:"outline",size:4},{op:"resize",width:256,height:256},{op:"optimize"}]}. All steps share one 50s budget. The output extension picks the final format.

## Install

In Unify, open the Hub, find this pack and choose Install. Unify downloads `pack.ts` from this folder, compiles it and writes it to your toolpacks folder. There is no install script and no dependencies are installed by the Hub.
