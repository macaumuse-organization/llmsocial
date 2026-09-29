import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * A plain zip writer (deflate or store, no ZIP64) for the Windows 免安装版.
 *
 * Why not the system tar: Windows' bsdtar writes names in the active code page (GBK here) without
 * the UTF-8 flag, so the archive unpacks with garbled Chinese names on Traditional-Chinese or English
 * Windows, and it crashes outright (access violation) on a name that code page cannot represent —
 * node_modules ships one (@fastify/send's test fixture "snow ☃"). This writer stores every name as
 * UTF-8 with general-purpose bit 11 set, which Explorer's "Extract All", 7-Zip, Bandizip and WinRAR
 * all honour. build-portable.ts proves it by unpacking the result through the Windows shell.
 */

export interface ZipEntry {
  /** Path inside the archive, forward slashes, directories end with "/". */
  name: string;
  dir: boolean;
  size: number;
}

export interface ZipResult {
  entries: ZipEntry[];
  bytesIn: number;
  bytesOut: number;
}

const UTF8_NAMES = 0x0800;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

interface Item {
  name: string;
  abs: string;
  dir: boolean;
  mtime: Date;
}

/** Local time packed the DOS way; the format cannot express anything before 1980. */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  if (d.getFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 };
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

/** Sorted by name so the same tree always gives the same archive. */
function walk(root: string, rel: string, out: Item[]): void {
  const here = rel === '' ? root : path.join(root, rel);
  const children = fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const child of children) {
    const name = rel === '' ? child.name : `${rel}/${child.name}`;
    const abs = path.join(root, name);
    if (child.isSymbolicLink()) throw new Error(`不打包符号链接：${name}`);
    if (child.isDirectory()) {
      out.push({ name: `${name}/`, abs, dir: true, mtime: fs.statSync(abs).mtime });
      walk(root, name, out);
    } else if (child.isFile()) {
      out.push({ name, abs, dir: false, mtime: fs.statSync(abs).mtime });
    } else {
      throw new Error(`不认识的文件类型：${name}`);
    }
  }
}

/**
 * Zips `sourceDir` so that it unpacks as a single folder named `rootName`.
 * Throws instead of writing an archive the format cannot describe (more than 65535 entries, or a
 * file or offset past 4 GiB — those would need ZIP64).
 */
export function zipDirectory(sourceDir: string, rootName: string, outFile: string): ZipResult {
  const items: Item[] = [{ name: `${rootName}/`, abs: sourceDir, dir: true, mtime: fs.statSync(sourceDir).mtime }];
  const inner: Item[] = [];
  walk(sourceDir, '', inner);
  for (const item of inner) items.push({ ...item, name: `${rootName}/${item.name}` });
  if (items.length > MAX_U16) throw new Error(`条目太多（${items.length}），普通 zip 最多 65535 个`);

  const fd = fs.openSync(outFile, 'w');
  const central: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  let bytesIn = 0;
  const write = (buf: Buffer): void => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };

  try {
    for (const item of items) {
      const name = Buffer.from(item.name, 'utf8');
      let data: Buffer = Buffer.alloc(0);
      let method = 0;
      let crc = 0;
      let size = 0;
      if (!item.dir) {
        const raw = fs.readFileSync(item.abs);
        size = raw.length;
        bytesIn += size;
        crc = zlib.crc32(raw) >>> 0;
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        if (deflated.length < raw.length) {
          data = deflated;
          method = 8;
        } else {
          data = raw;
        }
      }
      if (size > MAX_U32 || data.length > MAX_U32 || offset > MAX_U32) throw new Error(`${item.name} 超出普通 zip 的 4 GiB 上限`);

      const { date, time } = dosDateTime(item.mtime);
      const headerOffset = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate, directories)
      local.writeUInt16LE(UTF8_NAMES, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      write(local);
      write(name);
      if (data.length > 0) write(data);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // made by: MS-DOS host (attributes below are DOS attributes), spec 2.0
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(data.length, 20);
      header.writeUInt32LE(size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(0, 30); // extra field length
      header.writeUInt16LE(0, 32); // comment length
      header.writeUInt16LE(0, 34); // disk number
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(item.dir ? 0x10 : 0x20, 38); // FILE_ATTRIBUTE_DIRECTORY / _ARCHIVE
      header.writeUInt32LE(headerOffset, 42);
      central.push(header, name);
      entries.push({ name: item.name, dir: item.dir, size });
    }

    const centralStart = offset;
    for (const part of central) write(part);
    const centralSize = offset - centralStart;
    if (centralStart > MAX_U32 || centralSize > MAX_U32) throw new Error('中央目录超出普通 zip 的 4 GiB 上限');

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(items.length, 8);
    end.writeUInt16LE(items.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    write(end);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(outFile, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  return { entries, bytesIn, bytesOut: offset };
}
