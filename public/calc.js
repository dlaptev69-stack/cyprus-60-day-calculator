// Deterministic Cyprus 60-day rule calculator
// Ported from approved spec — no LLM is used for math.

const COUNTRY_ALIASES = {
  cyprus: "Cyprus", кипр: "Cyprus",
  россия: "Russia", russia: "Russia",
  греция: "Greece", greece: "Greece",
  латвия: "Latvia", latvia: "Latvia",
  турция: "Turkey", turkey: "Turkey",
  uae: "UAE", "united arab emirates": "UAE", оаэ: "UAE",
  германия: "Germany", germany: "Germany",
  испания: "Spain", spain: "Spain",
  италия: "Italy", italy: "Italy",
  франция: "France", france: "France",
  великобритания: "United Kingdom", "united kingdom": "United Kingdom", uk: "United Kingdom",
  сша: "USA", usa: "USA", "united states": "USA",
  израиль: "Israel", israel: "Israel",
  армения: "Armenia", armenia: "Armenia",
  грузия: "Georgia", georgia: "Georgia",
  казахстан: "Kazakhstan", kazakhstan: "Kazakhstan",
  украина: "Ukraine", ukraine: "Ukraine",
  беларусь: "Belarus", belarus: "Belarus",
  польша: "Poland", poland: "Poland",
  португалия: "Portugal", portugal: "Portugal",
  нидерланды: "Netherlands", netherlands: "Netherlands",
  швейцария: "Switzerland", switzerland: "Switzerland",
  австрия: "Austria", austria: "Austria",
  чехия: "Czechia", czechia: "Czechia",
  болгария: "Bulgaria", bulgaria: "Bulgaria",
  румыния: "Romania", romania: "Romania",
  венгрия: "Hungary", hungary: "Hungary",
  сербия: "Serbia", serbia: "Serbia",
  черногория: "Montenegro", montenegro: "Montenegro",
  египет: "Egypt", egypt: "Egypt",
  ливан: "Lebanon", lebanon: "Lebanon",
  иордания: "Jordan", jordan: "Jordan",
  сингапур: "Singapore", singapore: "Singapore",
  таиланд: "Thailand", thailand: "Thailand",
  индия: "India", india: "India",
  китай: "China", china: "China",
  япония: "Japan", japan: "Japan",
};

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || formatDate(date) !== value ? null : date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// -------- Deterministic trip ordering --------
//
// One ordering rule is used everywhere (table, calculation, report, saved cloud
// payload) so the same trip list always looks and calculates the same way:
//   1. ascending by date_arrival,
//   2. then ascending by date_departure,
//   3. then the original relative order (stable) for identical rows.
// Rows with a missing or unparseable date sink to the end while keeping their
// relative order, so a freshly added blank row stays at the bottom instead of
// jumping to the top.
function tripDateKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return parseDate(trimmed) ? trimmed : null;
}

function compareTripsByDate(a, b) {
  const aArrival = tripDateKey(a && a.date_arrival);
  const bArrival = tripDateKey(b && b.date_arrival);
  if (aArrival !== bArrival) {
    if (aArrival === null) return 1;
    if (bArrival === null) return -1;
    // ISO YYYY-MM-DD strings compare lexicographically as they do chronologically.
    return aArrival < bArrival ? -1 : 1;
  }
  const aDeparture = tripDateKey(a && a.date_departure);
  const bDeparture = tripDateKey(b && b.date_departure);
  if (aDeparture !== bDeparture) {
    if (aDeparture === null) return 1;
    if (bDeparture === null) return -1;
    return aDeparture < bDeparture ? -1 : 1;
  }
  return 0;
}

// Returns a new array; the input is never mutated. The explicit index tiebreak
// keeps the result stable regardless of the engine's sort implementation.
function sortTripsByDate(trips) {
  if (!Array.isArray(trips)) return [];
  return trips
    .map((trip, index) => ({ trip, index }))
    .sort((a, b) => compareTripsByDate(a.trip, b.trip) || a.index - b.index)
    .map((entry) => entry.trip);
}

