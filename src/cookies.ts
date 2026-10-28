import { existsSync, readFileSync } from "node:fs";
import { DOMAIN } from "./config.ts";
import { ClientError } from "./errors.ts";
import { cookiesFromBrowser, isBrowserKeyword } from "./browser-cookies.ts";

export type SameSite = "Strict" | "Lax" | "None";
export interface PWCookie {
  name: string; value: string; domain: string; path: string;
  secure: boolean; httpOnly: boolean; sameSite: SameSite; expires?: number;
}
export interface StorageState {
  cookies: PWCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}
export const serviceHost = (host: string): boolean => host === DOMAIN || host.endsWith(`.${DOMAIN}`);

/** Only the selected site's cookies and storage ever enter the browser context. */
export function loadState(source?: string): StorageState {
  if (!source) return { cookies: [], origins: [] };
  if (isBrowserKeyword(source)) return { cookies: cookiesFromBrowser(source), origins: [] };
  const raw = existsSync(source) ? readFileSync(source, "utf8").trim() : source.trim();
  let rows: Record<string, unknown>[] = [];
  let origins: StorageState["origins"] = [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) rows = data;
    else if (Array.isArray(data.cookies)) {
      rows = data.cookies;
      origins = (data.origins ?? []).filter((o: { origin?: string }) => {
        try { const u = new URL(o.origin!); return u.protocol === "https:" && serviceHost(u.hostname); }
        catch { return false; }
      });
    } else rows = Object.entries(data).map(([name, value]) => ({ name, value }));
  } else if (raw.includes("\t")) {
    rows = raw.split(/\r?\n/).flatMap(line => {
      const httpOnly = line.startsWith("#HttpOnly_");
      if (httpOnly) line = line.slice(10);
      else if (line.startsWith("#")) return [];
      const [domain, , path, secure, expires, name, ...value] = line.split("\t");
      return name ? [{ domain, path, secure: secure === "TRUE", expires, name, value: value.join("\t"), httpOnly }] : [];
    });
  } else {
    rows = raw.split(/;|\n/).flatMap(part => {
      const equal = part.indexOf("=");
      return equal > 0 ? [{ name: part.slice(0, equal).trim(), value: part.slice(equal + 1).trim() }] : [];
    });
  }
  const cookies = rows.flatMap(row => {
    if (!row || typeof row.name !== "string" || typeof row.value !== "string") return [];
    const domain = String(row.domain ?? `.${DOMAIN}`);
    if (!serviceHost(domain.replace(/^\./, ""))) return [];
    const same = String(row.sameSite ?? "lax").toLowerCase();
    const cookie: PWCookie = {
      name: row.name, value: row.value, domain, path: String(row.path ?? "/"),
      secure: row.secure !== false, httpOnly: row.httpOnly === true,
      sameSite: same === "strict" ? "Strict" : ["none", "no_restriction"].includes(same) ? "None" : "Lax",
    };
    const expires = Number(row.expirationDate ?? row.expires);
    if (Number.isFinite(expires) && expires > 0) cookie.expires = expires;
    return [cookie];
  });
  if (!cookies.length) throw new ClientError(`No ${DOMAIN} cookies found in the provided source.`, "AUTH_REQUIRED");
  return { cookies, origins };
}
