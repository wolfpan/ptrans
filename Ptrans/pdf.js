// pdf.js — PDF 文档翻译页：PDF.js 提取文本层 → 复用后台 TRANSLATE_BATCH 管线 → 双语对照渲染。
// 与网页翻译共享同一套存储配置（API / 目标语言 / 风格 / 术语解释）。
import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const SETTINGS_KEYS = ['baseUrl', 'apiKey', 'model', 'targetLang', 'styleMode', 'explainTerms'];
let settings = {};
let uiLang = '简体中文';

let blocks = [];        // { page, text, transEl, done }
let translating = false;
let parsing = false;    // 文本层解析中（与 translating 一起构成「进行中」状态）
let parseProgress = null; // { page, total }，供弹窗查询进度
let loadedName = '';
let pdfDoc = null;      // 文档保持存活，供「原页对照」懒渲染整页原图
let docGen = 0;         // 文档世代令牌：换文件后丢弃跨世代的渲染结果
let pageObserver = null;
const renderQueue = [];
const renderedPages = new Set();
let rendering = false;

function tt(key, params) {
  return t(uiLang, key, params);
}

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

// 与 content.js configReady 同口径：存储里真正配置过才发请求
function configReady() {
  return !!(settings.baseUrl && settings.model);
}

function applyI18n() {
  document.documentElement.lang = LANG_TAGS[uiLang] || 'en';
  document.documentElement.dir = uiLang === 'العربية' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(uiLang, el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(uiLang, el.dataset.i18nPlaceholder);
  document.title = t(uiLang, 'pdfTitle');
  renderSettingsHint();
}

function renderSettingsHint() {
  const lang = settings.targetLang || '简体中文';
  const model = settings.model || '—';
  document.getElementById('settingsHint').textContent = `${lang} · ${model}`;
}

// ===== 提示条 =====
let toastTimer = null;
function showToast(msg, isError = true) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = msg;
  document.getElementById('toastDot').classList.toggle('error', isError);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 10000);
}

// ===== 状态条 =====
// progress 为 0~1 的进度（解析按页、翻译按段）；null 时隐藏进度条（完成/出错）
function setStatus(text, { spinning = true, progress = null } = {}) {
  const bar = document.getElementById('statusBar');
  bar.hidden = false;
  document.getElementById('statusSpinner').hidden = !spinning;
  document.getElementById('statusDot').hidden = spinning;
  document.getElementById('statusText').textContent = text;
  const track = document.getElementById('statusProgress');
  if (progress === null) {
    track.hidden = true;
  } else {
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    track.hidden = false;
    document.getElementById('statusProgressFill').style.width = pct + '%';
    track.setAttribute('aria-valuenow', String(pct));
  }
}

function hideStatus() {
  document.getElementById('statusBar').hidden = true;
}

// 向后台发消息；与 content.js 相同的有限重试（worker 唤醒慢时会遇到）
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

// ===== 文本层提取：items → 行 → 段落块 =====

