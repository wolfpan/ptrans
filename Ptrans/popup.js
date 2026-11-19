// popup.js
const CONFIG_FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang', 'styleMode', 'explainTerms', 'hoverCtrl', 'autoEnglish'];
const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  styleMode: 'balanced'
};

let currentHost = '';
let pageLang = null; // 当前页面主语言（内容脚本检测），判不出为 null
let alwaysSites = [];
let enabledModels = []; // 勾选启用的模型，供「翻译模型」下拉选择
let manualModels = []; // 手动添加的模型，API 列表获取成功后不被自动移除
let fetchedModels = []; // 最近一次从 API 获取到的完整模型列表

// 目标语言与风格：value 为提示词使用的语言本名/风格键
// 目标语言选项用各语言的本名（endonym）显示，不随界面语言翻译；风格文案由 i18n.js 按界面语言生成
const LANG_VALUES = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Italiano', 'Português', 'Русский', 'العربية', 'ไทย', 'Tiếng Việt', 'Bahasa Indonesia', 'Bahasa Melayu'];
const STYLE_VALUES = ['strict', 'balanced', 'elegant'];

function langItems() {
  return LANG_VALUES.map(value => ({ value, label: value }));
}

function styleItems(lang) {
  return STYLE_VALUES.map(value => {
    const key = 'style' + value[0].toUpperCase() + value.slice(1);
    return { value, label: t(lang, key), title: t(lang, key + 'Title') };
  });
}

// ===== 界面语言跟随目标语言 =====
let uiLang = DEFAULTS.targetLang;

