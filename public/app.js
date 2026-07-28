const state = { user: null, csrf: null, permissions: [], resources: null, users: [], extraButtons: [] };
const pages = { overview: 'Resumen', antiraid: 'Anti-Raid', tickets: 'Tickets', users: 'Usuarios', account: 'Mi cuenta' };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const request = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  };
  if (options.body !== undefined) {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  if (state.csrf && request.method !== 'GET') request.headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(path, request);
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (response.status === 401 && path !== '/api/auth/login') showLogin();
  if (!response.ok) throw new Error(payload.error || 'No se pudo completar la solicitud.');
  return payload;
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toast-container').append(element);
  setTimeout(() => element.remove(), 3800);
}

function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || 'Procesando...';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function showLogin() {
  state.user = null;
  state.csrf = null;
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

async function showDashboard(session) {
  state.user = session.user;
  state.csrf = session.csrf;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#current-username').textContent = state.user.username;
  $('#current-role').textContent = state.user.isAdmin ? 'Administrador' : 'Operador';
  $('#user-avatar').textContent = state.user.username.slice(0, 1).toUpperCase();
  await loadOverview();
  applyPermissions();
}

function applyPermissions() {
  $$('[data-permission]').forEach((element) => {
    element.classList.toggle('hidden', !state.permissions.includes(element.dataset.permission));
  });
}

async function loadOverview() {
  const data = await api('/api/overview');
  state.permissions = data.permissions;
  applyPermissions();
  $('#stat-antiraid').textContent = data.stats.antiRaidEnabled === null
    ? 'Sin acceso'
    : data.stats.antiRaidEnabled ? 'Activo' : 'Inactivo';
  $('#stat-raidmode').textContent = data.stats.raidMode === null
    ? 'Módulo restringido'
    : data.stats.raidMode ? 'Modo raid activado' : 'Vigilancia normal';
  $('#stat-tickets').textContent = data.stats.openTickets ?? '—';
  $('#stat-members').textContent = Number(data.guild.members).toLocaleString('es-ES');
  $('#stat-guild').textContent = data.guild.name;
  $('#stat-users').textContent = data.stats.dashboardUsers ?? '—';
  $('#hero-description').textContent = data.bot.ready
    ? `${data.guild.name} está conectado y protegido.`
    : 'El dashboard está activo; Discord continúa conectando.';
  $('#bot-name').textContent = data.bot.username;
  $('#bot-ping').textContent = `Ping: ${data.bot.ping < 0 ? '—' : `${data.bot.ping} ms`}`;
  if (data.bot.avatar) { $('#bot-avatar').src = data.bot.avatar; $('#bot-avatar').classList.remove('hidden'); }
  const ready = data.bot.ready;
  $('#bot-badge').textContent = ready ? 'En línea' : 'Conectando';
  $('#bot-badge').className = `badge ${ready ? 'success' : 'neutral'}`;
  $('#sidebar-status').textContent = ready ? 'En línea' : 'Conectando';
  $('#sidebar-status-dot').classList.toggle('offline', !ready);
  renderAudit(data.audit);
}

function renderAudit(entries) {
  const list = $('#audit-list');
  if (!entries.length) { list.innerHTML = '<p class="empty-state">Aún no hay actividad.</p>'; return; }
  list.replaceChildren(...entries.map((entry) => {
    const row = document.createElement('div'); row.className = 'activity-item';
    const dot = document.createElement('span'); dot.className = 'activity-dot';
    const text = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = entry.action;
    const small = document.createElement('small'); small.textContent = `${entry.module} · ${entry.actor}`;
    text.append(strong, small);
    const time = document.createElement('time'); time.textContent = new Date(entry.at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    row.append(dot, text, time); return row;
  }));
}

async function openPage(name) {
  $$('.page').forEach((page) => page.classList.remove('active'));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  $(`#page-${name}`).classList.add('active');
  $('#page-title').textContent = pages[name];
  closeSidebar();
  try {
    if (name === 'overview') await loadOverview();
    if (name === 'antiraid') await loadAntiRaid();
    if (name === 'tickets') await loadTickets();
    if (name === 'users') await loadUsers();
  } catch (error) { toast(error.message, 'error'); }
}

function fillForm(form, values) {
  for (const [key, value] of Object.entries(values)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
  }
}

function formObject(form) {
  const result = {};
  for (const element of form.elements) {
    if (!element.name || element.type === 'submit' || element.type === 'button') continue;
    if (element.type === 'checkbox') result[element.name] = element.checked;
    else if (element.type === 'number') result[element.name] = Number(element.value);
    else result[element.name] = element.value;
  }
  return result;
}

async function loadAntiRaid() {
  const data = await api('/api/antiraid');
  fillForm($('#antiraid-form'), data.settings);
  const badge = $('#antiraid-live-badge');
  badge.textContent = data.status.raidMode ? 'Modo raid' : data.settings.enabled ? 'Protección activa' : 'Desactivado';
  badge.className = `badge ${data.status.raidMode || !data.settings.enabled ? 'danger' : 'success'}`;
}

async function getResources() {
  if (!state.resources) state.resources = await api('/api/discord/resources');
  return state.resources;
}

function populateSelect(select, items, selected, prefix = '') {
  const first = select.options[0]?.cloneNode(true);
  select.replaceChildren();
  if (first && !first.value) select.append(first);
  for (const item of items) {
    const option = document.createElement('option'); option.value = item.id; option.textContent = `${prefix}${item.name}`; select.append(option);
  }
  select.value = selected || '';
}

async function loadTickets() {
  const [data, resources] = await Promise.all([api('/api/tickets'), getResources()]);
  state.extraButtons = structuredClone(data.settings.extraButtons ?? []);
  fillForm($('#tickets-form'), data.settings);
  populateSelect($('#tickets-form [name="categoryId"]'), resources.categories, data.settings.categoryId);
  populateSelect($('#tickets-form [name="supportRoleId"]'), resources.roles, data.settings.supportRoleId, '@');
  populateSelect($('#tickets-form [name="logChannelId"]'), resources.channels, data.settings.logChannelId, '#');
  const commandSelect = $('#tickets-form [name="commandRoleId"]');
  commandSelect.replaceChildren();
  for (const role of resources.roles) {
    const option = document.createElement('option'); option.value = role.id; option.textContent = `@${role.name}`; commandSelect.append(option);
  }
  commandSelect.value = data.settings.commandRoleId;
  populateSelect($('#publish-channel'), resources.channels, '', '#');
  renderExtraButtons();
  updateTicketPreview();
}

const ticketStyleLabels = { primary: 'Azul', secondary: 'Gris', success: 'Verde', danger: 'Rojo', link: 'Enlace' };

function updateTicketPreview() {
  const form = $('#tickets-form');
  if (!form) return;
  const color = form.elements.embedColor.value || '#2B2D31';
  $('#embed-color-value').textContent = color.toUpperCase();
  $('#preview-title').textContent = form.elements.panelTitle.value || 'Título del panel';
  $('#preview-description').textContent = form.elements.panelDescription.value || 'Descripción del panel';
  $('#preview-footer').textContent = form.elements.footerText.value || 'Footer';
  const buttons = [
    { label: form.elements.createButtonLabel.value || 'Abrir ticket', style: form.elements.createButtonStyle.value },
    { label: form.elements.infoButtonLabel.value || 'Información', style: form.elements.infoButtonStyle.value },
    ...state.extraButtons,
  ];
  $('#preview-buttons').replaceChildren(...buttons.map((button) => {
    const element = document.createElement('span');
    element.className = `discord-button ${button.style}`;
    element.textContent = button.label;
    return element;
  }));
}

function renderExtraButtons() {
  const list = $('#extra-buttons-list');
  $('#add-extra-button').disabled = state.extraButtons.length >= 3;
  if (!state.extraButtons.length) {
    list.innerHTML = '<p class="empty-state">No hay botones adicionales.</p>';
    updateTicketPreview();
    return;
  }
  list.replaceChildren(...state.extraButtons.map((button) => {
    const card = document.createElement('article'); card.className = 'extra-button-card';
    const summary = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = button.label;
    const detail = document.createElement('small');
    detail.textContent = button.type === 'link'
      ? `Enlace · ${button.value}`
      : `Respuesta privada · ${ticketStyleLabels[button.style]}`;
    summary.append(title, detail);
    const actions = document.createElement('div'); actions.className = 'inline-actions';
    const edit = document.createElement('button'); edit.className = 'button ghost'; edit.type = 'button'; edit.textContent = 'Editar'; edit.addEventListener('click', () => openExtraButtonDialog(button));
    const remove = document.createElement('button'); remove.className = 'button danger'; remove.type = 'button'; remove.textContent = 'Eliminar'; remove.addEventListener('click', () => {
      state.extraButtons = state.extraButtons.filter((item) => item.id !== button.id);
      renderExtraButtons();
      updateTicketPreview();
    });
    actions.append(edit, remove); card.append(summary, actions); return card;
  }));
  updateTicketPreview();
}

function updateExtraButtonFields() {
  const form = $('#extra-button-form');
  const isLink = form.elements.type.value === 'link';
  $('#extra-style-field').classList.toggle('hidden', isLink);
  $('#extra-value-label').textContent = isLink ? 'Dirección del enlace' : 'Mensaje privado';
  $('#extra-value-help').textContent = isLink
    ? 'Debe comenzar con https:// y apuntar a un sitio público.'
    : 'Se mostrará únicamente al usuario que pulse el botón.';
  form.elements.value.placeholder = isLink ? 'https://ejemplo.com' : 'Contenido que verá el usuario...';
  form.elements.value.maxLength = isLink ? 512 : 2000;
}

function openExtraButtonDialog(button = null) {
  const form = $('#extra-button-form'); form.reset();
  $('#extra-button-error').classList.add('hidden');
  form.elements.id.value = button?.id ?? '';
  form.elements.label.value = button?.label ?? '';
  form.elements.type.value = button?.type ?? 'response';
  form.elements.style.value = button?.style === 'link' ? 'secondary' : button?.style ?? 'secondary';
  form.elements.value.value = button?.value ?? '';
  $('#extra-button-title').textContent = button ? 'Editar botón' : 'Nuevo botón';
  updateExtraButtonFields();
  $('#extra-button-dialog').showModal();
}

async function loadUsers() {
  const data = await api('/api/users');
  state.users = data.users;
  const grid = $('#users-grid');
  if (!data.users.length) { grid.innerHTML = '<p class="empty-state">No hay usuarios.</p>'; return; }
  grid.replaceChildren(...data.users.map(createUserCard));
}

function createUserCard(user) {
  const card = document.createElement('article'); card.className = 'user-card';
  const head = document.createElement('div'); head.className = 'user-card-head';
  const avatar = document.createElement('div'); avatar.className = 'mini-avatar'; avatar.textContent = user.username[0].toUpperCase();
  const identity = document.createElement('div');
  const title = document.createElement('h4'); title.textContent = user.username;
  const subtitle = document.createElement('p'); subtitle.textContent = user.isAdmin ? 'Administrador total' : 'Acceso personalizado';
  identity.append(title, subtitle); head.append(avatar, identity);
  const tags = document.createElement('div'); tags.className = 'permission-tags';
  const labels = user.isAdmin ? ['Acceso total'] : user.permissions;
  for (const label of labels) { const tag = document.createElement('span'); tag.className = 'permission-tag'; tag.textContent = label; tags.append(tag); }
  if (user.disabled) { const tag = document.createElement('span'); tag.className = 'permission-tag disabled'; tag.textContent = 'Desactivado'; tags.append(tag); }
  const actions = document.createElement('div'); actions.className = 'user-actions';
  const edit = document.createElement('button'); edit.className = 'button ghost'; edit.type = 'button'; edit.textContent = 'Editar'; edit.disabled = user.id === state.user.id || (user.isAdmin && !state.user.isAdmin); edit.addEventListener('click', () => openUserDialog(user));
  const remove = document.createElement('button'); remove.className = 'button danger'; remove.type = 'button'; remove.textContent = 'Eliminar'; remove.disabled = user.id === state.user.id || (user.isAdmin && !state.user.isAdmin); remove.addEventListener('click', () => deleteUser(user));
  actions.append(edit, remove); card.append(head, tags, actions); return card;
}

function openUserDialog(user = null) {
  const form = $('#user-form'); form.reset();
  $('#user-form-error').classList.add('hidden');
  form.elements.id.value = user?.id || '';
  form.elements.username.value = user?.username || '';
  form.elements.password.required = !user;
  form.elements.isAdmin.checked = Boolean(user?.isAdmin);
  for (const checkbox of form.querySelectorAll('[name="permissions"]')) checkbox.checked = Boolean(user?.permissions.includes(checkbox.value));
  form.elements.disabled.checked = Boolean(user?.disabled);
  $('#disabled-row').classList.toggle('hidden', !user);
  $('#user-dialog-title').textContent = user ? 'Editar usuario' : 'Nuevo usuario';
  $('#password-help').textContent = user ? 'Déjala vacía para mantenerla.' : 'Mínimo 8 caracteres.';
  $('.admin-check').classList.toggle('hidden', !state.user.isAdmin);
  if (!state.user.isAdmin) form.elements.isAdmin.checked = false;
  togglePermissionFields();
  $('#user-dialog').showModal();
}

function togglePermissionFields() {
  $('#permission-fieldset').classList.toggle('disabled', $('#user-form [name="isAdmin"]').checked);
}

async function deleteUser(user) {
  if (!confirm(`¿Eliminar el acceso de ${user.username}?`)) return;
  try { await api(`/api/users/${user.id}`, { method: 'DELETE' }); toast('Usuario eliminado.'); await loadUsers(); }
  catch (error) { toast(error.message, 'error'); }
}

function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebar-backdrop').classList.remove('hidden'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebar-backdrop').classList.add('hidden'); }

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#login-submit'); const errorBox = $('#login-error');
  errorBox.classList.add('hidden'); setButtonBusy(button, true, 'Verificando...');
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: formObject(event.currentTarget) });
    await showDashboard(data);
  } catch (error) { errorBox.textContent = error.message; errorBox.classList.remove('hidden'); }
  finally { setButtonBusy(button, false); }
});

