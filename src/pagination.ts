import type {Browser} from './browser.ts';
import {siteURL} from './browser.ts';
import {ClientError,UiChanged} from './errors.ts';
import {countLimit} from './ui.ts';
export interface PageOptions {cursor?:string;all?:boolean;}
export function resume(cursor:string,root:string):{url:string;offset:number}{
  try{if(cursor.length>16000)throw Error();const value=JSON.parse(Buffer.from(cursor,'base64url').toString());const url=new URL(siteURL(value.url)),base=new URL(siteURL(root));if(url.origin!==base.origin||url.pathname!==base.pathname||!Number.isSafeInteger(value.offset)||value.offset<0)throw Error();return {url:url.href,offset:value.offset};}
  catch{throw new ClientError('Invalid cursor for this page.','INVALID_ARGUMENT');}
}
export async function nextPage(b:Browser):Promise<string|null>{
  const links=await b.page.locator('a.forward_link,a.next_page,a[rel="next"]').evaluateAll(as=>[...new Set(as.map(a=>(a as HTMLAnchorElement).href))]);
  if(links.length>1)throw new UiChanged('Multiple next-page destinations found.');
  if(!links.length)return null;
  const url=new URL(siteURL(links[0]!)),current=new URL(b.page.url());
  if(url.origin!==current.origin||url.pathname!==current.pathname)throw new UiChanged('Pagination left the current list.');
  return url.href;
}
/** Caller opens the root first, resolving any canonical redirect before validating cursors. */
export async function collectPages<T>(b:Browser,limit:number,options:PageOptions,read:()=>Promise<T[]>) {
  countLimit(limit);const root=b.page.url(),start=options.cursor?resume(options.cursor,root):{url:root,offset:0};
  let {url,offset}=start;const items:T[]=[],seen=new Set<string>();let cursor:string|null=null;
  if(options.cursor)await b.goto(url);
  while(true){
    if(seen.has(url))throw new UiChanged('The site returned a pagination cycle.');seen.add(url);
    const rows=await read();if(offset>rows.length)throw new UiChanged('The list changed while resuming. Restart the list.');
    const take=options.all?rows.length-offset:Math.min(rows.length-offset,limit-items.length);items.push(...rows.slice(offset,offset+take));offset+=take;
    const next=offset<rows.length?{url,offset}:await nextPage(b).then(url=>url?{url,offset:0}:null);
    if(!next)break;
    if(!options.all&&items.length>=limit){cursor=Buffer.from(JSON.stringify(next)).toString('base64url');break;}
    url=next.url;offset=next.offset;await b.goto(url);
  }
  return {items,cursor,next:cursor,url:root};
}
