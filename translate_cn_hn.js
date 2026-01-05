// ==UserScript==
// @name         Translate HN to Chinese (Google)
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Translate main story titles (first link only) and comment text on Hacker News to Chinese using Google Translate API. Fixes long text splitting and concurrency control.
// @author       You
// @match        https://news.ycombinator.com/*
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
            console.log('[HN Translator] Text length <= maxLength, no split needed:', text.length);
            return [text];
        }

        const fragments = text.split(/(\n)/g).flatMap(line => {
            if (line === '\n') return line;
            return line.split(/(?<=[.!?。！？])\s*/g);
        }).filter(Boolean);

        console.log('[HN Translator] Fragments after splitting:', fragments);

        const safeFragments = fragments.flatMap(frag =>
            frag.length > maxLength ? splitByLength(frag, maxLength) : frag
        );

        console.log('[HN Translator] Safe fragments:', safeFragments);

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

        console.log('[HN Translator] Final segments:', segments);
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
                                console.log('[HN Translator] Translated segment:', translated);
                                resolve(translated);
                            } else {
                                console.warn('Unexpected API response for segment:', data, 'Text was:', text.substring(0, 100) + '...');
                                if (retries > 0) {
                                    console.log(`Retrying (${retries} left)...`);
                                    setTimeout(() => attempt(), 1000);
                                    retries--;
                                } else {
                                    resolve(`[翻译失败：无效响应]`);
                                }
                            }
                        } catch (e) {
                            console.error('Parse error for segment:', e, response.responseText, 'Text was:', text.substring(0, 100) + '...');
                            if (retries > 0) {
                                console.log(`Retrying (${retries} left)...`);
                                setTimeout(() => attempt(), 1000);
                                retries--;
                            } else {
                                resolve(`[翻译失败：解析错误]`);
                            }
                        }
                    },
                    onerror: function (error) {
                        console.error('Network error for segment:', error, 'Text was:', text.substring(0, 100) + '...');
                        if (retries > 0) {
                            console.log(`Retrying (${retries} left)...`);
                            setTimeout(() => attempt(), 1000);
                            retries--;
                        } else {
                            resolve(`[翻译失败：网络错误]`);
                        }
                    },
                    ontimeout: function () {
                        console.error('Timeout error for segment. Text was:', text.substring(0, 100) + '...');
                        if (retries > 0) {
                            console.log(`Retrying (${retries} left)...`);
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

        if (segments.length > 1) {
            console.log(`[HN Translator] Split text (${text.length} chars) into ${segments.length} segment(s):`, segments);
        }

        const promises = segments.map((seg, index) => limit(() => {
            console.log(`[HN Translator] Translating segment ${index}:`, seg.substring(0, 100) + '...');
            return translateSingleSegment(seg);
        }));
        const results = await Promise.allSettled(promises);

        const translatedSegments = results.map((r, index) => {
            if (r.status === 'fulfilled') {
                console.log(`[HN Translator] Segment ${index} translated:`, r.value);
                return r.value;
            } else {
                console.error(`Translation failed for segment ${index}:`, segments[index], r.reason);
                return `[片段${index}翻译失败]`;
            }
        });

        return translatedSegments.join('');
    }

    async function translateElement(element) {
        if (element.hasAttribute('data-hn-translate-attempted')) return;
        element.setAttribute('data-hn-translate-attempted', 'true');

        const originalText = (element.textContent || element.innerText)?.trim();
        if (!originalText) return;

        if (element.parentElement?.querySelector('.hn-translation')) return;
        if (element.closest('form[action="comment"]')) return;

        const container = document.createElement('div');
        container.style.display = element.closest('.titleline') ? 'inline-block' : 'block';
        container.style.position = 'relative';

        element.parentNode.insertBefore(container, element);
        container.appendChild(element);

        const span = document.createElement('span');
        span.className = 'hn-translation';
        span.style.display = 'block';
        span.style.fontSize = '0.9em';
        span.style.color = '#222';
        span.style.marginTop = '4px';
        span.textContent = '翻译中...';
        container.appendChild(span);

        try {
            const translated = await translateText(originalText);
            console.log(`[HN Translator] Element translated:`, { original: originalText.substring(0, 100) + '...', translated });
            span.textContent = translated;
        } catch (err) {
            console.error('Transmission error for element:', element, err);
            span.textContent = '[翻译异常]';
        }
    }

    async function translatePageContentAsync() {
        const selectors = ['.titleline > a:first-child', '.commtext'];
        const elementsToTranslate = [];

        document.querySelectorAll(selectors.join(', ')).forEach(el => {
            if (!el.hasAttribute('data-hn-translate-attempted')) {
                elementsToTranslate.push(el);
            }
        });

        if (elementsToTranslate.length === 0) return;

        console.log(`[HN Translator] Found ${elementsToTranslate.length} new items to translate.`);

        const tasks = elementsToTranslate.map(el => translateElement(el));
        await Promise.allSettled(tasks);
    }

    let debounceTimer;
    function debouncedTranslate() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(translatePageContentAsync, 500);
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