function normalizeCountry(value) {
  if (!value || typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  return COUNTRY_ALIASES[trimmed.toLowerCase()] || trimmed;
}

function eachDate(start, end) {
  if (!start || !end || end < start) return [];
  const dates = [];
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(new Date(cursor));
  }
  return dates;
}

function maxDate(a, b) { return a > b ? a : b; }
function minDate(a, b) { return a < b ? a : b; }

function yesNoUnknown(value) {
  if (value === "yes") return "да";
  if (value === "no") return "нет";
  return "неизвестно";
}

function toPublicPeriod(period, reason) {
  return {
    reason,
    trip_index: period.index,
    country: period.trip_country,
    date_arrival: period.date_arrival,
    date_departure: period.date_departure,
    day_type: period.day_type,
    comment: period.comment,
  };
}

function dedupeObjects(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function calculateCyprusResidency(input) {
  const settings = {
    arrival_day_counts_for_cyprus: true,
    departure_day_counts_for_cyprus: false,
    same_day_arrival_departure_counts_for_cyprus: true,
    same_day_departure_return_counts_for_cyprus: false,
    transit_day_counts_for_cyprus: false,
    arrival_day_counts_other_countries: true,
    departure_day_counts_other_countries: false,
    calendar_year_start: null,
    calendar_year_end: null,
    known_countries: null,
    ...input.settings,
  };

  const taxYear = Number(input.tax_year);
  // Sorted up front so trip_index, the trips table and the report all follow
  // the same chronological order even if the caller passed trips out of order.
  const trips = sortTripsByDate(input.trips);
  const errors = [];
  const warnings = [];
  const disputedPeriods = [];
  const transitDays = [];
  const countryMap = {};
  const countedDaysByTrip = {};

  const requiredRoot = [
    "tax_year",
    "has_cyprus_home",
    "has_cyprus_business_or_employment_or_directorship",
    "possible_tax_resident_elsewhere",
  ];

  for (const field of requiredRoot) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      errors.push({ type: "missing_required_field", field });
    }
  }

  if (!Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 2200) {
    errors.push({ type: "invalid_tax_year", value: input.tax_year });
  }

  const yearStart = parseDate(settings.calendar_year_start || `${taxYear}-01-01`);
  const yearEnd = parseDate(settings.calendar_year_end || `${taxYear}-12-31`);

  const normalizedTrips = trips.map((trip, index) => {
    const country = normalizeCountry(trip.trip_country);
    const arrival = parseDate(trip.date_arrival);
    const departure = parseDate(trip.date_departure);
    const dayType = trip.day_type || "unknown";
    const period = {
      index,
      trip_country: country,
      original_country: trip.trip_country,
      date_arrival: trip.date_arrival,
      date_departure: trip.date_departure,
      day_type: dayType,
      comment: trip.comment || "",
      arrival,
      departure,
      valid: true,
    };

    for (const field of ["trip_country", "date_arrival", "date_departure", "day_type"]) {
      if (trip[field] === undefined || trip[field] === null || trip[field] === "") {
        period.valid = false;
        errors.push({ type: "missing_required_field", trip_index: index, field });
      }
    }

    if (!arrival || !departure) {
      period.valid = false;
      errors.push({
        type: "invalid_date_format",
        trip_index: index,
        arrival: trip.date_arrival,
        departure: trip.date_departure,
      });
    } else if (departure < arrival) {
      period.valid = false;
      errors.push({
        type: "departure_before_arrival",
        trip_index: index,
        arrival: trip.date_arrival,
        departure: trip.date_departure,
      });
    }

    if (!["stay", "transit", "unknown"].includes(dayType)) {
      period.valid = false;
      errors.push({ type: "invalid_day_type", trip_index: index, day_type: dayType });
    }

    if (!country || country === "unknown") {
      period.valid = false;
      errors.push({ type: "unknown_country", trip_index: index, trip_country: trip.trip_country });
    } else if (
      Array.isArray(settings.known_countries) &&
      settings.known_countries.length > 0 &&
      !settings.known_countries.includes(country)
    ) {
      period.valid = false;
      errors.push({ type: "unknown_country", trip_index: index, trip_country: country });
    }

    if (dayType === "unknown") {
      disputedPeriods.push(toPublicPeriod(period, "unknown_day_type"));
    }

    if (country === "Cyprus" && (!arrival || !departure)) {
      warnings.push({ type: "incomplete_cyprus_data", trip_index: index });
    }

    return period;
  });

  const validTrips = normalizedTrips.filter((trip) => trip.valid);

  const sameDayDepartureReturnDates = new Set();
  for (const left of validTrips.filter((t) => t.trip_country === "Cyprus")) {
    for (const ret of validTrips.filter((t) => t.trip_country === "Cyprus")) {
      if (left.index !== ret.index && formatDate(left.departure) === formatDate(ret.arrival)) {
        sameDayDepartureReturnDates.add(formatDate(left.departure));
      }
    }
  }

  const countedOccupancy = new Map();

  for (const trip of validTrips) {
    const periodDays = [];
    const clippedStart = maxDate(trip.arrival, yearStart);
    const clippedEnd = minDate(trip.departure, yearEnd);

    for (const date of eachDate(clippedStart, clippedEnd)) {
      const dateKey = formatDate(date);
      let counts = false;
      const isArrivalDay = dateKey === formatDate(trip.arrival);
      const isDepartureDay = dateKey === formatDate(trip.departure);
      const isSameDayArrivalDeparture = formatDate(trip.arrival) === formatDate(trip.departure);

      if (trip.day_type === "transit") {
        transitDays.push({
          date: dateKey,
          country: trip.trip_country,
          trip_index: trip.index,
          comment: trip.comment,
        });
      }

      if (trip.trip_country === "Cyprus") {
        if (trip.day_type === "transit" && !settings.transit_day_counts_for_cyprus) {
          counts = false;
        } else if (isSameDayArrivalDeparture) {
          counts = !!settings.same_day_arrival_departure_counts_for_cyprus;
        } else if (
          sameDayDepartureReturnDates.has(dateKey) &&
          !settings.same_day_departure_return_counts_for_cyprus
        ) {
          counts = false;
          disputedPeriods.push({
            reason: "same_day_departure_return_to_cyprus",
            date: dateKey,
            trip_index: trip.index,
          });
        } else if (isArrivalDay) {
          counts = !!settings.arrival_day_counts_for_cyprus;
        } else if (isDepartureDay) {
          counts = !!settings.departure_day_counts_for_cyprus;
        } else {
          counts = true;
        }
      } else {
        if (isSameDayArrivalDeparture) {
          counts =
            !!settings.arrival_day_counts_other_countries ||
            !!settings.departure_day_counts_other_countries;
        } else if (isArrivalDay) {
          counts = !!settings.arrival_day_counts_other_countries;
        } else if (isDepartureDay) {
          counts = !!settings.departure_day_counts_other_countries;
        } else {
          counts = true;
        }
      }

      if (counts) {
        periodDays.push(dateKey);
        if (!countedOccupancy.has(dateKey)) countedOccupancy.set(dateKey, []);
        countedOccupancy.get(dateKey).push(trip);
      }
    }

    if (!countryMap[trip.trip_country]) {
      countryMap[trip.trip_country] = { country: trip.trip_country, days_set: new Set(), periods: [] };
    }

    for (const day of periodDays) countryMap[trip.trip_country].days_set.add(day);
    countedDaysByTrip[trip.index] = periodDays.length;
    countryMap[trip.trip_country].periods.push({
      trip_index: trip.index,
      date_arrival: trip.date_arrival,
      date_departure: trip.date_departure,
      day_type: trip.day_type,
      counted_days: periodDays.length,
      comment: trip.comment,
    });
  }

  for (const [date, periods] of countedOccupancy.entries()) {
    const countries = [...new Set(periods.map((p) => p.trip_country))];
    if (periods.length > 1 && countries.length > 1) {
      errors.push({
        type: "overlapping_counted_days",
        date,
        countries,
        trip_indexes: periods.map((p) => p.index),
      });
      disputedPeriods.push({
        reason: "overlapping_counted_days",
        date,
        trip_indexes: periods.map((p) => p.index),
        countries,
      });
    }
  }

  const countryDayBreakdown = Object.values(countryMap)
    .map((entry) => ({
      country: entry.country,
      days: entry.days_set.size,
      periods: entry.periods,
    }))
    .sort((a, b) => b.days - a.days || a.country.localeCompare(b.country));

  const cyprusDays = countryDayBreakdown.find((e) => e.country === "Cyprus")?.days || 0;
  const otherCountries = countryDayBreakdown.filter((e) => e.country !== "Cyprus");
  const maxOtherCountry = otherCountries.reduce(
    (max, e) => (e.days > max.days ? { country: e.country, days: e.days } : max),
    { country: null, days: 0 }
  );

  const cyprusDaysAtLeast60 = cyprusDays >= 60;
  const cyprusDaysOver183 = cyprusDays > 183;
  const anyOtherCountryDaysOver183 = otherCountries.some((e) => e.days > 183);

  if (!cyprusDaysAtLeast60) warnings.push({ type: "cyprus_days_below_60", cyprus_days: cyprusDays });
  if (anyOtherCountryDaysOver183) {
    warnings.push({
      type: "other_country_over_183_days",
      countries: otherCountries.filter((e) => e.days > 183),
    });
  }
  if (transitDays.length > 0) warnings.push({ type: "transit_days_present", count: transitDays.length });
  if (disputedPeriods.some((p) => p.reason === "unknown_day_type")) {
    warnings.push({ type: "unknown_day_type_present" });
  }
  if (input.possible_tax_resident_elsewhere !== "no") {
    warnings.push({ type: "possible_tax_residency_elsewhere", value: input.possible_tax_resident_elsewhere });
  }
  if (input.has_cyprus_home !== "yes") {
    warnings.push({ type: "cyprus_home_not_confirmed", value: input.has_cyprus_home });
  }
  if (input.has_cyprus_business_or_employment_or_directorship !== "yes") {
    warnings.push({
      type: "cyprus_business_employment_or_directorship_not_confirmed",
      value: input.has_cyprus_business_or_employment_or_directorship,
    });
  }

  let preliminaryStatus = "needs tax advisor review";
  if (
    errors.length === 0 &&
    cyprusDaysAtLeast60 &&
    !anyOtherCountryDaysOver183 &&
    input.has_cyprus_home === "yes" &&
    input.has_cyprus_business_or_employment_or_directorship === "yes" &&
    input.possible_tax_resident_elsewhere === "no" &&
    disputedPeriods.length === 0
  ) {
    preliminaryStatus = "likely qualifies";
  } else if (!cyprusDaysAtLeast60 || anyOtherCountryDaysOver183) {
    preliminaryStatus = "likely does not qualify";
  }

  return {
    tax_year: taxYear,
    settings_used: settings,
    cyprus_days: cyprusDays,
    cyprus_days_at_least_60: cyprusDaysAtLeast60 ? "да" : "нет",
    cyprus_days_over_183: cyprusDaysOver183 ? "да" : "нет",
    any_other_country_days_over_183: anyOtherCountryDaysOver183 ? "да" : "нет",
    max_other_country: maxOtherCountry,
    country_day_breakdown: countryDayBreakdown,
    transit_days: dedupeObjects(transitDays),
    disputed_or_incomplete_periods: disputedPeriods,
    permanent_home_in_cyprus: yesNoUnknown(input.has_cyprus_home),
    business_employment_or_directorship_in_cyprus: yesNoUnknown(
      input.has_cyprus_business_or_employment_or_directorship
    ),
    possible_tax_residency_elsewhere: yesNoUnknown(input.possible_tax_resident_elsewhere),
    preliminary_status: preliminaryStatus,
    warnings,
    errors,
    trips_table: normalizedTrips.map((t) => ({
      trip_index: t.index,
      country: t.trip_country,
      date_arrival: t.date_arrival,
      date_departure: t.date_departure,
      day_type: t.day_type,
      counted_days: countedDaysByTrip[t.index] ?? 0,
      comment: t.comment,
      valid: t.valid,
    })),
    disclaimer:
      "Это расчётный помощник и чек-лист. Он не является юридическим или налоговым заключением.",
  };
}

