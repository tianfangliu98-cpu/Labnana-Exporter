const DEFAULTS = { includeRefs: true, saveAs: false, skipImages: false };

const LANG_EN = !/^zh/i.test(navigator.language || "zh");
const t = (zh, en) => (LANG_EN ? en : zh);

const LABELS = {
  title: t("Labnana 作品导出器", "Labnana Exporter"),
  sub: t("把提示词、参数、参考图和成图一起带走", "Take prompts, parameters, references and images with you"),
  "lbl-refs": t("同时保存参考图", "Save reference images too"),
  "lbl-saveas": t("每次询问保存位置", "Ask where to save"),
  "lbl-skip": t("跳过成图（只补参考图）", "Skip images (refs only)"),
  open: t("打开我的作品页", "Open my library"),
  hint: t(
    "面板会出现在页面右下角。作品列表直接来自站内接口，不依赖页面结构，站点改版也不会失效。",
    "The panel appears at the bottom-right of the page. Works come straight from the site's own API, so a redesign won't break it."
  ),
};

for (const [id, text] of Object.entries(LABELS)) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

const refsEl = document.getElementById("refs");
const saveAsEl = document.getElementById("saveAs");
const skipImagesEl = document.getElementById("skipImages");
const openBtn = document.getElementById("open");

chrome.storage.local.get(DEFAULTS).then((settings) => {
  refsEl.checked = !!settings.includeRefs;
  saveAsEl.checked = !!settings.saveAs;
  skipImagesEl.checked = !!settings.skipImages;
});

refsEl.addEventListener("change", () => {
  chrome.storage.local.set({ includeRefs: refsEl.checked });
});

saveAsEl.addEventListener("change", () => {
  chrome.storage.local.set({ saveAs: saveAsEl.checked });
});

skipImagesEl.addEventListener("change", () => {
  chrome.storage.local.set({ skipImages: skipImagesEl.checked });
});

openBtn.addEventListener("click", async () => {
  const url = "https://labnana.com/zh/library";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith("https://labnana.com/")) {
    // 已经在站点里，刷新一下让面板重新挂载
    await chrome.tabs.reload(tab.id);
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});
