import { INodeData } from '../../../src/Interface'
import { NodePodHarnessServer } from './NodePodHarnessServer'

type Browser = any
type BrowserContext = any
type Page = any

declare const require: any
declare const window: any

export interface NodePodExecutionRequest {
    code: string
    nodeData: INodeData
    modules?: string[]
    timeoutMs?: number
    env?: Record<string, string>
    allowedFetchDomains?: string[]
}

interface BrowserExecutionResponse {
    ok: boolean
    value?: unknown
    stdout?: string
    stderr?: string
    exitCode?: number
    recycle?: boolean
    error?: {
        name?: string
        message?: string
        stack?: string
    }
    timings?: Record<string, number>
}

interface RuntimeConfig {
    poolSize: number
    maxOutputBytes: number
    recycleAfterRuns: number
    browserEvaluateGraceMs: number
    chromiumSandbox: boolean
    defaultAllowedDomains: string[]
}

const DEFAULT_ALLOWED_DOMAINS = [
    'registry.npmjs.org',
    'registry.yarnpkg.com',
    'npm.pkg.github.com',
    'github.com',
    'codeload.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'esm.sh',
    'unpkg.com',
    'cdn.jsdelivr.net'
]

let singleton: NodePodRuntime | null = null

export function getNodePodRuntime(): NodePodRuntime {
    if (!singleton) singleton = new NodePodRuntime(readRuntimeConfig())
    return singleton
}

export class NodePodRuntime {
    private readonly config: RuntimeConfig
    private readonly harness = new NodePodHarnessServer()
    private browser?: Browser
    private slots: NodePodSlot[] = []
    private initPromise?: Promise<void>
    private nextSlot = 0

    constructor(config: RuntimeConfig) {
        this.config = config
    }

    async warm(): Promise<void> {
        await this.ensureStarted()
    }

    async execute(request: NodePodExecutionRequest): Promise<unknown> {
        await this.ensureStarted()

        const slot = this.pickSlot()
        const response = await slot.run({
            code: request.code,
            nodeData: toJsonSafe(request.nodeData),
            modules: request.modules || [],
            timeoutMs: request.timeoutMs || 30000,
            env: request.env || {},
            allowedFetchDomains: request.allowedFetchDomains || [],
            maxOutputBytes: this.config.maxOutputBytes
        })

        if (!response.ok) {
            const message = response.error?.message || response.stderr || `NodePod process exited with code ${response.exitCode ?? 1}`
            const err = new Error(message)
            ;(err as any).name = response.error?.name || 'NodePodExecutionError'
            ;(err as any).stack = response.error?.stack || err.stack
            ;(err as any).stdout = response.stdout || ''
            ;(err as any).stderr = response.stderr || ''
            ;(err as any).exitCode = response.exitCode
            ;(err as any).timings = response.timings
            throw err
        }

        return response.value
    }

    async shutdown(): Promise<void> {
        for (const slot of this.slots) {
            await slot.close()
        }
        this.slots = []

        if (this.browser) {
            await this.browser.close()
            this.browser = undefined
        }

        await this.harness.stop()
        this.initPromise = undefined
    }

    private async ensureStarted(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.start()
        }
        await this.initPromise
    }

    private async start(): Promise<void> {
        const harnessUrl = await this.harness.start()
        const playwright = require('playwright')
        this.browser = await playwright.chromium.launch({
            headless: true,
            chromiumSandbox: this.config.chromiumSandbox,
            args: [
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
                '--disable-hang-monitor',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-first-run',
                '--safebrowsing-disable-auto-update'
            ]
        })

        this.slots = []
        for (let i = 0; i < this.config.poolSize; i += 1) {
            const slot = new NodePodSlot(this.browser, harnessUrl, i, this.config)
            await slot.init()
            this.slots.push(slot)
        }
    }

    private pickSlot(): NodePodSlot {
        if (!this.slots.length) throw new Error('NodePod runtime has no active slots')
        const slot = this.slots[this.nextSlot % this.slots.length]
        this.nextSlot = (this.nextSlot + 1) % this.slots.length
        return slot
    }
}

interface SlotRunRequest {
    code: string
    nodeData: unknown
    modules: string[]
    timeoutMs: number
    env: Record<string, string>
    allowedFetchDomains: string[]
    maxOutputBytes: number
}

class NodePodSlot {
    private readonly browser: Browser
    private readonly harnessUrl: string
    private readonly harnessOrigin: string
    private readonly id: number
    private readonly config: RuntimeConfig
    private mutex = new Mutex()
    private context?: BrowserContext
    private page?: Page
    private runCount = 0
    private currentAllowedDomains = new Set<string>()

    constructor(browser: Browser, harnessUrl: string, id: number, config: RuntimeConfig) {
        this.browser = browser
        this.harnessUrl = harnessUrl
        this.harnessOrigin = new URL(harnessUrl).origin
        this.id = id
        this.config = config
    }

    async init(): Promise<void> {
        await this.openFreshContext()
    }

    async close(): Promise<void> {
        if (this.context) {
            try {
                await this.context.close()
            } catch (e) {
                // ignore close failures during shutdown/recycle
            }
        }
        this.context = undefined
        this.page = undefined
    }

