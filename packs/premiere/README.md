# Premiere

Edit Adobe Premiere Pro through a local CEP panel: inspect projects/timelines, import media, organize bins, create sequences, insert/trim/move/remove/razor clips, add tracks and .mogrt titles, set effect parameters and keyframes, mute tracks, add markers, capture frames, export via Media Encoder with job status, and execute ExtendScript. Built for Premiere Pro 2023 (23.x); requires CEP support and an open Unify Bridge panel.

- Author: raisinhvh
- Version: 1.0.0
- Category: Media
- License: MIT

## Tools

- `premiere_instances` — List connected Premiere instances, project files, active sequences and version. Choose an id when several are connected.
- `premiere_install_panel` — Install/update the bundled Unify Bridge CEP panel into the current user Adobe extensions folder. By default enables unsigned CEP panels (PlayerDebugMode) for CSXS 11, used by Premiere 2023. Restart Premiere, then open Window > Extensions > Unify Bridge.
- `premiere_find_presets` — Find installed Adobe export (.epr) and sequence (.sqpreset) presets by filename. Searches Documents/Adobe and installed Adobe applications, or an explicit directory. Does not require Premiere to be connected.
- `premiere_project` — Inspect, open, create, save or save-as a Premiere project. Files require absolute paths. Existing destinations require overwrite:true. Opening/creating may show Premiere dialogs for unsaved work.
- `premiere_tree` — Read the project bin tree with node ids and media paths. The root defaults to the project root; depth defaults to 4 and maxItems to 300.
- `premiere_find` — Find project items by case-insensitive name substring and type. Returns ids for use with other tools.
- `premiere_import_media` — Import existing media files into a bin (root by default). Requires absolute local paths. Reports actual new items; an import can partly succeed.
- `premiere_bin` — Create a bin, rename a project item, or move an item into a bin. Item ids and destination bin are checked before mutation.
- `premiere_sequences` — List, activate, rename, clone, create from a .sqpreset, or create from media project item ids. from_media derives sequence settings from footage; create from a preset uses undocumented QE and can vary by Premiere version.
- `premiere_timeline` — Inspect sequence tracks and clips: node id, track type/index, source in/out, timeline start/end, speed and selection. Times are seconds from sequence/source start; track indices are zero-based. Every track is listed with its clipCount; clips are filtered by trackType/trackIndex and from/to, and capped by maxClips (default 150). truncated:true means more clips matched.
- `premiere_insert_clip` — Insert or overwrite a project item into existing sequence video/audio tracks. time is timeline seconds; track indices default to 0. Optional source in/out are restored on the project item after insertion. Insert may shift other clips; overwrite may replace them. Returns only the new track item ids (video and audio separately) and ids that disappeared, ready for premiere_clip_edit.
- `premiere_clip_edit` — Trim source in/out while preserving timeline start, move one track item to timeline time, rename, enable/disable or remove it. Trimming supports forward clips at normal speed. Linked audio/video are separate: edit each returned node id. Removing defaults to leaving a gap.
- `premiere_selection` — Read or replace the timeline clip selection using node ids. All ids are resolved before changing selection.
- `premiere_playhead` — Read or set the sequence playhead and sequence in/out range in seconds. Returns times and sequence frame duration.
- `premiere_markers` — List, add or delete sequence markers. Delete requires a marker guid from list. Times and duration are seconds.
- `premiere_components` — Inspect effects already on a clip, including Motion, Opacity and audio Volume. Returns component/property indices, display names, raw values (long strings such as Lumetri data are shortened) and keyframe times. Set parameters with premiere_set_parameter; arbitrary new effects can be applied through Premiere UI or premiere_execute.
- `premiere_set_parameter` — Set a parameter on an existing clip effect by component/property index or exact name from premiere_components. value uses Premiere's raw units: Opacity 0-100; Motion Scale 100 = 100%; Motion Position is normalized [x,y] where [0.5,0.5] is frame center; Rotation in degrees; audio Volume Level is linear gain, not dB (gain = 10^((dB - 15) / 20), so 0 dB ≈ 0.178; verify by reading the value back). Color uses [alpha,red,green,blue] 0-255 with color:true. Static writes to animated properties are refused; give a keyframe time instead: timelineTime (sequence seconds, converted for you) or keyframeTime (seconds in the clip's source media time).
- `premiere_track` — Inspect or mute/unmute a video or audio track. Indices are zero-based.
- `premiere_export` — Queue an export in Adobe Media Encoder using an existing .epr preset, or export Final Cut Pro XML. Requires absolute output path. Media jobs return a job id, not completion; poll premiere_export_status with that jobId. The first export of a session waits for Media Encoder to start; call premiere_export_status with launchEncoder:true beforehand to start it separately. Existing output requires overwrite:true.
- `premiere_export_status` — Status of Media Encoder jobs submitted by premiere_export in this Premiere session: queued, encoding (with progress 0-100), complete (with output path) or error. Omit jobId to list all jobs. launchEncoder:true starts Media Encoder without exporting (it can take tens of seconds the first time).
- `premiere_capture_frame` — Render one sequence frame and return it as an image (downscaled to maxSize). By default uses Premiere's frame-to-PNG export, which needs no preset but works only on the active sequence (activate others with premiere_sequences action:"activate") and moves the playhead to time, restoring it afterwards. Pass presetPath (a PNG .epr from premiere_find_presets) to render through Media Encoder's synchronous exporter instead; it restores the in/out range. Rendering blocks Premiere.
- `premiere_output_log` — Read bridge execution events and Media Encoder completion/error events from this Premiere session (progress is in premiere_export_status). Returns entries and nextCursor; pass after:nextCursor next time to read only newer events. contains is case-insensitive. Default limit 50.
- `premiere_execute` — Execute ES3-compatible ExtendScript inside Premiere with app and a print(value) function. Returns print output and the last expression; Premiere objects are returned as their String() form, so return plain values. Scripts block Premiere and cannot be cancelled after starting; no automatic retries and no guaranteed single undo step. QE is undocumented and version-sensitive. Example: var s = app.project.activeSequence; print(s.name); s.videoTracks.numTracks
- `premiere_insert_title` — Insert a Motion Graphics template (.mogrt) such as a title at a timeline time with Sequence.importMGT, optionally setting its text and other template parameters by display name (for example {"Main Title":"Level 2"}). Returns the new track item; list its parameters with premiere_components.
- `premiere_razor` — Split clips at a timeline time, like the Razor tool. Without trackType/trackIndex every track is cut. Uses Premiere's undocumented QE API on the active sequence; the result is verified by counting clips and an error says if nothing was cut. Returns the new clip ids on each cut track.
- `premiere_add_tracks` — Add empty video and/or audio tracks after the existing ones on the active sequence. Uses Premiere's undocumented QE API; the new track counts are verified and returned.

## Install

In Unify, open the Hub, find this pack and choose Install. Unify downloads `pack.ts` from this folder, compiles it and writes it to your toolpacks folder. Then it runs `install.js`, which installs the Unify Bridge CEP panel into Adobe's extensions folder and turns on PlayerDebugMode so the unsigned panel can load (this allows every unsigned CEP panel). The **Finish setup** checklist (from `setup.json`) covers opening the panel.
