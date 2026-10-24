/**
 * 内容脚本：在 labnana.com 上挂一个独立浮层面板。
 *
 * 关键设计：作品列表不走 DOM 抓取，而是直接调站内接口。
 * 站点改版、卡片结构变化都不会影响这里 —— 因为数据来源是 API，
 * 不是那堆 className。
 */
(() => {
  if (window.__LABNANA_EXPORTER_UI__) return;
  window.__LABNANA_EXPORTER_UI__ = true;

  const API_BASE = "https://api.listenhub.ai/api";
  const PAGE_SIZE = 40;
  const MAX_AUTO_PAGES = 500; // 单次「全部载入」的安全上限（500×40=20000 件）
  const RENDER_LIMIT = 400; // 列表最多渲染多少行，导出不受影响

  /**
   * 语言：浏览器是中文就中文，其余一律英文。
   * 写成 t(中, 英) 而不是查表，是为了让两种文案挨在一起，
   * 改文案时不会出现「只改了一边」的漏网之鱼。
   */
  const LANG_EN = !/^zh/i.test(navigator.language || "zh");
  const t = (zh, en) => (LANG_EN ? en : zh);

  /** 毫秒 -> 「12分34秒」/「12m 34s」。 */
  const fmtDuration = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? t(`${m} 分 ${s} 秒`, `${m}m ${s}s`) : t(`${s} 秒`, `${s}s`);
  };

  const state = {
    items: [],
    selected: new Set(),
    page: 0,
    hasMore: true,
    total: null,
    loading: false,
    exporting: false,
    exportStartedAt: 0,
    token: null,
    capturedHeaders: null,
    diagnosed: false,
    myUserId: undefined,
    settings: { includeRefs: true, skipImages: false, naming: "date" },
  };

  const CHANNEL = "LABNANA_EXPORTER";

  // ---------------- 鉴权 ----------------
  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[2]) : null;
  }

  function getToken() {
    // cookie 里存的就是 "Bearer xxx" 完整形态
    return readCookie("app_access_token");
  }

  function getRefreshToken() {
    return readCookie("app_refresh_token");
  }

  function baseHeaders() {
    const headers = {
      "Content-Type": "application/json",
      ...(state.capturedHeaders || {}),
    };
    const token = state.token || getToken();
    if (token) headers.Authorization = token;
    return headers;
  }

  // 监听注入脚本传来的真实鉴权头
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL) return;
    if (data.type === "auth") {
      state.capturedHeaders = data.payload;
      const authKey = Object.keys(data.payload).find((k) => k.toLowerCase() === "authorization");
      if (authKey && !state.token) state.token = data.payload[authKey];
    }
  });

  async function apiGet(path, query = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, v);
    }
    const qs = params.toString();
    const url = `${API_BASE}${path}${qs ? "?" + qs : ""}`;
    const res = await fetch(url, { headers: baseHeaders(), credentials: "omit" });
    const json = await res.json().catch(() => null);

    if (res.status === 401) {
      const refreshed = await tryRefreshToken();
      if (refreshed) return apiGet(path, query);
      throw new Error(t("登录已失效，请先在网页上重新登录 Labnana", "Session expired — please sign in to Labnana again"));
    }
    if (!res.ok) throw new Error(t(`接口请求失败（HTTP ${res.status}）`, `Request failed (HTTP ${res.status})`));
    if (json && json.code !== 0 && json.code !== undefined) {
      throw new Error(json.message || t(`接口返回 code=${json.code}`, `API returned code=${json.code}`));
    }
    return json?.data ?? json;
  }

  /**
   * 取当前登录用户的 ID，只查一次。
   * 用来卡住「只能导出自己的作品」这条底线 —— 公共作品即使拿到 ID 也不导。
   */
  async function getMyUserId() {
    if (state.myUserId !== undefined) return state.myUserId;
    try {
      const me = await apiGet("/v1/users/me");
      state.myUserId = me?.id || me?.userId || null;
    } catch {
      state.myUserId = null;
    }
    return state.myUserId;
  }

  async function tryRefreshToken() {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE}/v1/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ grantType: "refresh_token", refreshToken }),
      });
      const json = await res.json().catch(() => null);
      if (json?.code === 0 && json.data?.accessToken) {
        state.token = `Bearer ${json.data.accessToken}`;
        return true;
      }
    } catch {
      /* 刷新失败就交给上层报错 */
    }
    return false;
  }

  // ---------------- 数据 ----------------
  const toUrls = (value) => {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    return arr
      .map((r) =>
        typeof r === "string" ? r : r?.url || r?.fileUri || r?.fileData?.fileUri || r?.imageUrl
      )
      .filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
  };

  /** 字段名猜不中时深挖原始记录，避免提示词变空白。 */
  const deepFindString = (root, keyRe, maxDepth = 5) => {
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
  };

  const deepFindUrls = (root, keyRe, maxDepth = 5) => {
    const seen = new Set();
    const found = [];
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > maxDepth || seen.has(node)) return;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (keyRe.test(key)) {
          for (const url of toUrls(value)) if (!found.includes(url)) found.push(url);
        }
        if (value && typeof value === "object") walk(value, depth + 1);
      }
    };
    walk(root, 0);
    return found;
  };

  function normalize(raw) {
    const pick = (paths) => {
      for (const path of paths) {
        let cur = raw;
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
    };

    const refs = pick([
      "referenceImageUrls",
      "referenceImages",
      "refImages",
      "input.referenceImages",
    ]);
    let refUrls = toUrls(refs);
    if (!refUrls.length) refUrls = deepFindUrls(raw, /^reference.*(url|image|uri)s?$/i);

    const promptValue =
      pick(["prompt", "promptText", "inputPrompt", "text", "content", "input.prompt"]) ??
      deepFindString(raw, /prompt/i);

    const createdAt = pick(["createdAt", "createTime", "created_at", "timestamp", "gmtCreate"]);
    let ts;
    if (typeof createdAt === "number") ts = createdAt < 1e12 ? createdAt * 1000 : createdAt;
    else if (createdAt) ts = Date.parse(createdAt);

    return {
      id: String(pick(["id", "imageId", "_id", "image_id"]) ?? ""),
      status: pick(["status", "taskStatus", "state"]),
      prompt: promptValue,
      negativePrompt: pick(["negativePrompt", "negative_prompt", "negative"]),
      model: pick(["model", "modelName", "modelId", "input.model"]),
      provider: pick(["provider", "vendor"]),
      imageSize: pick(["imageSize", "imageConfig.imageSize", "resolution"]),
      aspectRatio: pick(["aspectRatio", "ratio", "imageConfig.aspectRatio"]),
      quality: pick(["quality", "imageConfig.quality"]),
      batchCount: pick(["batchCount", "batchSize", "input.batchCount"]),
      imageUrl: pick(["imageUrl", "url", "outputUrl", "resultUrl"]),
      thumbnailUrl: pick(["thumbnailUrl", "thumbUrl", "previewUrl"]),
      referenceImageUrls: refUrls,
      width: pick(["width", "imageWidth"]),
      height: pick(["height", "imageHeight"]),
      isPublic: pick(["isPublic", "public"]),
      creator: (() => {
        const c = pick(["creator.userId", "creator.id", "creator", "userId"]);
        if (typeof c === "string") return c;
        if (c && typeof c === "object") return c.userId || c.id || undefined;
        return undefined;
      })(),
      remixSourceImageId: pick([
        "remixSourceImageId",
        "sourceImageId",
        "parentImageId",
        "rootImageId",
        "editRootImageId",
      ]),
      createdAt: Number.isFinite(ts) ? ts : undefined,
      raw,
    };
  }

  /**
   * 提示词字段没匹配上时，自动探一次详情接口并把字段名打到日志里。
   * 这样用户点一下就能把「真实字段长什么样」告诉我，不用自己开 F12。
   */
  async function diagnosePromptMapping(sampleItems) {
    if (!sampleItems.length || state.diagnosed) return;
    if (sampleItems.some((i) => i.prompt)) return;
    state.diagnosed = true;
    try {
      const detail = await apiGet(`/v1/banana/images/${encodeURIComponent(sampleItems[0].id)}`);
      const keys = Object.keys(detail || {});
      logLine(
        t(
          `没匹配到提示词字段。详情接口的顶层字段有：${keys.join(", ") || "（空）"}`,
          `No prompt field matched. Top-level keys from the detail API: ${keys.join(", ") || "(empty)"}`
        ),
        "warn"
      );
      logLine(
        t(
          "把上面这一行发给我，我按真实字段修正映射。原始数据不会丢，都在 metadata.json 的 raw 里。",
          "Send that line to the developer and the field mapping can be fixed. Nothing is lost — the raw record is kept in metadata.json."
        ),
        "warn"
      );
    } catch (err) {
      logLine(t(`详情接口探测失败：${err.message}`, `Detail probe failed: ${err.message}`), "warn");
    }
  }

  async function loadPage() {
    if (state.loading || (!state.hasMore && state.page > 0)) return;
    state.loading = true;
    renderStatus(t("正在拉取作品列表…", "Loading your works …"));
    try {
      const data = await apiGet("/v1/banana/images", {
        scope: "me",
        page: state.page + 1,
        pageSize: PAGE_SIZE,
      });
      const items = (data?.items ?? []).map(normalize).filter((r) => r.id);
      const pagination = data?.pagination ?? {};

      for (const item of items) {
        if (!state.items.some((x) => x.id === item.id)) {
          state.items.push(item);
          state.selected.add(item.id);
        }
      }
      state.page += 1;
      state.total = pagination.total ?? state.total;
      state.hasMore =
        typeof pagination.hasMore === "boolean"
          ? pagination.hasMore
          : items.length >= PAGE_SIZE;

      renderList();
      renderStatus(
        t(
          `已载入 ${state.items.length} 件${state.total ? ` / 共 ${state.total} 件` : ""}`,
          `Loaded ${state.items.length}${state.total ? ` / ${state.total} total` : ""}`
        )
      );
      diagnosePromptMapping(items);
    } catch (err) {
      renderStatus(err.message, "error");
    } finally {
      state.loading = false;
      renderButtons();
    }
  }

  async function loadAll(auto = false) {
    if (state.loading) return;
    let guard = 0;
    while (state.hasMore && guard < MAX_AUTO_PAGES) {
      const before = state.items.length;
      await loadPage();
      guard += 1;
      if (state.items.length === before && !state.hasMore) break;
    }
    if (auto)
      renderStatus(t(`全部载入完成，共 ${state.items.length} 件`, `All loaded: ${state.items.length} works`));

    // 撞到单次上限时明确告诉用户，别让人以为已经全了
    if (state.hasMore && guard >= MAX_AUTO_PAGES) {
      logLine(
        t(
          `已达单次载入上限（${MAX_AUTO_PAGES * PAGE_SIZE} 件），还有更多。再点一次「全部载入」继续。`,
          `Reached the single-run limit (${MAX_AUTO_PAGES * PAGE_SIZE} works) and there is more. Click “Load all” again to continue.`
        ),
        "warn"
      );
    }
  }

  // ---------------- 导出 ----------------
  function buildFilenameBase() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `Labnana-export-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
      d.getHours()
    )}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  async function startExport(items) {
    if (state.exporting) return;
    if (!items.length) {
      renderStatus(t("没有可导出的作品", "Nothing to export"), "warn");
      return;
    }

    // 大批量导出动辄一小时、几个 GB，先让用户确认一下再动手
    if (items.length >= 50) {
      const ok = window.confirm(
        t(
          `即将导出 ${items.length} 件作品。\n\n这可能耗时较长（每件要下载原图，几百件通常要半小时以上），` +
            `并生成多个压缩包，总大小可能有好几个 GB。\n\n确认开始吗？`,
          `About to export ${items.length} works.\n\nThis can take a long time (each image is downloaded ` +
            `individually; several hundred works often take 30+ minutes) and may produce multiple ` +
            `archives totalling several GB.\n\nContinue?`
        )
      );
      if (!ok) {
        renderStatus(t("已取消导出", "Export cancelled"), "warn");
        return;
      }
    }

    state.exporting = true;
    renderButtons();
    logLine(t(`开始导出 ${items.length} 件作品…`, `Exporting ${items.length} works …`));
    state.exportStartedAt = Date.now();

    // 超大书库时不再把每条服务端原始记录都塞进消息里：
    // 两万条 raw 能到几十 MB，会把扩展消息通道顶爆。
    // 反正 offscreen 本来就会逐条拉详情，raw 只是详情失败时的兜底。
    const keepRaw = items.length <= 1500;
    if (!keepRaw) {
      logLine(
        t(
          `作品较多（${items.length} 件），本次不携带原始记录，改为逐条实时拉取详情。`,
          `Large library (${items.length} works): raw records are omitted and details are fetched live.`
        )
      );
    }

    const payload = items.map((r) => ({
      record: {
        id: r.id,
        prompt: r.prompt,
        negativePrompt: r.negativePrompt,
        model: r.model,
        provider: r.provider,
        imageSize: r.imageSize,
        aspectRatio: r.aspectRatio,
        quality: r.quality,
        batchCount: r.batchCount,
        imageUrl: r.imageUrl,
        thumbnailUrl: r.thumbnailUrl,
        referenceImageUrls: r.referenceImageUrls,
        width: r.width,
        height: r.height,
        isPublic: r.isPublic,
        remixSourceImageId: r.remixSourceImageId,
        createdAt: r.createdAt,
        status: r.status,
        raw: keepRaw ? r.raw : {},
      },
    }));

    try {
      const res = await chrome.runtime.sendMessage({
        type: "EXPORT_START",
        items: payload,
        headers: baseHeaders(),
        filenameBase: buildFilenameBase(),
        includeRefs: state.settings.includeRefs,
        skipImages: state.settings.skipImages,
        naming: state.settings.naming,
      });
      if (res && res.ok === false) {
        renderStatus(res.error || t("导出启动失败", "Export failed to start"), "error");
        state.exporting = false;
      }
    } catch (err) {
      renderStatus(t(`导出启动失败：${err.message}`, `Export failed to start: ${err.message}`), "error");
      state.exporting = false;
    }
    renderButtons();
  }

  // ---------------- 按 ID 导出 ----------------
  /**
   * 从任意文本里抽作品 ID。
   * 直接支持粘贴整份 CSV —— 里面的日期、序号、提示词都是干扰项，
   * 所以优先只认 24 位十六进制（ObjectId 的形态），抽不到才退回按分隔符切。
   */
  function extractIds(text) {
    const set = new Set();
    const re = /[0-9a-f]{24}/gi;
    let m;
    while ((m = re.exec(text)) !== null) set.add(m[0].toLowerCase());
    if (set.size === 0) {
      for (const tok of text.split(/[\s,;，；、]+/)) {
        const t = tok.replace(/^["'\[]+/, "").replace(/["'\]]+$/, "").trim();
        if (t && /^[A-Za-z0-9_-]{8,}$/.test(t)) set.add(t);
      }
    }
    return [...set];
  }

  function updateByIdCount() {
    const n = extractIds($("byid-text").value).length;
    $("byid-count").textContent = t(`识别到 ${n} 个 ID`, `${n} ID(s) detected`);
    $("byid-go").disabled = n === 0;
  }

  function openByIdPanel() {
    $("byid").hidden = false;
    $("byid-text").value = "";
    updateByIdCount();
    $("byid-text").focus();
  }

  function closeByIdPanel() {
    $("byid").hidden = true;
  }

  async function exportByIds(idList) {
    if (!idList.length) {
      renderStatus(t("没有识别到作品 ID", "No work ID found"), "warn");
      return;
    }
    if (state.exporting) return;
    closeByIdPanel();
    logLine(t(`按 ID 导出：${idList.length} 件，正在逐条查详情…`, `Export by ID: ${idList.length} works, fetching details …`));
    state.exportStartedAt = Date.now();

    const records = [];
    let failed = 0;
    let foreign = 0;
    const myId = await getMyUserId();
    if (!myId) {
      logLine(
        t(
          "没能确认当前账号 ID，跳过归属校验（列表导出仍然只包含你自己的作品）",
          "Could not confirm your user ID, so ownership check is skipped (list export still only covers your own works)"
        ),
        "warn"
      );
    }

    for (let i = 0; i < idList.length; i++) {
      setProgress((i + 1) / idList.length, t(`查询详情 ${i + 1}/${idList.length}`, `Fetching detail ${i + 1}/${idList.length}`));
      try {
        const detail = await apiGet(`/v1/banana/images/${encodeURIComponent(idList[i])}`);
        const rec = normalize({ ...(detail || {}), id: (detail && detail.id) || idList[i] });
        if (!rec.id) rec.id = idList[i];
        rec.raw = detail || {};

        // 只导自己的：别人的作品（哪怕公开可见）一律跳过
        if (myId && rec.creator && rec.creator !== myId) {
          foreign += 1;
          logLine(
            t(`${idList[i]} 不属于当前账号，已跳过`, `${idList[i]} belongs to another account — skipped`),
            "warn"
          );
          continue;
        }

        records.push(rec);
        if (!rec.imageUrl) {
          logLine(
            t(
              `${idList[i]} 查到了，但接口没给成图地址（多半是生成失败或仍在生成）`,
              `${idList[i]} found, but the API returned no image URL (likely failed or still generating)`
            ),
            "warn"
          );
        }
      } catch (err) {
        failed += 1;
        logLine(t(`${idList[i]} 查询失败：${err.message}`, `${idList[i]} lookup failed: ${err.message}`), "warn");
      }
    }
    setProgress(null, "");

    if (!records.length) {
      renderStatus(
        foreign && !failed
          ? t(`${foreign} 个 ID 都不属于当前账号，没有可导出的`, `All ${foreign} IDs belong to other accounts — nothing to export`)
          : t(`这 ${idList.length} 个 ID 一个都没查到`, `None of the ${idList.length} IDs could be found`),
        "error"
      );
      return;
    }
    logLine(
      t(
        `查到 ${records.length} 件${failed ? `，${failed} 件查不到` : ""}${foreign ? `，${foreign} 件不属于本账号已跳过` : ""}`,
        `${records.length} found${failed ? `, ${failed} not found` : ""}${foreign ? `, ${foreign} skipped (not yours)` : ""}`
      ),
      "ok"
    );
    await startExport(records);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "EXPORT_PROGRESS") {
      const { phase, done, total, label } = msg;
      let text = label;
      // 给长任务一点时间感：已用多久、还剩多久
      if (phase === "running" && total && done > 0 && state.exportStartedAt) {
        const elapsed = Date.now() - state.exportStartedAt;
        const remain = (elapsed / done) * (total - done);
        text = `${label} · ${t("已用", "elapsed")} ${fmtDuration(elapsed)} · ${t(
          "预计剩余",
          "ETA"
        )} ${fmtDuration(remain)}`;
      }
      setProgress(total ? done / total : null, text);
      if (phase === "downloading") logLine(label);
    } else if (msg.type === "EXPORT_LOG") {
      logLine(msg.message, msg.level);
    } else if (msg.type === "EXPORT_DONE") {
      state.exporting = false;
      const s = msg.summary || {};
      logLine(
        t(
          `完成：成图 ${s.images ?? 0} 张，参考图 ${s.refs ?? 0} 张，压缩包 ${s.parts ?? 0} 个，` +
            `耗时 ${((s.elapsed ?? 0) / 1000).toFixed(1)} 秒`,
          `Done: ${s.images ?? 0} images, ${s.refs ?? 0} reference images, ${s.parts ?? 0} archive(s), ` +
            `${((s.elapsed ?? 0) / 1000).toFixed(1)}s`
        ),
        "ok"
      );
      if (s.errors?.length) {
        for (const e of s.errors.slice(0, 10)) logLine(e, "warn");
        if (s.errors.length > 10)
          logLine(t(`…另有 ${s.errors.length - 10} 条错误未显示（完整清单见包内 errorlog.txt）`, `…plus ${s.errors.length - 10} more (see errorlog.txt in the archive)`), "warn");
      }
      if (s.foreign) {
        logLine(
          t(
            `${s.foreign} 件不属于当前账号，已跳过`,
            `${s.foreign} item(s) belonged to other accounts and were skipped`
          ),
          "warn"
        );
      }
      if (s.skipped?.length) {
        logLine(t(`${s.skipped.length} 件因缺少成图被跳过`, `${s.skipped.length} skipped (no image)`), "warn");
      }
      setProgress(null, t("全部完成", "All done"));
      renderButtons();
    } else if (msg.type === "EXPORT_FAILED") {
      state.exporting = false;
      setProgress(null, t(`导出失败：${msg.error}`, `Export failed: ${msg.error}`));
      logLine(t(`导出失败：${msg.error}`, `Export failed: ${msg.error}`), "error");
      if (msg.unauthorized) {
        logLine(t("请刷新页面重新登录 Labnana 后再试", "Please refresh the page and sign in to Labnana again"), "error");
      }
      renderButtons();
    }
  });

  // ---------------- 界面 ----------------
  const host = document.createElement("div");
  host.id = "labnana-exporter-host";
  host.style.cssText = "position:fixed;z-index:2147483646;inset:auto 16px 16px auto;";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
          "PingFang SC", "Microsoft YaHei", sans-serif; }
      .wrap {
        width: 380px; max-height: 72vh; display: flex; flex-direction: column;
        background: rgba(24, 24, 27, .97); color: #e4e4e7;
        border: 1px solid rgba(255,255,255,.10); border-radius: 14px;
        box-shadow: 0 18px 48px rgba(0,0,0,.55);
        backdrop-filter: blur(12px); overflow: hidden;
        font-size: 13px; line-height: 1.45; position: relative;
      }
      .wrap.collapsed .body, .wrap.collapsed .foot { display: none; }
      .head {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; background: rgba(255,255,255,.04);
        border-bottom: 1px solid rgba(255,255,255,.08); cursor: pointer; user-select: none;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #a1a1aa; flex: none; }
      .dot.ok { background: #34d399; }
      .dot.busy { background: #fbbf24; animation: pulse 1.2s infinite; }
      .dot.error { background: #f87171; }
      @keyframes pulse { 50% { opacity: .35; } }
      .title { font-weight: 600; letter-spacing: .2px; flex: 1; }
      .chev { opacity: .6; font-size: 11px; }
      .body { padding: 8px 12px; overflow: auto; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
      button {
        appearance: none; border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.06); color: #e4e4e7;
        border-radius: 7px; padding: 5px 9px; font-size: 12px; cursor: pointer;
        transition: background .15s, border-color .15s;
      }
      button:hover:not(:disabled) { background: rgba(255,255,255,.13); }
      button:disabled { opacity: .4; cursor: default; }
      button.primary {
        background: linear-gradient(180deg, #6366f1, #4f46e5);
        border-color: #6366f1; font-weight: 600;
      }
      button.primary:hover:not(:disabled) { background: linear-gradient(180deg, #7c7ff5, #5b52ea); }
      .status { font-size: 12px; color: #a1a1aa; margin-bottom: 6px; min-height: 16px; }
      .status.error { color: #f87171; }
      .status.warn { color: #fbbf24; }
      .list { display: flex; flex-direction: column; gap: 6px; }
      .row {
        display: flex; gap: 8px; align-items: center; padding: 5px;
        border-radius: 8px; background: rgba(255,255,255,.03); cursor: pointer;
      }
      .row:hover { background: rgba(255,255,255,.07); }
      .row img {
        width: 44px; height: 44px; border-radius: 6px; object-fit: cover;
        background: #27272a; flex: none;
      }
      .row .txt { min-width: 0; flex: 1; }
      .row .p {
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; color: #d4d4d8; font-size: 12px;
      }
      .row .m { color: #71717a; font-size: 11px; margin-top: 2px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .row input { flex: none; accent-color: #6366f1; }
      .empty { color: #71717a; text-align: center; padding: 18px 0; font-size: 12px; }
      .foot { padding: 8px 12px 10px; border-top: 1px solid rgba(255,255,255,.08); }
      .bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,.10); overflow: hidden; margin-bottom: 6px; }
      .bar i { display: block; height: 100%; width: 0%; background: #6366f1; transition: width .25s; }
      .log { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #a1a1aa;
        max-height: 90px; overflow: auto; white-space: pre-wrap; }
      .log .err { color: #f87171; }
      .log .ok { color: #34d399; }
      .log .warn { color: #fbbf24; }
      .note { color: #71717a; font-size: 11px; margin-top: 4px; }
      .byid {
        position: absolute; inset: 0; z-index: 9;
        background: rgba(20, 20, 23, .985);
        padding: 12px; display: flex; flex-direction: column; gap: 8px;
      }
      .byid[hidden] { display: none; }
      .byid h3 { margin: 0; font-size: 13px; font-weight: 600; }
      .byid .tip { color: #71717a; font-size: 11px; line-height: 1.5; margin: 0; }
      .byid textarea {
        flex: 1; min-height: 150px; resize: none;
        background: #27272a; color: #e4e4e7;
        border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
        padding: 8px; font-size: 12px;
        font-family: ui-monospace, Consolas, monospace;
        outline: none;
      }
      .byid textarea:focus { border-color: #6366f1; }
      .byid .count { font-size: 11px; color: #a1a1aa; }
      .byid .actions { display: flex; gap: 6px; }
    </style>
    <div class="wrap" id="wrap">
      <div class="head" id="head">
        <span class="dot" id="dot"></span>
        <span class="title" id="title">Labnana 作品导出器</span>
        <span class="chev" id="chev">收起</span>
      </div>
      <div class="body">
        <div class="toolbar">
          <button id="btn-refresh">刷新列表</button>
          <button id="btn-all">全部载入</button>
          <button id="btn-select">全选</button>
          <button id="btn-clear">清空</button>
        </div>
        <div class="status" id="status">点「刷新列表」开始</div>
        <div class="list" id="list"><div class="empty" id="empty">还没有载入作品</div></div>
        <div class="note" id="note"></div>
      </div>
      <div class="foot">
        <div class="bar"><i id="bar"></i></div>
        <div class="toolbar" style="margin-bottom:6px">
          <button class="primary" id="btn-export">导出选中</button>
          <button id="btn-export-all">导出全部作品</button>
          <button id="btn-byid">按 ID 导出</button>
          <button id="btn-refs">参考图：开</button>
          <button id="btn-skipimg">成图：导出</button>
          <button id="btn-naming">命名：日期</button>
        </div>
        <div class="log" id="log"></div>
      </div>
      <div class="byid" id="byid" hidden>
        <h3 id="byid-title">按 ID 导出</h3>
        <p class="tip" id="byid-tip">
          一行一个作品 ID，也可以直接把整份 CSV 或链接粘进来 —— 会自动认出里面的 ID。
        </p>
        <textarea id="byid-text" placeholder="6adc477f7cbd4f1d3a88ef63&#10;6adb45d9f49554113bbb09ca"></textarea>
        <div class="count" id="byid-count">识别到 0 个 ID</div>
        <div class="actions">
          <button class="primary" id="byid-go">开始导出</button>
          <button id="byid-cancel">取消</button>
        </div>
      </div>
    </div>
  `;

  const $ = (id) => shadow.getElementById(id);
  const wrap = $("wrap");
  const dot = $("dot");
  const listEl = $("list");
  const statusEl = $("status");
  const logEl = $("log");
  const noteEl = $("note");

  /** 把静态文案按语言刷一遍。动态按钮由 renderButtons 负责。 */
  function initLabels() {
    const set = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text;
    };
    set("title", t("Labnana 作品导出器", "Labnana Exporter"));
    set("chev", t("收起", "Hide"));
    set("btn-refresh", t("刷新列表", "Refresh"));
    set("btn-all", t("全部载入", "Load all"));
    set("btn-select", t("全选", "Select all"));
    set("btn-clear", t("清空", "Clear"));
    set("btn-export-all", t("导出全部作品", "Export all"));
    set("btn-byid", t("按 ID 导出", "Export by ID"));
    set("byid-title", t("按 ID 导出", "Export by ID"));
    set("byid-go", t("开始导出", "Start export"));
    set("byid-cancel", t("取消", "Cancel"));
    set("empty", t("还没有载入作品", "No works loaded yet"));
    set("status", t("点「刷新列表」开始", "Click “Refresh” to start"));
    const tip = $("byid-tip");
    if (tip)
      tip.textContent = t(
        "一行一个作品 ID，也可以直接把整份 CSV 或链接粘进来 —— 会自动认出里面的 ID。",
        "One work ID per line. You can also paste a whole CSV or links — IDs are picked out automatically."
      );
    const ta = $("byid-text");
    if (ta) ta.placeholder = t("粘贴作品 ID…", "Paste work IDs …");
  }

  initLabels();
  const barEl = $("bar");

  function setDot(cls) {
    dot.className = "dot" + (cls ? " " + cls : "");
  }

  function renderStatus(text, level) {
    statusEl.textContent = text;
    statusEl.className = "status" + (level ? " " + level : "");
    setDot(level === "error" ? "error" : state.loading ? "busy" : state.items.length ? "ok" : "");
  }

  function setProgress(ratio, label) {
    if (ratio === null || ratio === undefined) {
      barEl.style.width = "0%";
    } else {
      barEl.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
    }
    if (label) statusEl.textContent = label;
  }

  function logLine(text, level) {
    if (!text) return;
    const line = document.createElement("div");
    if (level === "error") line.className = "err";
    else if (level === "ok") line.className = "ok";
    else if (level === "warn") line.className = "warn";
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    line.textContent = `[${time}] ${text}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.childElementCount > 200) logEl.removeChild(logEl.firstChild);
  }

  function renderList() {
    const shown = state.items.slice(0, RENDER_LIMIT);
    if (!shown.length) {
      listEl.innerHTML = `<div class="empty">${t("还没有载入作品", "No works loaded yet")}</div>`;
      noteEl.textContent = "";
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of shown) {
      const row = document.createElement("label");
      row.className = "row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.selected.has(item.id);
      cb.addEventListener("change", () => {
        if (cb.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        renderButtons();
      });

      const img = document.createElement("img");
      img.loading = "lazy";
      img.src = item.thumbnailUrl || item.imageUrl || "";
      img.alt = "";
      img.addEventListener("error", () => {
        img.style.visibility = "hidden";
      });

      const txt = document.createElement("div");
      txt.className = "txt";
      const p = document.createElement("div");
      p.className = "p";
      p.textContent = item.prompt || t("（无提示词）", "(no prompt)");
      const m = document.createElement("div");
      m.className = "m";
      m.textContent = [item.model, item.imageSize, item.aspectRatio]
        .filter(Boolean)
        .join(" · ");
      txt.append(p, m);

      row.append(cb, img, txt);
      frag.appendChild(row);
    }
    listEl.replaceChildren(frag);

    if (state.items.length > RENDER_LIMIT) {
      noteEl.textContent = t(
        `列表只显示前 ${RENDER_LIMIT} 件，导出不受影响（已选 ${state.selected.size} 件）`,
        `Only the first ${RENDER_LIMIT} are shown; export still covers everything (${state.selected.size} selected)`
      );
    } else {
      noteEl.textContent = t(`已选 ${state.selected.size} / ${state.items.length} 件`, `${state.selected.size} / ${state.items.length} selected`);
    }
    setDot(state.items.length ? "ok" : "");
  }

  function renderButtons() {
    $("btn-refresh").disabled = state.loading || state.exporting;
    $("btn-all").disabled = state.loading || state.exporting || !state.hasMore;
    $("btn-select").disabled = !state.items.length;
    $("btn-clear").disabled = !state.items.length;
    $("btn-export").disabled = state.exporting || state.selected.size === 0;
    $("btn-export-all").disabled = state.exporting || !state.items.length;
    $("btn-byid").disabled = state.exporting;
    $("btn-export").textContent = t(`导出选中（${state.selected.size}）`, `Export selected (${state.selected.size})`);
    $("btn-refs").textContent = t(
      `参考图：${state.settings.includeRefs ? "开" : "关"}`,
      `Refs: ${state.settings.includeRefs ? "on" : "off"}`
    );
    $("btn-skipimg").textContent = t(
      `成图：${state.settings.skipImages ? "跳过" : "导出"}`,
      `Images: ${state.settings.skipImages ? "skip" : "export"}`
    );
    $("btn-naming").textContent = t(
      `命名：${state.settings.naming === "date" ? "日期" : "序号"}`,
      `Names: ${state.settings.naming === "date" ? "date" : "seq"}`
    );
    noteEl.textContent =
      state.items.length > RENDER_LIMIT
        ? t(
          `列表只显示前 ${RENDER_LIMIT} 件，导出不受影响（已选 ${state.selected.size} 件）`,
          `Only the first ${RENDER_LIMIT} are shown; export still covers everything (${state.selected.size} selected)`
        )
        : state.items.length
          ? t(
              `已选 ${state.selected.size} / ${state.items.length} 件`,
              `${state.selected.size} / ${state.items.length} selected`
            )
          : "";
  }

  $("head").addEventListener("click", () => {
    wrap.classList.toggle("collapsed");
    $("chev").textContent = wrap.classList.contains("collapsed")
      ? t("展开", "Show")
      : t("收起", "Hide");
  });

  $("btn-refresh").addEventListener("click", async () => {
    state.items = [];
    state.selected.clear();
    state.page = 0;
    state.hasMore = true;
    state.total = null;
    renderList();
    await loadPage();
  });

  $("btn-all").addEventListener("click", () => loadAll(true));

  $("btn-select").addEventListener("click", () => {
    for (const item of state.items) state.selected.add(item.id);
    renderList();
    renderButtons();
  });

  $("btn-clear").addEventListener("click", () => {
    state.selected.clear();
    renderList();
    renderButtons();
  });

  $("btn-refs").addEventListener("click", () => {
    state.settings.includeRefs = !state.settings.includeRefs;
    chrome.storage.local.set({ includeRefs: state.settings.includeRefs });
    renderButtons();
  });

  $("btn-skipimg").addEventListener("click", () => {
    state.settings.skipImages = !state.settings.skipImages;
    chrome.storage.local.set({ skipImages: state.settings.skipImages });
    renderButtons();
    if (state.settings.skipImages) {
      logLine(
        t(
          "已跳过成图：本次只导参数文件和参考图，适合单独补参考图。",
          "Skipping images: only metadata and reference images will be exported. Useful for backfilling refs."
        ),
        "warn"
      );
    }
  });

  $("btn-naming").addEventListener("click", () => {
    state.settings.naming = state.settings.naming === "date" ? "seq" : "date";
    chrome.storage.local.set({ naming: state.settings.naming });
    renderButtons();
    logLine(
      state.settings.naming === "date"
        ? t("文件夹将按生成日期命名，如 2026-10-24_1351_a3f9", "Folders will be named by date, e.g. 2026-10-24_1351_a3f9")
        : t("文件夹将用序号+作品ID 命名，如 0001_6adc477f…", "Folders will be named seq+ID, e.g. 0001_6adc477f…")
    );
  });

  $("btn-byid").addEventListener("click", () => {
    if (!state.exporting) openByIdPanel();
  });
  $("byid-cancel").addEventListener("click", closeByIdPanel);
  $("byid-text").addEventListener("input", updateByIdCount);
  $("byid-go").addEventListener("click", () => {
    exportByIds(extractIds($("byid-text").value));
  });

  $("btn-export").addEventListener("click", () => {
    const items = state.items.filter((i) => state.selected.has(i.id));
    startExport(items);
  });

  $("btn-export-all").addEventListener("click", async () => {
    if (state.hasMore) await loadAll(false);
    const items = state.items.slice();
    for (const item of items) state.selected.add(item.id);
    renderList();
    renderButtons();
    startExport(items);
  });

  // 初始化
  document.documentElement.appendChild(host);
  chrome.storage.local.get({ includeRefs: true, skipImages: false, naming: "date" }).then((s) => {
    state.settings.includeRefs = !!s.includeRefs;
    state.settings.skipImages = !!s.skipImages;
    state.settings.naming = s.naming === "seq" ? "seq" : "date";
    renderButtons();
  });
  renderButtons();

  // 向注入脚本索取一次鉴权头
  window.postMessage({ source: CHANNEL, type: "get-auth" }, "*");

  // 页面本身就绪后再自动拉第一页，省一次点击
  setTimeout(() => {
    if (!state.items.length && !state.loading) loadPage();
  }, 1200);
})();
