import {collectPages, nextPage, type PageOptions} from "./pagination.ts";
import { mkdir, stat, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Locator } from "playwright-core";
import { Browser, siteURL } from "./browser.ts";
import { ClientError, NotLoggedIn, UiChanged, WriteUncertain } from "./errors.ts";
import { one, clickNamed, fillEditor, countLimit } from "./ui.ts";
import { S } from "./selectors.ts";

export interface Item { id?: string; title: string; url: string; text?: string; author?: string; }
export interface Comment { id: string; text: string; author: string; url: string; parentId: string | null; }

export function gameURL(target: string): string {
  if (/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i.test(target)) {
    const [user, game] = target.split("/"); return siteURL(`https://${user}.itch.io/${game}`);
  }
  return siteURL(target);
}
export function id(value: string): string {
  if (!/^\d+$/.test(value)) throw new ClientError("Expected a numeric itch.io ID.", "INVALID_ARGUMENT");
  return value;
}

export async function whoami(b: Browser): Promise<Record<string, string>> {
  await b.goto("/dashboard");
  const current = await b.page.evaluate(() => {
    const user = (window as unknown as { I?: { current_user?: { id?: number; username?: string } } }).I?.current_user;
    return user && typeof user === "object" ? { id:user.id, username:user.username } : null;
  });
  if (current?.id && current.username) return { id:String(current.id),username:current.username,url:siteURL(`/profile/${current.username}`) };
  const profile = b.page.locator('.user_panel_widget a[href*="/profile/"], .user_panel_widget a.profile_link');
  if (!await profile.count()) throw new NotLoggedIn("No account profile found on the itch.io dashboard. Renew your session with login.");
  const url = await profile.first().getAttribute("href");
  const parsed = new URL(siteURL(url!));
  const username = parsed.hostname.endsWith(".itch.io") ? parsed.hostname.slice(0,-8) : parsed.pathname.split("/").filter(Boolean).pop();
  if (!username) throw new UiChanged("The account profile URL does not identify a username.");
  return { ...(current?.id ? { id:String(current.id) } : {}), name: (await profile.first().innerText()).trim(), url:parsed.href, username };
}

async function gameCards(b: Browser, limit = 20): Promise<Item[]> {
  return b.page.locator(S.game).evaluateAll((nodes, max) => nodes.slice(0, max).map(node => {
    const a = node.querySelector<HTMLAnchorElement>(".game_title a");
    return { id: node.getAttribute("data-game_id")!, title: a?.textContent?.trim() ?? "", url: a?.href ?? "", text: node.querySelector(".game_text")?.textContent?.trim() ?? "", author: node.querySelector(".game_author")?.textContent?.trim() ?? "" };
  }), countLimit(limit));
}

export async function search(b: Browser, query: string, limit = 20, page = 1): Promise<unknown> {
  const q = new URLSearchParams({ q: query, page: String(page) });
  await b.goto(`/search?${q}`);
  await b.page.locator('.search_page, [id^="search_"]').first().waitFor();
  const items = await gameCards(b, limit);
  const nextLink = b.page.locator('a.next_page, a[rel="next"]').first();
  const next = await nextLink.count() ? await nextLink.getAttribute("href") : null;
  return { items, page, next: next ? siteURL(next) : null };
}

export async function commentPages(b: Browser, target: string, limit=20,options:PageOptions={}) {
  await b.goto(gameURL(target));
  const root=b.page.locator('.community_post_list_widget, .community_view_topic_widget, .game_comments_widget, .community_post_list');
  if(!await root.count()&&!await b.page.locator(S.comment).count())throw new UiChanged("This page has no comment section. Use the project's community or topic URL.");
  return collectPages(b,limit,options,()=>extractComments(b));
}
export async function comments(b:Browser,target:string,limit=20):Promise<Comment[]>{
  return (await commentPages(b,target,limit)).items;
}

async function extractComments(b: Browser, limit?: number): Promise<Comment[]> {
  return b.page.locator(S.comment).evaluateAll((nodes, max) => (max===undefined?nodes:nodes.slice(0,max)).map(node => ({
    id: node.id.replace(/^post-/, "") || JSON.parse(node.getAttribute("data-post") || "{}").id?.toString() || "",
    text: node.querySelector(".post_body")?.textContent?.trim() ?? "",
    author: node.querySelector(".post_author")?.textContent?.trim() ?? "",
    url: node.querySelector<HTMLAnchorElement>(".post_date a")?.href ?? `${location.href.split("#")[0]}#${node.id}`,
    parentId: (node.parentElement?.closest(".community_post")?.id || (node.parentElement?.matches(".community_post_replies") ? node.parentElement.previousElementSibling?.id : null))?.replace(/^post-/, "") ?? null,
  })), limit===undefined?undefined:countLimit(limit));
}

export async function read(b: Browser, target: string, limit = 20): Promise<unknown> {
  await b.goto(gameURL(target));
  const content = await b.page.locator('.formatted_description, .post_body, .user_formatted, main').first().innerText().catch(() => "");
  if (!content) throw new UiChanged("No project or community content found on this page.");
  return { title: await b.page.title(), url: b.page.url(), text: content, comments: await extractComments(b, limit) };
}

