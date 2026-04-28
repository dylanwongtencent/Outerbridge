import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'

const MIME_TYPES: Record<string, string> = {
    '.cjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm'
}

export class NodePodHarnessServer {
    private server?: http.Server
    private baseUrl?: string
    private readonly nodePodDistDir: string
    private readonly runnerJs: string

    constructor() {
        this.nodePodDistDir = locateNodePodDistDir()
        this.runnerJs = buildRunnerJs()
    }

    async start(): Promise<string> {
        if (this.baseUrl) return this.baseUrl

        this.server = http.createServer((req, res) => this.handle(req, res))

        await new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err)
            this.server!.once('error', onError)
            this.server!.listen(0, '127.0.0.1', () => {
                this.server!.off('error', onError)
                resolve()
            })
        })

        const address = this.server.address() as net.AddressInfo
        this.baseUrl = `http://127.0.0.1:${address.port}`
        return this.baseUrl
    }

    async stop(): Promise<void> {
        if (!this.server) return
        await new Promise<void>((resolve, reject) => {
            this.server!.close((err) => (err ? reject(err) : resolve()))
        })
        this.server = undefined
        this.baseUrl = undefined
    }

    get url(): string {
        if (!this.baseUrl) throw new Error('NodePod harness server has not started')
        return this.baseUrl
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            const method = req.method || 'GET'
            if (method !== 'GET' && method !== 'HEAD') {
                sendText(res, 405, 'Method Not Allowed')
                return
            }

            setSecurityHeaders(res)
            const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
            const pathname = decodeURIComponent(requestUrl.pathname)

            if (pathname === '/' || pathname === '/runner.html') {
                const body = RUNNER_HTML
                send(res, 200, 'text/html; charset=utf-8', method === 'HEAD' ? '' : body)
                return
            }

            if (pathname === '/runner.js') {
                send(res, 200, 'application/javascript; charset=utf-8', method === 'HEAD' ? '' : this.runnerJs)
                return
            }

            if (pathname.startsWith('/nodepod/')) {
                this.serveNodePodAsset(pathname, method, res)
                return
            }

            sendText(res, 404, 'Not Found')
        } catch (e) {
            sendText(res, 500, e instanceof Error ? e.message : String(e))
        }
    }

    private serveNodePodAsset(pathname: string, method: string, res: http.ServerResponse): void {
        const relative = pathname.replace(/^\/nodepod\//, '')
        const safeRelative = path.normalize(relative).replace(/^([/\\])+/, '')

        if (!safeRelative || safeRelative.startsWith('..') || safeRelative.includes(`..${path.sep}`)) {
            sendText(res, 403, 'Forbidden')
            return
        }

        const fullPath = path.join(this.nodePodDistDir, safeRelative)
        if (!fullPath.startsWith(this.nodePodDistDir) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            sendText(res, 404, 'Not Found')
            return
        }

        const ext = path.extname(fullPath).toLowerCase()
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream'
        res.writeHead(200, {
            'Content-Type': mimeType,
            'Cache-Control': 'private, max-age=3600',
            'Cross-Origin-Resource-Policy': 'same-origin'
        })

        if (method === 'HEAD') {
            res.end()
            return
        }

        fs.createReadStream(fullPath).pipe(res)
    }
}

function locateNodePodDistDir(): string {
    let resolved: string
    try {
        resolved = require.resolve('@scelar/nodepod')
    } catch (e) {
        throw new Error('Missing dependency @scelar/nodepod. Install it in packages/components before using the NodeJS node.')
    }

    const distDir = path.dirname(resolved)
    const indexMjs = path.join(distDir, 'index.mjs')
    if (!fs.existsSync(indexMjs)) {
        throw new Error(`Cannot find NodePod browser bundle at ${indexMjs}`)
    }
    return distDir
}

function setSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "script-src 'self' blob: 'unsafe-eval'",
            "worker-src 'self' blob:",
            "connect-src 'self' http: https: data: blob:",
            "img-src 'self' data: blob:",
            "style-src 'self' 'unsafe-inline'"
        ].join('; ')
    )
}

function sendText(res: http.ServerResponse, statusCode: number, text: string): void {
    send(res, statusCode, 'text/plain; charset=utf-8', text)
}

function send(res: http.ServerResponse, statusCode: number, contentType: string, body: string): void {
    res.writeHead(statusCode, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    })
    res.end(body)
}

const RUNNER_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Outerbridge NodePod Harness</title>
</head>
<body>
  <script type="module" src="/runner.js"></script>
</body>
</html>`

function buildRunnerJs(): string {
    return `
import { Nodepod } from '/nodepod/index.mjs';

const MAX_DEP_SNAPSHOTS = 24;
const BASE_WORKDIR = '/outerbridge';
const RESULT_FILE = BASE_WORKDIR + '/result.json';
const ERROR_FILE = BASE_WORKDIR + '/error.json';
const NODE_DATA_FILE = BASE_WORKDIR + '/node-data.json';
const USER_RUNNER_FILE = BASE_WORKDIR + '/user-runner.js';

