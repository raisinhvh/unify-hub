import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

interface ToolpackContext { log(message: string): void; status(text: string): void; dataDir: string }
interface ToolpackTool {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    run(args: Record<string, unknown>, ctx: ToolpackContext): unknown | Promise<unknown>;
}
interface ToolpackDefinition {
    name: string;
    description: string;
    tools: ToolpackTool[];
    setup?(ctx: ToolpackContext): void | Promise<void>;
    teardown?(): void | Promise<void>;
}

/** IM7 runs everything through `magick`; IM6 (non-Windows fallback only) has separate `convert` and `identify`. */
interface Magick { mode: 'im7' | 'im6'; convert: string[]; identify: string[]; version: string }
interface Optional { pngquant?: string; oxipng?: string; rembg?: string; realesrgan?: string }

/** The host kills a call at 60s, so every call (all steps together) must finish before this. */
const CALL_BUDGET_MS = 50_000;
const PREVIEW_PX = 512;
const IMAGE_EXT: Record<string, string> = {
    '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP', '.gif': 'GIF', '.bmp': 'BMP',
    '.tga': 'TGA', '.tif': 'TIFF', '.tiff': 'TIFF', '.ico': 'ICO', '.psd': 'PSD', '.dds': 'DDS',
};
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc']);
/** One-image edits imaging_pipeline can chain. */
const PIPELINE_STEPS = ['trim', 'resize', 'canvas', 'outline', 'drop_shadow', 'composite', 'text', 'adjust', 'convert', 'optimize', 'remove_background', 'upscale'];
const MAX_PIPELINE_STEPS = 12;
/** ImageMagick expands these in file names (frame selection, sequences, globs, percent escapes). */
const BAD_PATH_CHARS = /[[\]*?%<>|"\x00-\x1f]/;
const SENSITIVE_DIR = /^\.(ssh|gnupg|aws|azure|kube|docker|git)$/i;
const GRAVITIES = ['NorthWest', 'North', 'NorthEast', 'West', 'Center', 'East', 'SouthWest', 'South', 'SouthEast'];
const BLENDS: Record<string, string> = {
    over: 'Over', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', add: 'Plus', darken: 'Darken', lighten: 'Lighten',
    softlight: 'SoftLight', hardlight: 'HardLight', difference: 'Difference', colordodge: 'ColorDodge', colorburn: 'ColorBurn',
};
/** Format coders magick_raw may name explicitly (`png:out.png`) and built-in generators that read no files. */
const RAW_CODERS = new Set([...Object.values(IMAGE_EXT).map(coder => coder.toLowerCase()), 'jpg', 'png8', 'png24', 'png32', 'png48', 'png64', 'xc', 'canvas', 'gradient', 'radial-gradient', 'pattern', 'null', 'info', 'label', 'caption', 'plasma', 'rose', 'logo', 'granite', 'checkerboard']);
const RAW_BLOCKED_OPTIONS = new Set(['-script', '-process', '-module', '-debug', '-log', '-authenticate', '-path']);
const RAW_BLOCKED_TOOLS = new Set(['conjure', 'import', 'display', 'animate', 'mogrify', 'stream', 'magick-script']);
const RAW_TOOLS = new Set(['identify', 'compare', 'composite', 'montage', 'convert']);

const state: { ctx?: ToolpackContext; magick?: Magick; optional: Optional; roots: string[] } = { optional: {}, roots: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
    return value;
}

function requiredString(args: Record<string, unknown>, name: string): string {
    const value = optionalString(args, name);
    if (value === undefined || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
    return value;
}

function optionalNumber(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
    const value = args[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
    return value;
}

function number(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    return optionalNumber(args, name, min, max) ?? fallback;
}

function integer(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    const value = number(args, name, fallback, min, max);
    if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
    return value;
}

function optionalInteger(args: Record<string, unknown>, name: string, min: number, max: number): number | undefined {
    return args[name] === undefined || args[name] === null ? undefined : integer(args, name, 0, min, max);
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
    const value = args[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
    return value;
}

function stringList(args: Record<string, unknown>, name: string, max: number): string[] {
    const value = args[name];
    if (!Array.isArray(value) || !value.length || value.length > max || value.some(item => typeof item !== 'string')) throw new Error(`${name} must be an array of 1 to ${max} strings.`);
    return value as string[];
}

function color(args: Record<string, unknown>, name: string, fallback: string): string {
    const value = (optionalString(args, name) ?? fallback).trim();
    if (/^transparent$/i.test(value)) return 'none';
    if (!/^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]{3,24}\d{0,2}|(rgb|rgba|hsl|hsla)\([\d.,\s%]{1,48}\))$/i.test(value)) throw new Error(`${name} must be a color like "#ff8800", "#ff880080", "white", "rgba(0,0,0,0.5)" or "transparent".`);
    return value;
}

function gravity(args: Record<string, unknown>, name = 'gravity', fallback = 'Center'): string {
    const value = optionalString(args, name) ?? fallback;
    const found = GRAVITIES.find(item => item.toLowerCase() === value.toLowerCase());
    if (!found) throw new Error(`${name} must be one of ${GRAVITIES.join(', ')}.`);
    return found;
}

function formatBytes(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise(resolve => {
        execFile(file, args, { timeout: Math.max(1_000, timeoutMs), windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0;
            const killed = !!error && (error as { killed?: boolean }).killed;
            resolve({ stdout: String(stdout), stderr: killed ? `Timed out after ${Math.round(timeoutMs / 1000)}s.` : String(stderr || (error && !stdout ? error.message : '')), code });
        });
    });
}

class Deadline {
    private readonly end = Date.now() + CALL_BUDGET_MS;
    public left(): number {
        const left = this.end - Date.now();
        if (left < 1_000) throw new Error(`Ran out of time (calls are limited to ${CALL_BUDGET_MS / 1000}s). Use a smaller image or fewer files per call.`);
        return left;
    }
}

/** Pipeline steps carry the pipeline's deadline under this key, so all steps share one call budget. */
const SHARED_DEADLINE = Symbol('deadline');

function deadlineFor(args: Record<string, unknown>): Deadline {
    const shared = (args as Record<symbol, unknown>)[SHARED_DEADLINE];
    return shared instanceof Deadline ? shared : new Deadline();
}

async function listDirs(dir: string): Promise<string[]> {
    try { return (await readdir(dir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name); }
    catch { return []; }
}

/** Candidate executables named `name` on PATH, after an explicit env override. */
function onPath(name: string, envVar: string): string[] {
    const found: string[] = [];
    if (process.env[envVar]) found.push(process.env[envVar]!);
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) found.push(join(dir, exe));
    return found;
}

async function findMagick(): Promise<Magick | undefined> {
    const candidates: string[] = [];
    if (process.env.DSH_MAGICK_PATH) candidates.push(process.env.DSH_MAGICK_PATH);
    if (process.platform === 'win32') {
        for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((item): item is string => !!item)) {
            const versions = (await listDirs(base)).filter(name => /^ImageMagick-7/i.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const version of versions) candidates.push(join(base, version, 'magick.exe'));
        }
    }
    candidates.push(...onPath('magick', 'DSH_MAGICK_PATH'));
    const magick = candidates.find(path => existsSync(path));
    if (magick) {
        const version = await run(magick, ['-version'], 10_000);
        if (version.code === 0) return { mode: 'im7', convert: [magick], identify: [magick, 'identify'], version: version.stdout.split(/\r?\n/)[0] };
    }
    // Windows ships an unrelated convert.exe (a disk tool), so IM6 names are only trusted elsewhere.
    if (process.platform === 'win32') return undefined;
    const convert = onPath('convert', 'DSH_CONVERT_PATH').find(path => existsSync(path));
    const identify = onPath('identify', 'DSH_IDENTIFY_PATH').find(path => existsSync(path));
    if (!convert || !identify) return undefined;
    const version = await run(convert, ['-version'], 10_000);
    if (version.code !== 0 || !/ImageMagick/i.test(version.stdout)) return undefined;
    return { mode: 'im6', convert: [convert], identify: [identify], version: version.stdout.split(/\r?\n/)[0] };
}

async function findOptional(): Promise<Optional> {
    const first = (paths: string[]): string | undefined => paths.find(path => existsSync(path));
    const pythonScripts: string[] = [];
    if (process.platform === 'win32') {
        for (const base of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python'), process.env.APPDATA && join(process.env.APPDATA, 'Python')].filter((item): item is string => !!item)) {
            for (const version of (await listDirs(base)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) pythonScripts.push(join(base, version, 'Scripts', 'rembg.exe'));
        }
    } else pythonScripts.push(join(homedir(), '.local', 'bin', 'rembg'));
    return {
        pngquant: first(onPath('pngquant', 'DSH_PNGQUANT_PATH')),
        oxipng: first(onPath('oxipng', 'DSH_OXIPNG_PATH')),
        rembg: first([...onPath('rembg', 'DSH_REMBG_PATH'), ...pythonScripts]),
        realesrgan: first(onPath('realesrgan-ncnn-vulkan', 'DSH_REALESRGAN_PATH')),
    };
}

async function magick(): Promise<Magick> {
    // Re-scan when missing so installing ImageMagick mid-session works without reloading the pack.
    state.magick ??= await findMagick();
    if (!state.magick) throw new Error('ImageMagick 7 was not found. Install it from https://imagemagick.org/script/download.php#windows (keep "Add application directory to your system path" checked) or set DSH_MAGICK_PATH to magick.exe, then retry.');
    return state.magick;
}

function limits(): string[] {
    return ['-limit', 'width', '16384', '-limit', 'height', '16384', '-limit', 'area', '256MP', '-limit', 'memory', '1GiB', '-limit', 'disk', '4GiB', '-limit', 'time', String(CALL_BUDGET_MS / 1000 - 5)];
}

function cleanError(text: string): string {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 8).join('\n') || 'ImageMagick failed without a message.';
}

/** Runs `magick <args>` (IM7) or `convert <args>` (IM6) with resource limits in front. */
async function convert(args: string[], deadline: Deadline): Promise<string> {
    const im = await magick();
    const result = await run(im.convert[0], [...im.convert.slice(1), ...limits(), ...args], deadline.left());
    if (result.code !== 0) throw new Error(cleanError(result.stderr));
    return result.stdout;
}

async function identify(args: string[], deadline: Deadline): Promise<string> {
    const im = await magick();
    const result = await run(im.identify[0], [...im.identify.slice(1), ...limits(), ...args], deadline.left());
    if (result.code !== 0) throw new Error(cleanError(result.stderr));
    return result.stdout;
}

// ---------- Paths ----------

async function computeRoots(dataDir: string): Promise<string[]> {
    const raw = [dataDir, process.cwd(), ...(process.env.DSH_IMAGING_ROOTS ?? '').split(delimiter)];
    // Without explicit roots, allow the user's home folder (which also holds DSH's per-chat working copies).
    if (!process.env.DSH_IMAGING_ROOTS?.trim()) raw.push(homedir());
    const roots: string[] = [];
    for (const item of raw) {
        if (!item?.trim() || !isAbsolute(item.trim())) continue;
        try { roots.push(await realpath(item.trim())); } catch { /* Root does not exist. */ }
    }
    return [...new Set(roots)];
}

function norm(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path;
}

function within(path: string, root: string): boolean {
    const rel = relative(norm(root), norm(path));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Real path of `path`, or of its deepest existing ancestor joined with the rest. */
async function realOrAncestor(path: string): Promise<string> {
    let current = path;
    const rest: string[] = [];
    for (;;) {
        try { return join(await realpath(current), ...rest.reverse()); } catch { /* Keep climbing. */ }
        const parent = dirname(current);
        if (parent === current) return path;
        rest.push(basename(current));
        current = parent;
    }
}

function assertAllowed(real: string, original: string): void {
    if (!state.roots.some(root => within(real, root))) throw new Error(`${original} is outside the folders this pack may use (${state.roots.join(', ')}). Use a path inside them, or add a folder to the DSH_IMAGING_ROOTS environment variable.`);
    const root = state.roots.find(item => within(real, item))!;
    if (relative(norm(root), norm(real)).split(/[\\/]/).some(part => SENSITIVE_DIR.test(part))) throw new Error(`${original} is inside a protected folder.`);
}

/** Validates an image path for reading or writing and returns its absolute form. */
async function checkPath(raw: string, kind: 'input' | 'output', extensions: Set<string> | Record<string, string> = IMAGE_EXT, name: string = kind): Promise<string> {
    if (!isAbsolute(raw)) throw new Error(`${name} must be an absolute path (got "${raw}").`);
    if (BAD_PATH_CHARS.test(raw)) throw new Error(`${name} contains a character ImageMagick treats specially ([ ] * ? % < > | "). Rename the file or folder.`);
    const full = resolve(raw);
    const ext = extname(full).toLowerCase();
    const allowed = extensions instanceof Set ? extensions.has(ext) : ext in extensions;
    if (!allowed) throw new Error(`${name} must end in ${(extensions instanceof Set ? [...extensions] : Object.keys(extensions)).join(' ')} (got "${ext || 'no extension'}").`);
    if (kind === 'input') {
        let real: string;
        try { real = await realpath(full); } catch {
            // Check the folder first so the error never reveals whether files outside the roots exist.
            assertAllowed(await realOrAncestor(full), full);
            throw new Error(`${name} does not exist: ${full}`);
        }
        if (!(await stat(real)).isFile()) throw new Error(`${name} is not a file: ${full}`);
        assertAllowed(real, full);
        return real;
    }
    try {
        const info = await lstat(full);
        if (info.isSymbolicLink()) throw new Error(`${name} is a symbolic link; write to a real file instead.`);
        if (info.isDirectory()) throw new Error(`${name} is a folder; give a file name ending in an image extension.`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    assertAllowed(await realOrAncestor(full), full);
    return full;
}

/** Validates a folder to write into (created if missing). */
async function checkDir(raw: string, name: string): Promise<string> {
    if (!isAbsolute(raw)) throw new Error(`${name} must be an absolute path.`);
    if (BAD_PATH_CHARS.test(raw)) throw new Error(`${name} contains a character ImageMagick treats specially ([ ] * ? % < > | ").`);
    const full = resolve(raw);
    assertAllowed(await realOrAncestor(full), full);
    await mkdir(full, { recursive: true });
    return full;
}

/** Forces the decoder/encoder from the extension so file contents can't pick a script-capable format (SVG, MVG, MSL). */
function coded(path: string): string {
    return `${IMAGE_EXT[extname(path).toLowerCase()]}:${path}`;
}

function samePath(a: string, b: string): boolean {
    return norm(resolve(a)) === norm(resolve(b));
}

async function prepareOutput(target: string, overwrite: boolean, inputs: string[], name = 'output'): Promise<string> {
    const output = await checkPath(target, 'output', IMAGE_EXT, name);
    if (!overwrite) {
        if (inputs.some(input => samePath(input, output))) throw new Error(`${name} is the same file as an input. Pass overwrite:true to replace it, or choose another output.`);
        if (existsSync(output)) throw new Error(`${output} already exists. Pass overwrite:true to replace it, or choose another output.`);
    }
    await mkdir(dirname(output), { recursive: true });
    return output;
}

/** The explicit `output`, or `<input folder>/<input stem><suffix><ext>`. */
async function outputFor(args: Record<string, unknown>, input: string, suffix: string, ext?: string): Promise<string> {
    const raw = optionalString(args, 'output');
    const target = raw ?? join(dirname(input), basename(input, extname(input)) + suffix + (ext ?? extname(input)));
    return prepareOutput(target, optionalBoolean(args, 'overwrite') === true, [input]);
}

async function input(args: Record<string, unknown>, name = 'input'): Promise<string> {
    return checkPath(requiredString(args, name), 'input', IMAGE_EXT, name);
}

/** Only these formats keep transparency, so alpha-producing ops default to PNG. */
function alphaExt(file: string): string {
    return ['.png', '.webp', '.gif', '.tga', '.tif', '.tiff', '.psd', '.dds'].includes(extname(file).toLowerCase()) ? extname(file) : '.png';
}

// ---------- Results ----------

interface Size { width: number; height: number }

async function sizes(files: string[], deadline: Deadline): Promise<Size[]> {
    if (!files.length) return [];
    const out = await identify(['-format', '%w %h\n', ...files.map(file => `${coded(file)}[0]`)], deadline);
    const lines = out.trim().split(/\r?\n/);
    return files.map((_, index) => {
        const [width, height] = (lines[index] ?? '0 0').split(' ').map(Number);
        return { width, height };
    });
}

async function previewImage(file: string, deadline: Deadline): Promise<string | undefined> {
    const temp = join(tmpdir(), `dsh-imaging-${randomBytes(6).toString('hex')}.png`);
    try {
        await convert([`${coded(file)}[0]`, '-thumbnail', `${PREVIEW_PX}x${PREVIEW_PX}>`, `PNG32:${temp}`], deadline);
        return (await readFile(temp)).toString('base64');
    } catch { return undefined; } finally { await rm(temp, { force: true }).catch(() => undefined); }
}

/**
 * Lists written files with size and dimensions, plus a downscaled preview of `previewOf` unless preview:false.
 * `data` lets a DSH batch chain the files, e.g. "{{1.files[0].path}}" as the next tool's input.
 */
async function done(args: Record<string, unknown>, files: string[], deadline: Deadline, options: { note?: string; previewOf?: string; listLimit?: number } = {}): Promise<unknown> {
    const limit = options.listLimit ?? 40;
    const shown = files.slice(0, limit);
    const dims = await sizes(shown, deadline);
    const bytes = await Promise.all(shown.map(async file => (await stat(file)).size));
    const lines = shown.map((file, index) => `${file}  ${dims[index].width}x${dims[index].height}  ${formatBytes(bytes[index])}`);
    if (files.length > limit) lines.push(`...and ${files.length - limit} more in ${dirname(files[0])}`);
    if (options.note) lines.push(options.note);
    const text = lines.join('\n');
    const data = {
        files: shown.map((file, index) => ({ path: file, width: dims[index].width, height: dims[index].height, bytes: bytes[index] })),
        ...(files.length > limit ? { moreFiles: files.length - limit } : {}),
    };
    const target = options.previewOf ?? files[0];
    const image = optionalBoolean(args, 'preview') === false || !target ? undefined : await previewImage(target, deadline);
    return { content: [{ type: 'text', text }, ...(image ? [{ type: 'image', mimeType: 'image/png', data: image }] : [])], data };
}

/** The text part of a tool result (a string, or the first text block of { content }). */
function resultText(result: unknown): string {
    if (typeof result === 'string') return result;
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    const block = content.find(item => isRecord(item) && item.type === 'text');
    return isRecord(block) && typeof block.text === 'string' ? block.text : '';
}

// ---------- Schemas ----------

const pathNote = 'Absolute path';
const io = {
    input: { type: 'string', description: `${pathNote} of the source image.` },
    output: { type: 'string', description: 'Absolute output path; its extension picks the format. Default: next to the input with a suffix.' },
    overwrite: { type: 'boolean', description: 'Replace an existing output (or the input itself). Default false.' },
    preview: { type: 'boolean', description: 'Return a ≤512px preview image. Default true.' },
};
const colorSchema = (description: string) => ({ type: 'string', description: `${description} Hex, name, rgba() or "transparent".` });
const gravitySchema = { type: 'string', enum: GRAVITIES, description: 'Anchor. Default Center.' };
const schema = (properties: Record<string, unknown>, required: string[] = ['input']) => ({ type: 'object', properties, required, additionalProperties: false });

function textArg(value: string): string {
    // A leading @ makes ImageMagick read the text from a file; % starts escapes like %[filename].
    return (value.startsWith('@') ? `\u200b${value}` : value).replace(/%/g, '%%');
}

function fontArgs(args: Record<string, unknown>): string[] {
    const font = optionalString(args, 'font');
    if (!font) return [];
    if (/[\\/]/.test(font)) {
        if (!isAbsolute(font) || !FONT_EXT.has(extname(font).toLowerCase()) || !existsSync(font)) throw new Error('font must be a font name (e.g. "Arial") or an absolute path to an existing .ttf/.otf/.ttc file.');
    } else if (!/^[\w .+-]{1,64}$/.test(font)) throw new Error('font must be a font name like "Arial" or "Segoe-UI-Bold".');
    return ['-font', font];
}

// ---------- magick_raw validation ----------

const PATHLIKE = /[\\/]|\.[a-z][a-z0-9]{1,4}$/i;
/** Options whose next argument is a free-form value, not a file (e.g. -define png:compression-level=9). */
const RAW_VALUE_OPTIONS = new Set(['-define', '-set', '-format', '-comment', '-label', '-annotate', '-fx', '-draw', '-family', '-gravity', '-compose']);

async function rawArgs(list: string[]): Promise<{ args: string[]; outputs: string[] }> {
    if (!list.length || list.length > 200) throw new Error('args must hold 1 to 200 strings.');
    const out: string[] = [];
    const outputs: string[] = [];
    let tool: string | undefined;
    let start = 0;
    if (RAW_BLOCKED_TOOLS.has(list[0].toLowerCase())) throw new Error(`"${list[0]}" is not allowed.`);
    if (RAW_TOOLS.has(list[0].toLowerCase())) { tool = list[0].toLowerCase(); start = 1; }
    const lastPathIndex = tool === 'identify' ? -1 : list.length - 1;
    for (let index = start; index < list.length; index++) {
        const arg = list[index];
        if (typeof arg !== 'string' || arg.length > 4096) throw new Error('Each arg must be a string under 4096 characters.');
        const lower = arg.toLowerCase();
        if (arg.startsWith('@')) throw new Error(`"${arg}": @file arguments are not allowed.`);
        if (arg.includes('|')) throw new Error(`"${arg}": pipes are not allowed.`);
        if (arg.includes('%[')) throw new Error(`"${arg}": %[...] escapes are not allowed in magick_raw.`);
        if (RAW_BLOCKED_OPTIONS.has(lower)) throw new Error(`"${arg}" is not allowed.`);
        if (lower === '-set' && /^filename:/i.test(list[index + 1] ?? '')) throw new Error('-set filename: is not allowed.');
        if (lower === '-limit') throw new Error('-limit is set by the pack.');
        if (/^[-+]/.test(arg) && !/^[-+]\d/.test(arg)) { out.push(arg); continue; }
        const previous = (list[index - 1] ?? '').toLowerCase();
        if (previous === '-draw' && /image|url\s*\(|@/i.test(arg)) throw new Error('-draw image/url()/@ primitives are not allowed; use composite instead.');
        if ((RAW_VALUE_OPTIONS.has(previous) || (list[index - 2] ?? '').toLowerCase() === '-annotate') && index !== lastPathIndex) { out.push(arg); continue; }
        const isOutput = index === lastPathIndex || previous === '-write';
        const coder = /^([a-z][a-z0-9_-]{1,31}):(.*)$/is.exec(arg);
        if (coder && !/^[a-z]:[\\/]/i.test(arg)) {
            const name = coder[1].toLowerCase();
            const rest = coder[2];
            if (!RAW_CODERS.has(name)) throw new Error(`"${name}:" is not allowed in magick_raw (allowed: ${[...RAW_CODERS].join(', ')}).`);
            if ((name === 'label' || name === 'caption') && rest.trimStart().startsWith('@')) throw new Error('label:@/caption:@ file reads are not allowed.');
            if (['xc', 'canvas', 'gradient', 'radial-gradient', 'pattern', 'null', 'info', 'label', 'caption', 'plasma', 'rose', 'logo', 'granite', 'checkerboard'].includes(name)) {
                if (name === 'info' && rest) throw new Error('info: may only write to standard output.');
                if (name === 'null' && rest) throw new Error('null: takes no file.');
                out.push(name === 'label' || name === 'caption' ? `${name}:${rest.replace(/%/g, '%%')}` : arg);
                if (isOutput && name !== 'info' && name !== 'null') throw new Error('The last argument must be an output file (or info:/null:).');
                continue;
            }
            const path = await checkRawPath(rest.replace(/\[[\d,x+-]*\]$/, ''), isOutput);
            out.push(`${coder[1]}:${path}${/\[[\d,x+-]*\]$/.exec(rest)?.[0] ?? ''}`);
            if (isOutput) outputs.push(path);
            continue;
        }
        if (isOutput || PATHLIKE.test(arg)) {
            const frame = /\[[\d,x+-]*\]$/.exec(arg)?.[0] ?? '';
            const bare = frame ? arg.slice(0, -frame.length) : arg;
            if (!isOutput && FONT_EXT.has(extname(bare).toLowerCase()) && previous === '-font') {
                if (!isAbsolute(bare) || !existsSync(bare)) throw new Error(`Font "${bare}" must be an absolute path to an existing file.`);
                out.push(bare);
                continue;
            }
            if (!isAbsolute(bare) && !isOutput && !/[\\/]/.test(bare) && !extname(bare)) { out.push(arg); continue; }
            const path = await checkRawPath(bare, isOutput);
            out.push(`${coded(path)}${frame}`);
            if (isOutput) outputs.push(path);
            continue;
        }
        out.push(arg);
    }
    return { args: tool ? [tool, ...out] : out, outputs };
}

async function checkRawPath(raw: string, isOutput: boolean): Promise<string> {
    if (isOutput) {
        // Allow one printf-style frame counter (e.g. frame_%03d.png) in outputs only.
        const counter = /%0?\d{0,2}d/.exec(raw)?.[0];
        if (counter && raw.split('%').length === 2) {
            const probe = raw.replace(counter, '0');
            const checked = await checkPath(probe, 'output', IMAGE_EXT, 'output');
            await mkdir(dirname(checked), { recursive: true });
            return join(dirname(checked), basename(raw));
        }
        const checked = await checkPath(raw, 'output', IMAGE_EXT, 'output');
        await mkdir(dirname(checked), { recursive: true });
        return checked;
    }
    return checkPath(raw, 'input', IMAGE_EXT, 'input');
}

// ---------- Pack ----------

const pack: ToolpackDefinition = {
    name: 'imaging',
    description: 'Headless image editing with ImageMagick: trim, resize, pad, outline, drop shadow, layer, text, color adjust, sprite sheets, tile slicing, icon sets, format conversion and PNG optimization, plus optional AI background removal and upscaling. All paths are absolute; results include a small preview image.',
    async setup(ctx) {
        state.ctx = ctx;
        await mkdir(ctx.dataDir, { recursive: true });
        state.roots = await computeRoots(ctx.dataDir);
        state.magick = await findMagick();
        state.optional = await findOptional();
        ctx.status(state.magick ? `${state.magick.mode === 'im7' ? 'ImageMagick 7' : 'ImageMagick 6 (fallback)'} ready` : 'ImageMagick 7 not found');
        ctx.log(`Allowed roots: ${state.roots.join(', ')}`);
    },
    teardown() {
        state.ctx = undefined;
    },
    tools: [
        {
            name: 'tools_status',
            description: 'Show which image tools are installed (ImageMagick, pngquant, oxipng, rembg, Real-ESRGAN) and which folders this pack may read and write.',
            inputSchema: { type: 'object', properties: {} },
            async run() {
                state.magick = await findMagick();
                state.optional = await findOptional();
                const lines = [state.magick ? `ImageMagick: ${state.magick.version} (${state.magick.mode}, ${state.magick.convert[0]})` : 'ImageMagick: NOT FOUND - install ImageMagick 7 or set DSH_MAGICK_PATH.'];
                const versions: Array<[keyof Optional, string, string[]]> = [['pngquant', 'pngquant (lossy PNG compression, used by optimize)', ['--version']], ['oxipng', 'oxipng (lossless PNG compression, used by optimize)', ['--version']], ['rembg', 'rembg (remove_background; pip install "rembg[cli]")', []], ['realesrgan', 'realesrgan-ncnn-vulkan (upscale)', []]];
                for (const [key, label, flag] of versions) {
                    const path = state.optional[key];
                    if (!path) { lines.push(`${label}: not found`); continue; }
                    const version = flag.length ? (await run(path, flag, 10_000)).stdout.trim().split(/\r?\n/)[0] : '';
                    lines.push(`${label}: ${path}${version ? ` (${version})` : ''}`);
                }
                lines.push(`Allowed folders: ${state.roots.join(', ')}`);
                return lines.join('\n');
            },
        },
        {
            name: 'info',
            description: 'Read image facts: format, width x height, frames, colorspace, whether it has alpha and whether any pixel is transparent, file size.',
            inputSchema: schema({ input: io.input }),
            async run(args) {
                const file = await input(args);
                const deadline = deadlineFor(args);
                const out = await identify(['-format', '%m|%w|%h|%[channels]|%[colorspace]|%[opaque]|%z\n', coded(file)], deadline);
                const frames = out.trim().split(/\r?\n/);
                const [format, width, height, channels, colorspace, opaque, depth] = frames[0].split('|');
                const hasAlpha = /a\b/.test(channels.split(/\s/)[0]);
                return [
                    `${file}`,
                    `format=${format} size=${width}x${height} frames=${frames.length} colorspace=${colorspace} depth=${depth}-bit`,
                    `alpha=${hasAlpha ? 'yes' : 'no'}${hasAlpha ? ` transparentPixels=${opaque === 'true' ? 'no' : 'yes'}` : ''} bytes=${formatBytes((await stat(file)).size)}`,
                ].join('\n');
            },
        },
        {
            name: 'trim',
            description: 'Crop away the uniform or transparent border around the subject, then optionally add even padding back. Example: {input, fuzz:5, padding:8}.',
            inputSchema: schema({ ...io, fuzz: { type: 'number', description: 'Color tolerance in % (0-50). Default 1.' }, padding: { type: 'integer', description: 'Transparent pixels added on every side after trimming. Default 0.' } }),
            async run(args) {
                const file = await input(args);
                const output = await outputFor(args, file, '_trim', alphaExt(file));
                const deadline = deadlineFor(args);
                const padding = integer(args, 'padding', 0, 0, 4096);
                await convert([coded(file), '-fuzz', `${number(args, 'fuzz', 1, 0, 50)}%`, '-trim', '+repage', ...(padding ? ['-bordercolor', 'none', '-border', String(padding)] : []), coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'resize',
            description: 'Resize to a width and/or height in pixels. fit: contain (fit inside, keep aspect, default), cover (fill then center-crop to exactly WxH), exact (stretch). Use filter "point" for pixel art.',
            inputSchema: schema({ ...io, width: { type: 'integer', description: 'Target width px.' }, height: { type: 'integer', description: 'Target height px.' }, fit: { type: 'string', enum: ['contain', 'cover', 'exact'] }, filter: { type: 'string', enum: ['lanczos', 'mitchell', 'catrom', 'triangle', 'point'], description: 'Default lanczos.' }, onlyShrink: { type: 'boolean', description: 'Never enlarge. Default false.' } }),
            async run(args) {
                const file = await input(args);
                const width = optionalInteger(args, 'width', 1, 16384);
                const height = optionalInteger(args, 'height', 1, 16384);
                if (!width && !height) throw new Error('Give width, height, or both.');
                const fit = optionalString(args, 'fit') ?? 'contain';
                if ((fit === 'cover' || fit === 'exact') && (!width || !height)) throw new Error(`fit "${fit}" needs both width and height.`);
                const filter = optionalString(args, 'filter') ?? 'lanczos';
                if (!['lanczos', 'mitchell', 'catrom', 'triangle', 'point'].includes(filter)) throw new Error('filter must be lanczos, mitchell, catrom, triangle or point.');
                const geometry = `${width ?? ''}x${height ?? ''}`;
                const flag = optionalBoolean(args, 'onlyShrink') ? '>' : '';
                const ops = fit === 'cover' ? ['-resize', `${geometry}^${flag}`, '-gravity', 'Center', '-extent', geometry] : ['-resize', `${geometry}${fit === 'exact' ? '!' : ''}${flag}`];
                const output = await outputFor(args, file, `_${width ?? 'auto'}x${height ?? 'auto'}`);
                const deadline = deadlineFor(args);
                await convert([coded(file), '-filter', filter[0].toUpperCase() + filter.slice(1), ...ops, '+repage', coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'canvas',
            description: 'Place the image on a canvas without scaling: pad to WxH or to a square (square:true), or crop if smaller. Anchored by gravity.',
            inputSchema: schema({ ...io, width: { type: 'integer', description: 'Canvas width px.' }, height: { type: 'integer', description: 'Canvas height px.' }, square: { type: 'boolean', description: 'Pad to a square of the longer side (plus padding).' }, padding: { type: 'integer', description: 'Extra px on every side when square:true. Default 0.' }, background: colorSchema('Fill. Default transparent.'), gravity: gravitySchema }),
            async run(args) {
                const file = await input(args);
                const deadline = deadlineFor(args);
                let width = optionalInteger(args, 'width', 1, 16384);
                let height = optionalInteger(args, 'height', 1, 16384);
                if (optionalBoolean(args, 'square')) {
                    const [size] = await sizes([file], deadline);
                    width = height = Math.max(size.width, size.height) + 2 * integer(args, 'padding', 0, 0, 4096);
                }
                if (!width || !height) throw new Error('Give width and height, or square:true.');
                const background = color(args, 'background', 'transparent');
                const output = await outputFor(args, file, `_canvas${width}x${height}`, background === 'none' ? alphaExt(file) : undefined);
                await convert([coded(file), '-background', background, '-gravity', gravity(args), '-extent', `${width}x${height}`, '+repage', coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'outline',
            description: 'Add a solid stroke around the opaque shape of a transparent image (sticker/icon outline). The canvas grows so the stroke is not clipped. Example: {input, size:4, color:"#000000"}.',
            inputSchema: schema({ ...io, size: { type: 'integer', description: 'Stroke width px (1-64). Default 4.' }, color: colorSchema('Stroke color. Default black.') }),
            async run(args) {
                const file = await input(args);
                const size = integer(args, 'size', 4, 1, 64);
                const output = await outputFor(args, file, '_outline', alphaExt(file));
                const deadline = deadlineFor(args);
                await convert([coded(file), '-alpha', 'set', '-bordercolor', 'none', '-border', String(size), '(', '+clone', '-alpha', 'extract', '-morphology', 'Dilate', `Disk:${size}`, '-background', color(args, 'color', 'black'), '-alpha', 'shape', ')', '+swap', '-compose', 'Over', '-composite', coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'drop_shadow',
            description: 'Add a soft drop shadow behind a transparent image. The canvas grows to fit the shadow.',
            inputSchema: schema({ ...io, color: colorSchema('Shadow color. Default black.'), opacity: { type: 'integer', description: 'Shadow opacity % (0-100). Default 60.' }, blur: { type: 'number', description: 'Blur sigma px (0-50). Default 4.' }, x: { type: 'integer', description: 'Offset right px. Default 4.' }, y: { type: 'integer', description: 'Offset down px. Default 4.' } }),
            async run(args) {
                const file = await input(args);
                const x = integer(args, 'x', 4, -512, 512);
                const y = integer(args, 'y', 4, -512, 512);
                const output = await outputFor(args, file, '_shadow', alphaExt(file));
                const deadline = deadlineFor(args);
                const offset = `${x < 0 ? '-' : '+'}${Math.abs(x)}${y < 0 ? '-' : '+'}${Math.abs(y)}`;
                await convert([coded(file), '-alpha', 'set', '(', '+clone', '-background', color(args, 'color', 'black'), '-shadow', `${integer(args, 'opacity', 60, 0, 100)}x${number(args, 'blur', 4, 0, 50)}${offset}`, ')', '+swap', '-background', 'none', '-layers', 'merge', '+repage', coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'composite',
            description: 'Layer images onto a base image in order. Each layer: {file, x, y, gravity, width, height, opacity 0-100, blend}. x/y are px offsets from the gravity anchor (default NorthWest = top-left).',
            inputSchema: schema({
                ...io,
                input: { type: 'string', description: `${pathNote} of the base image.` },
                layers: {
                    type: 'array', minItems: 1, maxItems: 64, items: {
                        type: 'object', required: ['file'], additionalProperties: false, properties: {
                            file: { type: 'string', description: pathNote },
                            x: { type: 'integer' }, y: { type: 'integer' },
                            gravity: { type: 'string', enum: GRAVITIES },
                            width: { type: 'integer', description: 'Resize layer to fit this width px first.' },
                            height: { type: 'integer', description: 'Resize layer to fit this height px first.' },
                            opacity: { type: 'number', description: '0-100. Default 100.' },
                            blend: { type: 'string', enum: Object.keys(BLENDS), description: 'Default over.' },
                        },
                    },
                },
            }, ['input', 'layers']),
            async run(args) {
                const base = await input(args);
                if (!Array.isArray(args.layers) || !args.layers.length || args.layers.length > 64) throw new Error('layers must be an array of 1 to 64 layer objects.');
                const ops: string[] = [coded(base), '-alpha', 'set'];
                const files: string[] = [];
                for (const [index, raw] of args.layers.entries()) {
                    if (!isRecord(raw)) throw new Error(`layers[${index}] must be an object.`);
                    const file = await checkPath(requiredString(raw, 'file'), 'input', IMAGE_EXT, `layers[${index}].file`);
                    files.push(file);
                    const width = optionalInteger(raw, 'width', 1, 16384);
                    const height = optionalInteger(raw, 'height', 1, 16384);
                    const opacity = number(raw, 'opacity', 100, 0, 100);
                    const blend = BLENDS[(optionalString(raw, 'blend') ?? 'over').toLowerCase()];
                    if (!blend) throw new Error(`layers[${index}].blend must be one of ${Object.keys(BLENDS).join(', ')}.`);
                    const x = integer(raw, 'x', 0, -16384, 16384);
                    const y = integer(raw, 'y', 0, -16384, 16384);
                    ops.push('(', `${coded(file)}[0]`, '-alpha', 'set');
                    if (width || height) ops.push('-resize', `${width ?? ''}x${height ?? ''}`);
                    if (opacity < 100) ops.push('-channel', 'A', '-evaluate', 'multiply', String(opacity / 100), '+channel');
                    ops.push(')', '-gravity', gravity(raw, 'gravity', 'NorthWest'), '-geometry', `${x < 0 ? '-' : '+'}${Math.abs(x)}${y < 0 ? '-' : '+'}${Math.abs(y)}`, '-compose', blend, '-composite');
                }
                const output = await prepareOutput(optionalString(args, 'output') ?? join(dirname(base), `${basename(base, extname(base))}_composite${alphaExt(base)}`), optionalBoolean(args, 'overwrite') === true, [base, ...files]);
                const deadline = deadlineFor(args);
                await convert([...ops, coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'text',
            description: 'Draw text onto an image. size is in points (≈px at 72 dpi). x/y offset from the gravity anchor. Example: {input, text:"LEVEL 5", gravity:"North", y:20, size:48, color:"white", strokeColor:"black", strokeWidth:3}.',
            inputSchema: schema({ ...io, text: { type: 'string', description: 'Text; \\n for new lines.' }, x: { type: 'integer' }, y: { type: 'integer' }, gravity: gravitySchema, font: { type: 'string', description: 'Font name (e.g. "Arial") or absolute .ttf/.otf path.' }, size: { type: 'number', description: 'Point size. Default 32.' }, color: colorSchema('Fill. Default white.'), strokeColor: colorSchema('Outline color.'), strokeWidth: { type: 'number', description: 'Outline px. Default 0.' } }, ['input', 'text']),
            async run(args) {
                const file = await input(args);
                const text = requiredString(args, 'text');
                if (text.length > 2000) throw new Error('text must be under 2000 characters.');
                const x = integer(args, 'x', 0, -16384, 16384);
                const y = integer(args, 'y', 0, -16384, 16384);
                const strokeWidth = number(args, 'strokeWidth', 0, 0, 64);
                const stroke = strokeWidth > 0 ? ['-stroke', color(args, 'strokeColor', 'black'), '-strokewidth', String(strokeWidth)] : [];
                const output = await outputFor(args, file, '_text');
                const deadline = deadlineFor(args);
                const drawArgs = ['-gravity', gravity(args), ...fontArgs(args), '-pointsize', String(number(args, 'size', 32, 1, 1000)), '-fill', color(args, 'color', 'white')];
                const offset = `${x < 0 ? '-' : '+'}${Math.abs(x)}${y < 0 ? '-' : '+'}${Math.abs(y)}`;
                // Draw the stroke first and the fill on top so thick outlines don't eat into the letters.
                const ops = stroke.length ? [...drawArgs, ...stroke, '-annotate', offset, textArg(text), '-stroke', 'none', '-annotate', offset, textArg(text)] : [...drawArgs, '-annotate', offset, textArg(text)];
                await convert([coded(file), ...ops, coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'adjust',
            description: 'Color adjustments; transparency is kept. brightness/saturation/contrast are -100..100 (0 = unchanged; saturation -100 = grayscale), hue rotates -180..180 degrees, tint blends toward a color by tintAmount %.',
            inputSchema: schema({ ...io, brightness: { type: 'number' }, saturation: { type: 'number' }, contrast: { type: 'number' }, hue: { type: 'number', description: 'Degrees.' }, tint: colorSchema('Tint color.'), tintAmount: { type: 'number', description: 'Tint strength % (0-100). Default 30.' } }),
            async run(args) {
                const file = await input(args);
                const brightness = number(args, 'brightness', 0, -100, 100);
                const saturation = number(args, 'saturation', 0, -100, 100);
                const contrast = number(args, 'contrast', 0, -100, 100);
                const hue = number(args, 'hue', 0, -180, 180);
                const ops: string[] = [];
                if (brightness || saturation || hue) ops.push('-modulate', `${100 + brightness},${100 + saturation},${100 + hue / 1.8}`);
                if (contrast) ops.push('-brightness-contrast', `0x${contrast}`);
                if (optionalString(args, 'tint')) ops.push('-fill', color(args, 'tint', 'white'), '-colorize', `${number(args, 'tintAmount', 30, 0, 100)}%`);
                if (!ops.length) throw new Error('Give at least one of brightness, saturation, contrast, hue or tint.');
                const output = await outputFor(args, file, '_adjust');
                const deadline = deadlineFor(args);
                await convert([coded(file), ...ops, coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'sprite_sheet',
            description: 'Pack frames into a grid sprite sheet (row by row, in the given order) and write a JSON frame map next to it (<output>.json with x/y/w/h per frame). Cells default to the largest frame; larger frames are shrunk to fit.',
            inputSchema: schema({
                files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 400, description: 'Absolute frame paths, in order.' },
                output: { type: 'string', description: 'Absolute .png path for the sheet.' },
                columns: { type: 'integer', description: 'Frames per row. Default: near-square grid.' },
                cellWidth: { type: 'integer' }, cellHeight: { type: 'integer' },
                padding: { type: 'integer', description: 'Transparent px between and around cells. Default 0.' },
                overwrite: io.overwrite, preview: io.preview,
            }, ['files', 'output']),
            async run(args) {
                const raw = stringList(args, 'files', 400);
                const files: string[] = [];
                for (const [index, file] of raw.entries()) files.push(await checkPath(file, 'input', IMAGE_EXT, `files[${index}]`));
                const overwrite = optionalBoolean(args, 'overwrite') === true;
                const output = await prepareOutput(requiredString(args, 'output'), overwrite, files);
                if (extname(output).toLowerCase() !== '.png') throw new Error('sprite_sheet output must be a .png file.');
                const mapFile = join(dirname(output), `${basename(output, extname(output))}.json`);
                if (!overwrite && existsSync(mapFile)) throw new Error(`${mapFile} already exists. Pass overwrite:true or choose another output.`);
                const deadline = deadlineFor(args);
                const dims = await sizes(files, deadline);
                const cellWidth = optionalInteger(args, 'cellWidth', 1, 8192) ?? Math.max(...dims.map(item => item.width));
                const cellHeight = optionalInteger(args, 'cellHeight', 1, 8192) ?? Math.max(...dims.map(item => item.height));
                const columns = Math.min(files.length, optionalInteger(args, 'columns', 1, 400) ?? Math.ceil(Math.sqrt(files.length)));
                const rows = Math.ceil(files.length / columns);
                const padding = integer(args, 'padding', 0, 0, 512);
                const sheetWidth = columns * cellWidth + (columns + 1) * padding;
                const sheetHeight = rows * cellHeight + (rows + 1) * padding;
                if (sheetWidth > 16384 || sheetHeight > 16384) throw new Error(`The sheet would be ${sheetWidth}x${sheetHeight}px; the limit is 16384. Use smaller cells or more columns.`);
                const ops: string[] = ['-size', `${sheetWidth}x${sheetHeight}`, 'xc:none'];
                const frames = files.map((file, index) => {
                    const x = padding + (index % columns) * (cellWidth + padding);
                    const y = padding + Math.floor(index / columns) * (cellHeight + padding);
                    ops.push('(', `${coded(file)}[0]`, '-alpha', 'set', '-resize', `${cellWidth}x${cellHeight}>`, '-background', 'none', '-gravity', 'Center', '-extent', `${cellWidth}x${cellHeight}`, ')', '-gravity', 'NorthWest', '-geometry', `+${x}+${y}`, '-composite');
                    return { index, name: basename(file, extname(file)), x, y, w: cellWidth, h: cellHeight };
                });
                await convert([...ops, `PNG32:${output}`], deadline);
                const map = { image: basename(output), width: sheetWidth, height: sheetHeight, columns, rows, cellWidth, cellHeight, padding, frames };
                await writeFile(mapFile, JSON.stringify(map, null, 2), 'utf8');
                return done(args, [output], deadline, { note: `Frame map: ${mapFile} (${frames.length} frames, ${columns}x${rows} grid, cell ${cellWidth}x${cellHeight}, padding ${padding})` });
            },
        },
        {
            name: 'slice_grid',
            description: 'Cut a sheet into tiles, either by grid (columns x rows) or tile size in px, left-to-right then top-to-bottom. Files are named <prefix>_000.png, <prefix>_001.png ...',
            inputSchema: schema({ input: io.input, outputDir: { type: 'string', description: 'Absolute folder for tiles. Default: <input stem>_tiles next to the input.' }, prefix: { type: 'string', description: 'File name prefix. Default: input stem.' }, columns: { type: 'integer' }, rows: { type: 'integer' }, tileWidth: { type: 'integer' }, tileHeight: { type: 'integer' }, skipEmpty: { type: 'boolean', description: 'Delete fully transparent tiles. Default false.' }, overwrite: io.overwrite, preview: io.preview }),
            async run(args) {
                const file = await input(args);
                const stem = basename(file, extname(file));
                const prefix = optionalString(args, 'prefix') ?? stem.replace(/[^\w.-]/g, '_');
                if (!/^[\w.-]{1,64}$/.test(prefix)) throw new Error('prefix may use letters, digits, _ . - (max 64).');
                const dir = await checkDir(optionalString(args, 'outputDir') ?? join(dirname(file), `${stem}_tiles`), 'outputDir');
                const deadline = deadlineFor(args);
                const [size] = await sizes([file], deadline);
                const columns = optionalInteger(args, 'columns', 1, 256);
                const rows = optionalInteger(args, 'rows', 1, 256);
                const tileWidth = optionalInteger(args, 'tileWidth', 1, 16384);
                const tileHeight = optionalInteger(args, 'tileHeight', 1, 16384);
                let crop: string;
                let count: number;
                if (columns && rows) { crop = `${columns}x${rows}@`; count = columns * rows; }
                else if (tileWidth && tileHeight) { crop = `${tileWidth}x${tileHeight}`; count = Math.ceil(size.width / tileWidth) * Math.ceil(size.height / tileHeight); }
                else throw new Error('Give columns and rows, or tileWidth and tileHeight.');
                if (count > 1024) throw new Error(`That makes ${count} tiles; the limit is 1024 per call.`);
                const names = Array.from({ length: count }, (_, index) => join(dir, `${prefix}_${String(index).padStart(3, '0')}.png`));
                if (optionalBoolean(args, 'overwrite') !== true) {
                    const existing = names.find(name => existsSync(name));
                    if (existing) throw new Error(`${existing} already exists. Pass overwrite:true or use another outputDir/prefix.`);
                }
                await convert([coded(file), '-crop', crop, '+repage', '+adjoin', '-scene', '0', `PNG32:${join(dir, `${prefix}_%03d.png`)}`], deadline);
                let written = names.filter(name => existsSync(name));
                let note = `${written.length} tiles in ${dir}`;
                if (optionalBoolean(args, 'skipEmpty') && written.length) {
                    const maxima = (await convert([...written.map(coded), '-alpha', 'extract', '-format', '%[max]\n', 'info:'], deadline)).trim().split(/\r?\n/).map(Number);
                    const empty = written.filter((_, index) => maxima[index] === 0);
                    for (const name of empty) await rm(name, { force: true });
                    written = written.filter(name => !empty.includes(name));
                    note = `${written.length} tiles in ${dir} (${empty.length} empty tiles removed)`;
                }
                return done(args, written, deadline, { note, listLimit: 12 });
            },
        },
        {
            name: 'icon_set',
            description: 'Export square PNG icons at several sizes from one image (fit inside, centered on transparent). Files are <stem>_<size>.png. Example: {input, sizes:[512,256,128,64]}.',
            inputSchema: schema({ input: io.input, sizes: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 16, description: 'Edge lengths px. Default [512,256,128,64,32].' }, outputDir: { type: 'string', description: 'Absolute folder. Default: next to the input.' }, filter: { type: 'string', enum: ['lanczos', 'point'], description: 'point for pixel art. Default lanczos.' }, overwrite: io.overwrite, preview: io.preview }),
            async run(args) {
                const file = await input(args);
                const list = args.sizes === undefined ? [512, 256, 128, 64, 32] : args.sizes;
                if (!Array.isArray(list) || !list.length || list.length > 16 || list.some(item => !Number.isInteger(item) || item < 1 || item > 4096)) throw new Error('sizes must be 1 to 16 whole numbers from 1 to 4096.');
                const dir = await checkDir(optionalString(args, 'outputDir') ?? dirname(file), 'outputDir');
                const stem = basename(file, extname(file));
                const overwrite = optionalBoolean(args, 'overwrite') === true;
                const outputs: string[] = [];
                for (const size of [...new Set(list as number[])]) outputs.push(await prepareOutput(join(dir, `${stem}_${size}.png`), overwrite, [file]));
                const filter = optionalString(args, 'filter') === 'point' ? 'Point' : 'Lanczos';
                const ops: string[] = [`${coded(file)}[0]`, '-alpha', 'set', '-filter', filter];
                for (const output of outputs) {
                    const size = basename(output, '.png').split('_').pop()!;
                    ops.push('(', '+clone', '-resize', `${size}x${size}`, '-background', 'none', '-gravity', 'Center', '-extent', `${size}x${size}`, '-write', `PNG32:${output}`, '+delete', ')');
                }
                const deadline = deadlineFor(args);
                await convert([...ops, 'null:'], deadline);
                return done(args, outputs, deadline);
            },
        },
        {
            name: 'convert',
            description: 'Convert to another format chosen by the output extension (.png .jpg .webp .gif .bmp .tga .tif .ico). Formats without alpha (jpg, bmp) are flattened onto background.',
            inputSchema: schema({ ...io, output: { type: 'string', description: 'Absolute output path; extension picks the format.' }, quality: { type: 'integer', description: 'JPEG/WebP quality 1-100. Default 90.' }, background: colorSchema('Flatten color for jpg/bmp. Default white.') }, ['input', 'output']),
            async run(args) {
                const file = await input(args);
                const output = await outputFor(args, file, '');
                const ext = extname(output).toLowerCase();
                const ops: string[] = [];
                if (['.jpg', '.jpeg', '.bmp'].includes(ext)) ops.push('-background', color(args, 'background', 'white'), '-alpha', 'remove', '-alpha', 'off');
                if (['.jpg', '.jpeg', '.webp'].includes(ext)) ops.push('-quality', String(integer(args, 'quality', 90, 1, 100)));
                if (ext === '.ico') ops.push('-resize', '256x256>');
                const deadline = deadlineFor(args);
                await convert([`${coded(file)}${['.gif', '.tif', '.tiff', '.ico'].includes(ext) ? '' : '[0]'}`, ...ops, coded(output)], deadline);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'optimize',
            description: 'Shrink a file for upload. PNG: pngquant (lossy, unless lossless:true) then oxipng when installed, else ImageMagick recompression. JPG/WebP: strip metadata and re-encode at quality. Reports before/after size.',
            inputSchema: schema({ ...io, lossless: { type: 'boolean', description: 'Skip pngquant. Default false.' }, quality: { type: 'integer', description: 'Minimum quality 1-100 (pngquant floor / JPEG quality). Default 80.' } }),
            async run(args) {
                const file = await input(args);
                const output = await outputFor(args, file, '_opt');
                const deadline = deadlineFor(args);
                const quality = integer(args, 'quality', 80, 1, 100);
                const before = (await stat(file)).size;
                const steps: string[] = [];
                const ext = extname(file).toLowerCase();
                state.optional = await findOptional();
                const temp = join(tmpdir(), `dsh-imaging-${randomBytes(6).toString('hex')}.png`);
                try {
                    if (ext === '.png') {
                        let current = file;
                        if (state.optional.pngquant && optionalBoolean(args, 'lossless') !== true) {
                            const result = await run(state.optional.pngquant, ['--force', '--skip-if-larger', '--strip', `--quality=${quality}-100`, '--speed', '3', '--output', temp, file], deadline.left());
                            if (result.code === 0) { current = temp; steps.push('pngquant'); }
                            else if (result.code === 98 || result.code === 99) steps.push('pngquant skipped (would not help at this quality)');
                            else throw new Error(`pngquant failed: ${cleanError(result.stderr)}`);
                        }
                        if (state.optional.oxipng) {
                            const result = await run(state.optional.oxipng, ['-o', '3', '--strip', 'safe', '--out', output, current], deadline.left());
                            if (result.code !== 0) throw new Error(`oxipng failed: ${cleanError(result.stderr)}`);
                            steps.push('oxipng');
                        } else {
                            await convert([coded(current), '-strip', '-define', 'png:compression-level=9', '-define', 'png:compression-filter=5', coded(output)], deadline);
                            steps.push('ImageMagick recompress');
                        }
                    } else {
                        await convert([coded(file), '-strip', ...(['.jpg', '.jpeg', '.webp'].includes(ext) ? ['-quality', String(quality)] : []), coded(output)], deadline);
                        steps.push('ImageMagick strip/re-encode');
                    }
                } finally { await rm(temp, { force: true }).catch(() => undefined); }
                let after = (await stat(output)).size;
                if (after > before && !samePath(file, output)) { await copyFile(file, output); after = before; steps.push('kept original (smaller)'); }
                const tips = ext === '.png' && (!state.optional.pngquant || !state.optional.oxipng) ? ' Install pngquant and oxipng for much smaller PNGs.' : '';
                return done(args, [output], deadline, { note: `${formatBytes(before)} -> ${formatBytes(after)} (${before ? Math.round((1 - after / before) * 100) : 0}% smaller) via ${steps.join(', ')}.${tips}` });
            },
        },
        {
            name: 'remove_background',
            description: 'Cut out the subject onto transparency with rembg (AI). Requires rembg: `pip install "rembg[cli]"`. Output is PNG.',
            inputSchema: schema({ ...io, model: { type: 'string', enum: ['u2net', 'isnet-general-use', 'isnet-anime', 'birefnet-general', 'u2net_human_seg'], description: 'Default isnet-general-use; isnet-anime for cartoon art.' } }),
            async run(args) {
                const file = await input(args);
                state.optional = await findOptional();
                if (!state.optional.rembg) throw new Error('rembg is not installed. Run `pip install "rembg[cli]"` (Python 3.10+) in a terminal, or set DSH_REMBG_PATH, then retry.');
                const model = optionalString(args, 'model') ?? 'isnet-general-use';
                if (!['u2net', 'isnet-general-use', 'isnet-anime', 'birefnet-general', 'u2net_human_seg'].includes(model)) throw new Error('Unknown model.');
                const output = await outputFor(args, file, '_cutout', '.png');
                if (extname(output).toLowerCase() !== '.png') throw new Error('remove_background writes PNG; use a .png output.');
                const deadline = deadlineFor(args);
                const result = await run(state.optional.rembg, ['i', '-m', model, file, output], deadline.left());
                if (result.code !== 0) throw new Error(`rembg failed: ${cleanError(result.stderr)}${/Timed out/.test(result.stderr) ? '\nThe first run downloads the model (100+ MB). Run `rembg i -m ' + model + ' <any image> <out.png>` once in a terminal, then retry.' : ''}`);
                return done(args, [output], deadline);
            },
        },
        {
            name: 'upscale',
            description: 'AI upscale 2x/3x/4x with realesrgan-ncnn-vulkan (GPU). model: anime (flat/cartoon art, default) or photo. Output is PNG. Large inputs may exceed the 50s limit; keep inputs under ~512px.',
            inputSchema: schema({ ...io, scale: { type: 'integer', enum: [2, 3, 4], description: 'Default 4.' }, model: { type: 'string', enum: ['anime', 'photo'] } }),
            async run(args) {
                const file = await input(args);
                state.optional = await findOptional();
                const exe = state.optional.realesrgan;
                if (!exe) throw new Error('realesrgan-ncnn-vulkan was not found. Download the Windows zip from https://github.com/xinntao/Real-ESRGAN/releases, unzip it, and set DSH_REALESRGAN_PATH to realesrgan-ncnn-vulkan.exe (keep its models folder beside it).');
                const scale = integer(args, 'scale', 4, 2, 4);
                const model = optionalString(args, 'model') ?? 'anime';
                if (model !== 'anime' && model !== 'photo') throw new Error('model must be anime or photo.');
                const output = await outputFor(args, file, `_x${scale}`, '.png');
                if (extname(output).toLowerCase() !== '.png') throw new Error('upscale writes PNG; use a .png output.');
                const deadline = deadlineFor(args);
                // Only the anime video model supports 2x/3x natively; photo runs 4x and is scaled down.
                const [name, native] = model === 'photo' ? ['realesrgan-x4plus', 4] : scale === 4 ? ['realesrgan-x4plus-anime', 4] : ['realesr-animevideov3', scale];
                const target = native === scale ? output : join(tmpdir(), `dsh-imaging-${randomBytes(6).toString('hex')}.png`);
                try {
                    const result = await run(exe, ['-i', file, '-o', target, '-s', String(native), '-n', name, '-m', join(dirname(exe), 'models'), '-f', 'png'], deadline.left());
                    if (result.code !== 0 || !existsSync(target)) throw new Error(`Real-ESRGAN failed: ${cleanError(result.stderr)}`);
                    if (target !== output) await convert([coded(target), '-resize', `${Math.round((scale / native) * 100)}%`, coded(output)], deadline);
                } finally { if (target !== output) await rm(target, { force: true }).catch(() => undefined); }
                return done(args, [output], deadline);
            },
        },
        {
            name: 'magick_raw',
            description: 'Escape hatch: run ImageMagick with your own argument list (no shell), e.g. ["C:/in.png","-blur","0x3","C:/out.png"]. Input/output paths must be absolute and inside the allowed folders; the last argument is the output. @files, URLs, script coders, -script and %[...] are refused. Prefer the dedicated tools.',
            inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 }, overwrite: io.overwrite, preview: io.preview }, required: ['args'], additionalProperties: false },
            async run(args) {
                const { args: list, outputs } = await rawArgs(stringList(args, 'args', 200));
                if (optionalBoolean(args, 'overwrite') !== true) {
                    const existing = outputs.find(output => !/%0?\d{0,2}d/.test(output) && existsSync(output));
                    if (existing) throw new Error(`${existing} already exists. Pass overwrite:true to replace it.`);
                }
                const deadline = deadlineFor(args);
                const im = await magick();
                let file: string;
                let prefix: string[];
                if (RAW_TOOLS.has(list[0]) && list[0] !== 'convert') {
                    if (im.mode === 'im7') { file = im.convert[0]; prefix = [list[0]]; }
                    else {
                        const sibling = join(dirname(im.convert[0]), list[0]);
                        if (!existsSync(sibling)) throw new Error(`${list[0]} is not installed alongside ImageMagick 6.`);
                        file = sibling; prefix = [];
                    }
                    list.shift();
                } else {
                    if (list[0] === 'convert') list.shift();
                    file = im.convert[0]; prefix = im.convert.slice(1);
                }
                const result = await run(file, [...prefix, ...limits(), ...list], deadline.left());
                if (result.code !== 0) return { content: [{ type: 'text', text: `ImageMagick failed:\n${cleanError(result.stderr)}` }], isError: true };
                const written = outputs.filter(output => existsSync(output));
                const stdout = result.stdout.trim() ? `stdout:\n${result.stdout.trim().slice(0, 4000)}` : undefined;
                if (!written.length) return stdout ?? 'Done (no output file).';
                return done(args, written, deadline, { note: stdout });
            },
        },
        {
            name: 'pipeline',
            description: `Run several one-image edits in order in one call: each step's output is the next step's input, in-between files are temporary, and only the final file is listed and previewed. Steps: ${PIPELINE_STEPS.join(', ')}; each is {op, ...that tool's arguments without input/output}. Example: {input, output, steps:[{op:"trim",padding:8},{op:"outline",size:4},{op:"resize",width:256,height:256},{op:"optimize"}]}. All steps share one ${CALL_BUDGET_MS / 1000}s budget. The output extension picks the final format.`,
            inputSchema: schema({
                ...io,
                output: { type: 'string', description: 'Absolute output path; its extension picks the format. Default: next to the input with suffix _edit.' },
                steps: {
                    type: 'array', minItems: 1, maxItems: MAX_PIPELINE_STEPS, items: {
                        type: 'object', required: ['op'], properties: { op: { type: 'string', enum: PIPELINE_STEPS } },
                    },
                },
            }, ['input', 'steps']),
            async run(args, ctx) {
                const file = await input(args);
                const steps = Array.isArray(args.steps) ? args.steps : [];
                if (!steps.length || steps.length > MAX_PIPELINE_STEPS) throw new Error(`steps must list 1-${MAX_PIPELINE_STEPS} edits.`);
                const tools = steps.map((step, index) => {
                    const op = isRecord(step) && typeof step.op === 'string' ? step.op : '';
                    if (!PIPELINE_STEPS.includes(op)) throw new Error(`Step ${index + 1}: op must be one of ${PIPELINE_STEPS.join(', ')}.`);
                    if ('input' in (step as Record<string, unknown>) || 'output' in (step as Record<string, unknown>)) throw new Error(`Step ${index + 1} (${op}): leave out input and output; the pipeline chains them.`);
                    return pack.tools.find(tool => tool.name === op)!;
                });
                const output = await outputFor(args, file, '_edit', alphaExt(file));
                const deadline = deadlineFor(args);
                // In-between files go next to the output, which is inside the allowed folders.
                const scratch = join(dirname(output), `.dsh-pipeline-${randomBytes(4).toString('hex')}`);
                await mkdir(scratch, { recursive: true });
                const notes: string[] = [];
                try {
                    let current = file;
                    for (const [index, tool] of tools.entries()) {
                        const last = index === tools.length - 1;
                        const target = last ? output : join(scratch, `step-${index + 1}${alphaExt(current)}`);
                        const { op, ...stepArgs } = steps[index] as Record<string, unknown>;
                        const stepCall = { ...stepArgs, input: current, output: target, overwrite: true, preview: false, [SHARED_DEADLINE]: deadline };
                        let result: unknown;
                        try {
                            result = await tool.run(stepCall, ctx);
                        } catch (error) {
                            throw new Error(`Step ${index + 1} (${op}) failed: ${error instanceof Error ? error.message : String(error)}`);
                        }
                        // Keep what a step adds (sizes saved, warnings), not the line that lists its file.
                        const added = resultText(result).split(/\r?\n/).filter(line => line.trim() && !line.startsWith(target));
                        notes.push(...added.map(line => `${op}: ${line}`));
                        current = target;
                    }
                } finally {
                    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
                }
                const names = steps.map(step => (step as Record<string, unknown>).op).join(' -> ');
                return done(args, [output], deadline, { note: [`Steps: ${names}`, ...notes].join('\n') });
            },
        },
    ],
};

export default pack;

// Exposed for tests only.
export const __test = { rawArgs, checkPath, state, computeRoots };
