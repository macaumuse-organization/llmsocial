import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Callback crypto shared by the WeChat Official Account and WeCom connectors.
 * Both use the same scheme: sha1 over sorted parts for the signature, and AES-256-CBC
 * with a 43-char base64 EncodingAESKey for the body. Pure functions, no I/O.
 */

/** WeChat pads to 32 bytes even though the AES block is 16, so the pad byte can be up to 32. */
const WX_BLOCK_SIZE = 32;
const MAX_XML_BYTES = 64 * 1024;

/** token/timestamp/nonce/encrypt sorted as strings, concatenated, sha1 hex. */
export function wxSignature(parts: string[]): string {
  return createHash('sha1').update([...parts].sort().join(''), 'utf8').digest('hex');
}

export function wxVerify(expected: string, parts: string[]): boolean {
  const actual = Buffer.from(wxSignature(parts), 'utf8');
  const given = Buffer.from(expected ?? '', 'utf8');
  // Lengths differ only when the caller sent a malformed signature; compare anyway to keep timing flat.
  if (given.length !== actual.length) return false;
  return timingSafeEqual(given, actual);
}

function aesKey(encodingAesKey: string): Buffer {
  if (typeof encodingAesKey !== 'string' || encodingAesKey.length !== 43) {
    throw new Error('EncodingAESKey must be 43 characters');
  }
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey does not decode to 32 bytes');
  return key;
}

function stripPkcs7(buf: Buffer): Buffer {
  if (buf.length === 0) throw new Error('empty plaintext');
  const pad = buf[buf.length - 1] ?? 0;
  if (pad < 1 || pad > WX_BLOCK_SIZE || pad > buf.length) throw new Error('bad padding');
  for (let i = buf.length - pad; i < buf.length; i += 1) {
    if (buf[i] !== pad) throw new Error('bad padding');
  }
  return buf.subarray(0, buf.length - pad);
}

function addPkcs7(buf: Buffer): Buffer {
  const pad = WX_BLOCK_SIZE - (buf.length % WX_BLOCK_SIZE);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/** Plaintext layout: 16 random bytes | 4-byte big-endian length | message | receiveId. */
export function wxDecrypt(encodingAesKey: string, encryptedB64: string): { message: string; receiveId: string } {
  const key = aesKey(encodingAesKey);
  const raw = Buffer.from(encryptedB64 ?? '', 'base64');
  if (raw.length === 0 || raw.length % 16 !== 0) throw new Error('ciphertext length is not a multiple of the AES block');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = stripPkcs7(Buffer.concat([decipher.update(raw), decipher.final()]));
  if (plain.length < 20) throw new Error('plaintext too short');
  const msgLen = plain.readUInt32BE(16);
  if (msgLen > plain.length - 20) throw new Error('declared message length exceeds plaintext');
  return {
    message: plain.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: plain.subarray(20 + msgLen).toString('utf8'),
  };
}

/** Used for the encrypted-mode reply body and for round-trip tests. */
export function wxEncrypt(encodingAesKey: string, message: string, receiveId: string): string {
  const key = aesKey(encodingAesKey);
  const body = Buffer.from(message, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const plain = addPkcs7(Buffer.concat([randomBytes(16), len, body, Buffer.from(receiveId, 'utf8')]));
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

const XML_TAG = /<([A-Za-z_][A-Za-z0-9_.:-]*)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;

/**
 * WeChat callback bodies are one flat level of tags under <xml>, so a parser dependency would be
 * a supply-chain cost for no gain. Nested or repeated tags are not supported by design: last wins.
 */
export function parseFlatXml(xml: string): Record<string, string> {
  if (typeof xml !== 'string') throw new Error('xml must be a string');
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new Error('xml body exceeds 64 KB');
  const start = xml.indexOf('<xml>');
  const end = xml.lastIndexOf('</xml>');
  const inner = start >= 0 && end > start ? xml.slice(start + 5, end) : xml;
  const out: Record<string, string> = {};
  XML_TAG.lastIndex = 0;
  let m = XML_TAG.exec(inner);
  while (m !== null) {
    const name = m[1];
    if (name !== undefined) out[name] = m[2] ?? m[3] ?? '';
    m = XML_TAG.exec(inner);
  }
  return out;
}
