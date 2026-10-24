/**
 * 离屏文档：导出任务的实际执行者。
 *
 * 为什么不在 service worker 里干活：
 * SW 里没有 URL.createObjectURL，也没法把几百 MB 的 bytes 挂在内存上等人下载。
 * 离屏文档有完整 DOM 环境，能建 Blob、能发 chrome.downloads 请求，
 * 而且不会因为 SW 被回收而中断。
 */
import { ZipWriter } from "./lib/zip.js";
import { insertItxt, isPng, buildParametersText } from "./lib/png.js";
import { getImageSize } from "./lib/imageinfo.js";
import { API_BASE, ENDPOINTS, unwrap, normalizeRecord } from "./lib/labapi.js";

/** 语言：与面板保持一致，中文环境中文，其余英文。 */
const LANG_EN = !/^zh/i.test(navigator.language || "zh");
const t = (zh, en) => (LANG_EN ? en : zh);

/** 每件作品之间的请求间隔（毫秒）。克制一点，别把对方接口当自家带宽。 */
const REQUEST_GAP = 120;

/** 单个压缩包上限，超过就切分，避免撞上 ZIP32 的 4GB 天花板。 */
const PART_LIMIT = 1_600_000_000;
/** 单个请求超时。 */
const FETCH_TIMEOUT = 60_000;

let activeJob = null;
const blobUrls = new Map(); // downloadId -> url

const send = (msg) => {
  chrome.runtime.sendMessage(msg).catch(() => {});
};

const log = (level, message) => send({ type: "EXPORT_LOG", level, message });

const progress = (payload) => send({ type: "EXPORT_PROGRESS", ...payload });

const pad4 = (n) => String(n).padStart(4, "0");

/** 文件名安全化：去掉 Windows 与 macOS 都不接受的字符。 */
const safeName = (s, fallback = "item") => {
  const cleaned = String(s ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
};

const extFromUrl = (url, contentType) => {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.(png|jpe?g|webp|gif|avif|bmp)$/i);
    if (m) return m[1].toLowerCase();
  } catch {
    /* 走 content-type 兜底 */
  }
  if (contentType?.includes("jpeg")) return "jpg";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("gif")) return "gif";
  if (contentType?.includes("avif")) return "avif";
  return "png";
};

/**
 * 图片下载专用头。
 *
 * 关键：这里绝对不能带接口用的那些头（Authorization / Content-Type: json）。
 * 跨域请求只要带上非「简单头」，浏览器就先发一次 OPTIONS 预检，
 * 而图片 CDN 通常不应答预检，结果就是整批图 400/失败。
 * Accept 属于 CORS 简单头，不会触发预检。
 */
const ASSET_HEADERS = { Accept: "image/*,*/*;q=0.8" };

/** 带超时与重试的二进制抓取。 */
async function fetchBytes(url, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        headers: ASSET_HEADERS,
        signal: controller.signal,
        credentials: "omit",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      return {
        bytes: new Uint8Array(buffer),
        contentType: res.headers.get("content-type") || "",
      };
    } catch (err) {
      // 把域名写进错误里：网络类失败（TypeError）大多是因为该域名
      // 不在 host_permissions 白名单内，报出域名才能一眼定位
      let host = "?";
      try {
        host = new URL(url).host;
      } catch {
        /* 忽略 */
      }
      const reason =
        err?.name === "AbortError" ? t("超时", "timeout") : err?.message || String(err);
      lastError = new Error(t(`${reason}（域名 ${host}）`, `${reason} (host ${host})`));
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(t("抓取失败", "download failed"));
}

