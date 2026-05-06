(function () {
  const STORAGE_KEY_V3 = "cute-todo-v3";
  const STORAGE_KEY_V2 = "cute-todo-v2";

  const CALENDAR_RETENTION_MONTHS = 6;
  const DEADLINE_NOTIFY_START_HOUR = 8;

  /** 智能安排代理接口（由你在云服务器部署，服务端持有 DeepSeek Key）。可在 index.html 里设置 window.SMART_SCHEDULE_API_URL 覆盖默认路径。 */
  const SMART_SCHEDULE_API_URL =
    typeof window !== "undefined" && window.SMART_SCHEDULE_API_URL
      ? window.SMART_SCHEDULE_API_URL
      : "/api/smart-schedule";

  const DEEPSEEK_MODEL = "deepseek-chat";

  const SMART_SCHEDULE_SYSTEM_PROMPT = `你是一个任务安排助手。请你按照所获知的信息安排今日工作。规则如下：

1. 只能在可工作时段安排任务；
2. 输入 tasks 中列出的每一条任务都必须安排时段（若 tasks 为子集则表示其余任务已由用户固定，不在此列）；
3. 紧迫性越高，任务安排越早；
4. 给任务安排的时间不得少于其预计完成时间；
5. 根据任务表弹性进行安排：
   1) 当弹性为 1 星时，严格按照预计完成时间进行安排，每项任务之间间隔不超过十分钟；
   2) 当弹性为 2 星时，任务安排时间不超过预计完成时间的 1.15 倍，每项任务之间间隔不超过 15 分钟；
   3) 当弹性为 3 星时，任务安排时间不超过预计完成时间的 1.3 倍且高于预计完成时间的 1.1 倍，每项任务之间间隔大于十分钟，小于 20 分钟；
   4) 当弹性为 4 星时，任务安排时间不超过预计完成时间的 1.4 倍且高于预计完成时间的 1.2 倍，每项任务之间间隔大于 15 分钟，小于 25 分钟；
   5) 当弹性为 5 星时，任务安排时间不超过预计完成时间的 1.5 倍且高于预计完成时间的 1.3 倍，每项任务之间间隔大于 20 分钟，小于 30 分钟。
6. 尽量在时间较整时安排任务开始；
7. 最低安排单位为分钟；
8. 对于要求时间连续的任务不要分开为多个时段。
9. 所有安排的时刻必须落在可工作时段内：① 不早于「开始工作时间」、不晚于「结束工作时间」；② 若「可工作时段」多行语段中写出了具体时段（如 14:00-15:50、21:00-23:59），则每一段任务时间必须完全落在其中某一语段所描述的时间范围内，不得落在语段之间的空隙中。
10. 若输入中 capacity.shortfallMinutes > 0（即按可工作时段计算出的可用总分钟数小于各任务预计耗时之和），仍须为每条任务都安排时段：优先保证紧迫度 urgency 高的任务尽量接近或达到预计耗时；不再安排紧迫性最低的任务，不得因此把任何任务排到可工作时段之外。
11. timeMode 为 block 的任务：优先排成一段连续时间；若可工作时段离散或总容量不足，允许拆成多段（见下方 segments）；当多个 block 任务无法都获得长连续时段时，urgency 更高的优先获得更长的连续时段。
12. 若输入中的 tasks 数组只包含部分任务，表示其余任务已由用户固定时段，你无需为它们输出 items；仅需为 tasks 中的每一条安排时间，且 items 的输出条数必须与 tasks 完全一致。

你必须只输出一个 JSON 对象，不要使用 markdown 代码块，不要添加任何解释文字。每条已确认任务对应 items 中一条记录（条数须与 tasks 一致）。格式二选一：
单段任务：{"taskId":"与输入任务 id 完全一致","timeStart":"HH:MM","timeEnd":"HH:MM"}
多段任务：{"taskId":"与输入任务 id 完全一致","segments":[{"timeStart":"HH:MM","timeEnd":"HH:MM"},…]}
timeStart/timeEnd 为 24 小时制，且结束晚于开始；segments 内各段均须落在可工作时段内。`;

  let smartAiLoading = false;
  /** 一键安排时未持久化：当前批次内所有未完成任务元数据（含 fixed / aiAssign）。 */
  let oneClickAllMeta = null;

  const timeEditSnapshot = new Map();

  const UNCATEGORIZED_ID = "cat-uncategorized";

  const LIST_TITLE = {
    dailyManual: "每日 · 待完成",
    comprehensive: "综合 · 待完成",
  };

  const DEFAULT_ONE_CLICK_EXPECTED_MINUTES = 60;

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
  const sheetCalBtn = document.getElementById("sheet-calendar");
  const listTitleEl = document.getElementById("list-title");
  const composeDailyExtra = document.getElementById("compose-daily-extra");
  const composeExtra = document.getElementById("compose-comprehensive-extra");
  const compDeadlineInput = document.getElementById("comp-deadline");
  const compPlanDaysInput = document.getElementById("comp-plan-days");
  const dailyTimeStartInput = document.getElementById("daily-time-start");
  const dailyTimeEndInput = document.getElementById("daily-time-end");
  const dailyExpectedHoursInput = document.getElementById("daily-expected-hours");
  const dailyExpectedMinutesInput = document.getElementById("daily-expected-minutes");
  const composeUrgencyEl = document.getElementById("compose-urgency");
  const composePanel = document.getElementById("compose-panel");
  const composeToolbar = document.getElementById("compose-toolbar");
  const tagsCard = document.getElementById("tags-card");
  const smartArrangeCard = document.getElementById("smart-arrange-card");
  const btnOneClickSmart = document.getElementById("btn-oneclick-smart");
  const smartOneClickError = document.getElementById("smart-oneclick-error");
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
      workSlotsExpanded: false,
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

  function defaultCalendarState() {
    return { days: {}, deadlineNotifyFired: {} };
  }

  function defaultStateV3() {
    return {
      activeSheet: "daily",
      persistedTaskSheet: "daily",
      daily: defaultSheetState("daily"),
      comprehensive: defaultSheetState("comprehensive"),
      calendar: defaultCalendarState(),
    };
  }

  function normalizeCalendarSnap(entry) {
    if (!entry || typeof entry !== "object") return { dailyCompleted: [] };
    const dailyCompleted = Array.isArray(entry.dailyCompleted)
      ? entry.dailyCompleted.map((row) => ({
          id: typeof row.id === "string" ? row.id : uid(),
          text: typeof row.text === "string" ? row.text : "",
          categoryId: typeof row.categoryId === "string" ? row.categoryId : UNCATEGORIZED_ID,
          urgency:
            typeof row.urgency === "number" && row.urgency >= 1
              ? Math.min(5, Math.floor(row.urgency))
              : 1,
          timeStart: row.timeStart && typeof row.timeStart === "string" ? row.timeStart : null,
          timeEnd: row.timeEnd && typeof row.timeEnd === "string" ? row.timeEnd : null,
        }))
      : [];
    return { dailyCompleted };
  }

  function normalizeCalendarBlock(raw) {
    const base = raw && typeof raw === "object" ? raw : {};
    const days = {};
    if (base.days && typeof base.days === "object") {
      for (const k of Object.keys(base.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        days[k] = normalizeCalendarSnap(base.days[k]);
      }
    }
    const deadlineNotifyFired =
      base.deadlineNotifyFired && typeof base.deadlineNotifyFired === "object"
        ? { ...base.deadlineNotifyFired }
        : {};
    return { days, deadlineNotifyFired };
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
    let expectedDurationMinutes = null;
    if (typeof t.expectedDurationMinutes === "number" && t.expectedDurationMinutes >= 1) {
      expectedDurationMinutes = Math.min(99999, Math.floor(t.expectedDurationMinutes));
    } else if (t.expectedDurationMinutes != null && String(t.expectedDurationMinutes).trim() !== "") {
      const n = parseInt(String(t.expectedDurationMinutes).trim(), 10);
      if (!Number.isNaN(n) && n >= 1) expectedDurationMinutes = Math.min(99999, n);
    }
    if (expectedDurationMinutes != null) {
      base.expectedDurationMinutes = expectedDurationMinutes;
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
      workSlotsExpanded: !!sp.workSlotsExpanded,
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
      dailyArrangement: "manual",
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
      let persistedTaskSheet;
      if (data.persistedTaskSheet === "comprehensive") persistedTaskSheet = "comprehensive";
      else if (data.persistedTaskSheet === "daily") persistedTaskSheet = "daily";
      else if (data.activeSheet === "calendar") persistedTaskSheet = "daily";
      else persistedTaskSheet =
          data.activeSheet === "comprehensive" ? "comprehensive" : "daily";
      const activeSheet =
        data.activeSheet === "calendar"
          ? "calendar"
          : data.activeSheet === "comprehensive"
            ? "comprehensive"
            : "daily";
      const calendar = normalizeCalendarBlock(data.calendar);
      return {
        activeSheet,
        persistedTaskSheet:
          persistedTaskSheet === "comprehensive" ? "comprehensive" : "daily",
        daily: normalizeDailySheet(data.daily),
        comprehensive: normalizeSheet(data.comprehensive, "comprehensive"),
        calendar,
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
      persistedTaskSheet: "comprehensive",
      daily: defaultSheetState("daily"),
      comprehensive,
      calendar: defaultCalendarState(),
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
      state.persistedTaskSheet = "comprehensive";
      if (!state.calendar) state.calendar = defaultCalendarState();
      localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(state));
    }
  })();

  if (!state.calendar) state.calendar = defaultCalendarState();
  if (state.persistedTaskSheet !== "daily" && state.persistedTaskSheet !== "comprehensive") {
    state.persistedTaskSheet = "daily";
  }

  function save() {
    pruneCalendarRetention();
    pruneDeadlineNotifyFiredMap();
    localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(state));
  }

  function getSheetKey() {
    return state.persistedTaskSheet === "comprehensive" ? "comprehensive" : "daily";
  }

  function getSheet() {
    return state.persistedTaskSheet === "comprehensive" ? state.comprehensive : state.daily;
  }

  function formatLocalYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function isDailyCalendarDateLocked(dateKey) {
    const now = new Date();
    const today = formatLocalYMD(now);
    if (dateKey < today) return true;
    if (dateKey > today) return false;
    return (
      now.getHours() > 23 || (now.getHours() === 23 && now.getMinutes() >= 59)
    );
  }

  function pruneCalendarRetention() {
    const cal = state.calendar;
    if (!cal || !cal.days) return;
    const boundary = new Date();
    boundary.setMonth(boundary.getMonth() - CALENDAR_RETENTION_MONTHS);
    const cutoff = formatLocalYMD(boundary);
    for (const k of Object.keys(cal.days)) {
      if (k < cutoff) delete cal.days[k];
    }
  }

  function pruneDeadlineNotifyFiredMap() {
    const cal = state.calendar;
    if (!cal || !cal.deadlineNotifyFired) return;
    const boundary = new Date();
    boundary.setMonth(boundary.getMonth() - CALENDAR_RETENTION_MONTHS);
    const cutoff = formatLocalYMD(boundary);
    for (const key of Object.keys(cal.deadlineNotifyFired)) {
      const pipe = key.indexOf("|");
      const d = pipe >= 0 ? key.slice(pipe + 1) : "";
      if (d && d < cutoff) delete cal.deadlineNotifyFired[key];
    }
  }

  function dailyTaskToCalendarRow(t) {
    return {
      id: t.id,
      text: t.text || "",
      categoryId: t.categoryId || UNCATEGORIZED_ID,
      urgency: Math.min(5, Math.max(1, parseInt(t.urgency, 10) || 1)),
      timeStart: t.timeStart || null,
      timeEnd: t.timeEnd || null,
    };
  }

  function ensureCalendarDay(dateKey) {
    if (!state.calendar.days[dateKey]) {
      state.calendar.days[dateKey] = { dailyCompleted: [] };
    }
    return state.calendar.days[dateKey];
  }

  function syncDailyCompletedSnapshotForTask(task) {
    if (getSheetKey() !== "daily") return;
    const dk = formatLocalYMD(new Date());
    if (isDailyCalendarDateLocked(dk)) return;
    const day = ensureCalendarDay(dk);
    const i = day.dailyCompleted.findIndex((r) => r.id === task.id);
    if (i === -1) return;
    day.dailyCompleted[i] = dailyTaskToCalendarRow(task);
  }

  function recordDailyDoneForToggle(task, nowDone) {
    if (getSheetKey() !== "daily") return;
    const dk = formatLocalYMD(new Date());
    const day = ensureCalendarDay(dk);
    if (isDailyCalendarDateLocked(dk)) return;
    if (nowDone) {
      const row = dailyTaskToCalendarRow(task);
      const i = day.dailyCompleted.findIndex((r) => r.id === task.id);
      if (i >= 0) day.dailyCompleted[i] = row;
      else day.dailyCompleted.push(row);
    } else {
      day.dailyCompleted = day.dailyCompleted.filter((r) => r.id !== task.id);
    }
  }

  function comprehensiveDeadlinesOnDate(dateKey) {
    return state.comprehensive.items.filter(
      (t) => !t.done && t.deadline && t.deadline === dateKey
    );
  }

  function deadlineNotifyKey(taskId, deadline) {
    return `${taskId}|${deadline}`;
  }

  function tryShowDeadlineNotifications() {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const now = new Date();
    if (now.getHours() < DEADLINE_NOTIFY_START_HOUR) return;

    const today = formatLocalYMD(now);
    const fired = state.calendar.deadlineNotifyFired;
    let any = false;
    for (const t of state.comprehensive.items) {
      if (t.done || !t.deadline || t.deadline !== today) continue;
      const k = deadlineNotifyKey(t.id, t.deadline);
      if (fired[k] === today) continue;
      const title = "综合任务截止";
      const body = (t.text && String(t.text).trim()) || "今日截止";
      try {
        if (Notification.permission === "granted") {
          new Notification(title, { body, tag: k, silent: false });
        }
      } catch {
        /* ignore */
      }
      fired[k] = today;
      any = true;
    }
    if (any) save();
  }

  function requestDeadlineNotifyPermission(btnEl) {
    if (!("Notification" in window)) {
      if (btnEl) btnEl.textContent = "当前环境不支持系统通知";
      return;
    }
    Notification.requestPermission().then((p) => {
      if (btnEl) {
        btnEl.textContent =
          p === "granted" ? "已开启截止日上午提醒" : p === "denied" ? "通知已被拒绝" : "未授权通知";
        btnEl.disabled = p === "granted" || p === "denied";
      }
      tryShowDeadlineNotifications();
    });
  }

  let calendarViewYear = new Date().getFullYear();
  let calendarViewMonth = new Date().getMonth();
  let calendarSelectedYmd = formatLocalYMD(new Date());

  function renderCalendarView() {
    listContainer.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "cal-wrap";

    const notifyRow = document.createElement("div");
    notifyRow.className = "cal-notify-row";
    const notifyBtn = document.createElement("button");
    notifyBtn.type = "button";
    notifyBtn.className = "cal-notify-btn";
    if (!("Notification" in window)) {
      notifyBtn.textContent = "截止日 8:00 提醒（当前浏览器不支持）";
      notifyBtn.disabled = true;
    } else if (Notification.permission === "granted") {
      notifyBtn.textContent = "已开启截止日上午 8:00 提醒";
      notifyBtn.disabled = true;
    } else {
      notifyBtn.textContent = "开启截止日上午 8:00 手机/系统提醒";
      notifyBtn.addEventListener("click", () => requestDeadlineNotifyPermission(notifyBtn));
    }
    notifyRow.appendChild(notifyBtn);

    const nav = document.createElement("div");
    nav.className = "cal-nav";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "cal-nav-btn";
    prev.setAttribute("aria-label", "上一月");
    prev.textContent = "‹";
    const next = document.createElement("button");
    next.type = "button";
    next.className = "cal-nav-btn";
    next.setAttribute("aria-label", "下一月");
    next.textContent = "›";
    const title = document.createElement("h3");
    title.className = "cal-nav-title";
    title.textContent = `${calendarViewYear}年 ${calendarViewMonth + 1}月`;

    prev.addEventListener("click", () => {
      calendarViewMonth--;
      if (calendarViewMonth < 0) {
        calendarViewMonth = 11;
        calendarViewYear--;
      }
      render();
    });
    next.addEventListener("click", () => {
      calendarViewMonth++;
      if (calendarViewMonth > 11) {
        calendarViewMonth = 0;
        calendarViewYear++;
      }
      render();
    });
    nav.append(prev, title, next);

    const legend = document.createElement("div");
    legend.className = "cal-legend";
    legend.innerHTML =
      '<span><i class="cal-dot cal-dot--ddl" aria-hidden="true"></i>综合截止</span>' +
      '<span><i class="cal-dot cal-dot--daily" aria-hidden="true"></i>当日完成任务</span>';

    const weekdays = document.createElement("div");
    weekdays.className = "cal-weekdays";
    const wk = ["日", "一", "二", "三", "四", "五", "六"];
    weekdays.innerHTML = wk.map((d) => `<div>${d}</div>`).join("");

    const grid = document.createElement("div");
    grid.className = "cal-grid";
    const first = new Date(calendarViewYear, calendarViewMonth, 1);
    const pad = first.getDay();
    const lastDate = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
    const prevMonthDays = new Date(calendarViewYear, calendarViewMonth, 0).getDate();

    function addCell(y, m, day, muted) {
      const ymd = formatLocalYMD(new Date(y, m, day));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-cell" + (muted ? " cal-cell--muted" : "");
      const todayStr = formatLocalYMD(new Date());
      if (ymd === todayStr) btn.classList.add("cal-cell--today");
      if (ymd === calendarSelectedYmd) btn.classList.add("cal-cell--selected");

      btn.appendChild(document.createTextNode(String(day)));
      const hasDdl = comprehensiveDeadlinesOnDate(ymd).length > 0;
      const dayRec = state.calendar.days[ymd];
      const hasDaily = !!(dayRec && dayRec.dailyCompleted && dayRec.dailyCompleted.length);

      if (hasDdl || hasDaily) {
        const dots = document.createElement("div");
        dots.className = "cal-cell-dots";
        if (hasDdl) {
          const d = document.createElement("i");
          d.className = "cal-dot cal-dot--ddl";
          d.title = "有综合任务截止";
          dots.appendChild(d);
        }
        if (hasDaily) {
          const d = document.createElement("i");
          d.className = "cal-dot cal-dot--daily";
          d.title = "有当日勾选完成记录";
          dots.appendChild(d);
        }
        btn.appendChild(dots);
      }

      btn.addEventListener("click", () => {
        calendarSelectedYmd = ymd;
        render();
      });
      grid.appendChild(btn);
    }

    for (let i = 0; i < pad; i++) {
      const d = prevMonthDays - pad + i + 1;
      addCell(
        calendarViewMonth === 0 ? calendarViewYear - 1 : calendarViewYear,
        calendarViewMonth === 0 ? 11 : calendarViewMonth - 1,
        d,
        true
      );
    }
    for (let day = 1; day <= lastDate; day++) {
      addCell(calendarViewYear, calendarViewMonth, day, false);
    }
    const cells = pad + lastDate;
    const tail = (7 - (cells % 7)) % 7;
    for (let i = 1; i <= tail; i++) {
      addCell(
        calendarViewMonth === 11 ? calendarViewYear + 1 : calendarViewYear,
        calendarViewMonth === 11 ? 0 : calendarViewMonth + 1,
        i,
        true
      );
    }

    const detail = document.createElement("div");
    detail.className = "cal-detail";
    const dTitle = document.createElement("h4");
    dTitle.className = "cal-detail-title";
    dTitle.textContent = calendarSelectedYmd;

    const ddlSub = document.createElement("p");
    ddlSub.className = "cal-detail-sub";
    ddlSub.textContent = "综合任务截止";
    const ddlList = document.createElement("ul");
    ddlList.className = "cal-detail-list";
    const ddls = comprehensiveDeadlinesOnDate(calendarSelectedYmd);
    if (ddls.length === 0) {
      const p = document.createElement("p");
      p.className = "cal-detail-empty";
      p.textContent = "无";
      detail.append(dTitle, ddlSub, p);
    } else {
      for (const t of ddls) {
        const cat = state.comprehensive.categories.find((c) => c.id === t.categoryId);
        const li = document.createElement("li");
        li.textContent = `${cat ? cat.name : "—"} · ${t.text || "（无标题）"}`;
        ddlList.appendChild(li);
      }
      detail.append(dTitle, ddlSub, ddlList);
    }

    const dailySub = document.createElement("p");
    dailySub.className = "cal-detail-sub";
    dailySub.textContent = "每日任务表 · 该日曾勾选完成";
    const dayEntry = state.calendar.days[calendarSelectedYmd];
    const dailyRows = dayEntry && dayEntry.dailyCompleted ? dayEntry.dailyCompleted : [];
    if (dailyRows.length === 0) {
      const p2 = document.createElement("p");
      p2.className = "cal-detail-empty";
      p2.textContent = "无记录";
      detail.append(dailySub, p2);
    } else {
      const ul2 = document.createElement("ul");
      ul2.className = "cal-detail-list";
      for (const row of dailyRows) {
        const cat = state.daily.categories.find((c) => c.id === row.categoryId);
        const li = document.createElement("li");
        li.textContent = `${cat ? cat.name : "—"} · ${row.text || "（无标题）"}`;
        ul2.appendChild(li);
      }
      detail.append(dailySub, ul2);
    }

    wrap.append(notifyRow, nav, legend, weekdays, grid, detail);
    listContainer.appendChild(wrap);
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
    return sheet.items.slice().sort((a, b) => {
      const da = a.deadline && /^\d{4}-\d{2}-\d{2}$/.test(a.deadline) ? a.deadline : null;
      const db = b.deadline && /^\d{4}-\d{2}-\d{2}$/.test(b.deadline) ? b.deadline : null;
      if (da && db) {
        if (da !== db) return da < db ? -1 : 1;
      } else if (da && !db) {
        return -1;
      } else if (!da && db) {
        return 1;
      }
      return a.order - b.order;
    });
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

  function itemDerivedExpectedMinutes(it) {
    const ivs = itemScheduleIntervalsMinutes(it);
    if (ivs.length) return ivs.reduce((acc, x) => acc + (x.end - x.start), 0);
    if (it.timeStart && it.timeEnd) {
      const ts = timeToMinutes(it.timeStart);
      const te = timeToMinutes(it.timeEnd);
      if (ts != null && te != null && te > ts) return te - ts;
    }
    return null;
  }

  function itemUserExpectedMinutes(it) {
    if (typeof it.expectedDurationMinutes === "number" && !Number.isNaN(it.expectedDurationMinutes)) {
      const n = Math.floor(it.expectedDurationMinutes);
      if (n >= 1) return Math.min(99999, n);
    }
    return null;
  }

  function readExpectedMinutesFromHourMinFields(hRaw, mRaw) {
    let h = hRaw !== undefined && hRaw !== "" ? parseInt(String(hRaw).trim(), 10) : 0;
    let mm = mRaw !== undefined && mRaw !== "" ? parseInt(String(mRaw).trim(), 10) : 0;
    if (Number.isNaN(h)) h = 0;
    if (Number.isNaN(mm)) mm = 0;
    h = Math.min(1666, Math.max(0, h));
    mm = Math.min(59, Math.max(0, mm));
    const total = h * 60 + mm;
    return total >= 1 ? Math.min(99999, total) : null;
  }

  function formatExpectedDurationShort(totalMinutes) {
    if (totalMinutes == null || totalMinutes < 1) return "";
    const n = Math.floor(totalMinutes);
    const h = Math.floor(n / 60);
    const m = n % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}小时`);
    if (m > 0) parts.push(`${m}分`);
    return parts.length ? `预计${parts.join("")}` : "";
  }

  /** 将未完成任务写入 oneClickAllMeta；仅 aiAssign 的进入 sp.draftTasks 请求 AI。有时段则固定时段；仅预计则 AI 排；都有则以时段为准。 */
  function prepareDraftTasksForOneClickAi() {
    const sp = state.daily.smartPlan;
    const prevDraftById = new Map(sp.draftTasks.map((d) => [d.id, d]));
    const items = state.daily.items.slice().sort((a, b) => a.order - b.order);
    const undone = items.filter((t) => !t.done);
    const allMeta = [];
    const aiOnly = [];
    for (let i = 0; i < undone.length; i++) {
      const it = undone[i];
      const schedMin = itemDerivedExpectedMinutes(it);
      const userExp = itemUserExpectedMinutes(it);
      const hasSched = schedMin != null && schedMin >= 1;
      const preserveUserWindow = hasSched;
      let expectedDurationMinutes;
      if (hasSched) {
        expectedDurationMinutes = Math.min(99999, Math.floor(schedMin));
      } else if (userExp != null) {
        expectedDurationMinutes = userExp;
      } else {
        expectedDurationMinutes = DEFAULT_ONE_CLICK_EXPECTED_MINUTES;
      }
      const prev = prevDraftById.get(it.id);
      const tm = prev && prev.timeMode === "fragment" ? "fragment" : "block";
      const titleOk = !!(it.text && String(it.text).trim());
      const row = {
        id: it.id,
        text: it.text,
        urgency: it.urgency,
        categoryId: it.categoryId || UNCATEGORIZED_ID,
        expectedDurationMinutes,
        timeMode: tm,
        confirmed: titleOk,
        planningMode: preserveUserWindow ? "fixedKeepUserTimes" : "aiAssign",
      };
      allMeta.push(row);
      if (!preserveUserWindow) {
        aiOnly.push(row);
      }
    }
    oneClickAllMeta = allMeta;
    sp.draftTasks = aiOnly;
  }

  function mergeAiWithFixedItems(aiBuiltOrdered) {
    const meta = oneClickAllMeta;
    if (!meta || !meta.length) return aiBuiltOrdered;
    const byIdAi = new Map(aiBuiltOrdered.map((x) => [x.id, x]));
    const catOk = (id) => state.daily.categories.some((c) => c.id === id);
    const out = [];
    for (let order = 0; order < meta.length; order++) {
      const row = meta[order];
      if (row.planningMode === "fixedKeepUserTimes") {
        const orig = state.daily.items.find((t) => t.id === row.id);
        if (!orig) continue;
        const cid = row.categoryId && catOk(row.categoryId) ? row.categoryId : UNCATEGORIZED_ID;
        const copy = {
          id: orig.id,
          text: String(orig.text || "").trim() || String(row.text || "").trim() || "未命名",
          done: false,
          categoryId: cid,
          order,
          deadline: null,
          planDays: null,
          urgency: row.urgency,
          timeStart: orig.timeStart,
          timeEnd: orig.timeEnd,
        };
        if (orig.expectedDurationMinutes != null && orig.expectedDurationMinutes >= 1) {
          copy.expectedDurationMinutes = orig.expectedDurationMinutes;
        }
        if (orig.timeSegments && orig.timeSegments.length) {
          copy.timeSegments = orig.timeSegments.map((s) => ({
            timeStart: s.timeStart,
            timeEnd: s.timeEnd,
          }));
        }
        out.push(copy);
      } else {
        const it = byIdAi.get(row.id);
        if (!it) {
          throw new Error("返回数据与待安排任务不匹配，请重试。");
        }
        const orig = state.daily.items.find((t) => t.id === row.id);
        const next = { ...it, order };
        if (orig && orig.expectedDurationMinutes != null && orig.expectedDurationMinutes >= 1) {
          next.expectedDurationMinutes = orig.expectedDurationMinutes;
        }
        out.push(next);
      }
    }
    return out;
  }

  function applySmartSlotsPanelUi() {
    const sp = state.daily.smartPlan;
    const panel = document.getElementById("smart-slots-panel");
    const btn = document.getElementById("smart-slots-toggle");
    if (!panel || !btn) return;
    const open = !!sp.workSlotsExpanded;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "收起可工作时段" : "展开可工作时段";
  }

  function captureSmartArrangeSettingsFromDom() {
    const sp = state.daily.smartPlan;
    const ws = document.getElementById("smart-settings-work-start");
    const we = document.getElementById("smart-settings-work-end");
    const slots = document.getElementById("smart-settings-work-slots");
    if (ws) sp.workStart = ws.value ? parseTimeHHMM(ws.value.trim()) : null;
    if (we) sp.workEnd = we.value ? parseTimeHHMM(we.value.trim()) : null;
    if (slots) sp.workSlots = slots.value;
  }

  function applySmartArrangeSettingsToDom() {
    const sp = state.daily.smartPlan;
    const ws = document.getElementById("smart-settings-work-start");
    const we = document.getElementById("smart-settings-work-end");
    const slots = document.getElementById("smart-settings-work-slots");
    const fp = document.getElementById("smart-settings-flex-picker");
    const ae = document.activeElement;
    if (ws && ae !== ws) ws.value = sp.workStart || "";
    if (we && ae !== we) we.value = sp.workEnd || "";
    if (slots && ae !== slots) slots.value = sp.workSlots || "";
    if (fp) fp.innerHTML = renderStarsHtml(sp.flexibility);
    applySmartSlotsPanelUi();
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
      throw new Error("请先在「智能安排」中填写有效的开始、结束工作时间。");
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
            `「${title}」的时段不在可工作时段内（须落在已填写的某一段可工作时间内）。请重新生成或调整「智能安排」中的工作时间。`
          );
        }
      }
    }
  }

  /** 是否已点「添加」变为只读摘要（兼容旧字段 locked）。 */
  function isDraftConfirmed(t) {
    return !!(t && (t.confirmed === true || t.locked === true));
  }

  function urgencyStarsText(u) {
    const n = Math.min(5, Math.max(1, u || 1));
    return "★".repeat(n) + "☆".repeat(5 - n);
  }

  function draftCategoryLabel(categoryId) {
    const c = state.daily.categories.find((x) => x.id === categoryId);
    return c ? c.name : "—";
  }

  function setActiveSheet(sheet) {
    if (sheet !== "daily" && sheet !== "comprehensive") return;
    state.persistedTaskSheet = sheet;
    if (state.activeSheet === sheet && state.activeSheet !== "calendar") return;
    state.activeSheet = sheet;
    save();
    editingId = null;
    setComposeOpen(false);
    updateSheetUi();
    updateChromeVisibility();
    render();
  }

  function setCalendarSheet() {
    if (state.activeSheet === "calendar") return;
    state.activeSheet = "calendar";
    save();
    editingId = null;
    setComposeOpen(false);
    updateSheetUi();
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
    const cal = state.activeSheet === "calendar";
    const isDaily = state.persistedTaskSheet === "daily";
    sheetDailyBtn.classList.toggle("is-active", !cal && isDaily);
    sheetCompBtn.classList.toggle("is-active", !cal && !isDaily);
    sheetCalBtn.classList.toggle("is-active", cal);
    sheetCalBtn.setAttribute("aria-pressed", cal ? "true" : "false");
    composeDailyExtra.hidden = !isDaily || cal;
    composeExtra.hidden = isDaily || cal;
    if (cal) {
      listTitleEl.textContent = "日历";
    } else if (isDaily) {
      listTitleEl.textContent = LIST_TITLE.dailyManual;
    } else {
      listTitleEl.textContent = LIST_TITLE.comprehensive;
    }
  }

  function updateChromeVisibility() {
    const cal = state.activeSheet === "calendar";
    if (cal) {
      smartArrangeCard.hidden = true;
      composeToolbar.hidden = true;
      tagsCard.hidden = true;
      clearDoneBtn.hidden = true;
      btnOneClickSmart.hidden = true;
      if (smartOneClickError) {
        smartOneClickError.hidden = true;
        smartOneClickError.textContent = "";
      }
      return;
    }
    clearDoneBtn.hidden = false;
    const isDaily = state.activeSheet === "daily";
    smartArrangeCard.hidden = !isDaily;
    composeToolbar.hidden = false;
    tagsCard.hidden = !isDaily;
    btnOneClickSmart.hidden = !isDaily;
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
      const expLabel = formatExpectedDurationShort(item.expectedDurationMinutes);
      if (expLabel) parts.push(expLabel);
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
      const tExp = document.createElement("div");
      tExp.className = "todo-meta-field todo-meta-expected-row";
      const lH = document.createElement("span");
      lH.className = "todo-field-label";
      lH.textContent = "预计";
      const inH = document.createElement("input");
      inH.type = "number";
      inH.min = "0";
      inH.max = "1666";
      inH.step = "1";
      inH.inputMode = "numeric";
      inH.className = "compose-input compose-input--sm todo-meta-exp-h";
      inH.setAttribute("aria-label", "预计小时");
      const lM = document.createElement("span");
      lM.className = "todo-duration-suffix";
      lM.textContent = "时";
      const inM = document.createElement("input");
      inM.type = "number";
      inM.min = "0";
      inM.max = "59";
      inM.step = "1";
      inM.inputMode = "numeric";
      inM.className = "compose-input compose-input--sm todo-meta-exp-m";
      inM.setAttribute("aria-label", "预计分钟");
      const lM2 = document.createElement("span");
      lM2.className = "todo-duration-suffix";
      lM2.textContent = "分";
      const em = item.expectedDurationMinutes;
      if (em != null && em >= 1) {
        inH.value = String(Math.floor(em / 60));
        inM.value = String(em % 60);
      } else {
        inH.value = "";
        inM.value = "";
      }
      tExp.append(lH, inH, lM, inM, lM2);
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
      wrap.append(t1, t2, tExp, d3);
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
    const meta = oneClickAllMeta;
    if (!meta || !meta.length) {
      return { ok: false, message: "请至少保留一条未完成的任务。" };
    }
    for (let i = 0; i < meta.length; i++) {
      const t = meta[i];
      if (!isDraftConfirmed(t)) {
        return { ok: false, message: `第 ${i + 1} 条任务标题为空，请先填写后再试。` };
      }
      if (!t.text || !String(t.text).trim()) {
        return { ok: false, message: `第 ${i + 1} 条任务标题为空，请先填写后再试。` };
      }
      if (t.expectedDurationMinutes == null || t.expectedDurationMinutes < 1) {
        return { ok: false, message: `任务「${String(t.text).trim()}」缺少有效预计耗时。` };
      }
    }
    if (!sp.workStart || !sp.workEnd) {
      return { ok: false, message: "请在「智能安排」中填写开始与结束工作时间。" };
    }
    return { ok: true };
  }

  function sumAllowedWorkMinutesFromPlan(sp) {
    return buildAllowedIntervalsFromWorkPlan(sp).reduce((acc, seg) => acc + (seg.end - seg.start), 0);
  }

  function buildSmartScheduleUserPayload(sp) {
    const slotsNorm = getNormalizedWorkSlotsDescription(sp);
    const metaFull = oneClickAllMeta && oneClickAllMeta.length ? oneClickAllMeta : sp.draftTasks;
    const tasks = sp.draftTasks.filter(isDraftConfirmed);
    const sumExpected = metaFull
      .filter(isDraftConfirmed)
      .reduce((acc, t) => acc + (t.expectedDurationMinutes || 0), 0);
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
    return built;
  }

  function taskEarliestStartMinutes(it) {
    const ivs = itemScheduleIntervalsMinutes(it);
    if (ivs.length) return Math.min(...ivs.map((x) => x.start));
    return Infinity;
  }

  function taskMaxBlockMinutes(it) {
    const ivs = itemScheduleIntervalsMinutes(it);
    if (!ivs.length) return 0;
    return Math.max(...ivs.map((x) => x.end - x.start));
  }

  function taskSegmentCount(it) {
    const ivs = itemScheduleIntervalsMinutes(it);
    return ivs.length;
  }

  // 业务硬规则：紧迫度更高应更早安排；block 任务中更紧迫者优先得到整块时间。
  function assertUrgencyPriorityInAiSchedule(sp, builtItems) {
    const metaSrc = oneClickAllMeta && oneClickAllMeta.length ? oneClickAllMeta : sp.draftTasks;
    const confirmedById = new Map(metaSrc.filter(isDraftConfirmed).map((d) => [d.id, d]));
    const scheduled = builtItems
      .filter((it) => it.timeStart && it.timeEnd && confirmedById.has(it.id))
      .map((it) => ({
        it,
        draft: confirmedById.get(it.id),
        urgency: confirmedById.get(it.id).urgency || 1,
        start: taskEarliestStartMinutes(it),
      }));

    for (let i = 0; i < scheduled.length; i++) {
      for (let j = 0; j < scheduled.length; j++) {
        if (i === j) continue;
        const hi = scheduled[i];
        const lo = scheduled[j];
        if (hi.urgency <= lo.urgency) continue;
        if (hi.start > lo.start) {
          throw new Error("AI 结果未满足紧迫度优先：更紧迫的任务被安排得更晚，请重试。");
        }
      }
    }

    const blockTasks = scheduled.filter((x) => (x.draft.timeMode === "fragment" ? "fragment" : "block") === "block");
    for (let i = 0; i < blockTasks.length; i++) {
      for (let j = 0; j < blockTasks.length; j++) {
        if (i === j) continue;
        const hi = blockTasks[i];
        const lo = blockTasks[j];
        if (hi.urgency <= lo.urgency) continue;
        const hiSeg = taskSegmentCount(hi.it);
        const loSeg = taskSegmentCount(lo.it);
        const hiMax = taskMaxBlockMinutes(hi.it);
        const loMax = taskMaxBlockMinutes(lo.it);
        if (hiSeg > loSeg && hiMax < loMax) {
          throw new Error("AI 结果未满足整块优先：更紧迫的 block 任务未优先获得整块时间，请重试。");
        }
      }
    }
  }

  function commitAiScheduleItems(newItems, opts = {}) {
    const mergeDone = !!opts.mergeDone;
    const prevAll = state.daily.items;
    const sorted = newItems.slice().sort((a, b) => {
      const ka = dailyTimeSortKey(a);
      const kb = dailyTimeSortKey(b);
      if (ka !== kb) return ka - kb;
      return a.order - b.order;
    });
    sorted.forEach((t, i) => {
      t.order = i;
    });
    let merged = sorted;
    if (mergeDone) {
      const scheduledIds = new Set(sorted.map((t) => t.id));
      const doneKept = prevAll.filter((t) => t.done && !scheduledIds.has(t.id));
      const base = sorted.length;
      merged = sorted.concat(doneKept.map((t, i) => ({ ...t, order: base + i })));
    }
    state.daily.items = merged;
    state.daily.dailyArrangement = "manual";
    const sp = state.daily.smartPlan;
    sp.step = 1;
    const draftSource =
      oneClickAllMeta && oneClickAllMeta.length ? oneClickAllMeta : sp.draftTasks;
    const draftById = new Map(draftSource.map((d) => [d.id, d]));
    oneClickAllMeta = null;
    sp.draftTasks = merged.map((it) => {
      const prev = draftById.get(it.id);
      // IMPORTANT: 合并结果上已带的预计耗时（用户填写）优先；其次 oneClick 元数据；最后才用时段推算。
      let expectedDurationMinutes =
        it.expectedDurationMinutes != null && it.expectedDurationMinutes >= 1
          ? Math.min(99999, Math.floor(it.expectedDurationMinutes))
          : null;
      if (
        (expectedDurationMinutes == null || expectedDurationMinutes < 1) &&
        prev &&
        prev.expectedDurationMinutes != null &&
        prev.expectedDurationMinutes >= 1
      ) {
        expectedDurationMinutes = prev.expectedDurationMinutes;
      }
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

  async function runSmartAiSchedule(opts = {}) {
    if (smartAiLoading) return;
    const mergeDone = !!opts.mergeDone;
    const sp = state.daily.smartPlan;
    const errEl = opts.errorEl != null ? opts.errorEl : smartOneClickError;
    const btn = opts.triggerBtn != null ? opts.triggerBtn : btnOneClickSmart;
    const errPrefix = opts.errorPrefix != null ? opts.errorPrefix : "安排失败：";
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
    const prevLabel = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "正在生成…";
    }
    try {
      const commitOpts = { mergeDone };
      const assertMergedOk = (merged) => {
        assertScheduleWithinWorkPlan(
          sp,
          merged.filter((x) => x.timeStart && x.timeEnd)
        );
        assertUrgencyPriorityInAiSchedule(sp, merged);
      };

      if (sp.draftTasks.length === 0) {
        const merged = mergeAiWithFixedItems([]);
        assertMergedOk(merged);
        commitAiScheduleItems(merged, commitOpts);
        editingId = null;
        render();
        return;
      }

      const payload = buildSmartScheduleUserPayload(sp);
      const parsed = await requestSmartSchedule(payload);
      const aiBuilt = buildItemsFromAiParsed(sp, parsed);
      const mergedTry = mergeAiWithFixedItems(aiBuilt);

      if (findConflictsInItems(mergedTry).length > 0) {
        showTimeConflictDialog(
          "生成的时间段存在重叠。选择「覆盖另一任务时段」将保留较早的时段，并清空与之后任务冲突的时段；也可选择重新填写时间以取消本次结果。",
          () => {
            try {
              const resolvedAi = resolveOverlapsByClearingLater(aiBuilt);
              const merged = mergeAiWithFixedItems(resolvedAi);
              assertMergedOk(merged);
              commitAiScheduleItems(merged, commitOpts);
              editingId = null;
              render();
            } catch (e2) {
              const m2 = e2 && e2.message ? e2.message : String(e2);
              if (errEl) {
                errEl.textContent = errPrefix + m2;
                errEl.hidden = false;
              }
            }
          },
          () => {}
        );
      } else {
        assertMergedOk(mergedTry);
        commitAiScheduleItems(mergedTry, commitOpts);
        editingId = null;
        render();
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (errEl) {
        errEl.textContent = errPrefix + msg;
        errEl.hidden = false;
      }
    } finally {
      smartAiLoading = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevLabel || "一键智能安排";
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
      if (
        Object.prototype.hasOwnProperty.call(patch, "expectedDurationMinutes") &&
        patch.expectedDurationMinutes == null
      ) {
        next = { ...next };
        delete next.expectedDurationMinutes;
      }
      return next;
    });
    const updated = sheet.items.find((x) => x.id === id);
    if (updated && getSheetKey() === "daily") syncDailyCompletedSnapshotForTask(updated);
    save();
  }

  function render() {
    if (!composePanel.hidden) {
      initComposeUrgencyPicker();
      updateComposeUrgencyDisplay();
    }

    updateSheetUi();
    updateChromeVisibility();

    if (state.activeSheet === "calendar") {
      countBadge.textContent = "·";
      renderCalendarView();
      unbindListDrag();
      return;
    }

    renderCategorySelect();
    renderTagList();

    if (state.activeSheet === "daily") {
      applySmartArrangeSettingsToDom();
    }

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
    const prev = sh.items.find((t) => t.id === id);
    if (!prev) return;
    const nextDone = !prev.done;
    sh.items = sh.items.map((t) => (t.id === id ? { ...t, done: nextDone } : t));
    if (getSheetKey() === "daily") {
      recordDailyDoneForToggle({ ...prev, done: nextDone }, nextDone);
    }
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
  sheetCalBtn.addEventListener("click", () => setCalendarSheet());

  if (smartArrangeCard) {
    smartArrangeCard.addEventListener("change", () => {
      if (state.activeSheet !== "daily") return;
      captureSmartArrangeSettingsFromDom();
      save();
    });
    smartArrangeCard.addEventListener("click", (e) => {
      const flexStar = e.target.closest("#smart-settings-flex-picker .star-btn");
      if (!flexStar) return;
      e.preventDefault();
      const si = +flexStar.dataset.si;
      state.daily.smartPlan.flexibility = si;
      const fp = document.getElementById("smart-settings-flex-picker");
      if (fp) fp.innerHTML = renderStarsHtml(si);
      save();
    });
  }

  const smartSlotsToggle = document.getElementById("smart-slots-toggle");
  if (smartSlotsToggle) {
    smartSlotsToggle.addEventListener("click", (e) => {
      e.preventDefault();
      if (state.activeSheet !== "daily") return;
      state.daily.smartPlan.workSlotsExpanded = !state.daily.smartPlan.workSlotsExpanded;
      applySmartSlotsPanelUi();
      save();
    });
  }

  if (btnOneClickSmart) {
    btnOneClickSmart.addEventListener("click", () => {
      if (state.activeSheet !== "daily" || smartAiLoading) return;
      if (smartOneClickError) {
        smartOneClickError.hidden = true;
        smartOneClickError.textContent = "";
      }
      captureSmartArrangeSettingsFromDom();
      prepareDraftTasksForOneClickAi();
      void runSmartAiSchedule({
        mergeDone: true,
        errorEl: smartOneClickError,
        triggerBtn: btnOneClickSmart,
      });
    });
  }

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
    const otherSheet = state.persistedTaskSheet === "daily" ? state.comprehensive : state.daily;
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
    const otherSheet = state.persistedTaskSheet === "daily" ? state.comprehensive : state.daily;
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
      const expMin = readExpectedMinutesFromHourMinFields(
        dailyExpectedHoursInput && dailyExpectedHoursInput.value,
        dailyExpectedMinutesInput && dailyExpectedMinutesInput.value
      );
      const newItem = {
        ...base,
        deadline: null,
        planDays: null,
        timeStart: ts ? parseTimeHHMM(ts) || ts : null,
        timeEnd: te ? parseTimeHHMM(te) || te : null,
        urgency: composeUrgency,
      };
      if (expMin != null) {
        newItem.expectedDurationMinutes = expMin;
      }
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
            if (dailyExpectedHoursInput) dailyExpectedHoursInput.value = "";
            if (dailyExpectedMinutesInput) dailyExpectedMinutesInput.value = "";
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
      if (dailyExpectedHoursInput) dailyExpectedHoursInput.value = "";
      if (dailyExpectedMinutesInput) dailyExpectedMinutesInput.value = "";
    }

    composeUrgency = 1;
    updateComposeUrgencyDisplay();
    input.value = "";
    save();
    setComposeOpen(false);
    render();
  });

  listContainer.addEventListener("click", (e) => {
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
    "change",
    (e) => {
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
      if (t.classList.contains("todo-meta-exp-h") || t.classList.contains("todo-meta-exp-m")) {
        const rowEl = t.closest(".todo-item");
        const hIn = rowEl && rowEl.querySelector(".todo-meta-exp-h");
        const mIn = rowEl && rowEl.querySelector(".todo-meta-exp-m");
        const exp = readExpectedMinutesFromHourMinFields(
          hIn ? hIn.value : "",
          mIn ? mIn.value : ""
        );
        patchCurrentSheetItem(id, { expectedDurationMinutes: exp });
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

  tryShowDeadlineNotifications();
  setInterval(tryShowDeadlineNotifications, 45 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tryShowDeadlineNotifications();
  });

  render();
})();
