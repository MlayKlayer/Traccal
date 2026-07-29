"use strict";

const STORAGE_KEY = "traccal-data-v1";
const defaultState = {
  version: 1,
  settings: { mode: "simple", theme: "auto", sound: false, vibration: false, retention: "30", unit: "g", goal: null, feedbackUrl: "" },
  recents: [],
  logs: {},
  favorites: []
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const todayKey = () => {
  const date = new Date();
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const safeNumber = value => {
  const normalized = String(value).trim().replace(",", ".");
  if (!normalized || !/^\d*\.?\d+$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const energyFactor = unit => unit === "g" || unit === "ml" ? 100 : 1;
const roundKcal = (energy, amount, unit = "g") => Math.round((energy * amount) / energyFactor(unit));
const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!parsed || parsed.version !== 1) return structuredClone(defaultState);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      settings: { ...defaultState.settings, ...parsed.settings },
      recents: Array.isArray(parsed.recents) ? parsed.recents : [],
      logs: parsed.logs && typeof parsed.logs === "object" ? parsed.logs : {},
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : []
    };
  } catch {
    return structuredClone(defaultState);
  }
}

let state = loadState();
let currentResult = null;
let estimatedGoal = null;
let estimatedMaintenance = null;
let toastTimer;
let recentTimer;

function persist() {
  applyRetention();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateStorageSummary();
}

function applyRetention() {
  if (state.settings.retention === "forever") return;
  const days = Number(state.settings.retention);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days + 1);
  for (const date of Object.keys(state.logs)) {
    if (new Date(`${date}T00:00:00`) < cutoff) delete state.logs[date];
  }
}