export async function uploads(b: Browser, target: string): Promise<unknown[]> {
  await b.goto(gameURL(target));
  return listUploads(b);
}
async function listUploads(b: Browser): Promise<unknown[]> {
  return b.page.locator(S.upload).evaluateAll(nodes => nodes.map(node => ({
    id: node.querySelector("[data-upload_id]")?.getAttribute("data-upload_id") ?? null,
    name: node.querySelector(".name")?.textContent?.trim() ?? "",
    size: node.querySelector(".file_size")?.textContent?.trim() ?? "",
    version: node.querySelector(".version_name")?.textContent?.trim() ?? null,
    platforms: [...node.querySelectorAll("[title^='Download for']")].map(e => e.getAttribute("title")),
  })));
}

export async function download(b: Browser, target: string, uploadId: string, output: string): Promise<unknown> {
  id(uploadId);
  const destination = resolve(output);
  if (await stat(destination).then(() => true).catch(() => false)) throw new ClientError("The output file already exists. Choose a new path.", "OUTPUT_EXISTS");
  await b.goto(gameURL(target));
  let button = b.page.locator(`${S.download}[data-upload_id="${uploadId}"]`);
  if (!await button.count()) {
    // The site may reveal downloadable uploads after the game's download button.
    await clickNamed(b.page, /^(Download Now|Download|Download or claim)$/i);
    const skip = b.page.getByRole("link", { name: /No thanks, just take me to the downloads/i });
    if (await skip.isVisible()) await skip.click();
    button = b.page.locator(`${S.download}[data-upload_id="${uploadId}"]`);
  }
  const pending = b.page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  await (await one(button, `download for upload ${uploadId}`)).click();
  const file = await pending;
  if (!file) throw new ClientError("No download was offered by the site.", "DOWNLOAD_FAILED");
  const failure = await file.failure();
  if (failure) throw new ClientError(`Download failed: ${failure}`, "DOWNLOAD_FAILED");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.part`;
  try {
    await file.saveAs(temporary);
    // Atomic no-clobber installation; never replace an existing user file.
    await link(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  return { path: destination, uploadId, bytes: (await stat(destination)).size, suggestedFilename: file.suggestedFilename() };
}

async function postNode(b: Browser, postId: string): Promise<Locator> {
  return one(b.page.locator(`#post-${id(postId)}`), `comment ${postId}`);
}

/** Read responses in Chromium before website reload handlers discard their bodies. */
async function captureWrite(b: Browser, matches: (url: URL) => boolean, trigger: () => Promise<unknown>) {
  const session = await b.context.newCDPSession(b.page);
  let settle!: (value: { status:number; headers:Record<string,string>; url:string; data:any }) => void;
  let fail!: (reason:unknown)=>void;
  const receipt = new Promise<{status:number;headers:Record<string,string>;url:string;data:any}>((resolve,reject)=>{settle=resolve;fail=reject;});
  const timer = setTimeout(()=>fail(new WriteUncertain("No readable mutation response.")),30000);
  void receipt.catch(()=>{});
  session.on("Fetch.requestPaused",async event=>{
    const targeted=event.request.method === "POST" && matches(new URL(event.request.url));
    try {
      if (targeted) {
        const headers = Object.fromEntries((event.responseHeaders??[]).map(h=>[h.name.toLowerCase(),h.value]));
        let data = null;
        if (headers["content-type"]?.includes("json")) {
          const response = await session.send("Fetch.getResponseBody",{requestId:event.requestId});
          data = JSON.parse(response.base64Encoded ? Buffer.from(response.body,"base64").toString("utf8") : response.body);
        }
        await session.send("Fetch.continueResponse",{requestId:event.requestId});
        settle({status:event.responseStatusCode??0,headers,url:event.request.url,data});
      } else await session.send("Fetch.continueResponse",{requestId:event.requestId});
    } catch {
      await session.send("Fetch.continueResponse",{requestId:event.requestId}).catch(()=>{});
      if(targeted) fail(new WriteUncertain("Could not read the mutation response."));
    }
  });
  try {
    await session.send("Fetch.enable",{patterns:[{urlPattern:"*",requestStage:"Response"}]});
    await trigger(); return await receipt;
  }
  finally { clearTimeout(timer); await session.send("Fetch.disable").catch(()=>{}); await session.detach().catch(()=>{}); }
}

