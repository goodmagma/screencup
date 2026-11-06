// Writes src-tauri/binaries/licenses/THIRD-PARTY-LICENSES.txt: the licence texts of every
// third-party library compiled into the shipped programs, which the installer bundles
// (bundle.resources in src-tauri/tauri.conf.json).
//
// Rust: the crates reachable through normal (non-dev, non-build) dependencies of the workspace
// members, for the host target, read with `cargo metadata`. JavaScript: the packages reachable
// from package.json "dependencies" (what Vite bundles), read from node_modules.
// The licence files come from each package's own sources. When a package ships none, the
// output names its licence expression and repository.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;

/** Licence-like files at the top of a package directory, as [file name, text]. */
function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => [e.name, readFileSync(join(dir, e.name), "utf8").trim()]);
}

function rustPackages() {
  const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)$/m)[1];
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--filter-platform", triple], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(meta.workspace_members);
  const seen = new Set();
  const queue = [...members];
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      // dep_kinds kind null = normal dependency; "dev" and "build" ones never ship.
      if (dep.dep_kinds.some((k) => k.kind === null)) queue.push(dep.pkg);
    }
  }
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => byId.get(id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? `see ${p.license_file}` : "unknown"),
      repository: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
      files: licenseFiles(dirname(p.manifest_path)),
    }));
}

function npmPackages() {
  const seen = new Map();
  const visit = (name, fromDir) => {
    // Node resolution: the nearest node_modules/<name> walking up from the requiring package.
    let dir = fromDir;
    let pkgDir;
    for (;;) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) {
        pkgDir = candidate;
        break;
      }
      const up = dirname(dir);
      if (up === dir) return;
      dir = up;
    }
    if (seen.has(pkgDir)) return;
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    seen.set(pkgDir, {
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "unknown",
      repository: repo ?? pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`,
      files: licenseFiles(pkgDir),
    });
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, pkgDir);
  };
  const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const dep of Object.keys(own.dependencies ?? {})) visit(dep, root);
  return [...seen.values()];
}

const RULE = "=".repeat(78);
/** Identical texts (the Apache-2.0 one recurs hundreds of times) are printed once. */
const printed = new Map();

function section(title, packages) {
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const out = [`${RULE}\n${title} (${packages.length})\n${RULE}\n`];
  for (const p of packages) {
    out.push(`\n${"-".repeat(78)}\n${p.name} ${p.version}\nLicence: ${p.license}\nSource: ${p.repository}\n`);
    if (p.files.length === 0) out.push("\n(The package ships no licence file; see its source repository.)\n");
    for (const [file, text] of p.files) {
      const first = printed.get(text);
      if (first) out.push(`\n--- ${file} ---\n\n(Same text as ${first} above.)\n`);
      else {
        printed.set(text, `${file} of ${p.name} ${p.version}`);
        out.push(`\n--- ${file} ---\n\n${text}\n`);
      }
    }
  }
  return { text: out.join(""), missing: packages.filter((p) => p.files.length === 0).map((p) => p.name) };
}

const rust = section("Rust crates", rustPackages());
const js = section("JavaScript packages", npmPackages());
const header =
  "Screencup includes the third-party software listed below. Each component is used under\n" +
  "its own licence, reproduced here. ffmpeg, a separate program bundled with Screencup, is\n" +
  "covered in licenses/ffmpeg/ and THIRD-PARTY-NOTICES.md.\n\n";

const outDir = join(root, "src-tauri", "binaries", "licenses");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "THIRD-PARTY-LICENSES.txt");
writeFileSync(outFile, header + rust.text + "\n" + js.text);
console.log(`licenses: ${outFile}`);
const missing = [...rust.missing, ...js.missing];
if (missing.length) console.warn(`licenses: no licence file in ${missing.length} package(s): ${missing.join(", ")}`);
