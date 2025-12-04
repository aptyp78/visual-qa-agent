/**
 * PixelComparator - Pixel-perfect сравнение изображений
 *
 * Использует pixelmatch для точного попиксельного сравнения:
 * - Генерация diff-изображений
 * - Настраиваемые пороги чувствительности
 * - Игнорирование anti-aliasing артефактов
 */

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import fs from 'fs-extra';
import path from 'path';

export class PixelComparator {
    constructor(options = {}) {
        // Настройки сравнения
        this.threshold = options.threshold || 0.1;           // Порог чувствительности (0-1)
        this.includeAA = options.includeAA ?? true;          // Учитывать anti-aliasing
        this.alpha = options.alpha || 0.1;                   // Прозрачность фона в diff
        this.diffColor = options.diffColor || [255, 0, 0];   // Цвет различий (красный)
        this.aaColor = options.aaColor || [255, 255, 0];     // Цвет AA-различий (жёлтый)
    }

    /**
     * Сравнение двух PNG изображений
     */
    async compare(image1Path, image2Path, outputDiffPath = null) {
        // Загружаем изображения
        const img1 = await this.loadPNG(image1Path);
        const img2 = await this.loadPNG(image2Path);

        if (!img1 || !img2) {
            return {
                error: 'Не удалось загрузить изображения',
                success: false
            };
        }

        // Проверяем размеры
        if (img1.width !== img2.width || img1.height !== img2.height) {
            return {
                success: false,
                sizeMismatch: true,
                image1: { width: img1.width, height: img1.height },
                image2: { width: img2.width, height: img2.height },
                message: `Размеры изображений различаются: ${img1.width}x${img1.height} vs ${img2.width}x${img2.height}`
            };
        }

        // Создаём буфер для diff
        const { width, height } = img1;
        const diff = new PNG({ width, height });

        // Выполняем сравнение
        const diffPixels = pixelmatch(
            img1.data,
            img2.data,
            diff.data,
            width,
            height,
            {
                threshold: this.threshold,
                includeAA: this.includeAA,
                alpha: this.alpha,
                diffColor: this.diffColor,
                aaColor: this.aaColor
            }
        );

        // Вычисляем процент различий
        const totalPixels = width * height;
        const diffPercent = (diffPixels / totalPixels) * 100;

        // Сохраняем diff если нужно
        if (outputDiffPath && diffPixels > 0) {
            await fs.ensureDir(path.dirname(outputDiffPath));
            await this.savePNG(diff, outputDiffPath);
        }

        return {
            success: true,
            match: diffPixels === 0,
            diffPixels,
            totalPixels,
            diffPercent: parseFloat(diffPercent.toFixed(4)),
            dimensions: { width, height },
            diffImagePath: diffPixels > 0 ? outputDiffPath : null
        };
    }

    /**
     * Пакетное сравнение директорий
     */
    async compareDirectories(baselineDir, currentDir, outputDir) {
        const results = {
            timestamp: new Date().toISOString(),
            comparisons: [],
            summary: {
                total: 0,
                matched: 0,
                different: 0,
                missing: 0,
                new: 0
            }
        };

        // Получаем списки файлов
        const baselineFiles = await this.getPNGFiles(baselineDir);
        const currentFiles = await this.getPNGFiles(currentDir);

        const allFiles = new Set([...baselineFiles, ...currentFiles]);

        for (const file of allFiles) {
            const baselinePath = path.join(baselineDir, file);
            const currentPath = path.join(currentDir, file);
            const diffPath = path.join(outputDir, `diff_${file}`);

            results.summary.total++;

            // Проверяем наличие файлов
            const hasBaseline = await fs.pathExists(baselinePath);
            const hasCurrent = await fs.pathExists(currentPath);

            if (!hasBaseline && hasCurrent) {
                // Новый файл
                results.comparisons.push({
                    file,
                    status: 'new',
                    message: 'Новый скриншот (нет baseline)'
                });
                results.summary.new++;
                continue;
            }

            if (hasBaseline && !hasCurrent) {
                // Отсутствующий файл
                results.comparisons.push({
                    file,
                    status: 'missing',
                    message: 'Скриншот отсутствует (есть baseline)'
                });
                results.summary.missing++;
                continue;
            }

            // Сравниваем
            const comparison = await this.compare(baselinePath, currentPath, diffPath);

            if (comparison.success && comparison.match) {
                results.comparisons.push({
                    file,
                    status: 'matched',
                    diffPercent: 0
                });
                results.summary.matched++;
            } else if (comparison.success) {
                results.comparisons.push({
                    file,
                    status: 'different',
                    diffPercent: comparison.diffPercent,
                    diffPixels: comparison.diffPixels,
                    diffImage: diffPath
                });
                results.summary.different++;
            } else {
                results.comparisons.push({
                    file,
                    status: 'error',
                    error: comparison.error || comparison.message
                });
            }
        }

        return results;
    }

