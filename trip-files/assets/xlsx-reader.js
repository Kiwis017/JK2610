/* Minimal browser-side XLSX reader for local project workbooks. */
(function (global) {
  'use strict';

  function u16(view, at) { return view.getUint16(at, true); }
  function u32(view, at) { return view.getUint32(at, true); }
  function columnIndex(ref) {
    var letters = String(ref || '').replace(/[0-9]/g, '').toUpperCase(), n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
    return n - 1;
  }
  function textContent(el) {
    return Array.prototype.map.call(el.getElementsByTagNameNS('*', 't'), function (t) { return t.textContent || ''; }).join('');
  }
  function parseXml(source) {
    var doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Excel XML 格式无法读取');
    return doc;
  }
  async function unzip(file) {
    var bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer), eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('这个文件不是有效的 XLSX 工作簿');
    var count = u16(view, eocd + 10), offset = u32(view, eocd + 16), files = {};
    for (var j = 0; j < count; j++) {
      if (u32(view, offset) !== 0x02014b50) throw new Error('XLSX 压缩目录损坏');
      var method = u16(view, offset + 10), size = u32(view, offset + 20);
      var nameLen = u16(view, offset + 28), extraLen = u16(view, offset + 30), commentLen = u16(view, offset + 32);
      var localOffset = u32(view, offset + 42);
      var name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLen));
      var dataStart = localOffset + 30 + u16(view, localOffset + 26) + u16(view, localOffset + 28);
      var compressed = bytes.slice(dataStart, dataStart + size), content;
      if (method === 0) content = compressed;
      else if (method === 8 && typeof DecompressionStream !== 'undefined') {
        var stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        content = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error('浏览器不支持此 XLSX 压缩方式');
      files[name] = new TextDecoder().decode(content);
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }
  function parseSheet(source, sharedStrings) {
    var doc = parseXml(source), rows = Array.prototype.slice.call(doc.getElementsByTagNameNS('*', 'row'));
    return rows.map(function (row) {
      var cells = Array.prototype.slice.call(row.getElementsByTagNameNS('*', 'c')), values = [];
      cells.forEach(function (cell) {
        var col = columnIndex(cell.getAttribute('r'));
        var type = cell.getAttribute('t'), v = cell.getElementsByTagNameNS('*', 'v')[0];
        var value = v ? v.textContent : '';
        if (type === 's') value = sharedStrings[Number(value)] || '';
        else if (type === 'inlineStr') value = textContent(cell);
        else if (type === 'b') value = value === '1';
        values[col] = value;
      });
      return values;
    }).filter(function (row) { return row.some(function (v) { return v !== undefined && v !== ''; }); });
  }
  async function readWorkbook(file, sheetName) {
    var files = await unzip(file), workbookDoc = parseXml(files['xl/workbook.xml']);
    var relsDoc = parseXml(files['xl/_rels/workbook.xml.rels']), relMap = {};
    Array.prototype.forEach.call(relsDoc.getElementsByTagNameNS('*', 'Relationship'), function (r) {
      relMap[r.getAttribute('Id')] = r.getAttribute('Target');
    });
    var sheetNode = Array.prototype.find.call(workbookDoc.getElementsByTagNameNS('*', 'sheet'), function (s) { return s.getAttribute('name') === sheetName; });
    if (!sheetNode) throw new Error('工作簿中找不到工作表「' + sheetName + '」');
    var relId = sheetNode.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheetNode.getAttribute('r:id');
    var target = relMap[relId];
    if (!target) throw new Error('无法定位工作表「' + sheetName + '」');
    var sheetPath = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    var ss = [], shared = files['xl/sharedStrings.xml'];
    if (shared) {
      var ssDoc = parseXml(shared);
      ss = Array.prototype.map.call(ssDoc.getElementsByTagNameNS('*', 'si'), textContent);
    }
    var raw = parseSheet(files[sheetPath], ss);
    if (!raw.length) return [];
    var headers = raw[0].map(function (h) { return String(h == null ? '' : h).trim(); });
    return raw.slice(1).map(function (row) {
      var item = {};
      headers.forEach(function (h, i) { if (h) item[h] = row[i] == null ? '' : row[i]; });
      return item;
    }).filter(function (item) { return Object.keys(item).some(function (k) { return item[k] !== ''; }); });
  }
  global.ProjectXlsxReader = { readWorkbook: readWorkbook };
})(window);
