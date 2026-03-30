(function () {
  const STORAGE_KEY_V3 = "cute-todo-v3";
  const STORAGE_KEY_V2 = "cute-todo-v2";

  /** 智能安排代理接口（由你在云服务器部署，服务端持有 DeepSeek Key）。可在 index.html 里设置 window.SMART_SCHEDULE_API_URL 覆盖默认路径。 */
  const SMART_SCHEDULE_API_URL =
    typeof window !== "undefined" && window.SMART_SCHEDULE_API_URL
      ? window.SMART_SCHEDULE_API_URL
      : "/api/smart-schedule";

  const DEEPSEEK_MODEL = "deepseek-chat";

  const SMART_SCHEDULE_SYSTEM_PROMPT = `你是一个任务安排助手。请你按照所获知的信息安排今日工作。规则如下：

1. 只能在可工作时段安排任务；
2. 所有任务必须全部进行安排；
3. 紧迫性越高，任务安排越早；
4. 紧迫性高的任务优先按照预计完成时间安排连续时间段；
5. 根据任务表弹性进行安排：
   1) 当弹性为 1 星时，严格按照预计完成时间进行安排，每项任务之间间隔不超过十分钟；
   2) 当弹性为 2 星时，任务安排时间不超过预计完成时间的 1.15 倍，每项任务之间间隔不超过 15 分钟；
   3) 当弹性为 3 星时，任务安排时间不超过预计完成时间的 1.3 倍且高于预计完成时间的 1.1 倍，每项任务之间间隔大于十分钟，小于 20 分钟；
   4) 当弹性为 4 星时，任务安排时间不超过预计完成时间的 1.4 倍且高于预计完成时间的 1.2 倍，每项任务之间间隔大于 15 分钟，小于 25 分钟；
   5) 当弹性为 5 星时，任务安排时间不超过预计完成时间的 1.5 倍且高于预计完成时间的 1.3 倍，每项任务之间间隔大于 20 分钟，小于 30 分钟。
6. 尽量在时间较整时安排任务开始；
7. 最低安排单位为分钟；
8. 对于要求时间连续的任务优先安排连续时间。
9. 所有安排的时刻必须落在可工作时段内：① 不早于「开始工作时间」、不晚于「结束工作时间」；② 若「可工作时段」多行语段中写出了具体时段（如 14:00-15:50、21:00-23:59），则每一段任务时间必须完全落在其中某一语段所描述的时间范围内，不得落在语段之间的空隙中。
10. 若输入中 capacity.shortfallMinutes > 0（即按可工作时段计算出的可用总分钟数小于各任务预计耗时之和），仍须为每条任务都安排时段：优先保证紧迫度 urgency 高的任务尽量接近或达到预计耗时；对紧迫度较低的任务可将安排时长缩短至低于 expectedDurationMinutes，每项至少 1 分钟；不得因此把任何任务排到可工作时段之外。
11. timeMode 为 block 的任务：优先排成一段连续时间；若可工作时段离散或总容量不足，允许拆成多段（见下方 segments）；当多个 block 任务无法都获得长连续时段时，urgency 更高的优先获得更长的连续时段。

你必须只输出一个 JSON 对象，不要使用 markdown 代码块，不要添加任何解释文字。每条已确认任务对应 items 中一条记录（条数须与 tasks 一致）。格式二选一：
单段任务：{"taskId":"与输入任务 id 完全一致","timeStart":"HH:MM","timeEnd":"HH:MM"}
多段任务：{"taskId":"与输入任务 id 完全一致","segments":[{"timeStart":"HH:MM","timeEnd":"HH:MM"},…]}
timeStart/timeEnd 为 24 小时制，且结束晚于开始；segments 内各段均须落在可工作时段内。`;

  let smartAiLoading = false;

  const timeEditSnapshot = new Map();

  const UNCATEGORIZED_ID = "cat-uncategorized";

  const LIST_TITLE = {
    dailyManual: "每日 · 待完成",
    dailySmart: "每日 · 智能安排",
    comprehensive: "综合 · 待完成",
  };

  const CHIP_BG = ["#ffe4ec", "#e8faf3", "#ede7ff", "#fff3e0", "#e3f2fd", "#f3e5f5"];

  const form = document.getElementById("todo-form");
  const input = document.getElementById("todo-input");
  const categorySelect = document.getElementById("category-select");
  const listContainer = document.getElementById("list-container");
  const countBadge = document.getElementById("count-badge");
  const clearDoneBtn = document.getElementById("clear-done");
  const tagForm = document.getElementById("tag-form");
  const tagInput = document.getElementById("tag-input");
  const tagList = document.getElementById("tag-list");
  const sheetDailyBtn = document.getElementById("sheet-daily");
  const sheetCompBtn = document.getElementById("sheet-comprehensive");
  const listTitleEl = document.getElementById("list-title");
  const composeDailyExtra = document.getElementById("compose-daily-extra");
  const composeExtra = document.getElementById("compose-comprehensive-extra");
  const compDeadlineInput = document.getElementById("comp-deadline");
  const compPlanDaysInput = document.getElementById("comp-plan-days");
  const dailyTimeStartInput = document.getElementById("daily-time-start");
  const dailyTimeEndInput = document.getElementById("daily-time-end");
  const composeUrgencyEl = document.getElementById("compose-urgency");
  const composePanel = document.getElementById("compose-panel");
  const composeToolbar = document.getElementById("compose-toolbar");
  const tagsCard = document.getElementById("tags-card");
  const dailyModeCard = document.getElementById("daily-mode-card");
  const dailyArrManualBtn = document.getElementById("daily-arr-manual");
  const dailyArrSmartBtn = document.getElementById("daily-arr-smart");
  const btnToggleCompose = document.getElementById("btn-toggle-compose");
  const btnCancelCompose = document.getElementById("btn-cancel-compose");

  let composeUrgency = 1;
  let composeUrgencyInited = false;
  let editingId = null;

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
  }

  function defaultCategories() {
    return [
      { id: UNCATEGORIZED_ID, name: "未分类", system: true },
      { id: "cat-work", name: "工作" },
      { id: "cat-life", name: "生活" },
      { id: "cat-feel", name: "情感" },
    ];
  }

  function defaultSmartPlan() {
    return {
      step: 1,
      draftTasks: [],
      workStart: null,
      workEnd: null,
      workSlots: "",
      flexibility: 3,
    };
  }

  function defaultSheetState(kind) {
    const base = {
      mode: "manual",
      categories: defaultCategories(),
      items: [],
    };
    if (kind === "comprehensive") {
      base.smartSortBy = "urgency";
    }
    if (kind === "daily") {
      base.dailyArrangement = "manual";
      base.smartPlan = defaultSmartPlan();
    }
    return base;
  }

  function defaultStateV3() {
    return {
      activeSheet: "daily",
      daily: defaultSheetState("daily"),
      comprehensive: defaultSheetState("comprehensive"),
    };
  }

  function parseTimeHHMM(v) {
    if (!v || typeof v !== "string") return null;
    const m = v.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  function normalizeTaskItem(t, i, catIds) {
    const deadline =
      t.deadline && typeof t.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.deadline)
        ? t.deadline
        : null;
    let planDays = null;
    if (typeof t.planDays === "number" && t.planDays >= 1) {
      planDays = Math.min(9999, Math.floor(t.planDays));
    }
    let urgency = parseInt(t.urgency, 10);
    if (Number.isNaN(urgency)) urgency = 1;
    urgency = Math.min(5, Math.max(1, urgency));
    let timeStart =
      t.timeStart != null && String(t.timeStart).trim() !== ""
        ? parseTimeHHMM(String(t.timeStart).trim())
        : null;
    let timeEnd =
      t.timeEnd != null && String(t.timeEnd).trim() !== ""
        ? parseTimeHHMM(String(t.timeEnd).trim())
        : null;
    let timeSegments = null;
    if (Array.isArray(t.timeSegments) && t.timeSegments.length > 0) {
      const segs = [];
      for (let si = 0; si < t.timeSegments.length; si++) {
        const seg = t.timeSegments[si];
        if (!seg || typeof seg !== "object") continue;
        const ts =
          seg.timeStart != null && String(seg.timeStart).trim() !== ""
            ? parseTimeHHMM(String(seg.timeStart).trim())
            : null;
        const te =
          seg.timeEnd != null && String(seg.timeEnd).trim() !== ""
            ? parseTimeHHMM(String(seg.timeEnd).trim())
            : null;
        if (ts && te) segs.push({ timeStart: ts, timeEnd: te });
      }
      if (segs.length > 0) {
        timeSegments = segs;
        const mins = segs.map((s) => ({
          a: timeToMinutes(s.timeStart),
          b: timeToMinutes(s.timeEnd),
        }));
        if (mins.every((x) => x.a != null && x.b != null && x.b > x.a)) {
          const minS = Math.min(...mins.map((x) => x.a));
          const maxE = Math.max(...mins.map((x) => x.b));
          timeStart = formatHM(minS);
          timeEnd = formatHM(maxE);
        }
      }
    }
    const base = {
      id: t.id || uid(),
      text: typeof t.text === "string" ? t.text : "",
      done: !!t.done,
      categoryId: catIds.has(t.categoryId) ? t.categoryId : UNCATEGORIZED_ID,
      order: typeof t.order === "number" ? t.order : i,
      deadline,
      planDays,
      urgency,
      timeStart,
      timeEnd,
    };
    if (timeSegments && timeSegments.length > 1) {
      base.timeSegments = timeSegments;
    }
    return base;
  }

  function normalizeSmartPlan(sp) {
    if (!sp || typeof sp !== "object") return defaultSmartPlan();
    const draftTasks = Array.isArray(sp.draftTasks)
      ? sp.draftTasks.map((t) => {
          let expectedDurationMinutes = null;
          if (typeof t.expectedDurationMinutes === "number" && t.expectedDurationMinutes >= 1) {
            expectedDurationMinutes = Math.min(99999, Math.floor(t.expectedDurationMinutes));
          } else if (t.expectedDurationMinutes != null && String(t.expectedDurationMinutes).trim() !== "") {
            const n = parseInt(String(t.expectedDurationMinutes).trim(), 10);
            if (!Number.isNaN(n) && n >= 1) expectedDurationMinutes = Math.min(99999, n);
          }
          return {
            id: t.id || uid(),
            text: typeof t.text === "string" ? t.text : "",
            urgency: Math.min(5, Math.max(1, parseInt(t.urgency, 10) || 1)),
            expectedDurationMinutes,
            timeMode: t.timeMode === "fragment" ? "fragment" : "block",
            categoryId:
              typeof t.categoryId === "string" && t.categoryId ? t.categoryId : UNCATEGORIZED_ID,
            confirmed: t.confirmed !== undefined ? !!t.confirmed : !!t.locked,
          };
        })
      : [];
    let flex = parseInt(sp.flexibility, 10);
    if (Number.isNaN(flex)) flex = 3;
    flex = Math.min(5, Math.max(1, flex));
    let step = parseInt(sp.step, 10);
    if (Number.isNaN(step)) step = 1;
    step = Math.min(3, Math.max(1, step));
    return {
      step,
      draftTasks,
      workStart:
        sp.workStart != null && String(sp.workStart).trim() !== ""
          ? parseTimeHHMM(String(sp.workStart).trim())
          : null,
      workEnd:
        sp.workEnd != null && String(sp.workEnd).trim() !== ""
          ? parseTimeHHMM(String(sp.workEnd).trim())
          : null,
      workSlots: typeof sp.workSlots === "string" ? sp.workSlots : "",
      flexibility: flex,
    };
  }

  function normalizeDailySheet(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    let categories = Array.isArray(r.categories) ? r.categories.slice() : defaultCategories();
    const hasUnc = categories.some((c) => c.id === UNCATEGORIZED_ID);
    if (!hasUnc) {
      categories.unshift({ id: UNCATEGORIZED_ID, name: "未分类", system: true });
    }
    categories = categories.map((c) => ({
      id: c.id || uid(),
      name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : "标签",
      system: !!c.system && c.id === UNCATEGORIZED_ID,
    }));
    const catIds = new Set(categories.map((c) => c.id));
    const itemsRaw = Array.isArray(r.items) ? r.items : [];
    const items = itemsRaw.map((t, i) => normalizeTaskItem(t, i, catIds));
    const smartPlan = normalizeSmartPlan(r.smartPlan);
    smartPlan.draftTasks = smartPlan.draftTasks.map((dt) => ({
      ...dt,
      categoryId: catIds.has(dt.categoryId) ? dt.categoryId : UNCATEGORIZED_ID,
    }));
    return {
      mode: "manual",
      categories,
      items,
      dailyArrangement: r.dailyArrangement === "smart" ? "smart" : "manual",
      smartPlan,
    };
  }

  function normalizeSheet(raw, kind) {
    if (kind === "daily") {
      return normalizeDailySheet(raw);
    }
    let categories = Array.isArray(raw.categories) ? raw.categories.slice() : defaultCategories();
    const hasUnc = categories.some((c) => c.id === UNCATEGORIZED_ID);
    if (!hasUnc) {
      categories.unshift({ id: UNCATEGORIZED_ID, name: "未分类", system: true });
    }
    categories = categories.map((c) => ({
      id: c.id || uid(),
      name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : "标签",
      system: !!c.system && c.id === UNCATEGORIZED_ID,
    }));
    const catIds = new Set(categories.map((c) => c.id));
    const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
    const items = itemsRaw.map((t, i) => normalizeTaskItem(t, i, catIds));
    const out = {
      mode: "manual",
      categories,
      items,
    };
    out.smartSortBy = raw.smartSortBy === "deadline" ? "deadline" : "urgency";
    return out;
  }

  function normalizeV3(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return defaultStateV3();
    }
    if (data.daily && data.comprehensive) {
      return {
        activeSheet: data.activeSheet === "comprehensive" ? "comprehensive" : "daily",
        daily: normalizeDailySheet(data.daily),
        comprehensive: normalizeSheet(data.comprehensive, "comprehensive"),
      };
    }
    return migrateFlatV2ToV3(data);
  }

  function migrateFlatV2ToV3(data) {
    if (!data || typeof data !== "object") {
      return defaultStateV3();
    }
    const comprehensive = normalizeSheet(data, "comprehensive");
    return {
      activeSheet: "comprehensive",
      daily: defaultSheetState("daily"),
      comprehensive,
    };
  }

  function load() {
    try {
      const r3 = localStorage.getItem(STORAGE_KEY_V3);
      if (r3) {
        return normalizeV3(JSON.parse(r3));
      }
      const r2 = localStorage.getItem(STORAGE_KEY_V2);
      if (r2) {
        const st = normalizeV3(JSON.parse(r2));
        localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(st));
        return st;
      }
    } catch {
      /* fallthrough */
    }
    return defaultStateV3();
  }

  let state = load();

  function migrateFromV1(raw) {
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return null;
      return normalizeSheet(
        {
          mode: "manual",
          categories: defaultCategories(),
          items: data.map((t, i) => ({
            id: t.id,
            text: t.text,
            done: t.done,
            categoryId: UNCATEGORIZED_ID,
            order: i,
          })),
        },
        "comprehensive"
      );
    } catch {
      return null;
    }
  }

  (function tryMigrateV1() {
    const v1 = localStorage.getItem("cute-todo-v1");
    if (!v1) return;
    const empty = state.daily.items.length === 0 && state.comprehensive.items.length === 0;
    if (!empty) return;
    const migrated = migrateFromV1(v1);
    if (migrated) {
      state.comprehensive = migrated;
      state.activeSheet = "comprehensive";
      localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(state));
    }
  })();

  function save() {
    localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(state));
  }

  function getSheetKey() {
    return state.activeSheet === "comprehensive" ? "comprehensive" : "daily";
  }

  function getSheet() {
    return state.activeSheet === "comprehensive" ? state.comprehensive : state.daily;
  }

  function categoryIndex(catId) {
    const categories = getSheet().categories;
    const i = categories.findIndex((c) => c.id === catId);
    return i === -1 ? categories.length : i;
  }

  function chipStyle(catId) {
    const idx = categoryIndex(catId);
    const bg = CHIP_BG[idx % CHIP_BG.length];
    return `background:${bg};`;
  }

  function nextOrder() {
    const items = getSheet().items;
    if (items.length === 0) return 0;
    return Math.max(...items.map((t) => t.order)) + 1;
  }

  function timeToMinutes(hhmm) {
    if (!hhmm || typeof hhmm !== "string") return null;
    const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  /** 解析中文数字（0–99 常见写法），用于时点与分。 */
  function parseCnIntGeneral(s) {
    s = String(s || "")
      .trim()
      .replace(/\s+/g, "");
    if (!s) return NaN;
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      return n;
    }
    if (s === "半") return 30;
    const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (s.length === 1 && map[s] !== undefined) return map[s];
    if (s.includes("十")) {
      const parts = s.split("十");
      let tens;
      if (parts[0] === "") tens = 1;
      else if (map[parts[0]] !== undefined) tens = map[parts[0]];
      else return NaN;
      const rest = parts[1] || "";
      if (rest === "") return tens * 10;
      const ones = parseCnIntGeneral(rest);
      if (Number.isNaN(ones)) return NaN;
      return tens * 10 + ones;
    }
    return NaN;
  }

  function applyChinesePeriod(period, hour, minute) {
    const p = period || "";
    if (!p) return { H: hour, min: minute };
    if (p === "凌晨" || p === "早上" || p === "上午") return { H: hour, min: minute };
    if (p === "中午") {
      if (hour === 12) return { H: 12, min: minute };
      if (hour >= 1 && hour <= 4) return { H: 12 + hour, min: minute };
      return { H: hour, min: minute };
    }
    if (p === "下午") {
      if (hour === 12) return { H: 12, min: minute };
      if (hour >= 1 && hour <= 11) return { H: 12 + hour, min: minute };
      return { H: hour, min: minute };
    }
    if (p === "晚上" || p === "夜里" || p === "晚间" || p === "深夜") {
      if (hour === 12) return { H: 23, min: 59 };
      if (hour >= 1 && hour <= 11) return { H: 12 + hour, min: minute };
      return { H: hour, min: minute };
    }
    return { H: hour, min: minute };
  }

  /** 将自然语言或数字时钟片段解析为从 0:00 起的分钟数。 */
  function parseChineseTimePhrase(raw) {
    const s0 = String(raw || "").trim().replace(/\s+/g, "");
    if (!s0) return null;
    const dig = s0.match(/^(\d{1,2})[:：](\d{2})$/);
    if (dig) {
      const h = parseInt(dig[1], 10);
      const min = parseInt(dig[2], 10);
      if (h > 23 || min > 59) return null;
      return h * 60 + min;
    }
    const periods = ["凌晨", "早上", "上午", "中午", "下午", "晚上", "夜里", "晚间", "深夜"];
    let period = "";
    let rest = s0;
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      if (rest.startsWith(p)) {
        period = p;
        rest = rest.slice(p.length);
        break;
      }
    }
    const m = rest.match(/^([〇零一二三四五六七八九十两]+|\d{1,2})点(.*)$/);
    if (!m) return null;
    const hourRaw = parseCnIntGeneral(m[1]);
    if (Number.isNaN(hourRaw) || hourRaw > 23) return null;
    let tail = (m[2] || "").replace(/分$/g, "").trim();
    let minute = 0;
    if (tail === "" || tail === undefined) minute = 0;
    else if (tail === "半") minute = 30;
    else {
      minute = parseCnIntGeneral(tail);
      if (Number.isNaN(minute) || minute > 59) return null;
    }
    const { H, min: mm } = applyChinesePeriod(period, hourRaw, minute);
    if (H < 0 || H > 23 || mm > 59) return null;
    return H * 60 + mm;
  }

  function parseTimeFlexible(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    return parseChineseTimePhrase(s);
  }

  function formatHM(totalMin) {
    const h = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${h}:${String(mm).padStart(2, "0")}`;
  }

  /** 从一行可工作时段解析出与全局 [ws,we] 求交后的区间；失败返回 null。 */
  function parseWorkSlotLine(trimmed, ws, we) {
    const openM = trimmed.match(/^(.+?)\s*(以后|之后|以後)\s*$/);
    if (openM) {
      const startMin = parseTimeFlexible(openM[1].trim());
      if (startMin == null) return null;
      const s = Math.max(startMin, ws);
      const e = we;
      if (e <= s) return null;
      return {
        start: s,
        end: e,
        normalizedLine: `${formatHM(s)}–${formatHM(e)}`,
      };
    }
    const rangeM = trimmed.match(/^(.+?)\s*[-–—至到]\s*(.+)$/);
    if (rangeM) {
      const a = parseTimeFlexible(rangeM[1].trim());
      const b = parseTimeFlexible(rangeM[2].trim());
      if (a == null || b == null) return null;
      let s = Math.min(a, b);
      let e = Math.max(a, b);
      s = Math.max(s, ws);
      e = Math.min(e, we);
      if (e <= s) return null;
      return {
        start: s,
        end: e,
        normalizedLine: `${formatHM(s)}–${formatHM(e)}`,
      };
    }
    return null;
  }

  function tryParseDigitalRangeLine(trimmed, ws, we) {
    const re = /(\d{1,2})[:：](\d{2})\s*[-–—至到]\s*(\d{1,2})[:：](\d{2})/;
    const m = trimmed.match(re);
    if (!m) return null;
    const sh = parseInt(m[1], 10);
    const sm = parseInt(m[2], 10);
    const eh = parseInt(m[3], 10);
    const em = parseInt(m[4], 10);
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
    let s = sh * 60 + sm;
    let e = eh * 60 + em;
    if (e <= s) return null;
    s = Math.max(s, ws);
    e = Math.min(e, we);
    if (e <= s) return null;
    return { start: s, end: e };
  }

  /** 一行内可能出现的多个 H:MM–H:MM 片段（与全局起止时间求交）。 */
  function collectDigitalRangesInString(str, ws, we) {
    const re = /(\d{1,2})[:：](\d{2})\s*[-–—至到]\s*(\d{1,2})[:：](\d{2})/g;
    const out = [];
    let m;
    while ((m = re.exec(str)) !== null) {
      const sh = parseInt(m[1], 10);
      const sm = parseInt(m[2], 10);
      const eh = parseInt(m[3], 10);
      const em = parseInt(m[4], 10);
      if (sh > 23 || eh > 23 || sm > 59 || em > 59) continue;
      let s = sh * 60 + sm;
      let e = eh * 60 + em;
      if (e <= s) continue;
      s = Math.max(s, ws);
      e = Math.min(e, we);
      if (e > s) out.push({ start: s, end: e });
    }
    return out;
  }

  /** 将可工作时段多行文本转为数字时钟区间展示（供校验与 API）。 */
  function getNormalizedWorkSlotsDescription(sp) {
    const ws = sp.workStart ? timeToMinutes(sp.workStart) : null;
    const we = sp.workEnd ? timeToMinutes(sp.workEnd) : null;
    const text = sp.workSlots || "";
    if (ws == null || we == null || we <= ws) return text;
    return String(text)
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        const parsed = parseWorkSlotLine(trimmed, ws, we);
        if (parsed) return parsed.normalizedLine;
        const dig = tryParseDigitalRangeLine(trimmed, ws, we);
        if (dig) return `${formatHM(dig.start)}–${formatHM(dig.end)}`;
        const multi = collectDigitalRangesInString(trimmed, ws, we);
        if (multi.length) {
          return multi.map((seg) => `${formatHM(seg.start)}–${formatHM(seg.end)}`).join("；");
        }
        return trimmed;
      })
      .join("\n");
  }

  function itemTimeInterval(item) {
    if (!item.timeStart || !item.timeEnd) return null;
    const s = timeToMinutes(item.timeStart);
    const e = timeToMinutes(item.timeEnd);
    if (s == null || e == null || e <= s) return null;
    return { start: s, end: e, id: item.id };
  }

  /** 任务在分钟轴上的区间（含多段拆分）。 */
  function itemScheduleIntervalsMinutes(item) {
    if (item.timeSegments && Array.isArray(item.timeSegments) && item.timeSegments.length > 0) {
      const out = [];
      for (let i = 0; i < item.timeSegments.length; i++) {
        const seg = item.timeSegments[i];
        if (!seg || !seg.timeStart || !seg.timeEnd) continue;
        const s = timeToMinutes(seg.timeStart);
        const e = timeToMinutes(seg.timeEnd);
        if (s == null || e == null || e <= s) continue;
        out.push({ start: s, end: e });
      }
      return out;
    }
    const iv = itemTimeInterval(item);
    return iv ? [{ start: iv.start, end: iv.end }] : [];
  }

  function dailyTimeSortKey(item) {
    const ivs = itemScheduleIntervalsMinutes(item);
    if (ivs.length) return Math.min(...ivs.map((x) => x.start));
    return Infinity;
  }

  function dailyTimeEndTiebreak(item) {
    const ivs = itemScheduleIntervalsMinutes(item);
    if (ivs.length) return Math.max(...ivs.map((x) => x.end));
    return timeToMinutes(item.timeEnd) ?? Infinity;
  }

  function getSortedListItems() {
    const sheet = getSheet();
    if (getSheetKey() === "daily") {
      return sheet.items.slice().sort((a, b) => {
        const ka = dailyTimeSortKey(a);
        const kb = dailyTimeSortKey(b);
        if (ka !== kb) return ka - kb;
        const ea = dailyTimeEndTiebreak(a);
        const eb = dailyTimeEndTiebreak(b);
        if (ea !== eb) return ea - eb;
        return a.order - b.order;
      });
    }
    return sheet.items.slice().sort((a, b) => a.order - b.order);
  }

  function findConflictsInItems(items) {
    const pairs = [];
    const list = [];
    items.forEach((it) => {
      itemScheduleIntervalsMinutes(it).forEach((iv) => {
        list.push({ start: iv.start, end: iv.end, item: it });
      });
    });
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i];
        const B = list[j];
        if (A.item.id === B.item.id) continue;
        if (Math.max(A.start, B.start) < Math.min(A.end, B.end)) {
          pairs.push({ a: A.item, b: B.item });
        }
      }
    }
    return pairs;
  }

  function findConflictWithId(items, id) {
    const self = items.find((x) => x.id === id);
    if (!self) return null;
    const selfIvs = itemScheduleIntervalsMinutes(self);
    if (!selfIvs.length) return null;
    for (const other of items) {
      if (other.id === id) continue;
      const otherIvs = itemScheduleIntervalsMinutes(other);
      for (let a = 0; a < selfIvs.length; a++) {
        for (let b = 0; b < otherIvs.length; b++) {
          if (
            Math.max(selfIvs[a].start, otherIvs[b].start) <
            Math.min(selfIvs[a].end, otherIvs[b].end)
          ) {
            return { other, self };
          }
        }
      }
    }
    return null;
  }

  function resolveOverlapsByClearingLater(items) {
    const result = items.map((t) => ({ ...t }));
    const byId = new Map(result.map((t) => [t.id, t]));
    const withIntervals = [];
    result.forEach((it) => {
      itemScheduleIntervalsMinutes(it).forEach((iv) => {
        withIntervals.push({ start: iv.start, end: iv.end, id: it.id });
      });
    });
    withIntervals.sort((a, b) => a.start - b.start || a.end - b.end);
    const kept = [];
    for (let s = 0; s < withIntervals.length; s++) {
      const seg = withIntervals[s];
      let bad = false;
      for (let k = 0; k < kept.length; k++) {
        if (Math.max(seg.start, kept[k].start) < Math.min(seg.end, kept[k].end)) {
          bad = true;
          break;
        }
      }
      if (bad) {
        const node = byId.get(seg.id);
        if (node) {
          node.timeStart = null;
          node.timeEnd = null;
          delete node.timeSegments;
        }
      } else {
        kept.push({ start: seg.start, end: seg.end });
      }
    }
    return result;
  }

  function showTimeConflictDialog(message, onOverwrite, onRetry) {
    const modal = document.getElementById("time-conflict-modal");
    const msgEl = document.getElementById("time-conflict-msg");
    const btnO = document.getElementById("time-conflict-overwrite");
    const btnR = document.getElementById("time-conflict-retry");
    if (!modal || !msgEl || !btnO || !btnR) {
      window.alert(message);
      onRetry();
      return;
    }
    msgEl.textContent = message;
    modal.hidden = false;
    function onO() {
      modal.hidden = true;
      btnO.removeEventListener("click", onO);
      btnR.removeEventListener("click", onR);
      onOverwrite();
    }
    function onR() {
      modal.hidden = true;
      btnO.removeEventListener("click", onO);
      btnR.removeEventListener("click", onR);
      onRetry();
    }
    btnO.addEventListener("click", onO);
    btnR.addEventListener("click", onR);
  }

  function syncDailyItemsToDraft() {
    const items = state.daily.items.slice().sort((a, b) => a.order - b.order);
    const prevDraftById = new Map(state.daily.smartPlan.draftTasks.map((d) => [d.id, d]));
    state.daily.smartPlan.draftTasks = items.map((it) => {
      let expectedDurationMinutes = null;
      const ivs = itemScheduleIntervalsMinutes(it);
      if (ivs.length) {
        expectedDurationMinutes = ivs.reduce((acc, x) => acc + (x.end - x.start), 0);
      } else if (it.timeStart && it.timeEnd) {
        const ts = timeToMinutes(it.timeStart);
        const te = timeToMinutes(it.timeEnd);
        if (ts != null && te != null && te > ts) expectedDurationMinutes = te - ts;
      }
      const titleOk = !!(it.text && String(it.text).trim());
      const durationOk = expectedDurationMinutes != null && expectedDurationMinutes >= 1;
      const prev = prevDraftById.get(it.id);
      const tm = prev && prev.timeMode === "fragment" ? "fragment" : "block";
      return {
        id: it.id,
        text: it.text,
        urgency: it.urgency,
        categoryId: it.categoryId || UNCATEGORIZED_ID,
        expectedDurationMinutes,
        timeMode: tm,
        confirmed: titleOk && durationOk,
      };
    });
  }

  /** 从「可工作时段」文本中解析时段（含中文自然语言，先归一为数字时钟再求交），并与全局起止时间求交后得到若干合法区间（分钟）。 */
  function buildAllowedIntervalsFromWorkPlan(sp) {
    const ws = sp.workStart ? timeToMinutes(sp.workStart) : null;
    const we = sp.workEnd ? timeToMinutes(sp.workEnd) : null;
    if (ws == null || we == null || we <= ws) {
      return [];
    }
    const globalSeg = { start: ws, end: we };
    const text = sp.workSlots || "";
    const segments = [];
    let anyUnparsedNonEmptyLine = false;
    const lines = text.split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      const trimmed = lines[li].trim();
      if (!trimmed) continue;
      const before = segments.length;
      const parsed = parseWorkSlotLine(trimmed, ws, we);
      if (parsed) {
        segments.push({ start: parsed.start, end: parsed.end });
        continue;
      }
      const dig = tryParseDigitalRangeLine(trimmed, ws, we);
      if (dig) {
        segments.push({ start: dig.start, end: dig.end });
        continue;
      }
      collectDigitalRangesInString(trimmed, ws, we).forEach((seg) => segments.push(seg));
      if (segments.length === before) {
        anyUnparsedNonEmptyLine = true;
      }
    }
    if (segments.length === 0) {
      return [globalSeg];
    }
    // 若存在非空行但本端未能解析为时段，模型仍可能按「整段工作时间」理解；校验时并入全局框，避免与 AI 结果系统性不一致。
    if (anyUnparsedNonEmptyLine) {
      segments.push({ start: globalSeg.start, end: globalSeg.end });
    }
    return segments;
  }

  function taskIntervalInsideAllowedSegments(ts, te, segments) {
    if (ts == null || te == null || te <= ts) return false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (ts >= seg.start && te <= seg.end) return true;
    }
    return false;
  }

  function assertScheduleWithinWorkPlan(sp, builtItems) {
    const intervals = buildAllowedIntervalsFromWorkPlan(sp);
    if (intervals.length === 0) {
      throw new Error("请先在第二步填写有效的开始、结束工作时间。");
    }
    for (let i = 0; i < builtItems.length; i++) {
      const it = builtItems[i];
      const ivs = itemScheduleIntervalsMinutes(it);
      if (!ivs.length) continue;
      for (let j = 0; j < ivs.length; j++) {
        const iv = ivs[j];
        if (!taskIntervalInsideAllowedSegments(iv.start, iv.end, intervals)) {
          const title = (it.text && String(it.text).trim()) || "任务";
          throw new Error(
            `「${title}」的时段不在可工作时段内（须落在已填写的某一段可工作时间内）。请重新生成或回到第二步调整。`
          );
        }
      }
    }
  }

  /** 是否已点「添加」变为只读摘要（兼容旧字段 locked）。 */
  function isDraftConfirmed(t) {
    return !!(t && (t.confirmed === true || t.locked === true));
  }

  function mergeDraftIntoDailyItems() {
    const draft = state.daily.smartPlan.draftTasks;
    const existingById = new Map(state.daily.items.map((t) => [t.id, t]));
    state.daily.items = draft.map((d, order) => {
      const prev = existingById.get(d.id);
      return {
        id: d.id,
        text: d.text,
        urgency: d.urgency,
        categoryId: d.categoryId || UNCATEGORIZED_ID,
        done: prev ? prev.done : false,
        order,
        deadline: null,
        planDays: null,
        timeStart: prev && prev.timeStart != null ? prev.timeStart : null,
        timeEnd: prev && prev.timeEnd != null ? prev.timeEnd : null,
      };
    });
  }

  function urgencyStarsText(u) {
    const n = Math.min(5, Math.max(1, u || 1));
    return "★".repeat(n) + "☆".repeat(5 - n);
  }

  function draftTimeModeLabel(mode) {
    return mode === "fragment" ? "可碎片化完成" : "优先整块（可拆多段）";
  }

  function splitMinutesToHourMinuteDisplay(totalMinutes) {
    if (totalMinutes == null || totalMinutes < 1 || Number.isNaN(totalMinutes)) {
      return { h: "", m: "" };
    }
    const n = Math.min(99999, Math.floor(totalMinutes));
    return { h: String(Math.floor(n / 60)), m: String(n % 60) };
  }

  function formatDurationMinutesCell(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const total = Math.floor(n);
    if (total < 1) return "—";
    const h = Math.floor(total / 60);
    const m = total % 60;
    const parts = [];
    if (h > 0) parts.push(`${h} 小时`);
    if (m > 0) parts.push(`${m} 分钟`);
    return parts.length ? parts.join(" ") : "—";
  }

  function renderSmartDraftCategorySelectHtml(selectedId) {
    const cats = state.daily.categories;
    const sel = cats.some((c) => c.id === selectedId) ? selectedId : UNCATEGORIZED_ID;
    let h = "";
    cats.forEach((c) => {
      h += `<option value="${escapeAttr(c.id)}"${c.id === sel ? " selected" : ""}>${escapeHtml(
        c.name
      )}</option>`;
    });
    return h;
  }

  function draftCategoryLabel(categoryId) {
    const c = state.daily.categories.find((x) => x.id === categoryId);
    return c ? c.name : "—";
  }

  function setActiveSheet(sheet) {
    if (sheet !== "daily" && sheet !== "comprehensive") return;
    if (state.activeSheet === sheet) return;
    state.activeSheet = sheet;
    save();
    editingId = null;
    setComposeOpen(false);
    updateSheetUi();
    updateChromeVisibility();
    render();
  }

  function setDailyArrangement(arr) {
    if (arr !== "manual" && arr !== "smart") return;
    if (arr === "manual" && state.daily.dailyArrangement === "smart") {
      if (state.daily.smartPlan.step === 1) {
        collectSmartDraftFromDom();
      }
      mergeDraftIntoDailyItems();
    }
    if (arr === "smart") {
      syncDailyItemsToDraft();
    }
    state.daily.dailyArrangement = arr;
    editingId = null;
    save();
    updateChromeVisibility();
    render();
  }

  function setComposeOpen(open) {
    composePanel.hidden = !open;
    btnToggleCompose.setAttribute("aria-expanded", open ? "true" : "false");
    btnToggleCompose.textContent = open ? "收起添加" : "添加任务";
    if (open) {
      initComposeUrgencyPicker();
      renderCategorySelect();
      updateComposeUrgencyDisplay();
      input.focus();
    }
  }

  function updateSheetUi() {
    const isDaily = state.activeSheet === "daily";
    sheetDailyBtn.classList.toggle("is-active", isDaily);
    sheetCompBtn.classList.toggle("is-active", !isDaily);
    composeDailyExtra.hidden = !isDaily;
    composeExtra.hidden = isDaily;
    if (isDaily) {
      listTitleEl.textContent =
        state.daily.dailyArrangement === "smart" ? LIST_TITLE.dailySmart : LIST_TITLE.dailyManual;
    } else {
      listTitleEl.textContent = LIST_TITLE.comprehensive;
    }
  }

  function updateChromeVisibility() {
    const isDaily = state.activeSheet === "daily";
    const smart = isDaily && state.daily.dailyArrangement === "smart";
    dailyModeCard.hidden = !isDaily;
    composeToolbar.hidden = smart;
    tagsCard.hidden = !isDaily;
    dailyArrManualBtn.classList.toggle("is-active", isDaily && !smart);
    dailyArrSmartBtn.classList.toggle("is-active", isDaily && smart);
  }

  function initComposeUrgencyPicker() {
    if (composeUrgencyInited) return;
    composeUrgencyEl.innerHTML = [1, 2, 3, 4, 5]
      .map((i) => `<button type="button" class="star-btn" data-value="${i}">★</button>`)
      .join("");
    composeUrgencyEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".star-btn");
      if (!btn) return;
      composeUrgency = +btn.dataset.value;
      updateComposeUrgencyDisplay();
    });
    composeUrgencyInited = true;
  }

  function updateComposeUrgencyDisplay() {
    composeUrgencyEl.querySelectorAll(".star-btn").forEach((btn, i) => {
      btn.classList.toggle("is-on", i + 1 <= composeUrgency);
    });
  }

  function renderCategorySelect() {
    const prev = categorySelect.value;
    const sheet = getSheet();
    categorySelect.innerHTML = "";
    sheet.categories.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      categorySelect.appendChild(opt);
    });
    if (prev && sheet.categories.some((c) => c.id === prev)) {
      categorySelect.value = prev;
    } else {
      const preferred = sheet.categories.find((c) => c.id !== UNCATEGORIZED_ID);
      categorySelect.value = preferred ? preferred.id : sheet.categories[0].id;
    }
  }

  function renderTagList() {
    const sheet = getSheet();
    tagList.innerHTML = "";
    sheet.categories.forEach((c) => {
      const li = document.createElement("li");
      const chip = document.createElement("span");
      chip.className = "tag-chip" + (c.system ? " is-system" : "");
      chip.style.cssText = chipStyle(c.id);
      chip.appendChild(document.createTextNode(c.name));
      if (!c.system) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "tag-chip-remove";
        rm.textContent = "×";
        rm.dataset.catId = c.id;
        chip.appendChild(rm);
      }
      li.appendChild(chip);
      tagList.appendChild(li);
    });
  }

  function buildTodoRowView(item) {
    const draggable = getSheetKey() === "comprehensive";
    const li = document.createElement("li");
    li.className = "todo-item" + (item.done ? " done" : "") + (draggable ? " todo-item--manual" : "");
    li.dataset.id = item.id;

    const drag = document.createElement("span");
    drag.className = "todo-drag";
    drag.draggable = draggable;
    drag.textContent = "⋮⋮";

    const check = document.createElement("button");
    check.type = "button";
    check.className = "todo-check";
    check.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

    const body = document.createElement("div");
    body.className = "todo-body";

    const cat = getSheet().categories.find((c) => c.id === item.categoryId);
    const catSpan = document.createElement("span");
    catSpan.className = "todo-cat";
    catSpan.style.cssText = chipStyle(item.categoryId);
    catSpan.textContent = cat ? cat.name : "—";

    const titleSpan = document.createElement("div");
    titleSpan.className = "todo-title-readonly";
    titleSpan.textContent = item.text || "—";

    const meta = document.createElement("div");
    meta.className = "todo-meta todo-meta--readonly";

    if (getSheetKey() === "daily") {
      const parts = [];
      if (item.timeSegments && item.timeSegments.length > 1) {
        parts.push(
          item.timeSegments
            .map((s) => (s.timeStart || "—") + "–" + (s.timeEnd || "—"))
            .join("、")
        );
      } else if (item.timeStart || item.timeEnd) {
        parts.push((item.timeStart || "—") + " – " + (item.timeEnd || "—"));
      }
      parts.push(urgencyStarsText(item.urgency));
      meta.textContent = parts.join(" · ");
    } else {
      const bits = [];
      if (item.deadline) bits.push(item.deadline);
      if (item.planDays != null) bits.push(item.planDays + "天");
      bits.push(urgencyStarsText(item.urgency));
      meta.textContent = bits.join(" · ");
    }

    const actions = document.createElement("div");
    actions.className = "todo-row-actions";
    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.className = "btn-text btn-edit";
    btnEdit.textContent = "编辑";
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-text btn-del-text";
    btnDel.textContent = "删除";
    actions.append(btnEdit, btnDel);

    body.append(catSpan, titleSpan, meta, actions);
    li.append(drag, check, body);
    return li;
  }

  function buildTodoRowEdit(item) {
    const draggable = getSheetKey() === "comprehensive";
    const li = document.createElement("li");
    li.className =
      "todo-item todo-item--editing" +
      (item.done ? " done" : "") +
      (draggable ? " todo-item--manual" : "");
    li.dataset.id = item.id;

    const drag = document.createElement("span");
    drag.className = "todo-drag";
    drag.draggable = draggable;
    drag.textContent = "⋮⋮";

    const check = document.createElement("button");
    check.type = "button";
    check.className = "todo-check";
    check.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

    const body = document.createElement("div");
    body.className = "todo-body";

    const catRow = document.createElement("div");
    catRow.className = "todo-row-line";
    const catLabel = document.createElement("span");
    catLabel.className = "todo-field-label";
    catLabel.textContent = "类别";
    const catSel = document.createElement("select");
    catSel.className = "todo-meta-cat compose-select";
    getSheet().categories.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      catSel.appendChild(opt);
    });
    catSel.value = item.categoryId;
    catRow.append(catLabel, catSel);

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "todo-title-input compose-input";
    titleInput.maxLength = 200;
    titleInput.value = item.text;

    const wrap = document.createElement("div");
    wrap.className = "todo-meta";

    if (getSheetKey() === "daily") {
      const t1 = document.createElement("div");
      t1.className = "todo-meta-field";
      const l1 = document.createElement("label");
      l1.textContent = "从";
      const in1 = document.createElement("input");
      in1.type = "time";
      in1.step = "60";
      in1.className = "todo-meta-time-start";
      in1.value = item.timeStart || "";
      t1.append(l1, in1);
      const t2 = document.createElement("div");
      t2.className = "todo-meta-field";
      const l2 = document.createElement("label");
      l2.textContent = "到";
      const in2 = document.createElement("input");
      in2.type = "time";
      in2.step = "60";
      in2.className = "todo-meta-time-end";
      in2.value = item.timeEnd || "";
      t2.append(l2, in2);
      const d3 = document.createElement("div");
      d3.className = "todo-meta-field";
      d3.appendChild(document.createTextNode("紧迫 "));
      const stars = document.createElement("div");
      stars.className = "todo-stars";
      for (let i = 1; i <= 5; i++) {
        const sb = document.createElement("button");
        sb.type = "button";
        sb.className = "star-btn" + (i <= (item.urgency || 1) ? " is-on" : "");
        sb.dataset.value = String(i);
        sb.textContent = "★";
        stars.appendChild(sb);
      }
      d3.appendChild(stars);
      wrap.append(t1, t2, d3);
    } else {
      const d1 = document.createElement("div");
      d1.className = "todo-meta-field";
      const l1 = document.createElement("label");
      l1.textContent = "截止";
      const in1 = document.createElement("input");
      in1.type = "date";
      in1.className = "todo-meta-deadline";
      in1.value = item.deadline || "";
      d1.append(l1, in1);
      const d2 = document.createElement("div");
      d2.className = "todo-meta-field";
      const l2 = document.createElement("label");
      l2.textContent = "计划天";
      const in2 = document.createElement("input");
      in2.type = "number";
      in2.min = "1";
      in2.max = "9999";
      in2.className = "todo-meta-plan";
      in2.value = item.planDays != null ? String(item.planDays) : "";
      d2.append(l2, in2);
      const d3 = document.createElement("div");
      d3.className = "todo-meta-field";
      d3.appendChild(document.createTextNode("紧迫 "));
      const stars = document.createElement("div");
      stars.className = "todo-stars";
      for (let i = 1; i <= 5; i++) {
        const sb = document.createElement("button");
        sb.type = "button";
        sb.className = "star-btn" + (i <= (item.urgency || 1) ? " is-on" : "");
        sb.dataset.value = String(i);
        sb.textContent = "★";
        stars.appendChild(sb);
      }
      d3.appendChild(stars);
      wrap.append(d1, d2, d3);
    }

    const actions = document.createElement("div");
    actions.className = "todo-row-actions";
    const btnDone = document.createElement("button");
    btnDone.type = "button";
    btnDone.className = "btn-text btn-finish-edit";
    btnDone.textContent = "完成";
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-text btn-del-text";
    btnDel.textContent = "删除";
    actions.append(btnDone, btnDel);

    body.append(catRow, titleInput, wrap, actions);
    li.append(drag, check, body);
    return li;
  }

  function buildTodoRow(item) {
    if (editingId === item.id) {
      return buildTodoRowEdit(item);
    }
    return buildTodoRowView(item);
  }

  function renderList() {
    listContainer.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "todo-list";
    ul.id = "todo-list-manual";
    getSortedListItems().forEach((item) => {
      ul.appendChild(buildTodoRow(item));
    });
    listContainer.appendChild(ul);
  }

  function renderStarsHtml(urgency) {
    const u = Math.min(5, Math.max(1, urgency || 1));
    let h = "";
    for (let i = 1; i <= 5; i++) {
      h += `<button type="button" class="star-btn${i <= u ? " is-on" : ""}" data-si="${i}">★</button>`;
    }
    return h;
  }

  function renderDailySmartWizard() {
    const sp = state.daily.smartPlan;
    const root = document.createElement("div");
    root.id = "smart-wizard";
    root.className = "smart-wizard";

    if (sp.step === 1) {
      const table = document.createElement("div");
      table.className = "smart-draft-table";
      sp.draftTasks.forEach((t, idx) => {
        const row = document.createElement("div");
        row.dataset.index = String(idx);
        const tm = t.timeMode === "fragment" ? "fragment" : "block";
        if (isDraftConfirmed(t)) {
          row.className = "smart-draft-row smart-draft-row--locked";
          row.innerHTML = `
            <div class="smart-draft-locked-main">
              <div class="smart-draft-locked-title">${escapeHtml(t.text || "（无标题）")}</div>
              <div class="smart-draft-locked-meta">${urgencyStarsText(t.urgency)} · ${escapeHtml(
            draftCategoryLabel(t.categoryId || UNCATEGORIZED_ID)
          )} · ${escapeHtml(formatDurationMinutesCell(t.expectedDurationMinutes))} · ${escapeHtml(
            draftTimeModeLabel(tm)
          )}</div>
            </div>
            <button type="button" class="btn-text smart-draft-edit" data-index="${idx}">编辑</button>
            <button type="button" class="btn-text smart-remove-row" data-index="${idx}">移除</button>`;
          table.appendChild(row);
          return;
        }
        row.className = "smart-draft-row";
        const hm = splitMinutesToHourMinuteDisplay(t.expectedDurationMinutes);
        row.innerHTML = `
          <input type="text" class="compose-input smart-draft-title" value="${escapeAttr(t.text)}" maxlength="200" />
          <div class="smart-draft-stars" data-index="${idx}">${renderStarsHtml(t.urgency)}</div>
          <label class="smart-draft-cat-wrap">
            <span class="compose-field-label">标签</span>
            <select class="compose-input compose-input--sm smart-draft-cat" data-index="${idx}" aria-label="标签">${renderSmartDraftCategorySelectHtml(
          t.categoryId || UNCATEGORIZED_ID
        )}</select>
          </label>
          <label class="smart-duration-field" title="填写预计耗时：小时与分钟，合计至少 1 分钟">
            <span class="compose-field-label">预计完成</span>
            <div class="smart-duration-inputs">
              <input type="number" min="0" max="1666" step="1" inputmode="numeric" class="compose-input compose-input--sm smart-draft-hours" aria-label="小时" value="${escapeAttr(hm.h)}" />
              <span class="smart-duration-unit">小时</span>
              <input type="number" min="0" max="59" step="1" inputmode="numeric" class="compose-input compose-input--sm smart-draft-minutes" aria-label="分钟" value="${escapeAttr(hm.m)}" />
              <span class="smart-duration-unit">分钟</span>
            </div>
          </label>
          <select class="compose-input compose-input--sm smart-draft-time-mode" aria-label="时间完成方式">
            <option value="block" ${tm === "block" ? "selected" : ""}>优先整块（必要时拆多段）</option>
            <option value="fragment" ${tm === "fragment" ? "selected" : ""}>可碎片化完成</option>
          </select>
          <div class="smart-draft-row-footer">
            <button type="button" class="btn btn-soft smart-draft-commit" data-index="${idx}">添加</button>
            <button type="button" class="btn-text smart-remove-row" data-index="${idx}">移除</button>
          </div>`;
        table.appendChild(row);
      });
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "btn btn-soft smart-add-row";
      addBtn.textContent = "添加一行";
      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "btn btn-primary smart-step-next";
      nextBtn.textContent = "下一步";
      root.append(table, addBtn, nextBtn);
    } else if (sp.step === 2) {
      root.innerHTML = `
        <div class="smart-step2-grid">
          <label class="compose-field"><span class="compose-field-label">开始工作时间</span>
            <input type="time" id="smart-work-start" class="compose-input compose-input--sm" step="60" value="${sp.workStart || ""}" /></label>
          <label class="compose-field"><span class="compose-field-label">结束工作时间</span>
            <input type="time" id="smart-work-end" class="compose-input compose-input--sm" step="60" value="${sp.workEnd || ""}" /></label>
          <label class="compose-field compose-field--block"><span class="compose-field-label">可工作时段</span>
            <textarea id="smart-work-slots" class="compose-textarea" rows="5" placeholder="每行一段，如：14:00-15:50">${escapeHtml(sp.workSlots)}</textarea></label>
          <div class="compose-field"><span class="compose-field-label">任务表弹性</span>
            <div class="star-picker smart-flex-picker" id="smart-flex-picker">${renderStarsHtml(sp.flexibility)}</div></div>
        </div>
        <div class="smart-wizard-actions">
          <button type="button" class="btn btn-ghost smart-step-prev">上一步</button>
          <button type="button" class="btn btn-primary smart-step-done">完成</button>
        </div>`;
    } else {
      const summary = document.createElement("div");
      summary.className = "smart-summary";
      let html = '<div class="smart-summary-block"><table class="smart-sum-table">';
      html +=
        "<thead><tr><th>任务</th><th>标签</th><th>紧迫度</th><th>预计耗时</th><th>时间方式</th></tr></thead><tbody>";
      sp.draftTasks.forEach((t) => {
        const tm = t.timeMode === "fragment" ? "fragment" : "block";
        html += `<tr><td>${t.text ? escapeHtml(t.text) : "—"}</td><td>${escapeHtml(
          draftCategoryLabel(t.categoryId || UNCATEGORIZED_ID)
        )}</td><td>${urgencyStarsText(t.urgency)}</td><td>${formatDurationMinutesCell(
          t.expectedDurationMinutes
        )}</td><td>${draftTimeModeLabel(tm)}</td></tr>`;
      });
      html += "</tbody></table></div>";
      html += `<div class="smart-summary-block"><p>${sp.workStart || "—"} – ${sp.workEnd || "—"}</p>`;
      html += `<pre class="smart-slots-pre">${escapeHtml(sp.workSlots) || "—"}</pre>`;
      html += `<p>${urgencyStarsText(sp.flexibility)}</p></div>`;
      summary.innerHTML = html;

      const aiBlock = document.createElement("div");
      aiBlock.className = "smart-ai-block";
      const errBox = document.createElement("div");
      errBox.id = "smart-ai-error";
      errBox.className = "smart-ai-error";
      errBox.setAttribute("role", "alert");
      errBox.hidden = true;
      const aiActions = document.createElement("div");
      aiActions.className = "smart-wizard-actions smart-ai-actions";
      const aiBtn = document.createElement("button");
      aiBtn.type = "button";
      aiBtn.id = "smart-ai-schedule-btn";
      aiBtn.className = "btn btn-primary smart-ai-schedule";
      aiBtn.textContent = "AI 安排并填入任务列表";
      aiActions.appendChild(aiBtn);
      aiBlock.append(errBox, aiActions);

      const backRow = document.createElement("div");
      backRow.className = "smart-wizard-actions";
      const back = document.createElement("button");
      back.type = "button";
      back.className = "btn btn-ghost smart-edit-settings";
      back.textContent = "修改设置";
      backRow.appendChild(back);

      root.append(summary, aiBlock, backRow);
    }

    listContainer.innerHTML = "";
    listContainer.appendChild(root);

  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseJsonFromAiContent(text) {
    let s = String(text || "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    try {
      return JSON.parse(s);
    } catch (e1) {
      const start = s.indexOf("{");
      const end = s.lastIndexOf("}");
      if (start !== -1 && end > start) {
        return JSON.parse(s.slice(start, end + 1));
      }
      throw e1;
    }
  }

  function validateSmartPlanForAi(sp) {
    if (!sp.draftTasks.length) {
      return { ok: false, message: "请至少添加一项任务。" };
    }
    const confirmed = sp.draftTasks.filter(isDraftConfirmed);
    if (confirmed.length === 0) {
      return { ok: false, message: "请至少对一条任务点击「添加」，保存为只读摘要后，才能进行 AI 安排。" };
    }
    for (let i = 0; i < confirmed.length; i++) {
      const t = confirmed[i];
      if (!t.text || !String(t.text).trim()) {
        return { ok: false, message: `已确认的任务中有标题为空的项，请编辑后重新点「添加」。` };
      }
      if (t.expectedDurationMinutes == null || t.expectedDurationMinutes < 1) {
        return { ok: false, message: `请为已确认任务「${String(t.text).trim()}」填写有效的预计完成时间。` };
      }
    }
    if (!sp.workStart || !sp.workEnd) {
      return { ok: false, message: "请填写开始与结束工作时间。" };
    }
    return { ok: true };
  }

  function sumAllowedWorkMinutesFromPlan(sp) {
    return buildAllowedIntervalsFromWorkPlan(sp).reduce((acc, seg) => acc + (seg.end - seg.start), 0);
  }

  function buildSmartScheduleUserPayload(sp) {
    const slotsNorm = getNormalizedWorkSlotsDescription(sp);
    const tasks = sp.draftTasks.filter(isDraftConfirmed);
    const sumExpected = tasks.reduce((acc, t) => acc + (t.expectedDurationMinutes || 0), 0);
    const totalAvail = sumAllowedWorkMinutesFromPlan(sp);
    const shortfall = Math.max(0, sumExpected - totalAvail);
    return {
      workWindow: {
        workStart: sp.workStart,
        workEnd: sp.workEnd,
        workSlotsDescription: sp.workSlots || "",
        workSlotsNormalized: slotsNorm,
        note:
          "开始/结束工作时间定义当日总可用范围；可工作时段为多行语段。workSlotsNormalized 已将自然语言时间转为数字时钟区间；若语段中出现具体时间，任务必须整段落在其中某一区间内。",
      },
      capacity: {
        totalAvailableWorkMinutes: totalAvail,
        sumExpectedDurationMinutes: sumExpected,
        shortfallMinutes: shortfall,
      },
      flexibilityStars: sp.flexibility,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: String(t.text).trim(),
        categoryLabel: draftCategoryLabel(t.categoryId || UNCATEGORIZED_ID),
        urgency: t.urgency,
        expectedDurationMinutes: t.expectedDurationMinutes,
        timeMode: t.timeMode === "fragment" ? "fragment" : "block",
      })),
    };
  }

  async function requestSmartSchedule(userPayload) {
    const body = {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: SMART_SCHEDULE_SYSTEM_PROMPT },
        {
          role: "user",
          content:
            "请根据以下 JSON 数据安排今日任务并只输出约定格式的 JSON：\n" +
            JSON.stringify(userPayload, null, 2),
        },
      ],
      temperature: 0.3,
    };
    const res = await fetch(SMART_SCHEDULE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data.error && data.error.message) || data.message || res.statusText || "请求失败";
      throw new Error(msg);
    }
    const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) throw new Error("接口未返回内容");
    return parseJsonFromAiContent(raw);
  }

  /** 识别模型在 taskId 等短字段填入的拒绝说明（避免与任务标题误判：仅匹配较短片段）。 */
  function looksLikeModelScheduleRefusal(s) {
    const t = String(s || "").trim();
    if (t.length > 120) return false;
    return /无法生成|不在可规划|不能生成|不能安排|拒绝|不在.*范围内.*无法|无可规划|超出.*可规划/i.test(t);
  }

  function parseSegmentsFromAiScheduleRow(row) {
    let raw = [];
    if (Array.isArray(row.segments) && row.segments.length > 0) {
      raw = row.segments;
    } else if (row.timeStart != null && row.timeEnd != null) {
      raw = [{ timeStart: row.timeStart, timeEnd: row.timeEnd }];
    } else {
      return null;
    }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const seg = raw[i];
      if (!seg || seg.timeStart == null || seg.timeEnd == null) continue;
      if (
        looksLikeModelScheduleRefusal(String(seg.timeStart)) ||
        looksLikeModelScheduleRefusal(String(seg.timeEnd))
      ) {
        continue;
      }
      const tsa = parseTimeHHMM(String(seg.timeStart).trim());
      const teb = parseTimeHHMM(String(seg.timeEnd).trim());
      if (!tsa || !teb) continue;
      const a = timeToMinutes(tsa);
      const b = timeToMinutes(teb);
      if (a == null || b == null || b <= a) continue;
      out.push({ timeStart: tsa, timeEnd: teb });
    }
    return out.length ? out : null;
  }

  function buildItemsFromAiParsed(sp, parsed) {
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
    const confirmedDrafts = sp.draftTasks.filter(isDraftConfirmed);
    if (!items || items.length !== confirmedDrafts.length) {
      throw new Error("返回的任务条数与已确认的任务条数不一致，请重试。");
    }
    const byId = new Map(items.map((it) => [String(it.taskId), it]));
    const catOk = (id) => state.daily.categories.some((c) => c.id === id);
    const scheduledById = new Map();
    for (let i = 0; i < confirmedDrafts.length; i++) {
      const draft = confirmedDrafts[i];
      let row = byId.get(String(draft.id));
      if (row && looksLikeModelScheduleRefusal(row.taskId)) {
        row = null;
      }
      if (!row) row = items[i];
      if (row && looksLikeModelScheduleRefusal(row.taskId)) {
        row = null;
      }
      if (!row) {
        throw new Error("返回数据缺少时间或任务对应关系，请重试。");
      }
      const segs = parseSegmentsFromAiScheduleRow(row);
      if (!segs || !segs.length) {
        throw new Error("返回数据缺少时间或任务对应关系，请重试。");
      }
      let timeStart;
      let timeEnd;
      let timeSegments;
      if (segs.length === 1) {
        timeStart = segs[0].timeStart;
        timeEnd = segs[0].timeEnd;
        timeSegments = undefined;
      } else {
        const mins = segs.map((s) => ({
          a: timeToMinutes(s.timeStart),
          b: timeToMinutes(s.timeEnd),
        }));
        const minS = Math.min(...mins.map((x) => x.a));
        const maxE = Math.max(...mins.map((x) => x.b));
        timeStart = formatHM(minS);
        timeEnd = formatHM(maxE);
        timeSegments = segs;
      }
      const cid = draft.categoryId && catOk(draft.categoryId) ? draft.categoryId : UNCATEGORIZED_ID;
      const baseItem = {
        id: draft.id,
        text: String(draft.text).trim(),
        done: false,
        categoryId: cid,
        order: 0,
        deadline: null,
        planDays: null,
        urgency: draft.urgency,
        timeStart,
        timeEnd,
      };
      if (timeSegments) {
        baseItem.timeSegments = timeSegments;
      }
      scheduledById.set(draft.id, baseItem);
    }
    const built = sp.draftTasks.map((draft, order) => {
      if (!isDraftConfirmed(draft)) {
        const cid = draft.categoryId && catOk(draft.categoryId) ? draft.categoryId : UNCATEGORIZED_ID;
        return {
          id: draft.id,
          text: String(draft.text || "").trim() || "未命名",
          done: false,
          categoryId: cid,
          order,
          deadline: null,
          planDays: null,
          urgency: draft.urgency,
          timeStart: null,
          timeEnd: null,
        };
      }
      const it = scheduledById.get(draft.id);
      if (!it) throw new Error("返回数据与已确认任务不匹配，请重试。");
      return { ...it, order };
    });
    assertScheduleWithinWorkPlan(
      sp,
      built.filter((x) => x.timeStart && x.timeEnd)
    );
    return built;
  }

  function commitAiScheduleItems(newItems) {
    const sorted = newItems.slice().sort((a, b) => {
      const ka = dailyTimeSortKey(a);
      const kb = dailyTimeSortKey(b);
      if (ka !== kb) return ka - kb;
      return a.order - b.order;
    });
    sorted.forEach((t, i) => {
      t.order = i;
    });
    state.daily.items = sorted;
    state.daily.dailyArrangement = "manual";
    const sp = state.daily.smartPlan;
    sp.step = 3;
    const draftById = new Map(sp.draftTasks.map((d) => [d.id, d]));
    sp.draftTasks = sorted.map((it) => {
      const prev = draftById.get(it.id);
      // IMPORTANT: 用户填写的 expectedDurationMinutes 不应被 AI 返回的 timeStart/timeEnd 反推覆盖。
      // 仅在用户从未填写过 expectedDurationMinutes 时，才做兜底计算。
      let expectedDurationMinutes = prev ? prev.expectedDurationMinutes : null;
      if (expectedDurationMinutes == null || expectedDurationMinutes < 1) {
        const ivs = itemScheduleIntervalsMinutes(it);
        if (ivs.length) {
          expectedDurationMinutes = ivs.reduce((acc, x) => acc + (x.end - x.start), 0);
        } else if (it.timeStart && it.timeEnd) {
          const ts = timeToMinutes(it.timeStart);
          const te = timeToMinutes(it.timeEnd);
          if (ts != null && te != null && te > ts) expectedDurationMinutes = te - ts;
        }
      }

      const titleOk = !!(it.text && String(it.text).trim());
      const durationOk = expectedDurationMinutes != null && expectedDurationMinutes >= 1;
      const tm = prev && prev.timeMode === "fragment" ? "fragment" : "block";
      const confirmedFromPrev = prev ? isDraftConfirmed(prev) : titleOk && durationOk;
      const confirmedFinal = confirmedFromPrev && titleOk && durationOk;
      return {
        id: it.id,
        text: it.text,
        urgency: it.urgency,
        categoryId: it.categoryId || UNCATEGORIZED_ID,
        expectedDurationMinutes,
        timeMode: tm,
        confirmed: confirmedFinal,
      };
    });
    save();
  }

  function applyAiScheduleToDaily(sp, parsed) {
    const newItems = buildItemsFromAiParsed(sp, parsed);
    commitAiScheduleItems(newItems);
  }

  async function runSmartAiSchedule() {
    if (smartAiLoading) return;
    const sp = state.daily.smartPlan;
    const errEl = document.getElementById("smart-ai-error");
    const btn = document.getElementById("smart-ai-schedule-btn");
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = "";
    }
    const v = validateSmartPlanForAi(sp);
    if (!v.ok) {
      if (errEl) {
        errEl.textContent = v.message;
        errEl.hidden = false;
      }
      return;
    }
    smartAiLoading = true;
    if (btn) {
      btn.disabled = true;
      btn.dataset.label = btn.textContent;
      btn.textContent = "正在生成…";
    }
    try {
      const payload = buildSmartScheduleUserPayload(sp);
      const parsed = await requestSmartSchedule(payload);
      const newItems = buildItemsFromAiParsed(sp, parsed);
      if (findConflictsInItems(newItems).length > 0) {
        showTimeConflictDialog(
          "生成的时间段存在重叠。选择「覆盖另一任务时段」将保留较早的时段，并清空与之后任务冲突的时段；也可选择重新填写时间以取消本次结果。",
          () => {
            commitAiScheduleItems(resolveOverlapsByClearingLater(newItems));
            editingId = null;
            render();
          },
          () => {}
        );
      } else {
        commitAiScheduleItems(newItems);
        editingId = null;
        render();
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (errEl) {
        errEl.textContent = "安排失败：" + msg;
        errEl.hidden = false;
      }
    } finally {
      smartAiLoading = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = btn.dataset.label || "AI 安排并填入任务列表";
      }
    }
  }

  let dragId = null;

  function onDragStart(e) {
    if (!e.target.classList.contains("todo-drag")) return;
    const li = e.target.closest(".todo-item");
    if (!li || getSheetKey() !== "comprehensive") return;
    dragId = li.dataset.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
  }

  function onDragEnd(e) {
    const li = e.target.closest(".todo-item");
    if (li) li.classList.remove("dragging");
    dragId = null;
  }

  function onDragOver(e) {
    if (getSheetKey() !== "comprehensive") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function onDrop(e) {
    if (getSheetKey() !== "comprehensive") return;
    e.preventDefault();
    const ul = document.getElementById("todo-list-manual");
    if (!ul || !dragId) return;
    const ids = Array.from(ul.querySelectorAll(".todo-item")).map((el) => el.dataset.id);
    if (ids.indexOf(dragId) === -1) return;
    const newIds = ids.filter((id) => id !== dragId);
    const target = e.target.closest(".todo-item");
    if (!target) {
      newIds.push(dragId);
    } else {
      const targetId = target.dataset.id;
      if (targetId === dragId) return;
      const insertAt = newIds.indexOf(targetId);
      if (insertAt === -1) return;
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      if (before) newIds.splice(insertAt, 0, dragId);
      else newIds.splice(insertAt + 1, 0, dragId);
    }
    const sheet = getSheet();
    newIds.forEach((id, i) => {
      const item = sheet.items.find((t) => t.id === id);
      if (item) item.order = i;
    });
    save();
    render();
  }

  function unbindListDrag() {
    listContainer.removeEventListener("dragstart", onDragStart);
    listContainer.removeEventListener("dragend", onDragEnd);
    listContainer.removeEventListener("dragover", onDragOver);
    listContainer.removeEventListener("drop", onDrop);
  }

  function bindListDrag() {
    unbindListDrag();
    listContainer.addEventListener("dragstart", onDragStart);
    listContainer.addEventListener("dragend", onDragEnd);
    listContainer.addEventListener("dragover", onDragOver);
    listContainer.addEventListener("drop", onDrop);
  }

  function patchCurrentSheetItem(id, patch) {
    const sheet = getSheet();
    sheet.items = sheet.items.map((t) => {
      if (t.id !== id) return t;
      let next = { ...t, ...patch };
      if (
        Object.prototype.hasOwnProperty.call(patch, "timeStart") ||
        Object.prototype.hasOwnProperty.call(patch, "timeEnd")
      ) {
        next = { ...next };
        delete next.timeSegments;
      }
      return next;
    });
    save();
  }

  function collectSmartDraftFromDom() {
    const rows = listContainer.querySelectorAll(".smart-draft-row");
    const draftTasks = [];
    rows.forEach((row, i) => {
      const prev = state.daily.smartPlan.draftTasks[i] || { id: uid(), urgency: 1, confirmed: false };
      if (isDraftConfirmed(prev) || row.classList.contains("smart-draft-row--locked")) {
        draftTasks.push({
          id: prev.id || uid(),
          text: typeof prev.text === "string" ? prev.text : "",
          urgency: Math.min(5, Math.max(1, parseInt(prev.urgency, 10) || 1)),
          categoryId: prev.categoryId || UNCATEGORIZED_ID,
          expectedDurationMinutes: prev.expectedDurationMinutes,
          timeMode: prev.timeMode === "fragment" ? "fragment" : "block",
          confirmed: true,
        });
        return;
      }
      const title = row.querySelector(".smart-draft-title");
      const hEl = row.querySelector(".smart-draft-hours");
      const mEl = row.querySelector(".smart-draft-minutes");
      const modeEl = row.querySelector(".smart-draft-time-mode");
      const catEl = row.querySelector(".smart-draft-cat");
      const timeMode = modeEl && modeEl.value === "fragment" ? "fragment" : "block";
      let h = hEl && hEl.value.trim() !== "" ? parseInt(hEl.value.trim(), 10) : 0;
      let mm = mEl && mEl.value.trim() !== "" ? parseInt(mEl.value.trim(), 10) : 0;
      if (Number.isNaN(h)) h = 0;
      if (Number.isNaN(mm)) mm = 0;
      h = Math.min(1666, Math.max(0, h));
      mm = Math.min(59, Math.max(0, mm));
      const totalMin = h * 60 + mm;
      let expectedDurationMinutes = null;
      if (totalMin >= 1) expectedDurationMinutes = Math.min(99999, totalMin);
      let categoryId = prev.categoryId || UNCATEGORIZED_ID;
      if (catEl && catEl.value && state.daily.categories.some((c) => c.id === catEl.value)) {
        categoryId = catEl.value;
      }
      let urgency = prev.urgency;
      const starWrap = row.querySelector(".smart-draft-stars");
      if (starWrap) {
        const on = starWrap.querySelectorAll(".star-btn.is-on");
        if (on.length) urgency = on.length;
      }
      draftTasks.push({
        id: prev.id || uid(),
        text: title ? title.value.trim() : "",
        urgency: Math.min(5, Math.max(1, urgency || 1)),
        categoryId,
        expectedDurationMinutes,
        timeMode,
        confirmed: false,
      });
    });
    state.daily.smartPlan.draftTasks = draftTasks;
  }

  function handleSmartWizardClick(e) {
    const wiz = e.target.closest("#smart-wizard");
    if (!wiz) return;
    const sp = state.daily.smartPlan;

    if (e.target.closest(".smart-ai-schedule")) {
      e.preventDefault();
      void runSmartAiSchedule();
      return;
    }

    if (e.target.closest(".smart-draft-edit")) {
      collectSmartDraftFromDom();
      const btn = e.target.closest(".smart-draft-edit");
      const idx = +btn.dataset.index;
      if (sp.draftTasks[idx]) {
        sp.draftTasks[idx].confirmed = false;
        delete sp.draftTasks[idx].locked;
        save();
        render();
      }
      return;
    }

    if (e.target.closest(".smart-draft-commit")) {
      collectSmartDraftFromDom();
      const btn = e.target.closest(".smart-draft-commit");
      const idx = +btn.dataset.index;
      const t = sp.draftTasks[idx];
      if (!t || isDraftConfirmed(t)) return;
      const title = (t.text && String(t.text).trim()) || "";
      if (!title) {
        window.alert("请填写任务标题后再点击添加。");
        return;
      }
      if (t.expectedDurationMinutes == null || t.expectedDurationMinutes < 1) {
        window.alert("请填写预计完成时间（小时与分钟，合计至少 1 分钟）后再点击添加。");
        return;
      }
      sp.draftTasks[idx].confirmed = true;
      delete sp.draftTasks[idx].locked;
      save();
      render();
      return;
    }

    if (e.target.closest(".smart-add-row")) {
      collectSmartDraftFromDom();
      const preferred =
        (categorySelect && categorySelect.value) ||
        state.daily.categories.find((c) => c.id !== UNCATEGORIZED_ID)?.id ||
        UNCATEGORIZED_ID;
      sp.draftTasks.push({
        id: uid(),
        text: "",
        urgency: 1,
        categoryId: preferred,
        expectedDurationMinutes: null,
        timeMode: "block",
        confirmed: false,
      });
      save();
      render();
      return;
    }

    if (e.target.closest(".smart-remove-row")) {
      collectSmartDraftFromDom();
      const btn = e.target.closest(".smart-remove-row");
      const idx = +btn.dataset.index;
      sp.draftTasks.splice(idx, 1);
      save();
      render();
      return;
    }

    if (e.target.closest(".smart-step-next")) {
      collectSmartDraftFromDom();
      if (!sp.draftTasks.length) {
        window.alert("请至少添加一项任务。");
        return;
      }
      for (let i = 0; i < sp.draftTasks.length; i++) {
        const t = sp.draftTasks[i];
        if (!isDraftConfirmed(t)) {
          window.alert(`请先点击第 ${i + 1} 条任务下方的「添加」，将该任务保存为只读摘要后再进入下一步。`);
          return;
        }
        if (!t.text || !String(t.text).trim()) {
          window.alert(`第 ${i + 1} 行任务标题不能为空。`);
          return;
        }
        if (t.expectedDurationMinutes == null || t.expectedDurationMinutes < 1) {
          window.alert(
            `请为「${String(t.text).trim()}」填写预计完成时间（小时与分钟，合计至少 1 分钟）。`
          );
          return;
        }
      }
      sp.step = 2;
      save();
      render();
      return;
    }

    if (e.target.closest(".smart-step-prev")) {
      sp.step = 1;
      save();
      render();
      return;
    }

    if (e.target.closest(".smart-step-done")) {
      const ws = document.getElementById("smart-work-start");
      const we = document.getElementById("smart-work-end");
      const slots = document.getElementById("smart-work-slots");
      sp.workStart = ws && ws.value ? parseTimeHHMM(ws.value.trim()) : null;
      sp.workEnd = we && we.value ? parseTimeHHMM(we.value.trim()) : null;
      sp.workSlots = slots ? slots.value : "";
      sp.step = 3;
      save();
      render();
      return;
    }

    if (e.target.closest(".smart-edit-settings")) {
      sp.step = 1;
      save();
      render();
      return;
    }

    const starInDraft = e.target.closest(".smart-draft-stars .star-btn");
    if (starInDraft) {
      const wrap = e.target.closest(".smart-draft-stars");
      const idx = +wrap.dataset.index;
      const val = +starInDraft.dataset.si;
      if (sp.draftTasks[idx]) {
        sp.draftTasks[idx].urgency = val;
        wrap.innerHTML = renderStarsHtml(val);
        save();
      }
      return;
    }

    const flexStar = e.target.closest("#smart-flex-picker .star-btn");
    if (flexStar) {
      const si = +flexStar.dataset.si;
      state.daily.smartPlan.flexibility = si;
      save();
      const fp = document.getElementById("smart-flex-picker");
      if (fp) fp.innerHTML = renderStarsHtml(si);
      return;
    }
  }

  function render() {
    if (!composePanel.hidden) {
      initComposeUrgencyPicker();
      updateComposeUrgencyDisplay();
    }

    updateSheetUi();
    updateChromeVisibility();

    if (state.activeSheet === "daily" && state.daily.dailyArrangement === "smart") {
      const sp = state.daily.smartPlan;
      countBadge.textContent = String(sp.draftTasks.length);
      renderTagList();
      renderCategorySelect();
      renderDailySmartWizard();
      unbindListDrag();
      return;
    }

    renderCategorySelect();
    renderTagList();

    const sheet = getSheet();
    const active = sheet.items.filter((t) => !t.done).length;
    countBadge.textContent = String(active);

    if (sheet.items.length === 0) {
      listContainer.innerHTML = "";
      unbindListDrag();
    } else {
      renderList();
      if (getSheetKey() === "comprehensive") {
        bindListDrag();
      } else {
        unbindListDrag();
      }
    }
  }

  function toggle(id) {
    const sh = getSheet();
    sh.items = sh.items.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
    save();
    render();
  }

  function remove(id) {
    editingId = editingId === id ? null : editingId;
    const sh = getSheet();
    sh.items = sh.items.filter((t) => t.id !== id);
    save();
    render();
  }

  sheetDailyBtn.addEventListener("click", () => setActiveSheet("daily"));
  sheetCompBtn.addEventListener("click", () => setActiveSheet("comprehensive"));
  dailyArrManualBtn.addEventListener("click", () => setDailyArrangement("manual"));
  dailyArrSmartBtn.addEventListener("click", () => setDailyArrangement("smart"));

  function syncTargetCategoriesOrderAndFixInvalidItems(sourceSheet, targetSheet) {
    const sourceById = new Map((sourceSheet.categories || []).map((c) => [c.id, c]));
    const targetById = new Map((targetSheet.categories || []).map((c) => [c.id, c]));

    const next = [];
    (sourceSheet.categories || []).forEach((sc) => {
      next.push(targetById.has(sc.id) ? targetById.get(sc.id) : { ...sc });
    });
    (targetSheet.categories || []).forEach((tc) => {
      if (!sourceById.has(tc.id)) next.push(tc);
    });

    targetSheet.categories = next.map((c) => ({ ...c }));

    const catIdSet = new Set(targetSheet.categories.map((c) => c.id));
    if (Array.isArray(targetSheet.items)) {
      targetSheet.items = targetSheet.items.map((it) =>
        catIdSet.has(it.categoryId) ? it : { ...it, categoryId: UNCATEGORIZED_ID }
      );
    }
    if (targetSheet.smartPlan && Array.isArray(targetSheet.smartPlan.draftTasks)) {
      targetSheet.smartPlan.draftTasks = targetSheet.smartPlan.draftTasks.map((dt) =>
        catIdSet.has(dt.categoryId) ? dt : { ...dt, categoryId: UNCATEGORIZED_ID }
      );
    }
  }

  tagForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = tagInput.value.trim();
    if (!name) return;
    const sheet = getSheet();
    const otherSheet = state.activeSheet === "daily" ? state.comprehensive : state.daily;
    if (sheet.categories.some((c) => c.name === name)) {
      tagInput.value = "";
      return;
    }

    // 如果另一张表已经有同名标签，则复用它的 id，从而保持两边的 categoryId 一致。
    const otherExisting = otherSheet.categories.find((c) => c.name === name);
    const id = otherExisting ? otherExisting.id : uid();
    const newCat = { id, name, system: false };
    sheet.categories.push({ ...newCat });
    if (!otherExisting) {
      otherSheet.categories.push({ ...newCat });
    }
    syncTargetCategoriesOrderAndFixInvalidItems(sheet, otherSheet);
    tagInput.value = "";
    save();
    render();
  });

  tagList.addEventListener("click", (e) => {
    const btn = e.target.closest(".tag-chip-remove");
    if (!btn) return;
    const catId = btn.dataset.catId;
    if (!catId || catId === UNCATEGORIZED_ID) return;
    const sheet = getSheet();
    const otherSheet = state.activeSheet === "daily" ? state.comprehensive : state.daily;
    const removedCat = sheet.categories.find((c) => c.id === catId);
    const otherExistingById = otherSheet.categories.find((c) => c.id === catId);
    const otherExistingByName = removedCat
      ? otherSheet.categories.find((c) => c.name === removedCat.name)
      : null;
    const otherCatId = (otherExistingById && otherExistingById.id) || (otherExistingByName && otherExistingByName.id) || null;

    sheet.items = sheet.items.map((t) =>
      t.categoryId === catId ? { ...t, categoryId: UNCATEGORIZED_ID } : t
    );
    if (sheet.smartPlan && Array.isArray(sheet.smartPlan.draftTasks)) {
      sheet.smartPlan.draftTasks = sheet.smartPlan.draftTasks.map((dt) =>
        dt.categoryId === catId ? { ...dt, categoryId: UNCATEGORIZED_ID } : dt
      );
    }
    sheet.categories = sheet.categories.filter((c) => c.id !== catId);

    if (otherCatId) {
      otherSheet.items = otherSheet.items.map((t) =>
        t.categoryId === otherCatId ? { ...t, categoryId: UNCATEGORIZED_ID } : t
      );
      if (otherSheet.smartPlan && Array.isArray(otherSheet.smartPlan.draftTasks)) {
        otherSheet.smartPlan.draftTasks = otherSheet.smartPlan.draftTasks.map((dt) =>
          dt.categoryId === otherCatId ? { ...dt, categoryId: UNCATEGORIZED_ID } : dt
        );
      }
      otherSheet.categories = otherSheet.categories.filter((c) => c.id !== otherCatId);
    }

    syncTargetCategoriesOrderAndFixInvalidItems(sheet, otherSheet);
    save();
    render();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const categoryId = categorySelect.value || UNCATEGORIZED_ID;
    const sheet = getSheet();
    const base = {
      id: uid(),
      text,
      done: false,
      categoryId,
      order: nextOrder(),
    };

    if (getSheetKey() === "comprehensive") {
      const deadline = compDeadlineInput.value.trim();
      const deadlineOk =
        deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null;
      const planRaw = compPlanDaysInput.value.trim();
      let planDays = null;
      if (planRaw !== "") {
        const n = parseInt(planRaw, 10);
        if (!Number.isNaN(n) && n >= 1) planDays = Math.min(9999, n);
      }
      sheet.items.push({
        ...base,
        deadline: deadlineOk,
        planDays,
        urgency: composeUrgency,
        timeStart: null,
        timeEnd: null,
      });
      compDeadlineInput.value = "";
      compPlanDaysInput.value = "";
    } else {
      const ts = dailyTimeStartInput.value.trim();
      const te = dailyTimeEndInput.value.trim();
      const newItem = {
        ...base,
        deadline: null,
        planDays: null,
        timeStart: ts ? parseTimeHHMM(ts) || ts : null,
        timeEnd: te ? parseTimeHHMM(te) || te : null,
        urgency: composeUrgency,
      };
      const candidateItems = [...sheet.items, newItem];
      const c = findConflictWithId(candidateItems, newItem.id);
      if (c) {
        const otherTitle = (c.other.text && String(c.other.text).trim()) || "已有任务";
        showTimeConflictDialog(
          `与「${otherTitle}」的时间段重叠。覆盖将清空对方的起止时间。`,
          () => {
            sheet.items = sheet.items.map((t) =>
              t.id === c.other.id ? { ...t, timeStart: null, timeEnd: null } : t
            );
            sheet.items.push(newItem);
            dailyTimeStartInput.value = "";
            dailyTimeEndInput.value = "";
            composeUrgency = 1;
            updateComposeUrgencyDisplay();
            input.value = "";
            save();
            setComposeOpen(false);
            render();
          },
          () => {}
        );
        return;
      }
      sheet.items.push(newItem);
      dailyTimeStartInput.value = "";
      dailyTimeEndInput.value = "";
    }

    composeUrgency = 1;
    updateComposeUrgencyDisplay();
    input.value = "";
    save();
    setComposeOpen(false);
    render();
  });

  listContainer.addEventListener("click", (e) => {
    if (state.activeSheet === "daily" && state.daily.dailyArrangement === "smart") {
      handleSmartWizardClick(e);
      return;
    }

    if (e.target.closest("input, textarea, select, .todo-stars")) {
      e.stopPropagation();
    }

    if (e.target.closest(".btn-edit")) {
      const li = e.target.closest(".todo-item");
      if (li) {
        editingId = li.dataset.id;
        render();
      }
      return;
    }

    if (e.target.closest(".btn-finish-edit")) {
      editingId = null;
      render();
      return;
    }

    if (e.target.closest(".btn-del-text")) {
      const li = e.target.closest(".todo-item");
      if (li) remove(li.dataset.id);
      return;
    }

    const starBtn = e.target.closest(".todo-stars .star-btn");
    if (starBtn && editingId) {
      const row = starBtn.closest(".todo-item");
      if (!row || row.dataset.id !== editingId) return;
      e.preventDefault();
      const val = +starBtn.dataset.value;
      patchCurrentSheetItem(row.dataset.id, { urgency: val });
      render();
      return;
    }

    const li = e.target.closest(".todo-item");
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.closest(".todo-check")) toggle(id);
  });

  listContainer.addEventListener(
    "input",
    (e) => {
      if (state.activeSheet !== "daily" || state.daily.dailyArrangement !== "smart") return;
      if (state.daily.smartPlan.step !== 1) return;
      const row = e.target.closest(".smart-draft-row");
      if (!row || row.classList.contains("smart-draft-row--locked")) return;
      if (
        e.target.classList.contains("smart-draft-title") ||
        e.target.classList.contains("smart-draft-hours") ||
        e.target.classList.contains("smart-draft-minutes")
      ) {
        collectSmartDraftFromDom();
        save();
      }
    },
    true
  );

  listContainer.addEventListener(
    "change",
    (e) => {
      if (state.activeSheet === "daily" && state.daily.dailyArrangement === "smart") {
        if (state.daily.smartPlan.step === 1 && e.target.closest(".smart-draft-time-mode")) {
          collectSmartDraftFromDom();
          save();
          return;
        }
        const sel = e.target.closest(".smart-draft-cat");
        if (sel) {
          const row = sel.closest(".smart-draft-row");
          const idx = row ? +row.dataset.index : -1;
          if (idx >= 0 && state.daily.smartPlan.draftTasks[idx]) {
            state.daily.smartPlan.draftTasks[idx].categoryId = sel.value;
            collectSmartDraftFromDom();
            save();
          }
          return;
        }
      }
      if (editingId == null) return;
      const sel = e.target.closest(".todo-meta-cat");
      if (!sel) return;
      const row = sel.closest(".todo-item");
      if (!row || row.dataset.id !== editingId) return;
      patchCurrentSheetItem(row.dataset.id, { categoryId: sel.value });
      render();
    },
    true
  );

  listContainer.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (
        !t.classList.contains("todo-meta-time-start") &&
        !t.classList.contains("todo-meta-time-end")
      ) {
        return;
      }
      if (editingId == null) return;
      const row = t.closest(".todo-item");
      if (!row || row.dataset.id !== editingId) return;
      const id = row.dataset.id;
      const sheet = getSheet();
      const item = sheet.items.find((x) => x.id === id);
      if (item) {
        timeEditSnapshot.set(id, { timeStart: item.timeStart, timeEnd: item.timeEnd });
      }
    },
    true
  );

  listContainer.addEventListener(
    "blur",
    (e) => {
      if (editingId == null) return;
      const t = e.target;
      const row = t.closest(".todo-item");
      if (!row || row.dataset.id !== editingId) return;
      const id = row.dataset.id;

      if (t.classList.contains("todo-title-input")) {
        patchCurrentSheetItem(id, { text: t.value.trim() || "未命名" });
        render();
        return;
      }
      if (t.classList.contains("todo-meta-time-start") || t.classList.contains("todo-meta-time-end")) {
        const field = t.classList.contains("todo-meta-time-start") ? "timeStart" : "timeEnd";
        const v = t.value.trim();
        const parsed = v ? parseTimeHHMM(v) || v : null;
        const sheet = getSheet();
        const cur = sheet.items.find((x) => x.id === id);
        if (!cur) {
          render();
          return;
        }
        const next = { ...cur, [field]: parsed };
        const items = sheet.items.map((x) => (x.id === id ? next : x));
        const c = findConflictWithId(items, id);
        if (c) {
          const snap = timeEditSnapshot.get(id) || {
            timeStart: cur.timeStart,
            timeEnd: cur.timeEnd,
          };
          const otherTitle = (c.other.text && String(c.other.text).trim()) || "另一任务";
          showTimeConflictDialog(
            `与「${otherTitle}」的时间段重叠。覆盖将清空对方的起止时间。`,
            () => {
              patchCurrentSheetItem(c.other.id, { timeStart: null, timeEnd: null });
              patchCurrentSheetItem(id, { [field]: parsed });
              timeEditSnapshot.delete(id);
              save();
              render();
            },
            () => {
              const rowEl = t.closest(".todo-item");
              const startIn = rowEl && rowEl.querySelector(".todo-meta-time-start");
              const endIn = rowEl && rowEl.querySelector(".todo-meta-time-end");
              if (startIn)
                startIn.value = snap.timeStart != null ? String(snap.timeStart).slice(0, 5) : "";
              if (endIn) endIn.value = snap.timeEnd != null ? String(snap.timeEnd).slice(0, 5) : "";
              render();
            }
          );
          return;
        }
        patchCurrentSheetItem(id, { [field]: parsed });
        timeEditSnapshot.delete(id);
        render();
        return;
      }
      if (t.classList.contains("todo-meta-deadline")) {
        const v = t.value.trim();
        patchCurrentSheetItem(id, {
          deadline: v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null,
        });
      } else if (t.classList.contains("todo-meta-plan")) {
        const v = t.value.trim();
        let planDays = null;
        if (v !== "") {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 1) planDays = Math.min(9999, n);
        }
        patchCurrentSheetItem(id, { planDays });
      }
      render();
    },
    true
  );

  clearDoneBtn.addEventListener("click", () => {
    const sheet = getSheet();
    sheet.items = sheet.items.filter((t) => !t.done);
    save();
    render();
  });

  btnToggleCompose.addEventListener("click", () => {
    setComposeOpen(composePanel.hidden);
  });

  btnCancelCompose.addEventListener("click", () => {
    setComposeOpen(false);
  });

  render();
})();