// 刷新全部界面文案：静态标记、两个下拉的显示文本、站点后缀与模型提示
function applyI18n(lang) {
  uiLang = lang;
  document.documentElement.lang = LANG_TAGS[lang] || 'en';
  document.documentElement.dir = lang === 'العربية' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(lang, el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(lang, el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(lang, el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    const text = t(lang, el.dataset.i18nPlaceholder);
    el.setAttribute('placeholder', text);
    el.dataset.placeholder = text; // syncDrop 的回退文本与之同源
  }
  // 重建下拉选项（value 不变，选中态保留）
  setDropItems('targetLang', langItems());
  setDropItems('styleMode', styleItems(lang));
  renderSiteHost();
  renderAutoLangLabel();
  renderModelHint();
  renderVersion();
}

// 版本号取自 manifest，展开 API 抽屉时显示在右下角
function renderVersion() {
  document.getElementById('versionLabel').textContent =
    t(uiLang, 'version', { version: chrome.runtime.getManifest().version });
}

function renderSiteHost() {
  document.getElementById('siteHost').textContent = currentHost
    ? t(uiLang, 'siteHost', { host: currentHost })
    : t(uiLang, 'siteUnsupported');
}

// 自动翻译开关文案跟随当前页面语言；判不出或与目标语言相同时用通用文案
function renderAutoLangLabel() {
  const label = document.querySelector('label[for="autoEnglish"]');
  label.textContent = pageLang && pageLang !== uiLang
    ? t(uiLang, 'autoLang', { lang: langLabel(uiLang, pageLang) })
    : t(uiLang, 'autoForeign');
}

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get([...CONFIG_FIELDS, 'alwaysSites', 'enabledModels', 'manualModels']);
  document.getElementById('baseUrl').value = data.baseUrl || DEFAULTS.baseUrl;
  document.getElementById('apiKey').value = data.apiKey || '';
  uiLang = data.targetLang || DEFAULTS.targetLang;
  setupDrop('targetLang', langItems(), value => { saveConfig(); applyI18n(value); });
  setupDrop('styleMode', styleItems(uiLang), saveConfig);
  setupDrop('model', [], saveConfig);
  setVal('targetLang', uiLang);
  setVal('styleMode', data.styleMode || DEFAULTS.styleMode);
  document.getElementById('explainTerms').checked = !!data.explainTerms;
  document.getElementById('hoverCtrl').checked = !!data.hoverCtrl;
  document.getElementById('autoEnglish').checked = !!data.autoEnglish;

  // 首次使用时把默认值写入存储，供内容脚本的自动翻译读取
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (data[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length > 0) await chrome.storage.local.set(missing);

  // 勾选列表：旧版本只存了单个 model，升级时自动迁移为勾选项；
  // 已有列表（含用户主动清空的空数组）原样保留，避免默认模型被反复写回
  if (Array.isArray(data.enabledModels)) {
    enabledModels = data.enabledModels;
  } else {
    enabledModels = [data.model || DEFAULTS.model];
    await chrome.storage.local.set({ enabledModels });
  }
  manualModels = Array.isArray(data.manualModels) ? data.manualModels : [];
  renderModelDrop();
  setVal('model', data.model || DEFAULTS.model);
  // 存储中的模型不在勾选列表时（如换 API 后遗留），下拉已回退到实际可选项，
  // 把该选择写回存储，避免内容脚本仍按旧模型发请求
  if (getVal('model') !== (data.model || DEFAULTS.model)) await saveConfig();

  // 未配置密钥时展开 API 抽屉，引导首次填写
  if (!data.apiKey) document.getElementById('apiDrawer').open = true;

  // 「始终翻译此网站」按当前标签页的站点记忆
  alwaysSites = Array.isArray(data.alwaysSites) ? data.alwaysSites : [];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { currentHost = tab && tab.url ? new URL(tab.url).hostname : ''; } catch { currentHost = ''; }
  // 页面语言检测失败（chrome://、商店页、扩展更新后未刷新的页面）时回退通用文案
  try {
    const resp = await sendToTab({ action: 'DETECT_LANG' });
    pageLang = (resp && resp.lang) || null;
  } catch { pageLang = null; }
  const siteBox = document.getElementById('alwaysSite');
  if (!currentHost) {
    siteBox.disabled = true;
  } else {
    siteBox.checked = alwaysSites.includes(currentHost);
  }
  applyI18n(uiLang);

  // 所有设置即时保存：自动翻译与悬停翻译直接读取存储，不依赖点击翻译按钮
  // （三个下拉为自定义组件，选中时自行调用 saveConfig）
  for (const id of ['baseUrl', 'apiKey', 'explainTerms', 'hoverCtrl', 'autoEnglish']) {
    document.getElementById(id).addEventListener('change', saveConfig);
  }
  siteBox.addEventListener('change', saveAlwaysSites);

  // 模型状态点与抽屉入口
  updateModelRow();
  for (const id of ['baseUrl', 'apiKey']) {
    document.getElementById(id).addEventListener('input', updateModelRow);
  }
  document.getElementById('settingsBtn').addEventListener('click', toggleDrawer);
  document.getElementById('apiCard').addEventListener('click', toggleDrawer);
  document.getElementById('modelAddBtn').addEventListener('click', addManualModel);
  document.getElementById('modelAddInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addManualModel(); }
  });
  document.getElementById('apiDrawer').addEventListener('toggle', () => {
    const open = document.getElementById('apiDrawer').open;
    document.getElementById('apiCard').classList.toggle('open', open);
    if (open) loadModels(); // 展开抽屉时自动拉取可用模型
  });

  // 地址或密钥变更（失焦/回车确认）后重新拉取模型列表
  for (const id of ['baseUrl', 'apiKey']) {
    document.getElementById(id).addEventListener('change', () => loadModels());
  }
  // 填入 API 后首次自动获取：输入停顿 800ms 即拉取，无需点击「获取」
  let autoFetchTimer = null;
  for (const id of ['baseUrl', 'apiKey']) {
    document.getElementById(id).addEventListener('input', () => {
      clearTimeout(autoFetchTimer);
      autoFetchTimer = setTimeout(() => loadModels(), 800);
    });
  }
  document.getElementById('refreshModels').addEventListener('click', () => loadModels(true));

  // 已配置密钥（或本机服务）时打开弹窗即拉取列表，遗留的无效模型无需展开抽屉即可被清理
  if (data.apiKey || /localhost|127\.0\.0\.1/.test(data.baseUrl || DEFAULTS.baseUrl)) loadModels();
});

// ===== 模型列表自动获取 =====
let modelReqToken = 0;
let modelsLoadedFor = ''; // 已成功加载过列表的 地址+密钥 组合，避免重复请求

// 提示按 key+参数 记录，切换界面语言时可原样重译
let modelHintState = { key: 'hintDefault', params: {}, isError: false };

function setModelHint(key, params = {}, isError = false) {
  modelHintState = { key, params, isError };
  renderModelHint();
}

function renderModelHint() {
  const hint = document.getElementById('modelHint');
  hint.textContent = t(uiLang, modelHintState.key, modelHintState.params);
  hint.classList.toggle('error', modelHintState.isError);
}

