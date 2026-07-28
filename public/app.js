const state = {
  user: null,
  csrf: null,
  permissions: [],
  resources: null,
  users: [],
  extraButtons: [],
  embeds: [],
  schedules: [],
};
const pages = {
  overview: 'Resumen',
  antiraid: 'Anti-Raid',
  antinuke: 'Anti-Nuke',
  automod: 'AutoMod',
  tickets: 'Tickets',
  embeds: 'Embeds',
  users: 'Usuarios',
  account: 'Mi cuenta',
};
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
  if (data.bot.avatar) {
    $('#bot-avatar').src = data.bot.avatar;
    $('#bot-avatar').classList.remove('hidden');
  }
  const ready = data.bot.ready;
  $('#bot-badge').textContent = ready ? 'En línea' : 'Conectando';
  $('#bot-badge').className = `badge ${ready ? 'success' : 'neutral'}`;
  $('#sidebar-status').textContent = ready ? 'En línea' : 'Conectando';
  $('#sidebar-status-dot').classList.toggle('offline', !ready);
  renderAudit(data.audit);
}

function renderAudit(entries) {
  const list = $('#audit-list');
  if (!entries.length) {
    list.innerHTML = '<p class="empty-state">Aún no hay actividad.</p>';
    return;
  }
  list.replaceChildren(...entries.map((entry) => {
    const row = document.createElement('div'); row.className = 'activity-item';
    const dot = document.createElement('span'); dot.className = 'activity-dot';
    const text = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = entry.action;
    const small = document.createElement('small'); small.textContent = `${entry.module} · ${entry.actor}`;
    text.append(strong, small);
    const time = document.createElement('time');
    time.textContent = new Date(entry.at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    row.append(dot, text, time);
    return row;
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
    if (name === 'antinuke') await loadAntiNuke();
    if (name === 'automod') await loadAutoMod();
    if (name === 'tickets') await loadTickets();
    if (name === 'embeds') await loadEmbeds();
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

async function loadAntiNuke() {
  const data = await api('/api/antinuke');
  fillForm($('#antinuke-form'), data.settings);
  const badge = $('#antinuke-live-badge');
    badge.textContent = !data.settings.enabled ? 'Desactivado' : data.settings.emergencyMode ? 'Emergencia' : 'Protección activa';
  badge.className = `badge ${!data.settings.enabled ? 'neutral' : data.settings.emergencyMode ? 'danger' : 'success'}`;
  $('#emergency-setting').classList.toggle('active', data.settings.emergencyMode);
  $('#snapshot-channels').textContent = data.status.snapshots.channels;
  $('#snapshot-roles').textContent = data.status.snapshots.roles;
  $('#snapshot-emojis').textContent = data.status.snapshots.emojis;
  $('#snapshot-date').textContent = data.status.snapshots.capturedAt
    ? `Última copia: ${new Date(data.status.snapshots.capturedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Sin copia registrada.';
  renderAntiNukeIncidents(data.status.incidents);
}

function renderAntiNukeIncidents(incidents) {
  const list = $('#antinuke-incidents');
  if (!incidents.length) {
    list.innerHTML = '<p class="empty-state">No hay incidentes.</p>';
    return;
  }
  const resourceLabels = { channel: 'Canal', role: 'Rol', emoji: 'Emoji' };
  list.replaceChildren(...incidents.map((incident) => {
    const item = document.createElement('article'); item.className = 'incident-item';
    const partial = incident.restored && (incident.relationErrors?.length ?? 0) > 0;
    const icon = document.createElement('span');
    icon.className = `incident-icon ${partial ? 'partial' : incident.restored ? 'restored' : 'failed'}`;
    icon.textContent = partial ? '≈' : incident.restored ? '↺' : '!';
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${resourceLabels[incident.resourceType] ?? 'Recurso'} · ${incident.resourceName}`;
    const detail = document.createElement('small');
    const executor = incident.executorId ?? 'desconocido';
    const responses = [];
    if (incident.sanctioned) responses.push('sancionado');
    if (incident.rolesRemoved > 0) responses.push(`${incident.rolesRemoved} rol(es) retirado(s)`);
    if (incident.rolesError) responses.push(`retirada de roles fallida: ${incident.rolesError}`);
    if (!responses.length) responses.push('sin sanción');
    const response = responses.join(' · ');
    const restoration = partial
      ? `Recreado parcialmente: ${incident.relationErrors.join(' ')}`
      : incident.restored ? 'Restaurado completamente' : incident.restoreError || 'Restauración desactivada';
    detail.textContent = `${restoration} · responsable ${executor} · ${response}`;
    content.append(title, detail);
    const time = document.createElement('time');
    time.textContent = new Date(incident.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    item.append(icon, content, time);
    return item;
  }));
}

async function loadAutoMod() {
  const data = await api('/api/automod');
  fillForm($('#automod-form'), data.settings);
  const badge = $('#automod-live-badge');
  badge.textContent = data.settings.enabled ? `${data.status.activeStrikes} usuarios con strikes` : 'Desactivado';
  badge.className = `badge ${data.settings.enabled ? 'success' : 'neutral'}`;
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
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${prefix}${item.name}`;
    select.append(option);
  }
  select.value = selected || '';
}

function populateEmojiSelectors(resources) {
  $$('[data-emoji-custom] select').forEach((select) => {
    const selected = select.value;
    select.replaceChildren(new Option('Selecciona un emoji', ''));
    for (const emoji of resources.emojis ?? []) {
      select.append(new Option(`:${emoji.name}:${emoji.animated ? ' · animado' : ''}`, emoji.id));
    }
    select.value = selected;
  });
}

function emojiField(name) {
  return $(`[data-emoji-field="${name}"]`);
}

function updateEmojiField(field) {
  if (!field) return;
  const type = $('[data-emoji-type]', field).value;
  $('[data-emoji-unicode]', field).classList.toggle('hidden', type !== 'unicode');
  $('[data-emoji-custom]', field).classList.toggle('hidden', type !== 'custom');
}

function setEmojiField(name, emoji) {
  const field = emojiField(name);
  if (!field) return;
  const type = emoji?.type === 'custom' ? 'custom' : emoji?.name ? 'unicode' : 'none';
  $('[data-emoji-type]', field).value = type;
  $('[data-emoji-unicode] input', field).value = type === 'unicode' ? emoji.name : '';
  $('[data-emoji-custom] select', field).value = type === 'custom' ? emoji.id : '';
  updateEmojiField(field);
}

function readEmojiField(name) {
  const field = emojiField(name);
  const type = $('[data-emoji-type]', field).value;
  if (type === 'unicode') {
    const value = $('[data-emoji-unicode] input', field).value.trim();
    return value ? { type: 'unicode', name: value } : null;
  }
  if (type === 'custom') {
    const id = $('[data-emoji-custom] select', field).value;
    return id ? { type: 'custom', id } : null;
  }
  return null;
}

function emojiPreview(emoji) {
  if (!emoji) return '';
  if (emoji.type === 'unicode') return emoji.name || '';
  const resource = state.resources?.emojis?.find((item) => item.id === emoji.id);
  return resource ? `:${resource.name}:` : emoji.name ? `:${emoji.name}:` : '';
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
  for (const role of resources.roles) commandSelect.append(new Option(`@${role.name}`, role.id));
  commandSelect.value = data.settings.commandRoleId;
  populateSelect($('#publish-channel'), resources.channels, '', '#');
  populateEmojiSelectors(resources);
  setEmojiField('createButtonEmoji', data.settings.createButtonEmoji);
  setEmojiField('infoButtonEmoji', data.settings.infoButtonEmoji);
  renderExtraButtons();
  updateTicketPreview();
}

const ticketStyleLabels = {
  primary: 'Azul', secondary: 'Gris', success: 'Verde', danger: 'Rojo', link: 'Enlace',
};

function updateTicketPreview() {
  const form = $('#tickets-form');
  if (!form) return;
  const color = form.elements.embedColor.value || '#2B2D31';
  $('#embed-color-value').textContent = color.toUpperCase();
  $('#preview-embed').style.borderLeftColor = color;
  $('#preview-title').textContent = form.elements.panelTitle.value || 'Título del panel';
  $('#preview-description').textContent = form.elements.panelDescription.value || 'Descripción del panel';
  $('#preview-footer').textContent = form.elements.footerText.value || 'Footer';
  const image = $('#preview-panel-image');
  const imageUrl = form.elements.panelImageUrl.value.trim();
  image.classList.toggle('hidden', !imageUrl);
  if (imageUrl) image.src = imageUrl;
  else image.removeAttribute('src');
  const buttons = [
    {
      label: form.elements.createButtonLabel.value || 'Abrir ticket',
      style: form.elements.createButtonStyle.value,
      emoji: readEmojiField('createButtonEmoji'),
    },
    {
      label: form.elements.infoButtonLabel.value || 'Información',
      style: form.elements.infoButtonStyle.value,
      emoji: readEmojiField('infoButtonEmoji'),
    },
    ...state.extraButtons,
  ];
  $('#preview-buttons').replaceChildren(...buttons.map((button) => {
    const element = document.createElement('span');
    element.className = `discord-button ${button.style}`;
    const emoji = emojiPreview(button.emoji);
    element.textContent = `${emoji ? `${emoji} ` : ''}${button.label}`;
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
    const title = document.createElement('strong');
    const emoji = emojiPreview(button.emoji);
    title.textContent = `${emoji ? `${emoji} ` : ''}${button.label}`;
    const detail = document.createElement('small');
    detail.textContent = button.type === 'link'
      ? `Enlace · ${button.value}`
      : `Respuesta privada · ${ticketStyleLabels[button.style]}`;
    summary.append(title, detail);
    const actions = document.createElement('div'); actions.className = 'inline-actions';
    const edit = document.createElement('button');
    edit.className = 'button ghost'; edit.type = 'button'; edit.textContent = 'Editar';
    edit.addEventListener('click', () => openExtraButtonDialog(button));
    const remove = document.createElement('button');
    remove.className = 'button danger'; remove.type = 'button'; remove.textContent = 'Eliminar';
    remove.addEventListener('click', () => {
      state.extraButtons = state.extraButtons.filter((item) => item.id !== button.id);
      renderExtraButtons();
    });
    actions.append(edit, remove);
    card.append(summary, actions);
    return card;
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
  const form = $('#extra-button-form');
  form.reset();
  $('#extra-button-error').classList.add('hidden');
  form.elements.id.value = button?.id ?? '';
  form.elements.label.value = button?.label ?? '';
  form.elements.type.value = button?.type ?? 'response';
  form.elements.style.value = button?.style === 'link' ? 'secondary' : button?.style ?? 'secondary';
  form.elements.value.value = button?.value ?? '';
  setEmojiField('extraButtonEmoji', button?.emoji);
  $('#extra-button-title').textContent = button ? 'Editar botón' : 'Nuevo botón';
  updateExtraButtonFields();
  $('#extra-button-dialog').showModal();
}

function switchEmbedView(name) {
  $$('.subpage-tab').forEach((tab) => {
    const active = tab.dataset.embedView === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $$('.embed-subpage').forEach((view) => view.classList.toggle('active', view.id === `embed-view-${name}`));
}

function embedPayload() {
  const form = $('#embed-form');
  return {
    name: form.elements.name.value.trim(),
    title: form.elements.title.value.trim(),
    description: form.elements.description.value.trim(),
    color: form.elements.color.value,
    authorName: form.elements.authorName.value.trim(),
    authorIconUrl: form.elements.authorIconUrl.value.trim(),
    footerText: form.elements.footerText.value.trim(),
    imageUrl: form.elements.imageUrl.value.trim(),
    thumbnailUrl: form.elements.thumbnailUrl.value.trim(),
    timestamp: form.elements.timestamp.checked,
  };
}

function setPreviewImage(element, url) {
  element.classList.toggle('hidden', !url);
  if (url) element.src = url;
  else element.removeAttribute('src');
}

function updateEmbedPreview() {
  const form = $('#embed-form');
  const color = form.elements.color.value || '#5865F2';
  $('#custom-embed-color').textContent = color.toUpperCase();
  $('#custom-embed-preview').style.borderLeftColor = color;
  $('#custom-preview-title').textContent = form.elements.title.value.trim() || 'Título del mensaje';
  $('#custom-preview-description').textContent = form.elements.description.value.trim()
    || 'La vista previa aparecerá aquí mientras escribes.';
  const author = $('#custom-preview-author');
  const authorName = form.elements.authorName.value.trim();
  author.classList.toggle('hidden', !authorName);
  $('span', author).textContent = authorName;
  setPreviewImage($('#custom-preview-author-icon'), authorName ? form.elements.authorIconUrl.value.trim() : '');
  setPreviewImage($('#custom-preview-image'), form.elements.imageUrl.value.trim());
  setPreviewImage($('#custom-preview-thumbnail'), form.elements.thumbnailUrl.value.trim());
  const footer = $('#custom-preview-footer');
  const footerText = form.elements.footerText.value.trim();
  const withTimestamp = form.elements.timestamp.checked;
  footer.classList.toggle('hidden', !footerText && !withTimestamp);
  $('span', footer).textContent = footerText;
  $('span', footer).classList.toggle('hidden', !footerText);
  $('time', footer).textContent = withTimestamp ? new Date().toLocaleString('es-ES') : '';
  $('time', footer).classList.toggle('hidden', !withTimestamp);
}

function resetEmbedForm() {
  const form = $('#embed-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.color.value = '#5865f2';
  $('#embed-form-title').textContent = 'Crear Embed';
  $('#embed-save-state').textContent = '';
  updateEmbedPreview();
}

function editEmbed(embed) {
  const form = $('#embed-form');
  fillForm(form, embed);
  form.elements.id.value = embed.id;
  $('#embed-form-title').textContent = `Editar · ${embed.name}`;
  $('#embed-save-state').textContent = '';
  switchEmbedView('builder');
  updateEmbedPreview();
  $('#page-embeds').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function makeChannelControl(selected = '') {
  const channels = state.resources?.channels ?? [];
  if (!channels.length) {
    const input = document.createElement('input');
    input.type = 'text'; input.inputMode = 'numeric'; input.placeholder = 'ID del canal de Discord';
    input.value = selected;
    input.setAttribute('aria-label', 'ID del canal');
    return input;
  }
  const select = document.createElement('select');
  select.append(new Option('Selecciona un canal', ''));
  for (const channel of channels) select.append(new Option(`#${channel.name}`, channel.id));
  if (selected && !channels.some((channel) => channel.id === selected)) {
    select.append(new Option(`Canal ${selected}`, selected));
  }
  select.value = selected;
  select.setAttribute('aria-label', 'Canal de Discord');
  return select;
}

async function performButtonAction(button, busyText, action) {
  setButtonBusy(button, true, busyText);
  try { await action(); }
  catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
}

function createSavedEmbedCard(embed) {
  const schedule = state.schedules.find((item) => item.embedId === embed.id);
  const card = document.createElement('article'); card.className = 'panel-card saved-embed-card';

  const header = document.createElement('div'); header.className = 'card-header';
  const heading = document.createElement('div');
  const eyebrow = document.createElement('div'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'EMBED GUARDADO';
  const title = document.createElement('h3'); title.textContent = embed.name;
  heading.append(eyebrow, title);
  const badge = document.createElement('span');
  badge.className = `badge ${schedule?.lastError ? 'danger' : schedule?.enabled ? 'success' : 'neutral'}`;
  badge.textContent = schedule?.lastError ? 'Error de envío' : schedule?.enabled ? 'Programado' : 'Sin automatizar';
  header.append(heading, badge);

  const preview = document.createElement('div'); preview.className = 'saved-embed-preview';
  preview.style.borderLeftColor = embed.color;
  const previewTitle = document.createElement('h4'); previewTitle.textContent = embed.title || embed.name;
  const description = document.createElement('p'); description.textContent = embed.description || 'Sin descripción.';
  preview.append(previewTitle, description);

  const meta = document.createElement('div'); meta.className = 'saved-embed-meta';
  const color = document.createElement('span'); color.textContent = `Color ${embed.color}`;
  meta.append(color);
  if (schedule) {
    const interval = document.createElement('span'); interval.textContent = `Cada ${schedule.intervalMinutes} min`;
    meta.append(interval);
    if (schedule.nextRunAt) {
      const next = document.createElement('span');
      next.textContent = `Próximo: ${new Date(schedule.nextRunAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}`;
      meta.append(next);
    }
    if (schedule.lastRunAt) {
      const last = document.createElement('span');
      last.textContent = `Último envío: ${new Date(schedule.lastRunAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}`;
      meta.append(last);
    }
    if (schedule.lastError) {
      const error = document.createElement('span');
      error.className = 'schedule-error';
      error.textContent = `Error: ${schedule.lastError}`;
      meta.append(error);
    }
  }

  const savedActions = document.createElement('div'); savedActions.className = 'saved-embed-actions';
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button ghost'; edit.textContent = 'Editar';
  edit.addEventListener('click', () => editEmbed(embed));
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button danger'; remove.textContent = 'Eliminar embed';
  remove.addEventListener('click', () => {
    if (!confirm(`¿Eliminar el embed “${embed.name}”?`)) return;
    performButtonAction(remove, 'Eliminando...', async () => {
      await api(`/api/embeds/${embed.id}`, { method: 'DELETE' });
      toast('Embed eliminado.');
      await loadEmbeds();
    });
  });
  savedActions.append(edit, remove);

  const delivery = document.createElement('div'); delivery.className = 'embed-delivery';
  const sendRow = document.createElement('div'); sendRow.className = 'embed-delivery-row';
  const channel = makeChannelControl(schedule?.channelId ?? '');
  const send = document.createElement('button'); send.type = 'button'; send.className = 'button secondary'; send.textContent = 'Enviar ahora';
  send.addEventListener('click', () => {
    if (!channel.value.trim()) return toast('Selecciona o escribe un canal.', 'error');
    performButtonAction(send, 'Enviando...', async () => {
      await api(`/api/embeds/${embed.id}/send`, { method: 'POST', body: { channelId: channel.value.trim() } });
      toast('Embed enviado al canal.');
    });
  });
  sendRow.append(channel, send);

  const scheduleGrid = document.createElement('div'); scheduleGrid.className = 'schedule-grid';
  const intervalLabel = document.createElement('label'); intervalLabel.className = 'field';
  const intervalText = document.createElement('span'); intervalText.textContent = 'Intervalo (minutos)';
  const interval = document.createElement('input');
  interval.type = 'number'; interval.min = '5'; interval.max = '43200'; interval.required = true;
  interval.value = String(schedule?.intervalMinutes ?? 5);
  intervalLabel.append(intervalText, interval);
  const enabledLabel = document.createElement('label'); enabledLabel.className = 'check-row schedule-toggle';
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = Boolean(schedule?.enabled);
  const enabledCopy = document.createElement('span');
  const enabledTitle = document.createElement('strong'); enabledTitle.textContent = 'Programación habilitada';
  const enabledHelp = document.createElement('small'); enabledHelp.textContent = 'Publicación recurrente automática.';
  enabledCopy.append(enabledTitle, enabledHelp); enabledLabel.append(enabled, enabledCopy);
  scheduleGrid.append(intervalLabel, enabledLabel);

  const scheduleActions = document.createElement('div'); scheduleActions.className = 'schedule-actions';
  const saveSchedule = document.createElement('button'); saveSchedule.type = 'button'; saveSchedule.className = 'button primary'; saveSchedule.textContent = schedule ? 'Actualizar programación' : 'Guardar programación';
  saveSchedule.addEventListener('click', () => {
    const minutes = Number(interval.value);
    if (!channel.value.trim()) return toast('Selecciona o escribe un canal para programar.', 'error');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 43200) return toast('El intervalo debe ser de al menos 5 minutos.', 'error');
    performButtonAction(saveSchedule, 'Guardando...', async () => {
      await api(`/api/embeds/${embed.id}/schedule`, {
        method: 'PUT',
        body: { channelId: channel.value.trim(), intervalMinutes: minutes, enabled: enabled.checked },
      });
      toast(enabled.checked ? 'Programación guardada y habilitada.' : 'Programación guardada en pausa.');
      await loadEmbeds();
    });
  });
  scheduleActions.append(saveSchedule);
  if (schedule) {
    const deleteSchedule = document.createElement('button');
    deleteSchedule.type = 'button'; deleteSchedule.className = 'button danger'; deleteSchedule.textContent = 'Quitar programación';
    deleteSchedule.addEventListener('click', () => {
      if (!confirm(`¿Quitar la programación de “${embed.name}”?`)) return;
      performButtonAction(deleteSchedule, 'Quitando...', async () => {
        await api(`/api/embeds/${embed.id}/schedule`, { method: 'DELETE' });
        toast('Programación eliminada.');
        await loadEmbeds();
      });
    });
    scheduleActions.append(deleteSchedule);
  }
  delivery.append(sendRow, scheduleGrid, scheduleActions);
  card.append(header, preview, meta, savedActions, delivery);
  return card;
}

function renderSavedEmbeds() {
  const list = $('#saved-embeds-list');
  if (!state.embeds.length) {
    list.innerHTML = '<p class="empty-state">No hay embeds guardados.</p>';
    return;
  }
  list.replaceChildren(...state.embeds.map(createSavedEmbedCard));
}

async function loadEmbeds() {
  const data = await api('/api/embeds');
  state.embeds = Array.isArray(data.saved) ? data.saved : [];
  state.schedules = Array.isArray(data.schedules) ? data.schedules : [];
  if (!state.resources) {
    try { await getResources(); } catch { /* Los IDs manuales mantienen disponibles los envíos. */ }
  }
  renderSavedEmbeds();
}

async function loadUsers() {
  const data = await api('/api/users');
  state.users = data.users;
  const grid = $('#users-grid');
  if (!data.users.length) {
    grid.innerHTML = '<p class="empty-state">No hay usuarios.</p>';
    return;
  }
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
  for (const label of labels) {
    const tag = document.createElement('span'); tag.className = 'permission-tag'; tag.textContent = label; tags.append(tag);
  }
  if (user.disabled) {
    const tag = document.createElement('span'); tag.className = 'permission-tag disabled'; tag.textContent = 'Desactivado'; tags.append(tag);
  }
  const actions = document.createElement('div'); actions.className = 'user-actions';
  const edit = document.createElement('button');
  edit.className = 'button ghost'; edit.type = 'button'; edit.textContent = 'Editar';
  edit.disabled = user.id === state.user.id || (user.isAdmin && !state.user.isAdmin);
  edit.addEventListener('click', () => openUserDialog(user));
  const remove = document.createElement('button');
  remove.className = 'button danger'; remove.type = 'button'; remove.textContent = 'Eliminar';
  remove.disabled = user.id === state.user.id || (user.isAdmin && !state.user.isAdmin);
  remove.addEventListener('click', () => deleteUser(user));
  actions.append(edit, remove); card.append(head, tags, actions);
  return card;
}

function openUserDialog(user = null) {
  const form = $('#user-form'); form.reset();
  $('#user-form-error').classList.add('hidden');
  form.elements.id.value = user?.id || '';
  form.elements.username.value = user?.username || '';
  form.elements.password.required = !user;
  form.elements.isAdmin.checked = Boolean(user?.isAdmin);
  for (const checkbox of form.querySelectorAll('[name="permissions"]')) {
    checkbox.checked = Boolean(user?.permissions.includes(checkbox.value));
  }
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
  try {
    await api(`/api/users/${user.id}`, { method: 'DELETE' });
    toast('Usuario eliminado.');
    await loadUsers();
  } catch (error) { toast(error.message, 'error'); }
}

function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebar-backdrop').classList.remove('hidden'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebar-backdrop').classList.add('hidden'); }

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#login-submit'); const errorBox = $('#login-error');
  errorBox.classList.add('hidden'); setButtonBusy(button, true, 'Verificando...');
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: formObject(event.currentTarget) });
    await showDashboard(data);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  } finally { setButtonBusy(button, false); }
});

