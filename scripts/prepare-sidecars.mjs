// Prepares the binaries Tauri bundles next to the app (bundle.externalBin in
// src-tauri/tauri.conf.json): the native screencup-overlay, built in release, and ffmpeg.
// Tauri wants them as src-tauri/binaries/<name>-<target triple><ext>.
//
// ffmpeg comes from $SCREENCUP_FFMPEG, else the first one on PATH. Mind its licence: a GPL
// build (e.g. with libx264) must be distributed under the GPL's terms; an LGPL build works
// too, the recorder then falls back to the platform H.264 encoder.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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

// The installer ships ffmpeg's licence and build details (bundle.resources): the GPL asks
// for its text and a pointer to the matching source. Release builds such as gyan.dev's keep
// LICENSE and README.txt (with the source commit) one folder above bin/.
const licenses = join(outDir, "licenses", "ffmpeg");
mkdirSync(licenses, { recursive: true });
writeFileSync(join(licenses, "BUILD.txt"), execFileSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8" }));
for (const [file, as] of [["LICENSE", "LICENSE.txt"], ["LICENSE.txt", "LICENSE.txt"], ["README.txt", "README.txt"]]) {
  const from = join(dirname(ffmpeg), "..", file);
  if (existsSync(from)) copyFileSync(from, join(licenses, as));
}
if (!existsSync(join(licenses, "LICENSE.txt"))) {
  console.warn("ffmpeg: no LICENSE next to the binary; add its licence text to " + licenses);
}