function formatDate(dateString, style = "long") {
  const date = new Date(`${dateString}T12:00:00`);
  if (dateString === todayKey()) return "Today";
  return new Intl.DateTimeFormat("en", style === "long" ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" }).format(date);
}

function currentInput() {
  const per100 = safeNumber($("#calories-input").value);
  const amount = safeNumber($("#grams-input").value);
  if (per100 === null || amount === null || per100 <= 0 || amount <= 0) return null;
  const macros = {};
  ["protein", "carbs", "fat", "fiber", "sugar", "salt"].forEach(key => {
    const value = safeNumber($(`#${key}-input`).value);
    if (value !== null) macros[key] = Math.round((value * amount / energyFactor(state.settings.unit)) * 10) / 10;
  });
  return {
    id: uid(),
    name: $("#food-name").value.trim(),
    per100,
    amount,
    kcal: roundKcal(per100, amount, state.settings.unit),
    unit: state.settings.unit,
    macros,
    timestamp: Date.now()
  };
}

function calculate() {
  currentResult = currentInput();
  const result = $("#result-number");
  result.classList.add("bump");
  window.setTimeout(() => {
    result.textContent = currentResult ? currentResult.kcal.toLocaleString("en") : "—";
    result.classList.remove("bump");
  }, 85);
  const progress = currentResult ? Math.min(currentResult.kcal / (state.settings.goal || 800), 1) * 300 : 0;
  $("#result-ring").parentElement.style.background = `conic-gradient(var(--orange) ${progress}deg, var(--green) 0deg, rgba(255,255,255,.45) 0)`;
  clearTimeout(recentTimer);
  if (currentResult) recentTimer = setTimeout(recordRecent, 850);
}

function recordRecent() {
  const item = currentInput();
  if (!item) return;
  const duplicate = state.recents[0] && state.recents[0].per100 === item.per100 && state.recents[0].amount === item.amount;
  if (!duplicate) {
    state.recents.unshift(item);
    state.recents = state.recents.slice(0, 10);
    persist();
    renderRecents();
  }
}

function renderRecents() {
  const list = $("#recent-list");
  list.innerHTML = "";
  $("#recent-empty").classList.toggle("hidden", state.recents.length > 0);
  $("#clear-recents").classList.toggle("hidden", state.recents.length === 0);
  state.recents.forEach(item => {
    const button = document.createElement("button");
    button.className = "recent-item";
    button.type = "button";
    button.dataset.id = item.id;
    button.innerHTML = `<div><strong>${escapeHTML(item.name || `${item.per100} kcal / ${denominator(item.unit || "g")}`)}</strong><small>${item.amount} ${item.unit || "g"}</small></div><div class="item-end"><strong>${item.kcal} kcal</strong><span aria-hidden="true">›</span></div>`;
    list.append(button);
  });
}

function denominator(unit) {
  return unit === "g" ? "100 g" : unit === "ml" ? "100 ml" : unit === "oz" ? "oz" : "serving";
}

function renderFavorites() {
  const list = $("#favorites-list");
  list.innerHTML = "";
  $("#favorites-empty").classList.toggle("hidden", state.favorites.length > 0);
  state.favorites.forEach(item => {
    const row = document.createElement("div");
    row.className = "favorite-item";
    row.innerHTML = `<button class="favorite-load" type="button" data-favorite="${item.id}"><strong>${escapeHTML(item.name)}</strong><small>${item.per100} kcal / ${denominator(item.unit || "g")}</small></button><button class="item-remove" type="button" data-remove-favorite="${item.id}" aria-label="Delete ${escapeHTML(item.name)}">×</button>`;
    list.append(row);
  });
}

function renderToday() {
  const entries = state.logs[todayKey()] || [];
  const total = entries.reduce((sum, item) => sum + item.kcal, 0);
  $("#today-total").textContent = total.toLocaleString("en");
  $("#today-date").textContent = new Intl.DateTimeFormat("en", { weekday: "long", month: "short", day: "numeric" }).format(new Date());
  const goal = state.settings.goal;
  $("#remaining-label").textContent = goal ? (total <= goal ? `${(goal - total).toLocaleString("en")} kcal remaining` : `${(total - goal).toLocaleString("en")} kcal over goal`) : "Set a daily goal";
  $("#set-goal-open").textContent = goal ? `${goal.toLocaleString("en")} kcal goal` : "Set goal";
  $("#goal-ring").style.setProperty("--progress", `${goal ? Math.min(total / goal, 1) * 360 : 0}deg`);
  const list = $("#today-list");
  list.innerHTML = "";
  $("#today-empty").classList.toggle("hidden", entries.length > 0);
  entries.forEach(item => {
    const row = document.createElement("div");
    row.className = "today-item";
    row.innerHTML = `<div><strong>${escapeHTML(item.name || "Quick calculation")}</strong><small>${item.amount} ${item.unit || "g"} · ${item.per100} kcal / ${denominator(item.unit || "g")}</small></div><div class="item-end"><strong>${item.kcal} kcal</strong><button class="item-remove" data-remove-log="${item.id}" aria-label="Remove ${escapeHTML(item.name || "entry")}">×</button></div>`;
    list.append(row);
  });
}

function renderHistory() {
  const content = $("#history-content");
  const dates = Object.keys(state.logs).filter(date => state.logs[date].length).sort().reverse();
  if (!dates.length) {
    content.innerHTML = `<p class="empty-state">No logged days yet. Add something from the calculator and your history will appear here.</p>`;
    return;
  }
  content.innerHTML = dates.map(date => {
    const entries = state.logs[date];
    const total = entries.reduce((sum, item) => sum + item.kcal, 0);
    return `<section class="history-day"><h3>${formatDate(date)}<span>${total.toLocaleString("en")} kcal</span></h3>${entries.map(item => `<p><span>${escapeHTML(item.name || "Quick calculation")} · ${item.amount} ${item.unit || "g"}</span><span>${item.kcal}</span></p>`).join("")}</section>`;
  }).join("");
}

function updateMode() {
  const mode = state.settings.mode;
  $("#mode-label").textContent = `${mode[0].toUpperCase()}${mode.slice(1)} mode`;
  const tracking = mode !== "simple";
  const advanced = mode === "advanced";
  $("#name-field-wrap").classList.toggle("hidden", !tracking);
  $("#tracker-actions").classList.toggle("hidden", !tracking);
  $("#today-card").classList.toggle("hidden", !tracking);
  $("#favorites-card").classList.toggle("hidden", !tracking);
  $("#advanced-fields").classList.toggle("hidden", !advanced);
  $$(".advanced-only").forEach(el => el.classList.toggle("hidden", !advanced));
  $$("[data-mode]").forEach(button => button.setAttribute("aria-checked", String(button.dataset.mode === mode)));
  renderToday();
}

function resolveTheme() {
  const theme = state.settings.theme;
  const resolved = theme === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  document.documentElement.dataset.resolvedTheme = resolved;
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = resolved === "dark" ? "#171914" : "#f7f0e4";
  $$(".segmented [data-theme]").forEach(button => button.classList.toggle("active", button.dataset.theme === theme));
}

function applySettings() {
  updateMode();
  resolveTheme();
  $("#sound-toggle").checked = state.settings.sound;
  $("#vibration-toggle").checked = state.settings.vibration;
  $("#retention-select").value = state.settings.retention;
  $("#unit-select").value = state.settings.unit;
  $("#goal-setting-summary").textContent = state.settings.goal ? `${state.settings.goal.toLocaleString("en")} kcal` : "Not set";
  const feedback = $("#feedback-link");
  feedback.classList.toggle("hidden", !state.settings.feedbackUrl);
  if (state.settings.feedbackUrl) feedback.href = state.settings.feedbackUrl;
  updateUnits();
}

function updateUnits() {
  const unit = state.settings.unit;
  const labels = { g: "grams", ml: "milliliters", oz: "ounces", serving: "servings" };
  $("#grams-unit").textContent = labels[unit];
  $("#calories-unit").textContent = `kcal / ${denominator(unit)}`;
  $("#macro-note").textContent = `Values per ${denominator(unit)}.`;
}

function addToday() {
  const item = currentInput();
  if (!item) return showToast("Enter energy and amount first");
  const date = todayKey();
  state.logs[date] ||= [];
  state.logs[date].push(item);
  persist();
  feedback();
  renderToday();
  showToast("Added to today");
}

function saveFavorite() {
  const item = currentInput();
  if (!item) return showToast("Enter energy and amount first");
  if (!item.name) return showToast("Add a food name before saving");
  const existing = state.favorites.findIndex(food => food.name.toLowerCase() === item.name.toLowerCase());
  if (existing >= 0) state.favorites[existing] = item;
  else state.favorites.unshift(item);
  persist();
  feedback();
  renderFavorites();
  showToast(existing >= 0 ? "Saved food updated" : "Food saved");
}

function feedback() {
  if (state.settings.vibration && navigator.vibrate) navigator.vibrate(12);
  if (state.settings.sound) {
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 540;
      gain.gain.setValueAtTime(.025, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .09);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + .09);
    } catch {}
  }
}

