import { createHash } from 'node:crypto';

export class PersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const hasControlCharacters = (value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** Stable across JSONB key ordering, for verifiable checkpoints and backups. */
export function canonicalJSON(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  throw new PersistenceError('INVALID_STATE', 'Checkpoint must contain only finite JSON values.');
}

export function validateIdentifier(value, label = 'Namespace') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value)) {
    throw new PersistenceError('INVALID_NAMESPACE', `${label} is invalid.`);
  }
  return value;
}

export function validateBudget(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new PersistenceError('INVALID_BUDGET', `${label} must be a positive integer.`);
  return value;
}

export function validateObjectReference(ref) {
  if (!ref || typeof ref !== 'object' || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.key !== ref.sha256 ||
      !Number.isSafeInteger(ref.size) || ref.size < 0) {
    throw new PersistenceError('INVALID_OBJECT', 'Invalid content-addressed object reference.');
  }
  return { key: ref.key, sha256: ref.sha256, size: ref.size };
}

/** Only portable, relative cache paths are allowed during reconstruction. */
export function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !state.files || Array.isArray(state.files) || typeof state.files !== 'object') {
    throw new PersistenceError('INVALID_STATE', 'Unsupported workspace checkpoint.');
  }
  canonicalJSON(state);
  const refs = new Map();
  const paths = new Set(Object.keys(state.files));
  for (const [name, file] of Object.entries(state.files)) {
    const parts = name.split('/');
    if (!name || name.includes('\\') || name.includes(':') || hasControlCharacters(name) ||
        parts.some((part) => !part || part === '.' || part === '..') || name.length > 1024 ||
        parts.some((_, index) => index > 0 && paths.has(parts.slice(0, index).join('/')))) {
      throw new PersistenceError('INVALID_PATH', 'Checkpoint contains an unsafe or conflicting relative path.');
    }
    if (!file || typeof file !== 'object' || !['json', 'blob'].includes(file.kind)) {
      throw new PersistenceError('INVALID_STATE', 'Unknown workspace file kind.');
    }
    if (file.kind === 'json') {
      canonicalJSON(file.value);
    } else {
      const ref = validateObjectReference(file);
      const previous = refs.get(ref.key);
      if (previous && previous.size !== ref.size) throw new PersistenceError('INVALID_OBJECT', 'Conflicting object sizes.');
      refs.set(ref.key, ref);
    }
  }
  return [...refs.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function verifyObject(ref, bytes) {
  validateObjectReference(ref);
  if (bytes.length !== ref.size || sha256(bytes) !== ref.sha256) {
    throw new PersistenceError('OBJECT_CORRUPT', 'Cloud object failed its size or SHA-256 integrity check.');
  }
  return bytes;
}
