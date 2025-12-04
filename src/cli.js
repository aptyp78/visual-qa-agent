#!/usr/bin/env node

/**
 * Visual QA Agent - CLI
 *
 * Командная строка для запуска визуальных проверок:
 *
 *   visual-qa check https://example.com --profile standard
 *   visual-qa baseline https://example.com
 *   visual-qa compare --baseline ./baselines --current ./current
 *   visual-qa report --open
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs-extra';

import { VisualQAAgent } from './core/visual-agent.js';
import { AIVisionAnalyzer } from './analyzers/ai-vision-analyzer.js';
import { PixelComparator } from './analyzers/pixel-comparator.js';
import { HTMLReporter } from './reporters/html-reporter.js';

const program = new Command();

program
    .name('visual-qa')
    .description('🔍 Автономный агент для визуальной проверки веб-интерфейсов')
    .version('1.0.0');

/**
 * Команда: check - проверка страницы
 */
program
    .command('check <url>')
    .description('Проверить страницу на всех устройствах')
    .option('-p, --profile <name>', 'Профиль проверки (quick/standard/comprehensive/mobile_first)', 'standard')
    .option('--ai', 'Включить AI-анализ (требует ANTHROPIC_API_KEY)', false)
    .option('--compare', 'Сравнить с baseline если есть', false)
    .option('-o, --output <dir>', 'Директория для отчёта', './reports')
    .action(async (url, options) => {
        console.log(chalk.cyan('\n🔍 Visual QA Agent\n'));
        console.log(chalk.gray(`URL: ${url}`));
        console.log(chalk.gray(`Профиль: ${options.profile}`));
        console.log(chalk.gray(`AI-анализ: ${options.ai ? 'включён' : 'отключён'}\n`));

        const spinner = ora('Инициализация...').start();

        try {
            // Инициализация
            const agent = new VisualQAAgent({ reportsPath: options.output });
            await agent.init();
            spinner.succeed('Агент инициализирован');

            // Проверка страницы
            spinner.start('Проверка страницы на всех устройствах...');
            const results = await agent.checkPage(url, {
                profile: options.profile
            });
            spinner.succeed(`Проверено ${results.summary.total} конфигураций`);

            // AI-анализ если включён
            if (options.ai) {
                spinner.start('AI-анализ скриншотов...');
                const aiAnalyzer = new AIVisionAnalyzer();

                for (const check of results.checks) {
                    if (check.screenshot && aiAnalyzer.enabled) {
                        const analysis = await aiAnalyzer.analyzeScreenshot(
                            check.screenshot,
                            { device: check.device, browser: check.browser, url }
                        );

                        if (analysis.issues) {
                            check.issues = [...(check.issues || []), ...analysis.issues];
                        }
                        check.aiAnalysis = analysis;
                    }
                }
                spinner.succeed('AI-анализ завершён');
            }

            // Сравнение с baseline если есть
            if (options.compare) {
                spinner.start('Сравнение с baseline...');
                const comparator = new PixelComparator();
                const baselineDir = path.join('./baselines', agent.urlToSlug(url));

                if (await fs.pathExists(baselineDir)) {
                    for (const check of results.checks) {
                        if (check.screenshot) {
                            const baselinePath = path.join(
                                baselineDir,
                                `${check.device?.toLowerCase().replace(/\s+/g, '_')}_${check.browser}.png`
                            );

                            if (await fs.pathExists(baselinePath)) {
                                const diffPath = check.screenshot.replace('.png', '_diff.png');
                                const comparison = await comparator.compare(
                                    baselinePath,
                                    check.screenshot,
                                    diffPath
                                );
                                check.comparison = comparator.analyzeResults(comparison);
                            }
                        }
                    }
                    spinner.succeed('Сравнение завершено');
                } else {
                    spinner.warn('Baseline не найден - пропускаем сравнение');
                }
            }

            // Генерация отчёта
            spinner.start('Генерация отчёта...');
            const reporter = new HTMLReporter({ outputDir: options.output });
            const reportPath = await reporter.generate(results);
            spinner.succeed(`Отчёт сохранён: ${reportPath}`);

            // Вывод сводки
            console.log('\n' + chalk.bold('📊 Результаты:'));
            console.log(chalk.green(`   ✓ Пройдено: ${results.summary.passed}`));
            console.log(chalk.yellow(`   ⚠ Предупреждений: ${results.summary.warnings || 0}`));
            console.log(chalk.red(`   ✗ Ошибок: ${results.summary.failed}`));

            // Совет
            console.log(chalk.gray(`\n💡 Откройте отчёт: npx serve ${options.output}/latest -p 3333\n`));

            process.exit(results.summary.failed > 0 ? 1 : 0);

        } catch (error) {
            spinner.fail(`Ошибка: ${error.message}`);
            console.error(chalk.red(error.stack));
            process.exit(1);
        }
    });

/**
 * Команда: baseline - сохранение эталонных скриншотов
 */
