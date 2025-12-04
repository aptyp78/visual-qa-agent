/**
 * HTMLReporter - Генератор HTML отчётов
 *
 * Создаёт интерактивные HTML-отчёты с:
 * - Галереей скриншотов по устройствам
 * - Фильтрацией по статусу/устройству
 * - Side-by-side сравнением
 * - Детализацией проблем
 */

import fs from 'fs-extra';
import path from 'path';

export class HTMLReporter {
    constructor(options = {}) {
        this.outputDir = options.outputDir || './reports';
        this.templateDir = options.templateDir || path.join(import.meta.dirname, '../templates');
    }

    /**
     * Генерация полного HTML отчёта
     */
    async generate(results, options = {}) {
        const {
            title = 'Visual QA Report',
            includeScreenshots = true
        } = options;

        const reportDir = path.join(this.outputDir, 'latest');
        await fs.ensureDir(reportDir);

        // Копируем скриншоты
        if (includeScreenshots && results.checks) {
            const screenshotsDir = path.join(reportDir, 'screenshots');
            await fs.ensureDir(screenshotsDir);

            for (const check of results.checks) {
                if (check.screenshot && await fs.pathExists(check.screenshot)) {
                    const filename = path.basename(check.screenshot);
                    await fs.copy(check.screenshot, path.join(screenshotsDir, filename));
                    check.screenshotRelative = `screenshots/${filename}`;
                }
            }
        }

        // Привязываем issues из results.issues к каждому check по устройству
        if (results.issues && results.checks) {
            for (const check of results.checks) {
                check.detectedIssues = results.issues.filter(issue =>
                    issue.affected_devices?.includes(check.device) ||
                    issue.device === check.device
                );
            }
        }

        // Генерируем HTML
        const html = this.generateHTML(results, title);

        const reportPath = path.join(reportDir, 'index.html');
        await fs.writeFile(reportPath, html);

        // Сохраняем JSON для программного доступа
        const jsonPath = path.join(reportDir, 'results.json');
        await fs.writeJSON(jsonPath, results, { spaces: 2 });

        console.log(`📊 Отчёт сохранён: ${reportPath}`);
        return reportPath;
    }

    /**
     * Генерация HTML контента
     */
    generateHTML(results, title) {
        const { summary, checks = [], url, profile, timestamp } = results;

        return `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        ${this.getStyles()}
    </style>
</head>
<body>
    <header class="header">
        <h1>🔍 Visual QA Report</h1>
        <div class="meta">
            <span class="url">${url || 'Multiple URLs'}</span>
            <span class="timestamp">${new Date(timestamp).toLocaleString('ru-RU')}</span>
        </div>
    </header>

    <section class="summary">
        <h2>Сводка</h2>
        <div class="summary-cards">
            <div class="card total">
                <span class="number">${summary?.total || checks.length}</span>
                <span class="label">Всего проверок</span>
            </div>
            <div class="card passed">
                <span class="number">${summary?.passed || 0}</span>
                <span class="label">Пройдено</span>
            </div>
            <div class="card failed">
                <span class="number">${summary?.failed || 0}</span>
                <span class="label">Ошибок</span>
            </div>
            <div class="card warnings">
                <span class="number">${summary?.warnings || 0}</span>
                <span class="label">Предупреждений</span>
            </div>
        </div>
        <div class="progress-bar">
            <div class="passed" style="width: ${this.getPassedPercent(summary)}%"></div>
            <div class="warnings" style="width: ${this.getWarningsPercent(summary)}%"></div>
            <div class="failed" style="width: ${this.getFailedPercent(summary)}%"></div>
        </div>
    </section>

    <section class="filters">
        <h2>Фильтры</h2>
        <div class="filter-buttons">
            <button class="filter-btn active" data-filter="all">Все</button>
            <button class="filter-btn" data-filter="passed">✓ Пройдено</button>
            <button class="filter-btn" data-filter="warning">⚠ Предупреждения</button>
            <button class="filter-btn" data-filter="failed">✗ Ошибки</button>
        </div>
        <div class="device-filters">
            ${this.generateDeviceFilters(checks)}
        </div>
    </section>

    <section class="results">
        <h2>Результаты проверок</h2>
        <div class="checks-grid">
            ${checks.map(check => this.generateCheckCard(check)).join('\n')}
        </div>
    </section>

    ${this.generateIssuesSection(results)}

    <footer class="footer">
        <p>Сгенерировано Visual QA Agent • ${new Date().toISOString()}</p>
    </footer>

    <div id="lightbox" class="lightbox" onclick="closeLightbox()">
        <img id="lightbox-img" src="" alt="">
        <span class="close">&times;</span>
    </div>

    <script>
        ${this.getScripts()}
    </script>
</body>
</html>`;
    }

