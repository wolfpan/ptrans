// content.js
const originalTextMap = new WeakMap();
const translatedNodes = new Set();
const inFlightNodes = new WeakSet(); // 正在请求中的节点，避免悬停翻译与整页翻译重复请求

const IGNORE_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
  'CODE', 'PRE', 'SVG', 'MATH', 'TEXTAREA', 'INPUT'
]);

// ===== 设置读取 =====
const SETTINGS_KEYS = [
  'baseUrl', 'apiKey', 'model', 'targetLang', 'styleMode', 'explainTerms',
  'hoverCtrl', 'autoEnglish', 'alwaysSites'
];
let settings = {};
let pageTranslating = false;
let autoDone = false; // 本次页面加载已触发过自动翻译，避免重复

function getConfig() {
  return {
    baseUrl: settings.baseUrl || 'https://api.openai.com/v1',
    apiKey: settings.apiKey || '',
    model: settings.model || 'gpt-4o-mini',
    targetLang: settings.targetLang || '简体中文',
    styleMode: settings.styleMode || 'balanced',
    explainTerms: !!settings.explainTerms
  };
}

// 手动翻译的最低配置要求（与弹窗校验一致）
function configReady() {
  return !!(settings.baseUrl && settings.model);
}

// 自动翻译更严格：必须真正配置过密钥（本地服务除外），
// 防止首次安装只有默认值时就向 API 发起无效请求
function autoConfigReady() {
  if (!configReady()) return false;
  return !!settings.apiKey || /localhost|127\.0\.0\.1/.test(settings.baseUrl);
}

// 页面右上角提示条：让失败/完成对用户可见，而不是静默无响应
// 白色圆角卡片 + 彩色状态点，与弹窗设计语言一致
let toastEl = null;
function showToast(msg, isError = true) {
  if (toastEl) toastEl.remove();
  toastEl = document.createElement('div');
  toastEl.setAttribute('data-ptrans-ui', '');
  toastEl.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:380px;' +
    'display:flex;align-items:flex-start;gap:8px;padding:10px 14px;' +
    'background:#fff;color:#111827;font:13px/1.6 system-ui,sans-serif;' +
    'border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 8px 24px rgba(17,24,39,.12);';
  const dot = document.createElement('span');
  dot.style.cssText = 'flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px;' +
    (isError ? 'background:#dc2626;' : 'background:#16a34a;');
  const text = document.createElement('span');
  text.style.cssText = 'white-space:pre-wrap;';
  text.textContent = msg;
  toastEl.append(dot, text);
  document.documentElement.appendChild(toastEl);
  setTimeout(() => { if (toastEl) { toastEl.remove(); toastEl = null; } }, 10000);
}

