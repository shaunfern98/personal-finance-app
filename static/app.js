/* global Chart */

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const pctFmt = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

function ymFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function parseYM(s) {
  const [y, m] = s.split("-").map(Number);
  return { y, m };
}

function shiftMonth(ym, delta) {
  const { y, m } = parseYM(ym);
  const d = new Date(y, m - 1 + delta, 1);
  return ymFromDate(d);
}

let currentMonth = ymFromDate(new Date());
let dashboard = { daily: true, category: true, list: true };
let categoryList = [];
let chartDaily;
let chartCategory;
let lastCategoryAgg = [];
let lastCategoryStack = null;
let incomeStreams = [];
let incomeSettings = {
  rpp_deduction: 0,
  rrsp_contribution: 0,
  fhsa_contribution: 0,
  take_home_override: "",
};
let categoryMetadata = {};
let customCategorySet = new Set();
let cashbackMap = {};
let show503020Rule = false;
let allTransactions = [];
let lastBudgetStatus = { overBudget: new Set() };
let calendarMonth = ymFromDate(new Date());
let creditCards = [];
let dashboardMonth = ymFromDate(new Date());
let chartSpendingTrend;
let chartCategoryDonut;
let chartCashbackTrend;
let chartSpendVsCashback;
let budgetValuesCache = {};
let debts = [];
let goals = [];
let recurringExpenses = [];
let txSortDirection = "asc";
let lastTransactionDate = null;

const el = (id) => document.getElementById(id);

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

function loadTheme() {
  const savedTheme = localStorage.getItem('theme') || 'default';
  setTheme(savedTheme);
  const themeSelector = el('theme-selector');
  if (themeSelector) {
    themeSelector.value = savedTheme;
  }
}

function destroyCategoryChart() {
  if (chartCategory) {
    chartCategory.destroy();
    chartCategory = null;
  }
}

function showFlash(msg) {
  const f = el("flash");
  f.textContent = msg;
  f.classList.add("show");
  setTimeout(() => f.classList.remove("show"), 4500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || "Invalid JSON" };
  }
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const err = (data && data.error) || res.statusText || "Request failed";
    throw new Error(err);
  }
  return data;
}

function setMonthInput() {
  el("month-input").value = currentMonth;
  const today = new Date().toISOString().slice(0, 10);
  el("date").value = today;
}

function applyDashboardVisibility() {
  el("panel-daily").hidden = !dashboard.daily;
  el("panel-category").hidden = !dashboard.category;
  el("panel-list").hidden = !dashboard.list;
  document.querySelectorAll("#dash-toggles [data-widget]").forEach((cb) => {
    const key = cb.getAttribute("data-widget");
    cb.checked = !!dashboard[key];
  });
}

async function saveDashboardPartial(partial) {
  try {
    dashboard = await api("/api/settings/dashboard", {
      method: "PUT",
      body: JSON.stringify(partial),
    });
    applyDashboardVisibility();
    refreshChartsSize();
  } catch (e) {
    showFlash(String(e.message));
  }
}

function refreshChartsSize() {
  if (chartDaily) chartDaily.resize();
  if (chartCategory) chartCategory.resize();
}

function fillCategorySelect(selectEl, selected) {
  selectEl.innerHTML = "";
  const sortedCategories = [...categoryList].sort((a, b) => a.localeCompare(b));
  for (const c of sortedCategories) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    selectEl.appendChild(o);
  }
  if (selected && categoryList.includes(selected)) {
    selectEl.value = selected;
  } else if (sortedCategories.length) {
    const prefer = "Groceries";
    selectEl.value = sortedCategories.includes(prefer) ? prefer : sortedCategories[0];
  }
}

function ensureLegacyOption(selectEl, value) {
  if (!value || categoryList.includes(value)) return;
  const o = document.createElement("option");
  o.value = value;
  o.textContent = `${value} (legacy — pick a new category to save)`;
  selectEl.insertBefore(o, selectEl.firstChild);
  selectEl.value = value;
}

function calcCashbackTotal(items) {
  return items.reduce((sum, t) => {
    if (t.payment_method === "credit" && t.credit_card && cashbackMap[t.credit_card]) {
      const rates = cashbackMap[t.credit_card];
      const rate = rates[t.category] ?? rates["__default__"] ?? 0;
      return sum + t.amount * rate / 100;
    }
    return sum;
  }, 0);
}

function renderSummary(items, budgetTotals) {
  let total = 0;
  let fixed = 0;
  let variable = 0;
  for (const t of items) {
    total += t.amount;
    if (t.cost_type === "fixed") fixed += t.amount;
    else variable += t.amount;
  }
  const cashback = calcCashbackTotal(items);
  const bRem = budgetTotals && typeof budgetTotals.remaining === "number";
  const remClass =
    bRem && budgetTotals.remaining < 0 ? " pill--alert" : bRem ? " pill--cool" : "";
  const budgetPill = bRem
    ? `<div class="pill${remClass}"><span class="muted">Budget left (all categories)</span><strong>${money.format(
        budgetTotals.remaining
      )}</strong></div>`
    : "";
  const cashbackPill = cashback > 0
    ? `<div class="pill"><span class="muted">💳 Cashback</span><strong style="color:var(--success);">${money.format(cashback)}</strong></div>`
    : "";
  el("summary").innerHTML = `
    <div class="pill"><span class="muted">Month spend</span><strong>${money.format(total)}</strong></div>
    <div class="pill"><span class="muted">Fixed</span><strong>${money.format(fixed)}</strong></div>
    <div class="pill"><span class="muted">Variable</span><strong>${money.format(variable)}</strong></div>
    <div class="pill"><span class="muted">Transactions</span><strong>${items.length}</strong></div>
    ${cashbackPill}
    ${budgetPill}
  `;
}

function renderBudgetTotalBar(totals) {
  const bar = el("budget-total-bar");
  if (!totals || typeof totals.remaining !== "number") {
    bar.innerHTML = "";
    return;
  }
  const bad = totals.remaining < 0;
  bar.className = "budget-total-bar" + (bad ? " bad" : "");
  bar.innerHTML = `
    <div class="label">Total budget left (sum across categories)</div>
    <div class="value">${money.format(totals.remaining)}</div>
    <p class="muted" style="margin:0.5rem 0 0">Budgeted ${money.format(
      totals.budget
    )} · Spent (in these categories) ${money.format(totals.spent)}</p>
  `;
}

function renderBudgetStatusTable(data) {
  const body = el("budget-status-body");
  body.innerHTML = "";
  if (!data || !data.items) return;
  for (const row of data.items) {
    const tr = document.createElement("tr");
    if (row.over) tr.classList.add("row-over");
    tr.innerHTML = `
      <td>${escapeHtml(row.category)}</td>
      <td style="font-family:var(--mono)">${money.format(row.budget)}</td>
      <td style="font-family:var(--mono)">${money.format(row.spent)}</td>
      <td style="font-family:var(--mono)">${money.format(row.remaining)}</td>`;
    body.appendChild(tr);
  }
}