    /**
     * Генерация карточки проверки
     */
    generateCheckCard(check) {
        const statusClass = check.status || 'unknown';
        const statusIcon = {
            passed: '✓',
            warning: '⚠',
            failed: '✗',
            error: '⚡'
        }[statusClass] || '?';

        // Используем detectedIssues (привязанные из results.issues) или issues_count
        const issues = check.detectedIssues || [];
        const issuesCount = issues.length || check.issues_count || 0;

        return `
        <div class="check-card ${statusClass}" data-device="${check.device}" data-browser="${check.browser}">
            <div class="card-header">
                <span class="status-icon">${statusIcon}</span>
                <span class="device-name">${check.device || 'Unknown'}</span>
                <span class="browser-badge">${check.browser || ''}</span>
            </div>
            ${check.screenshotRelative ? `
            <div class="screenshot-wrapper" onclick="openLightbox('${check.screenshotRelative}')">
                <img src="${check.screenshotRelative}" alt="${check.device}" loading="lazy">
                <div class="overlay">🔍 Увеличить</div>
            </div>
            ` : ''}
            <div class="card-body">
                ${issuesCount > 0 ? `
                <div class="issues-count">
                    <span class="count">${issuesCount}</span> проблем${this.pluralize(issuesCount, 'а', 'ы', '')}
                </div>
                <ul class="issues-list">
                    ${issues.slice(0, 3).map(issue => `
                        <li class="${issue.severity}">${issue.title || issue.message || issue.description}</li>
                    `).join('')}
                    ${issuesCount > 3 ? `<li class="more">+${issuesCount - 3} ещё...</li>` : ''}
                </ul>
                ` : '<p class="no-issues">Проблем не обнаружено</p>'}
            </div>
        </div>`;
    }

    /**
     * Генерация секции со всеми проблемами
     */
    generateIssuesSection(results) {
        // Используем results.issues напрямую (новый формат)
        const allIssues = results.issues || [];

        if (allIssues.length === 0) return '';

        // Группируем по severity
        const critical = allIssues.filter(i => i.severity === 'critical');
        const warnings = allIssues.filter(i => i.severity === 'warning');
        const info = allIssues.filter(i => i.severity === 'info');

        return `
        <section class="all-issues">
            <h2>Все обнаруженные проблемы (${allIssues.length})</h2>

            ${critical.length > 0 ? `
            <div class="issues-group critical">
                <h3>🔴 Критические (${critical.length})</h3>
                <ul>
                    ${critical.map(i => `
                        <li>
                            <strong>${i.affected_devices?.join(', ') || i.device}</strong>: ${i.title}
                            <br><small>${i.description}</small>
                            ${i.fix?.suggestion ? `<br><em>💡 ${i.fix.suggestion}</em>` : ''}
                            ${i.fix?.css ? `<br><code style="display:block;background:#1e293b;padding:8px;margin-top:4px;border-radius:4px;font-size:12px;white-space:pre;">${i.fix.css}</code>` : ''}
                        </li>
                    `).join('')}
                </ul>
            </div>
            ` : ''}

            ${warnings.length > 0 ? `
            <div class="issues-group warning">
                <h3>🟡 Предупреждения (${warnings.length})</h3>
                <ul>
                    ${warnings.map(i => `
                        <li>
                            <strong>${i.affected_devices?.join(', ') || i.device}</strong>: ${i.title}
                            <br><small>${i.description}</small>
                            ${i.fix?.suggestion ? `<br><em>💡 ${i.fix.suggestion}</em>` : ''}
                            ${i.fix?.css ? `<br><code style="display:block;background:#1e293b;padding:8px;margin-top:4px;border-radius:4px;font-size:12px;white-space:pre;">${i.fix.css}</code>` : ''}
                        </li>
                    `).join('')}
                </ul>
            </div>
            ` : ''}

            ${info.length > 0 ? `
            <div class="issues-group info">
                <h3>🔵 Информация (${info.length})</h3>
                <ul>
                    ${info.map(i => `<li>${i.title}: ${i.description}</li>`).join('')}
                </ul>
            </div>
            ` : ''}
        </section>`;
    }

