import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

interface ToolpackContext { log(message: string): void; status(text: string): void; dataDir: string }
interface ToolpackTool {
    name: string; description: string; inputSchema: Record<string, unknown>;
    run(args: Record<string, unknown>, ctx: ToolpackContext): unknown | Promise<unknown>;
}
interface ToolpackDefinition {
    name: string; description: string; tools: ToolpackTool[];
    setup(ctx: ToolpackContext): Promise<void>; teardown(): Promise<void>;
}
type Args = Record<string, unknown>;
interface Command { id: number; op: string; args: Args; expiresAt: number }
interface Waiter { res: ServerResponse; timer: ReturnType<typeof setTimeout> }
interface Session {
    id: string; version: string; project: string; file: string; sequence: string; bridge: number;
    lastSeen: number; queue: Command[]; waiters: Waiter[]; inflight: Set<number>;
    /** The delivered command Premiere is executing, for busy messages. */
    running?: { op: string; since: number };
}
interface Pending {
    session: string; sent: boolean; resolve(value: unknown): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}
const BRIDGE_VERSION = 2;
/** Stay well under Unify's 60,000-character tool output cap so JSON is never cut mid-value. */
const MAX_RESULT_CHARS = 50_000;
const EXTENSION_ID = 'com.unify.premiere.bridge';
const ONLINE_MS = 10_000;
const state = {
    server: undefined as Server | undefined, ctx: undefined as ToolpackContext | undefined,
    token: '', port: 0, discoveryFile: '', lastStatus: '', nextId: 1,
    statusTimer: undefined as ReturnType<typeof setInterval> | undefined,
    sessions: new Map<string, Session>(), pending: new Map<number, Pending>(),
};
function record(value: unknown): value is Args { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(res: ServerResponse, status: number, data: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
}
function endWaiter(waiter: Waiter): void { clearTimeout(waiter.timer); if (!waiter.res.writableEnded && !waiter.res.destroyed) { waiter.res.writeHead(204); waiter.res.end(); } }
function online(session: Session): boolean { return Date.now() - session.lastSeen < ONLINE_MS; }
function label(session: Session): string { return `${session.project || 'No project'} (Premiere ${session.version}, instance ${session.id})`; }
function rejectCommand(id: number, reason: string): void {
    const pending = state.pending.get(id);
    if (!pending) return;
    state.pending.delete(id); clearTimeout(pending.timer);
    const session = state.sessions.get(pending.session);
    if (session) { session.queue = session.queue.filter(command => command.id !== id); session.inflight.delete(id); if (!session.inflight.size) session.running = undefined; }
    pending.reject(new Error(reason + (pending.sent ? ' The command was delivered and may have run. Inspect Premiere before retrying.' : ' The command was not delivered.')));
}
function prune(): void {
    for (const session of state.sessions.values()) {
        if (online(session)) continue;
        for (const [id, pending] of state.pending) if (pending.session === session.id) rejectCommand(id, `Premiere ${session.id} disconnected.`);
        for (const waiter of session.waiters.splice(0)) endWaiter(waiter);
        if (Date.now() - session.lastSeen > 300_000) state.sessions.delete(session.id);
    }
}
function updateStatus(): void {
    prune();
    const sessions = [...state.sessions.values()].filter(online);
    const text = sessions.length ? `Connected: ${sessions.map(label).join(', ')}` : 'Waiting for Premiere. Run premiere_install_panel, then open Window > Extensions > Unify Bridge.';
    if (text !== state.lastStatus) { state.lastStatus = text; state.ctx?.status(text); }
}
function touch(url: URL): Session {
    const id = url.searchParams.get('session') || '';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid session id.');
    let session = state.sessions.get(id);
    if (!session) {
        session = { id, version: '', project: '', file: '', sequence: '', bridge: 0, lastSeen: 0, queue: [], waiters: [], inflight: new Set() };
        state.sessions.set(id, session);
        state.ctx?.log(`Premiere instance ${id} connected.`);
    }
    for (const key of ['version', 'project', 'file', 'sequence'] as const) if (url.searchParams.has(key)) session[key] = (url.searchParams.get(key) || '').slice(0, 4096);
    if (url.searchParams.has('bridge')) session.bridge = Number(url.searchParams.get('bridge')) || 0;
    session.lastSeen = Date.now(); updateStatus();
    return session;
}
function dispatch(session: Session): void {
    // One outstanding command per instance. The panel also serializes evalScript across Unify windows.
    if (session.inflight.size) return;
    while (session.queue.length && session.waiters.length) {
        const waiter = session.waiters.shift()!;
        clearTimeout(waiter.timer);
        if (waiter.res.destroyed || waiter.res.writableEnded) continue;
        const command = session.queue.shift()!;
        const pending = state.pending.get(command.id);
        if (!pending || command.expiresAt <= Date.now()) { json(waiter.res, 204, undefined); continue; }
        pending.sent = true; session.inflight.add(command.id); session.running = { op: command.op, since: Date.now() };
        json(waiter.res, 200, command); return;
    }
}
async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 8 * 1024 * 1024) throw new Error('Request body exceeds 8 MB.');
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers['x-unify-token'] !== state.token) { json(res, 401, { error: 'Invalid bridge token.' }); return; }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/ping' || url.pathname === '/poll')) {
        let session: Session;
        try { session = touch(url); } catch { json(res, 400, { error: 'Invalid session id.' }); return; }
        if (url.pathname === '/ping') { json(res, 200, { ok: true, bridge: BRIDGE_VERSION }); return; }
        if (session.waiters.length) { json(res, 409, { error: 'A poll is already open for this session.' }); return; }
        const waiter: Waiter = { res, timer: setTimeout(() => { session.waiters = session.waiters.filter(value => value !== waiter); endWaiter(waiter); }, 15_000) };
        session.waiters.push(waiter);
        res.on('close', () => { clearTimeout(waiter.timer); session.waiters = session.waiters.filter(value => value !== waiter); });
        dispatch(session); return;
    }
    if (req.method === 'POST' && url.pathname === '/result') {
        let data: unknown;
        try { data = await readBody(req); } catch { json(res, 400, { error: 'Invalid or oversized JSON.' }); return; }
        if (!record(data) || !Number.isSafeInteger(data.id) || typeof data.ok !== 'boolean') { json(res, 400, { error: 'Expected id and ok.' }); return; }
        const id = data.id as number, pending = state.pending.get(id), sessionId = url.searchParams.get('session') || '';
        if (pending && (pending.session !== sessionId || !pending.sent)) { json(res, 409, { error: 'Result does not belong to this instance or was not dispatched.' }); return; }
        if (pending) {
            state.pending.delete(id); clearTimeout(pending.timer);
            const session = state.sessions.get(sessionId);
            if (session) { session.inflight.delete(id); session.running = undefined; session.lastSeen = Date.now(); }
            if (data.ok) pending.resolve(data.data); else pending.reject(new Error(typeof data.error === 'string' ? data.error : 'Premiere command failed.'));
            if (session) dispatch(session);
        }
        json(res, 200, { ok: true }); return; // Acknowledge retries without executing anything again.
    }
    if (req.method === 'POST' && url.pathname === '/disconnect') {
        const session = state.sessions.get(url.searchParams.get('session') || '');
        if (session) { session.lastSeen = 0; updateStatus(); }
        json(res, 200, { ok: true }); return;
    }
    json(res, 404, { error: 'Unknown bridge route.' });
}
function resolveSession(args: Args): Session {
    prune();
    let sessions = [...state.sessions.values()].filter(online);
    if (args.instance) sessions = sessions.filter(session => session.id === args.instance || session.file === args.instance || session.project === args.instance || basename(session.file.replace(/\\/g, '/')) === args.instance);
    if (!sessions.length) throw new Error('No matching Premiere instance connected. Run premiere_install_panel, restart Premiere, and open Window > Extensions > Unify Bridge.');
    if (sessions.length > 1) throw new Error(`Several Premiere instances match; pass an instance id from premiere_instances: ${sessions.map(label).join('; ')}`);
    if (sessions[0].bridge !== BRIDGE_VERSION) throw new Error('Premiere panel protocol differs. Run premiere_install_panel and restart Premiere.');
    return sessions[0];
}
function command(args: Args, op: string, timeoutMs = 50_000): Promise<unknown> {
    if (!state.server) throw new Error('Premiere toolpack is not running.');
    const session = resolveSession(args), id = state.nextId++;
    const { instance: _instance, timeoutSeconds: _timeout, ...payload } = args;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 1_000_000) throw new Error('Command arguments exceed 1 MB.');
    return new Promise((resolve, reject) => {
        state.pending.set(id, { session: session.id, sent: false, resolve, reject, timer: setTimeout(() => rejectCommand(id, timeoutReason(session, id, op)), timeoutMs) });
        session.queue.push({ id, op, args: payload, expiresAt: Date.now() + timeoutMs }); dispatch(session);
    });
}
function timeoutReason(session: Session, id: number, op: string): string {
    const running = session.running;
    if (state.pending.get(id)?.sent || !running) return `Premiere ${op} timed out.`;
    const queued = session.queue.filter(command => command.id !== id).length;
    return `Premiere ${op} timed out waiting in the queue: Premiere has been busy with ${running.op} for ${Math.round((Date.now() - running.since) / 1000)}s${queued ? ` and ${queued} other command(s) are queued` : ''}. Retry when it finishes.`;
}
/** Compact JSON, refused (not truncated) when it would exceed the host's output cap. */
function compact(data: unknown, hint: string): string | { content: Array<{ type: 'text'; text: string }>; isError: true } {
    const text = JSON.stringify(data) ?? 'null';
    if (text.length <= MAX_RESULT_CHARS) return text;
    return { content: [{ type: 'text', text: `Result is ${text.length} characters, over the ${MAX_RESULT_CHARS} limit. ${hint}` }], isError: true };
}
const NARROW_HINT: Record<string, string> = {
    timeline: 'Pass trackType/trackIndex, from/to seconds, or a smaller maxClips.',
    tree: 'Pass a deeper root bin, smaller depth or smaller maxItems.',
    find: 'Use a more specific name or type, or a smaller limit.',
    components: 'Inspect fewer clips or read individual values with premiere_execute.',
    output_log: 'Pass contains, after or a smaller limit.',
};
function validate(args: Args, schema: Args, prefix = 'arguments'): void {
    if (!record(args)) throw new Error(`${prefix} must be an object.`);
    for (const key of schema.required as string[] || []) if (args[key] === undefined) throw new Error(`${key} is required.`);
    const properties = schema.properties as Record<string, Args>;
    for (const [key, value] of Object.entries(args)) {
        const rule = properties[key];
        if (!rule) throw new Error(`Unknown argument ${key}.`);
        if (value === undefined) continue;
        if (rule.enum && !(rule.enum as unknown[]).includes(value)) throw new Error(`${key} must be one of ${(rule.enum as string[]).join(', ')}.`);
        if (rule.type === 'string' && (typeof value !== 'string' || !value.trim())) throw new Error(`${key} must be a nonempty string.`);
        if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be boolean.`);
        if (rule.type === 'object' && !record(value)) throw new Error(`${key} must be an object.`);
        if (rule.type === 'number' || rule.type === 'integer') {
            if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value))) throw new Error(`${key} must be a finite ${rule.type}.`);
            if (typeof rule.minimum === 'number' && value < rule.minimum || typeof rule.maximum === 'number' && value > rule.maximum) throw new Error(`${key} is out of range.`);
        }
        if (rule.type === 'array') {
            if (!Array.isArray(value) || value.length < Number(rule.minItems || 0) || value.length > Number(rule.maxItems || 1000)) throw new Error(`${key} must be an array of the allowed length.`);
            for (const element of value) if (record(rule.items)) validate({ value: element }, { properties: { value: rule.items } }, key);
        }
    }
}
/** Marker.setColorByIndex order; commands.jsx maps names back to indices. */
const MARKER_COLORS = ['green', 'red', 'purple', 'orange', 'yellow', 'white', 'blue', 'cyan'];
/** ComponentParam.setInterpolationTypeAtKey codes; mirrored in commands.jsx. */
const INTERPOLATION: Record<string, number> = { linear: 0, hold: 1, bezier: 2, time: 3 };
const str = (description: string): Args => ({ type: 'string', description });
const num = (description: string, minimum = 0): Args => ({ type: 'number', minimum, description });
const int = (description: string, minimum = 0, maximum = 10000): Args => ({ type: 'integer', minimum, maximum, description });
const bool = (description: string): Args => ({ type: 'boolean', description });
const choices = (values: string[], description = ''): Args => ({ type: 'string', enum: values, description });
const strings = (description: string): Args => ({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500, description });
const instance = str('Instance id from premiere_instances; only needed when several are connected.');
const sequence = str('Sequence id or exact name; defaults to the active sequence.');
const item = str('Project item node id (from premiere_find/tree), exact name, or bin path like Footage/Camera A.');
const clip = str('Track item id from premiere_timeline (linked audio/video have separate ids).');
function tool(name: string, description: string, properties: Record<string, Args> = {}, required: string[] = []): ToolpackTool {
    const inputSchema = { type: 'object', additionalProperties: false, properties: { instance, ...properties }, required };
    // Validation and instance errors stay synchronous; results become compact JSON text.
    return { name, description, inputSchema, run(args) { validate(args, inputSchema); return command(args, name).then(data => compact(data, NARROW_HINT[name] || 'Narrow the request.')); } };
}
async function writePanel(folder: string): Promise<void> {
    for (const [name, source] of Object.entries(PANEL_FILES)) { const file = join(folder, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, source, 'utf8'); }
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});
function pngChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0); chunk.write(type, 4, 4, 'ascii'); data.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    return chunk;
}
/**
 * Box-downscales an 8-bit, non-interlaced PNG so its longest side is at most maxSide.
 * Other PNG variants are returned unchanged; Premiere's frame exports are 8-bit RGB(A).
 */
export function downscalePng(png: Buffer, maxSide: number): { png: Buffer; width: number; height: number; scaled: boolean } {
    let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0; const idat: Buffer[] = [];
    for (let at = 8; at + 8 <= png.length;) {
        const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, at + 8 + length);
        if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        at += 12 + length;
    }
    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
    if (Math.max(width, height) <= maxSide || depth !== 8 || interlace !== 0 || !channels) return { png, width, height, scaled: false };
    const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, pixels = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), out = y * stride;
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? pixels[out + x - channels] : 0, up = y ? pixels[out - stride + x] : 0, corner = y && x >= channels ? pixels[out - stride + x - channels] : 0;
            let value = line[x];
            if (filter === 1) value += left;
            else if (filter === 2) value += up;
            else if (filter === 3) value += (left + up) >> 1;
            else if (filter === 4) { const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner); value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner; }
            pixels[out + x] = value & 255;
        }
    }
    const scale = maxSide / Math.max(width, height), outW = Math.max(1, Math.round(width * scale)), outH = Math.max(1, Math.round(height * scale));
    const rgba = Buffer.alloc(outW * outH * 4);
    for (let oy = 0; oy < outH; oy++) {
        const y0 = Math.floor(oy * height / outH), y1 = Math.max(y0 + 1, Math.floor((oy + 1) * height / outH));
        for (let ox = 0; ox < outW; ox++) {
            const x0 = Math.floor(ox * width / outW), x1 = Math.max(x0 + 1, Math.floor((ox + 1) * width / outW)), sum = [0, 0, 0, 0];
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                const at = y * stride + x * channels;
                const r = pixels[at], g = channels >= 3 ? pixels[at + 1] : r, b = channels >= 3 ? pixels[at + 2] : r;
                const a = channels === 4 ? pixels[at + 3] : channels === 2 ? pixels[at + 1] : 255;
                sum[0] += r; sum[1] += g; sum[2] += b; sum[3] += a;
            }
            const count = (y1 - y0) * (x1 - x0), out = (oy * outW + ox) * 4;
            for (let c = 0; c < 4; c++) rgba[out + c] = Math.round(sum[c] / count);
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(outW, 0); header.writeUInt32BE(outH, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(outH * (outW * 4 + 1));
    for (let y = 0; y < outH; y++) rgba.copy(rows, y * (outW * 4 + 1) + 1, y * outW * 4, (y + 1) * outW * 4);
    return { png: Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]), width: outW, height: outH, scaled: true };
}
async function waitForFile(path: string, timeoutMs: number): Promise<Buffer> {
    // QE frame export can finish writing shortly after the host call returns.
    const deadline = Date.now() + timeoutMs; let previous = -1;
    for (;;) {
        try {
            const bytes = await readFile(path);
            if (bytes.length > 0 && bytes.length === previous) return bytes;
            previous = bytes.length;
        } catch { /* not written yet */ }
        if (Date.now() > deadline) throw new Error('Premiere did not write the frame PNG.');
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}
function runFile(file: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 10_000 }, error => error ? reject(error) : resolve()));
}
function extensionDirectory(): string {
    if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions', EXTENSION_ID);
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions', EXTENSION_ID);
    throw new Error('The Premiere panel installer supports Windows and macOS.');
}
async function findPresets(args: Args): Promise<unknown> {
    const roots = args.directory ? [args.directory as string] : [
        join(homedir(), 'Documents', 'Adobe'),
        ...(process.platform === 'win32' ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe')] : process.platform === 'darwin' ? ['/Applications'] : []),
    ];
    if (args.directory && !isAbsolute(args.directory as string)) throw new Error('directory must be absolute.');
    const result: Array<{ name: string; path: string; kind: string }> = [], limit = Number(args.limit || 50), name = String(args.name || '').toLowerCase();
    let visited = 0;
    async function walk(folder: string, depth: number): Promise<void> {
        if (depth > 9 || visited >= 50_000 || result.length >= limit) return;
        let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (++visited > 50_000 || result.length >= limit) break;
            if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(join(folder, entry.name), depth + 1);
            else if (entry.isFile() && /\.(epr|sqpreset)$/i.test(entry.name) && entry.name.toLowerCase().includes(name)) {
                const kind = /\.epr$/i.test(entry.name) ? 'export' : 'sequence';
                if (!args.kind || args.kind === 'all' || args.kind === kind) result.push({ name: entry.name, path: join(folder, entry.name), kind });
            }
        }
    }
    for (const root of roots) await walk(root, 0);
    return { presets: result, searchedRoots: roots, truncated: result.length >= limit || visited >= 50_000 };
}
const pack: ToolpackDefinition = {
    name: 'premiere',
    description: 'Edit Adobe Premiere Pro through a local CEP panel: inspect projects/timelines, import media, organize bins, create sequences, insert/trim/move/remove/razor clips, add tracks and .mogrt titles, set effect parameters and keyframes, mute tracks, add markers, capture frames, export via Media Encoder with job status, and execute ExtendScript. Built for Premiere Pro 2023 (23.x); requires CEP support and an open Unify Bridge panel.',
    async setup(ctx) {
        if (state.server) throw new Error('Premiere bridge is already running.');
        state.ctx = ctx; state.token = randomBytes(32).toString('hex'); state.lastStatus = '';
        try {
            await mkdir(ctx.dataDir, { recursive: true });
            await writePanel(join(ctx.dataDir, 'extension'));
            const server = createServer((req, res) => { void handle(req, res).catch(error => { ctx.log(`Premiere bridge: ${String(error)}`); json(res, 500, { error: 'Bridge request failed.' }); }); });
            state.server = server;
            await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.UNIFY_PREMIERE_PORT || 0), '127.0.0.1', resolve); }); // 0: any free port; the panel finds it through the discovery file.
            const address = server.address(); state.port = typeof address === 'object' && address ? address.port : 0;
            const discoveryDir = process.env.UNIFY_PREMIERE_DISCOVERY_DIR || join(homedir(), '.unify', 'premiere-bridge');
            await mkdir(discoveryDir, { recursive: true });
            state.discoveryFile = join(discoveryDir, `${process.pid}-${randomBytes(4).toString('hex')}.json`);
            await writeFile(state.discoveryFile, JSON.stringify({ port: state.port, token: state.token, pid: process.pid, bridge: BRIDGE_VERSION }), { encoding: 'utf8', mode: 0o600 });
            ctx.log(`Premiere bridge listening on 127.0.0.1:${state.port}`);
            updateStatus(); state.statusTimer = setInterval(updateStatus, 2000); state.statusTimer.unref();
        } catch (error) { await pack.teardown(); throw error; }
    },
    async teardown() {
        if (state.statusTimer) clearInterval(state.statusTimer); state.statusTimer = undefined;
        if (state.discoveryFile) await rm(state.discoveryFile, { force: true }); state.discoveryFile = '';
        for (const id of state.pending.keys()) rejectCommand(id, 'Premiere toolpack stopped.');
        for (const session of state.sessions.values()) for (const waiter of session.waiters.splice(0)) endWaiter(waiter);
        state.sessions.clear();
        const server = state.server; state.server = undefined;
        if (server) { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        state.ctx = undefined; state.token = ''; state.port = 0; state.lastStatus = '';
    },
    tools: [
        { name: 'instances', description: 'List connected Premiere instances, project files, active sequences and version. Choose an id when several are connected.', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, run() { prune(); return [...state.sessions.values()].filter(online).map(session => ({ instance: session.id, version: session.version, project: session.project, path: session.file, sequence: session.sequence, bridgeVersion: session.bridge, busy: session.running ? `${session.running.op} for ${Math.round((Date.now() - session.running.since) / 1000)}s` : false, queued: session.queue.length })); } },
        { name: 'install_panel', description: 'Install/update the bundled Unify Bridge CEP panel into the current user Adobe extensions folder. By default enables unsigned CEP panels (PlayerDebugMode) for CSXS 11, used by Premiere 2023. Restart Premiere, then open Window > Extensions > Unify Bridge.',
            inputSchema: { type: 'object', additionalProperties: false, properties: { enableDebugMode: bool('Enable loading unsigned CEP extensions; default true.'), csxsVersion: int('CEP runtime version for PlayerDebugMode; Premiere 2023 uses 11.', 9, 15) } },
            async run(args) {
                validate(args, this.inputSchema);
                const folder = extensionDirectory();
                const manifest = join(folder, 'CSXS', 'manifest.xml');
                if (existsSync(folder) && (!existsSync(manifest) || !(await readFile(manifest, 'utf8')).includes(`ExtensionBundleId="${EXTENSION_ID}"`))) throw new Error(`Refusing to replace an unrelated extension at ${folder}.`);
                await writePanel(folder);
                if (args.enableDebugMode !== false) {
                    const version = String(args.csxsVersion || 11);
                    if (process.platform === 'win32') await runFile('reg.exe', ['add', `HKCU\\Software\\Adobe\\CSXS.${version}`, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f']);
                    else await runFile('/usr/bin/defaults', ['write', `com.adobe.CSXS.${version}`, 'PlayerDebugMode', '-string', '1']);
                }
                return `Installed Unify Bridge to ${folder}. Restart Premiere and open Window > Extensions > Unify Bridge. Keep the panel open. ${args.enableDebugMode === false ? 'Unsigned panel loading was not enabled; enable PlayerDebugMode or sign the extension before loading.' : 'Unsigned CEP panel loading is enabled for the selected runtime.'}`;
            } },
        { ...tool('find_presets', 'Find installed Adobe export (.epr) and sequence (.sqpreset) presets by filename. Searches Documents/Adobe and installed Adobe applications, or an explicit directory. Does not require Premiere to be connected.', { name: str('Filename substring.'), kind: choices(['all', 'export', 'sequence']), directory: str('Absolute directory to search instead of default roots.'), limit: int('Maximum results; default 50.', 1, 500) }),
            run(args) { validate(args, this.inputSchema); if (args.instance) throw new Error('find_presets searches local files and does not accept an instance.'); return findPresets(args); } },
        tool('project', 'Inspect, open, create, save or save-as a Premiere project. Files require absolute paths. Existing destinations require overwrite:true. Opening/creating may show Premiere dialogs for unsaved work.', { action: choices(['info', 'open', 'new', 'save', 'save_as']), path: str('Absolute .prproj path for open/new/save_as.'), overwrite: bool('Allow replacing an existing destination file.') }, ['action']),
        tool('tree', 'Read the project bin tree with node ids and media paths. The root defaults to the project root; depth defaults to 4 and maxItems to 300.', { root: item, depth: int('Levels to descend.', 0, 30), maxItems: int('Maximum items returned.', 1, 1000) }),
        tool('find', 'Find project items by case-insensitive name substring and type. Returns ids for use with other tools.', { name: str('Name substring.'), type: choices(['all', 'bin', 'clip', 'sequence']), limit: int('Maximum results; default 50.', 1, 300) }),
        tool('import_media', 'Import existing media files into a bin (root by default). Requires absolute local paths. Reports actual new items; an import can partly succeed.', { paths: strings('Absolute media file paths.'), bin: item, numberedStills: bool('Import a numbered image sequence; default false.') }, ['paths']),
        tool('bin', 'Create a bin, rename a project item, or move an item into a bin. Item ids and destination bin are checked before mutation.', { action: choices(['create', 'rename', 'move']), item, parent: item, name: str('New bin/item name.') }, ['action']),
        tool('sequences', 'List, activate, rename, clone, create from a .sqpreset, or create from media project item ids. from_media derives sequence settings from footage; create from a preset uses undocumented QE and can vary by Premiere version.', { action: choices(['list', 'activate', 'rename', 'duplicate', 'create', 'from_media']), sequence, name: str('New sequence name.'), presetPath: str('Absolute .sqpreset path for create.'), items: strings('Project item ids or exact names for from_media.'), bin: item }, ['action']),
        tool('timeline', 'Inspect sequence tracks and clips: node id, track type/index, source in/out, timeline start/end, speed and selection. Times are seconds from sequence/source start; track indices are zero-based. Every track is listed with its clipCount; clips are filtered by trackType/trackIndex and from/to, and capped by maxClips (default 150). truncated:true means more clips matched.', { sequence, trackType: choices(['video', 'audio'], 'Only clips on this track type.'), trackIndex: int('Only clips on this track index (zero-based).', 0, 99), from: num('Only clips ending after this timeline second.'), to: num('Only clips starting before this timeline second.'), maxClips: int('Maximum clips returned; default 150.', 1, 1000) }),
        tool('insert_clip', 'Insert or overwrite a project item into existing sequence video/audio tracks. time is timeline seconds; track indices default to 0. Optional source in/out are restored on the project item after insertion. Insert may shift other clips; overwrite may replace them. Returns only the new track item ids (video and audio separately) and ids that disappeared, ready for premiere_clip_edit.', { sequence, item, time: num('Timeline seconds.'), videoTrack: int('Video track index.', 0, 99), audioTrack: int('Audio track index.', 0, 99), mode: choices(['insert', 'overwrite']), inPoint: num('Source in seconds.'), outPoint: num('Source out seconds.') }, ['item', 'time']),
        tool('clip_edit', 'Trim source in/out while preserving timeline start, move one track item to timeline time, rename, enable/disable or remove it. Trimming supports forward clips at normal speed. Linked audio/video are separate: edit each returned node id. Removing defaults to leaving a gap.', { sequence, clip, action: choices(['trim', 'move', 'rename', 'enable', 'remove']), inPoint: num('New source in seconds.'), outPoint: num('New source out seconds.'), time: num('New timeline start seconds.'), name: str('New clip name.'), enabled: bool('Whether the clip is enabled.'), ripple: bool('Ripple delete; default false.') }, ['clip', 'action']),
        tool('selection', 'Read or replace the timeline clip selection using node ids. All ids are resolved before changing selection.', { sequence, action: choices(['get', 'set']), clips: { type: 'array', items: { type: 'string' }, maxItems: 500 } }),
        tool('playhead', 'Read or set the sequence playhead and sequence in/out range in seconds. Returns times and sequence frame duration.', { sequence, time: num('Playhead seconds.'), inPoint: num('Sequence in seconds.'), outPoint: num('Sequence out seconds.') }),
        tool('markers', 'List, add or delete sequence markers. Delete requires a marker guid from list. Times and duration are seconds.', { sequence, action: choices(['list', 'add', 'delete']), time: num('Marker start seconds.'), duration: num('Marker duration seconds.'), name: str('Marker name.'), comments: str('Marker comment.'), guid: str('Marker guid to delete.'), color: choices(MARKER_COLORS, 'Marker color.') }, ['action']),
        tool('components', 'Inspect effects already on a clip, including Motion, Opacity and audio Volume. Returns component/property indices, display names, raw values (long strings such as Lumetri data are shortened) and keyframe times. Set parameters with premiere_set_parameter; arbitrary new effects can be applied through Premiere UI or premiere_execute.', { sequence, clip }, ['clip']),
        tool('set_parameter', 'Set a parameter on an existing clip effect by component/property index or exact name from premiere_components. value uses Premiere\'s raw units: Opacity 0-100; Motion Scale 100 = 100%; Motion Position is normalized [x,y] where [0.5,0.5] is frame center; Rotation in degrees; audio Volume Level is linear gain, not dB (gain = 10^((dB - 15) / 20), so 0 dB ≈ 0.178; verify by reading the value back). Color uses [alpha,red,green,blue] 0-255 with color:true. Static writes to animated properties are refused; give a keyframe time instead: timelineTime (sequence seconds, converted for you) or keyframeTime (seconds in the clip\'s source media time).', { sequence, clip, component: str('Component index as text, matchName or displayName.'), property: str('Property index as text or displayName.'), value: { description: 'Raw JSON parameter value: number, string, boolean or vector array.' }, color: bool('Use setColorValue with [a,r,g,b].'), timelineTime: num('Keyframe at this sequence time in seconds. Converted to source time as t - clip start + clip inPoint (normal-speed clips).'), keyframeTime: num('Keyframe time in seconds of the clip source media.'), interpolation: choices(Object.keys(INTERPOLATION), 'Keyframe interpolation.') }, ['clip', 'component', 'property', 'value']),
        tool('track', 'Inspect or mute/unmute a video or audio track. Indices are zero-based.', { sequence, type: choices(['video', 'audio']), index: int('Track index.', 0, 99), muted: bool('Set mute state; omit to inspect.') }, ['type', 'index']),
        tool('export', 'Queue an export in Adobe Media Encoder using an existing .epr preset, or export Final Cut Pro XML. Requires absolute output path. Media jobs return a job id, not completion; poll premiere_export_status with that jobId. The first export of a session waits for Media Encoder to start; call premiere_export_status with launchEncoder:true beforehand to start it separately. Existing output requires overwrite:true.', { sequence, path: str('Absolute output file path.'), presetPath: str('Absolute .epr preset path for media export.'), format: choices(['media', 'xml']), range: choices(['entire', 'in_out', 'workarea']), startQueue: bool('Start Media Encoder queue immediately; default true.'), overwrite: bool('Allow replacing existing output.') }, ['path']),
        tool('export_status', 'Status of Media Encoder jobs submitted by premiere_export in this Premiere session: queued, encoding (with progress 0-100), complete (with output path) or error. Omit jobId to list all jobs. launchEncoder:true starts Media Encoder without exporting (it can take tens of seconds the first time).', { jobId: str('Job id returned by premiere_export.'), launchEncoder: bool('Start Adobe Media Encoder now.') }),
        { ...tool('capture_frame', 'Render one sequence frame and return it as an image (downscaled to maxSize). By default uses Premiere\'s frame-to-PNG export, which needs no preset but works only on the active sequence (activate others with premiere_sequences action:"activate") and moves the playhead to time, restoring it afterwards. Pass presetPath (a PNG .epr from premiere_find_presets) to render through Media Encoder\'s synchronous exporter instead; it restores the in/out range. Rendering blocks Premiere.', { sequence, time: num('Timeline seconds; default current playhead.'), presetPath: str('Optional absolute PNG .epr export preset path.'), maxSize: int('Longest image side in pixels; default 1568.', 64, 4096), keep: bool('Keep the full-size PNG in the toolpack data folder and return its path; default false.') }),
            async run(args, ctx) {
                validate(args, this.inputSchema);
                const folder = join(ctx.dataDir, 'frames'); await mkdir(folder, { recursive: true });
                const path = join(folder, `${Date.now()}-${randomBytes(4).toString('hex')}.png`);
                const { maxSize, keep, ...rest } = args;
                try {
                    const data = await command({ ...rest, path }, 'capture_frame', 45_000); // Leaves time to wait for the PNG within Unify's 60s cap.
                    const bytes = await waitForFile(path, 10_000);
                    if (bytes.length > 64 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(args.presetPath ? 'The preset did not produce a PNG image. Select a PNG .epr preset.' : 'Premiere did not produce a PNG image.');
                    const image = downscalePng(bytes, Number(maxSize || 1568));
                    const info = { ...(record(data) ? data : {}), imageWidth: image.width, imageHeight: image.height, downscaled: image.scaled, ...(keep ? { path } : {}) };
                    return { content: [{ type: 'text', text: JSON.stringify(info) }, { type: 'image', data: image.png.toString('base64'), mimeType: 'image/png' }] };
                } finally { if (!keep) await rm(path, { force: true }); }
            } },
        tool('output_log', 'Read bridge execution events and Media Encoder completion/error events from this Premiere session (progress is in premiere_export_status). Returns entries and nextCursor; pass after:nextCursor next time to read only newer events. contains is case-insensitive. Default limit 50.', { contains: str('Text substring.'), limit: int('Maximum log entries.', 1, 500), after: int('Only entries with seq greater than this cursor.', 0, Number.MAX_SAFE_INTEGER), sinceTimestamp: num('Only events at or after this Unix time in milliseconds.') }),
        { ...tool('execute', 'Execute ES3-compatible ExtendScript inside Premiere with app and a print(value) function. Returns print output and the last expression; Premiere objects are returned as their String() form, so return plain values. Scripts block Premiere and cannot be cancelled after starting; no automatic retries and no guaranteed single undo step. QE is undocumented and version-sensitive. Example: var s = app.project.activeSequence; print(s.name); s.videoTracks.numTracks', { code: str('ExtendScript source, maximum 200000 UTF-8 bytes.'), timeoutSeconds: int('Response timeout; default 50.', 1, 55) }, ['code']),
            run(args) { validate(args, this.inputSchema); if (Buffer.byteLength(args.code as string, 'utf8') > 200_000) throw new Error('code exceeds 200000 bytes.'); return command(args, 'execute', Number(args.timeoutSeconds || 50) * 1000).then(data => compact(data, 'Print less or return a smaller value.')); } },
        tool('insert_title', 'Insert a Motion Graphics template (.mogrt) such as a title at a timeline time with Sequence.importMGT, optionally setting its text and other template parameters by display name (for example {"Main Title":"Level 2"}). Returns the new track item; list its parameters with premiere_components.', { sequence, path: str('Absolute .mogrt file path.'), time: num('Timeline seconds.'), videoTrack: int('Video track index; default 0.', 0, 99), audioTrack: int('Audio track index; default 0.', 0, 99), params: { type: 'object', description: 'Template parameter values keyed by display name, e.g. {"Main Title":"Boss Fight"}.' } }, ['path', 'time']),
        tool('razor', 'Split clips at a timeline time, like the Razor tool. Without trackType/trackIndex every track is cut. Uses Premiere\'s undocumented QE API on the active sequence; the result is verified by counting clips and an error says if nothing was cut. Returns the new clip ids on each cut track.', { sequence, time: num('Timeline seconds to cut at.'), trackType: choices(['video', 'audio'], 'Only cut tracks of this type.'), trackIndex: int('Only cut this track index (needs trackType).', 0, 99) }, ['time']),
        tool('add_tracks', 'Add empty video and/or audio tracks after the existing ones on the active sequence. Uses Premiere\'s undocumented QE API; the new track counts are verified and returned.', { sequence, video: int('Video tracks to add; default 0.', 0, 20), audio: int('Audio tracks to add; default 0.', 0, 20) }),
    ],
};
export default pack;

// Embedded assets make this a single-file Unify upload; no adjacent files or npm packages are needed.
const PANEL_FILES: Record<string, string> = {
    'CSXS/manifest.xml': String.raw`<?xml version="1.0" encoding="UTF-8"?>
<ExtensionManifest Version="7.0" ExtensionBundleId="com.unify.premiere.bridge" ExtensionBundleVersion="1.1.0" ExtensionBundleName="Unify Bridge">
  <ExtensionList><Extension Id="com.unify.premiere.bridge.panel" Version="1.1.0" /></ExtensionList>
  <ExecutionEnvironment><HostList><Host Name="PPRO" Version="[23.0,25.9]" /></HostList><LocaleList><Locale Code="All" /></LocaleList><RequiredRuntimeList><RequiredRuntime Name="CSXS" Version="11.0" /></RequiredRuntimeList></ExecutionEnvironment>
  <DispatchInfoList><Extension Id="com.unify.premiere.bridge.panel"><DispatchInfo>
    <Resources><MainPath>./index.html</MainPath><ScriptPath>./host.jsx</ScriptPath><CEFCommandLine><Parameter>--enable-nodejs</Parameter><Parameter>--mixed-context</Parameter></CEFCommandLine></Resources>
    <Lifecycle><AutoVisible>true</AutoVisible></Lifecycle>
    <UI><Type>Panel</Type><Menu>Unify Bridge</Menu><Geometry><Size><Width>340</Width><Height>230</Height></Size><MinSize><Width>260</Width><Height>160</Height></MinSize></Geometry></UI>
  </DispatchInfo></Extension></DispatchInfoList>
</ExtensionManifest>`,
    'index.html': String.raw`<!doctype html><html><head><meta charset="utf-8"><title>Unify Bridge</title>
<style>body{background:#13100E;color:#EFEAE4;font:13px system-ui,'Segoe UI',Arial,sans-serif;margin:18px}h1{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:700}p{line-height:1.5;color:#A89E94}#status{color:#EFEAE4}#last{color:#6C625A;overflow-wrap:break-word}button{background:#EFE6DA;color:#0D0B09;border:0;border-radius:6px;padding:7px 12px;cursor:pointer}button:hover{background:#FFF7EC}</style></head>
<body><h1><svg width="20" height="20" viewBox="0 0 32 32" fill="none"><path d="M4 2H12.4V19.2H15.5V27.6H4V2Z" fill="#C9A465"/><path d="M16.5 21.6H19.6V4.4H28V30H16.5V21.6Z" fill="#8B6A35"/></svg><span>Unify Premiere Bridge</span></h1><p id="status">Starting...</p><p id="last"></p><p>Keep this panel open while editing through Unify.</p><button id="toggle">Disconnect</button><script src="panel.js"></script></body></html>`,
    'panel.js': String.raw`(function () {
    'use strict';
    var status = document.getElementById('status'), last = document.getElementById('last');
    var nodeRequire = typeof cep_node !== 'undefined' ? cep_node.require : (typeof require === 'function' ? require : null);
    if (!nodeRequire || typeof __adobe_cep__ === 'undefined') { status.textContent = 'CEP Node integration is unavailable. Check the extension manifest and restart Premiere.'; return; }
    var fs = nodeRequire('fs'), path = nodeRequire('path'), os = nodeRequire('os'), http = nodeRequire('http'), crypto = nodeRequire('crypto');
    var discoveryDir = path.join(os.homedir(), '.unify', 'premiere-bridge');
    var session = crypto.randomBytes(12).toString('hex'), connections = {}, queue = [], busy = false, enabled = true, closed = false;
    var metadata = { version: '', project: '', file: '', sequence: '', bridge: '2' };
    // Keep ScriptPath minimal; load the editing script here so load errors can be caught.
    var hostFile = decodeURI(__adobe_cep__.getSystemPath('extension')).replace(/^file:\/\/(\/(?=[A-Za-z]:))?/, '') + '/commands.jsx';
    var loader = 'if (typeof $._UnifyPremiere === "undefined") { try { $.evalFile(' + JSON.stringify(hostFile) + '); } catch (e) { $._UnifyPremiereLoadError = String(e) + (e.line ? " (line " + e.line + ")" : ""); } } ';
    function evalHost(command, done) {
        var encoded = JSON.stringify(JSON.stringify(command)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
        __adobe_cep__.evalScript(loader + 'typeof $._UnifyPremiere === "undefined" ? "commands.jsx did not load: " + $._UnifyPremiereLoadError : $._UnifyPremiere.dispatch(' + encoded + ')', function (raw) {
            var result;
            try { result = JSON.parse(raw); if (typeof result.ok !== 'boolean') throw new Error('Missing result status'); }
            catch (error) { result = { ok: false, error: 'Host script failed: ' + String(raw).slice(0, 2000) }; }
            done(result);
        });
    }
    function query(meta) {
        var params = ['session=' + session];
        if (meta) Object.keys(metadata).forEach(function (key) { params.push(key + '=' + encodeURIComponent(String(metadata[key] || ''))); });
        return '?' + params.join('&');
    }
    function request(connection, route, method, body, done) {
        var finished = false, bytes = body ? JSON.stringify(body) : '';
        function finish(error, code, data) { if (finished) return; finished = true; done(error, code, data); }
        var req = http.request({ hostname: '127.0.0.1', port: connection.port, path: route, method: method,
            headers: { 'x-unify-token': connection.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, function (res) {
            var chunks = [], size = 0;
            res.on('data', function (chunk) { size += chunk.length; if (size > 8 * 1024 * 1024) { req.destroy(); finish(new Error('Bridge response too large')); } else chunks.push(chunk); });
            res.on('error', finish);
            res.on('end', function () { var raw = Buffer.concat(chunks).toString('utf8'), data; try { data = raw ? JSON.parse(raw) : null; } catch (error) { finish(error); return; } finish(null, res.statusCode, data); });
        });
        req.on('error', finish); req.setTimeout(18000, function () { req.destroy(new Error('Bridge network timeout')); });
        if (bytes) req.write(bytes); req.end(); return req;
    }
    function ui() {
        var count = Object.keys(connections).filter(function (key) { return connections[key].online; }).length;
        status.textContent = enabled ? (count ? 'Connected to ' + count + ' Unify window(s). Instance: ' + session : 'Waiting for Unify. Enable the premiere toolpack.') : 'Disconnected.';
    }
    function poll(connection) {
        if (closed || !enabled || connection.polling || connection.removed) return;
        connection.polling = true;
        connection.pollRequest = request(connection, '/poll' + query(true), 'GET', null, function (error, code, command) {
            connection.polling = false; connection.pollRequest = null;
            connection.online = !error && (code === 200 || code === 204); ui();
            if (!error && code === 200 && command && typeof command.id === 'number') {
                queue.push({ connection: connection, command: command }); drain();
            } else if (code === 401) { connection.removed = true; }
            if (!closed && enabled && !connection.removed) setTimeout(function () { poll(connection); }, error || code >= 400 ? 1500 : 50);
        });
    }
    function sendResult(connection, result, done, attempt) {
        request(connection, '/result' + query(false), 'POST', result, function (error, code) {
            if ((error || code >= 500) && !closed && !connection.removed && (attempt || 0) < 4) setTimeout(function () { sendResult(connection, result, done, (attempt || 0) + 1); }, 500);
            else done();
        });
    }
    function drain() {
        if (busy || closed || !queue.length) return;
        var work = queue.shift(), command = work.command; busy = true;
        function finish(result) {
            result.id = command.id;
            last.textContent = command.op + ': ' + (result.ok ? 'complete' : result.error);
            sendResult(work.connection, result, function () { busy = false; drain(); });
        }
        if (!enabled || work.connection.removed || Date.now() >= command.expiresAt) { finish({ ok: false, error: 'Command expired or panel disconnected before execution; it was not executed.' }); return; }
        last.textContent = 'Running ' + command.op + '...';
        evalHost(command, finish);
    }
    function scan() {
        if (closed || !enabled) return;
        var names = [], found = {};
        try { names = fs.readdirSync(discoveryDir); } catch (_) {}
        names.forEach(function (name) {
            if (!/\.json$/.test(name)) return;
            try {
                var info = JSON.parse(fs.readFileSync(path.join(discoveryDir, name), 'utf8'));
                if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{64}$/.test(info.token) || info.bridge !== 2) return;
                // Stale discovery files cannot connect to a recycled port without the correct token.
                var key = String(info.port) + ':' + info.token; found[key] = true;
                if (!connections[key]) connections[key] = { port: info.port, token: info.token, polling: false, online: false, removed: false };
                var connection = connections[key];
                if (!connection.removed) {
                    poll(connection);
                    request(connection, '/ping' + query(true), 'GET', null, function (error, code) { connection.online = !error && code === 200; ui(); });
                }
            } catch (_) {}
        });
        Object.keys(connections).forEach(function (key) { if (!found[key]) { connections[key].removed = true; if (connections[key].pollRequest) connections[key].pollRequest.destroy(); delete connections[key]; } });
        if (!busy && !queue.length) {
            busy = true;
            evalHost({ op: 'info', args: {} }, function (result) {
                if (result.ok && result.data) { metadata.version = result.data.version; metadata.project = result.data.project; metadata.file = result.data.path; metadata.sequence = result.data.sequence; }
                busy = false; drain();
            });
        }
        ui();
    }
    function disconnect() {
        Object.keys(connections).forEach(function (key) {
            var connection = connections[key]; connection.removed = true;
            request(connection, '/disconnect' + query(false), 'POST', {}, function () {});
            if (connection.pollRequest) connection.pollRequest.destroy();
        });
        connections = {};
    }
    document.getElementById('toggle').onclick = function () {
        enabled = !enabled; this.textContent = enabled ? 'Disconnect' : 'Connect';
        if (enabled) scan(); else disconnect(); ui();
    };
    window.addEventListener('beforeunload', function () { closed = true; clearInterval(timer); disconnect(); });
    var timer = setInterval(scan, 2000); scan();
}());`,
    'host.jsx': String.raw`$._UnifyPremiereBootstrap = true;
`,
    'commands.jsx': String.raw`// ExtendScript: keep this file compatible with ES3 (no const, let, promises, arrow functions, functions declared inside blocks).
// Runs agent code outside the bridge closure so scripts cannot reach the bridge's private state.
$._UnifyPremiereRun = function (code, print) { return eval(code); };
(function () {
    var TICKS = 254016000000, logs = [], nextSeq = 1, encoderBound = false, encoderLaunched = false, jobs = {}, jobOrder = [];
    var MARKER_COLORS = ['green', 'red', 'purple', 'orange', 'yellow', 'white', 'blue', 'cyan'];
    var INTERPOLATION = { linear: 0, hold: 1, bezier: 2, time: 3 };
    var TIME_TOLERANCE = 0.05;
    function fail(message) { throw new Error(message); }
    function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
    function kind(value) { return Object.prototype.toString.call(value); }
    function quote(value) {
        return '"' + String(value).replace(/[\\"\x00-\x1f\u2028\u2029]/g, function (c) {
            var map = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
            return map[c] || '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function stringify(value, depth) {
        // Only plain arrays/objects are walked; Premiere host objects become their String() form.
        depth = depth || 0; if (depth > 12) return quote('[max depth]');
        if (value === null || value === undefined) return 'null';
        var type = typeof value, parts = [], i, key;
        if (type === 'string') return quote(value);
        if (type === 'number') return isFinite(value) ? String(value) : 'null';
        if (type === 'boolean') return String(value);
        if (kind(value) === '[object Array]') { for (i = 0; i < value.length; i++) parts.push(stringify(value[i], depth + 1)); return '[' + parts.join(',') + ']'; }
        if (type === 'object' && kind(value) === '[object Object]') { for (key in value) if (own(value, key) && typeof value[key] !== 'function') parts.push(quote(key) + ':' + stringify(value[key], depth + 1)); return '{' + parts.join(',') + '}'; }
        return quote(String(value));
    }
    function parse(text) {
        // Small JSON reader: protocol input is never evaluated as ExtendScript.
        var at = 0;
        function whitespace() { while (/\s/.test(text.charAt(at)) && at < text.length) at++; }
        function value(depth) {
            if (depth > 30) fail('JSON nesting too deep.'); whitespace();
            var c = text.charAt(at++), result, key, match, token, escapes;
            if (c === '"') {
                result = '';
                while (at < text.length) {
                    c = text.charAt(at++); if (c === '"') return result;
                    if (c === '\\') {
                        c = text.charAt(at++);
                        if (c === 'u') { token = text.substr(at, 4); if (!/^[a-fA-F0-9]{4}$/.test(token)) fail('Invalid JSON unicode.'); result += String.fromCharCode(parseInt(token, 16)); at += 4; }
                        else { escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }; if (!own(escapes, c)) fail('Invalid JSON escape.'); result += escapes[c]; }
                    } else { if (c.charCodeAt(0) < 32) fail('Invalid JSON string.'); result += c; }
                }
                fail('Unterminated JSON string.');
            }
            if (c === '[' || c === '{') {
                result = c === '[' ? [] : {}; whitespace();
                if (text.charAt(at) === (c === '[' ? ']' : '}')) { at++; return result; }
                while (true) {
                    if (c === '[') result.push(value(depth + 1));
                    else { whitespace(); if (text.charAt(at) !== '"') fail('JSON object key must be a string.'); key = value(depth + 1); if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('Unsafe JSON key.'); whitespace(); if (text.charAt(at++) !== ':') fail('Missing JSON colon.'); result[key] = value(depth + 1); }
                    whitespace(); token = text.charAt(at++); if (token === (c === '[' ? ']' : '}')) return result; if (token !== ',') fail('Missing JSON comma.');
                }
            }
            at--; token = text.substr(at);
            if (token.substr(0, 4) === 'true') { at += 4; return true; }
            if (token.substr(0, 5) === 'false') { at += 5; return false; }
            if (token.substr(0, 4) === 'null') { at += 4; return null; }
            match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(token);
            if (!match) fail('Invalid JSON value.'); at += match[0].length; return Number(match[0]);
        }
        var result = value(0); whitespace(); if (at !== text.length) fail('Trailing JSON data.'); return result;
    }
    function log(level, message) { logs.push({ seq: nextSeq++, timestamp: new Date().getTime(), level: level, message: String(message) }); if (logs.length > 500) logs.shift(); }
    function time(seconds) { var result = new Time(); result.seconds = seconds; return result; }
    function seconds(value) { return value && typeof value.seconds === 'number' ? value.seconds : Number(value || 0) / TICKS; }
    function applyTime(label, set, get, target, numberFirst) {
        // Premiere's setters differ on whether they take seconds, a ticks string or a Time object.
        // Try each form and keep the one whose read-back matches.
        var forms = numberFirst ? [target, time(target).ticks, time(target)] : [time(target), target, time(target).ticks], got = NaN, lastError = '', i;
        for (i = 0; i < forms.length; i++) {
            try { set(forms[i]); got = seconds(get()); } catch (error) { lastError = String(error); continue; }
            if (Math.abs(got - target) <= TIME_TOLERANCE) return got;
        }
        fail(label + ' could not be set to ' + target + 's (read back ' + got + 's' + (lastError ? '; ' + lastError : '') + ').');
    }
    function brief(value) {
        if (typeof value === 'string' && value.length > 200) return value.substr(0, 200) + '...(' + value.length + ' chars)';
        if (kind(value) === '[object Array]' && value.length > 32) return { length: value.length, first: value.slice(0, 32) };
        return value;
    }
    function project() { if (!app.project || !app.project.rootItem) fail('No Premiere project is open.'); return app.project; }
    function sequence(ref) {
        var p = project(), matches = [], i, s;
        if (!ref) { if (!p.activeSequence) fail('No active sequence.'); return p.activeSequence; }
        for (i = 0; i < p.sequences.numSequences; i++) { s = p.sequences[i]; if (String(s.sequenceID) === String(ref)) return s; if (s.name === ref) matches.push(s); }
        if (matches.length !== 1) fail(matches.length ? 'Sequence name is ambiguous; use an id.' : 'Sequence not found: ' + ref); return matches[0];
    }
    function activeSequence(ref, what) {
        var s = sequence(ref), active = project().activeSequence;
        if (!active || String(active.sequenceID) !== String(s.sequenceID)) fail(what + ' works on the active sequence only. Activate it with premiere_sequences action:"activate" first.');
        app.enableQE();
        var qs = qe.project.getActiveSequence(); if (!qs) fail('QE could not open the active sequence.');
        return { dom: s, qe: qs };
    }
    function itemInfo(item, path) {
        var media = ''; try { media = item.getMediaPath(); } catch (_) {}
        return { id: String(item.nodeId), name: item.name, path: path || item.name, type: item.type === 3 ? 'root' : item.type === 2 ? 'bin' : item.isSequence() ? 'sequence' : 'clip', mediaPath: media };
    }
    function allItems() {
        var items = [], count = 0;
        function walk(parent, path, depth) {
            if (depth > 60) fail('Project tree is too deep.');
            for (var i = 0; i < parent.children.numItems; i++) {
                if (++count > 50000) fail('Project has over 50000 items; use a smaller project.');
                var child = parent.children[i], childPath = path ? path + '/' + child.name : child.name;
                items.push({ item: child, path: childPath }); if (child.type === 2) walk(child, childPath, depth + 1);
            }
        }
        walk(project().rootItem, '', 0); return items;
    }
    function item(ref, binOnly) {
        if (!ref || ref === '$root') return project().rootItem;
        var items = allItems(), matches = [], i, entry;
        for (i = 0; i < items.length; i++) {
            entry = items[i]; if (String(entry.item.nodeId) === String(ref)) { if (binOnly && entry.item.type !== 2) fail('Destination is not a bin.'); return entry.item; }
            if ((entry.item.name === ref || entry.path === ref) && (!binOnly || entry.item.type === 2)) matches.push(entry.item);
        }
        if (matches.length !== 1) fail(matches.length ? 'Item name/path is ambiguous; use a node id.' : 'Project item not found: ' + ref); return matches[0];
    }
    function containsNode(parent, target) {
        if (String(parent.nodeId) === String(target.nodeId)) return true;
        for (var i = 0; i < parent.children.numItems; i++) if (parent.children[i].type === 2 && containsNode(parent.children[i], target)) return true;
        return false;
    }
    function tracksOf(s, type) { return type === 'audio' ? s.audioTracks : s.videoTracks; }
    function track(s, type, index) { var tracks = tracksOf(s, type); if (index < 0 || index >= tracks.numTracks) fail('Track index does not exist: ' + type + ' ' + index); return tracks[index]; }
    function clips(s) {
        var result = [], kinds = ['video', 'audio'], tracks, t, c, k;
        for (k = 0; k < kinds.length; k++) { tracks = tracksOf(s, kinds[k]);
            for (t = 0; t < tracks.numTracks; t++) for (c = 0; c < tracks[t].clips.numItems; c++) result.push({ clip: tracks[t].clips[c], type: kinds[k], track: t, index: c }); }
        return result;
    }
    function clipIds(s) { var ids = {}, entries = clips(s); for (var i = 0; i < entries.length; i++) ids[String(entries[i].clip.nodeId)] = true; return ids; }
    function clip(s, id) { var entries = clips(s); for (var i = 0; i < entries.length; i++) if (String(entries[i].clip.nodeId) === String(id)) return entries[i]; fail('Timeline clip not found. Refresh premiere_timeline after editing.'); }
    function clipInfo(entry) {
        var c = entry.clip;
        return { id: String(c.nodeId), name: c.name, type: entry.type, track: entry.track, projectItemId: c.projectItem ? String(c.projectItem.nodeId) : null, start: seconds(c.start), end: seconds(c.end), inPoint: seconds(c.inPoint), outPoint: seconds(c.outPoint), speed: c.getSpeed(), reversed: !!c.isSpeedReversed(), selected: !!c.isSelected(), disabled: !!c.disabled };
    }
    function newClips(s, before) {
        var result = [], entries = clips(s);
        for (var i = 0; i < entries.length; i++) if (!before[String(entries[i].clip.nodeId)]) result.push({ id: String(entries[i].clip.nodeId), type: entries[i].type, track: entries[i].track, start: seconds(entries[i].clip.start), end: seconds(entries[i].clip.end) });
        return result;
    }
    function removedIds(s, before) { var now = clipIds(s), result = [], id; for (id in before) if (own(before, id) && !now[id]) result.push(id); return result; }
    function sequenceInfo(s) { return { id: String(s.sequenceID), name: s.name, end: seconds(s.end), frameDuration: Number(s.timebase) / TICKS, videoTracks: s.videoTracks.numTracks, audioTracks: s.audioTracks.numTracks }; }
    function required(a, key) { if (a[key] === undefined || a[key] === '') fail(key + ' is required for this action.'); return a[key]; }
    function absolute(path) {
        var first = path.charAt(0), third = path.charAt(2);
        var drive = /^[a-zA-Z]$/.test(first) && path.charAt(1) === ':' && (third === '/' || third === '\\');
        // A leading "/" is only absolute on macOS; on Windows it means the root of the current drive.
        var posix = first === '/' && String($.os || '').indexOf('Windows') < 0;
        if (!(drive || posix || path.substr(0, 2) === '\\\\')) fail('An absolute path is required: ' + path);
        return new File(path);
    }
    function inputFile(path) { var f = absolute(path); if (!f.exists) fail('File does not exist: ' + path); return f; }
    function outputFile(path, overwrite) {
        var f = absolute(path); if (f.exists && !overwrite) fail('Destination exists; use overwrite:true: ' + path);
        if (!f.parent.exists && !f.parent.create()) fail('Cannot create output folder: ' + f.parent.fsName); return f;
    }
    function success(result, label) { if (result === false) fail(label + ' failed.'); }
    function parameter(c, componentRef, propertyRef) {
        var components = c.components, matches = [], i, candidate;
        for (i = 0; i < components.numItems; i++) { candidate = components[i]; if (String(i) === componentRef || candidate.matchName === componentRef || candidate.displayName === componentRef) matches.push(candidate); }
        if (matches.length !== 1) fail('Component missing or ambiguous; use an index from premiere_components.');
        var properties = matches[0].properties; matches = [];
        for (i = 0; i < properties.numItems; i++) { candidate = properties[i]; if (String(i) === propertyRef || candidate.displayName === propertyRef) matches.push(candidate); }
        if (matches.length !== 1) fail('Property missing or ambiguous; use an index from premiere_components.'); return matches[0];
    }
    function job(id) {
        id = String(id);
        if (!own(jobs, id)) { jobs[id] = { jobId: id, status: 'submitted', progress: 0, path: '', output: '', error: '', updated: new Date().getTime() }; jobOrder.push(id); if (jobOrder.length > 100) delete jobs[jobOrder.shift()]; }
        return jobs[id];
    }
    function touchJob(id, fields) { var j = job(id), key; for (key in fields) if (own(fields, key)) j[key] = fields[key]; j.updated = new Date().getTime(); return j; }
    function bindEncoder() {
        if (encoderBound) return;
        // Progress updates the job in place so it never pushes completion events out of the log.
        app.encoder.bind('onEncoderJobComplete', function (id, output) { touchJob(id, { status: 'complete', progress: 100, output: String(output || '') }); log('complete', 'Encoder job ' + id + ' completed: ' + output); });
        app.encoder.bind('onEncoderJobError', function (id, error) { touchJob(id, { status: 'error', error: String(error || 'unknown error') }); log('error', 'Encoder job ' + id + ': ' + error); });
        app.encoder.bind('onEncoderJobProgress', function (id, progress) { var p = Number(progress) || 0; touchJob(id, { status: 'encoding', progress: Math.round(p <= 1 ? p * 100 : p) }); });
        app.encoder.bind('onEncoderJobQueued', function (id) { if (job(id).status === 'submitted') touchJob(id, { status: 'queued' }); });
        encoderBound = true;
    }
    function launchEncoder() { bindEncoder(); if (!encoderLaunched) { app.encoder.launchEncoder(); encoderLaunched = true; } }
    function info() { return { version: app.version, project: app.project ? app.project.name : '', path: app.project ? app.project.path : '', sequence: app.project && app.project.activeSequence ? app.project.activeSequence.name : '' }; }
    var ops = {
        info: info,
        project: function (a) {
            var f, result;
            if (a.action === 'open') { f = inputFile(required(a, 'path')); success(app.openDocument(f.fsName), 'Open project'); }
            else if (a.action === 'new') { f = outputFile(required(a, 'path'), a.overwrite); success(app.newProject(f.fsName), 'Create project'); }
            else if (a.action === 'save') { result = project().save(); if (typeof result === 'number' && result !== 0) fail('Project save returned ' + result); }
            else if (a.action === 'save_as') { f = outputFile(required(a, 'path'), a.overwrite); result = project().saveAs(f.fsName); if (typeof result === 'number' && result !== 0) fail('Save as returned ' + result); }
            return info();
        },
        tree: function (a) {
            var root = item(a.root, true), remaining = a.maxItems || 300;
            function walk(current, depth, path) {
                if (remaining <= 0) return null; remaining--;
                var result = itemInfo(current, path), children = [];
                var isFolder = current.type === 2 || current.type === 3;
                if (isFolder && depth > 0) for (var i = 0; i < current.children.numItems && remaining > 0; i++) children.push(walk(current.children[i], depth - 1, path + '/' + current.children[i].name));
                result.children = children; result.childCount = isFolder ? current.children.numItems : 0; return result;
            }
            return { root: walk(root, a.depth === undefined ? 4 : a.depth, root.name), truncated: remaining === 0 };
        },
        find: function (a) {
            var entries = allItems(), result = [], name = String(a.name || '').toLowerCase();
            for (var i = 0; i < entries.length && result.length < (a.limit || 50); i++) { var data = itemInfo(entries[i].item, entries[i].path); if (data.name.toLowerCase().indexOf(name) >= 0 && (!a.type || a.type === 'all' || a.type === data.type)) result.push(data); } return result;
        },
        import_media: function (a) {
            var destination = item(a.bin, true), paths = [], previous = {}, i;
            for (i = 0; i < a.paths.length; i++) paths.push(inputFile(a.paths[i]).fsName);
            for (i = 0; i < destination.children.numItems; i++) previous[String(destination.children[i].nodeId)] = true;
            var imported = project().importFiles(paths, true, destination, !!a.numberedStills), added = [];
            for (i = 0; i < destination.children.numItems; i++) if (!previous[String(destination.children[i].nodeId)]) added.push(itemInfo(destination.children[i]));
            return { success: imported, requestedPaths: paths, newItems: added, note: 'Inspect newItems for partial imports or existing media reused by Premiere.' };
        },
        bin: function (a) {
            var current, destination;
            if (a.action === 'create') { destination = item(a.parent, true); current = destination.createBin(required(a, 'name')); if (!current) fail('Could not create bin.'); }
            else { current = item(required(a, 'item')); if (current === project().rootItem) fail('Cannot rename or move project root.');
                if (a.action === 'rename') current.name = required(a, 'name');
                else {
                    destination = item(a.parent, true);
                    if (current.type === 2 && containsNode(current, destination)) fail('Cannot move a bin into itself or a descendant.');
                    success(current.moveBin(destination), 'Move project item');
                }
            } return itemInfo(current);
        },
        sequences: function (a) {
            var p = project(), s, result = [], i, before = {};
            if (a.action === 'list') { for (i = 0; i < p.sequences.numSequences; i++) result.push(sequenceInfo(p.sequences[i])); return result; }
            if (a.action === 'create') {
                var preset = inputFile(required(a, 'presetPath')); required(a, 'name'); app.enableQE();
                if (!qe || !qe.project || !qe.project.newSequence) fail('This Premiere version does not expose sequence creation from preset. Use from_media.');
                qe.project.newSequence(a.name, preset.fsName); s = sequence(a.name);
            } else if (a.action === 'from_media') {
                var refs = required(a, 'items'), media = []; for (i = 0; i < refs.length; i++) { var source = item(refs[i]); if (source.type === 2) fail('Use media items, not bins.'); media.push(source); }
                s = p.createNewSequenceFromClips(required(a, 'name'), media, item(a.bin, true)); if (!s) fail('Sequence creation failed.');
            } else {
                s = sequence(a.sequence);
                if (a.action === 'activate') success(p.openSequence(s.sequenceID), 'Activate sequence');
                if (a.action === 'rename') s.name = required(a, 'name');
                if (a.action === 'duplicate') {
                    for (i = 0; i < p.sequences.numSequences; i++) before[String(p.sequences[i].sequenceID)] = true;
                    success(s.clone(), 'Clone sequence'); s = null;
                    for (i = 0; i < p.sequences.numSequences; i++) if (!before[String(p.sequences[i].sequenceID)]) { s = p.sequences[i]; break; }
                    if (!s) fail('No new sequence appeared after cloning.'); if (a.name) s.name = a.name;
                }
            } return sequenceInfo(s);
        },
        timeline: function (a) {
            var s = sequence(a.sequence), result = sequenceInfo(s), tracks = [], remaining = a.maxClips || 150, truncated = false, kinds = ['video', 'audio'];
            for (var k = 0; k < kinds.length; k++) { var group = tracksOf(s, kinds[k]);
                for (var t = 0; t < group.numTracks; t++) {
                    var entry = { type: kinds[k], index: t, name: group[t].name, muted: !!group[t].isMuted(), clipCount: group[t].clips.numItems, clips: [] };
                    var wanted = (!a.trackType || a.trackType === kinds[k]) && (a.trackIndex === undefined || a.trackIndex === t);
                    for (var c = 0; wanted && c < group[t].clips.numItems; c++) {
                        var current = group[t].clips[c];
                        if (a.from !== undefined && seconds(current.end) <= a.from) continue;
                        if (a.to !== undefined && seconds(current.start) >= a.to) continue;
                        if (remaining <= 0) { truncated = true; break; }
                        entry.clips.push(clipInfo({ clip: current, type: kinds[k], track: t })); remaining--;
                    }
                    tracks.push(entry);
                }
            } result.tracks = tracks; result.truncated = truncated; return result;
        },
        insert_clip: function (a) {
            var s = sequence(a.sequence), source = item(a.item), v = a.videoTrack || 0, audio = a.audioTrack || 0;
            if (source.type === 2) fail('Cannot insert a bin.'); track(s, 'video', v); track(s, 'audio', audio);
            var oldIn = seconds(source.getInPoint(4)), oldOut = seconds(source.getOutPoint(4));
            var newIn = a.inPoint === undefined ? oldIn : a.inPoint, newOut = a.outPoint === undefined ? oldOut : a.outPoint;
            if (newOut <= newIn) fail('Source outPoint must be greater than inPoint.');
            var setIn = function (value) { source.setInPoint(value, 4); }, getIn = function () { return source.getInPoint(4); };
            var setOut = function (value) { source.setOutPoint(value, 4); }, getOut = function () { return source.getOutPoint(4); };
            var before = clipIds(s);
            try {
                if (a.inPoint !== undefined) applyTime('Source inPoint', setIn, getIn, newIn, false);
                if (a.outPoint !== undefined) applyTime('Source outPoint', setOut, getOut, newOut, false);
                var result = a.mode === 'overwrite' ? s.overwriteClip(source, time(a.time).ticks, v, audio) : s.insertClip(source, time(a.time), v, audio);
                success(result, 'Insert clip');
            } finally {
                // Restore the project item's own in/out; a failed restore must not hide the insert result.
                try { if (a.inPoint !== undefined) applyTime('Source inPoint', setIn, getIn, oldIn, false); } catch (error) { log('error', 'Could not restore source inPoint: ' + error); }
                try { if (a.outPoint !== undefined) applyTime('Source outPoint', setOut, getOut, oldOut, false); } catch (error2) { log('error', 'Could not restore source outPoint: ' + error2); }
            }
            return { sequence: String(s.sequenceID), newClips: newClips(s, before), removedClipIds: removedIds(s, before) };
        },
        clip_edit: function (a) {
            var s = sequence(a.sequence), entry = clip(s, a.clip), c = entry.clip;
            if (a.action === 'trim') {
                if (a.inPoint === undefined && a.outPoint === undefined) fail('Provide inPoint and/or outPoint.');
                if (c.getSpeed() !== 1 || c.isSpeedReversed()) fail('Trim supports normal forward speed only.');
                var start = seconds(c.start), sourceIn = a.inPoint === undefined ? seconds(c.inPoint) : a.inPoint, sourceOut = a.outPoint === undefined ? seconds(c.outPoint) : a.outPoint;
                if (sourceOut <= sourceIn) fail('outPoint must be greater than inPoint.');
                c.inPoint = time(sourceIn); c.outPoint = time(sourceOut); c.end = time(start + sourceOut - sourceIn);
                if (Math.abs(seconds(c.inPoint) - sourceIn) > TIME_TOLERANCE || Math.abs(seconds(c.outPoint) - sourceOut) > TIME_TOLERANCE) fail('Premiere did not apply the trim (now in ' + seconds(c.inPoint) + 's, out ' + seconds(c.outPoint) + 's). The source media may be shorter than requested.');
            } else if (a.action === 'move') {
                var offset = required(a, 'time') - seconds(c.start); success(c.move(offset), 'Move clip');
            } else if (a.action === 'rename') c.name = required(a, 'name');
            else if (a.action === 'enable') c.disabled = !required(a, 'enabled');
            else if (a.action === 'remove') { success(c.remove(!!a.ripple, true), 'Remove clip'); return { removed: a.clip, ripple: !!a.ripple }; }
            return clipInfo(entry);
        },
        selection: function (a) {
            var s = sequence(a.sequence), entries = clips(s), selected = [], i;
            if (a.action === 'set') {
                required(a, 'clips'); var resolved = []; for (i = 0; i < a.clips.length; i++) resolved.push(clip(s, a.clips[i]).clip);
                for (i = 0; i < entries.length; i++) entries[i].clip.setSelected(false, false);
                for (i = 0; i < resolved.length; i++) resolved[i].setSelected(true, i === resolved.length - 1);
            }
            for (i = 0; i < entries.length; i++) if (entries[i].clip.isSelected()) selected.push(clipInfo(entries[i])); return selected;
        },
        playhead: function (a) {
            var s = sequence(a.sequence), inTime = a.inPoint === undefined ? s.getInPointAsTime().seconds : a.inPoint, outTime = a.outPoint === undefined ? s.getOutPointAsTime().seconds : a.outPoint;
            if ((a.inPoint !== undefined || a.outPoint !== undefined) && outTime <= inTime) fail('Sequence outPoint must be greater than inPoint.');
            if (a.time !== undefined) success(s.setPlayerPosition(time(a.time).ticks), 'Set playhead');
            if (a.inPoint !== undefined) applyTime('Sequence inPoint', function (v) { s.setInPoint(v); }, function () { return s.getInPointAsTime(); }, a.inPoint, true);
            if (a.outPoint !== undefined) applyTime('Sequence outPoint', function (v) { s.setOutPoint(v); }, function () { return s.getOutPointAsTime(); }, a.outPoint, true);
            return { time: s.getPlayerPosition().seconds, inPoint: s.getInPointAsTime().seconds, outPoint: s.getOutPointAsTime().seconds, frameDuration: Number(s.timebase) / TICKS };
        },
        markers: function (a) {
            var markers = sequence(a.sequence).markers, m, result = [], count = 0, color;
            if (a.action === 'add') {
                if (a.color !== undefined) { for (color = 0; color < MARKER_COLORS.length && MARKER_COLORS[color] !== a.color; color++) {} if (color === MARKER_COLORS.length) fail('Unknown marker color: ' + a.color); }
                m = markers.createMarker(required(a, 'time')); m.name = a.name || ''; m.comments = a.comments || ''; if (a.duration !== undefined) m.end = a.time + a.duration; if (a.color !== undefined) m.setColorByIndex(color);
            }
            else if (a.action === 'delete') { required(a, 'guid'); var found = null; for (m = markers.getFirstMarker(); m && count++ < 10000; m = markers.getNextMarker(m)) if (String(m.guid) === a.guid) { found = m; break; } if (!found) fail('Marker not found.'); markers.deleteMarker(found); }
            count = 0; for (m = markers.getFirstMarker(); m && count++ < 10000; m = markers.getNextMarker(m)) result.push({ guid: String(m.guid), name: m.name, comments: m.comments, time: seconds(m.start), duration: seconds(m.end) - seconds(m.start), type: m.type }); return result;
        },
        components: function (a) {
            var c = clip(sequence(a.sequence), a.clip).clip, result = [];
            for (var i = 0; i < c.components.numItems; i++) { var component = c.components[i], entry = { index: i, name: component.displayName, matchName: component.matchName, properties: [] };
                for (var j = 0; j < component.properties.numItems; j++) { var p = component.properties[j], property = { index: j, name: p.displayName };
                    try { property.value = brief(p.getValue()); } catch (error) { property.error = String(error); }
                    try { property.color = p.getColorValue(); } catch (_) {}
                    try { property.timeVarying = !!p.isTimeVarying(); var keys = p.getKeys(), times = []; if (keys && keys.length) for (var k = 0; k < keys.length; k++) times.push(seconds(keys[k])); property.keyframeTimes = times; } catch (_) {}
                    entry.properties.push(property);
                } result.push(entry);
            } return result;
        },
        set_parameter: function (a) {
            var c = clip(sequence(a.sequence), a.clip).clip, p = parameter(c, a.component, a.property), result, keyTime = a.keyframeTime;
            if (a.timelineTime !== undefined) {
                if (a.keyframeTime !== undefined) fail('Pass timelineTime or keyframeTime, not both.');
                if (c.getSpeed() !== 1 || c.isSpeedReversed()) fail('timelineTime conversion supports normal-speed clips; pass keyframeTime in source seconds.');
                if (a.timelineTime < seconds(c.start) || a.timelineTime > seconds(c.end)) fail('timelineTime ' + a.timelineTime + 's is outside the clip (' + seconds(c.start) + 's to ' + seconds(c.end) + 's).');
                keyTime = a.timelineTime - seconds(c.start) + seconds(c.inPoint);
            }
            if (a.color) {
                if (keyTime !== undefined) fail('Color keyframes are not supported by this helper.');
                if (kind(a.value) !== '[object Array]' || a.value.length !== 4) fail('Color value must be [alpha,red,green,blue].');
                for (var i = 0; i < 4; i++) if (typeof a.value[i] !== 'number' || !isFinite(a.value[i]) || a.value[i] < 0 || a.value[i] > 255) fail('Color channels must be numbers from 0 to 255.');
                if (p.isTimeVarying()) fail('Parameter is animated; static color changes are refused.');
                result = p.setColorValue(a.value[0], a.value[1], a.value[2], a.value[3], true);
            } else if (keyTime !== undefined) {
                if (!p.areKeyframesSupported()) fail('This parameter does not support keyframes.');
                p.setTimeVarying(true); var at = time(keyTime); p.addKey(at); result = p.setValueAtKey(at, a.value, true);
                if (a.interpolation !== undefined) { if (!own(INTERPOLATION, a.interpolation)) fail('Unknown interpolation: ' + a.interpolation); p.setInterpolationTypeAtKey(at, INTERPOLATION[a.interpolation], true); }
            } else { if (p.isTimeVarying()) fail('Parameter is animated; supply timelineTime or keyframeTime.'); result = p.setValue(a.value, true); }
            if (typeof result === 'number' && result !== 0) fail('Parameter write returned ' + result);
            return { property: p.displayName, value: brief(a.color ? p.getColorValue() : p.getValue()), keyframeTime: keyTime };
        },
        track: function (a) { var t = track(sequence(a.sequence), a.type, a.index); if (a.muted !== undefined) success(t.setMute(a.muted ? 1 : 0), 'Track mute'); return { type: a.type, index: a.index, name: t.name, muted: !!t.isMuted(), clips: t.clips.numItems }; },
        'export': function (a) {
            var s = sequence(a.sequence), preset = a.format === 'xml' ? null : inputFile(required(a, 'presetPath')), f = outputFile(a.path, a.overwrite);
            if (a.format === 'xml') { var result = s.exportAsFinalCutProXML(f.fsName, 1); success(result, 'XML export'); if (typeof result === 'number' && result !== 0) fail('XML export returned ' + result); if (!f.exists) fail('XML export did not create a file.'); return { path: f.fsName, format: 'xml', complete: true }; }
            launchEncoder();
            var range = a.range === 'in_out' ? app.encoder.ENCODE_IN_TO_OUT : a.range === 'workarea' ? app.encoder.ENCODE_WORKAREA : app.encoder.ENCODE_ENTIRE;
            var id = app.encoder.encodeSequence(s, f.fsName, preset.fsName, range, 1, false);
            if (!id || String(id) === '0') fail('Media Encoder did not return a job id.');
            var entry = touchJob(id, { path: f.fsName, status: job(id).status === 'submitted' && a.startQueue === false ? 'queued' : job(id).status });
            if (a.startQueue !== false) app.encoder.startBatch();
            return { jobId: entry.jobId, path: f.fsName, complete: false, status: entry.status, note: 'Poll premiere_export_status with this jobId; encoding continues after this call.' };
        },
        export_status: function (a) {
            if (a.launchEncoder) launchEncoder();
            if (a.jobId !== undefined) { if (!own(jobs, String(a.jobId))) fail('Unknown job id ' + a.jobId + ' in this Premiere session. Jobs from before a Premiere restart are not tracked.'); return jobs[String(a.jobId)]; }
            var list = []; for (var i = Math.max(0, jobOrder.length - 50); i < jobOrder.length; i++) list.push(jobs[jobOrder[i]]);
            return { encoderLaunched: encoderLaunched, jobs: list };
        },
        capture_frame: function (a) {
            var s = sequence(a.sequence), f = outputFile(a.path, false), duration = Number(s.timebase) / TICKS;
            if (!isFinite(duration) || duration <= 0) fail('Cannot determine sequence frame duration.');
            var playhead = s.getPlayerPosition(), at = a.time === undefined ? playhead.seconds : a.time, frameStart = Math.floor(at / duration + 1e-6) * duration;
            if (a.presetPath) {
                var preset = inputFile(a.presetPath), oldIn = s.getInPointAsTime().seconds, oldOut = s.getOutPointAsTime().seconds;
                try {
                    s.setInPoint(frameStart); s.setOutPoint(frameStart + duration);
                    var result = s.exportAsMediaDirect(f.fsName, preset.fsName, app.encoder.ENCODE_IN_TO_OUT);
                    if (!f.exists) fail('Frame export failed: ' + String(result));
                } finally { s.setInPoint(oldIn); s.setOutPoint(oldOut); }
                return { sequence: s.name, time: frameStart, method: 'preset' };
            }
            var qs = activeSequence(a.sequence, 'Frame capture without presetPath').qe;
            try {
                success(s.setPlayerPosition(time(frameStart).ticks), 'Set playhead');
                // exportFramePNG appends .png to the base name it is given.
                qs.exportFramePNG(qs.CTI.timecode, f.fsName.replace(/\.png$/i, ''));
            } finally { s.setPlayerPosition(playhead.ticks); }
            return { sequence: s.name, time: frameStart, method: 'qe' };
        },
        insert_title: function (a) {
            var s = sequence(a.sequence), f = inputFile(required(a, 'path')), v = a.videoTrack || 0, audio = a.audioTrack || 0, applied = [], missing = [], available = [], key, i;
            if (!/\.mogrt$/i.test(f.fsName)) fail('path must be a .mogrt file.');
            track(s, 'video', v);
            var before = clipIds(s), item = s.importMGT(f.fsName, time(a.time).ticks, v, audio);
            if (!item) fail('importMGT returned nothing. Check the template and that the video track is not locked.');
            if (a.params) {
                var component = item.getMGTComponent(); if (!component) fail('The inserted item has no Motion Graphics parameters.');
                for (key in a.params) if (own(a.params, key)) {
                    var param = component.properties.getParamForDisplayName(key);
                    if (!param) { missing.push(key); continue; }
                    param.setValue(a.params[key], true); applied.push(key);
                }
                if (missing.length) for (i = 0; i < component.properties.numItems; i++) available.push(component.properties[i].displayName);
            }
            var output = { clipId: String(item.nodeId), newClips: newClips(s, before), paramsSet: applied, paramsMissing: missing };
            if (missing.length) output.availableParams = available;
            return output;
        },
        razor: function (a) {
            var pair = activeSequence(a.sequence, 'Razor'), s = pair.dom, qs = pair.qe, kinds = a.trackType ? [a.trackType] : ['video', 'audio'], cuts = [], total = 0, k, t;
            if (a.trackIndex !== undefined && !a.trackType) fail('trackIndex needs trackType.');
            var settings = s.getSettings(), timecode = time(a.time).getFormatted(settings.videoFrameRate, settings.videoDisplayFormat);
            var before = clipIds(s);
            for (k = 0; k < kinds.length; k++) {
                var count = tracksOf(s, kinds[k]).numTracks;
                for (t = 0; t < count; t++) {
                    if (a.trackIndex !== undefined && a.trackIndex !== t) continue;
                    var qt = kinds[k] === 'video' ? qs.getVideoTrackAt(t) : qs.getAudioTrackAt(t);
                    if (qt) qt.razor(timecode);
                }
            }
            var added = newClips(s, before);
            for (k = 0; k < added.length; k++) { cuts.push(added[k]); total++; }
            if (!total) fail('Razor made no cut at ' + a.time + 's (timecode ' + timecode + '). Check that a clip spans that time and the track is not locked; the QE razor API can differ between Premiere versions.');
            return { time: a.time, timecode: timecode, newClips: cuts };
        },
        add_tracks: function (a) {
            var pair = activeSequence(a.sequence, 'Adding tracks'), s = pair.dom, video = a.video || 0, audio = a.audio || 0;
            if (!video && !audio) fail('Pass video and/or audio counts.');
            var v0 = s.videoTracks.numTracks, a0 = s.audioTracks.numTracks;
            // QE addTracks(videoCount, videoAfterIndex, audioCount, audioType, audioAfterIndex, submixCount, submixType, submixAfterIndex)
            pair.qe.addTracks(video, v0, audio, 1, a0, 0, 1, 0);
            s = sequence(a.sequence);
            var v1 = s.videoTracks.numTracks, a1 = s.audioTracks.numTracks;
            if (v1 - v0 !== video || a1 - a0 !== audio) fail('Premiere added ' + (v1 - v0) + ' video and ' + (a1 - a0) + ' audio tracks instead of ' + video + ' and ' + audio + '. The QE addTracks signature may differ in this version.');
            return { videoTracks: v1, audioTracks: a1, addedVideo: video, addedAudio: audio };
        },
        output_log: function (a) {
            var result = [], contains = String(a.contains || '').toLowerCase(), after = a.after || 0;
            for (var i = 0; i < logs.length; i++) if (logs[i].seq > after && (!a.sinceTimestamp || logs[i].timestamp >= a.sinceTimestamp) && logs[i].message.toLowerCase().indexOf(contains) >= 0) result.push(logs[i]);
            result = result.slice(-(a.limit || 50));
            return { entries: result, nextCursor: logs.length ? logs[logs.length - 1].seq : after };
        },
        execute: function (a) {
            var printed = [], size = 0;
            function print(value) { var text = typeof value === 'string' ? value : stringify(value); size += text.length; if (size <= 40000) printed.push(text); }
            var result = $._UnifyPremiereRun(a.code, print);
            return { output: printed.join('\n') + (size > 40000 ? '\n...[print output truncated at 40000 characters]' : ''), result: result === undefined ? null : result };
        }
    };
    $._UnifyPremiere = {
        dispatch: function (raw) {
            var command, result;
            try { command = parse(raw); if (!own(ops, command.op)) fail('Unknown operation: ' + command.op + '. Reinstall the panel with premiere_install_panel.'); result = ops[command.op](command.args || {}); if (command.op !== 'info' && command.op !== 'output_log' && command.op !== 'export_status') log('command', command.op + ' completed'); return stringify({ ok: true, data: result }); }
            catch (error) { var message = String(error) + (error.line ? ' (line ' + error.line + ')' : ''); log('error', (command ? command.op + ': ' : '') + message); return stringify({ ok: false, error: message }); }
        }
    };
}());
`,
};
