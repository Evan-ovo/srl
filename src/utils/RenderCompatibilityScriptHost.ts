import { isRecord } from './UnknownValue'

/** Updates the visible saved floor without recreating the chat's companion script windows. */
export function buildArchivedReadingSessionRuntime(): string {
  return `
const readerInput=document.getElementById('srl-archived-reader-window');
const readerInitial=readerInput?JSON.parse(readerInput.textContent):null;readerInput?.remove();
const readerSnapshots=new Map();const readerSources=new Map();const readerHistory=new Map();
const readerSnapshot=value=>{if(!value||!Number.isSafeInteger(value.message_id)||value.message_id<0||!Number.isSafeInteger(value.last_message_id)||value.last_message_id<value.message_id||typeof value.message!=='string')throw new Error('Invalid archived reader snapshot');return clone(value)};
if(readerInitial){if(!Array.isArray(readerInitial.snapshots)||readerInitial.snapshots.length>5)throw new Error('Invalid archived reader window');for(const value of readerInitial.snapshots){const saved=readerSnapshot(value);readerSnapshots.set(saved.message_id,saved)}}
if(readerInitial?.history){for(const value of readerInitial.history){const saved=readerSnapshot(value);if(saved.message_id!==readerHistory.size)throw new Error('Invalid archived history order');readerHistory.set(saved.message_id,saved)}if(readerHistory.size!==readerHistory.get(0)?.last_message_id+1)throw new Error('Incomplete archived history');delete readerInitial.history}
const archivedForMeta=meta=>{if(meta?.scriptId&&readerHistory.size)return readerHistory.get(readerHistory.size-1);const id=meta?.frameName?.match(/^TH-message--(\\d+)--/);if(!readerInitial||meta?.scriptId||!id)return archived;const saved=readerSnapshots.get(Number(id[1]));if(!saved)throw new Error('Archived frontend snapshot has been released');return saved};
const archivedMvuFor=meta=>{const saved=archivedForMeta(meta);const valid=saved?.data&&typeof saved.data.stat_data==='object'&&saved.data.stat_data!==null&&!Array.isArray(saved.data.stat_data)&&typeof saved.data.schema==='object'&&saved.data.schema!==null&&!Array.isArray(saved.data.schema);if(!valid)return undefined;const read=options=>{const data=api.getVariables(meta,{type:'message',...options});if(typeof data?.stat_data!=='object'||data.stat_data===null||Array.isArray(data.stat_data)||typeof data.schema!=='object'||data.schema===null||Array.isArray(data.schema))throw new Error('Archived MVU data is unavailable');return data};return Object.freeze({...mvu,getMvuData:read,getCurrentMvuData:()=>read()})};
let readerStarted=false,readerLastTop=0,readerSelection=readerSnapshots.get(archived?.message_id);
const readerRoot=()=>document.querySelector('#chat[data-srl-reader-window]');
const readerSections=()=>Array.from(readerRoot()?.querySelectorAll(':scope>[data-floor]')||[]);
const readerPosition=()=>{const sections=readerSections();const section=sections.find(item=>item.getBoundingClientRect().bottom>5)||sections.at(-1);return section?{floor:Number(section.dataset.floor),offset:-section.getBoundingClientRect().top,documentTop:readerRoot().scrollTop+section.getBoundingClientRect().top}:null};
const restoreReader=position=>{if(!readerInitial||!position)return;const section=readerSections().find(item=>Number(item.dataset.floor)===position.floor);if(!section)return;const offset=Number.isFinite(position.documentTop)?Number(position.offset)||0:Math.min(Math.max(0,Number(position.offset)||0),Math.max(0,section.getBoundingClientRect().height-6));readerRoot().scrollTo(0,readerRoot().scrollTop+section.getBoundingClientRect().top+offset);readerLastTop=readerRoot().scrollTop};
const selectReaderFloor=position=>{const saved=readerSnapshots.get(position?.floor);if(!saved||saved===readerSelection)return;readerSelection=saved;archived=clone(saved);window.__SRL_ARCHIVED_READER_FLOOR__=archived.message_id;const valid=archivedMvuFor({});if(valid)globals.set('Mvu',mvu);else globals.delete('Mvu');for(const frame of document.querySelectorAll('#srl-tavern-helper-script-runtimes iframe')){if(valid)frame.contentWindow.Mvu=mvu;else delete frame.contentWindow.Mvu}publishButtons()};
const reportReader=(delta=0)=>{if(!readerInitial||!readerRoot())return;const frames=Array.from(readerRoot().querySelectorAll('div.TH-render>iframe'));if(!readerStarted){if(frames.some(frame=>frame.dataset.srlLayoutReady!=='true'))return;readerStarted=true;restoreReader(readerInitial.position);readerRoot().style.removeProperty('opacity')}const position=readerPosition();if(!position)return;readerLastTop=readerRoot().scrollTop;parent.postMessage({protocol,type:'SRL_ARCHIVED_READER_LAYOUT',position:{floor:position.floor,offset:Math.max(0,position.offset)},top:readerRoot().scrollTop,height:readerRoot().scrollHeight,viewport:readerRoot().clientHeight,delta,floors:readerSections().map(section=>({index:Number(section.dataset.floor),height:Math.ceil(section.getBoundingClientRect().height)}))},'*');selectReaderFloor(position)};
const archivedReaderScroll=()=>{if(!readerInitial||!readerStarted)return;const delta=readerRoot().scrollTop-readerLastTop;readerLastTop=readerRoot().scrollTop;reportReader(delta)};
const updateReaderWindow=data=>{if(!readerInitial||!Array.isArray(data.snapshots)||data.snapshots.length>5||typeof data.html!=='string')throw new Error('Invalid archived reader window update');const saved=data.snapshots.map(readerSnapshot);const changed=[];let added=false;for(const item of saved){const old=readerHistory.size?readerHistory.get(item.message_id):readerSnapshots.get(item.message_id);if(readerHistory.size&&!old)throw new Error('Historical message is unavailable');if(old&&JSON.stringify(old)!==JSON.stringify(item))changed.push(item.message_id);if(readerHistory.size)readerHistory.set(item.message_id,item)}const incoming=new DOMParser().parseFromString(data.html,'text/html').querySelector('#chat[data-srl-reader-window]');const root=readerRoot();if(!root||!incoming)throw new Error('Archived reader window is missing');readerInitial.mode=data.mode||readerInitial.mode;const currentPosition=readerPosition();const position=data.restore?data.position:saved.some(item=>item.message_id===currentPosition?.floor)?currentPosition:data.position;const nextIds=new Set(saved.map(item=>item.message_id));for(const section of readerSections()){if(nextIds.has(Number(section.dataset.floor)))continue;for(const frame of section.querySelectorAll('div.TH-render>iframe'))host.detach(frame.contentWindow);section.remove();readerSources.delete(Number(section.dataset.floor))}const nextSnapshots=saved.map(item=>{const previous=readerSnapshots.get(item.message_id);return previous&&JSON.stringify(previous)===JSON.stringify(item)?previous:item});readerSnapshots.clear();for(const item of nextSnapshots)readerSnapshots.set(item.message_id,item);if(data.vendors)window.__SRL_UPDATE_PREVIEW_VENDOR_DOCUMENTS__?.(data.vendors);for(const section of incoming.querySelectorAll(':scope>[data-floor]')){const id=Number(section.dataset.floor);if(!nextIds.has(id))throw new Error('Reader floor does not match its saved snapshot');const source=section.outerHTML;let current=readerSections().find(item=>Number(item.dataset.floor)===id);if(current&&readerSources.get(id)!==source){for(const frame of current.querySelectorAll('div.TH-render>iframe'))host.detach(frame.contentWindow);current.remove();current=null}if(!current){added=true;current=document.importNode(section,true);const before=readerSections().find(item=>Number(item.dataset.floor)>id);root.insertBefore(current,before||document.getElementById('srl-reader-virtual-bottom'))}readerSources.set(id,source)}for(const edge of ['top','bottom']){const id='srl-reader-virtual-'+edge;let spacer=document.getElementById(id);if(!spacer){spacer=document.createElement('div');spacer.id=id;spacer.setAttribute('aria-hidden','true');if(edge==='top')root.prepend(spacer);else root.append(spacer)}spacer.style.height=Math.max(0,Number(data[edge+'Height'])||0)+'px'}if(added||changed.length||archivedRender)archivedRender={frames:new Set(Array.from(root.querySelectorAll('div.TH-render>iframe')).filter(frame=>frame.dataset.srlLayoutReady!=='true').map(frame=>frame.id)),changed:[...new Set([...(archivedRender?.changed||[]),...changed])].filter(id=>nextIds.has(id)),more:added||archivedRender?.more};window.__SRL_RENDER_COMPAT_REFRESH_MESSAGE_FRAMES__?.();restoreReader(position);reportReader();publishArchivedReady()};
const archivedReaderClick=event=>{if(readerInitial&&event.target.closest?.('#chat')&&!event.target.closest('button,a,input,summary,table,.TH-render')&&!window.getSelection()?.toString())parent.postMessage({protocol,type:'SRL_ARCHIVED_READER_CHROME'},'*')};let readerDown=null;const archivedReaderDown=event=>{readerDown={x:event.clientX,y:event.clientY,blocked:!!event.target.closest?.('button,a,input,summary,table,.TH-render')}};const archivedReaderUp=event=>{if(!readerDown)return;const down=readerDown;readerDown=null;const dx=event.clientX-down.x,dy=event.clientY-down.y;if(readerInitial?.mode==='scroll'&&!down.blocked&&Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.4&&!window.getSelection()?.toString())parent.postMessage({protocol,type:'SRL_ARCHIVED_READER_TURN',delta:dx<0?1:-1},'*')};const readerMounted=()=>{if(!readerInitial)return;document.addEventListener('click',archivedReaderClick);document.addEventListener('pointerdown',archivedReaderDown);document.addEventListener('pointerup',archivedReaderUp);for(const section of readerSections())readerSources.set(Number(section.dataset.floor),section.outerHTML);readerRoot().addEventListener('scroll',archivedReaderScroll,{passive:true});reportReader()};
if(readerInitial){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',readerMounted,{once:true});else readerMounted()}
Object.defineProperty(window,'__SRL_ARCHIVED_READER_LAYOUT__',{configurable:true,value:readerInitial?()=>reportReader():undefined});
let archivedRender=null;
const publishArchivedReady=()=>{if(!archivedRender||archivedRender.frames.size)return;const rendered=archivedRender;archivedRender=null;publishButtons();if(rendered.changed){if(rendered.more)void emit(tavernEvents.MORE_MESSAGES_LOADED);for(const id of rendered.changed){const saved=readerSnapshots.get(id);void emit(saved?.role==='user'?tavernEvents.USER_MESSAGE_RENDERED:tavernEvents.CHARACTER_MESSAGE_RENDERED,id)}}else void emit(tavernEvents.CHARACTER_MESSAGE_RENDERED,archived.message_id)};
const archivedFrameReady=event=>{if(!archivedRender)return;for(const frame of document.querySelectorAll('div.TH-render>iframe'))if(frame.contentWindow===event.source){archivedRender.frames.delete(frame.id);publishArchivedReady();break}};
const updateArchivedFloor=data=>{
  const next=data.snapshot;
  if(!archived||!next||!Number.isSafeInteger(next.message_id)||next.message_id<0||!Number.isSafeInteger(next.last_message_id)||next.last_message_id<next.message_id||typeof next.message!=='string'||typeof data.html!=='string')throw new Error('Invalid archived reading update');
  const parsed=new DOMParser().parseFromString(data.html,'text/html');const incoming=parsed.querySelector('#chat');const current=document.querySelector('#chat');if(!incoming||!current)throw new Error('Archived reading content is missing');
  const vendors=parsed.getElementById('srl-preview-vendor-data');if(vendors){if(!window.__SRL_UPDATE_PREVIEW_VENDOR_DOCUMENTS__)throw new Error('Shared preview dependencies are unavailable');window.__SRL_UPDATE_PREVIEW_VENDOR_DOCUMENTS__(JSON.parse(vendors.textContent))}
  archived=clone(next);window.__SRL_ARCHIVED_READER_FLOOR__=archived.message_id;
  const valid=archived.data&&typeof archived.data.stat_data==='object'&&archived.data.stat_data!==null&&!Array.isArray(archived.data.stat_data)&&typeof archived.data.schema==='object'&&archived.data.schema!==null&&!Array.isArray(archived.data.schema);
  if(valid)api.initializeGlobal({},'Mvu',mvu);else globals.delete('Mvu');
  for(const frame of document.querySelectorAll('#srl-tavern-helper-script-runtimes iframe')){if(valid)frame.contentWindow.Mvu=mvu;else delete frame.contentWindow.Mvu}
  // Keep author UI appended outside #chat, script frames, listeners and IndexedDB state.
  const replacement=document.importNode(incoming,true);archivedRender={frames:new Set(Array.from(replacement.querySelectorAll('div.TH-render>iframe'),frame=>frame.id))};for(const frame of current.querySelectorAll('div.TH-render>iframe'))host.detach(frame.contentWindow);current.replaceWith(replacement);
  window.__SRL_RENDER_COMPAT_REFRESH_MESSAGE_FRAMES__?.();publishArchivedReady();
};
const archivedSessionReady=()=>{if(!disposed&&archived)parent.postMessage({protocol,type:'SRL_ARCHIVED_SESSION_READY'},'*')};if(archived){window.__SRL_ARCHIVED_READER_FLOOR__=archived.message_id;if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',archivedSessionReady,{once:true});else archivedSessionReady()}
`
}

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
