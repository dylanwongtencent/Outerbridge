import { ICommonObject, INode, INodeData, INodeExecutionData, INodeParams, NodeType } from '../../src/Interface'
import { returnNodeExecutionData } from '../../src/utils'
import { getNodePodRuntime } from './runtime/NodePodRuntime'

class NodeJS implements INode {
    label: string
    name: string
    type: NodeType
    description?: string
    version: number
    icon: string
    category: string
    incoming: number
    outgoing: number
    inputParameters?: INodeParams[]

    constructor() {
        this.label = 'NodeJS'
        this.name = 'nodeJS'
        this.icon = 'nodejs.png'
        this.type = 'action'
        this.category = 'Development'
        this.version = 2.0
        this.description = 'Execute Node.js code in a NodePod browser-isolated runtime'
        this.incoming = 1
        this.outgoing = 1
        this.inputParameters = [
            {
                label: 'Code',
                name: 'code',
                type: 'code',
                default: `console.info($nodeData);\nconst example = 'Hello World!';\nreturn example;`,
                description: 'Custom JavaScript code to run. Top-level await and return are supported inside the generated async wrapper.'
            },
            {
                label: 'External Modules',
                name: 'external',
                type: 'json',
                placeholder: '["axios", "lodash@latest", "@scope/package@1.2.3"]',
                description: 'npm package specs to install inside the NodePod virtual filesystem before running the code',
                optional: true
            },
            {
                label: 'Timeout MS',
                name: 'timeoutMs',
                type: 'number',
                default: 30000,
                description: 'Maximum execution time in milliseconds before the isolated worker is killed',
                optional: true
            },
            {
                label: 'Environment Variables',
                name: 'env',
                type: 'json',
                placeholder: '{"NODE_ENV":"production"}',
                description: 'JSON object of environment variables exposed to the NodePod process',
                optional: true
            },
            {
                label: 'Allowed Fetch Domains',
                name: 'allowedFetchDomains',
                type: 'json',
                placeholder: '["registry.npmjs.org", "api.github.com"]',
                description: 'Additional network domains the isolated browser runtime may fetch. npm registry domains are allowed by default.',
                optional: true
            }
        ] as INodeParams[]
    }

    async run(nodeData: INodeData): Promise<INodeExecutionData[] | null> {
        const inputParametersData = nodeData.inputParameters

        if (inputParametersData === undefined) {
            throw new Error('Required data missing')
        }

        const code = (inputParametersData.code as string) || ''
        const modules = parseStringArray(inputParametersData.external, 'External Modules')
        const timeoutMs = parseTimeoutMs(inputParametersData.timeoutMs)
        const env = parseStringRecord(inputParametersData.env, 'Environment Variables')
        const allowedFetchDomains = parseStringArray(inputParametersData.allowedFetchDomains, 'Allowed Fetch Domains')

        let responseData: any // tslint:disable-line: no-any

        if (!code.trim()) {
            responseData = []
        } else {
            responseData = await getNodePodRuntime().execute({
                code,
                nodeData,
                modules,
                timeoutMs,
                env,
                allowedFetchDomains
            })
        }

        const returnData: ICommonObject[] = []
        if (Array.isArray(responseData)) {
            returnData.push(...(responseData as ICommonObject[]))
        } else {
            returnData.push(responseData as ICommonObject)
        }

        return returnNodeExecutionData(returnData)
    }
}

function parseTimeoutMs(value: unknown): number {
    if (value === undefined || value === null || value === '') return 30000
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('Timeout MS must be a positive number')
    }
    return Math.max(100, Math.min(Math.floor(parsed), 300000))
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
    if (value === undefined || value === null || value === '') return {}

    const parsed = typeof value === 'string' ? safeJsonParse(value, label) : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object`)
    }

    const output: Record<string, string> = {}
    Object.entries(parsed as Record<string, unknown>).forEach(([key, val]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`${label} contains an invalid environment variable name: ${key}`)
        }
        if (val === undefined || val === null) return
        output[key] = String(val)
    })
    return output
}

function parseStringArray(value: unknown, label: string): string[] {
    if (value === undefined || value === null || value === '') return []

    const parsed = typeof value === 'string' ? safeJsonParse(value, label) : value
    if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON array of strings`)
    }

    return parsed
        .map((item) => String(item).trim())
        .filter(Boolean)
        .map((item) => {
            if (item.length > 214) throw new Error(`${label} contains an entry that is too long`)
            return item
        })
}

function safeJsonParse(value: string, label: string): unknown {
    try {
        return JSON.parse(value)
    } catch (e) {
        throw new Error(`${label} must be valid JSON`)
    }
}

module.exports = { nodeClass: NodeJS }
