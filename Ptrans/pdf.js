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
const renderQueue = [];        // { kind: 'page' | 'formula', n }
const renderedPages = new Set();
const renderedFormulaPages = new Set();
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

// 数学字体识别：强信号（数学专用）与弱信号（CMR 老论文正文也用，不能单独定公式）
const MATH_FONT_STRONG = /CMMI|CMSY|CMEX|MSAM|MSBM|MT ?Extra|Euclid|MathematicalPi|MathItalic|MathSym|MathExt|STIX|Cambria ?Math|Asana|Latin ?Modern ?Math|TeX ?Gyre.*Math/i;
const MATH_FONT_WEAK = /\bCMR\d|\bCMBSY|\bCMSS\d|\bCMTT\d/i;
// 数学符号（含 Greek/上下标/撇号）：无数学字体时的兜底判据，也用于页面级预筛。
// 只收数学专用符号，排除货币、罗马数字、普通箭头等正文也会出现的字符
const MATH_SYMBOLS = /[∑∏∐∫∬∭∮∯∰∱∲∳√∛∜∂∃∄∅∆∇∈∉∊∋∌∍∎−∓∔∕∖∗∘∙±×÷∝∞∟∠∡∢∣∤∥∦∧∨∩∪∴∵∶∷∸∹∺∻∼∽∾∿≀≁≂≃≄≅≆≇≈≉≊≋≌≍≎≏≐≑≒≓≔≕≖≗≘≙≚≛≜≝≞≟≠≡≢≣≤≥≦≧≨≩≪≫≬≭≮≯≰≱≲≳≴≵≶≷≸≹≺≻≼≽≾≿⊀⊁⊂⊃⊄⊅⊆⊇⊈⊉⊊⊋⊌⊍⊎⊏⊐⊑⊒⊓⊔⊕⊖⊗⊘⊙⊚⊛⊜⊝⊞⊟⊠⊡⊢⊣⊤⊥⊦⊧⊨⊩⊪⊫⊬⊭⊮⊯⊰⊱⊲⊳⊴⊵⊶⊷⊸⊹⊺⊻⊼⊽⊾⊿⋀⋁⋂⋃⋄⋅⋆⋇⋈⋉⋊⋋⋌⋍⋎⋏⋐⋑⋒⋓⋔⋕⋖⋗⋘⋙⋚⋛⋜⋝⋞⋟⋠⋡⋢⋣⋤⋥⋦⋧⋨⋩⋪⋫⋬⋭⋮⋯⋰⋱⋲⋳⋴⋵⋶⋷⋸⋹⋺⋻⋼⋽⋾⋿∀∁ℏℓ℘ℜℑℵℶℷℸ′″‴⁗⁰ⁱ⁲⁳⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜαβγδεζηθικλμνξοπρςστυφχψωϑϒϕϖϰϱϲϳϴϵ϶ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩϏ]/;

// 页面级预筛：有数学符号或明显上下标（小字号 item）才值得解析字体，纯 prose 页跳过
function pageHasMathSignal(items) {
  const its = items.filter(it => it.str && it.str.trim());
  if (its.length === 0) return false;
  let small = 0;
  const heights = its.map(it => it.height || 10).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;
  for (const it of its) {
    if (MATH_SYMBOLS.test(it.str)) return true;
    if ((it.height || 10) < medianH * 0.7) small++;
  }
  return small >= 3;
}

// 解析 items 内部字体别名 → 真实字体名（commonObjs 里的 Font 对象由 getOperatorList 填充）
function resolveFontNames(page, items) {
  const map = {};
  for (const it of items) {
    if (!it.fontName || map[it.fontName] !== undefined) continue;
    map[it.fontName] = '';
    try {
      const font = page.commonObjs.get(it.fontName);
      if (font && font.name) map[it.fontName] = font.name;
    } catch { /* 字体对象未就绪：退化为符号判据 */ }
  }
  return map;
}

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

// ASCII 运算符：只计入公式符号占比，不参与页面预筛（正文连字符太常见）
const MATH_OPS = /[=+\-<>]/;