// 同一行的 items 按 x 排序拼接；间隙超过阈值补空格（PDF 常把词拆成多个 item）
function joinLine(items) {
  items.sort((a, b) => a.transform[4] - b.transform[4]);
  let text = '';
  let prevEnd = null;
  let prevH = 10;
  for (const it of items) {
    if (prevEnd !== null) {
      const gap = it.transform[4] - prevEnd;
      if (gap > 0.25 * prevH && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
    }
    text += it.str;
    prevEnd = it.transform[4] + (it.width || 0);
    prevH = it.height || prevH;
  }
  return text.trim();
}

function extractBlocks(items, page) {
  const its = items.filter(it => it.str && it.str.trim());
  if (its.length === 0) return [];

  // 按 y 聚行（PDF 坐标自下而上，先按 y 降序即自上而下）
  its.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const lines = [];
  for (const it of its) {
    const y = it.transform[5];
    const h = it.height || Math.hypot(it.transform[2], it.transform[3]) || 10;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= Math.max(2, h * 0.35)) {
      last.items.push(it);
    } else {
      lines.push({ y, h, items: [it] });
    }
  }
  for (const line of lines) {
    line.text = joinLine(line.items);
    line.h = Math.max(...line.items.map(it => it.height || 10));
  }
  const usable = lines.filter(l => l.text);
  if (usable.length === 0) return [];

  // 行 → 段落：行距明显拉大（超过 1.6 倍字高）视为分段；超长块强制切分，控制单批体量
  const heights = usable.map(l => l.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;
  const out = [];
  let cur = '';
  let prevY = null;
  const flush = () => {
    const text = cur.trim();
    // 过滤纯数字/符号（页码、分隔线等），口径同 content.js
    if (text && !/^[\d\s\p{P}]+$/u.test(text)) out.push({ page, text });
    cur = '';
  };
  for (const line of usable) {
    if (prevY !== null && (prevY - line.y > medianH * 1.6 || cur.length > 1500)) flush();
    cur += (cur ? ' ' : '') + line.text;
    prevY = line.y;
  }
  flush();
  return out;
}

// ===== 渲染 =====

function renderDoc() {
  const doc = document.getElementById('doc');
  doc.textContent = '';
  let pageEl = null;
  let pageNum = 0;
  for (const block of blocks) {
    if (block.page !== pageNum) {
      pageNum = block.page;
      pageEl = document.createElement('section');
      pageEl.className = 'page';
      const head = document.createElement('h2');
      head.className = 'page-head';
      head.textContent = tt('pdfPage', { n: pageNum });
      pageEl.appendChild(head);
      const cols = document.createElement('div');
      cols.className = 'cols-head';
      const colOrig = document.createElement('span');
      colOrig.className = 'col-orig';
      colOrig.dataset.i18n = 'pdfColOrig';
      colOrig.textContent = tt('pdfColOrig');
      const colPage = document.createElement('span');
      colPage.className = 'col-page';
      colPage.dataset.i18n = 'pdfColPage';
      colPage.textContent = tt('pdfColPage');
      const colTrans = document.createElement('span');
      colTrans.className = 'col-trans';
      colTrans.dataset.i18n = 'pdfColTrans';
      colTrans.textContent = tt('pdfColTrans');
      cols.append(colOrig, colPage, colTrans);
      pageEl.appendChild(cols);
      // page-body：默认普通流（双语/仅译文）；原页对照时为「整页原图 | 译文」两栏
      const body = document.createElement('div');
      body.className = 'page-body';
      const img = document.createElement('div');
      img.className = 'page-img';
      const spin = document.createElement('span');
      spin.className = 'spinner';
      img.appendChild(spin);
      const blocksWrap = document.createElement('div');
      blocksWrap.className = 'blocks';
      body.append(img, blocksWrap);
      pageEl.appendChild(body);
      pageEl.dataset.page = pageNum;
      doc.appendChild(pageEl);
    }
    const wrap = document.createElement('div');
    wrap.className = 'block';
    const orig = document.createElement('p');
    orig.className = 'orig';
    orig.textContent = block.text;
    const trans = document.createElement('p');
    trans.className = 'trans pending';
    trans.textContent = '…';
    wrap.append(orig, trans);
    pageEl.querySelector('.blocks').appendChild(wrap);
    block.transEl = trans;
    block.done = false;
  }
}

// ===== 翻译：分批并发，口径与 content.js translateNodes 一致 =====

async function translateAll() {
  if (translating) return;
  if (!configReady()) {
    showToast(tt('toastNeedConfig'), true);
    return;
  }
  const pending = blocks.filter(b => !b.done);
  if (pending.length === 0) return;

  translating = true;
  document.getElementById('retranslateBtn').disabled = true;
  const config = getConfig();
  const BATCH_SIZE = 20;
  const CONCURRENCY = 3;

  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  let index = 0;
  let doneBatches = 0;
  let doneBlocks = blocks.filter(b => b.done).length;
  let firstError = null;

  setStatus(tt('pdfTranslating', { done: doneBlocks, total: blocks.length }), { progress: doneBlocks / blocks.length });

  async function worker() {
    while (index < batches.length) {
      const batch = batches[index++];
      const payload = {};
      batch.forEach((block, idx) => { payload[idx] = block.text; });
      try {
        const response = await sendToBackground({ action: 'TRANSLATE_BATCH', payload, config });
        if (response && response.success && response.data) {
          batch.forEach((block, idx) => {
            if (response.data[idx]) {
              block.transEl.textContent = response.data[idx];
              block.transEl.classList.remove('pending');
              block.done = true;
              doneBlocks++;
            }
          });
        } else {
          firstError = firstError || (response && response.error) || tt('errBackend');
        }
      } catch (err) {
        firstError = firstError || err.message;
      } finally {
        doneBatches++;
        setStatus(tt('pdfTranslating', { done: doneBlocks, total: blocks.length }), { progress: doneBlocks / blocks.length });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  translating = false;
  document.getElementById('retranslateBtn').disabled = false;

  if (firstError) {
    setStatus(tt('toastFailed', { error: firstError, done: doneBatches, total: batches.length }), { spinning: false });
    showToast(tt('toastFailed', { error: firstError, done: doneBatches, total: batches.length }), true);
  } else {
    setStatus(tt('pdfDone', { count: doneBlocks }), { spinning: false });
  }
}

// ===== 加载文档 =====

function resetToInput() {
  docGen++;
  renderQueue.length = 0;
  renderedPages.clear();
  if (pageObserver) pageObserver.disconnect();
  if (pdfDoc) { pdfDoc.destroy(); pdfDoc = null; }
  blocks = [];
  document.getElementById('doc').textContent = '';
  document.getElementById('toolbar').hidden = true;
  hideStatus();
  document.getElementById('inputCard').hidden = false;
}

async function loadDocument(source, name) {
  resetToInput();
  document.getElementById('inputCard').hidden = true;
  parsing = true;
  parseProgress = { page: 0, total: '?' };
  setStatus(tt('pdfParsing', { page: 0, total: '?' }), { progress: 0 });
  loadedName = name;

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument(source).promise;
    pdfDoc = pdf; // 保持存活：原页对照视图按需渲染整页原图
  } catch (err) {
    parsing = false;
    parseProgress = null;
    resetToInput();
    const msg = err && err.name === 'PasswordException'
      ? tt('pdfPassword')
      : tt('pdfParseFailed', { error: (err && err.message) || String(err) });
    showToast(msg, true);
    return;
  }

  try {
    const total = pdf.numPages;
    let charCount = 0;
    for (let p = 1; p <= total; p++) {
      parseProgress = { page: p, total };
      setStatus(tt('pdfParsing', { page: p, total }), { progress: p / total });
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const pageBlocks = extractBlocks(content.items, p);
      for (const b of pageBlocks) charCount += b.text.length;
      blocks.push(...pageBlocks);
      page.cleanup();
    }
    parsing = false;
    parseProgress = null;

    // 全文几乎没有文本层 → 扫描版（纯图片），明确告知而不是静默空白
    if (charCount < 40) {
      resetToInput();
      showToast(tt('pdfScanned'), true);
      return;
    }
    if (blocks.length === 0) {
      resetToInput();
      showToast(tt('toastNoNodes'), true);
      return;
    }

    renderDoc();
    document.getElementById('toolbar').hidden = false;
    await translateAll();
  } catch (err) {
    showToast(tt('pdfParseFailed', { error: (err && err.message) || String(err) }), true);
    if (blocks.length === 0) resetToInput();
    else hideStatus();
  } finally {
    parsing = false;
    parseProgress = null;
  }
}

async function loadFile(file) {
  if (!file) return;
  const data = await file.arrayBuffer();
  await loadDocument({ data }, file.name);
}

async function loadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    showToast(tt('pdfFetchFailed', { error: url }), true);
    return;
  }
  if (parsed.protocol === 'file:') {
    // 本地文件：扩展页 fetch file:// 需要用户在扩展管理页开启「允许访问文件网址」
    let allowed = false;
    try { allowed = await chrome.extension.isAllowedFileSchemeAccess(); } catch { /* 旧内核无此 API 时直接尝试 fetch */ allowed = true; }
    if (!allowed) {
      showToast(tt('pdfFileAccess'), true);
      return;
    }
  } else if (!/^https?:$/.test(parsed.protocol)) {
    showToast(tt('pdfFetchFailed', { error: url }), true);
    return;
  }
  const btn = document.getElementById('loadUrlBtn');
  btn.disabled = true;
  try {
    // 扩展页有 <all_urls> host 权限，可跨域下载；带凭据以兼容需要登录态的链接
    const resp = await fetch(parsed.href, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.arrayBuffer();
    await loadDocument({ data }, parsed.href);
  } catch (err) {
    showToast(tt('pdfFetchFailed', { error: (err && err.message) || String(err) }), true);
  } finally {
    btn.disabled = false;
  }
}

// 弹窗查询翻译页状态：进行中时弹窗提示等待（同普通页面），而不是新开标签打断翻译
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PDF_STATUS') {
    return {
      translating,
      parsing,
      done: blocks.filter(b => b.done).length,
      total: blocks.length,
      page: parseProgress ? parseProgress.page : 0,
      parseTotal: parseProgress ? parseProgress.total : '?'
    };
  }
});

