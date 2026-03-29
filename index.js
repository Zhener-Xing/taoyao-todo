/**
 * 静态站点（桃夭todo）+ 智能安排 API 代理；仅 Node 内置模块。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const STATIC_ROOT = path.join(__dirname, "public");

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
    const pathname = url.pathname;

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
  console.log(
    `桃夭todo：静态页 + 智能安排 API 已监听 :${PORT}（无 npm 依赖，文件目录 public/）`
  );
});
