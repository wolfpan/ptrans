// popup.js
const fields = ['baseUrl', 'apiKey', 'model', 'targetLang', 'styleMode', 'explainTerms'];

document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get(fields);
  document.getElementById('baseUrl').value = data.baseUrl || 'https://api.openai.com/v1';
  document.getElementById('apiKey').value = data.apiKey || '';
  document.getElementById('model').value = data.model || 'gpt-4o-mini';
  document.getElementById('targetLang').value = data.targetLang || '简体中文';
  document.getElementById('styleMode').value = data.styleMode || 'balanced';
  document.getElementById('explainTerms').checked = !!data.explainTerms;
});

async function saveConfig() {
  const config = {
    baseUrl: document.getElementById('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: document.getElementById('apiKey').value.trim(),
    model: document.getElementById('model').value.trim(),
    targetLang: document.getElementById('targetLang').value,
    styleMode: document.getElementById('styleMode').value,
    explainTerms: document.getElementById('explainTerms').checked
  };
  await chrome.storage.local.set(config);
  return config;
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
    alert('请先填写 API Base URL 和模型名称。');
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