// 公式块判定：字体判据优先——强数学字体占比 ≥0.15 且数学字体总占比 ≥0.75。
// 阈值按真实论文校准：独立公式 total≈0.89~0.94（\mathrm 函数名拉低 strong 至 0.25~0.33），
// 含大量行内公式的正文段 total 仅≈0.36，两类清晰分离。
// 无数学字体时用符号兜底（数学符号占比 ≥0.25 且有行内上下标结构或大运算符/根号）。
function isFormulaStats(s) {
  if (s.total === 0) return false;
  if (s.strong > 0 && s.strong / s.total >= 0.15 && (s.strong + s.weak) / s.total >= 0.75) return true;
  if (s.symbols / s.total >= 0.25 && (s.multiLevel >= 1 || /[∑∏∫√]/.test(s.text))) return true;
  return false;
}

function extractBlocks(items, page, fontMap = {}) {
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
  // 段落级数学统计与包围盒（公式块裁剪用）
  let st = null;
  const newStats = () => ({ total: 0, strong: 0, weak: 0, symbols: 0, multiLevel: 0, text: '', minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const addLineStats = (line) => {
    // 行内出现多个基线（上下标/分式碎片）才算结构信号；整段多行不算（Greek 正文也是多行）
    const ys = new Set(line.items.map(it => Math.round(it.transform[5])));
    if (ys.size >= 2) st.multiLevel++;
    for (const it of line.items) {
      const n = it.str.replace(/\s/g, '').length;
      if (!n) continue;
      const name = fontMap[it.fontName] || '';
      st.total += n;
      if (MATH_FONT_STRONG.test(name)) st.strong += n;
      else if (MATH_FONT_WEAK.test(name)) st.weak += n;
      for (const ch of it.str) if (MATH_SYMBOLS.test(ch) || MATH_OPS.test(ch)) st.symbols++;
      const x = it.transform[4], y = it.transform[5];
      const h = it.height || 10;
      st.minX = Math.min(st.minX, x);
      st.maxX = Math.max(st.maxX, x + (it.width || 0));
      st.minY = Math.min(st.minY, y - h * 0.35);
      st.maxY = Math.max(st.maxY, y + h * 1.1);
    }
    st.text += (st.text ? ' ' : '') + line.text;
  };
  const flush = () => {
    const text = cur.trim();
    // 过滤纯数字/符号（页码、分隔线等），口径同 content.js
    if (text && !/^[\d\s\p{P}]+$/u.test(text)) {
      const bbox = { minX: st.minX, minY: st.minY, maxX: st.maxX, maxY: st.maxY };
      if (isFormulaStats(st)) {
        out.push({ page, text, formula: true, bbox });
      } else {
        out.push({ page, text, bbox });
      }
    }
    cur = '';
    st = null;
  };
  let prevCaption = false;
  for (const line of usable) {
    if (prevY !== null && (prevY - line.y > medianH * 1.6 || cur.length > 1500)) flush();
    // 图注/表注行强制独立成块：避免与图表内容合并后被区域抑制整块吞掉
    const isCap = CAPTION_LINE.test(line.text);
    if (isCap) flush();
    if (!st) st = newStats();
    addLineStats(line);
    cur += (cur ? ' ' : '') + line.text;
    prevY = line.y;
    // 续行也独立成块（表格行距小，续行否则会并入表体被整块抑制）
    if (isCap || prevCaption) flush();
    prevCaption = isCap;
  }
  flush();
  return out;
}

// ===== 图形区域检测：插图（位图/矢量）与表格 → 原页裁剪保留 =====

// 图注/表注行：强制独立成块，避免与图表内容合并后被区域抑制吞掉
const CAPTION_LINE = /^(?:Figure|Fig\.?|Table|Tab\.?|图|表)\s*\d+\s*[:：.]/i;

function transformBox(ctm, x0, y0, x1, y1) {
  const [a, b, c, d, e, f] = ctm;
  const xs = [a * x0 + c * y0 + e, a * x1 + c * y0 + e, a * x0 + c * y1 + e, a * x1 + c * y1 + e];
  const ys = [b * x0 + d * y0 + f, b * x1 + d * y0 + f, b * x0 + d * y1 + f, b * x1 + d * y1 + f];
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// 遍历 operator list，CTM 栈追踪图片与路径的页面坐标包围盒。
// 实体框（图片/填充路径）聚成插图；长细线（表格框线）单独走表格检测。
function collectGraphicBoxes(ol) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const solids = [], rules = [];
  const add = (box) => {
    const w = box.maxX - box.minX, h = box.maxY - box.minY;
    if (h < 3 && w >= 40) rules.push({ ...box, horiz: true });
    else if (w < 3 && h >= 40) rules.push({ ...box, horiz: false });
    else if (w >= 3 && h >= 3) solids.push(box);
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === pdfjsLib.OPS.save) stack.push(ctm.slice());
    else if (fn === pdfjsLib.OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === pdfjsLib.OPS.transform) ctm = pdfjsLib.Util.transform(ctm, args);
    else if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintJpegXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
      add(transformBox(ctm, 0, 0, 1, 1)); // 图片绘制在单位正方形
    } else if (fn === pdfjsLib.OPS.constructPath) {
      const bb = args[2]; // 路径自带用户空间 bbox
      if (bb) add(transformBox(ctm, bb[0], bb[1], bb[2], bb[3]));
    }
  }
  return { solids, rules };
}