/** Submit the site's own form, preserving its action, validation and CSRF fields. */
export async function submitForm(b: Browser, form: Locator, submitButton?:Locator): Promise<unknown> {
  form = await one(form, "form");
  const endpoint = new URL(siteURL(new URL(await form.getAttribute("action") || b.page.url(),b.page.url()).href));
  const explicit = form.locator('button[type="submit"], input[type="submit"]');
  const button = submitButton ?? (await explicit.count() ? explicit : form.locator('button:not([type])'));
  const result = await captureWrite(b,u=>u.origin===endpoint.origin&&u.pathname===endpoint.pathname,async()=>{
    await (await one(button,"form submit button")).click();
  });
  const {data} = result;
  if (!result.status) throw new WriteUncertain("The mutation did not return an HTTP status.");
  if (result.status >= 400 || data?.errors?.length || data?.success === false) throw new ClientError(`The site rejected the form (HTTP ${result.status}).`, "WRITE_REJECTED");
  const redirect = data?.redirect_to || result.headers["location"];
  if (redirect) {
    const destination = siteURL(new URL(redirect,result.url).href);
    await b.page.waitForURL(u=>u.href===destination || u.href.split("#")[0]===destination.split("#")[0]);
    await b.guard();
    return { status:"submitted",url:b.page.url() };
  }
  if (data?.post) return { status:"submitted",id:String(data.post.id),url:data.post.url ? siteURL(data.post.url) : `${b.page.url().split("#")[0]}#post-${data.post.id}` };
  if (!data && await b.page.locator(".errors:visible,.form_errors:visible,.error_message:visible").count()) throw new ClientError("The site returned form validation errors. Inspect the form before retrying.","WRITE_REJECTED");
  return {status:"submitted",url:b.page.url()};
}

export async function comment(b: Browser, target: string, text: string, replyTo?: string): Promise<unknown> {
  await b.goto(gameURL(target));
  let form: Locator;
  if (replyTo) {
    const node = await postNode(b, replyTo);
    const reply = await one(node.locator(".reply_btn"), "reply control");
    const href = await reply.getAttribute("href");
    if (href && /\/post\/\d+\/reply/.test(href)) await b.goto(href);
    else await reply.click();
    form = b.page.locator("form.inline_reply, form.post_form[action]").filter({ visible:true });
  } else {
    const opener = b.page.locator('form.post_form .click_input, .community_post_form_widget textarea, .game_comments_widget textarea').filter({ visible: true });
    if (await opener.count() === 1) await opener.click();
    form = b.page.locator("form.post_form[action]").filter({ visible: true });
  }
  await b.guard();
  form = await one(form, "comment form");
  await fillEditor(form, text);
  return submitForm(b, form);
}

export async function editComment(b: Browser, target: string, postId: string, text: string): Promise<unknown> {
  await b.goto(gameURL(target));
  const node = await postNode(b, postId);
  const edit = await one(node.locator(`.edit_btn, a[href$="/post/${id(postId)}/edit"]`), "edit comment control");
  const href = await edit.getAttribute("href");
  if (href && /\/post\/\d+\/edit/.test(href)) await b.goto(href);
  else await edit.click();
  await b.guard();
  const form = await one(b.page.locator("form.inline_edit, form.post_form").filter({ visible: true }), "comment edit form");
  await fillEditor(form, text);
  return submitForm(b, form);
}

export async function deleteComment(b: Browser, target: string, postId: string): Promise<unknown> {
  await b.goto(gameURL(target));
  const node = await postNode(b, postId);
  if (await node.getByRole("link",{name:"Delete topic",exact:true}).count()) throw new ClientError("This is the topic's first post. Use delete-topic to delete the topic.","INVALID_ARGUMENT");
  // Only the documented soft-delete confirmation is accepted. Purge is separate.
  b.page.removeAllListeners("dialog");
  b.page.once("dialog", dialog => { void (/^Are you sure you want to delete this post\?$/i.test(dialog.message()) ? dialog.accept() : dialog.dismiss()); });
  const result = await captureWrite(b,u=>/delete/.test(u.pathname)&&u.pathname.includes(`/post/${postId}/`),async()=>{
    await (await one(node.locator(".delete_post_btn, .delete_btn"), "delete comment button")).click();
  });
  if (result.status >= 400 || result.data?.errors?.length) throw new ClientError("The site rejected deletion.", "WRITE_REJECTED");
  return { status: "submitted", id: postId, url: b.page.url() };
}

export async function topics(b: Browser, target: string, limit = 20, options:PageOptions = {}): Promise<unknown> {
  await b.goto(gameURL(target));
  return collectPages(b,limit,options,async()=>{
  const links = b.page.locator('a[href*="/t/"]');
  return links.evaluateAll((nodes) => {
    const found = new Map<string, { title: string; url: string }>();
    for (const node of nodes as HTMLAnchorElement[]) {
      const title = node.textContent?.trim(); const m = new URL(node.href).pathname.match(/^\/t\/\d+(?:\/[^/]+)?/);
      if (title && m && !found.has(m[0])) found.set(m[0], { title, url: node.origin + m[0] });
    }
    return [...found.values()];
  });
  });
}

export async function topic(b: Browser, target: string, title: string, text: string): Promise<unknown> {
  await b.goto(gameURL(target));
  if (!/\/new-topic$/.test(new URL(b.page.url()).pathname)) {
    const links = b.page.locator('a[href*="/category/"][href$="/new-topic"]');
    const destinations = await links.evaluateAll(nodes=>[...new Set(nodes.map(n=>(n as HTMLAnchorElement).href))]);
    if (destinations.length !== 1) throw new UiChanged("Expected one destination for creating a topic.");
    await b.goto(destinations[0]!);
  }
  await b.guard();
  const titleInput = await one(b.page.locator('input[name="topic[title]"]'), "topic title");
  const form = titleInput.locator("xpath=ancestor::form");
  await titleInput.fill(title);
  await fillEditor(form, text);
  return submitForm(b, form);
}

