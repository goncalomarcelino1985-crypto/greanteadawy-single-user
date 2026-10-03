// The app's name and version. The version is injected at build time from client/package.json (vite.config.js
// `define`), so the About dialog shows what this browser actually runs; tests and Node imports see "dev".
/* global __APP_VERSION__ */
export const APP_NAME = 'GreanTeaDawy';
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
