// @ts-check
/**
 * Graph values: typed nodes, wait nodes and the graph that wires them with data edges.
 * Schemas are any Standard Schema (zod v4 in cambium); validation goes through `schema['~standard'].validate`.
 */
import { END, validateGraph } from './validate.mjs'

export { END }

/**
 * @typedef {{ '~standard': { validate: (value: unknown) => StandardResult | Promise<StandardResult> } }} StandardSchema
 * @typedef {{ value: unknown, issues?: undefined } | { issues: ReadonlyArray<StandardIssue> }} StandardResult
 * @typedef {{ message: string, path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }} StandardIssue
 * @typedef {{ kind: 'node', name: string, input: StandardSchema, output: StandardSchema,
 *   run: (input: any, ctx: any) => unknown }} StepNode
 * @typedef {{ ready: false } | { ready: true, output: unknown }} PollResult
 * @typedef {{ kind: 'wait', name: string, input: StandardSchema, output: StandardSchema,
 *   poll: (input: any, ctx: any) => PollResult | Promise<PollResult> }} WaitNode
 * @typedef {StepNode | WaitNode} GraphNode
 * @typedef {(out: any, subject: unknown) => unknown} EdgeFn
 * @typedef {[from: string, to: string, when?: EdgeFn | null, map?: EdgeFn]} Edge
 * @typedef {{ queue?: string, node: string, input?: (...args: any[]) => unknown }} Entry
 * @typedef {{ name: string, version: number, entry: Entry, nodes: GraphNode[], edges: Edge[] }} Graph
 */

/** A failure inside a node: bad input or output, or a throw from run, poll, when or map. */
export class GraphNodeError extends Error {
  /**
   * @param {string} node
   * @param {'input' | 'output' | 'run' | 'poll' | 'edge'} phase
   * @param {string} detail
   * @param {{ issues?: ReadonlyArray<StandardIssue>, cause?: unknown }} [extra]
   */
  constructor(node, phase, detail, extra = {}) {
    const what = phase === 'input' || phase === 'output' ? `invalid ${phase}` : `${phase} failed`
    super(`node "${node}": ${what}: ${detail}`, { cause: extra.cause })
    this.name = 'GraphNodeError'
    this.node = node
    this.phase = phase
    this.issues = extra.issues ?? []
  }
}

/** @param {StandardIssue} issue */
const formatIssue = (issue) => {
  const path = (issue.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p)).join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * Validate `value` against `schema`: the parsed value, or a GraphNodeError naming the node and every issue.
 * @param {StandardSchema} schema @param {unknown} value @param {string} node @param {'input' | 'output'} phase
 */
export async function check(schema, value, node, phase) {
  const result = await schema['~standard'].validate(value)
  if (result.issues) throw new GraphNodeError(node, phase, result.issues.map(formatIssue).join('; '), result)
  return result.value
}

/** @param {unknown} s */
const isSchema = (s) =>
  typeof s === 'object' && s !== null && typeof (/** @type {any} */ (s)['~standard']?.validate) === 'function'

/** @param {string} what @param {any} def @param {string} fn */
function checkDef(what, def, fn) {
  if (typeof def?.name !== 'string' || !def.name) throw new Error(`${what}: name must be a non-empty string`)
  if (def.name === END) throw new Error(`${what} "${def.name}": the name is reserved`)
  for (const k of ['input', 'output'])
    if (!isSchema(def[k])) throw new Error(`${what} "${def.name}": ${k} must be a Standard Schema (e.g. zod v4)`)
  if (typeof def[fn] !== 'function') throw new Error(`${what} "${def.name}": ${fn} must be a function`)
}

/**
 * A step node: input is validated, `run(input, ctx)` returns the output, the output is validated.
 * @param {{ name: string, input: StandardSchema, output: StandardSchema, run: StepNode['run'] }} def
 * @returns {StepNode}
 */
export function defineNode(def) {
  checkDef('defineNode', def, 'run')
  return Object.freeze({ kind: 'node', name: def.name, input: def.input, output: def.output, run: def.run })
}

/**
 * A wait node: `poll(input, ctx)` either holds (`{ ready: false }`) or yields `{ ready: true, output }`.
 * @param {{ name: string, input: StandardSchema, output: StandardSchema, poll: WaitNode['poll'] }} def
 * @returns {WaitNode}
 */
export function defineWait(def) {
  checkDef('defineWait', def, 'poll')
  return Object.freeze({ kind: 'wait', name: def.name, input: def.input, output: def.output, poll: def.poll })
}

/**
 * A graph value. Throws, listing every problem, when `validateGraph` finds any.
 * @param {Graph} def
 * @returns {Graph}
 */
export function defineGraph(def) {
  const problems = validateGraph(def)
  if (problems.length) throw new Error(`graph "${def?.name}" is invalid:\n- ${problems.join('\n- ')}`)
  const { name, version, entry, nodes, edges } = def
  return Object.freeze({ name, version, entry: { ...entry }, nodes: [...nodes], edges: edges.map((e) => e) })
}
