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
// for its text and a pointer to the matching source. gyan.dev's Windows builds keep LICENSE and
// README.txt (with the source commit) one folder above bin/; other builds keep them next to the
// binary, or ship none, in which case a GPL build gets the GPL text kept in scripts/licenses.
const licenses = join(outDir, "licenses", "ffmpeg");
mkdirSync(licenses, { recursive: true });
const build = execFileSync(ffmpeg, ["-hide_banner", "-version"], { encoding: "utf8" });
writeFileSync(join(licenses, "BUILD.txt"), build);
const names = [
  ["LICENSE", "LICENSE.txt"],
  ["LICENSE.txt", "LICENSE.txt"],
  ["GPLv3.txt", "LICENSE.txt"],
  ["README.txt", "README.txt"],
  ["readme.txt", "README.txt"],
];
for (const dir of [join(dirname(ffmpeg), ".."), dirname(ffmpeg)]) {
  for (const [file, as] of names) {
    const from = join(dir, file);
    if (existsSync(from) && !existsSync(join(licenses, as))) copyFileSync(from, join(licenses, as));
  }
}
if (!existsSync(join(licenses, "LICENSE.txt"))) {
  if (build.includes("--enable-gpl")) {
    copyFileSync(join(root, "scripts", "licenses", "GPL-3.0.txt"), join(licenses, "LICENSE.txt"));
    console.log("ffmpeg: no licence file next to the binary; using the GPL-3.0 text");
  } else {
    console.warn("ffmpeg: no LICENSE next to the binary; add its licence text to " + licenses);
  }
}
