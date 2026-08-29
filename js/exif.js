// JPEG(APP1)およびHEIC/HEIF(ISOBMFFコンテナ内のExifアイテム)からGPS位置情報のみを読み取る
// 最小限のパーサー。PNG等それ以外の形式は非対応（呼び出し側で null を検知して手動選択にフォールバックする）。
//
// 注意: HEICのGPS抽出はコンテナのバイナリ構造を直接パースするため対応ブラウザを問わないが、
// サムネイル生成（<img>/canvas によるデコード）はブラウザのHEICデコード対応状況に依存する
// （Safari系は対応、Chrome/Firefox等は非対応な場合が多い。app.js側で非対応時は原本を保存する）。

function readGPSFromArrayBuffer(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    offset += 2;

    if (marker === 0xffe1) {
      const segLength = view.getUint16(offset, false);
      const segStart = offset + 2;
      if (
        view.getUint32(segStart, false) === 0x45786966 &&
        view.getUint16(segStart + 4, false) === 0x0000
      ) {
        return parseTiff(view, segStart + 6);
      }
      offset += segLength;
    } else if (marker === 0xffd9 || marker === 0xffda) {
      break;
    } else if ((marker & 0xff00) === 0xff00) {
      const segLength = view.getUint16(offset, false);
      offset += segLength;
    } else {
      break;
    }
  }
  return null;
}

function parseTiff(view, tiffStart) {
  const byteOrderMark = view.getUint16(tiffStart, false);
  const little = byteOrderMark === 0x4949; // 'II'
  if (!little && byteOrderMark !== 0x4d4d) return null; // not 'MM' either

  const ifd0Offset = view.getUint32(tiffStart + 4, little);
  const ifd0 = readIfd(view, tiffStart, tiffStart + ifd0Offset, little);
  const gpsIfdPointer = ifd0.tags[0x8825];
  if (gpsIfdPointer === undefined) return null;

  const gps = readIfd(view, tiffStart, tiffStart + gpsIfdPointer, little);
  const latRef = gps.ascii[1];
  const lat = gps.rationals[2];
  const lngRef = gps.ascii[3];
  const lng = gps.rationals[4];
  if (!lat || !lng || !latRef || !lngRef) return null;

  let latitude = lat[0] + lat[1] / 60 + lat[2] / 3600;
  let longitude = lng[0] + lng[1] / 60 + lng[2] / 3600;
  if (latRef === 'S') latitude = -latitude;
  if (lngRef === 'W') longitude = -longitude;

  if (!isFinite(latitude) || !isFinite(longitude)) return null;
  return { lat: latitude, lng: longitude };
}

function readIfd(view, tiffStart, ifdStart, little) {
  const result = { tags: {}, ascii: {}, rationals: {} };
  const entryCount = view.getUint16(ifdStart, little);
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdStart + 2 + i * 12;
    const tag = view.getUint16(entryOffset, little);
    const type = view.getUint16(entryOffset + 2, little);
    const count = view.getUint32(entryOffset + 4, little);
    const valueOffset = entryOffset + 8;

    if (type === 4 && count === 1) {
      // LONG, fits inline
      result.tags[tag] = view.getUint32(valueOffset, little);
    } else if (type === 2) {
      // ASCII
      const dataStart = count <= 4 ? valueOffset : tiffStart + view.getUint32(valueOffset, little);
      let str = '';
      for (let j = 0; j < count - 1; j++) {
        str += String.fromCharCode(view.getUint8(dataStart + j));
      }
      result.ascii[tag] = str;
    } else if (type === 5) {
      // RATIONAL[count]
      const dataStart = tiffStart + view.getUint32(valueOffset, little);
      const values = [];
      for (let j = 0; j < count; j++) {
        const num = view.getUint32(dataStart + j * 8, little);
        const den = view.getUint32(dataStart + j * 8 + 4, little);
        values.push(den === 0 ? 0 : num / den);
      }
      result.rationals[tag] = values;
    }
  }
  return result;
}

// ---------- HEIC/HEIF (ISOBMFF) ----------

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function readBoxes(view, start, end) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false);
    const type = readFourCC(view, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const high = view.getUint32(offset + 8, false);
      const low = view.getUint32(offset + 12, false);
      size = high * 4294967296 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize) break;
    boxes.push({ type, dataStart: offset + headerSize, dataEnd: offset + size });
    offset += size;
  }
  return boxes;
}

function findBox(boxes, type) {
  return boxes.find((b) => b.type === type);
}