async function fetchJson(path, headers) {
  const res = await fetch(`${API_BASE}${path}`, { headers, credentials: "omit" });
  const json = await res.json().catch(() => null);
  if (res.status === 401) {
    const err = new Error(t("登录状态已失效", "Session expired"));
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (json && json.code !== 0) {
    const err = new Error(json.message || t(`接口返回 code=${json.code}`, `API returned code=${json.code}`));
    err.code = json.code;
    throw err;
  }
  return unwrap(json);
}

function buildCsv(rows) {
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "序号",
    "作品ID",
    "文件夹",
    "模型",
    "尺寸档位",
    "宽高比",
    "像素宽",
    "像素高",
    "参考图数量",
    "创建时间",
    "提示词",
  ];
  const lines = [header.map(escape).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.index,
        row.id,
        row.folder,
        row.model,
        row.imageSize,
        row.aspectRatio,
        row.width,
        row.height,
        row.refCount,
        row.createdAt,
        row.prompt,
      ]
        .map(escape)
        .join(",")
    );
  }
  // 加 BOM，Excel 直接双击打开不会乱码
  return "\ufeff" + lines.join("\r\n");
}

function buildReadme() {
  if (LANG_EN) {
    return [
      "Labnana export package",
      "======================",
      "",
      "Layout",
      "------",
      "  2026-10-24_1351_a3f9/     one folder per work",
      "    image.<ext>       final image",
      "    metadata.json     full metadata (includes the raw server record)",
      "    parameters.txt    prompt + parameters, also embedded in the PNG iTXt chunk",
      "    ref_01.<ext> ...  reference images, numbered in generation order",
      "",
      "  index.csv           overview table (opens in Excel)",
      "  index.json          same, machine readable",
      "  errorlog.txt        only present when something failed",
      "",
      "Notes",
      "-----",
      "  1. Prompts and parameters come from Labnana's own API, not scraped from the page.",
      "  2. The raw field in metadata.json is the untouched server response; even if the",
      "     site renames fields later, this export stays intact.",
      "  3. PNG images carry a parameters iTXt chunk, readable by A1111 / ComfyUI.",
      "  4. Reference images are saved as files, not links — signed CDN URLs expire.",
      "  5. Use this on your own works only. It is a personal backup tool, not a scraper.",
      "",
    ].join("\n");
  }
  return [
    "Labnana 作品导出包",
    "==================",
    "",
    "目录结构",
    "--------",
    "  2026-10-24_1351_a3f9/   每件作品一个文件夹",
    "    image.<ext>        最终成图",
    "    metadata.json      完整元数据（含服务端原始记录）",
    "    parameters.txt     人类可读的提示词与参数，也写进了 PNG 的 iTXt 块",
    "    ref_01.<ext> ...   参考图，按生成时的顺序编号",
    "",
    "  index.csv            作品总表，可用 Excel 打开",
    "  index.json           同上，机器可读",
    "  errorlog.txt         仅在出现失败时生成",
    "",
    "说明",
    "----",
    "  1. 提示词与参数来自 Labnana 服务端记录，不是从页面文字里抄的。",
    "  2. metadata.json 的 raw 字段是服务端返回的原始 JSON，未做任何裁剪；",
    "     即便本站改了字段名，历史导出也不受影响。",
    "  3. PNG 图片已经在 iTXt 里写入 parameters，拖进 A1111 / ComfyUI 能回读提示词。",
    "  4. 参考图的 CDN 链接会过期，所以这里保存的是图片本体，不是链接。",
    "  5. 只用于导出自己的作品。这是个人备份工具，不是采集器。",
    "",
  ].join("\n");
}

/** 把新数据合并进已有记录：只覆盖有实际值的字段。
 *  normalizeRecord 会为缺失字段产出 undefined，直接展开会把已有的
 *  imageUrl / id 冲掉 —— 所以这里必须逐字段判断。 */
function mergeRecord(base, incoming) {
  const out = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "raw") continue;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 生成文件夹名。
 * seq  ：0001_<作品ID>，稳定、便于和接口 ID 对照
 * date ：YYYY-MM-DD_HHMM_xxxx，按生成时间排列，后缀是作品 ID 末 4 位。
 *
 * 为什么要那 4 位：只写日期时，同一分钟生成的不同作品会得到同名文件夹，
 * 用户把多次导出的包解压到同一个目录就会互相覆盖、丢图。
 * 末 4 位由 ID 决定，跨批次稳定且几乎不会重复。
 */
