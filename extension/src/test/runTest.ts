// Integration tests in a real VS Code (downloaded into .vscode-test/).
//   1. Host run:  VS Code hosts via the real `mls.host` command; a real guest daemon joins.
//   2. Guest run: VS Code is a guest window on mls://<session>/ against a real host daemon.
// Usage: npm run test:vscode

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";
import { DaemonClient, findDaemon, spawnDaemon } from "../daemon.ts";
import { FakeHost } from "./fakeHost.ts";

const extensionDevelopmentPath = path.resolve(import.meta.dirname, "..", "..");
const repo = path.resolve(extensionDevelopmentPath, "..");
const vscodeExecutablePath = process.env.MLS_VSCODE_EXE || undefined;
const baseArgs = ["--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"];

/** Fixture workspace (TypeScript, so VS Code's built-in TS support plays "the host's IntelliSense"). */
function fixture(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mls-ws-"));
  fs.mkdirSync(path.join(ws, "src"));
  fs.writeFileSync(
    path.join(ws, "src", "util.ts"),
    "/** Adds two numbers together. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport class Counter {\n  count = 0;\n  increment(): void {\n    this.count++;\n  }\n}\n",
  );
  fs.writeFileSync(path.join(ws, "src", "main.ts"), 'import { add, Counter } from "./util";\n\nconst c = new Counter();\nc.increment();\nconsole.log(add(1, 2));\n');
  fs.writeFileSync(path.join(ws, "tsconfig.json"), '{ "compilerOptions": { "strict": true, "target": "ES2022" } }\n');
  return ws;
}

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function hostRun(): Promise<void> {
  const ws = fixture();
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath: path.join(extensionDevelopmentPath, "out", "test", "suite.js"),
    extensionTestsEnv: { MLS_TEST_WORKSPACE: ws },
    launchArgs: [ws, ...baseArgs, "--user-data-dir", tmp("mls-user-")],
  });
}

async function guestRun(): Promise<void> {
  const ws = fixture();
  const port = await freePort();
  const relayExe = path.join(repo, "target", "debug", process.platform === "win32" ? "mls-relay.exe" : "mls-relay");
  const relay = spawn(relayExe, ["--listen", `127.0.0.1:${port}`], { stdio: "ignore" });
  const logs = tmp("mls-logs-");
  try {
    await new Promise((r) => setTimeout(r, 300));
    const exe = findDaemon(extensionDevelopmentPath, "");
    const host = await spawnDaemon(exe, ["host", "--relay", `ws://127.0.0.1:${port}`, "--root", ws, "--name", "host"], path.join(logs, "host.log"));
    const hostClient = await DaemonClient.connect(host.port, host.token);
    new FakeHost(hostClient, ws);
    const guest = await spawnDaemon(exe, ["join", host.invite, "--name", "guest"], path.join(logs, "guest.log"));
    // `--folder-uri mls://…` makes VS Code's test mode exit immediately; a
    // workspace file pointing at the mls: folder opens the same window.
    const workspaceFile = path.join(logs, "guest.code-workspace");
    fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ uri: `mls://${host.session}/` }] }));
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath: path.join(extensionDevelopmentPath, "out", "test", "suiteGuest.js"),
      extensionTestsEnv: { MLS_TEST_WORKSPACE: ws, MLS_TEST_ATTACH: JSON.stringify({ port: guest.port, token: guest.token }) },
      launchArgs: [workspaceFile, ...baseArgs, "--user-data-dir", tmp("mls-user-")],
    });
    hostClient.send({ t: "leave" });
    hostClient.close();
  } finally {
    relay.kill();
  }
}

try {
  if (!process.env.MLS_SKIP_HOST) await hostRun();
  console.log("HOST INTEGRATION TESTS PASSED");
  await guestRun();
  console.log("GUEST INTEGRATION TESTS PASSED");
} catch (e) {
  console.error("INTEGRATION TESTS FAILED", e);
  process.exitCode = 1;
}