// ===== 事件绑定与初始化 =====

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  loadFile(e.dataTransfer.files[0]);
});

document.getElementById('loadUrlBtn').addEventListener('click', () => {
  const url = document.getElementById('urlInput').value.trim();
  if (url) loadUrl(url);
});
document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const url = e.target.value.trim();
    if (url) loadUrl(url);
  }
});

// ===== 视图切换：双语对照 / 原页对照 / 仅译文 =====
const VIEW_MODES = { viewBoth: '', viewTrans: 'trans-only', viewPage: 'page-view' };

function setView(id) {
  document.body.classList.remove('trans-only', 'page-view');
  if (VIEW_MODES[id]) document.body.classList.add(VIEW_MODES[id]);
  for (const key of Object.keys(VIEW_MODES)) {
    document.getElementById(key).classList.toggle('active', key === id);
  }
  if (id === 'viewPage') observePages();
  else if (pageObserver) pageObserver.disconnect();
}

document.getElementById('viewBoth').addEventListener('click', () => setView('viewBoth'));
document.getElementById('viewTrans').addEventListener('click', () => setView('viewTrans'));
document.getElementById('viewPage').addEventListener('click', () => setView('viewPage'));

// ===== 原页对照：整页原图懒渲染 =====
// 进入视图且页面接近视口才渲染，串行队列避免 CPU/内存尖峰；canvas 缓存后切回即时

