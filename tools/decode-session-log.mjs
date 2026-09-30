// Probe helper: decode a DSH session log (.jsonl.zstd, multi-frame zstd) into
// raw events. Node >= 22 ships zstd in node:zlib, but only for a single frame,
// so walk the frames the same way the persistence reader does.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Byte offsets of every zstd frame magic in the buffer. */
function frameOffsets(buffer) {
  const offsets = []
  let at = buffer.indexOf(MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(MAGIC, at + 4)
  }
  return offsets
}

/** Decompress every frame and concatenate, skipping frames we cannot read. */
export function decodeZstdFrames(buffer) {
  const offsets = frameOffsets(buffer)
  const parts = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A torn tail frame is expected while a session is live.
    }
  }
  return Buffer.concat(parts)
}

/** Read one session directory into raw events (v4 preferred, else v3). */
export function readSessionEvents(dir) {
  for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
    try {
      const text = decodeZstdFrames(readFileSync(`${dir}/${name}`)).toString('utf8')
      const events = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          events.push(JSON.parse(line))
        } catch {
          // ignore a torn final line
        }
      }
      if (events.length > 0) return { file: name, events }
    } catch {
      // try the next candidate
    }
  }
  return null
}
