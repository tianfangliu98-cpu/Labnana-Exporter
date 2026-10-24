/**
 * 从图片文件头读取像素尺寸（PNG / JPEG / WebP）。
 *
 * 为什么不用 <img> 或 createImageBitmap：
 * 这里只有字节，没有 DOM 解码；而且解码一张 4K 图纯属浪费，
 * 文件头里就写着尺寸，读几十字节的事。
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(b) {
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false;
  return true;
}

/**
 * @param {Uint8Array} b 完整文件字节（JPEG 需要能读到 SOF 段）
 * @returns {{width:number,height:number}|null}
 */
export function getImageSize(b) {
  if (!b || b.length < 24) return null;

  // ---- PNG：IHDR 固定在第 16 字节起 ----
  if (isPng(b)) {
    const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    return w && h ? { width: w, height: h } : null;
  }

  // ---- JPEG：逐段扫描，找 SOF0/SOF2 等起始帧 ----
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    const n = b.length;
    while (i < n - 9) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        // 填充字节
        i += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const segLen = (b[i + 2] << 8) | b[i + 3];
      // SOF0..SOF15，排除 C4(DHT)/C8(JPG)/CC(DAC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return w && h ? { width: w, height: h } : null;
      }
      if (segLen < 2) return null; // 长度非法，防死循环
      i += 2 + segLen;
    }
    return null;
  }

  // ---- WebP ----
  const ascii = (o, len) => String.fromCharCode(...b.slice(o, o + len));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 " && b.length >= 30) {
      return {
        width: ((b[26] | (b[27] << 8)) & 0x3fff) || 0,
        height: ((b[28] | (b[29] << 8)) & 0x3fff) || 0,
      };
    }
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8X" && b.length >= 30) {
      return {
        width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
        height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
      };
    }
  }

  return null;
}
