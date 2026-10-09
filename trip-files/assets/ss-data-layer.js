/*!
 * ss-data-layer.js — HTML 直出页面的通用数据层（vanilla JS，零依赖）
 * ---------------------------------------------------------------------------
 * 定位：HTML 直出链路（Stage S2 html-builder）里所有页面共用的"数据基座桥接层"。
 *      等价于 React 脚手架 archive/ 里 src/lib/smartsheet.ts 的 useTableData，
 *      但改成命令式（无 React），可直接在 <script src="./assets/ss-data-layer.js"> 引用。
 *
 * ⛔ 这份文件是**固定库**，AI 生成页面时禁止手写/改写这里的逻辑，只允许调用。
 *    SmartsheetRuntime 由智能页宿主自动注入，页面不需要关心注入，只管调用。
 *
 * 暴露全局对象：window.SSDataLayer
 *   - SSDataLayer.waitRuntime(timeoutMs?)        → Promise<SmartsheetRuntime>
 *   - SSDataLayer.createTableStore(tableId)      → 返回一张表的数据句柄 tableData（records 缓存 + CRUD + 订阅）
 *   - SSDataLayer.readField(record, field)       → 按 field.method 读一个字段值（RecordProxy 方法映射）
 *   - SSDataLayer.readRecord(record, fields)     → 把一条 record 读成普通对象 { 字段名: 值 }
 *   - SSDataLayer.toast                          → { success, error }（宿主有 toast 用宿主，否则降级）
 *
 * tableData（createTableStore 返回的表数据句柄；下面用 tableData 泛指，多表时换成各自的变量名）：
 *   tableData.tableId                            子表 id
 *   tableData.getRecords()                       当前缓存的 RecordProxy[]
 *   tableData.getFieldOptions()                  { 字段名: string[] }（SELECT/MULTISELECT 选项）
 *   tableData.isLoading()                        boolean
 *   await tableData.reload()                     重新拉取（分页读，最多 1000）
 *   await tableData.create(values)               新建；成功自动 reload + toast
 *   await tableData.update(recordId, values)     更新；成功自动 reload + toast
 *   await tableData.delete(recordId)             删除；成功自动 reload + toast
 *   tableData.onChange(cb)                       订阅数据变化（reload 成功 / 宿主 onChange 都会触发）→ 返回取消函数
 *   await tableData.getLinkCandidates(fieldName) 关联列候选（配合 SmartsheetUploader.pickLinkRecords）
 *
 * 富字段高阶方法（内部封装「上传/选人 → 读最新 → 追加/覆盖 → update → reload」，页面一行调用；全部返回 boolean）：
 *   await tableData.uploadImageTo(recordId, fieldName, files)        上传图片并「追加」写入 IMAGE 字段（files=File|FileList|File[]）
 *   await tableData.uploadAttachmentTo(recordId, fieldName, files)   上传附件并「追加」写入 ATTACHMENT 字段
 *   await tableData.pickUsersInto(recordId, fieldName, { isMultiple })  弹选人面板并「追加」写入 USER 字段
 *   await tableData.pickLinksInto(recordId, fieldName, defaultIds)   弹关联面板并「整体覆盖」写入 LINK 字段
 *   await tableData.setFieldValue(recordId, fieldName, valueArray)   直接整份覆盖写回 IMAGE/ATTACHMENT/USER 字段（删除/清空传 []，勿用 length 守卫）
 *   await tableData.downloadAttachment(objKey)                       下载附件（objKey 即 attachment.fileId）
 *
 * ⚠️ 富字段（IMAGE/ATTACHMENT/USER）不要自己拼 create/update 的写入值——统一用上面高阶方法：
 *    - 追加：uploadImageTo / uploadAttachmentTo / pickUsersInto
 *    - 删除某几项 / 清空：先在页面里过滤出剩余数组，再 tableData.setFieldValue(recordId, field, 剩余数组)（清空传 []）
 *    - IMAGE 写入必须含全部 5 字段（id/title/imageUrl/width/height），ATTACHMENT 含 5 字段（fileId/name/size/fileExt/classify），
 *      USER 为 [{ id, name, avatarUrl }]——上述高阶方法内部已按契约透传，页面无需关心。
 *
 * CRUD 全部返回 boolean；失败自动 toast.error，不抛异常，不把 error 展示给用户。
 */
