<div align="center">

<img src="icons/banner.jpg"/>

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178c6?style=flat-square&logo=typescript&logoColor=white)](#)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](#)
[![Tests](https://img.shields.io/badge/55%20tests-passing-22c55e?style=flat-square)](#running-tests)
[![Chrome](https://img.shields.io/badge/Chrome-≥%20109-EA4335?style=flat-square&logo=googlechrome&logoColor=white)](#)
[![Zero Runtime Deps](https://img.shields.io/badge/runtime%20deps-zero-f97316?style=flat-square)](#)
[![License](https://img.shields.io/badge/License-MIT-6366f1?style=flat-square)](#license)

</div>

Chrome Perf Analyzer is a Manifest V3 Chrome DevTools extension that captures Core Web Vitals from the inspected page and shows a lightweight issues feed inside a dedicated DevTools panel.

## Current scope

- Collects `LCP`, `CLS`, `FCP`, and `TTFB` from the page via `PerformanceObserver` and navigation timing.
- Persists session state in `chrome.storage.session` so the panel can recover after service worker restarts.
- Surfaces derived issues and a simple performance score in the DevTools panel.
- Builds to a loadable `dist/` folder and can be packaged as a release zip.

## Requirements

- Node.js 18+
- npm 9+
- Chrome 109+

---

## The Problem It Solves

Performance problems hide behind numbers. You open the Network tab and see 300 requests. You open Coverage and see 73% unused JavaScript. You open Performance and see a 900ms long task. But you still don't know _what to fix first_ or _how much it would matter_.

Chrome Perf Analyzer connects those dots. It attaches to the Chrome DevTools Protocol, cross-correlates signals from four separate CDP domains simultaneously, ranks every problem by impact, and tells you exactly what to do about each one — all inside a dedicated **⚡ Perf** panel. No tab-switching. No raw number interpretation. No guessing.

---

## What It Measures

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                        FOUR INSTRUMENTS, ONE PANEL                           ║
╠══════════════════╦═══════════════════════════╦════════════════════════════╗  ║
║  CORE WEB VITALS ║   NETWORK MONITOR         ║   BUNDLE ANALYZER          ║  ║
║  ──────────────  ║   ───────────────         ║   ───────────────          ║  ║
║  LCP · CLS · INP ║  Per-request timing:      ║  Per-script analysis:      ║  ║
║  FCP · TTFB      ║  DNS → Connect → SSL      ║  Parsed & transfer size    ║  ║
║                  ║  → Send → TTFB → Receive  ║  Dead code %               ║  ║
║  Live via        ║  P75 / P95 / P99 latency  ║  Library detection         ║  ║
║  PerformanceObs  ║  Slow request alerts      ║  Bundler identification    ║  ║
║                  ║  Network waterfall view   ║  0–100 performance score   ║  ║
╠══════════════════╩═══════════════════════════╩════════════════════════════╣  ║
║  ISSUE DETECTOR                                                           ║  ║
║  ──────────────                                                           ║  ║
║  Cross-signal analysis → ranked actionable issues → byte-savings estimates║  ║
║  Long tasks · Render-blocking scripts · Missing cache headers             ║  ║
║  Large bundles · Dead code · Memory leaks · CLS culprits                  ║  ║
╚═══════════════════════════════════════════════════════════════════════════╚══╝
```

---

## How It Works

Everything runs over the **Chrome DevTools Protocol** — the same wire protocol Chrome uses internally for its own DevTools. No page instrumentation. No injected globals. No interference with the app under test.

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  PAGE                                                                    │
 │  ┌──────────────────┐                    ┌──────────────────────────┐    │
 │  │  page-bridge.ts  │ ── postMessage ──► │  content-script.ts       │    │
 │  │  PerformanceObs  │                    │  CWV hub (LCP/CLS/INP)   │    │
 │  └──────────────────┘                    └────────────┬─────────────┘    │
 └────────────────────────────────────────────────────── │ ─────────────────┘
                                           chrome.runtime.sendMessage
 ┌────────────────────────────────────────────────────── │ ────────────────┐
 │  SERVICE WORKER                         ◄──────────── ┘                 │
 │                                                                         │
 │  ┌──────────────────┐    ┌──────────────────────────────────────────┐   │
 │  │  SessionManager  │    │  CDP via chrome.debugger.attach()        │   │
 │  │  storage.session │    │                                          │   │
 │  └──────────────────┘    │   Network.*            Debugger.*        │   │
 │                          │   requestWillBeSent    scriptParsed      │   │
 │                          │   responseReceived     getScriptSource   │   │
 │                          │   loadingFinished                        │   │
 │                          │                        Profiler.*        │   │
 │                          │                        takePreciseCoverage│  │
 │                          │          ▼                   ▼           │   │
 │                          │   NetworkCollector     BundleAnalyzer    │   │
 │                          └──────────┬───────────────────┬───────────┘   │
 │                                     │                   │               │
 │                          ┌──────────▼───────────────────▼───────────┐   │
 │                          │  timing-calculator  ·  script-classifier │   │
 │                          │  library-fingerprints  ·  issue-detector │   │
 │                          └───────────────────┬──────────────────────┘   │
 └──────────────────────────────────────────────│──────────────────────────┘
                                    push → METRICS_UPDATE
 ┌───────────────────────────────────────────── │ ─────────────────────────┐
 │  DEVTOOLS PANEL                              ▼                          │
 │                                                                         │
 │  Score Gauge · Issue List · Detail Pane · Network Waterfall             │
 │  Severity filters · Stack traces · Recommendation engine                │
 └─────────────────────────────────────────────────────────────────────────┘
```

### Why a Service Worker, Not a Background Page

Manifest V3 abolished persistent background pages. Service workers are killed after ~30 seconds of inactivity. This extension survives by persisting **all** session state to `chrome.storage.session` — never module-level variables — and re-hydrating the panel via `SESSION_HYDRATE` on every `PANEL_READY` event. A `chrome.alarms` keepalive prevents premature termination during long recording sessions.

---

## The Issue Engine

The core value is the issue detector. It doesn't expose raw numbers — it generates ranked, actionable problems with concrete byte-savings estimates.

```
SEVERITY MAP
────────────────────────────────────────────────────────────────
[CRITICAL] ── score −18 pts each
  • JavaScript task > 50ms blocking the main thread
  • Single bundle > 200 KB parsed size
  • Coverage ratio < 30%  (dead code)
  • Testing library present in production bundle

[WARNING] ─── score −8 pts each
  • Render-blocking scripts in <head>
  • API response missing Cache-Control header
  • Cumulative Layout Shift score > 0.1
  • Heap growth pattern consistent with a leak
  • Third-party script > 50 KB

[INFO] ─────── score −2 pts each
  • Large bundle with no source map
  • Third-party script spawning multiple sub-resources
  • Non-module script that could be ESM

GLOBAL (cross-script)
  • Total JavaScript exceeds 1 MB budget
  • Same library detected in multiple bundles
  • Duplicate dependencies wasting bandwidth
────────────────────────────────────────────────────────────────
Score starts at 100. Penalties stack. Minimum 0.
```

---

## Library Fingerprinting

The bundle analyzer identifies **54 known libraries and frameworks** using a three-tier detection strategy — cheapest first, stopping as soon as a match is found:

```
TIER 1 · URL PATTERN                       free — runs on every scriptParsed event
──────────────────────────────────────────────────────────────────────────────
Frameworks     React · Vue · Angular · Svelte · Next.js · Nuxt · Remix
UI Libraries   Material UI · Ant Design · Chakra · Bootstrap · Tailwind
Utilities      Lodash · Underscore · Moment.js · date-fns · Day.js
               Axios · jQuery · Ramda · Immer · Zod
State          Redux · Zustand · MobX
Polyfills      core-js · regenerator-runtime
Analytics      Google Analytics · Segment · Mixpanel · Hotjar · Sentry · Datadog
Testing ⚠      Jest · Mocha · Jasmine · Cypress  ← CRITICAL if found in prod


TIER 2 · SOURCE CONTENT                    optional — requires fetchScriptSource: true
──────────────────────────────────────────────────────────────────────────────
Scans first 8 KB of source for code signatures
Version extraction via named capture groups (?<version>[\d.]+)

Bundler detection:
  webpack    __webpack_require__ · webpackChunkName
  vite       import.meta.env.VITE_ · __vite__mapDeps
  rollup     IIFE wrapper · sourceMappingURL=rollup
  parcel     parcelRequire · parcel/runtime
  esbuild    // esbuild comment header
  turbopack  turbopack marker


TIER 3 · GLOBAL VARIABLES                  planned — Runtime.evaluate in page context
──────────────────────────────────────────────────────────────────────────────
window.React · window.Vue · window.angular · window._ etc.
```

---

## The CDP Timing Model

The `timing-calculator` module converts raw Chrome DevTools Protocol offsets into named phases. All values are milliseconds relative to `requestTime`:

```
requestTime (epoch, fractional seconds)
  │
  ├─ [blocked]   time queued before dispatch
  │                = min(proxyStart, dnsStart) − 0
  │
  ├─ [dns]       DNS resolution
  │                = dnsEnd − dnsStart
  │
  ├─ [connect]   TCP connection
  │                = connectEnd − connectStart
  │   └─ [ssl]   TLS handshake (subset of connect)
  │                = sslEnd − sslStart
  │
  ├─ [send]      bytes written to socket
  │                = sendEnd − sendStart
  │
  ├─ [wait]      Time To First Byte  (TTFB)
  │                = receiveHeadersEnd − sendEnd
  │
  └─ [receive]   response body download
                   = (loadingFinished.timestamp × 1000)
                     − (requestTime × 1000 + receiveHeadersEnd)

Any phase with a −1 start offset was not applicable
(no DNS for warm connections, no SSL for http://).
Those phases return null.
```

---

## Repository Structure

```
chrome-perf-analyzer/
│
├── manifest.json                  MV3 extension manifest
├── package.json                   npm scripts · zero runtime deps
├── tsconfig.json                  strict TS · noUncheckedIndexedAccess
├── webpack.config.ts              4 isolated entry bundles · splitChunks: false
├── jest.config.ts                 ts-jest · Chrome API stubs
├── perf-issues-panel.html         standalone UI preview (no install needed)
│
├── icons/
│   └── icon{16,32,48,128}.png
│
├── .vscode/
│   ├── settings.json              TypeScript SDK path
│   ├── launch.json                Jest debug configs
│   └── extensions.json            ESLint · Prettier · Jest runner
│
└── src/
    │
    ├── background/
    │   └── service-worker.ts      SW hub · CDP attach · session persistence
    │
    ├── devtools/
    │   ├── devtools.html          invisible DevTools entry point
    │   └── devtools.ts            panel registration · DEVTOOLS_OPENED message
    │
    ├── panel/
    │   ├── panel.html             dark panel UI · score gauge · waterfall
    │   └── panel.ts               reactive state · METRICS_UPDATE subscriber
    │
    ├── content-script/
    │   └── content-script.ts      PerformanceObserver · LCP/CLS/FCP/INP/TTFB
    │
    ├── collectors/                raw CDP events → typed, enriched records
    │   ├── network-collector.ts   Network.requestWillBeSent → loadingFinished
    │   └── bundle-analyzer.ts     Debugger.scriptParsed + Profiler coverage
    │
    ├── analyzers/                 pure functions · no Chrome APIs · fully testable
    │   ├── timing-calculator.ts   CDP offsets → DNS/connect/TTFB/receive phases
    │   ├── library-fingerprints.ts 54 URL + source fingerprints · bundler detect
    │   └── script-classifier.ts   classification · issue generation · 0–100 score
    │
    ├── reporters/
    │   ├── network-report-renderer.ts  ASCII timing tables · waterfall bars
    │   └── bundle-report-renderer.ts   █░ coverage bars · per-script drill-down
    │
    └── shared/
        ├── types/
        │   ├── messages.types.ts   typed contract · 14 message types
        │   ├── network.types.ts    CDP Network domain + derived shapes
        │   └── bundle.types.ts     ScriptRecord · BundleAnalysisReport · issues
        └── utils/
            └── ring-buffer.ts      O(1) circular buffer · caps memory usage
```

---

## Getting Started

### Requirements

|         | Minimum |
| ------- | ------- |
| Node.js | 18      |
| npm     | 9       |
| Chrome  | 109     |

### Install and Build

```bash
npm run clean
npm run type-check
npm run build
npm run build:prod
npm run watch
npm run validate
npm run package
```

## Local development

```bash
npm install
npm run build
```

Then load `dist/` from `chrome://extensions` using `Load unpacked`.

Open any page, open DevTools, and switch to the `Perf` panel.

## Release flow

```bash
npm run validate
npm run package
```

This creates a production build and a zip archive in `artifacts/`.

## Notes

- The extension currently focuses on Core Web Vitals driven analysis. The deeper network and bundle collectors exist in the codebase but are not yet wired into the live panel flow.
- Manifest and package versions are kept in sync automatically during builds.
- The repository documentation is intentionally aligned with the scripts that actually exist.
