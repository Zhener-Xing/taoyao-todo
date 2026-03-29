/**
 * 静态站点（桃夭todo）+ 智能安排 API 代理；仅 Node 内置模块。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;

function resolveStaticRoot() {
  const pub = path.join(__dirname, "public");
  const indexInPub = path.join(pub, "index.html");
  if (fs.existsSync(indexInPub)) {
    return pub;
  }
  const indexNext = path.join(__dirname, "index.html");
  if (fs.existsSync(indexNext)) {
    console.warn(
      "桃夭todo: 在 public/ 未找到 index.html，改用与 index.js 同目录的静态文件（请确认 Docker 已 COPY 到 /app/public/）"
    );
    return __dirname;
  }
  return pub;
}

const STATIC_ROOT = resolveStaticRoot();

const DEEPSEEK_URL =
  process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function corsHeaders(req) {
  const origin = req.headers.origin;
  const configured = process.env.CORS_ORIGIN;
  let allowOrigin = "*";
  if (!configured || configured.trim() === "" || configured === "*") {
    allowOrigin = origin || "*";
  } else {
    const list = configured
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (origin && list.includes(origin)) allowOrigin = origin;
    else if (list.length) allowOrigin = list[0];
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function sendJson(req, res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(req),
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeStaticPath(urlPathname) {
  let rel =
    urlPathname === "/" || urlPathname === "" ? "index.html" : urlPathname.replace(/^\//, "");
  rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const root = path.resolve(STATIC_ROOT);
  const resolved = path.resolve(STATIC_ROOT, rel);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null;
  }
  return resolved;
}

function serveStaticFile(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        console.error("[static] 404 找不到文件:", filePath);
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("读取文件失败");
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const pathname = (url.pathname.replace(/\/+/g, "/") || "/").replace(/\/$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && pathname === "/api/smart-schedule") {
      if (!DEEPSEEK_API_KEY) {
        sendJson(req, res, 500, {
          error: { message: "服务器未配置 DEEPSEEK_API_KEY 环境变量" },
        });
        return;
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        sendJson(req, res, 413, { error: { message: e.message || "请求体过大" } });
        return;
      }

      let bodyObj;
      try {
        bodyObj = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        sendJson(req, res, 400, { error: { message: "请求体不是合法 JSON" } });
        return;
      }

      try {
        const upstream = await fetch(DEEPSEEK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify(bodyObj),
        });

        const text = await upstream.text();
        const contentType = upstream.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
          try {
            const data = JSON.parse(text);
            sendJson(req, res, upstream.status, data);
          } catch {
            sendJson(req, res, 502, {
              error: { message: "上游返回了非 JSON 内容" },
            });
          }
        } else {
          const buf = Buffer.from(text, "utf8");
          res.writeHead(upstream.status, {
            "Content-Type": "text/plain; charset=utf-8",
            ...corsHeaders(req),
            "Content-Length": buf.length,
          });
          res.end(buf);
        }
      } catch (err) {
        console.error("[smart-schedule]", err);
        sendJson(req, res, 502, {
          error: { message: err.message || "无法连接 DeepSeek 接口" },
        });
      }
      return;
    }

    if (req.method === "GET") {
      const filePath = safeStaticPath(pathname);
      if (filePath) {
        serveStaticFile(req, res, filePath);
        return;
      }
    }

    res.writeHead(404, corsHeaders(req));
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      sendJson(req, res, 500, { error: { message: "内部错误" } });
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const ok = fs.existsSync(path.join(STATIC_ROOT, "index.html"));
  console.log(
    `桃夭todo：监听 :${PORT} | 静态目录 ${STATIC_ROOT} | index.html ${ok ? "已就绪" : "缺失，请从仓库根目录构建镜像"}`
  );
});