    async run(request: SlotRunRequest): Promise<BrowserExecutionResponse> {
        return this.mutex.runExclusive(async () => {
            if (!this.page) await this.openFreshContext()

            this.currentAllowedDomains = new Set<string>([
                ...this.config.defaultAllowedDomains,
                ...request.allowedFetchDomains.map((domain) => domain.toLowerCase())
            ])

            const payload = {
                code: request.code,
                nodeData: request.nodeData,
                modules: request.modules,
                timeoutMs: request.timeoutMs,
                env: request.env,
                maxOutputBytes: request.maxOutputBytes
            }

            const evaluateTimeoutMs = request.timeoutMs + this.config.browserEvaluateGraceMs
            let response: BrowserExecutionResponse
            try {
                response = await promiseWithTimeout(
                    this.page!.evaluate((innerPayload: unknown) => {
                        return (window as any).__outerbridgeNodepod.execute(innerPayload)
                    }, payload),
                    evaluateTimeoutMs,
                    `NodePod browser evaluation exceeded ${evaluateTimeoutMs}ms`
                )
            } catch (e) {
                await this.recycle()
                throw e
            } finally {
                this.currentAllowedDomains = new Set<string>()
            }

            this.runCount += 1
            if (response.recycle || this.runCount >= this.config.recycleAfterRuns) {
                await this.recycle()
            }

            return response
        })
    }

    private async recycle(): Promise<void> {
        await this.close()
        this.runCount = 0
        await this.openFreshContext()
    }

    private async openFreshContext(): Promise<void> {
        await this.close()

        this.context = await this.browser.newContext({
            javaScriptEnabled: true,
            ignoreHTTPSErrors: false,
            viewport: { width: 1280, height: 720 },
            serviceWorkers: 'block'
        })

        await this.context.route('**/*', async (route: any) => {
            const request = route.request()
            const url = request.url()
            if (this.isAllowedRequestUrl(url)) {
                await route.continue()
            } else {
                await route.abort('blockedbyclient')
            }
        })

        this.page = await this.context.newPage()
        this.page.on('pageerror', (err: Error) => {
            // Keep this on stderr so it is visible in server logs without leaking into workflow output.
            // eslint-disable-next-line no-console
            console.error(`[NodePod slot ${this.id}] page error:`, err)
        })
        await this.page.goto(`${this.harnessUrl}/runner.html`, { waitUntil: 'load', timeout: 30000 })
        await this.page.waitForFunction(() => (window as any).__outerbridgeNodepod?.ready === true, undefined, { timeout: 30000 })
    }

    private isAllowedRequestUrl(rawUrl: string): boolean {
        if (rawUrl === 'about:blank') return true
        if (rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) return true

        let parsed: URL
        try {
            parsed = new URL(rawUrl)
        } catch (e) {
            return false
        }

        if (parsed.origin === this.harnessOrigin) return true
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

        const hostname = parsed.hostname.toLowerCase()
        for (const domain of this.currentAllowedDomains) {
            const normalized = domain.replace(/^https?:\/\//, '').split('/')[0].toLowerCase()
            if (!normalized) continue
            if (hostname === normalized || hostname.endsWith(`.${normalized}`)) return true
        }
        return false
    }
}

class Mutex {
    private tail: Promise<void> = Promise.resolve()

    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this.tail
        let release!: () => void
        this.tail = new Promise<void>((resolve) => {
            release = resolve
        })

        await previous
        try {
            return await fn()
        } finally {
            release()
        }
    }
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: any
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs)
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function readRuntimeConfig(): RuntimeConfig {
    const poolSize = readPositiveIntEnv('OUTERBRIDGE_NODEPOD_POOL_SIZE', 2, 1, 16)
    const recycleAfterRuns = readPositiveIntEnv('OUTERBRIDGE_NODEPOD_RECYCLE_AFTER_RUNS', 100, 1, 10000)
    const maxOutputBytes = readPositiveIntEnv('OUTERBRIDGE_NODEPOD_MAX_OUTPUT_BYTES', 4 * 1024 * 1024, 1024, 32 * 1024 * 1024)
    const browserEvaluateGraceMs = readPositiveIntEnv('OUTERBRIDGE_NODEPOD_BROWSER_GRACE_MS', 5000, 500, 60000)
    const chromiumSandbox = process.env.OUTERBRIDGE_NODEPOD_CHROMIUM_SANDBOX !== 'false'
    const extraDomains = (process.env.OUTERBRIDGE_NODEPOD_ALLOWED_FETCH_DOMAINS || '')
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean)

    return {
        poolSize,
        recycleAfterRuns,
        maxOutputBytes,
        browserEvaluateGraceMs,
        chromiumSandbox,
        defaultAllowedDomains: [...DEFAULT_ALLOWED_DOMAINS, ...extraDomains]
    }
}

function readPositiveIntEnv(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(Math.floor(value), max))
}

function toJsonSafe(input: unknown): unknown {
    const seen = new WeakSet<object>()
    return sanitize(input, seen)
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
    if (value === undefined) return null
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'function' || typeof value === 'symbol') return undefined

    if (value instanceof Date) return value.toISOString()
    if (Buffer.isBuffer(value)) return { type: 'Buffer', data: Array.from((value as Buffer).values()) }

    if (typeof value === 'object') {
        if (seen.has(value as object)) return '[Circular]'
        seen.add(value as object)

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack
            }
        }

        if (Array.isArray(value)) {
            return value.map((item) => sanitize(item, seen)).filter((item) => item !== undefined)
        }

        const output: Record<string, unknown> = {}
        Object.keys(value as Record<string, unknown>).forEach((key) => {
            const sanitized = sanitize((value as Record<string, unknown>)[key], seen)
            if (sanitized !== undefined) output[key] = sanitized
        })
        return output
    }

    return null
}
