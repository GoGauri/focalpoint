// Core types
/** @typedef {{ id:string, title:string, notes:string, created:number, due?:number, completed?:number|null, priority:1|2|3, tags:string[], subtasks: { id:string, title:string, done:boolean }[], repeat: { mode:'none'|'daily'|'weekdays'|'weekly'|'monthly'|'custom', rrule?:string }, remind?: { enabled:boolean, minutesBefore:number }, list?: 'daily'|'weekly'|null }} Task */

const state = {
  tasks: /** @type {Task[]} */ ([]),
  filters: /** @type {{ id:string, name:string, query:string }[]} */ ([]),
  view: 'inbox',
  selectedTaskId: null,
  installPrompt: null,
  ui: { sidebarHiddenDesktop: false },
};

// DOM refs
const els = {
  navToggle: document.getElementById('navToggle'),
  sidebar: document.getElementById('sidebar'),
  layout: document.querySelector('.layout'),
  newTaskBtn: document.getElementById('newTaskBtn'),
  notifBtn: document.getElementById('notifBtn'),
  installBtn: document.getElementById('installBtn'),
  searchInput: document.getElementById('searchInput'),
  viewTitle: document.getElementById('viewTitle'),
  sortSelect: document.getElementById('sortSelect'),
  taskList: document.getElementById('taskList'),
  details: document.getElementById('details'),
  closeDetailsBtn: document.getElementById('closeDetailsBtn'),
  taskForm: document.getElementById('taskForm'),
  taskTitle: document.getElementById('taskTitle'),
  taskNotes: document.getElementById('taskNotes'),
  taskDue: document.getElementById('taskDue'),
  taskPriority: document.getElementById('taskPriority'),
  taskTags: document.getElementById('taskTags'),
  taskListSel: document.getElementById('taskList'),
  subtasksList: document.getElementById('subtasksList'),
  newSubtaskInput: document.getElementById('newSubtaskInput'),
  addSubtaskBtn: document.getElementById('addSubtaskBtn'),
  taskRepeat: document.getElementById('taskRepeat'),
  taskRepeatCustom: document.getElementById('taskRepeatCustom'),
  taskRemind: document.getElementById('taskRemind'),
  taskRemindMinutes: document.getElementById('taskRemindMinutes'),
  deleteTaskBtn: document.getElementById('deleteTaskBtn'),
  calendarView: document.getElementById('calendarView'),
  filtersList: document.getElementById('filtersList'),
  addFilterBtn: document.getElementById('addFilterBtn'),
  tagsCloud: document.getElementById('tagsCloud'),
  importInput: document.getElementById('importInput'),
  exportBtn: document.getElementById('exportBtn'),
};

// Storage helpers
const storage = {
  load(){
    try{
      const raw = localStorage.getItem('focus.tasks');
      state.tasks = raw ? JSON.parse(raw) : [];
      const rawF = localStorage.getItem('focus.filters');
      state.filters = rawF ? JSON.parse(rawF) : [];
    }catch(err){
      console.error('Failed to load data', err);
      state.tasks = [];
      state.filters = [];
    }
  },
  save(){
    localStorage.setItem('focus.tasks', JSON.stringify(state.tasks));
    localStorage.setItem('focus.filters', JSON.stringify(state.filters));
  }
};

