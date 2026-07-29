const state = {
  user: null,
  csrf: null,
  permissions: [],
  resources: null,
  users: [],
  extraButtons: [],
  claimKey: {
    settings: null,
    stats: { available: 0, claimed: 0, total: 0 },
    credentials: [],
    loaded: false,
    actionPending: false,
    viewRevision: 0,
    loadGeneration: 0,
  },
  embeds: [],
  schedules: [],
};
const pages = {
  overview: 'Resumen',
  antiraid: 'Anti-Raid',
  antinuke: 'Anti-Nuke',
  automod: 'AutoMod',
  tickets: 'Tickets',
  claimkey: 'Claim Key',
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
  const claimKeyStat = $('#stat-claimkey');
  if (claimKeyStat) {
    claimKeyStat.textContent = data.stats.claimKeyAvailable ?? '—';
    $('#stat-claimkey-detail').textContent = data.stats.claimKeyClaimed === null
      ? 'Módulo restringido'
      : `${data.stats.claimKeyClaimed} reclamadas`;
  }
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
    if (name === 'claimkey') await loadClaimKey();
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

function closeEmojiPicker(select) {
  const picker = select?._visualEmojiPicker;
  if (!picker) return;
  picker.root.classList.remove('open');
  picker.panel.classList.add('hidden');
  picker.trigger.setAttribute('aria-expanded', 'false');
}

function syncEmojiPicker(select) {
  const picker = select?._visualEmojiPicker;
  if (!picker) return;
  const selected = picker.emojis.find((emoji) => emoji.id === select.value);
  picker.selected.replaceChildren();
  if (selected) {
    const image = document.createElement('img');
    image.src = selected.url;
    image.alt = `:${selected.name}:`;
    image.loading = 'lazy';
    const name = document.createElement('span');
    name.textContent = `:${selected.name}:`;
    picker.selected.append(image, name);
    picker.trigger.classList.add('has-selection');
  } else {
    const placeholder = document.createElement('span');
    placeholder.textContent = 'Elegir emoji del servidor';
    picker.selected.append(placeholder);
    picker.trigger.classList.remove('has-selection');
  }
}

function updateEmojiFieldPreview(select) {
  const name = select?.closest('[data-emoji-field]')?.dataset.emojiField;
  if (name === 'claimKeyButtonEmoji') updateClaimKeyPreview();
  else updateTicketPreview();
}

function clearUnicodeEmoji(field) {
  if (!field) return;
  field.dataset.unicodeEmoji = '';
  const input = $('[data-emoji-unicode]', field);
  if (input) input.value = '';
}

function renderEmojiPicker(select, query = '') {
  const picker = select._visualEmojiPicker;
  const cleanQuery = query.trim().toLocaleLowerCase('es');
  const emojis = picker.emojis.filter((emoji) => emoji.name.toLocaleLowerCase('es').includes(cleanQuery));
  const buttons = [];

  if (!cleanQuery) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'visual-emoji-option clear-option';
    clear.title = 'Sin emoji';
    clear.setAttribute('aria-label', 'No usar emoji');
    const clearIcon = document.createElement('span'); clearIcon.textContent = '∅';
    clear.append(clearIcon);
    clear.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      select.value = '';
      clearUnicodeEmoji(select.closest('[data-emoji-field]'));
      syncEmojiPicker(select);
      closeEmojiPicker(select);
      updateEmojiFieldPreview(select);
    });
    buttons.push(clear);
  }

  for (const emoji of emojis) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'visual-emoji-option';
    button.classList.toggle('selected', select.value === emoji.id);
    button.title = `:${emoji.name}:${emoji.animated ? ' · animado' : ''}`;
    button.setAttribute('aria-label', `Seleccionar emoji ${emoji.name}`);
    const image = document.createElement('img');
    image.src = emoji.url;
    image.alt = `:${emoji.name}:`;
    image.loading = 'lazy';
    button.append(image);
    button.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      select.value = emoji.id;
      clearUnicodeEmoji(select.closest('[data-emoji-field]'));
      syncEmojiPicker(select);
      closeEmojiPicker(select);
      updateEmojiFieldPreview(select);
    });
    buttons.push(button);
  }

  picker.grid.replaceChildren(...buttons);
  picker.empty.textContent = cleanQuery
    ? 'No se encontraron emojis.'
    : 'Este servidor todavía no tiene emojis personalizados.';
  picker.empty.classList.toggle('hidden', emojis.length > 0);
}