// iinf: item_ID -> item_type（'Exif' を含むアイテムを探すために使用）
function parseIinf(view, box) {
  const version = view.getUint8(box.dataStart);
  const entryCountSize = version === 0 ? 2 : 4;
  const childrenStart = box.dataStart + 4 + entryCountSize;
  const children = readBoxes(view, childrenStart, box.dataEnd);

  const items = {};
  for (const child of children) {
    if (child.type !== 'infe') continue;
    const infeVersion = view.getUint8(child.dataStart);
    if (infeVersion < 2) continue; // 旧バージョンのitem_ID(16bit固定)は現行ファイルでは稀なため非対応
    let p = child.dataStart + 4;
    let itemId;
    if (infeVersion === 2) {
      itemId = view.getUint16(p, false);
      p += 2;
    } else {
      itemId = view.getUint32(p, false);
      p += 4;
    }
    p += 2; // item_protection_index
    const itemType = readFourCC(view, p);
    items[itemId] = itemType;
  }
  return items;
}

// iloc: item_ID -> [{offset, length}, ...]（ファイル内の格納位置）
function parseIloc(view, box) {
  const version = view.getUint8(box.dataStart);
  let p = box.dataStart + 4;

  const sizesByte1 = view.getUint8(p);
  p += 1;
  const offsetSize = sizesByte1 >> 4;
  const lengthSize = sizesByte1 & 0xf;

  const sizesByte2 = view.getUint8(p);
  p += 1;
  const baseOffsetSize = sizesByte2 >> 4;
  const indexSize = version === 1 || version === 2 ? sizesByte2 & 0xf : 0;

  let itemCount;
  if (version < 2) {
    itemCount = view.getUint16(p, false);
    p += 2;
  } else {
    itemCount = view.getUint32(p, false);
    p += 4;
  }

  function readUint(size) {
    let v = 0;
    for (let i = 0; i < size; i++) {
      v = v * 256 + view.getUint8(p);
      p += 1;
    }
    return v;
  }

  const items = {};
  for (let i = 0; i < itemCount; i++) {
    let itemId;
    if (version < 2) {
      itemId = view.getUint16(p, false);
      p += 2;
    } else {
      itemId = view.getUint32(p, false);
      p += 4;
    }

    if (version === 1 || version === 2) p += 2; // construction_method
    p += 2; // data_reference_index
    const baseOffset = readUint(baseOffsetSize);
    const extentCount = view.getUint16(p, false);
    p += 2;

    const extents = [];
    for (let e = 0; e < extentCount; e++) {
      if ((version === 1 || version === 2) && indexSize > 0) readUint(indexSize);
      const extOffset = readUint(offsetSize);
      const extLength = readUint(lengthSize);
      extents.push({ offset: baseOffset + extOffset, length: extLength });
    }
    items[itemId] = extents;
  }
  return items;
}

function parseHeif(view) {
  const topBoxes = readBoxes(view, 0, view.byteLength);
  const metaBox = findBox(topBoxes, 'meta');
  if (!metaBox) return null;

  // metaはFullBox（version/flags 4バイト）を持つ
  const metaChildren = readBoxes(view, metaBox.dataStart + 4, metaBox.dataEnd);
  const iinfBox = findBox(metaChildren, 'iinf');
  const ilocBox = findBox(metaChildren, 'iloc');
  if (!iinfBox || !ilocBox) return null;

  const itemTypes = parseIinf(view, iinfBox);
  const itemLocations = parseIloc(view, ilocBox);

  let exifItemId = null;
  for (const id of Object.keys(itemTypes)) {
    if (itemTypes[id] === 'Exif') {
      exifItemId = Number(id);
      break;
    }
  }
  if (exifItemId === null) return null;

  const extents = itemLocations[exifItemId];
  if (!extents || extents.length === 0) return null;
  const { offset, length } = extents[0];
  if (offset < 0 || offset + length > view.byteLength) return null;

  // Exifアイテムのデータは [4バイトのTIFFヘッダーまでのオフセット]["Exif\0\0"][TIFFデータ] という並び
  const exifOffset = view.getUint32(offset, false);
  const tiffStart = offset + 4 + exifOffset;
  if (tiffStart >= offset + length) return null;
  return parseTiff(view, tiffStart);
}

function isHeif(view) {
  return view.byteLength >= 12 && readFourCC(view, 4) === 'ftyp';
}

// ---------- エントリーポイント ----------

async function extractGPSFromFile(file) {
  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength >= 2 && view.getUint16(0, false) === 0xffd8) {
      return readGPSFromArrayBuffer(buffer);
    }
    if (isHeif(view)) {
      return parseHeif(view);
    }
    return null;
  } catch (e) {
    console.warn('EXIF読み取りに失敗しました', e);
    return null;
  }
}
