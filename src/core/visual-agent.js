/**
 * VisualQAAgent - Ядро агента визуальной проверки
 *
 * Основной класс, координирующий все проверки:
 * - Скриншоты через Playwright
 * - Pixel-perfect сравнение
 * - AI-анализ визуальных проблем
 * - Проверка accessibility
 */

import { chromium, firefox, webkit } from '@playwright/test';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { IssueDetector } from './issue-detector.js';
import { validateUrl, findDeviceById } from '../utils/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class VisualQAAgent {
    constructor(options = {}) {
        this.configPath = options.configPath || path.join(__dirname, '../../config');
        this.baselinesPath = options.baselinesPath || path.join(__dirname, '../../baselines');
        this.reportsPath = options.reportsPath || path.join(__dirname, '../../reports');

        this.standards = null;
        this.devices = null;
        this.browsers = { chromium, firefox, webkit };
        this.issueDetector = null; // Инициализируется в init()

        this.results = {
            passed: [],
            failed: [],
            warnings: [],
            info: []
        };
    }

    /**
     * Инициализация агента - загрузка конфигураций
     */
    async init() {
        // Загружаем стандарты качества
        const standardsPath = path.join(this.configPath, 'quality-standards.json');
        this.standards = await fs.readJSON(standardsPath);

        // Загружаем профили устройств
        const devicesPath = path.join(this.configPath, 'devices.json');
        this.devices = await fs.readJSON(devicesPath);

        // Инициализируем детектор проблем
        this.issueDetector = new IssueDetector(this.standards);

        // Создаём директории если их нет
        await fs.ensureDir(this.baselinesPath);
        await fs.ensureDir(this.reportsPath);

        console.log('✓ VisualQAAgent инициализирован');
        return this;
    }

    /**
     * Получение устройств для тестирования по профилю
     */
    getDevicesForProfile(profileName) {
        const profile = this.devices.test_profiles[profileName];
        if (!profile) {
            throw new Error(`Профиль "${profileName}" не найден`);
        }

        const devicesList = [];
        const deviceProfiles = this.devices.device_profiles;

        if (profile.devices === 'all') {
            // Все устройства
            for (const category of Object.values(deviceProfiles)) {
                for (const [id, device] of Object.entries(category)) {
                    devicesList.push({ id, ...device });
                }
            }
        } else {
            // Конкретные устройства
            for (const deviceId of profile.devices) {
                for (const category of Object.values(deviceProfiles)) {
                    if (category[deviceId]) {
                        devicesList.push({ id: deviceId, ...category[deviceId] });
                        break;
                    }
                }
            }
        }

        return { devices: devicesList, browsers: profile.browsers };
    }

    /**
     * Захват скриншота страницы
     * @param {boolean} keepOpen - не закрывать браузер (для дальнейшего анализа)
     * @param {string} colorScheme - цветовая схема: 'light', 'dark', 'no-preference'
     */
    async captureScreenshot(url, device, browserType = 'chromium', keepOpen = false, colorScheme = 'light') {
        // Валидация URL
        validateUrl(url);

        const browser = await this.browsers[browserType].launch({ headless: true });

        const contextOptions = {
            viewport: device.viewport,
            deviceScaleFactor: device.device_scale_factor || 1,
            isMobile: device.is_mobile || false,
            hasTouch: device.has_touch || false,
            userAgent: device.user_agent,
            colorScheme: colorScheme // Эмуляция prefers-color-scheme
        };

        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        try {
            // Переходим на страницу с ожиданием загрузки
            await page.goto(url, {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            // Ждём стабилизации (анимации, lazy-load)
            await page.waitForTimeout(500);

            // Делаем скриншот
            const screenshot = await page.screenshot({
                fullPage: true,
                type: 'png'
            });

            // Собираем метаданные
            const metadata = {
                url,
                device: device.id,
                browser: browserType,
                viewport: device.viewport,
                timestamp: new Date().toISOString(),
                title: await page.title()
            };

            // Если keepOpen=true, возвращаем browser и page для дальнейшей работы
            if (keepOpen) {
                return { screenshot, metadata, page, browser };
            }

            return { screenshot, metadata, page: null, browser: null };

        } finally {
            if (!keepOpen) {
                await browser.close();
            }
        }
    }

    /**
     * Захват логов консоли браузера (F12 Console)
     * Перехватывает: console.log/warn/error/info, JS ошибки, network failures
     * @param {string} url - URL страницы
     * @param {Object} options - опции
     * @param {number} options.waitTime - время ожидания после загрузки (мс)
     * @param {boolean} options.includeNetwork - включить сетевые ошибки
     * @param {string} options.browserType - тип браузера
     */
    async captureConsole(url, options = {}) {
        const {
            waitTime = 3000,
            includeNetwork = true,
            browserType = 'chromium'
        } = options;

        // Валидация URL
        validateUrl(url);

        const browser = await this.browsers[browserType].launch({ headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();

        // Собираем все события консоли
        const consoleLogs = [];
        const jsErrors = [];
        const networkErrors = [];
        const securityWarnings = [];

        // Перехват console.log/warn/error/info
        page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();
            const location = msg.location();

            consoleLogs.push({
                type: type,
                text: text,
                url: location.url || '',
                line: location.lineNumber,
                column: location.columnNumber,
                timestamp: new Date().toISOString()
            });
        });

        // Перехват необработанных JS ошибок
        page.on('pageerror', error => {
            jsErrors.push({
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
        });

        // Перехват ошибок запросов (network failures)
        if (includeNetwork) {
            page.on('requestfailed', request => {
                networkErrors.push({
                    url: request.url(),
                    method: request.method(),
                    failure: request.failure()?.errorText || 'Unknown error',
                    resourceType: request.resourceType(),
                    timestamp: new Date().toISOString()
                });
            });

            // Перехват ответов с ошибками (4xx, 5xx)
            page.on('response', response => {
                const status = response.status();
                if (status >= 400) {
                    networkErrors.push({
                        url: response.url(),
                        status: status,
                        statusText: response.statusText(),
                        resourceType: response.request().resourceType(),
                        timestamp: new Date().toISOString()
                    });
                }
            });
        }

        // Перехват security warnings (mixed content и т.д.)
        context.on('console', msg => {
            if (msg.text().toLowerCase().includes('security') ||
                msg.text().toLowerCase().includes('mixed content') ||
                msg.text().toLowerCase().includes('insecure')) {
                securityWarnings.push({
                    message: msg.text(),
                    timestamp: new Date().toISOString()
                });
            }
        });

        try {
            // Переходим на страницу
            const response = await page.goto(url, {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            // Ждём указанное время для сбора runtime ошибок
            await page.waitForTimeout(waitTime);

            // Получаем performance metrics
            const performanceMetrics = await page.evaluate(() => {
                const perf = performance.getEntriesByType('navigation')[0];
                const paint = performance.getEntriesByType('paint');

                return {
                    // Время загрузки
                    domContentLoaded: perf?.domContentLoadedEventEnd - perf?.startTime,
                    loadComplete: perf?.loadEventEnd - perf?.startTime,
                    // First Paint / First Contentful Paint
                    firstPaint: paint.find(p => p.name === 'first-paint')?.startTime,
                    firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime,
                    // Размеры
                    transferSize: perf?.transferSize,
                    encodedBodySize: perf?.encodedBodySize,
                    decodedBodySize: perf?.decodedBodySize
                };
            });

            // Получаем deprecated API warnings
            const deprecationWarnings = await page.evaluate(() => {
                // Проверяем известные deprecated features
                const warnings = [];

                if (typeof document.all !== 'undefined') {
                    warnings.push('document.all is deprecated');
                }

                return warnings;
            });

            // Классифицируем логи по severity
            const classify = (logs) => {
                return {
                    errors: logs.filter(l => l.type === 'error'),
                    warnings: logs.filter(l => l.type === 'warning'),
                    info: logs.filter(l => l.type === 'info' || l.type === 'log'),
                    debug: logs.filter(l => l.type === 'debug'),
                    other: logs.filter(l => !['error', 'warning', 'info', 'log', 'debug'].includes(l.type))
                };
            };

            const classified = classify(consoleLogs);

            // Формируем результат
            const result = {
                url,
                browserType,
                timestamp: new Date().toISOString(),
                pageInfo: {
                    title: await page.title(),
                    status: response?.status(),
                    ok: response?.ok()
                },
                summary: {
                    total_logs: consoleLogs.length,
                    errors: classified.errors.length + jsErrors.length,
                    warnings: classified.warnings.length + securityWarnings.length,
                    network_errors: networkErrors.length,
                    has_critical: jsErrors.length > 0 || networkErrors.some(e => e.status >= 500)
                },
                console: {
                    all: consoleLogs,
                    ...classified
                },
                jsErrors,
                networkErrors,
                securityWarnings,
                deprecationWarnings,
                performance: performanceMetrics
            };

            return result;

        } finally {
            await browser.close();
        }
    }

    /**
     * Проверка страницы на всех устройствах профиля
     * Возвращает машиночитаемый JSON с actionable fixes
     * @param {string} url - URL для проверки
     * @param {Object} options - опции проверки
     * @param {string} options.profile - профиль устройств
     * @param {boolean} options.checkDarkMode - проверять также в тёмном режиме
     */
    async checkPage(url, options = {}) {
        const { profile = 'standard', saveBaseline = false, checkDarkMode = false } = options;
        const { devices, browsers } = this.getDevicesForProfile(profile);

        // Режимы для проверки
        const colorSchemes = checkDarkMode ? ['light', 'dark'] : ['light'];

        // Все найденные проблемы со всех устройств
        const allIssues = [];

        const results = {
            url,
            profile,
            timestamp: new Date().toISOString(),
            checks: [],
            issues: [], // Новое: структурированные проблемы с fix-ами
            summary: {
                total: 0,
                passed: 0,
                failed: 0,
                warnings: 0,
                blocks_release: false
            },
            action_summary: null // Сводка для агента
        };

        for (const colorScheme of colorSchemes) {
            const schemeLabel = colorScheme === 'dark' ? '🌙' : '☀️';

            for (const browserType of browsers) {
                for (const device of devices) {
                    console.log(`  ${schemeLabel} 📱 ${device.name} (${browserType}, ${colorScheme})...`);

                    let browser = null;
                    try {
                        // Захватываем с keepOpen=true для анализа
                        const { screenshot, metadata, page, browser: br } = await this.captureScreenshot(
                            url, device, browserType, true, colorScheme
                        );
                        browser = br;

                        // Добавляем colorScheme в metadata
                        metadata.colorScheme = colorScheme;

                        const schemeSuffix = colorScheme === 'dark' ? '_dark' : '';
                        const checkId = `${device.id}_${browserType}${schemeSuffix}`;
                        const screenshotPath = path.join(
                            this.reportsPath,
                            'screenshots',
                            `${checkId}_${Date.now()}.png`
                        );

                        await fs.ensureDir(path.dirname(screenshotPath));
                        await fs.writeFile(screenshotPath, screenshot);

                        // Детектируем проблемы через IssueDetector (пока page открыт!)
                        const detectedIssues = await this.issueDetector.detectIssues(page, device, metadata);

                        // Помечаем проблемы как относящиеся к dark mode
                        if (colorScheme === 'dark') {
                            detectedIssues.forEach(issue => {
                                issue.colorScheme = 'dark';
                                issue.title = `[Dark Mode] ${issue.title}`;
                            });
                        }

                        allIssues.push(...detectedIssues);

                        // Базовые проверки
                        const checkResults = await this.runChecks(screenshot, metadata, device);

                        // Определяем статус на основе найденных проблем
                        const hasCritical = detectedIssues.some(i => i.severity === 'critical');
                        const hasWarnings = detectedIssues.some(i => i.severity === 'warning');

                        let status = 'passed';
                        if (hasCritical) status = 'failed';
                        else if (hasWarnings) status = 'warning';

                        const deviceLabel = colorScheme === 'dark' ? `${device.name} (Dark)` : device.name;

                        results.checks.push({
                            device: deviceLabel,
                            device_id: device.id,
                            browser: browserType,
                            viewport: device.viewport,
                            is_mobile: device.is_mobile || false,
                            colorScheme: colorScheme,
                            screenshot: screenshotPath,
                            status,
                            issues_count: detectedIssues.length,
                            ...checkResults
                        });

                        results.summary.total++;
                        if (status === 'passed') results.summary.passed++;
                        else if (status === 'failed') results.summary.failed++;
                        else results.summary.warnings++;

                    } catch (error) {
                        console.error(`    ✗ Ошибка: ${error.message}`);
                        const deviceLabel = colorScheme === 'dark' ? `${device.name} (Dark)` : device.name;
                        results.checks.push({
                            device: deviceLabel,
                            device_id: device.id,
                            browser: browserType,
                            colorScheme: colorScheme,
                            status: 'error',
                            error: error.message
                        });
                        results.summary.failed++;
                    } finally {
                        // Закрываем браузер после анализа
                        if (browser) {
                            await browser.close();
                        }
                    }
                }
            }
        }

        // Дедупликация проблем (одна проблема может быть на нескольких устройствах)
        results.issues = this.deduplicateIssues(allIssues);

        // Определяем блокирует ли релиз
        results.summary.blocks_release = results.issues.some(i => i.blocks_release);

        // Генерируем сводку для агента
        results.action_summary = this.issueDetector.generateSummaryForAgent(results.issues);

        return results;
    }

    /**
     * Дедупликация проблем (объединение одинаковых с разных устройств)
     */
    deduplicateIssues(issues) {
        const seen = new Map();

        for (const issue of issues) {
            // Ключ для дедупликации: тип + элемент
            const key = `${issue.type}-${issue.element?.selector || issue.title}`;

            if (seen.has(key)) {
                // Добавляем устройство к существующей проблеме
                const existing = seen.get(key);
                if (!existing.affected_devices) {
                    existing.affected_devices = [existing.device];
                }
                if (!existing.affected_devices.includes(issue.device)) {
                    existing.affected_devices.push(issue.device);
                }
            } else {
                seen.set(key, { ...issue, affected_devices: [issue.device] });
            }
        }

        return Array.from(seen.values());
    }

    /**
     * Запуск всех проверок для скриншота
     */
    async runChecks(screenshot, metadata, device) {
        const issues = [];
        let status = 'passed';

        // 1. Проверка размеров (горизонтальный скролл)
        const layoutCheck = this.checkLayout(metadata, device);
        if (layoutCheck.issues.length > 0) {
            issues.push(...layoutCheck.issues);
            if (layoutCheck.hasCritical) status = 'failed';
            else if (status !== 'failed') status = 'warning';
        }

        // 2. Базовые визуальные проверки (будут расширены AI-анализатором)
        const visualCheck = await this.basicVisualCheck(screenshot, metadata);
        if (visualCheck.issues.length > 0) {
            issues.push(...visualCheck.issues);
        }

        return {
            status,
            issues,
            metrics: {
                screenshotSize: screenshot.length,
                checkTime: new Date().toISOString()
            }
        };
    }

    /**
     * Проверка layout (размеры, скролл)
     */
    checkLayout(metadata, device) {
        const issues = [];
        let hasCritical = false;
        const standards = this.standards.responsiveness;

        // Проверка на соответствие viewport
        if (metadata.viewport) {
            if (metadata.viewport.width !== device.viewport.width) {
                issues.push({
                    type: 'layout',
                    severity: 'warning',
                    message: `Ширина viewport не соответствует: ожидалось ${device.viewport.width}px, получено ${metadata.viewport.width}px`
                });
            }
        }

        return { issues, hasCritical };
    }

    /**
     * Базовая визуальная проверка
     */
    async basicVisualCheck(screenshot, metadata) {
        const issues = [];

        // Проверка что скриншот не пустой
        if (screenshot.length < 1000) {
            issues.push({
                type: 'visual',
                severity: 'critical',
                message: 'Скриншот слишком маленький - возможно страница не загрузилась'
            });
        }

        return { issues };
    }

    /**
     * Сохранение baseline скриншотов для сравнения
     */
    async saveBaseline(url, options = {}) {
        const { profile = 'standard' } = options;
        const { devices, browsers } = this.getDevicesForProfile(profile);

        const urlSlug = this.urlToSlug(url);
        const baselinePath = path.join(this.baselinesPath, urlSlug);
        await fs.ensureDir(baselinePath);

        console.log(`📸 Сохранение baseline для ${url}`);

        for (const browserType of browsers) {
            for (const device of devices) {
                console.log(`  → ${device.name} (${browserType})...`);

                const { screenshot, metadata } = await this.captureScreenshot(
                    url, device, browserType
                );

                const filename = `${device.id}_${browserType}.png`;
                await fs.writeFile(path.join(baselinePath, filename), screenshot);

                // Сохраняем метаданные
                const metaFilename = `${device.id}_${browserType}.json`;
                await fs.writeJSON(path.join(baselinePath, metaFilename), metadata, { spaces: 2 });
            }
        }

        console.log(`✓ Baseline сохранён: ${baselinePath}`);
        return baselinePath;
    }

    /**
     * Преобразование URL в безопасное имя файла
     */
    urlToSlug(url) {
        return url
            .replace(/^https?:\/\//, '')
            .replace(/[^a-zA-Z0-9]/g, '_')
            .substring(0, 100);
    }
}

export default VisualQAAgent;