function ensureEmojiPicker(select, emojis) {
  select.classList.add('emoji-native-select');
  if (!select._visualEmojiPicker) {
    const root = document.createElement('div'); root.className = 'visual-emoji-picker';
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'visual-emoji-trigger'; trigger.setAttribute('aria-expanded', 'false');
    const selected = document.createElement('span'); selected.className = 'visual-emoji-selected';
    const chevron = document.createElement('span'); chevron.className = 'visual-emoji-chevron'; chevron.textContent = '⌄';
    trigger.append(selected, chevron);
    const panel = document.createElement('div'); panel.className = 'visual-emoji-panel hidden';
    const heading = document.createElement('div'); heading.className = 'visual-emoji-heading'; heading.textContent = 'EMOJIS DEL SERVIDOR';
    const search = document.createElement('input');
    search.type = 'search'; search.className = 'visual-emoji-search'; search.placeholder = 'Buscar emoji...'; search.autocomplete = 'off';
    const grid = document.createElement('div'); grid.className = 'visual-emoji-grid';
    const empty = document.createElement('p'); empty.className = 'visual-emoji-empty hidden'; empty.textContent = 'No se encontraron emojis.';
    panel.append(heading, search, grid, empty); root.append(trigger, panel); select.insertAdjacentElement('afterend', root);
    select._visualEmojiPicker = { root, trigger, selected, panel, search, grid, empty, emojis: [] };

    trigger.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      const opening = panel.classList.contains('hidden');
      $$('[data-emoji-custom] select').forEach((other) => { if (other !== select) closeEmojiPicker(other); });
      panel.classList.toggle('hidden', !opening);
      root.classList.toggle('open', opening);
      trigger.setAttribute('aria-expanded', String(opening));
      if (opening) { search.value = ''; renderEmojiPicker(select); search.focus(); }
    });
    panel.addEventListener('click', (event) => event.stopPropagation());
    search.addEventListener('input', () => renderEmojiPicker(select, search.value));
  }
  select._visualEmojiPicker.emojis = emojis;
  renderEmojiPicker(select);
  syncEmojiPicker(select);
}

document.addEventListener('click', () => {
  $$('[data-emoji-custom] select').forEach(closeEmojiPicker);
});

function populateEmojiSelectors(resources) {
  const emojis = resources.emojis ?? [];
  $$('[data-emoji-custom] select').forEach((select) => {
    const selected = select.value;
    select.replaceChildren(new Option('Selecciona un emoji', ''));
    for (const emoji of emojis) select.append(new Option(`:${emoji.name}:`, emoji.id));
    select.value = emojis.some((emoji) => emoji.id === selected) ? selected : '';
    ensureEmojiPicker(select, emojis);
  });
}

function emojiField(name) {
  return $(`[data-emoji-field="${name}"]`);
}

function setEmojiField(name, emoji) {
  const field = emojiField(name);
  if (!field) return;
  const customSelect = $('[data-emoji-custom] select', field);
  const unicode = emoji?.type === 'unicode' ? emoji.name : '';
  field.dataset.unicodeEmoji = unicode || '';
  const unicodeInput = $('[data-emoji-unicode]', field);
  if (unicodeInput) unicodeInput.value = unicode || '';
  customSelect.value = emoji?.type === 'custom' ? emoji.id : '';
  syncEmojiPicker(customSelect);
}

function readEmojiField(name) {
  const field = emojiField(name);
  if (!field) return null;
  const id = $('[data-emoji-custom] select', field).value;
  if (id) return { type: 'custom', id };
  const unicodeInput = $('[data-emoji-unicode]', field);
  const unicode = (unicodeInput?.value ?? field.dataset.unicodeEmoji ?? '').trim();
  return unicode ? { type: 'unicode', name: unicode } : null;
}

function appendEmojiLabel(element, emoji, label) {
  if (emoji?.type === 'unicode' && emoji.name) {
    const unicode = document.createElement('span'); unicode.className = 'inline-emoji unicode'; unicode.textContent = emoji.name;
    element.append(unicode);
  } else if (emoji?.type === 'custom') {
    const resource = state.resources?.emojis?.find((item) => item.id === emoji.id);
    if (resource) {
      const image = document.createElement('img');
      image.className = 'inline-emoji custom'; image.src = resource.url; image.alt = `:${resource.name}:`; image.loading = 'lazy';
      element.append(image);
    }
  }
  element.append(document.createTextNode(label));
}

