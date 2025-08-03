
document.addEventListener('DOMContentLoaded', () => {
  const USE_5_MIN_SLOTS = false;

  const STORAGE_KEY_EVENTS = 'ecEvents';
  const ROW_PX_30MIN = 42;
  const ROW_PX_5MIN  = 7;

  const SLOT_DURATION = USE_5_MIN_SLOTS ? '00:05:00' : '00:30:00';
  const SLOT_HEIGHT   = USE_5_MIN_SLOTS ? ROW_PX_5MIN : ROW_PX_30MIN;

  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2);

  let cal = null;

  (function initCalendar(){
    const el = document.getElementById('calendar');
    if (!el) { console.warn('No #calendar element found'); return; }

    
    let initialEvents = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY_EVENTS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          initialEvents = parsed.map(e => ({
            id: e.id || uid(),
            title: e.title || 'Busy',
            start: typeof e.startMs === 'number' ? new Date(e.startMs) : new Date(e.start),
            end:   typeof e.endMs   === 'number' ? new Date(e.endMs)   : new Date(e.end),
            classNames: Array.isArray(e.classNames) ? e.classNames : ['busy','type-busy'],
            backgroundColor: e.backgroundColor || 'red',
            textColor: e.textColor || '#fff',
            editable: e.editable !== undefined ? e.editable : true,
            extendedProps: { type: 'busy' }
          })).filter(ev => (ev.classNames||[]).includes('busy') || ev.extendedProps?.type === 'busy');
        }
      }
    } catch (_) {}

    cal = EventCalendar.create(el, {
      view: 'timeGridWeek',
      firstDay: 1,
      hiddenDays: [0],
      allDaySlot: false,
      slotDuration: SLOT_DURATION,
      slotHeight: SLOT_HEIGHT,
      slotMinTime: '08:00:00',
      slotMaxTime: '24:00:00',
      height: '900px',

      headerToolbar: { start:'', center:'', end:'' },
      dayHeaderFormat: { weekday:'short' },

            selectable: true,
      editable: true,
      eventStartEditable: true,
      eventDurationEditable: true,
      droppable: false,
      dragScroll: false,

      events: initialEvents,

      select: addBusy,
      eventDidMount: decorateEvent,

      eventDragStop(arg){
        if (isCourse(arg.event)) { renderCourseEvents(); } else { persistBusy(); }
      },
      eventDrop(arg){
        if (isCourse(arg.event)) { renderCourseEvents(); } else { persistBusy(); }
      },
      eventResize(arg){
        if (isCourse(arg.event)) { renderCourseEvents(); } else { persistBusy(); }
      }
    });

        cal.getEvents().forEach(ev => {
      if ((ev.classNames||[]).includes('busy')) ev.setProp('editable', true);
    });

        const content = el.querySelector('.ec-content');
    if (content) {
      content.style.overflowX = 'hidden';
      content.addEventListener('wheel', () => { if (content.scrollLeft !== 0) content.scrollLeft = 0; }, { passive: true });
      (function clamp(){ if (content.scrollLeft !== 0) content.scrollLeft = 0; requestAnimationFrame(clamp); })();
      window.addEventListener('resize', () => { content.scrollLeft = 0; });
    }

    function addBusy(sel){
      const ev = cal.addEvent({
        id: uid(),
        title: 'Busy',
        start: sel.start,
        end: sel.end,
        classNames: ['busy', 'type-busy'],
        backgroundColor: 'red',
        textColor: '#fff',
        editable: true,
        extendedProps: { type: 'busy' }
      });
      cal.unselect();
      if (ev) { persistBusy(); flushCalendar(); }
    }

    function persistBusy(){
      try {
                const events = cal.getEvents()
          .filter(ev => (ev.extendedProps?.type === 'busy') || (ev.classNames||[]).includes('busy'));
        const data = events.map(ev => ({
          id: ev.id,
          title: ev.title,
          startMs: ev.start.getTime(),
          endMs: ev.end.getTime(),
          backgroundColor: ev.backgroundColor,
          textColor: ev.textColor,
          classNames: ev.classNames,
          editable: ev.editable,
          type: 'busy'
        }));
        localStorage.setItem(STORAGE_KEY_EVENTS, JSON.stringify(data));

        const SLOTS_PER_DAY = 32;
        const BYTES = 24;
        const DAY0_MIN = 8 * 60;
        const DAY1_MAX = 24 * 60;
        const bits = new Uint8Array(BYTES);

        function setBit(bitIndex) {
          if (bitIndex < 0 || bitIndex >= 192) return;
          bits[bitIndex >> 3] |= (1 << (bitIndex & 7));
        }
        function dayToIdx(d) {
          const w = d.getDay();
          if (w === 0) return -1;            
          const idx = w - 1;                 
          return (idx >= 0 && idx < 6) ? idx : -1;
        }

        for (const ev of events) {
          let cur = new Date(ev.start.getTime());
          const end = new Date(ev.end.getTime());
          cur.setSeconds(0,0); end.setSeconds(0,0);

          while (cur < end) {
            const sliceDay = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
            const nextDay  = new Date(sliceDay.getTime()); nextDay.setDate(nextDay.getDate() + 1);

            const sliceStart = new Date(Math.max(cur.getTime(), sliceDay.getTime()));
            const sliceEnd   = new Date(Math.min(end.getTime(), nextDay.getTime()));

            const dIdx = dayToIdx(sliceStart);
            if (dIdx >= 0) {
              const startMin = Math.max(DAY0_MIN, sliceStart.getHours()*60 + sliceStart.getMinutes());
              const endMin   = Math.min(DAY1_MAX, sliceEnd.getHours()*60 + sliceEnd.getMinutes());

              if (endMin > startMin) {
                const startSlot = Math.max(0, Math.floor((startMin - DAY0_MIN) / 30));
                const endSlot   = Math.min(SLOTS_PER_DAY, Math.ceil((endMin - DAY0_MIN) / 30));
                for (let s = startSlot; s < endSlot; s++) {
                  const bitIndex = dIdx * SLOTS_PER_DAY + s;
                  setBit(bitIndex);
                }
              }
            }
            cur = nextDay;
          }
        }

        let bin = '';
        for (let i = 0; i < bits.length; i++) bin += String.fromCharCode(bits[i]);
        const b64 = btoa(bin);
        localStorage.setItem('manualBitsV1', b64);

        window.invalidatePlans && window.invalidatePlans();

      } catch (_) {}
    }
    window._persistBusy = persistBusy;
  })();

  function flushCalendar() {
    try {
      if (!cal) return;
      if (typeof cal.rerenderEvents === 'function') { cal.rerenderEvents(); return; }
      if (typeof cal.update === 'function') { cal.update(); return; }
      if (typeof cal.render === 'function') { cal.render(); return; }
      if (typeof cal.updateSize === 'function') { cal.updateSize(); return; }
      window.dispatchEvent(new Event('resize'));
    } catch (_) {}
  }

  const sidebarEl    = document.querySelector('.sidebar');
  const NAMES_URL    = (sidebarEl && sidebarEl.dataset.coursesUrl) || '/api/courses/names';
  const SUGGESTION_LIMIT = 12;
  const LS_SELECTED = 'selectedCoursesV1';

  const courseInput  = document.getElementById('course-search');
  const courseList   = document.getElementById('course-suggestions');
  const savedList    = document.getElementById('saved-courses');

  let names = []; let namesLC = []; let loaded = false; let activeIndex = -1;

  const debounce = (fn, ms = 120) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };
  const escapeHTML = (s) => String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const norm = (s) => s.toLowerCase().trim();
  const highlight = (text, qLC) => {
    const t = String(text || '');
    const i = t.toLowerCase().indexOf(qLC);
    if (i < 0) return escapeHTML(t);
    return escapeHTML(t.slice(0,i)) + '<mark>' + escapeHTML(t.slice(i,i+qLC.length)) + '</mark>' + escapeHTML(t.slice(i+qLC.length));
  };

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const res = await fetch(NAMES_URL, { cache: 'force-cache' });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      names = data.filter(x => typeof x === 'string');
      namesLC = names.map(n => n.toLowerCase());
      loaded = true;
      renderSaved();
      renderCourseEvents();
    } catch (e) { console.error('Failed to load names', e); }
  }

  function search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (let i = 0; i < namesLC.length && out.length < SUGGESTION_LIMIT; i++) if (namesLC[i].startsWith(q)) out.push(i);
    for (let i = 0; i < namesLC.length && out.length < SUGGESTION_LIMIT; i++) { const n = namesLC[i]; if (!n.startsWith(q) && n.includes(q)) out.push(i); }
    return out;
  }

  function renderSuggestions(idxs, q) {
    if (!courseList) return;
    activeIndex = -1;
    if (!idxs.length) { courseList.hidden = true; courseList.innerHTML=''; return; }
    const qlc = q.toLowerCase();
    courseList.hidden = false;
    courseList.innerHTML = idxs.map((i,pos) =>
      `<li data-idx="${i}" role="option" aria-selected="${pos===activeIndex}">
         <span class="name">${highlight(names[i], qlc)}</span>
       </li>`
    ).join('');
  }

  async function selectIndex(i) {
    const name = names[i];
    if (!name) return;
    if (courseInput) { courseInput.value = name; courseList.hidden = true; }
    const saved = loadSaved();
    const key = norm(name);
    if (!saved.find(x => x.key === key)) {
      saved.unshift({ key, name, savedAt: Date.now() });
      saveSaved(saved);
      renderSaved();
      renderCourseEvents();
      window.invalidatePlans && window.invalidatePlans();
    }
  }

  function loadSaved() { try { return JSON.parse(localStorage.getItem(LS_SELECTED) || '[]') || []; } catch { return []; } }
  function saveSaved(list) { localStorage.setItem(LS_SELECTED, JSON.stringify(list.slice(0,200))); }
  function removeSaved(key) {
    const list = loadSaved().filter(x => x.key !== key);
    saveSaved(list);
    renderSaved();
    renderCourseEvents();
    window.invalidatePlans && window.invalidatePlans();
  }

  if (courseInput) {
    courseInput.addEventListener('focus', ensureLoaded);
    courseInput.addEventListener('input', debounce(async () => { await ensureLoaded(); const idxs = search(courseInput.value); renderSuggestions(idxs, courseInput.value); }, 120));
    courseList?.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (!li) return; e.preventDefault(); selectIndex(Number(li.dataset.idx)); });
    courseInput.addEventListener('keydown', (e) => {
      if (!courseList || courseList.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(+1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); const li = courseList.querySelectorAll('li')[activeIndex] || courseList.querySelector('li'); if (li) selectIndex(Number(li.dataset.idx)); }
      else if (e.key === 'Escape') { courseList.hidden = true; }
    });
  }

  function moveActive(delta) {
    if (!courseList) return;
    const items = courseList.querySelectorAll('li');
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    items.forEach((el, i) => el.setAttribute('aria-selected', i === activeIndex));
    items[activeIndex].scrollIntoView({ block: 'nearest' });
  }


  const courseCache = new Map();
  async function fetchCourseByKey(key) {
    if (courseCache.has(key)) return courseCache.get(key);
    const saved = loadSaved();
    const item = saved.find(x => x.key === key);
    if (!item) return null;
    const name = item.name;
    try {
      const res = await fetch(`/api/courses/lookup?name=${encodeURIComponent(name)}`);
      const arr = res.ok ? await res.json() : [];
      const course = Array.isArray(arr) && arr[0] ? arr[0] : null;
      if (course) courseCache.set(key, course);
      return course;
    } catch (_) { return null; }
  }

  function renderSaved() {
    if (!savedList) return;
    const list = loadSaved();
    const sidebar = document.querySelector('.sidebar');
    const prevScroll = sidebar ? sidebar.scrollTop : 0;

    if (list.length === 0) {
      savedList.innerHTML = `<li class="empty-note">(none)</li>`;
    } else {
      savedList.innerHTML = list.map(item =>
        `<li class="course-card" data-key="${item.key}">
           <div class="card-head">
             <span class="swatch" style="background:${pickColorForKey(item.key)};"></span>
             <span class="name">${escapeHTML(item.name)}</span>
             <button type="button" class="rm" aria-label="Remove saved course">×</button>
           </div>
           <div class="card-panel">
             <div class="combos">Loading…</div>
           </div>
         </li>`
      ).join('');
    }

    savedList.querySelectorAll('.course-card').forEach(async (card) => {
      const key = card.dataset.key;
      const course = await fetchCourseByKey(key);
      if (course) buildCombosFor(card, course); else {
        const c = card.querySelector('.combos'); if (c) c.textContent = 'No data';
      }
    });

    if (sidebar) sidebar.scrollTop = prevScroll;
  }

  savedList?.addEventListener('click', (e) => {
    const rm = e.target.closest('rm, .rm');
    if (rm) {
      e.stopPropagation();
      const card = rm.closest('.course-card');
      if (card?.dataset.key) removeSaved(card.dataset.key);
      return;
    }
  });

  function buildCombosFor(card, course) {
    const key = card.dataset.key;
    const target = card.querySelector('.combos');
    if (!target) return;

    const saved = loadSaved();
    const item = saved.find(x => x.key === key) || { selections: {} };
    if (!item.selections) item.selections = {};

    if (!Array.isArray(course.TYPES) || !course.GROUPED) {
      target.innerHTML = `<div class="muted">No session types</div>`;
      return;
    }

    const rows = [];
    for (const t of course.TYPES) {
      const idxs = course.GROUPED[t] || [];

      const options = [`<option value="">Not selected</option>`].concat(
        idxs.map(i => {
          const s = course.COURSE_SESSIONS[i];
          const left  = s.SESSION_NAME || `${t}${i+1}`;
          const right = s.TIME_RECORD || '';
          const prof  = s.PROFESSOR || '';
          const enr   = s.ENROLLMENT || '';
          const composed = `${left} - ${right}${prof ? ' | ' + prof : ''}${enr ? ' | ' + enr : ''}`;
          return `<option value="${i}">${escapeHTML(composed)}</option>`;
        })
      ).join('');

      rows.push(
        `<div class="combo-row">
           <label class="field-label">
             ${escapeHTML(typeLabel(t))}
             <button type="button"
                     class="attend-toggle-type"
                     data-type="${escapeHTML(t)}"
                     title="Toggle attendance importance">(attended)</button>
           </label>
           <select class="combo-select" data-type="${escapeHTML(t)}">${options}</select>
         </div>`
      );
    }

    target.innerHTML = rows.join('');

        target.querySelectorAll('select.combo-select').forEach(sel => {
      const t = sel.dataset.type;
      const cur = item.selections?.[t]?.sessionIndex;
      sel.value = (typeof cur === 'number') ? String(cur) : "";
      sel.addEventListener('mousedown', ev => ev.stopPropagation());
      sel.addEventListener('click', ev => ev.stopPropagation());
      sel.addEventListener('touchstart', ev => ev.stopPropagation(), { passive: true });
    });

        target.querySelectorAll('button.attend-toggle-type').forEach(btn => {
      const type = btn.dataset.type;
      const cur  = item.selections?.[type];
      const on   = cur ? (cur.attended !== false) : true; 
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? '(attended)' : '(not attended)';
    });

    if (!target.dataset.bound) {
            target.addEventListener('change', (e) => {
        const sel = e.target.closest('select.combo-select');
        if (!sel) return;
        const type = sel.dataset.type;
        const val  = sel.value;

        const list = loadSaved();
        const it = list.find(x => x.key === key);
        if (!it) return;
        if (!it.selections) it.selections = {};

        if (val === "") {
          delete it.selections[type];
        } else {
          const idx = Number(val);
          const s   = course.COURSE_SESSIONS[idx];
          const bitsB64 = s?.TIME_BITS || "";
          const timeMap = parseTimeRecord(s?.TIME_RECORD || "");
          const prev    = it.selections[type] || {};
          const wasPinned = !!prev.pinned && prev.sessionIndex === idx;
          const timeRelevance = s?.TIME_RELEVANCE || 0;
          const sessionName = s?.SESSION_NAME || `${type}${idx+1}`;
          const attended = (prev.attended !== false); 

          it.selections[type] = {
            sessionIndex: idx,
            bitsB64, timeMap, timeRelevance, sessionName,
            pinned: wasPinned,
            attended
          };
        }
        saveSaved(list);
        renderCourseEvents();
        window.invalidatePlans && window.invalidatePlans();
      });

            target.addEventListener('click', (e) => {
        const btn = e.target.closest('button.attend-toggle-type');
        if (!btn) return;
        const type = btn.dataset.type;

        const list = loadSaved();
        const it   = list.find(x => x.key === key);
        if (!it) return;
        it.selections = it.selections || {};
        const cur = it.selections[type] || {};

        const turnOn = !(btn.getAttribute('aria-pressed') === 'true'); 
        cur.attended = turnOn;

        it.selections[type] = cur;
        saveSaved(list);

                btn.setAttribute('aria-pressed', String(turnOn));
        btn.textContent = turnOn ? '(attended)' : '(not attended)';

        renderSaved();
        renderCourseEvents();
        window.invalidatePlans && window.invalidatePlans();
      });

      target.dataset.bound = 'true';
    }
  }

  function typeLabel(t){
    const map = { L: 'Lecture', R: 'Recitation', P: 'Practice', Lab: 'Lab' };
    return map[t] || `Type ${t}`;
  }


  function decorateEvent(arg){
    const ev = arg.event;
    const t  = ev.extendedProps?.type;

        if (t === 'busy' || (ev.classNames||[]).includes('busy')) {
      try { ev.setProp && ev.setProp('editable', true); } catch(_){}
      if (!arg.el.querySelector('.close-btn')) {
        const btn = document.createElement('span');
        btn.textContent = '×';
        btn.className = 'close-btn';
        btn.style.pointerEvents = 'auto';
        btn.addEventListener('pointerdown', e => e.stopPropagation());
        btn.addEventListener('click', e => {
          e.stopPropagation();
          cal.removeEventById(ev.id);
          window._persistBusy && window._persistBusy();
          flushCalendar();
        });
        arg.el.appendChild(btn);
      }
      return;
    }

        if (isCourse(ev)) {
      try { ev.setProp && ev.setProp('editable', false); } catch(_){}
      const ep = ev.extendedProps || {};
      const pinned = isSelectionPinned(ep.courseKey, ep.typeCode, ep.sessionIndex);
      if (pinned) arg.el.classList.add('pinned'); else arg.el.classList.remove('pinned');

      if (!arg.el.dataset.pinBound) {
        arg.el.dataset.pinBound = '1';
        arg.el.style.cursor = 'pointer';
        arg.el.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
        arg.el.addEventListener('click', async (e) => {
          e.stopPropagation();
          await togglePinFromEvent(ep);
        });
      }
      return;
    }
  }

  function isCourse(ev){
    return (ev?.extendedProps?.type === 'course') || (ev?.classNames||[]).includes('course');
  }

  function isSelectionPinned(courseKey, typeCode, sessionIndex){
    const list = loadSaved();
    const item = list.find(x => x.key === courseKey);
    const sel  = item?.selections?.[typeCode];
    if (!sel) return false;
    if (typeof sessionIndex === 'number' && sel.sessionIndex !== sessionIndex) return false;
    return !!sel.pinned;
  }

  async function togglePinFromEvent(ep){
    const { courseKey, typeCode, sessionIndex } = ep;
    let list = loadSaved();
    const item = list.find(x => x.key === courseKey);
    if (!item) return;

    item.selections = item.selections || {};
    const cur = item.selections[typeCode];

    if (!cur || cur.sessionIndex !== sessionIndex) {
      const course = await fetchCourseByKey(courseKey);
      if (!course) return;
      const s = (course.COURSE_SESSIONS || [])[sessionIndex];
      if (!s) return;
      const bitsB64 = s.TIME_BITS || "";
      const timeMap = parseTimeRecord(s.TIME_RECORD || "");
      const timeRelevance = s.TIME_RELEVANCE || 0;
      const sessionName = s.SESSION_NAME || `${typeCode}${sessionIndex+1}`;
      const attended = cur ? (cur.attended !== false) : true; 
      item.selections[typeCode] = { sessionIndex, bitsB64, timeMap, timeRelevance, sessionName, pinned: true, attended };
    } else {
      item.selections[typeCode].pinned = !item.selections[typeCode].pinned;
    }

    saveSaved(list);
    renderSaved();
    renderCourseEvents();
    window.invalidatePlans && window.invalidatePlans();
  }



  let paintQueued = false;
  function renderCourseEvents() {
    if (!cal) return;
    if (paintQueued) return;
    paintQueued = true;

    requestAnimationFrame(() => {
      paintQueued = false;

      const list = loadSaved();
      const weekStart = getWeekStartMonday(new Date());

      const desired = new Map();
      for (const item of list) {
        const key = item.key;
        const color = pickColorForKey(key);
        const sels = item.selections || {};
        for (const t of Object.keys(sels)) {
          const info = sels[t];
          if (info && typeof info.timeRelevance === 'number' && info.timeRelevance === 0) continue;
          if (!info || typeof info.sessionIndex !== 'number') continue;
          const bitsU8 = b64ToBytes(info.bitsB64);
          if (!bitsU8) continue;

          const pinned = !!info.pinned;
          const intervals = intervalsFromBits(bitsU8);
          for (const iv of intervals) {
            let startMin = 8 * 60 + iv.startSlot * 30;
            let endMin   = 8 * 60 + iv.endSlot   * 30;
            const tm = info.timeMap && info.timeMap[iv.day];
            if (tm && Number.isFinite(tm.startMin) && Number.isFinite(tm.endMin)) {
              startMin = tm.startMin; endMin = tm.endMin;
            }
            const id = courseEventIdMins(key, t, iv.day, startMin, endMin);
            const { start, end } = minsToDates(weekStart, iv.day, startMin, endMin);

            const cls = ['course', `course-${key}`]; if (pinned) cls.push('pinned');

            const sessName = info.sessionName || `${t}`;
            desired.set(id, {
              id,
              title: `${item.name} — ${sessName}`,
              start, end,
              backgroundColor: color,
              textColor: '#fff',
              classNames: cls,
              extendedProps: { type: 'course', courseKey: key, typeCode: t, sessionIndex: info.sessionIndex },
              editable: false
            });
          }
        }
      }

      const existing = cal.getEvents().filter(ev => isCourse(ev));
      const existingMap = new Map(existing.map(ev => [ev.id, ev]));

      desired.forEach(desc => {
        const ev = cal.getEventById ? cal.getEventById(desc.id) : existingMap.get(desc.id);
        if (ev) {
          const needsTime = ev.start.getTime() !== desc.start.getTime() || ev.end.getTime() !== desc.end.getTime();
          const needsColor = ev.backgroundColor !== desc.backgroundColor || ev.textColor !== desc.textColor;
          const needsClass = JSON.stringify(ev.classNames || []) !== JSON.stringify(desc.classNames || []);
          const needsTitle = ev.title !== desc.title;
          if (needsTime || needsColor || needsClass || needsTitle) {
            if (typeof cal.updateEvent === 'function') {
              cal.updateEvent({
                id: desc.id, title: desc.title, start: desc.start, end: desc.end,
                backgroundColor: desc.backgroundColor, textColor: desc.textColor,
                classNames: desc.classNames, extendedProps: desc.extendedProps, editable: false
              });
            } else {
              if (typeof cal.removeEventById === 'function') cal.removeEventById(desc.id);
              cal.addEvent(desc);
            }
          }
        } else {
          cal.addEvent(desc);
        }
      });

      for (const ev of existing) {
        if (!desired.has(ev.id)) {
          if (typeof cal.removeEventById === 'function') cal.removeEventById(ev.id);
          else ev.remove();
        }
      }

      flushCalendar();
    });
  }
  window.renderCourseEvents = renderCourseEvents;

    function intervalsFromBits(bitsU8) {
    const DAYS = 6, SLOTS_PER_DAY = 32;
    const out = [];
    for (let d = 0; d < DAYS; d++) {
      let i = 0;
      while (i < SLOTS_PER_DAY) {
        const fi = d * SLOTS_PER_DAY + i;
        const b = (bitsU8[fi >> 3] >> (fi & 7)) & 1;
        if (!b) { i++; continue; }
        let j = i + 1;
        while (j < SLOTS_PER_DAY) {
          const fj = d * SLOTS_PER_DAY + j;
          const b2 = (bitsU8[fj >> 3] >> (fj & 7)) & 1;
          if (!b2) break;
          j++;
        }
        out.push({ day: d, startSlot: i, endSlot: j });
        i = j;
      }
    }
    return out;
  }

  initautoschedulerUI();
  function initautoschedulerUI() {
    const box = document.querySelector('.calendar-box');
    if (!box) return;

    const wrap = document.createElement('div');
    wrap.className = 'autoscheduler-wrap';
    wrap.innerHTML = `
      <button class="autoscheduler-fab" title="Find optimal schedule" aria-label="Find schedule">🎲</button>
      <div class="autoscheduler-pop" hidden></div>
    `;
    box.style.position = 'relative';
    box.appendChild(wrap);

    const btn = wrap.querySelector('.autoscheduler-fab');
    const pop = wrap.querySelector('.autoscheduler-pop');

    let plans = null;
    let pick  = 0;
    let solving = false;

        window.invalidatePlans = function () {
      plans = null;
      pick  = 0;
    };

    async function triggerautoschedule() {
      if (solving) return;
      solving = true;
      try {
        btn.disabled = true; btn.classList.add('loading');

        if (!plans || !plans.length) {
          const payload = await buildautoschedulerPayload();
          if (!payload) { showPop(pop, 'Add courses first.'); return; }

          const res = await fetch('/api/autoschedule', {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            body: JSON.stringify(payload)
          });
          if (!res.ok) {
            showPop(pop, `autoscheduler error (${res.status})`);
            return;
          }
          const body = await res.json();
          if (!body.ok) {
            showPop(pop, body.message || 'No plan found.');
            return;
          }
          plans = Array.isArray(body.allOptimal) && body.allOptimal.length ? body.allOptimal
                : (body.chosenPlan ? [body.chosenPlan] : []);
          pick = 0;

          if (!plans.length) {
            showPop(pop, 'No plan found.');
            return;
          }
        } else {
                    pick = (pick + 1) % plans.length;
        }

                await applyPlan(plans[pick]);

        const s = plans[pick].summary || {};
        const badge = plans.length > 1 ? ` (${pick+1}/${plans.length})` : '';
        showPop(pop, `Busy clash: ${s.busyOverlapMin || 0}m · Gaps: ${s.gapMin || 0}m${badge}`);
      } catch (e) {
        console.error('autoscheduler', e);
        showPop(pop, 'Failed to contact autoscheduler.');
      } finally {
        btn.disabled = false; btn.classList.remove('loading'); solving = false;
      }
    }

    btn.addEventListener('click', triggerautoschedule);
        document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault(); triggerautoschedule();
      }
    });

    window._debugautoschedule = triggerautoschedule;
  }

  async function buildautoschedulerPayload() {
    const saved = loadSaved(); if (!saved.length) return null;
    const busyBitsB64 = localStorage.getItem('manualBitsV1') || "";
    const coursesPayload = [];
    for (const c of saved) {
      const res = await fetch(`/api/courses/lookup?name=${encodeURIComponent(c.name)}`);
      const arr = res.ok ? await res.json() : [];
      const course = Array.isArray(arr) && arr[0] ? arr[0] : null;
      if (!course || !Array.isArray(course.TYPES) || !course.GROUPED) continue;

      const types = [];
      for (const code of course.TYPES) {
        const idxs = course.GROUPED[code] || [];
        const sessions = idxs
          .map(i => {
            const s = course.COURSE_SESSIONS[i];
            return s && (s.TIME_RELEVANCE === undefined || s.TIME_RELEVANCE)
              ? { index: i, bitsB64: s.TIME_BITS || "" }
              : null;
          })
          .filter(Boolean);

                let pinnedIndex = null;
        const sel = (c.selections && c.selections[code]) ? c.selections[code] : null;
        if (sel && sel.pinned === true && typeof sel.sessionIndex === 'number') {
          const chosen = course.COURSE_SESSIONS[sel.sessionIndex];
          if (chosen && (chosen.TIME_RELEVANCE === undefined || chosen.TIME_RELEVANCE)) {
            pinnedIndex = sel.sessionIndex;
          }
        }

                const attendImportant = sel ? (sel.attended !== false) : true;

        types.push({ code, pinnedIndex, attendImportant, sessions });
      }
      coursesPayload.push({ key: c.key, name: c.name, types });
    }
    if (!coursesPayload.length) return null;
    return { busyBitsB64, courses: coursesPayload };
  }

  async function applyPlan(plan) {
        const saved = loadSaved();
    if (!saved.length) return;

        const coursePayloadByKey = new Map();
    for (const c of saved) {
      const course = await fetchCourseByKey(c.key);
      if (!course) continue;
            const typeMap = new Map();
      for (const code of course.TYPES || []) {
        const idxs = course.GROUPED[code] || [];
        const sess = new Map();
        for (const i of idxs) {
          const s = course.COURSE_SESSIONS[i];
          sess.set(i, { bitsB64: s.TIME_BITS || "", timeMap: parseTimeRecord(s.TIME_RECORD || ""), sessionName: s.SESSION_NAME || `${code}${i+1}` });
        }
        typeMap.set(code, sess);
      }
      coursePayloadByKey.set(c.key, typeMap);
    }

    const byKeyType = new Map();
    for (const a of (plan.assignments || [])) {
      byKeyType.set(a.courseKey + '|' + a.typeCode, a.sessionIndex);
    }

    const updated = saved.map(c => {
      c.selections = c.selections || {};
      const typeMap = coursePayloadByKey.get(c.key);
      if (!typeMap) return c;

      for (const [code, sessMap] of typeMap.entries()) {
        const k = c.key + '|' + code;
        const chosenIdx = byKeyType.get(k);
        if (typeof chosenIdx === 'number') {
          const sInfo = sessMap.get(chosenIdx) || { bitsB64:"", timeMap:{}, sessionName:`${code}${chosenIdx+1}` };
          const prev  = c.selections[code] || {};
          c.selections[code] = {
            sessionIndex: chosenIdx,
            bitsB64: sInfo.bitsB64,
            timeMap: sInfo.timeMap,
            sessionName: sInfo.sessionName,
            pinned: !!(prev.pinned && prev.sessionIndex===chosenIdx),
            attended: (prev.attended !== false) 
          };
        }
      }
      return c;
    });

    localStorage.setItem(LS_SELECTED, JSON.stringify(updated));
    renderSaved();          
    renderCourseEvents();   
  }

  function showPop(el, text) {
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 3500);
  }


  function pickColorForKey(key) {
    let h = 0; for (let i = 0; i < key.length; i++) h = (h * 131 + key.charCodeAt(i)) >>> 0;
    h = h % 360; const s = 68, l = 52; return hslToHex(h, s, l);
  }
  function hslToHex(h, s, l) {
    s/=100; l/=100; const c = (1 - Math.abs(2*l - 1)) * s; const x = c * (1 - Math.abs((h/60)%2 - 1)); const m = l - c/2;
    let r=0,g=0,b=0;
    if (0<=h && h<60){ r=c; g=x; b=0; }
    else if (60<=h && h<120){ r=x; g=c; b=0; }
    else if (120<=h && h<180){ r=0; g=c; b=x; }
    else if (180<=h && h<240){ r=0; g=x; b=c; }
    else if (240<=h && h<300){ r=x; g=0; b=c; }
    else { r=c; g=0; b=x; }
    r = Math.round((r+m)*255); g=Math.round((g+m)*255); b=Math.round((b+m)*255);
    return '#' + [r,g,b].map(v=>v.toString(16)).map(s=>s.padStart(2,'0')).join('');
  }

  function b64ToBytes(b64) {
    try { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
    catch { return null; }
  }

  function getWeekStartMonday(d) {
    const out = new Date(d); out.setHours(0,0,0,0);
    const day = out.getDay(); const delta = (day === 0 ? -6 : 1 - day);
    out.setDate(out.getDate() + delta); return out;
  }

  function parseTimeRecord(str) {
    if (!str) return {};
    let s = String(str).trim().replace(/\u2013|\u2014/g, '-');
    const m = s.match(/([0-2]?\d)(?::([0-5]\d))?\s*(am|pm)?\s*-\s*([0-2]?\d)(?::([0-5]\d))?\s*(am|pm)?/i);
    if (!m) return {};
    const h1 = parseInt(m[1],10), m1 = m[2] ? parseInt(m[2],10) : 0, ap1 = m[3] ? m[3].toLowerCase() : null;
    const h2 = parseInt(m[4],10), m2 = m[5] ? parseInt(m[5],10) : 0, ap2 = m[6] ? m[6].toLowerCase() : null;
    const ap = ap2 || ap1 || null;
    const startMin = toMinutes(h1, m1, ap);
    const endMin   = toMinutes(h2, m2, ap);
    const idx = s.indexOf(m[0]);
    const daysPartRaw = idx >= 0 ? s.slice(0, idx).trim() : '';
    if (!daysPartRaw) return {};
    let dnorm = daysPartRaw.toLowerCase();
    dnorm = dnorm
      .replace(/\bmondays?\b|\bmon\b/gi, 'M').replace(/\btuesdays?\b|\btuesday\b|\btue\b|\btues\b|\btu\b/gi, 'T')
      .replace(/\bwednesdays?\b|\bwed\b/gi, 'W').replace(/\bthursdays?\b|\bthursday\b|\bthu\b|\bthur\b|\bthurs\b|\bth\b/gi, 'R')
      .replace(/\bfridays?\b|\bfri\b/gi, 'F').replace(/\bsaturdays?\b|\bsat\b|\bsa\b/gi, 'S')
      .replace(/\bsundays?\b|\bsun\b/gi, 'U')
      .replace(/tth/gi, 'TR').replace(/tuth/gi, 'TR').replace(/tu/gi, 'T');
    const letters = Array.from(dnorm.toUpperCase()).filter(ch => 'MTWRFSU'.includes(ch));
    const map = {}; const L2D = { M:0, T:1, W:2, R:3, F:4, S:5, U:6 };
    for (const ch of letters) { const d = L2D[ch]; if (d !== undefined) map[d] = { startMin, endMin }; }
    return map;
  }
  function toMinutes(h, m, ap) { if (ap) { let hh = h % 12; if (ap === 'pm') hh += 12; return hh*60 + m; } return h*60 + m; }
  function minsToDates(weekStart, day, startMin, endMin) {
    const start = new Date(weekStart); start.setDate(start.getDate() + day); start.setHours(0, startMin, 0, 0);
    const end = new Date(weekStart);   end.setDate(end.getDate() + day);   end.setHours(0, endMin, 0, 0);
    return { start, end };
  }
  function courseEventIdMins(courseKey, typeCode, day, startMin, endMin) { return `CE:${courseKey}:${typeCode}:${day}:${startMin}-${endMin}`; }

    renderSaved();
  renderCourseEvents();
  ensureLoaded();

});