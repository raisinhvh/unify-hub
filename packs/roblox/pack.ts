import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
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
    /** dataDir files DSH Config Sync carries to other PCs; secrets stay on each PC. */
    sync?: { files: string[]; secrets?: string[] };
    setup?(ctx: ToolpackContext): void | Promise<void>;
    teardown?(): void | Promise<void>;
}

/** target "client": the playtest server session relays the command to the playtest client. */
interface Command { id: number; op: string; args: Record<string, unknown>; queuedAt: number; timeoutMs: number; target?: 'client' }
interface Waiter { res: ServerResponse; timer: ReturnType<typeof setTimeout>; closed: boolean }
interface Place {
    session: string; name: string; placeId: string; protocol: number; lastSeen: number; queue: Command[]; waiters: Waiter[];
    /** "test" sessions are the plugin running inside a playtest's server: they run commands in the live game and end the test. */
    role: 'edit' | 'test';
    /** For a test session, the edit session that started the test ("" when it was started by hand). */
    parent: string;
    /** For a test session, whether the playtest client is connected to it (play mode). */
    client: boolean;
    /** The command Studio is running now; the plugin runs one at a time and does not poll meanwhile. */
    inflight?: { id: number; op: string; since: number };
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; session: string }
interface State {
    server?: Server;
    ctx?: ToolpackContext;
    code: string;
    port: number;
    lastStatus: string;
    statusTimer?: ReturnType<typeof setInterval>;
    nextId: number;
    places: Map<string, Place>;
    pending: Map<number, Pending>;
}

const DEFAULT_PORT = 34872;
/** Bump together with PROTOCOL_VERSION in DSHBridge.server.lua whenever the command protocol changes. */
const PROTOCOL_VERSION = 3;
/** DSH cuts tool calls off at 60s; every Studio command finishes or fails before this. */
const CALL_BUDGET_MS = 55_000;
const MAX_QUEUED = 8;

const state: State = {
    code: '', port: DEFAULT_PORT, lastStatus: '', nextId: 1,
    places: new Map(), pending: new Map(),
};
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** What the user types into the Studio widget; a non-default port rides along after a colon. */
function pairingText(): string { return state.port === DEFAULT_PORT ? state.code : `${state.code}:${state.port}`; }

function updateStatus(): void {
    const ctx = state.ctx;
    if (!ctx || !state.code) return;
    prunePlaces();
    const connected = connectedPlaces();
    const text = connected.length === 1
        ? `Connected to Roblox Studio (place: ${connected[0].name}). Pairing code: ${pairingText()}`
        : connected.length > 1
            ? `Connected to Roblox Studio (${connected.length} places: ${connected.map(place => place.name).join(', ')}). Pairing code: ${pairingText()}`
            : `Waiting for Roblox Studio. Pairing code: ${pairingText()}`;
    if (text !== state.lastStatus) {
        state.lastStatus = text;
        ctx.status(text);
    }
}

function json(res: ServerResponse, status: number, value: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
}

/** A place that is busy with a long command still counts as connected, even though it is not polling. */
function isConnected(place: Place, now = Date.now()): boolean {
    return now - place.lastSeen < 35_000 || (place.inflight !== undefined && now - place.inflight.since < 2 * CALL_BUDGET_MS);
}
function connectedPlaces(): Place[] { return [...state.places.values()].filter(place => place.role === 'edit' && isConnected(place)); }
/**
 * The playtest server session for an edit place: the one it started, else an unclaimed one in the same place
 * (by place id, then name), else the only unclaimed one that no other edit place matches. Tests started from
 * Studio's own Play button carry no parent, and unpublished places all have place id 0.
 */
function testSessionFor(place: Place): Place | undefined {
    // Newest first: a test that just ended keeps looking alive for a while, and a stop sent to it would hang.
    const tests = [...state.places.values()].filter(item => item.role === 'test' && Date.now() - item.lastSeen < 35_000)
        .sort((a, b) => b.lastSeen - a.lastSeen);
    const own = tests.find(item => item.parent === place.session);
    if (own) return own;
    const edits = connectedPlaces();
    const unclaimed = tests.filter(item => !edits.some(edit => edit.session === item.parent));
    const samePlace = (edit: Place, test: Place): boolean => edit.placeId !== '0' && edit.placeId !== '' ? test.placeId === edit.placeId : test.name === edit.name;
    return unclaimed.find(item => samePlace(place, item))
        ?? (unclaimed.length === 1 && !edits.some(edit => edit !== place && samePlace(edit, unclaimed[0])) ? unclaimed[0] : undefined);
}
function dropPlace(session: string, place: Place): void {
    for (const waiter of place.waiters.splice(0)) { waiter.closed = true; clearTimeout(waiter.timer); if (!waiter.res.destroyed && !waiter.res.writableEnded) { waiter.res.writeHead(204); waiter.res.end(); } }
    for (const queued of place.queue.splice(0)) {
        const pending = state.pending.get(queued.id);
        if (!pending) continue;
        state.pending.delete(queued.id);
        clearTimeout(pending.timer);
        pending.reject(new Error(`Roblox Studio session ${place.name} went away before ${queued.op} started (nothing was changed).`));
    }
    state.places.delete(session);
}
function prunePlaces(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [session, place] of state.places) if (place.lastSeen < cutoff && !isConnected(place)) dropPlace(session, place);
}

function busyText(place: Place): string {
    const running = place.inflight ? `running ${place.inflight.op} for another call (${Math.round((Date.now() - place.inflight.since) / 1000)}s so far)` : 'busy';
    return `Roblox Studio (${place.name}) is ${running} with ${place.queue.length} more command(s) queued`;
}

/** Hands a queued command to a waiting poll and starts its run timer; time spent in the queue has its own limit. */
function deliver(place: Place, waiter: Waiter, command: Command): void {
    waiter.closed = true;
    clearTimeout(waiter.timer);
    const pending = state.pending.get(command.id);
    if (!pending) return;
    const runMs = Math.max(1_000, Math.min(command.timeoutMs, CALL_BUDGET_MS - (Date.now() - command.queuedAt)));
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
        state.pending.delete(command.id);
        const mutates = ['execute', 'set_source'].includes(command.op);
        pending.reject(new Error(`Roblox Studio did not finish ${command.op} within ${Math.round(runMs / 1000)}s.${mutates ? ' It may still be running and may have applied changes; check the current state before retrying.' : ' Retry, or narrow the request.'}`));
    }, runMs);
    place.inflight = { id: command.id, op: command.op, since: Date.now() };
    json(waiter.res, 200, { id: command.id, op: command.op, args: command.args, budgetMs: runMs, ...(command.target ? { target: command.target } : {}) });
}

function dispatch(place: Place): void {
    while (place.queue.length && place.waiters.length) {
        const waiter = place.waiters.shift()!;
        if (waiter.closed || waiter.res.destroyed || waiter.res.writableEnded) continue;
        deliver(place, waiter, place.queue.shift()!);
    }
}

function refreshPlace(url: URL): Place {
    const name = url.searchParams.get('place') ?? '';
    const session = url.searchParams.get('session') || name;
    let place = state.places.get(session);
    const isNew = !place;
    if (!place) { place = { session, name, placeId: '', protocol: 1, lastSeen: Date.now(), queue: [], waiters: [], role: 'edit', parent: '', client: false }; state.places.set(session, place); }
    place.name = name; place.placeId = url.searchParams.get('placeId') ?? ''; place.lastSeen = Date.now();
    place.role = url.searchParams.get('role') === 'test' ? 'test' : 'edit';
    place.parent = url.searchParams.get('parent') ?? '';
    place.client = place.role === 'test' && url.searchParams.get('client') === '1';
    // An edit session runs one test at a time, so a new test session means the older ones are gone.
    if (isNew && place.role === 'test' && place.parent) for (const [other, item] of state.places) {
        if (item !== place && item.role === 'test' && item.parent === place.parent) dropPlace(other, item);
    }
    place.protocol = Number(url.searchParams.get('protocol')) || 1;
    // A poll means the plugin finished whatever it was running.
    place.inflight = undefined;
    prunePlaces(); updateStatus(); return place;
}

function tokenMatches(header: unknown): boolean {
    const given = Buffer.from(String(header ?? '').toUpperCase());
    const expected = Buffer.from(state.code);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokenMatches(req.headers['x-dsh-token'])) {
        json(res, 401, { error: 'wrong pairing code' });
        return;
    }
    const host = req.headers.host ?? '127.0.0.1';
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${host}`); }
    catch { json(res, 400, { error: 'invalid request URL' }); return; }

    if (req.method === 'GET' && url.pathname === '/ping') {
        refreshPlace(url);
        json(res, 200, { ok: true });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/poll') {
        const place = refreshPlace(url);
        const waiter: Waiter = {
            res, closed: false,
            timer: setTimeout(() => {
                const index = place.waiters.indexOf(waiter);
                if (index >= 0) place.waiters.splice(index, 1);
                waiter.closed = true;
                if (!res.destroyed && !res.writableEnded) { res.writeHead(204); res.end(); }
            }, 20_000),
        };
        place.waiters.push(waiter);
        res.on('close', () => {
            if (waiter.closed) return;
            waiter.closed = true;
            clearTimeout(waiter.timer);
            const index = place.waiters.indexOf(waiter);
            if (index >= 0) place.waiters.splice(index, 1);
        });
        dispatch(place);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/result') {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
            if (tooLarge) return;
            size += chunk.length;
            if (size > 32 * 1024 * 1024) {
                tooLarge = true;
                json(res, 413, { error: 'request body too large' });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge || res.writableEnded) return;
            let result: unknown;
            try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
            catch { json(res, 400, { error: 'invalid JSON body' }); return; }
            if (!isRecord(result) || typeof result.id !== 'number' || typeof result.ok !== 'boolean') {
                json(res, 400, { error: 'result must contain numeric id and boolean ok' });
                return;
            }
            // Results count as a heartbeat: long commands keep the plugin from polling.
            for (const place of state.places.values()) if (place.inflight?.id === result.id) {
                place.inflight = undefined;
                place.lastSeen = Date.now();
            }
            const pending = state.pending.get(result.id);
            if (pending) {
                state.pending.delete(result.id);
                clearTimeout(pending.timer);
                if (result.ok) pending.resolve(result.data);
                else pending.reject(new Error(typeof result.error === 'string' ? result.error : 'Roblox Studio command failed.'));
            }
            json(res, 200, {});
        });
        return;
    }
    json(res, 404, { error: 'not found' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Queues a command for one place. timeoutMs is how long it may run once Studio picks it up; it may wait in
 * the queue for whatever is left of the call budget, and fails with a "busy" error instead of a timeout.
 */
function command(place: Place, op: string, args: Record<string, unknown>, timeoutMs = 30_000, queueMs = CALL_BUDGET_MS - timeoutMs, target?: 'client'): Promise<unknown> {
    if (place.protocol < PROTOCOL_VERSION) return Promise.reject(new Error(`The DSH Bridge plugin in ${place.name} is outdated (protocol ${place.protocol}; this toolpack needs ${PROTOCOL_VERSION}). Copy DSHBridge.server.lua from the Roblox toolpack folder into Studio's Plugins folder, then restart Studio.`));
    if (place.queue.length >= MAX_QUEUED) return Promise.reject(new Error(`${busyText(place)}. Wait a few seconds and retry.`));
    const id = state.nextId++;
    const queuedAt = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            state.pending.delete(id);
            const index = place.queue.findIndex(item => item.id === id);
            if (index >= 0) place.queue.splice(index, 1);
            reject(new Error(`${busyText(place)}, so ${op} never started (nothing was changed). Retry in a few seconds.`));
        }, Math.max(3_000, queueMs));
        state.pending.set(id, { resolve, reject, timer, session: place.session });
        place.queue.push({ id, op, args, queuedAt, timeoutMs, ...(target ? { target } : {}) });
        dispatch(place);
    });
}

function resolvePlace(args: Record<string, unknown>): Place {
    prunePlaces();
    const places = connectedPlaces();
    const noConnection = `Roblox Studio is not connected. In Studio open the 'DSH Bridge' plugin widget, enter the pairing code (${state.code}) and make sure HTTP requests are allowed.`;
    const label = (place: Place): string => `${place.name} (placeId: ${place.placeId}, session: ${place.session})`;
    if (!places.length) throw new Error(noConnection);
    const requested = stringArg(args, 'place');
    if (requested !== undefined) {
        let matches = places.filter(place => place.session === requested);
        if (!matches.length) matches = places.filter(place => place.name.toLowerCase() === requested.toLowerCase());
        if (!matches.length) matches = places.filter(place => place.name.toLowerCase().includes(requested.toLowerCase()) || place.placeId === requested);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error(`Multiple Roblox Studio places match "${requested}": ${matches.map(label).join('; ')}. Pass an exact session or a more specific place.`);
        throw new Error(`No connected Roblox Studio place matches "${requested}". Connected places: ${places.map(label).join('; ')}`);
    }
    if (places.length === 1) return places[0];
    throw new Error(`Several Roblox Studio places are connected: ${places.map(label).join('; ')}. Pass the place argument.`);
}

function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
    const value = args[name];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || (required && value.length === 0)) throw new Error(`${name} must be a${required ? ' non-empty' : ''} string.`);
    return value;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
    const value = args[name];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
    return value;
}

function placeSchema(): Record<string, unknown> { return { type: 'string', description: 'Only needed when several places are connected: session, name, partial name, or placeId.' }; }
function commandFor(args: Record<string, unknown>, op: string, sent: Record<string, unknown>, timeoutMs?: number): Promise<unknown> { return command(resolvePlace(args), op, sent, timeoutMs); }

type Context = 'edit' | 'server' | 'client';
function contextSchema(viewport = false): Record<string, unknown> {
    return {
        type: 'string', enum: ['edit', 'server', 'client'],
        description: '"edit" is the place being edited. During a playtest, "server" and "client" are the live game'
            + (viewport ? '. Default: "server" during a Run-mode test, else "edit". Play-mode tests cannot be captured (Roblox hides the client\'s pixels).'
                : ' (execute runs as a game script there, sharing the game\'s modules and state). Default: "server" while a playtest is connected to DSH, else "edit".'),
    };
}
/** The session a context-aware tool talks to. A playtest's client is reached through its server session. */
function resolveContext(args: Record<string, unknown>, op: string): { place: Place; context: Context; relay?: 'client' } {
    const place = resolvePlace(args);
    const requested = stringArg(args, 'context');
    if (requested !== undefined && !['edit', 'server', 'client'].includes(requested)) throw new Error('context must be edit, server, or client.');
    const test = testSessionFor(place);
    // Roblox lets no plugin or script read a play client's viewport pixels (its screenshots are temporary textures).
    if (op === 'capture_view' && test?.client && requested !== 'edit') throw new Error('capture_view cannot read the viewport during a Play test: Roblox does not expose a play client\'s screenshot pixels. Capture in Run mode or edit mode instead; inspect the live game with execute, tree or properties.');
    const context = (requested ?? (test ? 'server' : 'edit')) as Context;
    if (context === 'edit') return { place, context };
    if (!test) throw new Error(`No playtest of ${place.name} is connected to DSH, so context "${context}" is unavailable. Start one with roblox_playtest, or omit context.`);
    if (context === 'client' && !test.client) throw new Error('The playtest has no client connected to DSH. Run mode has no client; in play mode the client connects a few seconds after the start.');
    return { place: test, context, ...(context === 'client' ? { relay: 'client' as const } : {}) };
}
function commandAt(args: Record<string, unknown>, op: string, sent: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const { place, relay } = resolveContext(args, op);
    return command(place, op, sent, timeoutMs, CALL_BUDGET_MS - timeoutMs, relay);
}

function dataRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error('Roblox Studio returned an invalid response.');
    return value;
}

function textValue(record: Record<string, unknown>, key: string, fallback = ''): string {
    const value = record[key];
    return typeof value === 'string' ? value : fallback;
}

function formatTree(data: Record<string, unknown>, depth: number): string {
    const root = dataRecord(data.root);
    const rootChildren = typeof root.childCount === 'number' ? root.childCount : 0;
    const lines = [`${textValue(root, 'path')} [${textValue(root, 'className')}]${depth === 0 && rootChildren > 0 ? ` (+${rootChildren} children)` : ''}`];
    if (Array.isArray(data.nodes)) {
        for (const raw of data.nodes) {
            if (!isRecord(raw)) continue;
            const level = typeof raw.depth === 'number' && Number.isFinite(raw.depth) ? Math.max(0, raw.depth) : 0;
            let line = `${'  '.repeat(level)}${textValue(raw, 'name')} [${textValue(raw, 'className')}]`;
            if (level === depth && typeof raw.childCount === 'number' && raw.childCount > 0) line += ` (+${raw.childCount} children)`;
            lines.push(line);
        }
    }
    if (data.truncated === true) lines.push('Listing truncated; narrow path or lower depth/className.');
    return lines.join('\n');
}

function formatFind(data: Record<string, unknown>): string {
    const lines: string[] = [];
    if (Array.isArray(data.matches)) for (const raw of data.matches) {
        if (isRecord(raw)) lines.push(`${textValue(raw, 'path')} [${textValue(raw, 'className')}]`);
    }
    if (!lines.length) lines.push('No matches.');
    if (data.truncated === true) lines.push('Results truncated.');
    return lines.join('\n');
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
}

function codeArg(args: Record<string, unknown>): string {
    const code = stringArg(args, 'code', true) as string;
    if (code.trim().length === 0) throw new Error('code must be a nonblank string.');
    if (Buffer.byteLength(code, 'utf8') > 200_000) throw new Error('code must be at most 200000 UTF-8 bytes.');
    return code;
}

function formatExecute(data: Record<string, unknown>, freshRequested = false): string {
    const logs = stringArray(data.logs);
    const returns = stringArray(data.returns);
    // Only playtest sessions report where the code ran.
    const where = typeof data.context === 'string' ? ` (playtest ${data.context})` : '';
    let freshNote = '';
    if (freshRequested && where) freshNote = 'Note: fresh only applies to the edit context; the playtest uses the game\'s own require cache.';
    else if (freshRequested && data.fresh !== true) freshNote = 'Note: plugin outdated: reinstall DSHBridge.server.lua for fresh.';
    if (!logs.length && !returns.length) return [`Code executed successfully${where}.`, freshNote].filter(Boolean).join('\n\n');
    const sections: string[] = where ? [`Ran in the playtest ${data.context}.`] : [];
    if (logs.length) sections.push(`Output:\n${logs.join('\n')}`);
    if (returns.length) sections.push(`Returns:\n${returns.join('\n')}`);
    if (freshNote) sections.push(freshNote);
    return sections.join('\n\n');
}

function stringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) result[key] = typeof item === 'string' ? item : JSON.stringify(item);
    return result;
}

function formatProperties(data: Record<string, unknown>): string {
    const count = typeof data.childCount === 'number' ? data.childCount : 0;
    const lines = [`${textValue(data, 'path')} [${textValue(data, 'className')}] (${count} children)`, 'Properties:'];
    const properties = stringMap(data.properties);
    for (const key of Object.keys(properties).sort((a, b) => a.localeCompare(b))) lines.push(`  ${key} = ${properties[key]}`);
    const attributes = stringMap(data.attributes);
    if (Object.keys(attributes).length) {
        lines.push('Attributes:');
        for (const key of Object.keys(attributes).sort((a, b) => a.localeCompare(b))) lines.push(`  ${key} = ${attributes[key]}`);
    }
    if (Array.isArray(data.tags) && data.tags.length) lines.push(`Tags: ${data.tags.filter((tag): tag is string => typeof tag === 'string').join(', ')}`);
    return lines.join('\n');
}

function formatSource(data: Record<string, unknown>): string {
    const total = typeof data.lineCount === 'number' ? data.lineCount : 0;
    const first = typeof data.startLine === 'number' ? data.startLine : 1;
    const source = textValue(data, 'source');
    const shown = source === '' ? [] : source.replace(/\n$/, '').split('\n');
    const last = first + shown.length - 1;
    const lines = [`${textValue(data, 'path')} [${textValue(data, 'className')}] ${total} lines${shown.length && (first > 1 || last < total) ? `, showing ${first}-${last}` : ''}`];
    if (typeof data.runContext === 'string' && data.runContext) lines[0] += ` (${data.runContext})`;
    const width = String(Math.max(last, 1)).length;
    lines.push('```lua', ...shown.map((line, i) => `${String(first + i).padStart(width)}| ${line}`), '```');
    if (last < total) lines.push(`More below: call again with startLine ${last + 1}.`);
    return lines.join('\n');
}

const MAX_SOURCE_CHARS = 50_000;
const pathDescription = 'Paths look like "ReplicatedStorage/Shared" (or "Workspace.Map" when no name contains a dot), optional leading "game"; omit path for the whole game. Paths returned by other tools can be passed back unchanged.';

const captureViews = ['current', 'top', 'bottom', 'side', 'front', 'back', 'perspective'];
const vectorSchema = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

function vectorArg(value: unknown, name: string): number[] {
    if (!Array.isArray(value) || value.length !== 3 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error(`${name} must contain three finite numbers.`);
    return value as number[];
}

function finiteArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
    const value = args[name] === undefined ? fallback : args[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
    return value;
}

const CAPTURE_OUTPUT_ARGS = ['saveDir', 'fileName', 'uploadAs'];

function captureArgs(args: Record<string, unknown>): Record<string, unknown> {
    const allowed = ['place', 'context', 'target', 'views', 'camera', 'padding', 'labels', 'width', 'height', 'captureId', 'viewIndex', 'pixels', 'maxDistance', ...CAPTURE_OUTPUT_ARGS];
    for (const key of Object.keys(args)) {
        if (key === 'restoreCamera') throw new Error('restoreCamera was removed: the editor camera is now always restored after a capture.');
        if (!allowed.includes(key)) throw new Error(`Unknown capture_view argument: ${key}.`);
    }
    if (args.captureId !== undefined) {
        const captureId = stringArg(args, 'captureId', true);
        if (typeof captureId !== 'string' || captureId.length > 100) throw new Error('captureId must be at most 100 characters.');
        for (const key of ['target', 'views', 'camera', 'padding', 'labels', 'width', 'height', ...CAPTURE_OUTPUT_ARGS]) if (args[key] !== undefined) throw new Error(`${key} cannot be used with captureId.`);
        if (!Array.isArray(args.pixels) || args.pixels.length < 1 || args.pixels.length > 100) throw new Error('pixels must contain 1 to 100 points.');
        const pixels = args.pixels.map(point => {
            if (!isRecord(point) || Object.keys(point).some(key => key !== 'x' && key !== 'y')) throw new Error('Each pixel must have only x and y.');
            for (const key of ['x', 'y']) if (typeof point[key] !== 'number' || !Number.isFinite(point[key]) || (point[key] as number) < 0) throw new Error('Pixel coordinates must be finite non-negative numbers.');
            return { x: point.x, y: point.y };
        });
        const viewIndex = finiteArg(args, 'viewIndex', 1, 1, 4);
        if (!Number.isInteger(viewIndex)) throw new Error('viewIndex must be an integer.');
        return { captureId, pixels, viewIndex, maxDistance: finiteArg(args, 'maxDistance', 10_000, 1, 100_000) };
    }
    for (const key of ['pixels', 'viewIndex', 'maxDistance']) if (args[key] !== undefined) throw new Error(`${key} requires captureId.`);
    const sent: Record<string, unknown> = {};
    if (args.target !== undefined) {
        const target = typeof args.target === 'string' ? [args.target] : args.target;
        if (!Array.isArray(target) || target.length < 1 || target.length > 100 || target.some(path => typeof path !== 'string' || !path.trim())) throw new Error('target must be a path, $selection, or 1 to 100 paths.');
        sent.target = target;
    }
    if (args.views !== undefined) {
        if (!Array.isArray(args.views) || args.views.length < 1 || args.views.length > 4 || args.views.some(view => !captureViews.includes(view as string))) throw new Error(`views must contain 1 to 4 of: ${captureViews.join(', ')}.`);
        sent.views = args.views;
    }
    if (args.camera !== undefined) {
        if (args.views !== undefined) throw new Error('camera overrides framing and cannot be combined with views.');
        if (!isRecord(args.camera) || Object.keys(args.camera).some(key => !['position', 'lookAt', 'up', 'fieldOfView'].includes(key))) throw new Error('camera must contain position, lookAt, optional up and fieldOfView.');
        const position = vectorArg(args.camera.position, 'camera.position');
        const lookAt = vectorArg(args.camera.lookAt, 'camera.lookAt');
        const delta = lookAt.map((n, i) => n - position[i]);
        if (Math.hypot(...delta) < 0.001) throw new Error('camera.position and lookAt must differ.');
        const up = args.camera.up === undefined ? [0, 1, 0] : vectorArg(args.camera.up, 'camera.up');
        const cross = [delta[1] * up[2] - delta[2] * up[1], delta[2] * up[0] - delta[0] * up[2], delta[0] * up[1] - delta[1] * up[0]];
        if (Math.hypot(...up) < 0.001 || Math.hypot(...cross) / Math.hypot(...delta) / Math.hypot(...up) < 0.001) throw new Error('camera.up must be nonzero and not parallel to its viewing direction.');
        sent.camera = { position, lookAt, up, ...(args.camera.fieldOfView !== undefined ? { fieldOfView: finiteArg(args.camera, 'fieldOfView', 70, 1, 120) } : {}) };
    }
    sent.padding = finiteArg(args, 'padding', 10, 0, 10_000);
    for (const name of ['width', 'height']) {
        const value = finiteArg(args, name, 768, 64, 1024);
        if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
        sent[name] = value;
    }
    if (args.labels !== undefined && typeof args.labels !== 'boolean') throw new Error('labels must be a boolean.');
    sent.labels = args.labels === true;
    // Falling back to the Studio selection would frame whatever the user or another agent last selected.
    const presets = Array.isArray(args.views) && args.views.some(view => view !== 'current');
    if (sent.target === undefined && (presets || sent.labels)) throw new Error('Preset views and labels need target: instance paths, or "$selection" to frame the current Studio selection on purpose.');
    if (args.saveDir !== undefined) {
        const saveDir = stringArg(args, 'saveDir', true) as string;
        if (!isAbsolute(saveDir)) throw new Error('saveDir must be an absolute folder path.');
    }
    if (args.fileName !== undefined && !/^[\w.-]{1,80}$/.test(stringArg(args, 'fileName', true) as string)) throw new Error('fileName may only use letters, digits, ".", "_" and "-" (max 80 characters).');
    if (args.uploadAs !== undefined && args.uploadAs !== 'Image' && args.uploadAs !== 'Decal') throw new Error('uploadAs must be "Image" or "Decal".');
    return sent;
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

/** Lossless PNG encoding using only Node built-ins; no image runtime dependency. */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024 || rgba.length !== width * height * 4) throw new Error('Invalid screenshot RGBA dimensions or byte count.');
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const rows = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

const digits = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];

/** Draw annotations after capture so viewport UI visibility does not affect label ids. */
export function drawCaptureLabels(rgba: Buffer, width: number, height: number, labels: unknown): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024 || rgba.length !== width * height * 4) throw new Error('Invalid label image dimensions.');
    if (!Array.isArray(labels) || labels.length > 200) throw new Error('Invalid screenshot labels.');
    const pixel = (x: number, y: number, color: number): void => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const offset = (y * width + x) * 4;
        rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = color; rgba[offset + 3] = 255;
    };
    for (const label of labels) {
        if (!isRecord(label) || !Number.isInteger(label.id) || (label.id as number) < 1 || (label.id as number) > 200 || !isRecord(label.pixel)
            || typeof label.pixel.x !== 'number' || typeof label.pixel.y !== 'number' || !Number.isFinite(label.pixel.x) || !Number.isFinite(label.pixel.y)) throw new Error('Invalid screenshot label coordinates or id.');
        // Label pixels are reprojected from the raycast hit, so one on a part's silhouette can land just off the image.
        if (label.pixel.x < -16 || label.pixel.y < -16 || label.pixel.x >= width + 16 || label.pixel.y >= height + 16) continue;
        const x = Math.min(Math.max(label.pixel.x, 0), width - 1), y = Math.min(Math.max(label.pixel.y, 0), height - 1);
        const text = String(label.id), boxWidth = text.length * 8 + 6;
        const left = Math.round(x - boxWidth / 2), top = Math.round(y - 8);
        for (let y = top; y < top + 16; y++) for (let x = left; x < left + boxWidth; x++) pixel(x, y, 20);
        for (let i = 0; i < text.length; i++) {
            const glyph = digits[Number(text[i])];
            for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (glyph[y * 3 + x] === '1')
                for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) pixel(left + 4 + i * 8 + x * 2 + dx, top + 3 + y * 2 + dy, 255);
        }
    }
}

const round2 = (value: unknown): unknown => typeof value === 'number' ? Math.round(value * 100) / 100 : Array.isArray(value) ? value.map(round2) : value;

/** The camera and label fields an agent needs for follow-up picks, without the raw CFrame matrix. */
function compactView(view: Record<string, unknown>): Record<string, unknown> {
    const camera = isRecord(view.camera) ? view.camera : {};
    const out: Record<string, unknown> = {
        viewIndex: view.viewIndex, view: view.view, width: view.width, height: view.height,
        camera: { position: round2(camera.position), lookDirection: round2(camera.lookDirection), up: round2(camera.up), fieldOfView: round2(camera.fieldOfView) },
    };
    if (Array.isArray(view.labels) && view.labels.length) {
        out.labels = view.labels.filter(isRecord).map(label => ({ id: label.id, path: label.path, pixel: isRecord(label.pixel) ? [Math.round(Number(label.pixel.x)), Math.round(Number(label.pixel.y))] : undefined }));
        if (view.labelsTruncated === true) out.labelsTruncated = true;
    }
    return out;
}

interface CaptureImage { viewIndex: number; view: string; png: Buffer }

