// Version of this code, the same as in manifest.json (dev/test.mjs checks this).
//
// The browser caches the background code (service worker) and only replaces it when the extension is
// reloaded on the extensions page; closing and reopening the browser does not. The UI pages, on the other hand,
// always come from disk. So the panel compares its version with the one the service worker reports and reloads
// the extension when they differ (ui/fresh.js). Changed background code? Bump the version here and in the manifest.
export const BUILD = '0.8.1';
