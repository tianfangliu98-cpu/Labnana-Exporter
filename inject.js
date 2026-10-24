/**
 * MAIN world 注入脚本：挂钩页面自身的 fetch / XHR。
 *
 * 目的有两个：
 * 1. 抓取站内接口实际使用的鉴权头（Authorization 以及客户端标识头），
 *    这样导出器发出的请求和网页自己发出的请求一模一样，不会被拦。
 * 2. 顺手截获作品列表 / 详情的 JSON，作为额外缓存来源。
 *
 * 这里不修改任何请求与响应，只旁听。
 */
(() => {
  if (window.__LABNANA_EXPORTER_HOOKED__) return;
  window.__LABNANA_EXPORTER_HOOKED__ = true;

  const API_HOSTS = ["api.listenhub.ai"];
  const isApiUrl = (url) => {
    try {
      const u = new URL(url, location.href);
      return API_HOSTS.includes(u.hostname);
    } catch {
      return false;
    }
  };

  const CHANNEL = "LABNANA_EXPORTER";
  let lastAuthHeaders = null;

  const post = (type, payload) => {
    try {
      window.postMessage({ source: CHANNEL, type, payload }, "*");
    } catch {
      /* 结构化克隆失败就跳过，不影响页面本身 */
    }
  };

  const headersToObject = (headers) => {
    const out = {};
    if (!headers) return out;
    if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
      headers.forEach((value, key) => {
        out[key] = value;
      });
    } else if (Array.isArray(headers)) {
      for (const [k, v] of headers) out[k] = v;
    } else if (typeof headers === "object") {
      for (const [k, v] of Object.entries(headers)) out[k] = v;
    }
    return out;
  };

  const rememberAuth = (headers) => {
    const obj = headersToObject(headers);
    const picked = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (key === "authorization" || key.includes("client") || key.startsWith("x-")) {
        picked[k] = v;
      }
    }
    if (picked.Authorization || picked.authorization) {
      lastAuthHeaders = picked;
      post("auth", picked);
    }
  };

  // ---------- fetch ----------
  const nativeFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    // 这里的任何异常都不能冒到页面里：站点自己的请求必须照常发出。
    let url = "";
    try {
      url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    } catch {
      url = "";
    }

    try {
      if (url && isApiUrl(url)) {
        const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
        rememberAuth(headers);
      }
    } catch {
      /* 旁听失败不影响主流程 */
    }

    const promise = nativeFetch.apply(this, arguments);

    try {
      if (url && isApiUrl(url) && (!init || !init.method || String(init.method).toUpperCase() === "GET")) {
        promise
          .then((res) => {
            if (!res.ok) return;
            const ct = res.headers.get("content-type") || "";
            if (!ct.includes("application/json")) return;
            res
              .clone()
              .json()
              .then((json) => post("response", { url, json }))
              .catch(() => {});
          })
          .catch(() => {});
      }
    } catch {
      /* 同上 */
    }

    return promise;
  };

  // ---------- XMLHttpRequest ----------
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__le_url = url;
      this.__le_headers = {};
    } catch {
      /* 忽略 */
    }
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
    try {
      if (this.__le_headers) this.__le_headers[key] = value;
    } catch {
      /* 忽略 */
    }
    return nativeSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__le_url || "";
      if (url && isApiUrl(url)) {
        rememberAuth(this.__le_headers);
        this.addEventListener("load", () => {
          try {
            const ct = this.getResponseHeader("content-type") || "";
            if (!ct.includes("application/json")) return;
            post("response", { url, json: JSON.parse(this.responseText) });
          } catch {
            /* 忽略非 JSON 响应 */
          }
        });
      }
    } catch {
      /* 忽略 */
    }
    return nativeSend.apply(this, arguments);
  };

  // 内容脚本可以主动索取当前已知的鉴权头
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL) return;
    if (data.type === "get-auth" && lastAuthHeaders) {
      post("auth", lastAuthHeaders);
    }
  });

  post("ready", { href: location.href });
})();
