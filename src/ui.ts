import type { Locator, Page } from "playwright-core";
import { UiChanged, WriteUncertain, ClientError } from "./errors.ts";

export async function one(locator: Locator, description: string): Promise<Locator> {
  const visible = locator.filter({ visible: true });
  await visible.first().waitFor({ state: "visible" });
  const count = await visible.count();
  if (count !== 1) throw new UiChanged(`Expected one ${description}, found ${count}.`);
  return visible;
}

export async function clickNamed(root: Page | Locator, name: RegExp): Promise<void> {
  await (await one(root.getByRole("button", { name }).or(root.getByRole("link", { name })).or(root.getByRole("menuitem", { name })), `control matching ${name}`)).click();
}

export async function fillEditor(root: Page | Locator, text: string): Promise<void> {
  const box = root.locator('textarea:visible, [contenteditable="true"]:visible');
  const direct = await box.count();
  if (direct === 1) { await box.fill(text); await box.blur(); return; }
  const frames = root.locator('iframe.tox-edit-area__iframe, iframe[id$="_ifr"]');
  if (await frames.count() === 1) {
    await frames.contentFrame().locator('body[contenteditable="true"]').fill(text);
    return;
  }
  throw new UiChanged(`Expected one text editor, found ${direct}.`);
}

/** Watch the real site's response. An unconfirmed click is never reported as success. */
export async function submit(page: Page, button: Locator, matches: (url: URL, method: string) => boolean, description: string): Promise<Record<string, unknown>> {
  const pending = page.waitForResponse(r => matches(new URL(r.url()), r.request().method()), { timeout: 30000 }).then(r => ({ response: r })).catch(() => ({ response: null }));
  try { await (await one(button, description)).click(); }
  catch (error) { throw new WriteUncertain(`Could not complete ${description}: ${error instanceof Error ? error.message : String(error)}.`); }
  const { response } = await pending;
  if (!response) throw new WriteUncertain(`No response confirming ${description}.`);
  let data: any = null;
  if (response.headers()["content-type"]?.includes("json")) {
    try { data = await response.json(); } catch { throw new WriteUncertain(`Unreadable response for ${description}.`); }
  }
  if (response.status() >= 400 || data?.errors?.length || data?.success === false) {
    throw new ClientError(`The site rejected ${description} (HTTP ${response.status()}).`, "WRITE_REJECTED");
  }
  return { status: "submitted", url: page.url(), httpStatus: response.status(), ...(data?.id ? { id: String(data.id) } : {}) };
}

export function countLimit(value: unknown, fallback = 20): number {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new ClientError("--limit must be an integer between 1 and 500.", "INVALID_ARGUMENT");
  return n;
}