function captureResult(data: Record<string, unknown>): { metadata: Record<string, unknown>; views: Array<Record<string, unknown>>; images: CaptureImage[] } | string {
    if (!Array.isArray(data.views)) return JSON.stringify(data);
    if (data.views.length < 1 || data.views.length > 4) throw new Error('Studio returned an invalid view count.');
    const images: CaptureImage[] = [];
    const views: Array<Record<string, unknown>> = [];
    for (const raw of data.views) {
        const view = dataRecord(raw);
        const { imageBase64: providedPng, pixelsBase64 } = view;
        let png: Buffer;
        if (pixelsBase64 !== undefined) {
            if (typeof pixelsBase64 !== 'string' || pixelsBase64.length > 6 * 1024 * 1024 || pixelsBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pixelsBase64)) throw new Error('Invalid screenshot pixel buffer.');
            const pixels = Buffer.from(pixelsBase64, 'base64');
            if (pixels.toString('base64') !== pixelsBase64) throw new Error('Invalid screenshot base64 encoding.');
            const width = view.width as number, height = view.height as number;
            if (view.labels !== undefined) drawCaptureLabels(pixels, width, height, view.labels);
            png = encodeRgbaPng(width, height, pixels);
        } else {
            if (typeof providedPng !== 'string' || providedPng.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(providedPng) || providedPng.length % 4 !== 0) throw new Error('Studio returned an invalid PNG screenshot.');
            png = Buffer.from(providedPng, 'base64');
        }
        if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Studio returned an invalid PNG screenshot.');
        images.push({ viewIndex: Number(view.viewIndex) || images.length + 1, view: textValue(view, 'view', 'view'), png });
        views.push(compactView(view));
    }
    const metadata: Record<string, unknown> = { captureId: data.captureId, place: data.place, mode: data.mode, targets: data.targets };
    return { metadata, views, images };
}

async function saveCaptureImages(images: CaptureImage[], saveDir: string, fileName: string): Promise<string[]> {
    await mkdir(saveDir, { recursive: true });
    const paths: string[] = [];
    for (const image of images) {
        const path = join(saveDir, images.length === 1 ? `${fileName}.png` : `${fileName}-${image.viewIndex}-${image.view}.png`);
        await writeFile(path, image.png);
        paths.push(path);
    }
    return paths;
}

// ---------------------------------------------------------------- Open Cloud uploads

interface CloudConfig { apiKey?: string; groupId?: string; userId?: string; universeId?: string }

const OPEN_CLOUD = 'https://apis.roblox.com/assets/v1';
/** Tool calls are cut off by DSH after 60s, so status checks stop waiting a little before that. */
const UPLOAD_BUDGET_MS = 45_000;
/** Background jobs keep going after this; the tool returns a job id for roblox_job_status instead. */
const JOB_INLINE_WAIT_MS = 40_000;
/** Background jobs are not bound by the tool call limit, so they give Open Cloud longer to answer. */
const JOB_POLL_BUDGET_MS = 5 * 60_000;
const ASSET_TYPES: Record<string, { type: string; mime: string }> = {
    '.fbx': { type: 'Model', mime: 'model/fbx' },
    '.gltf': { type: 'Model', mime: 'model/gltf+json' },
    '.glb': { type: 'Model', mime: 'model/gltf-binary' },
    '.rbxm': { type: 'Model', mime: 'model/x-rbxm' },
    '.rbxmx': { type: 'Model', mime: 'model/x-rbxm' },
    '.png': { type: 'Image', mime: 'image/png' },
    '.jpg': { type: 'Image', mime: 'image/jpeg' },
    '.jpeg': { type: 'Image', mime: 'image/jpeg' },
    '.bmp': { type: 'Image', mime: 'image/bmp' },
    '.tga': { type: 'Image', mime: 'image/tga' },
    '.mp3': { type: 'Audio', mime: 'audio/mpeg' },
    '.ogg': { type: 'Audio', mime: 'audio/ogg' },
    '.wav': { type: 'Audio', mime: 'audio/wav' },
    '.flac': { type: 'Audio', mime: 'audio/flac' },
    '.mp4': { type: 'Video', mime: 'video/mp4' },
    '.mov': { type: 'Video', mime: 'video/mov' },
};
/** Other asset types a file may be uploaded as instead of the one picked from its extension. */
const ASSET_TYPE_OVERRIDES: Record<string, string[]> = { Image: ['Image', 'Decal'], Model: ['Model', 'Animation'] };
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ASSET_PERMISSIONS = 'https://apis.roblox.com/asset-permissions-api/v1/assets/permissions';

function cloudConfigPath(): string {
    if (!state.ctx) throw new Error('The Roblox toolpack is not running.');
    return join(state.ctx.dataDir, 'opencloud.json');
}

async function readCloudConfig(): Promise<CloudConfig> {
    let stored: CloudConfig = {};
    try { stored = JSON.parse(await readFile(cloudConfigPath(), 'utf8')) as CloudConfig; } catch { /* Not configured yet. */ }
    // The install script leaves empty "" placeholders for the user to fill in; treat those as unset.
    const value = (env: string | undefined, saved: unknown): string | undefined => env || (typeof saved === 'string' && saved.trim() ? saved.trim() : undefined);
    return {
        apiKey: value(process.env.DSH_ROBLOX_API_KEY, stored.apiKey),
        groupId: value(process.env.DSH_ROBLOX_GROUP_ID, stored.groupId),
        userId: value(process.env.DSH_ROBLOX_USER_ID, stored.userId),
        universeId: value(process.env.DSH_ROBLOX_UNIVERSE_ID, stored.universeId),
    };
}

async function requireCloud(): Promise<{ apiKey: string; groupId: string; userId?: string }> {
    const config = await readCloudConfig();
    if (!config.apiKey || !config.groupId) throw new Error(`Open Cloud is not configured. Ask the user to create a key at https://create.roblox.com/dashboard/credentials and paste it, plus their group id (the number in the group's URL), between the quotes of "apiKey" and "groupId" in ${cloudConfigPath()} (or set DSH_ROBLOX_API_KEY and DSH_ROBLOX_GROUP_ID). groupId can also be set with roblox_cloud_config. Use a user-owned key with Assets API read and write; the key's owner needs permission to create assets in the group.`);
    return config as { apiKey: string; groupId: string; userId?: string };
}

