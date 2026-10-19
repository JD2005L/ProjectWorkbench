// The promote approval as a prompt that comes to the administrator: on every dashboard page an
// administrator has open, a promote request that is waiting for approval opens a modal asking
// for their password. OK approves it (POST /api/promote/requests/:id/approve, the same call and
// the same server-side checks as the Settings card), and the modal then follows the promote
// through the dashboard's restart to its result. Nothing here approves anything by itself: the
// password is typed by the person, every time, and the server re-checks it.
//
// One exception to "every page": a page that has shown a project PREVIEW. Previews are served
// from this origin and framed into the cockpit, so the code in one can reach into the page
// around it — including a password box. Once a preview has been opened in a page, the modal
// there does not take the password; it opens Settings in a fresh tab for that instead.
// (previewScript calls window.pwPromoteTaint() before it loads a preview; the flag lives in
// this script's closure, so nothing can clear it again.)
//
// On the Settings page itself the card is the approval UI; there the prompt only refreshes it.
export function promotePromptHtml(BASE) {
  return `<style>
#pwPromotePrompt{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.72);backdrop-filter:blur(2px)}
#pwPromotePrompt[hidden]{display:none}
#pwPromotePrompt .pp-box{width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:#0f172a;color:#e5e7eb;border:1px solid #6d28d9;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);padding:18px 20px;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
#pwPromotePrompt h2{margin:0 0 4px;font-size:17px;color:#ddd6fe}
#pwPromotePrompt .pp-lead{margin:0 0 12px;color:#94a3b8;font-size:13px}
#pwPromotePrompt .pp-row{display:flex;gap:10px;font-size:13px;margin:2px 0}
#pwPromotePrompt .pp-k{flex:0 0 96px;color:#94a3b8}
#pwPromotePrompt .pp-v{min-width:0;overflow-wrap:anywhere}
#pwPromotePrompt details{margin:10px 0 0}
#pwPromotePrompt summary{cursor:pointer;color:#a5b4fc;font-size:13px}
#pwPromotePrompt pre{max-height:220px;overflow:auto;background:#020617;border:1px solid #1f2937;border-radius:8px;padding:8px;font:11.5px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#cbd5e1}
#pwPromotePrompt form{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;align-items:center}
#pwPromotePrompt input[type=password]{flex:1 1 220px;min-width:0;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #334155;background:#020617;color:#e5e7eb;font:inherit}
#pwPromotePrompt button{padding:8px 14px;border-radius:8px;border:0;cursor:pointer;font:inherit;background:#374151;color:#fff}
#pwPromotePrompt button.pp-ok{background:#7c3aed}
#pwPromotePrompt button:disabled{opacity:.5;cursor:not-allowed}
#pwPromotePrompt .pp-msg{margin-top:10px;font-size:13px;min-height:1em}
#pwPromotePrompt .pp-msg.err{color:#fca5a5}
#pwPromotePrompt .pp-msg.ok{color:#86efac}
</style><div id="pwPromotePrompt" role="dialog" aria-modal="true" aria-labelledby="pwPromoteTitle" hidden><div class="pp-box"><h2 id="pwPromoteTitle">Promote Project Workbench?</h2><p class="pp-lead" id="pwPromoteLead"></p><div id="pwPromoteFacts"></div><details id="pwPromoteLogWrap"><summary>Dry run output</summary><pre id="pwPromoteLog"></pre></details><div id="pwPromoteAct"></div><div class="pp-msg" id="pwPromoteMsg" role="status" aria-live="polite"></div></div></div>
<script>(function(){
const API='${BASE}/api/promote/requests';
const SETTINGS='${BASE}/settings#system';
const box=document.getElementById('pwPromotePrompt');if(!box)return;
const lead=document.getElementById('pwPromoteLead'),facts=document.getElementById('pwPromoteFacts'),logWrap=document.getElementById('pwPromoteLogWrap'),logEl=document.getElementById('pwPromoteLog'),act=document.getElementById('pwPromoteAct'),msg=document.getElementById('pwPromoteMsg');
let tainted=false;
window.pwPromoteTaint=function(){tainted=true};
const card=!!document.getElementById('promotePending');
const SNOOZE_MS=30*60*1000;
let shown=null,phase='',timer=0,failures=0,lastFocus=null;
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function say(t,kind){msg.textContent=t||'';msg.className='pp-msg'+(kind?' '+kind:'')}
function commit(r){const h=r.head||{};return h.commit?((h.ref?h.ref.replace('refs/heads/','')+' @ ':'')+h.commit.slice(0,12)):'unknown'}
function when(iso){const d=new Date(iso);return isNaN(d)?(iso||''):d.toLocaleString()}
function row(k,v){const d=el('div','pp-row');d.append(el('span','pp-k',k),el('span','pp-v',v));return d}
function snoozed(id){try{const s=JSON.parse(localStorage.getItem('pwPromoteSnooze')||'{}');return s[id]&&s[id]>Date.now()}catch{return false}}
function snooze(id){try{const s=JSON.parse(localStorage.getItem('pwPromoteSnooze')||'{}');for(const k of Object.keys(s))if(!(s[k]>Date.now()))delete s[k];s[id]=Date.now()+SNOOZE_MS;localStorage.setItem('pwPromoteSnooze',JSON.stringify(s))}catch{}}
async function getJson(url,opts){const r=await fetch(url,Object.assign({cache:'no-store'},opts||{}));let j=null;try{j=await r.json()}catch{}if(!j)throw new Error(r.status>=500||r.status===0?'The dashboard is not answering ('+r.status+')':'Unexpected reply ('+r.status+')');if(!r.ok||!j.ok){const e=new Error(j.error||('Request failed ('+r.status+')'));e.status=r.status;throw e}return j}
function open(){if(!box.hidden)return;lastFocus=document.activeElement;box.hidden=false}
function close(){box.hidden=true;shown=null;phase='';say('');try{lastFocus&&lastFocus.focus&&lastFocus.focus()}catch{}}
function summaryOf(log){return String(log||'').split('\\n').filter(l=>/\\[promote\\] (app|scripts)\\/: /.test(l)).map(l=>l.replace('[promote] ','')).join(' · ')}
function render(r){
 shown=r;phase='ask';
 lead.textContent='A promote is waiting for your approval. It restarts the dashboard; terminals stay up.';
 facts.textContent='';
 facts.append(row('Asked by',(r.requestedBy||'—')+' · '+when(r.createdAt)),row('Commit',commit(r)),row('Snapshot',r.digest?(r.files+' files · '+r.digest.slice(0,16)+'…'):'—'));
 const sum=summaryOf(r.dryRunLog);if(sum)facts.appendChild(row('Changes',sum));
 if(r.note)facts.appendChild(row('Note',r.note));
 logEl.textContent=r.dryRunLog||'(no output)';logWrap.hidden=false;logWrap.open=false;
 act.textContent='';say('');
 if(tainted){
  const f=el('form');const go=el('button','pp-ok','Approve in a new tab');go.type='button';const later=el('button',null,'Later');later.type='button';f.append(go,later);act.appendChild(f);
  act.prepend(el('p','pp-lead','A project preview has been open in this page, and preview code can reach into the page around it, so your password is asked in a fresh tab instead.'));
  go.onclick=()=>{window.open(SETTINGS,'_blank','noopener,noreferrer');snooze(r.id);close()};
  later.onclick=()=>{snooze(r.id);close()};
  open();go.focus();return;
 }
 const f=el('form');
 const pw=document.createElement('input');pw.type='password';pw.autocomplete='current-password';pw.placeholder='Your password';pw.setAttribute('aria-label','Your password, to approve this promote');pw.required=true;
 const ok=el('button','pp-ok','OK — promote');ok.type='submit';
 const no=el('button',null,'Reject');no.type='button';
 const later=el('button',null,'Later');later.type='button';
 f.append(pw,ok,no,later);act.appendChild(f);
 f.onsubmit=async e=>{e.preventDefault();if(!pw.value)return;ok.disabled=no.disabled=later.disabled=pw.disabled=true;say('Approving…');
  try{await getJson(API+'/'+encodeURIComponent(r.id)+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value,digest:r.digest})});pw.value='';follow(r.id)}
  catch(err){pw.value='';say(err.message||String(err),'err');ok.disabled=no.disabled=later.disabled=pw.disabled=false;pw.focus()}};
 no.onclick=async()=>{const reason=prompt('Reject this promote? Optional reason for the agent:','');if(reason===null)return;ok.disabled=no.disabled=later.disabled=true;
  try{await getJson(API+'/'+encodeURIComponent(r.id)+'/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});close();schedule(10000)}
  catch(err){say(err.message||String(err),'err');ok.disabled=no.disabled=later.disabled=false}};
 later.onclick=()=>{snooze(r.id);close();schedule(10000)};
 open();pw.focus();
}
// After OK: the runner promotes, the dashboard restarts (every request fails for a while), and
// the result is there once it is back.
function follow(id){
 phase='follow';act.textContent='';
 lead.textContent='Approved. Promoting now — the dashboard restarts; this window reconnects by itself.';
 say('Promoting…');
 const tick=async()=>{
  let r;
  try{r=(await getJson(API+'/'+encodeURIComponent(id))).request;failures=0}
  catch{failures++;say('The dashboard is restarting for the promote — reconnecting…');timer=setTimeout(tick,3000);return}
  if(r.state==='promoted'){
   lead.textContent='Promoted.';say('Done. Reload to use the new version.','ok');
   const f=el('form');const reload=el('button','pp-ok','Reload now');reload.type='button';const fine=el('button',null,'Close');fine.type='button';f.append(reload,fine);act.textContent='';act.appendChild(f);
   reload.onclick=()=>location.reload();fine.onclick=()=>{close();schedule(10000)};reload.focus();return;
  }
  if(r.state==='failed'||r.state==='refused'){
   lead.textContent='The promote did not finish.';say((r.error||r.state)+' — see Settings → System & Updates for the full output.','err');
   const f=el('form');const fine=el('button',null,'Close');fine.type='button';f.appendChild(fine);act.textContent='';act.appendChild(f);fine.onclick=()=>{close();schedule(10000)};return;
  }
  say(r.state==='promoting'?'Promoting now…':'Approved — the promote is queued…');
  timer=setTimeout(tick,3000);
 };
 clearTimeout(timer);timer=setTimeout(tick,1500);
}
function schedule(ms){clearTimeout(timer);timer=setTimeout(check,ms)}
let lastWaiting='';
async function check(){
 if(phase==='follow')return;
 if(document.hidden){schedule(10000);return}
 try{
  const j=await getJson(API);
  if(!j.installed){schedule(60000);return}
  const waiting=(j.requests||[]).find(x=>x.state==='awaiting-approval');
  if(card){if((waiting?waiting.id:'')!==lastWaiting&&window.pwPromoteCardRefresh)window.pwPromoteCardRefresh();lastWaiting=waiting?waiting.id:'';schedule(10000);return}
  if(!waiting){if(phase==='ask')close();schedule(10000);return}
  if(phase==='ask'&&shown&&shown.id===waiting.id){schedule(10000);return}
  if(snoozed(waiting.id)){schedule(10000);return}
  render((await getJson(API+'/'+encodeURIComponent(waiting.id))).request);
  schedule(10000);
 }catch(e){schedule(e&&e.status===403?300000:15000)}
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!box.hidden&&phase==='ask'&&shown){snooze(shown.id);close();schedule(10000)}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&phase!=='follow')schedule(300)});
schedule(1200);
})();</script>`;
}
