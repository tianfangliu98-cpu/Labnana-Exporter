/**
 * Labnana 站内接口封装。
 *
 * 接口基址来自前端 bundle 里 createApiUrl 的实现：
 *   https://api.listenhub.ai/api + 路径
 * 鉴权方式：cookie `app_access_token`，值本身已经带 "Bearer " 前缀。
 */

export const API_BASE = "https://api.listenhub.ai/api";

export const ENDPOINTS = {
  listImages: "/v1/banana/images",
  imageDetail: (id) => `/v1/banana/images/${encodeURIComponent(id)}`,
  favorites: "/v1/banana/favorites",
  search: "/v1/banana/search",
  refreshToken: "/v1/auth/token",
  me: "/v1/users/me",
};

/** 把站点返回的 envelope 拆开；非 0 code 视为失败。 */
export function unwrap(json) {
  if (!json || typeof json !== "object") throw new Error("接口返回不是 JSON");
  if (json.code !== 0 && json.code !== undefined && json.code !== null) {
    const err = new Error(json.message || `接口返回 code=${json.code}`);
    err.code = json.code;
    throw err;
  }
  return json.data ?? json;
}

function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    let ok = true;
    for (const key of path.split(".")) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        ok = false;
        break;
      }
      cur = cur[key];
    }
    if (ok && cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return undefined;
}

/** 参考图可能是字符串、{url} 或 {fileData:{fileUri}} 三种形态。 */
function collectUrls(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    if (typeof item === "string") {
      out.push(item);
    } else if (item && typeof item === "object") {
      const url =
        item.url ||
        item.imageUrl ||
        item.fileUri ||
        item.fileData?.fileUri ||
        item.fileData?.url ||
        item.src;
      if (url) out.push(url);
    }
  }
  return out.filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
}

/**
 * 兜底：字段名猜不中时，直接在原始记录里深度翻找。
 *
 * 只在候选键全部落空时启用，且只认 key 里带 prompt 的字符串，
 * 避免把无关的界面文案当成提示词。
 */
function deepFindString(root, keyRe, maxDepth = 5) {
  const seen = new Set();
  let best;
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > maxDepth || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      // 反向提示词也带 "prompt"，不排掉会把负向词当成正向提示词
      if (/negative|反向/i.test(key)) continue;
      if (typeof value === "string" && keyRe.test(key) && value.trim()) {
        if (!best || value.length > best.length) best = value;
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };
  walk(root, 0);
  return best;
}

function deepFindUrls(root, keyRe, maxDepth = 5) {
  const seen = new Set();
  const found = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > maxDepth || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (keyRe.test(key)) {
        for (const url of collectUrls(value)) if (!found.includes(url)) found.push(url);
      }
      if (value && typeof value === "object") walk(value, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function parseDims(record) {
  let width = pick(record, ["width", "imageWidth", "w", "meta.width"]);
  let height = pick(record, ["height", "imageHeight", "h", "meta.height"]);
  const size = pick(record, ["size", "imageSizePixels"]);
  if ((!width || !height) && typeof size === "string") {
    const m = size.match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
    if (m) {
      width = Number(m[1]);
      height = Number(m[2]);
    }
  }
  return {
    width: Number.isFinite(Number(width)) ? Number(width) : undefined,
    height: Number.isFinite(Number(height)) ? Number(height) : undefined,
  };
}

/**
 * 取出作品归属者 ID。
 * 服务端给的是字符串（如 "692cefec67b6233573c65e5e"），
 * 也可能在某些接口里给成 { userId } 对象 —— 两种都兜住。
 * 这个字段是「只导自己作品」这项限制的判据，不能丢。
 */
function parseCreator(raw) {
  const c = pick(raw, ["creator.userId", "creator.id", "creator", "userId"]);
  if (typeof c === "string") return c;
  if (c && typeof c === "object") return c.userId || c.id || undefined;
  return undefined;
}

function parseTime(record) {
  const raw = pick(record, [
    "createdAt",
    "createTime",
    "created_at",
    "createdTime",
    "timestamp",
    "gmtCreate",
  ]);
  if (raw === undefined) return undefined;
  if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * 把服务端原始记录整理成统一结构。
 *
 * 字段名做了多候选匹配 —— 站方改字段名时不至于整批导出变空白，
 * 同时原始记录会原样保留在 raw 里，永远不丢信息。
 */
export function normalizeRecord(raw) {
  const id = pick(raw, ["id", "imageId", "_id", "image_id", "taskId"]);
  const { width, height } = parseDims(raw);

  // 候选键落空时深挖原始记录，宁可多找一层也不让提示词变空白
  const prompt = pick(raw, [
    "prompt",
    "promptText",
    "inputPrompt",
    "text",
    "content",
    "input.prompt",
  ]) ?? deepFindString(raw, /prompt/i);

  let referenceImageUrls = collectUrls(
    pick(raw, ["referenceImageUrls", "referenceImages", "refImages", "input.referenceImages"])
  );
  if (!referenceImageUrls.length) {
    referenceImageUrls = deepFindUrls(raw, /^reference.*(url|image|uri)s?$/i);
  }

  return {
    id: id ? String(id) : undefined,
    status: pick(raw, ["status", "taskStatus", "state"]),
    prompt,
    negativePrompt: pick(raw, [
      "negativePrompt",
      "negative_prompt",
      "negative",
      "input.negativePrompt",
    ]),
    model: pick(raw, ["model", "modelName", "modelId", "input.model"]),
    provider: pick(raw, ["provider", "vendor", "input.provider"]),
    imageSize: pick(raw, [
      "imageSize",
      "imageConfig.imageSize",
      "resolution",
      "input.imageConfig.imageSize",
    ]),
    aspectRatio: pick(raw, [
      "aspectRatio",
      "ratio",
      "imageConfig.aspectRatio",
      "input.imageConfig.aspectRatio",
    ]),
    quality: pick(raw, ["quality", "imageConfig.quality", "input.imageConfig.quality"]),
    batchCount: pick(raw, ["batchCount", "batchSize", "count", "input.batchCount"]),
    promptEnhance: pick(raw, ["enableSearch", "promptEnhance", "enablePromptEnhance"]),
    /** 图生图链条上的父图：说明这张图是拿哪张图改出来的。 */
    remixSourceImageId: pick(raw, [
      "remixSourceImageId",
      "sourceImageId",
      "parentImageId",
      "rootImageId",
      "editRootImageId",
    ]),
    imageUrl: pick(raw, ["imageUrl", "url", "outputUrl", "resultUrl", "cdnUrl"]),
    thumbnailUrl: pick(raw, ["thumbnailUrl", "thumbUrl", "previewUrl"]),
    referenceImageUrls,
    width,
    height,
    isPublic: pick(raw, ["isPublic", "public", "published"]),
    createdAt: parseTime(raw),
    creator: parseCreator(raw),
    favorite: pick(raw, ["favorite", "isFavorite", "favorited"]),
    raw,
  };
}

/** 人类可读的生成参数摘要。 */
export function describeParams(record) {
  return [
    record.model && `模型 ${record.model}`,
    record.imageSize && record.imageSize,
    record.aspectRatio && `${record.aspectRatio}`,
    record.width && record.height ? `${record.width}×${record.height}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
