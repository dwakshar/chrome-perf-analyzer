import CopyPlugin from "copy-webpack-plugin";
import path from "path";
import { fileURLToPath } from "url"; // ← add this
import type { Configuration } from "webpack";

// ← Replace __dirname with this
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config: Configuration = {
  mode: "development",
  devtool: "cheap-module-source-map",

  // ── Entry points ────────────────────────────────────────────────────────────
  // Each Chrome extension context needs its own bundle.
  entry: {
    "background/service-worker": "./src/background/service-worker.ts",
    "devtools/devtools": "./src/devtools/devtools.ts",
    "panel/panel": "./src/panel/panel.ts",
    "content-script/content-script": "./src/content-script/content-script.ts",
  },

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].js",
    // MV3 service workers must NOT use chunk splitting.
    chunkFilename: "[name].[contenthash].chunk.js",
    clean: true,
  },

  // ── Module resolution ───────────────────────────────────────────────────────
  resolve: {
    extensions: [".ts", ".js"],
  },

  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: "ts-loader",
          options: { transpileOnly: true },
        },
        exclude: /node_modules/,
      },
    ],
  },

  // ── Optimisation ────────────────────────────────────────────────────────────
  optimization: {
    // Keep each entry fully self-contained — required for the service worker.
    splitChunks: false,
    runtimeChunk: false,
  },

  // ── Static assets ───────────────────────────────────────────────────────────
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json", to: "." },
        { from: "src/devtools/devtools.html", to: "devtools/" },
        { from: "src/panel/panel.html", to: "panel/" },
        { from: "icons", to: "icons" },
      ],
    }),
  ],
};

export default config;
