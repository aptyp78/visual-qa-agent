/**
 * AIVisionAnalyzer - AI-анализатор визуальных проблем
 *
 * Использует Claude Vision для интеллектуального анализа скриншотов:
 * - Обнаружение визуальных багов
 * - Проверка UX/UI паттернов
 * - Анализ accessibility
 * - Сравнение с baseline
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs-extra';
import path from 'path';
import { withTimeout, RateLimiter, validateFilePath } from '../utils/helpers.js';

export class AIVisionAnalyzer {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
        this.model = options.model || 'claude-sonnet-4-20250514';
        // Настройки timeout и rate limiting
        this.timeout = options.timeout || 60000; // 60 секунд по умолчанию
        this.rateLimiter = new RateLimiter(
            options.maxRequestsPerMinute || 10,
            60000
        );

        if (!this.apiKey) {
            console.warn('⚠️ ANTHROPIC_API_KEY не установлен. AI-анализ будет недоступен.');
            this.enabled = false;
        } else {
            this.client = new Anthropic({ apiKey: this.apiKey });
            this.enabled = true;
        }

        // Промпты для анализа
        this.prompts = {
            visualQA: this.getVisualQAPrompt(),
            accessibility: this.getAccessibilityPrompt(),
            comparison: this.getComparisonPrompt(),
            responsive: this.getResponsivePrompt()
        };
    }

    /**
     * Полный визуальный анализ скриншота
     */
    async analyzeScreenshot(screenshotPath, metadata = {}) {
        if (!this.enabled) {
            return { skipped: true, reason: 'AI-анализ отключён (нет API ключа)' };
        }

        const imageData = await this.loadImage(screenshotPath);
        if (!imageData) {
            return { error: 'Не удалось загрузить изображение' };
        }

        try {
            // Rate limiting для защиты от 429 ошибок
            await this.rateLimiter.acquire();

            // API запрос с timeout
            const response = await withTimeout(
                this.client.messages.create({
                model: this.model,
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: imageData
                            }
                        },
                        {
                            type: 'text',
                            text: this.prompts.visualQA.replace(
                                '{{METADATA}}',
                                JSON.stringify(metadata, null, 2)
                            )
                        }
                    ]
                }]
            }),
                this.timeout,
                'AI Screenshot Analysis'
            );

            return this.parseAnalysisResponse(response.content[0].text);

        } catch (error) {
            console.error('Ошибка AI-анализа:', error.message);
            // Добавляем информацию о типе ошибки для отладки
            const isTimeout = error.message.includes('timed out');
            const isRateLimit = error.message.includes('rate') || error.status === 429;
            return {
                error: error.message,
                errorType: isTimeout ? 'timeout' : isRateLimit ? 'rate_limit' : 'api_error',
                retryable: isTimeout || isRateLimit
            };
        }
    }

    /**
     * Сравнение двух скриншотов (текущий vs baseline)
     */
    async compareScreenshots(currentPath, baselinePath, metadata = {}) {
        if (!this.enabled) {
            return { skipped: true, reason: 'AI-анализ отключён' };
        }

        const currentImage = await this.loadImage(currentPath);
        const baselineImage = await this.loadImage(baselinePath);

        if (!currentImage || !baselineImage) {
            return { error: 'Не удалось загрузить изображения для сравнения' };
        }

        try {
            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'BASELINE (эталон):'
                        },
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: baselineImage
                            }
                        },
                        {
                            type: 'text',
                            text: 'ТЕКУЩИЙ СКРИНШОТ:'
                        },
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: currentImage
                            }
                        },
                        {
                            type: 'text',
                            text: this.prompts.comparison.replace(
                                '{{METADATA}}',
                                JSON.stringify(metadata, null, 2)
                            )
                        }
                    ]
                }]
            });

            return this.parseComparisonResponse(response.content[0].text);

        } catch (error) {
            console.error('Ошибка AI-сравнения:', error.message);
            return { error: error.message };
        }
    }

    /**
     * Анализ accessibility
     */
    async analyzeAccessibility(screenshotPath, metadata = {}) {
        if (!this.enabled) {
            return { skipped: true };
        }

        const imageData = await this.loadImage(screenshotPath);
        if (!imageData) return { error: 'Не удалось загрузить изображение' };

        try {
            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: 'image/png',
                                data: imageData
                            }
                        },
                        {
                            type: 'text',
                            text: this.prompts.accessibility
                        }
                    ]
                }]
            });

            return this.parseAccessibilityResponse(response.content[0].text);

        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Загрузка и кодирование изображения в base64
     */
    async loadImage(imagePath) {
        try {
            const buffer = await fs.readFile(imagePath);
            return buffer.toString('base64');
        } catch (error) {
            console.error(`Ошибка загрузки изображения ${imagePath}:`, error.message);
            return null;
        }
    }

    /**
     * Парсинг ответа анализа
     */
    parseAnalysisResponse(text) {
        try {
            // Пытаемся найти JSON в ответе
            const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1]);
            }

            // Если JSON не найден, структурируем текстовый ответ
            return {
                raw: text,
                issues: this.extractIssuesFromText(text),
                summary: text.substring(0, 500)
            };
        } catch (error) {
            return { raw: text, parseError: true };
        }
    }

    /**
     * Парсинг ответа сравнения
     */
    parseComparisonResponse(text) {
        const result = this.parseAnalysisResponse(text);
        result.isComparison = true;
        return result;
    }

    /**
     * Парсинг ответа accessibility
     */
    parseAccessibilityResponse(text) {
        const result = this.parseAnalysisResponse(text);
        result.checkType = 'accessibility';
        return result;
    }

    /**
     * Извлечение проблем из текстового ответа
     */
    extractIssuesFromText(text) {
        const issues = [];
        const lines = text.split('\n');

        const severityKeywords = {
            critical: ['критич', 'critical', 'блокир', 'серьёзн', 'major'],
            warning: ['warning', 'предупрежд', 'внимание', 'minor'],
            info: ['info', 'информац', 'рекомендац', 'suggestion']
        };

        for (const line of lines) {
            const lowerLine = line.toLowerCase();

            for (const [severity, keywords] of Object.entries(severityKeywords)) {
                if (keywords.some(kw => lowerLine.includes(kw))) {
                    issues.push({
                        severity,
                        message: line.trim(),
                        source: 'ai-analysis'
                    });
                    break;
                }
            }
        }

        return issues;
    }

    /**
     * Промпт для визуального QA
     */
    getVisualQAPrompt() {
        return `Ты - эксперт по визуальному тестированию веб-интерфейсов.

Проанализируй этот скриншот веб-страницы и найди ВСЕ визуальные проблемы.

Метаданные страницы:
{{METADATA}}

Проверь следующие аспекты:

1. **LAYOUT (Разметка)**
   - Есть ли элементы, вылезающие за границы экрана?
   - Есть ли наложение элементов друг на друга?
   - Правильно ли выровнены элементы?
   - Есть ли горизонтальный скролл (плохо для мобильных)?

2. **ТИПОГРАФИКА**
   - Читаем ли текст?
   - Достаточный ли размер шрифта?
   - Есть ли обрезанный текст?
   - Правильные ли межстрочные интервалы?

3. **ВИЗУАЛЬНАЯ ИЕРАРХИЯ**
   - Понятно ли, что главное на странице?
   - Есть ли визуальный шум?
   - Сбалансирована ли композиция?

4. **ЦВЕТА И КОНТРАСТ**
   - Достаточен ли контраст текста?
   - Гармоничны ли цвета?
   - Есть ли проблемы для дальтоников?

5. **ИНТЕРАКТИВНЫЕ ЭЛЕМЕНТЫ**
   - Понятно ли, что кнопки кликабельны?
   - Достаточного ли размера touch-targets?
   - Есть ли состояния hover/focus?

6. **ОБЩЕЕ ВПЕЧАТЛЕНИЕ**
   - Профессионально ли выглядит?
   - Есть ли явные баги?
   - Соответствует ли современным стандартам?

Ответь в формате JSON:
\`\`\`json
{
  "overall_score": 0-100,
  "status": "passed" | "warning" | "failed",
  "issues": [
    {
      "severity": "critical" | "warning" | "info",
      "category": "layout" | "typography" | "colors" | "interaction" | "other",
      "message": "Описание проблемы",
      "location": "Где на странице (примерно)",
      "recommendation": "Как исправить"
    }
  ],
  "positive_aspects": ["Что хорошо на странице"],
  "summary": "Краткое заключение на 2-3 предложения"
}
\`\`\``;
    }

    /**
     * Промпт для проверки accessibility
     */
    getAccessibilityPrompt() {
        return `Ты - эксперт по web accessibility (WCAG 2.1).

Проанализируй скриншот на соответствие стандартам доступности.

Проверь:

1. **КОНТРАСТ ТЕКСТА**
   - Соотношение контраста минимум 4.5:1 для обычного текста
   - Минимум 3:1 для крупного текста (18pt+ или 14pt bold)

2. **РАЗМЕРЫ ЭЛЕМЕНТОВ**
   - Touch targets минимум 44x44 пикселей
   - Достаточное расстояние между кликабельными элементами

3. **ВИЗУАЛЬНЫЕ ИНДИКАТОРЫ**
   - Информация не передаётся только цветом
   - Есть ли видимый focus indicator?
   - Иконки имеют подписи или очевидны?

4. **ЧИТАЕМОСТЬ**
   - Размер шрифта достаточен (минимум 16px для body)
   - Достаточные межстрочные интервалы
   - Текст не слишком длинный (max 80 символов на строку)

5. **НАВИГАЦИЯ**
   - Понятна ли структура страницы?
   - Есть ли skip links?
   - Логичен ли порядок элементов?

Ответь в формате JSON:
\`\`\`json
{
  "wcag_level": "A" | "AA" | "AAA" | "FAIL",
  "issues": [
    {
      "wcag_criterion": "1.4.3 Contrast",
      "severity": "critical" | "warning",
      "message": "Описание",
      "recommendation": "Как исправить"
    }
  ],
  "score": 0-100
}
\`\`\``;
    }

    /**
     * Промпт для сравнения скриншотов
     */
    getComparisonPrompt() {
        return `Ты - эксперт по визуальному регрессионному тестированию.

Сравни два скриншота:
1. BASELINE - эталонная версия (как должно быть)
2. ТЕКУЩИЙ - новая версия для проверки

Метаданные:
{{METADATA}}

Найди ВСЕ различия между скриншотами:

1. **СТРУКТУРНЫЕ ИЗМЕНЕНИЯ**
   - Добавлены/удалены элементы?
   - Изменился layout?
   - Сместились блоки?

2. **ВИЗУАЛЬНЫЕ ИЗМЕНЕНИЯ**
   - Изменились цвета?
   - Изменились шрифты?
   - Изменились размеры?

3. **КОНТЕНТ**
   - Изменился текст?
   - Изменились изображения?
   - Изменились иконки?

4. **ОЦЕНКА ИЗМЕНЕНИЙ**
   - Это намеренные улучшения?
   - Это регрессии (ухудшения)?
   - Это баги?

Ответь в формате JSON:
\`\`\`json
{
  "has_differences": true | false,
  "is_regression": true | false,
  "difference_percent": 0-100,
  "changes": [
    {
      "type": "addition" | "removal" | "modification",
      "severity": "critical" | "warning" | "info",
      "description": "Что изменилось",
      "location": "Где на странице",
      "is_intentional": true | false | "unknown"
    }
  ],
  "recommendation": "approve" | "review" | "reject",
  "summary": "Краткое описание изменений"
}
\`\`\``;
    }

    /**
     * Промпт для responsive проверки
     */
    getResponsivePrompt() {
        return `Проанализируй скриншот мобильной/планшетной версии сайта.

Проверь:
1. Адаптивность layout
2. Размеры touch-элементов (min 44px)
3. Читаемость текста без зума
4. Отсутствие горизонтального скролла
5. Правильность меню (burger menu если нужно)

Ответь в JSON формате с issues и recommendations.`;
    }
}

export default AIVisionAnalyzer;