async function cloudFetch(apiKey: string, url: string, init: { method?: string; body?: FormData | string; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'x-api-key': apiKey };
    if (typeof init.body === 'string') headers['content-type'] = 'application/json';
    const timeoutMs = init.timeoutMs ?? 30_000;
    let response: Response;
    try { response = await fetch(url, { method: init.method ?? 'GET', headers, body: init.body, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error(`Open Cloud did not answer within ${timeoutMs / 1000}s (${init.method ?? 'GET'} ${new URL(url).pathname}).`);
        throw error;
    }
    const text = await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok) {
        const message = isRecord(body) ? String(body.message ?? body.error ?? text) : text;
        throw new Error(`Open Cloud ${response.status}: ${message.slice(0, 500)}${response.status === 401 || response.status === 403 ? ' (check the API key, its permissions/scopes for this API, allowed IPs, and that the key owner has access to the group\'s assets)' : ''}`);
    }
    return isRecord(body) ? body : {};
}

interface UploadResult { done: boolean; operationId: string; assetId?: string; revisionId?: string; moderation?: string; error?: string }

function operationResult(operation: Record<string, unknown>, operationId: string): UploadResult {
    if (operation.done !== true) return { done: false, operationId };
    if (isRecord(operation.error)) return { done: true, operationId, error: String(operation.error.message ?? JSON.stringify(operation.error)) };
    const response = isRecord(operation.response) ? operation.response : {};
    const moderation = isRecord(response.moderationResult) ? String(response.moderationResult.moderationState ?? '') : undefined;
    return { done: true, operationId, assetId: response.assetId === undefined ? undefined : String(response.assetId), revisionId: response.revisionId === undefined ? undefined : String(response.revisionId), moderation };
}

/** The operation id of an Open Cloud long-running operation, or '' when the response is not one. */
function operationIdOf(response: Record<string, unknown>): string {
    if (typeof response.operationId === 'string') return response.operationId;
    return typeof response.path === 'string' && response.path.startsWith('operations/') ? response.path.slice('operations/'.length) : '';
}

async function pollOperation(apiKey: string, operationId: string, deadline: number): Promise<UploadResult> {
    for (let delay = 1_000; ; delay = Math.min(delay * 1.5, 5_000)) {
        const result = operationResult(await cloudFetch(apiKey, `${OPEN_CLOUD}/operations/${encodeURIComponent(operationId)}`), operationId);
        if (result.done || Date.now() + delay > deadline) return result;
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

async function uploadAsset(content: Buffer, fileName: string, mime: string, assetType: string, displayName: string, description: string, deadline: number): Promise<UploadResult> {
    const { apiKey, groupId } = await requireCloud();
    const form = new FormData();
    form.append('request', JSON.stringify({ assetType, displayName: displayName.slice(0, 50), description: description.slice(0, 1000), creationContext: { creator: { groupId } } }));
    form.append('fileContent', new Blob([new Uint8Array(content)], { type: mime }), fileName);
    const operation = await cloudFetch(apiKey, `${OPEN_CLOUD}/assets`, { method: 'POST', body: form, timeoutMs: 120_000 });
    const operationId = operationIdOf(operation);
    if (!operationId) throw new Error(`Open Cloud returned no operation: ${JSON.stringify(operation).slice(0, 500)}`);
    const first = operationResult(operation, operationId);
    const result = first.done ? first : await pollOperation(apiKey, operationId, deadline);
    if (result.assetId) await recordAsset({ assetId: result.assetId, type: assetType, name: displayName.slice(0, 50), at: new Date().toISOString() });
    return result;
}

// Open Cloud cannot list a group's assets, so roblox_list shows the ones uploaded through this toolpack.
interface UploadedAsset { assetId: string; type: string; name: string; at: string }
const MAX_UPLOAD_RECORDS = 2000;
let uploadRecordWrite: Promise<void> = Promise.resolve();

function uploadRecordPath(): string { return join(state.ctx!.dataDir, 'uploaded-assets.json'); }

async function readUploadRecords(): Promise<UploadedAsset[]> {
    try {
        const records = JSON.parse(await readFile(uploadRecordPath(), 'utf8')) as unknown;
        return Array.isArray(records) ? records.filter((record): record is UploadedAsset => isRecord(record) && typeof record.assetId === 'string') : [];
    } catch { return []; }
}

function recordAsset(entry: UploadedAsset): Promise<void> {
    // Chained so parallel uploads do not overwrite each other's records.
    uploadRecordWrite = uploadRecordWrite.then(async () => {
        const records = await readUploadRecords();
        await mkdir(state.ctx!.dataDir, { recursive: true });
        await writeFile(uploadRecordPath(), JSON.stringify([entry, ...records].slice(0, MAX_UPLOAD_RECORDS)), 'utf8');
    }).catch(() => undefined);
    return uploadRecordWrite;
}

// ---------------------------------------------------------------- game passes and developer products

const STORE_KINDS = {
    GamePass: { label: 'Game pass', url: 'https://apis.roblox.com/game-passes/v1/universes', segment: 'game-passes', id: 'gamePassId', list: 'gamePasses', icon: 'iconAssetId', scope: 'game-pass', usage: 'MarketplaceService:UserOwnsGamePassAsync / PromptGamePassPurchase' },
    DeveloperProduct: { label: 'Developer product', url: 'https://apis.roblox.com/developer-products/v2/universes', segment: 'developer-products', id: 'productId', list: 'developerProducts', icon: 'iconImageAssetId', scope: 'developer-product', usage: 'MarketplaceService:PromptProductPurchase, granted in ProcessReceipt' },
} as const;
type StoreKind = keyof typeof STORE_KINDS;
const STORE_ONLY_FIELDS = ['price', 'isForSale', 'managedPricing', 'gift', 'universeId'];
const ICON_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
/** Creating the same pass twice by retrying would leave a duplicate on the experience. */
const recentStoreCreates = new Map<string, { at: number; text: string; data: Record<string, unknown> }>();

function isStoreKind(type: string | undefined): type is StoreKind { return type === 'GamePass' || type === 'DeveloperProduct'; }

async function requireApiKey(): Promise<string> {
    const { apiKey } = await readCloudConfig();
    if (!apiKey) throw new Error(`Open Cloud is not configured. Ask the user to put {"apiKey": "..."} in ${cloudConfigPath()} or set DSH_ROBLOX_API_KEY.`);
    return apiKey;
}

/** universeId argument, then roblox_cloud_config, then the experience open in the connected Studio place. */
async function resolveUniverse(args: Record<string, unknown>): Promise<string> {
    const given = stringArg(args, 'universeId');
    if (given !== undefined) {
        if (!/^\d+$/.test(given)) throw new Error('universeId must be the numeric experience (universe) id.');
        return given;
    }
    const { universeId } = await readCloudConfig();
    if (universeId) return universeId;
    let place: Place;
    try { place = resolvePlace(args); }
    catch (error) { throw new Error(`No experience to use: pass universeId, store one with roblox_cloud_config, or connect Studio with the published place open. (${error instanceof Error ? error.message : String(error)})`); }
    const [gameId] = await luau(place, 'return tostring(game.GameId)', 10_000);
    if (!gameId || gameId === '0') throw new Error(`${place.name} is not published to an experience (game.GameId is 0). Pass universeId or store it with roblox_cloud_config.`);
    return gameId;
}

async function storeFetch(kind: StoreKind, universeId: string, suffix: string, init: { method?: string; body?: FormData; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const spec = STORE_KINDS[kind];
    try { return await cloudFetch(await requireApiKey(), `${spec.url}/${universeId}/${spec.segment}${suffix}`, { timeoutMs: 20_000, ...init }); }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(/^Open Cloud 40[13]/.test(message) ? `${message} The key needs the ${spec.scope}:read and ${spec.scope}:write permissions for experience ${universeId}.` : message);
    }
}

function storePricing(item: Record<string, unknown>): { price: string; managed: string } {
    const info = isRecord(item.priceInformation) ? item.priceInformation : {};
    const features = stringArray(info.enabledFeatures).filter(feature => feature !== 'Invalid');
    const price = typeof info.defaultPriceInRobux === 'number' ? `${info.defaultPriceInRobux} R$` : 'no price';
    return { price, managed: `${item.isManagedPricingEnabled === true ? 'on' : 'off'}${features.length ? ` (${features.join(', ')})` : ''}` };
}

function describeStoreItem(kind: StoreKind, item: Record<string, unknown>): string {
    const spec = STORE_KINDS[kind];
    const { price, managed } = storePricing(item);
    const icon = item[spec.icon];
    return `${spec.label} ${String(item[spec.id])}: "${String(item.name ?? '')}" | ${item.isForSale === true ? 'on sale' : 'off sale'} | ${price} | managed pricing: ${managed}${icon ? ` | icon: rbxassetid://${String(icon)}` : ''}${item.isImmutable === true ? ' | immutable' : ''}`;
}

/** Multipart fields shared by create and update. New items stay off sale unless isForSale is passed. */
async function storeForm(args: Record<string, unknown>, creating: boolean): Promise<{ form: FormData; fields: string[] }> {
    const form = new FormData();
    const fields: string[] = [];
    const set = (key: string, value: string | Blob, fileName?: string): void => { if (value instanceof Blob) form.append(key, value, fileName); else form.append(key, value); fields.push(key); };
    const name = stringArg(args, 'name');
    if (name !== undefined) set('name', name);
    const description = stringArg(args, 'description');
    if (description !== undefined) set('description', description);
    if (args.price !== undefined) {
        if (typeof args.price !== 'number' || !Number.isInteger(args.price) || args.price < 0) throw new Error('price must be a whole number of Robux.');
        set('price', String(args.price));
    }
    for (const key of ['isForSale', 'managedPricing', 'gift']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
    if (args.gift === true && args.managedPricing === true) throw new Error('Gift items need one fixed price, so they cannot use managed pricing. Drop managedPricing or gift.');
    // A gift bought at a regional discount would hand out an item worth more elsewhere, so gifts use a fixed price.
    const managed = args.gift === true ? false : args.managedPricing as boolean | undefined;
    if (managed !== undefined) set('isManagedPricingEnabled', String(managed));
    if (args.isForSale !== undefined) set('isForSale', String(args.isForSale));
    else if (creating) set('isForSale', 'false');
    if (creating && args.isForSale === true && args.price === undefined) throw new Error('Pass price (Robux) to put a new item on sale.');
    const path = stringArg(args, 'path');
    if (path !== undefined) {
        const mime = ICON_MIME[extname(path).toLowerCase()];
        if (!mime) throw new Error('The icon (path) must be a .png or .jpg file; 512x512 works well (imaging_icon_set can make one).');
        set('imageFile', new Blob([new Uint8Array(await readUploadFile(path))], { type: mime }), basename(path));
    }
    return { form, fields };
}

async function createStoreItem(kind: StoreKind, args: Record<string, unknown>): Promise<unknown> {
    if (stringArg(args, 'name') === undefined) throw new Error(`name is required to create a ${STORE_KINDS[kind].label.toLowerCase()}.`);
    const universeId = await resolveUniverse(args);
    const key = jobKey(kind, universeId, args.name);
    for (const [entry, value] of recentStoreCreates) if (Date.now() - value.at > 10 * 60_000) recentStoreCreates.delete(entry);
    const previous = recentStoreCreates.get(key);
    if (previous && args.force !== true) return withData(`Already created in the last 10 minutes (pass force: true to create another):\n${previous.text}`, previous.data);
    const { form } = await storeForm(args, true);
    const item = await storeFetch(kind, universeId, '', { method: 'POST', body: form, timeoutMs: 45_000 });
    const spec = STORE_KINDS[kind];
    const lines = [`Created ${describeStoreItem(kind, item)}`, `Experience ${universeId}. Use id ${String(item[spec.id])} with ${spec.usage}.`];
    if (item.isManagedPricingEnabled === true && args.managedPricing === undefined) lines.push('Managed pricing is on (Roblox enrolls new items by default); pass managedPricing: false for one fixed price everywhere.');
    const text = lines.join('\n');
    const data = { type: kind, id: String(item[spec.id]), universeId, name: item.name, isForSale: item.isForSale === true };
    recentStoreCreates.set(key, { at: Date.now(), text, data });
    return withData(text, data);
}

async function updateStoreItem(kind: StoreKind, id: string, args: Record<string, unknown>): Promise<string> {
    const universeId = await resolveUniverse(args);
    const { form, fields } = await storeForm(args, false);
    if (!fields.length) throw new Error('Nothing to update: pass name, description, price, isForSale, managedPricing, gift, or path (new icon).');
    const before = await storeFetch(kind, universeId, `/${id}/creator`, { timeoutMs: 12_000 });
    if (before.isImmutable === true) throw new Error(`${STORE_KINDS[kind].label} ${id} is immutable (for example a commerce product) and cannot be changed.`);
    await storeFetch(kind, universeId, `/${id}`, { method: 'PATCH', body: form, timeoutMs: 25_000 });
    const after = await storeFetch(kind, universeId, `/${id}/creator`, { timeoutMs: 12_000 });
    // Price, sale state and pricing mode are spelled out so a money-affecting change is never silent.
    const changes: string[] = [];
    const was = storePricing(before), now = storePricing(after);
    if (was.price !== now.price) changes.push(`price: ${was.price} → ${now.price}`);
    if (before.isForSale !== after.isForSale) changes.push(`sale: ${before.isForSale === true ? 'on' : 'off'} → ${after.isForSale === true ? 'on' : 'off'}`);
    if (was.managed !== now.managed) changes.push(`managed pricing: ${was.managed} → ${now.managed}`);
    if (before.name !== after.name) changes.push(`name: "${String(before.name)}" → "${String(after.name)}"`);
    return [`Updated ${describeStoreItem(kind, after)}`, changes.length ? `Changed: ${changes.join('; ')}` : 'No visible change in price, sale state, pricing mode, or name.'].join('\n');
}

/** An upload's ids as chaining data; assetUri is ready for properties such as Image or SoundId. */
function uploadData(kind: string, result: UploadResult): Record<string, unknown> {
    return {
        type: kind,
        operationId: result.operationId,
        done: result.done,
        ...(result.assetId ? { assetId: result.assetId, assetUri: `rbxassetid://${result.assetId}` } : {}),
        ...(result.revisionId ? { revisionId: result.revisionId } : {}),
        ...(result.moderation ? { moderation: result.moderation } : {}),
        ...(result.error ? { error: result.error } : {}),
    };
}

function describeUpload(kind: string, result: UploadResult): string {
    if (result.error) return `${kind} upload failed (operation ${result.operationId}): ${result.error}`;
    if (!result.done || !result.assetId) return `${kind} upload is still processing (operation ${result.operationId}). Check it with roblox_asset_status.`;
    return `${kind} uploaded: asset id ${result.assetId} (rbxassetid://${result.assetId})${result.revisionId ? `, revision ${result.revisionId}` : ''}${result.moderation ? ` (moderation: ${result.moderation})` : ''}.`;
}

// ---------------------------------------------------------------- background jobs

interface Job {
    id: string; kind: string; key?: string; status: 'running' | 'done' | 'failed';
    started: number; finished?: number; lines: string[]; done: Promise<void>;
    /** Ids the work produced (assetId, inserted paths...), returned as chaining data for DSH batches. */
    data: Record<string, unknown>;
}

const JOB_TTL_MS = 30 * 60_000;
const jobs = new Map<string, Job>();
let nextJob = 1;

function pruneJobs(): void {
    for (const [id, job] of jobs) if (job.finished && Date.now() - job.finished > JOB_TTL_MS) jobs.delete(id);
}

/** Runs work past the 60s tool limit. Work reports progress by pushing lines and ids into data; a thrown error fails the job. */
function startJob(kind: string, key: string | undefined, work: (lines: string[], data: Record<string, unknown>) => Promise<void>): Job {
    pruneJobs();
    const job: Job = { id: `job-${nextJob++}`, kind, key, status: 'running', started: Date.now(), lines: [], done: Promise.resolve(), data: {} };
    job.done = work(job.lines, job.data).then(
        () => { job.status = 'done'; },
        (error: unknown) => { job.status = 'failed'; job.lines.push(`Failed: ${error instanceof Error ? error.message : String(error)}`); },
    ).finally(() => { job.finished = Date.now(); });
    jobs.set(job.id, job);
    return job;
}

function describeJob(job: Job): string {
    const seconds = Math.round(((job.finished ?? Date.now()) - job.started) / 1000);
    const header = job.status === 'running'
        ? `${job.kind} ${job.id} is still running (${seconds}s). Check again with roblox_job_status {"jobId": "${job.id}"}.`
        : `${job.kind} ${job.id} ${job.status === 'done' ? 'finished' : 'failed'} after ${seconds}s.`;
    return [header, ...job.lines].join('\n');
}

/** Waits for a job inside the tool call budget, then describes it either way. */
async function awaitJob(job: Job, waitMs = JOB_INLINE_WAIT_MS): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
    clearTimeout(timer);
    return describeJob(job);
}

/** A tool result with text for the agent and chaining data for DSH batches ("{{1.assetId}}"). */
function withData(text: string, data: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }>; data: Record<string, unknown> } {
    return { content: [{ type: 'text', text }], data };
}

/** awaitJob as a tool result: the job's description plus its id, status and the ids it produced. */
async function awaitJobResult(job: Job, waitMs = JOB_INLINE_WAIT_MS, prefix = ''): Promise<unknown> {
    const text = await awaitJob(job, waitMs);
    return withData(prefix ? `${prefix}\n${text}` : text, { jobId: job.id, status: job.status, ...job.data });
}

/** A retry of a call that timed out on the DSH side finds the original job instead of uploading twice. */
function existingJob(key: string): Job | undefined {
    pruneJobs();
    return [...jobs.values()].find(job => job.key === key && (job.status === 'running' || (job.status === 'done' && Date.now() - (job.finished ?? 0) < 10 * 60_000)));
}

function jobKey(...parts: unknown[]): string { return createHash('sha1').update(JSON.stringify(parts)).digest('hex'); }

function assetIdArg(args: Record<string, unknown>, name = 'assetId'): string {
    const assetId = stringArg(args, name, true) as string;
    if (!/^\d+$/.test(assetId)) throw new Error(`${name} must be a numeric id.`);
    return assetId;
}

/** Reads a local file for upload after checking it exists, is absolute, and fits the Open Cloud size limit. */
async function readUploadFile(path: string): Promise<Buffer> {
    if (!isAbsolute(path)) throw new Error('path must be absolute.');
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`${path} does not exist.`);
    if (info.size > MAX_UPLOAD_BYTES) throw new Error(`${path} is ${(info.size / 1048576).toFixed(1)} MB; Open Cloud accepts files up to 20 MB.`);
    return readFile(path);
}

// ---------------------------------------------------------------- Studio helpers

/** Lua string literal for arbitrary text; non-ASCII bytes stay raw UTF-8, which Luau accepts. */
function luaString(text: string): string {
    return `"${text.replace(/[\\"\x00-\x1f\x7f]/g, char => `\\${char.charCodeAt(0).toString().padStart(3, '0')}`)}"`;
}

/** Same path rules as splitPath in DSHBridge.server.lua, so paths returned by tree/find work everywhere. */
const LUAU_RESOLVE = `local function dshResolve(path)
	local separator = string.find(string.gsub(path, "\\\\.", ""), "/", 1, true) and "/" or "."
	local segments, current, index = {}, {}, 1
	while index <= #path do
		local char = string.sub(path, index, index)
		if char == "\\\\" and index < #path then
			index += 1
			table.insert(current, string.sub(path, index, index))
		elseif char == separator then
			if #current > 0 then table.insert(segments, table.concat(current)) end
			table.clear(current)
		else
			table.insert(current, char)
		end
		index += 1
	end
	if #current > 0 then table.insert(segments, table.concat(current)) end
	local node = game
	for i, segment in ipairs(segments) do
		if not (i == 1 and segment == "game") then
			local child = node:FindFirstChild(segment)
			if not child and node == game then
				local ok, service = pcall(game.GetService, game, segment)
				if ok then child = service end
			end
			if not child then error("No instance at " .. path .. " (missing " .. segment .. ")", 0) end
			node = child
		end
	end
	return node
end
`;

const LUAU_BASE64 = `local function dshBase64(data)
	local chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	local map = {}
	for i = 1, 64 do map[i - 1] = string.byte(chars, i) end
	local len = buffer.len(data)
	local out = buffer.create(math.ceil(len / 3) * 4)
	local o = 0
	for i = 0, len - 1, 3 do
		local a = buffer.readu8(data, i)
		local b = if i + 1 < len then buffer.readu8(data, i + 1) else 0
		local c = if i + 2 < len then buffer.readu8(data, i + 2) else 0
		local n = a * 65536 + b * 256 + c
		buffer.writeu8(out, o, map[bit32.rshift(n, 18)])
		buffer.writeu8(out, o + 1, map[bit32.band(bit32.rshift(n, 12), 63)])
		buffer.writeu8(out, o + 2, if i + 1 < len then map[bit32.band(bit32.rshift(n, 6), 63)] else 61)
		buffer.writeu8(out, o + 3, if i + 2 < len then map[bit32.band(n, 63)] else 61)
		o += 4
	end
	return buffer.tostring(out)
end
`;

async function luau(place: Place, code: string, timeoutMs = 30_000): Promise<string[]> {
    const data = dataRecord(await command(place, 'execute', { code }, timeoutMs));
    return stringArray(data.returns);
}

/** Moves the contents of an uploaded Model asset into Studio and returns the new instance paths. */
async function insertAsset(place: Place, assetId: string, parent: string): Promise<string[]> {
    return luau(place, `${LUAU_RESOLVE}
local parent = dshResolve(${luaString(parent)})
local InsertService = game:GetService("InsertService")
local ok, container = pcall(InsertService.LoadAsset, InsertService, ${Number(assetId)})
if not ok then error("InsertService:LoadAsset(${Number(assetId)}) failed: " .. tostring(container) .. " (new uploads can take a moment, or be held by moderation; retry with roblox_insert_asset)", 0) end
local inserted = {}
for _, child in container:GetChildren() do
	child.Parent = parent
	table.insert(inserted, child)
end
container:Destroy()
game:GetService("Selection"):Set(inserted)
return table.unpack(inserted)`);
}

// ---------------------------------------------------------------- animations

interface AnimationFile {
    format: string;
    bones: Array<{ name: string; parent: string | null; rest: number[]; offset: number }>;
    animations: Array<{ name: string; fps: number; times: number[]; tracks: Record<string, number[]> }>;
}

type Mat3 = number[];

function quatToMat(x: number, y: number, z: number, w: number): Mat3 {
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
        2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
        2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
}

function matToQuat(m: Mat3): [number, number, number, number] {
    const trace = m[0] + m[4] + m[8];
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
        const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
        w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
        const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
        w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
    } else {
        const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
        w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
    }
    return [x, y, z, w];
}

function mul(a: Mat3, b: Mat3): Mat3 {
    const out: Mat3 = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
    return out;
}

function transpose(m: Mat3): Mat3 { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }

function readAnimationFile(raw: unknown): AnimationFile {
    if (!isRecord(raw) || raw.format !== 'dsh-animation' || !Array.isArray(raw.bones) || !Array.isArray(raw.animations)) throw new Error('file is not a dsh-animation JSON file (create one with blender_export_animation).');
    return raw as unknown as AnimationFile;
}

/** Pose CFrames as flat x,y,z,qx,qy,qz,qw per bone per key, in the joint frame the rig expects. */
function poseFrames(file: AnimationFile, animation: AnimationFile['animations'][number], space: string, studsPerMeter: number): number[][] {
    return animation.times.map((_, key) => {
        const out: number[] = [];
        for (const bone of file.bones) {
            const track = animation.tracks[bone.name];
            let [x, y, z, qx, qy, qz, qw] = track ? track.slice(key * 7, key * 7 + 7) : [0, 0, 0, 0, 0, 0, 1];
            if (space === 'world') {
                const rest = bone.rest;
                const rotated = mul(mul(rest, quatToMat(qx, qy, qz, qw)), transpose(rest));
                [qx, qy, qz, qw] = matToQuat(rotated);
                [x, y, z] = [rest[0] * x + rest[1] * y + rest[2] * z, rest[3] * x + rest[4] * y + rest[5] * z, rest[6] * x + rest[7] * y + rest[8] * z];
            }
            out.push(...[x * studsPerMeter, y * studsPerMeter, z * studsPerMeter, qx, qy, qz, qw].map(value => Math.round(value * 1e5) / 1e5));
        }
        return out;
    });
}

