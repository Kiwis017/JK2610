from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import webbrowser


PROJECT_DIR = Path(__file__).resolve().parent.parent
handler = partial(SimpleHTTPRequestHandler, directory=str(PROJECT_DIR))
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
url = "http://127.0.0.1:{}/index.html".format(server.server_address[1])

print("行程攻略已啟動：{}".format(url), flush=True)
print("儲存 Excel 後，頁面會在約 10 秒內自動更新。按 Ctrl+C 可停止。", flush=True)
threading.Timer(0.8, lambda: webbrowser.open(url, new=2)).start()

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\n行程攻略伺服器已停止。", flush=True)
finally:
    server.server_close()
