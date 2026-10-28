import { readFileSync, statSync } from "node:fs";
import type { ParsedArgs, SubCommand, Option } from "./argparse.ts";
import type { Browser } from "./browser.ts";
import { ClientError } from "./errors.ts";

export interface Command extends SubCommand {
  mutates?: boolean;
  browser?: boolean;
  validate?: (args: ParsedArgs) => void;
  execute: (browser: Browser, args: ParsedArgs) => Promise<unknown>;
}
export const str = (a: ParsedArgs, key: string): string => String(a[key] ?? "");
export const opt = (a: ParsedArgs, key: string): string | undefined => str(a, key) || undefined;
export const limit: Option = { flags: ["--limit"], dest: "limit", valueType: "int", default: 20, help: "maximum items (1–500)" };
export const textFile: Option = { flags: ["--body-file"], dest: "bodyFile", help: "read UTF-8 body from a local file instead of the text argument" };
export const field = (name: string, help: string, choices?: string[]): Option => ({ flags: [`--${name}`], dest: name.replace(/-([a-z])/g, (_, l) => l.toUpperCase()), help, ...(choices ? { choices } : {}) });
export const flag = (name: string, help: string): Option => ({ ...field(name, help), action: "storeTrue" });

export function body(a: ParsedArgs): string {
  if (a.bodyFile && a.text) throw new ClientError("Use text or --body-file, not both.", "INVALID_ARGUMENT");
  const value = a.bodyFile ? readFileSync(str(a, "bodyFile"), "utf8") : str(a, "text");
  if (!value.trim()) throw new ClientError("A nonempty text body is required.", "INVALID_ARGUMENT");
  return value;
}
export function required(a: ParsedArgs, key: string): string {
  const value = str(a, key).trim();
  if (!value) throw new ClientError(`--${key} is required.`, "INVALID_ARGUMENT");
  return value;
}
export function localFile(path: string): void {
  if (!statSync(path).isFile()) throw new ClientError(`Expected a local file: ${path}`, "INVALID_ARGUMENT");
}
