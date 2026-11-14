// macOS driver: screencapture + Vision OCR + CGEvent input, via the small
// Swift helpers compiled on first use. Requires Screen Recording (capture) and
// Accessibility (input) for the *perch* binary — not for your terminal.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Driver, OcrBox } from "./driver.js";

const RUN = (bin: string, args: string[], timeout = 20_000) =>
  new Promise<{ out: string; err: string; code: number }>((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ out: String(stdout), err: String(stderr), code: err ? 1 : 0 })
    );
  });

const helperDir = () => path.join(config.dataDir, "helpers");

const SWIFT: Record<string, string> = {
  // One helper for every input primitive: `input <verb> ...`
  input: String.raw`
import CoreGraphics
import Foundation
import AppKit

func post(_ e: CGEvent) { e.post(tap: .cghidEventTap) }
let a = Array(CommandLine.arguments.dropFirst())
func num(_ i: Int) -> Double { Double(a[i]) ?? 0 }

switch a.first ?? "" {
case "windows":
  let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
  let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
  let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list {
    guard (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { continue }
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? -1
    let title = w[kCGWindowName as String] as? String ?? ""
    if owner.isEmpty { continue }
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let x = (b["X"] as? NSNumber)?.doubleValue ?? 0, y = (b["Y"] as? NSNumber)?.doubleValue ?? 0
    let wd = (b["Width"] as? NSNumber)?.doubleValue ?? 0, ht = (b["Height"] as? NSNumber)?.doubleValue ?? 0
    if wd < 80 || ht < 60 { continue }
    print("\(owner)\t\(title)\t\(Int(x))\t\(Int(y))\t\(Int(wd))\t\(Int(ht))\t\(pid == frontPid ? 1 : 0)")
  }
case "activate":
  let wanted = a.count > 1 ? a[1] : ""
  let apps = NSWorkspace.shared.runningApplications.filter {
    ($0.localizedName ?? "").caseInsensitiveCompare(wanted) == .orderedSame
      || ($0.bundleURL?.lastPathComponent ?? "").lowercased().hasPrefix(wanted.lowercased())
  }
  guard let app = apps.first else {
    FileHandle.standardError.write(Data("no such app\n".utf8)); exit(3)
  }
  app.activate(options: [.activateAllWindows])
  // wait until it is actually frontmost
  for _ in 0..<30 {
    usleep(100_000)
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { break }
  }
  if NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
    FileHandle.standardError.write(Data("activate did not take\n".utf8)); exit(4)
  }
case "move":
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: num(1), y: num(2)), mouseButton: .left)!)
case "click":
  let p = CGPoint(x: num(1), y: num(2))
  let button: CGMouseButton = (a.count > 4 && a[4] == "right") ? .right : .left
  let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!)
  usleep(40_000)
  let clicks = a.count > 3 ? Int(a[3]) ?? 1 : 1
  for n in 1...max(1, clicks) {
    let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: button)!
    d.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    post(d)
    usleep(20_000)
    let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: button)!
    u.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    post(u)
    usleep(20_000)
  }
case "drag":
  let from = CGPoint(x: num(1), y: num(2)), to = CGPoint(x: num(3), y: num(4))
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)!)
  for i in 1...14 {
    let t = Double(i) / 14.0
    let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)!)
    usleep(12_000)
  }
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)!)
case "scroll":
  post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(num(1)), wheel2: 0, wheel3: 0)!)
case "type":
  let text = a.dropFirst().joined(separator: " ")
  for ch in text.utf16 {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
    var c = ch
    down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
    post(down)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)!
    up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
    post(up)
    usleep(3_000)
  }
case "key":
  // chord like cmd+shift+t
  let parts = (a.count > 1 ? a[1] : "").split(separator: "+").map { String($0).lowercased() }
  var flags: CGEventFlags = []
  var vk: CGKeyCode? = nil
  let map: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "esc": 53, "escape": 53, "space": 49,
    "up": 126, "down": 125, "left": 123, "right": 124, "backspace": 51, "delete": 51,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37,
    "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13,
    "x": 7, "y": 16, "z": 6, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28,
    "9": 25, "0": 29, "-": 27, "=": 24, "[": 33, "]": 30, "": 42, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44]
  for p in parts {
    switch p {
    case "cmd", "command", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: vk = map[p]
    }
  }
  if let v = vk {
    let d = CGEvent(keyboardEventSource: nil, virtualKey: v, keyDown: true)!
    d.flags = flags
    post(d)
    usleep(12_000)
    let u = CGEvent(keyboardEventSource: nil, virtualKey: v, keyDown: false)!
    u.flags = flags
    post(u)
  }
default:
  FileHandle.standardError.write(Data("unknown verb\n".utf8))
  exit(2)
}
exit(0)
`,
  // Vision OCR: prints TSV of "x\ty\tw\th\ttext" in screen points.
  ocr: String.raw`
import Foundation
import Vision
import AppKit

let a = CommandLine.arguments
guard a.count >= 5,
      let src = CGImageSourceCreateImageAtIndex(
        CGImageSourceCreateWithData(Data(base64Encoded: a[1])! as CFData, nil)!, 0, nil)
else { exit(1) }
let ox = Double(a[2]) ?? 0, oy = Double(a[3]) ?? 0, scale = Double(a[4]) ?? 1
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: src, options: [:]).perform([req])
for obs in req.results ?? [] {
  guard let c = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  let x = ox + b.origin.x * Double(src.width) * scale
  let y = oy + (1 - b.origin.y - b.height) * Double(src.height) * scale
  print("\(Int(x))\t\(Int(y))\t\(Int(b.width * Double(src.width) * scale))\t\(Int(b.height * Double(src.height) * scale))\t\(c.string)")
}
`,
};