// 向后台发消息；对“连接建立失败/上下文失效”做有限重试（worker 唤醒慢或扩展刚重载时会遇到）
async function sendToBackground(message, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      const retryable = /Receiving end does not exist|Extension context invalidated|message port closed/i.test(err?.message || '');
      if (!retryable || attempt >= retries) throw err;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

// 提取页面内所有有效文本节点
function getTranslatableTextNodes(root = document.body) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || IGNORE_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;

      const text = node.nodeValue.trim();
      // 过滤空字符、纯数字或纯符号
      if (!text || /^[\d\s\p{P}]+$/u.test(text)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  return nodes;
}

// 批量分块翻译并原地替换（整页与悬停翻译共用）
async function translateNodes(allNodes, config) {
  const BATCH_SIZE = 20; // 每批打包 20 个文本节点
  const CONCURRENCY = 3; // 最大并发请求数

  const batches = [];
  for (let i = 0; i < allNodes.length; i += BATCH_SIZE) {
    batches.push(allNodes.slice(i, i + BATCH_SIZE));
  }

  let index = 0;
  let doneCount = 0;
  let firstError = null;
  async function worker() {
    while (index < batches.length) {
      const batch = batches[index++];
      const payload = {};

      batch.forEach((node, idx) => {
        if (!originalTextMap.has(node)) {
          originalTextMap.set(node, node.nodeValue);
        }
        payload[idx] = originalTextMap.get(node).trim();
        inFlightNodes.add(node);
      });

      try {
        const response = await sendToBackground({
          action: 'TRANSLATE_BATCH',
          payload,
          config
        });

        if (response && response.success && response.data) {
          batch.forEach((node, idx) => {
            if (response.data[idx]) {
              // 保留原有的首尾空白符结构，仅替换核心文字
              const raw = originalTextMap.get(node);
              const leadingSpace = raw.match(/^\s*/)[0];
              const trailingSpace = raw.match(/\s*$/)[0];
              node.nodeValue = leadingSpace + response.data[idx] + trailingSpace;
              translatedNodes.add(node);
            }
          });
        } else {
          firstError = firstError || (response && response.error) || '后台返回异常';
          console.error('[ptrans] batch failed:', response && response.error);
        }
      } catch (err) {
        firstError = firstError || err.message;
        console.error('[ptrans] batch error:', err);
      } finally {
        batch.forEach(node => inFlightNodes.delete(node));
        doneCount++;
      }
    }
  }

  // 启动并发队列
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  return { batches, doneCount, firstError };
}

async function translatePage(config) {
  if (pageTranslating) {
    showToast('整页翻译正在进行中，请稍候。');
    return;
  }
  const allNodes = getTranslatableTextNodes();
  if (allNodes.length === 0) {
    showToast('未找到可翻译的文本节点。', true);
    return;
  }

  pageTranslating = true;
  try {
    const { batches, doneCount, firstError } = await translateNodes(allNodes, config);
    if (firstError) {
      showToast(`翻译失败：${firstError}\n（已完成 ${doneCount}/${batches.length} 批）`, true);
    } else {
      showToast(`翻译完成：${translatedNodes.size} 段文本`, false);
    }
  } finally {
    pageTranslating = false;
  }
}

// 一键还原原文
function restorePage() {
  translatedNodes.forEach(node => {
    if (originalTextMap.has(node)) {
      node.nodeValue = originalTextMap.get(node);
    }
  });
  translatedNodes.clear();
  showToast('已还原原文', false);
}

// ===== 自动翻译（始终翻译本站 / 英文页面） =====

// 启发式判定英文页面：采样文本节点，拉丁字母占绝对多数且总量足够
function looksEnglish() {
  const nodes = getTranslatableTextNodes();
  let sample = '';
  for (const node of nodes) {
    sample += node.nodeValue + ' ';
    if (sample.length > 4000) break;
  }
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  const cjk = (sample.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  return latin > 200 && latin / (latin + cjk) > 0.8;
}

function tryAutoTranslate() {
  if (autoDone || pageTranslating || translatedNodes.size > 0) return;
  if (!autoConfigReady()) return;
  const bySite = (settings.alwaysSites || []).includes(location.hostname);
  const byLang = settings.autoEnglish && settings.targetLang !== 'English' && looksEnglish();
  if (bySite || byLang) {
    autoDone = true;
    translatePage(getConfig());
  }
}

// 设置变更即时生效：悬停模式热切换；刚开启的自动翻译立即作用于当前页
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const prevSites = settings.alwaysSites || [];
  const prevAutoEnglish = !!settings.autoEnglish;
  for (const [key, { newValue }] of Object.entries(changes)) {
    settings[key] = newValue;
  }
  if (changes.hoverCtrl) applyHoverMode();
  if (!autoConfigReady() || pageTranslating || translatedNodes.size > 0) return;

  const host = location.hostname;
  const sites = settings.alwaysSites || [];
  const siteJustEnabled = sites.includes(host) && !prevSites.includes(host);
  const englishJustEnabled = settings.autoEnglish && !prevAutoEnglish &&
    settings.targetLang !== 'English' && looksEnglish();
  if (siteJustEnabled || englishJustEnabled) {
    autoDone = true;
    translatePage(getConfig());
  }
});

// ===== 悬停 + Ctrl 翻译 =====
const HOVER_MAX_CHARS = 5000; // 过大的容器不视为段落，避免误翻整块区域
const HOVER_DEBOUNCE_MS = 250;
let hoverEnabled = false;
let ctrlHeld = false;
let hoverBlock = null;
let hoverTimer = null;
let hoverStyleEl = null;
let lastHoverTarget = null;
const hoverBusy = new WeakSet();