export async function moderate(b: Browser, target: string, action: string, reason?: string): Promise<unknown> {
  await b.goto(gameURL(target));
  const names: Record<string, RegExp> = {
    lock: /^Lock topic(?:\.\.\.)?$/i, unlock: /^Unlock topic(?:\.\.\.)?$/i, stick: /^Stick topic(?:\.\.\.)?$/i, unstick: /^Unstick topic(?:\.\.\.)?$/i,
    archive: /^Archive\/Hide topic(?:\.\.\.)?$/i, hide: /^Archive\/Hide topic(?:\.\.\.)?$/i,
    unarchive: /^Unarchive(?: topic)?(?:\.\.\.)?$/i, unhide: /^Unhide topic(?:\.\.\.)?$/i,
  };
  const name = names[action];
  if (!name) throw new ClientError("Unknown moderation action.", "INVALID_ARGUMENT");
  await clickNamed(b.page, /^Moderation$/);
  await clickNamed(b.page, name);
  const form = await one(b.page.locator(".lightbox form"), "moderation form");
  if (action === "archive" || action === "hide") await form.locator(`input[name="action"][value="${action}"]`).check();
  if (reason) await fillEditor(form, reason);
  return submitForm(b, form);
}

export async function report(b: Browser, target: string, postId: string, reason: string, category:"off_topic"|"spam"|"offensive"|"other"="other"): Promise<unknown> {
  if(!["off_topic","spam","offensive","other"].includes(category)) throw new ClientError("Unknown report category.","INVALID_ARGUMENT");
  await b.goto(gameURL(target));
  await (await postNode(b, postId)).locator(".report_post_btn, .report_btn").click();
  const form = await one(b.page.locator(".lightbox form"), "report form");
  await form.locator(`input[name="report[reason]"][value="${category}"]`).check();
  await form.locator('input[name="block_user[yes]"]').setChecked(false);
  await fillEditor(form, reason);
  return submitForm(b, form);
}

export async function ban(b: Browser, target: string, postId: string, reason: string): Promise<unknown> {
  await b.goto(gameURL(target));
  await (await postNode(b, postId)).locator(".ban_user_btn").click();
  const form = await one(b.page.locator(".lightbox form"), "ban form");
  await fillEditor(form, reason);
  return submitForm(b, form);
}