/** Studs per meter measured from Bone instances in the imported rig that share names with the exported bones. */
async function measureRigScale(place: Place, rig: string, file: AnimationFile): Promise<number | undefined> {
    const returns = await luau(place, `${LUAU_RESOLVE}
local rig = dshResolve(${luaString(rig)})
local lengths = {}
for _, bone in rig:GetDescendants() do
	if bone:IsA("Bone") then table.insert(lengths, bone.Name .. "=" .. tostring(bone.Position.Magnitude)) end
end
return table.concat(lengths, "\\n")`);
    const studs = new Map<string, number>();
    for (const line of (returns[0] ?? '').split('\n')) {
        const at = line.lastIndexOf('=');
        if (at > 0) studs.set(line.slice(0, at), Number(line.slice(at + 1)));
    }
    const ratios = file.bones.filter(bone => bone.parent && bone.offset > 1e-4 && (studs.get(bone.name) ?? 0) > 1e-4).map(bone => studs.get(bone.name)! / bone.offset).sort((a, b) => a - b);
    return ratios.length ? ratios[Math.floor(ratios.length / 2)] : undefined;
}

/** Sends large Luau data in pieces that fit the bridge's 200 KB code limit. */
async function sendChunks(place: Place, key: string, text: string): Promise<void> {
    await luau(place, `shared.__dshAnim = shared.__dshAnim or {}\nshared.__dshAnim[${luaString(key)}] = {}`);
    for (let index = 0; index < text.length; index += 120_000) {
        await luau(place, `table.insert(shared.__dshAnim[${luaString(key)}], ${luaString(text.slice(index, index + 120_000))})`);
    }
}

const BLOB_CHUNK = 1024 * 1024;

/** Reads a base64 string stashed in shared.__dshBlob through the bridge's blob op, 1 MB per round trip. */
async function receiveBlob(place: Place, key: string, length: number): Promise<Buffer> {
    let text = '';
    try {
        while (text.length < length) {
            const data = dataRecord(await command(place, 'blob', { key, offset: text.length + 1, length: BLOB_CHUNK }));
            const part = textValue(data, 'data');
            if (!part) break;
            text += part;
        }
    } finally {
        await command(place, 'blob', { key, delete: true }).catch(() => undefined);
    }
    if (text.length !== length) throw new Error(`Received ${text.length} of ${length} base64 characters from Studio.`);
    return Buffer.from(text, 'base64');
}

const BUILD_KFS = `${LUAU_RESOLVE}${LUAU_BASE64}
local spec = game:GetService("HttpService"):JSONDecode(table.concat(shared.__dshAnim[KEY]))
shared.__dshAnim[KEY] = nil
local parent = dshResolve(spec.parent)
local existing = parent:FindFirstChild(spec.name)
if existing and existing:IsA("KeyframeSequence") then existing:Destroy() end
local kfs = Instance.new("KeyframeSequence")
kfs.Name = spec.name
kfs.Loop = spec.loop
kfs.Priority = Enum.AnimationPriority[spec.priority]
for k, t in ipairs(spec.times) do
	local keyframe = Instance.new("Keyframe")
	keyframe.Time = t
	local root = keyframe
	if spec.root ~= "" then
		root = Instance.new("Pose")
		root.Name = spec.root
		root.Parent = keyframe
	end
	local frame = spec.frames[k]
	local poses = {}
	for i, bone in ipairs(spec.bones) do
		local o = (i - 1) * 7
		local pose = Instance.new("Pose")
		pose.Name = bone.name
		pose.EasingStyle = Enum.PoseEasingStyle.Linear
		pose.CFrame = CFrame.new(frame[o + 1], frame[o + 2], frame[o + 3], frame[o + 4], frame[o + 5], frame[o + 6], frame[o + 7])
		poses[i] = pose
	end
	for i, bone in ipairs(spec.bones) do
		poses[i].Parent = if bone.parent > 0 then poses[bone.parent] else root
	end
	keyframe.Parent = kfs
end
kfs.Parent = parent
local encoded = ""
if spec.upload then
	encoded = dshBase64(game:GetService("SerializationService"):SerializeInstancesAsync({ kfs }))
	shared.__dshBlob = shared.__dshBlob or {}
	shared.__dshBlob[KEY] = encoded
end
return kfs, #encoded`;

