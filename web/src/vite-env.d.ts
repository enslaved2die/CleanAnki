/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** package.json's version, injected at build time (vite.config.ts `define`) —
 * the Profile page's version footer. */
declare const __APP_VERSION__: string
/** Short git commit hash, injected at build time (vite.config.ts `define`) —
 * the precise "which exact build is this" identifier that stays accurate
 * between version bumps. "unknown" if built outside a git checkout. */
declare const __GIT_COMMIT__: string

// Fontsource variable-font packages ship CSS + font files only, no types —
// this just tells TS the side-effect import in main.tsx is valid.
declare module '@fontsource-variable/hanken-grotesk'
