// background.js
console.log('[ptrans] service worker started');

function buildSystemPrompt(config) {
  const stylePrompts = {
    strict: '采用严谨、准确、直译优先的风格。严格忠实于原文的句法与技术细节，不作主观润色，确保信息零损耗。',
    balanced: '采用均衡标准的翻译风格。在准确传达原意的前提下，使语句自然流畅，符合目标语言的母语阅读习惯。',
    elegant: '采用优雅自然的意译风格。深度重构语序与句式，消除生硬的翻译腔，使用地道、富有表现力的母语表达。'
  };

  const termInstruction = config.explainTerms
    ? '【术语解释要求】：识别文本中的专业术语、行业黑话、学科概念或技术缩写。在译文中首次出现该术语时，必须在译名后用括号附上原文及简明的一句话解释，格式为：“译名（原文，一句话核心释义）”。'
    : '';

  return `你是一个高精度的网页DOM文本翻译引擎。
请将用户输入的 JSON 对象中的所有文本值（不论其源语言是什么）翻译为【${config.targetLang}】。
【翻译风格】：${stylePrompts[config.styleMode] || stylePrompts.balanced}
${termInstruction}
【输出格式铁律】：
1. 必须严格输出合法的 JSON 对象，保持输入的数字键（Key）完全一致。
2. 严禁输出 Markdown 代码块标记（不要包含 \`\`\`json），只输出纯 JSON 文本。
3. 若某条文本已经是${config.targetLang}、人名、网址或无需翻译的标识符，则在对应键值中原样返回。`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'PING') {
    sendResponse({ pong: true });
    return false;
  }
  if (message.action === 'TRANSLATE_BATCH') {
    handleTranslation(message.payload, message.config)
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 保持异步消息通道开启
  }
});

async function handleTranslation(payload, config) {
  const tempMap = { strict: 0.1, balanced: 0.3, elegant: 0.6 };
  const endpoint = `${config.baseUrl}/chat/completions`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: tempMap[config.styleMode] ?? 0.3,
      response_format: { type: 'json_object' }, // 强制 JSON 输出（主流兼容接口均支持）
      messages: [
        { role: 'system', content: buildSystemPrompt(config) },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API HTTP ${response.status} @ ${endpoint}: ${body.slice(0, 200)}`);
  }

  const result = await response.json();
  let rawContent = result.choices?.[0]?.message?.content?.trim() || '{}';
  // 兼容部分未严格遵守 json_object 仍带 markdown 标记的开源模型
  rawContent = rawContent.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(rawContent);
}
