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

// 界面文案跟随目标语言（词典见 i18n.js，先于本脚本注入）
function tt(key, params) {
  return t(settings.targetLang || '简体中文', key, params);
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
          firstError = firstError || (response && response.error) || tt('errBackend');
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
    showToast(tt('toastBusy'));
    return;
  }
  const allNodes = getTranslatableTextNodes();
  if (allNodes.length === 0) {
    showToast(tt('toastNoNodes'), true);
    return;
  }

  pageTranslating = true;
  try {
    const { batches, doneCount, firstError } = await translateNodes(allNodes, config);
    if (firstError) {
      showToast(tt('toastFailed', { error: firstError, done: doneCount, total: batches.length }), true);
    } else {
      showToast(tt('toastDone', { count: translatedNodes.size }), false);
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
  showToast(tt('toastRestored'), false);
}

// ===== 自动翻译（始终翻译本站 / 外语页面） =====

// 启发式判定页面主语言：采样文本节点，按字符脚本判定非拉丁语言，
// 拉丁文本按高频功能词词频打分。返回语言本名（与 targetLang 一致），判不出返回 null。
// 结果缓存：页面被翻译后仍返回原文语言，弹窗文案保持稳定
let detectedPageLang;
function detectPageLanguage() {
  if (detectedPageLang !== undefined) return detectedPageLang;
  const nodes = getTranslatableTextNodes();
  let sample = '';
  for (const node of nodes) {
    sample += node.nodeValue + ' ';
    if (sample.length > 4000) break;
  }
  detectedPageLang = detectLangFromSample(sample);
  return detectedPageLang;
}

function detectLangFromSample(sample) {
  const count = re => (sample.match(re) || []).length;
  const scripts = {
    latin: count(/[A-Za-z]/g),
    cjk: count(/[㐀-䶿一-鿿]/g),
    kana: count(/[぀-ヿ]/g),
    hangul: count(/[가-힯ᄀ-ᇿ]/g),
    cyrillic: count(/[Ѐ-ӿ]/g),
    arabic: count(/[؀-ۿݐ-ݿ]/g),
    thai: count(/[฀-๿]/g)
  };
  const total = Object.values(scripts).reduce((a, b) => a + b, 0);
  if (total < 100) return null; // 文本太少，不足以可靠判定
  const ratio = n => n / total;

  if (ratio(scripts.hangul) > 0.3) return '한국어';
  if (ratio(scripts.kana) > 0.15) return '日本語'; // 日文页混用汉字，假名是判别特征
  if (ratio(scripts.cjk) > 0.3) return detectChineseVariant(sample);
  if (ratio(scripts.cyrillic) > 0.3) return 'Русский';
  if (ratio(scripts.arabic) > 0.3) return 'العربية';
  if (ratio(scripts.thai) > 0.3) return 'ไทย';
  if (ratio(scripts.latin) > 0.5) return detectLatinLanguage(sample, scripts.latin);
  return null;
}

// 简繁判别：统计简/繁特征字出现次数；持平时以 <html lang> 裁决
const TRAD_CHARS = new Set('們說時為學對過還後點與東車長門開關電氣語話請問題難離雙體魚鳥黨齊龍龜歲愛樂藝節範經結給紅線練總義習聯職聽舉莊藍藥處號裝覺觀記訂計認議護讀變讓豐貝貞負財貢貧貨販貪貫責貴買貸費貼賀資賓賜賞賠賣賦質賭購贈贊趕趨軌軍軒軟軸較載輕輛輝輩輪輸轉辦農運達違遠適選遺邊郵鄰醫釋針釘釣鈴銀銅銘銳鋒鋼錄錢錦錯鍵鎮鏡鐘鐵鑄鑑發萬無圖團種眾準築隻製');
const SIMP_CHARS = new Set('们说时为学对过还后点与东车长门开关电气语话请问题难离双体鱼鸟党齐龙龟岁爱乐艺节范经结给红线练总义习联职听举庄蓝药处号装觉观记订计认议护读变让丰贝贞负财贡贫货贩贪贯责贵买贷费贴贺资宾赐赏赔卖赋质赌购赠赞赶趋轨军轩软轴较载轻辆辉辈轮输转办农运达违远适选遗边邮邻医释针钉钓铃银铜铭锐锋钢录钱锦错键镇镜钟铁铸鉴发万无图团种众准筑只制');

function detectChineseVariant(sample) {
  let trad = 0, simp = 0;
  for (const ch of sample) {
    if (TRAD_CHARS.has(ch)) trad++;
    else if (SIMP_CHARS.has(ch)) simp++;
  }
  if (trad !== simp) return trad > simp ? '繁體中文' : '简体中文';
  const tag = (document.documentElement.getAttribute('lang') || '').toLowerCase();
  return /^zh-(hant|tw|hk|mo)/.test(tag) ? '繁體中文' : '简体中文';
}

// 拉丁语系功能词表（高频虚词即可，无需完整词典）
const LATIN_STOPWORDS = {
  'English': 'the and of to in is that for it with as was on are be this have from or by not but they you we his her at which when what there can will would has been were their our its also than then more most other some only very just because if while about into over after before between under again once here where why how all any both each these those does do did had my your who until during without within through now never always often really quite too so no',
  'Español': 'el la los las de que y en un una por con no se su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas ser son era fue fueron está están estaba han ha había',
  'Français': 'le la les de des du et à un une est en que qui ne pas pour ce se sur au plus par ou mais dans avec son sa ses sont été être avoir ont avait cette ces comme tout tous toute toutes elle il ils elles nous vous je tu me te lui leur y dont où quand si bien alors donc or ni car aussi très peu trop moins encore déjà toujours jamais souvent parfois ici là maintenant avant après pendant depuis vers chez sans sous entre parmi contre selon malgré parce lorsque puisque l d j n qu c s m t',
  'Deutsch': 'der die das und den dem des ein eine einer eines einem einen ist sind war waren wird werden wurde wurden hat hatte haben kann können muss müssen soll sollen will wollen darf dürfen nicht nur noch schon auch sehr mehr viel viele wenig einige alle alles jeder jede jedes keine kein mit nach bei seit von zu zum zur aus auf über unter vor hinter neben zwischen durch für gegen ohne um bis während wegen trotz statt ich du er sie es wir ihr mich dich sich uns euch mir dir ihm ihn ihnen mein dein sein unser euer ihre welcher welche welches dieser diese dieses man hier da dort heute morgen gestern jetzt immer nie oft manchmal',
  'Italiano': 'il lo la i gli le di a da in con su per tra fra e che non è sono era erano essere avere ha hanno aveva avevano questo questa questi queste quello quella quelli quelle come ma anche se perché quando mentre dove chi cui ne ci vi mi ti si un uno una del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle più meno molto poco tanto troppo tutti tutto tutta tutte ogni alcuni alcune nessuno nulla niente qualcosa qualcuno sempre mai spesso ora adesso oggi ieri domani prima dopo durante fino già ancora appena quasi',
  'Português': 'o a os as de do da dos das em no na nos nas um uma uns umas por pelo pela pelos pelas para com não se que e é são era eram ser estar ter tem tinha tinham há houve havia este esta estes estas esse essa esses essas aquele aquela aqueles aquelas isto isso aquilo como mas ou nem pois porque quando enquanto onde quem qual quais cujo cuja me te lhe nos vos meu minha meus minhas teu tua seu sua seus suas nosso nossa vosso vossa dele dela deles delas nele nela aqui ali lá cá agora hoje ontem amanhã sempre nunca já ainda apenas quase',
  'Tiếng Việt': 'và của là có được trong cho với các một những này đó kia đây đấy ấy nó họ chúng tôi ta bạn anh chị em ông bà cô chú không đã đang sẽ rất quá lắm hơi khá thì mà nhưng hoặc hay nếu tuy dù vì bởi do nên để khi lúc sau trước trên dưới ngoài giữa từ đến tới lên xuống vào ra qua lại đi về ở tại theo như cùng nhau luôn thường ít nhiều mọi mỗi từng cả',
  'Bahasa Indonesia': 'dan yang di ke dari untuk dengan pada adalah ini itu tersebut akan telah sudah sedang belum tidak bukan tak tanpa ada berada menjadi merupakan ialah yaitu bahwa karena sebab sehingga maka lalu kemudian setelah sebelum ketika saat sementara sambil serta atau maupun meski meskipun walaupun seperti sebagai bagi oleh tentang terhadap kepada daripada hingga sampai sejak selama bisa hanya saja cuma',
  'Bahasa Melayu': 'dan yang di ke dari untuk dengan pada adalah ini itu tersebut akan telah sudah sedang belum tidak bukan tak tanpa ada berada menjadi merupakan ialah yaitu bahawa kerana sebab sehingga maka lalu kemudian selepas sebelum ketika sambil serta atau maupun meski meskipun walaupun seperti sebagai bagi oleh tentang terhadap kepada daripada hingga sampai sejak selama boleh tak sahaja je cuma'
};
const LATIN_LANGS = Object.keys(LATIN_STOPWORDS);
for (const lang of LATIN_LANGS) LATIN_STOPWORDS[lang] = new Set(LATIN_STOPWORDS[lang].split(' '));

function detectLatinLanguage(sample, latinCount) {
  // 越南语特征变音符号（不含 ă，避免误判罗马尼亚语）足够多时直接判定
  const vnMarks = (sample.match(/[ơưđạảấầẩẫậắằẳẵặếềểễệốồổỗộớờởỡợứừửữựỳỷỹỵ]/gi) || []).length;
  if (vnMarks >= 15 && vnMarks / latinCount > 0.02) return 'Tiếng Việt';

  const words = sample.toLowerCase().match(/[\p{L}]+/gu) || [];
  let best = null, bestScore = 0;
  for (const lang of LATIN_LANGS) {
    const stops = LATIN_STOPWORDS[lang];
    let score = 0;
    for (const w of words) if (stops.has(w)) score++;
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return bestScore >= 6 ? best : null;
}

function tryAutoTranslate() {
  if (autoDone || pageTranslating || translatedNodes.size > 0) return;
  if (!autoConfigReady()) return;
  const bySite = (settings.alwaysSites || []).includes(location.hostname);
  const pageLang = detectPageLanguage();
  const byLang = settings.autoEnglish && pageLang && pageLang !== (settings.targetLang || '简体中文');
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
  const pageLang = detectPageLanguage();
  const autoJustEnabled = settings.autoEnglish && !prevAutoEnglish &&
    pageLang && pageLang !== (settings.targetLang || '简体中文');
  if (siteJustEnabled || autoJustEnabled) {
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
    showToast(tt('toastNeedConfig'), true);
    return;
  }

  hoverBusy.add(block);
  block.setAttribute('data-ptrans-hover', '');
  try {
    const { firstError } = await translateNodes(nodes, getConfig());
    if (firstError) showToast(tt('toastHoverFailed', { error: firstError }), true);
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
  } else if (msg.action === 'DETECT_LANG') {
    return { lang: detectPageLanguage() };
  }
});

// ===== 初始化 =====
(async () => {
  settings = await chrome.storage.local.get(SETTINGS_KEYS);
  applyHoverMode();
  tryAutoTranslate();
})();