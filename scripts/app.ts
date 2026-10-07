// Builds Annex.app from app/main.swift with the Swift compiler in Apple's command line tools (no
// Xcode needed), and installs it. The app only shows Annex; the server is the login service.
//   node scripts/app.ts build     → .annex/app/Annex.app
//   node scripts/app.ts install   → builds, then copies it to /Applications (or ~/Applications)

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, ".annex", "app");
const bundle = join(out, "Annex.app");
const version = "1.0";

// Prefer full Xcode's toolchain when it is there: a Command Line Tools install can carry a stale
// module map that stops Swift from building anything that imports Cocoa.
const xcode = "/Applications/Xcode.app/Contents/Developer";
const env = existsSync(xcode) ? { ...process.env, DEVELOPER_DIR: xcode } : process.env;
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "inherit", env });

function build() {
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
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
  // signed for this Mac only; enough for notifications and for Gatekeeper on the machine that built it
  run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
  console.log(`Built ${bundle}`);
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
if (cmd === "build" || cmd === "install") build();
if (cmd === "install") {
  const dest = join(appsFolder(), "Annex.app");
  if (existsSync(dest)) execFileSync("osascript", ["-e", 'tell application id "dev.annex.app" to quit'], { stdio: "ignore" });
  rmSync(dest, { recursive: true, force: true });
  run("ditto", [bundle, dest]);
  console.log(`Installed ${dest}. Open it from Launchpad, Spotlight or the Dock.`);
  run("open", [dest]);
}
if (cmd !== "build" && cmd !== "install") {
  console.error("Usage: node scripts/app.ts build|install");
  process.exit(1);
}