program
    .command('baseline <url>')
    .description('Сохранить эталонные скриншоты (baseline)')
    .option('-p, --profile <name>', 'Профиль устройств', 'standard')
    .option('-o, --output <dir>', 'Директория для baseline', './baselines')
    .action(async (url, options) => {
        console.log(chalk.cyan('\n📸 Сохранение baseline\n'));

        const spinner = ora('Инициализация...').start();

        try {
            const agent = new VisualQAAgent({ baselinesPath: options.output });
            await agent.init();
            spinner.succeed('Агент инициализирован');

            spinner.start('Создание скриншотов...');
            const baselinePath = await agent.saveBaseline(url, { profile: options.profile });
            spinner.succeed(`Baseline сохранён: ${baselinePath}`);

            console.log(chalk.green('\n✓ Готово! Используйте --compare при следующей проверке\n'));

        } catch (error) {
            spinner.fail(`Ошибка: ${error.message}`);
            process.exit(1);
        }
    });

/**
 * Команда: compare - сравнение директорий
 */
program
    .command('compare')
    .description('Сравнить две директории скриншотов')
    .requiredOption('-b, --baseline <dir>', 'Директория baseline')
    .requiredOption('-c, --current <dir>', 'Директория текущих скриншотов')
    .option('-o, --output <dir>', 'Директория для diff', './reports/diff')
    .action(async (options) => {
        console.log(chalk.cyan('\n🔄 Сравнение скриншотов\n'));

        const spinner = ora('Сравнение...').start();

        try {
            const comparator = new PixelComparator();
            const results = await comparator.compareDirectories(
                options.baseline,
                options.current,
                options.output
            );

            spinner.succeed('Сравнение завершено');

            console.log('\n' + chalk.bold('📊 Результаты:'));
            console.log(chalk.green(`   ✓ Совпадает: ${results.summary.matched}`));
            console.log(chalk.red(`   ✗ Различается: ${results.summary.different}`));
            console.log(chalk.yellow(`   ➕ Новых: ${results.summary.new}`));
            console.log(chalk.gray(`   ➖ Отсутствует: ${results.summary.missing}`));

            if (results.summary.different > 0) {
                console.log(chalk.yellow(`\n⚠ Найдены различия! Проверьте: ${options.output}\n`));
            }

            await fs.writeJSON(
                path.join(options.output, 'comparison.json'),
                results,
                { spaces: 2 }
            );

        } catch (error) {
            spinner.fail(`Ошибка: ${error.message}`);
            process.exit(1);
        }
    });

/**
 * Команда: analyze - AI-анализ скриншота
 */
program
    .command('analyze <image>')
    .description('AI-анализ скриншота на визуальные проблемы')
    .option('--accessibility', 'Проверка accessibility', false)
    .action(async (imagePath, options) => {
        console.log(chalk.cyan('\n🤖 AI-анализ скриншота\n'));

        const spinner = ora('Анализ...').start();

        try {
            const analyzer = new AIVisionAnalyzer();

            if (!analyzer.enabled) {
                spinner.fail('ANTHROPIC_API_KEY не установлен');
                console.log(chalk.yellow('\nУстановите переменную окружения:\n'));
                console.log(chalk.gray('  export ANTHROPIC_API_KEY=your-key\n'));
                process.exit(1);
            }

            let results;
            if (options.accessibility) {
                results = await analyzer.analyzeAccessibility(imagePath);
            } else {
                results = await analyzer.analyzeScreenshot(imagePath);
            }

            spinner.succeed('Анализ завершён');

            console.log('\n' + chalk.bold('📋 Результаты анализа:\n'));
            console.log(JSON.stringify(results, null, 2));

        } catch (error) {
            spinner.fail(`Ошибка: ${error.message}`);
            process.exit(1);
        }
    });

/**
 * Команда: devices - список доступных устройств
 */
program
    .command('devices')
    .description('Показать доступные устройства и профили')
    .action(async () => {
        const agent = new VisualQAAgent();
        await agent.init();

        console.log(chalk.cyan('\n📱 Доступные профили тестирования:\n'));

        for (const [name, profile] of Object.entries(agent.devices.test_profiles)) {
            console.log(chalk.bold(`  ${name}`) + chalk.gray(` - ${profile.description}`));
            console.log(chalk.gray(`    Браузеры: ${profile.browsers.join(', ')}`));
            console.log(chalk.gray(`    Устройств: ${profile.devices === 'all' ? 'все' : profile.devices.length}\n`));
        }

        console.log(chalk.cyan('📋 Все устройства:\n'));

        for (const [category, devices] of Object.entries(agent.devices.device_profiles)) {
            console.log(chalk.bold(`  ${category.toUpperCase()}:`));
            for (const [id, device] of Object.entries(devices)) {
                console.log(chalk.gray(`    - ${device.name} (${device.viewport.width}x${device.viewport.height})`));
            }
            console.log();
        }
    });

program.parse();
