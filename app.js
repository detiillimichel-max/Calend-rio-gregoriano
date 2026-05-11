'use strict';

/* ════════════════════════════════════════════════════════════
   OIO CALENDAR — app.js
   Firebase Realtime Database · Auth · Multi-user
   ────────────────────────────────────────────────────────────
   ⚙️  CONFIGURAÇÃO: substitua os valores abaixo com os dados
       do seu projeto no Firebase Console.
       Console → Configurações → Seus apps → Config do SDK
════════════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey:            "SUA_API_KEY",
  authDomain:        "SEU_PROJETO.firebaseapp.com",
  databaseURL:       "https://SEU_PROJETO-default-rtdb.firebaseio.com",
  projectId:         "SEU_PROJETO",
  storageBucket:     "SEU_PROJETO.appspot.com",
  messagingSenderId: "SEU_MESSAGING_ID",
  appId:             "SEU_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.database();

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */
let currentUser     = null;
let userData        = null;
let viewDate        = new Date();
let allEvents       = {};         // { eventId: eventObj }
let editingEventId  = null;
let selectedColor   = '#00e5ff';
let selectedCat     = 'Pessoal';
let pendingInvitees = [];         // [{ uid, email, name }]
let dbListeners     = [];
let reminderTimer   = null;
let notifiedSet     = new Set();

/* ════════════════════════════════════════════════════════════
   AUTH STATE
════════════════════════════════════════════════════════════ */
auth.onAuthStateChanged(async user => {
  if (user) {
    currentUser = user;
    await ensureProfile(user);
    showScreen('app');
    subscribeEvents();
    subscribeInvitations();
    requestNotifPermission();
    startReminderChecker();
  } else {
    currentUser = null;
    stopListeners();
    showScreen('auth');
  }
});

async function ensureProfile(user) {
  const ref  = db.ref(`users/${user.uid}`);
  const snap = await ref.once('value');
  if (!snap.exists()) {
    await ref.set({
      name:     user.displayName || 'Usuário',
      email:    user.email,
      photoURL: user.photoURL || null,
      createdAt: Date.now()
    });
  }
  userData = (await ref.once('value')).val();

  // Email → UID lookup index
  await db.ref(`emailIndex/${emailKey(user.email)}`).set(user.uid);
  updateUserUI();
}

/* encode email to valid Firebase key */
function emailKey(email) {
  return email.toLowerCase().replace(/\./g, ',').replace(/@/g, '_at_');
}

/* ════════════════════════════════════════════════════════════
   SCREEN MANAGEMENT
════════════════════════════════════════════════════════════ */
function showScreen(name) {
  document.getElementById('auth-screen').classList.toggle('hidden', name !== 'auth');
  document.getElementById('app-screen').classList.toggle('hidden', name !== 'app');
  if (name === 'app') {
    renderCalendar();
    renderUpcoming();
  }
}

function updateUserUI() {
  const name    = userData?.name || currentUser?.displayName || 'U';
  const email   = userData?.email || currentUser?.email || '';
  const initial = name.charAt(0).toUpperCase();
  el('sb-avatar').textContent = initial;
  el('sb-name').textContent   = name;
  el('sb-email').textContent  = email;
}

/* ════════════════════════════════════════════════════════════
   FIREBASE REALTIME SUBSCRIPTIONS
════════════════════════════════════════════════════════════ */
function subscribeEvents() {
  if (!currentUser) return;
  const ref = db.ref(`userEvents/${currentUser.uid}`);

  const listener = ref.on('value', async snap => {
    const ids = Object.keys(snap.val() || {});
    if (ids.length === 0) { allEvents = {}; renderCalendar(); renderUpcoming(); return; }

    const snaps = await Promise.all(ids.map(id => db.ref(`events/${id}`).once('value')));
    allEvents = {};
    snaps.forEach(s => { if (s.exists()) allEvents[s.key] = s.val(); });

    renderCalendar();
    renderUpcoming();
  });

  dbListeners.push({ ref, listener, event: 'value' });
}

