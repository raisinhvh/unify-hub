import { execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

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

interface Command { id: number; op: string; args: Record<string, unknown>; deadline: number }
interface Waiter { res: ServerResponse; timer: ReturnType<typeof setTimeout>; closed: boolean }
interface Session {
    id: string; pid: string; blender: string; file: string; dirty: boolean; scene: string; addon: number;
    lastSeen: number; queue: Command[]; waiters: Waiter[]; inflight: Set<number>;
    /** Set when Blender dropped an open long-poll, which only happens when it exits or the add-on stops. */
    gone: boolean;
    /** The command Blender's main thread is executing now, reported by /started. */
    running?: { id: number; op: string; startedAt: number };
    /** Results of commands that finished after their caller timed out (newest last). */
    late: string[];
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; session: string; op: string; queuedAt: number; startedAt?: number }
interface Job { id: string; label: string; startedAt: number; finishedAt?: number; result?: unknown; error?: string; done: Promise<void> }
interface State {
    server?: Server;
    ctx?: ToolpackContext;
    token: string;
    port: number;
    discoveryFile: string;
    lastStatus: string;
    statusTimer?: ReturnType<typeof setInterval>;
    nextId: number;
    sessions: Map<string, Session>;
    pending: Map<number, Pending>;
    /** Commands that started but outlived their caller; their results go to Session.late. */
    late: Map<number, { session: string; op: string; startedAt: number }>;
    /** Headless Blender processes, killed on teardown. */
    children: Set<ChildProcess>;
    jobs: Map<string, Job>;
}

/** Bump together with ADDON_VERSION inside ADDON_SOURCE whenever the add-on protocol changes. */
const ADDON_VERSION = 4;
const DISCOVERY_DIR = join(homedir(), '.unify', 'blender-bridge');
/** Healthy sessions always hold a long-poll open, so a short grace period is enough to bridge re-polls. */
const ONLINE_MS = 6_000;
const FORGET_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 50_000;
/** Blender refuses commands it could only start this close to their deadline, so "never started" reports stay true. */
const START_GRACE_MS = 2_000;
/** How long a tool call waits for a background job before handing back its id (Unify stops waiting at 60s). */
const JOB_WAIT_MS = 45_000;
const HEADLESS_TIMEOUT_MS = 10 * 60_000;

const state: State = { token: '', port: 0, discoveryFile: '', lastStatus: '', nextId: 1, sessions: new Map(), pending: new Map(), late: new Map(), children: new Set(), jobs: new Map() };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(res: ServerResponse, status: number, value: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
}

function endWaiter(waiter: Waiter): void {
    waiter.closed = true;
    clearTimeout(waiter.timer);
    if (!waiter.res.destroyed && !waiter.res.writableEnded) { waiter.res.writeHead(204); waiter.res.end(); }
}

function online(session: Session): boolean {
    return !session.gone && (session.waiters.length > 0 || session.inflight.size > 0 || Date.now() - session.lastSeen < ONLINE_MS);
}

function onlineSessions(): Session[] { return [...state.sessions.values()].filter(online); }

function label(session: Session): string {
    const file = session.file ? basename(session.file.replace(/\\/g, '/')) : 'untitled';
    return `${file}${session.dirty ? '*' : ''} (Blender ${session.blender}, scene "${session.scene}", pid ${session.pid}, instance ${session.id})`;
}

/** Fails queued and running work for sessions that went away and forgets long-gone ones. */
function prune(): void {
    for (const [id, session] of state.sessions) {
        if (online(session)) continue;
        session.queue.length = 0;
        session.inflight.clear();
        session.running = undefined;
        for (const [commandId, pending] of state.pending) {
            if (pending.session !== id) continue;
            state.pending.delete(commandId);
            clearTimeout(pending.timer);
            pending.reject(new Error(`Blender session ${label(session)} disconnected (closed or crashed) before answering.`));
        }
        if (Date.now() - session.lastSeen > FORGET_MS) state.sessions.delete(id);
    }
}

function updateStatus(): void {
    const ctx = state.ctx;
    if (!ctx) return;
    prune();
    const sessions = onlineSessions();
    const outdated = sessions.some(session => session.addon < ADDON_VERSION);
    let text = sessions.length === 0
        ? 'Waiting for Blender. Run blender_install_addon once, then open Blender.'
        : sessions.length === 1
            ? `Connected to Blender: ${label(sessions[0])}`
            : `Connected to ${sessions.length} Blender sessions: ${sessions.map(session => session.file ? basename(session.file.replace(/\\/g, '/')) : 'untitled').join(', ')}`;
    if (outdated) text += ' - add-on outdated, run blender_install_addon and restart Blender';
    if (text !== state.lastStatus) {
        state.lastStatus = text;
        ctx.status(text);
    }
}

function touch(url: URL): Session | undefined {
    const id = url.searchParams.get('session') ?? '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined;
    let session = state.sessions.get(id);
    if (!session) {
        session = { id, pid: '', blender: '', file: '', dirty: false, scene: '', addon: 0, lastSeen: Date.now(), queue: [], waiters: [], inflight: new Set(), gone: false, late: [] };
        state.sessions.set(id, session);
        state.ctx?.log(`Blender session ${id} connected.`);
    }
    session.gone = false;
    const param = (name: string): string => url.searchParams.get(name) ?? '';
    session.pid = param('pid');
    session.blender = param('blender');
    session.file = param('file');
    session.dirty = param('dirty') === '1';
    session.scene = param('scene');
    session.addon = Number(param('addon')) || 0;
    session.lastSeen = Date.now();
    updateStatus();
    return session;
}

function deliver(session: Session, waiter: Waiter, command: Command): boolean {
    if (waiter.closed || waiter.res.destroyed || waiter.res.writableEnded) return false;
    waiter.closed = true;
    clearTimeout(waiter.timer);
    session.inflight.add(command.id);
    json(waiter.res, 200, command);
    return true;
}

function dispatch(session: Session): void {
    while (session.queue.length && session.waiters.length) {
        const waiter = session.waiters.shift()!;
        if (deliver(session, waiter, session.queue[0])) session.queue.shift();
    }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers['x-unify-token'] !== state.token) { json(res, 401, { error: 'wrong token' }); return; }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/poll') {
        const session = touch(url);
        if (!session) { json(res, 400, { error: 'missing or invalid session' }); return; }
        const next = session.queue.shift();
        if (next) { session.inflight.add(next.id); json(res, 200, next); return; }
        const waiter: Waiter = {
            res, closed: false,
            timer: setTimeout(() => {
                const index = session.waiters.indexOf(waiter);
                if (index >= 0) session.waiters.splice(index, 1);
                endWaiter(waiter);
            }, 20_000),
        };
        session.waiters.push(waiter);
        res.on('close', () => {
            if (waiter.closed) return;
            waiter.closed = true;
            clearTimeout(waiter.timer);
            const index = session.waiters.indexOf(waiter);
            if (index >= 0) session.waiters.splice(index, 1);
            if (session.waiters.length) return;
            session.gone = true;
            state.ctx?.log(`Blender session ${session.id} disconnected.`);
            updateStatus();
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/meta') {
        // Sent right after a save or file load, so paths do not lag behind until the next long-poll.
        await readBody(req, 64 * 1024).catch(() => '');
        if (!touch(url)) { json(res, 400, { error: 'missing or invalid session' }); return; }
        json(res, 200, {});
        return;
    }

    if (req.method === 'POST' && url.pathname === '/started') {
        let body: unknown;
        try { body = JSON.parse(await readBody(req, 64 * 1024)); }
        catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'invalid body' }); return; }
        if (!isRecord(body) || typeof body.id !== 'number') { json(res, 400, { error: 'started must contain a numeric id' }); return; }
        const pending = state.pending.get(body.id);
        if (pending) {
            pending.startedAt = Date.now();
            const session = state.sessions.get(pending.session);
            if (session) session.running = { id: body.id, op: pending.op, startedAt: pending.startedAt };
        }
        json(res, 200, {});
        return;
    }

    if (req.method === 'POST' && url.pathname === '/result') {
        let result: unknown;
        try { result = JSON.parse(await readBody(req, 64 * 1024 * 1024)); }
        catch (error) { json(res, 400, { error: error instanceof Error ? error.message : 'invalid body' }); return; }
        if (!isRecord(result) || typeof result.id !== 'number' || typeof result.ok !== 'boolean') { json(res, 400, { error: 'result must contain numeric id and boolean ok' }); return; }
        const pending = state.pending.get(result.id);
        const late = state.late.get(result.id);
        const owner = state.sessions.get(pending?.session ?? late?.session ?? '');
        if (owner) {
            owner.inflight.delete(result.id);
            if (owner.running?.id === result.id) owner.running = undefined;
        }
        if (pending) {
            state.pending.delete(result.id);
            clearTimeout(pending.timer);
            if (result.ok) pending.resolve(result.data);
            else pending.reject(new Error(typeof result.error === 'string' ? result.error : 'Blender command failed.'));
        } else if (late) {
            state.late.delete(result.id);
            if (owner) {
                const seconds = Math.round((Date.now() - late.startedAt) / 1000);
                const detail = result.ok ? summarize(result.data) : `failed: ${typeof result.error === 'string' ? result.error.slice(0, 300) : 'unknown error'}`;
                owner.late.push(`${late.op} #${result.id} finished after its caller timed out (${seconds}s total): ${detail}`);
                if (owner.late.length > 5) owner.late.shift();
            }
        }
        json(res, 200, {});
        return;
    }
    json(res, 404, { error: 'not found' });
}

function summarize(data: unknown): string {
    // Ops return {text}; execute returns {output, value, error}.
    const field = (name: string): string => isRecord(data) && typeof data[name] === 'string' ? data[name] as string : '';
    const text = field('text') || (field('error') ? `error: ${field('error').trim().split('\n').pop()}` : field('output') || field('value') || 'ok');
    return text.replace(/\s+/g, ' ').slice(0, 300);
}

/** Why a command has not started: another call's work, or an unresponsive Blender. */
function busyText(session: Session, id: number): string {
    const ahead = [...state.pending.entries()].filter(([other, pending]) => other < id && pending.session === session.id && !pending.startedAt).length;
    const queued = ahead ? `, with ${ahead} other command(s) queued ahead of this one` : '';
    if (session.running && session.running.id !== id) return `busy running ${session.running.op} for another call (${Math.round((Date.now() - session.running.startedAt) / 1000)}s so far${queued})`;
    if (ahead) return `busy with ${ahead} command(s) queued ahead of this one`;
    return 'not responding (window minimized, a modal dialog or file browser open, or the add-on stopped)';
}

function outdated(session: Session): string {
    return `This Blender (${label(session)}) runs Unify Bridge add-on v${session.addon || 'unknown'}, but this toolpack needs v${ADDON_VERSION}. Run blender_install_addon, then restart that Blender.`;
}

function command(session: Session, op: string, args: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (session.addon < ADDON_VERSION) return Promise.reject(new Error(outdated(session)));
    const id = state.nextId++;
    const queuedAt = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const pending = state.pending.get(id);
            state.pending.delete(id);
            const index = session.queue.findIndex(item => item.id === id);
            if (index >= 0) session.queue.splice(index, 1);
            const seconds = Math.round(timeoutMs / 1000);
            if (pending?.startedAt) {
                state.late.set(id, { session: session.id, op, startedAt: pending.startedAt });
                reject(new Error(`Blender started ${op} ${Math.round((Date.now() - pending.startedAt) / 1000)}s ago and is still running (Python cannot be interrupted). It may still finish and change the scene: check blender_instances for its late result before retrying.`));
                return;
            }
            const why = busyText(session, id);
            session.inflight.delete(id);
            reject(new Error(`Blender did not start ${op} within ${seconds}s because it was ${why}. The command was cancelled and will not run. Retry once blender_instances shows the session idle.`));
        }, timeoutMs);
        state.pending.set(id, { resolve, reject, timer, session: session.id, op, queuedAt });
        // The add-on refuses commands past this deadline (minus a grace period), so a cancelled command never runs later.
        session.queue.push({ id, op, args, deadline: queuedAt + timeoutMs - START_GRACE_MS });
        dispatch(session);
    });
}

function startJob(label: string, work: () => Promise<unknown>): Job {
    const id = randomBytes(4).toString('hex');
    const job: Job = { id, label, startedAt: Date.now(), done: Promise.resolve() };
    job.done = work().then(
        result => { job.result = result; },
        (error: unknown) => { job.error = error instanceof Error ? error.message : String(error); },
    ).finally(() => { job.finishedAt = Date.now(); });
    state.jobs.set(id, job);
    for (const [other, old] of state.jobs) if (old.finishedAt && Date.now() - old.finishedAt > 30 * 60_000) state.jobs.delete(other);
    return job;
}

/** Waits for a job up to waitMs; returns its result, throws its error, or describes how to keep waiting. */
async function awaitJob(job: Job, waitMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
    if (!job.finishedAt) return `${job.label} is still running (${Math.round((Date.now() - job.startedAt) / 1000)}s so far) as job ${job.id}. Call blender_job_status with jobId "${job.id}" to wait for the result; do not start it again.`;
    if (job.error !== undefined) throw new Error(job.error);
    return job.result;
}

function resolveSession(args: Record<string, unknown>): Session {
    prune();
    const sessions = onlineSessions();
    if (!sessions.length) throw new Error('No Blender session is connected. Run blender_install_addon once (or enable the "Unify Bridge" add-on in Blender Preferences), then open Blender.');
    const requested = optionalString(args, 'instance');
    if (requested !== undefined) {
        const needle = requested.toLowerCase();
        let matches = sessions.filter(session => session.id === requested || session.pid === requested);
        if (!matches.length) matches = sessions.filter(session => basename(session.file.replace(/\\/g, '/')).toLowerCase() === needle);
        if (!matches.length) matches = sessions.filter(session => session.file.toLowerCase().includes(needle));
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error(`Several Blender sessions match "${requested}": ${matches.map(label).join('; ')}. Pass the exact instance id.`);
        throw new Error(`No connected Blender session matches "${requested}". Connected: ${sessions.map(label).join('; ')}`);
    }
    if (sessions.length === 1) return sessions[0];
    throw new Error(`Several Blender sessions are connected: ${sessions.map(label).join('; ')}. Pass the instance argument.`);
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

function integer(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    const value = args[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
    const value = args[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
    return value;
}

function stringList(args: Record<string, unknown>, name: string): string[] | undefined {
    const value = args[name];
    if (value === undefined || value === null) return undefined;
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) throw new Error(`${name} must be a string or an array of strings.`);
    return list as string[];
}

/** Copies the listed keys that are present, so Blender sees only what the agent passed. */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const sent: Record<string, unknown> = {};
    for (const key of keys) if (args[key] !== undefined && args[key] !== null) sent[key] = args[key];
    return sent;
}

async function textCommand(args: Record<string, unknown>, op: string, sent: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const data = await command(resolveSession(args), op, sent, timeoutMs);
    if (!isRecord(data) || typeof data.text !== 'string') throw new Error('Blender returned an invalid response. Update the add-on with blender_install_addon.');
    return textResult(data);
}

/**
 * The add-on's text, plus its `data` (names, files) when it sent some: Unify batches chain that data
 * ("{{1.files[0]}}") while the agent reads only the text. Older add-ons send text alone.
 */
function textResult(data: Record<string, unknown>): unknown {
    const text = String(data.text);
    return isRecord(data.data) ? { content: [{ type: 'text', text }], data: data.data } : text;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    return chunk;
}

function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

interface Tile { view: string; width: number; height: number; pixels: Buffer }

/** Lays views out two per row; Blender reads pixels bottom-up, so rows are flipped here. */
function composeTiles(tiles: Tile[]): { width: number; height: number; rgba: Buffer; cells: string[] } {
    const gap = 4;
    const cols = tiles.length === 1 ? 1 : 2;
    const rows = Math.ceil(tiles.length / cols);
    const cellW = Math.max(...tiles.map(tile => tile.width));
    const cellH = Math.max(...tiles.map(tile => tile.height));
    const width = cols * cellW + (cols - 1) * gap;
    const height = rows * cellH + (rows - 1) * gap;
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = rgba[i + 1] = rgba[i + 2] = 24; rgba[i + 3] = 255; }
    const cells: string[] = [];
    tiles.forEach((tile, index) => {
        const col = index % cols, row = Math.floor(index / cols);
        const left = col * (cellW + gap), top = row * (cellH + gap);
        for (let y = 0; y < tile.height; y++) {
            const source = (tile.height - 1 - y) * tile.width * 4;
            const target = ((top + y) * width + left) * 4;
            tile.pixels.copy(rgba, target, source, source + tile.width * 4);
            for (let x = 0; x < tile.width; x++) rgba[target + x * 4 + 3] = 255;
        }
        cells.push(`${tiles.length > 1 ? `${row === 0 ? 'top' : 'bottom'}-${col === 0 ? 'left' : 'right'}` : 'image'}: ${tile.view} (${tile.width}x${tile.height})`);
    });
    return { width, height, rgba, cells };
}

function captureResult(data: unknown): unknown {
    if (!isRecord(data) || !Array.isArray(data.views) || !data.views.length) throw new Error('Blender returned no views. Update the add-on with blender_install_addon.');
    const tiles: Tile[] = data.views.map(raw => {
        if (!isRecord(raw) || typeof raw.pixels !== 'string' || !Number.isInteger(raw.width) || !Number.isInteger(raw.height)) throw new Error('Blender returned an invalid view.');
        const width = raw.width as number, height = raw.height as number;
        const pixels = Buffer.from(raw.pixels, 'base64');
        if (width < 1 || height < 1 || width > 2048 || height > 2048 || pixels.length !== width * height * 4) throw new Error('Blender returned a pixel buffer of the wrong size.');
        return { view: String(raw.view), width, height, pixels };
    });
    const { width, height, rgba, cells } = composeTiles(tiles);
    const { views: _views, ...metadata } = data;
    const text = [`Layout: ${cells.join('; ')}`, `Info: ${JSON.stringify(metadata)}`].join('\n');
    return { content: [{ type: 'text', text }, { type: 'image', mimeType: 'image/png', data: encodeRgbaPng(width, height, rgba).toString('base64') }] };
}

