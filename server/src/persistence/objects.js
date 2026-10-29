import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PersistenceError, hasControlCharacters, sha256, validateBudget, validateObjectReference, verifyObject } from './validation.js';

const missing = (error) => error?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(error?.name);

async function readBody(body, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      body.destroy?.();
      throw new PersistenceError('OBJECT_TOO_LARGE', 'Cloud object exceeds the configured download limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

/** An S3-compatible private bucket, with immutable SHA-256 keys and a durable quota ledger. */
export class S3ObjectStore {
  constructor({ client, bucket, prefix = 'gm-worker/', ledger, maxObjectBytes = 64 * 1024 * 1024, readOnly = false }) {
    if (!client?.send || !ledger?.reserve || typeof bucket !== 'string' || !bucket ||
        typeof prefix !== 'string' || /(^\/|\\|\.\.)/.test(prefix) || hasControlCharacters(prefix)) {
      throw new PersistenceError('CONFIGURATION', 'Private object storage and a durable quota ledger are required.');
    }
    this.client = client;
    this.bucket = bucket;
    this.prefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
    this.ledger = ledger;
    this.maxObjectBytes = validateBudget(maxObjectBytes, 'Single object budget');
    this.readOnly = readOnly;
  }

  async get(ref) {
    validateObjectReference(ref);
    if (ref.size > this.maxObjectBytes) throw new PersistenceError('OBJECT_TOO_LARGE', 'Object exceeds the configured download limit.');
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + ref.key }));
    } catch (error) {
      if (missing(error)) throw new PersistenceError('OBJECT_MISSING', 'A required cloud object is missing.');
      throw error;
    }
    if (response.ContentLength != null && Number(response.ContentLength) !== ref.size) {
      response.Body?.destroy?.();
      throw new PersistenceError('OBJECT_CORRUPT', 'Cloud object length does not match its checkpoint.');
    }
    if (!response.Body) throw new PersistenceError('OBJECT_CORRUPT', 'Cloud object has no response body.');
    return verifyObject(ref, await readBody(response.Body, ref.size));
  }

  async put(input) {
    if (this.readOnly) throw new PersistenceError('READ_ONLY', 'This cloud object connection is read-only.');
    if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new PersistenceError('INVALID_OBJECT', 'Object content must be bytes.');
    const bytes = Buffer.from(input);
    if (bytes.length > this.maxObjectBytes) throw new PersistenceError('OBJECT_TOO_LARGE', 'Object exceeds the configured upload limit.');
    const digest = sha256(bytes);
    const ref = { key: digest, sha256: digest, size: bytes.length };
    // Reserve before issuing any upload, even when a previous call may have succeeded.
    await this.ledger.reserve(ref);
    try {
      await this.get(ref);
      return ref;
    } catch (error) {
      if (error.code !== 'OBJECT_MISSING') throw error;
    }
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: this.prefix + ref.key, Body: bytes,
      ContentType: 'application/octet-stream', ContentLength: bytes.length,
      Metadata: { sha256: digest }, CacheControl: 'private, max-age=31536000, immutable'
    }));
    // Confirm bytes in cloud; HTTP 200 or ETag alone does not prove integrity.
    await this.get(ref);
    return ref;
  }
}
