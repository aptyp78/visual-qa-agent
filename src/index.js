/**
 * Visual QA Agent - Главный модуль
 *
 * Экспортирует все компоненты для программного использования
 */

export { VisualQAAgent } from './core/visual-agent.js';
export { AIVisionAnalyzer } from './analyzers/ai-vision-analyzer.js';
export { PixelComparator } from './analyzers/pixel-comparator.js';
export { HTMLReporter } from './reporters/html-reporter.js';

/**
 * Быстрый запуск проверки
 *
 * @example
 * import { quickCheck } from 'visual-qa-agent';
 * const results = await quickCheck('https://example.com');
 */
export async function quickCheck(url, options = {}) {
    const { VisualQAAgent } = await import('./core/visual-agent.js');
    const { HTMLReporter } = await import('./reporters/html-reporter.js');

    const agent = new VisualQAAgent(options);
    await agent.init();

    const results = await agent.checkPage(url, {
        profile: options.profile || 'quick'
    });

    if (options.generateReport !== false) {
        const reporter = new HTMLReporter(options);
        await reporter.generate(results);
    }

    return results;
}

/**
 * Полная проверка с AI-анализом
 */
export async function fullCheck(url, options = {}) {
    const { VisualQAAgent } = await import('./core/visual-agent.js');
    const { AIVisionAnalyzer } = await import('./analyzers/ai-vision-analyzer.js');
    const { HTMLReporter } = await import('./reporters/html-reporter.js');

    const agent = new VisualQAAgent(options);
    await agent.init();

    const results = await agent.checkPage(url, {
        profile: options.profile || 'comprehensive'
    });

    // AI-анализ каждого скриншота
    const aiAnalyzer = new AIVisionAnalyzer(options);
    if (aiAnalyzer.enabled) {
        for (const check of results.checks) {
            if (check.screenshot) {
                const analysis = await aiAnalyzer.analyzeScreenshot(
                    check.screenshot,
                    { device: check.device, browser: check.browser, url }
                );
                check.aiAnalysis = analysis;
                if (analysis.issues) {
                    check.issues = [...(check.issues || []), ...analysis.issues];
                }
            }
        }
    }

    const reporter = new HTMLReporter(options);
    await reporter.generate(results);

    return results;
}