/** Points at the usual fix for errors agents hit often in bpy code. */
function executeHint(error: string): string {
    if (/context is incorrect|poll\(\) failed/i.test(error)) return 'Hint: this operator cannot run in the current context. Check it with blender_api_lookup (shows poll() and parameters), or use the bpy.data API instead of bpy.ops.';
    if (/ReferenceError: StructRNA .* has been removed/.test(error)) return 'Hint: a stored reference went stale (the data was removed or the file reloaded). Look objects up again by name.';
    if (/Calling operator .* error, can't modify blend data in this state/i.test(error)) return 'Hint: Blender is in a state that blocks edits (e.g. rendering or a modal tool). Retry after it finishes.';
    return '';
}

function formatExecute(data: unknown): unknown {
    if (!isRecord(data)) throw new Error('Blender returned an invalid response.');
    const sections: string[] = [];
    // The error goes first so Unify's output limit never cuts off the traceback.
    const error = typeof data.error === 'string' && data.error ? data.error : '';
    if (error) sections.push(`Error:\n${error}`, executeHint(error));
    if (typeof data.output === 'string' && data.output) sections.push(`Output:\n${data.output}`);
    if (typeof data.value === 'string') sections.push(`Value:\n${data.value}`);
    const text = sections.filter(Boolean).join('\n\n');
    if (error) return { content: [{ type: 'text', text }], isError: true };
    return text || 'Code executed successfully (no output). Changes are one undo step in Blender.';
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise(resolve => {
        const child = execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            state.children.delete(child);
            const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0;
            resolve({ stdout: String(stdout), stderr: String(stderr || (error && !stdout ? error.message : '')), code });
        });
        state.children.add(child);
    });
}

/** Rejects anything but a Blender executable, so a tool argument cannot launch arbitrary programs. */
function blenderExecutable(file: string): string {
    if (!/^blender(\.exe)?$/i.test(basename(file))) throw new Error(`blenderPath must be the Blender executable (blender or blender.exe), not ${basename(file)}.`);
    if (!existsSync(file)) throw new Error(`Blender not found at ${file}.`);
    return file;
}