function subscribeInvitations() {
  if (!currentUser) return;
  const ref = db.ref(`invitations/${currentUser.uid}`);

  const listener = ref.on('value', snap => {
    const invitations = snap.val() || {};
    const pending = Object.values(invitations).filter(i => i.status === 'pending');
    const badge   = el('invite-count');
    if (pending.length > 0) {
      badge.textContent = pending.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
    renderInvitations(invitations);
  });

  dbListeners.push({ ref, listener, event: 'value' });
}

function stopListeners() {
  dbListeners.forEach(({ ref, listener, event: ev }) => ref.off(ev, listener));
  dbListeners = [];
  allEvents   = {};
  if (reminderTimer) clearInterval(reminderTimer);
}

/* ════════════════════════════════════════════════════════════
   CALENDAR RENDERING
════════════════════════════════════════════════════════════ */
const MONTHS_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                   'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function renderCalendar() {
  const grid = el('cal-grid');

  // Keep only the 7 header cells
  const headers = [...grid.querySelectorAll('.cal-header')];
  grid.innerHTML = '';
  headers.forEach(h => grid.appendChild(h));

  el('month-label').textContent = `${MONTHS_PT[viewDate.getMonth()]} ${viewDate.getFullYear()}`;

  const year     = viewDate.getFullYear();
  const month    = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();   // 0=Sun
  const daysInM  = new Date(year, month + 1, 0).getDate();
  const daysInP  = new Date(year, month, 0).getDate();
  const today    = new Date();

  // Group events by "Y-M-D" key
  const byDate = {};
  Object.entries(allEvents).forEach(([eid, evt]) => {
    if (!evt?.start) return;
    const d   = new Date(evt.start);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    (byDate[key] = byDate[key] || []).push({ id: eid, ...evt });
  });

  // Prev-month filler
  for (let i = firstDay - 1; i >= 0; i--)
    grid.appendChild(makeCell(year, month - 1, daysInP - i, true, byDate, today));

  // Current month
  for (let d = 1; d <= daysInM; d++)
    grid.appendChild(makeCell(year, month, d, false, byDate, today));

  // Next-month filler
  const total   = firstDay + daysInM;
  const padding = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let d = 1; d <= padding; d++)
    grid.appendChild(makeCell(year, month + 1, d, true, byDate, today));
}

function makeCell(year, month, day, isOther, byDate, today) {
  const date    = new Date(year, month, day);
  const key     = `${year}-${month}-${day}`;
  const isToday = date.toDateString() === today.toDateString();

  const cell = document.createElement('div');
  cell.className = `cal-day${isOther ? ' other-month' : ''}${isToday ? ' today' : ''}`;

  const numEl = document.createElement('div');
  numEl.className   = 'day-num';
  numEl.textContent = day;
  cell.appendChild(numEl);

  const evts       = byDate[key] || [];
  const evtWrap    = document.createElement('div');
  evtWrap.className = 'day-events';
  const MAX = 3;

  evts.slice(0, MAX).forEach(evt => {
    const pill = document.createElement('div');
    pill.className        = 'day-event';
    pill.style.background = evt.color || '#00e5ff';
    pill.textContent      = evt.title || '(sem título)';
    pill.addEventListener('click', e => { e.stopPropagation(); openEditModal(evt.id); });
    evtWrap.appendChild(pill);
  });

  if (evts.length > MAX) {
    const more = document.createElement('div');
    more.className   = 'more-events';
    more.textContent = `+${evts.length - MAX} mais`;
    evtWrap.appendChild(more);
  }

  cell.appendChild(evtWrap);

  if (!isOther) cell.addEventListener('click', () => openNewModal(date));
  return cell;
}