// Utilities
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const fmtDateTime = (ms)=>{
  if(!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString([], { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
};
const isToday = (ms)=>{
  if(!ms) return false;
  const d = new Date(ms); const n = new Date();
  return d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate();
};
const isUpcoming = (ms)=>{
  if(!ms) return false;
  const now = new Date();
  const in7 = new Date(); in7.setDate(now.getDate()+7);
  return ms > now.getTime() && ms <= in7.getTime();
};
const parseTags = (txt)=> txt.split(',').map(s=>s.trim()).filter(Boolean).map(s=>s.toLowerCase());

// Recurrence engine (simple)
function nextOccurrence(task){
  if(!task.due) return null;
  const d = new Date(task.due);
  switch(task.repeat.mode){
    case 'daily': d.setDate(d.getDate()+1); break;
    case 'weekdays':{
      do { d.setDate(d.getDate()+1); } while([0,6].includes(d.getDay()));
      break;
    }
    case 'weekly': d.setDate(d.getDate()+7); break;
    case 'monthly': d.setMonth(d.getMonth()+1); break;
    case 'custom':{
      // Minimal RRULE support: FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE
      const rule = task.repeat.rrule || '';
      const parts = Object.fromEntries(rule.split(';').map(kv=>kv.split('=')));
      const freq = parts.FREQ || 'DAILY';
      const interval = parseInt(parts.INTERVAL||'1',10);
      if(freq==='DAILY') d.setDate(d.getDate()+interval);
      else if(freq==='WEEKLY') d.setDate(d.getDate()+7*interval);
      else if(freq==='MONTHLY') d.setMonth(d.getMonth()+interval);
      // BYDAY simplistic: move forward until matching day
      if(parts.BYDAY){
        const map={SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};
        const days = parts.BYDAY.split(',').map(s=>map[s.trim()]).filter(v=>v!=null);
        let tries=0;
        while(!days.includes(d.getDay()) && tries<14){ d.setDate(d.getDate()+1); tries++; }
      }
      break;
    }
    default: return null;
  }
  return d.getTime();
}

// In-app reminder scheduler (active while app open)
const reminderScheduler = {
  timer:null,
  start(){
    this.stop();
    this.timer = setInterval(()=>this.tick(), 30_000);
    this.tick();
  },
  stop(){ if(this.timer) clearInterval(this.timer); this.timer=null; },
  async notify(task){
    try{
      if(Notification.permission==='granted'){
        new Notification('Task reminder', { body: task.title + (task.due?` — due ${fmtDateTime(task.due)}`:''), tag: task.id });
      }
    }catch{}
  },
  tick(){
    const now = Date.now();
    for(const task of state.tasks){
      if(!task.due || task.completed) continue;
      if(!task.remind?.enabled) continue;
      const fireAt = task.due - (task.remind.minutesBefore||0)*60*1000;
      if(now >= fireAt && now - fireAt < 31_000){ // window ~30s
        this.notify(task);
      }
    }
  }
};

// Rendering
function render(){
  // Title
  const viewMap = { inbox:'All Tasks', today:'Today', upcoming:'Upcoming', calendar:'Calendar', daily:'Daily Checklist', weekly:'Weekly Plan' };
  els.viewTitle.textContent = viewMap[state.view] || 'Tasks';

  // Sidebar active
  document.querySelectorAll('.nav .nav-item').forEach(b=>{
    b.classList.toggle('active', b.getAttribute('data-view')===state.view);
  });

  // Tags cloud
  const tagCounts = new Map();
  for(const t of state.tasks){
    for(const tag of t.tags){ tagCounts.set(tag,(tagCounts.get(tag)||0)+1); }
  }
  els.tagsCloud.innerHTML = '';
  if(tagCounts.size === 0) {
    // Show some example tags as clickable presets
    ['work','health','home','study','errands'].forEach(tag => {
      const s = document.createElement('button');
      s.className = 'tag';
      s.textContent = `#${tag}`;
      s.addEventListener('click',()=>{ state.view='inbox'; els.searchInput.value = `tag:${tag}`; renderTasks(); });
      els.tagsCloud.appendChild(s);
    });
  } else {
    [...tagCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,30).forEach(([tag,count])=>{
      const s = document.createElement('button');
      s.className='tag'; s.textContent=`#${tag} (${count})`;
      s.addEventListener('click',()=>{ state.view='inbox'; els.searchInput.value = `tag:${tag}`; renderTasks(); });
      els.tagsCloud.appendChild(s);
    });
  }

  // Filters list
  els.filtersList.innerHTML='';
  if(state.filters.length===0) {
    // Show filter presets if none exist (click to apply)
    const presets = [
      { name: 'Urgent', query: 'priority:1' },
      { name: 'Due Today', query: 'due:today' },
      { name: 'With #work tag', query: 'tag:work' }
    ];
    presets.forEach(f=>{
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'nav-item'; btn.textContent = f.name;
      btn.addEventListener('click',()=>{ state.view='inbox'; els.searchInput.value=f.query; renderTasks(); });
      li.appendChild(btn);
      els.filtersList.appendChild(li);
    });
  } else {
    for(const f of state.filters){
      const li = document.createElement('li');
      const wrap = document.createElement('div'); wrap.style.display='flex'; wrap.style.gap='6px';
      const btn = document.createElement('button');
      btn.className='nav-item'; btn.style.flex='1'; btn.textContent=f.name;
      btn.addEventListener('click',()=>{ state.view='inbox'; els.searchInput.value=f.query; renderTasks(); });
      const del = document.createElement('button'); del.className='icon-btn'; del.setAttribute('aria-label',`Delete filter ${f.name}`); del.textContent='✕';
      del.addEventListener('click',()=>{ state.filters = state.filters.filter(x=>x.id!==f.id); storage.save(); render(); });
      wrap.append(btn, del); li.appendChild(wrap); els.filtersList.appendChild(li);
    }
  }

  // Calendar vs list
  if(state.view==='calendar'){
    els.calendarView.classList.remove('hidden');
    els.calendarView.setAttribute('aria-hidden','false');
    renderCalendar();
    els.taskList.replaceChildren();
  }else{
    els.calendarView.classList.add('hidden');
    els.calendarView.setAttribute('aria-hidden','true');
    renderTasks();
  }
}

function matchesQuickQuery(task, q){
  // Enhanced query: supports tag:, due:, priority:, list:, quoted search
  let parts = [];
  // Allow quoted phrases
  q.replace(/"[^"]+"|[^\s]+/g, m => {parts.push(m.replace(/^"|"$/g, '')); return ''});
  for(const pRaw of parts){
    const p = pRaw.trim().toLowerCase();
    if(p.startsWith('tag:')){
      const tag = p.slice(4);
      if(!task.tags.includes(tag)) return false;
    }else if(p.startsWith('due:')){
      const v = p.slice(4);
      if(v==='today' && !isToday(task.due)) return false;
      if(v==='upcoming' && !isUpcoming(task.due)) return false;
      if(v==='overdue' && (!task.due || task.due > Date.now())) return false;
    }else if(p.startsWith('priority:')){
      let val = p.slice(9);
      if(['high','1'].includes(val)) { if(task.priority !== 1) return false; }
      else if(['medium','2'].includes(val)) { if(task.priority !== 2) return false; }
      else if(['low','3'].includes(val)) { if(task.priority !== 3) return false; }
      else return false;
    }else if(p.startsWith('list:')){
      let val = p.slice(5);
      if((val==='daily' && task.list!=='daily') || (val==='weekly' && task.list!=='weekly')) return false;
      if((val==='none' || val==='inbox') && !!task.list) return false;
    }else{
      // Normal AND search on title/notes
      const t = (task.title+' '+(task.notes||''));
      if(!t.toLowerCase().includes(p)) return false;
    }
  }
  return true;
}

function renderTasks(){
  let tasks = [...state.tasks];
  // View filter
  if(state.view==='today') tasks = tasks.filter(t=>isToday(t.due) && !t.completed);
  else if(state.view==='upcoming') tasks = tasks.filter(t=>isUpcoming(t.due) && !t.completed);
  else if(state.view==='daily') tasks = tasks.filter(t=>t.list==='daily' && !t.completed);
  else if(state.view==='weekly') tasks = tasks.filter(t=>t.list==='weekly' && !t.completed);

  const q = els.searchInput.value.trim();
  if(q) tasks = tasks.filter(t=>matchesQuickQuery(t,q));

  // --- Show active search or filter summary just above the tasks ---
  let filterRow = document.getElementById('activeFilterRow');
  if(filterRow) filterRow.remove();
  if(q){
    filterRow = document.createElement('div');
    filterRow.id = 'activeFilterRow';
    filterRow.style.cssText = 'margin-bottom:10px;color:var(--muted);font-size:14px;display:flex;gap:16px;align-items:center;justify-content:space-between;';
    filterRow.innerHTML = `<span>Filtered by: <b>${q.replace(/</g,'&lt;')}</b></span><button class='secondary' style='padding:1px 10px' id='clearSearchBtn'>Clear</button>`;
    els.taskList.parentElement.insertBefore(filterRow, els.taskList);
    filterRow.querySelector('#clearSearchBtn').onclick = ()=>{ els.searchInput.value=''; renderTasks(); };
  }

  const sort = els.sortSelect.value;
  tasks.sort((a,b)=>{
    if(sort==='priority') return a.priority - b.priority;
    if(sort==='due') return (a.due||1e20) - (b.due||1e20);
    if(sort==='title') return a.title.localeCompare(b.title);
    return a.created - b.created;
  });

  els.taskList.innerHTML='';
  const tmpl = document.getElementById('taskItemTemplate');
  // Empty state & suggestions
  if(tasks.length === 0) {
    let message = '';
    if(state.view==='inbox') {
      // Suggest some day-to-day tasks if the user has not created any task
      const suggestions = [
        {title:'Drink Water', priority:2},
        {title:'Read for 10 minutes', priority:2},
        {title:'Exercise/Stretch', priority:2},
        {title:'Plan tomorrow', priority:3},
        {title:'Clear workspace', priority:3}
      ];
      message = '<div class="empty-hint">No tasks yet. Here are some ideas to get you started:</div>';
      const ul = document.createElement('ul');
      ul.className = 'suggested-list';
      suggestions.forEach(s=>{
        const li = document.createElement('li');
        li.className = 'suggested-task';
        li.innerHTML = `<span>${s.title}</span> <button class="primary add-suggested">Add</button>`;
        li.querySelector('button').onclick = () => {
          const t = { ...s, id: uid(), notes:'', created:Date.now(), tags:[], subtasks:[], repeat:{mode:'none'}, remind:{enabled:false, minutesBefore:15}, list:null };
          state.tasks.unshift(t); storage.save(); render();
        };
        ul.appendChild(li);
      });
      els.taskList.innerHTML = message;
      els.taskList.appendChild(ul);
      return;
    } else if(state.view==='today') {
      message = '<div class="empty-hint">You have no tasks for today. Add a new task!</div>';
    } else if(state.view==='upcoming') {
      message = '<div class="empty-hint">No upcoming tasks found.</div>';
    } else if(state.view==='daily') {
      message = '<div class="empty-hint">This daily checklist is empty.</div>';
    } else if(state.view==='weekly') {
      message = '<div class="empty-hint">This weekly plan is empty.</div>';
    }
    els.taskList.innerHTML = message;
    return;
  }
  for(const task of tasks){
    const node = tmpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = task.id;
    node.querySelector('.task-title').textContent = task.title;
    const meta = [];
    if(task.due) meta.push(`Due ${fmtDateTime(task.due)}`);
    if(task.tags.length) meta.push('#'+task.tags.join(' #'));
    node.querySelector('.task-meta').textContent = meta.join(' · ');
    const badges = node.querySelector('.task-badges');
    const pr = document.createElement('span'); pr.className='badge'; pr.textContent = ['High','Med','Low'][task.priority-1]; badges.appendChild(pr);
    if(task.repeat.mode!=='none'){ const r=document.createElement('span'); r.className='badge'; r.textContent='↻'; badges.appendChild(r); }
    const cb = node.querySelector('.task-complete'); cb.checked = !!task.completed;
    cb.addEventListener('change',()=>toggleComplete(task.id, cb.checked));
    node.addEventListener('click',(e)=>{ if(e.target.closest('input,button,label')) return; openDetails(task.id); });
    node.querySelector('.more').addEventListener('click',(e)=>{ e.stopPropagation(); openDetails(task.id); });
    els.taskList.appendChild(node);
  }
}

function renderCalendar(){
  const wrap = document.createElement('div');
  wrap.className='calendar-grid';
  const start = new Date();
  start.setHours(0,0,0,0);
  const dow = start.getDay();
  const weekStart = new Date(start); weekStart.setDate(start.getDate()-dow); // Sunday start
  for(let i=0;i<7;i++){
    const day = new Date(weekStart); day.setDate(weekStart.getDate()+i);
    const box = document.createElement('div'); box.className='calendar-day';
    const h = document.createElement('h3'); h.textContent = day.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }); box.appendChild(h);
    const dayTasks = state.tasks.filter(t=> t.due && new Date(t.due).toDateString()===day.toDateString());
    for(const t of dayTasks){
      const it = document.createElement('div'); it.className='mini-task'; it.draggable=true; it.textContent=t.title;
      it.addEventListener('dragstart', ev=>{ ev.dataTransfer.setData('text/plain', t.id); });
      box.appendChild(it);
    }
    box.addEventListener('dragover', ev=>ev.preventDefault());
    box.addEventListener('drop', ev=>{
      ev.preventDefault(); const id = ev.dataTransfer.getData('text/plain');
      const task = state.tasks.find(x=>x.id===id); if(!task) return;
      const newDue = new Date(day); newDue.setHours(9,0,0,0);
      task.due = newDue.getTime(); storage.save(); render();
    });
    wrap.appendChild(box);
  }
  els.calendarView.replaceChildren(wrap);
}

// Actions
function createTask(){
  const t = /** @type {Task} */ ({
    id: uid(),
    title: 'New task',
    notes: '',
    created: Date.now(),
    due: undefined,
    completed: null,
    priority: 2,
    tags: [],
    subtasks: [],
    repeat: { mode:'none' },
    remind: { enabled:false, minutesBefore:15 },
    list: null,
  });
  state.tasks.unshift(t); storage.save(); render(); openDetails(t.id);
}

function openDetails(id){
  state.selectedTaskId=id;
  const t = state.tasks.find(x=>x.id===id); if(!t) return;
  els.details.hidden = false;
  els.taskTitle.value = t.title;
  els.taskNotes.value = t.notes||'';
  els.taskDue.value = t.due? new Date(t.due).toISOString().slice(0,16):'';
  els.taskPriority.value = String(t.priority);
  els.taskTags.value = t.tags.join(', ');
  els.taskRepeat.value = t.repeat.mode;
  els.taskRepeatCustom.classList.toggle('hidden', t.repeat.mode!=='custom');
  els.taskRepeatCustom.value = t.repeat.rrule||'';
  els.taskRemind.checked = !!t.remind?.enabled;
  els.taskRemindMinutes.value = String(t.remind?.minutesBefore ?? 15);
  els.taskListSel.value = t.list || 'none';

  els.subtasksList.innerHTML='';
  for(const s of t.subtasks){
    const li = document.createElement('li');
    const cb = document.createElement('input'); cb.type='checkbox'; cb.checked=s.done; cb.addEventListener('change',()=>{ s.done=cb.checked; storage.save(); });
    const inp = document.createElement('input'); inp.type='text'; inp.value=s.title; inp.addEventListener('change',()=>{ s.title=inp.value; storage.save(); render(); });
    const del = document.createElement('button'); del.className='icon-btn'; del.textContent='🗑'; del.addEventListener('click',()=>{ t.subtasks=t.subtasks.filter(x=>x.id!==s.id); storage.save(); openDetails(id); });
    li.append(cb, inp, del); els.subtasksList.appendChild(li);
  }
}

function closeDetails(){ els.details.hidden=true; state.selectedTaskId=null; }

function saveDetails(ev){
  ev?.preventDefault();
  const id = state.selectedTaskId; if(!id) return;
  const t = state.tasks.find(x=>x.id===id); if(!t) return;
  t.title = els.taskTitle.value.trim() || 'Untitled';
  t.notes = els.taskNotes.value.trim();
  t.due = els.taskDue.value ? new Date(els.taskDue.value).getTime() : undefined;
  t.priority = clamp(parseInt(els.taskPriority.value,10)||2,1,3);
  t.tags = parseTags(els.taskTags.value);
  const mode = /** @type {Task['repeat']['mode']} */ (els.taskRepeat.value);
  t.repeat = { mode, rrule: mode==='custom'? (els.taskRepeatCustom.value||undefined) : undefined };
  t.remind = { enabled: !!els.taskRemind.checked, minutesBefore: parseInt(els.taskRemindMinutes.value,10)||15 };
  const listSel = els.taskListSel.value;
  t.list = (listSel==='none') ? null : listSel;
  storage.save(); render();
}

function deleteTask(){
  const id = state.selectedTaskId; if(!id) return;
  state.tasks = state.tasks.filter(t=>t.id!==id); storage.save(); closeDetails(); render();
}

function toggleComplete(id, done){
  const t = state.tasks.find(x=>x.id===id); if(!t) return;
  t.completed = done ? Date.now() : null;
  // Handle recurrence: when completed, spawn next occurrence
  if(done && t.repeat.mode!=='none'){
    const next = nextOccurrence(t);
    if(next){
      const copy = JSON.parse(JSON.stringify(t));
      copy.id = uid();
      copy.created = Date.now();
      copy.completed = null;
      copy.subtasks = (copy.subtasks||[]).map(s=>({ ...s, id:uid(), done:false }));
      copy.due = next;
      state.tasks.push(copy);
    }
  }
  storage.save(); render();
}

// Daily/Weekly generation (idempotent per day/week)
function ensureLists(){
  const todayKey = new Date().toDateString();
  const wk = new Date();
  const weekKey = `${wk.getFullYear()}-W${getWeekNumber(wk)}`;
  const lastDay = localStorage.getItem('focus.daily.key');
  const lastWeek = localStorage.getItem('focus.weekly.key');
  if(lastDay && lastDay !== todayKey){
    // Reset daily checklist completion
    for(const t of state.tasks){ if(t.list==='daily'){ t.completed = null; t.subtasks?.forEach(s=>s.done=false); } }
  }
  if(lastWeek && lastWeek !== weekKey){
    for(const t of state.tasks){ if(t.list==='weekly'){ t.completed = null; t.subtasks?.forEach(s=>s.done=false); } }
  }
  localStorage.setItem('focus.daily.key', todayKey);
  localStorage.setItem('focus.weekly.key', weekKey);
  storage.save();
}
function getWeekNumber(d){
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = dt.getUTCDay() || 7; dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(),0,1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1)/7);
}

