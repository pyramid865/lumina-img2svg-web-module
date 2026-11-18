"""本地 HTTP 服务器：模拟 Lumina 工坊的 iframe 隔离 + 严格 CSP（无 wasm-unsafe-eval）。"""
import http.server, socketserver, os

BASE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(BASE, "..", ".."))

# 工坊同款 CSP：允许内联脚本（模块 bundle 就是内联 script），
# 但绝不含 'unsafe-eval' / 'wasm-unsafe-eval' —— 这正是拦截 WASM 的那条限制。
STRICT_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "worker-src 'self'; "
    "frame-src 'self'; "
    "object-src 'none'; base-uri 'none'"
)

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=BASE, **kw)

    def end_headers(self):
        # 模块 iframe 页面（module.html）返回严格 CSP；宿主页不限制。
        if self.path.startswith("/module"):
            self.send_header("Content-Security-Policy", STRICT_CSP)
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 静默

if __name__ == "__main__":
    # 把构建好的 ui/index.html 复制成 e2e/module.html
    import shutil
    src = os.path.join(PROJECT, "ui", "index.html")
    dst = os.path.join(BASE, "module.html")
    shutil.copyfile(src, dst)
    print("module.html copied:", os.path.getsize(dst), "bytes", flush=True)
    with socketserver.TCPServer(("127.0.0.1", 8791), Handler) as httpd:
        print("E2E server on http://127.0.0.1:8791", flush=True)
        httpd.serve_forever()
