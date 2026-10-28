import { chromium, type Browser as Engine, type BrowserContext, type Page } from "playwright-core";
import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DOMAIN, ENV, NAME, ORIGIN } from "./config.ts";
import { loadState, serviceHost } from "./cookies.ts";
import { ClientError, NotLoggedIn } from "./errors.ts";

export interface BrowserOptions {
  headed?: boolean; slow?: number; verbose?: boolean; timeout?: number;
  executablePath?: string; channel?: string; anonymous?: boolean;
}
export const sessionPath = (): string => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), NAME, "session.json");

export function siteURL(input: string): string {
  const url = new URL(input, ORIGIN);
  if (url.protocol !== "https:" || !serviceHost(url.hostname) || url.username || url.password || url.port) {
    throw new ClientError(`Expected an HTTPS ${DOMAIN} URL.`, "INVALID_TARGET");
  }
  return url.href;
}

export class Browser {
  private constructor(readonly engine: Engine, readonly context: BrowserContext, readonly page: Page, readonly options: BrowserOptions) {}
  static async start(source?: string, options: BrowserOptions = {}): Promise<Browser> {
    const stateSource = options.anonymous ? undefined : source || process.env[`${ENV}_COOKIES`] || (existsSync(sessionPath()) ? sessionPath() : undefined);
    const state = loadState(stateSource);
    const executablePath = options.executablePath || process.env[`${ENV}_BROWSER`];
    const channel = options.channel || process.env[`${ENV}_BROWSER_CHANNEL`];
    let engine: Engine;
    try {
      engine = await chromium.launch({ headless: !options.headed, slowMo: options.slow ?? 0, ...(executablePath ? { executablePath } : channel ? { channel } : {}) });
    } catch {
      throw new ClientError(`Cannot launch Chromium. Use --channel chrome, --browser-path <binary>, or install a Playwright Chromium browser.`, "BROWSER_UNAVAILABLE");
    }
    try {
      const context = await engine.newContext({ storageState: { ...state, cookies: state.cookies.map(c => ({ ...c, expires: c.expires ?? -1 })) }, viewport: { width: 1440, height: 1000 }, locale: "en-US", acceptDownloads: true });
      context.setDefaultTimeout(options.timeout ?? 20000);
      context.setDefaultNavigationTimeout(options.timeout ?? 30000);
      const page = await context.newPage();
      // Unexpected site confirmation dialogs must never approve a different action.
      page.on("dialog", dialog => { void dialog.dismiss(); });
      return new Browser(engine, context, page, options);
    } catch (error) { await engine.close(); throw error; }
  }
  async goto(input: string, options: { allowLogin?: boolean } = {}): Promise<void> {
    const url = siteURL(input);
    if (this.options.verbose) console.error(`[nav] ${new URL(url).origin}${new URL(url).pathname}`);
    const response = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.guard(options.allowLogin);
    if (response && response.status() >= 400) throw new ClientError(`The site returned HTTP ${response.status()}.`, "HTTP_ERROR");
  }
  async guard(allowLogin = false): Promise<void> {
    const url = new URL(this.page.url());
    if (!serviceHost(url.hostname)) throw new ClientError("The site redirected outside the expected service.", "UNEXPECTED_REDIRECT");
    if (!allowLogin && /\/(login|signin|sign-in|checkpoint|two-factor|verify)(\/|$)/i.test(url.pathname)) throw new NotLoggedIn();
    const title = await this.page.title();
    if (/just a moment|verify you are human|checking your browser|cierpliwości/i.test(title)) {
      throw new ClientError("The site requires browser verification. Open a headed login session and complete it manually.", "BROWSER_VERIFICATION_REQUIRED");
    }
  }
  async saveSession(): Promise<string> {
    const path = sessionPath();
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const state = await this.context.storageState();
    state.cookies = state.cookies.filter(c => serviceHost(c.domain.replace(/^\./, "")));
    state.origins = state.origins.filter(o => serviceHost(new URL(o.origin).hostname));
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    return path;
  }
  async close(): Promise<void> { await this.engine.close(); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}
