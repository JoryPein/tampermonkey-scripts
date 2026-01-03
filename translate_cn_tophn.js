// ==UserScript==
// @name         TopHN 标题+摘要全能翻译
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  深度适配 tophn.co，翻译标题、摘要及来源。支持动态加载，防封频率限制。
// @author       Gemini
// @match        https://www.tophn.co/*
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        transColor: '#10b981', // 翻译后的字体颜色
        minLength: 4,         // 最小翻译长度
        interval: 400,        // 请求间隔 (ms)，保护 IP
        // 目标选择器：标题、描述/摘要、域名链接
        selectors: [
            '.font-semibold.text-lg p',          // 标题
            '.leading-tight p.font-semibold',    // 内容摘要
            'a[target="_blank"] > span.text-sm'  // 来源域名
        ]
    };

    const translationMap = new Map();
    let queue = [];
    let isProcessing = false;

    // --- 核心翻译逻辑 ---

    function discover() {
        CONFIG.selectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
                const text = el.innerText.trim();
                if (shouldTranslate(el, text)) {
                    el.dataset.translated = 'pending';
                    queue.push({ el, text });
                }
            });
        });
        processQueue();
    }

    function shouldTranslate(el, text) {
        return (
            !el.dataset.translated &&
            text.length >= CONFIG.minLength &&
            !/[\u4e00-\u9fa5]/.test(text) // 不包含中文
        );
    }

    async function processQueue() {
        if (isProcessing || queue.length === 0) return;
        isProcessing = true;

        const item = queue.shift();

        try {
            let translated = translationMap.get(item.text);
            if (!translated) {
                translated = await fetchTranslation(item.text);
                if (translated) translationMap.set(item.text, translated);
            }

            if (translated) {
                inject(item.el, translated);
            }
        } catch (e) {
            console.error('Translation error:', e);
            item.el.dataset.translated = ''; // 出错允许重试
        }

        setTimeout(() => {
            isProcessing = false;
            processQueue();
        }, CONFIG.interval);
    }

    function fetchTranslation(text) {
        return new Promise((resolve, reject) => {
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        resolve(data[0].map(x => x[0]).join(''));
                    } catch (e) { reject(e); }
                },
                onerror: reject
            });
        });
    }

    function inject(el, translatedText) {
        if (el.dataset.translated === 'true') return;
        el.dataset.translated = 'true';

        const transEl = document.createElement('div');
        transEl.className = 'tophn-translation';
        transEl.innerText = translatedText;

        // 样式适配：根据父级不同调整外观
        const isSmall = el.classList.contains('text-sm');
        transEl.style.cssText = `
            color: ${CONFIG.transColor};
            font-size: ${isSmall ? '0.85em' : '0.9em'};
            font-weight: 400;
            margin-top: 2px;
            line-height: 1.4;
            border-left: 2px solid ${CONFIG.transColor}33;
            padding-left: 8px;
            font-style: normal;
        `;

        // 如果是标题，加一点间距
        if (el.parentElement.classList.contains('text-lg')) {
            transEl.style.marginBottom = '4px';
        }

        el.after(transEl); // 在原元素下方插入
    }

    // --- 监听器 ---

    const observer = new MutationObserver((mutations) => {
        if (mutations.some(m => m.addedNodes.length > 0)) {
            discover();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 初始化
    setTimeout(discover, 500);
    // 路由跳转兜底
    window.addEventListener('popstate', () => setTimeout(discover, 1000));
    // 定时检查
    setInterval(discover, 4000);

})();