const ticketButtonStyles = {
  primary: { label: 'Azul', color: '#5865F2' },
  secondary: { label: 'Gris', color: '#4E5058' },
  success: { label: 'Verde', color: '#248046' },
  danger: { label: 'Rojo', color: '#DA373C' },
};
const ticketStyleLabels = {
  ...Object.fromEntries(Object.entries(ticketButtonStyles).map(([style, value]) => [style, value.label])),
  link: 'Enlace',
};

function syncTicketButtonStylePicker(select) {
  const picker = select?._ticketButtonStylePicker;
  if (!picker) return;
  for (const button of picker.buttons) {
    const selected = button.dataset.style === select.value;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}

function updateButtonStylePreview(select) {
  if (select?.closest('#claim-key-form')) updateClaimKeyPreview();
  else updateTicketPreview();
}

function ensureTicketButtonStylePicker(select) {
  if (!select) return;
  select.classList.add('ticket-button-style-select');
  if (!select._ticketButtonStylePicker) {
    const root = document.createElement('div');
    root.className = 'ticket-button-style-picker';
    const buttons = Object.entries(ticketButtonStyles).map(([style, option]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ticket-button-style-option';
      button.dataset.style = style;
      button.setAttribute('aria-label', `Usar color ${option.label}`);
      const swatch = document.createElement('span');
      swatch.className = 'ticket-button-style-swatch';
      swatch.style.backgroundColor = option.color;
      const label = document.createElement('span');
      label.textContent = option.label;
      button.append(swatch, label);
      button.addEventListener('click', () => {
        select.value = style;
        syncTicketButtonStylePicker(select);
        updateButtonStylePreview(select);
      });
      return button;
    });
    root.append(...buttons);
    select.insertAdjacentElement('afterend', root);
    select._ticketButtonStylePicker = { root, buttons };
  }
  syncTicketButtonStylePicker(select);
}

function initializeTicketButtonStylePickers() {
  [
    $('#tickets-form [name="createButtonStyle"]'),
    $('#tickets-form [name="infoButtonStyle"]'),
    $('#extra-button-form [name="style"]'),
  ].forEach(ensureTicketButtonStylePicker);
}

async function loadTickets() {
  const [data, resources] = await Promise.all([api('/api/tickets'), getResources()]);
  state.extraButtons = structuredClone(data.settings.extraButtons ?? []);
  fillForm($('#tickets-form'), data.settings);
  initializeTicketButtonStylePickers();
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
    appendEmojiLabel(element, button.emoji, button.label);
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
    appendEmojiLabel(title, button.emoji, button.label);
    const detail = document.createElement('small');
    detail.textContent = button.type === 'link'
      ? `Enlace · ${button.value}`
      : `Respuesta privada · ${ticketStyleLabels[button.style] ?? 'Gris'}`;
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
  syncTicketButtonStylePicker(form.elements.style);
  form.elements.value.value = button?.value ?? '';
  setEmojiField('extraButtonEmoji', button?.emoji);
  $('#extra-button-title').textContent = button ? 'Editar botón' : 'Nuevo botón';
  updateExtraButtonFields();
  $('#extra-button-dialog').showModal();
}

function applyClaimKeyView(data) {
  state.claimKey.viewRevision += 1;
  state.claimKey.settings = structuredClone(data.settings ?? {});
  state.claimKey.loaded = true;
  state.claimKey.stats = {
    available: Number(data.stats?.available) || 0,
    claimed: Number(data.stats?.claimed) || 0,
    total: Number(data.stats?.total) || 0,
  };
  state.claimKey.credentials = Array.isArray(data.credentials)
    ? data.credentials.map((credential) => structuredClone(credential))
    : [];
  const form = $('#claim-key-form');
  if (form?.elements.enabled) {
    form.elements.enabled.checked = Boolean(state.claimKey.settings.enabled);
  }
  renderClaimKeyStats();
  renderClaimKeyInventory();
  renderClaimKeyStatus();
  if (form) updateClaimKeyPreview();
}

function renderClaimKeyStatus() {
  const loaded = state.claimKey.loaded;
  const enabled = Boolean(state.claimKey.settings?.enabled);
  const publishedPanels = Array.isArray(state.claimKey.settings?.publishedPanels)
    ? state.claimKey.settings.publishedPanels.length
    : 0;
  const card = $('#claim-key-status-card');
  card.classList.toggle('is-active', loaded && enabled);
  card.classList.toggle('is-paused', loaded && !enabled);
  $('#claim-key-status-dot').className = loaded ? (enabled ? 'is-active' : 'is-paused') : '';
  $('#claim-key-status-label').textContent = loaded
    ? (enabled ? 'Reclamaciones activas' : 'Reclamaciones pausadas')
    : 'Actualizando estado';
  $('#claim-key-status-copy').textContent = loaded
    ? enabled
      ? `“Obtener clave” está habilitado en ${publishedPanels} panel(es) registrado(s).`
      : 'Los paneles siguen visibles, pero “Obtener clave” permanece deshabilitado hasta que reactives las entregas.'
    : 'Esperando la configuración vigente del servidor.';

  const controlsLocked = !loaded || state.claimKey.actionPending;
  const toggleButton = $('#claim-key-toggle-button');
  toggleButton.className = `button ${loaded ? (enabled ? 'danger' : 'primary') : 'ghost'}`;
  toggleButton.textContent = loaded
    ? (enabled ? 'Pausar reclamaciones' : 'Reactivar reclamaciones')
    : 'Cargando...';
  toggleButton.setAttribute('aria-label', toggleButton.textContent);
  toggleButton.disabled = controlsLocked;

  const publishButton = $('#claim-key-publish-button');
  const canPublish = !controlsLocked && enabled && state.claimKey.stats.available > 0;
  publishButton.disabled = !canPublish;
  publishButton.title = canPublish
    ? ''
    : controlsLocked
      ? 'Espera a que termine la operación actual.'
      : enabled
        ? 'Añade al menos una credencial disponible para publicar.'
        : 'Reactiva las reclamaciones antes de publicar.';

  const saveButton = $('#claim-key-form [type="submit"]');
  if (saveButton) saveButton.disabled = controlsLocked;
  $$('#claim-key-form input, #claim-key-form textarea, #claim-key-form select, #claim-key-form button, #claim-key-single-form input, #claim-key-single-form button, #claim-key-bulk-form textarea, #claim-key-bulk-form button, #claim-key-list button')
    .forEach((control) => { control.disabled = controlsLocked; });
}

async function loadClaimKey() {
  const loadGeneration = ++state.claimKey.loadGeneration;
  const revisionAtStart = state.claimKey.viewRevision;
  state.claimKey.loaded = false;
  renderClaimKeyStats();
  renderClaimKeyStatus();
  const [data, resources] = await Promise.all([api('/api/claim-key'), getResources()]);
  if (
    state.claimKey.loadGeneration !== loadGeneration
    || state.claimKey.viewRevision !== revisionAtStart
  ) return;
  applyClaimKeyView(data);
  const form = $('#claim-key-form');
  fillForm(form, data.settings);
  ensureTicketButtonStylePicker(form.elements.buttonStyle);
  syncTicketButtonStylePicker(form.elements.buttonStyle);
  populateSelect($('#claim-key-publish-channel'), resources.channels, '', '#');
  populateEmojiSelectors(resources);
  setEmojiField('claimKeyButtonEmoji', data.settings.buttonEmoji);
  updateClaimKeyPreview();
}

function claimKeyPayload() {
  const form = $('#claim-key-form');
  const body = formObject(form);
  body.buttonEmoji = readEmojiField('claimKeyButtonEmoji');
  return body;
}

function updateClaimKeyPreview() {
  const form = $('#claim-key-form');
  if (!form) return;
  const color = form.elements.embedColor.value || '#5865F2';
  $('#claim-key-color-value').textContent = color.toUpperCase();
  $('#claim-key-preview-embed').style.borderLeftColor = color;
  $('#claim-key-preview-title').textContent = form.elements.panelTitle.value.trim() || 'Título del panel';
  $('#claim-key-preview-description').textContent = form.elements.panelDescription.value.trim() || 'Descripción del acceso.';
  $('#claim-key-preview-warning').textContent = form.elements.warningText.value.trim() || 'Advertencia del acceso.';
  $('#claim-key-preview-footer').textContent = form.elements.footerText.value.trim() || 'BLL$LIFE Access';

  const author = $('#claim-key-preview-author');
  const authorName = form.elements.authorName.value.trim();
  author.classList.toggle('hidden', !authorName);
  $('span', author).textContent = authorName;
  setPreviewImage($('#claim-key-preview-author-icon'), authorName ? form.elements.authorIconUrl.value.trim() : '');
  setPreviewImage($('#claim-key-preview-image'), form.elements.panelImageUrl.value.trim());
  setPreviewImage($('#claim-key-preview-thumbnail'), form.elements.thumbnailUrl.value.trim());

  const button = $('#claim-key-preview-button');
  button.className = `discord-button ${form.elements.buttonStyle.value || 'primary'}`;
  button.classList.toggle('disabled', !form.elements.enabled.checked);
  button.setAttribute('aria-disabled', String(!form.elements.enabled.checked));
  button.replaceChildren();
  appendEmojiLabel(
    button,
    readEmojiField('claimKeyButtonEmoji'),
    form.elements.buttonLabel.value.trim() || 'Obtener clave',
  );
}

function renderClaimKeyStats() {
  const { available, claimed, total } = state.claimKey.stats;
  $('#claim-key-available').textContent = available.toLocaleString('es-ES');
  $('#claim-key-claimed').textContent = claimed.toLocaleString('es-ES');
  $('#claim-key-total').textContent = total.toLocaleString('es-ES');
  const enabled = Boolean(state.claimKey.settings?.enabled);
  const badge = $('#claim-key-stock-badge');
  if (!state.claimKey.loaded) {
    badge.textContent = 'Cargando estado';
    badge.className = 'badge neutral';
  } else if (!enabled) {
    badge.textContent = 'Entregas pausadas';
    badge.className = 'badge warning';
  } else {
    badge.textContent = `${available.toLocaleString('es-ES')} disponible${available === 1 ? '' : 's'}`;
    badge.className = `badge ${available > 0 ? 'success' : total > 0 ? 'danger' : 'neutral'}`;
  }

  const resetButton = $('#claim-key-reset-button');
  const resetLocked = !state.claimKey.loaded || state.claimKey.actionPending;
  resetButton.disabled = resetLocked || claimed < 1;
  resetButton.title = resetLocked
    ? 'Espera a que termine la carga u operación actual.'
    : claimed > 0
      ? `Reiniciar ${claimed.toLocaleString('es-ES')} reclamación(es).`
      : 'No hay reclamaciones para reiniciar.';
}

function formatClaimKeyDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Fecha no disponible'
    : date.toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

function createClaimKeyCredentialItem(credential) {
  const item = document.createElement('article');
  item.className = 'claim-key-item';

  const identity = document.createElement('div');
  identity.className = 'claim-key-identity';
  const username = document.createElement('strong');
  username.textContent = credential.username;
  const secret = document.createElement('code');
  secret.className = 'credential-secret';
  secret.textContent = credential.passwordMasked || '••••••••';
  identity.append(username, secret);

  const status = document.createElement('span');
  status.className = `badge claim-key-status ${credential.status === 'claimed' ? 'neutral' : 'success'}`;
  status.textContent = credential.status === 'claimed' ? 'Reclamada' : 'Disponible';

  const meta = document.createElement('div');
  meta.className = 'claim-key-meta';
  const id = document.createElement('span');
  id.textContent = `ID interno: ${credential.id}`;
  const created = document.createElement('span');
  created.textContent = `Creada: ${formatClaimKeyDate(credential.createdAt)}`;
  meta.append(id, created);

  const details = document.createElement('div');
  details.className = 'claim-key-claimant';
  if (credential.status === 'claimed' && credential.claimedBy) {
    const claimant = document.createElement('strong');
    claimant.textContent = credential.claimedBy.globalName
      || credential.claimedBy.username
      || credential.claimedBy.tag
      || 'Cuenta de Discord';
    const publicIdentity = document.createElement('span');
    const labels = [credential.claimedBy.tag, credential.claimedBy.username]
      .filter((value, index, values) => value && values.indexOf(value) === index);
    publicIdentity.textContent = labels.join(' · ') || 'Nombre público no disponible';
    const discordId = document.createElement('span');
    discordId.textContent = `Discord ID: ${credential.claimedBy.userId}`;
    const claimedAt = document.createElement('span');
    claimedAt.textContent = `Reclamada: ${formatClaimKeyDate(credential.claimedBy.claimedAt)}`;
    details.append(claimant, publicIdentity, discordId, claimedAt);
  } else {
    const available = document.createElement('span');
    available.textContent = 'Sin reclamante asignado.';
    details.append(available);
  }

  const actions = document.createElement('div');
  actions.className = 'claim-key-item-actions';
  if (credential.status === 'available') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button danger';
    remove.textContent = 'Eliminar';
    remove.addEventListener('click', () => deleteClaimKeyCredential(credential, remove));
    actions.append(remove);
  } else {
    const locked = document.createElement('span');
    locked.className = 'claim-key-locked';
    locked.textContent = 'Registro protegido';
    actions.append(locked);
  }

  item.append(identity, status, meta, details, actions);
  return item;
}

