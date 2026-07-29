// UI controller — Cyprus 60-day calculator
(function () {
  "use strict";

  const { calculateCyprusResidency, SAMPLES } = window.CyprusCalc;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const tripsBody = $("#trips-body");
  const resultsSection = $("#results");
  let currentResult = null;

  // -------- Trip rows --------
  let nextRowId = 0;

  function makeRow(trip = {}) {
    const id = ++nextRowId;
    const tr = document.createElement("tr");
    tr.dataset.rowId = String(id);
    tr.setAttribute("data-testid", `trip-row-${id}`);
    tr.innerHTML = `
      <td>
        <input type="text" class="trip-country" placeholder="Cyprus / Russia / Greece"
          value="${escapeAttr(trip.trip_country || "")}"
          data-testid="input-trip-country-${id}" />
      </td>
      <td>
        <input type="date" class="trip-arrival"
          value="${escapeAttr(trip.date_arrival || "")}"
          data-testid="input-trip-arrival-${id}" />
      </td>
      <td>
        <input type="date" class="trip-departure"
          value="${escapeAttr(trip.date_departure || "")}"
          data-testid="input-trip-departure-${id}" />
      </td>
      <td>
        <select class="trip-day-type" data-testid="select-trip-day-type-${id}">
          <option value="stay" ${trip.day_type === "stay" || !trip.day_type ? "selected" : ""}>пребывание</option>
          <option value="transit" ${trip.day_type === "transit" ? "selected" : ""}>транзит</option>
          <option value="unknown" ${trip.day_type === "unknown" ? "selected" : ""}>не знаю</option>
        </select>
      </td>
      <td class="trip-days-cell">
        <span class="trip-counted-days" data-testid="trip-counted-days-${id}">не рассчитано</span>
      </td>
      <td>
        <input type="text" class="trip-comment" placeholder="комментарий"
          value="${escapeAttr(trip.comment || "")}"
          data-testid="input-trip-comment-${id}" />
      </td>
      <td>
        <div class="row-actions">
          <button type="button" class="icon-btn remove-trip"
            aria-label="Удалить поездку"
            data-testid="button-remove-trip-${id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
          </button>
        </div>
      </td>
    `;
    tr.querySelector(".remove-trip").addEventListener("click", () => {
      tr.remove();
      if (!tripsBody.querySelector("tr")) makeRow();
    });
    tripsBody.appendChild(tr);
    return tr;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeHtml(s) { return escapeAttr(s); }

  function clearTrips() {
    tripsBody.innerHTML = "";
    nextRowId = 0;
  }

  function getTripsFromUI() {
    return Array.from(tripsBody.querySelectorAll("tr")).map((tr) => ({
      trip_country: tr.querySelector(".trip-country").value.trim(),
      date_arrival: tr.querySelector(".trip-arrival").value.trim(),
      date_departure: tr.querySelector(".trip-departure").value.trim(),
      day_type: tr.querySelector(".trip-day-type").value,
      comment: tr.querySelector(".trip-comment").value.trim(),
    })).filter((t) => t.trip_country || t.date_arrival || t.date_departure || t.comment);
  }

  function getActiveTripRows() {
    return Array.from(tripsBody.querySelectorAll("tr")).filter((tr) => {
      const country = tr.querySelector(".trip-country").value.trim();
      const arrival = tr.querySelector(".trip-arrival").value.trim();
      const departure = tr.querySelector(".trip-departure").value.trim();
      const comment = tr.querySelector(".trip-comment").value.trim();
      return country || arrival || departure || comment;
    });
  }

  function resetTripDayCells() {
    $$(".trip-counted-days").forEach((el) => {
      el.textContent = "не рассчитано";
      el.classList.remove("is-zero", "is-positive", "is-invalid");
    });
  }

  function getSettingsFromUI() {
    return {
      arrival_day_counts_for_cyprus: $("#set_arrival_cyprus").checked,
      departure_day_counts_for_cyprus: $("#set_departure_cyprus").checked,
      same_day_arrival_departure_counts_for_cyprus: $("#set_same_day_arr_dep_cyprus").checked,
      same_day_departure_return_counts_for_cyprus: $("#set_same_day_dep_ret_cyprus").checked,
      transit_day_counts_for_cyprus: $("#set_transit_cyprus").checked,
      arrival_day_counts_other_countries: $("#set_arrival_other").checked,
      departure_day_counts_other_countries: $("#set_departure_other").checked,
    };
  }

  function getRootFromUI() {
    return {
      tax_year: Number($("#tax_year").value),
      has_cyprus_home: $("#has_cyprus_home").value,
      has_cyprus_business_or_employment_or_directorship: $("#has_cyprus_business_or_employment_or_directorship").value,
      possible_tax_resident_elsewhere: $("#possible_tax_resident_elsewhere").value,
    };
  }

  function buildPayload() {
    return {
      ...getRootFromUI(),
      settings: getSettingsFromUI(),
      trips: getTripsFromUI(),
    };
  }

  // -------- Samples --------
  function loadSample(name) {
    if (name === "clear") {
      clearTrips();
      makeRow();
      resetInlineCountrySummary();
      resetTripDayCells();
      resultsSection.classList.remove("shown");
      currentResult = null;
      return;
    }
    const sample = SAMPLES[name];
    if (!sample) return;
    const p = sample.payload;
    $("#tax_year").value = p.tax_year;
    $("#has_cyprus_home").value = p.has_cyprus_home;
    $("#has_cyprus_business_or_employment_or_directorship").value = p.has_cyprus_business_or_employment_or_directorship;
    $("#possible_tax_resident_elsewhere").value = p.possible_tax_resident_elsewhere;
    clearTrips();
    for (const t of p.trips) makeRow(t);
    runCalc();
  }

  // -------- Calculation + render --------
  function runCalc() {
    const payload = buildPayload();
    const result = calculateCyprusResidency(payload);
    currentResult = result;
    render(result);
  }

  // Map warning/error type → Russian human description
  const WARNING_LABELS = {
    cyprus_days_below_60: (w) => `Минимум 60 дней на Кипре не выполнен — засчитано ${w.cyprus_days} дн.`,
    other_country_over_183_days: (w) => `Есть страна со свыше 183 днями: ${(w.countries || []).map((c) => `${c.country} (${c.days} дн.)`).join(", ")}.`,
    transit_days_present: (w) => `Указаны транзитные дни (${w.count}). По умолчанию они не засчитываются как дни на Кипре — уточни статус у налогового консультанта.`,
    unknown_day_type_present: () => `Есть периоды с типом «не знаю». Их нужно уточнить перед окончательной оценкой.`,
    possible_tax_residency_elsewhere: (w) => `Возможно налоговое резидентство другой страны: «${ynLabel(w.value)}». Это может полностью отменить резидентство Кипра.`,
    cyprus_home_not_confirmed: (w) => `Дом на Кипре не подтверждён: «${ynLabel(w.value)}». Правило 60 дней требует постоянное жильё.`,
    cyprus_business_employment_or_directorship_not_confirmed: (w) => `Бизнес, работа или директорство на Кипре не подтверждены: «${ynLabel(w.value)}». Правило 60 дней требует деловой связи с Кипром.`,
    incomplete_cyprus_data: (w) => `Неполные данные по поездке на Кипр в строке ${w.trip_index + 1}.`,
  };

  const ERROR_LABELS = {
    missing_required_field: (e) => e.trip_index !== undefined
      ? `Поездка ${e.trip_index + 1}: не заполнено обязательное поле «${fieldLabel(e.field)}».`
      : `Не заполнено обязательное поле верхнего уровня: «${fieldLabel(e.field)}».`,
    invalid_tax_year: (e) => `Некорректный налоговый год: «${e.value}». Используй четырёхзначный год.`,
    invalid_date_format: (e) => `Поездка ${e.trip_index + 1}: неверный формат даты (въезд «${e.arrival || "—"}», выезд «${e.departure || "—"}»). Нужен формат YYYY-MM-DD.`,
    departure_before_arrival: (e) => `Поездка ${e.trip_index + 1}: дата выезда «${e.departure}» раньше даты въезда «${e.arrival}».`,
    invalid_day_type: (e) => `Поездка ${e.trip_index + 1}: недопустимый тип дня «${e.day_type}».`,
    unknown_country: (e) => `Поездка ${e.trip_index + 1}: неизвестная или пустая страна «${e.trip_country || "—"}».`,
    overlapping_counted_days: (e) => `Один и тот же день (${e.date}) засчитан в нескольких странах: ${(e.countries || []).join(", ")}. Проверь даты пересекающихся поездок.`,
  };

  const DISPUTED_LABELS = {
    unknown_day_type: (p) => `Поездка ${p.trip_index + 1} (${p.country || "?"}, ${p.date_arrival || "?"} → ${p.date_departure || "?"}) помечена как «не знаю». Уточни тип дня.`,
    overlapping_counted_days: (p) => `${p.date}: пересечение по странам ${(p.countries || []).join(", ")}.`,
    same_day_departure_return_to_cyprus: (p) => `${p.date}: выезд с Кипра и возвращение в тот же день — по умолчанию день не засчитан.`,
  };

  function fieldLabel(f) {
    return {
      tax_year: "налоговый год",
      has_cyprus_home: "дом на Кипре",
      has_cyprus_business_or_employment_or_directorship: "бизнес/работа/директорство на Кипре",
      possible_tax_resident_elsewhere: "возможное резидентство другой страны",
      trip_country: "страна поездки",
      date_arrival: "дата въезда",
      date_departure: "дата выезда",
      day_type: "тип дня",
    }[f] || f;
  }

  function ynLabel(v) {
    return v === "yes" ? "да" : v === "no" ? "нет" : "не знаю";
  }

  const STATUS_LABELS = {
    "likely qualifies": {
      cls: "pass",
      title: "Скорее всего, условия выполнены",
      desc: "Расчётно набрано минимум 60 дней на Кипре, нет страны со свыше 183 днями и базовые контрольные ответы подтверждены. Это предварительная оценка — финальное решение остаётся за налоговым консультантом и Tax Department Кипра.",
      tag: "likely qualifies",
    },
    "likely does not qualify": {
      cls: "fail",
      title: "Скорее всего, условия не выполнены",
      desc: "Не выполнено хотя бы одно из жёстких условий: меньше 60 дней на Кипре или есть другая страна со свыше 183 днями. Проверь даты или обсуди ситуацию с налоговым консультантом.",
      tag: "likely does not qualify",
    },
    "needs tax advisor review": {
      cls: "review",
      title: "Нужна проверка налогового консультанта",
      desc: "Жёсткие условия по дням выполнены, но есть сигналы, которые нельзя закрыть автоматически: ошибки ввода, неподтверждённый дом или деловая связь с Кипром, возможное резидентство другой страны или спорные периоды.",
      tag: "needs tax advisor review",
    },
  };

  function render(result) {
    resultsSection.classList.add("shown");

    // KPIs
    $("[data-testid=kpi-cyprus-days]").textContent = result.cyprus_days;
    const sub = result.cyprus_days >= 60
      ? `≥ 60 дн. — условие выполнено`
      : `до 60 дн. не хватает ${60 - result.cyprus_days}`;
    $("[data-testid=kpi-cyprus-days-sub]").textContent = sub;

    $("[data-testid=kpi-cyprus-60]").textContent = result.cyprus_days_at_least_60;
    $("[data-testid=kpi-cyprus-183]").textContent = result.cyprus_days_over_183;
    $("[data-testid=kpi-other-183]").textContent = result.any_other_country_days_over_183;

    const maxOther = result.max_other_country;
    $("[data-testid=kpi-max-other-sub]").textContent = maxOther.country
      ? `максимум: ${maxOther.country} — ${maxOther.days} дн.`
      : "страна с максимумом дней — нет";

    // Status
    const statusInfo = STATUS_LABELS[result.preliminary_status] || STATUS_LABELS["needs tax advisor review"];
    const statusCard = $("#status-card");
    statusCard.classList.remove("pass", "fail", "review");
    statusCard.classList.add(statusInfo.cls);
    $("[data-testid=status-title]").textContent = statusInfo.title;
    $("[data-testid=status-desc]").textContent = statusInfo.desc;
    $("[data-testid=status-tag]").textContent = statusInfo.tag;

    renderTripDayCells(result);
    renderInlineCountrySummary(result);

    // Country breakdown
    const countryBody = $("#country-body");
    countryBody.innerHTML = "";
    if (result.country_day_breakdown.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="3"><div class="empty">Нет рассчитанных стран. Добавь хотя бы одну корректную поездку.</div></td>`;
      countryBody.appendChild(tr);
    } else {
      for (const entry of result.country_day_breakdown) {
        const isCyprus = entry.country === "Cyprus";
        const isOver183 = !isCyprus && entry.days > 183;
        const tr = document.createElement("tr");
        tr.className = `country-row ${isCyprus ? "cyprus" : ""} ${isOver183 ? "over-183" : ""}`.trim();
        tr.setAttribute("data-testid", `country-row-${entry.country}`);
        const periodsHtml = entry.periods.length === 0
          ? "<span class='periods-list'>—</span>"
          : `<ul class="periods-list periods-list-nested">
              ${entry.periods.map((p) =>
                `<li>${escapeHtml(p.date_arrival)} → ${escapeHtml(p.date_departure)} · ${dayTypeLabel(p.day_type)} · <strong>${p.counted_days}</strong>&nbsp;дн.${p.comment ? ` · ${escapeHtml(p.comment)}` : ""}</li>`
              ).join("")}
            </ul>`;
        tr.innerHTML = `
          <td data-testid="country-name-${entry.country}">${escapeHtml(entry.country)}${isCyprus ? " <span class='jurisdiction-note'>(целевая юрисдикция)</span>" : ""}</td>
          <td class="num" data-testid="country-days-${entry.country}">${entry.days}</td>
          <td>${periodsHtml}</td>
        `;
        countryBody.appendChild(tr);
      }
    }

    // Warnings + errors + disputed periods
    const list = $("#warnings-list");
    list.innerHTML = "";

    // Errors first (red)
    for (const e of result.errors) {
      const label = (ERROR_LABELS[e.type] && ERROR_LABELS[e.type](e)) || `Ошибка: ${e.type}`;
      const li = document.createElement("li");
      li.className = "warning-item error";
      li.setAttribute("data-testid", `warning-error-${e.type}`);
      li.textContent = `Ошибка ввода: ${label}`;
      list.appendChild(li);
    }

    // Warnings
    for (const w of result.warnings) {
      const label = (WARNING_LABELS[w.type] && WARNING_LABELS[w.type](w)) || w.type;
      const li = document.createElement("li");
      const cls = w.type === "transit_days_present" ? "transit" : "";
      li.className = `warning-item ${cls}`.trim();
      li.setAttribute("data-testid", `warning-${w.type}`);
      li.textContent = label;
      list.appendChild(li);
    }

    // Disputed periods (collapse duplicates already handled in calc; show as info)
    for (const p of result.disputed_or_incomplete_periods) {
      const label = (DISPUTED_LABELS[p.reason] && DISPUTED_LABELS[p.reason](p)) || `Спорный период: ${p.reason}`;
      const li = document.createElement("li");
      li.className = "warning-item info";
      li.setAttribute("data-testid", `disputed-${p.reason}`);
      li.textContent = label;
      list.appendChild(li);
    }

    if (result.errors.length === 0 && result.warnings.length === 0 && result.disputed_or_incomplete_periods.length === 0) {
      const li = document.createElement("li");
      li.className = "warning-item info";
      li.setAttribute("data-testid", "no-warnings");
      li.textContent = "Автоматических предупреждений и ошибок не найдено. Это не отменяет необходимость финальной проверки у налогового консультанта.";
      list.appendChild(li);
    }

    $("#consultant-report").textContent = buildConsultantReport(result);
    $("#copy-state").textContent = "";

    // Scroll into view (nice UX) — but only when triggered by user
    if (!window._suppressScroll) {
      resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function dayTypeLabel(t) {
    return t === "stay" ? "пребывание" : t === "transit" ? "транзит" : "не знаю";
  }

  function renderTripDayCells(result) {
    const activeRows = getActiveTripRows();
    const byIndex = new Map(result.trips_table.map((trip) => [trip.trip_index, trip]));
    activeRows.forEach((tr, index) => {
      const cell = tr.querySelector(".trip-counted-days");
      if (!cell) return;
      const trip = byIndex.get(index);
      const days = trip?.valid ? trip.counted_days : 0;
      cell.textContent = trip?.valid ? `${days} дн.` : "ошибка";
      cell.classList.remove("is-zero", "is-positive", "is-invalid");
      cell.classList.add(trip?.valid ? (days > 0 ? "is-positive" : "is-zero") : "is-invalid");
    });
  }

  function resetInlineCountrySummary() {
    const chips = $("#inline-country-chips");
    if (chips) chips.innerHTML = `<span class="empty-chip">Пока нет расчёта</span>`;
  }

  function renderInlineCountrySummary(result) {
    const chips = $("#inline-country-chips");
    if (!chips) return;
    if (!result.country_day_breakdown.length) {
      chips.innerHTML = `<span class="empty-chip">Нет рассчитанных стран</span>`;
      return;
    }
    chips.innerHTML = result.country_day_breakdown.map((entry) => {
      const cls = entry.country === "Cyprus" ? "country-chip cyprus" : entry.days > 183 ? "country-chip risk" : "country-chip";
      return `<span class="${cls}" data-testid="inline-country-${escapeAttr(entry.country)}"><b>${escapeHtml(entry.country)}</b><span>${entry.days} дн.</span></span>`;
    }).join("");
  }

  function buildConsultantReport(result) {
    const generatedAt = new Date().toLocaleString("ru-RU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    const lines = [];
    lines.push("ОТЧЁТ ДЛЯ НАЛОГОВОГО КОНСУЛЬТАНТА");
    lines.push("Cyprus tax residency / 60-day rule");
    lines.push("");
    lines.push(`Дата формирования: ${generatedAt}`);
    lines.push(`Налоговый год: ${result.tax_year}`);
    lines.push("");
    lines.push("Дисклеймер:");
    lines.push("Это расчётный помощник и чек-лист. Отчёт не является юридическим или налоговым заключением и не заменяет консультацию квалифицированного налогового консультанта.");
    lines.push("");
    lines.push("Итог расчёта:");
    lines.push(`- Дней на Кипре: ${result.cyprus_days}`);
    lines.push(`- Минимум 60 дней на Кипре выполнен: ${result.cyprus_days_at_least_60}`);
    lines.push(`- Более 183 дней на Кипре: ${result.cyprus_days_over_183}`);
    lines.push(`- Есть другая страна с более чем 183 днями: ${result.any_other_country_days_over_183}`);
    lines.push(`- Максимум в другой стране: ${result.max_other_country.country || "нет"} (${result.max_other_country.days} дн.)`);
    lines.push(`- Предварительный статус: ${result.preliminary_status}`);
    lines.push("");
    lines.push("Контрольные условия:");
    lines.push(`- Постоянное жильё на Кипре: ${result.permanent_home_in_cyprus}`);
    lines.push(`- Бизнес, работа или директорство на Кипре: ${result.business_employment_or_directorship_in_cyprus}`);
    lines.push(`- Возможное налоговое резидентство другой страны: ${result.possible_tax_residency_elsewhere}`);
    lines.push("");
    lines.push("Настройки подсчёта дней:");
    lines.push(`- День прибытия на Кипр считается днём на Кипре: ${boolRu(result.settings_used.arrival_day_counts_for_cyprus)}`);
    lines.push(`- День выезда с Кипра считается днём на Кипре: ${boolRu(result.settings_used.departure_day_counts_for_cyprus)}`);
    lines.push(`- Прибытие и выезд с Кипра в тот же день считается днём на Кипре: ${boolRu(result.settings_used.same_day_arrival_departure_counts_for_cyprus)}`);
    lines.push(`- Выезд с Кипра и возвращение в тот же день считается днём на Кипре: ${boolRu(result.settings_used.same_day_departure_return_counts_for_cyprus)}`);
    lines.push(`- Транзитный день на Кипре засчитывается: ${boolRu(result.settings_used.transit_day_counts_for_cyprus)}`);
    lines.push(`- День прибытия в другие страны считается: ${boolRu(result.settings_used.arrival_day_counts_other_countries)}`);
    lines.push(`- День выезда из других стран считается: ${boolRu(result.settings_used.departure_day_counts_other_countries)}`);
    lines.push("");
    lines.push("Поездки:");
    if (result.trips_table.length === 0) {
      lines.push("- Нет введённых поездок.");
    } else {
      for (const trip of result.trips_table) {
        lines.push(`- ${trip.trip_index + 1}. ${trip.country || "?"}: ${trip.date_arrival || "?"} -> ${trip.date_departure || "?"}, тип: ${dayTypeLabel(trip.day_type)}, валидно: ${trip.valid ? "да" : "нет"}${trip.comment ? `, комментарий: ${trip.comment}` : ""}`);
      }
    }
    lines.push("");
    lines.push("Разбивка по странам:");
    if (result.country_day_breakdown.length === 0) {
      lines.push("- Нет рассчитанных стран.");
    } else {
      for (const entry of result.country_day_breakdown) {
        lines.push(`- ${entry.country}: ${entry.days} дн.`);
        for (const period of entry.periods) {
          lines.push(`  * ${period.date_arrival} -> ${period.date_departure}, ${dayTypeLabel(period.day_type)}, засчитано ${period.counted_days} дн.${period.comment ? `, ${period.comment}` : ""}`);
        }
      }
    }
    lines.push("");
    lines.push("Предупреждения:");
    if (result.warnings.length === 0) {
      lines.push("- Автоматических предупреждений нет.");
    } else {
      for (const warning of result.warnings) {
        const label = (WARNING_LABELS[warning.type] && WARNING_LABELS[warning.type](warning)) || warning.type;
        lines.push(`- ${label}`);
      }
    }
    lines.push("");
    lines.push("Ошибки ввода:");
    if (result.errors.length === 0) {
      lines.push("- Ошибок ввода нет.");
    } else {
      for (const error of result.errors) {
        const label = (ERROR_LABELS[error.type] && ERROR_LABELS[error.type](error)) || error.type;
        lines.push(`- ${label}`);
      }
    }
    lines.push("");
    lines.push("Спорные или неполные периоды:");
    if (result.disputed_or_incomplete_periods.length === 0) {
      lines.push("- Спорных или неполных периодов не найдено автоматически.");
    } else {
      for (const period of result.disputed_or_incomplete_periods) {
        const label = (DISPUTED_LABELS[period.reason] && DISPUTED_LABELS[period.reason](period)) || period.reason;
        lines.push(`- ${label}`);
      }
    }
    lines.push("");
    lines.push("Источники по правилу подсчёта дней:");
    lines.push("- PwC Worldwide Tax Summaries, Cyprus - Individual Residence: https://taxsummaries.pwc.com/cyprus/individual/residence");
    lines.push("- Constantinos Markou & Co, Cyprus Tax Residency: https://www.cmarkou.com/tax/cyprus-tax-residency/");
    return lines.join("\n");
  }

  function boolRu(value) {
    return value ? "да" : "нет";
  }

  async function copyReport() {
    if (!currentResult) runCalc();
    const text = $("#consultant-report").textContent;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      $("#copy-state").textContent = "Отчёт скопирован в буфер обмена.";
    } catch (err) {
      $("#copy-state").textContent = "Не удалось скопировать автоматически. Выдели текст отчёта и скопируй вручную.";
    }
  }

  function printReport() {
    if (!currentResult) runCalc();
    const reportText = $("#consultant-report").textContent || "";
    const year = currentResult?.tax_year || $("#tax_year").value || "report";
    const html = buildPrintableHtml(reportText, year);
    const printWindow = window.open("", "_blank", "width=920,height=1000");

    if (printWindow) {
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();
      $("#copy-state").textContent = "Открыла отдельное окно печати. В диалоге браузера выбери «Сохранить как PDF».";
      printWindow.focus();
      setTimeout(() => {
        try {
          printWindow.print();
        } catch (err) {
          downloadPrintableHtml(html, year);
        }
      }, 350);
      return;
    }

    downloadPrintableHtml(html, year);
    $("#copy-state").textContent = "Браузер заблокировал окно печати. Я скачала HTML-отчёт, его можно открыть и сохранить как PDF.";
  }

  function buildPrintableHtml(reportText, year) {
    const generatedAt = new Date().toLocaleString("ru-RU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cyprus 60-Day Report ${escapeHtml(year)}</title>
  <style>
    @page { margin: 16mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #f4f6f6;
      color: #142326;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      line-height: 1.45;
    }
    .sheet {
      max-width: 840px;
      margin: 0 auto;
      padding: 28px;
      background: #ffffff;
      border: 1px solid #d7dddd;
      box-shadow: 0 18px 48px rgba(20, 35, 38, 0.08);
    }
    .document-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 24px;
      border-bottom: 2px solid #102a2e;
      padding-bottom: 16px;
      margin-bottom: 16px;
    }
    .brand {
      color: #102a2e;
      font-size: 16px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .brand small {
      display: block;
      margin-top: 3px;
      color: #5b6b70;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .doc-ref {
      text-align: right;
      color: #5b6b70;
      font-size: 10px;
      line-height: 1.5;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 21px;
      line-height: 1.15;
      color: #102a2e;
    }
    .subtitle {
      margin: 0 0 18px;
      color: #5b6b70;
      font-size: 12px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border: 1px solid #d7dddd;
      margin: 0 0 18px;
    }
    .meta-item {
      min-height: 56px;
      padding: 10px 12px;
      border-right: 1px solid #d7dddd;
      background: #fbfcfc;
    }
    .meta-item:last-child { border-right: none; }
    .meta-item b {
      display: block;
      margin-bottom: 4px;
      color: #102a2e;
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .meta-item span {
      color: #374b50;
      font-weight: 700;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      padding: 16px 18px;
      border: 1px solid #d7dddd;
      border-left: 4px solid #0b6f78;
      background: #ffffff;
      color: #142326;
      font-size: 11.5px;
      line-height: 1.5;
    }
    .actions {
      margin: 0 0 18px;
      padding: 10px 12px;
      border: 1px solid #d8d8d8;
      background: #f7f9f9;
      color: #53676a;
    }
    .footer-note {
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px solid #d7dddd;
      color: #69787c;
      font-size: 10px;
    }
    @media print {
      body { background: #ffffff; }
      .actions { display: none; }
      .sheet { padding: 0; border: none; box-shadow: none; }
    }
  </style>
</head>
<body>
  <main class="sheet">
    <header class="document-header">
      <div class="brand">Denis<small>Cyprus 60-Day Calculator</small></div>
      <div class="doc-ref">Tax year: ${escapeHtml(year)}<br>Generated: ${escapeHtml(generatedAt)}<br>Status: preliminary</div>
    </header>
    <h1>Tax Residency Calculation Memo</h1>
    <p class="subtitle">Working paper for Cyprus 60-day rule review. Deterministic day-count calculation, not legal or tax advice.</p>
    <section class="meta-grid" aria-label="Document metadata">
      <div class="meta-item"><b>Document type</b><span>Consultant memo</span></div>
      <div class="meta-item"><b>Method</b><span>Deterministic count</span></div>
      <div class="meta-item"><b>Review status</b><span>Advisor review required</span></div>
    </section>
    <div class="actions">Если диалог печати не открылся автоматически, нажми Ctrl+P или Cmd+P и выбери «Сохранить как PDF».</div>
    <pre>${escapeHtml(reportText)}</pre>
    <div class="footer-note">This report is a calculation aid and checklist. Final tax residency assessment should be confirmed by a qualified Cyprus tax adviser.</div>
  </main>
</body>
</html>`;
  }

  function downloadPrintableHtml(html, year) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cyprus-60-day-report-${year}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------- Event wiring --------
  $$(".sample-btn").forEach((btn) => {
    btn.addEventListener("click", () => loadSample(btn.dataset.sample));
  });

  $("#add-trip").addEventListener("click", () => makeRow());

  $("#calculate").addEventListener("click", () => {
    window._suppressScroll = false;
    runCalc();
    scheduleAutosave({ immediate: true });
  });

  // Trigger autosave whenever the user edits trip rows (inputs/selects inside
  // the body). Delegated so newly added rows are covered.
  tripsBody.addEventListener("input", () => scheduleAutosave());
  tripsBody.addEventListener("change", () => scheduleAutosave());

  $("#copy-report").addEventListener("click", copyReport);
  $("#print-report").addEventListener("click", printReport);

  // -------- Server sync (no localStorage / sessionStorage / indexedDB) -------
  //
  // There is exactly one trip list, and it lives on the server. The browser
  // sends no identifier at all: /api/default-draft resolves the shared profile
  // server-side, so opening the bare URL on any device shows the same trips and
  // no access code is ever present in this file or in a link.
  //
  // The only cookie this app can hold is the httpOnly session set by the server
  // when APP_ACCESS_PASSWORD is configured, which JS cannot read.
  const AUTOSAVE_DEBOUNCE_MS = 1000;

  let autosaveTimer = null;
  let lastAutosaveSig = "";
  let lastSavedAt = null;
  // Suppress autosave while we programmatically populate the form (samples,
  // server load). Otherwise loading a draft would immediately re-save it.
  let suppressAutosave = false;
  // Autosave stays disarmed until we know what the server holds. Saving before
  // the initial load resolves would POST the blank startup form over the stored
  // list and destroy the user's trips.
  let autosaveArmed = false;

  function getTaxYear() {
    const n = Number($("#tax_year").value);
    return Number.isInteger(n) ? n : null;
  }

  function scheduleAutosave(opts = {}) {
    if (suppressAutosave) return;
    if (!autosaveArmed) return;
    if (!getTaxYear()) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    const delay = opts.immediate ? 0 : AUTOSAVE_DEBOUNCE_MS;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      const payload = buildPayload();
      const sig = JSON.stringify(payload);
      if (sig === lastAutosaveSig) return;
      lastAutosaveSig = sig;
      cloudSave({ autosave: true });
    }, delay);
  }

  function setCloudStatus(kind, message) {
    const wrap = $("#cloud-status");
    if (!wrap) return;
    wrap.classList.remove("status-idle", "status-busy", "status-ok", "status-info", "status-error");
    wrap.classList.add(`status-${kind}`);
    const textEl = wrap.querySelector(".cloud-status-text");
    if (textEl) textEl.textContent = message;
  }

  function refreshAdvancedPanel() {
    const yearEl = $("#cloud-year-display");
    if (yearEl) yearEl.textContent = getTaxYear() ?? "—";
    const stampEl = $("#cloud-last-saved");
    if (stampEl) stampEl.textContent = lastSavedAt ? formatStamp(lastSavedAt) : "пока не было";
  }

  function applyPayloadToUI(p) {
    if (!p || typeof p !== "object") return;
    suppressAutosave = true;
    if (p.tax_year !== undefined && p.tax_year !== null) {
      $("#tax_year").value = String(p.tax_year);
    }
    if (p.has_cyprus_home) $("#has_cyprus_home").value = p.has_cyprus_home;
    if (p.has_cyprus_business_or_employment_or_directorship) {
      $("#has_cyprus_business_or_employment_or_directorship").value = p.has_cyprus_business_or_employment_or_directorship;
    }
    if (p.possible_tax_resident_elsewhere) {
      $("#possible_tax_resident_elsewhere").value = p.possible_tax_resident_elsewhere;
    }
    const s = p.settings || {};
    const settingMap = {
      arrival_day_counts_for_cyprus: "#set_arrival_cyprus",
      departure_day_counts_for_cyprus: "#set_departure_cyprus",
      same_day_arrival_departure_counts_for_cyprus: "#set_same_day_arr_dep_cyprus",
      same_day_departure_return_counts_for_cyprus: "#set_same_day_dep_ret_cyprus",
      transit_day_counts_for_cyprus: "#set_transit_cyprus",
      arrival_day_counts_other_countries: "#set_arrival_other",
      departure_day_counts_other_countries: "#set_departure_other",
    };
    for (const [k, sel] of Object.entries(settingMap)) {
      if (typeof s[k] === "boolean") $(sel).checked = s[k];
    }
    clearTrips();
    const trips = Array.isArray(p.trips) ? p.trips : [];
    if (trips.length === 0) {
      makeRow();
    } else {
      for (const t of trips) makeRow(t);
    }
    // Sync baseline so the very next user edit triggers a fresh autosave
    // instead of being suppressed as a no-op.
    lastAutosaveSig = JSON.stringify(buildPayload());
    suppressAutosave = false;
  }

  async function cloudLoad() {
    const year = getTaxYear();
    if (!year) {
      setCloudStatus("error", "Налоговый год заполнен некорректно.");
      return;
    }
    setCloudStatus("busy", "Загружаю данные с сервера…");
    try {
      const url = `/api/default-draft?tax_year=${encodeURIComponent(year)}`;
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (res.status === 401 || data.auth_required) {
        showLock("Сессия истекла. Введи пароль ещё раз.");
        return;
      }
      if (!res.ok || !data.ok) {
        setCloudStatus("error", `Не удалось загрузить: ${data.error || res.statusText}. Автосохранение приостановлено, чтобы не затереть сохранённый список — обнови страницу.`);
        return;
      }
      if (!data.found) {
        // Nothing stored for this year yet — the normal empty state. Sit
        // silently in "ready to autosave" mode so the form looks clean.
        lastAutosaveSig = JSON.stringify(buildPayload());
        autosaveArmed = true;
        setCloudStatus("idle", "Автосохранение включено · список хранится на сервере");
        refreshAdvancedPanel();
        return;
      }
      applyPayloadToUI(data.payload);
      window._suppressScroll = true;
      runCalc();
      window._suppressScroll = false;
      lastSavedAt = data.updated_at;
      autosaveArmed = true;
      setCloudStatus("ok", `Загружено с сервера · обновлено ${formatStamp(data.updated_at)}`);
      refreshAdvancedPanel();
    } catch (err) {
      setCloudStatus("error", `Сеть недоступна или сервер не отвечает: ${err.message}. Автосохранение приостановлено, чтобы не затереть сохранённый список — обнови страницу.`);
    }
  }

  async function cloudSave(opts = {}) {
    const payload = buildPayload();
    setCloudStatus("busy", "Сохраняю…");
    try {
      const res = await fetch("/api/default-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ payload }),
      });
      const data = await res.json();
      if (res.status === 401 || data.auth_required) {
        // Disarm: without a session the POST would keep failing, and a later
        // success must not be built on a stale baseline.
        autosaveArmed = false;
        showLock("Сессия истекла. Введи пароль ещё раз.");
        return;
      }
      if (!res.ok || !data.ok) {
        setCloudStatus("error", `Ошибка сохранения: ${data.error || res.statusText}`);
        return;
      }
      lastAutosaveSig = JSON.stringify(payload);
      lastSavedAt = data.updated_at;
      const prefix = opts.autosave ? "Сохранено на сервере" : "Сохранено вручную";
      setCloudStatus("ok", `${prefix} · ${formatStamp(data.updated_at)}`);
      refreshAdvancedPanel();
    } catch (err) {
      setCloudStatus("error", `Ошибка сохранения: сеть недоступна (${err.message})`);
    }
  }

  // Clears the shared list. Deliberately a normal save of an empty payload
  // rather than a delete: the server archives the outgoing list first, so this
  // stays reversible from "Архив поездок".
  async function clearTripList() {
    if (!confirm("Очистить список поездок? Прежний список сохранится в «Архиве поездок», его можно будет вернуть.")) {
      return;
    }
    suppressAutosave = true;
    clearTrips();
    makeRow();
    resetTripDayCells();
    resetInlineCountrySummary();
    resultsSection.classList.remove("shown");
    currentResult = null;
    suppressAutosave = false;
    await cloudSave({});
    if (!$("#cloud-history")?.hasAttribute("hidden")) loadHistory();
  }

  // -------- Version history / restore --------
  //
  // The backend archives the outgoing payload on every draft overwrite, so an
  // accidental clobber is reversible from here instead of needing a DB dig.
  // Everything is rendered with textContent: version summaries echo back trip
  // countries and comments the user typed, which must never become markup.
  const HISTORY_PAGE_SIZE = 20;
  let historyBusy = false;

  function pluralRu(n, one, few, many) {
    const mod100 = Math.abs(n) % 100;
    const mod10 = mod100 % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  function describeVersion(entry) {
    const parts = [`${entry.trip_count} ${pluralRu(entry.trip_count, "поездка", "поездки", "поездок")}`];
    if (entry.countries && entry.countries.length) parts.push(entry.countries.join(", "));
    if (entry.earliest_date && entry.latest_date) {
      parts.push(entry.earliest_date === entry.latest_date
        ? entry.earliest_date
        : `${entry.earliest_date} — ${entry.latest_date}`);
    }
    return parts.join(" · ");
  }

  function setHistoryStatus(message) {
    const el = $("#cloud-history-status");
    if (el) el.textContent = message;
  }

  function historyEntryNode(entry, { current }) {
    const li = document.createElement("li");
    li.className = current ? "cloud-history-item is-current" : "cloud-history-item";
    if (!current) li.dataset.versionId = String(entry.version_id);

    const meta = document.createElement("div");
    meta.className = "cloud-history-meta";

    const when = document.createElement("span");
    when.className = "cloud-history-when";
    const stamp = formatStamp(current ? entry.updated_at : entry.saved_at);
    when.textContent = current ? `Текущая версия · ${stamp}` : stamp;
    meta.appendChild(when);

    const facts = document.createElement("span");
    facts.className = "cloud-history-facts";
    facts.textContent = describeVersion(entry);
    meta.appendChild(facts);

    if (entry.comments_preview && entry.comments_preview.length) {
      const comments = document.createElement("span");
      comments.className = "cloud-history-comments";
      comments.textContent = `Комментарии: ${entry.comments_preview.join("; ")}`;
      meta.appendChild(comments);
    }

    li.appendChild(meta);

    if (!current) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-ghost cloud-history-restore";
      btn.dataset.versionId = String(entry.version_id);
      btn.dataset.when = stamp;
      btn.setAttribute("data-testid", `button-restore-version-${entry.version_id}`);
      btn.textContent = "Восстановить";
      li.appendChild(btn);
    }
    return li;
  }

  function renderHistory(data) {
    const list = $("#cloud-history-list");
    if (!list) return;
    list.textContent = "";
    if (data.current) list.appendChild(historyEntryNode(data.current, { current: true }));
    for (const entry of data.versions) list.appendChild(historyEntryNode(entry, { current: false }));
    if (!data.versions.length) {
      setHistoryStatus(
        data.current
          ? "Предыдущих версий пока нет — черновик ещё не перезаписывался."
          : "В облаке пока нет сохранённого черновика для этого года.",
      );
    } else {
      const shown = data.versions.length;
      const total = data.total_versions;
      const tail = total > shown ? ` (показаны последние ${shown} из ${total})` : "";
      setHistoryStatus(`Доступно версий для восстановления: ${total}${tail}.`);
    }
  }

  async function loadHistory() {
    if (historyBusy) return;
    const year = getTaxYear();
    if (!year) {
      setHistoryStatus("Сначала укажи корректный налоговый год.");
      return;
    }
    historyBusy = true;
    setHistoryStatus("Загружаю архив…");
    try {
      const url = `/api/default-draft/versions?tax_year=${encodeURIComponent(year)}&limit=${HISTORY_PAGE_SIZE}`;
      const res = await fetch(url, { headers: { "Accept": "application/json" } });
      const data = await res.json();
      if (res.status === 401 || data.auth_required) {
        showLock("Сессия истекла. Введи пароль ещё раз.");
        return;
      }
      if (!res.ok || !data.ok) {
        setHistoryStatus(`Не удалось загрузить архив: ${data.error || res.statusText}`);
        return;
      }
      renderHistory(data);
    } catch (err) {
      setHistoryStatus(`Не удалось загрузить архив: сеть недоступна (${err.message})`);
    } finally {
      historyBusy = false;
    }
  }

  async function restoreVersion(versionId, whenLabel) {
    if (historyBusy) return;
    const year = getTaxYear();
    if (!year) return;
    if (!confirm(`Восстановить версию от ${whenLabel}? Текущие данные не потеряются — они уйдут в архив, и их можно будет вернуть обратно.`)) {
      return;
    }
    historyBusy = true;
    setCloudStatus("busy", "Восстанавливаю версию…");
    try {
      const res = await fetch("/api/default-draft/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ tax_year: year, version_id: versionId }),
      });
      const data = await res.json();
      if (res.status === 401 || data.auth_required) {
        showLock("Сессия истекла. Введи пароль ещё раз.");
        return;
      }
      if (!res.ok || !data.ok) {
        setCloudStatus("error", `Не удалось восстановить версию: ${data.error || res.statusText}`);
        return;
      }
      // applyPayloadToUI resyncs the autosave baseline, so hydrating the
      // restored draft does not immediately POST it straight back.
      applyPayloadToUI(data.payload);
      window._suppressScroll = true;
      runCalc();
      window._suppressScroll = false;
      lastSavedAt = data.updated_at;
      // The restore round-trip proves what the server holds, so autosave is
      // safe to arm even if the initial load had failed.
      autosaveArmed = true;
      setCloudStatus("ok", `Восстановлена версия от ${whenLabel} · сохранено ${formatStamp(data.updated_at)}`);
      refreshAdvancedPanel();
    } catch (err) {
      setCloudStatus("error", `Не удалось восстановить версию: сеть недоступна (${err.message})`);
    } finally {
      historyBusy = false;
    }
    loadHistory();
  }

  // -------- Optional password gate --------
  //
  // Only shown when the server reports password_required. The password is
  // posted once and exchanged for an httpOnly cookie this script cannot read,
  // so no credential is ever held in frontend state.

  function showLock(message) {
    const lock = $("#app-lock");
    if (!lock) return;
    autosaveArmed = false;
    lock.removeAttribute("hidden");
    const err = $("#app-lock-error");
    if (err) err.textContent = message || "";
    $("#app-lock-password")?.focus();
  }

  function hideLock() {
    $("#app-lock")?.setAttribute("hidden", "");
    const err = $("#app-lock-error");
    if (err) err.textContent = "";
  }

  async function submitLogin(ev) {
    ev.preventDefault();
    const input = $("#app-lock-password");
    const err = $("#app-lock-error");
    if (!input) return;
    if (err) err.textContent = "";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ password: input.value }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (err) err.textContent = res.status === 429
          ? "Слишком много попыток. Попробуй позже."
          : "Неверный пароль.";
        return;
      }
      input.value = "";
      hideLock();
      cloudLoad();
    } catch (e) {
      if (err) err.textContent = `Сеть недоступна: ${e.message}`;
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "Accept": "application/json" } });
    } catch (_) {
      // Showing the lock is the point; a failed call still ends the session UI.
    }
    showLock("");
  }

  function formatStamp(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("ru-RU", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch (e) {
      return iso;
    }
  }

  $("#app-lock-form")?.addEventListener("submit", submitLogin);
  $("#cloud-logout")?.addEventListener("click", logout);
  $("#cloud-clear-trips")?.addEventListener("click", clearTripList);
  $("#cloud-advanced-toggle")?.addEventListener("click", () => {
    const panel = $("#cloud-advanced");
    const btn = $("#cloud-advanced-toggle");
    if (!panel || !btn) return;
    const open = panel.hasAttribute("hidden");
    if (open) {
      panel.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
      refreshAdvancedPanel();
    } else {
      panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  $("#cloud-history-toggle")?.addEventListener("click", () => {
    const panel = $("#cloud-history");
    const btn = $("#cloud-history-toggle");
    if (!panel || !btn) return;
    if (panel.hasAttribute("hidden")) {
      panel.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
      loadHistory();
    } else {
      panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
    }
  });
  $("#cloud-history-refresh")?.addEventListener("click", () => loadHistory());
  // Delegated: the list is rebuilt on every load.
  $("#cloud-history-list")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".cloud-history-restore");
    if (!btn) return;
    restoreVersion(Number(btn.dataset.versionId), btn.dataset.when || "");
  });

  // Autosave triggers for non-trip controls: tax year, top-level selects,
  // settings checkboxes.
  const autosaveSelectors = [
    "#tax_year",
    "#has_cyprus_home",
    "#has_cyprus_business_or_employment_or_directorship",
    "#possible_tax_resident_elsewhere",
    "#set_arrival_cyprus",
    "#set_departure_cyprus",
    "#set_same_day_arr_dep_cyprus",
    "#set_same_day_dep_ret_cyprus",
    "#set_transit_cyprus",
    "#set_arrival_other",
    "#set_departure_other",
  ];
  for (const sel of autosaveSelectors) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener("input", () => scheduleAutosave());
    el.addEventListener("change", () => scheduleAutosave());
  }

  $("#tax_year")?.addEventListener("input", refreshAdvancedPanel);

  // Initial state: one empty row, then load the shared list.
  makeRow();

  (async function bootstrap() {
    setCloudStatus("busy", "Загружаю список поездок…");
    let status = null;
    try {
      const res = await fetch("/api/auth/status", { headers: { "Accept": "application/json" } });
      status = await res.json();
    } catch (_) {
      // Treat an unreachable status probe as "no password": cloudLoad reports
      // the network failure properly and leaves autosave disarmed.
    }
    if (status && status.password_required) {
      $("#cloud-logout-item")?.removeAttribute("hidden");
      if (!status.authenticated) {
        setCloudStatus("idle", "Требуется вход");
        showLock("");
        return;
      }
    } else {
      $("#cloud-open-warning")?.removeAttribute("hidden");
    }
    cloudLoad();
  })();
})();
