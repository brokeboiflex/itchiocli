import {statSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Browser} from './browser.ts';
import {id,submitForm} from './web-actions.ts';
import {one} from './ui.ts';
import {ClientError,WriteUncertain} from './errors.ts';
export interface Attachment {index:number;type:string;objectId?:string;attachmentId?:string;url?:string;title:string;}
export async function selectedAttachments(b:Browser):Promise<Attachment[]> {
  return b.page.locator('.attachment_picker .selected_attachments input[name^="attachment["]').evaluateAll(inputs=>{
    const values=new Map<number,Record<string,string>>();
    for(const input of inputs as HTMLInputElement[]){const match=/^attachment\[(\d+)\]\[(\w+)\]$/.exec(input.name);if(!match)continue;const index=Number(match[1]);const value=values.get(index)??{};value[match[2]!]=input.value;value.title=input.closest('li')?.querySelector('.attachment_title')?.textContent?.trim()??'';values.set(index,value);}
    return [...values].sort((a,b)=>a[0]-b[0]).map(([index,v])=>({index,type:v.object_type??v.type??'',objectId:v.object_id,attachmentId:v.attachment_id,url:v.url,title:v.title??''}));
  });
}
async function open(b:Browser,postId:string){await b.goto(`/dashboard/post/${id(postId)}/edit`);await one(b.page.locator('.attachment_picker'),'devlog attachment picker');}
async function available(b:Browser,tab:'Files'|'Images'){
  const picker=b.page.locator('.attachment_picker');await picker.getByRole('button',{name:tab,exact:true}).click();
  return picker.locator('.object_picker li').evaluateAll(rows=>rows.map((row,index)=>({index:index+1,title:row.querySelector('.object_title')?.textContent?.trim()??'',version:row.querySelector('.title_tag')?.textContent?.trim()??'',image:row.classList.contains('image_preview'),imageUrl:row.classList.contains('image_preview')?(row as HTMLElement).style.backgroundImage.replace(/^url\(["']?|["']?\)$/g,''):undefined})));
}
export async function devlogAttachments(b:Browser,postId:string){await open(b,postId);return {selected:await selectedAttachments(b),files:await available(b,'Files'),images:await available(b,'Images')};}
export type AddAttachment={kind:'file'|'existing-image';index:number}|{kind:'image';path:string}|{kind:'video';url:string};
export function validateAttachment(input:AddAttachment){
  if(input.kind==='file'||input.kind==='existing-image'){if(!Number.isSafeInteger(input.index)||input.index<1)throw new ClientError('Use a positive index returned by devlog-attachments.','INVALID_ARGUMENT');}
  else if(input.kind==='image'){if(!statSync(input.path).isFile())throw new ClientError('Use a local image file.','INVALID_ARGUMENT');}
  else if(input.kind==='video'){const url=new URL(input.url);if(url.protocol!=='https:'||url.username||url.password||!/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|sketchfab\.com)$/.test(url.hostname))throw new ClientError('Use an HTTPS YouTube, Vimeo or Sketchfab URL.','INVALID_ARGUMENT');}
  else throw new ClientError('Unsupported attachment kind.','INVALID_ARGUMENT');
}
function fingerprint(items:Attachment[]){return items.map(a=>`${a.type}:${a.objectId??a.url}`).join('|');}
async function save(b:Browser,postId:string,expected:Attachment[]){
  const form=await one(b.page.locator('form').filter({has:b.page.locator('input[name="post[title]"]')}),'devlog form');
  await submitForm(b,form,form.getByRole('button',{name:'Save',exact:true}));await open(b,postId);
  const saved=await selectedAttachments(b);if(fingerprint(saved)!==fingerprint(expected))throw new WriteUncertain('Devlog attachment readback did not match. Inspect devlog-attachments before retrying.');
  return {status:'saved',postId,attachments:saved};
}
export async function attachDevlog(b:Browser,postId:string,input:AddAttachment){
  validateAttachment(input);await open(b,postId);const picker=b.page.locator('.attachment_picker'),before=await selectedAttachments(b);
  if(input.kind==='file'||input.kind==='existing-image'){
    const list=await available(b,input.kind==='file'?'Files':'Images');if(input.index>list.length)throw new ClientError('Attachment index is no longer available. Read devlog-attachments again.','NOT_FOUND');
    const row=picker.locator('.object_picker li').nth(input.index-1);if(input.kind==='existing-image')await row.hover();await row.getByRole('button',{name:'Attach',exact:true}).click();
  } else if(input.kind==='video'){
    await picker.getByRole('button',{name:'Video',exact:true}).click();await picker.locator('.video_link_input input').fill(input.url);await picker.getByRole('button',{name:'Add video',exact:true}).click();
  } else if(input.kind==='image') {
    await picker.getByRole('button',{name:'Upload image',exact:true}).click();
    const chooser=b.page.waitForEvent('filechooser');await picker.getByRole('button',{name:'Select images',exact:true}).click();await (await chooser).setFiles(resolve(input.path));
    // The native widget adds a selected image only after its upload response.
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){
      const error=picker.locator('.form_errors,.error_message');if(await error.count()&&await error.first().isVisible())throw new ClientError((await error.allTextContents()).join(' '),'UPLOAD_FAILED');
      if((await selectedAttachments(b)).length>before.length&&await picker.getByRole('button',{name:'Select images',exact:true}).isEnabled())break;
      await b.page.waitForTimeout(250);
    }
  }
  const expected=await selectedAttachments(b);
  if(expected.length!==before.length+1){const error=await picker.locator('.error_message,.form_errors').allTextContents();throw new ClientError(error.join(' ')||'The site did not add the attachment.','UPLOAD_FAILED');}
  return save(b,postId,expected);
}
export async function changeDevlogAttachment(b:Browser,postId:string,index:number,action:'remove'|'up'|'down'){
  if(!Number.isSafeInteger(index)||index<1||!['remove','up','down'].includes(action))throw new ClientError('Use a positive attachment index and remove, up or down.','INVALID_ARGUMENT');
  await open(b,postId);const before=await selectedAttachments(b),attachment=before.find(a=>a.index===index);
  if(!attachment)throw new ClientError('Attachment not found.','NOT_FOUND');
  const input=b.page.locator(`.selected_attachments input[name="attachment[${index}][${attachment.type==='video_link'?'url':'object_id'}]"]`),row=input.locator('xpath=ancestor::li[1]');
  if(attachment.type==='image')await row.hover();
  if(action==='remove')await row.getByRole('button',{name:'Remove',exact:true}).click();
  else {const label=attachment.type==='image'?(action==='up'?'left':'right'):action,link=row.getByRole('link',{name:label,exact:true});if(!await link.count())return {status:'unchanged',postId,attachments:before};await link.click();}
  const expected=await selectedAttachments(b);return save(b,postId,expected);
}