    /**
     * Загрузка PNG файла
     */
    async loadPNG(filePath) {
        return new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .pipe(new PNG())
                .on('parsed', function() {
                    resolve(this);
                })
                .on('error', (err) => {
                    console.error(`Ошибка загрузки PNG ${filePath}:`, err.message);
                    resolve(null);
                });
        });
    }

    /**
     * Сохранение PNG файла
     */
    async savePNG(png, filePath) {
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(filePath);
            png.pack().pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }

    /**
     * Получение списка PNG файлов в директории
     */
    async getPNGFiles(dir) {
        try {
            const files = await fs.readdir(dir);
            return files.filter(f => f.toLowerCase().endsWith('.png'));
        } catch (error) {
            return [];
        }
    }

    /**
     * Анализ результатов сравнения с порогами
     */
    analyzeResults(comparison, thresholds = {}) {
        const {
            acceptablePercent = 0.1,    // Приемлемо: < 0.1%
            warningPercent = 1.0,       // Предупреждение: 0.1% - 1%
            // > 1% = ошибка
        } = thresholds;

        if (!comparison.success) {
            return {
                status: 'error',
                severity: 'critical',
                message: comparison.error || 'Ошибка сравнения'
            };
        }

        if (comparison.match) {
            return {
                status: 'passed',
                severity: 'none',
                message: 'Изображения идентичны'
            };
        }

        const { diffPercent } = comparison;

        if (diffPercent < acceptablePercent) {
            return {
                status: 'passed',
                severity: 'none',
                message: `Минимальные различия: ${diffPercent}% (допустимо < ${acceptablePercent}%)`
            };
        }

        if (diffPercent < warningPercent) {
            return {
                status: 'warning',
                severity: 'warning',
                message: `Незначительные различия: ${diffPercent}%`,
                requiresReview: true
            };
        }

        return {
            status: 'failed',
            severity: 'critical',
            message: `Значительные различия: ${diffPercent}%`,
            requiresReview: true
        };
    }

    /**
     * Создание side-by-side сравнения
     */
    async createSideBySide(image1Path, image2Path, diffPath, outputPath) {
        const img1 = await this.loadPNG(image1Path);
        const img2 = await this.loadPNG(image2Path);

        if (!img1 || !img2) return null;

        const hasDiff = diffPath && await fs.pathExists(diffPath);
        const diffImg = hasDiff ? await this.loadPNG(diffPath) : null;

        // Создаём изображение с 2 или 3 панелями
        const panelCount = diffImg ? 3 : 2;
        const { width, height } = img1;
        const gap = 10;
        const totalWidth = width * panelCount + gap * (panelCount - 1);

        const combined = new PNG({ width: totalWidth, height });

        // Заполняем серым фоном
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < totalWidth; x++) {
                const idx = (totalWidth * y + x) << 2;
                combined.data[idx] = 128;     // R
                combined.data[idx + 1] = 128; // G
                combined.data[idx + 2] = 128; // B
                combined.data[idx + 3] = 255; // A
            }
        }

        // Копируем изображения
        this.copyImageRegion(img1, combined, 0, 0);
        this.copyImageRegion(img2, combined, width + gap, 0);
        if (diffImg) {
            this.copyImageRegion(diffImg, combined, (width + gap) * 2, 0);
        }

        await this.savePNG(combined, outputPath);
        return outputPath;
    }

    /**
     * Копирование региона изображения
     */
    copyImageRegion(src, dest, destX, destY) {
        for (let y = 0; y < src.height; y++) {
            for (let x = 0; x < src.width; x++) {
                const srcIdx = (src.width * y + x) << 2;
                const destIdx = (dest.width * (destY + y) + (destX + x)) << 2;

                dest.data[destIdx] = src.data[srcIdx];
                dest.data[destIdx + 1] = src.data[srcIdx + 1];
                dest.data[destIdx + 2] = src.data[srcIdx + 2];
                dest.data[destIdx + 3] = src.data[srcIdx + 3];
            }
        }
    }
}

export default PixelComparator;
