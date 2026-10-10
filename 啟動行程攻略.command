#!/bin/zsh
# 啟動西雙版納·普洱行程攻略本地伺服器
# 雙擊本檔案即可，無需開終機

cd "$(dirname "$0")"

echo "=============================="
echo "  西雙版納·普洱 7天6晚自由行攻略"
echo "=============================="
echo ""

# 找 python3
PYTHON=""
for candidate in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done

if [ -z "$PYTHON" ]; then
  echo "[錯誤] 找不到 python3。"
  echo "請先安裝 Python 3（可從 https://python.org 下載）。"
  echo ""
  echo "按任意鍵關閉視窗..."
  read -k1
  exit 1
fi

echo "使用 Python：$($PYTHON --version 2>&1)"
echo "專案目錄：$(pwd)"
echo ""
echo "正在啟動本地伺服器，瀏覽器會自動打開..."
echo "（關閉此視窗即可停止伺服器）"
echo ""

# 啟動伺服器
"$PYTHON" trip-files/start_local.py

# 伺服器結束後暫停，讓使用者看到訊息
echo ""
echo "伺服器已停止。按任意鍵關閉視窗..."
read -k1
