// Prepares the binaries Tauri bundles next to the app (bundle.externalBin in
// src-tauri/tauri.conf.json): the native screencup-overlay, built in release, and ffmpeg.
// Tauri wants them as src-tauri/binaries/<name>-<target triple><ext>.
//
// ffmpeg comes from $SCREENCUP_FFMPEG, else the first one on PATH. Mind its licence: a GPL
// build (e.g. with libx264) must be distributed under the GPL's terms; an LGPL build works
// too, the recorder then falls back to the platform H.264 encoder.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = process.platform === "win32" ? ".exe" : "";
const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)$/m)?.[1];
if (!triple) throw new Error("cannot read the host target triple from `rustc -vV`");
const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

const install = (from, name) => {
  const to = join(outDir, `${name}-${triple}${ext}`);
  copyFileSync(from, to);
  console.log(`${name}: ${from} -> ${to} (${(statSync(to).size / 1e6).toFixed(1)} MB)`);
};

execFileSync("cargo", ["build", "--release", "-p", "screencup-overlay"], { cwd: root, stdio: "inherit" });
install(join(root, "target", "release", `screencup-overlay${ext}`), "screencup-overlay");

const ffmpeg =
  process.env.SCREENCUP_FFMPEG ??
  (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, `ffmpeg${ext}`))
    .find((p) => existsSync(p));
if (!ffmpeg) throw new Error("ffmpeg not found: set SCREENCUP_FFMPEG or put ffmpeg on PATH");
install(ffmpeg, "ffmpeg");
