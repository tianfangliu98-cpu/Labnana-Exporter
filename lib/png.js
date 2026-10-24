/**
 * PNG 元数据写入：把生成参数塞进 iTXt 块。
 *
 * 用 A1111 约定的 `parameters` 关键字，这样把图片拖进
 * WebUI、ComfyUI、以及各类「读 PNG 元数据」的工具里，提示词都能回读。
 * 对 non-PNG（webp/jpeg）直接跳过，由 sidecar 文件兜底。
 */

import { crc32 } from "./zip.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

function readU32(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

function writeU32(arr, off, value) {
  arr[off] = (value >>> 24) & 0xff;
  arr[off + 1] = (value >>> 16) & 0xff;
  arr[off + 2] = (value >>> 8) & 0xff;
  arr[off + 3] = value & 0xff;
}

const latin1 = (s) => {
  const out = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0xff) throw new Error("iTXt 关键字必须是 Latin-1");
    out.push(code);
  }
  return new Uint8Array(out);
};

const utf8 = new TextEncoder();

/** 构造一个完整 PNG 块（长度 + 类型 + 数据 + CRC）。 */
function makeChunk(type, data) {
  const typeBytes = latin1(type);
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  writeU32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  writeU32(chunk, 8 + data.length, crc32(crcInput));
  return chunk;
}

/**
 * 在 IHDR 之后插入一个 iTXt 块。
 * @param {Uint8Array} bytes 原始 PNG
 * @param {string} keyword 关键字（Latin-1，≤79 字节）
 * @param {string} text UTF-8 文本
 * @returns {Uint8Array}
 */
export function insertItxt(bytes, keyword, text) {
  if (!isPng(bytes)) return bytes;

  const kw = latin1(keyword);
  if (kw.length > 79) throw new Error("iTXt 关键字过长");

  const textBytes = utf8.encode(text);
  // keyword \0 flag \0 method \0 languageTag \0 translatedKeyword \0 text
  const data = new Uint8Array(kw.length + 1 + 1 + 1 + 1 + 1 + textBytes.length);
  let p = 0;
  data.set(kw, p);
  p += kw.length;
  data[p++] = 0; // 关键字结束
  data[p++] = 0; // 不压缩
  data[p++] = 0; // 压缩方法
  data[p++] = 0; // languageTag 为空
  data[p++] = 0; // translatedKeyword 为空
  data.set(textBytes, p);

  const chunk = makeChunk("iTXt", data);

  // 找到 IHDR 结束位置：8 字节签名 + (4+4+len+4)
  const ihdrLen = readU32(bytes, 8);
  const insertAt = 8 + 12 + ihdrLen;

  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(bytes.subarray(insertAt), insertAt + chunk.length);
  return out;
}

/**
 * 组织成 A1111 风格的参数文本。
 * 注意：Labnana 走的是 Gemini / GPT-Image 系列，没有 steps/CFG/seed 这些
 * 概念，所以这里只写真实存在的字段，不编造数值。
 */
export function buildParametersText(record) {
  const lines = [];
  lines.push(record.prompt || "(无提示词)");

  const params = [];
  if (record.model) params.push(`Model: ${record.model}`);
  if (record.imageSize) params.push(`Size: ${record.imageSize}`);
  if (record.aspectRatio) params.push(`Aspect ratio: ${record.aspectRatio}`);
  if (record.quality) params.push(`Quality: ${record.quality}`);
  if (record.width && record.height) params.push(`Pixels: ${record.width}x${record.height}`);
  if (record.batchCount && record.batchCount > 1) params.push(`Batch: ${record.batchCount}`);
  if (record.remixSourceImageId) params.push(`Source image: ${record.remixSourceImageId}`);
  if (record.referenceImageUrls?.length) {
    params.push(`Reference images: ${record.referenceImageUrls.length}`);
  }
  if (params.length) lines.push(params.join(", "));

  return lines.join("\n");
}
