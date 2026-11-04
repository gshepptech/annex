// Builds Annex.app: the Swift window (app/main.swift) plus everything the server needs to run on a
// Mac with nothing installed but Claude Code. Contents/Resources carries the official Node binary,
// Annex's server and built page, and the pinned Paperclip engine. On first launch the app installs
// its own login service from them.
//   node scripts/app.ts build     → .annex/app/Annex.app
//   node scripts/app.ts dmg       → builds, then .annex/app/Annex.dmg to hand to another Mac
//   node scripts/app.ts install   → builds, then copies it to /Applications (or ~/Applications)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The Node release the bundle carries: the one this project runs on, from nodejs.org, checked
// against the checksum nodejs.org publishes for it.
const NODE_VERSION = "v26.10.0";
const NODE_SHA256 = "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9";
// Paperclip's packages Annex never runs: the Codex adapter's 311 MB binary (Annex agents run claude)
const PRUNE = ["@openai/codex-darwin-arm64"];

const root = join(import.meta.dirname, "..");
const out = join(root, ".annex", "app");
const bundle = join(out, "Annex.app");
const version = "1.0";

// Prefer full Xcode's toolchain when it is there: a Command Line Tools install can carry a stale
// module map that stops Swift from building anything that imports Cocoa.
const xcode = "/Applications/Xcode.app/Contents/Developer";
const env = existsSync(xcode) ? { ...process.env, DEVELOPER_DIR: xcode } : process.env;
const run = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { stdio: "inherit", env, cwd });

function nodeBinary(): string {
  const cache = join(out, "cache");
  const name = `node-${NODE_VERSION}-darwin-arm64`;
  const tarball = join(cache, `${name}.tar.gz`);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(tarball)) run("curl", ["-fL", "-o", tarball, `https://nodejs.org/dist/${NODE_VERSION}/${name}.tar.gz`]);
  const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (sum !== NODE_SHA256) {
    rmSync(tarball);
    throw new Error(`${name}.tar.gz does not match nodejs.org's checksum (got ${sum})`);
  }
  if (!existsSync(join(cache, name))) run("tar", ["-xzf", tarball, "-C", cache]);
  return join(cache, name, "bin", "node");
}

// The server, its two runtime packages, the built page and the engine, laid out as a checkout
// would be so the same scripts run from either.
function server(dest: string) {
  run("npx", ["vite", "build", "web"]);
  const keep = (src: string) => !/\.test\.ts$|\/fixtures(\/|$)/.test(src);
  cpSync(join(root, "server"), join(dest, "server"), { recursive: true, filter: keep });
  mkdirSync(join(dest, "scripts"));
  for (const f of ["up.ts", "service.ts"]) cpSync(join(root, "scripts", f), join(dest, "scripts", f));
  cpSync(join(root, "web", "dist"), join(dest, "web", "dist"), { recursive: true });
  cpSync(join(root, "package.json"), join(dest, "package.json"));
  for (const pkg of ["smol-toml", "node-addon-api"]) cpSync(join(root, "node_modules", pkg), join(dest, "node_modules", pkg), { recursive: true });
  // node-pty ships sources and other platforms' prebuilds; this Mac's prebuild is all it loads
  const ptySrc = join(root, "node_modules", "node-pty");
  const pty = join(dest, "node_modules", "node-pty");
  cpSync(ptySrc, pty, {
    recursive: true,
    filter: (src) => !/^\/(prebuilds\/(?!darwin-arm64)|src|deps|third_party|scripts|binding\.gyp)/.test(src.slice(ptySrc.length)),
  });
  chmodSync(join(pty, "prebuilds", "darwin-arm64", "spawn-helper"), 0o755);
  if (!existsSync(join(root, "runtime", "node_modules", "paperclipai"))) run("npm", ["install", "--no-fund", "--no-audit"], join(root, "runtime"));
  cpSync(join(root, "runtime"), join(dest, "runtime"), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !PRUNE.some((p) => src.includes(`/node_modules/${p}`)),
  });
}

function build() {
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  const resources = join(bundle, "Contents", "Resources");
  mkdirSync(join(resources, "node", "bin"), { recursive: true });
  cpSync(nodeBinary(), join(resources, "node", "bin", "node"));
  server(join(resources, "annex"));
  run("xcrun", ["swiftc", "-O", "-swift-version", "5", "-o", join(bundle, "Contents", "MacOS", "Annex"), join(root, "app", "main.swift")]);

  const png = join(out, "icon.png");
  const iconset = join(out, "AppIcon.iconset");
  run("xcrun", ["swift", join(root, "app", "icon.swift"), png]);
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync("sips", ["-z", String(s), String(s), png, "--out", join(iconset, `icon_${s}x${s}.png`)], { stdio: "ignore" });
    execFileSync("sips", ["-z", String(s * 2), String(s * 2), png, "--out", join(iconset, `icon_${s}x${s}@2x.png`)], { stdio: "ignore" });
  }
  run("iconutil", ["-c", "icns", iconset, "-o", join(bundle, "Contents", "Resources", "AppIcon.icns")]);

  writeFileSync(join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.annex.app</string>
  <key>CFBundleName</key><string>Annex</string>
  <key>CFBundleDisplayName</key><string>Annex</string>
  <key>CFBundleExecutable</key><string>Annex</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
`);
  // Signed for this Mac only (ad hoc). Another Mac's Gatekeeper refuses an app downloaded from the
  // internet unless it is signed with a Developer ID and notarized; see README.
  run("codesign", ["--force", "--sign", "-", bundle]);
  const size = execFileSync("du", ["-sh", bundle], { encoding: "utf8" }).split("\t")[0];
  console.log(`Built ${bundle} (${size})`);
}

// /Applications when this user can write there, otherwise ~/Applications
function appsFolder(): string {
  try {
    accessSync("/Applications", constants.W_OK);
    return "/Applications";
  } catch {
    const mine = join(homedir(), "Applications");
    mkdirSync(mine, { recursive: true });
    return mine;
  }
}

const cmd = process.argv[2];
if (cmd === "build" || cmd === "install" || cmd === "dmg") build();
if (cmd === "dmg") {
  const stage = join(out, "dmg");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  run("ditto", [bundle, join(stage, "Annex.app")]);
  symlinkSync("/Applications", join(stage, "Applications"));
  const dmg = join(out, "Annex.dmg");
  run("hdiutil", ["create", "-volname", "Annex", "-srcfolder", stage, "-format", "UDZO", "-ov", dmg]);
  rmSync(stage, { recursive: true, force: true });
  console.log(`Made ${dmg}`);
}
if (cmd === "install") {
  const dest = join(appsFolder(), "Annex.app");
  if (existsSync(dest)) execFileSync("osascript", ["-e", 'tell application id "dev.annex.app" to quit'], { stdio: "ignore" });
  rmSync(dest, { recursive: true, force: true });
  run("ditto", [bundle, dest]);
  console.log(`Installed ${dest}. Open it from Launchpad, Spotlight or the Dock.`);
  run("open", [dest]);
}
if (cmd !== "build" && cmd !== "install" && cmd !== "dmg") {
  console.error("Usage: node scripts/app.ts build|dmg|install");
  process.exit(1);
}