async function listDirs(dir: string): Promise<string[]> {
    try { return (await readdir(dir, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name); }
    catch { return []; }
}

async function blenderCandidates(): Promise<string[]> {
    const found: string[] = [];
    if (process.env.UNIFY_BLENDER_PATH) found.push(process.env.UNIFY_BLENDER_PATH);
    if (process.platform === 'win32') {
        const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')].filter((base): base is string => !!base);
        for (const base of bases) {
            const root = join(base, 'Blender Foundation');
            const versions = (await listDirs(root)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const version of versions) found.push(join(root, version, 'blender.exe'));
        }
        for (const steam of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
            const libraries = [steam];
            try {
                const vdf = await readFile(join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
                for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libraries.push(match[1].replace(/\\\\/g, '\\'));
            } catch { /* No Steam install here. */ }
            for (const library of libraries) found.push(join(library, 'steamapps', 'common', 'Blender', 'blender.exe'));
        }
    } else if (process.platform === 'darwin') {
        found.push('/Applications/Blender.app/Contents/MacOS/Blender', join(homedir(), 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
    } else {
        for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir) found.push(join(dir, 'blender'));
        found.push('/snap/bin/blender', '/usr/bin/blender');
    }
    return [...new Set(found)].filter(path => existsSync(path));
}

async function cleanDiscovery(): Promise<void> {
    let names: string[] = [];
    try { names = await readdir(DISCOVERY_DIR); } catch { return; }
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = join(DISCOVERY_DIR, name);
        try {
            const info = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown };
            if (typeof info.pid === 'number') { process.kill(info.pid, 0); continue; }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') continue;
        }
        await rm(file, { force: true });
    }
}

const EXPORT_EXTENSIONS: Record<string, string[]> = {
    fbx: ['.fbx'], glb: ['.glb'], gltf: ['.gltf'], obj: ['.obj'], stl: ['.stl'], ply: ['.ply'], usd: ['.usdc', '.usd', '.usda', '.usdz'],
};
/** Files that mark a folder as a code project; models must not be written inside one unless the user asks. */
const CODE_MARKERS = /^(.+\.project\.json|package\.json|tsconfig\.json|wally\.toml|rokit\.toml|aftman\.toml|foreman\.toml|selene\.toml|cargo\.toml)$/i;

function exportDir(session: Session): string {
    return session.file ? join(dirname(session.file), 'exports') : join(homedir(), 'Documents', 'Blender Exports');
}

/** Resolves the output file: a full file path, a folder (gets "<name>.<ext>"), or the default exports folder next to the .blend. */
function exportPath(args: Record<string, unknown>, session: Session, label: string, extensions: string[], target: string[] | undefined): string {
    const blendDir = session.file ? dirname(session.file) : '';
    const defaultDir = exportDir(session);
    const single = target?.length === 1 && !target[0].startsWith('$') ? target[0] : undefined;
    const fallback = session.file ? basename(session.file).replace(/\.blend\d*$/i, '') : 'export';
    const stem = (optionalString(args, 'name') ?? single ?? fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'export';
    const raw = optionalString(args, 'path');
    if (!raw) return join(defaultDir, stem + extensions[0]);
    const full = isAbsolute(raw) ? resolve(raw) : resolve(blendDir || defaultDir, raw);
    if (/[\\/]$/.test(raw) || !extname(full) || (existsSync(full) && statSync(full).isDirectory())) return join(full, stem + extensions[0]);
    if (!extensions.includes(extname(full).toLowerCase())) throw new Error(`path ends in ${extname(full)}, but ${label} writes ${extensions.join(' / ')}.`);
    return full;
}

/** Resolves an output folder for split exports: path (absolute or relative to the .blend) or the default exports folder. */
function exportFolder(args: Record<string, unknown>, session: Session): string {
    const raw = optionalString(args, 'path');
    if (!raw) return exportDir(session);
    const full = isAbsolute(raw) ? resolve(raw) : resolve(session.file ? dirname(session.file) : exportDir(session), raw);
    if (extname(full) && !(existsSync(full) && statSync(full).isDirectory())) throw new Error('With split, path must be a folder, not a file.');
    return full;
}

async function refuseCodeProject(args: Record<string, unknown>, file: string): Promise<void> {
    if (optionalBoolean(args, 'allowCodeWorkspace')) return;
    const marker = await codeProjectMarker(file);
    if (marker) throw new Error(`Refusing to write into a code project (found ${marker}). Choose a folder outside the project, such as an Assets folder. Pass allowCodeWorkspace: true only if the user explicitly asked for this location.`);
}

async function codeProjectMarker(file: string): Promise<string | undefined> {
    const home = resolve(homedir()).toLowerCase();
    let dir = dirname(resolve(file));
    for (;;) {
        // Stray config files directly in the home folder do not make it a project.
        if (dir.toLowerCase() === home) return undefined;
        try {
            const hit = (await readdir(dir)).find(name => CODE_MARKERS.test(name));
            if (hit) return join(dir, hit);
        } catch { /* Folder does not exist yet. */ }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

const instanceSchema = { type: 'string', description: 'Which Blender session to use (instance id, pid, or .blend file name). Required only when several sessions are connected; see blender_instances.' };
const targetSchema = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200, description: 'Object names, collection names (all objects inside), "$selection" or "$all". Prefer names: the selection is shared with the user and other agents.' };
const codeWorkspaceSchema = { type: 'boolean', default: false, description: 'Allow writing inside a code project folder. Only set this when the user explicitly asked for that location.' };

const pack: ToolpackDefinition = {
    name: 'blender',
    description: 'Inspect and edit open Blender sessions: run Python (bpy), browse the scene, read/write properties, capture viewport images, render PNG icons and thumbnails, check meshes for game readiness, import, save and export models (including a Roblox FBX preset), convert armature actions or animation FBX files for roblox_import_animation, and look up the bpy API of the running version. Supports several Blender windows at once.',
    async setup(ctx) {
        state.ctx = ctx;
        state.token = randomBytes(24).toString('hex');
        await mkdir(ctx.dataDir, { recursive: true });
        await writeFile(join(ctx.dataDir, 'unify_bridge.py'), ADDON_SOURCE, 'utf8');
        const server = createServer((req, res) => {
            void handle(req, res).catch((error: unknown) => {
                ctx.log(`Bridge request failed: ${error instanceof Error ? error.message : String(error)}`);
                json(res, 500, { error: 'internal server error' });
            });
        });
        state.server = server;
        await new Promise<void>((resolve, reject) => {
            server.once('error', error => reject(new Error(`Could not start the Blender bridge: ${error.message}`)));
            server.listen(Number(process.env.UNIFY_BLENDER_PORT) || 0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        state.port = typeof address === 'object' && address ? address.port : 0;
        // The token in the discovery file lets its reader run code in Blender: keep it private to this user.
        await mkdir(DISCOVERY_DIR, { recursive: true, mode: 0o700 });
        await chmod(DISCOVERY_DIR, 0o700).catch(() => undefined);
        await cleanDiscovery();
        state.discoveryFile = join(DISCOVERY_DIR, `${process.pid}.json`);
        await writeFile(state.discoveryFile, JSON.stringify({ port: state.port, token: state.token, pid: process.pid, addon: ADDON_VERSION }), { encoding: 'utf8', mode: 0o600 });
        await chmod(state.discoveryFile, 0o600).catch(() => undefined);
        ctx.log(`Listening on 127.0.0.1:${state.port}; discovery file ${state.discoveryFile}`);
        state.lastStatus = '';
        updateStatus();
        state.statusTimer = setInterval(updateStatus, 2_000);
        state.statusTimer.unref();
    },
    async teardown() {
        if (state.statusTimer) clearInterval(state.statusTimer);
        state.statusTimer = undefined;
        if (state.discoveryFile) await rm(state.discoveryFile, { force: true }).catch(() => undefined);
        state.discoveryFile = '';
        for (const session of state.sessions.values()) for (const waiter of session.waiters.splice(0)) endWaiter(waiter);
        for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Blender bridge shut down.')); }
        state.pending.clear();
        state.late.clear();
        for (const child of state.children) child.kill();
        state.children.clear();
        state.sessions.clear();
        const server = state.server;
        state.server = undefined;
        if (server) await new Promise<void>(resolve => server.close(() => resolve()));
        state.ctx = undefined;
        state.lastStatus = '';
    },
    tools: [
        {
            name: 'instances',
            description: 'List connected Blender sessions (file, Blender version, scene, unsaved changes marked with *), what each is busy with, and results of commands that finished after their caller timed out. Use the instance id to target one when several are open.',
            inputSchema: { type: 'object', properties: {} },
            run() {
                prune();
                const sessions = onlineSessions();
                if (!sessions.length) return 'No Blender session is connected. Run blender_install_addon once, then open Blender (the "Unify Bridge" add-on connects automatically).';
                return sessions.map(session => {
                    const queued = [...state.pending.values()].filter(pending => pending.session === session.id && !pending.startedAt).length;
                    const running = session.running ? ` | running ${session.running.op} for ${Math.round((Date.now() - session.running.startedAt) / 1000)}s` : '';
                    const busy = queued ? ` | ${queued} command(s) queued` : '';
                    const old = session.addon < ADDON_VERSION ? ' | add-on outdated: run blender_install_addon and restart this Blender' : '';
                    const late = session.late.length ? `\n  Late results:\n${session.late.map(item => `  - ${item}`).join('\n')}` : '';
                    return `${label(session)} | last seen ${Math.floor((Date.now() - session.lastSeen) / 1000)}s ago${running}${busy}${old}${late}`;
                }).join('\n');
            },
        },
        {
            name: 'execute',
            description: 'Run Python inside Blender on the main thread with bpy, bmesh, mathutils, Vector, Matrix, C (bpy.context) and D (bpy.data) preloaded. print() output and the value of a trailing expression are returned. Variables do not persist between calls. Operators (bpy.ops) run with the largest 3D Viewport as context. Changes are pushed as one undo step after the call. Selection, active object, mode and undo history are shared with the user and other agents: look objects up by name instead of relying on them, and never undo. In Edit Mode, obj.data is stale; use bmesh.from_edit_mesh(obj.data) or obj.update_from_editmode(). Blender is Z-up and uses meters. Python cannot be interrupted: keep each call well under the timeout.',
            inputSchema: {
                type: 'object', required: ['code'], properties: {
                    instance: instanceSchema,
                    code: { type: 'string', description: 'Python source (max 200000 bytes).' },
                    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 55, default: 50 },
                },
            },
            async run(args) {
                const code = requiredString(args, 'code');
                if (Buffer.byteLength(code, 'utf8') > 200_000) throw new Error('code must be at most 200000 bytes.');
                const timeout = integer(args, 'timeoutSeconds', 50, 1, 55) * 1000;
                return formatExecute(await command(resolveSession(args), 'execute', { code }, timeout));
            },
        },
        {
            name: 'tree',
            description: 'Show the scene outline: collections, objects (with parenting), their types, selection/visibility and modifiers. Pass root to start from a collection or object name.',
            inputSchema: {
                type: 'object', properties: {
                    instance: instanceSchema,
                    scene: { type: 'string', description: 'Scene name; defaults to the active scene.' },
                    root: { type: 'string', description: 'Collection or object name to list from.' },
                    depth: { type: 'integer', minimum: 0, maximum: 50, default: 4 },
                    maxNodes: { type: 'integer', minimum: 1, maximum: 5000, default: 300 },
                },
            },
            async run(args) {
                integer(args, 'depth', 4, 0, 50); integer(args, 'maxNodes', 300, 1, 5000);
                return textCommand(args, 'tree', pick(args, ['scene', 'root', 'depth', 'maxNodes']));
            },
        },
        {
            name: 'find',
            description: 'Search objects (or any bpy.data collection via kind, e.g. "materials", "meshes", "images", "node_groups", "actions") by name, type, material, modifier, collection or selection.',
            inputSchema: {
                type: 'object', properties: {
                    instance: instanceSchema,
                    kind: { type: 'string', default: 'objects', description: 'bpy.data collection to search.' },
                    name: { type: 'string', description: 'Case-insensitive substring, or a glob such as "Rock*".' },
                    type: { type: 'string', description: 'Object type such as MESH, CURVE, EMPTY, LIGHT, CAMERA, ARMATURE.' },
                    material: { type: 'string', description: 'Only objects with a material whose name matches (substring or glob).' },
                    modifier: { type: 'string', description: 'Modifier name or type (e.g. BEVEL).' },
                    collection: { type: 'string', description: 'Only objects inside this collection (including nested ones).' },
                    scene: { type: 'string', description: 'Only objects linked to this scene.' },
                    selected: { type: 'boolean' },
                    limit: { type: 'integer', minimum: 1, maximum: 2000, default: 100 },
                },
            },
            async run(args) {
                integer(args, 'limit', 100, 1, 2000);
                optionalBoolean(args, 'selected');
                return textCommand(args, 'find', pick(args, ['kind', 'name', 'type', 'material', 'modifier', 'collection', 'scene', 'selected', 'limit']));
            },
        },
        {
            name: 'properties',
            description: 'Read or set RNA properties. Without properties it lists every property. set takes {name: value}; vectors are arrays, enums are strings, ID pointers take a data-block name or null. Sets are one undo step. Functions cannot be called here; use blender_execute.',
            inputSchema: {
                type: 'object', required: ['path'], properties: {
                    instance: instanceSchema,
                    path: { type: 'string', description: 'An object name ("Cube") or a data path made of names and ["key"]/[index] lookups, e.g. objects["Cube"].modifiers["Bevel"], materials["Metal"].node_tree.nodes["Principled BSDF"].inputs["Roughness"], scenes["Scene"].render or bpy.context.scene.' },
                    properties: { type: 'array', items: { type: 'string' }, description: 'Only read these properties.' },
                    set: { type: 'object', description: 'Property values to assign before reading back.' },
                },
            },
            async run(args) {
                const sent: Record<string, unknown> = { path: requiredString(args, 'path') };
                const properties = stringList(args, 'properties');
                if (properties) sent.properties = properties;
                if (args.set !== undefined) {
                    if (!isRecord(args.set)) throw new Error('set must be an object of property names to values.');
                    sent.set = args.set;
                }
                return textCommand(args, 'properties', sent);
            },
        },
        {
            name: 'selection',
            description: 'Get the mode, active object and selected objects (plus edit-mode element counts), or set the object selection and active object. The selection is shared with the user and other agents; other tools take explicit target names instead.',
            inputSchema: {
                type: 'object', properties: {
                    instance: instanceSchema,
                    action: { type: 'string', enum: ['get', 'set'], default: 'get' },
                    objects: { type: 'array', items: { type: 'string' }, description: 'Objects to select (action set). Everything else is deselected.' },
                    active: { type: 'string', description: 'Object to make active (action set); defaults to the first selected.' },
                },
            },
            async run(args) {
                const action = optionalString(args, 'action') ?? 'get';
                if (action !== 'get' && action !== 'set') throw new Error('action must be get or set.');
                const objects = stringList(args, 'objects');
                if (action === 'set' && !objects) throw new Error('objects is required when action is set (pass [] to clear).');
                return textCommand(args, 'selection', { action, ...(objects ? { objects } : {}), ...pick(args, ['active']) });
            },
        },
        {
            name: 'capture_view',
            description: 'Draw the 3D Viewport to an image without moving the user\'s view, for checking work. Views: current (what the user sees), camera (scene camera), front, back, right, left, top, bottom, iso (orthographic, framed on target). With target and no views you get front/right/top/iso tiled 2x2 in one image; without target, preset views frame the selection. Shading: solid, wireframe, material, rendered (material/rendered may need a second capture while shaders compile, and rendered with Cycles can come out noisy). Overlays (grid, outlines) are off unless overlays is true. For final PNG images use blender_render.',
            inputSchema: {
                type: 'object', properties: {
                    instance: instanceSchema,
                    views: { type: 'array', items: { type: 'string', enum: ['current', 'camera', 'front', 'back', 'right', 'left', 'top', 'bottom', 'iso'] }, minItems: 1, maxItems: 4 },
                    target: targetSchema,
                    shading: { type: 'string', enum: ['solid', 'wireframe', 'material', 'rendered'] },
                    overlays: { type: 'boolean', default: false },
                    size: { type: 'integer', minimum: 64, maximum: 1024, description: 'Longest edge of each view in pixels. Default 768 for one view, 512 per tile otherwise (at most 768 per tile).' },
                    padding: { type: 'number', minimum: 1, maximum: 10, default: 1.1, description: 'Framing margin for preset views (1 = tight).' },
                },
            },
            async run(args) {
                const views = stringList(args, 'views');
                if (views && (views.length < 1 || views.length > 4)) throw new Error('views must contain 1 to 4 entries.');
                if (args.size !== undefined) integer(args, 'size', 512, 64, 1024);
                if (args.padding !== undefined && (typeof args.padding !== 'number' || args.padding < 1 || args.padding > 10)) throw new Error('padding must be a number from 1 to 10.');
                optionalBoolean(args, 'overlays');
                const sent = pick(args, ['shading', 'overlays', 'size', 'padding']);
                const target = stringList(args, 'target');
                const count = views?.length ?? (target ? 4 : 1);
                // Tiled images stay near 1536 px wide; larger ones cost tokens without showing more.
                if (count > 1 && typeof sent.size === 'number' && sent.size > 768) sent.size = 768;
                if (views) sent.views = views;
                if (target) sent.target = target;
                return captureResult(await command(resolveSession(args), 'capture_view', sent, 55_000));
            },
        },
        {
            name: 'render',
            description: 'Render a final PNG with Blender\'s renderer, e.g. Roblox icons, thumbnails and decals. Preset views place a temporary orthographic camera framed on target (the scene and the user\'s view are restored afterwards); view "camera" uses the scene camera. Other geometry is hidden from the render unless isolate is false. Engines: workbench (fast, studio lighting, default), eevee (scene lights and materials; first render compiles shaders) or cycles (slow; keep samples low). Returns the file path and a small preview. Without path, files go to the "exports" folder next to the .blend.',
            inputSchema: {
                type: 'object', additionalProperties: false, properties: {
                    instance: instanceSchema,
                    target: targetSchema,
                    view: { type: 'string', enum: ['iso', 'front', 'back', 'right', 'left', 'top', 'bottom', 'camera'], default: 'iso' },
                    width: { type: 'integer', minimum: 16, maximum: 2048, default: 512, description: 'Pixels. Roblox images are limited to 1024x1024.' },
                    height: { type: 'integer', minimum: 16, maximum: 2048, description: 'Pixels; defaults to width.' },
                    engine: { type: 'string', enum: ['workbench', 'eevee', 'cycles'], default: 'workbench' },
                    transparent: { type: 'boolean', default: true, description: 'Transparent background (RGBA PNG).' },
                    textures: { type: 'boolean', default: true, description: 'workbench only: show image textures instead of flat material colors.' },
                    samples: { type: 'integer', minimum: 1, maximum: 512, description: 'eevee (default 16) or cycles (default 32) samples.' },
                    padding: { type: 'number', minimum: 1, maximum: 10, default: 1.1, description: 'Framing margin for preset views (1 = tight).' },
                    isolate: { type: 'boolean', description: 'Hide other geometry from the render. Default true when target is given.' },
                    path: { type: 'string', description: 'Output .png file or folder. Relative paths are resolved from the .blend folder.' },
                    name: { type: 'string', description: 'File name without extension. Defaults to the single target name or the .blend name.' },
                    overwrite: { type: 'boolean', default: false },
                    allowCodeWorkspace: codeWorkspaceSchema,
                },
            },
            async run(args) {
                const session = resolveSession(args);
                const target = stringList(args, 'target');
                const view = optionalString(args, 'view') ?? 'iso';
                if (view !== 'camera' && !target) throw new Error('Preset views frame target: pass target (object or collection names, or "$all"), or use view "camera".');
                const width = integer(args, 'width', 512, 16, 2048);
                const height = integer(args, 'height', width, 16, 2048);
                if (args.samples !== undefined) integer(args, 'samples', 16, 1, 512);
                for (const key of ['transparent', 'textures', 'isolate']) optionalBoolean(args, key);
                const file = exportPath(args, session, 'render', ['.png'], target);
                await refuseCodeProject(args, file);
                if (existsSync(file) && !optionalBoolean(args, 'overwrite')) throw new Error(`${file} already exists. Pass overwrite: true to replace it, or choose another name.`);
                const sent: Record<string, unknown> = { path: file, view, width, height, ...pick(args, ['engine', 'transparent', 'textures', 'samples', 'padding', 'isolate']) };
                if (target) sent.target = target;
                const data = await command(session, 'render', sent, 55_000);
                if (!isRecord(data) || typeof data.path !== 'string') throw new Error('Blender returned an invalid response.');
                const preview = captureResult({ views: data.views });
                const text = `Rendered ${data.path} (${data.width}x${data.height}, ${data.engine}, ${data.transparent ? 'transparent' : 'opaque'} background, ${data.seconds}s). Framed: ${Array.isArray(data.framed) && data.framed.length ? data.framed.join(', ') : 'scene camera view'}.`;
                const image = (preview as { content: Array<Record<string, unknown>> }).content.find(block => block.type === 'image');
                return { content: [{ type: 'text', text }, ...(image ? [image] : [])] };
            },
        },
        {
            name: 'output_log',
            description: 'Read Python console output captured in Blender since the add-on started (prints and tracebacks from scripts, add-ons and handlers). Ends with now=<timestamp> to pass as sinceTimestamp later.',
            inputSchema: {
                type: 'object', properties: {
                    instance: instanceSchema,
                    level: { type: 'string', enum: ['all', 'output', 'error'], default: 'all' },
                    contains: { type: 'string', description: 'Case-insensitive text filter.' },
                    limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
                    sinceTimestamp: { type: 'number', description: 'Unix time in seconds (the now= value of an earlier call); only newer entries are returned.' },
                    clear: { type: 'boolean', description: 'Empty the log after reading. It is shared by all agents; prefer sinceTimestamp.' },
                },
            },
            async run(args) {
                integer(args, 'limit', 200, 1, 2000);
                optionalBoolean(args, 'clear');
                return textCommand(args, 'output_log', pick(args, ['level', 'contains', 'limit', 'sinceTimestamp', 'clear']));
            },
        },
        {
            name: 'mesh_check',
            description: 'Game-readiness report for mesh objects: vertex/face/triangle counts, n-gons, open and non-manifold edges, inconsistent normals, loose and duplicate vertices, degenerate faces, UV maps, material slots and unapplied or negative transforms. Defaults to every visible mesh. profile "roblox" also flags more than 20,000 triangles, extra UV maps, vertices weighted to more than 4 bones and textures over 1024 px.',
            inputSchema: {
                type: 'object', properties: {
                    instance: instanceSchema,
                    target: targetSchema,
                    profile: { type: 'string', enum: ['generic', 'roblox'], default: 'generic' },
                    evaluated: { type: 'boolean', default: true, description: 'Check the mesh with modifiers applied, as an exporter would see it.' },
                },
            },
            async run(args) {
                optionalBoolean(args, 'evaluated');
                const sent = pick(args, ['profile', 'evaluated']);
                const target = stringList(args, 'target');
                if (target) sent.target = target;
                return textCommand(args, 'mesh_check', sent);
            },
        },
        {
            name: 'api_lookup',
            description: 'Look up the bpy API of the connected Blender version before writing code: a type ("Object", "bpy.types.BevelModifier"), a member ("Object.location", "Mesh.attributes"), an operator ("bpy.ops.mesh.primitive_cube_add", including whether it can run in the current context) or free text ("subdivision levels") to search type, operator and property names. Large types are listed by name only; look up a member for details.',
            inputSchema: {
                type: 'object', required: ['query'], properties: {
                    instance: instanceSchema,
                    query: { type: 'string' },
                    brief: { type: 'boolean', default: false, description: 'For a type, list member names only.' },
                    limit: { type: 'integer', minimum: 1, maximum: 300, default: 60, description: 'Maximum search results.' },
                },
            },
            async run(args) {
                integer(args, 'limit', 60, 1, 300);
                optionalBoolean(args, 'brief');
                return textCommand(args, 'api_lookup', { query: requiredString(args, 'query'), ...pick(args, ['limit', 'brief']) });
            },
        },
        {
            name: 'export',
            description: 'Export objects to FBX, GLB/glTF, OBJ, STL, PLY or USD (selection and mode are restored). preset "roblox": FBX, Y-up/-Z-forward, unit scaling, embedded textures, no leaf bones; rigs get only the active action and deform bones. Warnings cover skipped objects (curves/text: convert first), skinned meshes without their armature and >20,000 triangles. Default folder: "exports" next to the .blend. Never overwrites unless overwrite is true. Lists each file with its size in meters and the settings used.',
            inputSchema: {
                type: 'object', required: ['target'], properties: {
                    instance: instanceSchema,
                    target: targetSchema,
                    format: { type: 'string', enum: Object.keys(EXPORT_EXTENSIONS), default: 'fbx' },
                    preset: { type: 'string', enum: ['default', 'roblox'], default: 'default' },
                    split: { type: 'string', enum: ['none', 'object', 'collection'], default: 'none', description: 'object: one file per object (a skinned mesh brings its armature); collection: one file per collection.' },
                    path: { type: 'string', description: 'Output file, or a folder (ends with / or has no extension; required to be a folder with split). Relative paths are resolved from the .blend folder.' },
                    name: { type: 'string', description: 'File name without extension when path is a folder or omitted. Defaults to the single target name or the .blend name. Ignored with split.' },
                    applyModifiers: { type: 'boolean', default: true },
                    overwrite: { type: 'boolean', default: false },
                    options: { type: 'object', description: 'Extra exporter operator settings, e.g. {"global_scale": 0.5} for FBX. Unknown names are rejected with the valid list; use blender_api_lookup on bpy.ops.export_scene.fbx etc. to see them.' },
                    allowCodeWorkspace: codeWorkspaceSchema,
                },
            },
            async run(args) {
                const session = resolveSession(args);
                const format = optionalString(args, 'format') ?? 'fbx';
                if (!EXPORT_EXTENSIONS[format]) throw new Error(`format must be one of: ${Object.keys(EXPORT_EXTENSIONS).join(', ')}.`);
                const preset = optionalString(args, 'preset') ?? 'default';
                if (preset !== 'default' && preset !== 'roblox') throw new Error('preset must be default or roblox.');
                if (preset === 'roblox' && format !== 'fbx') throw new Error('The roblox preset exports FBX; use format fbx (or omit format).');
                const split = optionalString(args, 'split') ?? 'none';
                if (!['none', 'object', 'collection'].includes(split)) throw new Error('split must be none, object or collection.');
                if (args.options !== undefined && !isRecord(args.options)) throw new Error('options must be an object of exporter settings.');
                optionalBoolean(args, 'applyModifiers');
                const target = stringList(args, 'target');
                if (!target) throw new Error('target is required: object or collection names, "$all", or "$selection" to export what is selected in Blender right now.');
                const overwrite = optionalBoolean(args, 'overwrite') ?? false;
                let file: string;
                if (split === 'none') {
                    file = exportPath(args, session, `format ${format}`, EXPORT_EXTENSIONS[format], target);
                    await refuseCodeProject(args, file);
                    if (existsSync(file) && !overwrite) throw new Error(`${file} already exists. Pass overwrite: true to replace it, or choose another name.`);
                } else {
                    file = exportFolder(args, session);
                    await refuseCodeProject(args, join(file, 'export'));
                }
                const sent: Record<string, unknown> = { format, preset, split, overwrite, path: file, target, ...pick(args, ['applyModifiers', 'options']) };
                const data = await command(session, 'export', sent, 55_000);
                if (!isRecord(data) || typeof data.text !== 'string') throw new Error('Blender returned an invalid response.');
                return textResult(data);
            },
        },
        {
            name: 'import',
            description: 'Import a model file (FBX, GLB/glTF, OBJ, STL, PLY, USD) into the open scene. Lists the new objects and actions so you can pass them as target to other tools. One undo step.',
            inputSchema: {
                type: 'object', required: ['path'], properties: {
                    instance: instanceSchema,
                    path: { type: 'string', description: 'Absolute path of the file to import.' },
                    collection: { type: 'string', description: 'Put the new objects into this collection (created if missing).' },
                    options: { type: 'object', description: 'Extra importer operator settings, e.g. {"global_scale": 0.01}. Unknown names are rejected with the valid list.' },
                },
            },
            async run(args) {
                const path = requiredString(args, 'path');
                if (!isAbsolute(path) || !existsSync(path)) throw new Error(`path must be an absolute path to an existing file (${path}).`);
                if (args.options !== undefined && !isRecord(args.options)) throw new Error('options must be an object of importer settings.');
                return textCommand(args, 'import', { path, ...pick(args, ['collection', 'options']) }, 55_000);
            },
        },
        {
            name: 'save',
            description: 'Save the open .blend file. With path, save as that file (the session then edits it) or, with copy, write a copy and keep editing the current file.',
            inputSchema: {
                type: 'object', properties: {
                    instance: instanceSchema,
                    path: { type: 'string', description: 'Absolute .blend path. Required if the file was never saved.' },
                    copy: { type: 'boolean', default: false },
                    overwrite: { type: 'boolean', default: false, description: 'Replace an existing file at path.' },
                },
            },
            async run(args) {
                const path = optionalString(args, 'path');
                if (path !== undefined && (!isAbsolute(path) || extname(path).toLowerCase() !== '.blend')) throw new Error('path must be an absolute path ending in .blend.');
                optionalBoolean(args, 'copy'); optionalBoolean(args, 'overwrite');
                return textCommand(args, 'save', pick(args, ['path', 'copy', 'overwrite']));
            },
        },
        {
            name: 'export_animation',
            description: 'Convert armature animations to a unify-animation JSON file for roblox_import_animation (Open Cloud needs KeyframeSequences, not FBX). With fbx, the FBX is read by a separate headless Blender (open scene untouched; long runs continue as a blender_job_status job); otherwise the session\'s armature is used. Samples every frame (or every step frames) with constraints applied. Without actions, an FBX exports all takes and a session armature its current action. Output goes next to the FBX or to "exports" next to the .blend.',
            inputSchema: {
                type: 'object', additionalProperties: false, properties: {
                    instance: instanceSchema,
                    fbx: { type: 'string', description: 'Absolute path of an animation FBX to read headlessly.' },
                    armature: { type: 'string', description: 'Armature object name. Required only when there are several.' },
                    actions: { type: 'array', items: { type: 'string' }, description: 'Action names to export (FBX takes may appear as "Armature|Take").' },
                    frameStart: { type: 'integer', description: 'First frame (inclusive); defaults to the action\'s range.' },
                    frameEnd: { type: 'integer', description: 'Last frame (inclusive); defaults to the action\'s range.' },
                    step: { type: 'integer', minimum: 1, maximum: 60, default: 1 },
                    fps: { type: 'number', exclusiveMinimum: 0, description: 'Overrides the scene frame rate.' },
                    path: { type: 'string', description: 'Output .json file or folder.' },
                    name: { type: 'string', description: 'File name without extension. Defaults to the FBX, armature or .blend name.' },
                    overwrite: { type: 'boolean', default: false },
                    allowCodeWorkspace: codeWorkspaceSchema,
                    blenderPath: { type: 'string', description: 'Blender executable (blender or blender.exe) for fbx mode.' },
                },
            },
            async run(args, ctx) {
                const fbx = optionalString(args, 'fbx');
                const actions = stringList(args, 'actions');
                const step = integer(args, 'step', 1, 1, 60);
                const fps = args.fps;
                if (fps !== undefined && (typeof fps !== 'number' || !(fps > 0))) throw new Error('fps must be a positive number.');
                for (const key of ['frameStart', 'frameEnd']) if (args[key] !== undefined) integer(args, key, 0, -1_000_000, 1_000_000);

                let session: Session | undefined;
                let baseDir: string;
                let stem: string;
                if (fbx !== undefined) {
                    if (!isAbsolute(fbx) || !existsSync(fbx)) throw new Error(`fbx must be an absolute path to an existing file (${fbx}).`);
                    baseDir = dirname(fbx);
                    stem = basename(fbx, extname(fbx));
                } else {
                    session = resolveSession(args);
                    baseDir = exportDir(session);
                    stem = optionalString(args, 'armature') ?? (session.file ? basename(session.file).replace(/\.blend\d*$/i, '') : 'animation');
                }
                stem = (optionalString(args, 'name') ?? stem).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'animation';
                const raw = optionalString(args, 'path');
                let out = raw ? (isAbsolute(raw) ? resolve(raw) : resolve(session?.file ? dirname(session.file) : baseDir, raw)) : join(baseDir, `${stem}.anim.json`);
                if (raw && (/[\\/]$/.test(raw) || !extname(out) || (existsSync(out) && statSync(out).isDirectory()))) out = join(out, `${stem}.anim.json`);
                if (extname(out).toLowerCase() !== '.json') throw new Error('path must end in .json or be a folder.');
                await refuseCodeProject(args, out);
                if (existsSync(out) && !optionalBoolean(args, 'overwrite')) throw new Error(`${out} already exists. Pass overwrite: true to replace it, or choose another name.`);
                await mkdir(dirname(out), { recursive: true });

                const params = { armature: optionalString(args, 'armature') ?? null, actions: actions ?? null, frame_start: args.frameStart ?? null, frame_end: args.frameEnd ?? null, step, fps: fps ?? null, out, fbx: fbx ?? null };
                const report = (output: string): string => {
                    const line = output.split(/\r?\n/).find(item => item.startsWith('UNIFY_ANIM_RESULT '));
                    if (!line) throw new Error(`Blender did not report a result.\n${output.slice(-2000)}`);
                    const summary = JSON.parse(line.slice('UNIFY_ANIM_RESULT '.length)) as { armature: string; bones: number; animations: Array<{ name: string; keys: number; seconds: number; fps: number }> };
                    return [
                        `Wrote ${out}`,
                        `Armature "${summary.armature}" with ${summary.bones} bones.`,
                        ...summary.animations.map(item => `- ${item.name}: ${item.keys} keyframes, ${item.seconds.toFixed(2)}s at ${item.fps} fps`),
                        'Next: roblox_import_animation with this file.',
                    ].join('\n');
                };
                if (session) {
                    const data = await command(session, 'execute', { code: `${ANIM_SOURCE}\n_unify_anim_export(**_unify_json.loads(${JSON.stringify(JSON.stringify(params))}))` }, 55_000);
                    if (!isRecord(data)) throw new Error('Blender returned an invalid response.');
                    if (typeof data.error === 'string' && data.error) throw new Error(data.error);
                    return report(typeof data.output === 'string' ? data.output : '');
                }
                const explicit = optionalString(args, 'blenderPath');
                const blender = explicit !== undefined ? blenderExecutable(explicit) : (await blenderCandidates())[0];
                if (!blender) throw new Error('No Blender executable found. Pass blenderPath or set UNIFY_BLENDER_PATH.');
                await mkdir(ctx.dataDir, { recursive: true });
                // Per-call files: parallel exports must not overwrite each other's parameters.
                const tag = randomBytes(4).toString('hex');
                const script = join(ctx.dataDir, `export_animation_${tag}.py`);
                const paramsFile = join(ctx.dataDir, `export_animation_${tag}.json`);
                await writeFile(script, `${ANIM_SOURCE}\n${ANIM_HEADLESS}`, 'utf8');
                await writeFile(paramsFile, JSON.stringify(params), 'utf8');
                const job = startJob(`Animation export of ${basename(fbx!)}`, async () => {
                    try {
                        const result = await run(blender, ['--background', '--factory-startup', '--python', script, '--', paramsFile], HEADLESS_TIMEOUT_MS);
                        if (!result.stdout.includes('UNIFY_ANIM_RESULT ')) {
                            const failure = result.stdout.split(/\r?\n/).find(line => line.startsWith('UNIFY_ANIM_ERROR '));
                            throw new Error(failure ? failure.slice('UNIFY_ANIM_ERROR '.length) : `Blender (${blender}) did not finish (exit ${result.code}).\n${(result.stderr || result.stdout).slice(-2000)}`);
                        }
                        return report(result.stdout);
                    } finally {
                        await rm(script, { force: true }).catch(() => undefined);
                        await rm(paramsFile, { force: true }).catch(() => undefined);
                    }
                });
                return awaitJob(job, JOB_WAIT_MS);
            },
        },
        {
            name: 'job_status',
            description: 'Wait for or check a background job started by blender_export_animation (fbx mode) or blender_install_addon. Without jobId, lists recent jobs.',
            inputSchema: {
                type: 'object', properties: {
                    jobId: { type: 'string' },
                    waitSeconds: { type: 'integer', minimum: 0, maximum: 50, default: 40, description: 'How long to wait for the job to finish before returning.' },
                },
            },
            async run(args) {
                const id = optionalString(args, 'jobId');
                const wait = integer(args, 'waitSeconds', 40, 0, 50) * 1000;
                if (id === undefined) {
                    const jobs = [...state.jobs.values()];
                    if (!jobs.length) return 'No background jobs.';
                    return jobs.map(job => `${job.id}: ${job.label} | ${job.finishedAt ? (job.error !== undefined ? 'failed' : 'done') : `running ${Math.round((Date.now() - job.startedAt) / 1000)}s`}`).join('\n');
                }
                const job = state.jobs.get(id);
                if (!job) throw new Error(`No job ${id}. Jobs are forgotten 30 minutes after finishing or when the toolpack restarts; call without jobId to list them.`);
                return awaitJob(job, wait);
            },
        },
        {
            name: 'install_addon',
            description: 'Install (or update) the Unify Bridge add-on into Blender\'s user add-ons folder and enable it, using a headless Blender run. Finds Blender automatically (Program Files, Steam libraries, UNIFY_BLENDER_PATH), preferring the version of a connected session, unless blenderPath is given. Open Blender windows need a restart afterwards.',
            inputSchema: {
                type: 'object', properties: {
                    blenderPath: { type: 'string', description: 'Path to the Blender executable (blender or blender.exe).' },
                    enable: { type: 'boolean', default: true },
                },
            },
            async run(args, ctx) {
                const addonFile = join(ctx.dataDir, 'unify_bridge.py');
                await mkdir(ctx.dataDir, { recursive: true });
                await writeFile(addonFile, ADDON_SOURCE, 'utf8');
                const explicit = optionalString(args, 'blenderPath');
                let candidates = explicit !== undefined ? [blenderExecutable(explicit)] : await blenderCandidates();
                const manual = `Manual install: Blender > Edit > Preferences > Add-ons > dropdown (top right) > Install from Disk..., choose ${addonFile}, then enable "Unify Bridge".`;
                if (!candidates.length) return `Saved the add-on to ${addonFile}, but no Blender executable was found. Pass blenderPath or set UNIFY_BLENDER_PATH.\n${manual}`;
                if (explicit === undefined) {
                    // Install folders are named by major.minor ("Blender 4.2"); prefer the Blender the user has open.
                    const running = onlineSessions().map(session => /^(\d+\.\d+)/.exec(session.blender)?.[1]).filter((version): version is string => !!version);
                    const matching = candidates.filter(path => running.some(version => path.includes(version)));
                    if (matching.length) candidates = [...matching, ...candidates.filter(path => !matching.includes(path))];
                }
                const blender = candidates[0];
                const script = join(ctx.dataDir, 'install_addon.py');
                await writeFile(script, INSTALL_SOURCE, 'utf8');
                const enable = optionalBoolean(args, 'enable') ?? true;
                const job = startJob(`Add-on install into ${blender}`, async () => {
                    const result = await run(blender, ['--background', '--python', script, '--', addonFile, enable ? '1' : '0'], HEADLESS_TIMEOUT_MS);
                    const line = result.stdout.split(/\r?\n/).find(item => item.startsWith('UNIFY_INSTALL_RESULT '));
                    if (!line) throw new Error(`Blender (${blender}) did not finish the install (exit ${result.code}).\n${(result.stderr || result.stdout).slice(-2000)}\n${manual}`);
                    const info = JSON.parse(line.slice('UNIFY_INSTALL_RESULT '.length)) as { blender?: string; path?: string; enabled?: boolean; enableError?: string; error?: string };
                    if (info.error) throw new Error(`Install failed in Blender ${info.blender ?? ''}: ${info.error}\n${manual}`);
                    const lines = [`Installed Unify Bridge add-on v${ADDON_VERSION} for Blender ${info.blender} (${blender}) at ${info.path}.`];
                    if (enable) lines.push(info.enabled ? 'Enabled and saved in Blender preferences.' : `Could not enable it automatically${info.enableError ? ` (${info.enableError})` : ''}; enable "Unify Bridge" in Preferences > Add-ons.`);
                    if (candidates.length > 1) lines.push(`Other Blender installs found (pass blenderPath to install there too): ${candidates.slice(1).join(', ')}`);
                    if (onlineSessions().length) lines.push('Restart the Blender windows that are open now so they load this version. If one has "Auto-Save Preferences" on, quitting it can overwrite the enabled state; re-enable Unify Bridge there if it does not reconnect.');
                    else lines.push('Open Blender and it will connect automatically (check with blender_instances).');
                    return lines.join('\n');
                });
                return awaitJob(job, JOB_WAIT_MS);
            },
        },
    ],
};

export default pack;

const INSTALL_SOURCE = String.raw`import json
import os
import shutil
import sys

import addon_utils
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
source, enable = argv[0], argv[1] == "1"
result = {"blender": bpy.app.version_string}
try:
    folder = bpy.utils.user_resource("SCRIPTS", path="addons", create=True)
    target = os.path.join(folder, "unify_bridge.py")
    shutil.copyfile(source, target)
    result["path"] = target
    if enable:
        # A freshly created add-ons folder is not on sys.path until script paths are refreshed.
        bpy.utils.refresh_script_paths()
        addon_utils.modules(refresh=True)
        errors = []
        addon_utils.enable("unify_bridge", default_set=True, persistent=True, handle_error=lambda error: errors.append("%s: %s" % (type(error).__name__, error)))
        result["enabled"] = "unify_bridge" in bpy.context.preferences.addons
        if errors:
            result["enableError"] = errors[0]
        bpy.ops.wm.save_userpref()
except Exception as error:
    result["error"] = "%s: %s" % (type(error).__name__, error)
print("UNIFY_INSTALL_RESULT " + json.dumps(result))
sys.stdout.flush()
`;

/** Samples armature actions into unify-animation JSON. Runs inside a session (via execute) or headless (with ANIM_HEADLESS). */
const ANIM_SOURCE = String.raw`import json as _unify_json
import bpy as _unify_bpy
from mathutils import Matrix as _UnifyMatrix


def _unify_anim_export(armature=None, actions=None, frame_start=None, frame_end=None, step=1, fps=None, out=None, fbx=None):
    bpy = _unify_bpy
    scene = bpy.context.scene
    if armature:
        arm = bpy.data.objects.get(armature)
        if arm is None or arm.type != "ARMATURE":
            raise ValueError("No armature object named %r." % armature)
    else:
        arms = [obj for obj in scene.objects if obj.type == "ARMATURE"]
        if len(arms) != 1:
            raise ValueError("Found %d armatures (%s); pass armature." % (len(arms), ", ".join(obj.name for obj in arms) or "none"))
        arm = arms[0]
    anim = arm.animation_data or arm.animation_data_create()
    if actions:
        chosen = []
        for name in actions:
            action = bpy.data.actions.get(name) or next((item for item in bpy.data.actions if item.name.split("|")[-1] == name), None)
            if action is None:
                raise ValueError("No action %r. Actions: %s" % (name, ", ".join(item.name for item in bpy.data.actions)))
            chosen.append(action)
    elif fbx:
        # The FBX importer names takes "<object>|<take>"; prefer the ones that belong to this armature.
        chosen = [item for item in bpy.data.actions if item.name.startswith(arm.name + "|")] or list(bpy.data.actions)
    elif anim.action:
        chosen = [anim.action]
    else:
        chosen = []
    if not chosen:
        raise ValueError("No animation found on %s. Actions in file: %s" % (arm.name, ", ".join(item.name for item in bpy.data.actions) or "none"))

    # Blender is Z-up with +Y mapped to Roblox -Z (the roblox FBX preset's axes): (x, y, z) -> (x, z, -y).
    to_roblox = _UnifyMatrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))
    world_rot = arm.matrix_world.to_quaternion().to_matrix()
    s = arm.matrix_world.to_scale()
    meters = (abs(s.x) + abs(s.y) + abs(s.z)) / 3.0 * scene.unit_settings.scale_length
    bones = []
    for bone in arm.data.bones:
        rest = to_roblox @ world_rot @ bone.matrix_local.to_quaternion().to_matrix()
        offset = (bone.parent.matrix_local.inverted() @ bone.matrix_local).translation.length * meters if bone.parent else 0.0
        bones.append({"name": bone.name, "parent": bone.parent.name if bone.parent else None, "rest": [round(v, 6) for row in rest for v in row], "offset": round(offset, 6)})

    rate = fps or scene.render.fps / scene.render.fps_base
    old_action, old_frame = anim.action, scene.frame_current
    old_slot = getattr(anim, "action_slot", None)
    animations, summary = [], []
    try:
        for action in chosen:
            anim.action = action
            slots = getattr(action, "slots", None)
            if slots is not None and len(slots) and getattr(anim, "action_slot", None) is None:
                anim.action_slot = slots[0]
            start = frame_start if frame_start is not None else int(round(action.frame_range[0]))
            end = frame_end if frame_end is not None else int(round(action.frame_range[1]))
            if end < start:
                raise ValueError("frame range %d-%d is empty." % (start, end))
            frames = list(range(start, end + 1, step))
            if frames[-1] != end:
                frames.append(end)
            tracks = {bone.name: [] for bone in arm.data.bones}
            for frame in frames:
                scene.frame_set(frame)
                for pose_bone in arm.pose.bones:
                    bone = pose_bone.bone
                    if pose_bone.parent:
                        posed = pose_bone.parent.matrix.inverted() @ pose_bone.matrix
                        rest = bone.parent.matrix_local.inverted() @ bone.matrix_local
                    else:
                        posed, rest = pose_bone.matrix, bone.matrix_local
                    delta = rest.inverted() @ posed
                    t = delta.translation * meters
                    q = delta.to_3x3().normalized().to_quaternion()
                    tracks[bone.name].extend(round(v, 6) for v in (t.x, t.y, t.z, q.x, q.y, q.z, q.w))
            name = action.name.split("|")[-1]
            animations.append({"name": name, "action": action.name, "fps": rate, "frameStart": start, "frameEnd": end, "times": [round((frame - start) / rate, 5) for frame in frames], "tracks": tracks})
            summary.append({"name": name, "keys": len(frames), "seconds": (end - start) / rate, "fps": rate})
    finally:
        anim.action = old_action
        if old_slot is not None:
            try:
                anim.action_slot = old_slot
            except Exception:
                pass
        scene.frame_set(old_frame)

    data = {"format": "unify-animation", "version": 1, "source": fbx or bpy.data.filepath, "armature": arm.name, "bones": bones, "animations": animations}
    with open(out, "w", encoding="utf-8") as handle:
        _unify_json.dump(data, handle, separators=(",", ":"))
    print("UNIFY_ANIM_RESULT " + _unify_json.dumps({"armature": arm.name, "bones": len(bones), "animations": summary}))
`;

const ANIM_HEADLESS = String.raw`
import sys as _unify_sys

try:
    _params = _unify_json.load(open(_unify_sys.argv[_unify_sys.argv.index("--") + 1], encoding="utf-8"))
    for _obj in list(_unify_bpy.data.objects):
        _unify_bpy.data.objects.remove(_obj, do_unlink=True)
    _unify_bpy.ops.import_scene.fbx(filepath=_params["fbx"], use_anim=True)
    _unify_anim_export(**_params)
except Exception as _error:
    print("UNIFY_ANIM_ERROR %s: %s" % (type(_error).__name__, _error))
_unify_sys.stdout.flush()
`;

const ADDON_SOURCE = String.raw`bl_info = {
    "name": "Unify Bridge",
    "author": "Unify",
    "version": (1, 3, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > Unify",
    "description": "Lets Unify agents inspect and edit this Blender session",
    "category": "Development",
}

import ast
import base64
import contextlib
import fnmatch
import io
import json
import linecache
import os
import queue
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

import bmesh
import bpy
import mathutils
from mathutils import Matrix, Vector

ADDON_VERSION = 4
DISCOVERY_DIR = os.path.join(os.path.expanduser("~"), ".unify", "blender-bridge")
SESSION = uuid.uuid4().hex[:8]
MAX_TEXT = 50000
GEOMETRY = {"MESH", "CURVE", "SURFACE", "META", "FONT", "CURVES", "POINTCLOUD", "VOLUME", "GPENCIL", "GREASEPENCIL"}
MESHLIKE = {"MESH", "CURVE", "SURFACE", "META", "FONT"}

# Localhost only; skip any system proxy settings.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_inbox = queue.Queue()
_outbox = queue.Queue()
_run = {"stop": None}
_meta = {"session": SESSION, "pid": str(os.getpid()), "blender": bpy.app.version_string, "addon": str(ADDON_VERSION), "file": "", "dirty": "0", "scene": ""}
_meta_at = [0.0]
_meta_ready = threading.Event()
_pollers = {}
_connected = {}
_lock = threading.Lock()
_log = []
_partial = {"output": "", "error": ""}
_status = {"busy": "", "last": ""}
_streams = {}
# Epoch milliseconds after which the running command should stop starting new work (0 = none).
_deadline = [0]


# ---------------------------------------------------------------- console capture

def _append_log(level, text):
    with _lock:
        data = _partial[level] + text
        lines = data.split("\n")
        _partial[level] = lines.pop()
        now = time.time()
        for line in lines:
            if line.strip():
                _log.append((now, level, line.rstrip("\r")))
        if len(_log) > 2000:
            del _log[: len(_log) - 2000]


class _Tee:
    def __init__(self, stream, level):
        self._stream = stream
        self._level = level

    def write(self, text):
        try:
            if self._stream is not None:
                self._stream.write(text)
        except Exception:
            pass
        if isinstance(text, str):
            _append_log(self._level, text)
        return len(text)

    def flush(self):
        try:
            if self._stream is not None:
                self._stream.flush()
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._stream, name)


def _install_tee():
    if not isinstance(sys.stdout, _Tee):
        _streams["stdout"] = sys.stdout
        sys.stdout = _Tee(sys.stdout, "output")
    if not isinstance(sys.stderr, _Tee):
        _streams["stderr"] = sys.stderr
        sys.stderr = _Tee(sys.stderr, "error")


def _remove_tee():
    if isinstance(sys.stdout, _Tee) and "stdout" in _streams:
        sys.stdout = _streams.pop("stdout")
    if isinstance(sys.stderr, _Tee) and "stderr" in _streams:
        sys.stderr = _streams.pop("stderr")


# ---------------------------------------------------------------- transport (background threads)

def _request(pack, path, body=None, timeout=30.0):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request("http://127.0.0.1:%d%s" % (pack["port"], path), data=data, method="GET" if data is None else "POST")
    request.add_header("x-unify-token", pack["token"])
    if data is not None:
        request.add_header("content-type", "application/json")
    with _opener.open(request, timeout=timeout) as response:
        raw = response.read()
        if response.status == 204 or not raw:
            return None
        return json.loads(raw.decode("utf-8"))


def _poll_loop(key, pack, stop):
    failures = 0
    try:
        while not stop.is_set():
            try:
                command = _request(pack, "/poll?" + urllib.parse.urlencode(dict(_meta)), timeout=30.0)
                failures = 0
                _connected[key] = time.time()
                if isinstance(command, dict) and "id" in command and not stop.is_set():
                    _inbox.put((pack, command))
            except urllib.error.HTTPError as error:
                failures = 3 if error.code == 401 else failures + 1
            except Exception:
                failures += 1
            if failures:
                _connected.pop(key, None)
                if failures >= 3:
                    return
                stop.wait(1.0)
    finally:
        _connected.pop(key, None)
        with _lock:
            if _pollers.get(key) is threading.current_thread():
                del _pollers[key]


def _discover_loop(stop):
    # Let the main thread fill in file/scene before the first poll registers this session.
    _meta_ready.wait(5.0)
    while not stop.is_set():
        try:
            names = os.listdir(DISCOVERY_DIR)
        except OSError:
            names = []
        for name in names:
            if not name.endswith(".json"):
                continue
            path = os.path.join(DISCOVERY_DIR, name)
            try:
                # Only trust discovery files written by this user; anyone who can plant one could run code here.
                if hasattr(os, "getuid") and os.stat(path).st_uid != os.getuid():
                    continue
                with open(path, "r", encoding="utf-8") as handle:
                    info = json.load(handle)
                pack = {"port": int(info["port"]), "token": str(info["token"])}
            except Exception:
                continue
            key = (name, pack["port"], pack["token"])
            with _lock:
                if key in _pollers:
                    continue
                thread = threading.Thread(target=_poll_loop, args=(key, pack, stop), name="unify-bridge-poll", daemon=True)
                _pollers[key] = thread
            thread.start()
        stop.wait(2.0)


def _send_loop(stop):
    while not stop.is_set():
        try:
            pack, result = _outbox.get(timeout=0.5)
        except queue.Empty:
            continue
        if pack is None:
            # File saved or opened: tell every Unify window right away instead of waiting for the next poll.
            with _lock:
                packs = [{"port": key[1], "token": key[2]} for key in _pollers]
            for target in packs:
                try:
                    _request(target, "/meta?" + urllib.parse.urlencode(dict(_meta)), {}, timeout=5.0)
                except Exception:
                    pass
            continue
        path = "/started" if result.get("started") else "/result"
        for _attempt in range(3):
            try:
                _request(pack, path, result, timeout=30.0)
                break
            except Exception:
                stop.wait(0.5)


# ---------------------------------------------------------------- main thread

def _refresh_meta(force=False):
    now = time.monotonic()
    if not force and now - _meta_at[0] < 1.0:
        return
    _meta_at[0] = now
    try:
        scene = bpy.context.scene
        _meta["file"] = bpy.data.filepath
        _meta["dirty"] = "1" if bpy.data.is_dirty else "0"
        _meta["scene"] = scene.name if scene else ""
        _meta_ready.set()
    except Exception:
        pass


def _tick():
    if _run["stop"] is None:
        return None
    _refresh_meta()
    deadline = time.monotonic() + 0.25
    while time.monotonic() < deadline:
        try:
            pack, command = _inbox.get_nowait()
        except queue.Empty:
            break
        _outbox.put((pack, _dispatch(pack, command)))
    return 0.05


@bpy.app.handlers.persistent
def _file_changed(*_args):
    _refresh_meta(force=True)
    _outbox.put((None, None))


def _find_view3d():
    best = None
    for window in bpy.context.window_manager.windows:
        screen = window.screen
        if screen is None:
            continue
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            region = next((item for item in area.regions if item.type == "WINDOW"), None)
            if region is None:
                continue
            size = area.width * area.height
            if best is None or size > best[3]:
                best = (window, area, region, size)
    return best[:3] if best else None


@contextlib.contextmanager
def _context():
    found = _find_view3d()
    if found:
        window, area, region = found
        with bpy.context.temp_override(window=window, screen=window.screen, area=area, region=region):
            yield found
        return
    windows = bpy.context.window_manager.windows
    if len(windows):
        with bpy.context.temp_override(window=windows[0], screen=windows[0].screen):
            yield None
        return
    yield None


def _dispatch(pack, command):
    command_id = command.get("id")
    op = command.get("op")
    args = command.get("args") or {}
    handler = _OPS.get(op)
    if handler is None:
        return {"id": command_id, "ok": False, "error": "Unknown op %r; run blender_install_addon and restart Blender." % op}
    deadline = command.get("deadline") or 0
    if deadline and time.time() * 1000.0 > deadline:
        # Unify already told the agent this command timed out; running it now would surprise everyone.
        return {"id": command_id, "ok": False, "expired": True, "error": "Expired before Blender could start it; not run."}
    if pack is not None:
        _outbox.put((pack, {"id": command_id, "started": True}))
    _status["busy"] = op
    _deadline[0] = deadline
    started = time.perf_counter()
    try:
        with _context():
            data = handler(args)
        _status["last"] = "%s ok (%.2fs)" % (op, time.perf_counter() - started)
        return {"id": command_id, "ok": True, "data": data}
    except Exception as error:
        _status["last"] = "%s failed" % op
        return {"id": command_id, "ok": False, "error": "%s: %s" % (type(error).__name__, error)}
    finally:
        _status["busy"] = ""
        _deadline[0] = 0
        _redraw_panels()


def _time_left():
    """Seconds until the running command's deadline (large when there is none)."""
    return (_deadline[0] / 1000.0 - time.time()) if _deadline[0] else 1e9


def _redraw_panels():
    try:
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
    except Exception:
        pass


# ---------------------------------------------------------------- helpers

def _clip(text, limit=MAX_TEXT):
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated %d characters]" % (len(text) - limit)


def _clip_tail(text, limit):
    # Tracebacks end with the actual error, so keep the end.
    if len(text) <= limit:
        return text
    return "[%d earlier characters truncated]...\n" % (len(text) - limit) + text[-limit:]


def _undo(message):
    try:
        bpy.ops.ed.undo_push(message=message)
    except Exception:
        pass


def _scene(name=None):
    if name:
        scene = bpy.data.scenes.get(name)
        if scene is None:
            raise ValueError("No scene named %r. Scenes: %s" % (name, ", ".join(item.name for item in bpy.data.scenes)))
        return scene
    return bpy.context.scene


def _view_layer(scene):
    if scene == bpy.context.scene and bpy.context.view_layer is not None:
        return bpy.context.view_layer
    return scene.view_layers[0]


def _targets(target, scene):
    if isinstance(target, str):
        target = [target]
    objects = []
    for name in target or []:
        if name == "$selection":
            objects.extend(bpy.context.selected_objects)
        elif name == "$all":
            objects.extend(scene.objects)
        else:
            obj = bpy.data.objects.get(name)
            if obj is not None:
                objects.append(obj)
                continue
            collection = bpy.data.collections.get(name)
            if collection is None:
                raise ValueError("No object or collection named %r." % name)
            objects.extend(collection.all_objects)
    seen = set()
    unique = []
    for obj in objects:
        if obj.name not in seen:
            seen.add(obj.name)
            unique.append(obj)
    return unique


def _default_objects(scene, types):
    selected = [obj for obj in bpy.context.selected_objects if obj.type in types]
    if selected:
        return selected
    return _visible_objects(scene, types)


def _visible_objects(scene, types):
    visible = []
    view_layer = _view_layer(scene)
    for obj in scene.objects:
        if obj.type not in types:
            continue
        try:
            if not obj.visible_get(view_layer=view_layer):
                continue
        except Exception:
            pass
        visible.append(obj)
    return visible


def _num(value):
    return "%.6g" % value


def _fmt(value):
    if value is None:
        return "None"
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float):
        return _num(value)
    if isinstance(value, (int, str)):
        return repr(value)
    if isinstance(value, Matrix):
        return "Matrix(" + ", ".join("(" + ", ".join(_num(x) for x in row) + ")" for row in value) + ")"
    if isinstance(value, (Vector, mathutils.Euler, mathutils.Quaternion, mathutils.Color)):
        return type(value).__name__ + "(" + ", ".join(_num(x) for x in value) + ")"
    if isinstance(value, bpy.types.ID):
        return "%s %r" % (value.bl_rna.identifier, value.name)
    if isinstance(value, bpy.types.bpy_prop_collection):
        count = len(value)
        names = []
        for index, item in enumerate(value):
            if index >= 20:
                break
            names.append(repr(getattr(item, "name", None) or getattr(item, "identifier", None) or "<%s>" % item.bl_rna.identifier))
        return "[%d items%s]" % (count, (": " + ", ".join(names) + (", ..." if count > 20 else "")) if names else "")
    if hasattr(value, "bl_rna"):
        return "<%s>" % value.bl_rna.identifier
    try:
        items = list(value)
        if len(items) <= 64 and all(isinstance(item, (int, float, bool)) for item in items):
            return "(" + ", ".join(_num(item) if isinstance(item, float) else str(item) for item in items) + ")"
    except Exception:
        pass
    return _clip(repr(value), 300)


# ---------------------------------------------------------------- ops

def op_execute(args):
    code = args.get("code")
    if not isinstance(code, str) or not code.strip():
        raise ValueError("code must be a non-empty string.")
    filename = "<unify>"
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    namespace = {"__name__": "__unify__", "bpy": bpy, "bmesh": bmesh, "mathutils": mathutils, "Vector": Vector, "Matrix": Matrix, "C": bpy.context, "D": bpy.data}
    try:
        tree = ast.parse(code, filename, "exec")
    except SyntaxError:
        return {"output": "", "value": None, "error": traceback.format_exc(limit=0)}
    tail = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(tree.body.pop().value)
    output = io.StringIO()
    value = None
    error = None
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        try:
            exec(compile(tree, filename, "exec"), namespace)
            if tail is not None:
                value = eval(compile(tail, filename, "eval"), namespace)
        except BaseException:
            kind, exc, tb = sys.exc_info()
            error = "".join(traceback.format_exception(kind, exc, tb.tb_next if tb else None))
    _undo("Unify: execute")
    # Keep the total well under Unify's 60,000-character tool output limit so tracebacks survive.
    return {
        "output": _clip(output.getvalue().rstrip(), 25000),
        "value": None if value is None else _clip(repr(value), 8000),
        "error": _clip_tail(error, 8000) if error else None,
    }


def _object_label(obj, view_layer):
    flags = []
    try:
        if obj.select_get(view_layer=view_layer):
            flags.append("selected")
        if not obj.visible_get(view_layer=view_layer):
            flags.append("hidden")
    except Exception:
        pass
    if view_layer.objects.active == obj:
        flags.append("active")
    if obj.type == "MESH" and obj.data is not None:
        flags.append("%d faces" % len(obj.data.polygons))
    if len(obj.modifiers):
        names = [modifier.name for modifier in obj.modifiers]
        flags.append("modifiers: " + ", ".join(names[:6]) + (", ..." if len(names) > 6 else ""))
    return "%s [%s]%s" % (obj.name, obj.type, (" (" + "; ".join(flags) + ")") if flags else "")


def op_tree(args):
    scene = _scene(args.get("scene"))
    view_layer = _view_layer(scene)
    depth = int(args.get("depth", 4))
    limit = int(args.get("maxNodes", 300))
    lines = []
    truncated = [False]

    def emit(level, text):
        if len(lines) >= limit:
            truncated[0] = True
            return False
        lines.append("  " * level + text)
        return True

    def walk_object(obj, level, members):
        if not emit(level, _object_label(obj, view_layer)):
            return
        children = sorted((child for child in obj.children if child.name in members), key=lambda item: item.name)
        if not children:
            return
        if level >= depth:
            lines[-1] += " (+%d children)" % len(children)
            return
        for child in children:
            walk_object(child, level + 1, members)

    def walk_collection(collection, level):
        if not emit(level, "%s/ [COLLECTION]" % collection.name):
            return
        objects = list(collection.objects)
        members = {obj.name for obj in objects}
        roots = sorted((obj for obj in objects if obj.parent is None or obj.parent.name not in members), key=lambda item: item.name)
        children = list(collection.children)
        if level >= depth:
            if roots or children:
                lines[-1] += " (+%d items)" % (len(roots) + len(children))
            return
        for obj in roots:
            walk_object(obj, level + 1, members)
        for child in children:
            walk_collection(child, level + 1)

    root = args.get("root")
    if root:
        collection = bpy.data.collections.get(root)
        if collection is not None:
            walk_collection(collection, 0)
        else:
            obj = bpy.data.objects.get(root)
            if obj is None:
                raise ValueError("No collection or object named %r." % root)
            walk_object(obj, 0, {item.name for item in bpy.data.objects})
    else:
        units = scene.unit_settings
        lines.append("Scene %r | frame %d (%d-%d) | units %s, scale %s | file %s" % (
            scene.name, scene.frame_current, scene.frame_start, scene.frame_end, units.system, _num(units.scale_length), bpy.data.filepath or "(unsaved)"))
        walk_collection(scene.collection, 0)
    if truncated[0]:
        lines.append("Listing truncated at %d nodes; pass root or lower depth." % limit)
    return {"text": "\n".join(lines)}


def _matcher(pattern):
    if not pattern:
        return lambda name: True
    pattern = pattern.lower()
    if any(char in pattern for char in "*?["):
        return lambda name: fnmatch.fnmatchcase(name.lower(), pattern)
    return lambda name: pattern in name.lower()


def op_find(args):
    kind = args.get("kind") or "objects"
    limit = int(args.get("limit", 100))
    name_ok = _matcher(args.get("name"))
    if kind != "objects":
        pool = getattr(bpy.data, kind, None)
        if not isinstance(pool, bpy.types.bpy_prop_collection):
            raise ValueError("Unknown bpy.data collection %r." % kind)
        matches = [item for item in pool if name_ok(item.name)]
        lines = ["%s [%s] users=%d%s" % (item.name, item.bl_rna.identifier, item.users, " (linked)" if item.library else "") for item in matches[:limit]]
    else:
        scene = _scene(args.get("scene")) if args.get("scene") else None
        pool = scene.objects if scene else bpy.data.objects
        object_type = (args.get("type") or "").upper()
        material_ok = _matcher(args.get("material")) if args.get("material") else None
        modifier = (args.get("modifier") or "").lower()
        allowed = None
        if args.get("collection"):
            collection = bpy.data.collections.get(args["collection"])
            if collection is None:
                raise ValueError("No collection named %r." % args["collection"])
            allowed = {obj.name for obj in collection.all_objects}
        selected = args.get("selected")
        matches = []
        for obj in pool:
            if not name_ok(obj.name) or (object_type and obj.type != object_type):
                continue
            if material_ok and not any(slot.material and material_ok(slot.material.name) for slot in obj.material_slots):
                continue
            if modifier and not any(modifier in item.name.lower() or modifier == item.type.lower() for item in obj.modifiers):
                continue
            if allowed is not None and obj.name not in allowed:
                continue
            if selected is not None:
                try:
                    if obj.select_get() != bool(selected):
                        continue
                except Exception:
                    continue
            matches.append(obj)
        lines = ["%s [%s] in %s" % (obj.name, obj.type, ", ".join(item.name for item in obj.users_collection) or "-") for obj in matches[:limit]]
    # data lets a Unify batch chain the names, e.g. "{{1.names}}" as another tool's target.
    data = {"names": [item.name for item in matches[:limit]], "total": len(matches)}
    if not lines:
        return {"text": "No matches.", "data": data}
    if len(matches) > limit:
        lines.append("... and %d more (raise limit or narrow the search)" % (len(matches) - limit))
    return {"text": "\n".join(lines), "data": data}


_PATH_TOKEN = re.compile(r"""\s*(?:\.?([A-Za-z_][A-Za-z0-9_]*)|\[\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(-?\d+))\s*\])""")


def _resolve_path(path):
    # Parsed by hand rather than eval'd, so this read/write tool cannot run arbitrary Python.
    path = path.strip()
    if path in bpy.data.objects:
        return bpy.data.objects[path], "bpy.data.objects[%r]" % path
    hint = "Use an object name or a path like objects['Cube'].modifiers['Bevel'], materials['Mat'] or bpy.context.scene.render."
    for prefix, root in (("bpy.data", bpy.data), ("bpy.context", bpy.context), ("D", bpy.data), ("C", bpy.context)):
        if path == prefix or path.startswith(prefix + ".") or path.startswith(prefix + "["):
            rest, value, expression = path[len(prefix):], root, prefix
            break
    else:
        rest, value, expression = "." + path, bpy.data, "bpy.data"
    position = 0
    while position < len(rest):
        match = _PATH_TOKEN.match(rest, position)
        if match is None or match.end() == position:
            raise ValueError("Could not parse %r near %r. %s" % (path, rest[position:position + 20], hint))
        position = match.end()
        attribute, double, single, index = match.groups()
        try:
            if attribute is not None:
                if attribute.startswith("_"):
                    raise ValueError("private attributes are not allowed")
                value = getattr(value, attribute)
                expression += "." + attribute
            elif index is not None:
                value = value[int(index)]
                expression += "[%s]" % index
            else:
                key = (double if double is not None else single).replace("\\\"", "\"").replace("\\'", "'")
                value = value[key]
                expression += "[%r]" % key
        except Exception as error:
            raise ValueError("Could not resolve %r at %s (%s: %s). %s" % (path, expression, type(error).__name__, error, hint))
        if callable(value) and not hasattr(value, "bl_rna"):
            raise ValueError("%s is a function; this tool only reads and writes properties. Use blender_execute to call it." % expression)
    return value, expression


def _lookup_id(fixed_type, name):
    cls = getattr(bpy.types, fixed_type.identifier, None) if fixed_type else None
    for prop in bpy.data.bl_rna.properties:
        if prop.type != "COLLECTION":
            continue
        try:
            item = getattr(bpy.data, prop.identifier).get(name)
        except Exception:
            continue
        if item is not None and (cls is None or isinstance(item, cls)):
            return item
    raise ValueError("No %s named %r." % (fixed_type.identifier if fixed_type else "data-block", name))


def _assign(target, key, raw):
    prop = target.bl_rna.properties.get(key)
    if prop is not None and prop.type == "POINTER" and (raw is None or isinstance(raw, str)):
        value = None if raw is None else _lookup_id(prop.fixed_type, raw)
    else:
        value = raw
    setattr(target, key, value)


def op_properties(args):
    target, expression = _resolve_path(args.get("path") or "")
    if not hasattr(target, "bl_rna"):
        return {"text": "%s = %s" % (expression, _fmt(target))}
    updates = args.get("set") or {}
    changed = []
    for key, raw in updates.items():
        try:
            _assign(target, key, raw)
        except Exception as error:
            if changed:
                _undo("Unify: set properties")
            raise ValueError("Setting %s failed (%s: %s). Already set: %s" % (key, type(error).__name__, error, ", ".join(changed) or "nothing"))
        changed.append(key)
    if changed:
        _undo("Unify: set properties")
    rna = target.bl_rna
    lines = ["%s [%s]" % (expression, rna.identifier)]
    if changed:
        lines.append("Set: " + ", ".join(changed))
    wanted = args.get("properties") or changed
    if wanted:
        for name in wanted:
            try:
                lines.append("  %s = %s" % (name, _fmt(getattr(target, name))))
            except AttributeError:
                lines.append("  %s: no such property" % name)
    else:
        for prop in rna.properties:
            if prop.identifier == "rna_type":
                continue
            try:
                value = _fmt(getattr(target, prop.identifier))
            except Exception as error:
                value = "<error: %s>" % error
            line = "  %s = %s" % (prop.identifier, value)
            if prop.is_readonly and prop.type not in ("POINTER", "COLLECTION"):
                line += "  [readonly]"
            lines.append(line)
        try:
            keys = [key for key in target.keys() if not key.startswith("_")]
        except Exception:
            keys = []
        if keys:
            lines.append("Custom properties:")
            for key in keys:
                lines.append("  [%r] = %s" % (key, _clip(repr(target[key]), 300)))
    return {"text": _clip("\n".join(lines))}


def op_selection(args):
    view_layer = bpy.context.view_layer
    lines = []
    if args.get("action") == "set":
        names = args.get("objects") or []
        wanted = set(names)
        missing = [name for name in names if view_layer.objects.get(name) is None]
        for obj in view_layer.objects:
            try:
                obj.select_set(obj.name in wanted)
            except Exception:
                pass
        active = args.get("active") or next((name for name in names if name not in missing), None)
        if active:
            obj = view_layer.objects.get(active)
            if obj is None:
                missing.append(active)
            else:
                view_layer.objects.active = obj
        _undo("Unify: select")
        if missing:
            lines.append("Not in the view layer: " + ", ".join(missing))
    selected = [obj.name for obj in view_layer.objects if obj.select_get()]
    active = view_layer.objects.active
    lines.insert(0, "Mode: %s" % bpy.context.mode)
    lines.insert(1, "Active: %s" % ("%s [%s]" % (active.name, active.type) if active else "None"))
    lines.insert(2, "Selected (%d): %s" % (len(selected), ", ".join(selected[:200]) + (" ..." if len(selected) > 200 else "") if selected else "nothing"))
    if active is not None and active.mode == "EDIT" and active.type == "MESH":
        mesh = bmesh.from_edit_mesh(active.data)
        lines.append("Edit mesh selection: %d verts, %d edges, %d faces" % (
            sum(1 for item in mesh.verts if item.select), sum(1 for item in mesh.edges if item.select), sum(1 for item in mesh.faces if item.select)))
    return {"text": "\n".join(lines)}


PRESET_VIEWS = {
    "front": ((0, -1, 0), (0, 0, 1)),
    "back": ((0, 1, 0), (0, 0, 1)),
    "right": ((1, 0, 0), (0, 0, 1)),
    "left": ((-1, 0, 0), (0, 0, 1)),
    "top": ((0, 0, 1), (0, 1, 0)),
    "bottom": ((0, 0, -1), (0, -1, 0)),
    "iso": ((1, -1, 0.8), (0, 0, 1)),
}


def _look_at(eye, center, up):
    forward = (center - eye).normalized()
    side = forward.cross(up).normalized()
    upward = side.cross(forward)
    return Matrix((
        (side.x, side.y, side.z, -side.dot(eye)),
        (upward.x, upward.y, upward.z, -upward.dot(eye)),
        (-forward.x, -forward.y, -forward.z, forward.dot(eye)),
        (0.0, 0.0, 0.0, 1.0),
    ))


def _ortho(half_width, half_height, near, far):
    return Matrix((
        (1.0 / half_width, 0.0, 0.0, 0.0),
        (0.0, 1.0 / half_height, 0.0, 0.0),
        (0.0, 0.0, -2.0 / (far - near), -(far + near) / (far - near)),
        (0.0, 0.0, 0.0, 1.0),
    ))


def _fit(width, height, size):
    scale = size / float(max(width, height, 1))
    return max(16, int(round(width * scale))), max(16, int(round(height * scale)))


def _bounds(objects):
    points = []
    for obj in objects:
        try:
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
        except Exception:
            points.append(obj.matrix_world.translation.copy())
    if not points:
        return Vector((0.0, 0.0, 0.0)), 1.0
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return (low + high) / 2.0, max((high - low).length / 2.0, 0.01)


def _pixels(buffer, size):
    try:
        data = memoryview(buffer).tobytes()
        if len(data) == size:
            return data
    except Exception:
        pass
    import numpy
    return numpy.array(buffer.to_list(), dtype=numpy.uint8).reshape(-1).tobytes()


def _draw(jobs, scene, view_layer, space, region):
    import gpu
    results = []
    for name, view_matrix, projection, width, height in jobs:
        offscreen = gpu.types.GPUOffScreen(width, height)
        try:
            offscreen.draw_view3d(scene, view_layer, space, region, view_matrix, projection, do_color_management=True)
            with offscreen.bind():
                framebuffer = gpu.state.active_framebuffer_get()
                buffer = framebuffer.read_color(0, 0, width, height, 4, 0, "UBYTE")
        finally:
            offscreen.free()
        results.append({"view": name, "width": width, "height": height, "pixels": base64.b64encode(_pixels(buffer, width * height * 4)).decode("ascii")})
    return results


def _draw_in_handler(jobs, scene, view_layer, space, region):
    # Fallback: draw from inside a viewport draw callback, where a GPU context is guaranteed.
    state = {"results": None, "error": None}

    def callback():
        if state["results"] is not None or state["error"] is not None:
            return
        try:
            state["results"] = _draw(jobs, scene, view_layer, space, region)
        except Exception as error:
            state["error"] = error

    handle = bpy.types.SpaceView3D.draw_handler_add(callback, (), "WINDOW", "POST_PIXEL")
    try:
        bpy.ops.wm.redraw_timer(type="DRAW_WIN", iterations=1)
    finally:
        bpy.types.SpaceView3D.draw_handler_remove(handle, "WINDOW")
    if state["error"] is not None:
        raise state["error"]
    if state["results"] is None:
        raise RuntimeError("The 3D Viewport did not redraw; is the Blender window minimized?")
    return state["results"]


def op_capture_view(args):
    found = _find_view3d()
    if not found:
        raise RuntimeError("No 3D Viewport is open in this Blender session. Open one (for example the Layout workspace) and retry.")
    _window, area, region = found
    space = area.spaces.active
    scene = bpy.context.scene
    view_layer = bpy.context.view_layer
    target = args.get("target")
    views = args.get("views") or (["front", "right", "top", "iso"] if target else ["current"])
    for name in views:
        if name not in PRESET_VIEWS and name not in ("current", "camera"):
            raise ValueError("Unknown view %r." % name)
    size = int(args.get("size") or (768 if len(views) == 1 else 512))
    padding = float(args.get("padding") or 1.1)
    objects = _targets(target, scene) if target else _default_objects(scene, GEOMETRY)
    center, radius = _bounds(objects)
    jobs = []
    for name in views:
        if name == "current":
            region_3d = space.region_3d
            width, height = _fit(region.width, region.height, size)
            jobs.append((name, region_3d.view_matrix.copy(), region_3d.window_matrix.copy(), width, height))
        elif name == "camera":
            camera = scene.camera
            if camera is None:
                raise ValueError("The scene has no active camera.")
            render = scene.render
            width, height = _fit(render.resolution_x * render.pixel_aspect_x, render.resolution_y * render.pixel_aspect_y, size)
            projection = camera.calc_matrix_camera(bpy.context.evaluated_depsgraph_get(), x=width, y=height, scale_x=render.pixel_aspect_x, scale_y=render.pixel_aspect_y)
            jobs.append((name, camera.matrix_world.inverted(), projection, width, height))
        else:
            direction, up = PRESET_VIEWS[name]
            distance = radius * 4.0
            eye = center + Vector(direction).normalized() * distance
            half = radius * padding
            jobs.append((name, _look_at(eye, center, Vector(up)), _ortho(half, half, distance - radius * 2.0, distance + radius * 2.0), size, size))
    shading = space.shading
    overlay = space.overlay
    old_shading, old_overlays = shading.type, overlay.show_overlays
    try:
        if args.get("shading"):
            shading.type = str(args["shading"]).upper()
        overlay.show_overlays = bool(args.get("overlays", False))
        try:
            results = _draw(jobs, scene, view_layer, space, region)
        except Exception:
            results = _draw_in_handler(jobs, scene, view_layer, space, region)
        used = shading.type
    finally:
        shading.type = old_shading
        overlay.show_overlays = old_overlays
    return {
        "views": results,
        "shading": used,
        "framed": [obj.name for obj in objects[:30]] + (["... %d more" % (len(objects) - 30)] if len(objects) > 30 else []),
        "center": [round(value, 4) for value in center],
        "radius": round(radius, 4),
    }


def op_output_log(args):
    level = args.get("level") or "all"
    contains = (args.get("contains") or "").lower()
    limit = int(args.get("limit") or 200)
    since = args.get("sinceTimestamp")
    with _lock:
        entries = list(_log)
        if args.get("clear"):
            del _log[:]
    rows = [entry for entry in entries if (level == "all" or entry[1] == level) and (not contains or contains in entry[2].lower()) and (since is None or entry[0] > since)]
    lines = ["[%s] %s %s" % (time.strftime("%H:%M:%S", time.localtime(stamp)), kind.upper(), text) for stamp, kind, text in rows[-limit:]]
    if len(rows) > limit:
        lines.insert(0, "(%d older entries omitted)" % (len(rows) - limit))
    lines.append("now=%.3f" % time.time())
    return {"text": _clip("\n".join(lines) if rows else "No log entries.\nnow=%.3f" % time.time())}


def _mesh_stats(bm, check_doubles):
    stats = {"verts": len(bm.verts), "edges": len(bm.edges), "faces": len(bm.faces)}
    stats["tris"] = sum(len(face.verts) - 2 for face in bm.faces)
    stats["ngons"] = sum(1 for face in bm.faces if len(face.verts) > 4)
    boundary = wire = nonmanifold = flipped = 0
    for edge in bm.edges:
        count = len(edge.link_faces)
        if count == 0:
            wire += 1
        elif count == 1:
            boundary += 1
        elif count > 2:
            nonmanifold += 1
        else:
            first, second = edge.link_loops
            if first.vert == second.vert:
                flipped += 1
    stats.update(boundary=boundary, wire=wire, nonmanifold=nonmanifold, flipped=flipped)
    stats["loose_verts"] = sum(1 for vert in bm.verts if not vert.link_edges)
    stats["degenerate"] = sum(1 for face in bm.faces if face.calc_area() < 1e-12)
    stats["uv_maps"] = len(bm.loops.layers.uv)
    if check_doubles:
        stats["doubles"] = len(bmesh.ops.find_doubles(bm, verts=list(bm.verts), dist=1e-5)["targetmap"])
    return stats


def _roblox_issues(obj, stats):
    issues = []
    if stats["tris"] > 20000:
        issues.append("%d triangles exceeds the Roblox MeshPart limit of 20,000" % stats["tris"])
    if stats["uv_maps"] > 1:
        issues.append("%d UV maps; Roblox only uses the first (active render) one" % stats["uv_maps"])
    if obj.type == "MESH" and obj.data is not None and len(obj.vertex_groups):
        bones = set()
        for modifier in obj.modifiers:
            if modifier.type == "ARMATURE" and modifier.object is not None and modifier.object.type == "ARMATURE":
                bones.update(bone.name for bone in modifier.object.data.bones)
        if bones:
            deform = {group.index for group in obj.vertex_groups if group.name in bones}
            over = sum(1 for vert in obj.data.vertices if sum(1 for item in vert.groups if item.group in deform and item.weight > 0.0) > 4)
            if over:
                issues.append("%d vertices are weighted to more than 4 bones; Roblox keeps 4 influences per vertex (Weights > Limit Total)" % over)
    large = set()
    for slot in obj.material_slots:
        material = slot.material
        if material is None or not material.use_nodes or material.node_tree is None:
            continue
        for node in material.node_tree.nodes:
            image = getattr(node, "image", None) if node.type == "TEX_IMAGE" else None
            if image is not None and max(image.size[0], image.size[1]) > 1024:
                large.add("%s (%dx%d)" % (image.name, image.size[0], image.size[1]))
    if large:
        issues.append("textures over 1024 px, which Roblox downscales: " + ", ".join(sorted(large)[:10]))
    return issues


def op_mesh_check(args):
    scene = bpy.context.scene
    target = args.get("target")
    # No selection fallback: the selection is shared with the user and other agents.
    objects = _targets(target, scene) if target else _visible_objects(scene, MESHLIKE)
    objects = [obj for obj in objects if obj.type in MESHLIKE]
    if not objects:
        raise ValueError("No mesh objects to check. Pass target names, $selection or $all.")
    profile = args.get("profile") or "generic"
    evaluated = args.get("evaluated", True)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lines = []
    total = 0
    for obj in objects[:50]:
        if obj.mode == "EDIT":
            obj.update_from_editmode()
        source = obj.evaluated_get(depsgraph) if evaluated else obj
        bm = bmesh.new()
        try:
            bm.from_mesh(source.to_mesh())
        finally:
            source.to_mesh_clear()
        try:
            stats = _mesh_stats(bm, len(bm.verts) <= 100000)
        finally:
            bm.free()
        total += stats["tris"]
        slots = obj.material_slots
        empty_slots = sum(1 for slot in slots if slot.material is None)
        dims = obj.dimensions
        lines.append("%s [%s%s]: %d verts, %d faces, %d tris, %d n-gons | UV maps: %d | material slots: %d | size %s x %s x %s" % (
            obj.name, obj.type, ", with modifiers" if evaluated and len(obj.modifiers) else "", stats["verts"], stats["faces"], stats["tris"], stats["ngons"],
            stats["uv_maps"], len(slots), _num(dims.x), _num(dims.y), _num(dims.z)))
        issues = []
        if stats["nonmanifold"]:
            issues.append("%d non-manifold edges (shared by 3+ faces)" % stats["nonmanifold"])
        if stats["flipped"]:
            issues.append("%d edges between faces with opposite winding (inconsistent normals; try Mesh > Normals > Recalculate Outside)" % stats["flipped"])
        if stats["boundary"]:
            issues.append("%d open (boundary) edges - mesh is not watertight" % stats["boundary"])
        if stats["wire"]:
            issues.append("%d loose edges without faces" % stats["wire"])
        if stats["loose_verts"]:
            issues.append("%d loose vertices" % stats["loose_verts"])
        if stats.get("doubles"):
            issues.append("%d overlapping vertices (Merge by Distance)" % stats["doubles"])
        if "doubles" not in stats:
            issues.append("duplicate-vertex check skipped (mesh too large)")
        if stats["degenerate"]:
            issues.append("%d zero-area faces" % stats["degenerate"])
        if not stats["uv_maps"]:
            issues.append("no UV map")
        if not len(slots):
            issues.append("no material")
        elif empty_slots:
            issues.append("%d empty material slots" % empty_slots)
        if obj.matrix_world.determinant() < 0:
            issues.append("negative scale - normals flip on export; apply scale")
        elif any(abs(value - 1.0) > 1e-4 for value in obj.scale):
            issues.append("unapplied scale %s (Ctrl+A > Scale before export)" % _fmt(obj.scale))
        # Skinned meshes follow their armature, and quaternion/axis-angle objects do not use rotation_euler.
        skinned = obj.parent is not None and obj.parent.type == "ARMATURE"
        if not skinned and obj.rotation_mode not in ("QUATERNION", "AXIS_ANGLE") and any(abs(value) > 1e-4 for value in obj.rotation_euler):
            issues.append("unapplied rotation %s" % _fmt(obj.rotation_euler))
        if profile == "roblox":
            issues.extend(_roblox_issues(obj, stats))
        lines.extend("  - " + issue for issue in issues) if issues else lines.append("  OK")
    if len(objects) > 50:
        lines.append("... %d more objects not checked; pass target to narrow." % (len(objects) - 50))
    lines.append("Total triangles: %d" % total)
    return {"text": "\n".join(lines)}


def _prop_line(prop):
    kind = prop.type
    if kind in ("POINTER", "COLLECTION") and prop.fixed_type is not None:
        kind += "(%s)" % prop.fixed_type.identifier
    length = getattr(prop, "array_length", 0)
    if length:
        kind += "[%d]" % length
    if prop.type == "ENUM":
        items = [item.identifier for item in prop.enum_items]
        kind += " {%s}" % ("|".join(items[:40]) + ("|..." if len(items) > 40 else "") if items else "dynamic")
        if prop.is_enum_flag:
            kind += " (set)"
    default = ""
    if prop.type in ("BOOLEAN", "INT", "FLOAT", "STRING", "ENUM") and not length and not getattr(prop, "is_enum_flag", False):
        try:
            default = " = %r" % (prop.default,)
        except Exception:
            pass
    flags = " [readonly]" if prop.is_readonly and prop.type not in ("POINTER", "COLLECTION") else ""
    return "%s: %s%s%s%s" % (prop.identifier, kind, default, flags, (" - " + prop.description) if prop.description else "")


def _func_line(func):
    inputs = [param for param in func.parameters if not param.is_output]
    outputs = [param for param in func.parameters if param.is_output]
    signature = ", ".join(param.identifier + ("" if param.is_required else "=...") for param in inputs)
    returns = ", ".join("%s: %s" % (param.identifier, param.type) for param in outputs)
    return "%s(%s)%s%s" % (func.identifier, signature, (" -> " + returns) if returns else "", (" - " + func.description) if func.description else "")


def _op_exists(module, name):
    return module in dir(bpy.ops) and name in dir(getattr(bpy.ops, module))


def _describe_op(module, name):
    op = getattr(getattr(bpy.ops, module), name)
    rna = op.get_rna_type()
    lines = ["bpy.ops.%s.%s - %s" % (module, name, rna.description or "(no description)")]
    try:
        lines.append("poll() in the current context: %s" % op.poll())
    except Exception as error:
        lines.append("poll() failed: %s" % error)
    params = [prop for prop in rna.properties if prop.identifier != "rna_type"]
    lines.append("Parameters:" if params else "No parameters.")
    lines.extend("  " + _prop_line(prop) for prop in params)
    return "\n".join(lines)


def _describe_type(cls, member, brief=False):
    rna = cls.bl_rna
    if member:
        prop = rna.properties.get(member)
        if prop is not None:
            text = "bpy.types.%s.%s\n%s" % (rna.identifier, member, _prop_line(prop))
            if prop.type in ("POINTER", "COLLECTION") and prop.fixed_type is not None:
                text += "\nSee bpy.types.%s for its members." % prop.fixed_type.identifier
                srna = getattr(prop, "srna", None)
                if srna is not None:
                    text += "\nCollection API type: %s (functions: %s)" % (srna.identifier, ", ".join(func.identifier for func in srna.functions) or "none")
            return text
        func = rna.functions.get(member)
        if func is not None:
            lines = ["bpy.types.%s.%s" % (rna.identifier, _func_line(func))]
            lines.extend("  %s%s" % ("returns " if param.is_output else "", _prop_line(param)) for param in func.parameters)
            return "\n".join(lines)
        attribute = getattr(cls, member, None)
        if attribute is not None:
            return "bpy.types.%s.%s (Python-defined)\n%s" % (rna.identifier, member, (getattr(attribute, "__doc__", None) or "").strip() or "(no docstring)")
        raise ValueError("bpy.types.%s has no member %r." % (rna.identifier, member))
    base = rna.base.identifier if rna.base is not None else None
    lines = ["bpy.types.%s%s - %s" % (rna.identifier, (" (inherits %s)" % base) if base else "", rna.description or "(no description)")]
    props = [prop for prop in rna.properties if prop.identifier != "rna_type"]
    if brief:
        lines.append("Properties: " + ", ".join(prop.identifier for prop in props))
        if len(rna.functions):
            lines.append("Functions: " + ", ".join(func.identifier for func in rna.functions))
        lines.append("Look up one member (e.g. %s.%s) for its type and description." % (rna.identifier, props[0].identifier if props else "name"))
        return "\n".join(lines)
    if props:
        lines.append("Properties:")
        lines.extend("  " + _prop_line(prop) for prop in props)
    if len(rna.functions):
        lines.append("Functions:")
        lines.extend("  " + _func_line(func) for func in rna.functions)
    return "\n".join(lines)


def _search_api(query, limit):
    words = query.lower().replace("_", " ").replace(".", " ").split()

    def hit(*texts):
        haystack = " ".join(text.lower().replace("_", " ") for text in texts if text)
        return all(word in haystack for word in words)

    named, described = [], []
    for name in dir(bpy.types):
        cls = getattr(bpy.types, name, None)
        rna = getattr(cls, "bl_rna", None)
        if rna is None:
            continue
        if hit(name):
            named.append("type  bpy.types.%s" % name)
        elif hit(name, rna.description):
            described.append("type  bpy.types.%s - %s" % (name, rna.description))
        for prop in rna.properties:
            if prop.identifier == "rna_type":
                continue
            if hit(name, prop.identifier):
                named.append("prop  %s.%s - %s" % (name, prop.identifier, prop.description))
            elif hit(name, prop.identifier, prop.description):
                described.append("prop  %s.%s - %s" % (name, prop.identifier, prop.description))
    for module in dir(bpy.ops):
        if module.startswith("_"):
            continue
        for name in dir(getattr(bpy.ops, module)):
            if name.startswith("_"):
                continue
            if hit(module, name):
                named.append("op    bpy.ops.%s.%s" % (module, name))
    results = named + described
    lines = results[:limit]
    if len(results) > limit:
        lines.append("... %d more; refine the query or raise limit." % (len(results) - limit))
    return "\n".join(lines) if lines else "Nothing matches %r." % query


def op_api_lookup(args):
    query = (args.get("query") or "").strip()
    if not query:
        raise ValueError("query is required.")
    limit = int(args.get("limit") or 60)
    header = "Blender %s\n" % bpy.app.version_string
    match = re.match(r"^(?:bpy\.ops\.)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$", query)
    if match and _op_exists(match.group(1), match.group(2)):
        return {"text": header + _describe_op(match.group(1), match.group(2))}
    dotted = query[len("bpy.types."):] if query.startswith("bpy.types.") else query
    parts = dotted.split(".")
    if len(parts) <= 2 and re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", parts[0]):
        cls = getattr(bpy.types, parts[0], None)
        if cls is not None and hasattr(cls, "bl_rna"):
            member = parts[1] if len(parts) == 2 else None
            text = _describe_type(cls, member, bool(args.get("brief")))
            if member is None and not args.get("brief") and len(text) > 15000:
                # Large types (Object, Scene...) would cost tens of thousands of tokens in full.
                text = _describe_type(cls, None, True) + "\n(Full listing is %d characters; showing names only.)" % len(text)
            return {"text": _clip(header + text)}
    return {"text": _clip(header + "Search results for %r:\n" % query + _search_api(query, limit))}


EXPORT_EXTENSION = {"fbx": ".fbx", "glb": ".glb", "gltf": ".gltf", "obj": ".obj", "stl": ".stl", "ply": ".ply", "usd": ".usdc"}
EXPORT_FORMATS = {
    "fbx": ("export_scene", "fbx"),
    "glb": ("export_scene", "gltf"),
    "gltf": ("export_scene", "gltf"),
    "obj": ("wm", "obj_export"),
    "stl": ("wm", "stl_export"),
    "ply": ("wm", "ply_export"),
    "usd": ("wm", "usd_export"),
}


def _export_settings(fmt, preset, apply_modifiers, rigged=False):
    if fmt == "fbx":
        settings = {"use_selection": True, "use_mesh_modifiers": apply_modifiers, "add_leaf_bones": False, "path_mode": "COPY", "embed_textures": True}
        if preset == "roblox":
            settings.update(
                apply_scale_options="FBX_SCALE_UNITS", apply_unit_scale=True, axis_forward="-Z", axis_up="Y",
                mesh_smooth_type="FACE", object_types={"MESH", "ARMATURE", "EMPTY"},
                # bake_space_transform is experimental and is known to break armatures and their animation.
                bake_space_transform=not rigged, bake_anim=rigged)
            if rigged:
                # Only the active action, and only deforming bones (no IK/control bones).
                settings.update(bake_anim_use_all_actions=False, use_armature_deform_only=True)
        return settings
    if fmt in ("glb", "gltf"):
        return {"export_format": "GLB" if fmt == "glb" else "GLTF_SEPARATE", "use_selection": True, "export_apply": apply_modifiers, "export_yup": True}
    if fmt == "usd":
        return {"selected_objects_only": True}
    settings = {"export_selected_objects": True, "apply_modifiers": apply_modifiers}
    if fmt == "obj":
        settings["path_mode"] = "COPY"
    return settings


def _settings_text(settings):
    parts = []
    for key in sorted(settings):
        value = settings[key]
        if key == "filepath":
            continue
        parts.append("%s=%s" % (key, "{" + ",".join(sorted(value)) + "}" if isinstance(value, set) else repr(value)))
    return ", ".join(parts)


def _exporter(fmt):
    if fmt not in EXPORT_FORMATS:
        raise ValueError("Unknown format %r. Use one of: %s." % (fmt, ", ".join(EXPORT_FORMATS)))
    module, name = EXPORT_FORMATS[fmt]
    if not _op_exists(module, name):
        raise RuntimeError("The %s exporter (bpy.ops.%s.%s) is not available in Blender %s; is its add-on enabled?" % (fmt, module, name, bpy.app.version_string))
    operator = getattr(getattr(bpy.ops, module), name)
    return operator, {prop.identifier: prop for prop in operator.get_rna_type().properties if prop.identifier != "rna_type"}


def _operator_settings(fmt, props, settings, options, kind="exporter"):
    ignored = sorted(key for key in settings if key not in props)
    settings = {key: value for key, value in settings.items() if key in props}
    unknown = [key for key in options if key not in props]
    if unknown:
        raise ValueError("Unknown %s %s options: %s. Valid options: %s" % (fmt, kind, ", ".join(unknown), ", ".join(sorted(props))))
    for key, value in options.items():
        prop = props[key]
        settings[key] = set(value) if prop.type == "ENUM" and prop.is_enum_flag and isinstance(value, list) else value
    return settings, ignored


def _world_bounds(objects, depsgraph):
    low = high = None
    for obj in objects:
        try:
            corners = [obj.evaluated_get(depsgraph).matrix_world @ Vector(corner) for corner in obj.evaluated_get(depsgraph).bound_box]
        except Exception:
            continue
        for point in corners:
            low = point.copy() if low is None else Vector((min(low.x, point.x), min(low.y, point.y), min(low.z, point.z)))
            high = point.copy() if high is None else Vector((max(high.x, point.x), max(high.y, point.y), max(high.z, point.z)))
    return (high - low) if low is not None else None


def _export_warnings(objects, preset, settings, depsgraph):
    warnings = []
    names = {obj.name for obj in objects}
    object_types = settings.get("object_types")
    for obj in objects:
        if object_types is not None and obj.type not in object_types:
            hint = " (convert it with Object > Convert > Mesh first)" if obj.type in MESHLIKE else ""
            warnings.append("%s is a %s, which this preset does not export%s" % (obj.name, obj.type, hint))
            continue
        if obj.type == "MESH":
            if preset == "roblox":
                mesh = obj.evaluated_get(depsgraph).data if settings.get("use_mesh_modifiers", True) else obj.data
                tris = sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)
                if tris > 20000:
                    warnings.append("%s has %d triangles; Roblox MeshParts allow 20,000" % (obj.name, tris))
            for modifier in obj.modifiers:
                if modifier.type == "ARMATURE" and modifier.object is not None and modifier.object.name not in names:
                    warnings.append("%s is skinned to armature %s, which is not part of this export; it will arrive unrigged" % (obj.name, modifier.object.name))
        if obj.matrix_world.determinant() < 0:
            warnings.append("%s has negative scale; its normals may flip" % obj.name)
    return warnings


@contextlib.contextmanager
def _export_selection(objects, warnings):
    """Selects exactly objects in Object Mode, then restores the user's selection, active object and mode."""
    view_layer = bpy.context.view_layer
    active = view_layer.objects.active
    mode = active.mode if active is not None else "OBJECT"
    # Multi-object editing: every object in the mode must go back into it, not only the active one.
    editing = [obj for obj in view_layer.objects if obj.mode == mode] if mode != "OBJECT" else []
    selected = [obj.name for obj in view_layer.objects if obj.select_get()]
    if mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    try:
        for obj in view_layer.objects:
            obj.select_set(False)
        for obj in objects:
            obj.select_set(True)
        view_layer.objects.active = objects[0]
        yield
    finally:
        for obj in view_layer.objects:
            try:
                obj.select_set(obj.name in selected or obj in editing)
            except Exception:
                pass
        view_layer.objects.active = active
        if mode != "OBJECT" and active is not None:
            try:
                bpy.ops.object.mode_set(mode=mode)
            except Exception:
                warnings.append("could not switch back to %s mode" % mode)
            for obj in view_layer.objects:
                try:
                    obj.select_set(obj.name in selected)
                except Exception:
                    pass


def _split_groups(objects, split):
    if split == "object":
        # A skinned mesh travels with its armature; the armature itself is not exported alone.
        groups = []
        for obj in objects:
            if obj.type == "ARMATURE":
                continue
            group = [obj]
            for modifier in getattr(obj, "modifiers", []):
                if modifier.type == "ARMATURE" and modifier.object is not None and modifier.object not in group:
                    group.append(modifier.object)
            groups.append((obj.name, group))
        if not groups:
            groups = [(obj.name, [obj]) for obj in objects]
        return groups
    groups = {}
    order = []
    for obj in objects:
        collection = obj.users_collection[0].name if obj.users_collection else "Scene"
        if collection not in groups:
            groups[collection] = []
            order.append(collection)
        groups[collection].append(obj)
    return [(name, groups[name]) for name in order]


def _safe_name(name):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip() or "export"


def op_export(args):
    fmt = args.get("format") or "fbx"
    operator, props = _exporter(fmt)
    path = args.get("path")
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("path must be an absolute file path (or folder when split is used).")
    preset = args.get("preset") or "default"
    split = args.get("split") or "none"

    scene = bpy.context.scene
    view_layer = bpy.context.view_layer
    target = args.get("target")
    objects = _targets(target, scene) if target else list(bpy.context.selected_objects)
    if not objects:
        raise ValueError("Nothing to export: pass target (object or collection names, \"$selection\" or \"$all\").")
    missing = [obj.name for obj in objects if view_layer.objects.get(obj.name) is None]
    if missing:
        raise ValueError("These objects are not in the active view layer, so they cannot be exported: %s" % ", ".join(missing[:20]))

    if split == "none":
        groups = [(None, objects)]
    else:
        groups = _split_groups(objects, split)
    extension = os.path.splitext(path)[1] if split == "none" else EXPORT_EXTENSION[fmt]
    files = []
    for name, group in groups:
        out = path if name is None else os.path.join(path, _safe_name(name) + extension)
        if name is not None and os.path.exists(out) and not args.get("overwrite"):
            raise ValueError("%s already exists. Pass overwrite: true to replace it, or choose another folder." % out)
        files.append((name, group, out))

    depsgraph = bpy.context.evaluated_depsgraph_get()
    lines = []
    warnings = []
    done = []
    written = []
    first_settings = None
    ignored = []
    with _export_selection(objects, warnings):
        for index, (name, group, out) in enumerate(files):
            if done and _time_left() < 8.0:
                lines.append("Stopped early to stay within the time limit. Not exported yet: %s. Call again with those as target." % ", ".join(item[0] for item in files[index:]))
                break
            rigged = any(obj.type == "ARMATURE" for obj in group)
            settings, ignored = _operator_settings(fmt, props, _export_settings(fmt, preset, bool(args.get("applyModifiers", True)), rigged), args.get("options") or {})
            settings["filepath"] = out
            warnings.extend(_export_warnings(group, preset, settings, depsgraph))
            for obj in view_layer.objects:
                obj.select_set(False)
            for obj in group:
                obj.select_set(True)
            view_layer.objects.active = group[0]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            result = operator(**settings)
            if "FINISHED" not in result:
                raise RuntimeError("The exporter returned %s for %s." % (", ".join(sorted(result)), out))
            if not os.path.exists(out):
                raise RuntimeError("The exporter finished but %s was not written." % out)
            size = _world_bounds(group, depsgraph)
            written.append(out)
            done.append("%s (%.1f KB, %d object%s%s)" % (out, os.path.getsize(out) / 1024.0, len(group), "" if len(group) == 1 else "s",
                                                         ", bounds %s x %s x %s m" % (_num(size.x), _num(size.y), _num(size.z)) if size is not None else ""))
            first_settings = first_settings or settings

    names = [obj.name for obj in objects]
    header = "Exported %d file%s as %s%s:" % (len(done), "" if len(done) == 1 else "s", fmt.upper(), " with the roblox preset" if preset == "roblox" else "")
    out_lines = [header] + ["  " + item for item in done] + lines
    out_lines.append("Objects: " + ", ".join(names[:50]) + (" ..." if len(names) > 50 else ""))
    if first_settings:
        out_lines.append("Settings: " + _settings_text(first_settings))
    out_lines.append("Bounds are in Blender meters (unit scale %s); check the size in Studio after import." % _num(scene.unit_settings.scale_length))
    if ignored:
        out_lines.append("Not supported by this Blender's exporter (skipped): " + ", ".join(ignored))
    if warnings:
        out_lines.append("Warnings:")
        out_lines.extend("  - " + warning for warning in dict.fromkeys(warnings))
    # data lets a Unify batch hand the file on, e.g. "{{1.files[0]}}" as roblox_create's path.
    return {"text": "\n".join(out_lines), "data": {"files": written, "objects": names}}


IMPORT_FORMATS = {
    ".fbx": [("import_scene", "fbx")],
    ".glb": [("import_scene", "gltf")],
    ".gltf": [("import_scene", "gltf")],
    ".obj": [("wm", "obj_import"), ("import_scene", "obj")],
    ".stl": [("wm", "stl_import"), ("import_mesh", "stl")],
    ".ply": [("wm", "ply_import"), ("import_mesh", "ply")],
    ".usd": [("wm", "usd_import")], ".usdc": [("wm", "usd_import")], ".usda": [("wm", "usd_import")], ".usdz": [("wm", "usd_import")],
}


def op_import(args):
    path = args.get("path")
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
        raise ValueError("path must be an absolute path to an existing file.")
    extension = os.path.splitext(path)[1].lower()
    choices = [item for item in IMPORT_FORMATS.get(extension, []) if _op_exists(*item)]
    if extension not in IMPORT_FORMATS:
        raise ValueError("Cannot import %s files. Supported: %s." % (extension or "extensionless", ", ".join(sorted(IMPORT_FORMATS))))
    if not choices:
        raise RuntimeError("No %s importer is available in Blender %s; is its add-on enabled?" % (extension, bpy.app.version_string))
    module, name = choices[0]
    operator = getattr(getattr(bpy.ops, module), name)
    props = {prop.identifier: prop for prop in operator.get_rna_type().properties if prop.identifier != "rna_type"}
    settings, _ignored = _operator_settings(extension[1:], props, {}, args.get("options") or {}, "importer")
    settings["filepath"] = path
    before = set(bpy.data.objects)
    actions_before = set(bpy.data.actions)
    view_layer = bpy.context.view_layer
    if view_layer.objects.active is not None and view_layer.objects.active.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    result = operator(**settings)
    if "FINISHED" not in result:
        raise RuntimeError("The importer returned %s." % ", ".join(sorted(result)))
    added = [obj for obj in bpy.data.objects if obj not in before]
    collection_name = args.get("collection")
    if collection_name and added:
        collection = bpy.data.collections.get(collection_name)
        if collection is None:
            collection = bpy.data.collections.new(collection_name)
            bpy.context.scene.collection.children.link(collection)
        for obj in added:
            for owner in list(obj.users_collection):
                owner.objects.unlink(obj)
            collection.objects.link(obj)
    _undo("Unify: import")
    actions = [action.name for action in bpy.data.actions if action not in actions_before]
    lines = ["Imported %s with bpy.ops.%s.%s: %d new object%s%s." % (path, module, name, len(added), "" if len(added) == 1 else "s", (" in collection %r" % collection_name) if collection_name and added else "")]
    lines.extend("  %s [%s]" % (obj.name, obj.type) for obj in added[:100])
    if len(added) > 100:
        lines.append("  ... %d more" % (len(added) - 100))
    if actions:
        lines.append("New actions: " + ", ".join(actions[:30]))
    lines.append("Imported objects are selected; pass their names as target to other tools.")
    return {"text": "\n".join(lines), "data": {"objects": [obj.name for obj in added], "actions": actions}}


def op_save(args):
    path = args.get("path")
    if path:
        if not os.path.isabs(path) or not path.lower().endswith(".blend"):
            raise ValueError("path must be an absolute path ending in .blend.")
        if os.path.exists(path) and not args.get("overwrite") and os.path.normcase(path) != os.path.normcase(bpy.data.filepath):
            raise ValueError("%s already exists. Pass overwrite: true to replace it." % path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if args.get("copy"):
            bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
            return {"text": "Saved a copy to %s; the session still edits %s." % (path, bpy.data.filepath or "an unsaved file")}
        bpy.ops.wm.save_as_mainfile(filepath=path)
    else:
        if not bpy.data.filepath:
            raise ValueError("This file has never been saved; pass path (an absolute .blend path).")
        bpy.ops.wm.save_mainfile()
    _refresh_meta(force=True)
    return {"text": "Saved %s." % bpy.data.filepath}


def _eevee_engine():
    items = {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    # Blender 4.2-4.4 named the new EEVEE BLENDER_EEVEE_NEXT; earlier and later versions use BLENDER_EEVEE.
    return "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in items else "BLENDER_EEVEE"


def _preview_pixels(path, size):
    """Loads the rendered PNG and returns it downscaled over mid-gray as bottom-up RGBA bytes."""
    import numpy
    image = bpy.data.images.load(path, check_existing=False)
    try:
        width, height = image.size
        scale = min(1.0, size / float(max(width, height, 1)))
        if scale < 1.0:
            width, height = max(1, int(width * scale)), max(1, int(height * scale))
            image.scale(width, height)
        pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
        image.pixels.foreach_get(pixels)
    finally:
        bpy.data.images.remove(image)
    pixels = pixels.reshape(-1, 4)
    alpha = pixels[:, 3:4]
    rgb = pixels[:, :3] * alpha + 0.35 * (1.0 - alpha)
    out = numpy.empty((width * height, 4), dtype=numpy.uint8)
    out[:, :3] = numpy.clip(rgb * 255.0 + 0.5, 0, 255).astype(numpy.uint8)
    out[:, 3] = 255
    return width, height, base64.b64encode(out.tobytes()).decode("ascii")


def op_render(args):
    scene = bpy.context.scene
    path = args.get("path")
    if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".png"):
        raise ValueError("path must be an absolute .png path.")
    view = args.get("view") or "iso"
    if view not in PRESET_VIEWS and view != "camera":
        raise ValueError("view must be camera or one of: %s." % ", ".join(PRESET_VIEWS))
    width = int(args.get("width") or 512)
    height = int(args.get("height") or width)
    engine = (args.get("engine") or "workbench").lower()
    target = args.get("target")
    objects = _targets(target, scene) if target else []
    if view != "camera" and not objects:
        raise ValueError("Preset views frame target; pass target (object or collection names, or \"$all\").")
    if view == "camera" and scene.camera is None:
        raise ValueError("The scene has no active camera; use a preset view or set scene.camera.")
    isolate = bool(args.get("isolate", bool(objects)))
    render = scene.render
    saved = {
        "camera": scene.camera, "engine": render.engine, "x": render.resolution_x, "y": render.resolution_y, "pct": render.resolution_percentage,
        "transparent": render.film_transparent, "filepath": render.filepath, "format": render.image_settings.file_format,
        "mode": render.image_settings.color_mode,
    }
    shading = scene.display.shading
    saved_shading = (shading.light, shading.color_type)
    hidden = []
    camera_object = camera_data = None
    try:
        if view != "camera":
            center, radius = _bounds(objects)
            direction, up = PRESET_VIEWS[view]
            distance = radius * 4.0
            camera_data = bpy.data.cameras.new("Unify Render Camera")
            camera_data.type = "ORTHO"
            padding = float(args.get("padding") or 1.1)
            # ortho_scale spans the longer image side; scale it so the shorter side still fits the bounds.
            camera_data.ortho_scale = radius * 2.0 * padding * max(width / float(height), height / float(width))
            camera_data.clip_start = max(distance - radius * 2.0, 0.001)
            camera_data.clip_end = distance + radius * 2.0
            camera_object = bpy.data.objects.new("Unify Render Camera", camera_data)
            scene.collection.objects.link(camera_object)
            camera_object.matrix_world = _look_at(center + Vector(direction).normalized() * distance, center, Vector(up)).inverted()
            scene.camera = camera_object
        if isolate:
            keep = {obj.name for obj in objects}
            # Children and armatures that deform a kept mesh must stay visible too.
            for obj in objects:
                keep.update(child.name for child in obj.children_recursive)
                keep.update(m.object.name for m in getattr(obj, "modifiers", []) if m.type == "ARMATURE" and m.object is not None)
            for obj in scene.objects:
                if obj.name not in keep and obj.type in GEOMETRY and not obj.hide_render:
                    obj.hide_render = True
                    hidden.append(obj)
        render.engine = {"workbench": "BLENDER_WORKBENCH", "eevee": _eevee_engine(), "cycles": "CYCLES"}.get(engine, "BLENDER_WORKBENCH")
        if render.engine == "BLENDER_WORKBENCH":
            shading.light = "STUDIO"
            shading.color_type = "TEXTURE" if args.get("textures", True) else "MATERIAL"
        elif render.engine == "CYCLES":
            scene.cycles.samples = int(args.get("samples") or 32)
        else:
            eevee = scene.eevee
            if hasattr(eevee, "taa_render_samples"):
                eevee.taa_render_samples = int(args.get("samples") or 16)
        render.resolution_x, render.resolution_y, render.resolution_percentage = width, height, 100
        render.film_transparent = bool(args.get("transparent", True))
        render.image_settings.file_format = "PNG"
        render.image_settings.color_mode = "RGBA" if render.film_transparent else "RGB"
        render.filepath = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        started = time.perf_counter()
        bpy.ops.render.render(write_still=True)
        seconds = time.perf_counter() - started
    finally:
        for obj in hidden:
            obj.hide_render = False
        scene.camera = saved["camera"]
        render.engine = saved["engine"]
        render.resolution_x, render.resolution_y, render.resolution_percentage = saved["x"], saved["y"], saved["pct"]
        render.film_transparent = saved["transparent"]
        render.filepath = saved["filepath"]
        render.image_settings.file_format = saved["format"]
        render.image_settings.color_mode = saved["mode"]
        shading.light, shading.color_type = saved_shading
        if camera_object is not None:
            bpy.data.objects.remove(camera_object, do_unlink=True)
        if camera_data is not None:
            bpy.data.cameras.remove(camera_data)
    if not os.path.exists(path):
        raise RuntimeError("The render finished but %s was not written." % path)
    preview_w, preview_h, pixels = _preview_pixels(path, int(args.get("previewSize") or 512))
    return {
        "path": path, "width": width, "height": height, "engine": engine, "seconds": round(seconds, 2),
        "transparent": bool(args.get("transparent", True)), "framed": [obj.name for obj in objects[:30]],
        "views": [{"view": "render preview (transparent areas shown gray)", "width": preview_w, "height": preview_h, "pixels": pixels}],
    }


_OPS = {
    "execute": op_execute,
    "tree": op_tree,
    "find": op_find,
    "properties": op_properties,
    "selection": op_selection,
    "capture_view": op_capture_view,
    "output_log": op_output_log,
    "mesh_check": op_mesh_check,
    "api_lookup": op_api_lookup,
    "export": op_export,
    "import": op_import,
    "save": op_save,
    "render": op_render,
    "info": lambda args: {"file": bpy.data.filepath, "dirty": bpy.data.is_dirty, "scene": bpy.context.scene.name},
}


# ---------------------------------------------------------------- UI and lifecycle

# The Unify logo (media/unify.svg) as a 32px PNG, shown as the panel header icon.
_LOGO_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgEAYAAAAj6qa3AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAAAAAAAAPlDu38AAAAJcEhZcwAAAYAAAAGAAB/kyyIAAAAHdElNRQfqCxgGKh9/mGFKAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTExLTI0VDAzOjQwOjIxKzAwOjAwJaRIqQAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMS0yNFQwMzo0MDoyMSswMDowMFT58BUAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTEtMjRUMDY6NDI6MzErMDA6MDDWnLJ6AAADaElEQVRo3u2ZXUgUURiG3zM7uKsuRUlaEOSFioa5RP5FZnkhBUIRZQYrEpGWG2GQSfRDRCShedON5U9hakJm1E1UFEokuaTkT4WJiVAIkZumq7nr7pwuzlk1bZ113XVEfW+eMzvfnO98786cmTlDME1GY1VVZiZEvmmDu7JzfoAVBEAC1KDwjdOl60tL8cftfj0s0cnvvHDVdcagHh7ewEgbXexXzTBwjtF8W+mCXTWAK2gtY10948Y8Rsks0+8GBhLPeDGfsVLWgJs12TnR5QBNQgepBcgdhNA8AP5QYZQHEfcLzs0tLm5OcdkAsYkXnsqZNcd87QyrfFw9YLhc26yOBPHNIKmWRlCLhg763ADoefQjl4/Y/QvTYR110QC8ZZAuu52S5YvijRa5SO2ZEX/rYVDoUUfWJ0b7rYF63HREBAFwEt08bECmznBGk46xaD8/LG16pJwBC6/PCEEgAA0k2LfUwgQBa7KDJ/+zuajPwFhinuLbK/RMRghK1zu76CH3CnfIdpY38p1FLHIDvK8VA5QegNJaMUDpASitFQOUHoDSWjFA6QEorWVvwAK9C9BK9CMAJmw2JlbrjnfNCBDi3ujbysIgLT0DCDQYV++k20gD3eUTRfwwCj+R5x3/yGld6MK9b4Dj4oqACBh2kBYaT5r27UUe4mAU+9nO8hLGimg8x4GlZQBbeqDwgxVi6FMAVmhDJ/dbYMF4vfmnqj9jsAEoLDAYYmKmH29/4G0DvD0JOl28Iu2kkdy357R/+9TRnbw1FhpIoKda4QsJ9MQXWGCFT9IVAHQ+S2ByUmxBhESQQPRJL1TdKqPwPkUHCwS0XtNNCVHDhhoAZH5rArNLydsgnVJc7/888mbhyhtA/2kPKTWMZf8gJGfABQaxyOOZx2CBRVBhDGOwYlApA2ZOgl0Iw8ST2rCW8d5vxoBIRto5v7TCHiGLpBFqpOQYOUoexj5CMFYvCgP8w0c6/cMdNx7HOvolT+d99vJ0x9V3TwASSDaR3u3J3pnwhNe8kcD5VdYAs12rMtu9P/9K62iQZACbDKsH+RnWl85ou+WZwr/X8v4O8h0VsgbEx+v1ZWXeLh8oLDQYYtocW3f5p7PHAYxUO7/eSQEvfDfjj1/OIpX+MuTLMMQLnrgbVnqo/+mn/IzP/n8B3pbxbFmFm/gAAAAASUVORK5CYII="
_icons = {"previews": None}


def _load_logo():
    import bpy.utils.previews
    previews = bpy.utils.previews.new()
    path = os.path.join(bpy.app.tempdir or os.path.expanduser("~"), "unify_bridge_logo.png")
    try:
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(_LOGO_PNG))
        previews.load("unify_logo", path, "IMAGE")
    except OSError:
        pass
    _icons["previews"] = previews


def _logo_icon():
    previews = _icons["previews"]
    if previews is None or "unify_logo" not in previews:
        return 0
    return previews["unify_logo"].icon_id


class UNIFY_PT_bridge(bpy.types.Panel):
    bl_label = "Unify Bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Unify"

    def draw_header(self, context):
        self.layout.label(text="", icon_value=_logo_icon())

    def draw(self, context):
        column = self.layout.column()
        connected = len(_connected)
        column.label(text="Instance: %s" % SESSION)
        column.label(text="Connected to %d Unify window%s" % (connected, "" if connected == 1 else "s"), icon="LINKED" if connected else "UNLINKED")
        if _status["busy"]:
            column.label(text="Agent running: %s" % _status["busy"], icon="TIME")
        elif _status["last"]:
            column.label(text="Last: %s" % _status["last"])


def _start():
    if _run["stop"] is not None:
        return
    stop = threading.Event()
    _run["stop"] = stop
    _install_tee()
    threading.Thread(target=_discover_loop, args=(stop,), name="unify-bridge-discover", daemon=True).start()
    threading.Thread(target=_send_loop, args=(stop,), name="unify-bridge-send", daemon=True).start()
    for handlers in (bpy.app.handlers.save_post, bpy.app.handlers.load_post):
        if _file_changed not in handlers:
            handlers.append(_file_changed)
    # Timers never fire in --background; serve_blocking drives _tick there instead.
    if not bpy.app.background and not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=0.1, persistent=True)


def _stop():
    stop = _run["stop"]
    _run["stop"] = None
    if stop is not None:
        stop.set()
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    for handlers in (bpy.app.handlers.save_post, bpy.app.handlers.load_post):
        if _file_changed in handlers:
            handlers.remove(_file_changed)
    with _lock:
        _pollers.clear()
    _connected.clear()
    _remove_tee()


def serve_blocking(seconds=None):
    """Run the bridge loop on this thread; for headless Blender (--background), where timers do not fire."""
    _start()
    ends = None if seconds is None else time.monotonic() + seconds
    while ends is None or time.monotonic() < ends:
        delay = _tick()
        time.sleep(0.05 if delay is None else delay)


def register():
    if not bpy.app.background:
        _load_logo()
    bpy.utils.register_class(UNIFY_PT_bridge)
    if bpy.app.background and not os.environ.get("UNIFY_BLENDER_BRIDGE_BACKGROUND"):
        return
    _start()


def unregister():
    _stop()
    bpy.utils.unregister_class(UNIFY_PT_bridge)
    if _icons["previews"] is not None:
        import bpy.utils.previews
        bpy.utils.previews.remove(_icons["previews"])
        _icons["previews"] = None


if __name__ == "__main__":
    register()
`;