function renderTable(txs, budgetStatus) {
  allTransactions = txs;
  const filteredTxs = filterTransactions(txs).sort((a, b) => {
    const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
    const idCompare = Number(a.id || 0) - Number(b.id || 0);
    return txSortDirection === "asc" ? dateCompare || idCompare : -(dateCompare || idCompare);
  });
  const overBudget = budgetStatus instanceof Set ? budgetStatus : budgetStatus?.overBudget || new Set();
  
  const tbody = el("tx-body");
  tbody.innerHTML = "";
  
  let monthlyTotal = 0;
  
  if (!filteredTxs.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="9" class="muted">No transactions this month yet.</td>`;
    tbody.appendChild(tr);
    return;
  }
  
  for (const t of filteredTxs) {
    monthlyTotal += t.amount;
    const tr = document.createElement("tr");
    const isOver = overBudget.has(t.category);
    if (isOver) tr.classList.add("row-over");
    
    const paymentDisplay = t.payment_method === "credit" && t.credit_card 
      ? `Credit (${escapeHtml(t.credit_card)})` 
      : t.payment_method.charAt(0).toUpperCase() + t.payment_method.slice(1);
    
    const tagsDisplay = t.tags ? `<span class="muted" style="font-size: 0.75rem; margin-left: 0.5rem;">#${escapeHtml(t.tags)}</span>` : "";
    const recurringBadge = t.is_recurring ? `<span class="tag tag-subscription" style="font-size: 0.7rem; margin-left: 0.3rem;">Recurring</span>` : "";
    const purchaseDisplay = escapeHtml(t.purchase || (t.is_recurring ? "Recurring expense" : ""));
    const noteDisplay = escapeHtml(t.note || (t.is_recurring ? "Auto-logged from recurring expenses" : ""));

    let cashbackDisplay = "<span class='muted'>—</span>";
    if (t.payment_method === "credit" && t.credit_card && cashbackMap[t.credit_card]) {
      const cardRates = cashbackMap[t.credit_card];
      const rate = cardRates[t.category] ?? cardRates["__default__"] ?? 0;
      if (rate > 0) {
        const earned = t.amount * rate / 100;
        cashbackDisplay = `<span style="color:var(--success);font-family:var(--mono);font-weight:600;">${money.format(earned)}</span><span class="muted" style="font-size:0.75rem;"> (${rate}%)</span>`;
      }
    }
    
    tr.innerHTML = `
      <td>${t.date}</td>
      <td>${escapeHtml(t.category)}${recurringBadge}</td>
      <td>${purchaseDisplay}${tagsDisplay}</td>
      <td style="font-size: 0.85rem;">${paymentDisplay}</td>
      <td><span class="tag tag-${t.cost_type === "fixed" ? "fixed" : "var"}">${
      t.cost_type === "fixed" ? "Fixed" : "Variable"
    }</span></td>
      <td style="font-family: var(--mono); font-weight: 600;">${money.format(t.amount)}</td>
      <td>${cashbackDisplay}</td>
      <td class="notes">${noteDisplay}</td>
      <td class="row-actions">
        <button type="button" class="btn" data-edit="${t.id}">Edit</button>
        <button type="button" class="btn btn-danger" data-del="${t.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  
  tbody.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tid = parseInt(btn.getAttribute("data-edit"), 10);
      const t = txs.find((tx) => tx.id === tid);
      openEdit(t);
    });
  });
  tbody.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tid = parseInt(btn.getAttribute("data-del"), 10);
      removeTx(tid);
    });
  });
  
  const totalDisplay = document.getElementById("monthly-total-display");
  if (totalDisplay) {
    totalDisplay.textContent = `Monthly Total: ${money.format(monthlyTotal)}`;
  }
  const sortBtn = el("btn-sort-date");
  if (sortBtn) {
    sortBtn.textContent = txSortDirection === "asc" ? "Date ↑" : "Date ↓";
    sortBtn.setAttribute("aria-label", `Sort transactions by date ${txSortDirection === "asc" ? "descending" : "ascending"}`);
  }
}

function filterTransactions(txs) {
  const searchTerm = el("search-tx").value.toLowerCase();
  const categoryFilter = el("filter-category").value;
  const paymentFilter = el("filter-payment").value;
  
  return txs.filter(t => {
    const purchase = String(t.purchase || "");
    const category = String(t.category || "");
    const tags = String(t.tags || "");
    const creditCard = String(t.credit_card || "");
    const note = String(t.note || "");
    const matchesSearch = !searchTerm || 
      purchase.toLowerCase().includes(searchTerm) ||
      category.toLowerCase().includes(searchTerm) ||
      tags.toLowerCase().includes(searchTerm) ||
      creditCard.toLowerCase().includes(searchTerm) ||
      note.toLowerCase().includes(searchTerm);
    
    const matchesCategory = !categoryFilter || t.category === categoryFilter;
    const matchesPayment = !paymentFilter || t.payment_method === paymentFilter;
    
    return matchesSearch && matchesCategory && matchesPayment;
  });
}

async function addCustomCategory() {
  const dlg = el("dlg-category");
  if (dlg) {
    el("category-name").value = "";
    dlg.showModal();
  }
}

async function submitCustomCategory(ev) {
  ev.preventDefault();
  const name = el("category-name").value.trim();
  
  if (!name) {
    showFlash("Please enter a category name.");
    return;
  }
  if (categoryList.includes(name)) {
    showFlash("Category already exists.");
    return;
  }
  
  // Preserve current budget values before rebuilding
  const currentValues = {};
  const tbody = el("budget-editor-body");
  if (tbody) {
    tbody.querySelectorAll(".budget-amt").forEach(inp => {
      const cat = inp.dataset.cat;
      if (cat) currentValues[cat] = inp.value;
    });
  }
  
  try {
    await api("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    categoryList.push(name);
    customCategorySet.add(name);
    // Ensure categories stay sorted
    sortCategories();
    fillCategorySelect(el("category"), null);
    fillCategorySelect(el("edit-category"), null);
    populateFilterCategories();
    buildBudgetEditorRows();
    
    // Restore preserved values
    if (tbody) {
      Object.entries(currentValues).forEach(([cat, val]) => {
        const inp = tbody.querySelector(`.budget-amt[data-cat="${CSS.escape(cat)}"]`);
        if (inp) inp.value = val;
      });
    }
    syncBudgetPercents();
    
    el("dlg-category").close();
    showFlash(`Category "${name}" added.`);
  } catch (e) {
    showFlash(`Failed to add category: ${e.message}`);
  }
}

function populateFilterCategories() {
  const select = el("filter-category");
  select.innerHTML = '<option value="">All Categories</option>';
  categoryList.forEach(cat => {
    const option = document.createElement("option");
    option.value = cat;
    option.textContent = cat;
    select.appendChild(option);
  });
}

function renderCalendarHeatmap(txs) {
  const grid = el("calendar-grid");
  grid.innerHTML = "";
  
  const [year, month] = calendarMonth.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDayOfMonth = new Date(year, month - 1, 1).getDay();
  
  const dailySpending = {};
  txs.forEach(tx => {
    if (tx.date.startsWith(calendarMonth)) {
      const day = parseInt(tx.date.split("-")[2], 10);
      dailySpending[day] = (dailySpending[day] || 0) + tx.amount;
    }
  });
  
  const maxSpend = Math.max(...Object.values(dailySpending), 0);
  
  const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  weekdayLabels.forEach(day => {
    const label = document.createElement("div");
    label.textContent = day;
    label.style.cssText = "font-weight: 700; font-size: 0.85rem; color: var(--muted); text-align: center;";
    grid.appendChild(label);
  });
  
  for (let i = 0; i < firstDayOfMonth; i++) {
    const empty = document.createElement("div");
    empty.style.cssText = "visibility: hidden;";
    grid.appendChild(empty);
  }
  
  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement("div");
    const spend = dailySpending[day] || 0;
    const isFuture = new Date(year, month - 1, day) > new Date();
    
    let bgColor = "var(--surface-solid)";
    let textColor = "var(--muted)";
    
    if (!isFuture && spend > 0) {
      const intensity = maxSpend > 0 ? spend / maxSpend : 0;
      if (intensity < 0.2) {
        bgColor = "rgba(34, 197, 94, 0.25)";
        textColor = "#16a34a";
      } else if (intensity < 0.4) {
        bgColor = "rgba(34, 197, 94, 0.5)";
        textColor = "#fff";
      } else if (intensity < 0.6) {
        bgColor = "rgba(234, 179, 8, 0.65)";
        textColor = "#fff";
      } else if (intensity < 0.8) {
        bgColor = "rgba(249, 115, 22, 0.75)";
        textColor = "#fff";
      } else {
        bgColor = "rgba(239, 68, 68, 0.88)";
        textColor = "#fff";
      }
    }
    
    if (isFuture) {
      bgColor = "var(--surface-solid)";
      textColor = "var(--muted)";
      cell.style.opacity = "0.5";
    }
    
    cell.style.cssText = `
      border: 1px solid var(--stroke);
      border-radius: var(--radius-sm);
      padding: 0.5rem;
      text-align: center;
      cursor: ${isFuture ? "default" : "pointer"};
      background: ${bgColor};
      transition: transform 0.15s, box-shadow 0.15s;
      min-height: 60px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    `;
    
    cell.innerHTML = `
      <div style="font-weight: 700; font-size: 1rem; color: ${textColor};">${day}</div>
      ${spend > 0 ? `<div style="font-family: var(--mono); font-size: 0.75rem; color: ${textColor};">${money.format(spend)}</div>` : '<div style="font-size: 0.7rem; color: var(--muted);">—</div>'}
    `;
    
    if (!isFuture) {
      cell.addEventListener("mouseenter", () => {
        cell.style.transform = "scale(1.05)";
        cell.style.boxShadow = "0 4px 12px rgba(124, 58, 237, 0.3)";
      });
      cell.addEventListener("mouseleave", () => {
        cell.style.transform = "scale(1)";
        cell.style.boxShadow = "none";
      });
      cell.addEventListener("click", () => showDayDetails(day, txs));
    }
    
    grid.appendChild(cell);
  }
  
  grid.style.gridTemplateColumns = "repeat(7, 1fr)";
}

function showDayDetails(day, txs) {
  const [year, month] = calendarMonth.split("-").map(Number);
  const dayStr = `${calendarMonth}-${String(day).padStart(2, "0")}`;
  const dayTxs = txs.filter(tx => tx.date === dayStr);
  
  const dlg = el("dlg-day-details");
  const title = el("day-details-title");
  const content = el("day-details-content");
  
  const dateObj = new Date(year, month - 1, day);
  title.textContent = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  
  let dailyTotal = 0;
  dayTxs.forEach(tx => dailyTotal += tx.amount);
  
  let html = `<div style="margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--stroke);">
    <strong style="font-size: 1.2rem; color: var(--accent-soft);">Daily Total: ${money.format(dailyTotal)}</strong>
  </div>`;
  
  if (dayTxs.length === 0) {
    html += `<p class="muted">No transactions on this day.</p>`;
  } else {
    html += `<div style="display: grid; gap: 0.75rem;">`;
    dayTxs.forEach(tx => {
      const paymentDisplay = tx.payment_method === "credit" && tx.credit_card 
        ? `Credit (${escapeHtml(tx.credit_card)})` 
        : tx.payment_method.charAt(0).toUpperCase() + tx.payment_method.slice(1);
      
      html += `
        <div style="padding: 0.75rem; border: 1px solid var(--stroke); border-radius: var(--radius-sm); background: var(--surface-solid);">
          <div style="display: flex; justify-content: space-between; align-items: start;">
            <div>
              <strong style="color: var(--ink);">${escapeHtml(tx.purchase)}</strong>
              <div class="muted" style="font-size: 0.85rem; margin-top: 0.25rem;">${escapeHtml(tx.category)}</div>
              <div class="muted" style="font-size: 0.8rem;">${paymentDisplay}</div>
            </div>
            <div style="font-family: var(--mono); font-weight: 600; color: var(--accent-soft);">${money.format(tx.amount)}</div>
          </div>
        </div>
      `;
    });
    html += `</div>`;
  }
  
  content.innerHTML = html;
  dlg.showModal();
}

async function loadCalendarData() {
  try {
    const q = `?month=${encodeURIComponent(calendarMonth)}`;
    const txData = await api(`/api/transactions${q}`);
    const txs = txData.items || [];
    renderCalendarHeatmap(txs);
  } catch (e) {
  }
}

function setCalendarMonthInput() {
  el("month-input-cal").value = calendarMonth;
}

async function loadCashbackMap() {
  try {
    const data = await api("/api/credit-cards/cashback-map");
    cashbackMap = data.map || {};
  } catch (e) {}
}

async function loadCreditCards() {
  try {
    const data = await api("/api/credit-cards");
    creditCards = data.cards || [];
    await loadCashbackMap();
    populateCreditCardDropdowns();
    renderCreditCards();
  } catch (e) {
  }
}

function populateCreditCardDropdowns() {
  const dropdowns = ["credit_card_select", "edit-credit_card_select"];
  dropdowns.forEach(id => {
    const select = el(id);
    if (!select) return;
    select.innerHTML = '<option value="">Select a card...</option>';
    creditCards.forEach(card => {
      const option = document.createElement("option");
      option.value = card.nickname;
      option.textContent = `${card.nickname} (${card.card_type}${card.last_four ? ' ••' + card.last_four : ''})`;
      select.appendChild(option);
    });
  });
}

function renderCreditCards() {
  const container = el("credit-cards-container");
  if (!container) return;
  container.innerHTML = "";

  if (creditCards.length === 0) {
    container.innerHTML = '<p class="muted">No credit cards added yet.</p>';
    return;
  }

  creditCards.forEach(card => {
    const cardRates = cashbackMap[card.nickname] || {};
    const defaultRate = cardRates["__default__"] ?? card.default_cashback_rate ?? 1;
    const categoryRates = Object.entries(cardRates).filter(([k]) => k !== "__default__");

    const div = document.createElement("div");
    div.style.cssText = "display:grid;gap:0.75rem;padding:0.85rem;border:1px solid var(--stroke);border-radius:var(--radius-md);background:var(--surface-solid);margin-bottom:0.75rem;";

    const rateRows = categoryRates.map(([cat, rate]) =>
      `<div class="cashback-rate-row" data-cat="${escapeHtml(cat)}" style="display:flex;align-items:center;gap:0.5rem;">
        <span style="flex:1;font-size:0.85rem;">${escapeHtml(cat)}</span>
        <input type="number" class="cashback-cat-rate" min="0" max="100" step="0.1" value="${rate}" style="width:5rem;" /><span class="muted" style="font-size:0.8rem;">%</span>
        <button type="button" class="btn btn-ghost btn-sm btn-del-rate" style="color:var(--danger);">✕</button>
      </div>`
    ).join("");

    div.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr auto;gap:0.5rem;align-items:start;">
        <div>
          <strong style="font-size:1rem;">${escapeHtml(card.nickname)}</strong>
          <div class="muted" style="font-size:0.85rem;">${card.card_type}${card.last_four ? ' \u00b7\u00b7\u00b7\u00b7' + card.last_four : ''}</div>
        </div>
        <button type="button" class="btn btn-danger btn-sm btn-remove-card" data-id="${card.id}">Remove</button>
      </div>
      <div>
        <label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:0.35rem;">💳 Cashback Rates</label>
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">
          <span style="flex:1;font-size:0.85rem;color:var(--muted);">Default (all other categories)</span>
          <input type="number" class="cashback-default-rate" min="0" max="100" step="0.1" value="${defaultRate}" style="width:5rem;" /><span class="muted" style="font-size:0.8rem;">%</span>
        </div>
        <div class="cashback-rates-list">${rateRows}</div>
        <div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap;">
          <select class="cashback-add-cat" style="flex:1;min-width:120px;">
            <option value="">+ Category...</option>
            ${categoryList.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>
          <input type="number" class="cashback-add-rate" min="0" max="100" step="0.1" placeholder="%" style="width:5rem;" />
          <button type="button" class="btn btn-sm btn-add-rate">Add</button>
        </div>
        <button type="button" class="btn btn-primary btn-save-cashback" style="margin-top:0.5rem;width:100%;">Save Rates</button>
      </div>
    `;
    container.appendChild(div);

    div.querySelector(".btn-remove-card").addEventListener("click", () => removeCreditCard(card.id));

    div.querySelector(".btn-add-rate").addEventListener("click", () => {
      const catSel = div.querySelector(".cashback-add-cat");
      const rateSel = div.querySelector(".cashback-add-rate");
      const cat = catSel.value.trim();
      const rate = parseFloat(rateSel.value);
      if (!cat || isNaN(rate)) { showFlash("Pick a category and enter a rate."); return; }
      const existing = div.querySelector(`.cashback-rate-row[data-cat="${CSS.escape(cat)}"]`);
      if (existing) { showFlash(`${cat} already has a rate — edit it directly.`); return; }
      const list = div.querySelector(".cashback-rates-list");
      const row = document.createElement("div");
      row.className = "cashback-rate-row";
      row.dataset.cat = cat;
      row.style.cssText = "display:flex;align-items:center;gap:0.5rem;";
      row.innerHTML = `<span style="flex:1;font-size:0.85rem;">${escapeHtml(cat)}</span><input type="number" class="cashback-cat-rate" min="0" max="100" step="0.1" value="${rate}" style="width:5rem;"/><span class="muted" style="font-size:0.8rem;">%</span><button type="button" class="btn btn-ghost btn-sm btn-del-rate" style="color:var(--danger);">✕</button>`;
      row.querySelector(".btn-del-rate").addEventListener("click", () => row.remove());
      list.appendChild(row);
      catSel.value = "";
      rateSel.value = "";
    });

    div.querySelectorAll(".btn-del-rate").forEach(btn => {
      btn.addEventListener("click", () => btn.closest(".cashback-rate-row").remove());
    });

    div.querySelector(".btn-save-cashback").addEventListener("click", async () => {
      const defaultRate = parseFloat(div.querySelector(".cashback-default-rate").value) || 0;
      const rates = [];
      div.querySelectorAll(".cashback-rate-row").forEach(row => {
        const cat = row.dataset.cat;
        const rate = parseFloat(row.querySelector(".cashback-cat-rate").value) || 0;
        if (cat) rates.push({ category: cat, rate });
      });
      try {
        await api(`/api/credit-cards/${card.id}/cashback`, {
          method: "PUT",
          body: JSON.stringify({ default_rate: defaultRate, rates }),
        });
        await loadCashbackMap();
        showFlash("Cashback rates saved.");
      } catch (e) {
        showFlash("Failed to save: " + e.message);
      }
    });
  });
}

