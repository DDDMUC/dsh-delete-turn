// Local adapter patch: make `dsh-llm-pi-ai` skip user messages whose content
// converts to nothing, the same way the official DeepSeek adapter drops empty
// user content. dsh-delete-turn probes for the marker comment this writes and,
// when it finds it, uses an EMPTY content carrier for deletions — a deletion
// then leaves no blank message in any model request. Without the patch the
// plugin falls back to a zero-width carrier, so this tool is optional and its
// absence can never break a request.
//
//   node tools/apply-pi-ai-empty-skip.mjs            # patch every npx cache
//   node tools/apply-pi-ai-empty-skip.mjs --revert   # restore the backups
//
// A cache rebuild or a DSH upgrade replaces the patched file; re-run this tool
// after upgrading and restart DSH.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MARKER = 'dsh-delete-turn:skip-empty-user'
const REVERT = process.argv.includes('--revert')
const NPM_CACHE = process.env.DSH_NPX_CACHE_ROOT ?? path.join(os.homedir(), '.npm', '_npx')

const OLD = `\t\tconst content = userContent(message.content, requestImages, resolveImageAccess);
\t\tmessages.push({
\t\t\trole: "user",
\t\t\tcontent,
\t\t\ttimestamp: 0
\t\t});`

const NEW = `\t\tconst content = userContent(message.content, requestImages, resolveImageAccess);
\t\t// ${MARKER} — a user message whose content converts to nothing (the
\t\t// silent surface-replacement carrier dsh-delete-turn writes) is omitted
\t\t// from the request, exactly as the official DeepSeek adapter drops it.
\t\tif (content.length === 0) continue;
\t\tmessages.push({
\t\t\trole: "user",
\t\t\tcontent,
\t\t\ttimestamp: 0
\t\t});`

const caches = fs.existsSync(NPM_CACHE)
  ? fs.readdirSync(NPM_CACHE).map((entry) => path.join(NPM_CACHE, entry, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')).filter((file) => fs.existsSync(file))
  : []

if (caches.length === 0) {
  console.error('no installed @deepseek-ai/dsh-llm-pi-ai found under', NPM_CACHE)
  process.exit(1)
}

let changed = 0
for (const file of caches) {
  const backup = file + '.bak-dshdt-silent'
  const source = fs.readFileSync(file, 'utf8')
  if (REVERT) {
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, file)
      changed += 1
      console.log('reverted:', file)
    } else {
      console.log('no backup:', file)
    }
    continue
  }
  if (source.includes(MARKER)) {
    console.log('already patched:', file)
    continue
  }
  if (!source.includes(OLD)) {
    console.error('patch anchor not found (adapter changed upstream?):', file)
    continue
  }
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, source.replace(OLD, NEW))
  changed += 1
  console.log('patched:', file, '| backup:', path.basename(backup))
}
console.log(changed > 0 ? 'restart DSH for the change to load' : 'nothing to do')
