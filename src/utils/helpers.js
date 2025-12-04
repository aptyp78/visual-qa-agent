/**
 * Общие утилиты для Visual QA Agent
 *
 * Вынесены общие функции для устранения дублирования кода
 */

import path from 'path';

/**
 * Получение CSS селектора для DOM элемента
 * Используется в evaluate() функциях Playwright
 *
 * @param {Element} el - DOM элемент
 * @returns {string} CSS селектор
 */
export function getSelector(el) {
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

/**
 * Код getSelector для использования внутри page.evaluate()
 * (так как функции нельзя передать напрямую в браузерный контекст)
 */
export const getSelectorCode = `
function getSelector(el) {
    if (el.id) return '#' + el.id;
    if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(' ').filter(c => c && !c.includes(':'));
        if (classes.length > 0) return '.' + classes[0];
    }
    let selector = el.tagName.toLowerCase();
    if (el.type) selector += '[type="' + el.type + '"]';
    if (el.name) selector += '[name="' + el.name + '"]';
    return selector;
}
`;

/**
 * Валидация URL
 *
 * @param {string} url - URL для проверки
 * @returns {boolean} true если URL валиден
 * @throws {Error} если URL невалиден
 */
export function validateUrl(url) {
    if (!url || typeof url !== 'string') {
        throw new Error('URL не может быть пустым');
    }

    try {
        const parsed = new URL(url);
        // Разрешаем только http и https
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`Недопустимый протокол: ${parsed.protocol}. Разрешены только http и https`);
        }
        return true;
    } catch (e) {
        if (e.message.includes('Недопустимый протокол')) throw e;
        throw new Error(`Невалидный URL: ${url}`);
    }
}

/**
 * Валидация пути к файлу (защита от path traversal)
 *
 * @param {string} filePath - путь к файлу
 * @param {string} baseDir - базовая директория (опционально)
 * @returns {string} нормализованный безопасный путь
 * @throws {Error} если путь небезопасен
 */
export function validateFilePath(filePath, baseDir = null) {
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('Путь к файлу не может быть пустым');
    }

    // Нормализуем путь
    const normalizedPath = path.normalize(filePath);

    // Проверяем на path traversal
    if (normalizedPath.includes('..')) {
        throw new Error('Путь содержит небезопасные символы (..)');
    }

    // Если указана базовая директория, проверяем что путь внутри неё
    if (baseDir) {
        const normalizedBase = path.normalize(baseDir);
        const resolvedPath = path.resolve(normalizedBase, normalizedPath);
        if (!resolvedPath.startsWith(normalizedBase)) {
            throw new Error('Путь выходит за пределы разрешённой директории');
        }
        return resolvedPath;
    }

    return normalizedPath;
}

/**
 * Обёртка для безопасного выполнения async функций с логированием ошибок
 *
 * @param {Function} fn - async функция
 * @param {string} context - контекст для логирования
 * @param {any} defaultValue - значение по умолчанию при ошибке
 * @returns {Promise<any>}
 */
export async function safeExecute(fn, context = 'operation', defaultValue = null) {
    try {
        return await fn();
    } catch (error) {
        console.warn(`[${context}] Ошибка: ${error.message}`);
        return defaultValue;
    }
}

/**
 * Создание Promise с timeout
 *
 * @param {Promise} promise - исходный Promise
 * @param {number} ms - timeout в миллисекундах
 * @param {string} operation - название операции для сообщения об ошибке
 * @returns {Promise}
 */
export function withTimeout(promise, ms, operation = 'Operation') {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]);
}

/**
 * Простой rate limiter для API запросов
 */
export class RateLimiter {
    constructor(maxRequests = 10, windowMs = 60000) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.requests = [];
    }

    async acquire() {
        const now = Date.now();
        // Удаляем старые запросы
        this.requests = this.requests.filter(time => now - time < this.windowMs);

        if (this.requests.length >= this.maxRequests) {
            const waitTime = this.windowMs - (now - this.requests[0]);
            console.warn(`Rate limit reached. Waiting ${Math.ceil(waitTime / 1000)}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.acquire();
        }

        this.requests.push(now);
    }
}

/**
 * Поиск устройства по ID в профилях
 *
 * @param {Object} deviceProfiles - объект с профилями устройств
 * @param {string} deviceId - ID устройства
 * @returns {Object|null} устройство или null
 */
export function findDeviceById(deviceProfiles, deviceId) {
    for (const category of Object.values(deviceProfiles)) {
        if (category[deviceId]) {
            return { id: deviceId, ...category[deviceId] };
        }
    }
    return null;
}

/**
 * Склонение слов по числу (русский язык)
 *
 * @param {number} n - число
 * @param {string} one - форма для 1 (проблема)
 * @param {string} few - форма для 2-4 (проблемы)
 * @param {string} many - форма для 5+ (проблем)
 * @returns {string}
 */
export function pluralize(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

export default {
    getSelector,
    getSelectorCode,
    validateUrl,
    validateFilePath,
    safeExecute,
    withTimeout,
    RateLimiter,
    findDeviceById,
    pluralize
};
