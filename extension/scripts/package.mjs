// Builds the release daemon for each platform into bin/<platform>-<arch>/
// and produces a .vsix that works for everyone.
//
//   win32-x64   native cargo build (when packaging on Windows)
//   linux-x64   static musl binary built in Docker (runs on any distro)
//
// Set MLS_SKIP_LINUX=1 to skip the Docker build.

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ext = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(ext, "..");
const bin = path.join(ext, "bin");

fs.rmSync(bin, { recursive: true, force: true });

function place(platform, file, name) {
  const dir = path.join(bin, platform);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, name));
  console.log(`bundled ${platform}/${name} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
}

// Native build for this machine.
execSync("cargo build --release -p mls", { cwd: repo, stdio: "inherit" });
const exe = process.platform === "win32" ? "mls.exe" : "mls";
place(`${process.platform}-${process.arch}`, path.join(repo, "target", "release", exe), exe);

// Static Linux build in Docker.
if (!(process.platform === "linux" && process.arch === "x64") && !process.env.MLS_SKIP_LINUX) {
  try {
    execFileSync(
      "docker",
      [
        "run", "--rm",
        "-v", `${repo}:/src`,
        "-v", "mls-cargo-registry:/usr/local/cargo/registry",
        "-w", "/src",
        "rust:1-alpine",
        "sh", "-c",
        "apk add --no-cache musl-dev gcc >/dev/null && cargo build --release --locked -p mls --target-dir /src/target/linux-musl",
      ],
      { stdio: "inherit" },
    );
    place("linux-x64", path.join(repo, "target", "linux-musl", "release", "mls"), "mls");
  } catch (e) {
    console.warn(`\n!! Skipping linux-x64: Docker build failed (${e.message.split("\n")[0]}). Linux users won't be able to use this .vsix.\n`);
  }
}

// vsce wants the license next to package.json; the canonical copy is at the repo root.
fs.copyFileSync(path.join(repo, "LICENSE"), path.join(ext, "LICENSE"));

execSync("npx --yes @vscode/vsce package -o ferroshare.vsix", { cwd: ext, stdio: "inherit" });