function overlapArea(a, b) {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  return w > 0 && h > 0 ? w * h : 0;
}
const boxArea = b => (b.maxX - b.minX) * (b.maxY - b.minY);

// 邻近合并（gap 内视为同一图形）；O(n²) 迭代，千级路径框实测可接受
function clusterBoxes(boxes, gap = 12) {
  const cs = boxes.map(b => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < cs.length && !merged; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j];
        if (a.minX - gap <= b.maxX && b.minX - gap <= a.maxX && a.minY - gap <= b.maxY && b.minY - gap <= a.maxY) {
          a.minX = Math.min(a.minX, b.minX); a.maxX = Math.max(a.maxX, b.maxX);
          a.minY = Math.min(a.minY, b.minY); a.maxY = Math.max(a.maxY, b.maxY);
          cs.splice(j, 1); merged = true; break;
        }
      }
    }
  }
  return cs;
}

function figureRegions(solids, items) {
  const out = [];
  for (const c of clusterBoxes(solids)) {
    const w = c.maxX - c.minX, h = c.maxY - c.minY;
    if (w < 60 || h < 40) continue;
    // 文本密度护栏：轮廓化正文（字形全是路径）会聚成大簇，按字符密度排除
    let chars = 0;
    for (const it of items) {
      const x = it.transform[4], y = it.transform[5];
      if (x >= c.minX && x <= c.maxX && y >= c.minY && y <= c.maxY) chars += (it.str || '').replace(/\s/g, '').length;
    }
    if (chars / (w * h) > 1 / 150) continue;
    out.push({ minX: c.minX - 12, minY: c.minY - 12, maxX: c.maxX + 12, maxY: c.maxY + 12, kind: 'figure' });
  }
  return out;
}

// 表格框线检测：横线按 x 跨度重叠 ≥60% 且 y 距 <250pt 分组；
// ≥3 横（booktabs）或 2 横 + ≥1 竖才成表，排除页眉页脚单/双线
function tableRegions(rules) {
  const horiz = rules.filter(r => r.horiz), vert = rules.filter(r => !r.horiz);
  const groups = [];
  for (const r of horiz) {
    let g = groups.find(g => {
      const ow = Math.min(g.maxX, r.maxX) - Math.max(g.minX, r.minX);
      const rw = Math.min(g.maxX - g.minX, r.maxX - r.minX);
      return ow / rw >= 0.6 && r.minY >= g.minY - 250 && r.maxY <= g.maxY + 250;
    });
    if (!g) { g = { minX: r.minX, maxX: r.maxX, minY: r.minY, maxY: r.maxY, h: 1, v: 0 }; groups.push(g); }
    else { g.minX = Math.min(g.minX, r.minX); g.maxX = Math.max(g.maxX, r.maxX); g.minY = Math.min(g.minY, r.minY); g.maxY = Math.max(g.maxY, r.maxY); g.h++; }
  }
  for (const r of vert) {
    const g = groups.find(g => r.minX >= g.minX - 5 && r.maxX <= g.maxX + 5 && r.minY >= g.minY - 5 && r.maxY <= g.maxY + 5);
    if (g) g.v++;
  }
  return groups.filter(g => (g.h >= 3 || (g.h >= 2 && g.v >= 1)) && g.maxX - g.minX >= 80 && g.maxY - g.minY >= 20)
    .map(g => ({ minX: g.minX - 6, minY: g.minY - 6, maxX: g.maxX + 6, maxY: g.maxY + 6, kind: 'table' }));
}

