/**
 * 极简 ZIP 写入器（STORE，不压缩）。
 *
 * 图片本身已是压缩格式，再 deflate 收益接近 0，反而要吃 CPU 与内存，
 * 所以这里只用 STORE 方式打包 —— 兼容性最好，Windows 资源管理器、
 * macOS 归档工具、7-Zip 全都能正常打开。
 *
 * 支持 UTF-8 文件名标志位（bit 11），中文路径不会乱码。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 把 Date 转成 DOS 时间/日期对。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

const encoder = new TextEncoder();

class ByteBuilder {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  u16(v) {
    const b = new Uint8Array(2);
    b[0] = v & 0xff;
    b[1] = (v >>> 8) & 0xff;
    this.push(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    b[0] = v & 0xff;
    b[1] = (v >>> 8) & 0xff;
    b[2] = (v >>> 16) & 0xff;
    b[3] = (v >>> 24) & 0xff;
    this.push(b);
  }
  bytes(b) {
    this.push(b instanceof Uint8Array ? b : new Uint8Array(b));
  }
  push(b) {
    this.parts.push(b);
    this.length += b.length;
  }
  concat() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

export class ZipWriter {
  constructor() {
    this.localParts = [];
    this.centralParts = [];
    this.offset = 0;
    this.count = 0;
    this.names = new Set();
  }

  get size() {
    return this.offset;
  }

  /**
   * 追加一个文件。
   * @param {string} path 压缩包内路径，用 / 分隔
   * @param {Uint8Array|string} data 内容
   * @param {Date} [date] 修改时间
   */
  add(path, data, date = new Date()) {
    let name = path.replace(/^\/+/, "");
    // 同名冲突时自动加后缀，避免静默覆盖
    if (this.names.has(name)) {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let i = 2;
      while (this.names.has(`${base}_${i}${ext}`)) i++;
      name = `${base}_${i}${ext}`;
    }
    this.names.add(name);

    const nameBytes = encoder.encode(name);
    const body = typeof data === "string" ? encoder.encode(data) : data;
    const crc = crc32(body);
    const { dosTime, dosDate } = dosDateTime(date);

    const local = new ByteBuilder();
    local.u32(0x04034b50);
    local.u16(20); // version needed
    local.u16(0x0800); // UTF-8 文件名
    local.u16(0); // method: store
    local.u16(dosTime);
    local.u16(dosDate);
    local.u32(crc);
    local.u32(body.length);
    local.u32(body.length);
    local.u16(nameBytes.length);
    local.u16(0);
    local.bytes(nameBytes);
    local.bytes(body);

    const localBytes = local.concat();
    this.localParts.push(localBytes);

    const central = new ByteBuilder();
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(dosTime);
    central.u16(dosDate);
    central.u32(crc);
    central.u32(body.length);
    central.u32(body.length);
    central.u16(nameBytes.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(0);
    central.u32(this.offset);
    central.bytes(nameBytes);
    this.centralParts.push(central.concat());

    this.offset += localBytes.length;
    this.count += 1;
  }

  /** 生成最终 zip 字节流。 */
  build() {
    const centralBytes = (() => {
      const total = this.centralParts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of this.centralParts) {
        out.set(p, off);
        off += p.length;
      }
      return out;
    })();

    const eocd = new ByteBuilder();
    eocd.u32(0x06054b50);
    eocd.u16(0);
    eocd.u16(0);
    eocd.u16(this.count);
    eocd.u16(this.count);
    eocd.u32(centralBytes.length);
    eocd.u32(this.offset);
    eocd.u16(0);

    const out = new Uint8Array(this.offset + centralBytes.length + eocd.length);
    let off = 0;
    for (const p of this.localParts) {
      out.set(p, off);
      off += p.length;
    }
    out.set(centralBytes, off);
    off += centralBytes.length;
    out.set(eocd.concat(), off);
    return out;
  }
}