function makeFolderName(record, index, naming, used) {
  if (naming !== "date") {
    const name = `${pad4(index)}_${safeName(record.id || "unknown")}`;
    used.add(name);
    return name;
  }
  const d = record.createdAt ? new Date(record.createdAt) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(
    d.getHours()
  )}${p(d.getMinutes())}`;
  const code = String(record.id || "")
    .slice(-4)
    .toLowerCase()
    .replace(/[^0-9a-z]/g, "") || "0000";
  const base = `${stamp}_${code}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/** 把一条作品写进当前压缩包。 */
async function addItem(zip, folder, record, stats, options = {}) {
  const skipImages = !!options.skipImages;
  let refCount = 0;

  if (!record.prompt) stats.missingPrompt = (stats.missingPrompt || 0) + 1;

  try {
    // 成图
    if (!skipImages) {
      if (!record.imageUrl) {
        stats.skipped.push({
        id: record.id,
        reason: t("没有成图地址（可能仍在生成或已失败）", "no image URL (still generating or failed)"),
      });
        return { folder, refCount };
      }

      let imageExt = "png";
      try {
        const { bytes, contentType } = await fetchBytes(record.imageUrl);
        imageExt = extFromUrl(record.imageUrl, contentType);

        let output = bytes;

        // 先读文件头补全像素尺寸（PNG/JPEG/WebP 都支持），
        // 这样写进 PNG 的参数文本和 parameters.txt 才一致
        const dims = getImageSize(bytes);
        if (dims && dims.width && dims.height) {
          record.width = dims.width;
          record.height = dims.height;
        }

        if (isPng(bytes) && record.prompt) {
          try {
            output = insertItxt(bytes, "parameters", buildParametersText(record));
          } catch (err) {
            log("warn", t(`写入 PNG 元数据失败，保留原图：${err.message}`, `Could not write PNG metadata, keeping original: ${err.message}`));
          }
        }
        zip.add(`${folder}/image.${imageExt}`, output);
        stats.images += 1;
      } catch (err) {
        stats.errors.push(t(`作品 ${record.id} 成图下载失败：${err.message}`, `${record.id}: image download failed: ${err.message}`));
      }
    }

    // 参考图
    const refs = record.referenceImageUrls || [];
    for (let i = 0; i < refs.length; i++) {
      try {
        const { bytes, contentType } = await fetchBytes(refs[i]);
        const ext = extFromUrl(refs[i], contentType);
        zip.add(`${folder}/ref_${String(i + 1).padStart(2, "0")}.${ext}`, bytes);
        refCount += 1;
        stats.refs += 1;
      } catch (err) {
        stats.errors.push(t(`作品 ${record.id} 参考图 ${i + 1} 下载失败：${err.message}`, `${record.id}: reference ${i + 1} download failed: ${err.message}`));
      }
    }
  } finally {
    // 无论图片抓取成功与否，信息文件一定要留下
    zip.add(`${folder}/metadata.json`, JSON.stringify(record, null, 2));
    zip.add(`${folder}/parameters.txt`, buildParametersText(record) + "\n");
  }

  return { folder, refCount };
}

