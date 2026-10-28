import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameURL, id } from "../src/web-actions.ts";
import { upload, validateUpload } from "../src/butler.ts";

test("game shorthand and comment IDs are validated",()=>{
  expect(gameURL("itchio/butler")).toBe("https://itchio.itch.io/butler");
  expect(()=>gameURL("https://itch.io.evil.invalid/game")).toThrow();
  expect(()=>id('1"]')).toThrow();
});
test("noninteractive comments require confirmation before opening a browser",()=>{
  const result=Bun.spawnSync([process.execPath,"itchiocli.ts","comment","itchio/butler","hello","--browser-path","/missing"],{cwd:import.meta.dir+"/.."});
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr.toString()).error.code).toBe("CONFIRMATION_REQUIRED");
});
test("invalid moderation is rejected even in dry run",()=>{
  const result=Bun.spawnSync([process.execPath,"itchiocli.ts","moderate","https://itch.io/t/1/topic","purge-all","--dry-run"],{cwd:import.meta.dir+"/.."});
  expect(result.exitCode).toBe(2);
});
test("butler receives literal argv and official push syntax without a shell",async()=>{
  const root=mkdtempSync(join(tmpdir(),"itchiocli-butler-test-"));
  try{
    const binary=join(root,"butler"),build=join(root,"build.zip"),receipt=join(root,"argv.json");
    writeFileSync(build,"fixture");
    writeFileSync(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(binary,0o755);
    const version="1.0; echo should-not-execute";
    expect(()=>validateUpload(build,"owner/game")).toThrow();
    await upload(build,"owner/game:linux",{executable:binary,version});
    expect(JSON.parse(readFileSync(receipt,"utf8"))).toEqual(["push",build,"owner/game:linux","--userversion",version]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("topic creation rejects an empty title before any browser or write",()=>{
  const result=Bun.spawnSync([process.execPath,"itchiocli.ts","topic","https://itch.io/category/123/new-topic","","body","--dry-run"],{cwd:import.meta.dir+"/.."});
  expect(result.exitCode).toBe(2);
});
test("pending moderation does not expose destructive spam or account actions implicitly",()=>{
  const result=Bun.spawnSync([process.execPath,"itchiocli.ts","pending","https://itch.io/category/123/pending-posts","42","spam","--dry-run"],{cwd:import.meta.dir+"/.."});
  expect(result.exitCode).toBe(2);
});

test("unverified itch email has a machine-readable upload error",async()=>{
  const {uploadFailure}=await import('../src/butler.ts');
  expect(uploadFailure("itch.io API error (400): Please verify your account's email address before uploading a build",1,null)).toMatchObject({code:'EMAIL_VERIFICATION_REQUIRED'});
  expect(uploadFailure('permission denied',1,null)).toMatchObject({code:'UPLOAD_FAILED'});
});

test("butler email rejection reaches the CLI wrapper as a specific error",async()=>{
  const root=mkdtempSync(join(tmpdir(),"itchiocli-email-test-"));
  try{
    const binary=join(root,"butler"),build=join(root,"build.txt");writeFileSync(build,"test");
    writeFileSync(binary,`#!${process.execPath}\nconsole.error("Please verify your account's email address before uploading a build");process.exit(1);\n`);chmodSync(binary,0o755);
    await expect(upload(build,"owner/game:test",{executable:binary})).rejects.toMatchObject({code:"EMAIL_VERIFICATION_REQUIRED"});
  }finally{rmSync(root,{recursive:true,force:true});}
});
