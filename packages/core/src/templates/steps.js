import { notesFromSteps } from '../builders.js';

/** A drum step string (spaces between beats and bars allowed) as notes on `key` (default the channel's root key). */
export const steps = (str, key, opts = {}) => notesFromSteps(str.replace(/\s/g, ''), { key, ...opts });