    /**
     * Генерация фильтров по устройствам
     */
    generateDeviceFilters(checks) {
        const devices = [...new Set(checks.map(c => c.device).filter(Boolean))];
        return devices.map(device =>
            `<button class="device-filter" data-device="${device}">${device}</button>`
        ).join('\n');
    }

    /**
     * CSS стили
     */
    getStyles() {
        return `
        :root {
            --color-passed: #22c55e;
            --color-warning: #f59e0b;
            --color-failed: #ef4444;
            --color-info: #3b82f6;
            --bg-dark: #1e293b;
            --bg-card: #334155;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: var(--bg-dark);
            color: var(--text-primary);
            line-height: 1.6;
            padding: 2rem;
        }

        .header {
            text-align: center;
            margin-bottom: 2rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--bg-card);
        }

        .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }
        .header .meta { color: var(--text-secondary); font-size: 0.9rem; }
        .header .url { margin-right: 1rem; }

        .summary {
            background: var(--bg-card);
            border-radius: 1rem;
            padding: 1.5rem;
            margin-bottom: 2rem;
        }

        .summary h2 { margin-bottom: 1rem; }

        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 1rem;
            margin-bottom: 1rem;
        }

        .card {
            background: var(--bg-dark);
            border-radius: 0.75rem;
            padding: 1rem;
            text-align: center;
        }

        .card .number { font-size: 2rem; font-weight: bold; display: block; }
        .card .label { color: var(--text-secondary); font-size: 0.85rem; }

        .card.passed .number { color: var(--color-passed); }
        .card.failed .number { color: var(--color-failed); }
        .card.warnings .number { color: var(--color-warning); }

        .progress-bar {
            height: 8px;
            background: var(--bg-dark);
            border-radius: 4px;
            overflow: hidden;
            display: flex;
        }

        .progress-bar > div { height: 100%; transition: width 0.3s; }
        .progress-bar .passed { background: var(--color-passed); }
        .progress-bar .warnings { background: var(--color-warning); }
        .progress-bar .failed { background: var(--color-failed); }

        .filters {
            margin-bottom: 2rem;
        }

        .filter-buttons, .device-filters {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            margin-top: 0.5rem;
        }

        .filter-btn, .device-filter {
            padding: 0.5rem 1rem;
            border: 1px solid var(--bg-card);
            border-radius: 2rem;
            background: transparent;
            color: var(--text-primary);
            cursor: pointer;
            transition: all 0.2s;
        }

        .filter-btn:hover, .device-filter:hover,
        .filter-btn.active, .device-filter.active {
            background: var(--color-info);
            border-color: var(--color-info);
        }

        .checks-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1.5rem;
        }

        .check-card {
            background: var(--bg-card);
            border-radius: 1rem;
            overflow: hidden;
            border: 2px solid transparent;
            transition: transform 0.2s, border-color 0.2s;
        }

        .check-card:hover { transform: translateY(-4px); }
        .check-card.passed { border-color: var(--color-passed); }
        .check-card.warning { border-color: var(--color-warning); }
        .check-card.failed { border-color: var(--color-failed); }

        .card-header {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.75rem 1rem;
            background: rgba(0,0,0,0.2);
        }

        .status-icon { font-size: 1.25rem; }
        .device-name { font-weight: 600; flex: 1; }
        .browser-badge {
            font-size: 0.75rem;
            background: var(--bg-dark);
            padding: 0.25rem 0.5rem;
            border-radius: 0.25rem;
        }

        .screenshot-wrapper {
            position: relative;
            cursor: pointer;
            overflow: hidden;
        }

        .screenshot-wrapper img {
            width: 100%;
            height: 200px;
            object-fit: cover;
            object-position: top;
            transition: transform 0.3s;
        }

        .screenshot-wrapper:hover img { transform: scale(1.05); }

        .screenshot-wrapper .overlay {
            position: absolute;
            inset: 0;
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .screenshot-wrapper:hover .overlay { opacity: 1; }

        .card-body { padding: 1rem; }

        .issues-count {
            margin-bottom: 0.5rem;
            color: var(--color-warning);
        }

        .issues-list {
            list-style: none;
            font-size: 0.85rem;
        }

        .issues-list li {
            padding: 0.25rem 0;
            padding-left: 1rem;
            border-left: 2px solid var(--color-warning);
            margin-bottom: 0.25rem;
        }

        .issues-list li.critical { border-color: var(--color-failed); color: var(--color-failed); }
        .issues-list li.more { border: none; color: var(--text-secondary); font-style: italic; }

        .no-issues { color: var(--color-passed); }

        .all-issues {
            background: var(--bg-card);
            border-radius: 1rem;
            padding: 1.5rem;
            margin-top: 2rem;
        }

        .issues-group { margin-top: 1rem; }
        .issues-group h3 { margin-bottom: 0.5rem; }
        .issues-group ul { list-style-position: inside; }
        .issues-group li { margin-bottom: 0.5rem; }
        .issues-group em { color: var(--text-secondary); font-size: 0.9rem; }

        .footer {
            text-align: center;
            margin-top: 3rem;
            padding-top: 1rem;
            border-top: 1px solid var(--bg-card);
            color: var(--text-secondary);
            font-size: 0.85rem;
        }

        .lightbox {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.9);
            z-index: 1000;
            align-items: center;
            justify-content: center;
            cursor: zoom-out;
        }

        .lightbox.active { display: flex; }

        .lightbox img {
            max-width: 95%;
            max-height: 95%;
            object-fit: contain;
        }

        .lightbox .close {
            position: absolute;
            top: 1rem;
            right: 1.5rem;
            font-size: 2rem;
            color: white;
        }

        @media (max-width: 768px) {
            body { padding: 1rem; }
            .checks-grid { grid-template-columns: 1fr; }
        }
        `;
    }

