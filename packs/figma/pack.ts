import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join } from 'node:path';


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
    id: string; file: string; page: string; editor: string; user: string; bridge: number;
    lastSeen: number; queue: Command[]; waiters: Waiter[]; inflight: Set<number>;
    /** The command Figma is running now, for busy messages. */
    current?: { id: number; op: string; since: number };
}
interface Pending {
    session: string; sent: boolean; resolve(value: unknown): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}
const BRIDGE_VERSION = 2;
/** Unify stops waiting for a tool call after 60s, so every bridge wait ends before that. */
const MAX_WAIT_MS = 55_000;
/** Keep JSON replies under Unify's 60,000-character tool output cap so they are never cut mid-JSON. */
const MAX_REPLY_CHARS = 55_000;
const ONLINE_MS = 10_000;
const PORT = Number(process.env.UNIFY_FIGMA_PORT ?? 34876);
const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-unify-code',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-private-network': 'true',
};
const state = {
    server: undefined as Server | undefined, server6: undefined as Server | undefined, ctx: undefined as ToolpackContext | undefined,
    code: '', port: 0, lastStatus: '', nextId: 1,
    statusTimer: undefined as ReturnType<typeof setInterval> | undefined,
    sessions: new Map<string, Session>(), pending: new Map<number, Pending>(),
};
function record(value: unknown): value is Args { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(res: ServerResponse, status: number, data: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
}
function endWaiter(waiter: Waiter): void { clearTimeout(waiter.timer); if (!waiter.res.writableEnded && !waiter.res.destroyed) { waiter.res.writeHead(204, CORS); waiter.res.end(); } }
function online(session: Session): boolean { return Date.now() - session.lastSeen < ONLINE_MS; }
function label(session: Session): string { return `${session.file || 'Untitled'} / ${session.page || '?'} (${session.editor || 'figma'}, instance ${session.id})`; }
function busyText(session: Session): string {
    const current = session.current;
    if (!current) return '';
    return ` Figma is busy running ${current.op} (${Math.round((Date.now() - current.since) / 1000)}s so far) with ${session.queue.length} more queued; retry when it finishes.`;
}
function rejectCommand(id: number, reason: string): void {
    const pending = state.pending.get(id);
    if (!pending) return;
    state.pending.delete(id); clearTimeout(pending.timer);
    const session = state.sessions.get(pending.session);
    if (session) { session.queue = session.queue.filter(command => command.id !== id); session.inflight.delete(id); }
    if (session?.current?.id === id) session.current = undefined;
    const busy = session && !pending.sent ? busyText(session) : '';
    pending.reject(new Error(reason + (pending.sent ? ' The command was delivered and may have run. Inspect Figma before retrying.' : ' The command was not delivered.' + busy)));
}
function prune(): void {
    for (const session of state.sessions.values()) {
        if (online(session)) continue;
        for (const [id, pending] of state.pending) if (pending.session === session.id) rejectCommand(id, `Figma ${session.id} disconnected.`);
        for (const waiter of session.waiters.splice(0)) endWaiter(waiter);
        if (Date.now() - session.lastSeen > 300_000) state.sessions.delete(session.id);
    }
}
function updateStatus(): void {
    prune();
    const sessions = [...state.sessions.values()].filter(online);
    const text = sessions.length
        ? `Connected: ${sessions.map(label).join(', ')}. Pairing code: ${state.code}`
        : `Waiting for Figma. Run figma_install_plugin, then in Figma run Plugins > Development > Unify Bridge and enter pairing code ${state.code} (port ${state.port}).`;
    if (text !== state.lastStatus) { state.lastStatus = text; state.ctx?.status(text); }
}
function touch(url: URL): Session {
    const id = url.searchParams.get('session') || '';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid session id.');
    let session = state.sessions.get(id);
    if (!session) {
        session = { id, file: '', page: '', editor: '', user: '', bridge: 0, lastSeen: 0, queue: [], waiters: [], inflight: new Set() };
        state.sessions.set(id, session);
        state.ctx?.log(`Figma file ${id} connected.`);
    }
    for (const key of ['file', 'page', 'editor', 'user'] as const) if (url.searchParams.has(key)) session[key] = (url.searchParams.get(key) || '').slice(0, 4096);
    if (url.searchParams.has('bridge')) session.bridge = Number(url.searchParams.get('bridge')) || 0;
    session.lastSeen = Date.now(); updateStatus();
    return session;
}
function dispatch(session: Session): void {
    // One outstanding command per instance.
    if (session.inflight.size) return;
    while (session.queue.length && session.waiters.length) {
        const waiter = session.waiters.shift()!;
        clearTimeout(waiter.timer);
        if (waiter.res.destroyed || waiter.res.writableEnded) continue;
        const command = session.queue.shift()!;
        const pending = state.pending.get(command.id);
        if (!pending || command.expiresAt <= Date.now()) { json(waiter.res, 204, undefined); continue; }
        pending.sent = true; session.inflight.add(command.id);
        session.current = { id: command.id, op: command.op, since: Date.now() };
        json(waiter.res, 200, command); return;
    }
}
class TooLarge extends Error { }
async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 48 * 1024 * 1024) throw new TooLarge('Request body exceeds 48 MB.');
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (String(req.headers['x-unify-code'] || '').trim().toUpperCase() !== state.code) { json(res, 401, { error: 'Wrong pairing code.' }); return; }
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
        // 413 lets the plugin replace an oversized result with an error instead of leaving the call to time out.
        try { data = await readBody(req); } catch (error) { if (error instanceof TooLarge) json(res, 413, { error: 'Result exceeds 48 MB.' }); else json(res, 400, { error: 'Invalid JSON.' }); return; }
        if (!record(data) || !Number.isSafeInteger(data.id) || typeof data.ok !== 'boolean') { json(res, 400, { error: 'Expected id and ok.' }); return; }
        const id = data.id as number, pending = state.pending.get(id), sessionId = url.searchParams.get('session') || '';
        if (pending && (pending.session !== sessionId || !pending.sent)) { json(res, 409, { error: 'Result does not belong to this instance or was not dispatched.' }); return; }
        if (pending) {
            state.pending.delete(id); clearTimeout(pending.timer);
            const session = state.sessions.get(sessionId);
            if (session) { session.inflight.delete(id); session.lastSeen = Date.now(); if (session.current?.id === id) session.current = undefined; }
            if (data.ok) pending.resolve(data.data); else pending.reject(new Error(typeof data.error === 'string' ? data.error : 'Figma command failed.'));
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
    if (args.instance) sessions = sessions.filter(session => session.id === args.instance || session.file === args.instance);
    if (!sessions.length) throw new Error('No matching Figma file connected. Run figma_install_plugin, open Plugins > Development > Unify Bridge in Figma and enter the pairing code.');
    if (sessions.length > 1) throw new Error(`Several Figma files match; pass an instance id from figma_instances: ${sessions.map(label).join('; ')}`);
    if (sessions[0].bridge !== BRIDGE_VERSION) throw new Error('Figma plugin protocol differs. Run figma_install_plugin, re-import the plugin manifest in Figma and restart the plugin.');
    return sessions[0];
}
function command(args: Args, op: string, timeoutMs = 50_000): Promise<unknown> {
    if (!state.server) throw new Error('Figma toolpack is not running.');
    timeoutMs = Math.min(timeoutMs, MAX_WAIT_MS);
    const session = resolveSession(args), id = state.nextId++;
    const { instance: _instance, timeoutSeconds: _timeout, ...payload } = args;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 1_000_000) throw new Error('Command arguments exceed 1 MB.');
    return new Promise((resolve, reject) => {
        state.pending.set(id, { session: session.id, sent: false, resolve, reject, timer: setTimeout(() => rejectCommand(id, `Figma ${op} timed out.`), timeoutMs) });
        session.queue.push({ id, op, args: payload, expiresAt: Date.now() + timeoutMs }); dispatch(session);
    });
}
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
const str = (description: string): Args => ({ type: 'string', description });
const num = (description: string, minimum = 0): Args => ({ type: 'number', minimum, description });
const int = (description: string, minimum = 0, maximum = 10000): Args => ({ type: 'integer', minimum, maximum, description });
const bool = (description: string): Args => ({ type: 'boolean', description });
const choices = (values: string[], description = ''): Args => ({ type: 'string', enum: values, description });
const instance = str('Instance id or file name; required when several Figma files are connected. Use figma_instances.');
const node = str('Figma node id, e.g. 12:34. Use figma_tree, figma_find or figma_selection.');
const page = str('Page id or exact name; defaults to the current page. Pass it when other agents may switch pages.');
const maxSize = (fallback: number): Args => int(`Cap on the longest output side in pixels; default ${fallback}. Roblox images are limited to 1024.`, 16, 8192);
function tool(name: string, description: string, properties: Record<string, Args> = {}, required: string[] = []): ToolpackTool {
    const inputSchema = { type: 'object', additionalProperties: false, properties: { instance, ...properties }, required };
    return { name, description, inputSchema, async run(args) { validate(args, inputSchema); return bounded(await command(args, name)); } };
}
function bounded(value: unknown): unknown {
    const text = JSON.stringify(value);
    if (text !== undefined && text.length > MAX_REPLY_CHARS) throw new Error(`Result is ${text.length} characters, over the ${MAX_REPLY_CHARS} limit. Narrow it: lower depth/maxItems/limit, pass a root node, or drop includeStyle.`);
    return value;
}
/** Reads width and height from a PNG header; other formats return undefined. */
function pngSize(buffer: Buffer): { width: number; height: number } | undefined {
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString('latin1', 12, 16) !== 'IHDR') return undefined;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
function fileSafe(value: string): string {
    const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
    return (cleaned || 'node').slice(0, 120);
}
async function writeNew(path: string, data: Buffer, overwrite: boolean): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    try { await writeFile(path, data, { flag: overwrite ? 'w' : 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} exists; pass overwrite:true.`); throw error; }
}
async function writePlugin(folder: string): Promise<void> {
    await mkdir(folder, { recursive: true });
    for (const [name, source] of Object.entries(PLUGIN_FILES)) await writeFile(join(folder, name), source, 'utf8');
}
function newCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(randomBytes(8), byte => alphabet[byte % alphabet.length]).join('');
}
const pack: ToolpackDefinition = {
    name: 'figma',
    description: 'Inspect and edit open Figma design files through the Unify Bridge development plugin: list pages, browse the layer tree, find nodes, read/set selection and node properties, capture node images, export PNG/JPG/SVG/PDF files to disk (one node or batches at several scales), and run Figma Plugin API JavaScript. Requires the Figma desktop app with the Unify Bridge plugin running (figma_install_plugin) and the pairing code entered.',
    async setup(ctx) {
        if (state.server) throw new Error('Figma bridge is already running.');
        state.ctx = ctx; state.lastStatus = '';
        try {
            await mkdir(ctx.dataDir, { recursive: true });
            const codePath = join(ctx.dataDir, 'pairing-code.txt');
            let code = '';
            if (existsSync(codePath)) { const saved = (await readFile(codePath, 'utf8')).trim(); if (/^[A-Z0-9]{8}$/.test(saved)) code = saved; }
            if (!code) { code = newCode(); await writeFile(codePath, code, 'utf8'); }
            state.code = code;
            await writePlugin(join(ctx.dataDir, 'plugin'));
            const listener = (req: IncomingMessage, res: ServerResponse) => { void handle(req, res).catch(error => { ctx.log(`Figma bridge: ${String(error)}`); json(res, 500, { error: 'Bridge request failed.' }); }); };
            const server = createServer(listener);
            state.server = server;
            await new Promise<void>((resolve, reject) => {
                server.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is in use. Close the other Unify window using the figma toolpack or set UNIFY_FIGMA_PORT (the plugin manifest only allows localhost:34876).`) : error));
                server.listen(PORT, '127.0.0.1', resolve);
            });
            // Figma only allows "localhost" in the manifest, which can resolve to ::1; also listen on IPv6 loopback when available.
            const server6 = createServer(listener);
            state.server6 = await new Promise<Server | undefined>(resolve => {
                server6.once('error', (error: Error) => { ctx.log(`Figma bridge: IPv6 loopback unavailable (${error.message}).`); resolve(undefined); });
                server6.listen(PORT, '::1', () => resolve(server6));
            });
            state.port = PORT;
            ctx.log(`Figma bridge listening on localhost:${PORT}`);
            updateStatus(); state.statusTimer = setInterval(updateStatus, 2000); state.statusTimer.unref();
        } catch (error) { await pack.teardown(); throw error; }
    },
    async teardown() {
        if (state.statusTimer) clearInterval(state.statusTimer); state.statusTimer = undefined;
        for (const id of state.pending.keys()) rejectCommand(id, 'Figma toolpack stopped.');
        for (const session of state.sessions.values()) for (const waiter of session.waiters.splice(0)) endWaiter(waiter);
        state.sessions.clear();
        const servers = [state.server, state.server6]; state.server = undefined; state.server6 = undefined;
        for (const server of servers) if (server) { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        state.ctx = undefined; state.code = ''; state.port = 0; state.lastStatus = '';
    },
    tools: [
        { name: 'instances', description: 'List connected Figma files with their current page, editor, user, bridge version and the command each is busy with. Choose an instance id when several files are connected.', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, run() { prune(); return [...state.sessions.values()].filter(online).map(session => ({ instance: session.id, file: session.file, page: session.page, editor: session.editor, user: session.user, bridgeVersion: session.bridge, busy: session.current ? `${session.current.op} #${session.current.id} for ${Math.round((Date.now() - session.current.since) / 1000)}s` : false, queued: session.queue.length })); } },
        { name: 'install_plugin', description: 'Install/update the bundled Unify Bridge Figma development plugin into the Unify data folder. Import the manifest once in Figma, then run the plugin and enter the pairing code.',
            inputSchema: { type: 'object', additionalProperties: false, properties: {} },
            async run(args, ctx) {
                validate(args, this.inputSchema);
                const folder = join(ctx.dataDir, 'plugin');
                await writePlugin(folder);
                return `Wrote the Unify Bridge plugin to ${folder}. One-time setup: open the Figma desktop app, open any design file, then Plugins > Development > Import plugin from manifest... and choose ${join(folder, 'manifest.json')}. To connect: Plugins > Development > Unify Bridge, enter pairing code ${state.code} and press Connect. Keep the plugin window open while working.`;
            } },
        tool('pages', 'List pages or switch the current page. page accepts a page id or exact name.', { action: choices(['list', 'switch']), page: str('Page id or exact name.') }),
        tool('tree', 'Read the layer tree with node ids, types, names, positions and sizes (x/y relative to the parent). root (a node) or page sets where to start; default is the current page. depth defaults to 3 and maxItems to 200. includeStyle adds fill/stroke hex, opacity, corner radius, auto layout, and text/font/fontSize for text nodes.', { root: node, page, depth: int('Levels to descend.', 0, 30), maxItems: int('Maximum nodes returned; default 200.', 1, 400), includeStyle: bool('Add compact visual attributes to each node.') }),
        tool('find', 'Find nodes by case-insensitive name substring and/or node type. scope page (default) searches page (or the current page); document loads and searches every page. Each result includes page and pageId.', { name: str('Name substring.'), type: str('Figma node type, case-insensitive: FRAME, TEXT, COMPONENT, COMPONENT_SET, INSTANCE, RECTANGLE, ELLIPSE, GROUP, VECTOR, SECTION, LINE, BOOLEAN_OPERATION.'), scope: choices(['page', 'document']), page, limit: int('Maximum results; default 50.', 1, 400) }),
        tool('selection', 'Get or set the selection on the current page. set switches to the page of the first node, selects the given ids and optionally zooms the viewport to them. Selection and the current page are shared with the user and other agents; prefer passing node ids to other tools.', { action: choices(['get', 'set']), nodes: { type: 'array', items: { type: 'string' }, maxItems: 500, description: 'Node ids to select.' }, zoom: bool('Scroll and zoom to the selection; default true.') }),
        tool('properties', 'Read a node\'s properties (geometry, fills, strokes, effects, auto layout, text, component info). Pass set to assign properties, e.g. {"name":"Button","x":10,"opacity":0.5,"characters":"Hi","fills":[{"type":"SOLID","color":{"r":1,"g":0.5,"b":0},"opacity":0.8}]}. Colors are 0-1 {r,g,b} with opacity as a separate paint field; fills/strokes replace the whole array; x/y are relative to the parent; width/height resize the node; text fonts are loaded automatically. Returns the updated properties and per-key errors.', { node, set: { type: 'object', description: 'Property name to value map.' } }, ['node']),
        { ...tool('capture_view', 'Render a node to PNG and return it as an image plus its id, page, pixel size and effective scale. node defaults to page (if given), else the first selected node, else the current page. scale defaults to 1; the longest side is capped at maxSize.', { node, page, scale: num('Export scale 0.1-4.', 0.1), maxSize: maxSize(1568) }),
            async run(args) {
                validate(args, this.inputSchema);
                if (Number(args.scale || 1) > 4) throw new Error('scale must be at most 4.');
                const data = await command(args, 'capture_view') as { base64: string; id: string; name: string; page: unknown; width: number; height: number; scale: number };
                const bytes = Buffer.from(data.base64, 'base64');
                if (bytes.length > 8 * 1024 * 1024) throw new Error('Image exceeds 8 MB; lower maxSize or scale, or pick a smaller node.');
                const size = pngSize(bytes);
                return { content: [{ type: 'text', text: JSON.stringify({ id: data.id, name: data.name, page: data.page, width: size?.width ?? data.width, height: size?.height ?? data.height, scale: data.scale }) }, { type: 'image', data: data.base64, mimeType: 'image/png' }] };
            } },
        { ...tool('export', 'Export one node to a file on disk as PNG, JPG, SVG or PDF. path must be absolute; existing files require overwrite:true. For many nodes or several scales use figma_export_batch.', { node, path: str('Absolute output file path.'), format: choices(['PNG', 'JPG', 'SVG', 'PDF']), scale: num('Raster scale 0.1-4; default 1.', 0.1), maxSize: int('Optional cap on the longest raster side in pixels.', 16, 8192), useAbsoluteBounds: bool('Export the full node bounds instead of cropping to visible content (keeps text from being clipped).'), overwrite: bool('Replace an existing file.') }, ['node', 'path']),
            async run(args) {
                validate(args, this.inputSchema);
                const path = String(args.path);
                if (!isAbsolute(path)) throw new Error('path must be absolute.');
                if (Number(args.scale || 1) > 4) throw new Error('scale must be at most 4.');
                if (existsSync(path) && !args.overwrite) throw new Error('Destination exists; pass overwrite:true.');
                const format = String(args.format || 'PNG');
                const data = await command({ instance: args.instance, node: args.node, format, scale: args.scale, maxSize: args.maxSize, useAbsoluteBounds: args.useAbsoluteBounds }, 'export', MAX_WAIT_MS) as { base64: string; width?: number; height?: number; scale?: number };
                const buffer = Buffer.from(data.base64, 'base64');
                await writeNew(path, buffer, !!args.overwrite);
                const size = pngSize(buffer);
                return { path, bytes: buffer.length, format, ...(format === 'PNG' || format === 'JPG' ? { width: size?.width ?? data.width, height: size?.height ?? data.height, scale: data.scale } : {}) };
            } },
        { ...tool('export_batch', 'Export several nodes, optionally at several scales, into a folder (e.g. Roblox UI icons). Pass nodes (ids) or childrenOf (a frame/page id; exports its visible direct children). Files are named by pattern with {name}, {id}, {scale} and {ext}. The longest side is capped at maxSize (default 1024, the Roblox limit). Stops after about 45s and returns nextCursor; call again with the same arguments plus cursor to continue. Returns path, node, width, height and scale per file.', {
            nodes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500, description: 'Node ids to export.' },
            childrenOf: str('Export the visible direct children of this node or page id instead of nodes.'),
            dir: str('Absolute output folder; created if missing.'),
            scales: { type: 'array', items: { type: 'number', minimum: 0.1, maximum: 4 }, minItems: 1, maxItems: 8, description: 'Raster scales; default [1]. Ignored for SVG/PDF.' },
            format: choices(['PNG', 'JPG', 'SVG', 'PDF'], 'Default PNG.'),
            pattern: str('File name pattern; default "{name}@{scale}x.{ext}" with several scales, else "{name}.{ext}".'),
            maxSize: maxSize(1024),
            useAbsoluteBounds: bool('Export full node bounds instead of cropping to visible content.'),
            overwrite: bool('Replace existing files.'),
            cursor: int('Index to resume from, taken from nextCursor.', 0, 100000),
        }, ['dir']),
            async run(args) {
                validate(args, this.inputSchema);
                const started = Date.now();
                const dir = String(args.dir);
                if (!isAbsolute(dir)) throw new Error('dir must be absolute.');
                if (!args.nodes === !args.childrenOf) throw new Error('Pass exactly one of nodes or childrenOf.');
                const format = String(args.format || 'PNG');
                const ext = format.toLowerCase() === 'jpg' ? 'jpg' : format.toLowerCase();
                const raster = format === 'PNG' || format === 'JPG';
                const scales = raster ? (args.scales as number[] | undefined) ?? [1] : [1];
                const pattern = String(args.pattern || (scales.length > 1 ? '{name}@{scale}x.{ext}' : '{name}.{ext}'));
                if (!pattern.includes('{name}') && !pattern.includes('{id}')) throw new Error('pattern must contain {name} or {id} so files do not overwrite each other.');
                if (scales.length > 1 && !pattern.includes('{scale}')) throw new Error('pattern must contain {scale} when exporting several scales.');
                const targets = await command({ instance: args.instance, nodes: args.nodes, childrenOf: args.childrenOf }, 'export_list', 30_000) as Array<{ id: string; name: string }>;
                // Duplicate layer names get the node id appended so every target maps to its own file.
                const counts = new Map<string, number>();
                for (const target of targets) counts.set(fileSafe(target.name), (counts.get(fileSafe(target.name)) ?? 0) + 1);
                const jobs = targets.flatMap(target => scales.map(scale => ({ target, scale })));
                const files: unknown[] = [], errors: unknown[] = [];
                let index = Number(args.cursor ?? 0);
                for (; index < jobs.length; index++) {
                    const left = 45_000 - (Date.now() - started);
                    if (left < 3_000) break;
                    const { target, scale } = jobs[index];
                    const safeName = fileSafe(target.name);
                    const name = (counts.get(safeName) ?? 0) > 1 ? `${safeName}_${fileSafe(target.id.replace(/:/g, '-'))}` : safeName;
                    const fileName = pattern.replace(/\{name\}/g, name).replace(/\{id\}/g, fileSafe(target.id.replace(/:/g, '-'))).replace(/\{scale\}/g, String(scale)).replace(/\{ext\}/g, ext);
                    const path = join(dir, fileSafe(fileName.slice(0, -extname(fileName).length || undefined)) + (extname(fileName) || `.${ext}`));
                    try {
                        const data = await command({ instance: args.instance, node: target.id, format, scale, maxSize: raster ? args.maxSize ?? 1024 : undefined, useAbsoluteBounds: args.useAbsoluteBounds }, 'export', Math.min(left, 30_000)) as { base64: string; width?: number; height?: number; scale?: number };
                        const buffer = Buffer.from(data.base64, 'base64');
                        await writeNew(path, buffer, !!args.overwrite);
                        const size = pngSize(buffer);
                        files.push({ path, node: target.id, name: target.name, ...(raster ? { width: size?.width ?? data.width, height: size?.height ?? data.height, scale: data.scale } : {}) });
                    } catch (error) {
                        errors.push({ node: target.id, name: target.name, scale, error: error instanceof Error ? error.message : String(error) });
                    }
                }
                const result = { total: jobs.length, exported: files.length, files, ...(errors.length ? { errors } : {}), nextCursor: index < jobs.length ? index : null };
                return bounded(result);
            } },
        tool('output_log', 'Read print output and errors recorded by figma_execute and other plugin commands. contains filters case-insensitively; default limit 50.', { contains: str('Text substring.'), limit: int('Maximum entries.', 1, 500), clear: bool('Clear the log after reading.') }),
        { ...tool('execute', 'Run JavaScript in the Figma plugin main thread as the body of an async function with figma and print(...values) in scope. Use await for async APIs; the document uses dynamic page loading. Example: const n = await figma.getNodeByIdAsync("12:34"); n.name = "Play"; return n.id. Returns print output and the returned value. Edits are not automatically grouped into one undo step.', { code: str('JavaScript source, maximum 200000 UTF-8 bytes.'), timeoutSeconds: int('Response timeout; default 50, maximum 55.', 1, 55) }, ['code']),
            async run(args) { validate(args, this.inputSchema); if (Buffer.byteLength(args.code as string, 'utf8') > 200_000) throw new Error('code exceeds 200000 bytes.'); return bounded(await command(args, 'execute', Number(args.timeoutSeconds || 50) * 1000)); } },
    ],
};
export default pack;