$$('[data-toggle-password]').forEach((button) => button.addEventListener('click', () => {
  const input = $(`#${button.dataset.togglePassword}`);
  input.type = input.type === 'password' ? 'text' : 'password';
  button.textContent = input.type === 'password' ? 'Ver' : 'Ocultar';
}));
$$('.nav-item').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.page)));
$$('[data-refresh="overview"]').forEach((button) => button.addEventListener('click', () => loadOverview().catch((error) => toast(error.message, 'error'))));
$('#menu-button').addEventListener('click', openSidebar);
$('#sidebar-backdrop').addEventListener('click', closeSidebar);

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* La sesión local se cierra igualmente. */ }
  showLogin();
});

$('#antiraid-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Guardando...');
  try {
    await api('/api/antiraid', { method: 'PATCH', body: formObject(event.currentTarget) });
    $('#antiraid-save-state').textContent = 'Cambios aplicados en tiempo real';
    toast('Protección Anti-Raid actualizada.');
    await loadAntiRaid();
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});

$('#antinuke-form [name="emergencyMode"]').addEventListener('change', (event) => {
  $('#emergency-setting').classList.toggle('active', event.currentTarget.checked);
});
$('#antinuke-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Guardando...');
  try {
    await api('/api/antinuke', { method: 'PATCH', body: formObject(event.currentTarget) });
    $('#antinuke-save-state').textContent = 'Protección actualizada';
    toast('Anti-Nuke actualizado.');
    await loadAntiNuke();
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});
$('#refresh-security-snapshot').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setButtonBusy(button, true, 'Actualizando...');
  try {
    await api('/api/antinuke/snapshot', { method: 'POST' });
    toast('Copia de seguridad actualizada.');
    await loadAntiNuke();
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});

