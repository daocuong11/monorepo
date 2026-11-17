// @ts-check
import { extname } from 'node:path'
import { parse } from '@babel/parser'

export const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
])

const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments',
])

/** @param {string} file */
function pluginsFor(file) {
  const ext = extname(file)
  if (ext === '.tsx') return ['typescript', 'jsx']
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ['typescript']
  return ['jsx']
}

/**
 * @typedef {{ line: number, column: number }} Pos
 * @typedef {{ name: string, start: Pos, end: Pos, complexity: number, depth: number }} FunctionInfo
 */

/** @param {any} node */
function decisionPoints(node) {
  switch (node.type) {
    case 'IfStatement':
    case 'ConditionalExpression':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'CatchClause':
      return 1
    case 'SwitchCase':
      return node.test ? 1 : 0
    case 'LogicalExpression':
      return 1
    case 'AssignmentExpression':
      return node.operator === '&&=' || node.operator === '||=' || node.operator === '??=' ? 1 : 0
    default:
      return 0
  }
}

/** @param {any} key */
function keyName(key, computed) {
  if (!key) return null
  if (computed) return `[${key.type === 'StringLiteral' ? JSON.stringify(key.value) : '…'}]`
  if (key.type === 'Identifier') return key.name
  if (key.type === 'PrivateName') return `#${key.id?.name ?? key.name}`
  if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') return String(key.value)
  return null
}

/** @param {any} node */
function memberText(node) {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const obj = memberText(node.object)
    const prop = keyName(node.property, node.computed)
    return obj && prop ? `${obj}.${prop}` : null
  }
  return null
}

/**
 * The name a reader would use for a function, from its own id or the slot it sits in.
 * @param {any} node
 * @param {any} parent
 * @param {string | null} className
 */
function nameOf(node, parent, className) {
  if (node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
    const key = keyName(node.key, node.computed) ?? '<computed>'
    const prefix = node.kind === 'get' ? 'get ' : node.kind === 'set' ? 'set ' : ''
    return `${prefix}${className ?? '<class>'}.${key}`
  }
  if (node.type === 'ObjectMethod') return keyName(node.key, node.computed) ?? '<computed>'
  if (node.id?.name) return node.id.name
  if (!parent) return '<anonymous>'
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id.type === 'Identifier' ? parent.id.name : '<anonymous>'
    case 'ObjectProperty':
      return keyName(parent.key, parent.computed) ?? '<anonymous>'
    case 'ClassProperty':
    case 'ClassPrivateProperty':
    case 'ClassAccessorProperty':
      return `${className ?? '<class>'}.${keyName(parent.key, parent.computed) ?? '<computed>'}`
    case 'AssignmentExpression':
    case 'AssignmentPattern':
      return memberText(parent.left) ?? '<anonymous>'
    case 'ExportDefaultDeclaration':
      return 'default'
    default:
      return '<anonymous>'
  }
}

/**
 * Every function in a source file with its cyclomatic complexity: 1 plus one per branch
 * (if, ?:, loops, case, catch, &&, ||, ??, logical assignment). A nested function's
 * branches count toward the nested function only.
 * @param {string} code
 * @param {string} file used for the extension (syntax plugins) and error messages
 * @returns {FunctionInfo[]}
 */
export function analyze(code, file) {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    plugins: /** @type {any} */ (pluginsFor(file)),
    errorRecovery: false,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
  })
  /** @type {FunctionInfo[]} */
  const out = []

  /**
   * @param {any} node
   * @param {any} parent
   * @param {FunctionInfo | null} fn
   * @param {string | null} className
   * @param {number} depth
   */
  function walk(node, parent, fn, className, depth) {
    let current = fn
    let currentDepth = depth
    if (FUNCTION_TYPES.has(node.type) && node.body) {
      current = {
        name: nameOf(node, parent, className),
        start: { line: node.loc.start.line, column: node.loc.start.column },
        end: { line: node.loc.end.line, column: node.loc.end.column },
        complexity: 1,
        depth: depth + 1,
      }
      currentDepth = depth + 1
      out.push(current)
    } else if (current) {
      current.complexity += decisionPoints(node)
    }
    let cls = className
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      cls = node.id?.name ?? (parent?.type === 'VariableDeclarator' ? parent.id.name : '<class>')
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child.type === 'string') walk(child, node, current, cls, currentDepth)
      } else if (value && typeof value.type === 'string') {
        walk(value, node, current, cls, currentDepth)
      }
    }
  }

  walk(ast.program, null, null, null, 0)
  return out
}