async function loadModels(force = false) {
  const baseUrl = document.getElementById('baseUrl').value.trim().replace(/\/+$/, '');
  const apiKey = document.getElementById('apiKey').value.trim();
  const btn = document.getElementById('refreshModels');
  const combo = `${baseUrl}\n${apiKey}`;

  if (!baseUrl) {
    setModelHint('hintNeedUrl');
    return;
  }
  // 未配密钥且非本机服务时不发请求（首次安装的默认地址必然 401）
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) {
    setModelHint('hintNeedKey');
    return;
  }
  if (!force && modelsLoadedFor === combo) return;

  const token = ++modelReqToken;
  btn.disabled = true;
  btn.classList.add('spinning');
  setModelHint('hintLoading');
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'LIST_MODELS', config: { baseUrl, apiKey } });
    if (token !== modelReqToken) return; // 已有更新的请求，丢弃过期结果
    if (!resp || !resp.success) throw new Error((resp && resp.error) || '后台无响应');

    fetchedModels = resp.models;
    // 获取成功后以 API 列表为准：自动取消勾选 API 未提供的模型（如默认的 gpt-4o-mini），
    // 仅保留手动添加的模型，避免下拉继续选用 API 无法服务的模型
    const removed = enabledModels.filter(id => !fetchedModels.includes(id) && !manualModels.includes(id));
    if (removed.length > 0) {
      enabledModels = enabledModels.filter(id => !removed.includes(id));
      await chrome.storage.local.set({ enabledModels });
      renderModelDrop();
      await saveConfig(); // 当前模型被移除时下拉已回退，把新选择写回存储
      setModelHint('hintPruned', { count: resp.models.length, ids: removed.join(', ') });
    } else {
      setModelHint('hintLoaded', { count: resp.models.length });
    }
    renderModelList();
    modelsLoadedFor = combo;
  } catch (err) {
    if (token !== modelReqToken) return;
    setModelHint('hintFailed', { error: err.message }, true);
  } finally {
    if (token === modelReqToken) {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }
}

// 模型行状态点：口径同 content.js autoConfigReady（已配密钥或本机服务）
function updateModelRow() {
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  document.getElementById('modelDot').classList.toggle('ready', !!(apiKey || /localhost|127\.0\.0\.1/.test(baseUrl)));
}

// ===== 自定义下拉 =====
// 原生 select 的弹出层由系统渲染、无法用 CSS 统一风格，故三个下拉均用自定义面板
const drops = {}; // id -> { items, value, onChange }

function setupDrop(id, items, onChange) {
  drops[id] = { items: [], value: '', onChange };
  document.getElementById(id).addEventListener('click', () => toggleDrop(id));
  setDropItems(id, items);
}

function setDropItems(id, items) {
  const state = drops[id];
  state.items = items;
  const panel = document.getElementById(id + 'Drop');
  panel.textContent = '';
  for (const item of items) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'drop-item';
    opt.setAttribute('role', 'option');
    opt.dataset.value = item.value;
    if (item.title) opt.title = item.title;
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'check');
    check.setAttribute('viewBox', '0 0 24 24');
    check.setAttribute('fill', 'none');
    check.setAttribute('stroke', 'currentColor');
    check.setAttribute('stroke-width', '2.5');
    check.setAttribute('stroke-linecap', 'round');
    check.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 6 9 17l-5-5');
    check.appendChild(path);
    const text = document.createElement('span');
    text.className = 'drop-item-text';
    text.textContent = item.label;
    opt.append(check, text);
    opt.addEventListener('click', () => {
      setVal(id, item.value);
      closeAllDrops();
      if (state.onChange) state.onChange(item.value);
    });
    panel.appendChild(opt);
  }
  // 当前值不在新列表中时回退到第一项
  if (!items.some(i => i.value === state.value)) state.value = items[0] ? items[0].value : '';
  syncDrop(id);
}

// 同步胶囊显示文本与面板选中态
function syncDrop(id) {
  const state = drops[id];
  const btn = document.getElementById(id);
  const current = state.items.find(i => i.value === state.value);
  btn.textContent = current ? current.label : (btn.dataset.placeholder || '');
  document.getElementById(id + 'Drop').querySelectorAll('.drop-item').forEach(el => {
    const selected = el.dataset.value === state.value;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-selected', String(selected));
  });
}

function getVal(id) { return drops[id].value; }

function setVal(id, value) {
  const state = drops[id];
  if (state.items.some(i => i.value === value)) state.value = value;
  syncDrop(id);
}