$('#automod-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Guardando...');
  try {
    await api('/api/automod', { method: 'PATCH', body: formObject(event.currentTarget) });
    $('#automod-save-state').textContent = 'Filtros actualizados';
    toast('AutoMod actualizado.');
    await loadAutoMod();
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});
$('#clear-automod-strikes').addEventListener('click', async (event) => {
  if (!confirm('¿Reiniciar todos los strikes activos de AutoMod?')) return;
  const button = event.currentTarget;
  setButtonBusy(button, true, 'Reiniciando...');
  try {
    await api('/api/automod/strikes', { method: 'DELETE' });
    toast('Strikes de AutoMod reiniciados.');
    await loadAutoMod();
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});

$$('[data-emoji-field]').forEach((field) => {
  $('[data-emoji-type]', field).addEventListener('change', () => {
    updateEmojiField(field);
    updateTicketPreview();
  });
});
$('#tickets-form').addEventListener('input', updateTicketPreview);
$('#tickets-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Guardando...');
  try {
    const body = formObject(event.currentTarget);
    body.createButtonEmoji = readEmojiField('createButtonEmoji');
    body.infoButtonEmoji = readEmojiField('infoButtonEmoji');
    body.extraButtons = state.extraButtons;
    const result = await api('/api/tickets', { method: 'PATCH', body });
    state.extraButtons = structuredClone(result.settings.extraButtons ?? []);
    setEmojiField('createButtonEmoji', result.settings.createButtonEmoji);
    setEmojiField('infoButtonEmoji', result.settings.infoButtonEmoji);
    renderExtraButtons();
    $('#tickets-save-state').textContent = result.panelsUpdated
      ? `${result.panelsUpdated} panel(es) actualizado(s)`
      : 'Configuración guardada';
    toast(result.panelsUpdated
      ? `Tickets guardados y ${result.panelsUpdated} panel(es) actualizado(s).`
      : 'Sistema de tickets actualizado.');
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
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
    emoji: readEmojiField('extraButtonEmoji'),
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
});

