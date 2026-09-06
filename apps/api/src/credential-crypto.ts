import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyFor = (secret: string) => createHash('sha256').update(`texharbor/cloud-credentials/v1/${secret}`).digest();

export function sealCredential(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, encrypted, cipher.getAuthTag()].map((part) => part.toString('base64url')).join('.');
}

export function openCredential(value: string, secret: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Stored cloud credential is invalid');
  const [iv, encrypted, tag] = parts.map((part) => Buffer.from(part!, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8');
}
