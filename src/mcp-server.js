#!/usr/bin/env node

/**
 * Visual QA Agent - MCP Server
 *
 * MCP-сервер для интеграции с Claude Code.
 * Предоставляет инструменты для визуального тестирования веб-интерфейсов.
 *
 * Инструменты:
 *   - visual_qa_check: Проверка страницы на всех устройствах
 *   - visual_qa_baseline: Создание эталонных скриншотов
 *   - visual_qa_compare: Сравнение с baseline
 *   - visual_qa_analyze: AI-анализ скриншота
 *   - visual_qa_devices: Список доступных устройств
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

import { VisualQAAgent } from './core/visual-agent.js';
import { AIVisionAnalyzer } from './analyzers/ai-vision-analyzer.js';
import { PixelComparator } from './analyzers/pixel-comparator.js';
import { HTMLReporter } from './reporters/html-reporter.js';
import { validateUrl, validateFilePath, findDeviceById } from './utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// Инициализация MCP сервера
const server = new Server(
    {
        name: 'visual-qa-agent',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
            resources: {},
        },
    }
);

// Глобальный агент (инициализируется при первом вызове)
let agent = null;
let aiAnalyzer = null;

async function getAgent() {
    if (!agent) {
        agent = new VisualQAAgent({
            configPath: path.join(PROJECT_ROOT, 'config'),
            baselinesPath: path.join(PROJECT_ROOT, 'baselines'),
            reportsPath: path.join(PROJECT_ROOT, 'reports'),
        });
        await agent.init();
    }
    return agent;
}

function getAIAnalyzer() {
    if (!aiAnalyzer) {
        aiAnalyzer = new AIVisionAnalyzer();
    }
    return aiAnalyzer;
}

// Определение инструментов
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'visual_qa_check',
                description: `Проверяет веб-страницу на визуальные проблемы на разных устройствах.

Делает скриншоты на выбранных устройствах (iPhone, iPad, Desktop и др.),
проверяет layout, типографику, accessibility и генерирует HTML-отчёт.

Профили:
- quick: 3 устройства, ~30 сек
- standard: 8 устройств, ~2 мин
- comprehensive: 15+ устройств, ~5 мин
- mobile_first: 7 мобильных устройств`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'URL страницы для проверки',
                        },
                        profile: {
                            type: 'string',
                            enum: ['quick', 'standard', 'comprehensive', 'mobile_first'],
                            description: 'Профиль проверки (по умолчанию: standard)',
                            default: 'standard',
                        },
                        ai_analysis: {
                            type: 'boolean',
                            description: 'Включить AI-анализ скриншотов (требует ANTHROPIC_API_KEY)',
                            default: false,
                        },
                        compare_baseline: {
                            type: 'boolean',
                            description: 'Сравнить с baseline если существует',
                            default: false,
                        },
                    },
                    required: ['url'],
                },
            },
            {
                name: 'visual_qa_baseline',
                description: `Создаёт эталонные скриншоты (baseline) для последующего сравнения.

Сохраняет скриншоты всех устройств выбранного профиля.
Используйте перед внесением изменений, чтобы потом сравнить.`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'URL страницы',
                        },
                        profile: {
                            type: 'string',
                            enum: ['quick', 'standard', 'comprehensive', 'mobile_first'],
                            description: 'Профиль устройств',
                            default: 'standard',
                        },
                    },
                    required: ['url'],
                },
            },
            {
                name: 'visual_qa_compare',
                description: `Сравнивает текущие скриншоты с baseline (эталоном).

Находит визуальные различия и генерирует diff-изображения.
Показывает процент изменений для каждого устройства.`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        baseline_dir: {
                            type: 'string',
                            description: 'Путь к директории с baseline скриншотами',
                        },
                        current_dir: {
                            type: 'string',
                            description: 'Путь к директории с текущими скриншотами',
                        },
                    },
                    required: ['baseline_dir', 'current_dir'],
                },
            },
            {
                name: 'visual_qa_analyze',
                description: `AI-анализ скриншота на визуальные проблемы.

Использует Claude Vision для обнаружения:
- UX/UI проблем
- Проблем с layout
- Accessibility нарушений
- Типографических ошибок`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        image_path: {
                            type: 'string',
                            description: 'Путь к скриншоту для анализа',
                        },
                        check_accessibility: {
                            type: 'boolean',
                            description: 'Фокус на проверке accessibility',
                            default: false,
                        },
                    },
                    required: ['image_path'],
                },
            },
            {
                name: 'visual_qa_devices',
                description: 'Показывает список доступных устройств и профилей тестирования.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'visual_qa_audit_clickables',
                description: `Полный аудит всех кликабельных элементов на странице.

Проверяет каждый интерактивный элемент (кнопки, ссылки, input'ы, select'ы) на:
- Размер touch target (минимум 44px для мобильных)
- Наличие accessible name (aria-label, текст)
- Выход за пределы viewport
- Наложение с другими кликабельными элементами
- Видимость

Возвращает детальный отчёт по каждому элементу.`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'URL страницы для аудита',
                        },
                        device: {
                            type: 'string',
                            enum: ['iphone_14_pro', 'ipad_pro_11', 'laptop_full_hd', 'desktop_4k'],
                            description: 'Устройство для проверки (по умолчанию: iphone_14_pro)',
                            default: 'iphone_14_pro',
                        },
                    },
                    required: ['url'],
                },
            },
        ],
    };
});

// Обработка вызовов инструментов
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            case 'visual_qa_check': {
                const agent = await getAgent();
                const url = args.url;
                const profile = args.profile || 'standard';
                const aiAnalysis = args.ai_analysis || false;
                const compareBaseline = args.compare_baseline || false;

                // Проверка страницы (теперь возвращает структурированные issues с fix-ами)
                const results = await agent.checkPage(url, { profile });

                // AI-анализ если включён
                if (aiAnalysis) {
                    const analyzer = getAIAnalyzer();
                    if (analyzer.enabled) {
                        for (const check of results.checks) {
                            if (check.screenshot) {
                                const analysis = await analyzer.analyzeScreenshot(
                                    check.screenshot,
                                    { device: check.device, browser: check.browser, url }
                                );
                                if (analysis.issues) {
                                    check.issues = [...(check.issues || []), ...analysis.issues];
                                }
                                check.aiAnalysis = analysis;
                            }
                        }
                    }
                }

                // Сравнение с baseline
                if (compareBaseline) {
                    const comparator = new PixelComparator();
                    const baselineDir = path.join(PROJECT_ROOT, 'baselines', agent.urlToSlug(url));

                    if (await fs.pathExists(baselineDir)) {
                        for (const check of results.checks) {
                            if (check.screenshot) {
                                const deviceSlug = check.device?.toLowerCase().replace(/\s+/g, '_').replace(/"/g, '');
                                const baselinePath = path.join(baselineDir, `${deviceSlug}_${check.browser}.png`);

                                if (await fs.pathExists(baselinePath)) {
                                    const diffPath = check.screenshot.replace('.png', '_diff.png');
                                    const comparison = await comparator.compare(baselinePath, check.screenshot, diffPath);
                                    check.comparison = comparator.analyzeResults(comparison);
                                    check.diffPercent = comparison.diffPercent;
                                }
                            }
                        }
                    }
                }

                // Генерация отчёта
                const reporter = new HTMLReporter({ outputDir: path.join(PROJECT_ROOT, 'reports') });
                const reportPath = await reporter.generate(results);

                // Сохраняем JSON с issues для машинной обработки
                const jsonResultsPath = path.join(path.dirname(reportPath), 'results.json');
                await fs.writeJSON(jsonResultsPath, results, { spaces: 2 });

                // Формируем машиночитаемый ответ с actionable fixes
                const machineReadableResponse = {
                    status: results.summary.blocks_release ? 'blocked' :
                            results.summary.failed > 0 ? 'failed' :
                            results.summary.warnings > 0 ? 'warning' : 'passed',
                    url,
                    profile,
                    summary: results.summary,
                    action_summary: results.action_summary,
                    // Структурированные проблемы с конкретными fix-ами
                    issues: results.issues.map(issue => ({
                        id: issue.id,
                        type: issue.type,
                        severity: issue.severity,
                        title: issue.title,
                        description: issue.description,
                        affected_devices: issue.affected_devices,
                        element: issue.element ? {
                            selector: issue.element.selector,
                            tag: issue.element.tag
                        } : null,
                        fix: issue.fix, // Содержит action, target, suggestion, css/html код
                        wcag: issue.wcag,
                        blocks_release: issue.blocks_release
                    })),
                    checks: results.checks.map(c => ({
                        device: c.device,
                        device_id: c.device_id,
                        browser: c.browser,
                        viewport: c.viewport,
                        is_mobile: c.is_mobile,
                        status: c.status,
                        issues_count: c.issues_count || 0,
                        screenshot: c.screenshot,
                        diffPercent: c.diffPercent
                    })),
                    report_path: reportPath,
                    json_results_path: jsonResultsPath
                };

                // Текстовая сводка + JSON для агента
                let issuesList = '';
                if (results.issues.length > 0) {
                    issuesList = '\n### Найденные проблемы с исправлениями\n\n';
                    for (const issue of results.issues) {
                        const devicesList = issue.affected_devices?.join(', ') || issue.device;
                        issuesList += `#### ${issue.severity === 'critical' ? '🔴' : '🟡'} ${issue.title}\n`;
                        issuesList += `- **Тип:** ${issue.type}\n`;
                        issuesList += `- **Устройства:** ${devicesList}\n`;
                        issuesList += `- **Описание:** ${issue.description}\n`;
                        if (issue.fix) {
                            issuesList += `- **Исправление:** ${issue.fix.suggestion}\n`;
                            if (issue.fix.css) {
                                issuesList += `\`\`\`css\n${issue.fix.css}\n\`\`\`\n`;
                            }
                            if (issue.fix.html) {
                                issuesList += `\`\`\`html\n${issue.fix.html}\n\`\`\`\n`;
                            }
                        }
                        issuesList += '\n';
                    }
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: `## Результаты визуальной проверки

**URL:** ${url}
**Профиль:** ${profile}
**Статус:** ${machineReadableResponse.status === 'blocked' ? '🛑 БЛОКИРУЕТ РЕЛИЗ' :
              machineReadableResponse.status === 'failed' ? '❌ Есть ошибки' :
              machineReadableResponse.status === 'warning' ? '⚠️ Есть предупреждения' : '✅ Пройдено'}

### Сводка
- ✅ Пройдено: ${results.summary.passed}
- ⚠️ Предупреждений: ${results.summary.warnings}
- ❌ Ошибок: ${results.summary.failed}
- 📋 Всего проблем: ${results.issues.length}

${results.action_summary ? `### Действия\n${results.action_summary.action_required}\n` : ''}
${issuesList}
### Проверки по устройствам
${machineReadableResponse.checks.map(c =>
    `- **${c.device}** (${c.browser}): ${c.status}${c.issues_count > 0 ? ` - ${c.issues_count} проблем` : ''}${c.diffPercent !== undefined ? ` - diff: ${c.diffPercent}%` : ''}`
).join('\n')}

### Файлы
- HTML-отчёт: \`${reportPath}\`
- JSON результаты: \`${jsonResultsPath}\`

---
**Машиночитаемый JSON для автоматической обработки:**
\`\`\`json
${JSON.stringify(machineReadableResponse, null, 2)}
\`\`\``,
                        },
                    ],
                };
            }

            case 'visual_qa_baseline': {
                const agent = await getAgent();
                const url = args.url;
                const profile = args.profile || 'standard';

                const baselinePath = await agent.saveBaseline(url, { profile });

                return {
                    content: [
                        {
                            type: 'text',
                            text: `## Baseline создан

**URL:** ${url}
**Профиль:** ${profile}
**Путь:** \`${baselinePath}\`

Теперь вы можете использовать \`visual_qa_check\` с параметром \`compare_baseline: true\` для сравнения.`,
                        },
                    ],
                };
            }

            case 'visual_qa_compare': {
                const comparator = new PixelComparator();
                const outputDir = path.join(PROJECT_ROOT, 'reports', 'diff');

                const results = await comparator.compareDirectories(
                    args.baseline_dir,
                    args.current_dir,
                    outputDir
                );

                await fs.writeJSON(path.join(outputDir, 'comparison.json'), results, { spaces: 2 });

                return {
                    content: [
                        {
                            type: 'text',
                            text: `## Результаты сравнения

### Сводка
- ✓ Совпадает: ${results.summary.matched}
- ✗ Различается: ${results.summary.different}
- ➕ Новых: ${results.summary.new}
- ➖ Отсутствует: ${results.summary.missing}

### Детали
${results.comparisons.map(c => {
    if (c.status === 'matched') return `- ✓ ${c.file}: идентичны`;
    if (c.status === 'different') return `- ✗ ${c.file}: различия ${c.diffPercent}%`;
    if (c.status === 'new') return `- ➕ ${c.file}: новый файл`;
    if (c.status === 'missing') return `- ➖ ${c.file}: отсутствует`;
    return `- ? ${c.file}: ${c.status}`;
}).join('\n')}

Diff-изображения сохранены в: \`${outputDir}\``,
                        },
                    ],
                };
            }

            case 'visual_qa_analyze': {
                const analyzer = getAIAnalyzer();

                if (!analyzer.enabled) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: '❌ AI-анализ недоступен. Установите переменную окружения ANTHROPIC_API_KEY.',
                            },
                        ],
                    };
                }

                // Валидация пути к файлу (защита от path traversal)
                const safePath = validateFilePath(args.image_path, PROJECT_ROOT);

                let results;
                if (args.check_accessibility) {
                    results = await analyzer.analyzeAccessibility(safePath);
                } else {
                    results = await analyzer.analyzeScreenshot(safePath);
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: `## AI-анализ скриншота

**Файл:** \`${args.image_path}\`
**Тип проверки:** ${args.check_accessibility ? 'Accessibility' : 'Визуальный QA'}

### Результаты

${JSON.stringify(results, null, 2)}`,
                        },
                    ],
                };
            }

            case 'visual_qa_devices': {
                const agent = await getAgent();
                const { device_profiles, test_profiles } = agent.devices;

                let output = '## Доступные профили тестирования\n\n';

                for (const [name, profile] of Object.entries(test_profiles)) {
                    const deviceCount = profile.devices === 'all' ? 'все' : profile.devices.length;
                    output += `### ${name}\n`;
                    output += `- ${profile.description}\n`;
                    output += `- Браузеры: ${profile.browsers.join(', ')}\n`;
                    output += `- Устройств: ${deviceCount}\n\n`;
                }

                output += '## Все устройства\n\n';

                for (const [category, devices] of Object.entries(device_profiles)) {
                    output += `### ${category.toUpperCase()}\n`;
                    for (const [id, device] of Object.entries(devices)) {
                        output += `- **${device.name}** (${device.viewport.width}x${device.viewport.height})\n`;
                    }
                    output += '\n';
                }

                return {
                    content: [{ type: 'text', text: output }],
                };
            }

            case 'visual_qa_audit_clickables': {
                const agent = await getAgent();
                const url = args.url;
                const deviceId = args.device || 'iphone_14_pro';

                // Валидация URL
                validateUrl(url);

                // Находим устройство (используем helper)
                const device = findDeviceById(agent.devices.device_profiles, deviceId);
                if (!device) {
                    throw new Error(`Устройство ${deviceId} не найдено`);
                }

                // Захватываем страницу
                const { page, browser } = await agent.captureScreenshot(url, device, 'chromium', true);

                try {
                    // Выполняем аудит
                    const audit = await agent.issueDetector.auditClickableElements(page, device);

                    // Формируем отчёт
                    let output = `## 🔍 Аудит кликабельных элементов

**URL:** ${url}
**Устройство:** ${device.name} (${device.viewport.width}x${device.viewport.height})
**Touch device:** ${device.is_mobile || device.has_touch ? 'Да' : 'Нет'}

---

### 📊 Сводка

| Метрика | Значение |
|---------|----------|
| Всего элементов | ${audit.total} |
| ✅ Без проблем | ${audit.valid?.length || 0} |
| ⚠️ С проблемами | ${audit.issues?.length || 0} |

### 🚨 Проблемы по типам

| Тип | Количество |
|-----|------------|
| 📏 Слишком маленькие | ${audit.summary?.too_small || 0} |
| 🏷️ Без label | ${audit.summary?.no_label || 0} |
| 📤 За пределами экрана | ${audit.summary?.outside_viewport || 0} |
| 🔄 Наложения | ${audit.summary?.overlapping || 0} |
| 👻 Скрытые | ${audit.summary?.hidden || 0} |

`;

                    if (audit.issues && audit.issues.length > 0) {
                        output += `### ❌ Элементы с проблемами (${audit.issues.length})\n\n`;

                        for (const el of audit.issues) {
                            output += `#### ${el.tag}${el.type ? `[type="${el.type}"]` : ''}: \`${el.selector}\`\n`;
                            output += `- **Текст:** "${el.name || '(пусто)'}"\n`;
                            output += `- **Позиция:** x=${el.rect.x}, y=${el.rect.y}\n`;
                            output += `- **Размер:** ${el.rect.width}x${el.rect.height}px (min: ${el.size}px)\n`;
                            output += `- **Проблемы:**\n`;
                            for (const issue of el.issues) {
                                const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'warning' ? '🟡' : '🔵';
                                output += `  - ${icon} ${issue.message}\n`;
                            }
                            output += '\n';
                        }
                    }

                    if (audit.valid && audit.valid.length > 0) {
                        output += `### ✅ Корректные элементы (${audit.valid.length})\n\n`;
                        output += '| Элемент | Селектор | Текст | Размер |\n';
                        output += '|---------|----------|-------|--------|\n';

                        for (const el of audit.valid.slice(0, 20)) {
                            output += `| ${el.tag} | \`${el.selector}\` | ${el.name?.substring(0, 20) || '-'} | ${el.rect.width}x${el.rect.height} |\n`;
                        }

                        if (audit.valid.length > 20) {
                            output += `\n*...и ещё ${audit.valid.length - 20} элементов*\n`;
                        }
                    }

                    // JSON для автоматической обработки
                    output += `\n---\n**Машиночитаемый JSON:**\n\`\`\`json\n${JSON.stringify(audit, null, 2)}\n\`\`\``;

                    return {
                        content: [{ type: 'text', text: output }],
                    };
                } finally {
                    await browser.close();
                }
            }

            default:
                throw new Error(`Неизвестный инструмент: ${name}`);
        }
    } catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: `❌ Ошибка: ${error.message}\n\n${error.stack}`,
                },
            ],
            isError: true,
        };
    }
});

// Ресурсы (последний отчёт, стандарты качества)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
            {
                uri: 'visual-qa://reports/latest',
                name: 'Последний отчёт',
                description: 'JSON-данные последней проверки',
                mimeType: 'application/json',
            },
            {
                uri: 'visual-qa://config/standards',
                name: 'Стандарты качества',
                description: 'Текущие настройки стандартов качества',
                mimeType: 'application/json',
            },
        ],
    };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'visual-qa://reports/latest') {
        const resultsPath = path.join(PROJECT_ROOT, 'reports', 'latest', 'results.json');
        if (await fs.pathExists(resultsPath)) {
            const data = await fs.readJSON(resultsPath);
            return {
                contents: [
                    {
                        uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(data, null, 2),
                    },
                ],
            };
        }
        return {
            contents: [
                {
                    uri,
                    mimeType: 'application/json',
                    text: '{"error": "Отчёт не найден. Сначала выполните проверку."}',
                },
            ],
        };
    }

    if (uri === 'visual-qa://config/standards') {
        const standardsPath = path.join(PROJECT_ROOT, 'config', 'quality-standards.json');
        const data = await fs.readJSON(standardsPath);
        return {
            contents: [
                {
                    uri,
                    mimeType: 'application/json',
                    text: JSON.stringify(data, null, 2),
                },
            ],
        };
    }

    throw new Error(`Неизвестный ресурс: ${uri}`);
});

// Запуск сервера
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Visual QA Agent MCP Server запущен');
}

main().catch((error) => {
    console.error('Ошибка запуска MCP сервера:', error);
    process.exit(1);
});
