/**
 * A minimal reader for the one thing we need from a .docx or .xlsx: the text inside.
 *
 * Both are ZIP archives holding XML. Pulling in a general-purpose archive library for
 * that would add a large dependency (and, historically, a stream of CVEs) to a server
 * that otherwise touches nothing but hotel text. The central directory format is small
 * and stable, so we read it directly and inflate the entries we care about.
 *
 * Deliberately supports only stored (0) and deflated (8) entries — the two methods Word
 * and Excel actually emit.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const MAX_COMMENT = 0xffff;
/** One entry, uncompressed, must stay sane: a hotel menu is kilobytes, not gigabytes. */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  read(): Buffer;
}

/** Lists the archive entries without inflating anything. */
export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressed = buf.readUInt32LE(ptr + 20);
    const uncompressed = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    entries.push({
      name,
      read: () => {
        if (uncompressed > MAX_ENTRY_BYTES) throw new Error('entry too large');
        // The local header repeats the name/extra lengths, and its extra field
        // routinely differs from the central one — always re-read it here.
        const lnLen = buf.readUInt16LE(localOffset + 26);
        const leLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lnLen + leLen;
        const raw = buf.subarray(start, start + compressed);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
        throw new Error(`unsupported compression ${method}`);
      },
    });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Reads one named entry as UTF-8, or undefined when the archive has no such file. */
export function readZipText(buf: Buffer, name: string): string | undefined {
  const entry = readZip(buf).find((e) => e.name === name);
  return entry ? entry.read().toString('utf8') : undefined;
}

function findEocd(buf: Buffer): number {
  const from = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}