// --- Notification/Reminders handling update ---
function updateNotifBtn() {
  if (!('Notification' in window)) {
    els.notifBtn.textContent = 'Reminders Unsupported';
    els.notifBtn.disabled = true;
    els.notifBtn.classList.add('danger');
    return;
  }
  const perm = Notification.permission;
  if (perm === 'granted') {
    els.notifBtn.textContent = 'Reminders Enabled';
    els.notifBtn.disabled = true;
    els.notifBtn.classList.add('primary');
    els.notifBtn.classList.remove('danger');
  } else if (perm === 'denied') {
    els.notifBtn.textContent = 'Reminders Blocked';
    els.notifBtn.disabled = true;
    els.notifBtn.classList.add('danger');
  } else {
    els.notifBtn.textContent = 'Enable Reminders';
    els.notifBtn.disabled = false;
    els.notifBtn.classList.remove('primary','danger');
  }
}

// --- Accessibility for sidebar and search ---
function improveSidebarAccessibility() {
  els.sidebar.setAttribute('tabindex', '-1');
  els.sidebar.setAttribute('aria-label', 'Sidebar');
  els.sidebar.setAttribute('role', 'navigation');
  // Update nav toggle aria
  const expanded = isMobile() ? els.sidebar.classList.contains('open') : !state.ui.sidebarHiddenDesktop;
  els.navToggle.setAttribute('aria-expanded', String(expanded));
}