async function addCreditCard() {
  const nickname = prompt("Enter card nickname (e.g., Scotiabank Visa):");
  if (!nickname) return;
  
  const cardType = prompt("Enter card type (Visa, Mastercard, Amex, Other):");
  if (!cardType || !["Visa", "Mastercard", "Amex", "Other"].includes(cardType)) {
    showFlash("Invalid card type. Please enter Visa, Mastercard, Amex, or Other.");
    return;
  }
  
  const lastFour = prompt("Enter last 4 digits (optional):") || "";
  
  try {
    const data = await api("/api/credit-cards", {
      method: "POST",
      body: JSON.stringify({ nickname, card_type: cardType, last_four: lastFour }),
    });
    creditCards.push(data);
    populateCreditCardDropdowns();
    renderCreditCards();
    showFlash("Credit card added.");
  } catch (e) {
    showFlash(`Failed to add credit card: ${e.message}`);
  }
}

async function removeCreditCard(id) {
  if (!confirm("Remove this credit card?")) return;
  try {
    await api(`/api/credit-cards/${id}`, { method: "DELETE" });
    creditCards = creditCards.filter(c => c.id !== id);
    populateCreditCardDropdowns();
    renderCreditCards();
  } catch (e) {
    showFlash(`Failed to remove credit card: ${e.message}`);
  }
}

async function loadDashboardData() {
  try {
    const q = `?month=${encodeURIComponent(dashboardMonth)}`;
    const [txData, budgetData] = await Promise.all([
      api(`/api/transactions${q}`),
      api("/api/budget"),
    ]);
    
    const txs = txData.items || [];
    const budget = budgetData.allocations || {};
    
    renderDashboardSnapshot(txs);
    await renderMonthlyCharts();
    await renderCategoryDonutChart(txs);
    renderBudgetHealthBars(txs, budget);
    renderTopCategories(txs);
    renderSavingsRate(txs);
  } catch (e) {
  }
}

function renderDashboardSnapshot(txs) {
  const monthlyIncome = readSalaryInput();
  const monthlyExpenses = txs.reduce((sum, tx) => sum + tx.amount, 0);
  const netSavings = monthlyIncome - monthlyExpenses;
  const cashback = calcCashbackTotal(txs);

  el("dash-income").textContent = money.format(monthlyIncome);
  el("dash-expenses").textContent = money.format(monthlyExpenses);
  el("dash-savings").textContent = money.format(netSavings);
  el("dash-savings").classList.toggle("text-neg", netSavings < 0);
  const dashCb = el("dash-cashback");
  if (dashCb) dashCb.textContent = cashback > 0 ? money.format(cashback) : "—";
}

const CHART_TOOLTIP_OPTS = {
  backgroundColor: "rgba(10,10,15,0.95)",
  titleColor: "#e2e8f0",
  bodyColor: "#94a3b8",
  borderColor: "rgba(124,58,237,0.3)",
  borderWidth: 1,
};
const CHART_SCALE_OPTS = {
  grid: { color: "rgba(124,58,237,0.1)" },
  ticks: { color: "#94a3b8" },
};

async function renderMonthlyCharts() {
  if (typeof Chart === "undefined") return;
  const labels = [];
  const spending = [];
  const cashbacks = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const monthStr = ymFromDate(d);
    labels.push(d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }));
    try {
      const data = await api(`/api/transactions?month=${encodeURIComponent(monthStr)}`);
      const txs = data.items || [];
      spending.push(parseFloat(txs.reduce((s, t) => s + t.amount, 0).toFixed(2)));
      cashbacks.push(parseFloat(calcCashbackTotal(txs).toFixed(2)));
    } catch (e) {
      spending.push(0); cashbacks.push(0);
    }
  }

  // ── Spending Trend (line) ──────────────────────────────────────────────
  const ctx1 = el("chart-spending-trend");
  if (ctx1) {
    if (chartSpendingTrend) chartSpendingTrend.destroy();
    chartSpendingTrend = new Chart(ctx1, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Spending",
          data: spending,
          borderColor: "#6366f1",
          backgroundColor: "rgba(99,102,241,0.18)",
          fill: true,
          tension: 0.4,
          pointBackgroundColor: "#818cf8",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
          pointRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...CHART_TOOLTIP_OPTS, callbacks: { label: (c) => money.format(c.raw) } } },
        scales: {
          x: { ...CHART_SCALE_OPTS },
          y: { ...CHART_SCALE_OPTS, ticks: { color: "#94a3b8", callback: (v) => money.format(v) } },
        },
      },
    });
  }

  // ── Cashback Trend (bar) ───────────────────────────────────────────────
  const ctx2 = el("chart-cashback-trend");
  if (ctx2) {
    if (chartCashbackTrend) chartCashbackTrend.destroy();
    chartCashbackTrend = new Chart(ctx2, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Cashback Earned",
          data: cashbacks,
          backgroundColor: "rgba(16,185,129,0.7)",
          borderColor: "#10b981",
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { ...CHART_TOOLTIP_OPTS, callbacks: { label: (c) => money.format(c.raw) } } },
        scales: {
          x: { ...CHART_SCALE_OPTS },
          y: { ...CHART_SCALE_OPTS, ticks: { color: "#94a3b8", callback: (v) => money.format(v) }, beginAtZero: true },
        },
      },
    });
  }

  // ── Spend vs Cashback (bar + line, dual axis) ──────────────────────────
  const ctx3 = el("chart-spend-vs-cashback");
  if (ctx3) {
    if (chartSpendVsCashback) chartSpendVsCashback.destroy();
    chartSpendVsCashback = new Chart(ctx3, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Spending",
            data: spending,
            backgroundColor: "rgba(99,102,241,0.6)",
            borderColor: "#6366f1",
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: "ySpend",
          },
          {
            label: "Cashback",
            data: cashbacks,
            type: "line",
            borderColor: "#10b981",
            backgroundColor: "rgba(16,185,129,0.15)",
            fill: false,
            tension: 0.4,
            pointBackgroundColor: "#10b981",
            pointBorderColor: "#fff",
            pointBorderWidth: 2,
            pointRadius: 5,
            yAxisID: "yCashback",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#94a3b8", boxWidth: 12 } },
          tooltip: { ...CHART_TOOLTIP_OPTS, callbacks: { label: (c) => `${c.dataset.label}: ${money.format(c.raw)}` } },
        },
        scales: {
          x: { ...CHART_SCALE_OPTS },
          ySpend: {
            ...CHART_SCALE_OPTS,
            position: "left",
            ticks: { color: "#94a3b8", callback: (v) => money.format(v) },
            title: { display: true, text: "Spending", color: "#6366f1" },
          },
          yCashback: {
            ...CHART_SCALE_OPTS,
            position: "right",
            grid: { drawOnChartArea: false },
            ticks: { color: "#10b981", callback: (v) => money.format(v) },
            title: { display: true, text: "Cashback", color: "#10b981" },
          },
        },
      },
    });
  }
}

async function renderCategoryDonutChart(txs) {
  const ctx = el("chart-category-donut");
  if (!ctx) return;
  
  const categoryTotals = {};
  txs.forEach(tx => {
    categoryTotals[tx.category] = (categoryTotals[tx.category] || 0) + tx.amount;
  });
  
  const sorted = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map(([cat]) => cat);
  const data = sorted.map(([, amt]) => amt);
  
  const colors = [
    "#7c3aed", "#a855f7", "#06b6d4", "#f43f5e", "#f97316",
    "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899",
  ];
  
  if (chartCategoryDonut) {
    chartCategoryDonut.destroy();
  }
  
  chartCategoryDonut = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: colors.slice(0, labels.length),
        borderColor: "#111118",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: {
            color: "#94a3b8",
            padding: 12,
            usePointStyle: true,
          },
        },
        tooltip: {
          backgroundColor: "rgba(10, 10, 15, 0.95)",
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          borderColor: "rgba(124, 58, 237, 0.3)",
          borderWidth: 1,
          callbacks: {
            label: (ctx) => `${ctx.label}: ${money.format(ctx.raw)}`,
          },
        },
      },
    },
  });
}

