import {beforeAll,afterAll,test,expect} from "bun:test";
import {chromium,type Browser as Engine,type Page} from "playwright-core";
import type {Browser} from "../src/browser.ts";
import {comments,forms,setFields,deleteComment,categories,administrationAction} from "../src/web-actions.ts";

// Offline fixtures transcribed from authenticated itch.io markup, 2026-10-28.
// Use the documented browser setting; these tests never import account cookies.
const browserTest=process.env.ITCHIOCLI_BROWSER ? test : test.skip;
let engine:Engine,page:Page;
beforeAll(async()=>{
  if(!process.env.ITCHIOCLI_BROWSER)return;
  engine=await chromium.launch({executablePath:process.env.ITCHIOCLI_BROWSER});
  page=await engine.newPage();
  await page.route("**/*",route=>route.abort());
},30000);
afterAll(async()=>{await engine?.close();},30000);
const client=()=>({page,goto:async()=>{}} as unknown as Browser);

browserTest("replies use the site's sibling container; moderation events are not comments",async()=>{
  await page.setContent(`<base href="https://itch.io/t/123/fixture"><div class="community_post_list_widget">
    <div class="community_post has_replies" id="post-101"><div class="post_author">alice</div><div class="post_body">Parent</div></div>
    <div class="community_post_replies top_level_replies"><div class="community_post is_reply" id="post-102"><div class="post_author">bob</div><div class="post_body">Reply</div></div></div>
    <div class="community_post moderation_event" id="post-103">alice locked this topic</div>
  </div>`);
  const items=await comments(client(),"https://itch.io/t/123/fixture");
  expect(items.map(c=>({id:c.id,text:c.text,parentId:c.parentId}))).toEqual([
    {id:"101",text:"Parent",parentId:null},{id:"102",text:"Reply",parentId:"101"},
  ]);
});

browserTest("comment deletion refuses the first post's Delete topic control",async()=>{
  await page.setContent('<div class="community_post" id="post-101"><a class="delete_post_btn" href="#">Delete topic</a></div>');
  await expect(deleteComment(client(),"https://itch.io/t/123/fixture","101")).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});

browserTest("settings address radio values and the named Redactor editor",async()=>{
  await page.setContent(`<form>
    <input type="radio" name="category[type]" value="post_list" checked><input type="radio" name="category[type]" value="directory">
    <div class="redactor-box"><div contenteditable="true">Description</div><textarea hidden name="category[description]">Description</textarea></div>
    <div class="redactor-box"><div contenteditable="true">Rules</div><textarea hidden name="category[rules]">Rules</textarea></div>
    <input type="hidden" name="csrf_token" value="fixture-only">
  </form>`);
  await setFields(page.locator("form"),{"category[type]":"directory","category[rules]":"Revised rules"});
  expect(await page.locator('input[value="directory"]').isChecked()).toBe(true);
  expect(await page.locator('[contenteditable="true"]').allTextContents()).toEqual(["Description","Revised rules"]);
  await expect(setFields(page.locator("form"),{csrf_token:"replacement"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});

browserTest("form metadata hides CSRF and handles a control named action",async()=>{
  await page.setContent(`<form action="https://itch.io/category/123/moderators" method="post">
    <input type="hidden" name="csrf_token" value="fixture-secret"><input name="username"><button name="action" value="add_moderator">Add moderator</button>
  </form>`);
  const result=await forms(client(),"https://itch.io/category/123/moderators") as any[];
  expect(result[0].action).toBe("https://itch.io/category/123/moderators");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

browserTest("nested categories keep their own IDs, titles, and flags",async()=>{
  await page.setContent(`<base href="https://itch.io"><a href="/category/1/edit-children">Categories</a><form class="edit_categories">
    <div class="category_row"><input type="hidden" name="categories[1][id]" value="10"><input class="title_input" value="Parent"><input class="short_description_input" value="Directory"><input type="checkbox" name="categories[1][directory]" checked>
      <div class="children"><div class="category_row"><input type="hidden" name="categories[1][children][1][id]" value="11"><input class="title_input" value="Child"><input class="short_description_input" value="Nested"><input type="checkbox" name="categories[1][children][1][hidden]" checked></div></div>
    </div></form>`);
  expect(await categories(client(),'https://itch.io/category/1/edit-children')).toEqual([
    {id:'10',title:'Parent',description:'Directory',parentId:null,archived:false,hidden:false,directory:true},
    {id:'11',title:'Child',description:'Nested',parentId:'10',archived:false,hidden:true,directory:false},
  ]);
});
browserTest("administration writes refuse ambiguous user rows before clicking",async()=>{
  await page.setContent(`<base href="https://itch.io"><a href="/category/1/bans">Bans</a><table><tr><td><a href="/profile/example">example</a><button>Unban</button></td></tr><tr><td><a href="/profile/example">example</a><button>Unban</button></td></tr></table>`);
  await expect(administrationAction(client(),'https://itch.io/category/1/bans','bans','example','remove')).rejects.toMatchObject({code:'UI_CHANGED'});
});
