const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let catalog = [], selected = new Set(['hard-deny','secret','dependency','judge-deny','judge-review','flag-low']);
let tab = 'scenarios', current = null, report = null, page = 0, polling = false;
const labels = {passed:'Passed',failed:'Failed',pending:'Pending',capacity_blocked:'Capacity blocked',fault_blocked:'Fault blocked',judge_difference:'Judge differed'};
const fields = ['mode','transport','review','fault','post_order','count','concurrency','workers','connections','rate','messages','judge_delay_ms','policies','analysis','duplicates'];
const defaults = {mode:'scripted',transport:'queue',review:'approve',fault:'none',post_order:'normal',count:500,concurrency:64,workers:2,connections:1,rate:0,messages:2,judge_delay_ms:0,policies:true,analysis:false,duplicates:false};
const kits = {
  burst:{count:500,concurrency:64,connections:4},
  capacity:{count:100,concurrency:64,connections:1,judge_delay_ms:1500},
  replay:{count:20,concurrency:4,connections:1,duplicates:true,post_order:'before_pre'},
  retry:{count:10,concurrency:4,connections:1,fault:'retry_once'}
};
const trafficCases = ['ordinary-read','judge-review','flag-low','hard-deny'];
const states = {scenarios:{...defaults,selected:[...selected]},custom:{...defaults,selected:[]},load:{...defaults,...kits.burst,selected:trafficCases,kit:'burst'}};
let activeKit = null;
const scenarioList = document.createElement('div'); scenarioList.id='scenario-list'; scenarioList.setAttribute('aria-label','Available scenarios'); $('scenario-host').append(scenarioList);
async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw Error(typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map(e=>e.msg.replace(/^Value error, /,'')).join(' ') : 'The request could not be completed.');
  return data;
}
function error(e) { $('error').hidden = !e; $('error').textContent = e?.message || ''; if(e)$('error').scrollIntoView({block:'nearest'}); }
function values(){return Object.fromEntries(fields.map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));}
function apply(values){for(const id of fields){if(typeof values[id]==='boolean')$(id).checked=values[id];else $(id).value=values[id];}}
function renderScenarios() {
  let group = '';
  scenarioList.innerHTML = catalog.map(s => {
    const heading = group !== s.group ? `<h3 class="group-title">${esc(s.group)}</h3>` : ''; group = s.group;
    return `${heading}<div class="scenario"><label class="scenario-choice"><input type="checkbox" value="${esc(s.id)}" ${selected.has(s.id)?'checked':''}><span class="scenario-content"><strong>${esc(s.title)}</strong><code>${esc(s.tool_name)} ${esc(JSON.stringify(s.tool_input))}</code></span><span class="pill ${esc(s.expected.recommendation)}" aria-label="Expected: ${esc(s.expected.recommendation)}">Expect ${esc(s.expected.recommendation)}</span></label><button type="button" class="scenario-preview" data-preview="${esc(s.id)}" aria-label="View request: ${esc(s.title)}">↗</button></div>`;
  }).join('');
  updateSummary();
}
scenarioList.addEventListener('change', e => { if(e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value); if(tab==='load')activeKit=null; updateSummary(); });
scenarioList.addEventListener('click',e=>{
  const button=e.target.closest('[data-preview]');if(!button)return;
  const s=catalog.find(s=>s.id===button.dataset.preview);
  $('detail-title').textContent=s.title;
  $('detail-body').innerHTML=`<h3>User request</h3><p>${esc(s.conversation)}</p><h3>${esc(s.tool_name)}</h3><pre>${esc(JSON.stringify(s.tool_input,null,2))}</pre><h3>Expected result</h3><p>${esc(s.expected.recommendation)} · ${esc(s.expected.severity)}${s.expected.suspicious?' · suspicious':''}</p>${s.detail?`<p>${esc(s.detail)}</p>`:''}`;
  $('detail').showModal();
});
function selectAll(){if(tab==='load')activeKit=null;selected=selected.size===catalog.length?new Set():new Set(catalog.map(s=>s.id));renderScenarios();}
$('select-all').onclick=selectAll;$('select-mix').onclick=selectAll;
function switchTab(next){
  states[tab]={...values(),selected:[...selected],kit:activeKit};tab=next;
  apply(states[tab]);selected=new Set(states[tab].selected);activeKit=states[tab].kit||null;
  document.querySelectorAll('[data-tab]').forEach(b=>{const chosen=b.dataset.tab===tab;b.setAttribute('aria-selected',chosen);b.tabIndex=chosen?0:-1;});
  $('test-panel').setAttribute('aria-labelledby','tab-'+tab);
  $('custom-fields').hidden=tab!=='custom';$('scenario-view').hidden=tab!=='scenarios';$('load-view').hidden=tab!=='load';$('evaluation-row').hidden=tab==='load';$('failure-controls').hidden=tab!=='load';
  $(tab==='load'?'load-host':'scenario-host').append(scenarioList);
  $('advanced').open=false;error(null);renderScenarios();modeHelp();
}
document.querySelectorAll('[data-tab]').forEach(button=>{
  button.onclick=()=>switchTab(button.dataset.tab);
  button.onkeydown=e=>{const buttons=[...document.querySelectorAll('[data-tab]')];let index=buttons.indexOf(button);if(e.key==='ArrowRight')index=(index+1)%buttons.length;else if(e.key==='ArrowLeft')index=(index+buttons.length-1)%buttons.length;else if(e.key==='Home')index=0;else if(e.key==='End')index=buttons.length-1;else return;e.preventDefault();buttons[index].click();buttons[index].focus();};
});
document.querySelectorAll('[data-kit]').forEach(b=>b.onclick=()=>{
  apply({...values(),count:500,concurrency:64,connections:4,rate:0,judge_delay_ms:0,fault:'none',duplicates:false,post_order:'normal',...kits[b.dataset.kit]});activeKit=b.dataset.kit;
  selected=new Set(trafficCases);renderScenarios();modeHelp();
});
function modeHelp(){
  const live=$('mode').value==='live'&&tab!=='load';
  $('mode-help').textContent=live?'Assesses the request with the configured judge provider. OpenAI is untested; Anthropic is recommended.':'Checks rule handling and delivery, using preset judge answers. No API calls.';
  $('suspicious-label').textContent=live?'Expected to be flagged':'Flag as suspicious';
  $('expectations-title').textContent=live?'Expected result':'Simulated judge response';
  $('expectations-help').textContent=live?'Used to compare the result. These values are not sent to the judge.':'The simulated judge returns these values. Rules can take precedence.';
  updateSummary();
}
function updateSummary(){
  $('count').disabled=tab!=='load';$('concurrency').disabled=tab!=='load';
  const count=tab==='custom'?1:tab==='load'?Number($('count').value):selected.size;
  const live=tab!=='load'&&$('mode').value==='live';
  for(const id of ['select-all','select-mix'])$(id).textContent=selected.size===catalog.length?'Clear selection':'Select all';
  $('mix-count').textContent=`· ${selected.size} scenarios`;
  $('run-summary').textContent=tab==='load'?`${count} requests · ${$('concurrency').value} at once`:tab==='custom'?'1 custom request':`${count} scenarios · once each`;
  $('run-note').textContent=live?'Live AI · paid API calls · no commands executed':'Simulated responses · no API calls · no commands executed';
  $('start').textContent=tab==='load'?'Start load test →':tab==='custom'?'Test request →':`Run ${count} scenario${count===1?'':'s'} →`;
  $('start').disabled=count<1||(tab!=='custom'&&!selected.size);
  $('analysis-help').hidden=!$('analysis').checked;
  $('analysis-help').textContent=live?'Up to 3 extra minutes; uses paid API calls.':'Up to 3 extra minutes; limited to 25 requests.';
  $('traffic-summary').textContent=selected.size?`${selected.size} scenarios repeat across ${count} requests.`:'Choose at least one scenario in Request mix.';
  document.querySelectorAll('[data-kit]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.kit===activeKit));
  $('profile-name').textContent=activeKit?document.querySelector(`[data-kit="${activeKit}"] strong`).textContent:'Custom settings';
  const notes=[];
  if($('review').value!=='approve')notes.push($('review').value==='deny'?'reviews rejected':'reviews unanswered');
  if(!$('policies').checked)notes.push('policies off');if($('analysis').checked)notes.push('analysis on');
  if(tab==='load'){
    if($('fault').value!=='none')notes.push($('fault').selectedOptions[0].textContent);
    if(Number($('judge_delay_ms').value))notes.push(`${$('judge_delay_ms').value} ms delay`);
    if($('duplicates').checked)notes.push('duplicate hooks');if($('post_order').value!=='normal')notes.push('out of order');
  }
  $('advanced-summary').textContent=notes.length?'· '+notes.join(' · '):'';
}
$('mode').onchange=modeHelp;
$('run-form').addEventListener('input',e=>{if(tab==='load'&&fields.includes(e.target.id)){activeKit=null;}updateSummary();});
$('run-form').addEventListener('change',e=>{if(tab==='load'&&fields.includes(e.target.id)){activeKit=null;}updateSummary();});
$('run-form').onsubmit=async e=>{
  e.preventDefault();error(null);$('start').disabled=true;
  try {
    const config={scenarios:tab==='custom'?['custom']:catalog.filter(s=>selected.has(s.id)).map(s=>s.id)};
    if(!config.scenarios.length)throw Error('Select at least one scenario.');
    for(const id of ['mode','transport','review','fault','post_order'])config[id]=$(id).value;
    for(const id of ['count','concurrency','workers','connections','rate','messages','judge_delay_ms'])config[id]=Number($(id).value);
    for(const id of ['policies','analysis','duplicates'])config[id]=$(id).checked;
    if(tab!=='load')Object.assign(config,{count:tab==='custom'?1:selected.size,concurrency:tab==='custom'?1:4,fault:'none',judge_delay_ms:0,duplicates:false,post_order:'normal'});
    else config.mode='scripted';
    if(config.analysis&&config.count>25)throw Error('Incident analysis supports up to 25 requests. Reduce the total or turn off analysis in Advanced settings.');
    if(config.transport==='process'&&config.concurrency>32)throw Error('Separate hook processes support up to 32 concurrent requests. Reduce concurrency or choose Queue clients.');
    if(tab==='custom'){
      let input;try{input=JSON.parse($('custom-input').value)}catch{throw Error('Tool input must be valid JSON, for example {"command":"pwd"}.')}
      if(!input||Array.isArray(input)||typeof input!=='object')throw Error('Tool input must be a JSON object.');
      config.custom={title:$('custom-title').value,conversation:$('custom-conversation').value,tool_name:$('custom-tool').value,tool_input:input,recommendation:$('custom-verdict').value,severity:$('custom-severity').value,suspicious:$('custom-suspicious').checked};
    }
    const created=await api('/api/runs',config);await openRun(created.id);await refreshHistory();
  }catch(e){error(e)}finally{updateSummary();}
};
async function refreshHistory(){
  const runs=await api('/api/runs');
  $('history').innerHTML=runs.length?runs.map(r=>`<button class="history-item" data-run="${esc(r.id)}">${r.metrics?.planned?`${esc(r.metrics.planned)} ${r.metrics.planned===1?'action':'actions'}`:'Run'} <small>${esc(r.status)} · ${esc(r.id.slice(0,8))}</small></button>`).join(''):'<p class="hint">Your runs will appear here.</p>';
}
$('history').onclick=e=>{const b=e.target.closest('[data-run]');if(b)openRun(b.dataset.run).catch(error)};
$('refresh-history').onclick=()=>refreshHistory().catch(error);
function newRun(){current=null;report=null;window.history.replaceState({},'', '/');$('setup').hidden=false;$('results').hidden=true;error(null);refreshHistory().catch(error)}
$('new-run').onclick=newRun;$('another').onclick=newRun;
async function openRun(id){current=id;page=0;window.history.replaceState({},'',`/?run=${encodeURIComponent(id)}`);$('stop').disabled=false;$('stop').textContent='Stop new traffic';$('setup').hidden=true;$('results').hidden=false;error(null);await poll();}
async function poll(){
  if(!current||polling)return; polling=true;const id=current;
  try{const data=await api(`/api/runs/${id}?offset=${page*100}`);if(current!==id)return;const wasActive=!report||['starting','running','draining'].includes(report.status);report=data;renderReport(data);if(wasActive&&!['starting','running','draining'].includes(data.status))refreshHistory().catch(error);error(null)}catch(e){error(e)}finally{polling=false}
}
const metric=(title,value,detail)=>`<div class="metric"><span>${title}</span><strong>${esc(value??'—')}</strong><small>${esc(detail)}</small></div>`;
const time=ms=>ms==null?'—':ms>=1000?`${(ms/1000).toFixed(2)} s`:`${Math.round(ms)} ms`;
function renderReport(r){
  const m=r.metrics||{},active=['starting','running','draining'].includes(r.status),c=r.config||{};
  $('run-id').textContent='';$('run-id').hidden=true;
  $('run-title').textContent=({starting:'Starting the isolated workspace',running:'Traffic is flowing',draining:'Waiting for receipts and incidents',completed:'Run complete',cancelled:'Run stopped',failed:'Run failed',interrupted:'Run interrupted'})[r.status]||r.status;
  $('run-description').textContent=`${m.planned??c.count??0} ${(m.planned??c.count)===1?'request':'requests'} · ${c.mode==='live'?'Live AI judge':'Simulated responses'}`;
  document.querySelector('.chart-panel').hidden=(m.planned??c.count??0)<=1;
  $('stop').hidden=!active;$('another').hidden=active;$('download').href=`/api/runs/${r.id}/export`;
  $('run-notice').innerHTML=r.error?`<div class="notice">${esc(r.error)}</div>`:'';
  $('metrics').innerHTML=metric('Delivered / submitted',`${m.delivered??0} / ${m.submitted??0}`,`${m.not_started??0} of ${m.planned??0} actions not started`)+metric('Still unresolved',m.unresolved??0,`${m.queue_files??0} hook files queued`)+metric('Gate latency · p95',time(m.latency_p95_ms),`p50 ${time(m.latency_p50_ms)} · p99 ${time(m.latency_p99_ms)}`)+metric('Delivery rate',`${m.throughput??0}/s`,`${m.elapsed_seconds??0}s elapsed · ${m.messages??0} messages ingested`);
  $('assertions').innerHTML=Object.entries(labels).filter(([k])=>k!=='pending'&&(m[k]||k==='passed'||k==='failed')).map(([k,label])=>`<span><b>${m[k]??0}</b> ${label.toLowerCase()}</span>`).join('')+(m.diagnostic_events?`<span><b>${m.diagnostic_events}</b> diagnostic events</span>`:'')+(active?'<p>Checks finish after all requests settle.</p>':'')+(m.judge_difference?'<p>Judge differences compare verdict, severity and suspicion against the expected result.</p>':'')+(r.problems||[]).map(p=>`<p>⚠ ${esc(p)}</p>`).join('');
  const samples=r.samples||[],max=Math.max(1,...samples.map(s=>s.submitted)),last=Math.max(1,samples.at(-1)?.seconds||1);
  const points=key=>samples.map(s=>`${(s.seconds/last*890+5).toFixed(1)},${(100-s[key]/max*90).toFixed(1)}`).join(' ');
  $('chart').innerHTML=`<path d="M5 100H895 M5 55H895 M5 10H895" stroke="#ecf0f5"/><polyline points="${points('submitted')}" fill="none" stroke="#9eaac0" stroke-width="2"/><polyline points="${points('delivered')}" fill="none" stroke="#356be5" stroke-width="2.5"/>`;
  $('chart-time').textContent=`0 – ${m.elapsed_seconds||0}s`;
  $('rows').innerHTML=(r.rows||[]).map(row=>`<tr><td><button class="row-button" data-index="${row.index}">${row.index+1}. ${esc(row.title)}</button><small>${esc(row.source||'Waiting for intake')}${row.suspicious?' · suspicious':''}</small></td><td>${esc(row.recommendation||row.status||'—')}</td><td>${esc(row.receipt||'Not received')}</td><td>${esc(row.severity||'—')}</td><td><span class="pill ${esc(row.outcome)}">${esc(labels[row.outcome]||row.outcome)}</span></td><td>${time(row.latency_ms)}</td></tr>`).join('');
  $('page-label').textContent=r.row_count?`${page*100+1}–${Math.min((page+1)*100,r.row_count)} of ${r.row_count}`:'No requests yet';
  $('previous').disabled=page===0;$('next').disabled=(page+1)*100>=(r.row_count||0);
  $('diagnostics').innerHTML=`<p class="hint">${m.incidents||0} incidents · analysis ${esc(r.analysis_mode||'not_run')} · ${m.bad_files||0} quarantined hooks. Showing up to 100 incidents and diagnostic examples; export includes all incident rows.</p>`+(r.incidents||[]).slice(0,100).map(i=>`<div class="incident-item"><b>${esc(i.severity)} · ${esc(i.title)}</b><p>Analysis: ${esc(i.analysis_status)}</p>${i.analysis_result?`<p>${esc(i.analysis_result.summary)}</p>`:''}</div>`).join('')+`<pre>${esc(JSON.stringify({run_id:r.id,settings:r.config,problems:r.problems,error_counts:r.error_counts,errors:r.errors,worker_log:r.worker_log,database:r.database},null,2))}</pre>`;
}
$('stop').onclick=async()=>{try{await api(`/api/runs/${current}/stop`,{});$('stop').disabled=true;$('stop').textContent='Draining pending requests…'}catch(e){error(e)}};
$('previous').onclick=()=>{page--;poll()};$('next').onclick=()=>{page++;poll()};
$('rows').onclick=async e=>{
  const b=e.target.closest('[data-index]');if(!b)return;
  const row=report.rows.find(r=>r.index===Number(b.dataset.index));$('detail-title').textContent=row.title;
  const compare=['recommendation','source','severity','suspicious'].map(key=>`<tr><td>${esc(key)}</td><td>${esc(row.expected[key])}</td><td>${esc(row[key]??'Not recorded')}</td></tr>`).join('');
  $('detail-body').innerHTML=`<h3>Expected and observed</h3><table><thead><tr><th>Field</th><th>Expected</th><th>Observed</th></tr></thead><tbody>${compare}</tbody></table><p><b>Gate receipt:</b> ${esc(row.receipt||'Not received')} · <b>Review decision:</b> ${esc(row.human_decision||'None')} · <b>Incidents:</b> ${row.incidents?.length||0}</p><p>${esc(row.reason||row.error||'Assessment has not arrived.')}</p>${[...(row.failures||[]),...(row.differences||[])].map(f=>`<p class="failure-detail">${esc(f)}</p>`).join('')}<p id="evidence-loading">Loading saved evidence…</p>`;$('detail').showModal();
  try{const data=await api(`/api/runs/${current}/evidence/${row.index}`);$('evidence-loading').outerHTML=`<h3>Recorded payload and conversation</h3><p><b>User request</b><br>${esc(data.scenario.conversation)}</p><pre>${esc(data.snapshot.action)}</pre><p><b>Threat signals:</b> ${esc((row.triage?.signals||[]).map(s=>s.category.replaceAll('_',' ')).join(', ')||'None recorded')}</p><p>Completion hooks are simulated. No command was executed.</p><details><summary>Full frozen context and incident evidence</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`}catch(e){$('evidence-loading').textContent=e.message}
};
$('close-detail').onclick=()=>$('detail').close();
async function init(){try{catalog=(await api('/api/catalog')).scenarios;apply(states.scenarios);$('failure-controls').hidden=true;renderScenarios();modeHelp();await refreshHistory();const id=new URLSearchParams(location.search).get('run');if(id&&/^[0-9a-f-]{36}$/.test(id))await openRun(id)}catch(e){error(e)}}
setInterval(()=>{if(current&&(!report||['starting','running','draining'].includes(report.status)))poll()},2000);
init();
