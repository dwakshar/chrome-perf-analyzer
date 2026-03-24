import CopyPlugin from "copy-webpack-plugin";
import path from "path";
import { fileURLToPath } from "url";
import type { Configuration } from "webpack";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default (
  _env: unknown,
  argv: { mode?: "development" | "production" }
): Configuration => {
  const isProduction = argv.mode === "production";

  return {
    mode: isProduction ? "production" : "development",
    devtool: isProduction ? false : "cheap-module-source-map",
    entry: {
      "background/service-worker": "./src/background/service-worker.ts",
      "devtools/devtools": "./src/devtools/devtools.ts",
      "panel/panel": "./src/panel/panel.ts",
      "content-script/content-script": "./src/content-script/content-script.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      chunkFilename: "[name].[contenthash].chunk.js",
      clean: true,
    },
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
    optimization: {
      splitChunks: false,
      runtimeChunk: false,
    },
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
};
