/**
 * 仅使用 Node 内置模块：接收前端 OpenAI 兼容 chat 请求体，转发至 DeepSeek。
 */
const http = require("http");

const PORT = Number(process.env.PORT) || 3000;
const DEEPSEEK_URL =
  process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const MAX_BODY = 2 * 1024 * 1024;

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

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/health") {
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && path === "/api/smart-schedule") {
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
  console.log(`智能安排代理 listening on :${PORT}（无 npm 依赖）`);
});