const pack: ToolpackDefinition = {
    name: 'roblox',
    // Group, user and experience ids follow the user to other PCs; the API key does not.
    sync: { files: ['opencloud.json'], secrets: ['apiKey'] },
    description: 'Inspect and run Luau, edit scripts, search Creator Store audio (roblox_search_audio), capture viewport images (saved as PNG or uploaded as image assets), read output logs and selection, and control playtests across multiple Roblox Studio places through the paired DSH Bridge plugin. Uploads models, images, decals, audio, video, and Blender/FBX animations to the group through Open Cloud, inserts models into Studio, and manages uploaded assets (info, metadata, new model versions, version history, rollback, archive/restore, experience permissions, upload quotas).',
    async setup(ctx) {
        state.ctx = ctx;
        const envPort = process.env.DSH_ROBLOX_PORT;
        state.port = envPort !== undefined && /^\d+$/.test(envPort) && Number(envPort) < 65536 ? Number(envPort) : DEFAULT_PORT;
        const codePath = join(ctx.dataDir, 'pairing-code.txt');
        await mkdir(ctx.dataDir, { recursive: true });
        try {
            const stored = (await readFile(codePath, 'utf8')).trim().toUpperCase();
            if (/^[A-Z2-9]{8}$/.test(stored) && !/[01OI]/.test(stored)) state.code = stored;
        } catch { /* Generate the code below when there is no saved code. */ }
        if (!state.code) {
            state.code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
            await writeFile(codePath, state.code, 'utf8');
        }
        state.lastStatus = '';
        const server = createServer((req, res) => {
            void handle(req, res).catch((error: unknown) => {
                ctx.log(`Roblox bridge request failed: ${error instanceof Error ? error.message : String(error)}`);
                json(res, 500, { error: 'internal server error' });
            });
        });
        state.server = server;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                server.removeListener('listening', onListening);
                reject(new Error(`Could not start Roblox bridge on port ${state.port}: ${error.message}`));
            };
            const onListening = (): void => {
                server.removeListener('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(state.port, '127.0.0.1');
        });
        // Port 0 (tests) picks a free port; the status line shows it as part of the pairing code.
        const address = server.address();
        if (address && typeof address === 'object') state.port = address.port;
        updateStatus();
        state.statusTimer = setInterval(updateStatus, 5_000);
        state.statusTimer.unref();
    },
    async teardown() {
        if (state.statusTimer) clearInterval(state.statusTimer);
        state.statusTimer = undefined;
        for (const place of state.places.values()) for (const waiter of place.waiters.splice(0)) {
            waiter.closed = true;
            clearTimeout(waiter.timer);
            if (!waiter.res.destroyed && !waiter.res.writableEnded) { waiter.res.writeHead(204); waiter.res.end(); }
        }
        for (const pending of state.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Roblox bridge shut down.'));
        }
        state.pending.clear();
        state.places.clear();
        jobs.clear();
        const server = state.server;
        state.server = undefined;
        if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        state.ctx = undefined;
        state.lastStatus = '';
        state.code = '';
    },
    tools: [
        {
            name: 'capture_view',
            description: 'Capture Studio viewport images with camera metadata. No arguments captures the current editor view. Preset views and camera render through a separate capture camera for two frames, then the user\'s editor camera is always restored; captures from parallel calls run one at a time. saveDir writes PNG files; uploadAs also uploads each image to the group as an Image or Decal asset (turn labels off for assets). Follow up with captureId + viewIndex + pixels to raycast what is under image pixels; captures expire after 5 minutes.',
            inputSchema: {
                type: 'object', additionalProperties: false, properties: {
                    place: placeSchema(),
                    context: contextSchema(true),
                    target: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, description: 'Instance paths to frame, or ["$selection"]. Required for preset views and labels.' },
                    views: { type: 'array', items: { type: 'string', enum: captureViews }, minItems: 1, maxItems: 4, description: 'Up to 4 views. Default: "perspective" with a target, else "current" (the editor view as the user sees it).' },
                    camera: { type: 'object', additionalProperties: false, required: ['position', 'lookAt'], description: 'Explicit camera instead of views, e.g. {"position":[0,20,40],"lookAt":[0,5,0]}. Positions in studs.', properties: { position: vectorSchema, lookAt: vectorSchema, up: vectorSchema, fieldOfView: { type: 'number', minimum: 1, maximum: 120, description: 'Vertical field of view in degrees; defaults to the editor\'s.' } } },
                    padding: { type: 'number', minimum: 0, maximum: 10000, default: 10, description: 'Framing margin in studs.' },
                    labels: { type: 'boolean', default: false, description: 'Draw numbered labels on visible target models/parts and list their paths.' },
                    width: { type: 'integer', minimum: 64, maximum: 1024, default: 768, description: 'Maximum output width in pixels; keeps the viewport aspect ratio.' },
                    height: { type: 'integer', minimum: 64, maximum: 1024, default: 768, description: 'Maximum output height in pixels.' },
                    saveDir: { type: 'string', description: 'Absolute folder to write the PNG files into.' },
                    fileName: { type: 'string', description: 'Base file name without extension (default "capture"); several views get "-<index>-<view>" appended.' },
                    uploadAs: { type: 'string', enum: ['Image', 'Decal'], description: 'Upload each captured view to the group through Open Cloud.' },
                    captureId: { type: 'string', description: 'Pick mode: the captureId of an earlier capture.' },
                    viewIndex: { type: 'integer', minimum: 1, maximum: 4, default: 1, description: 'Pick mode: which view of that capture (1-based).' },
                    pixels: { type: 'array', minItems: 1, maxItems: 100, description: 'Pick mode: zero-based pixel coordinates in that view\'s image.', items: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 } } } },
                    maxDistance: { type: 'number', minimum: 1, maximum: 100000, default: 10000, description: 'Pick mode: ray length in studs.' },
                }
            },
            async run(args) {
                const sent = captureArgs(args);
                if (args.uploadAs !== undefined) await requireCloud();
                const data = dataRecord(await commandAt(args, 'capture_view', sent, 45_000));
                if (sent.captureId) return JSON.stringify(data);
                const result = captureResult(data);
                if (typeof result === 'string') throw new Error('Studio returned no screenshot views. Update the DSH Bridge plugin.');
                const notes: string[] = [];
                if (args.saveDir !== undefined) {
                    const paths = await saveCaptureImages(result.images, args.saveDir as string, (args.fileName as string | undefined) ?? 'capture');
                    result.metadata.files = paths;
                }
                if (args.uploadAs !== undefined) {
                    const assetType = args.uploadAs as string;
                    const base = (args.fileName as string | undefined) ?? `capture-${String(data.captureId).slice(0, 8)}`;
                    const job = startJob(`${assetType} upload`, undefined, async lines => {
                        for (const image of result.images) {
                            const name = result.images.length === 1 ? base : `${base}-${image.viewIndex}-${image.view}`;
                            const upload = await uploadAsset(image.png, `${name}.png`, 'image/png', assetType, name, 'Captured from Roblox Studio by DSH', Date.now() + JOB_POLL_BUDGET_MS);
                            lines.push(`view ${image.viewIndex}: ${describeUpload(assetType, upload)}`);
                        }
                    });
                    notes.push(await awaitJob(job, 25_000));
                }
                const content: Array<Record<string, unknown>> = [{ type: 'text', text: JSON.stringify(result.metadata) }];
                result.images.forEach((image, index) => content.push(
                    { type: 'text', text: JSON.stringify(result.views[index]) },
                    { type: 'image', mimeType: 'image/png', data: image.png.toString('base64') },
                ));
                if (notes.length) content.push({ type: 'text', text: notes.join('\n') });
                return { content };
            },
        },
        {
            name: 'tree',
            description: `List the Roblox instance hierarchy. ${pathDescription}`,
            inputSchema: { type: 'object', properties: { place: placeSchema(), context: contextSchema(), path: { type: 'string' }, depth: { type: 'integer', default: 3 }, maxNodes: { type: 'integer', default: 300 }, className: { type: 'string' } } },
            async run(args) {
                const path = stringArg(args, 'path');
                const depth = numberArg(args, 'depth', 3);
                const maxNodes = numberArg(args, 'maxNodes', 300);
                const className = stringArg(args, 'className');
                const sent: Record<string, unknown> = { depth, maxNodes };
                if (path !== undefined) sent.path = path;
                if (className !== undefined) sent.className = className;
                return formatTree(dataRecord(await commandAt(args, 'tree', sent)), depth);
            },
        },
        {
            name: 'find',
            description: `Find instances by name and/or className. ${pathDescription}`,
            inputSchema: { type: 'object', properties: { place: placeSchema(), context: contextSchema(), path: { type: 'string' }, name: { type: 'string' }, className: { type: 'string' }, limit: { type: 'integer', default: 50 } } },
            async run(args) {
                const path = stringArg(args, 'path');
                const name = stringArg(args, 'name');
                const className = stringArg(args, 'className');
                if (name === undefined && className === undefined) throw new Error('Provide name or className to search.');
                const sent: Record<string, unknown> = { limit: numberArg(args, 'limit', 50) };
                if (path !== undefined) sent.path = path;
                if (name !== undefined) sent.name = name;
                if (className !== undefined) sent.className = className;
                const data = dataRecord(await commandAt(args, 'find', sent));
                const matches = Array.isArray(data.matches) ? data.matches.filter(isRecord).map(match => ({ path: textValue(match, 'path'), className: textValue(match, 'className') })) : [];
                return withData(formatFind(data), { matches, paths: matches.map(match => match.path), truncated: data.truncated === true });
            },
        },
        {
            name: 'properties',
            description: 'Read an instance’s common properties, attributes, and tags. Pass `properties` to read specific property names instead (unreadable ones are reported).',
            inputSchema: { type: 'object', required: ['path'], properties: { place: placeSchema(), context: contextSchema(), path: { type: 'string', description: 'Instance path, e.g. "ReplicatedStorage/Shared/Config".' }, properties: { type: 'array', items: { type: 'string' } } } },
            async run(args) {
                const path = stringArg(args, 'path', true) as string;
                const sent: Record<string, unknown> = { path };
                if (args.properties !== undefined) {
                    if (!Array.isArray(args.properties) || args.properties.some(item => typeof item !== 'string')) throw new Error('properties must be an array of strings.');
                    sent.properties = args.properties;
                }
                return formatProperties(dataRecord(await commandAt(args, 'properties', sent)));
            },
        },
        {
            name: 'source',
            description: 'Read a script’s source with line numbers. Long scripts come back in pieces; continue with startLine.',
            inputSchema: {
                type: 'object', required: ['path'], properties: {
                    place: placeSchema(), context: contextSchema(), path: { type: 'string', description: 'Script path, e.g. "ServerScriptService/Main".' },
                    startLine: { type: 'integer', minimum: 1, default: 1 }, endLine: { type: 'integer', minimum: 1, description: 'Last line to return (inclusive).' },
                    maxChars: { type: 'integer', minimum: 100, maximum: MAX_SOURCE_CHARS, default: 20000 },
                },
            },
            async run(args) {
                const path = stringArg(args, 'path', true) as string;
                const sent: Record<string, unknown> = { path, maxChars: Math.min(Math.max(numberArg(args, 'maxChars', 20_000), 100), MAX_SOURCE_CHARS), startLine: Math.max(numberArg(args, 'startLine', 1), 1) };
                if (args.endLine !== undefined) sent.endLine = numberArg(args, 'endLine', 0);
                return formatSource(dataRecord(await commandAt(args, 'source', sent)));
            },
        },
        {
            name: 'set_source',
            description: 'Change a script\'s source through ScriptEditorService (works while the script is open in an editor; one undo step). Pass edits for targeted find/replace changes (each find must match exactly once), or source to replace the whole script.',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['path'], properties: {
                    place: placeSchema(),
                    path: { type: 'string', description: 'Script path, e.g. "ServerScriptService/Main".' },
                    edits: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['find', 'replace'], properties: { find: { type: 'string', description: 'Exact text, including whitespace.' }, replace: { type: 'string' } } } },
                    source: { type: 'string', description: 'Full new source (max 190000 bytes).' },
                },
            },
            async run(args) {
                const path = stringArg(args, 'path', true) as string;
                const sent: Record<string, unknown> = { path };
                if ((args.edits === undefined) === (args.source === undefined)) throw new Error('Pass exactly one of edits or source.');
                if (args.source !== undefined) sent.source = stringArg(args, 'source', false);
                else {
                    if (!Array.isArray(args.edits) || args.edits.length === 0 || args.edits.length > 50) throw new Error('edits must contain 1 to 50 {find, replace} items.');
                    sent.edits = args.edits.map((edit, i) => {
                        if (!isRecord(edit) || typeof edit.find !== 'string' || edit.find === '' || typeof edit.replace !== 'string') throw new Error(`edits[${i}] needs a nonempty find string and a replace string.`);
                        return { find: edit.find, replace: edit.replace };
                    });
                }
                if (Buffer.byteLength(JSON.stringify(sent), 'utf8') > 190_000) throw new Error('The change is too large to send at once; use smaller edits.');
                const data = dataRecord(await commandFor(args, 'set_source', sent));
                return `Updated ${textValue(data, 'path')} (${typeof data.lineCount === 'number' ? data.lineCount : '?'} lines${typeof data.applied === 'number' ? `, ${data.applied} edit(s) applied` : ''}).`;
            },
        },
        {
            name: 'execute',
            description: 'Run Luau in the paired Studio place to create instances, change properties, or inspect values; print output and return values come back. Variables do not persist between calls. During a playtest it runs in the live game by default (context "server", or "client"), as a game script that shares the game\'s required modules and state; pass context "edit" for the place being edited. The 20s limit only interrupts code that yields (task.wait etc.): always put task.wait() in loops, since a non-yielding infinite loop freezes Studio.',
            inputSchema: {
                type: 'object', required: ['code'], properties: {
                    place: placeSchema(),
                    context: contextSchema(),
                    code: { type: 'string', description: 'Luau source to execute in Studio (max 200000 UTF-8 bytes).' },
                    fresh: { type: 'boolean', description: 'Edit context: require modules from their current Source instead of Studio\'s cache (use after editing modules).' },
                },
            },
            async run(args) {
                const code = codeArg(args);
                const fresh = args.fresh === true;
                const sent: Record<string, unknown> = fresh ? { code, fresh: true } : { code };
                return formatExecute(dataRecord(await commandAt(args, 'execute', sent, 25_000)), fresh);
            },
        },
        {
            name: 'places', description: 'List connected Roblox Studio places and what each is busy with.', inputSchema: { type: 'object', properties: {} },
            run() {
                prunePlaces();
                const places = connectedPlaces();
                if (!places.length) return `No Roblox Studio places connected. Pairing code: ${pairingText()}`;
                return places.map(place => {
                    let line = `${place.name} | placeId: ${place.placeId} | session: ${place.session} | last seen: ${Math.floor((Date.now() - place.lastSeen) / 1000)}s ago`;
                    if (place.inflight) line += ` | busy: ${place.inflight.op} (${Math.round((Date.now() - place.inflight.since) / 1000)}s), ${place.queue.length} queued`;
                    if (place.protocol < PROTOCOL_VERSION) line += ' | plugin outdated: reinstall DSHBridge.server.lua';
                    const test = testSessionFor(place);
                    if (test) line += test.client ? ' | playtest server and client connected' : ' | playtest server connected';
                    return line;
                }).join('\n');
            },
        },
        {
            name: 'output_log', description: 'Read captured Studio output, newest last, optionally filtered by level or text. Each result ends with a cursor; pass it back as since to get only newer entries.',
            inputSchema: { type: 'object', properties: { place: placeSchema(), context: contextSchema(), limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }, level: { type: 'string', enum: ['all', 'output', 'info', 'warning', 'error'] }, contains: { type: 'string', description: 'Case-insensitive text filter.' }, since: { type: 'integer', minimum: 0, description: 'Cursor from an earlier output_log call.' } } },
            async run(args) {
                const sent: Record<string, unknown> = {};
                if (args.clear !== undefined) throw new Error('clear was removed because it wiped the log for every agent; pass since with the cursor from your last call instead.');
                if (args.limit !== undefined) { if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000) throw new Error('limit must be an integer from 1 to 1000.'); sent.limit = args.limit; }
                const level = stringArg(args, 'level'); if (level !== undefined) { if (!['all', 'output', 'info', 'warning', 'error'].includes(level)) throw new Error('level must be all, output, info, warning, or error.'); sent.level = level; }
                const contains = stringArg(args, 'contains'); if (contains !== undefined) sent.contains = contains;
                if (args.since !== undefined) sent.since = numberArg(args, 'since', 0);
                const data = dataRecord(await commandAt(args, 'output_log', sent));
                const lines: string[] = [];
                if (Array.isArray(data.entries)) for (const entry of data.entries) if (isRecord(entry)) {
                    const stamp = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? new Date(entry.timestamp * 1000).toISOString().slice(11, 19) : '??:??:??';
                    lines.push(`[${stamp}] ${textValue(entry, 'level').toUpperCase()} ${textValue(entry, 'message')}`);
                }
                if (!lines.length) lines.push('No log entries.');
                if (data.truncated === true) lines.push(`Showing the newest ${lines.length} of ${typeof data.total === 'number' ? data.total : 'more'} matching entries.`);
                if (typeof data.cursor === 'number') lines.push(`cursor: ${data.cursor}`);
                return lines.join('\n');
            },
        },
        {
            name: 'selection', description: 'Read or set the current Studio selection by instance paths.',
            inputSchema: { type: 'object', properties: { place: placeSchema(), action: { type: 'string', enum: ['get', 'set'] }, paths: { type: 'array', items: { type: 'string' } } } },
            async run(args) {
                const action = stringArg(args, 'action');
                if (action !== undefined && action !== 'get' && action !== 'set') throw new Error('action must be get or set.');
                const sent: Record<string, unknown> = {}; if (action !== undefined) sent.action = action;
                if (action === 'set' && (!Array.isArray(args.paths) || args.paths.some(path => typeof path !== 'string'))) throw new Error('paths must be an array of strings when action is set.');
                if (args.paths !== undefined) { if (!Array.isArray(args.paths) || args.paths.some(path => typeof path !== 'string')) throw new Error('paths must be an array of strings.'); sent.paths = args.paths; }
                const data = dataRecord(await commandFor(args, 'selection', sent));
                const lines: string[] = [];
                if (Array.isArray(data.selection)) for (const item of data.selection) if (isRecord(item)) lines.push(`${textValue(item, 'path')} [${textValue(item, 'className')}]`);
                if (Array.isArray(data.missing) && data.missing.length) lines.push(`Missing: ${stringArray(data.missing).join(', ')}`);
                const selection = Array.isArray(data.selection) ? data.selection.filter(isRecord).map(item => ({ path: textValue(item, 'path'), className: textValue(item, 'className') })) : [];
                return withData(lines.length ? lines.join('\n') : 'Selection is empty.', { selection, paths: selection.map(item => item.path), missing: stringArray(data.missing) });
            },
        },
        {
            name: 'playtest', description: 'Start, stop, or check a Studio playtest. mode "run" (default) simulates without a character; "play" starts Play Solo. start waits until Studio has really entered the test (up to ~30s) and fails with the reason otherwise; stop waits until Studio is back in edit mode. While a test runs, execute, tree, find, properties, source, output_log and capture_view act on the live game (see their context argument); the other tools act on the edit place.',
            inputSchema: { type: 'object', required: ['action'], properties: { place: placeSchema(), action: { type: 'string', enum: ['status', 'start', 'stop'] }, mode: { type: 'string', enum: ['run', 'play'] } } },
            async run(args) {
                const action = stringArg(args, 'action', true) as string;
                if (!['status', 'start', 'stop'].includes(action)) throw new Error('action must be status, start, or stop.');
                const sent: Record<string, unknown> = { action };
                const mode = stringArg(args, 'mode'); if (mode !== undefined) { if (mode !== 'run' && mode !== 'play') throw new Error('mode must be run or play.'); sent.mode = mode; }
                const place = resolvePlace(args);
                const notes: string[] = [];
                if (action === 'stop') {
                    // Only the test's own server can end it reliably; the edit plugin then waits for edit mode.
                    const test = testSessionFor(place);
                    if (test) {
                        // A live test session is always waiting in a poll, so a stop it has not picked up in 3s never will be.
                        try { await command(test, 'end_test', {}, 5_000, 3_000); sent.serverEnded = true; }
                        catch (error) { notes.push(`The playtest server did not take the stop request (${error instanceof Error ? error.message : String(error)}); used Studio's own stop instead.`); }
                    }
                }
                const data = dataRecord(await command(place, 'playtest', sent, action === 'status' ? 10_000 : 40_000));
                if (action === 'start' && data.running === true) {
                    // The test's server copy of the plugin connects within a few seconds; stop works better once it has.
                    const until = Date.now() + 8_000;
                    while (!testSessionFor(place) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 250));
                    if (!testSessionFor(place)) notes.push('The playtest server has not connected to DSH yet; stop will fall back to Studio\'s own stop, which may need a manual Stop in Studio.');
                }
                if (action === 'status' && data.running === true) notes.push(testSessionFor(place) ? 'Playtest server connected.' : 'Playtest server not connected to DSH.');
                return [`${textValue(data, 'message')}\nstate: ${textValue(data, 'state')}`, ...notes].join('\n');
            },
        },
        {
            name: 'cloud_config',
            description: 'Show the Open Cloud setup used by the upload, asset, game pass and developer product tools, or set the group id, the API key owner\'s user id (only needed for roblox_asset_quotas), and the default experience (universeId) for game passes and developer products. The API key itself is never passed through tools: the user puts it in the config file shown here or in DSH_ROBLOX_API_KEY. Environment variables override stored values.',
            inputSchema: { type: 'object', additionalProperties: false, properties: { groupId: { type: 'string', description: 'Numeric group id that will own uploads.' }, userId: { type: 'string', description: 'Numeric user id of the API key owner.' }, universeId: { type: 'string', description: 'Numeric experience (universe) id for game passes and developer products.' }, clear: { type: 'boolean', description: 'Delete the stored key and ids.' } } },
            async run(args) {
                const file = cloudConfigPath();
                if (args.apiKey !== undefined) throw new Error(`For safety the API key is not accepted as a tool argument (it would be stored in the chat transcript). Ask the user to put {"apiKey": "..."} in ${file} or set DSH_ROBLOX_API_KEY. Use a user-owned key with Assets API read and write (plus asset-permissions write for roblox_grant_asset_permission, and game-pass / developer-product read and write on the experience for those items).`);
                if (args.clear === true) { await rm(file, { force: true }); return `Removed ${file}.`; }
                const groupId = stringArg(args, 'groupId');
                const userId = stringArg(args, 'userId');
                const universeId = stringArg(args, 'universeId');
                if (groupId !== undefined && !/^\d+$/.test(groupId)) throw new Error('groupId must be the numeric group id.');
                if (userId !== undefined && !/^\d+$/.test(userId)) throw new Error('userId must be the numeric user id.');
                if (universeId !== undefined && !/^\d+$/.test(universeId)) throw new Error('universeId must be the numeric experience id.');
                if (groupId !== undefined || userId !== undefined || universeId !== undefined) {
                    let stored: CloudConfig = {};
                    try { stored = JSON.parse(await readFile(file, 'utf8')) as CloudConfig; } catch { /* First save. */ }
                    if (groupId !== undefined) stored.groupId = groupId;
                    if (userId !== undefined) stored.userId = userId;
                    if (universeId !== undefined) stored.universeId = universeId;
                    await mkdir(state.ctx!.dataDir, { recursive: true });
                    await writeFile(file, JSON.stringify(stored, null, 2), 'utf8');
                }
                const config = await readCloudConfig();
                return [
                    `Config file: ${file}`,
                    `API key: ${config.apiKey ? `set (…${config.apiKey.slice(-4)})${process.env.DSH_ROBLOX_API_KEY ? ' from DSH_ROBLOX_API_KEY' : ''}` : 'not set'}`,
                    `Group id: ${config.groupId ?? 'not set'}${process.env.DSH_ROBLOX_GROUP_ID ? ' (from DSH_ROBLOX_GROUP_ID)' : ''}`,
                    `User id: ${config.userId ?? 'not set'}${process.env.DSH_ROBLOX_USER_ID ? ' (from DSH_ROBLOX_USER_ID)' : ''}`,
                    `Experience (universeId): ${config.universeId ?? 'not set (game passes and products use the connected Studio experience)'}${process.env.DSH_ROBLOX_UNIVERSE_ID ? ' (from DSH_ROBLOX_UNIVERSE_ID)' : ''}`,
                ].join('\n');
            },
        },
        {
            name: 'create',
            description: 'Create any Roblox item through Open Cloud. Files (max 20 MB, type picked from the extension unless type is given): FBX/GLB/glTF/RBXM → Model, inserted into Studio (make FBX with blender_export preset "roblox"); PNG/JPG/BMP/TGA → Image (or Decal); MP3/OGG/WAV/FLAC → Audio; MP4/MOV → Video; .rbxm KeyframeSequence → Animation (Blender animations: roblox_import_animation). Slow uploads return a job id for roblox_job_status. type GamePass or DeveloperProduct creates one on the experience (path is then an optional PNG/JPG icon); it stays off sale unless isForSale: true with a price. Roblox puts new passes/products on managed pricing (regional prices + price tests) by default: managedPricing: false keeps one fixed price, and gift: true (for gift passes) forces it off. Retries of the same create within 10 minutes return the first result unless force: true.',
            inputSchema: {
                type: 'object', additionalProperties: false, properties: {
                    type: { type: 'string', enum: ['GamePass', 'DeveloperProduct', 'Model', 'Animation', 'Image', 'Decal', 'Audio', 'Video'], description: 'Required for GamePass/DeveloperProduct; for files it overrides the type from the extension (images: Image or Decal; .rbxm: Model or Animation).' },
                    path: { type: 'string', description: 'Absolute path of the file to upload, or of the icon for a GamePass/DeveloperProduct.' },
                    name: { type: 'string', description: 'Display name (assets: max 50 chars, defaults to the file name).' },
                    description: { type: 'string' },
                    price: { type: 'integer', minimum: 0, description: 'GamePass/DeveloperProduct: default price in Robux.' },
                    isForSale: { type: 'boolean', description: 'GamePass/DeveloperProduct: put on sale (default false).' },
                    managedPricing: { type: 'boolean', description: 'GamePass/DeveloperProduct: Roblox managed pricing. Omit to keep Roblox\'s default (on for new items).' },
                    gift: { type: 'boolean', description: 'GamePass/DeveloperProduct used as a gift: forces managedPricing off so every buyer pays the same price.' },
                    universeId: { type: 'string', description: 'GamePass/DeveloperProduct experience. Defaults to roblox_cloud_config, then the connected Studio experience.' },
                    place: placeSchema(),
                    insert: { type: 'boolean', default: true, description: 'Insert Model assets into Studio after upload.' },
                    parent: { type: 'string', default: 'Workspace', description: 'Studio path to insert Models into.' },
                    force: { type: 'boolean', default: false, description: 'Create again even if the same item was created in the last 10 minutes.' },
                },
            },
            async run(args) {
                const type = stringArg(args, 'type');
                if (isStoreKind(type)) return createStoreItem(type, args);
                const misplaced = STORE_ONLY_FIELDS.filter(key => args[key] !== undefined);
                if (misplaced.length) throw new Error(`${misplaced.join(', ')} only apply to type GamePass or DeveloperProduct.`);
                const path = stringArg(args, 'path');
                if (path === undefined) throw new Error('path is required to upload an asset (or pass type GamePass / DeveloperProduct).');
                const extension = extname(path).toLowerCase();
                const kind = ASSET_TYPES[extension];
                if (!kind) throw new Error(`Unsupported file type ${extname(path) || '(none)'}. Supported: ${Object.keys(ASSET_TYPES).join(', ')}.`);
                const assetType = type ?? kind.type;
                const allowed = ASSET_TYPE_OVERRIDES[kind.type] ?? [kind.type];
                if (!allowed.includes(assetType)) throw new Error(`${extension} files can be uploaded as ${allowed.join(' or ')}, not ${assetType}.`);
                if (assetType === 'Animation' && kind.mime !== 'model/x-rbxm') throw new Error('Animation uploads must be .rbxm or .rbxmx files.');
                const content = await readUploadFile(path);
                const insert = args.insert !== false && assetType === 'Model';
                const place = insert ? resolvePlace(args) : undefined;
                const name = stringArg(args, 'name') ?? basename(path, extname(path));
                const parent = stringArg(args, 'parent') ?? 'Workspace';
                const info = await stat(path);
                const key = jobKey('upload', path, info.size, info.mtimeMs, assetType, name);
                const previous = args.force === true ? undefined : existingJob(key);
                if (previous) return awaitJobResult(previous, undefined, 'This file was already sent (pass force: true to upload it again).');
                const job = startJob(`${assetType} upload`, key, async (lines, data) => {
                    const result = await uploadAsset(content, basename(path), kind.mime, assetType, name, stringArg(args, 'description') ?? 'Uploaded by DSH', Date.now() + JOB_POLL_BUDGET_MS);
                    Object.assign(data, uploadData(assetType, result));
                    lines.push(describeUpload(assetType, result));
                    if (place && result.assetId) {
                        try {
                            const inserted = await insertAsset(place, result.assetId, parent);
                            data.inserted = inserted;
                            lines.push(`Inserted into Studio: ${inserted.join(', ')}`);
                        } catch (error) {
                            lines.push(`Not inserted yet: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                });
                return awaitJobResult(job);
            },
        },
        {
            name: 'job_status',
            description: 'Check a background job (uploads, captures uploaded with uploadAs, animation imports) by the job id those tools returned. Without jobId, lists recent jobs.',
            inputSchema: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string' }, wait: { type: 'integer', minimum: 0, maximum: 40, default: 20, description: 'Seconds to wait for a running job to finish before answering.' } } },
            async run(args) {
                pruneJobs();
                const jobId = stringArg(args, 'jobId');
                if (jobId === undefined) return jobs.size ? [...jobs.values()].map(job => `${job.id}: ${job.kind}, ${job.status}`).join('\n') : 'No recent jobs.';
                const job = jobs.get(jobId);
                if (!job) throw new Error(`No job ${jobId}. Jobs are kept for 30 minutes and are lost when the toolpack restarts; run the original tool again if needed.`);
                return awaitJobResult(job, Math.min(numberArg(args, 'wait', 20), 40) * 1000);
            },
        },
        {
            name: 'asset_status',
            description: 'Check an Open Cloud operation id (from roblox_create or roblox_update) and report the asset id and moderation state once done.',
            inputSchema: { type: 'object', additionalProperties: false, required: ['operationId'], properties: { operationId: { type: 'string' } } },
            async run(args) {
                const { apiKey } = await requireCloud();
                const operationId = stringArg(args, 'operationId', true) as string;
                return describeUpload('Asset', await pollOperation(apiKey, operationId, Date.now() + UPLOAD_BUDGET_MS));
            },
        },
        {
            name: 'get',
            description: 'Read one item by id. type Asset (default, any asset kind): type, name, description, creator, state, revision, moderation, icon, previews. type GamePass / DeveloperProduct: name, description, sale state, price, managed pricing and which pricing features are active, icon.',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['id'], properties: {
                    type: { type: 'string', enum: ['Asset', 'GamePass', 'DeveloperProduct'], default: 'Asset' },
                    id: { type: 'string', description: 'Asset id, game pass id, or developer product id.' },
                    universeId: { type: 'string', description: 'GamePass/DeveloperProduct experience. Defaults to roblox_cloud_config, then the connected Studio experience.' },
                    place: placeSchema(),
                },
            },
            async run(args) {
                const type = stringArg(args, 'type') ?? 'Asset';
                const id = assetIdArg(args, 'id');
                if (isStoreKind(type)) {
                    const item = await storeFetch(type, await resolveUniverse(args), `/${id}/creator`);
                    return [describeStoreItem(type, item), item.description ? `description: ${String(item.description)}` : '', `created: ${String(item.createdTimestamp ?? '?')} | updated: ${String(item.updatedTimestamp ?? '?')}`].filter(Boolean).join('\n');
                }
                if (type !== 'Asset') throw new Error('type must be Asset, GamePass, or DeveloperProduct.');
                const readMask = 'assetType,assetId,creationContext,description,displayName,path,revisionId,revisionCreateTime,moderationResult,icon,previews,state';
                return JSON.stringify(await cloudFetch(await requireApiKey(), `${OPEN_CLOUD}/assets/${id}?readMask=${encodeURIComponent(readMask)}`));
            },
        },
        {
            name: 'list',
            description: 'List items. type GamePass / DeveloperProduct: every one on the experience, with price, sale state and managed pricing, paged by pageToken. Asset types (Asset = all): Open Cloud cannot list a group\'s assets, so this lists assets uploaded through this toolpack (newest first).',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['type'], properties: {
                    type: { type: 'string', enum: ['GamePass', 'DeveloperProduct', 'Asset', 'Model', 'Animation', 'Image', 'Decal', 'Audio', 'Video'] },
                    pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
                    pageToken: { type: 'string', description: 'nextPageToken from the previous page.' },
                    universeId: { type: 'string', description: 'GamePass/DeveloperProduct experience. Defaults to roblox_cloud_config, then the connected Studio experience.' },
                    place: placeSchema(),
                },
            },
            async run(args) {
                const type = stringArg(args, 'type', true) as string;
                const pageSize = Math.min(Math.max(numberArg(args, 'pageSize', 50), 1), 100);
                const pageToken = stringArg(args, 'pageToken');
                if (isStoreKind(type)) {
                    const universeId = await resolveUniverse(args);
                    const query = new URLSearchParams({ pageSize: String(pageSize) });
                    if (pageToken) query.set('pageToken', pageToken);
                    const page = await storeFetch(type, universeId, `/creator?${query.toString()}`);
                    const items = Array.isArray(page[STORE_KINDS[type].list]) ? (page[STORE_KINDS[type].list] as unknown[]).filter(isRecord) : [];
                    const lines = items.map(item => describeStoreItem(type, item));
                    if (!lines.length) lines.push(`No ${STORE_KINDS[type].label.toLowerCase()}s on experience ${universeId}${pageToken ? ' on this page' : ''}.`);
                    if (typeof page.nextPageToken === 'string' && page.nextPageToken) lines.push(`nextPageToken: ${page.nextPageToken}`);
                    return lines.join('\n');
                }
                const offset = pageToken === undefined ? 0 : Number(pageToken);
                if (!Number.isInteger(offset) || offset < 0) throw new Error('pageToken must be the nextPageToken from the previous page.');
                const records = (await readUploadRecords()).filter(record => type === 'Asset' || record.type === type);
                const lines = records.slice(offset, offset + pageSize).map(record => `${record.type} ${record.assetId}: "${record.name}" | uploaded ${record.at}`);
                if (!lines.length) lines.push(`No ${type === 'Asset' ? '' : `${type} `}assets uploaded through DSH${offset ? ' on this page' : ''}. Assets made elsewhere are not listed (Open Cloud has no list endpoint for them); use roblox_get with an id.`);
                if (offset + pageSize < records.length) lines.push(`nextPageToken: ${offset + pageSize}`);
                return lines.join('\n');
            },
        },
        {
            name: 'update',
            description: 'Update an item by id. type GamePass / DeveloperProduct: name, description, price, isForSale, managedPricing, gift (forces managed pricing off), path (new PNG/JPG icon); the result spells out every price, sale and pricing-mode change. type Asset (default): name, description, icon and previews (Image asset ids; square icon) for any asset; path uploads a new version of a Model (FBX/GLB/glTF/RBXM) keeping its id — slow updates continue as a roblox_job_status job, and Studio copies are not refreshed (re-insert with roblox_insert_asset).',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['id'], properties: {
                    type: { type: 'string', enum: ['Asset', 'GamePass', 'DeveloperProduct'], default: 'Asset' },
                    id: { type: 'string', description: 'Asset id, game pass id, or developer product id.' },
                    path: { type: 'string', description: 'Asset: model file for the next version. GamePass/DeveloperProduct: new icon.' },
                    name: { type: 'string', description: 'New name (assets: max 50 chars).' },
                    description: { type: 'string' },
                    icon: { type: 'string', description: 'Asset: Image asset id to use as the icon.' },
                    previews: { type: 'array', items: { type: 'string' }, description: 'Asset: Image asset ids to use as preview images, in order.' },
                    price: { type: 'integer', minimum: 0, description: 'GamePass/DeveloperProduct: default price in Robux.' },
                    isForSale: { type: 'boolean' },
                    managedPricing: { type: 'boolean', description: 'GamePass/DeveloperProduct: turn Roblox managed pricing on or off.' },
                    gift: { type: 'boolean', description: 'GamePass/DeveloperProduct: mark as a gift item, which turns managed pricing off.' },
                    universeId: { type: 'string', description: 'GamePass/DeveloperProduct experience. Defaults to roblox_cloud_config, then the connected Studio experience.' },
                    place: placeSchema(),
                },
            },
            async run(args) {
                const type = stringArg(args, 'type') ?? 'Asset';
                const assetId = assetIdArg(args, 'id');
                if (isStoreKind(type)) {
                    if (args.icon !== undefined || args.previews !== undefined) throw new Error('icon and previews are for assets; pass path to give a game pass or product a new icon.');
                    return updateStoreItem(type, assetId, args);
                }
                if (type !== 'Asset') throw new Error('type must be Asset, GamePass, or DeveloperProduct.');
                const misplaced = STORE_ONLY_FIELDS.filter(key => args[key] !== undefined);
                if (misplaced.length) throw new Error(`${misplaced.join(', ')} only apply to type GamePass or DeveloperProduct.`);
                const apiKey = await requireApiKey();
                const request: Record<string, unknown> = { assetId };
                const mask: string[] = [];
                const displayName = stringArg(args, 'name');
                if (displayName !== undefined) { request.displayName = displayName.slice(0, 50); mask.push('displayName'); }
                const description = stringArg(args, 'description');
                if (description !== undefined) { request.description = description.slice(0, 1000); mask.push('description'); }
                if (args.icon !== undefined) { request.icon = `assets/${assetIdArg(args, 'icon')}`; mask.push('icon'); }
                if (args.previews !== undefined) {
                    if (!Array.isArray(args.previews) || args.previews.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('previews must be an array of numeric Image asset ids.');
                    request.previews = (args.previews as string[]).map(id => ({ asset: `assets/${id}`, altText: '' }));
                    mask.push('previews');
                }
                const path = stringArg(args, 'path');
                let file: { content: Buffer; mime: string } | undefined;
                if (path !== undefined) {
                    const kind = ASSET_TYPES[extname(path).toLowerCase()];
                    if (kind?.type !== 'Model') throw new Error('Only Model assets accept new content: path must be an .fbx, .gltf, .glb, .rbxm, or .rbxmx file.');
                    file = { content: await readUploadFile(path), mime: kind.mime };
                }
                if (!file && mask.length === 0) throw new Error('Nothing to update: pass path, name, description, icon, or previews.');
                const form = new FormData();
                form.append('request', JSON.stringify(request));
                if (file && path) form.append('fileContent', new Blob([new Uint8Array(file.content)], { type: file.mime }), basename(path));
                const query = mask.length > 0 ? `?updateMask=${encodeURIComponent(mask.join(','))}` : '';
                const job = startJob('Asset update', undefined, async (lines, data) => {
                    data.assetId = assetId;
                    const response = await cloudFetch(apiKey, `${OPEN_CLOUD}/assets/${assetId}${query}`, { method: 'PATCH', body: form, timeoutMs: 120_000 });
                    const operationId = operationIdOf(response);
                    if (!operationId) { lines.push(`Updated asset ${assetId}.`, JSON.stringify(response)); return; }
                    const first = operationResult(response, operationId);
                    const result = first.done ? first : await pollOperation(apiKey, operationId, Date.now() + JOB_POLL_BUDGET_MS);
                    Object.assign(data, uploadData('Asset update', result), { assetId: result.assetId ?? assetId });
                    lines.push(describeUpload('Asset update', result));
                });
                return awaitJobResult(job);
            },
        },
        {
            name: 'asset_versions',
            description: 'List an asset\'s versions (newest first) with their creator and moderation state, or read a single version by number. Use with roblox_rollback_asset.',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['assetId'], properties: {
                    assetId: { type: 'string' },
                    version: { type: 'integer', minimum: 1, description: 'Read only this version number.' },
                    pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
                    pageToken: { type: 'string', description: 'nextPageToken from a previous call.' },
                },
            },
            async run(args) {
                const { apiKey } = await requireCloud();
                const assetId = assetIdArg(args);
                if (args.version !== undefined) {
                    const version = numberArg(args, 'version', 0);
                    if (version < 1) throw new Error('version must be 1 or higher.');
                    return JSON.stringify(await cloudFetch(apiKey, `${OPEN_CLOUD}/assets/${assetId}/versions/${version}`), null, 2);
                }
                const params = new URLSearchParams({ maxPageSize: String(Math.min(Math.max(numberArg(args, 'pageSize', 20), 1), 50)) });
                const pageToken = stringArg(args, 'pageToken');
                if (pageToken) params.set('pageToken', pageToken);
                return JSON.stringify(await cloudFetch(apiKey, `${OPEN_CLOUD}/assets/${assetId}/versions?${params.toString()}`), null, 2);
            },
        },
        {
            name: 'rollback_asset',
            description: 'Roll an asset back to an earlier version. Roblox publishes a new version with that version\'s content, so the asset id stays the same. List versions with roblox_asset_versions.',
            inputSchema: { type: 'object', additionalProperties: false, required: ['assetId', 'version'], properties: { assetId: { type: 'string' }, version: { type: 'integer', minimum: 1 } } },
            async run(args) {
                const { apiKey } = await requireCloud();
                const assetId = assetIdArg(args);
                const version = numberArg(args, 'version', 0);
                if (version < 1) throw new Error('version must be 1 or higher.');
                const form = new FormData();
                form.append('assetVersion', `assets/${assetId}/versions/${version}`);
                const response = await cloudFetch(apiKey, `${OPEN_CLOUD}/assets/${assetId}/versions:rollback`, { method: 'POST', body: form });
                return `Rolled asset ${assetId} back to version ${version}.\n${JSON.stringify(response, null, 2)}`;
            },
        },
        {
            name: 'archive_asset',
            description: 'Archive an asset (removes it from the website and stops it loading in experiences) or restore an archived one.',
            inputSchema: { type: 'object', additionalProperties: false, required: ['assetId'], properties: { assetId: { type: 'string' }, action: { type: 'string', enum: ['archive', 'restore'], default: 'archive' } } },
            async run(args) {
                const { apiKey } = await requireCloud();
                const assetId = assetIdArg(args);
                const action = stringArg(args, 'action') ?? 'archive';
                if (action !== 'archive' && action !== 'restore') throw new Error('action must be archive or restore.');
                const response = await cloudFetch(apiKey, `${OPEN_CLOUD}/assets/${assetId}:${action}`, { method: 'POST', body: '{}' });
                return `${action === 'archive' ? 'Archived' : 'Restored'} asset ${assetId}.\n${JSON.stringify(response, null, 2)}`;
            },
        },
        {
            name: 'grant_asset_permission',
            description: 'Let an experience use group assets it does not own, such as private audio, video, images, or models owned by a different creator than the experience. Needs an API key with the asset-permissions write scope. universeId is the experience (universe) id, not the place id.',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['assetIds', 'universeId'], properties: {
                    assetIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    universeId: { type: 'string' },
                    grantToDependencies: { type: 'boolean', default: true, description: 'Also grant the assets a model depends on (its meshes, textures, sounds).' },
                },
            },
            async run(args) {
                const { apiKey } = await requireCloud();
                const universeId = assetIdArg(args, 'universeId');
                if (!Array.isArray(args.assetIds) || args.assetIds.length === 0 || args.assetIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw new Error('assetIds must be a non-empty array of numeric asset ids.');
                const grantToDependencies = args.grantToDependencies !== false;
                const body = JSON.stringify({ subjectType: 'Universe', subjectId: universeId, action: 'Use', requests: (args.assetIds as string[]).map(assetId => ({ assetId: Number(assetId), grantToDependencies })) });
                const response = await cloudFetch(apiKey, ASSET_PERMISSIONS, { method: 'PATCH', body });
                const granted = Array.isArray(response.successAssetIds) ? response.successAssetIds.map(String) : [];
                const errors = Array.isArray(response.errors) ? response.errors : [];
                return [`Granted universe ${universeId} use of: ${granted.length > 0 ? granted.join(', ') : 'none'}`, ...(errors.length > 0 ? [`Errors: ${JSON.stringify(errors, null, 2)}`] : [])].join('\n');
            },
        },
        {
            name: 'asset_quotas',
            description: 'Show the API key owner\'s asset upload quotas (for example audio uploads per month and video uploads per day): usage, capacity, and period. Uses userId, or the userId stored by roblox_cloud_config.',
            inputSchema: {
                type: 'object', additionalProperties: false, properties: {
                    userId: { type: 'string', description: 'Numeric user id of the API key owner.' },
                    assetType: { type: 'string', enum: ['Audio', 'Video', 'Image', 'Decal', 'Model', 'Animation', 'Mesh'], description: 'Only quotas for this asset type.' },
                },
            },
            async run(args) {
                const { apiKey, userId: storedUserId } = await requireCloud();
                const userId = args.userId !== undefined ? assetIdArg(args, 'userId') : storedUserId;
                if (!userId) throw new Error('Pass userId (the API key owner\'s numeric user id) or store it with roblox_cloud_config.');
                const params = new URLSearchParams({ maxPageSize: '100' });
                const assetType = stringArg(args, 'assetType');
                if (assetType) params.set('filter', `assetType == ${assetType}`);
                return JSON.stringify(await cloudFetch(apiKey, `https://apis.roblox.com/cloud/v2/users/${userId}/asset-quotas?${params.toString()}`), null, 2);
            },
        },
        {
            name: 'search_audio',
            description: 'Search Roblox Creator Store audio (no key or Studio needed). One line per hit with rbxassetid://<id>, which works in Roblox directly (Sound.SoundId) without downloading; to edit one locally use sound_fetch rbx:<id> from the Sound toolpack. Filters are applied client-side across up to 3 pages; pass nextPageToken back as pageToken for more.',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['query'], properties: {
                    query: { type: 'string' },
                    audioType: { type: 'string', enum: ['SoundEffect', 'Music', 'Any'], description: 'Default SoundEffect.' },
                    minDuration: { type: 'number', minimum: 0, description: 'Seconds.' },
                    maxDuration: { type: 'number', minimum: 0, description: 'Seconds.' },
                    count: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
                    pageToken: { type: 'string' },
                },
            },
            async run(args) {
                const query = stringArg(args, 'query', true)!.trim();
                const audioType = stringArg(args, 'audioType') ?? 'SoundEffect';
                if (!['SoundEffect', 'Music', 'Any'].includes(audioType)) throw new Error('audioType must be SoundEffect, Music or Any.');
                const seconds = (name: string): number | undefined => {
                    const value = args[name];
                    if (value === undefined) return undefined;
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of seconds.`);
                    return value;
                };
                const minDuration = seconds('minDuration');
                const maxDuration = seconds('maxDuration');
                const count = Math.min(50, Math.max(1, numberArg(args, 'count', 20)));
                const filtered = audioType !== 'Any' || minDuration !== undefined || maxDuration !== undefined;
                let token = stringArg(args, 'pageToken');
                const hits: Record<string, unknown>[] = [];
                let total: unknown;
                let scanned = 0;
                for (let page = 0; page < 3 && hits.length < count; page++) {
                    const params = new URLSearchParams({ searchCategoryType: 'Audio', query, maxPageSize: String(filtered ? Math.min(100, count * 2) : count) });
                    if (token) params.set('pageToken', token);
                    let response: Response;
                    try { response = await fetch(`https://apis.roblox.com/toolbox-service/v2/assets:search?${params}`, { signal: AbortSignal.timeout(20_000) }); }
                    catch (error) { throw new Error(`Roblox Creator Store search failed: ${error instanceof Error ? error.message : String(error)}`); }
                    if (!response.ok) throw new Error(`Roblox Creator Store search failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
                    const body: unknown = await response.json();
                    if (!isRecord(body)) throw new Error('Roblox Creator Store returned an unexpected reply.');
                    total ??= body.totalResults;
                    const items = Array.isArray(body.creatorStoreAssets) ? body.creatorStoreAssets.filter(isRecord) : [];
                    scanned += items.length;
                    for (const item of items) {
                        const asset = isRecord(item.asset) ? item.asset : {};
                        const duration = typeof asset.durationSeconds === 'number' ? asset.durationSeconds : undefined;
                        if (audioType !== 'Any' && asset.audioType !== audioType) continue;
                        if (minDuration !== undefined && (duration === undefined || duration < minDuration)) continue;
                        if (maxDuration !== undefined && (duration === undefined || duration > maxDuration)) continue;
                        if (hits.length < count) hits.push(item);
                    }
                    token = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
                    if (!token || !items.length) break;
                }
                const line = (item: Record<string, unknown>): string => {
                    const asset = isRecord(item.asset) ? item.asset : {};
                    const creator = isRecord(item.creator) ? item.creator : {};
                    const voting = isRecord(item.voting) ? item.voting : {};
                    const title = String(asset.title ?? asset.name ?? '').replace(/\s+/g, ' ').slice(0, 80);
                    return `rbx:${asset.id}  "${title}"  ${asset.durationSeconds ?? '?'}s  ${asset.audioType ?? '?'}  by ${creator.name ?? '?'}${creator.verified === true ? ' ✓' : ''}  +${voting.upVotes ?? 0}/-${voting.downVotes ?? 0}  rbxassetid://${asset.id}`;
                };
                const filters = [audioType, minDuration !== undefined || maxDuration !== undefined ? `${minDuration ?? 0}–${maxDuration ?? '∞'}s` : ''].filter(Boolean).join(', ');
                const lines = [`Creator Store "${query}" (${filters}): ${hits.length} shown, ${scanned} scanned of ~${total ?? '?'} results.`, ...hits.map(line)];
                lines.push(token ? `nextPageToken: ${token}` : 'No more pages.');
                return lines.join('\n');
            },
        },
        {
            name: 'insert_asset',
            description: 'Insert a Model asset (for example one uploaded by roblox_create) into the paired Studio place with InsertService:LoadAsset. The asset contents are moved under parent and selected.',
            inputSchema: { type: 'object', additionalProperties: false, required: ['assetId'], properties: { place: placeSchema(), assetId: { type: 'string' }, parent: { type: 'string', default: 'Workspace' } } },
            async run(args) {
                const assetId = assetIdArg(args);
                const inserted = await insertAsset(resolvePlace(args), assetId, stringArg(args, 'parent') ?? 'Workspace');
                return withData(`Inserted: ${inserted.join(', ')}`, { assetId, inserted });
            },
        },
        {
            name: 'import_animation',
            description: 'Turn a dsh-animation JSON file (from blender_export_animation) into KeyframeSequences in Studio and upload each as a group Animation asset. Runs as a background job; returns the result, or a job id for roblox_job_status if it takes longer than ~40s. Retrying while it runs returns the same job.',
            inputSchema: {
                type: 'object', additionalProperties: false, required: ['file'], properties: {
                    place: placeSchema(),
                    file: { type: 'string', description: 'Absolute path of the .json written by blender_export_animation.' },
                    animations: { type: 'array', items: { type: 'string' }, description: 'Only these animation names from the file.' },
                    parent: { type: 'string', default: 'ServerStorage', description: 'Studio path for the KeyframeSequences.' },
                    animationParent: { type: 'string', description: 'Studio path to create Animation instances with the uploaded ids in.' },
                    rootPose: { type: 'string', description: 'Name of one Pose to nest all bone Poses under: the rig\'s root part (the MeshPart holding the Bones, or the part the Motor6Ds hang from).' },
                    rename: { type: 'object', additionalProperties: { type: 'string' }, description: 'Bone name to Pose name.' },
                    space: { type: 'string', enum: ['bone', 'world'], default: 'bone', description: '"bone" matches Bones imported from the same FBX; "world" is for Motor6Ds whose C0/C1 have no rotation.' },
                    rig: { type: 'string', description: 'Studio path of the imported model, used to measure studsPerMeter from its Bones.' },
                    studsPerMeter: { type: 'number', exclusiveMinimum: 0, default: 1, description: 'Scale for translations; ignored when rig is measured.' },
                    loop: { type: 'boolean', default: false },
                    priority: { type: 'string', enum: ['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'], default: 'Action' },
                    upload: { type: 'boolean', default: true },
                },
            },
            async run(args) {
                const path = stringArg(args, 'file', true) as string;
                const file = readAnimationFile(JSON.parse(await readFile(path, 'utf8')));
                const space = stringArg(args, 'space') ?? 'bone';
                if (space !== 'bone' && space !== 'world') throw new Error('space must be bone or world.');
                const priority = stringArg(args, 'priority') ?? 'Action';
                if (!['Core', 'Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4'].includes(priority)) throw new Error('priority is not a valid AnimationPriority.');
                const wanted = args.animations === undefined ? undefined : stringArray(args.animations);
                const animations = file.animations.filter(animation => !wanted || wanted.includes(animation.name));
                if (!animations.length) throw new Error(`No matching animations. The file has: ${file.animations.map(animation => animation.name).join(', ')}`);
                const rename = isRecord(args.rename) ? stringMap(args.rename) : {};
                const upload = args.upload !== false;
                if (upload) await requireCloud();
                const place = resolvePlace(args);
                const studsArg = finiteArg(args, 'studsPerMeter', 1, 1e-6, 1e6);
                const rig = stringArg(args, 'rig');
                const parent = stringArg(args, 'parent') ?? 'ServerStorage';
                const rootPose = stringArg(args, 'rootPose') ?? '';
                const animationParent = stringArg(args, 'animationParent');
                const info = await stat(path);
                const key = jobKey('import_animation', place.session, path, info.mtimeMs, animations.map(animation => animation.name), args);
                const previous = existingJob(key);
                if (previous) return awaitJobResult(previous, undefined, 'This import was already started.');

                const job = startJob('Animation import', key, async (lines, data) => {
                    const imported: Array<Record<string, unknown>> = [];
                    data.animations = imported;
                    let studsPerMeter = studsArg;
                    if (rig !== undefined) {
                        const measured = await measureRigScale(place, rig, file);
                        if (measured) { studsPerMeter = measured; lines.push(`Measured ${measured.toFixed(4)} studs per meter from the Bones in ${rig}.`); }
                        else lines.push(`No Bones in ${rig} match the exported bone names; using ${studsPerMeter} studs per meter.`);
                    }
                    const index = new Map(file.bones.map((bone, i) => [bone.name, i + 1]));
                    const bones = file.bones.map(bone => ({ name: rename[bone.name] ?? bone.name, parent: bone.parent ? index.get(bone.parent) ?? 0 : 0 }));

                    for (const animation of animations) {
                        const blobKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                        const spec = {
                            name: animation.name, parent, root: rootPose,
                            loop: args.loop === true, priority, upload, bones, times: animation.times,
                            frames: poseFrames(file, animation, space, studsPerMeter),
                        };
                        await sendChunks(place, blobKey, JSON.stringify(spec));
                        const [kfsPath, encodedLength] = await luau(place, BUILD_KFS.split('KEY').join(luaString(blobKey)));
                        lines.push(`${animation.name}: KeyframeSequence ${kfsPath} (${animation.times.length} keyframes, ${bones.length} poses each).`);
                        const entry: Record<string, unknown> = { name: animation.name, keyframeSequence: kfsPath };
                        imported.push(entry);
                        if (!upload) continue;
                        const rbxm = await receiveBlob(place, blobKey, Number(encodedLength));
                        const result = await uploadAsset(rbxm, `${animation.name}.rbxm`, 'model/x-rbxm', 'Animation', animation.name, 'Uploaded by DSH', Date.now() + JOB_POLL_BUDGET_MS);
                        Object.assign(entry, uploadData('Animation', result));
                        lines.push(`${animation.name}: ${describeUpload('Animation', result)}`);
                        if (result.assetId && animationParent !== undefined) {
                            const [created] = await luau(place, `${LUAU_RESOLVE}
local parent = dshResolve(${luaString(animationParent)})
local animation = parent:FindFirstChild(${luaString(animation.name)})
if not (animation and animation:IsA("Animation")) then
	animation = Instance.new("Animation")
	animation.Name = ${luaString(animation.name)}
	animation.Parent = parent
end
animation.AnimationId = "rbxassetid://${result.assetId}"
return animation`);
                            entry.animation = created;
                            lines.push(`${animation.name}: Animation instance ${created}.`);
                        }
                    }
                });
                return awaitJobResult(job);
            },
        },
    ],
};

export default pack;