// Sample scenarios
const SAMPLES = {
  exactly_60: {
    label: "Ровно 60 дней на Кипре",
    payload: {
      tax_year: 2026,
      has_cyprus_home: "yes",
      has_cyprus_business_or_employment_or_directorship: "yes",
      possible_tax_resident_elsewhere: "no",
      trips: [
        {
          trip_country: "Cyprus",
          date_arrival: "2026-01-01",
          date_departure: "2026-03-02",
          day_type: "stay",
          comment: "Основное пребывание на Кипре",
        },
      ],
    },
  },
  fifty_nine: {
    label: "59 дней на Кипре",
    payload: {
      tax_year: 2026,
      has_cyprus_home: "yes",
      has_cyprus_business_or_employment_or_directorship: "yes",
      possible_tax_resident_elsewhere: "no",
      trips: [
        {
          trip_country: "Cyprus",
          date_arrival: "2026-01-01",
          date_departure: "2026-03-01",
          day_type: "stay",
          comment: "На один день меньше нужного минимума",
        },
      ],
    },
  },
  other_over_183: {
    label: "Другая страна свыше 183 дней",
    payload: {
      tax_year: 2026,
      has_cyprus_home: "yes",
      has_cyprus_business_or_employment_or_directorship: "yes",
      possible_tax_resident_elsewhere: "yes",
      trips: [
        {
          trip_country: "Cyprus",
          date_arrival: "2026-01-01",
          date_departure: "2026-03-02",
          day_type: "stay",
          comment: "60 дней на Кипре",
        },
        {
          trip_country: "Russia",
          date_arrival: "2026-03-10",
          date_departure: "2026-09-11",
          day_type: "stay",
          comment: "Длительное пребывание в России",
        },
      ],
    },
  },
  transit_days: {
    label: "Транзитные дни",
    payload: {
      tax_year: 2026,
      has_cyprus_home: "yes",
      has_cyprus_business_or_employment_or_directorship: "yes",
      possible_tax_resident_elsewhere: "no",
      trips: [
        {
          trip_country: "Cyprus",
          date_arrival: "2026-01-01",
          date_departure: "2026-03-02",
          day_type: "stay",
          comment: "Основное пребывание",
        },
        {
          trip_country: "Cyprus",
          date_arrival: "2026-04-10",
          date_departure: "2026-04-10",
          day_type: "transit",
          comment: "Пересадка в аэропорту Ларнаки",
        },
      ],
    },
  },
  multi_country: {
    label: "Несколько стран",
    payload: {
      tax_year: 2026,
      has_cyprus_home: "yes",
      has_cyprus_business_or_employment_or_directorship: "yes",
      possible_tax_resident_elsewhere: "no",
      trips: [
        {
          trip_country: "Cyprus",
          date_arrival: "2026-01-01",
          date_departure: "2026-03-02",
          day_type: "stay",
          comment: "Основное пребывание",
        },
        {
          trip_country: "Greece",
          date_arrival: "2026-04-01",
          date_departure: "2026-05-01",
          day_type: "stay",
          comment: "Поездка в Грецию",
        },
        {
          trip_country: "Latvia",
          date_arrival: "2026-06-01",
          date_departure: "2026-06-16",
          day_type: "stay",
          comment: "Командировка в Латвию",
        },
        {
          trip_country: "UAE",
          date_arrival: "2026-07-01",
          date_departure: "2026-07-11",
          day_type: "stay",
          comment: "Конференция в ОАЭ",
        },
      ],
    },
  },
};

// Expose to window for browser
if (typeof window !== "undefined") {
  window.CyprusCalc = {
    calculateCyprusResidency,
    SAMPLES,
    normalizeCountry,
    parseDate,
    sortTripsByDate,
    compareTripsByDate,
  };
}
// Also export for Node-based tests
if (typeof module !== "undefined" && module.exports) {
  module.exports = { calculateCyprusResidency, SAMPLES, sortTripsByDate, compareTripsByDate };
}