// Embedded plugin files make this a single-file Unify toolpack.
const PLUGIN_FILES: Record<string, string> = {
 "manifest.json": "{\n  \"name\": \"Unify Bridge\",\n  \"id\": \"unify-figma-bridge\",\n  \"api\": \"1.0.0\",\n  \"main\": \"code.js\",\n  \"ui\": \"ui.html\",\n  \"editorType\": [\"figma\", \"figjam\"],\n  \"documentAccess\": \"dynamic-page\",\n  \"permissions\": [\"currentuser\"],\n  \"networkAccess\": {\n    \"allowedDomains\": [\"none\"],\n    \"devAllowedDomains\": [\"http://localhost:34876\"],\n    \"reasoning\": \"Connects to the local Unify toolpack bridge.\"\n  }\n}\n",
 "code.js": "figma.showUI(__html__, { width: 300, height: 230, themeColors: true });\n\nconst logEntries = [];\n\nfunction log(level, message) {\n  logEntries.push({ timestamp: Date.now(), level: level, message: String(message) });\n  if (logEntries.length > 1000) logEntries.shift();\n}\n\nfunction currentUserName() {\n  // figma.currentUser needs the \"currentuser\" manifest permission; never let it stop the bridge from starting.\n  try {\n    return figma.currentUser ? figma.currentUser.name : '';\n  } catch (e) {\n    return '';\n  }\n}\n\nfunction meta() {\n  return {\n    type: 'meta',\n    file: figma.root.name,\n    page: figma.currentPage.name,\n    editor: figma.editorType,\n    user: currentUserName()\n  };\n}\n\nfigma.ui.postMessage(meta());\nfigma.on('currentpagechange', function () {\n  figma.ui.postMessage(meta());\n});\n\nfunction safe(value, depth) {\n  if (value === figma.mixed || typeof value === 'symbol') return 'MIXED';\n  if (value instanceof Uint8Array) return '[bytes]';\n  if (typeof value === 'function') return undefined;\n  if (typeof value === 'number') return isFinite(value) ? value : null;\n  if (value === null || value === undefined) return value;\n  if (typeof value !== 'object') return value;\n  if (depth >= 8) return '[max depth]';\n  if (typeof value.id === 'string' && typeof value.type === 'string' && 'parent' in value) {\n    return { id: value.id, name: value.name, type: value.type };\n  }\n  if (Array.isArray(value)) {\n    return value.map(function (v) { return safe(v, depth + 1); });\n  }\n  const out = {};\n  for (const key of Object.keys(value)) {\n    const converted = safe(value[key], depth + 1);\n    if (converted !== undefined) out[key] = converted;\n  }\n  return out;\n}\n\nfunction summary(node) {\n  const s = { id: node.id, name: node.name, type: node.type };\n  if ('visible' in node) s.visible = node.visible;\n  if ('x' in node) s.x = Math.round(node.x * 100) / 100;\n  if ('y' in node) s.y = Math.round(node.y * 100) / 100;\n  if ('width' in node) s.width = Math.round(node.width * 100) / 100;\n  if ('height' in node) s.height = Math.round(node.height * 100) / 100;\n  s.childCount = 'children' in node ? node.children.length : 0;\n  return s;\n}\n\nconst DETAIL_KEYS = [\n  'rotation', 'opacity', 'blendMode', 'locked', 'isMask', 'fills', 'strokes', 'strokeWeight',\n  'strokeAlign', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius',\n  'bottomRightRadius', 'effects', 'constraints', 'layoutMode', 'layoutWrap', 'primaryAxisSizingMode',\n  'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing',\n  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'layoutAlign', 'layoutGrow',\n  'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'clipsContent',\n  'characters', 'fontSize', 'fontName', 'fontWeight', 'textAlignHorizontal', 'textAlignVertical',\n  'textAutoResize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration',\n  'componentProperties', 'variantProperties', 'description'\n];\n\nasync function details(node) {\n  const d = summary(node);\n  for (const key of DETAIL_KEYS) {\n    if (!(key in node)) continue;\n    try {\n      d[key] = safe(node[key], 0);\n    } catch (e) {\n      // skip properties that throw\n    }\n  }\n  d.parent = node.parent ? { id: node.parent.id, name: node.parent.name, type: node.parent.type } : null;\n  if (node.type === 'INSTANCE') {\n    const main = await node.getMainComponentAsync();\n    d.mainComponent = main ? { id: main.id, name: main.name } : null;\n  }\n  if ('absoluteBoundingBox' in node) d.absoluteBoundingBox = safe(node.absoluteBoundingBox, 0);\n  return d;\n}\n\nasync function getNode(id) {\n  const node = await figma.getNodeByIdAsync(id);\n  if (!node) throw new Error('Node not found: ' + id);\n  return node;\n}\n\nfunction pageOf(node) {\n  let current = node;\n  while (current && current.type !== 'PAGE') current = current.parent;\n  return current;\n}\n\n// Resolves an explicit page (id or exact name) without switching the user's current page.\nasync function pageArg(value) {\n  if (!value) return figma.currentPage;\n  const matches = figma.root.children.filter(function (p) { return p.id === value || p.name === value; });\n  if (matches.length === 0) throw new Error('Page not found: ' + value + '. Use figma_pages to list pages.');\n  if (matches.length > 1) throw new Error('Page name is ambiguous; use a page id from figma_pages.');\n  await matches[0].loadAsync();\n  return matches[0];\n}\n\nfunction pageRef(page) {\n  return page ? { id: page.id, name: page.name } : null;\n}\n\nfunction hex(color) {\n  function part(v) { return ('0' + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2); }\n  return '#' + part(color.r) + part(color.g) + part(color.b);\n}\n\nfunction firstSolid(paints) {\n  if (!Array.isArray(paints)) return undefined;\n  for (const paint of paints) {\n    if (paint.type === 'SOLID' && paint.visible !== false) {\n      const opacity = paint.opacity === undefined ? 1 : paint.opacity;\n      return opacity < 1 ? hex(paint.color) + ' ' + Math.round(opacity * 100) + '%' : hex(paint.color);\n    }\n  }\n  return paints.length ? paints[0].type : undefined;\n}\n\n// Compact visual attributes for building UI from the tree without one figma_properties call per node.\nfunction style(node, s) {\n  try {\n    if ('fills' in node && node.fills !== figma.mixed) { const fill = firstSolid(node.fills); if (fill) s.fill = fill; }\n    if ('strokes' in node) { const stroke = firstSolid(node.strokes); if (stroke) { s.stroke = stroke; s.strokeWeight = node.strokeWeight === figma.mixed ? 'MIXED' : node.strokeWeight; } }\n    if ('opacity' in node && node.opacity < 1) s.opacity = Math.round(node.opacity * 100) / 100;\n    if ('cornerRadius' in node && node.cornerRadius) s.cornerRadius = node.cornerRadius === figma.mixed ? 'MIXED' : node.cornerRadius;\n    if ('layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE') { s.layoutMode = node.layoutMode; s.itemSpacing = node.itemSpacing; }\n    if (node.type === 'TEXT') {\n      s.text = node.characters.length > 80 ? node.characters.slice(0, 80) + '...' : node.characters;\n      s.fontSize = node.fontSize === figma.mixed ? 'MIXED' : node.fontSize;\n      s.font = node.fontName === figma.mixed ? 'MIXED' : node.fontName.family + ' ' + node.fontName.style;\n    }\n  } catch (e) {\n    // style is best effort\n  }\n  return s;\n}\n\nfunction exportBounds(node, useAbsoluteBounds) {\n  if (!useAbsoluteBounds && 'absoluteRenderBounds' in node && node.absoluteRenderBounds) return node.absoluteRenderBounds;\n  if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) return node.absoluteBoundingBox;\n  if ('width' in node) return { width: node.width, height: node.height };\n  return null;\n}\n\n// Raster export settings; maxSize caps the longest output side in pixels by switching to a WIDTH/HEIGHT constraint.\nfunction rasterSettings(node, format, scale, maxSize, useAbsoluteBounds) {\n  const settings = { format: format, constraint: { type: 'SCALE', value: scale } };\n  if (useAbsoluteBounds) settings.useAbsoluteBounds = true;\n  const bounds = exportBounds(node, useAbsoluteBounds);\n  let effective = scale;\n  if (bounds && maxSize && bounds.width > 0 && bounds.height > 0) {\n    const wide = bounds.width >= bounds.height;\n    const longest = (wide ? bounds.width : bounds.height) * scale;\n    if (longest > maxSize) {\n      settings.constraint = { type: wide ? 'WIDTH' : 'HEIGHT', value: Math.floor(maxSize) };\n      effective = maxSize / (wide ? bounds.width : bounds.height);\n    }\n  }\n  return {\n    settings: settings,\n    scale: Math.round(effective * 1000) / 1000,\n    width: bounds ? Math.round(bounds.width * effective) : null,\n    height: bounds ? Math.round(bounds.height * effective) : null\n  };\n}\n\nconst MAX_RESULT_BYTES = 30 * 1024 * 1024;\n\nfunction encodeChecked(bytes, hint) {\n  if (bytes.length > MAX_RESULT_BYTES) throw new Error('Export is ' + Math.round(bytes.length / 1048576) + ' MB, over the 30 MB bridge limit; ' + hint);\n  return figma.base64Encode(bytes);\n}\n\nconst TEXT_KEYS = [\n  'characters', 'fontSize', 'fontName', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize',\n  'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'paragraphSpacing'\n];\n\nasync function assign(n, key, value) {\n  if (n.type === 'TEXT' && TEXT_KEYS.indexOf(key) !== -1) {\n    if (n.fontName === figma.mixed) {\n      if (n.characters.length > 0) {\n        const fonts = n.getRangeAllFontNames(0, n.characters.length);\n        for (const font of fonts) await figma.loadFontAsync(font);\n      }\n    } else {\n      await figma.loadFontAsync(n.fontName);\n    }\n    if (key === 'fontName') await figma.loadFontAsync(value);\n  }\n  if (key === 'width' || key === 'height') {\n    if (!('resize' in n)) throw new Error('Property not supported on ' + n.type);\n    n.resize(key === 'width' ? value : n.width, key === 'height' ? value : n.height);\n    return;\n  }\n  if (!(key in n)) throw new Error('Property not supported on ' + n.type);\n  n[key] = value;\n}\n\nconst ops = {\n  async pages(args) {\n    const action = args.action || 'list';\n    if (action === 'list') {\n      return {\n        current: figma.currentPage.id,\n        pages: figma.root.children.map(function (p) { return { id: p.id, name: p.name }; })\n      };\n    }\n    if (action === 'switch') {\n      const matches = figma.root.children.filter(function (p) {\n        return p.id === args.page || p.name === args.page;\n      });\n      if (matches.length === 0) throw new Error('Page not found');\n      if (matches.length > 1) throw new Error('Page name is ambiguous; use an id');\n      const p = matches[0];\n      await figma.setCurrentPageAsync(p);\n      return { current: p.id, name: p.name };\n    }\n    throw new Error('Unknown pages action: ' + action);\n  },\n\n  async tree(args) {\n    const rootNode = args.root ? await getNode(args.root) : await pageArg(args.page);\n    if (rootNode.type === 'PAGE') await rootNode.loadAsync();\n    const maxDepth = args.depth === undefined ? 3 : args.depth;\n    let remaining = args.maxItems === undefined ? 200 : args.maxItems;\n\n    function walk(node, d) {\n      if (remaining <= 0) return null;\n      remaining--;\n      const s = args.includeStyle ? style(node, summary(node)) : summary(node);\n      if ('children' in node && d > 0) {\n        s.children = [];\n        for (const child of node.children) {\n          if (remaining <= 0) break;\n          const c = walk(child, d - 1);\n          if (c) s.children.push(c);\n        }\n      }\n      return s;\n    }\n\n    const result = walk(rootNode, maxDepth);\n    return { page: pageRef(rootNode.type === 'PAGE' ? rootNode : pageOf(rootNode)), root: result, truncated: remaining <= 0 };\n  },\n\n  async find(args) {\n    const limit = args.limit === undefined ? 50 : args.limit;\n    const nameLower = args.name ? String(args.name).toLowerCase() : '';\n    const type = args.type ? String(args.type).toUpperCase() : '';\n    const predicate = function (node) {\n      return (!nameLower || node.name.toLowerCase().includes(nameLower)) &&\n        (!type || node.type === type);\n    };\n    const results = [];\n    let truncated = false;\n\n    const pages = [];\n    if (args.scope === 'document') {\n      await figma.loadAllPagesAsync();\n      for (const p of figma.root.children) pages.push(p);\n    } else {\n      pages.push(await pageArg(args.page));\n    }\n\n    for (const page of pages) {\n      const found = page.findAll(predicate);\n      for (const node of found) {\n        if (results.length >= limit) {\n          truncated = true;\n          break;\n        }\n        const entry = summary(node);\n        entry.page = page.name;\n        entry.pageId = page.id;\n        results.push(entry);\n      }\n      if (truncated) break;\n    }\n\n    return { results: results, truncated: truncated };\n  },\n\n  async selection(args) {\n    const action = args.action || 'get';\n    if (action === 'get') {\n      return {\n        page: pageRef(figma.currentPage),\n        nodes: figma.currentPage.selection.map(summary)\n      };\n    }\n    if (action === 'set') {\n      const ids = args.nodes || [];\n      const list = [];\n      for (const id of ids) list.push(await getNode(id));\n      for (const node of list) {\n        if (node.type === 'PAGE' || node.type === 'DOCUMENT') throw new Error('Cannot select a page or document');\n      }\n      if (list.length > 0) {\n        const page = pageOf(list[0]);\n        if (page !== figma.currentPage) await figma.setCurrentPageAsync(page);\n        for (const node of list) {\n          if (pageOf(node) !== figma.currentPage) throw new Error('Nodes span multiple pages');\n        }\n      }\n      figma.currentPage.selection = list;\n      if (args.zoom !== false && list.length) figma.viewport.scrollAndZoomIntoView(list);\n      return {\n        page: pageRef(figma.currentPage),\n        nodes: figma.currentPage.selection.map(summary)\n      };\n    }\n    throw new Error('Unknown selection action: ' + action);\n  },\n\n  async properties(args) {\n    const n = await getNode(args.node);\n    const errors = {};\n    if (args.set) {\n      for (const key of Object.keys(args.set)) {\n        try {\n          await assign(n, key, args.set[key]);\n        } catch (e) {\n          errors[key] = e && e.message ? e.message : String(e);\n        }\n      }\n    }\n    return { node: await details(n), errors: errors };\n  },\n\n  async capture_view(args) {\n    let target;\n    if (args.node) {\n      target = await getNode(args.node);\n    } else if (args.page) {\n      target = await pageArg(args.page);\n    } else {\n      target = figma.currentPage.selection[0] || figma.currentPage;\n    }\n    if (target.type === 'PAGE' && target.children.length === 0) throw new Error('Nothing to capture on this page.');\n    const raster = rasterSettings(target, 'PNG', args.scale || 1, args.maxSize === undefined ? 1568 : args.maxSize, false);\n    const bytes = await target.exportAsync(raster.settings);\n    return {\n      base64: encodeChecked(bytes, 'lower maxSize or scale, or capture a smaller node.'),\n      id: target.id,\n      name: target.name,\n      page: pageRef(target.type === 'PAGE' ? target : pageOf(target)),\n      width: raster.width,\n      height: raster.height,\n      scale: raster.scale\n    };\n  },\n\n  async export(args) {\n    const n = await getNode(args.node);\n    const fmt = args.format || 'PNG';\n    if (fmt === 'SVG' || fmt === 'PDF') {\n      return { base64: encodeChecked(await n.exportAsync({ format: fmt }), 'export a smaller node.'), id: n.id, name: n.name };\n    }\n    const raster = rasterSettings(n, fmt, args.scale || 1, args.maxSize, !!args.useAbsoluteBounds);\n    return {\n      base64: encodeChecked(await n.exportAsync(raster.settings), 'lower scale or set maxSize.'),\n      id: n.id,\n      name: n.name,\n      width: raster.width,\n      height: raster.height,\n      scale: raster.scale\n    };\n  },\n\n  // Lists export targets for figma_export_batch: explicit node ids, or the direct children of one node.\n  async export_list(args) {\n    let list = [];\n    if (args.childrenOf) {\n      const parent = await getNode(args.childrenOf);\n      if (parent.type === 'PAGE') await parent.loadAsync();\n      if (!('children' in parent)) throw new Error('Node ' + parent.id + ' has no children.');\n      list = parent.children.filter(function (child) { return child.visible !== false; });\n    } else {\n      for (const id of args.nodes || []) list.push(await getNode(id));\n    }\n    return list.map(function (n) {\n      if (n.type === 'PAGE' || n.type === 'DOCUMENT') throw new Error('Cannot export a page or document; pass frames or other layers.');\n      return { id: n.id, name: n.name };\n    });\n  },\n\n  async output_log(args) {\n    const contains = args.contains ? String(args.contains).toLowerCase() : '';\n    const limit = args.limit || 50;\n    const filtered = logEntries.filter(function (e) {\n      return !contains || e.message.toLowerCase().includes(contains);\n    });\n    const entries = filtered.slice(-limit);\n    if (args.clear) logEntries.length = 0;\n    return entries;\n  },\n\n  async execute(args) {\n    const output = [];\n    const print = function () {\n      const values = Array.prototype.slice.call(arguments);\n      const line = values.map(function (v) {\n        return typeof v === 'string' ? v : JSON.stringify(safe(v, 0));\n      }).join(' ');\n      output.push(line);\n      log('print', line);\n    };\n    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;\n    try {\n      const fn = new AsyncFunction('figma', 'print', args.code);\n      const result = await fn(figma, print);\n      return { output: output, result: safe(result, 0) };\n    } catch (err) {\n      const message = err && err.message ? err.message : String(err);\n      log('error', message);\n      const full = output.length ? message + '\\nOutput:\\n' + output.join('\\n') : message;\n      throw new Error(full);\n    }\n  }\n};\n\nlet queue = [];\nlet draining = false;\n\n// Stop waiting once the command's deadline passes so one hung execute cannot block every later command.\nfunction withDeadline(promise, command) {\n  const left = typeof command.expiresAt === 'number' ? command.expiresAt - Date.now() : 50000;\n  return new Promise(function (resolve, reject) {\n    const timer = setTimeout(function () {\n      reject(new Error(command.op + ' was still running at its deadline; the bridge moved on. Async work it started may still change the file. Inspect Figma before retrying.'));\n    }, Math.max(0, left));\n    promise.then(function (value) { clearTimeout(timer); resolve(value); }, function (error) { clearTimeout(timer); reject(error); });\n  });\n}\n\nasync function drain() {\n  if (draining) return;\n  draining = true;\n  while (queue.length > 0) {\n    const command = queue.shift();\n    let response;\n    try {\n      if (!ops[command.op]) throw new Error('Unknown op ' + command.op + '. Run figma_install_plugin and restart the plugin.');\n      const data = await withDeadline(Promise.resolve().then(function () { return ops[command.op](command.args || {}); }), command);\n      response = { type: 'result', id: command.id, ok: true, data: data };\n    } catch (err) {\n      const message = String(err && err.message || err);\n      log('error', command.op + ': ' + message);\n      response = { type: 'result', id: command.id, ok: false, error: message };\n    }\n    figma.ui.postMessage(response);\n  }\n  draining = false;\n}\n\nfigma.ui.onmessage = async function (msg) {\n  if (!msg) return;\n  if (msg.type === 'load-code') {\n    const value = await figma.clientStorage.getAsync('unify-code');\n    figma.ui.postMessage({ type: 'code', code: value || '' });\n    figma.ui.postMessage(meta());\n  } else if (msg.type === 'save-code') {\n    await figma.clientStorage.setAsync('unify-code', msg.code);\n  } else if (msg.type === 'command') {\n    queue.push(msg.command);\n    drain();\n  }\n};\n",
 "ui.html": "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<style>\n  body {\n    margin: 0;\n    padding: 16px;\n    box-sizing: border-box;\n    font: 12px Inter, system-ui, sans-serif;\n    background: #13100E;\n    color: #EFEAE4;\n  }\n  h1 { display: flex; align-items: center; gap: 8px; font-size: 14px; margin: 0 0 12px; font-weight: 700; }\n  label { display: block; margin-bottom: 4px; color: #A89E94; }\n  input {\n    width: 100%;\n    box-sizing: border-box;\n    padding: 6px 8px;\n    margin-bottom: 8px;\n    font: inherit;\n    text-transform: uppercase;\n    letter-spacing: 2px;\n    background: #1B1714;\n    color: #EFEAE4;\n    border: 1px solid #2E2722;\n    border-radius: 6px;\n  }\n  button {\n    width: 100%;\n    padding: 7px;\n    font: inherit;\n    cursor: pointer;\n    border: none;\n    border-radius: 6px;\n    background: #EFE6DA;\n    color: #0D0B09;\n  }\n  .status { margin-top: 10px; min-height: 16px; word-break: break-word; }\n  .last { margin-top: 6px; min-height: 16px; color: #A89E94; word-break: break-word; }\n  .note { margin-top: 12px; font-size: 11px; color: #6C625A; }\n</style>\n</head>\n<body>\n<h1><svg width=\"18\" height=\"18\" viewBox=\"0 0 32 32\" fill=\"none\"><path d=\"M4 2H12.4V19.2H15.5V27.6H4V2Z\" fill=\"#C9A465\"/><path d=\"M16.5 21.6H19.6V4.4H28V30H16.5V21.6Z\" fill=\"#8B6A35\"/></svg><span>Unify Bridge</span></h1>\n<label for=\"code\">Pairing code</label>\n<input id=\"code\" maxlength=\"8\" autocomplete=\"off\" spellcheck=\"false\">\n<button id=\"toggle\">Connect</button>\n<div class=\"status\" id=\"status\"></div>\n<div class=\"last\" id=\"last\"></div>\n<div class=\"note\">Keep this window open while Unify works in Figma.</div>\n<script>\n  const BASE = 'http://localhost:34876';\n  const EXPIRED_ERROR = 'Command expired before execution; it was not executed.';\n\n  const codeInput = document.getElementById('code');\n  const toggleButton = document.getElementById('toggle');\n  const statusEl = document.getElementById('status');\n  const lastEl = document.getElementById('last');\n\n  const sessionId = makeSession();\n  let pairingCode = '';\n  let metadata = { file: '', page: '', editor: '', user: '' };\n  let connected = false;\n  let generation = 0;\n  let pingTimer = null;\n  let pollController = null;\n  let queue = [];\n  let draining = false;\n  let pendingResult = null;\n\n  function makeSession() {\n    const bytes = new Uint8Array(12);\n    crypto.getRandomValues(bytes);\n    let out = '';\n    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');\n    return out;\n  }\n\n  function sleep(ms) {\n    return new Promise(function (resolve) { setTimeout(resolve, ms); });\n  }\n\n  function setStatus(text) { statusEl.textContent = text; }\n  function setLast(text) { lastEl.textContent = text; }\n\n  function connectedText() { return 'Connected. Instance: ' + sessionId; }\n\n  function parseJson(text) {\n    try { return JSON.parse(text); } catch (e) { return null; }\n  }\n\n  function buildUrl(path, withMeta) {\n    let url = BASE + path + '?session=' + encodeURIComponent(sessionId);\n    if (withMeta) {\n      url += '&file=' + encodeURIComponent(metadata.file);\n      url += '&page=' + encodeURIComponent(metadata.page);\n      url += '&editor=' + encodeURIComponent(metadata.editor);\n      url += '&user=' + encodeURIComponent(metadata.user);\n      url += '&bridge=2';\n    }\n    return url;\n  }\n\n  async function call(method, path, opts) {\n    const controller = opts.controller || new AbortController();\n    const timer = setTimeout(function () { controller.abort(); }, opts.timeout);\n    try {\n      const init = {\n        method: method,\n        headers: { 'x-unify-code': pairingCode },\n        signal: controller.signal\n      };\n      if (opts.body !== undefined) {\n        init.headers['Content-Type'] = 'application/json';\n        init.body = JSON.stringify(opts.body);\n      }\n      const res = await fetch(buildUrl(path, opts.meta), init);\n      const text = await res.text();\n      return { status: res.status, text: text };\n    } finally {\n      clearTimeout(timer);\n    }\n  }\n\n  async function ping() {\n    try {\n      const res = await call('GET', '/ping', { meta: true, timeout: 10000 });\n      return res.status;\n    } catch (e) {\n      return 0;\n    }\n  }\n\n  function stopConnection() {\n    connected = false;\n    generation++;\n    if (pingTimer !== null) {\n      clearInterval(pingTimer);\n      pingTimer = null;\n    }\n    if (pollController !== null) {\n      pollController.abort();\n      pollController = null;\n    }\n    toggleButton.textContent = 'Connect';\n  }\n\n  function rejectCode() {\n    stopConnection();\n    setStatus('Wrong pairing code. Check the Unify figma toolpack status.');\n  }\n\n  async function connect() {\n    pairingCode = codeInput.value.trim().toUpperCase();\n    parent.postMessage({ pluginMessage: { type: 'save-code', code: pairingCode } }, '*');\n\n    generation++;\n    const gen = generation;\n    connected = true;\n    toggleButton.textContent = 'Disconnect';\n    setStatus('Connecting...');\n\n    while (gen === generation) {\n      const status = await ping();\n      if (gen !== generation) return;\n      if (status === 401) {\n        rejectCode();\n        return;\n      }\n      if (status === 200) break;\n      setStatus('Waiting for Unify (figma toolpack not running). Retrying...');\n      await sleep(2000);\n    }\n    if (gen !== generation) return;\n\n    setStatus(connectedText());\n    pingTimer = setInterval(function () { keepAlive(gen); }, 5000);\n    pollLoop(gen);\n  }\n\n  async function keepAlive(gen) {\n    const status = await ping();\n    if (gen !== generation) return;\n    if (status === 401) rejectCode();\n  }\n\n  async function pollLoop(gen) {\n    while (gen === generation) {\n      const controller = new AbortController();\n      pollController = controller;\n      let res;\n      try {\n        res = await call('GET', '/poll', { meta: true, timeout: 20000, controller: controller });\n      } catch (e) {\n        if (gen !== generation) return;\n        setStatus('Connection lost, retrying...');\n        await sleep(1500);\n        continue;\n      }\n      if (gen !== generation) return;\n\n      if (res.status === 200) {\n        setStatus(connectedText());\n        const command = parseJson(res.text);\n        if (command) {\n          queue.push(command);\n          drain();\n        }\n      } else if (res.status === 204) {\n        setStatus(connectedText());\n      } else if (res.status === 401) {\n        rejectCode();\n        return;\n      } else {\n        setStatus('Connection lost, retrying...');\n        await sleep(1500);\n      }\n    }\n  }\n\n  async function drain() {\n    if (draining) return;\n    draining = true;\n    while (queue.length > 0) {\n      const command = queue.shift();\n      if (Date.now() >= command.expiresAt) {\n        setLast(command.op + ': ' + EXPIRED_ERROR);\n        await postResult({ id: command.id, ok: false, error: EXPIRED_ERROR });\n        continue;\n      }\n      setLast('Running ' + command.op + '...');\n      const result = await runOnMain(command);\n      await postResult(result);\n      if (result.ok) setLast(command.op + ': complete');\n      else setLast(command.op + ': ' + result.error);\n    }\n    draining = false;\n  }\n\n  function runOnMain(command) {\n    return new Promise(function (resolve) {\n      // The main thread enforces the deadline itself; this is a fallback so the UI queue never waits forever.\n      const timer = setTimeout(function () {\n        if (!pendingResult || pendingResult.id !== command.id) return;\n        pendingResult = null;\n        resolve({ id: command.id, ok: false, error: command.op + ' did not finish before its deadline. Inspect Figma before retrying.' });\n      }, Math.max(0, command.expiresAt - Date.now()) + 5000);\n      pendingResult = { id: command.id, resolve: function (result) { clearTimeout(timer); resolve(result); } };\n      parent.postMessage({ pluginMessage: { type: 'command', command: command } }, '*');\n    });\n  }\n\n  async function postResult(result) {\n    let body = { id: result.id, ok: result.ok };\n    if (result.data !== undefined) body.data = result.data;\n    if (result.error !== undefined) body.error = result.error;\n    for (let attempt = 0; attempt <= 4; attempt++) {\n      if (attempt > 0) await sleep(500);\n      try {\n        const res = await call('POST', '/result', { body: body, timeout: 10000 });\n        if (res.status === 413 && body.ok) {\n          // Too large for the bridge: report a real error instead of leaving Unify waiting for a timeout.\n          body = { id: result.id, ok: false, error: 'Result was too large for the bridge. Lower scale/maxSize or pick a smaller node.' };\n          continue;\n        }\n        if (res.status < 500) return;\n      } catch (e) {\n        // retry on network error\n      }\n    }\n  }\n\n  async function disconnect() {\n    stopConnection();\n    setStatus('Disconnected.');\n    try {\n      await call('POST', '/disconnect', { body: {}, timeout: 10000 });\n    } catch (e) {\n      // bridge may already be gone\n    }\n  }\n\n  toggleButton.addEventListener('click', function () {\n    if (connected) disconnect();\n    else connect();\n  });\n\n  codeInput.addEventListener('input', function () {\n    codeInput.value = codeInput.value.toUpperCase();\n  });\n\n  window.onmessage = function (event) {\n    const msg = event.data && event.data.pluginMessage;\n    if (!msg) return;\n    if (msg.type === 'meta') {\n      metadata = {\n        file: msg.file || '',\n        page: msg.page || '',\n        editor: msg.editor || '',\n        user: msg.user || ''\n      };\n    } else if (msg.type === 'code') {\n      const code = String(msg.code || '').toUpperCase();\n      codeInput.value = code;\n      if (code.length === 8 && !connected) connect();\n    } else if (msg.type === 'result') {\n      if (pendingResult && pendingResult.id === msg.id) {\n        const waiting = pendingResult;\n        pendingResult = null;\n        waiting.resolve({ id: msg.id, ok: msg.ok, data: msg.data, error: msg.error });\n      }\n    }\n  };\n\n  parent.postMessage({ pluginMessage: { type: 'load-code' } }, '*');\n</script>\n</body>\n</html>\n"
};