// Responsive helpers
function isMobile(){ return window.matchMedia('(max-width: 920px)').matches; }
function setSidebarOpenMobile(open){
  els.sidebar.classList.toggle('open', open);
  document.body.classList.toggle('sidebar-open', open);
  toggleSidebarBackdrop(open);
  els.navToggle.setAttribute('aria-expanded', String(open));
  if(open) setTimeout(()=>{ els.sidebar.focus(); }, 80);
}
function setSidebarHiddenDesktop(hidden){
  state.ui.sidebarHiddenDesktop = !!hidden;
  els.layout && els.layout.classList.toggle('sidebar-hidden', hidden);
  localStorage.setItem('focus.ui.sidebarHidden',''+(hidden?1:0));
  els.navToggle.setAttribute('aria-expanded', String(!hidden));
}

// Backdrop for mobile
let sidebarBackdrop = document.getElementById('sidebarBackdrop');
if(!sidebarBackdrop){
  sidebarBackdrop = document.createElement('div');
  sidebarBackdrop.id = 'sidebarBackdrop';
  sidebarBackdrop.className = 'sidebar-backdrop';
  document.body.appendChild(sidebarBackdrop);
}
function toggleSidebarBackdrop(show){ sidebarBackdrop.style.display = show ? 'block' : 'none'; }

