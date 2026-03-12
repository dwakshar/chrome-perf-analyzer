// ─────────────────────────────────────────────────────────────────────────────
// library-fingerprints.ts
//
// Heuristic fingerprint database for detecting known JS libraries and bundlers
// from script URLs, source content snippets, and global variable presence.
//
// Detection strategy (in priority order):
//   1. URL pattern match (cheapest — no source fetch needed)
//   2. Global variable signature (via Runtime.evaluate in page context)
//   3. Source content signature (requires fetchScriptSource: true)
// ─────────────────────────────────────────────────────────────────────────────

import type {
  DetectedBundler,
  DetectedLibrary,
  LibraryCategory,
} from "../shared/types/bundle.types.js";

// ─────────────────────────────────────────────────────────────────────────────
// URL fingerprints
// ─────────────────────────────────────────────────────────────────────────────

interface UrlFingerprint {
  pattern: RegExp;
  name: string;
  category: LibraryCategory;
  /** Typical minified size in bytes (for size estimation) */
  typicalSize?: number;
}

export const URL_FINGERPRINTS: UrlFingerprint[] = [
  // ── Frameworks ────────────────────────────────────────────────────────────
  {
    pattern: /react(?:[-.]dom)?(?:\.min)?\.js/i,
    name: "React",
    category: "framework",
    typicalSize: 45_000,
  },
  {
    pattern: /react[-.]production/i,
    name: "React",
    category: "framework",
    typicalSize: 45_000,
  },
  {
    pattern: /vue(?:\.min)?\.(?:js|esm)/i,
    name: "Vue",
    category: "framework",
    typicalSize: 90_000,
  },
  {
    pattern: /angular(?:\.min)?\.js/i,
    name: "Angular",
    category: "framework",
    typicalSize: 180_000,
  },
  {
    pattern: /svelte/i,
    name: "Svelte",
    category: "framework",
    typicalSize: 20_000,
  },
  {
    pattern: /next(?:js)?[-\/](?:chunks|static)/i,
    name: "Next.js",
    category: "framework",
    typicalSize: 80_000,
  },
  {
    pattern: /nuxt(?:js)?/i,
    name: "Nuxt",
    category: "framework",
    typicalSize: 80_000,
  },
  {
    pattern: /remix[-\/]/i,
    name: "Remix",
    category: "framework",
    typicalSize: 60_000,
  },

  // ── UI Libraries ──────────────────────────────────────────────────────────
  {
    pattern: /material[-.]ui|@mui/i,
    name: "Material UI",
    category: "ui-library",
    typicalSize: 300_000,
  },
  {
    pattern: /antd|ant[-.]design/i,
    name: "Ant Design",
    category: "ui-library",
    typicalSize: 500_000,
  },
  {
    pattern: /chakra[-.]ui/i,
    name: "Chakra UI",
    category: "ui-library",
    typicalSize: 200_000,
  },
  {
    pattern: /bootstrap(?:\.min)?\.js/i,
    name: "Bootstrap",
    category: "ui-library",
    typicalSize: 60_000,
  },
  {
    pattern: /tailwindcss/i,
    name: "Tailwind",
    category: "ui-library",
    typicalSize: 10_000,
  },

  // ── Utilities ─────────────────────────────────────────────────────────────
  {
    pattern: /lodash(?:\.min)?\.js/i,
    name: "Lodash",
    category: "utility",
    typicalSize: 70_000,
  },
  {
    pattern: /underscore(?:\.min)?\.js/i,
    name: "Underscore",
    category: "utility",
    typicalSize: 18_000,
  },
  {
    pattern: /moment(?:\.min)?\.js/i,
    name: "Moment.js",
    category: "utility",
    typicalSize: 290_000,
  },
  {
    pattern: /date[-.]fns/i,
    name: "date-fns",
    category: "utility",
    typicalSize: 80_000,
  },
  {
    pattern: /dayjs(?:\.min)?\.js/i,
    name: "Day.js",
    category: "utility",
    typicalSize: 7_000,
  },
  {
    pattern: /axios(?:\.min)?\.js/i,
    name: "Axios",
    category: "utility",
    typicalSize: 15_000,
  },
  {
    pattern: /jquery(?:\.min)?\.js/i,
    name: "jQuery",
    category: "utility",
    typicalSize: 87_000,
  },
  {
    pattern: /ramda(?:\.min)?\.js/i,
    name: "Ramda",
    category: "utility",
    typicalSize: 50_000,
  },
  {
    pattern: /immer(?:\.min)?/i,
    name: "Immer",
    category: "utility",
    typicalSize: 15_000,
  },
  {
    pattern: /zod(?:\.min)?/i,
    name: "Zod",
    category: "utility",
    typicalSize: 55_000,
  },

  // ── State management ──────────────────────────────────────────────────────
  {
    pattern: /redux(?:\.min)?\.js/i,
    name: "Redux",
    category: "utility",
    typicalSize: 20_000,
  },
  {
    pattern: /zustand/i,
    name: "Zustand",
    category: "utility",
    typicalSize: 5_000,
  },
  {
    pattern: /mobx(?:\.min)?\.js/i,
    name: "MobX",
    category: "utility",
    typicalSize: 60_000,
  },

  // ── Polyfills ─────────────────────────────────────────────────────────────
  {
    pattern: /core[-.]js/i,
    name: "core-js",
    category: "polyfill",
    typicalSize: 200_000,
  },
  {
    pattern: /regenerator[-.]runtime/i,
    name: "Regenerator",
    category: "polyfill",
    typicalSize: 25_000,
  },
  {
    pattern: /polyfill(?:\.min)?\.js/i,
    name: "Polyfill",
    category: "polyfill",
    typicalSize: 30_000,
  },

  // ── Analytics / Tracking ──────────────────────────────────────────────────
  {
    pattern: /google[-.]analytics|gtag|ga\.js/i,
    name: "Google Analytics",
    category: "analytics",
    typicalSize: 50_000,
  },
  {
    pattern: /segment\.(?:min\.)?js/i,
    name: "Segment",
    category: "analytics",
    typicalSize: 60_000,
  },
  {
    pattern: /mixpanel(?:\.min)?\.js/i,
    name: "Mixpanel",
    category: "analytics",
    typicalSize: 45_000,
  },
  {
    pattern: /hotjar/i,
    name: "Hotjar",
    category: "analytics",
    typicalSize: 40_000,
  },
  {
    pattern: /sentry/i,
    name: "Sentry",
    category: "analytics",
    typicalSize: 80_000,
  },
  {
    pattern: /datadog/i,
    name: "Datadog RUM",
    category: "analytics",
    typicalSize: 60_000,
  },

  // ── Testing (should not appear in production) ─────────────────────────────
  {
    pattern: /jest[-.](?:runtime|circus)/i,
    name: "Jest",
    category: "testing",
    typicalSize: 500_000,
  },
  {
    pattern: /mocha(?:\.min)?\.js/i,
    name: "Mocha",
    category: "testing",
    typicalSize: 250_000,
  },
  {
    pattern: /jasmine(?:\.min)?\.js/i,
    name: "Jasmine",
    category: "testing",
    typicalSize: 100_000,
  },
  {
    pattern: /cypress/i,
    name: "Cypress",
    category: "testing",
    typicalSize: 800_000,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Source content signatures
// ─────────────────────────────────────────────────────────────────────────────

interface SourceFingerprint {
  /** Regex searched against up to first 4 KB of source */
  pattern: RegExp;
  name: string;
  category: LibraryCategory;
  versionPattern?: RegExp; // Named group `version` extracts semver
}

export const SOURCE_FINGERPRINTS: SourceFingerprint[] = [
  // React
  {
    pattern: /\bReact\.createElement\b|\bjsx[-_]runtime\b/,
    name: "React",
    category: "framework",
    versionPattern: /React\.version\s*=\s*["'](?<version>[\d.]+)["']/,
  },
  // Vue 3
  {
    pattern: /\bcreateApp\b.*\bdefineComponent\b|\bvue3\b/,
    name: "Vue 3",
    category: "framework",
  },
  // Vue 2
  {
    pattern: /Vue\.config\.productionTip/,
    name: "Vue 2",
    category: "framework",
  },
  // Svelte
  {
    pattern: /\bSvelteComponent\b|\bcreate_fragment\b/,
    name: "Svelte",
    category: "framework",
  },
  // Lodash
  {
    pattern: /\blodash\b.*\bVar VERSION\b|exports\._\s*=/,
    name: "Lodash",
    category: "utility",
    versionPattern: /VERSION\s*=\s*["'](?<version>[\d.]+)["']/,
  },
  // jQuery
  {
    pattern: /jQuery\.fn\.jquery|window\.jQuery\s*=/,
    name: "jQuery",
    category: "utility",
    versionPattern: /jquery:\s*["'](?<version>[\d.]+)["']/,
  },
  // Moment.js
  {
    pattern: /moment\.version\s*=|exports\.moment/,
    name: "Moment.js",
    category: "utility",
  },
  // core-js
  {
    pattern: /core-js\/internals|__core-js_shared__/,
    name: "core-js",
    category: "polyfill",
  },
  // Webpack runtime
  {
    pattern: /\b__webpack_require__\b|\bwebpackChunk\b/,
    name: "Webpack Runtime",
    category: "bundler-runtime",
  },
  // Rollup IIFE
  {
    pattern: /\(function\s*\(\s*\)\s*\{[\s\S]{0,100}'use strict'/,
    name: "Rollup IIFE",
    category: "bundler-runtime",
  },
  // Vite / Rollup ESM
  {
    pattern: /import\.meta\.env\.VITE_|__vite__mapDeps/,
    name: "Vite Runtime",
    category: "bundler-runtime",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Bundler detection
// ─────────────────────────────────────────────────────────────────────────────

interface BundlerSignature {
  pattern: RegExp;
  bundler: DetectedBundler;
}

export const BUNDLER_SIGNATURES: BundlerSignature[] = [
  {
    pattern: /\b__webpack_require__\b|\bwebpackChunkName\b/,
    bundler: "webpack",
  },
  { pattern: /\bimport\.meta\.env\.VITE_\b|__vite__/, bundler: "vite" },
  { pattern: /\b__rollup_\b|sourceMappingURL.*rollup/i, bundler: "rollup" },
  { pattern: /\bparcelRequire\b|\bparcel\/runtime\b/, bundler: "parcel" },
  { pattern: /\/\/\s*esbuild/i, bundler: "esbuild" },
  { pattern: /turbopack/i, bundler: "turbopack" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Detection functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect libraries from a script URL alone (no source fetch required).
 */
export function detectLibrariesFromUrl(url: string): DetectedLibrary[] {
  const found: DetectedLibrary[] = [];

  for (const fp of URL_FINGERPRINTS) {
    if (fp.pattern.test(url)) {
      const lib: DetectedLibrary = {
        name: fp.name,
        category: fp.category,
      };

      if (fp.typicalSize !== undefined) {
        lib.estimatedSize = fp.typicalSize;
      }

      found.push(lib);
    }
  }

  return found;
}

/**
 * Detect libraries and bundler from the first N bytes of script source.
 * Pass the full source or a large prefix for best results.
 */
export function detectLibrariesFromSource(
  source: string,
  sampleSize = 8192
): { libraries: DetectedLibrary[]; bundler: DetectedBundler | null } {
  const sample = source.slice(0, sampleSize);
  const libraries: DetectedLibrary[] = [];
  let bundler: DetectedBundler | null = null;

  // Library detection
  for (const fp of SOURCE_FINGERPRINTS) {
    if (fp.pattern.test(sample)) {
      let version: string | undefined;

      if (fp.versionPattern) {
        const m = fp.versionPattern.exec(source.slice(0, 32_768));
        version = m?.groups?.["version"];
      }

      const lib: DetectedLibrary = {
        name: fp.name,
        category: fp.category,
      };

      if (version !== undefined) {
        lib.version = version;
      }

      libraries.push(lib);
    }
  }

  // Bundler detection
  for (const sig of BUNDLER_SIGNATURES) {
    if (sig.pattern.test(sample)) {
      bundler = sig.bundler;
      break;
    }
  }

  return { libraries, bundler };
}

/**
 * Deduplicate detected libraries and flag duplicates by name.
 * If the same library appears in multiple scripts, mark them as duplicates.
 */
export function deduplicateLibraries(
  allLibraries: Array<{ scriptId: string; lib: DetectedLibrary }>
): Map<
  string,
  { lib: DetectedLibrary; scriptIds: string[]; isDuplicate: boolean }
> {
  const map = new Map<
    string,
    { lib: DetectedLibrary; scriptIds: string[]; isDuplicate: boolean }
  >();

  for (const { scriptId, lib } of allLibraries) {
    const key = lib.name.toLowerCase();

    if (map.has(key)) {
      const entry = map.get(key)!;
      entry.scriptIds.push(scriptId);
      entry.isDuplicate = entry.scriptIds.length > 1;
    } else {
      map.set(key, {
        lib,
        scriptIds: [scriptId],
        isDuplicate: false,
      });
    }
  }

  return map;
}