$$('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => {
  const input = $(`#${button.dataset.togglePassword}`); input.type = input.type === 'password' ? 'text' : 'password'; button.textContent = input.type === 'password' ? 'Ver' : 'Ocultar';
}));
$$('.nav-item').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.page)));
$$('[data-refresh="overview"]').forEach((button) => button.addEventListener('click', () => loadOverview().catch((error) => toast(error.message, 'error'))));
$('#menu-button').addEventListener('click', openSidebar); $('#sidebar-backdrop').addEventListener('click', closeSidebar);

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {} showLogin();
});

$('#antiraid-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); setButtonBusy(button, true, 'Guardando...');
  try { await api('/api/antiraid', { method: 'PATCH', body: formObject(event.currentTarget) }); $('#antiraid-save-state').textContent = 'Cambios aplicados en tiempo real'; toast('Protección Anti-Raid actualizada.'); await loadAntiRaid(); }
  catch (error) { toast(error.message, 'error'); } finally { setButtonBusy(button, false); }
});

$('#tickets-form').addEventListener('input', updateTicketPreview);
$('#tickets-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector('[type="submit"]'); setButtonBusy(button, true, 'Guardando...');
  try {
    const body = formObject(event.currentTarget);
    body.extraButtons = state.extraButtons;
    const result = await api('/api/tickets', { method: 'PATCH', body });
    state.extraButtons = structuredClone(result.settings.extraButtons ?? []);
    renderExtraButtons();
    $('#tickets-save-state').textContent = result.panelsUpdated
      ? `${result.panelsUpdated} panel(es) actualizado(s)`
      : 'Configuración guardada';
    toast(result.panelsUpdated
      ? `Tickets guardados y ${result.panelsUpdated} panel(es) actualizado(s).`
      : 'Sistema de tickets actualizado.');
  } catch (error) { toast(error.message, 'error'); } finally { setButtonBusy(button, false); }
});