// Make sidebar focusable by keyboard and toggle for both desktop/mobile
els.navToggle.addEventListener('click', ()=>{
  if(isMobile()){
    setSidebarOpenMobile(!els.sidebar.classList.contains('open'));
  }else{
    setSidebarHiddenDesktop(!state.ui.sidebarHiddenDesktop);
  }
});
sidebarBackdrop.addEventListener('click', ()=> setSidebarOpenMobile(false));

// Escape key to close sidebar
window.addEventListener('keydown', e=>{
  if (e.key === 'Escape' && els.sidebar.classList.contains('open')) {
    els.sidebar.classList.remove('open');
    els.navToggle.setAttribute('aria-expanded','false');
    els.navToggle.focus();
  }
});

// Make sure search input is always accessible and focusable
els.searchInput.setAttribute('aria-label','Search tasks');
els.searchInput.setAttribute('tabindex','0');

// Event wiring
function wire(){
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.addEventListener('click',()=>{ const v=btn.getAttribute('data-view'); if(v){ state.view=v; render(); }});
  });
  // navToggle handler defined globally for mobile/desktop
  els.newTaskBtn.addEventListener('click', createTask);
  els.notifBtn.addEventListener('click', async ()=>{
    try{
      if (!('Notification' in window)) return;
      const perm = await Notification.requestPermission();
      updateNotifBtn();
      if(perm==='granted') reminderScheduler.start();
      if(perm==='denied') alert('Notifications were blocked. Enable them in your browser settings.');
    }catch(e){
      alert('Failed to enable notifications.');
    }
  });
  els.searchInput.addEventListener('input', renderTasks);
  els.sortSelect.addEventListener('change', renderTasks);
  els.closeDetailsBtn.addEventListener('click', closeDetails);
  els.taskForm.addEventListener('submit', saveDetails);
  els.taskRepeat.addEventListener('change',()=>{
    els.taskRepeatCustom.classList.toggle('hidden', els.taskRepeat.value!=='custom');
  });
  els.addSubtaskBtn.addEventListener('click',()=>{
    const id = state.selectedTaskId; if(!id) return;
    const t = state.tasks.find(x=>x.id===id); if(!t) return;
    const title = els.newSubtaskInput.value.trim(); if(!title) return;
    t.subtasks.push({ id: uid(), title, done:false }); els.newSubtaskInput.value=''; storage.save(); openDetails(id);
  });
  els.deleteTaskBtn.addEventListener('click', deleteTask);
  els.addFilterBtn.addEventListener('click',()=>{
    const name = prompt('Filter name:'); if(!name) return;
    const query = prompt('Filter query (e.g. tag:work due:today):'); if(query==null) return;
    state.filters.push({ id: uid(), name, query }); storage.save(); render();
  });
  els.exportBtn.addEventListener('click',()=>{
    const data = { tasks: state.tasks, filters: state.filters };
    const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='focus-tasks-backup.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  });
  els.importInput.parentElement.addEventListener('click',()=> els.importInput.click());
  els.importInput.addEventListener('change', async ()=>{
    const file = els.importInput.files?.[0]; if(!file) return;
    const text = await file.text();
    try{
      const data = JSON.parse(text);
      if(Array.isArray(data.tasks)) state.tasks = data.tasks;
      if(Array.isArray(data.filters)) state.filters = data.filters;
      storage.save(); render();
    }catch{ alert('Invalid backup file'); }
  });

  // PWA install
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault(); state.installPrompt = e; els.installBtn.hidden=false;
  });
  els.installBtn.addEventListener('click', async ()=>{
    if(!state.installPrompt) return;
    state.installPrompt.prompt();
    const res = await state.installPrompt.userChoice; // eslint-disable-line no-unused-vars
    els.installBtn.hidden=true; state.installPrompt = null;
  });

  // Service worker
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }

  // Keyboard shortcuts
  window.addEventListener('keydown', (e)=>{
    if((e.target instanceof HTMLInputElement) || (e.target instanceof HTMLTextAreaElement)) return;
    if(e.key==='/' ){ e.preventDefault(); els.searchInput.focus(); return; }
    if(e.key==='n' ){ e.preventDefault(); createTask(); return; }
    if(e.key==='t' ){ e.preventDefault(); state.view='today'; render(); return; }
    if(e.key==='u' ){ e.preventDefault(); state.view='upcoming'; render(); return; }
    if(e.key==='c' ){ e.preventDefault(); state.view='calendar'; render(); return; }
    if(e.key==='a' ){ e.preventDefault(); state.view='inbox'; render(); return; }
    if(e.key==='s' ){
      e.preventDefault();
      if(isMobile()) setSidebarOpenMobile(!els.sidebar.classList.contains('open'));
      else setSidebarHiddenDesktop(!state.ui.sidebarHiddenDesktop);
      return;
    }
  });
}