function toggleDrop(id) {
  const panel = document.getElementById(id + 'Drop');
  const willOpen = panel.hidden;
  closeAllDrops();
  if (willOpen) {
    panel.hidden = false;
    document.getElementById(id).closest('.pill').classList.add('open');
    const selected = panel.querySelector('.drop-item.selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }
}

function closeAllDrops() {
  for (const id of Object.keys(drops)) {
    document.getElementById(id + 'Drop').hidden = true;
    document.getElementById(id).closest('.pill').classList.remove('open');
  }
}

// 点击面板与胶囊之外、或按 Escape 时收起
document.addEventListener('click', e => {
  if (!e.target.closest('.pill')) closeAllDrops();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllDrops();
});

// ===== 模型勾选与下拉联动 =====

// 勾选列表：API 列表 + 不在其中的手动添加模型与遗留勾选（尚未成功获取列表时），
// 保证它们都有复选框可取消勾选；获取成功后遗留的非手动模型已由 loadModels 自动移除
function renderModelList() {
  const box = document.getElementById('modelList');
  box.textContent = '';
  const extras = [...new Set([...enabledModels, ...manualModels])].filter(id => !fetchedModels.includes(id));
  const ids = [...extras, ...fetchedModels];
  if (ids.length === 0) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const id of ids) {
    const label = document.createElement('label');
    label.className = 'model-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = enabledModels.includes(id);
    cb.addEventListener('change', () => toggleModel(id, cb.checked));
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = id;
    name.title = id;
    label.append(cb, name);
    box.appendChild(label);
  }
}

// 「翻译模型」下拉：只列勾选启用的模型
function renderModelDrop() {
  setDropItems('model', enabledModels.map(id => ({ value: id, label: id })));
}

async function toggleModel(id, checked) {
  const set = new Set(enabledModels);
  if (checked) set.add(id); else set.delete(id);
  enabledModels = [...set];
  await chrome.storage.local.set({ enabledModels });
  const wasCurrent = getVal('model') === id;
  renderModelDrop();
  // 取消勾选的恰是当前使用的模型时，自动切换到列表中的第一个
  if (!checked && wasCurrent) await saveConfig();
}

// 手动添加：兼容不支持 /models 的接口，或列表未收录的模型名
async function addManualModel() {
  const input = document.getElementById('modelAddInput');
  const id = input.value.trim();
  if (!id) return;
  if (!enabledModels.includes(id)) enabledModels = [...enabledModels, id];
  if (!manualModels.includes(id)) manualModels = [...manualModels, id];
  await chrome.storage.local.set({ enabledModels, manualModels });
  if (!fetchedModels.includes(id)) fetchedModels = [...fetchedModels, id];
  renderModelList(); // 手动添加的模型也出现在列表中，保持勾选状态一致
  renderModelDrop();
  setVal('model', id);
  await saveConfig();
  input.value = '';
  setModelHint('hintAdded', { id });
}

function toggleDrawer() {
  const drawer = document.getElementById('apiDrawer');
  drawer.open = !drawer.open;
}

async function saveConfig() {
  const config = {
    baseUrl: document.getElementById('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: document.getElementById('apiKey').value.trim(),
    model: getVal('model'),
    targetLang: getVal('targetLang'),
    styleMode: getVal('styleMode'),
    explainTerms: document.getElementById('explainTerms').checked,
    hoverCtrl: document.getElementById('hoverCtrl').checked,
    autoEnglish: document.getElementById('autoEnglish').checked
  };
  await chrome.storage.local.set(config);
  return config;
}

async function saveAlwaysSites() {
  if (!currentHost) return;
  const sites = new Set(alwaysSites);
  if (document.getElementById('alwaysSite').checked) {
    sites.add(currentHost);
  } else {
    sites.delete(currentHost);
  }
  alwaysSites = [...sites];
  await chrome.storage.local.set({ alwaysSites });
}

// 向当前标签页的 content script 发消息；失败时给出明确提示而不是静默关窗
async function sendToTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error(t(uiLang, 'errNoTab'));
  await chrome.tabs.sendMessage(tab.id, message);
}

document.getElementById('translateBtn').addEventListener('click', async () => {
  const config = await saveConfig();
  if (!config.baseUrl || !config.model) {
    alert(t(uiLang, 'alertConfig'));
    return;
  }
  try {
    await sendToTab({ action: 'START_TRANSLATE', config });
    window.close();
  } catch (err) {
    alert(t(uiLang, 'errConnect', { error: err.message }));
  }
});

document.getElementById('restoreBtn').addEventListener('click', async () => {
  try {
    await sendToTab({ action: 'RESTORE_ORIGINAL' });
    window.close();
  } catch (err) {
    alert(t(uiLang, 'errRestore', { error: err.message }));
  }
});

// ===== 分享：复制 Chrome 商店链接 =====
const STORE_URL = 'https://chromewebstore.google.com/detail/oiheeklecbofdocnfdbellakbpiphijp';

document.getElementById('shareBtn').addEventListener('click', async () => {
  let ok = false;
  try { await navigator.clipboard.writeText(STORE_URL); ok = true; }
  catch { ok = legacyCopy(STORE_URL); }
  showPopupToast(ok ? t(uiLang, 'shareCopied') : t(uiLang, 'shareFailed', { url: STORE_URL }), !ok);
});

// 剪贴板 API 不可用时的兜底：隐藏 textarea + execCommand
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 忽略，走失败提示 */ }
  ta.remove();
  return ok;
}

let popupToastTimer = null;
function showPopupToast(msg, isError = false) {
  const toast = document.getElementById('popupToast');
  document.getElementById('popupToastText').textContent = msg;
  const dot = toast.querySelector('.dot');
  dot.classList.toggle('ready', !isError);
  dot.classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(popupToastTimer);
  popupToastTimer = setTimeout(() => { toast.hidden = true; }, 2500);
}