$('#add-extra-button').addEventListener('click', () => {
  if (state.extraButtons.length >= 3) return toast('Discord permite un máximo de 5 botones en esta fila.', 'error');
  openExtraButtonDialog();
});
$('#extra-button-form [name="type"]').addEventListener('change', updateExtraButtonFields);
$$('.extra-button-close, .extra-button-cancel').forEach((button) => button.addEventListener('click', () => $('#extra-button-dialog').close()));
$('#extra-button-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value || crypto.randomUUID();
  const item = {
    id,
    label: form.elements.label.value.trim(),
    type: form.elements.type.value,
    style: form.elements.type.value === 'link' ? 'link' : form.elements.style.value,
    value: form.elements.value.value.trim(),
  };
  if (!item.label || !item.value) {
    $('#extra-button-error').textContent = 'Completa la etiqueta y el contenido del botón.';
    $('#extra-button-error').classList.remove('hidden');
    return;
  }
  const index = state.extraButtons.findIndex((button) => button.id === id);
  if (index === -1) state.extraButtons.push(item);
  else state.extraButtons[index] = item;
  $('#extra-button-dialog').close();
  renderExtraButtons();
  updateTicketPreview();
});

$('#publish-button').addEventListener('click', async () => {
  const button = $('#publish-button'); const channelId = $('#publish-channel').value;
  if (!channelId) return toast('Selecciona un canal.', 'error'); setButtonBusy(button, true, 'Publicando...');
  try { await api('/api/tickets/publish', { method: 'POST', body: { channelId } }); toast('Panel publicado correctamente.'); }
  catch (error) { toast(error.message, 'error'); } finally { setButtonBusy(button, false); }
});