// 区域整合：抑制落入区域的文本块（图内标签/表格单元格），插入裁剪块，按阅读顺序重排。
// 图注/表注块（含续行）豁免抑制：整页图版聚类可能把图注包进区域，但图注必须保留翻译
function applyGraphicBlocks(pageBlocks, regions, page) {
  if (regions.length === 0) return pageBlocks;
  const isCaption = b => !b.figure && CAPTION_LINE.test(b.text);
  const captionYs = [];
  let inCaption = false;
  for (const b of pageBlocks) { // extractBlocks 输出按阅读顺序（y 降序）
    if (isCaption(b)) { inCaption = true; captionYs.push(b.bbox); }
    else if (inCaption) {
      const last = captionYs[captionYs.length - 1];
      // 续行两种形态：整页图版里被插图区域深包的图注续行；表注续行贴着表区域上缘。
      // 表格内容深在区域内部（重叠≈100%），不算续行，仍被抑制
      const ba = boxArea(b.bbox);
      const inFigure = regions.some(r => r.kind === 'figure' && overlapArea(b.bbox, r) > 0);
      const graze = ba > 0 && regions.some(r => { const o = overlapArea(b.bbox, r) / ba; return o > 0 && o < 0.5; });
      if ((inFigure || graze) && b.bbox.minX >= last.minX - 20 && b.bbox.maxX <= last.maxX + 20 && last.minY - b.bbox.maxY < 25) captionYs.push(b.bbox);
      else inCaption = false;
    }
  }
  const kept = pageBlocks.filter(b => {
    if (isCaption(b) || captionYs.includes(b.bbox)) return true;
    const ba = boxArea(b.bbox);
    return ba <= 0 || !regions.some(r => overlapArea(b.bbox, r) / ba >= 0.7);
  });
  // 区域边缘贴着的图注/表注（含续行）裁进图里会被切字：把区域边界收回到注释外
  for (const r of regions) {
    for (const c of captionYs) {
      if (c.minX >= r.maxX || c.maxX <= r.minX) continue;
      if (r.maxY - c.minY > 0 && r.maxY - c.minY < 25) r.maxY = c.minY - 2;
      else if (c.maxY - r.minY > 0 && c.maxY - r.minY < 25) r.minY = c.maxY + 2;
    }
  }
  for (const r of regions) kept.push({ page, text: '', figure: true, kind: r.kind, bbox: { minX: r.minX, minY: r.minY, maxX: r.maxX, maxY: r.maxY } });
  kept.sort((a, b) => b.bbox.maxY - a.bbox.maxY);
  return kept;
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
    wrap.dataset.page = pageNum;
    if (block.formula || block.figure) {
      // 公式/插图/表格块：原页裁剪图（懒渲染）+ 说明标签，不送翻译，天然完成态
      wrap.classList.add('crop-block', block.formula ? 'formula' : 'figure');
      const img = document.createElement('div');
      img.className = 'formula-img';
      const spin = document.createElement('span');
      spin.className = 'spinner';
      img.appendChild(spin);
      const note = document.createElement('p');
      note.className = 'trans formula-note';
      note.textContent = tt(block.formula ? 'pdfFormula' : 'pdfFigure');
      wrap.append(img, note);
      pageEl.querySelector('.blocks').appendChild(wrap);
      block.imgEl = img;
      block.transEl = note;
      block.done = true;
      continue;
    }
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
  renderedFormulaPages.clear();
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
      // operator list 两用：公式检测的字体对象（getTextContent 不填充 commonObjs）
      // 与插图/表格检测的图形包围盒；解析失败退化为纯文本管线
      let fontMap = {}, regions = [];
      try {
        const ol = await page.getOperatorList();
        if (pageHasMathSignal(content.items)) fontMap = resolveFontNames(page, content.items);
        const { solids, rules } = collectGraphicBoxes(ol);
        regions = [...figureRegions(solids, content.items), ...tableRegions(rules)];
      } catch { /* 降级：不检测公式字体与图形 */ }
      const pageBlocks = applyGraphicBlocks(extractBlocks(content.items, p, fontMap), regions, p);
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
    observeForView(); // 默认双语视图也要观察公式块（裁剪图懒渲染）
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
  observeForView();
}

