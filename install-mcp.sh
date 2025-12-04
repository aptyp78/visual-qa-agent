#!/bin/bash

# Visual QA Agent - Установка MCP-сервера для Claude Code
# Запуск: ./install-mcp.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_CONFIG="$HOME/.claude.json"

echo "🔍 Visual QA Agent - Установка MCP-сервера"
echo "==========================================="
echo ""

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js не установлен. Установите Node.js 18+ и повторите попытку."
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Требуется Node.js 18+. Текущая версия: $(node -v)"
    exit 1
fi

echo "✓ Node.js $(node -v)"

# Установка зависимостей
echo ""
echo "📦 Установка зависимостей..."
cd "$SCRIPT_DIR"
npm install --silent

# Установка Playwright браузеров
echo ""
echo "🌐 Установка браузеров Playwright..."
npx playwright install chromium --with-deps 2>/dev/null || npx playwright install chromium

echo ""
echo "✓ Зависимости установлены"

# Делаем скрипты исполняемыми
chmod +x "$SCRIPT_DIR/src/mcp-server.js"
chmod +x "$SCRIPT_DIR/src/cli.js"

# Конфигурация для Claude Code
MCP_CONFIG=$(cat <<EOF
{
  "visual-qa": {
    "command": "node",
    "args": ["$SCRIPT_DIR/src/mcp-server.js"],
    "env": {}
  }
}
EOF
)

echo ""
echo "📝 Конфигурация MCP-сервера:"
echo ""
echo "$MCP_CONFIG"
echo ""

# Проверяем существует ли конфигурация Claude
if [ -f "$CLAUDE_CONFIG" ]; then
    echo "⚠️  Файл $CLAUDE_CONFIG уже существует."
    echo ""
    echo "Добавьте следующую конфигурацию в секцию 'mcpServers':"
    echo ""
    echo "  \"visual-qa\": {"
    echo "    \"command\": \"node\","
    echo "    \"args\": [\"$SCRIPT_DIR/src/mcp-server.js\"]"
    echo "  }"
    echo ""
else
    echo "Создать конфигурацию $CLAUDE_CONFIG? (y/n)"
    read -r answer
    if [ "$answer" = "y" ]; then
        cat > "$CLAUDE_CONFIG" <<EOF
{
  "mcpServers": {
    "visual-qa": {
      "command": "node",
      "args": ["$SCRIPT_DIR/src/mcp-server.js"]
    }
  }
}
EOF
        echo "✓ Конфигурация создана: $CLAUDE_CONFIG"
    fi
fi

echo ""
echo "==========================================="
echo "✅ Установка завершена!"
echo ""
echo "Доступные инструменты в Claude Code:"
echo "  • mcp__visual-qa__visual_qa_check     - проверка страницы"
echo "  • mcp__visual-qa__visual_qa_baseline  - создание baseline"
echo "  • mcp__visual-qa__visual_qa_compare   - сравнение скриншотов"
echo "  • mcp__visual-qa__visual_qa_analyze   - AI-анализ"
echo "  • mcp__visual-qa__visual_qa_devices   - список устройств"
echo ""
echo "Перезапустите Claude Code для применения изменений."
echo ""
