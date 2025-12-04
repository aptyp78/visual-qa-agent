/**
 * IssueDetector - Детектор визуальных проблем с actionable fixes
 *
 * Анализирует страницу и генерирует структурированные проблемы
 * с конкретными указаниями по исправлению для другого агента.
 */

export class IssueDetector {
    constructor(standards) {
        this.standards = standards;
    }

    /**
     * Анализ страницы через Playwright и генерация проблем
     */
    async detectIssues(page, device, metadata = {}) {
        const issues = [];

        // 1. Проверка горизонтального скролла
        const horizontalScrollIssue = await this.checkHorizontalScroll(page, device);
        if (horizontalScrollIssue) issues.push(horizontalScrollIssue);

        // 2. Проверка overflow элементов
        const overflowIssues = await this.checkOverflow(page, device);
        issues.push(...overflowIssues);

        // 3. Проверка touch targets (для мобильных)
        if (device.is_mobile || device.has_touch) {
            const touchIssues = await this.checkTouchTargets(page, device);
            issues.push(...touchIssues);
        }

        // 4. Проверка контраста текста
        const contrastIssues = await this.checkContrast(page, device);
        issues.push(...contrastIssues);

        // 5. Проверка размера шрифта
        const fontIssues = await this.checkFontSize(page, device);
        issues.push(...fontIssues);

        // 6. Проверка alt-текстов изображений
        const altIssues = await this.checkImageAlt(page, device);
        issues.push(...altIssues);

        // 7. Проверка наложения элементов
        const overlapIssues = await this.checkOverlap(page, device);
        issues.push(...overlapIssues);

        // Сортировка по приоритету
        return this.prioritizeIssues(issues);
    }

    /**
     * Проверка горизонтального скролла
     */
    async checkHorizontalScroll(page, device) {
        try {
            const hasHorizontalScroll = await page.evaluate(() => {
                return document.documentElement.scrollWidth > document.documentElement.clientWidth;
            });

            if (hasHorizontalScroll) {
                // Находим элемент, вызывающий overflow
                const overflowingElement = await page.evaluate(() => {
                    const docWidth = document.documentElement.clientWidth;
                    const elements = document.querySelectorAll('*');
                    for (const el of elements) {
                        const rect = el.getBoundingClientRect();
                        if (rect.right > docWidth + 5) {
                            return {
                                tag: el.tagName.toLowerCase(),
                                className: el.className,
                                id: el.id,
                                width: rect.width,
                                right: rect.right,
                                selector: el.id ? `#${el.id}` :
                                         el.className ? `.${el.className.split(' ')[0]}` :
                                         el.tagName.toLowerCase()
                            };
                        }
                    }
                    return null;
                });

                return {
                    id: `horizontal-scroll-${device.id}`,
                    type: 'layout',
                    severity: 'critical',
                    title: 'Горизонтальный скролл на странице',
                    description: `Страница имеет горизонтальную прокрутку на устройстве ${device.name}`,
                    device: device.name,
                    viewport: device.viewport,
                    element: overflowingElement,
                    fix: {
                        action: 'css_change',
                        target: overflowingElement?.selector || 'body',
                        suggestion: overflowingElement
                            ? `Элемент ${overflowingElement.selector} выходит за границы (${Math.round(overflowingElement.right)}px > ${device.viewport.width}px). Добавьте overflow-x: hidden или уменьшите ширину.`
                            : 'Добавьте в body или html: overflow-x: hidden; или найдите элемент с фиксированной шириной больше viewport.',
                        css: `${overflowingElement?.selector || 'body'} {\n  max-width: 100%;\n  overflow-x: hidden;\n}`
                    },
                    wcag: null,
                    blocks_release: true
                };
            }
        } catch (e) {
            console.warn(`[IssueDetector] checkHorizontalScroll: ${e.message}`);
        }
        return null;
    }