let pod = null;
let baseSnapshot = null;
let bootPromise = boot();
const depSnapshots = new Map();

window.__outerbridgeNodepod = {
  ready: false,
  execute,
  memoryStats: () => pod ? pod.memoryStats() : null
};

async function boot() {
  pod = await Nodepod.boot({
    serviceWorker: false,
    workdir: BASE_WORKDIR,
    enableSnapshotCache: true,
    enableSharedArrayBuffer: true,
    allowedFetchDomains: null,
    files: {
      '/package.json': JSON.stringify({ name: 'outerbridge-nodepod-runtime', private: true, type: 'commonjs' }, null, 2),
      [BASE_WORKDIR + '/.keep']: ''
    },
    env: { NODE_ENV: 'production' }
  });

  await ensureWorkdir();
  baseSnapshot = pod.snapshot({ shallow: false });
  window.__outerbridgeNodepod.ready = true;
}

async function execute(request) {
  await bootPromise;

  const startedAt = performance.now();
  const timeoutMs = clampNumber(request && request.timeoutMs, 30000, 100, 300000);
  const maxOutputBytes = clampNumber(request && request.maxOutputBytes, 4194304, 1024, 32 * 1024 * 1024);
  const modules = normalizeStringArray(request && request.modules);
  const env = normalizeEnv(request && request.env);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let timer = null;

  try {
    const installStartedAt = performance.now();
    const dependencyKey = await ensureDependencies(modules);
    const installMs = Math.round(performance.now() - installStartedAt);

    await ensureWorkdir();
    await pod.fs.writeFile(NODE_DATA_FILE, JSON.stringify(request && request.nodeData !== undefined ? request.nodeData : null));
    await pod.fs.writeFile(RESULT_FILE, '');
    await pod.fs.writeFile(ERROR_FILE, '');
    await pod.fs.writeFile(USER_RUNNER_FILE, buildUserWrapper(String((request && request.code) || '')));

    const proc = await pod.spawn('node', [USER_RUNNER_FILE], { cwd: BASE_WORKDIR, env });

    const append = (stream, chunk) => {
      const text = String(chunk);
      if (stream === 'stdout') stdout += text;
      else stderr += text;

      if (stdout.length > maxOutputBytes) stdout = stdout.slice(-Math.floor(maxOutputBytes * 0.75));
      if (stderr.length > maxOutputBytes) stderr = stderr.slice(-Math.floor(maxOutputBytes * 0.75));
    };

    proc.on('output', (chunk) => append('stdout', chunk));
    proc.on('error', (chunk) => append('stderr', chunk));

    const timeoutResult = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch (_) {}
        resolve({ stdout, stderr, exitCode: 124 });
      }, timeoutMs);
    });

    const completion = await Promise.race([proc.completion, timeoutResult]);
    if (timer) clearTimeout(timer);

    stdout = typeof completion.stdout === 'string' ? completion.stdout : stdout;
    stderr = typeof completion.stderr === 'string' ? completion.stderr : stderr;

    if (timedOut) {
      return {
        ok: false,
        recycle: true,
        exitCode: 124,
        stdout,
        stderr,
        error: { name: 'TimeoutError', message: 'NodePod execution timed out after ' + timeoutMs + 'ms' },
        timings: { totalMs: Math.round(performance.now() - startedAt), installMs }
      };
    }

    if (completion.exitCode !== 0) {
      const err = await readJsonIfPresent(ERROR_FILE);
      return {
        ok: false,
        exitCode: completion.exitCode,
        stdout,
        stderr,
        error: err || { name: 'ExecutionError', message: stderr || ('Process exited with code ' + completion.exitCode) },
        timings: { totalMs: Math.round(performance.now() - startedAt), installMs }
      };
    }

    const result = await readJsonIfPresent(RESULT_FILE);
    return {
      ok: true,
      value: result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null,
      stdout,
      stderr,
      exitCode: completion.exitCode,
      dependencyKey,
      timings: { totalMs: Math.round(performance.now() - startedAt), installMs }
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return {
      ok: false,
      recycle: timedOut,
      exitCode: timedOut ? 124 : 1,
      stdout,
      stderr,
      error: serializeError(err),
      timings: { totalMs: Math.round(performance.now() - startedAt) }
    };
  }
}

async function ensureDependencies(modules) {
  const uniqueModules = Array.from(new Set(modules)).sort();
  const key = JSON.stringify(uniqueModules);

  if (uniqueModules.length === 0) {
    await restoreSnapshot(baseSnapshot);
    return 'base';
  }

  if (!depSnapshots.has(key)) {
    await restoreSnapshot(baseSnapshot);
    await pod.install(uniqueModules);
    depSnapshots.set(key, pod.snapshot({ shallow: false }));

    while (depSnapshots.size > MAX_DEP_SNAPSHOTS) {
      const firstKey = depSnapshots.keys().next().value;
      depSnapshots.delete(firstKey);
    }
  }

  await restoreSnapshot(depSnapshots.get(key));
  return key;
}