function renderClaimKeyInventory() {
  const list = $('#claim-key-list');
  if (!state.claimKey.credentials.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No hay credenciales guardadas.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...state.claimKey.credentials.map(createClaimKeyCredentialItem));
}

function parseBulkClaimCredentials(source) {
  const credentials = [];
  const usernames = new Set();
  const lines = String(source).split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const lineNumber = index + 1;
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`Línea ${lineNumber}: usa el formato usuario:contraseña.`);
    const username = line.slice(0, separator).trim();
    const password = line.slice(separator + 1);
    if (!username || username.length > 128 || /[\u0000-\u001f\u007f]/u.test(username)) {
      throw new Error(`Línea ${lineNumber}: el usuario no es válido.`);
    }
    if (!password || password.length > 512 || /[\u0000-\u001f\u007f]/u.test(password)) {
      throw new Error(`Línea ${lineNumber}: la contraseña no es válida.`);
    }
    const normalized = username.toLocaleLowerCase('en-US');
    if (usernames.has(normalized)) throw new Error(`Línea ${lineNumber}: el usuario está repetido.`);
    usernames.add(normalized);
    credentials.push({ username, password });
  });
  if (!credentials.length) throw new Error('Añade al menos una credencial válida.');
  if (credentials.length > 250) throw new Error('La importación admite un máximo de 250 credenciales.');
  return credentials;
}