$('#publish-button').addEventListener('click', async () => {
  const button = $('#publish-button'); const channelId = $('#publish-channel').value;
  if (!channelId) return toast('Selecciona un canal.', 'error');
  setButtonBusy(button, true, 'Publicando...');
  try {
    await api('/api/tickets/publish', { method: 'POST', body: { channelId } });
    toast('Panel publicado correctamente.');
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});

$$('.subpage-tab').forEach((tab) => tab.addEventListener('click', () => switchEmbedView(tab.dataset.embedView)));
$('#embed-form').addEventListener('input', updateEmbedPreview);
$('#embed-form-reset').addEventListener('click', resetEmbedForm);
$('#embed-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Guardando...');
  try {
    const result = await api(id ? `/api/embeds/${id}` : '/api/embeds', {
      method: id ? 'PATCH' : 'POST',
      body: embedPayload(),
    });
    $('#embed-save-state').textContent = id ? 'Embed actualizado' : 'Embed creado';
    toast(id ? 'Embed actualizado.' : 'Embed guardado.');
    form.elements.id.value = result.embed.id;
    $('#embed-form-title').textContent = `Editar · ${result.embed.name}`;
    await loadEmbeds();
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});
$('#refresh-embeds').addEventListener('click', () => loadEmbeds().then(() => toast('Embeds actualizados.')).catch((error) => toast(error.message, 'error')));

