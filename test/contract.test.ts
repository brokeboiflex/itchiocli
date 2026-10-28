import { describe, test, expect } from "bun:test";
import { createHash, createCipheriv, pbkdf2Sync } from "node:crypto";
import { loadState, serviceHost } from "../src/cookies.ts";
import { decryptValue, chromeTimeToUnix } from "../src/browser-cookies.ts";
import { siteURL } from "../src/browser.ts";
import { DOMAIN, NAME } from "../src/config.ts";
import { buildParser } from "../src/cli.ts";
import { parseArgs } from "../src/argparse.ts";
import { commands } from "../src/commands.ts";

function cli(...args:string[]) {
  return Bun.spawnSync([process.execPath, `${NAME}.ts`, ...args], {cwd:import.meta.dir+"/..",stdout:"pipe",stderr:"pipe"});
}

describe("fbcli command contract",()=>{
  test("offline schema matches executable commands",()=>{
    const result=cli("describe","--compact");
    expect(result.exitCode).toBe(0);
    const doc=JSON.parse(result.stdout.toString());
    expect(doc.commands.map((c:any)=>c.name)).toEqual([...commands.map(c=>c.name),"login"]);
    expect(doc.commands.every((c:any)=>typeof c.mutates==="boolean")).toBe(true);
  });
  test("global flags work on either side of a command",()=>{
    const args=parseArgs(buildParser(),["--compact","whoami","--cookies","brave:Default"]);
    expect(args.cookies).toBe("brave:Default");expect(args.compact).toBe(true);
  });
  test("dry run requires neither credentials nor a browser and redacts credentials",()=>{
    const result=cli("whoami","--dry-run","--cookies","session=private-value","--browser-path","/not/a/browser","--compact");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).dryRun).toBe(true);
    expect(result.stdout.toString()).not.toContain("private-value");
  });
  test("unknown commands fail with usage exit 2",()=>expect(cli("missing").exitCode).toBe(2));
  test("unknown describe target fails",()=>expect(cli("describe","missing").exitCode).toBe(2));
});

describe("session isolation",()=>{
  test("only exact service domains and subdomains are accepted",()=>{
    expect(serviceHost(DOMAIN)).toBe(true);expect(serviceHost(`sub.${DOMAIN}`)).toBe(true);
    expect(serviceHost(`${DOMAIN}.evil.invalid`)).toBe(false);expect(serviceHost(`fake${DOMAIN}`)).toBe(false);
    for(const url of [`http://${DOMAIN}`,`https://${DOMAIN}.evil.invalid`,`https://u:p@${DOMAIN}`,`https://${DOMAIN}:444`])expect(()=>siteURL(url)).toThrow();
  });
  test("Playwright storage state keeps only service cookies and origins",()=>{
    const result=loadState(JSON.stringify({cookies:[{name:"session",value:"opaque",domain:`.${DOMAIN}`,expirationDate:2000000000,sameSite:"no_restriction"},{name:"foreign",value:"private",domain:"evil.invalid"}],origins:[{origin:`https://${DOMAIN}`,localStorage:[]},{origin:"https://evil.invalid",localStorage:[]}]}));
    expect(result.cookies).toHaveLength(1);expect(result.origins).toHaveLength(1);
    expect(result.cookies[0]?.expires).toBe(2000000000);expect(result.cookies[0]?.sameSite).toBe("None");
  });
  test("Netscape HttpOnly cookies and values containing equals survive",()=>{
    const result=loadState(`# Netscape HTTP Cookie File\n#HttpOnly_.${DOMAIN}\tTRUE\t/\tTRUE\t2000000000\tsession\ta=b=c`);
    expect(result.cookies[0]?.httpOnly).toBe(true);expect(result.cookies[0]?.value).toBe("a=b=c");
    expect(loadState("session=a=b=c").cookies[0]?.value).toBe("a=b=c");
  });
  test("a foreign cookie export cannot silently produce a logged-out session",()=>{
    expect(()=>loadState(JSON.stringify([{name:"session",value:"secret",domain:"evil.invalid"}]))).toThrow();
  });
  test("Chromium domain-bound cookie decryption and epoch conversion",()=>{
    const key=pbkdf2Sync("test-password","saltysalt",1003,16,"sha1");
    const cipher=createCipheriv("aes-128-cbc",key,Buffer.alloc(16," "));
    const plaintext=Buffer.concat([createHash("sha256").update(`.${DOMAIN}`).digest(),Buffer.from("test-session")]);
    const encrypted=Buffer.concat([Buffer.from("v10"),cipher.update(plaintext),cipher.final()]);
    expect(decryptValue(encrypted,key,`.${DOMAIN}`)).toBe("test-session");
    expect(chromeTimeToUnix(0)).toBeUndefined();
    expect(chromeTimeToUnix((1700000000+11644473600)*1000000)).toBe(1700000000);
  });
});