function splitClaimKeyCredentialBatches(credentials) {
  const maximumBytes = 60 * 1024;
  const batches = [];
  let current = [];
  for (const credential of credentials) {
    const candidate = [...current, credential];
    const bytes = new TextEncoder().encode(JSON.stringify({ credentials: candidate })).byteLength;
    if (bytes > maximumBytes && current.length) {
      batches.push(current);
      current = [credential];
    } else {
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

async function addClaimKeyCredentials(credentials) {
  const existing = new Set(state.claimKey.credentials.map((item) => item.username.toLocaleLowerCase('en-US')));
  const duplicate = credentials.find((item) => existing.has(item.username.toLocaleLowerCase('en-US')));
  if (duplicate) throw new Error(`El usuario “${duplicate.username}” ya existe en el inventario.`);
  let data = null;
  for (const batch of splitClaimKeyCredentialBatches(credentials)) {
    data = await api('/api/claim-key/credentials', {
      method: 'POST',
      body: { credentials: batch },
    });
  }
  applyClaimKeyView(data);
}

async function deleteClaimKeyCredential(credential, button) {
  if (!confirm(`¿Eliminar la credencial disponible “${credential.username}”? Esta acción no se puede deshacer.`)) return;
  if (!beginClaimKeyAction(button, 'Eliminando...')) return;
  try {
    const data = await api(`/api/claim-key/credentials/${encodeURIComponent(credential.id)}`, { method: 'DELETE' });
    applyClaimKeyView(data);
    toast('Credencial eliminada del inventario.');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    endClaimKeyAction(button);
  }
}

function beginClaimKeyAction(button, label) {
  if (!state.claimKey.loaded || state.claimKey.actionPending) return false;
  state.claimKey.actionPending = true;
  renderClaimKeyStats();
  renderClaimKeyStatus();
  setButtonBusy(button, true, label);
  return true;
}

function endClaimKeyAction(button) {
  setButtonBusy(button, false);
  state.claimKey.actionPending = false;
  renderClaimKeyStats();
  renderClaimKeyStatus();
}

function claimKeySyncSummary(data, baseText) {
  const updated = Number(data.panelsUpdated) || 0;
  const failed = Number(data.panelsFailed) || 0;
  const pruned = Number(data.panelsPruned) || 0;
  const details = [];
  if (updated) details.push(`${updated} sincronizado(s)`);
  if (failed) details.push(`${failed} sin sincronizar`);
  if (pruned) details.push(`${pruned} registro(s) obsoleto(s) eliminado(s)`);
  return {
    failed,
    text: details.length ? `${baseText} · ${details.join(' · ')}` : baseText,
  };
}

async function toggleClaimKeyAvailability() {
  const button = $('#claim-key-toggle-button');
  const requestedEnabled = !Boolean(state.claimKey.settings?.enabled);
  if (!beginClaimKeyAction(button, requestedEnabled ? 'Reactivando...' : 'Pausando...')) return;
  $('#claim-key-toggle-state').textContent = '';
  try {
    const data = await api('/api/claim-key', { method: 'PATCH', body: { enabled: requestedEnabled } });
    applyClaimKeyView(data);
    const enabled = Boolean(data.settings?.enabled);
    const statusText = enabled ? 'Reclamaciones reactivadas' : 'Reclamaciones pausadas';
    const sync = claimKeySyncSummary(data, statusText);
    $('#claim-key-toggle-state').textContent = sync.text;
    $('#claim-key-save-state').textContent = statusText;
    if (sync.failed) {
      toast(
        `${statusText} en el backend, pero ${sync.failed} panel(es) no pudieron actualizarse. Se bloquearán al intentar reclamar.`,
        'error',
      );
    } else {
      toast(enabled
        ? '“Obtener clave” vuelve a estar disponible.'
        : '“Obtener clave” fue deshabilitado en los paneles registrados.');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    endClaimKeyAction(button);
  }
}

async function resetClaimKeyClaims() {
  const claimed = state.claimKey.stats.claimed;
  if (claimed < 1) return;
  const confirmed = confirm(
    `Vas a reiniciar ${claimed.toLocaleString('es-ES')} reclamación(es). `
      + 'Se borrará la asignación a cada Discord, las credenciales volverán a estar disponibles '
      + 'y “Obtener clave” quedará pausado. El reset no cambia las contraseñas externas; '
      + 'quienes ya las recibieron pueden conservarlas. ¿Deseas continuar?',
  );
  if (!confirmed) return;

  const button = $('#claim-key-reset-button');
  if (!beginClaimKeyAction(button, 'Reiniciando...')) return;
  $('#claim-key-reset-state').textContent = '';
  try {
    const data = await api('/api/claim-key/claims/reset', { method: 'POST' });
    applyClaimKeyView(data);
    const resetCount = Number(data.resetCount) || 0;
    const baseText = `${resetCount.toLocaleString('es-ES')} reclamación(es) reiniciada(s). Claim Key quedó pausado.`;
    const sync = claimKeySyncSummary(data, baseText);
    $('#claim-key-reset-state').textContent = sync.text;
    $('#claim-key-toggle-state').textContent = sync.failed
      ? `Pausa aplicada en backend · ${sync.failed} panel(es) pendientes`
      : 'Reclamaciones pausadas tras el reinicio';
    $('#claim-key-save-state').textContent = 'Reclamaciones pausadas tras el reinicio';
    updateClaimKeyPreview();
    if (sync.failed) {
      toast(
        `Se reiniciaron ${resetCount.toLocaleString('es-ES')} reclamación(es), pero ${sync.failed} panel(es) no pudieron actualizarse. El backend permanece pausado.`,
        'error',
      );
    } else {
      toast(`Se reiniciaron ${resetCount.toLocaleString('es-ES')} reclamación(es) y se pausaron las entregas.`);
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    endClaimKeyAction(button);
  }
}

function switchClaimKeyView(name) {
  const selected = name === 'inventory' ? 'inventory' : 'panel';
  $$('[data-claim-key-view]').forEach((tab) => {
    const active = tab.dataset.claimKeyView === selected;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  $$('.claim-key-subpage').forEach((view) => {
    const active = view.id === `claim-key-view-${selected}`;
    view.classList.toggle('active', active);
    view.hidden = !active;
  });
}

function handleClaimKeyTabKeydown(event) {
  const tabs = $$('[data-claim-key-view]');
  const currentIndex = tabs.indexOf(event.currentTarget);
  let nextIndex = currentIndex;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else {
    return;
  }
  event.preventDefault();
  const nextTab = tabs[nextIndex];
  switchClaimKeyView(nextTab.dataset.claimKeyView);
  nextTab.focus();
}

function switchEmbedView(name) {
  $$('[data-embed-view]').forEach((tab) => {
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

$('#tickets-form').addEventListener('input', updateTicketPreview);
$('#tickets-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  setButtonBusy(button, true, 'Guardando...');
  try {
    const body = formObject(form);
    body.createButtonEmoji = readEmojiField('createButtonEmoji');
    body.infoButtonEmoji = readEmojiField('infoButtonEmoji');
    body.extraButtons = state.extraButtons;
    const result = await api('/api/tickets', { method: 'PATCH', body });
    state.extraButtons = structuredClone(result.settings.extraButtons ?? []);
    syncTicketButtonStylePicker(form.elements.createButtonStyle);
    syncTicketButtonStylePicker(form.elements.infoButtonStyle);
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

$$('[data-claim-key-view]').forEach((tab) => {
  tab.addEventListener('click', () => switchClaimKeyView(tab.dataset.claimKeyView));
  tab.addEventListener('keydown', handleClaimKeyTabKeydown);
});
$('#claim-key-toggle-button').addEventListener('click', toggleClaimKeyAvailability);
$('#claim-key-reset-button').addEventListener('click', resetClaimKeyClaims);

const claimKeyUnicodeInput = $('#claim-key-form [data-emoji-unicode]');
claimKeyUnicodeInput.addEventListener('input', () => {
  const field = emojiField('claimKeyButtonEmoji');
  field.dataset.unicodeEmoji = claimKeyUnicodeInput.value.trim();
  const customSelect = $('[data-emoji-custom] select', field);
  if (customSelect.value) {
    customSelect.value = '';
    syncEmojiPicker(customSelect);
  }
  updateClaimKeyPreview();
});
$('#claim-key-form').addEventListener('input', updateClaimKeyPreview);
$('#claim-key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  if (!beginClaimKeyAction(button, 'Guardando...')) return;
  try {
    const data = await api('/api/claim-key', { method: 'PATCH', body: claimKeyPayload() });
    applyClaimKeyView(data);
    fillForm(form, data.settings);
    syncTicketButtonStylePicker(form.elements.buttonStyle);
    setEmojiField('claimKeyButtonEmoji', data.settings.buttonEmoji);
    updateClaimKeyPreview();
    const sync = claimKeySyncSummary(data, 'Configuración guardada');
    $('#claim-key-save-state').textContent = sync.text;
    if (sync.failed) {
      toast(
        `Configuración guardada, pero ${sync.failed} panel(es) no pudieron sincronizarse. El backend usa el estado nuevo.`,
        'error',
      );
    } else {
      toast('Configuración Claim Key guardada.');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    endClaimKeyAction(button);
  }
});

$('#claim-key-single-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  if (!beginClaimKeyAction(button, 'Cifrando...')) return;
  try {
    await addClaimKeyCredentials([{
      username: form.elements.username.value.trim(),
      password: form.elements.password.value,
    }]);
    form.reset();
    toast('Credencial cifrada y añadida al inventario.');
  } catch (error) {
    form.elements.password.value = '';
    toast(error.message, 'error');
  } finally {
    endClaimKeyAction(button);
  }
});

$('#claim-key-bulk-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  if (!beginClaimKeyAction(button, 'Importando...')) return;
  try {
    const credentials = parseBulkClaimCredentials(form.elements.credentials.value);
    await addClaimKeyCredentials(credentials);
    form.elements.credentials.value = '';
    toast(`${credentials.length} credencial(es) cifrada(s) e importada(s).`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    endClaimKeyAction(button);
  }
});

$('#claim-key-publish-button').addEventListener('click', async () => {
  const button = $('#claim-key-publish-button');
  const channelId = $('#claim-key-publish-channel').value;
  if (!channelId) return toast('Selecciona un canal para publicar Claim Key.', 'error');
  if (!beginClaimKeyAction(button, 'Publicando...')) return;
  try {
    const result = await api('/api/claim-key/publish', { method: 'POST', body: { channelId } });
    const sync = claimKeySyncSummary(result, 'Panel publicado y guardado para sincronización');
    $('#claim-key-publish-state').textContent = sync.text;
    if (sync.failed) {
      toast(`Panel publicado, pero ${sync.failed} publicación(es) anterior(es) no pudieron sincronizarse.`, 'error');
    } else {
      toast('Panel Claim Key publicado correctamente.');
    }
    await loadClaimKey();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    endClaimKeyAction(button);
  }
});

$$('[data-embed-view]').forEach((tab) => tab.addEventListener('click', () => switchEmbedView(tab.dataset.embedView)));
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
