// content.js
const originalTextMap = new WeakMap();
const translatedNodes = new Set();

const IGNORE_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
  'CODE', 'PRE', 'SVG', 'MATH', 'TEXTAREA', 'INPUT'
]);

// 页面右上角提示条：让失败/完成对用户可见，而不是静默无响应
let toastEl = null;
function showToast(msg, isError = true) {
  if (toastEl) toastEl.remove();
  toastEl = document.createElement('div');
  toastEl.textContent = msg;
  toastEl.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:380px;' +
    'padding:10px 14px;color:#fff;font:13px/1.6 system-ui,sans-serif;' +
    'border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.35);white-space:pre-wrap;' +
    (isError ? 'background:#dc2626;' : 'background:#16a34a;');
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

// 批量分块翻译并原地替换
async function translatePage(config) {
  const allNodes = getTranslatableTextNodes();
  const BATCH_SIZE = 20; // 每批打包 20 个文本节点
  const CONCURRENCY = 3; // 最大并发请求数

  if (allNodes.length === 0) {
    showToast('未找到可翻译的文本节点。', true);
    return;
  }

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
        doneCount++;
      }
    }
  }

  // 启动并发队列
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  if (firstError) {
    showToast(`翻译失败：${firstError}\n（已完成 ${doneCount}/${batches.length} 批）`, true);
  } else {
    showToast(`翻译完成：${translatedNodes.size} 段文本`, false);
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'START_TRANSLATE') {
    translatePage(msg.config);
  } else if (msg.action === 'RESTORE_ORIGINAL') {
    restorePage();
  }
});