// Init
storage.load();
// Load UI prefs
try{ state.ui.sidebarHiddenDesktop = localStorage.getItem('focus.ui.sidebarHidden')==='1'; }catch{}
ensureLists();
wire();
render();
reminderScheduler.start();

// Apply initial UI according to viewport and saved state
function applyResponsiveSidebarState(){
  if(isMobile()){
    setSidebarOpenMobile(false);
  }else{
    setSidebarHiddenDesktop(state.ui.sidebarHiddenDesktop);
    toggleSidebarBackdrop(false);
  }
}
applyResponsiveSidebarState();
window.addEventListener('resize', ()=>applyResponsiveSidebarState());

// --- Update notification button event ---
els.notifBtn.addEventListener('click', async ()=>{
  try{
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    updateNotifBtn();
    if(perm==='granted') reminderScheduler.start();
    if(perm==='denied') alert('Notifications were blocked. Enable them in your browser settings.');
  }catch(e){
    alert('Failed to enable notifications.');
  }
});

// --- Init and also after each render ---
function runAccessibilityEnhancements() {
  improveSidebarAccessibility();
  updateNotifBtn();
}

// inside wire():
wire = (function(origWire){
  return function(){
    origWire.call(this);
    runAccessibilityEnhancements();
  };
})(wire);
// inside render():
render = (function(origRender){
  return function(){
    origRender.call(this);
    runAccessibilityEnhancements();
  };
})(render);

// --- Enhance sidebar navigation: ---
// Only clear search on list view changes, not for tag/filter clicks
(function(){
  const origWire = wire;
  wire = function(){
    document.querySelectorAll('.nav-item').forEach(btn=>{
      // If it's a tag or custom filter, keep query; else clear search
      btn.addEventListener('click',()=>{
        const type = btn.getAttribute('data-view');
        const isList = ['inbox','today','upcoming','calendar','daily','weekly'].includes(type);
        if(isList) els.searchInput.value = '';
      });
    });
    origWire.apply(this, arguments);
  };
})();


