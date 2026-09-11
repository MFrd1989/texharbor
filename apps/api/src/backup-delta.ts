import { z } from 'zod';
import { HttpError } from './http.js';

// Copy ranges refer to the previous content; strings contain only new bytes.
const operationSchema = z.union([
  z.tuple([z.number().int().nonnegative(), z.number().int().positive()]),
  z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
]);
const deltaSchema = z.array(operationSchema).max(2_000_000);
type Operation = z.infer<typeof operationSchema>;
const modulus = 65521;

function checksum(bytes: Buffer, offset: number, blockSize: number): [number, number] {
  let a = 0;
  let b = 0;
  for (let i = 0; i < blockSize; i++) {
    const value = bytes[offset + i]!;
    a += value;
    b += (blockSize - i) * value;
  }
  return [a % modulus, b % modulus];
}

export function createByteDelta(previous: Buffer, current: Buffer): Buffer {
  const operations: Operation[] = [];
  const copy = (offset: number, length: number) => {
    if (!length) return;
    const last = operations.at(-1);
    if (Array.isArray(last) && last[0] + last[1] === offset) last[1] += length;
    else operations.push([offset, length]);
  };
  // Trim matching ends first: common editor insertions need no block index.
  let prefix = 0;
  while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previous.length - prefix && suffix < current.length - prefix && previous[previous.length - suffix - 1] === current[current.length - suffix - 1]) suffix++;
  copy(0, prefix);
  const end = current.length - suffix;
  // Bound the lookup table even for large binary assets.
  const blockSize = Math.max(32, Math.ceil((previous.length - prefix - suffix) / 100_000));
  const index = new Map<number, number[]>();
  for (let offset = prefix; offset + blockSize <= previous.length - suffix; offset += blockSize) {
    const [a, b] = checksum(previous, offset, blockSize);
    const key = b * 65536 + a;
    const candidates = index.get(key) || [];
    // Bound work for repeated input and checksum collisions.
    if (candidates.length < 8) candidates.push(offset);
    index.set(key, candidates);
  }
  let position = prefix;
  let literalStart = position;
  let rolling: [number, number] | undefined;
  while (index.size && position + blockSize <= end) {
    const [a, b] = rolling || checksum(current, position, blockSize);
    const candidates = index.get(b * 65536 + a) || [];
    const match = candidates.find((offset) => previous.subarray(offset, offset + blockSize).equals(current.subarray(position, position + blockSize)));
    if (match !== undefined) {
      if (literalStart < position) operations.push(current.subarray(literalStart, position).toString('base64'));
      let length = blockSize;
      while (match + length < previous.length - suffix && position + length < end && previous[match + length] === current[position + length]) length++;
      copy(match, length);
      position += length;
      literalStart = position;
      rolling = undefined;
    } else {
      const outgoing = current[position]!;
      const incoming = current[position + blockSize] || 0;
      const nextA = (a - outgoing + incoming + modulus) % modulus;
      rolling = [nextA, ((b - blockSize * outgoing + nextA) % modulus + modulus) % modulus];
      position++;
    }
  }
  if (literalStart < end) operations.push(current.subarray(literalStart, end).toString('base64'));
  copy(previous.length - suffix, suffix);
  return Buffer.from(JSON.stringify(operations));
}

export function applyByteDelta(previous: Buffer, delta: Buffer, expectedSize: number): Buffer {
  let operations: Operation[];
  try { operations = deltaSchema.parse(JSON.parse(delta.toString('utf8'))); }
  catch { throw new HttpError(422, 'Backup delta is invalid'); }
  const parts: Buffer[] = [];
  let size = 0;
  for (const operation of operations) {
    let part: Buffer;
    if (typeof operation === 'string') part = Buffer.from(operation, 'base64');
    else {
      const [offset, length] = operation;
      if (offset + length > previous.length) throw new HttpError(422, 'Backup delta copy is outside its base file');
      part = previous.subarray(offset, offset + length);
    }
    size += part.length;
    if (size > expectedSize) throw new HttpError(422, 'Backup delta exceeds its declared size');
    parts.push(part);
  }
  if (size !== expectedSize) throw new HttpError(422, 'Backup delta size does not match');
  return Buffer.concat(parts, size);
}