    /**
     * JavaScript для интерактивности
     */
    getScripts() {
        return `
        // Фильтрация по статусу
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const filter = btn.dataset.filter;
                document.querySelectorAll('.check-card').forEach(card => {
                    if (filter === 'all' || card.classList.contains(filter)) {
                        card.style.display = '';
                    } else {
                        card.style.display = 'none';
                    }
                });
            });
        });

        // Фильтрация по устройствам
        document.querySelectorAll('.device-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.classList.toggle('active');

                const activeDevices = [...document.querySelectorAll('.device-filter.active')]
                    .map(b => b.dataset.device);

                document.querySelectorAll('.check-card').forEach(card => {
                    if (activeDevices.length === 0 || activeDevices.includes(card.dataset.device)) {
                        card.style.display = '';
                    } else {
                        card.style.display = 'none';
                    }
                });
            });
        });

        // Lightbox
        function openLightbox(src) {
            document.getElementById('lightbox-img').src = src;
            document.getElementById('lightbox').classList.add('active');
        }

        function closeLightbox() {
            document.getElementById('lightbox').classList.remove('active');
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeLightbox();
        });
        `;
    }

    /**
     * Вспомогательные методы
     */
    getPassedPercent(summary) {
        if (!summary?.total) return 0;
        return ((summary.passed || 0) / summary.total * 100).toFixed(1);
    }

    getWarningsPercent(summary) {
        if (!summary?.total) return 0;
        return ((summary.warnings || 0) / summary.total * 100).toFixed(1);
    }

    getFailedPercent(summary) {
        if (!summary?.total) return 0;
        return ((summary.failed || 0) / summary.total * 100).toFixed(1);
    }

    pluralize(n, one, few, many) {
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return one;
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
        return many;
    }
}

export default HTMLReporter;