document.getElementById('viewBoth').addEventListener('click', () => setView('viewBoth'));
document.getElementById('viewTrans').addEventListener('click', () => setView('viewTrans'));
document.getElementById('viewPage').addEventListener('click', () => setView('viewPage'));

// ===== 懒渲染：原页对照整页原图 / 双语与仅译文的公式与图表裁剪图 =====
// 接近视口才渲染，串行队列避免 CPU/内存尖峰；canvas 缓存后切回即时

function observeForView() {
  if (!pageObserver) {
    pageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const n = Number(entry.target.dataset.page);
        queueRender(entry.target.classList.contains('crop-block') ? 'formula' : 'page', n);
      }
    }, { rootMargin: '300px 0px' });
  }
  pageObserver.disconnect();
  // 原页对照观察整页；其余视图只需裁剪块（整页原图不渲染）
  const sel = document.body.classList.contains('page-view') ? '.page' : '.block.crop-block';
  for (const el of document.querySelectorAll(sel)) pageObserver.observe(el);
}

function queueRender(kind, n) {
  if (!pdfDoc) return;
  const done = kind === 'page' ? renderedPages : renderedFormulaPages;
  if (done.has(n) || renderQueue.some(j => j.kind === kind && j.n === n)) return;
  renderQueue.push({ kind, n });
  if (!rendering) drainRenderQueue();
}

async function drainRenderQueue() {
  rendering = true;
  while (renderQueue.length > 0) {
    const job = renderQueue.shift();
    if (job.kind === 'page') await renderPageImage(job.n, docGen);
    else await renderCrops(job.n, docGen);
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

// 裁剪渲染：整页渲染一次，按 bbox 裁出该页每个公式/插图/表格块，丢弃整页 canvas 只留小图。
// 渲染失败降级为提取文本（图表块无文本时留空说明，不空白报错）
async function renderCrops(n, gen) {
  const targets = blocks.filter(b => (b.formula || b.figure) && b.page === n && b.imgEl);
  if (targets.length === 0 || !pdfDoc) return;
  const showText = (b) => {
    b.imgEl.textContent = '';
    const p = document.createElement('p');
    p.className = 'formula-fallback';
    p.textContent = b.text;
    b.imgEl.appendChild(p);
  };
  try {
    const page = await pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1100 / base.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();
    if (gen !== docGen) return; // 已换文件，丢弃过期结果
    const pad = 4; // PDF 点：公式四周留白
    for (const b of targets) {
      const { minX, minY, maxX, maxY } = b.bbox;
      const sx = Math.max(0, (minX - pad) * scale);
      const sy = Math.max(0, viewport.height - (maxY + pad) * scale);
      const sw = Math.min(canvas.width - sx, (maxX - minX + pad * 2) * scale);
      const sh = Math.min(canvas.height - sy, (maxY - minY + pad * 2) * scale);
      if (sw <= 0 || sh <= 0) { showText(b); continue; }
      const crop = document.createElement('canvas');
      crop.width = Math.ceil(sw);
      crop.height = Math.ceil(sh);
      crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
      b.imgEl.textContent = '';
      b.imgEl.appendChild(crop);
    }
    renderedFormulaPages.add(n);
  } catch (err) {
    if (gen !== docGen) return;
    for (const b of targets) showText(b);
  }
}

document.getElementById('retranslateBtn').addEventListener('click', async () => {
  if (translating || blocks.length === 0) return;
  settings = await chrome.storage.local.get(SETTINGS_KEYS);
  uiLang = settings.targetLang || '简体中文';
  applyI18n();
  for (const block of blocks) {
    if (block.formula || block.figure) continue; // 裁剪块是原样图，无需重译
    block.done = false;
    block.transEl.textContent = '…';
    block.transEl.classList.add('pending');
  }
  // 页码与公式标签文案也随界面语言刷新
  let pageNum = 0;
  for (const head of document.querySelectorAll('.page-head')) {
    pageNum++;
    head.textContent = tt('pdfPage', { n: pageNum });
  }
  for (const note of document.querySelectorAll('.formula-note')) {
    note.textContent = tt('pdfFormula');
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
  }
});

// 顶栏高度随内容显隐/窄屏换行变化，原页对照的 sticky 偏移跟随实际高度
const topbarEl = document.getElementById('topbar');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--topbar-h', topbarEl.offsetHeight + 'px');
}).observe(topbarEl);

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