(function (global) {
  'use strict';

  var WAIT_TIMEOUT_MS = 15000;
  var WAIT_INTERVAL_MS = 50;

  // ── toast：优先用宿主注入的 toast，否则降级为控制台 + 轻量气泡 ──────────────
  var toast = {
    success: function (msg) { _toast(msg, 'success'); },
    error: function (msg) { _toast(msg, 'error'); },
  };
  function _toast(msg, kind) {
    // 宿主若注入了 window.toast / SmartsheetRuntime.toast，则优先用宿主的
    var host = global.toast || (global.SmartsheetRuntime && global.SmartsheetRuntime.toast);
    if (host && typeof host[kind] === 'function') { host[kind](msg); return; }
    // 降级：控制台 + 一个极简气泡（不依赖任何框架）
    try { (kind === 'error' ? console.error : console.log)('[ss] ' + msg); } catch (e) {}
    _fallbackBubble(msg, kind);
  }
  function _fallbackBubble(msg, kind) {
    if (typeof document === 'undefined' || !document.body) return;
    var el = document.createElement('div');
    el.textContent = String(msg);
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:99999;' +
      'max-width:80vw;padding:10px 16px;border-radius:8px;font-size:14px;line-height:1.4;' +
      'color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.18);pointer-events:none;' +
      'background:' + (kind === 'error' ? '#e5484d' : '#30a46c') + ';';
    document.body.appendChild(el);
    setTimeout(function () { el.parentNode && el.parentNode.removeChild(el); }, 2600);
  }

  // ── 等待宿主注入 SmartsheetRuntime ────────────────────────────────────────
  function waitRuntime(timeoutMs) {
    var limit = typeof timeoutMs === 'number' ? timeoutMs : WAIT_TIMEOUT_MS;
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      (function tick() {
        var rt = global.SmartsheetRuntime;
        if (rt && typeof rt.table === 'function') { resolve(rt); return; }
        if (Date.now() - started >= limit) { reject(new Error('SmartsheetRuntime 未就绪')); return; }
        setTimeout(tick, WAIT_INTERVAL_MS);
      })();
    });
  }

  // ── RecordProxy 字段读取：method 映射（对齐 smartsheet-runtime 契约）──────────
  // field: { name, method }。method ∈ text/number/select/multiSelect/date/checked/img/images/url/users/link/links/formula/attachments
  function readField(record, field) {
    if (!record || !field) return undefined;
    var name = field.name;
    var m = field.method || 'text';
    try {
      switch (m) {
        case 'number': return record.number(name);
        case 'select': return record.select(name);
        case 'multiSelect': return record.multiSelect(name);
        case 'date': return record.date(name);
        case 'checked': return record.checked(name);
        case 'img': return record.img(name);
        case 'images': return typeof record.images === 'function' ? record.images(name) : undefined;
        case 'url': return record.url(name);
        case 'users': return record.users(name);
        case 'link': return record.link(name);
        case 'links': return record.links(name);
        case 'formula': return record.formula(name);
        case 'attachments': return typeof record.attachments === 'function' ? record.attachments(name) : undefined;
        case 'text':
        default: return record.text(name);
      }
    } catch (e) {
      return undefined;
    }
  }

  // 把一条 record 读成普通对象（含 id / createdUserId / modifiedUserId 元数据）
  function readRecord(record, fields) {
    var obj = { id: record && record.id, __createdUserId: record && record.createdUserId, __modifiedUserId: record && record.modifiedUserId };
    (fields || []).forEach(function (f) { obj[f.name] = readField(record, f); });
    return obj;
  }

  // ── TableStore：命令式的数据缓存 + CRUD + 订阅 ──────────────────────────────
  function createTableStore(tableId) {
    var _table = null;
    var _records = [];
    var _fieldOptions = {};
    var _loading = true;
    var _listeners = [];
    var _cancelHostChange = null;

      function emit() { _listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }
    // 用动态字段名构造单键对象 { [fieldName]: value }（兼容不支持计算属性名的老环境）
    function _kv(fieldName, value) { var o = {}; o[fieldName] = value; return o; }

    async function reload() {
      if (!_table) return false;
      _loading = true; emit();
      var res = await _table.recordsPaged();
      if (!res || !res.success) { toast.error('数据获取失败'); _loading = false; emit(); return false; }
      _records = res.data.records;
      _loading = false; emit();
      return true;
    }

    async function loadFieldOptions() {
      if (!_table) return;
      var res = await _table.fields();
      if (!res || !res.success) return;
      var opts = {};
      (res.data || []).forEach(function (field) {
        if (field.options) {
          opts[field.name] = field.options.filter(function (o) { return o.text; }).map(function (o) { return o.text; });
        }
      });
      _fieldOptions = opts; emit();
    }

    async function _ensure() {
      if (_table) return _table;
      var rt = await waitRuntime();
      _table = rt.table(tableId);
      if (typeof _table.onChange === 'function') {
        _cancelHostChange = _table.onChange(function () { void reload(); });
      }
      return _table;
    }

    // 初始化：等 Runtime → 建表代理 → 首次拉数据 + 选项
    var _ready = (async function () {
      if (!tableId) { _loading = false; emit(); return; }
      try {
        await _ensure();
        await reload();
        await loadFieldOptions();
      } catch (e) {
        toast.error('数据获取失败'); _loading = false; emit();
      }
    })();

    async function create(values) {
      var t = await _ensure();
      var res = await t.create(values);
      if (!res || !res.success) { toast.error('数据操作失败，请联系管理员查看权限'); return false; }
      toast.success('创建成功'); await reload(); return true;
    }
    async function update(recordId, values) {
      var t = await _ensure();
      var res = await t.update(recordId, values);
      if (!res || !res.success) { toast.error('数据操作失败，请联系管理员查看权限'); return false; }
      toast.success('更新成功'); await reload(); return true;
    }
    async function remove(recordId) {
      var t = await _ensure();
      var res = await t.delete(recordId);
      if (!res || !res.success) { toast.error('数据操作失败，请联系管理员查看权限'); return false; }
      toast.success('删除成功'); await reload(); return true;
    }
    async function getLinkCandidates(fieldName) {
      var t = await _ensure();
      return t.getLinkCandidates(fieldName);
    }

    // ── 读「最新」的某条记录（上传/选人后追加写入前，先拉一遍最新，避免覆盖并发改动）──
    async function _latestRecord(recordId) {
      var t = await _ensure();
      var res = await t.recordsPaged();
      if (!res || !res.success) { toast.error('数据获取失败'); return null; }
      var list = (res.data && res.data.records) || [];
      for (var i = 0; i < list.length; i += 1) if (list[i].id === recordId) return list[i];
      return null;
    }

    // ── 图片：上传 files 并「追加」写入 recordId 的 IMAGE 字段（写入必须含全部 5 字段）──
    async function uploadImageTo(recordId, fieldName, files) {
      if (!global.SmartsheetUploader) { toast.error('上传组件未就绪'); return false; }
      var arr = files && files.length != null ? Array.prototype.slice.call(files) : [files];
      var picked = [];
      for (var i = 0; i < arr.length; i += 1) {
        var r = await global.SmartsheetUploader.uploadImage(arr[i]);
        if (!r || !r.success) { toast.error('图片上传失败'); continue; }
        picked.push({ id: r.data.id, title: r.data.title, imageUrl: r.data.imageUrl, width: r.data.width, height: r.data.height });
      }
      if (!picked.length) return false;
      var rec = await _latestRecord(recordId);
      if (!rec) return false;
      var cur = typeof rec.images === 'function' ? (rec.images(fieldName) || []) : [];
      return update(recordId, _kv(fieldName, cur.concat(picked)));
    }

    // ── 附件：上传 files 并「追加」写入 recordId 的 ATTACHMENT 字段 ──
    async function uploadAttachmentTo(recordId, fieldName, files) {
      if (!global.SmartsheetUploader) { toast.error('上传组件未就绪'); return false; }
      var arr = files && files.length != null ? Array.prototype.slice.call(files) : [files];
      var picked = [];
      for (var i = 0; i < arr.length; i += 1) {
        var r = await global.SmartsheetUploader.uploadAttachment(arr[i]);
        if (!r || !r.success) { toast.error('附件上传失败'); continue; }
        picked.push({ fileId: r.data.fileId, name: r.data.name, size: r.data.size, fileExt: r.data.fileExt, classify: r.data.classify });
      }
      if (!picked.length) return false;
      var rec = await _latestRecord(recordId);
      if (!rec) return false;
      var cur = typeof rec.attachments === 'function' ? (rec.attachments(fieldName) || []) : [];
      return update(recordId, _kv(fieldName, cur.concat(picked)));
    }

    // ── 人员：弹选人面板并「追加」写入 recordId 的 USER 字段（opts.isMultiple 单/多选）──
    async function pickUsersInto(recordId, fieldName, opts) {
      if (!global.SmartsheetUploader) { toast.error('上传组件未就绪'); return false; }
      var r = await global.SmartsheetUploader.pickUser(opts || { isMultiple: false });
      if (!r || !r.success) { if (!r || r.error !== 'CANCELLED') toast.error('人员选择失败'); return false; }
      if (!r.data || !r.data.length) return false;
      var rec = await _latestRecord(recordId);
      if (!rec) return false;
      var cur = typeof rec.users === 'function' ? (rec.users(fieldName) || []) : [];
      return update(recordId, _kv(fieldName, cur.concat(r.data)));
    }

    // ── 覆盖写入型（IMAGE/ATTACHMENT/USER）：直接把整份数组写回（清空传 []，勿用 length 守卫）──
    async function setFieldValue(recordId, fieldName, valueArray) {
      return update(recordId, _kv(fieldName, valueArray || []));
    }

    // ── 关联列：弹面板选择并「整体覆盖」写入 recordId 的 LINK 字段 ──
    async function pickLinksInto(recordId, fieldName, defaultIds) {
      if (!global.SmartsheetUploader) { toast.error('上传组件未就绪'); return false; }
      var cand = await getLinkCandidates(fieldName);
      if (!cand || !cand.success) { toast.error('候选拉取失败'); return false; }
      if (cand.data && cand.data.isAutoLink) return false;
      var pick = await global.SmartsheetUploader.pickLinkRecords({
        candidates: cand.data.candidates,
        isMultiple: cand.data.isMultiple,
        defaultValue: defaultIds || [],
      });
      if (!pick || !pick.success) { if (!pick || pick.error !== 'CANCELLED') toast.error('关联选择失败'); return false; }
      return update(recordId, _kv(fieldName, (pick.data || []).map(function (i) { return i.recordId; })));
    }

    // ── 附件下载（objKey 即 attachment.fileId；宿主触发浏览器下载）──
    async function downloadAttachment(objKey) {
      if (!global.SmartsheetUploader) { toast.error('附件下载失败'); return false; }
      var r = await global.SmartsheetUploader.download(objKey);
      if (!r || !r.success) { toast.error('附件下载失败'); return false; }
      return true;
    }

    return {
      tableId: tableId,
      ready: _ready,
      getRecords: function () { return _records; },
      getFieldOptions: function () { return _fieldOptions; },
      isLoading: function () { return _loading; },
      reload: reload,
      create: create,
      update: update,
      delete: remove,
      getLinkCandidates: getLinkCandidates,
      uploadImageTo: uploadImageTo,
      uploadAttachmentTo: uploadAttachmentTo,
      pickUsersInto: pickUsersInto,
      pickLinksInto: pickLinksInto,
      setFieldValue: setFieldValue,
      downloadAttachment: downloadAttachment,
      onChange: function (cb) {
        _listeners.push(cb);
        return function () {
          var i = _listeners.indexOf(cb);
          if (i >= 0) _listeners.splice(i, 1);
        };
      },
      dispose: function () {
        if (_cancelHostChange) { try { _cancelHostChange(); } catch (e) {} }
        _listeners.length = 0;
      },
    };
  }

  global.SSDataLayer = {
    waitRuntime: waitRuntime,
    createTableStore: createTableStore,
    readField: readField,
    readRecord: readRecord,
    toast: toast,
  };
})(typeof window !== 'undefined' ? window : this);