    /**
     * Проверка overflow элементов
     */
    async checkOverflow(page, device) {
        const issues = [];
        try {
            const overflowingElements = await page.evaluate(() => {
                const results = [];
                const docWidth = document.documentElement.clientWidth;
                const elements = document.querySelectorAll('img, video, iframe, table, pre, code');

                elements.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > docWidth) {
                        results.push({
                            tag: el.tagName.toLowerCase(),
                            selector: el.id ? `#${el.id}` :
                                     el.className ? `.${el.className.split(' ')[0]}` :
                                     el.tagName.toLowerCase(),
                            width: rect.width,
                            maxWidth: docWidth
                        });
                    }
                });
                return results;
            });

            for (const el of overflowingElements) {
                issues.push({
                    id: `overflow-${el.tag}-${device.id}`,
                    type: 'layout',
                    severity: 'critical',
                    title: `Элемент ${el.tag} выходит за границы экрана`,
                    description: `${el.selector} шире viewport (${Math.round(el.width)}px > ${el.maxWidth}px)`,
                    device: device.name,
                    viewport: device.viewport,
                    element: el,
                    fix: {
                        action: 'css_change',
                        target: el.selector,
                        suggestion: `Добавьте max-width: 100% для ${el.selector}`,
                        css: `${el.selector} {\n  max-width: 100%;\n  height: auto;\n}`
                    },
                    blocks_release: true
                });
            }
        } catch (e) {
            console.warn(`[IssueDetector] checkOverflow: ${e.message}`);
        }
        return issues;
    }

    /**
     * Проверка размера touch targets
     */
    async checkTouchTargets(page, device) {
        const issues = [];
        const minSize = this.standards?.responsiveness?.touch_targets?.min_size_px || 44;

        try {
            const smallTargets = await page.evaluate((minSize) => {
                const results = [];
                const clickables = document.querySelectorAll('a, button, input, select, textarea, [onclick], [role="button"]');

                clickables.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    const size = Math.min(rect.width, rect.height);
                    if (size > 0 && size < minSize) {
                        results.push({
                            tag: el.tagName.toLowerCase(),
                            text: el.textContent?.substring(0, 30) || el.getAttribute('aria-label') || '',
                            selector: el.id ? `#${el.id}` :
                                     el.className ? `.${el.className.split(' ')[0]}` :
                                     el.tagName.toLowerCase(),
                            width: rect.width,
                            height: rect.height,
                            size: size
                        });
                    }
                });
                return results.slice(0, 10); // Максимум 10
            }, minSize);

            for (const el of smallTargets) {
                issues.push({
                    id: `touch-target-${el.selector}-${device.id}`,
                    type: 'accessibility',
                    severity: 'warning',
                    title: `Touch target слишком маленький: ${el.text || el.tag}`,
                    description: `${el.selector} имеет размер ${Math.round(el.size)}px (минимум ${minSize}px)`,
                    device: device.name,
                    viewport: device.viewport,
                    element: el,
                    fix: {
                        action: 'css_change',
                        target: el.selector,
                        suggestion: `Увеличьте размер кликабельной области до минимум ${minSize}x${minSize}px`,
                        css: `${el.selector} {\n  min-width: ${minSize}px;\n  min-height: ${minSize}px;\n  padding: 12px;\n}`
                    },
                    wcag: '2.5.5',
                    blocks_release: false
                });
            }
        } catch (e) {
            console.warn(`[IssueDetector] checkTouchTargets: ${e.message}`);
        }
        return issues;
    }

    /**
     * Проверка контраста текста (упрощённая)
     */
    async checkContrast(page, device) {
        const issues = [];
        try {
            const lowContrastElements = await page.evaluate(() => {
                const results = [];

                function getLuminance(r, g, b) {
                    const [rs, gs, bs] = [r, g, b].map(c => {
                        c = c / 255;
                        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
                    });
                    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
                }

                function getContrastRatio(l1, l2) {
                    const lighter = Math.max(l1, l2);
                    const darker = Math.min(l1, l2);
                    return (lighter + 0.05) / (darker + 0.05);
                }

                function parseColor(color) {
                    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                    if (match) {
                        return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
                    }
                    return null;
                }

                const textElements = document.querySelectorAll('p, span, a, h1, h2, h3, h4, h5, h6, li, td, th, label');

                textElements.forEach(el => {
                    const style = window.getComputedStyle(el);
                    const color = parseColor(style.color);
                    const bgColor = parseColor(style.backgroundColor);

                    if (color && bgColor && bgColor.r + bgColor.g + bgColor.b > 0) {
                        const textLum = getLuminance(color.r, color.g, color.b);
                        const bgLum = getLuminance(bgColor.r, bgColor.g, bgColor.b);
                        const ratio = getContrastRatio(textLum, bgLum);

                        if (ratio < 4.5 && ratio > 1) {
                            results.push({
                                tag: el.tagName.toLowerCase(),
                                text: el.textContent?.substring(0, 30) || '',
                                selector: el.id ? `#${el.id}` :
                                         el.className ? `.${el.className.split(' ')[0]}` :
                                         el.tagName.toLowerCase(),
                                ratio: ratio.toFixed(2),
                                color: style.color,
                                bgColor: style.backgroundColor
                            });
                        }
                    }
                });
                return results.slice(0, 5);
            });

            for (const el of lowContrastElements) {
                issues.push({
                    id: `contrast-${el.selector}-${device.id}`,
                    type: 'accessibility',
                    severity: 'warning',
                    title: `Низкий контраст текста: "${el.text}"`,
                    description: `Контраст ${el.ratio}:1 (требуется минимум 4.5:1 по WCAG AA)`,
                    device: device.name,
                    element: el,
                    fix: {
                        action: 'css_change',
                        target: el.selector,
                        suggestion: `Увеличьте контраст: затемните текст или осветлите фон`,
                        css: `${el.selector} {\n  color: #333333; /* или темнее */\n}`
                    },
                    wcag: '1.4.3',
                    blocks_release: false
                });
            }
        } catch (e) {
            console.warn(`[IssueDetector] checkContrast: ${e.message}`);
        }
        return issues;
    }

    /**
     * Проверка размера шрифта
     */
    async checkFontSize(page, device) {
        const issues = [];
        const minSize = device.is_mobile
            ? (this.standards?.typography?.min_font_size?.mobile || 14)
            : (this.standards?.typography?.min_font_size?.desktop || 12);

        try {
            const smallTextElements = await page.evaluate((minSize) => {
                const results = [];
                const textElements = document.querySelectorAll('p, span, a, li, td, th, label, div');

                textElements.forEach(el => {
                    const style = window.getComputedStyle(el);
                    const fontSize = parseFloat(style.fontSize);
                    const hasText = el.textContent?.trim().length > 0;

                    if (hasText && fontSize < minSize && fontSize > 0) {
                        results.push({
                            tag: el.tagName.toLowerCase(),
                            text: el.textContent?.substring(0, 30) || '',
                            selector: el.id ? `#${el.id}` :
                                     el.className ? `.${el.className.split(' ')[0]}` :
                                     el.tagName.toLowerCase(),
                            fontSize: fontSize
                        });
                    }
                });
                return results.slice(0, 5);
            }, minSize);

            for (const el of smallTextElements) {
                issues.push({
                    id: `font-size-${el.selector}-${device.id}`,
                    type: 'typography',
                    severity: 'warning',
                    title: `Слишком мелкий текст: "${el.text}"`,
                    description: `Размер шрифта ${el.fontSize}px (минимум ${minSize}px для ${device.is_mobile ? 'мобильных' : 'десктопа'})`,
                    device: device.name,
                    element: el,
                    fix: {
                        action: 'css_change',
                        target: el.selector,
                        suggestion: `Увеличьте размер шрифта до минимум ${minSize}px`,
                        css: `${el.selector} {\n  font-size: ${minSize}px;\n}`
                    },
                    wcag: '1.4.4',
                    blocks_release: false
                });
            }
        } catch (e) {
            console.warn(`[IssueDetector] checkFontSize: ${e.message}`);
        }
        return issues;
    }

    /**
     * Проверка alt-текстов изображений
     */
    async checkImageAlt(page, device) {
        const issues = [];
        try {
            const imagesWithoutAlt = await page.evaluate(() => {
                const results = [];
                const images = document.querySelectorAll('img');

                images.forEach(img => {
                    const alt = img.getAttribute('alt');
                    const isDecorative = img.getAttribute('role') === 'presentation' || alt === '';

                    if (alt === null && !isDecorative) {
                        results.push({
                            src: img.src?.substring(0, 50) || '',
                            selector: img.id ? `#${img.id}` :
                                     img.className ? `img.${img.className.split(' ')[0]}` :
                                     'img'
                        });
                    }
                });
                return results.slice(0, 5);
            });

            for (const img of imagesWithoutAlt) {
                issues.push({
                    id: `img-alt-${device.id}`,
                    type: 'accessibility',
                    severity: 'critical',
                    title: 'Изображение без alt-текста',
                    description: `${img.selector} не имеет атрибута alt`,
                    device: device.name,
                    element: img,
                    fix: {
                        action: 'html_change',
                        target: img.selector,
                        suggestion: 'Добавьте описательный alt-текст или alt="" для декоративных изображений',
                        html: `<img src="..." alt="Описание изображения">`
                    },
                    wcag: '1.1.1',
                    blocks_release: true
                });
            }
        } catch (e) {
            console.warn(`[IssueDetector] checkImageAlt: ${e.message}`);
        }
        return issues;
    }

    /**
     * Проверка наложения элементов
     */
    async checkOverlap(page, device) {
        // Упрощённая проверка - можно расширить
        return [];
    }

    /**
     * Полный аудит всех кликабельных элементов
     * Возвращает детальную информацию о каждом интерактивном элементе
     */
    async auditClickableElements(page, device) {
        const minTouchSize = this.standards?.responsiveness?.touch_targets?.min_size_px || 44;
        const isMobile = device.is_mobile || device.has_touch;

        try {
            const audit = await page.evaluate(({ minTouchSize, isMobile, viewportWidth }) => {
                const results = {
                    total: 0,
                    valid: [],
                    issues: [],
                    summary: {
                        too_small: 0,
                        no_label: 0,
                        hidden: 0,
                        overlapping: 0,
                        outside_viewport: 0
                    }
                };

                // Все кликабельные элементы
                const clickables = document.querySelectorAll(
                    'a, button, input, select, textarea, ' +
                    '[onclick], [role="button"], [role="link"], [role="menuitem"], ' +
                    '[tabindex]:not([tabindex="-1"]), label[for], ' +
                    '.btn, .button, [class*="clickable"], [class*="interactive"]'
                );

                // Функция получения accessible name
                function getAccessibleName(el) {
                    return el.getAttribute('aria-label') ||
                           el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent ||
                           el.getAttribute('title') ||
                           el.getAttribute('alt') ||
                           el.textContent?.trim().substring(0, 50) ||
                           el.getAttribute('placeholder') ||
                           el.value ||
                           '';
                }

                // Функция проверки видимости
                function isVisible(el) {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.display !== 'none' &&
                           style.visibility !== 'hidden' &&
                           style.opacity !== '0' &&
                           rect.width > 0 &&
                           rect.height > 0;
                }

                // Функция получения селектора
                function getSelector(el) {
                    if (el.id) return `#${el.id}`;
                    if (el.className && typeof el.className === 'string') {
                        const classes = el.className.split(' ').filter(c => c && !c.includes(':'));
                        if (classes.length > 0) return `.${classes[0]}`;
                    }
                    // Построение уникального селектора
                    let selector = el.tagName.toLowerCase();
                    if (el.type) selector += `[type="${el.type}"]`;
                    if (el.name) selector += `[name="${el.name}"]`;
                    return selector;
                }

                const rects = []; // Для проверки наложений

                clickables.forEach((el, index) => {
                    results.total++;
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    const visible = isVisible(el);
                    const name = getAccessibleName(el);
                    const selector = getSelector(el);
                    const minDimension = Math.min(rect.width, rect.height);

                    const elementInfo = {
                        index,
                        tag: el.tagName.toLowerCase(),
                        type: el.type || null,
                        selector,
                        name: name.substring(0, 50),
                        rect: {
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        },
                        visible,
                        size: Math.round(minDimension),
                        issues: []
                    };

                    // Проверка 1: Слишком маленький для touch
                    if (isMobile && visible && minDimension > 0 && minDimension < minTouchSize) {
                        elementInfo.issues.push({
                            type: 'too_small',
                            message: `Размер ${Math.round(minDimension)}px < ${minTouchSize}px`,
                            severity: 'warning'
                        });
                        results.summary.too_small++;
                    }

                    // Проверка 2: Нет доступного имени
                    if (visible && !name && el.tagName !== 'INPUT') {
                        elementInfo.issues.push({
                            type: 'no_label',
                            message: 'Нет текста или aria-label',
                            severity: 'warning'
                        });
                        results.summary.no_label++;
                    }

                    // Проверка 3: Скрытый элемент
                    if (!visible && rect.width === 0 && rect.height === 0) {
                        elementInfo.issues.push({
                            type: 'hidden',
                            message: 'Элемент скрыт (размер 0)',
                            severity: 'info'
                        });
                        results.summary.hidden++;
                    }

                    // Проверка 4: За пределами viewport
                    if (visible && (rect.right > viewportWidth + 10 || rect.left < -10)) {
                        elementInfo.issues.push({
                            type: 'outside_viewport',
                            message: `Выходит за пределы экрана (right: ${Math.round(rect.right)}px)`,
                            severity: 'critical'
                        });
                        results.summary.outside_viewport++;
                    }

                    // Проверка 5: Наложение с другими кликабельными
                    if (visible && rect.width > 0) {
                        for (const other of rects) {
                            const overlap = !(rect.right < other.rect.left ||
                                            rect.left > other.rect.right ||
                                            rect.bottom < other.rect.top ||
                                            rect.top > other.rect.bottom);
                            if (overlap && other.selector !== selector) {
                                // Проверяем что это не parent-child
                                const isNested = el.contains(other.el) || other.el?.contains(el);
                                if (!isNested) {
                                    elementInfo.issues.push({
                                        type: 'overlapping',
                                        message: `Пересекается с ${other.selector}`,
                                        severity: 'warning'
                                    });
                                    results.summary.overlapping++;
                                    break;
                                }
                            }
                        }
                        rects.push({ rect, selector, el });
                    }

                    // Распределяем по категориям
                    if (elementInfo.issues.length > 0) {
                        results.issues.push(elementInfo);
                    } else if (visible) {
                        results.valid.push(elementInfo);
                    }
                });

                return results;
            }, { minTouchSize, isMobile, viewportWidth: device.viewport.width });

            return audit;
        } catch (e) {
            return { error: e.message, total: 0, valid: [], issues: [], summary: {} };
        }
    }

    /**
     * Приоритизация и сортировка проблем
     */
    prioritizeIssues(issues) {
        const severityOrder = { critical: 0, warning: 1, info: 2 };

        return issues.sort((a, b) => {
            // Сначала по severity
            const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
            if (severityDiff !== 0) return severityDiff;

            // Затем по типу (accessibility важнее)
            if (a.type === 'accessibility' && b.type !== 'accessibility') return -1;
            if (b.type === 'accessibility' && a.type !== 'accessibility') return 1;

            return 0;
        });
    }

    /**
     * Генерация сводки для агента
     */
    generateSummaryForAgent(issues) {
        const critical = issues.filter(i => i.severity === 'critical');
        const warnings = issues.filter(i => i.severity === 'warning');
        const info = issues.filter(i => i.severity === 'info');

        return {
            total_issues: issues.length,
            blocks_release: critical.length > 0,
            by_severity: {
                critical: critical.length,
                warning: warnings.length,
                info: info.length
            },
            by_type: {
                layout: issues.filter(i => i.type === 'layout').length,
                accessibility: issues.filter(i => i.type === 'accessibility').length,
                typography: issues.filter(i => i.type === 'typography').length
            },
            action_required: critical.length > 0
                ? `БЛОКЕР: Исправьте ${critical.length} критических проблем перед релизом`
                : warnings.length > 0
                ? `Рекомендуется исправить ${warnings.length} предупреждений`
                : 'Все проверки пройдены'
        };
    }
}

export default IssueDetector;