function clearCalculator() {
  $$("input", $(".calculator-card")).forEach(input => { input.value = ""; });
  currentResult = null;
  calculate();
  $("#calories-input").focus();
}

function openDrawer(drawer) {
  $$(".drawer.open").forEach(el => { el.classList.remove("open"); el.setAttribute("aria-hidden", "true"); });
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("open");
  document.body.style.overflow = "hidden";
  setTimeout(() => $(".icon-button", drawer)?.focus(), 100);
}

function closeDrawers() {
  $$(".drawer.open").forEach(el => { el.classList.remove("open"); el.setAttribute("aria-hidden", "true"); });
  $("#scrim").classList.remove("open");
  document.body.style.overflow = "";
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function openGoal() {
  $("#goal-input").value = state.settings.goal || "";
  $("#goal-dialog").showModal();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `traccal-backup-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Backup exported");
}

async function importData(file) {
  try {
    const incoming = JSON.parse(await file.text());
    if (!incoming || incoming.version !== 1 || !incoming.settings || !Array.isArray(incoming.recents) || !incoming.logs) throw new Error();
    if (!confirm("Replace your current Traccal data with this backup?")) return;
    state = { ...structuredClone(defaultState), ...incoming, settings: { ...defaultState.settings, ...incoming.settings } };
    persist();
    applySettings();
    renderRecents();
    renderToday();
    renderFavorites();
    showToast("Backup restored");
  } catch {
    showToast("That file is not a valid Traccal backup");
  }
}

function updateStorageSummary() {
  const bytes = new Blob([localStorage.getItem(STORAGE_KEY) || ""]).size;
  const text = bytes < 1024 ? `${bytes} bytes stored locally` : `${(bytes / 1024).toFixed(1)} KB stored locally`;
  $("#storage-summary").textContent = text;
}

async function cleanup(type) {
  const copy = { cache: "temporary offline cache", recents: "recent calculations", logs: "daily logs", favorites: "saved foods", all: "all Traccal data" };
  if (!confirm(`Clear ${copy[type]}?${type === "all" ? " This cannot be undone." : ""}`)) return;
  if (type === "cache") {
    if ("caches" in window) await Promise.all((await caches.keys()).map(key => caches.delete(key)));
  } else if (type === "recents") state.recents = [];
  else if (type === "logs") state.logs = {};
  else if (type === "favorites") state.favorites = [];
  else if (type === "all") state = structuredClone(defaultState);
  persist();
  applySettings();
  renderRecents();
  renderToday();
  renderFavorites();
  $("#storage-dialog").close();
  showToast(type === "cache" ? "Cache cleared" : "Data cleared");
}

function calculateEstimate() {
  const form = $("#estimate-form");
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const age = Number(data.get("age"));
  const height = Number(data.get("height"));
  const weight = Number(data.get("weight"));
  const sexOffset = data.get("sex") === "male" ? 5 : -161;
  const bmr = 10 * weight + 6.25 * height - 5 * age + sexOffset;
  estimatedMaintenance = Math.round((bmr * Number(data.get("activity"))) / 10) * 10;
  const adjustment = Number(data.get("direction"));
  estimatedGoal = estimatedMaintenance + adjustment;
  const adjustmentText = adjustment === 0 ? "No goal adjustment" : `${adjustment > 0 ? "+" : "−"}${Math.abs(adjustment)} kcal goal adjustment`;
  $("#estimate-result").innerHTML = `<strong>${estimatedGoal.toLocaleString("en")} kcal</strong><br><small>${estimatedMaintenance.toLocaleString("en")} kcal maintenance · ${adjustmentText}</small>`;
  $("#estimate-result").classList.remove("hidden");
  $("#use-estimate").classList.remove("hidden");
  $("#calculate-estimate").textContent = "Recalculate";
}

function bindEvents() {
  ["calories-input", "grams-input", "food-name", "protein-input", "carbs-input", "fat-input", "fiber-input", "sugar-input", "salt-input"].forEach(id => $(`#${id}`).addEventListener("input", calculate));
  $("#clear-calculator").addEventListener("click", clearCalculator);
  $("#add-today").addEventListener("click", addToday);
  $("#save-favorite").addEventListener("click", saveFavorite);
  $("#settings-open").addEventListener("click", () => openDrawer($("#settings-drawer")));
  $("#history-open").addEventListener("click", () => { renderHistory(); openDrawer($("#history-drawer")); });
  $("#scrim").addEventListener("click", closeDrawers);
  $$("[data-close-drawer]").forEach(button => button.addEventListener("click", closeDrawers));
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeDrawers(); });
  $("#set-goal-open").addEventListener("click", openGoal);
  $("#goal-settings-open").addEventListener("click", openGoal);
  $("#estimate-open").addEventListener("click", () => $("#estimate-dialog").showModal());
  $("#storage-open").addEventListener("click", () => $("#storage-dialog").showModal());
  $("#calculate-estimate").addEventListener("click", calculateEstimate);
  $("#use-estimate").addEventListener("click", () => {
    if (estimatedGoal) {
      state.settings.goal = estimatedGoal;
      persist();
      applySettings();
      renderToday();
      showToast("Estimated goal saved");
    }
  });
  $("#goal-dialog").addEventListener("close", () => {
    if ($("#goal-dialog").returnValue === "save") {
      const value = Number($("#goal-input").value);
      if (value >= 500 && value <= 10000) {
        state.settings.goal = Math.round(value);
        persist();
        applySettings();
        renderToday();
        showToast("Daily goal saved");
      }
    }
  });
  $$("[data-mode]").forEach(button => button.addEventListener("click", () => {
    state.settings.mode = button.dataset.mode;
    persist();
    applySettings();
    showToast(`${button.textContent.trim().split(/\s/)[0]} mode on`);
  }));
  $$("[data-theme]").forEach(button => button.addEventListener("click", () => {
    state.settings.theme = button.dataset.theme;
    persist();
    resolveTheme();
  }));
  $("#theme-toggle").addEventListener("click", () => {
    const sequence = ["auto", "light", "dark"];
    state.settings.theme = sequence[(sequence.indexOf(state.settings.theme) + 1) % sequence.length];
    persist();
    resolveTheme();
    showToast(`${state.settings.theme[0].toUpperCase()}${state.settings.theme.slice(1)} theme`);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", resolveTheme);
  $("#sound-toggle").addEventListener("change", event => { state.settings.sound = event.target.checked; persist(); feedback(); });
  $("#vibration-toggle").addEventListener("change", event => { state.settings.vibration = event.target.checked; persist(); feedback(); });
  $("#retention-select").addEventListener("change", event => { state.settings.retention = event.target.value; persist(); showToast("History preference saved"); });
  $("#unit-select").addEventListener("change", event => { state.settings.unit = event.target.value; persist(); updateUnits(); calculate(); });
  $("#clear-recents").addEventListener("click", () => cleanup("recents"));
  $("#recent-list").addEventListener("click", event => {
    const item = state.recents.find(entry => entry.id === event.target.closest("[data-id]")?.dataset.id);
    if (!item) return;
    $("#calories-input").value = item.per100;
    $("#grams-input").value = item.amount;
    $("#food-name").value = item.name || "";
    calculate();
    window.scrollTo({ top: $(".calculator-card").offsetTop - 20, behavior: "smooth" });
  });
  $("#today-list").addEventListener("click", event => {
    const id = event.target.closest("[data-remove-log]")?.dataset.removeLog;
    if (!id) return;
    state.logs[todayKey()] = (state.logs[todayKey()] || []).filter(item => item.id !== id);
    persist();
    renderToday();
    showToast("Entry removed");
  });
  $("#favorites-list").addEventListener("click", event => {
    const removeId = event.target.closest("[data-remove-favorite]")?.dataset.removeFavorite;
    if (removeId) {
      state.favorites = state.favorites.filter(item => item.id !== removeId);
      persist();
      renderFavorites();
      showToast("Saved food removed");
      return;
    }
    const id = event.target.closest("[data-favorite]")?.dataset.favorite;
    const item = state.favorites.find(food => food.id === id);
    if (!item) return;
    state.settings.unit = item.unit || "g";
    $("#unit-select").value = state.settings.unit;
    $("#food-name").value = item.name;
    $("#calories-input").value = item.per100;
    $("#grams-input").value = item.amount;
    persist();
    updateUnits();
    calculate();
    window.scrollTo({ top: $(".calculator-card").offsetTop - 20, behavior: "smooth" });
  });
  $("#export-data").addEventListener("click", exportData);
  $("#import-data").addEventListener("change", event => { if (event.target.files[0]) importData(event.target.files[0]); event.target.value = ""; });
  $$("[data-clean]").forEach(button => button.addEventListener("click", () => cleanup(button.dataset.clean)));
}

function init() {
  applyRetention();
  persist();
  applySettings();
  renderRecents();
  renderToday();
  renderFavorites();
  bindEvents();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

init();
