// ==UserScript==
// @name         Translate Reddit to Chinese (Google)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Translate Reddit post titles (first link only) and comment text to Chinese using Google Translate API. Handles long text splitting and concurrency control.
// @author       You
// @match        https://www.reddit.com/*
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// ==/UserScript==

(function () {
    'use strict';

    const MAX_SEGMENT_LENGTH = 4000;

    function createLimiter(maxConcurrent) {
        const queue = [];
        let running = 0;

        function runNext() {
            if (running >= maxConcurrent || queue.length === 0) return;
            const { task, resolve, reject } = queue.shift();
            running++;
            Promise.resolve(task())
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    running--;
                    runNext();
                });
        }

        return function (task) {
            return new Promise((resolve, reject) => {
                queue.push({ task, resolve, reject });
                runNext();
            });
        };
    }

    const limit = createLimiter(20);

    function splitByLength(text, maxLength) {
        const chunks = [];
        for (let i = 0; i < text.length; i += maxLength) {
            chunks.push(text.substring(i, i + maxLength));
        }
        return chunks;
    }

    function splitTextBySentences(text, maxLength = MAX_SEGMENT_LENGTH) {
        if (text.length <= maxLength) {
            return [text];
        }

        const fragments = text.split(/(\n)/g).flatMap(line => {
            if (line === '\n') return line;
            return line.split(/(?<=[.!?。！？])\s*/g);
        }).filter(Boolean);

        const safeFragments = fragments.flatMap(frag =>
            frag.length > maxLength ? splitByLength(frag, maxLength) : frag
        );

        const segments = [];
        let currentSegment = "";
        for (const frag of safeFragments) {
            if ((currentSegment + frag).length > maxLength) {
                if (currentSegment) {
                    segments.push(currentSegment);
                }
                currentSegment = frag;
            } else {
                currentSegment += frag;
            }
        }
        if (currentSegment) {
            segments.push(currentSegment);
        }

        return segments.length > 0 ? segments : [text];
    }

    function translateSingleSegment(text, retries = 3) {
        return new Promise((resolve) => {
            if (!text.trim()) {
                return resolve(text);
            }
            const encodedText = encodeURIComponent(text);
            const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodedText}`;

            function attempt() {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: url,
                    timeout: 15000,
                    onload: function (response) {
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data && data[0]) {
                                const translated = data[0].map(sentence => sentence[0]).join('');
                                resolve(translated);
                            } else {
                                if (retries > 0) {
                                    setTimeout(() => attempt(), 1000);
                                    retries--;
                                } else {
                                    resolve(`[翻译失败：无效响应]`);
                                }
                            }
                        } catch (e) {
                            if (retries > 0) {
                                setTimeout(() => attempt(), 1000);
                                retries--;
                            } else {
                                resolve(`[翻译失败：解析错误]`);
                            }
                        }
                    },
                    onerror: function () {
                        if (retries > 0) {
                            setTimeout(() => attempt(), 1000);
                            retries--;
                        } else {
                            resolve(`[翻译失败：网络错误]`);
                        }
                    },
                    ontimeout: function () {
                        if (retries > 0) {
                            setTimeout(() => attempt(), 1000);
                            retries--;
                        } else {
                            resolve(`[翻译失败：请求超时]`);
                        }
                    }
                });
            }

            attempt();
        });
    }

    async function translateText(text) {
        if (!text?.trim()) return text;
        const segments = splitTextBySentences(text);
        const promises = segments.map(seg => limit(() => translateSingleSegment(seg)));
        const results = await Promise.allSettled(promises);

        const translatedSegments = results.map((r, index) => {
            if (r.status === 'fulfilled') {
                return r.value;
            } else {
                return `[片段${index}翻译失败]`;
            }
        });

        return translatedSegments.join('');
    }

    async function translateElement(element) {
        if (element.hasAttribute('data-reddit-translate-attempted')) return;
        element.setAttribute('data-reddit-translate-attempted', 'true');

        const originalText = (element.textContent || element.innerText)?.trim();
        if (!originalText) return;

        if (element.closest('.translation-container')) return;
        if (element.closest('form') || element.closest('[role="button"]')) return;

        const container = document.createElement('div');
        container.className = 'translation-container';
        container.style.position = 'relative';
        container.style.display = 'block';

        element.parentNode.insertBefore(container, element);
        container.appendChild(element);

        const span = document.createElement('div');
        span.className = 'reddit-translation';
        span.style.fontSize = '0.9em';
        span.style.color = '#222';
        span.style.marginTop = '4px';
        span.textContent = '翻译中...';
        container.appendChild(span);

        try {
            const translated = await translateText(originalText);
            span.textContent = translated;
        } catch (err) {
            span.textContent = '[翻译异常]';
        }
    }

    async function translatePageContentAsync() {
        // Reddit 主贴标题（第一链接）
        const postTitleSelector = 'shreddit-post h1[slot="title"], h1._3YpNZ';
        // 评论内容
        const commentSelector = '[data-testid="comment"], .Comment-body, .md';

        const selectors = [postTitleSelector, commentSelector].join(', ');
        const elementsToTranslate = [];

        document.querySelectorAll(selectors).forEach(el => {
            if (!el.hasAttribute('data-reddit-translate-attempted')) {
                // 排除已翻译或输入类元素
                if (!el.closest('input, textarea, button, [contenteditable="true"]')) {
                    elementsToTranslate.push(el);
                }
            }
        });

        if (elementsToTranslate.length === 0) return;

        const tasks = elementsToTranslate.map(el => translateElement(el));
        await Promise.allSettled(tasks);
    }

    let debounceTimer;
    function debouncedTranslate() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(translatePageContentAsync, 600);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', translatePageContentAsync);
    } else {
        translatePageContentAsync();
    }

    const observer = new MutationObserver((mutations) => {
        if (mutations.some(m => m.addedNodes.length > 0)) {
            debouncedTranslate();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();