function renderBudgetHealthBars(txs, budget) {
  const container = el("budget-health-bars");
  if (!container) return;
  container.innerHTML = "";
  
  const categorySpent = {};
  txs.forEach(tx => {
    categorySpent[tx.category] = (categorySpent[tx.category] || 0) + tx.amount;
  });
  
  const entries = Object.entries(categorySpent).map(([cat, spent]) => {
    const budgeted = budget[cat] || 0;
    const percent = budgeted > 0 ? (spent / budgeted) * 100 : 0;
    return { cat, spent, budgeted, percent };
  });
  
  entries.sort((a, b) => b.percent - a.percent);
  
  if (entries.length === 0) {
    container.innerHTML = '<p class="muted">No spending data for this month.</p>';
    return;
  }
  
  entries.forEach(({ cat, spent, budgeted, percent }) => {
    const isOver = percent > 100;
    const barColor = isOver ? "var(--danger)" : percent > 80 ? "var(--warning)" : "var(--success)";
    
    const div = document.createElement("div");
    div.style.cssText = "margin-bottom: 1rem;";
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
        <span style="font-weight: 500;">${escapeHtml(cat)}</span>
        <span class="mono" style="color: ${isOver ? 'var(--danger)' : 'var(--muted)'}">${money.format(spent)} / ${money.format(budgeted)}</span>
      </div>
      <div style="background: var(--surface-solid); border-radius: var(--radius-sm); overflow: hidden; height: 8px;">
        <div style="background: ${barColor}; height: 100%; width: ${Math.min(percent, 100)}%; transition: width 0.5s;"></div>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderTopCategories(txs) {
  const container = el("top-categories-list");
  if (!container) return;
  
  const categoryTotals = {};
  txs.forEach(t => {
    categoryTotals[t.category] = (categoryTotals[t.category] || 0) + t.amount;
  });
  
  const sorted = Object.entries(categoryTotals)
    .map(([cat, amount]) => ({ cat, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);
  
  if (sorted.length === 0) {
    container.innerHTML = '<p class="muted">No spending data for this month.</p>';
    return;
  }
  
  sorted.forEach(({ cat, amount }) => {
    const div = document.createElement("div");
    div.style.cssText = "display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--stroke);";
    div.innerHTML = `
      <span>${escapeHtml(cat)}</span>
      <span class="mono">${money.format(amount)}</span>
    `;
    container.appendChild(div);
  });
}

function renderSavingsRate(txs) {
  const monthlyIncome = readSalaryInput();
  const monthlyExpenses = txs.reduce((sum, tx) => sum + tx.amount, 0);
  const savingsRate = monthlyIncome > 0 ? ((monthlyIncome - monthlyExpenses) / monthlyIncome) * 100 : 0;
  
  el("dash-savings-rate").textContent = `${Math.max(0, savingsRate).toFixed(1)}%`;
  el("savings-rate-bar").style.width = `${Math.max(0, Math.min(savingsRate, 100))}%`;
}

function setDashboardMonthInput() {
  el("month-input-dash").value = dashboardMonth;
}

async function loadDebts() {
  try {
    const data = await api("/api/debts");
    debts = data.debts || [];
    renderDebts();
  } catch (e) {
  }
}

function calculatePayoffEstimate(balance, interestRate, minimumPayment) {
  if (minimumPayment <= 0 || balance <= 0) return { months: 0, totalInterest: 0 };
  
  const monthlyRate = interestRate / 100 / 12;
  let currentBalance = balance;
  let totalInterest = 0;
  let months = 0;
  const maxMonths = 600; // 50 years max to prevent infinite loops
  
  while (currentBalance > 0 && months < maxMonths) {
    const interestPayment = currentBalance * monthlyRate;
    const principalPayment = minimumPayment - interestPayment;
    
    if (principalPayment <= 0) {
      return { months: Infinity, totalInterest: Infinity };
    }
    
    totalInterest += interestPayment;
    currentBalance -= principalPayment;
    months++;
  }
  
  return { months, totalInterest };
}

function renderDebts() {
  const container = el("debts-container");
  if (!container) return;
  container.innerHTML = "";
  
  if (debts.length === 0) {
    container.innerHTML = '<p class="muted">No debts added yet.</p>';
    return;
  }
  
  debts.forEach(debt => {
    const payoff = calculatePayoffEstimate(debt.balance, debt.interest_rate, debt.minimum_payment);
    const payoffDate = payoff.months !== Infinity 
      ? new Date(Date.now() + payoff.months * 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" })
      : "Never";
    
    const div = document.createElement("div");
    div.style.cssText = "display: grid; gap: 0.5rem; padding: 0.75rem; border: 1px solid var(--stroke); border-radius: var(--radius-sm); background: var(--surface-solid); margin-bottom: 0.5rem;";
    div.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: start;">
        <div>
          <strong style="font-size: 1rem;">${escapeHtml(debt.name)}</strong>
          <div class="muted" style="font-size: 0.85rem;">${debt.interest_rate}% interest</div>
        </div>
        <button type="button" class="btn btn-danger btn-remove-debt" data-id="${debt.id}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Remove</button>
      </div>
      <div class="form-row cols-3" style="margin-top: 0.5rem;">
        <div>
          <span class="muted" style="font-size: 0.75rem;">Balance</span>
          <div class="mono" style="font-weight: 600;">${money.format(debt.balance)}</div>
        </div>
        <div>
          <span class="muted" style="font-size: 0.75rem;">Min Payment</span>
          <div class="mono" style="font-weight: 600;">${money.format(debt.minimum_payment)}</div>
        </div>
        <div>
          <span class="muted" style="font-size: 0.75rem;">Payoff</span>
          <div class="mono" style="font-weight: 600; color: var(--accent-soft);">${payoffDate}</div>
        </div>
      </div>
      <div class="muted" style="font-size: 0.75rem; margin-top: 0.25rem;">
        Est. total interest: ${payoff.totalInterest !== Infinity ? money.format(payoff.totalInterest) : "N/A"}
      </div>
    `;
    container.appendChild(div);
    
    div.querySelector(".btn-remove-debt").addEventListener("click", () => removeDebt(debt.id));
  });
}

async function addDebt() {
  const name = prompt("Enter debt name (e.g., Student Loan):");
  if (!name) return;
  
  const balance = parseFloat(prompt("Enter current balance:"));
  if (isNaN(balance) || balance < 0) {
    showFlash("Invalid balance.");
    return;
  }
  
  const interestRate = parseFloat(prompt("Enter annual interest rate (e.g., 5.5 for 5.5%):"));
  if (isNaN(interestRate) || interestRate < 0) {
    showFlash("Invalid interest rate.");
    return;
  }
  
  const minimumPayment = parseFloat(prompt("Enter minimum monthly payment:"));
  if (isNaN(minimumPayment) || minimumPayment < 0) {
    showFlash("Invalid minimum payment.");
    return;
  }
  
  try {
    const data = await api("/api/debts", {
      method: "POST",
      body: JSON.stringify({ name, balance, interest_rate: interestRate, minimum_payment: minimumPayment }),
    });
    debts.push(data);
    renderDebts();
  } catch (e) {
    showFlash(`Failed to add debt: ${e.message}`);
  }
}

async function removeDebt(id) {
  if (!confirm("Remove this debt?")) return;
  try {
    await api(`/api/debts/${id}`, { method: "DELETE" });
    debts = debts.filter(d => d.id !== id);
    renderDebts();
  } catch (e) {
    showFlash(`Failed to remove debt: ${e.message}`);
  }
}

async function loadGoals() {
  try {
    const data = await api("/api/goals");
    goals = data.goals || [];
    renderGoals();
  } catch (e) {
  }
}

function calculateGoalProgress(target, current, monthly) {
  if (target <= 0) return { percent: 0, months: 0 };
  const percent = (current / target) * 100;
  const remaining = target - current;
  const months = monthly > 0 ? Math.ceil(remaining / monthly) : Infinity;
  return { percent, months };
}

function renderGoals() {
  const container = el("goals-container");
  if (!container) return;
  container.innerHTML = "";
  
  if (goals.length === 0) {
    container.innerHTML = '<p class="muted">No savings goals added yet.</p>';
    return;
  }
  
  goals.forEach(goal => {
    const progress = calculateGoalProgress(goal.target_amount, goal.current_amount, goal.monthly_contribution);
    
    const div = document.createElement("div");
    div.style.cssText = "display: grid; gap: 0.5rem; padding: 0.75rem; border: 1px solid var(--stroke); border-radius: var(--radius-sm); background: var(--surface-solid); margin-bottom: 0.5rem;";
    div.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: start;">
        <div>
          <strong style="font-size: 1rem;">${escapeHtml(goal.name)}</strong>
          <div class="muted" style="font-size: 0.85rem;">${money.format(goal.current_amount)} / ${money.format(goal.target_amount)}</div>
        </div>
        <button type="button" class="btn btn-danger btn-remove-goal" data-id="${goal.id}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Remove</button>
      </div>
      <div style="margin-top: 0.5rem;">
        <div style="background: var(--surface-solid); border-radius: var(--radius-sm); overflow: hidden; height: 12px;">
          <div style="background: linear-gradient(90deg, var(--accent), var(--cyan)); height: 100%; width: ${Math.min(progress.percent, 100)}%; transition: width 0.5s;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 0.25rem;">
          <span class="muted" style="font-size: 0.75rem;">${progress.percent.toFixed(1)}% complete</span>
          <span class="muted" style="font-size: 0.75rem;">${progress.months !== Infinity ? progress.months + ' months left' : 'No monthly contribution'}</span>
        </div>
      </div>
      <div style="margin-top: 0.5rem;">
        <button type="button" class="btn btn-ghost btn-add-savings" data-id="${goal.id}" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">+ Add Savings</button>
      </div>
    `;
    container.appendChild(div);
    
    div.querySelector(".btn-remove-goal").addEventListener("click", () => removeGoal(goal.id));
    div.querySelector(".btn-add-savings").addEventListener("click", () => addSavings(goal.id));
  });
}

async function addGoal() {
  const name = prompt("Enter goal name (e.g., Emergency Fund):");
  if (!name) return;
  
  const targetAmount = parseFloat(prompt("Enter target amount:"));
  if (isNaN(targetAmount) || targetAmount < 0) {
    showFlash("Invalid target amount.");
    return;
  }
  
  const monthlyContribution = parseFloat(prompt("Enter monthly contribution:"));
  if (isNaN(monthlyContribution) || monthlyContribution < 0) {
    showFlash("Invalid monthly contribution.");
    return;
  }
  
  try {
    const data = await api("/api/goals", {
      method: "POST",
      body: JSON.stringify({ name, target_amount: targetAmount, monthly_contribution: monthlyContribution }),
    });
    goals.push(data);
    renderGoals();
  } catch (e) {
    showFlash(`Failed to add goal: ${e.message}`);
  }
}

async function removeGoal(id) {
  if (!confirm("Remove this goal?")) return;
  try {
    await api(`/api/goals/${id}`, { method: "DELETE" });
    goals = goals.filter(g => g.id !== id);
    renderGoals();
  } catch (e) {
    showFlash(`Failed to remove goal: ${e.message}`);
  }
}

async function addSavings(id) {
  const amount = parseFloat(prompt("Enter amount to add:"));
  if (isNaN(amount) || amount < 0) {
    showFlash("Invalid amount.");
    return;
  }
  
  const goal = goals.find(g => g.id === id);
  if (!goal) return;
  
  try {
    const updated = await api(`/api/goals/${id}`, {
      method: "PUT",
      body: JSON.stringify({ current_amount: goal.current_amount + amount }),
    });
    const index = goals.findIndex(g => g.id === id);
    if (index !== -1) {
      goals[index] = updated;
    }
    renderGoals();
  } catch (e) {
    showFlash(`Failed to add savings: ${e.message}`);
  }
}

async function loadRecurringExpenses() {
  try {
    const data = await api("/api/recurring-expenses");
    recurringExpenses = data.expenses || [];
    renderRecurringExpenses();
  } catch (e) {
  }
}

function renderRecurringExpenses() {
  const container = el("recurring-expenses-container");
  if (!container) return;
  container.innerHTML = "";
  
  if (recurringExpenses.length === 0) {
    container.innerHTML = '<p class="muted">No recurring expenses added yet.</p>';
    return;
  }
  
  recurringExpenses.forEach(expense => {
    const div = document.createElement("div");
    div.style.cssText = "display: grid; gap: 0.5rem; padding: 0.75rem; border: 1px solid var(--stroke); border-radius: var(--radius-sm); background: var(--surface-solid); margin-bottom: 0.5rem;";
    div.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: start;">
        <div>
          <strong style="font-size: 1rem;">${escapeHtml(expense.name)}</strong>
          <div class="muted" style="font-size: 0.85rem;">${money.format(expense.amount)} - ${escapeHtml(expense.category)}</div>
          <div class="muted" style="font-size: 0.8rem;">${expense.frequency} on day ${expense.day_of_month}</div>
          <div class="muted" style="font-size: 0.8rem;">${expense.start_date} to ${expense.end_date}</div>
        </div>
        <button type="button" class="btn btn-danger btn-remove-recurring" data-id="${expense.id}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Remove</button>
      </div>
    `;
    container.appendChild(div);
    
    div.querySelector(".btn-remove-recurring").addEventListener("click", () => removeRecurringExpense(expense.id));
  });
}

async function addRecurringExpense() {
  const dlg = el("dlg-recurring");
  const categorySelect = el("rec-category");
  if (!categorySelect || !dlg) return;
  fillCategorySelect(categorySelect, "Utilities");
  el("rec-name").value = "";
  el("rec-amount").value = "";
  el("rec-cost-type").value = "variable";
  el("rec-start-date").value = "";
  el("rec-end-date").value = "";
  el("rec-frequency").value = "monthly";
  el("rec-day-of-month").value = "1";
  dlg.showModal();
}

async function submitRecurringExpense(ev) {
  ev.preventDefault();
  const name = el("rec-name").value;
  const amount = parseFloat(el("rec-amount").value);
  const category = el("rec-category").value;
  const costType = el("rec-cost-type").value;
  const startDate = el("rec-start-date").value;
  const endDate = el("rec-end-date").value;
  const frequency = el("rec-frequency").value;
  const dayOfMonth = parseInt(el("rec-day-of-month").value);
  
  if (!name || isNaN(amount) || amount < 0 || !category || !startDate || !endDate || isNaN(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    showFlash("Please fill in all fields correctly.");
    return;
  }
  
  try {
    const data = await api("/api/recurring-expenses", {
      method: "POST",
      body: JSON.stringify({ 
        name, 
        amount, 
        category, 
        cost_type: costType, 
        start_date: startDate, 
        end_date: endDate, 
        frequency, 
        day_of_month: dayOfMonth 
      }),
    });
    recurringExpenses.push(data);
    renderRecurringExpenses();
    el("dlg-recurring").close();
    
    // Update current month to the start date's month so transactions are visible
    const startYearMonth = startDate.slice(0, 7);
    currentMonth = startYearMonth;
    setMonthInput();
    await reloadMonth();
    
    showFlash(`Recurring expense added. ${data.generated_transactions_count} transactions generated.`);
  } catch (e) {
    showFlash(`Failed to add recurring expense: ${e.message}`);
  }
}

async function removeRecurringExpense(id) {
  if (!confirm("Remove this recurring expense? All generated transactions will also be deleted.")) return;
  try {
    await api(`/api/recurring-expenses/${id}`, { method: "DELETE" });
    recurringExpenses = recurringExpenses.filter(r => r.id !== id);
    renderRecurringExpenses();
    showFlash("Recurring expense removed.");
  } catch (e) {
    showFlash(`Failed to remove recurring expense: ${e.message}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


async function saveVariablePayments(streamId) {
  const streamEl = document.querySelector(`.income-stream-item[data-id="${streamId}"]`);
  if (!streamEl) return;
  
  const paymentItems = streamEl.querySelectorAll(".payment-item");
  const payments = [];
  
  paymentItems.forEach(item => {
    const amount = parseFloat(item.querySelector(".payment-amount").value) || 0;
    const paymentDate = item.querySelector(".payment-date").value;
    if (amount > 0 && paymentDate) {
      payments.push({ amount, payment_date: paymentDate, day_of_month: parseInt(paymentDate.slice(-2), 10) });
    }
  });
  
  try {
    await updateIncomeStream(streamId, { payments });
    const stream = incomeStreams.find(s => s.id === streamId);
    if (stream) {
      stream.payments = payments;
      calculateIncomeSummary();
    }
  } catch (e) {
    showFlash(`Failed to save payments: ${e.message}`);
  }
}

function convertToMonthly(amount, frequency) {
  switch (frequency) {
    case "weekly":
      return amount * 52 / 12;
    case "bi_weekly":
      return amount * 26 / 12;
    case "semi_monthly":
      return amount * 2;
    case "monthly":
      return amount;
    case "annually":
      return amount / 12;
    default:
      return amount;
  }
}

function monthlyIncomeForStream(stream, month = currentMonth) {
  const datedPayments = (stream.payments || []).filter((p) => p.payment_date);
  const paymentsForMonth = datedPayments.filter((p) => String(p.payment_date || "").slice(0, 7) === month);
  if (paymentsForMonth.length) {
    return paymentsForMonth.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  }
  return convertToMonthly(Number(stream.amount || 0), stream.frequency);
}

function frequencyLabel(frequency) {
  const labels = {
    weekly: "Weekly",
    bi_weekly: "Bi-weekly",
    semi_monthly: "Semi-monthly",
    monthly: "Monthly",
    annually: "Annually",
  };
  return labels[frequency] || frequency;
}

function renderIncomeStreams() {
  const container = el("income-streams-container");
  container.innerHTML = "";
  
  incomeStreams.forEach((stream, index) => {
    const div = document.createElement("div");
    div.className = "income-stream-item";
    div.style.cssText = "display: grid; gap: 0.5rem; padding: 0.75rem; border: 1px solid var(--stroke); border-radius: var(--radius-sm); background: var(--surface-solid); margin-bottom: 0.5rem;";
    div.dataset.id = stream.id;
    
    const selectedMonth = currentMonth || ymFromDate(new Date());
    const datedPayments = (stream.payments || []).filter((p) => p.payment_date);
    const paymentsForMonth = datedPayments.length
      ? datedPayments.filter((p) => p.payment_date && p.payment_date.slice(0, 7) === selectedMonth)
      : (stream.payments || []);
    const monthlyAmount = monthlyIncomeForStream(stream, selectedMonth);
    
    div.innerHTML = `
      <div style="display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; align-items: start;">
        <div>
          <input type="text" class="income-label" value="${escapeHtml(stream.label)}" placeholder="Income source name" style="font-weight: 600;" />
        </div>
        <button type="button" class="btn btn-danger btn-remove-stream" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Remove</button>
      </div>
      <div class="form-row cols-2" style="margin-top: 0.5rem;">
        <div>
          <label>Amount</label>
          <input type="number" class="income-amount" value="${stream.amount}" min="0" step="0.01" style="font-family: var(--mono);" />
        </div>
        <div>
          <label>Frequency</label>
          <select class="income-frequency">
            <option value="weekly" ${stream.frequency === "weekly" ? "selected" : ""}>Weekly</option>
            <option value="bi_weekly" ${stream.frequency === "bi_weekly" ? "selected" : ""}>Bi-weekly</option>
            <option value="semi_monthly" ${stream.frequency === "semi_monthly" ? "selected" : ""}>Semi-monthly</option>
            <option value="monthly" ${stream.frequency === "monthly" ? "selected" : ""}>Monthly</option>
            <option value="annually" ${stream.frequency === "annually" ? "selected" : ""}>Annually</option>
            <option value="variable" ${stream.frequency === "variable" ? "selected" : ""}>Variable (custom)</option>
          </select>
        </div>
      </div>
      <div style="margin-top: 0.5rem; padding: 0.5rem; background: var(--surface); border-radius: var(--radius-sm);">
        <label style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Monthly Override</label>
        <p class="muted" style="font-size: 0.78rem; margin: 0.2rem 0 0.5rem;">Override base amount for a specific month. Leave blank to use base amount.</p>
        <div style="display: grid; grid-template-columns: auto 1fr auto auto; gap: 0.4rem; align-items: center;">
          <input type="month" class="override-month" value="${selectedMonth}" style="font-size: 0.85rem; width: 140px;" />
          <input type="number" class="override-amount" value="${paymentsForMonth.length ? paymentsForMonth[0].amount : ""}" min="0" step="0.01" placeholder="Override amount…" style="font-family: var(--mono); font-size: 0.85rem;" />
          <button type="button" class="btn btn-accent btn-set-override" style="font-size: 0.82rem; padding: 0.28rem 0.6rem;">Set</button>
          <button type="button" class="btn btn-danger btn-clear-override" style="font-size: 0.82rem; padding: 0.28rem 0.6rem;">Clear</button>
        </div>
      </div>
      <div class="form-row cols-2">
        <div>
          <label>Type</label>
          <select class="income-is-gross">
            <option value="true" ${stream.is_gross ? "selected" : ""}>Gross (pre-tax)</option>
            <option value="false" ${!stream.is_gross ? "selected" : ""}>Net (after tax)</option>
          </select>
        </div>
        <div style="display: flex; align-items: flex-end;">
          <span class="muted" style="font-size: 0.85rem; font-family: var(--mono);">Monthly: ${money.format(monthlyAmount)}</span>
        </div>
      </div>
    `;
    
    container.appendChild(div);
    
    div.querySelector(".btn-remove-stream").addEventListener("click", () => removeIncomeStream(stream.id));
    div.querySelector(".income-label").addEventListener("change", (e) => updateIncomeStream(stream.id, { label: e.target.value }));
    div.querySelector(".income-amount").addEventListener("change", (e) => updateIncomeStream(stream.id, { amount: parseFloat(e.target.value) || 0 }));
    div.querySelector(".income-frequency").addEventListener("change", (e) => updateIncomeStream(stream.id, { frequency: e.target.value }));
    div.querySelector(".income-is-gross").addEventListener("change", (e) => updateIncomeStream(stream.id, { is_gross: e.target.value === "true" }));

    div.querySelector(".btn-set-override").addEventListener("click", async () => {
      const month = div.querySelector(".override-month").value;
      const amount = parseFloat(div.querySelector(".override-amount").value);
      if (!month || isNaN(amount) || amount < 0) { showFlash("Enter a valid month and amount."); return; }
      const otherPayments = (stream.payments || []).filter(p => !p.payment_date || p.payment_date.slice(0, 7) !== month);
      const newPayment = { amount, payment_date: `${month}-01`, day_of_month: 1 };
      try {
        const data = await api(`/api/income/streams/${stream.id}`, { method: "PUT", body: JSON.stringify({ payments: [...otherPayments, newPayment] }) });
        Object.assign(stream, data);
        renderIncomeStreams();
        showFlash(`Income set to ${money.format(amount)} for ${month}.`);
      } catch (e) { showFlash(e.message); }
    });

    div.querySelector(".btn-clear-override").addEventListener("click", async () => {
      const month = div.querySelector(".override-month").value;
      const otherPayments = (stream.payments || []).filter(p => !p.payment_date || p.payment_date.slice(0, 7) !== month);
      try {
        const data = await api(`/api/income/streams/${stream.id}`, { method: "PUT", body: JSON.stringify({ payments: otherPayments }) });
        Object.assign(stream, data);
        renderIncomeStreams();
        showFlash(`Override cleared for ${month}. Using base amount.`);
      } catch (e) { showFlash(e.message); }
    });
  });
  
  calculateIncomeSummary();
}

async function loadIncomeStreams() {
  try {
    const data = await api("/api/income/streams");
    incomeStreams = data.streams || [];
    renderIncomeStreams();
  } catch (e) {
  }
}

async function loadIncomeSettings() {
  try {
    const data = await api("/api/income/settings");
    incomeSettings = data;
    el("rpp-deduction").value = data.rpp_deduction || "";
    el("rrsp-contribution").value = data.rrsp_contribution || "";
    el("fhsa-contribution").value = data.fhsa_contribution || "";
    el("take-home-override").value = data.take_home_override || "";
    calculateIncomeSummary();
  } catch (e) {
  }
}

async function addIncomeStream() {
  const newStream = {
    label: "New Income",
    amount: 0,
    frequency: "monthly",
    is_gross: true,
    payments: [],
  };
  try {
    const data = await api("/api/income/streams", {
      method: "POST",
      body: JSON.stringify(newStream),
    });
    incomeStreams.push(data);
    renderIncomeStreams();
  } catch (e) {
    showFlash(`Failed to add income stream: ${e.message}`);
  }
}

async function updateIncomeStream(id, updates) {
  try {
    const stream = incomeStreams.find(s => s.id === id);
    if (!stream) return;
    const data = await api(`/api/income/streams/${id}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    Object.assign(stream, data);
    renderIncomeStreams();
  } catch (e) {
    showFlash(`Failed to update income stream: ${e.message}`);
  }
}

async function removeIncomeStream(id) {
  if (!confirm("Remove this income stream?")) return;
  try {
    await api(`/api/income/streams/${id}`, { method: "DELETE" });
    incomeStreams = incomeStreams.filter(s => s.id !== id);
    renderIncomeStreams();
  } catch (e) {
    showFlash(`Failed to remove income stream: ${e.message}`);
  }
}

async function saveIncomeSettings() {
  const settings = {
    rpp_deduction: parseFloat(el("rpp-deduction").value) || 0,
    rrsp_contribution: parseFloat(el("rrsp-contribution").value) || 0,
    fhsa_contribution: parseFloat(el("fhsa-contribution").value) || 0,
    take_home_override: el("take-home-override").value || "",
  };
  try {
    const data = await api("/api/income/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    incomeSettings = data;
    calculateIncomeSummary();
  } catch (e) {
    showFlash(`Failed to save income settings: ${e.message}`);
  }
}

function calculateIncomeSummary() {
  let monthlyGross = 0;
  let monthlyNet = 0;
  
  incomeStreams.forEach(stream => {
    const monthly = monthlyIncomeForStream(stream, currentMonth);
    if (stream.is_gross) {
      monthlyGross += monthly;
      monthlyNet += monthly;
    } else {
      monthlyNet += monthly;
    }
  });
  
  const rpp = incomeSettings.rpp_deduction || 0;
  const rrsp = incomeSettings.rrsp_contribution || 0;
  const fhsa = incomeSettings.fhsa_contribution || 0;
  const takeHomeOverride = incomeSettings.take_home_override ? parseFloat(incomeSettings.take_home_override) : null;
  
  let finalMonthlyNet = monthlyNet - rpp - rrsp - fhsa;
  if (takeHomeOverride !== null && !isNaN(takeHomeOverride)) {
    finalMonthlyNet = takeHomeOverride;
  }
  
  el("val-monthly-income").textContent = money.format(finalMonthlyNet);
  el("val-annual-income").textContent = money.format(finalMonthlyNet * 12);
  
  if (show503020Rule) {
    update503020Rule(finalMonthlyNet);
  }
  
  updateBudgetSummaryFromInputs();
}

function update503020Rule(monthlyIncome) {
  el("rule-50").textContent = money.format(monthlyIncome * 0.5);
  el("rule-30").textContent = money.format(monthlyIncome * 0.3);
  el("rule-20").textContent = money.format(monthlyIncome * 0.2);
}

function chartDefaults() {
  if (typeof Chart === "undefined") return;
  Chart.defaults.font.family = "'Inter', 'Geist', sans-serif";
  Chart.defaults.color = "#94a3b8";
  Chart.defaults.borderColor = "rgba(124, 58, 237, 0.15)";
}

function buildOrUpdateDailyChart(series) {
  const labels = series.map((p) => String(p.day));
  const data = series.map((p) => p.total);
  const ctx = el("chart-daily");
  if (chartDaily) {
    chartDaily.data.labels = labels;
    chartDaily.data.datasets[0].data = data;
    chartDaily.update();
    return;
  }
  chartDaily = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Spent",
          data,
          tension: 0.3,
          borderColor: "#7c3aed",
          backgroundColor: "rgba(124, 58, 237, 0.2)",
          fill: true,
          pointRadius: 3,
          pointBackgroundColor: "#a855f7",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(17, 17, 24, 0.96)",
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          borderColor: "rgba(124, 58, 237, 0.28)",
          borderWidth: 1,
        },
      },
      scales: {
        x: { grid: { color: "rgba(124, 58, 237, 0.1)" }, ticks: { maxRotation: 0 } },
        y: {
          grid: { color: "rgba(124, 58, 237, 0.1)" },
          ticks: {
            callback: (v) => money.format(Number(v)),
          },
        },
      },
    },
  });
}

function buildSimpleCategoryChart(items) {
  const labels = items.map((x) => x.category);
  const data = items.map((x) => x.total);
  const ctx = el("chart-category");
  if (!items.length) {
    destroyCategoryChart();
    return;
  }
  chartCategory = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Spent",
          data,
          backgroundColor: "rgba(124, 58, 237, 0.55)",
          borderColor: "#7c3aed",
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(17, 17, 24, 0.96)",
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          borderColor: "rgba(124, 58, 237, 0.28)",
          borderWidth: 1,
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(124, 58, 237, 0.1)" },
          ticks: {
            callback: (v) => money.format(Number(v)),
          },
        },
        y: { grid: { display: false } },
      },
    },
  });
}

function stackBarLabel(tx) {
  const raw = (tx.purchase || "").trim();
  const base = raw || "Purchase";
  const short = base.length > 34 ? `${base.slice(0, 32)}…` : base;
  return `${short} · ${money.format(tx.amount)}`;
}

function stackBarColor(i) {
  const h = (310 + ((i * 37) % 55)) % 360;
  return `hsla(${h}, 78%, 68%, 0.9)`;
}

function buildStackedCategoryChart(payload) {
  const labels = payload.category_order || [];
  const txs = (payload.transactions || []).filter((t) => labels.includes(t.category));
  const ctx = el("chart-category");
  if (!labels.length || !txs.length) {
    destroyCategoryChart();
    return;
  }
  const showLegend = txs.length <= 18;
  const datasets = txs.map((tx, idx) => ({
    label: stackBarLabel(tx),
    data: labels.map((cat) => (cat === tx.category ? tx.amount : 0)),
    stack: "catSpend",
    backgroundColor: stackBarColor(idx),
    borderWidth: 0,
    metaTx: tx,
  }));
  chartCategory = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: showLegend,
          position: "bottom",
          labels: { boxWidth: 10, font: { size: 10 }, color: "#94a3b8" },
        },
        tooltip: {
          backgroundColor: "rgba(17, 17, 24, 0.96)",
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          borderColor: "rgba(124, 58, 237, 0.28)",
          borderWidth: 1,
          callbacks: {
            title(items) {
              const di = items[0]?.dataIndex;
              return di >= 0 ? labels[di] : "";
            },
            afterLabel(item) {
              const tx = item.dataset.metaTx;
              if (!tx) return "";
              const parts = [tx.date];
              if ((tx.note || "").trim()) parts.push(`Notes: ${tx.note.trim()}`);
              return parts.join(" · ");
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { color: "rgba(124, 58, 237, 0.1)" },
          ticks: {
            callback: (v) => money.format(Number(v)),
          },
        },
        y: { stacked: true, grid: { display: false } },
      },
    },
  });
}

function refreshCategoryChart() {
  if (!dashboard.category) return;
  const stacked = el("toggle-category-stack").checked;
  destroyCategoryChart();
  if (stacked) {
    if (lastCategoryStack && lastCategoryStack.transactions && lastCategoryStack.transactions.length) {
      buildStackedCategoryChart(lastCategoryStack);
    }
  } else if (lastCategoryAgg.length) {
    buildSimpleCategoryChart(lastCategoryAgg);
  }
}

async function loadCategoryList() {
  try {
    const data = await api("/api/categories");
    categoryList = data.items;
    customCategorySet = new Set(data.custom || []);
    // Ensure categories are always sorted
    sortCategories();
    fillCategorySelect(el("category"), null);
    fillCategorySelect(el("edit-category"), null);
    populateFilterCategories();
    await loadCategoryMetadata();
    buildBudgetEditorRows();
  } catch (e) {
  }
}

function sortCategories() {
  categoryList.sort((a, b) => a.localeCompare(b));
}

async function loadCategoryMetadata() {
  try {
    const { metadata } = await api("/api/categories/metadata");
    categoryMetadata = metadata;
  } catch (e) {
  }
}

function getCategoryTypeTag(cat) {
  const meta = categoryMetadata[cat];
  if (!meta) return "";
  const type = meta.type || "variable";
  const typeLabels = {
    fixed: "Fixed",
    variable: "Variable",
    subscription: "Subscription",
    debt: "Debt",
    savings: "Savings",
  };
  const tagClass = {
    fixed: "tag-fixed",
    variable: "tag-var",
    subscription: "tag-subscription",
    debt: "tag-debt",
    savings: "tag-savings",
  };
  return `<span class="tag ${tagClass[type] || 'tag-var'}">${typeLabels[type] || type}</span>`;
}

function buildBudgetEditorRows() {
  const tbody = el("budget-editor-body");
  if (!tbody) return;
  
  // Add fade out animation
  tbody.style.transition = "opacity 0.15s ease-out";
  tbody.style.opacity = "0";
  
  setTimeout(() => {
    tbody.innerHTML = "";
  for (const c of categoryList) {
    const isCustom = customCategorySet.has(c);
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = c;
    const tdType = document.createElement("td");
    const typeSelect = document.createElement("select");
    typeSelect.className = "category-type-select";
    typeSelect.dataset.cat = c;
    const meta = categoryMetadata[c] || {};
    const currentType = meta.type || "variable";
    const typeOptions = ["fixed", "variable", "subscription", "debt", "savings"];
    typeOptions.forEach(type => {
      const opt = document.createElement("option");
      opt.value = type;
      opt.textContent = type.charAt(0).toUpperCase() + type.slice(1);
      if (type === currentType) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    tdType.appendChild(typeSelect);
    const tdAmt = document.createElement("td");
    const inp = document.createElement("input");
    inp.type = "number";
    inp.className = "budget-amt";
    inp.min = "0";
    inp.max = "999999999";
    inp.step = "0.01";
    inp.dataset.cat = c;
    // Use cached value if available, otherwise default to 0
    inp.value = budgetValuesCache[c] !== undefined ? budgetValuesCache[c] : "0";
    inp.setAttribute("aria-label", `Budget for ${c}`);
    tdAmt.appendChild(inp);
    const tdPct = document.createElement("td");
    tdPct.className = "pct";
    tdPct.dataset.pctFor = c;
    tdPct.textContent = "—";
    const tdDel = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-sm";
    btn.textContent = "✕";
    btn.title = isCustom ? "Delete custom category" : "Hide category from your list";
    btn.style.color = "var(--danger)";
    btn.addEventListener("click", () => deleteCustomCategory(c));
    tdDel.appendChild(btn);
    tr.appendChild(tdName);
    tr.appendChild(tdType);
    tr.appendChild(tdAmt);
    tr.appendChild(tdPct);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  }
  if (!tbody.dataset.boundInput) {
    tbody.dataset.boundInput = "1";
    tbody.addEventListener("input", (ev) => {
      if (ev.target.classList.contains("budget-amt")) {
        // Cache the value immediately
        const cat = ev.target.dataset.cat;
        if (cat) budgetValuesCache[cat] = ev.target.value;
        syncBudgetPercents();
      }
      if (ev.target.classList.contains("category-type-select")) {
        const category = ev.target.dataset.cat;
        const newType = ev.target.value;
        saveCategoryType(category, newType);
      }
    });
  }
  syncBudgetPercents();
  
  // Fade back in
  setTimeout(() => {
    tbody.style.transition = "opacity 0.2s ease-in";
    tbody.style.opacity = "1";
  }, 50);
  }, 150);
}

async function deleteCustomCategory(name) {
  if (!confirm(`Remove "${name}" from your categories? Existing transactions using it will not be deleted.`)) return;
  
  // Preserve current budget values before rebuilding
  const currentValues = {};
  const tbody = el("budget-editor-body");
  if (tbody) {
    tbody.querySelectorAll(".budget-amt").forEach(inp => {
      const cat = inp.dataset.cat;
      if (cat && cat !== name) currentValues[cat] = inp.value;
    });
  }
  
  try {
    await api(`/api/categories/${encodeURIComponent(name)}`, { method: "DELETE" });
    await loadCategoryList();
    
    // Restore preserved values
    if (tbody) {
      Object.entries(currentValues).forEach(([cat, val]) => {
        const inp = tbody.querySelector(`.budget-amt[data-cat="${CSS.escape(cat)}"]`);
        if (inp) inp.value = val;
      });
    }
    syncBudgetPercents();
    
    showFlash(`Category "${name}" removed.`);
  } catch (e) {
    showFlash(e.message);
  }
}

function readSalaryInput() {
  const monthlyIncomeText = el("val-monthly-income").textContent;
  if (monthlyIncomeText === "—") return 0;
  const v = parseFloat(monthlyIncomeText.replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

function syncBudgetPercents() {
  const salary = readSalaryInput();
  const tbody = el("budget-editor-body");
  const rows = tbody.querySelectorAll("tr");
  rows.forEach(row => {
    const inp = row.querySelector(".budget-amt");
    const pctCell = row.querySelector(".pct");
    if (inp && pctCell) {
      const amt = parseFloat(inp.value) || 0;
      const pct = salary > 0 ? (amt / salary) * 100 : 0;
      pctCell.textContent = pct > 0 ? `${pct.toFixed(1)}%` : "—";
    }
  });
}

async function saveCategoryType(category, type) {
  try {
    await api(`/api/categories/metadata/${category}`, {
      method: "PUT",
      body: JSON.stringify({ type }),
    });
    categoryMetadata[category] = categoryMetadata[category] || {};
    categoryMetadata[category].type = type;
  } catch (e) {
    showFlash(`Failed to save category type: ${e.message}`);
  }
}

function applyBudgetSummaryFromApi(data) {
  const tb = el("val-total-budget");
  const inv = el("val-investing");
  if (!tb || !inv) return;
  if (typeof data.total_budget === "number") {
    tb.textContent = money.format(data.total_budget);
  }
  if (typeof data.investing_savings === "number") {
    inv.textContent = money.format(data.investing_savings);
    inv.classList.toggle("text-neg", data.investing_savings < 0);
  }
}

function updateBudgetSummaryFromInputs() {
  const tb = el("val-total-budget");
  const inv = el("val-investing");
  if (!tb || !inv) return;
  const salary = readSalaryInput();
  let sum = 0;
  const tbody = el("budget-editor-body");
  if (tbody) {
    for (const c of categoryList) {
      const inp = tbody.querySelector(`input.budget-amt[data-cat="${CSS.escape(c)}"]`);
      if (inp) sum += parseFloat(inp.value) || 0;
    }
  }
  sum = Math.round(sum * 100) / 100;
  const investing = Math.round((salary - sum) * 100) / 100;
  tb.textContent = money.format(sum);
  inv.textContent = money.format(investing);
  inv.classList.toggle("text-neg", investing < 0);
}

async function loadBudgetForm() {
  try {
    const data = await api("/api/budget");
    const tbody = el("budget-editor-body");
    if (!tbody) return;
    
    // Populate cache from server data on first load
    for (const c of categoryList) {
      const serverValue = String(data.allocations[c] ?? 0);
      // Only update cache if we don't have a local value (first load)
      if (budgetValuesCache[c] === undefined) {
        budgetValuesCache[c] = serverValue;
      }
    }
    
    // Apply cached values to inputs
    for (const c of categoryList) {
      const inp = tbody.querySelector(`.budget-amt[data-cat="${CSS.escape(c)}"]`);
      if (inp && budgetValuesCache[c] !== undefined) {
        inp.value = budgetValuesCache[c];
      }
    }
    syncBudgetPercents();
    applyBudgetSummaryFromApi(data);
  } catch (e) {
  }
}

async function saveBudget() {
  const salary = readSalaryInput();
  const allocations = {};
  for (const c of categoryList) {
    // Use cache first, then fall back to input value
    const raw = budgetValuesCache[c] !== undefined 
      ? parseFloat(budgetValuesCache[c]) 
      : 0;
    allocations[c] = Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }
  const res = await api("/api/budget", {
    method: "PUT",
    body: JSON.stringify({ salary, allocations }),
  });
  applyBudgetSummaryFromApi(res);
  el("budget-save-hint").textContent = "Saved.";
  setTimeout(() => {
    el("budget-save-hint").textContent = "";
  }, 2500);
}

async function saveIncomeSettingsDebounced() {
  await saveIncomeSettings();
}

let incomeSettingsTimeout;
function saveIncomeSettingsWithDebounce() {
  clearTimeout(incomeSettingsTimeout);
  incomeSettingsTimeout = setTimeout(saveIncomeSettingsDebounced, 500);
}

async function loadDashboardSettings() {
  try {
    dashboard = await api("/api/settings/dashboard");
    applyDashboardVisibility();
  } catch (e) {
  }
}

async function reloadMonth() {
  try {
    const q = `?month=${encodeURIComponent(currentMonth)}`;
    const [tx, daily, cat, budgetSt, catStack] = await Promise.all([
      api(`/api/transactions${q}`),
      api(`/api/stats/daily${q}`),
      api(`/api/stats/category${q}`),
      api(`/api/stats/budget-status${q}`),
      api(`/api/stats/category-stack${q}`),
    ]);
    lastCategoryAgg = cat.items;
    lastCategoryStack = catStack;
    renderSummary(tx.items, budgetSt.totals);
    renderDashboardSnapshot(tx.items);
    renderBudgetTotalBar(budgetSt.totals);
    renderBudgetStatusTable(budgetSt);
    const overSet = new Set(budgetSt.items.filter((r) => r.over).map((r) => r.category));
    renderTable(tx.items, overSet);
    if (dashboard.daily) buildOrUpdateDailyChart(daily.series);
    if (dashboard.category) refreshCategoryChart();
  } catch (e) {
  }
}

let budgetLoadTimeout;
function setTab(name) {
  const panels = ["expenses", "dashboard", "investing", "savings", "budget"];
  panels.forEach((panel) => {
    const node = el(`panel-${panel}`);
    if (!node) return;
    node.hidden = panel !== name;
  });
  document.querySelectorAll(".tab").forEach((btn) => {
    const on = btn.getAttribute("data-tab") === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  
  // Load budget form when switching to budget tab (with debouncing)
  if (name === "budget") {
    clearTimeout(budgetLoadTimeout);
    budgetLoadTimeout = setTimeout(loadBudgetForm, 100);
  } else {
    clearTimeout(budgetLoadTimeout);
  }
}

async function init() {
  chartDefaults();
  setMonthInput();
  setCalendarMonthInput();
  setDashboardMonthInput();
  try {
    await api("/api/health");
  } catch (e) {
    return;
  }
  await loadDashboardSettings();
  await loadCategoryList();
  await loadCreditCards();
  await loadDebts();
  await loadGoals();
  await loadRecurringExpenses();
  await loadIncomeStreams();
  await loadIncomeSettings();
  await loadBudgetForm();
  await reloadMonth();
  loadDashboardData().catch(() => {});
}

function openEdit(t) {
  if (!t) return;
  el("edit-id").value = String(t.id);
  el("edit-amount").value = String(t.amount);
  el("edit-date").value = t.date;
  fillCategorySelect(el("edit-category"), null);
  ensureLegacyOption(el("edit-category"), t.category);
  el("edit-cost_type").value = t.cost_type;
  el("edit-purchase").value = (t.purchase || "").trim();
  el("edit-payment_method").value = t.payment_method || "debit";
  el("edit-credit_card_select").value = t.credit_card || "";
  el("edit-tags").value = t.tags || "";
  el("edit-is_recurring").checked = t.is_recurring || false;
  el("edit-note").value = t.note || "";
  el("dlg-edit").showModal();
}

async function removeTx(id) {
  if (!confirm("Delete this transaction?")) return;
  try {
    await api(`/api/transactions/${id}`, { method: "DELETE" });
    await reloadMonth();
  } catch (e) {
    showFlash(e.message);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch(() => {});

  api("/api/auth/me").then((data) => {
    const badge = el("user-badge");
    if (badge && data && data.username) badge.textContent = data.username;
  }).catch(() => {});

  const btnLogout = el("btn-logout");
  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
      window.location.href = "/login";
    });
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      setTab(tab);
      if (tab === "budget") {
        loadIncomeStreams().catch(() => {});
        loadIncomeSettings().catch(() => {});
        loadBudgetForm().catch(() => {});
      } else if (tab === "dashboard") {
        loadDashboardData().catch(() => {});
      }
    });
  });

  const btnAddIncomeStream = el("btn-add-income-stream");
  if (btnAddIncomeStream) {
    btnAddIncomeStream.addEventListener("click", () => {
      addIncomeStream().catch((e) => showFlash(e.message));
    });
  }

  const btnAddCard = el("btn-add-card");
  if (btnAddCard) {
    btnAddCard.addEventListener("click", () => {
      addCreditCard().catch((e) => showFlash(e.message));
    });
  }

  const btnAddDebt = el("btn-add-debt");
  if (btnAddDebt) {
    btnAddDebt.addEventListener("click", () => {
      addDebt().catch((e) => showFlash(e.message));
    });
  }

  const btnAddGoal = el("btn-add-goal");
  if (btnAddGoal) {
    btnAddGoal.addEventListener("click", () => {
      addGoal().catch((e) => showFlash(e.message));
    });
  }

  const btnAddRecurring = el("btn-add-recurring");
  if (btnAddRecurring) {
    btnAddRecurring.addEventListener("click", () => {
      addRecurringExpense().catch((e) => showFlash(e.message));
    });
  }

  const btnExportJson = el("btn-export-json");
  if (btnExportJson) {
    btnExportJson.addEventListener("click", () => {
      window.location.href = "/api/export/json";
    });
  }

  const btnExportCsv = el("btn-export-csv");
  if (btnExportCsv) {
    btnExportCsv.addEventListener("click", () => {
      window.location.href = "/api/export/csv";
    });
  }

  const btnToggleMobile = el("btn-toggle-mobile");
  if (btnToggleMobile) {
    const applyMobileView = (on) => {
      document.body.classList.toggle("mobile-view", on);
      btnToggleMobile.title = on ? "Switch to desktop view" : "Switch to mobile view";
      btnToggleMobile.textContent = on ? "🖥️" : "📱";
      localStorage.setItem("mobile-view", on ? "1" : "0");
    };
    applyMobileView(localStorage.getItem("mobile-view") === "1");
    btnToggleMobile.addEventListener("click", () => {
      applyMobileView(!document.body.classList.contains("mobile-view"));
    });
  }

  // Bottom nav — mirrors the top tab behaviour
  document.querySelectorAll(".bottom-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.dataset.tab;
      // activate the matching top tab to reuse existing tab logic
      const topTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
      if (topTab) topTab.click();
      // sync active state on bottom nav
      document.querySelectorAll(".bottom-nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // Keep bottom nav in sync when top tabs are clicked
  document.querySelectorAll(".tab[data-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;
      document.querySelectorAll(".bottom-nav-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.tab === tabName);
      });
    });
  });

  const btnImportJson = el("btn-import-json");
  const fileImportJson = el("file-import-json");
  if (btnImportJson && fileImportJson) {
    btnImportJson.addEventListener("click", () => fileImportJson.click());
    fileImportJson.addEventListener("change", async () => {
      const file = fileImportJson.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        btnImportJson.disabled = true;
        btnImportJson.textContent = "Importing…";
        const result = await api("/api/import/json", {
          method: "POST",
          body: JSON.stringify(json),
        });
        const c = result.imported || {};
        showFlash(`Imported: ${c.transactions||0} transactions, ${c.income_streams||0} income streams, ${c.credit_cards||0} cards, ${c.debts||0} debts, ${c.savings_goals||0} goals.`);
        await reloadMonth();
        await loadCategoryList();
      } catch (e) {
        showFlash("Import failed: " + e.message);
      } finally {
        btnImportJson.disabled = false;
        btnImportJson.textContent = "Import Data (JSON)";
        fileImportJson.value = "";
      }
    });
  }

  const btnPrevDash = el("btn-prev-dash");
  if (btnPrevDash) {
    btnPrevDash.addEventListener("click", () => {
      const [year, month] = dashboardMonth.split("-").map(Number);
      const newDate = new Date(year, month - 2, 1);
      dashboardMonth = ymFromDate(newDate);
      setDashboardMonthInput();
      loadDashboardData();
    });
  }

  const btnNextDash = el("btn-next-dash");
  if (btnNextDash) {
    btnNextDash.addEventListener("click", () => {
      const [year, month] = dashboardMonth.split("-").map(Number);
      const newDate = new Date(year, month, 1);
      dashboardMonth = ymFromDate(newDate);
      setDashboardMonthInput();
      loadDashboardData();
    });
  }

  const btnTodayDash = el("btn-today-dash");
  if (btnTodayDash) {
    btnTodayDash.addEventListener("click", () => {
      dashboardMonth = ymFromDate(new Date());
      setDashboardMonthInput();
      loadDashboardData();
    });
  }

  const monthInputDash = el("month-input-dash");
  if (monthInputDash) {
    monthInputDash.addEventListener("change", (ev) => {
      dashboardMonth = ev.target.value;
      loadDashboardData();
    });
  }

  const rppDeduction = el("rpp-deduction");
  if (rppDeduction) {
    rppDeduction.addEventListener("change", saveIncomeSettingsWithDebounce);
  }

  const rrspContribution = el("rrsp-contribution");
  if (rrspContribution) {
    rrspContribution.addEventListener("change", saveIncomeSettingsWithDebounce);
  }

  const fhsaContribution = el("fhsa-contribution");
  if (fhsaContribution) {
    fhsaContribution.addEventListener("change", saveIncomeSettingsWithDebounce);
  }

  const takeHomeOverride = el("take-home-override");
  if (takeHomeOverride) {
    takeHomeOverride.addEventListener("change", saveIncomeSettingsWithDebounce);
  }

  const toggle503020 = el("toggle-503020");
  if (toggle503020) {
    toggle503020.addEventListener("change", (ev) => {
      show503020Rule = ev.target.checked;
      el("rule-503020-banner").style.display = show503020Rule ? "grid" : "none";
      calculateIncomeSummary();
    });
  }

  const searchTx = el("search-tx");
  if (searchTx) {
    searchTx.addEventListener("input", () => {
      renderTable(allTransactions, lastBudgetStatus);
    });
  }

  const filterCategory = el("filter-category");
  if (filterCategory) {
    filterCategory.addEventListener("change", () => {
      renderTable(allTransactions, lastBudgetStatus);
    });
  }

  const filterPayment = el("filter-payment");
  if (filterPayment) {
    filterPayment.addEventListener("change", () => {
      renderTable(allTransactions, lastBudgetStatus);
    });
  }

  const btnSortDate = el("btn-sort-date");
  if (btnSortDate) {
    btnSortDate.addEventListener("click", () => {
      txSortDirection = txSortDirection === "asc" ? "desc" : "asc";
      renderTable(allTransactions, lastBudgetStatus);
    });
  }

  const btnPrevCal = el("btn-prev-cal");
  if (btnPrevCal) {
    btnPrevCal.addEventListener("click", () => {
      const [year, month] = calendarMonth.split("-").map(Number);
      const newDate = new Date(year, month - 2, 1);
      calendarMonth = ymFromDate(newDate);
      setCalendarMonthInput();
      loadCalendarData();
    });
  }

  const btnNextCal = el("btn-next-cal");
  if (btnNextCal) {
    btnNextCal.addEventListener("click", () => {
      const [year, month] = calendarMonth.split("-").map(Number);
      const newDate = new Date(year, month, 1);
      calendarMonth = ymFromDate(newDate);
      setCalendarMonthInput();
      loadCalendarData();
    });
  }

  const btnTodayCal = el("btn-today-cal");
  if (btnTodayCal) {
    btnTodayCal.addEventListener("click", () => {
      calendarMonth = ymFromDate(new Date());
      setCalendarMonthInput();
      loadCalendarData();
    });
  }

  const monthInputCal = el("month-input-cal");
  if (monthInputCal) {
    monthInputCal.addEventListener("change", (ev) => {
      calendarMonth = ev.target.value;
      loadCalendarData();
    });
  }

  const dlgCloseDay = el("dlg-close-day");
  if (dlgCloseDay) {
    dlgCloseDay.addEventListener("click", () => {
      el("dlg-day-details").close();
    });
  }

  const toggleCategoryStack = el("toggle-category-stack");
  if (toggleCategoryStack) {
    toggleCategoryStack.addEventListener("change", () => {
      refreshCategoryChart();
      refreshChartsSize();
    });
  }

  const btnSaveBudget = el("btn-save-budget");
  if (btnSaveBudget) {
    btnSaveBudget.addEventListener("click", () => {
      saveBudget()
        .then(() => reloadMonth())
        .catch((e) => showFlash(e.message));
    });
  }

  const monthInput = el("month-input");
  if (monthInput) {
    monthInput.addEventListener("change", (ev) => {
      currentMonth = ev.target.value;
      reloadMonth()
        .then(() => {
          renderIncomeStreams();
          calculateIncomeSummary();
        })
        .catch((e) => showFlash(e.message));
    });
  }

  const btnPrev = el("btn-prev");
  if (btnPrev) {
    btnPrev.addEventListener("click", () => {
      currentMonth = shiftMonth(currentMonth, -1);
      setMonthInput();
      reloadMonth()
        .then(() => {
          renderIncomeStreams();
          calculateIncomeSummary();
        })
        .catch((e) => showFlash(e.message));
    });
  }

  const btnNext = el("btn-next");
  if (btnNext) {
    btnNext.addEventListener("click", () => {
      currentMonth = shiftMonth(currentMonth, 1);
      setMonthInput();
      reloadMonth()
        .then(() => {
          renderIncomeStreams();
          calculateIncomeSummary();
        })
        .catch((e) => showFlash(e.message));
    });
  }

  const btnToday = el("btn-today");
  if (btnToday) {
    btnToday.addEventListener("click", () => {
      currentMonth = ymFromDate(new Date());
      setMonthInput();
      reloadMonth()
        .then(() => {
          renderIncomeStreams();
          calculateIncomeSummary();
        })
        .catch((e) => showFlash(e.message));
    });
  }

  const dashToggles = el("dash-toggles");
  if (dashToggles) {
    dashToggles.addEventListener("change", (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLInputElement) || !t.matches("[data-widget]")) return;
      const key = t.getAttribute("data-widget");
      saveDashboardPartial({ [key]: t.checked });
      reloadMonth().catch((e) => showFlash(e.message));
    });
  }

  const formAdd = el("form-add");
  if (formAdd) {
    formAdd.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const selectedCard = el("credit_card_select").value;
      const payload = {
        amount: Number(el("amount").value),
        date: el("date").value,
        category: el("category").value,
        purchase: el("purchase").value,
        cost_type: el("cost_type").value,
        payment_method: el("payment_method").value,
        credit_card: selectedCard || null,
        tags: el("tags").value || null,
        is_recurring: el("is_recurring").checked,
        note: el("note").value,
      };
      try {
        await api("/api/transactions", { method: "POST", body: JSON.stringify(payload) });
        lastTransactionDate = payload.date;
        el("form-add").reset();
        setMonthInput();
        fillCategorySelect(el("category"), "Groceries");
        if (lastTransactionDate) {
          el("date").value = lastTransactionDate;
        }
        await reloadMonth();
      } catch (e) {
        showFlash(e.message);
      }
    });
  }

  const dlg = el("dlg-edit");
  const dlgClose = el("dlg-close");
  if (dlg && dlgClose) {
    dlgClose.addEventListener("click", () => dlg.close());
  }

  const formEdit = el("form-edit");
  if (formEdit) {
    formEdit.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = el("edit-id").value;
      const selectedCard = el("edit-credit_card_select").value;
      const payload = {
        amount: Number(el("edit-amount").value),
        date: el("edit-date").value,
        category: el("edit-category").value,
        purchase: el("edit-purchase").value,
        cost_type: el("edit-cost_type").value,
        payment_method: el("edit-payment_method").value,
        credit_card: selectedCard || null,
        tags: el("edit-tags").value || null,
        is_recurring: el("edit-is_recurring").checked,
        note: el("edit-note").value,
      };
      try {
        await api(`/api/transactions/${id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        dlg.close();
        await reloadMonth();
      } catch (e) {
        showFlash(e.message);
      }
    });
  }

  const dlgRecurring = el("dlg-recurring");
  const formRecurring = el("form-recurring");
  const dlgCloseRecurring = el("dlg-close-recurring");
  if (dlgRecurring && formRecurring && dlgCloseRecurring) {
    dlgCloseRecurring.addEventListener("click", () => dlgRecurring.close());
    formRecurring.addEventListener("submit", submitRecurringExpense);
  }

  const dlgCategory = el("dlg-category");
  const formCategory = el("form-category");
  const dlgCloseCategory = el("dlg-close-category");
  if (dlgCategory && formCategory && dlgCloseCategory) {
    dlgCloseCategory.addEventListener("click", () => dlgCategory.close());
    formCategory.addEventListener("submit", submitCustomCategory);
  }

  const themeSelector = el("theme-selector");
  if (themeSelector) {
    themeSelector.addEventListener("change", (ev) => {
      setTheme(ev.target.value);
    });
  }

  const btnAddCategory = el("btn-add-category");
  if (btnAddCategory) {
    btnAddCategory.addEventListener("click", addCustomCategory);
  }

  loadTheme();
});
// Force rebuild Mon Jun  8 01:51:09 EDT 2026
// Deploy Mon Jun  8 02:20:22 EDT 2026