async function restoreSnapshot(snapshot) {
  await pod.restore(snapshot, { autoInstall: false });
  await ensureWorkdir();
}

async function ensureWorkdir() {
  if (!(await pod.fs.exists(BASE_WORKDIR))) {
    await pod.fs.mkdir(BASE_WORKDIR, { recursive: true });
  }
}

async function readJsonIfPresent(file) {
  try {
    const text = await pod.fs.readFile(file, 'utf8');
    if (!text) return null;
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function buildUserWrapper(userCode) {
  const lines = [];
  lines.push("'use strict';");
  lines.push("const fs = require('fs');");
  lines.push('const RESULT_FILE = ' + JSON.stringify(RESULT_FILE) + ';');
  lines.push('const ERROR_FILE = ' + JSON.stringify(ERROR_FILE) + ';');
  lines.push('const NODE_DATA_FILE = ' + JSON.stringify(NODE_DATA_FILE) + ';');
  lines.push('const USER_CODE = ' + JSON.stringify(String(userCode)) + ';');
  lines.push('function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }');
  lines.push('function normalize(value, seen) {');
  lines.push('  if (value === undefined) return null;');
  lines.push('  if (value === null || typeof value === "string" || typeof value === "boolean") return value;');
  lines.push('  if (typeof value === "number") return Number.isFinite(value) ? value : null;');
  lines.push('  if (typeof value === "bigint") return value.toString();');
  lines.push('  if (typeof value === "symbol" || typeof value === "function") return undefined;');
  lines.push('  if (!seen) seen = new WeakSet();');
  lines.push('  if (typeof value === "object") {');
  lines.push('    if (seen.has(value)) return "[Circular]";');
  lines.push('    seen.add(value);');
  lines.push('    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };');
  lines.push('    if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(value)) return { type: "Buffer", data: Array.from(value.values()) };');
  lines.push('    if (Array.isArray(value)) return value.map((item) => normalize(item, seen)).filter((item) => item !== undefined);');
  lines.push('    if (value instanceof Date) return value.toISOString();');
  lines.push('    if (value instanceof Map) { const out = {}; for (const [key, val] of value.entries()) { const normalized = normalize(val, seen); if (normalized !== undefined) out[String(key)] = normalized; } return out; }');
  lines.push('    if (value instanceof Set) return Array.from(value.values()).map((item) => normalize(item, seen)).filter((item) => item !== undefined);');
  lines.push('    const out = {}; for (const key of Object.keys(value)) { const normalized = normalize(value[key], seen); if (normalized !== undefined) out[key] = normalized; } return out;');
  lines.push('  }');
  lines.push('  return null;');
  lines.push('}');
  lines.push('function serializeError(err) { return { name: err && err.name ? err.name : "Error", message: err && err.message ? err.message : String(err), stack: err && err.stack ? err.stack : "" }; }');
  lines.push('process.on("unhandledRejection", (reason) => { writeJson(ERROR_FILE, serializeError(reason)); process.exitCode = 1; });');
  lines.push('(async () => {');
  lines.push('  try {');
  lines.push('    const $nodeData = JSON.parse(fs.readFileSync(NODE_DATA_FILE, "utf8"));');
  lines.push('    globalThis.$nodeData = $nodeData;');
  lines.push('    const outerbridgeModule = { exports: {} };');
  lines.push('    const outerbridgeExports = outerbridgeModule.exports;');
  lines.push('    const fn = new Function("require", "module", "exports", "$nodeData", "__filename", "__dirname", "\\"use strict\\";\\nreturn (async () => {\\n" + USER_CODE + "\\n})()");');
  lines.push('    let value = await fn(require, outerbridgeModule, outerbridgeExports, $nodeData, "/outerbridge/user-code.js", "/outerbridge");');
  lines.push('    if (typeof value === "undefined") {');
  lines.push('      if (outerbridgeModule.exports !== outerbridgeExports || Object.keys(outerbridgeModule.exports || {}).length > 0) value = outerbridgeModule.exports;');
  lines.push('      else value = null;');
  lines.push('    }');
  lines.push('    writeJson(RESULT_FILE, { value: normalize(value) });');
  lines.push('  } catch (err) {');
  lines.push('    writeJson(ERROR_FILE, serializeError(err));');
  lines.push('    process.exitCode = 1;');
  lines.push('  }');
  lines.push('})();');
  return lines.join('\n');
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined || val === null) continue;
    out[key] = String(val);
  }
  return out;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function serializeError(err) {
  return {
    name: err && err.name ? err.name : 'Error',
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack : ''
  };
}
`;
}