/** Inspect actual admin forms rather than requiring callers to guess field names. */
export async function forms(b: Browser, target: string): Promise<unknown> {
  await b.goto(gameURL(target));
  return b.page.locator("form").evaluateAll(forms => forms.map((node, index) => { const form = node as HTMLFormElement; return ({
    index, action: new URL(form.getAttribute("action") || location.href,location.href).href, method: form.method,
    fields: [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")]
      .filter(e => e.name && !["hidden", "password"].includes(e.type))
      .map(e => ({ name: e.name, type: e.type, label: [...(e.labels ?? [])].map(l => l.textContent?.trim()).join(" "), required: e.required, checked: ["checkbox","radio"].includes(e.type) ? (e as HTMLInputElement).checked : undefined, value: e.type === "checkbox" ? (e as HTMLInputElement).checked : e.value, options: e instanceof HTMLSelectElement ? [...e.options].map(o => ({ label: o.text, value: o.value })) : undefined })),
  }); }));
}

export async function setFields(form: Locator, fields: Record<string,string|boolean>): Promise<void> {
  for (const [name,value] of Object.entries(fields)) {
    const controls = form.locator(`[name=${JSON.stringify(name)}]`);
    const types = await controls.evaluateAll(es=>es.map(e=>(e as HTMLInputElement).type));
    if (!types.length) throw new UiChanged(`The field ${name} is missing.`);
    if (types.every(t=>t==="radio")) {
      if (typeof value!=="string") throw new ClientError(`${name} must be a radio value string.`,"INVALID_ARGUMENT");
      await (await one(controls.and(form.locator(`[value=${JSON.stringify(value)}]`)),name)).check();
      continue;
    }
    if (types.length!==1) throw new UiChanged(`The field ${name} is ambiguous.`);
    const control=controls.first(), type=types[0];
    if (["hidden","password","file","submit"].includes(type??"")) throw new ClientError(`The field ${name} cannot be configured this way.`,"INVALID_ARGUMENT");
    if (type==="checkbox") {
      if (typeof value!=="boolean") throw new ClientError(`${name} must be boolean.`,"INVALID_ARGUMENT");
      await control.setChecked(value);
    } else {
      if (typeof value!=="string") throw new ClientError(`${name} must be a string.`,"INVALID_ARGUMENT");
      if (await control.evaluate(e=>e.tagName)==="SELECT") await control.selectOption(value);
      else if (type==="textarea" && !await control.isVisible()) {
        await fillEditor(control.locator("xpath=parent::*[contains(@class,'redactor-box')]"),value);
      } else await control.fill(value);
    }
  }
}

export async function configure(b: Browser, target: string, formIndex: number, fields: Record<string,string|boolean>): Promise<unknown> {
  await b.goto(gameURL(target));
  const form=await one(b.page.locator("form").nth(formIndex),"selected admin form");
  await setFields(form,fields);
  return submitForm(b,form);
}

async function topicMenu(b: Browser,target:string): Promise<void> {
  await b.goto(gameURL(target));
  await clickNamed(b.page,/^Moderation$/);
}

export async function editTopic(b: Browser,target:string,title:string,text:string): Promise<unknown> {
  await topicMenu(b,target);
  const href=await (await one(b.page.locator('.moderation_tools a[href$="/edit"]'),"topic edit link")).getAttribute("href");
  await b.goto(href!);
  const titleInput=await one(b.page.locator('input[name="post[title]"]'),"topic title");
  const form=titleInput.locator("xpath=ancestor::form");
  await titleInput.fill(title);
  await fillEditor(form,text);
  return submitForm(b,form);
}

export async function deleteTopic(b: Browser,target:string): Promise<unknown> {
  await topicMenu(b,target);
  const topicId=new URL(b.page.url()).pathname.match(/^\/t\/(\d+)/)?.[1];
  if (!topicId) throw new UiChanged("Cannot identify the current topic.");
  b.page.removeAllListeners("dialog");
  b.page.once("dialog",dialog=>{void (dialog.message()==="Are you sure you want to delete this topic?"?dialog.accept():dialog.dismiss());});
  const result=await captureWrite(b,u=>u.pathname.includes(`/topic/${topicId}/`)&&/delete/.test(u.pathname),()=>clickNamed(b.page,/^Delete topic\.\.\.$/));
  if (result.status>=400 || result.data?.errors?.length) throw new ClientError("The site rejected topic deletion.","WRITE_REJECTED");
  return {status:"submitted",id:topicId,url:b.page.url()};
}

export async function moveTargets(b: Browser,target:string): Promise<unknown> {
  await topicMenu(b,target);
  const href=await (await one(b.page.locator('.moderation_tools a[href$="/move"]'),"move topic link")).getAttribute("href");
  await b.goto(href!);
  const form=await one(b.page.locator('form').filter({has:b.page.locator('input[name="csrf_token"]')}).last(),"move form");
  return {url:b.page.url(),text:await form.innerText(),choices:await form.locator('button,input[type="radio"]').evaluateAll(es=>es.map(e=>({name:(e as HTMLInputElement).name,value:(e as HTMLInputElement).value,label:e.textContent?.trim()})))};
}

export async function moveTopic(b:Browser,target:string,categoryId:string):Promise<unknown> {
  await moveTargets(b,target);
  const button=await one(b.page.locator(`button[name="target_category_id"][value="${id(categoryId)}"]`),"permitted destination");
  return submitForm(b,button.locator("xpath=ancestor::form"),button);
}

const adminSections=["edit","edit-children","moderators","bans","reports","pending-posts","logs"] as const;
export type AdminSection=typeof adminSections[number];
async function adminPage(b: Browser,target:string,section:AdminSection): Promise<void> {
  await b.goto(gameURL(target));
  const current=new URL(b.page.url());
  if (current.pathname.match(new RegExp(`^/category/\\d+/${section}$`))) return;
  let links=b.page.locator(`a[href*="/category/"][href$="/${section}"]`);
  if (!await links.count()) {
    const edit=b.page.locator('a[href*="/category/"][href$="/edit"]');
    if (!await edit.count()) throw new UiChanged("Use a community URL or its administration URL that you can moderate.");
    await b.goto((await edit.first().getAttribute("href"))!);
    links=b.page.locator(`a[href*="/category/"][href$="/${section}"]`);
  }
  const destinations=await links.evaluateAll(es=>[...new Set(es.map(e=>(e as HTMLAnchorElement).href))]);
  if (destinations.length!==1) throw new UiChanged(`Cannot locate the ${section} administration page.`);
  await b.goto(destinations[0]!);
}

export async function administration(b: Browser,target:string,section:AdminSection,options:PageOptions = {}): Promise<unknown> {
  await adminPage(b,target,section);
  const read=async()=>{
  const page=await one(b.page.locator('.page_widget').filter({has:b.page.locator('.community_edit_category_header_widget')}),"administration page");
  return {url:b.page.url(),section,text:await page.innerText(),
    tables:await page.locator("table").evaluateAll(tables=>tables.map(t=>({headers:[...t.querySelectorAll("thead th,thead td")].map(e=>e.textContent?.trim()),rows:[...t.querySelectorAll("tbody tr")].map(row=>[...row.querySelectorAll("td")].map(e=>e.textContent?.trim()))}))),
    links:await page.locator("a[href]").evaluateAll(es=>es.map(e=>({title:e.textContent?.trim(),url:(e as HTMLAnchorElement).href})))};
  };
  if(!options.all&&!options.cursor){const next=await nextPage(b);return {...await read(),next,cursor:next?Buffer.from(JSON.stringify({url:next,offset:0})).toString('base64url'):null};}
  const result=await collectPages(b,20,options,async()=>[await read()]);
  return {...result,section,pages:result.items};
}

export async function communitySettings(b: Browser,target:string,fields:Record<string,string|boolean>): Promise<unknown> {
  await adminPage(b,target,"edit");
  const form=await one(b.page.locator('form').filter({has:b.page.locator('textarea[name="category[rules]"]')}),"community settings form");
  await setFields(form,fields);
  return submitForm(b,form);
}

export async function addModerator(b: Browser,target:string,username:string): Promise<unknown> {
  await adminPage(b,target,"moderators");
  const form=await one(b.page.locator("form.add_moderator_form"),"add moderator form");
  await form.locator('input[name="username"]').fill(username);
  return submitForm(b,form);
}

export async function createCategory(b:Browser,target:string,title:string,description?:string,parentId?:string):Promise<unknown> {
  if(!title.trim())throw new ClientError("Title cannot be empty.","INVALID_ARGUMENT");
  if(parentId)id(parentId);
  await adminPage(b,target,"edit-children");
  const form=await one(b.page.locator("form.edit_categories"),"categories form");
  const before=await categoryData(b);
  const parent=parentId?await categoryRow(b,parentId):null;
  if(parent)await parent.getByRole("button",{name:"Add child",exact:true}).first().click();
  else await clickNamed(form,/^New category$/);
  const titleInput=(parent??form).getByPlaceholder("Title",{exact:true}).last();
  const row=titleInput.locator("xpath=ancestor::div[contains(@class,'category_row')][1]");
  await titleInput.fill(title);
  if(description!==undefined) await row.getByPlaceholder("Short description",{exact:true}).fill(description);
  await submitForm(b,form,form.getByRole("button",{name:"Save",exact:true}));
  await adminPage(b,target,"edit-children");
  const created=(await categoryData(b)).filter(c=>!before.some(old=>old.id===c.id));
  if(created.length!==1||created[0]?.title!==title)throw new WriteUncertain("Could not identify the new category after saving.");
  return {status:"created",category:created[0]};
}

export async function tag(b:Browser,target:string,label:string,remove=false):Promise<unknown> {
  await adminPage(b,target,"edit");
  const form=await one(b.page.locator("form").filter({has:b.page.locator(".community_category_edit_tags_widget")}),"community settings form");
  // The field retains the current tag IDs and descriptions; only this tag changes.
  const labels=await form.locator(".tag_label").allTextContents();
  if(remove) {
    if(!labels.includes(label)) throw new ClientError("Tag not found.","NOT_FOUND");
    b.page.removeAllListeners("dialog");
    b.page.once("dialog",dialog=>{void(dialog.message()==="Are you sure you want to remove this tag?"?dialog.accept():dialog.dismiss());});
    const row=form.locator(".tag_row").filter({has:b.page.locator(".tag_label",{hasText:new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`)})});
    await (await one(row,"tag row")).locator(".remove_tag_btn").click();
  } else {
    if(labels.includes(label)) return {status:"unchanged",tag:label,url:b.page.url()};
    const input=form.getByPlaceholder("Type tag name and press enter to add tag");
    await input.fill(label);await input.press("Enter");
  }
  return submitForm(b,form,form.getByRole("button",{name:"Save",exact:true}));
}

export async function pending(b:Browser,target:string,pendingId:string,action:"approve"|"dismiss"):Promise<unknown> {
  await adminPage(b,target,"pending-posts");
  const matching=b.page.locator("form").filter({has:b.page.locator(`input[name="pending_post_id"][value="${id(pendingId)}"]`)});
  if(action==="approve") return submitForm(b,await one(matching.filter({has:b.page.locator('input[name="action"][value="promote_post"]')}),"pending post approval form"));
  const row=await one(matching.first().locator("xpath=ancestor::*[contains(@class,'community_pending_post_widget')][1]"),"pending post");
  await clickNamed(row,/^Dismiss\.\.\.$/);
  // Default dismissal preserves the site's unchecked spam-report and ban options.
  return submitForm(b,await one(b.page.locator(".lightbox form").filter({has:b.page.locator(`input[name="pending_post_id"][value="${pendingId}"]`)}),"pending post dismissal form"));
}

export interface Category {id:string;title:string;description:string;parentId:string|null;archived:boolean;hidden:boolean;directory:boolean;}
async function categoryData(b:Browser):Promise<Category[]> {
  return b.page.locator('form.edit_categories .category_row').evaluateAll(rows=>rows.map(row=>{
    const own=(selector:string)=>[...row.querySelectorAll<HTMLInputElement>(selector)].find(e=>e.closest('.category_row')===row);
    const parent=row.parentElement?.closest('.category_row');
    return {id:own('input[name$="[id]"]')?.value??'',title:own('.title_input')?.value??'',description:own('.short_description_input')?.value??'',parentId:parent?.querySelector<HTMLInputElement>('input[name$="[id]"]')?.value??null,archived:own('input[name$="[archived]"]')?.checked??false,hidden:own('input[name$="[hidden]"]')?.checked??false,directory:own('input[name$="[directory]"]')?.checked??false};
  }));
}
async function categoryRow(b:Browser,categoryId:string) {
  const input=b.page.locator(`form.edit_categories input[name$="[id]"][value="${id(categoryId)}"]`);
  if(await input.count()!==1)throw new ClientError("Category not found.","NOT_FOUND");
  return input.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," category_row ")][1]');
}
export async function categories(b:Browser,target:string) {await adminPage(b,target,"edit-children");return categoryData(b);}
export async function editCategory(b:Browser,target:string,categoryId:string,fields:Partial<Omit<Category,"id"|"parentId">>) {
  if(!Object.keys(fields).length)throw new ClientError("Provide category fields.","INVALID_ARGUMENT");
  for(const [key,value] of Object.entries(fields))if(!['title','description','archived','hidden','directory'].includes(key)||(['title','description'].includes(key)?typeof value!=="string":typeof value!=="boolean"))throw new ClientError("Invalid category field.","INVALID_ARGUMENT");
  if(fields.title!==undefined&&!fields.title.trim())throw new ClientError("Title cannot be empty.","INVALID_ARGUMENT");
  await adminPage(b,target,"edit-children");const row=await categoryRow(b,categoryId);
  if(fields.title!==undefined)await row.locator('.title_input').first().fill(fields.title);
  if(fields.description!==undefined)await row.locator('.short_description_input').first().fill(fields.description);
  for(const key of ['archived','hidden','directory'] as const)if(fields[key]!==undefined)await row.locator(`input[name$="[${key}]"]`).first().setChecked(fields[key]);
  const form=b.page.locator('form.edit_categories');await submitForm(b,form,form.getByRole('button',{name:'Save',exact:true}));
  await adminPage(b,target,"edit-children");const saved=(await categoryData(b)).find(c=>c.id===categoryId);
  if(!saved||Object.entries(fields).some(([k,v])=>saved[k as keyof Category]!==v))throw new WriteUncertain("Category save was not confirmed by readback.");
  return {status:"saved",category:saved};
}
export async function moveCategory(b:Browser,target:string,categoryId:string,direction:"up"|"down") {
  if(!['up','down'].includes(direction))throw new ClientError("Direction must be up or down.","INVALID_ARGUMENT");
  await adminPage(b,target,"edit-children");const before=await categoryData(b);const row=await categoryRow(b,categoryId);
  const button=row.locator(`.move_${direction}_btn`).first();if(!await button.count())return {status:"unchanged",id:categoryId};
  await button.click();const form=b.page.locator('form.edit_categories');await submitForm(b,form,form.getByRole('button',{name:'Save',exact:true}));
  await adminPage(b,target,"edit-children");const after=await categoryData(b);
  if(before.map(c=>c.id).join()===after.map(c=>c.id).join())throw new WriteUncertain("Category order did not change after saving.");
  return {status:"saved",categories:after};
}
export async function deleteCategory(b:Browser,target:string,categoryId:string) {
  await adminPage(b,target,"edit-children");const row=await categoryRow(b,categoryId);
  b.page.removeAllListeners('dialog');b.page.once('dialog',d=>{void(d.message()==='Are you sure you want to remove?'?d.accept():d.dismiss());});
  await row.locator('.remove_btn').first().click();const form=b.page.locator('form.edit_categories');await submitForm(b,form,form.getByRole('button',{name:'Save',exact:true}));
  await adminPage(b,target,"edit-children");if((await categoryData(b)).some(c=>c.id===categoryId))throw new WriteUncertain("Category deletion was not confirmed.");return {status:"deleted",id:categoryId};
}

/** Use the administration page's actual row and action, including its CSRF fields. */
export async function administrationAction(b:Browser,target:string,section:"moderators"|"bans"|"reports",identifier:string,action:"remove"|"resolve"|"ignore") {
  if(!/^[\w-]+$/.test(identifier))throw new ClientError("Use a username or numeric record ID.","INVALID_ARGUMENT");
  if(section==='reports'?!['resolve','ignore'].includes(action):action!=='remove')throw new ClientError("Invalid administration action.","INVALID_ARGUMENT");
  await adminPage(b,target,section);
  const rows=b.page.locator('tr,.report_row,.moderator_row,.ban_row');
  const matched=await rows.evaluateAll((rows,identifier)=>rows.map((row,index)=>({index,match:[...row.querySelectorAll('input')].some(e=>e.value===identifier&&/(?:^|_)(?:id|user|username)|\[id\]$/.test(e.name))||[...row.querySelectorAll('a[href]')].some(e=>{const u=new URL((e as HTMLAnchorElement).href);return u.pathname===`/profile/${identifier}`||u.hostname===`${identifier}.itch.io`;})||row.getAttribute('data-id')===identifier})).filter(r=>r.match).map(r=>r.index),identifier);
  if(matched.length!==1)throw new UiChanged(`Expected one ${section} row matching ${identifier}, found ${matched.length}.`);
  const row=rows.nth(matched[0]!);const name=action==='remove'?/^(Remove(?: moderator| ban)?|Revoke|Unban)$/i:action==='resolve'?/^(Resolve|Mark (?:as )?resolved)$/i:/^(Ignore|Dismiss)$/i;
  const control=await one(row.getByRole('button',{name}).or(row.getByRole('link',{name})),`${action} control`);
  const form=control.locator('xpath=ancestor::form[1]');
  b.page.removeAllListeners('dialog');b.page.once('dialog',d=>{void(/^Are you sure/i.test(d.message())&&!/delete|purge/i.test(d.message())?d.accept():d.dismiss());});
  if(await form.count())return submitForm(b,form,control);
  const href=await control.getAttribute('data-url')||await control.getAttribute('data-href')||await control.getAttribute('href');
  if(!href||href==='#')throw new UiChanged("The administration control has no inspectable endpoint.");
  const endpoint=new URL(siteURL(new URL(href,b.page.url()).href));
  const result=await captureWrite(b,u=>u.origin===endpoint.origin&&u.pathname===endpoint.pathname,()=>control.click());
  if(result.status>=400||result.data?.errors?.length)throw new ClientError("The administration action was rejected.","WRITE_REJECTED");
  return {status:"submitted",section,identifier,action};
}

export const devlogTypes=['general_update','major_update','postmortem','tech_discussion','culture','tutorial','game_design','marketing'] as const;
export interface DevlogOptions {title:string;text:string;type?:typeof devlogTypes[number];published?:boolean;comments?:boolean;}
export async function devlogs(b:Browser,gameId:string) {
  await b.goto(`/dashboard/game/${id(gameId)}/devlog`);
  return {url:b.page.url(),text:await b.page.locator('.main').innerText(),links:await b.page.locator('.main a[href]').evaluateAll(as=>as.map(a=>({title:a.textContent?.trim(),url:(a as HTMLAnchorElement).href})))};
}
async function saveDevlog(b:Browser,options:Partial<DevlogOptions>) {
  if(options.title!==undefined&&!options.title.trim()||options.text!==undefined&&!options.text.trim())throw new ClientError("Title and text cannot be empty.","INVALID_ARGUMENT");
  if(options.type!==undefined&&!devlogTypes.includes(options.type))throw new ClientError("Invalid devlog post type.","INVALID_ARGUMENT");
  const form=await one(b.page.locator('form').filter({has:b.page.locator('input[name="post[title]"]')}),'devlog form');
  const fields:Record<string,string|boolean>={};
  for(const [option,name] of [['title','title'],['text','body'],['type','user_classification'],['published','published'],['comments','enable_comments']] as const)if(options[option]!==undefined)fields[`post[${name}]`]=options[option]!;
  await setFields(form,fields);
  return submitForm(b,form,form.getByRole('button',{name:'Save',exact:true}));
}
export async function devlog(b:Browser,gameId:string,options:DevlogOptions) {
  id(gameId);if(!options.title.trim()||!options.text.trim())throw new ClientError("Title and text are required.","INVALID_ARGUMENT");
  await b.goto(`/dashboard/game/${gameId}/new-devlog`);
  return saveDevlog(b,{type:'general_update',published:false,...options});
}
export async function editDevlog(b:Browser,editorURL:string,options:Partial<DevlogOptions>) {
  const url=siteURL(editorURL);
  if(!/^\/dashboard\/post\/\d+\/edit$/.test(new URL(url).pathname))throw new ClientError("Use the Edit URL returned by devlogs.","INVALID_TARGET");
  if(!Object.values(options).some(v=>v!==undefined))throw new ClientError("Provide a devlog field to edit.","INVALID_ARGUMENT");
  await b.goto(url);return saveDevlog(b,options);
}
export async function deleteDevlog(b:Browser,postId:string) {
  await b.goto(`/dashboard/post/${id(postId)}/edit`);
  const button=await one(b.page.locator('.delete_post_btn[data-url]'),'delete devlog control');
  const endpoint=new URL(siteURL((await button.getAttribute('data-url'))!));
  const back=await b.page.locator('a[href^="/dashboard/game/"][href$="/devlog"]').getAttribute('href');
  b.page.removeAllListeners('dialog');b.page.once('dialog',d=>{void(d.message()==='Are you sure you want to delete this post?'?d.accept():d.dismiss());});
  const result=await captureWrite(b,u=>u.origin===endpoint.origin&&u.pathname===endpoint.pathname,()=>button.click());
  if(result.status>=400||result.data?.errors?.length)throw new ClientError('Devlog deletion rejected.','WRITE_REJECTED');
  if(!back)throw new WriteUncertain('Could not find the devlog list to verify deletion.');
  await b.page.waitForURL(u=>u.pathname===new URL(back,'https://itch.io').pathname);
  await b.page.waitForLoadState('domcontentloaded');await b.guard();
  if(await b.page.locator(`a[href="/dashboard/post/${postId}/edit"]`).count())throw new WriteUncertain('Deleted devlog is still listed.');
  return {status:'deleted',id:postId};
}