$('#new-user-button').addEventListener('click', () => openUserDialog());
$$('.modal-close, .modal-cancel').forEach((button) => button.addEventListener('click', () => $('#user-dialog').close()));
$('#user-form [name="isAdmin"]').addEventListener('change', togglePermissionFields);
$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  const body = { username: form.elements.username.value, password: form.elements.password.value || undefined, isAdmin: form.elements.isAdmin.checked, disabled: form.elements.disabled.checked, permissions: [...form.querySelectorAll('[name="permissions"]:checked')].map((item) => item.value) };
  const errorBox = $('#user-form-error'); errorBox.classList.add('hidden'); const button = form.querySelector('[type="submit"]'); setButtonBusy(button, true, 'Guardando...');
  try { await api(id ? `/api/users/${id}` : '/api/users', { method: id ? 'PATCH' : 'POST', body }); $('#user-dialog').close(); toast(id ? 'Usuario actualizado.' : 'Usuario creado.'); await loadUsers(); }
  catch (error) { errorBox.textContent = error.message; errorBox.classList.remove('hidden'); } finally { setButtonBusy(button, false); }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  if (form.elements.newPassword.value !== form.elements.confirmPassword.value) return toast('Las contraseñas nuevas no coinciden.', 'error');
  const button = form.querySelector('[type="submit"]'); setButtonBusy(button, true, 'Actualizando...');
  try { const result = await api('/api/account/password', { method: 'POST', body: { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value } }); state.csrf = result.csrf; form.reset(); toast('Contraseña actualizada y otras sesiones cerradas.'); }
  catch (error) { toast(error.message, 'error'); } finally { setButtonBusy(button, false); }
});

(async () => {
  try { await showDashboard(await api('/api/auth/session')); }
  catch { showLogin(); }
})();
