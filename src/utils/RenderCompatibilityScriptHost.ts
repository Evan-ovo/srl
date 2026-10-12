import { isRecord } from './UnknownValue'

/** Inputs are the selected card and already-read regex sources, never a library-wide scan. */
export interface PreviewScriptHostContext {
  worldbooks: Record<string, unknown[]>
  characterWorldbooks: { primary: string | null; additional: string[] }
  regexes: { global: unknown[]; preset: unknown[]; character: unknown[] }
}

export function archivedScriptHostContext(
  card: unknown,
  regexes: PreviewScriptHostContext['regexes'],
): PreviewScriptHostContext {
  const root = isRecord(card) && isRecord(card.data) ? card.data : isRecord(card) ? card : {}
  const book = isRecord(root.character_book) ? root.character_book : undefined
  const embeddedName =
    book && Array.isArray(book.entries) ? String(book.name || root.name || '卡内世界书') : null
  const extensions = isRecord(root.extensions) ? root.extensions : {}
  const primary =
    embeddedName ??
    (typeof extensions.world === 'string' && extensions.world ? extensions.world : null)
  return {
    worldbooks: embeddedName && book ? { [embeddedName]: book.entries as unknown[] } : {},
    characterWorldbooks: { primary, additional: [] },
    regexes,
  }
}