async function runJob(job) {
  const { items, headers, filenameBase, includeRefs, skipImages, naming } = job;
  const startedAt = Date.now();

  const stats = { images: 0, refs: 0, skipped: [], errors: [], foreign: 0 };
  const indexRows = [];
  const usedFolders = new Set();
  let zip = new ZipWriter();
  let partNo = 0;

  // 内存策略：做好一份就立刻交付下载，不攒在数组里。
  // 攒着的话，几百 GB 的库会直接把浏览器撑爆。
  // 唯一要缓一下的是第一份 —— 因为「只分了一卷」时文件名不该带 -part1，
  // 而这件事只有切出第二卷（或全部跑完）才知道。
  let heldFirst = null;

  /** 把一份压缩包交给浏览器下载。 */
  async function shipPart(blob, index, withSuffix) {
    const url = URL.createObjectURL(new Blob([blob], { type: "application/zip" }));
    const filename = withSuffix
      ? `${filenameBase}-part${index}.zip`
      : `${filenameBase}.zip`;
    const downloadId = await send({
      type: "EXPORT_PART_READY",
      url,
      filename,
      size: blob.length,
      part: index,
      parts: index,
    });
    blobUrls.set(String(index), url);
    progress({
      phase: "downloading",
      done: index,
      total: index,
      label: t(
        `已生成 ${filename}（${(blob.length / 1048576).toFixed(1)} MB），等待浏览器保存`,
        `${filename} ready (${(blob.length / 1048576).toFixed(1)} MB), waiting for the browser to save`
      ),
      downloadId,
    });
    // 给浏览器一点时间接住这个 blob
    await new Promise((r) => setTimeout(r, 600));
  }

  /**
   * 收尾并交付当前这一卷。
   * isFinal=true 表示不会再有下一卷了，可以决定首卷要不要带 -part 后缀。
   */
  const flush = async (isFinal) => {
    if (zip.count === 0) return;
    const blob = zip.build();
    const index = ++partNo;
    zip = new ZipWriter();

    if (index === 1 && !isFinal) {
      heldFirst = blob; // 先压着，等知道有没有第二卷
      return;
    }
    if (heldFirst) {
      await shipPart(heldFirst, 1, true);
      heldFirst = null;
    }
    await shipPart(blob, index, !isFinal || index > 1);
  };

  // 切包标记：等到下一轮开头再切，这样索引文件一定能落在
  // 一个「有内容」的最后分卷里，而不是单独占一个只有索引的空包
  let pendingSplit = false;

  // 确认「我是谁」：只导自己的作品，别人的一张都不碰
  let myUserId = null;
  try {
    const me = await fetchJson(ENDPOINTS.me, headers);
    myUserId = me?.id || me?.userId || null;
  } catch (err) {
    if (err?.unauthorized) throw err;
    log(
      "warn",
      t("无法确认当前账号，归属校验跳过", "Could not confirm your account; ownership check skipped")
    );
  }

  for (let i = 0; i < items.length; i++) {
    if (pendingSplit && zip.count > 0) {
      await flush(false);
      pendingSplit = false;
      log(
        "warn",
        t(
          `压缩包已超过单包上限，已切分为第 ${partNo} 包`,
          `Archive exceeded the part limit; split into part ${partNo}`
        )
      );
    }

    const entry = items[i];
    progress({
      phase: "running",
      done: i,
      total: items.length,
      label: t(`正在处理 ${i + 1}/${items.length}`, `Processing ${i + 1}/${items.length}`),
    });

    let record = entry.record;
    // 列表接口给的字段不全，逐条拉详情补全（提示词、参考图都在这上面）
    try {
      const detail = await fetchJson(ENDPOINTS.imageDetail(record.id), headers);
      record = mergeRecord(record, normalizeRecord({ ...record.raw, ...detail }));
      record.raw = { ...record.raw, ...detail };
    } catch (err) {
      if (err.unauthorized) throw err;
      log(
        "warn",
        t(
          `作品 ${record.id} 详情拉取失败，使用列表数据：${err.message}`,
          `Item ${record.id}: detail fetch failed, using list data: ${err.message}`
        )
      );
    }

    // 只导自己的：带上别人的作品 ID 也不会被导出
    if (myUserId && record.creator && record.creator !== myUserId) {
      stats.foreign += 1;
      log(
        "warn",
        t(
          `作品 ${record.id} 不属于当前账号，已跳过`,
          `Item ${record.id} belongs to another account — skipped`
        )
      );
      // continue 会跳过循环末尾的间隔，这里补一次，保证被跳过的作品
      // 也照样按节奏请求
      if (i < items.length - 1) {
        await new Promise((r) => setTimeout(r, REQUEST_GAP));
      }
      continue;
    }

    if (!includeRefs) record.referenceImageUrls = [];

    const { folder, refCount } = await addItem(
      zip,
      makeFolderName(record, i + 1, naming, usedFolders),
      record,
      stats,
      { skipImages }
    );

    indexRows.push({
      index: i + 1,
      id: record.id,
      folder,
      model: record.model,
      imageSize: record.imageSize,
      aspectRatio: record.aspectRatio,
      width: record.width,
      height: record.height,
      refCount,
      createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : "",
      prompt: record.prompt,
    });

    // 只打标记，真正切换留到下一轮开头
    if (zip.size > PART_LIMIT) pendingSplit = true;

    // 克制一点：每件之间留一点间隔，别把对方接口当自家带宽
    if (i < items.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_GAP));
    }
  }

  // 收尾：索引与说明只写在最后一份里。
  // 这样用户把多个分卷解压到同一个文件夹时，index.csv 一定是全量的，
  // 不会因为解压顺序不同而被前几份的部分索引覆盖。
  zip.add("index.csv", buildCsv(indexRows));
  zip.add("index.json", JSON.stringify(indexRows, null, 2));
  zip.add("README.txt", buildReadme());

  // 有错误就把完整清单一起打包，方便用户直接拿去提问，不用手工抄日志
  if (stats.errors.length || stats.skipped.length || stats.foreign) {
    const locale = LANG_EN ? "en-US" : "zh-CN";
    const lines = LANG_EN
      ? [
          "Labnana export error report",
          "===========================",
          `Generated: ${new Date().toLocaleString(locale, { hour12: false })}`,
          `Total: ${items.length}  images: ${stats.images}  references: ${stats.refs}`,
          "",
          `== Download failures (${stats.errors.length}) ==`,
          ...(stats.errors.length ? stats.errors : ["(none)"]),
          "",
          `== Skipped (${stats.skipped.length}) ==`,
          ...(stats.skipped.length ? stats.skipped.map((s) => `${s.id}: ${s.reason}`) : ["(none)"]),
          "",
          `== Not yours (${stats.foreign}) ==`,
          "",
        ]
      : [
          "Labnana 导出错误清单",
          "====================",
          `生成时间：${new Date().toLocaleString(locale, { hour12: false })}`,
          `作品总数：${items.length}　成图成功：${stats.images}　参考图成功：${stats.refs}`,
          "",
          `== 下载失败（${stats.errors.length} 条）==`,
          ...(stats.errors.length ? stats.errors : ["（无）"]),
          "",
          `== 跳过（${stats.skipped.length} 条）==`,
          ...(stats.skipped.length
            ? stats.skipped.map((s) => `${s.id}: ${s.reason}`)
            : ["（无）"]),
          "",
          `== 不属于本账号已跳过（${stats.foreign} 条）==`,
          "",
        ];
    zip.add("errorlog.txt", lines.join("\n"));
  }

  // 交付最后一卷。前面每一卷在切出来的当下就已经交出去了，
  // 这里只剩「收尾那一卷」（以及可能压着的首卷）。
  await flush(true);

  const summary = {
    total: items.length,
    images: stats.images,
    refs: stats.refs,
    skipped: stats.skipped,
    errors: stats.errors,
    foreign: stats.foreign,
    parts: partNo,
    elapsed: Date.now() - startedAt,
  };

  if (stats.missingPrompt) {
    log(
      "warn",
      t(
        `有 ${stats.missingPrompt} 件没提取到提示词。原始记录已完整保留在各自的 metadata.json 里（raw 字段），` +
          `可以据此调整字段映射。`,
        `${stats.missingPrompt} item(s) had no prompt extracted. The raw server record is kept in each metadata.json, so the mapping can be fixed from there.`
      )
    );
  }

  send({ type: "EXPORT_DONE", summary });
  return summary;
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === "EXPORT_JOB") {
    if (activeJob) {
      respond({ ok: false, error: t("已有导出任务在运行", "An export is already running") });
      return true;
    }
    activeJob = runJob(msg.job)
      .catch((err) => {
        log("error", t(`导出中止：${err.message}`, `Export aborted: ${err.message}`));
        send({ type: "EXPORT_FAILED", error: err.message, unauthorized: !!err.unauthorized });
      })
      .finally(() => {
        activeJob = null;
      });
    respond({ ok: true });
    return true;
  }

  if (msg?.type === "EXPORT_REVOKE") {
    const url = blobUrls.get(String(msg.part));
    if (url) {
      URL.revokeObjectURL(url);
      blobUrls.delete(String(msg.part));
    }
    respond({ ok: true });
    return true;
  }

  return false;
});
