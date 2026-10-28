import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { NAME, ENV, VERSION, ORIGIN } from "./config.ts";
import { parseArgs, ExitSignal, type ParserSpec, type ParsedArgs } from "./argparse.ts";
import { Browser } from "./browser.ts";
import { ClientError } from "./errors.ts";
import { commands } from "./commands.ts";
import { str, opt } from "./command.ts";
import { whoami } from "./web-actions.ts";
import { countLimit } from "./ui.ts";

export function buildParser(): ParserSpec {
  return {
    prog: NAME, description: `${NAME}: your account through the real web interface. Use describe for the JSON command schema.`,
    options: [
      { flags: ["--cookies"], dest: "cookies", help: `cookie file, storage state, or browser:profile (${ENV}_COOKIES)` },
      { flags: ["--channel"], dest: "channel", help: `installed browser channel (${ENV}_BROWSER_CHANNEL)` },
      { flags: ["--browser-path"], dest: "browserPath", help: `browser executable (${ENV}_BROWSER)` },
      { flags: ["--headed"], dest: "headed", action: "storeTrue", help: "show the browser" },
      { flags: ["--slow"], dest: "slow", valueType: "int", default: 0, help: "delay between UI actions in milliseconds" },
      { flags: ["--timeout"], dest: "timeout", valueType: "int", default: 30000, help: "navigation/control timeout in milliseconds" },
      { flags: ["--json"], dest: "json", action: "storeTrue", help: "JSON output" },
      { flags: ["--compact"], dest: "compact", action: "storeTrue", help: "one-line JSON output" },
      { flags: ["--verbose"], dest: "verbose", action: "storeTrue", help: "navigation diagnostics on stderr" },
      { flags: ["--dry-run"], dest: "dryRun", action: "storeTrue", help: "offline plan; no browser or remote calls" },
      { flags: ["--yes", "-y"], dest: "yes", action: "storeTrue", help: "confirm the requested write" },
      { flags: ["--version"], dest: "version", action: "version", version: `${NAME} ${VERSION}` },
    ],
    subcommands: [
      { name: "describe", help: "discover commands offline", positionals: [{ dest: "command", optional: true }] },
      { name: "login", help: "log in interactively and save a private session" },
      ...commands,
    ],
  };
}

function emit(data: unknown, args: ParsedArgs): void {
  // Structured data also has a readable default; stdout always contains one result.
  console.log(JSON.stringify(data, null, args.compact ? undefined : 2));
}

export async function run(args: ParsedArgs): Promise<number> {
  if (args.cmd === "describe") {
    const schemas = commands.map(({ execute, validate, browser, ...schema }) => ({ ...schema, mutates: !!schema.mutates, transport: browser === false ? "native" : "browser" }));
    const list = [...schemas, { name: "login", help: "log in interactively and save a private local session", mutates: false, transport: "browser" }].filter(c => !args.command || c.name === args.command);
    if (!list.length) throw new ClientError(`Unknown command: ${str(args, "command")}`, "INVALID_ARGUMENT");
    emit({ name: NAME, version: VERSION, options: buildParser().options, commands: list }, args);
    return 0;
  }
  const command = commands.find(c => c.name === args.cmd);
  if (!command && args.cmd !== "login") throw new ClientError("Unknown command", "INVALID_ARGUMENT");
  if (args.limit != null) countLimit(args.limit);
  if (!Number.isSafeInteger(args.timeout) || Number(args.timeout) < 1000 || Number(args.timeout) > 300000) throw new ClientError("--timeout must be 1000–300000 milliseconds.", "INVALID_ARGUMENT");
  if (!Number.isSafeInteger(args.slow) || Number(args.slow) < 0) throw new ClientError("--slow must be a nonnegative integer.", "INVALID_ARGUMENT");
  command?.validate?.(args);
  if (args.dryRun) {
    const { cookies, browserPath, ...safe } = args;
    emit({ dryRun: true, command: args.cmd, mutates: !!command?.mutates, arguments: safe }, args);
    return 0;
  }
  if (command?.mutates && !args.yes) {
    if (!stdin.isTTY) throw new ClientError("Writes require --yes in noninteractive use. Preview with --dry-run.", "CONFIRMATION_REQUIRED");
    const reader = createInterface({ input: stdin, output: stderr });
    try {
      if (!/^y(es)?$/i.test((await reader.question(`${command.help}. Continue? [y/N] `)).trim())) return 1;
    } finally { reader.close(); }
  }
  if (command?.browser === false) { emit(await command.execute(undefined as unknown as Browser, args), args); return 0; }
  if (args.cmd === "login" && !stdin.isTTY) throw new ClientError("login needs an interactive terminal.", "TTY_REQUIRED");
  const browser = await Browser.start(opt(args, "cookies"), { headed: !!args.headed || args.cmd === "login", executablePath: opt(args, "browserPath"), channel: opt(args, "channel"), verbose: !!args.verbose, slow: Number(args.slow), timeout: Number(args.timeout) });
  try {
    if (args.cmd === "login") {
      // Human completes credentials and any verification in the browser.
      await browser.page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded" });
      const reader = createInterface({ input: stdin, output: stderr });
      try { await reader.question("Complete login in the browser, then press Enter here. "); } finally { reader.close(); }
      const account = await whoami(browser);
      const path = await browser.saveSession();
      emit({ account, sessionFile: path }, args);
    } else emit(await command!.execute(browser, args), args);
  } finally { await browser.close(); }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try { return await run(parseArgs(buildParser(), argv)); }
  catch (error) {
    if (error instanceof ExitSignal) return error.code;
    const code = error instanceof ClientError ? error.code : "ERROR";
    // Do not dump stack traces or HTTP headers that could contain credentials.
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ error: { code, message } }));
    return ["INVALID_ARGUMENT", "INVALID_TARGET"].includes(code) ? 2 : 1;
  }
}