async function helper(name: "input" | "ocr"): Promise<string> {
  const dir = helperDir();
  const bin = path.join(dir, name);
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${name}.swift`);
  writeFileSync(src, SWIFT[name]);
  const res = await RUN("/usr/bin/swiftc", ["-O", src, "-o", bin], 180_000);
  if (res.code !== 0) throw new Error(`helper build failed: ${res.err.slice(0, 400)}`);
  // Helpers take screen-control permissions; keep them out of Gatekeeper's way.
  await RUN("/usr/bin/xattr", ["-c", bin]);
  return bin;
}

async function run(name: "input" | "ocr", args: string[], timeout?: number) {
  const bin = await helper(name);
  return RUN(bin, args, timeout);
}

export async function buildHelper(name: "input" | "ocr"): Promise<string> {
  return helper(name);
}

export const notes = [
  "Grant Screen Recording to the perch binary (System Settings → Privacy & Security → Screen Recording).",
  "Grant Accessibility to the perch binary (… → Accessibility) for clicks and keystrokes.",
  "Restart the agent after granting; macOS only applies these to new processes.",
];

export function available(): boolean {
  return process.platform === "darwin";
}

export const driver: Driver = {
  async capture(opts) {
    const args = ["-x", "-t", "jpg"];
    if (opts?.x != null && opts?.y != null && opts?.w && opts?.h) {
      args.push("-R", `${opts.x},${opts.y},${opts.w},${opts.h}`);
    }
    const out = path.join(config.dataDir, "tmp-shot.jpg");
    const res = await RUN("/usr/sbin/screencapture", [...args, out]);
    if (res.code !== 0) throw new Error(`capture failed: ${res.err.slice(0, 200)}`);
    const { readFileSync } = await import("node:fs");
    let jpeg = readFileSync(out);
    // downscale longest edge to <=1600 px via sips, keeping the scale factor
    const dims = await RUN("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]);
    const w = Number(/pixelWidth: (\d+)/.exec(dims.out)?.[1] ?? 0);
    const h = Number(/pixelHeight: (\d+)/.exec(dims.out)?.[1] ?? 0);
    const longest = Math.max(w, h);
    let scale = 2; // retina assumption before we know better
    if (longest > 1600) {
      const target = 1600;
      await RUN("/usr/bin/sips", ["-Z", String(target), out]);
      scale = w / target;
      jpeg = readFileSync(out);
    }
    return { jpeg, width: Math.round(w / scale), height: Math.round(h / scale), scale };
  },

  async windows() {
    const res = await run("input", ["windows"], 10_000);
    return res.out
      .split("\n")
      .filter(Boolean)
      .map((line, i) => {
        const [app, title, x, y, w, h, focused] = line.split("\t");
        return { id: String(i), app, title: title ?? "", bounds: { x: +x, y: +y, w: +w, h: +h }, focused: focused === "1" };
      });
  },

  async activate(appName) {
    // `open -a` also launches a not-yet-running app; the helper raises it.
    await RUN("/usr/bin/open", ["-a", appName]);
    const res = await run("input", ["activate", appName], 12_000);
    if (res.code !== 0) throw new Error(res.err.trim() || `could not activate ${appName}`);
  },

  async click({ x, y, button = "left", clicks = 1 }) {
    await run("input", ["click", String(x), String(y), String(clicks), button]);
  },

  async move({ x, y }) {
    await run("input", ["move", String(x), String(y)]);
  },

  async scroll({ dy }) {
    await run("input", ["scroll", String(Math.round(dy))]);
  },

  async drag({ from, to }) {
    await run("input", ["drag", String(from.x), String(from.y), String(to.x), String(to.y)], 30_000);
  },

  async type(text) {
    await run("input", ["type", text], 60_000);
  },

  async key(chord) {
    await run("input", ["key", chord]);
  },

  async clipboardRead() {
    const res = await RUN("/usr/bin/pbpaste", []);
    return res.out;
  },

  async clipboardWrite(text) {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const p = spawn("/usr/bin/pbcopy");
      p.on("close", () => resolve());
      p.stdin.write(text);
      p.stdin.end();
    });
  },

  async openUrl(url) {
    await RUN("/usr/bin/open", [url]);
  },

  async ocr(region) {
    const cap = await this.capture(region);
    const res = await run("ocr", [cap.jpeg.toString("base64"), String(region.x), String(region.y), String(cap.scale)], 30_000);
    return res.out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [x, y, w, h, ...text] = line.split("\t");
        return { x: +x, y: +y, w: +w, h: +h, text: text.join("\t") } satisfies OcrBox;
      });
  },

  async waitForText(needle, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const lowered = needle.toLowerCase();
    while (Date.now() < deadline) {
      const boxes = await this.ocr({ x: 0, y: 0, w: 9999, h: 9999 });
      if (boxes.some((b) => b.text.toLowerCase().includes(lowered))) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  },
};
