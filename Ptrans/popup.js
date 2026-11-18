// popup.js
const CONFIG_FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang', 'styleMode', 'explainTerms', 'hoverCtrl', 'autoEnglish'];
const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  targetLang: '简体中文',
  styleMode: 'balanced'
};

let currentHost = '';
let alwaysSites = [];

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get([...CONFIG_FIELDS, 'alwaysSites']);
  document.getElementById('baseUrl').value = data.baseUrl || DEFAULTS.baseUrl;
  document.getElementById('apiKey').value = data.apiKey || '';
  document.getElementById('model').value = data.model || DEFAULTS.model;
  document.getElementById('targetLang').value = data.targetLang || DEFAULTS.targetLang;
  document.getElementById('styleMode').value = data.styleMode || DEFAULTS.styleMode;
  document.getElementById('explainTerms').checked = !!data.explainTerms;
  document.getElementById('hoverCtrl').checked = !!data.hoverCtrl;
  document.getElementById('autoEnglish').checked = !!data.autoEnglish;

  // 首次使用时把默认值写入存储，供内容脚本的自动翻译读取
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (data[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length > 0) await chrome.storage.local.set(missing);

  // 未配置密钥时展开 API 抽屉，引导首次填写
  if (!data.apiKey) document.getElementById('apiDrawer').open = true;

  // 「始终翻译此网站」按当前标签页的站点记忆
  alwaysSites = Array.isArray(data.alwaysSites) ? data.alwaysSites : [];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { currentHost = tab && tab.url ? new URL(tab.url).hostname : ''; } catch { currentHost = ''; }
  const siteBox = document.getElementById('alwaysSite');
  const siteHost = document.getElementById('siteHost');
  if (!currentHost) {
    siteBox.disabled = true;
    siteHost.textContent = '（当前页面不支持）';
  } else {
    siteHost.textContent = `（${currentHost}）`;
    siteBox.checked = alwaysSites.includes(currentHost);
  }

  // 所有设置即时保存：自动翻译与悬停翻译直接读取存储，不依赖点击翻译按钮
  for (const id of CONFIG_FIELDS) {
    document.getElementById(id).addEventListener('change', saveConfig);
  }
  siteBox.addEventListener('change', saveAlwaysSites);

  // 模型胶囊行与抽屉入口
  updateModelRow();
  for (const id of ['baseUrl', 'apiKey', 'model']) {
    document.getElementById(id).addEventListener('input', updateModelRow);
  }
  document.getElementById('settingsBtn').addEventListener('click', toggleDrawer);
  document.getElementById('apiCard').addEventListener('click', toggleDrawer);
  document.getElementById('modelRow').addEventListener('click', () => {
    document.getElementById('apiDrawer').open = true;
    document.getElementById('model').focus();
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
  document.getElementById('refreshModels').addEventListener('click', () => loadModels(true));
});

// ===== 模型列表自动获取 =====
let modelReqToken = 0;
let modelsLoadedFor = ''; // 已成功加载过列表的 地址+密钥 组合，避免重复请求

function setModelHint(text, isError = false) {
  const hint = document.getElementById('modelHint');
  hint.textContent = text;
  hint.classList.toggle('error', isError);
}

async function loadModels(force = false) {
  const baseUrl = document.getElementById('baseUrl').value.trim().replace(/\/+$/, '');
  const apiKey = document.getElementById('apiKey').value.trim();
  const btn = document.getElementById('refreshModels');
  const combo = `${baseUrl}\n${apiKey}`;

  if (!baseUrl) {
    setModelHint('填写 API Base URL 后自动获取可用模型');
    return;
  }
  // 未配密钥且非本机服务时不发请求（首次安装的默认地址必然 401）
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) {
    setModelHint('填写 API Key 后自动获取可用模型（本机服务无需密钥）');
    return;
  }
  if (!force && modelsLoadedFor === combo) return;

  const token = ++modelReqToken;
  btn.disabled = true;
  btn.classList.add('spinning');
  setModelHint('正在获取模型列表…');
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'LIST_MODELS', config: { baseUrl, apiKey } });
    if (token !== modelReqToken) return; // 已有更新的请求，丢弃过期结果
    if (!resp || !resp.success) throw new Error((resp && resp.error) || '后台无响应');

    const list = document.getElementById('modelOptions');
    list.textContent = '';
    for (const id of resp.models) {
      const opt = document.createElement('option');
      opt.value = id;
      list.appendChild(opt);
    }
    modelsLoadedFor = combo;
    setModelHint(`已获取 ${resp.models.length} 个模型，点击输入框选择，也可手动输入`);
  } catch (err) {
    if (token !== modelReqToken) return;
    setModelHint(`获取失败：${err.message}。仍可手动输入模型名称`, true);
  } finally {
    if (token === modelReqToken) {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  }
}

// 模型行：实时显示模型名；状态点口径同 content.js autoConfigReady（已配密钥或本机服务）
function updateModelRow() {
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value.trim();
  document.getElementById('modelValue').textContent = model || DEFAULTS.model;
  document.getElementById('modelDot').classList.toggle('ready', !!(apiKey || /localhost|127\.0\.0\.1/.test(baseUrl)));
}

function toggleDrawer() {
  const drawer = document.getElementById('apiDrawer');
  drawer.open = !drawer.open;
}

async function saveConfig() {
  const config = {
    baseUrl: document.getElementById('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: document.getElementById('apiKey').value.trim(),
    model: document.getElementById('model').value.trim(),
    targetLang: document.getElementById('targetLang').value,
    styleMode: document.getElementById('styleMode').value,
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
  if (!tab || !tab.id) throw new Error('找不到当前标签页');
  await chrome.tabs.sendMessage(tab.id, message);
}

document.getElementById('translateBtn').addEventListener('click', async () => {
  const config = await saveConfig();
  if (!config.baseUrl || !config.model) {
    alert('请先在「API 设置」中填写 API Base URL 和模型名称。');
    return;
  }
  try {
    await sendToTab({ action: 'START_TRANSLATE', config });
    window.close();
  } catch (err) {
    alert('无法连接页面中的翻译脚本：\n' + err.message +
      '\n\n请先刷新目标网页后再点翻译。（扩展安装/更新后，已打开的页面必须刷新才会注入脚本；chrome:// 与商店页面无法翻译。）');
  }
});

document.getElementById('restoreBtn').addEventListener('click', async () => {
  try {
    await sendToTab({ action: 'RESTORE_ORIGINAL' });
    window.close();
  } catch (err) {
    alert('无法连接页面中的翻译脚本，请先刷新目标网页。\n' + err.message);
  }
});