$('#new-user-button').addEventListener('click', () => openUserDialog());
$$('.modal-close, .modal-cancel').forEach((button) => button.addEventListener('click', () => $('#user-dialog').close()));
$('#user-form [name="isAdmin"]').addEventListener('change', togglePermissionFields);
$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget; const id = form.elements.id.value;
  const body = {
    username: form.elements.username.value,
    password: form.elements.password.value || undefined,
    isAdmin: form.elements.isAdmin.checked,
    disabled: form.elements.disabled.checked,
    permissions: [...form.querySelectorAll('[name="permissions"]:checked')].map((item) => item.value),
  };
  const errorBox = $('#user-form-error'); errorBox.classList.add('hidden');
  const button = form.querySelector('[type="submit"]'); setButtonBusy(button, true, 'Guardando...');
  try {
    await api(id ? `/api/users/${id}` : '/api/users', { method: id ? 'PATCH' : 'POST', body });
    $('#user-dialog').close();
    toast(id ? 'Usuario actualizado.' : 'Usuario creado.');
    await loadUsers();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  } finally { setButtonBusy(button, false); }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.elements.newPassword.value !== form.elements.confirmPassword.value) return toast('Las contraseñas nuevas no coinciden.', 'error');
  const button = form.querySelector('[type="submit"]'); setButtonBusy(button, true, 'Actualizando...');
  try {
    const result = await api('/api/account/password', {
      method: 'POST',
      body: { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value },
    });
    state.csrf = result.csrf;
    form.reset();
    toast('Contraseña actualizada y otras sesiones cerradas.');
  } catch (error) { toast(error.message, 'error'); }
  finally { setButtonBusy(button, false); }
});

resetEmbedForm();
(async () => {
  try { await showDashboard(await api('/api/auth/session')); }
  catch { showLogin(); }
})();
