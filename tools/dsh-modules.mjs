// Resolve the INSTALLED DSH packages (the real session-format validator and
// the real Session class) wherever this machine keeps them.
//
// The plugin itself has zero runtime dependencies and never imports these: they
// are only used by the contract test and tools/verify-real-session.mjs to prove
// that every write a delete lands is accepted by the platform's own validator -
// the append-time surface manager and the strict cold read
// (sessionFormatCatalog.createRestore), not a re-implementation of either.
//
// Lookup order (first hit wins):
//   1. DSH_SESSION_DIR - an explicit node_modules root, for any other layout;
//   2. the repository's own node_modules, its parent's, and the sibling
//      dsh-rerun-turn checkout (the maintainer's workspace layout);
//   3. every npx cache root (~/.npm/_npx/<hash>/node_modules) - where a DSH
//      install launched through npx keeps its packages;
//   4. the bare specifier, when the package is installed normally.
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

/** Candidate node_modules roots, in lookup order. */
export function dshModuleRoots() {
  const roots = []
  if (typeof process.env.DSH_SESSION_DIR === 'string' && process.env.DSH_SESSION_DIR !== '') {
    roots.push(process.env.DSH_SESSION_DIR)
  }
  roots.push(join(REPO, 'node_modules'), join(REPO, '..', 'node_modules'), join(REPO, '..', 'dsh-rerun-turn', 'node_modules'))
  const npx = join(homedir(), '.npm', '_npx')
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) roots.push(join(npx, entry, 'node_modules'))
  }
  roots.push(join(homedir(), '.dsh', 'node_modules'))
  return roots
}

/**
 * Import one installed DSH package, or throw with every location tried.
 * @param name - package specifier.
 * @returns the module namespace.
 */
export async function loadDshModule(name) {
  const require = createRequire(import.meta.url)
  const tried = []
  for (const root of dshModuleRoots()) {
    try {
      return await import(pathToFileURL(require.resolve(name, { paths: [root] })).href)
    } catch (error) {
      tried.push(root + ': ' + String((error && error.message) || error).split('\n')[0])
    }
  }
  try {
    return await import(name)
  } catch (error) {
    tried.push('bare specifier: ' + String((error && error.message) || error).split('\n')[0])
  }
  throw new Error('cannot resolve ' + name + ' - install it or point DSH_SESSION_DIR at a node_modules root:\n  ' + tried.join('\n  '))
}