/** Runs inside the existing opaque host, sharing its event owner and teardown. */
export function buildRenderCompatibilityScriptHost(): string {
  return `
const scriptRegistry=new Map();
const buttonEvent=(id,name)=>'script_button_'+id+'_'+name;
const publishButtons=()=>parent.postMessage({protocol,type:'SRL_SCRIPT_BUTTONS',floor:archived?.message_id??0,scripts:[...scriptRegistry.values()].map(item=>({id:item.id,name:item.name,buttons:clone(item.buttons)}))},'*');
const requireScript=meta=>{const item=scriptRegistry.get(String(meta.scriptId||''));if(!item)throw new Error('Script controls require a script iframe');return item};
const normalizeButtons=value=>{if(!Array.isArray(value))throw new TypeError('Script buttons must be an array');const seen=new Set();return value.flatMap(item=>{const name=typeof item==='string'?item:item?.name;if(typeof name!=='string'||!name.trim()||seen.has(name))return[];seen.add(name);return[{name,visible:typeof item==='string'||item.visible===true}]})};
const registerScript=meta=>{if(!meta.scriptId)return;const id=String(meta.scriptId);if(!scriptRegistry.has(id)){scriptRegistry.set(id,{id,name:String(meta.scriptName||id),info:String(meta.scriptInfo||''),buttons:normalizeButtons(meta.scriptButtons||[])});publishButtons()}};
const setButtons=(meta,buttons)=>{const item=requireScript(meta);item.buttons=normalizeButtons(buttons);publishButtons();return clone(item.buttons)};
const inputHost=context.scriptHost;
const books=new Map(Object.entries(inputHost?.worldbooks||{}).map(([name,entries])=>[name,clone(entries)]));
const charBooks=clone(inputHost?.characterWorldbooks||{primary:null,additional:[]});
const regexes=clone(inputHost?.regexes||{global:[],preset:[],character:[]});
const normalizeEntry=(entry,uid)=>{const old=entry.extensions||{};return{...clone(entry),uid,name:String(entry.name??entry.comment??old.name??''),enabled:entry.enabled!==false,content:String(entry.content??''),strategy:entry.strategy||{type:entry.constant?'constant':'selective',keys:entry.keys||[],keys_secondary:{logic:'and_any',keys:entry.secondary_keys||[]},scan_depth:'same_as_global'},position:typeof entry.position==='object'?entry.position:{type:entry.position==='before_char'?'before_character_definition':'after_character_definition',order:entry.insertion_order??100,role:'system',depth:0},probability:entry.probability??100,recursion:entry.recursion||{prevent_incoming:false,prevent_outgoing:false,delay_until:null},effect:entry.effect||{sticky:null,cooldown:null,delay:null}}};
for(const [name,entries] of books)books.set(name,entries.map((entry,index)=>normalizeEntry(entry,Number.isSafeInteger(entry.uid)?entry.uid:Number.isSafeInteger(entry.id)?entry.id:index)));
const requireBook=name=>{const key=String(name);if(!books.has(key))throw new Error('Worldbook snapshot is unavailable: '+key);return books.get(key)};
const sessionWrite=capability=>touch(capability,{implementationStatus:'PARTIAL',parityStatus:'UNVERIFIED',source:'preview-session',impact:'changes exist only in this isolated reading session; original resources are unchanged'});
const replaceBook=(name,entries)=>{requireBook(name);if(!Array.isArray(entries))throw new TypeError('Worldbook entries must be an array');const used=new Set();let next=Math.max(-1,...entries.filter(e=>Number.isSafeInteger(e.uid)).map(e=>e.uid))+1;const normalized=entries.map(entry=>{const uid=Number.isSafeInteger(entry.uid)?entry.uid:next++;if(used.has(uid))throw new Error('Duplicate worldbook uid');used.add(uid);return normalizeEntry(entry,uid)});books.set(String(name),normalized);sessionWrite('worldbook.session');return clone(normalized)};
const regexScope=options=>{const scope=options?.type??options?.scope??'all';if(!['all','global','preset','character'].includes(scope))throw new TypeError('Invalid regex scope');return scope};
const normalizeRegex=(rule,index,scope)=>({...clone(rule),id:String(rule.id??scope+'-'+index),script_name:String(rule.script_name??rule.scriptName??rule.name??''),enabled:rule.enabled??!rule.disabled,scope,find_regex:String(rule.find_regex??rule.findRegex??''),replace_string:String(rule.replace_string??rule.replaceString??''),trim_strings:rule.trim_strings??rule.trimStrings??[],source:rule.source??{user_input:rule.placement?.includes(1)===true,ai_output:rule.placement?.includes(2)===true,slash_command:rule.placement?.includes(3)===true,world_info:rule.placement?.includes(5)===true,reasoning:false},destination:rule.destination??{display:rule.markdownOnly===true,prompt:rule.promptOnly===true},run_on_edit:rule.run_on_edit??rule.runOnEdit??false,min_depth:rule.min_depth??rule.minDepth??null,max_depth:rule.max_depth??rule.maxDepth??null});
for(const scope of ['global','preset','character'])regexes[scope]=(regexes[scope]||[]).map((rule,index)=>normalizeRegex(rule,index,scope));
Object.assign(api,{
  getScriptName:meta=>requireScript(meta).name,
  getScriptInfo:meta=>requireScript(meta).info,
  getButtonEvent:(meta,name)=>buttonEvent(requireScript(meta).id,String(name)),
  getScriptButtons:meta=>clone(requireScript(meta).buttons),
  replaceScriptButtons:(meta,buttons)=>{setButtons(meta,buttons)},
  updateScriptButtonsWith:(meta,updater)=>{const result=updater(clone(requireScript(meta).buttons));return result?.then?result.then(value=>setButtons(meta,value)):setButtons(meta,result)},
  appendInexistentScriptButtons:(meta,buttons)=>{setButtons(meta,[...requireScript(meta).buttons,...normalizeButtons(buttons)])},
  getWorldbookNames:()=>[...books.keys()],
  getCharWorldbookNames:(_meta,name='current')=>{if(name!=='current'&&name!==context.charName)throw new Error('Only the selected character is available');return clone(charBooks)},
  getWorldbook:async(_meta,name)=>clone(requireBook(name)),
  createWorldbook:async(_meta,name,entries=[])=>{if(books.has(String(name)))throw new Error('Worldbook already exists');books.set(String(name),[]);replaceBook(name,entries);return true},
  createOrReplaceWorldbook:async(_meta,name,entries=[])=>{const created=!books.has(String(name));if(created)books.set(String(name),[]);replaceBook(name,entries);return created},
  replaceWorldbook:async(_meta,name,entries)=>{replaceBook(name,entries)},
  updateWorldbookWith:async(_meta,name,updater)=>{const value=await updater(clone(requireBook(name)));if(disposed)throw new Error('Preview host has been disposed');return replaceBook(name,value)},
  createWorldbookEntries:async(_meta,name,entries)=>{const current=requireBook(name);if(!Array.isArray(entries))throw new TypeError('Worldbook entries must be an array');let uid=Math.max(-1,...current.map(e=>e.uid))+1;const added=entries.map(entry=>normalizeEntry(entry,uid++));const worldbook=replaceBook(name,[...current,...added]);return{worldbook,new_entries:clone(added)}},
  deleteWorldbookEntries:async(_meta,name,predicate)=>{const current=clone(requireBook(name));const removed=current.filter(predicate);const ids=new Set(removed.map(e=>e.uid));return{worldbook:replaceBook(name,current.filter(e=>!ids.has(e.uid))),deleted_entries:removed}},
  getLorebookEntries:async(_meta,name)=>clone(requireBook(name)).map(entry=>({...entry,comment:entry.name,position:entry.position.type})),
  setLorebookEntries:async(_meta,name,patches)=>{const current=clone(requireBook(name));for(const patch of patches){const index=current.findIndex(entry=>entry.uid===patch.uid);if(index<0)throw new Error('Worldbook uid is unavailable');current[index]={...current[index],...clone(patch)};}return replaceBook(name,current)},
  deleteLorebookEntries:async(_meta,name,uids)=>{const current=clone(requireBook(name));const kept=current.filter(entry=>!uids.includes(entry.uid));return{entries:replaceBook(name,kept),delete_occurred:kept.length!==current.length}},
  getTavernRegexes:(_meta,options={})=>{const scope=regexScope(options);const values=scope==='all'?['global','preset','character'].flatMap(key=>regexes[key]):regexes[scope];return clone(values).filter(rule=>options.enable_state==='enabled'?rule.enabled:options.enable_state==='disabled'?!rule.enabled:true)},
  replaceTavernRegexes:async(_meta,values,options={})=>{const scope=regexScope(options);if(!Array.isArray(values))throw new TypeError('Regexes must be an array');if(scope==='all')for(const key of ['global','preset','character'])regexes[key]=values.filter(value=>value.scope===key).map((rule,index)=>normalizeRegex(rule,index,key));else regexes[scope]=values.map((rule,index)=>normalizeRegex(rule,index,scope));sessionWrite('regexes.session')},
  triggerSlash:async(_meta,command)=>{const match=/^\\s*\\/(pass|echo)\\s+([\\s\\S]*)$/.exec(String(command));if(!match)throw new Error('Only /pass and /echo are available in archived reading');const text=match[2].replace(/\\{\\{(user|char|lastMessageId|userAvatarPath|charAvatarPath)\\}\\}/g,(_all,key)=>({user:context.userName,char:context.charName,lastMessageId:String(archived?.last_message_id??0),userAvatarPath:'',charAvatarPath:''})[key]);if(match[1]==='echo')console.info(text);return text},
});
`
}