/* ════════════════════════════════════════════════════════════
   UPCOMING VIEW
════════════════════════════════════════════════════════════ */
function renderUpcoming() {
  const container = el('upcoming-list');
  const now       = new Date();

  const upcoming = Object.entries(allEvents)
    .filter(([, e]) => e?.start && new Date(e.start) >= now)
    .sort(([,a],[,b]) => new Date(a.start) - new Date(b.start))
    .slice(0, 30);

  if (upcoming.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>Nenhum evento próximo</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  upcoming.forEach(([eid, evt]) => container.appendChild(makeEventCard(eid, evt)));
}

function makeEventCard(eid, evt) {
  const card = document.createElement('div');
  card.className             = 'event-card';
  card.style.borderLeftColor = evt.color || '#00e5ff';

  const start   = evt.start ? new Date(evt.start) : null;
  const timeStr = start ? fmtDateTime(start) : '—';

  card.innerHTML = `
    <div class="event-card-title">${esc(evt.title || '(sem título)')}</div>
    <div class="event-card-time">⏰ ${timeStr}</div>
    ${evt.category ? `<div class="event-card-cat" style="color:${evt.color}">${esc(evt.category)}</div>` : ''}
  `;
  card.addEventListener('click', () => openEditModal(eid));
  return card;
}

/* ════════════════════════════════════════════════════════════
   INVITATIONS VIEW
════════════════════════════════════════════════════════════ */
function renderInvitations(invitations) {
  const container = el('invitations-list');
  const entries   = Object.entries(invitations);

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📨</div>
        <p>Nenhum convite recebido</p>
      </div>`;
    return;
  }

  container.innerHTML = '';

  entries.forEach(([eventId, inv]) => {
    const card   = document.createElement('div');
    card.className = 'invite-card';

    const start = inv.eventStart ? fmtDateTime(new Date(inv.eventStart)) : '—';

    const statusHtml = inv.status === 'accepted'
      ? '<span style="color:#10b981;font-size:12px;margin-top:6px;display:block">✓ Aceito</span>'
      : inv.status === 'declined'
      ? '<span style="color:#ef4444;font-size:12px;margin-top:6px;display:block">✗ Recusado</span>'
      : '';

    const actionsHtml = inv.status === 'pending' ? `
      <div class="invite-actions">
        <button class="btn-accept">✓ Aceitar</button>
        <button class="btn-decline">✗ Recusar</button>
      </div>` : '';

    card.innerHTML = `
      <div class="invite-card-from">De: ${esc(inv.fromName || 'Usuário')}</div>
      <div class="invite-card-title">${esc(inv.eventTitle || '(sem título)')}</div>
      <div class="event-card-time" style="margin-top:4px">⏰ ${start}</div>
      ${statusHtml}${actionsHtml}
    `;

    card.querySelector('.btn-accept')?.addEventListener('click', () =>
      respondToInvitation(eventId, 'accepted'));
    card.querySelector('.btn-decline')?.addEventListener('click', () =>
      respondToInvitation(eventId, 'declined'));

    container.appendChild(card);
  });
}

async function respondToInvitation(eventId, status) {
  if (!currentUser) return;
  await db.ref(`invitations/${currentUser.uid}/${eventId}`).update({ status });

  if (status === 'accepted') {
    await db.ref(`events/${eventId}/invitees/${currentUser.uid}`).set('accepted');
    await db.ref(`userEvents/${currentUser.uid}/${eventId}`).set(true);
    toast('✓ Convite aceito! Evento adicionado ao seu calendário.');
  } else {
    await db.ref(`events/${eventId}/invitees/${currentUser.uid}`).set('declined');
    await db.ref(`userEvents/${currentUser.uid}/${eventId}`).remove();
    toast('Convite recusado.');
  }
}

/* ════════════════════════════════════════════════════════════
   MODAL — OPEN / CLOSE
════════════════════════════════════════════════════════════ */
function openNewModal(date) {
  editingEventId  = null;
  pendingInvitees = [];
  selectedColor   = '#00e5ff';
  selectedCat     = 'Pessoal';

  el('modal-heading').textContent  = 'Novo Evento';
  el('evt-title').value            = '';
  el('evt-desc').value             = '';
  el('evt-reminder').value         = '0';
  el('invitees-chips').innerHTML   = '';
  el('btn-delete-event').classList.add('hidden');

  const start = new Date(date);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + 3600000);

  el('evt-start').value = toLocal(start);
  el('evt-end').value   = toLocal(end);

  setColorPicker('#00e5ff', 'Pessoal');
  el('event-modal').classList.remove('hidden');
  el('evt-title').focus();
}

function openEditModal(eventId) {
  const evt = allEvents[eventId];
  if (!evt) return;

  editingEventId  = eventId;
  pendingInvitees = [];
  selectedColor   = evt.color || '#00e5ff';
  selectedCat     = evt.category || 'Pessoal';

  el('modal-heading').textContent = 'Editar Evento';
  el('evt-title').value           = evt.title || '';
  el('evt-desc').value            = evt.description || '';
  el('evt-start').value           = evt.start ? toLocal(new Date(evt.start)) : '';
  el('evt-end').value             = evt.end   ? toLocal(new Date(evt.end))   : '';
  el('evt-reminder').value        = String(evt.reminder || 0);

  // Render existing invitees as chips
  const chips = el('invitees-chips');
  chips.innerHTML = '';
  if (evt.invitees) {
    Object.entries(evt.invitees).forEach(([uid, status]) => {
      if (uid !== currentUser?.uid) addChip({ uid, email: uid, name: uid, status });
    });
  }

  const delBtn = el('btn-delete-event');
  evt.createdBy === currentUser?.uid
    ? delBtn.classList.remove('hidden')
    : delBtn.classList.add('hidden');

  setColorPicker(selectedColor, selectedCat);
  el('event-modal').classList.remove('hidden');
  el('evt-title').focus();
}

function closeModal() {
  el('event-modal').classList.add('hidden');
}

function setColorPicker(color, cat) {
  document.querySelectorAll('.cp-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.color === color));
  el('cat-label').textContent = cat;
  selectedColor = color;
  selectedCat   = cat;
}

/* ════════════════════════════════════════════════════════════
   SAVE / DELETE EVENTS
════════════════════════════════════════════════════════════ */
async function saveEvent() {
  const title = el('evt-title').value.trim();
  if (!title) { toast('⚠️ Título é obrigatório'); return; }

  const startVal = el('evt-start').value;
  if (!startVal) { toast('⚠️ Data de início obrigatória'); return; }

  const endVal  = el('evt-end').value;
  const desc    = el('evt-desc').value.trim();
  const reminder = parseInt(el('evt-reminder').value) || 0;

  const saveBtn = el('btn-save-event');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Salvando…';

  try {
    const payload = {
      title,
      description: desc,
      start:       new Date(startVal).toISOString(),
      end:         endVal ? new Date(endVal).toISOString() : new Date(startVal).toISOString(),
      color:       selectedColor,
      category:    selectedCat,
      reminder,
      createdBy:   currentUser.uid,
      updatedAt:   Date.now()
    };

    let eid = editingEventId;

    if (!eid) {
      // Create
      payload.createdAt = Date.now();
      const ref = db.ref('events').push();
      eid = ref.key;
      await ref.set(payload);
      await db.ref(`userEvents/${currentUser.uid}/${eid}`).set(true);
    } else {
      // Update
      const existing = allEvents[eid] || {};
      await db.ref(`events/${eid}`).update({
        ...payload,
        createdAt: existing.createdAt || Date.now(),
        createdBy: existing.createdBy || currentUser.uid
      });
    }

    if (pendingInvitees.length > 0) await sendInvitations(eid, payload);

    closeModal();
    toast('✓ Evento salvo!');
  } catch (err) {
    console.error(err);
    toast('❌ Erro ao salvar evento');
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Salvar';
  }
}

async function deleteEvent() {
  if (!editingEventId || !currentUser) return;
  const evt = allEvents[editingEventId];
  if (!evt || evt.createdBy !== currentUser.uid) {
    toast('Apenas o criador pode deletar'); return;
  }
  if (!confirm('Deseja deletar este evento?')) return;

  try {
    const updates = {};
    updates[`events/${editingEventId}`] = null;
    updates[`userEvents/${currentUser.uid}/${editingEventId}`] = null;

    Object.keys(evt.invitees || {}).forEach(uid => {
      updates[`userEvents/${uid}/${editingEventId}`] = null;
      updates[`invitations/${uid}/${editingEventId}`] = null;
    });

    await db.ref().update(updates);
    closeModal();
    toast('🗑 Evento deletado');
  } catch (err) {
    console.error(err);
    toast('❌ Erro ao deletar');
  }
}

/* ════════════════════════════════════════════════════════════
   INVITATIONS — SEND
════════════════════════════════════════════════════════════ */
async function addInvitee() {
  const email = el('invite-email-input').value.trim().toLowerCase();
  if (!email) return;

  if (email === currentUser.email.toLowerCase()) {
    toast('Você já é o criador do evento'); return;
  }
  if (pendingInvitees.find(i => i.email === email)) {
    toast('Usuário já adicionado'); return;
  }

  const btn = el('btn-add-invitee');
  btn.disabled    = true;
  btn.textContent = '…';

  try {
    const snap = await db.ref(`emailIndex/${emailKey(email)}`).once('value');
    if (!snap.exists()) {
      toast('❌ Usuário não encontrado. Ele precisa estar cadastrado no app.'); return;
    }
    const uid      = snap.val();
    const uSnap    = await db.ref(`users/${uid}`).once('value');
    const name     = uSnap.val()?.name || email;

    pendingInvitees.push({ uid, email, name });
    addChip({ uid, email, name, status: 'pending' });
    el('invite-email-input').value = '';
    toast(`✓ ${name} adicionado`);
  } catch (err) {
    console.error(err);
    toast('❌ Erro ao buscar usuário');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Adicionar';
  }
}

function addChip({ uid, email, name, status }) {
  const chips = el('invitees-chips');
  const chip  = document.createElement('div');
  chip.className   = 'chip';
  chip.dataset.uid = uid;

  const dotColor = status === 'accepted' ? '#10b981'
                 : status === 'declined' ? '#ef4444'
                 : 'rgba(255,255,255,0.3)';

  chip.innerHTML = `
    <span style="width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0"></span>
    <span>${esc(name || email)}</span>
    <button class="chip-remove" title="Remover">✕</button>
  `;
  chip.querySelector('.chip-remove').addEventListener('click', () => {
    pendingInvitees = pendingInvitees.filter(i => i.uid !== uid);
    chip.remove();
  });
  chips.appendChild(chip);
}

async function sendInvitations(eventId, eventData) {
  const updates = {};
  const senderName = userData?.name || currentUser?.displayName || 'Usuário';

  pendingInvitees.forEach(inv => {
    updates[`events/${eventId}/invitees/${inv.uid}`]           = 'pending';
    updates[`userEvents/${inv.uid}/${eventId}`]                = true;
    updates[`invitations/${inv.uid}/${eventId}`] = {
      status:     'pending',
      from:       currentUser.uid,
      fromName:   senderName,
      eventTitle: eventData.title,
      eventStart: eventData.start,
      sentAt:     Date.now()
    };
  });

  await db.ref().update(updates);
}

/* ════════════════════════════════════════════════════════════
   NOTIFICATIONS & REMINDERS
════════════════════════════════════════════════════════════ */
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default')
    Notification.requestPermission();
}

function startReminderChecker() {
  checkReminders();
  reminderTimer = setInterval(checkReminders, 60000);
}

function checkReminders() {
  const now = Date.now();
  Object.entries(allEvents).forEach(([eid, evt]) => {
    if (!evt?.start || !evt.reminder) return;
    const start