function observePages() {
  if (!pageObserver) {
    pageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) queuePageRender(Number(entry.target.dataset.page));
      }
    }, { rootMargin: '300px 0px' });
  }
  pageObserver.disconnect();
  for (const el of document.querySelectorAll('.page')) pageObserver.observe(el);
}

function queuePageRender(n) {
  if (!pdfDoc || renderedPages.has(n) || renderQueue.includes(n)) return;
  renderQueue.push(n);
  if (!rendering) drainRenderQueue();
}

async function drainRenderQueue() {
  rendering = true;
  while (renderQueue.length > 0) {
    await renderPageImage(renderQueue.shift(), docGen);
  }
  rendering = false;
}

async function renderPageImage(n, gen) {
  const holder = document.querySelector(`.page[data-page="${n}"] .page-img`);
  if (!holder || !pdfDoc) return;
  try {
    const page = await pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, 1100 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();
    if (gen !== docGen) return; // 已换文件，丢弃过期结果
    renderedPages.add(n);
    holder.textContent = '';
    holder.appendChild(canvas);
  } catch (err) {
    if (gen !== docGen) return;
    holder.textContent = '';
    const msg = document.createElement('span');
    msg.className = 'img-error';
    msg.textContent = tt('pdfParseFailed', { error: (err && err.message) || String(err) });
    holder.appendChild(msg);
  }
}

document.getElementById('retranslateBtn').addEventListener('click', async () => {
  if (translating || blocks.length === 0) return;
  settings = await chrome.storage.local.get(SETTINGS_KEYS);
  uiLang = settings.targetLang || '简体中文';
  applyI18n();
  for (const block of blocks) {
    block.done = false;
    block.transEl.textContent = '…';
    block.transEl.classList.add('pending');
  }
  // 页码文案也随界面语言刷新
  let pageNum = 0;
  for (const head of document.querySelectorAll('.page-head')) {
    pageNum++;
    head.textContent = tt('pdfPage', { n: pageNum });
  }
  await translateAll();
});

document.getElementById('newFileBtn').addEventListener('click', resetToInput);

// 设置变更即时同步（在弹窗里改了语言/模型后，这里的状态提示与重新翻译都用新值）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
  if (changes.targetLang) {
    uiLang = settings.targetLang || '简体中文';
    applyI18n();
  } else {
    renderSettingsHint();
  }
});

(async () => {
  settings = await chrome.storage.local.get(SETTINGS_KEYS);
  uiLang = settings.targetLang || '简体中文';
  applyI18n();
  // 从 PDF 标签页跳转而来时自动加载（popup 传入 ?src=）
  const src = new URLSearchParams(location.search).get('src');
  if (src) {
    document.getElementById('urlInput').value = src;
    await loadUrl(src);
  }
})();