function ensureHoverStyle() {
  if (hoverStyleEl) return;
  hoverStyleEl = document.createElement('style');
  hoverStyleEl.setAttribute('data-ptrans-ui', '');
  hoverStyleEl.textContent =
    '[data-ptrans-aim]{outline:2px solid rgba(37,99,235,.55)!important;outline-offset:2px;}' +
    '[data-ptrans-hover]{outline:2px dashed #2563eb!important;outline-offset:2px;}';
  document.documentElement.appendChild(hoverStyleEl);
}

// 从悬停元素向上找到最近的、含可翻译文本且体量合理的块
function findHoverBlock(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.closest('[data-ptrans-ui]')) return null;
  let node = el;
  while (node && node !== document.body && node !== document.documentElement) {
    if (!IGNORE_TAGS.has(node.tagName) && !node.isContentEditable) {
      const len = (node.textContent || '').trim().length;
      if (len > 0 && len <= HOVER_MAX_CHARS && getTranslatableTextNodes(node).length > 0) {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function updateAim() {
  document.querySelectorAll('[data-ptrans-aim]').forEach(el => el.removeAttribute('data-ptrans-aim'));
  if (ctrlHeld && hoverBlock) hoverBlock.setAttribute('data-ptrans-aim', '');
}

function clearHoverState() {
  ctrlHeld = false;
  clearTimeout(hoverTimer);
  hoverTimer = null;
  document.querySelectorAll('[data-ptrans-aim]').forEach(el => el.removeAttribute('data-ptrans-aim'));
}

function scheduleHoverTranslate() {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (ctrlHeld && hoverBlock) translateHoverBlock(hoverBlock);
  }, HOVER_DEBOUNCE_MS);
}

async function translateHoverBlock(block) {
  if (hoverBusy.has(block)) return;
  // 焦点在输入控件时不触发，避免与 Ctrl+A / Ctrl+C 等编辑操作互相干扰
  const active = document.activeElement;
  if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;

  const nodes = getTranslatableTextNodes(block)
    .filter(node => !translatedNodes.has(node) && !inFlightNodes.has(node));
  if (nodes.length === 0) return;
  if (!configReady()) {
    showToast('请先在扩展弹窗的「API 设置」中填写服务地址与模型名称。', true);
    return;
  }

  hoverBusy.add(block);
  block.setAttribute('data-ptrans-hover', '');
  try {
    const { firstError } = await translateNodes(nodes, getConfig());
    if (firstError) showToast(`悬停翻译失败：${firstError}`, true);
  } finally {
    hoverBusy.delete(block);
    block.removeAttribute('data-ptrans-hover');
  }
}

function onHoverMouseMove(e) {
  if (e.target === lastHoverTarget) return;
  lastHoverTarget = e.target;
  hoverBlock = findHoverBlock(e.target);
  updateAim();
  if (ctrlHeld) scheduleHoverTranslate();
}

function onHoverKeyDown(e) {
  if (e.key !== 'Control' || e.repeat) return;
  ctrlHeld = true;
  updateAim();
  scheduleHoverTranslate();
}

function onHoverKeyUp(e) {
  if (e.key !== 'Control') return;
  clearHoverState();
}

function applyHoverMode() {
  const enable = !!settings.hoverCtrl;
  if (enable === hoverEnabled) return;
  hoverEnabled = enable;
  if (enable) {
    ensureHoverStyle();
    document.addEventListener('mousemove', onHoverMouseMove, true);
    document.addEventListener('keydown', onHoverKeyDown, true);
    document.addEventListener('keyup', onHoverKeyUp, true);
    window.addEventListener('blur', clearHoverState);
  } else {
    document.removeEventListener('mousemove', onHoverMouseMove, true);
    document.removeEventListener('keydown', onHoverKeyDown, true);
    document.removeEventListener('keyup', onHoverKeyUp, true);
    window.removeEventListener('blur', clearHoverState);
    clearHoverState();
    hoverBlock = null;
    lastHoverTarget = null;
    if (hoverStyleEl) { hoverStyleEl.remove(); hoverStyleEl = null; }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'START_TRANSLATE') {
    translatePage(msg.config);
  } else if (msg.action === 'RESTORE_ORIGINAL') {
    restorePage();
  }
});

// ===== 初始化 =====
(async () => {
  settings = await chrome.storage.local.get(SETTINGS_KEYS);
  applyHoverMode();
  tryAutoTranslate();
})();