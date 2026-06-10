import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  LogarithmicScale,
  PointElement,
  Tooltip
} from "chart.js";
import React from "react";
import { useEffect, useMemo, useState } from "react";
import { Chart } from "react-chartjs-2";

ChartJS.register(
  BarElement,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

const compactMoney = new Intl.NumberFormat("en-US", {
  notation: "compact",
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 1
});

const STORAGE_KEY = "networth-growth-visualizer:assumptions";

const DEFAULT_ASSUMPTIONS = {
  startingValue: 100000,
  annualGrowth: 8,
  comparisonSpread: 3,
  years: 10,
  monthlyIncome: 1500,
  fixedIncomeEnabled: true,
  premiumIncomeEnabled: true,
  premiumRate: 1,
  premiumBasisPercent: 100,
  premiumFrequency: "monthly",
  inflationRate: 3,
  yScale: "linear",
  theme: "light",
  expenseMode: "monthly",
  expenses: 3000,
  withdrawalRate: 4,
  withdrawalMode: "fixed",
  withdrawalGrowthRatio: 44.4,
  withdrawalsEnabled: true,
  retirementIncomeMonthly: 0
};

function loadStoredAssumptions() {
  if (typeof window === "undefined") return DEFAULT_ASSUMPTIONS;

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ASSUMPTIONS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ASSUMPTIONS, ...parsed };
  } catch {
    return DEFAULT_ASSUMPTIONS;
  }
}

const monthYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric"
});

function projectedMonthLabel(month) {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + month);
  return monthYear.format(date);
}

function monthFromChartEvent(chart, event, maxMonth) {
  const xScale = chart.scales.x;
  if (!xScale || event.x < chart.chartArea.left || event.x > chart.chartArea.right) return null;

  const rawValue = xScale.getValueForPixel(event.x);
  const index = Number(rawValue);
  if (!Number.isFinite(index)) return null;

  return Math.max(0, Math.min(maxMonth, Math.round(index)));
}

const selectedMonthLinePlugin = {
  id: "selectedMonthLine",
  afterDatasetsDraw(chart, _args, options) {
    const index = options?.index;
    const xScale = chart.scales.x;
    if (!xScale || index === null || index === undefined) return;

    const x = xScale.getPixelForValue(index);
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = options?.color ?? "rgba(23, 33, 31, 0.55)";
    ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.restore();
  }
};

function createIncomeSources({
  fixedIncomeEnabled,
  monthlyIncome,
  premiumIncomeEnabled,
  premiumRate,
  premiumBasisPercent,
  premiumFrequency
}) {
  const premiumInterval = { monthly: 1, quarterly: 3, annually: 12 }[premiumFrequency];
  const premiumBasisShare = Math.max(0, Math.min(100, premiumBasisPercent)) / 100;

  return [
    {
      id: "fixed-savings",
      label: "Fixed savings",
      enabled: fixedIncomeEnabled,
      stopsAtRetirement: true,
      amount({ retired }) {
        return retired ? 0 : monthlyIncome;
      }
    },
    {
      id: "premium",
      label: "Premium income",
      enabled: premiumIncomeEnabled,
      stopsAtRetirement: false,
      amount({ month, portfolioValue }) {
        const premiumBasis = portfolioValue * premiumBasisShare;
        return (month - 1) % premiumInterval === 0 ? premiumBasis * (premiumRate / 100) : 0;
      },
      basis({ portfolioValue }) {
        return portfolioValue * premiumBasisShare;
      }
    }
  ];
}

function projectNetWorth({
  startingValue,
  annualGrowth,
  years,
  monthlyIncome,
  fixedIncomeEnabled,
  premiumIncomeEnabled,
  premiumRate,
  premiumBasisPercent,
  premiumFrequency,
  inflationRate,
  annualExpenses,
  withdrawalRate,
  withdrawalsEnabled,
  retirementIncomeMonthly
}) {
  const months = years * 12;
  const monthlyGrowth = Math.pow(1 + annualGrowth / 100, 1 / 12) - 1;
  const incomeSources = createIncomeSources({
    fixedIncomeEnabled,
    monthlyIncome,
    premiumIncomeEnabled,
    premiumRate,
    premiumBasisPercent,
    premiumFrequency
  });
  const netAnnualExpenses = Math.max(0, annualExpenses - retirementIncomeMonthly * 12);
  const retirementTarget =
    withdrawalRate > 0 ? netAnnualExpenses / (withdrawalRate / 100) : Number.POSITIVE_INFINITY;
  const inflationFactorFor = (month) => Math.pow(1 + inflationRate / 100, month / 12);
  let value = startingValue;
  let totalIncome = 0;
  let totalWithdrawals = 0;
  let finalIncome = 0;
  let finalIncomeBreakdown = {};
  let finalIncomeBasisBreakdown = {};
  let finalWithdrawal = 0;
  let finalRetirementIncome = 0;
  let retirementMonth = startingValue >= retirementTarget ? 0 : null;

  const points = Array.from({ length: months + 1 }, (_, month) => {
    if (month > 0) {
      const hasReachedRetirement = retirementMonth !== null && month > retirementMonth;
      const drawdownActive = withdrawalsEnabled && hasReachedRetirement;
      const incomeBreakdown = incomeSources.reduce((breakdown, source) => {
        const sourceRetired = hasReachedRetirement && source.stopsAtRetirement;
        breakdown[source.id] = source.enabled
          ? source.amount({ month, portfolioValue: value, retired: sourceRetired })
          : 0;
        return breakdown;
      }, {});
      const incomeBasisBreakdown = incomeSources.reduce((breakdown, source) => {
        breakdown[source.id] = source.enabled && source.basis ? source.basis({ portfolioValue: value }) : 0;
        return breakdown;
      }, {});
      const income = Object.values(incomeBreakdown).reduce((sum, amount) => sum + amount, 0);
      const inflationFactor = inflationFactorFor(month);
      const retirementIncome = drawdownActive ? retirementIncomeMonthly * inflationFactor : 0;
      const livingExpense = drawdownActive ? (annualExpenses / 12) * inflationFactor : 0;
      const withdrawal = Math.max(0, livingExpense - retirementIncome);

      finalIncome = income;
      finalIncomeBreakdown = incomeBreakdown;
      finalIncomeBasisBreakdown = incomeBasisBreakdown;
      finalRetirementIncome = retirementIncome;
      finalWithdrawal = withdrawal;
      totalIncome += income;
      totalWithdrawals += withdrawal;
      value = Math.max(0, value + income - withdrawal) * (1 + monthlyGrowth);

      if (retirementMonth === null && value >= retirementTarget * inflationFactor) {
        retirementMonth = month;
      }
    }

    return {
      month,
      year: month / 12,
      value,
      totalIncome,
      totalWithdrawals,
      investmentGrowth: value - startingValue - totalIncome + totalWithdrawals,
      income: month === 0 ? 0 : finalIncome,
      incomeBreakdown: month === 0 ? {} : finalIncomeBreakdown,
      incomeBasisBreakdown: month === 0 ? {} : finalIncomeBasisBreakdown,
      retirementIncome: month === 0 ? 0 : finalRetirementIncome,
      withdrawal: month === 0 ? 0 : finalWithdrawal,
      retired: retirementMonth !== null && month >= retirementMonth
    };
  });

  return {
    points,
    endingValue: value,
    totalIncome,
    totalWithdrawals,
    investmentGrowth: value - startingValue - totalIncome + totalWithdrawals,
    finalIncome,
    finalWithdrawal,
    retirementMonth
  };
}

function Slider({ id, label, value, min, max, step, suffix = "", onChange }) {
  const numericValue = Number.isInteger(value) ? value : Number(value).toFixed(1);

  return (
    <label className="control" htmlFor={id}>
      <span>
        {label}
        <strong>
          {numericValue}
          {suffix}
        </strong>
      </span>
      <div className="sliderRow">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <input
          aria-label={`${label} precise value`}
          className="sliderNumber"
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    </label>
  );
}

function NumberField({ id, label, value, step, max, onChange }) {
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        min="0"
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.42 1.42" />
      <path d="m17.65 17.65 1.42 1.42" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.35 17.65-1.42 1.42" />
      <path d="m19.07 4.93-1.42 1.42" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 7 7 0 1 0 20.5 14.5Z" />
    </svg>
  );
}

export default function App() {
  const storedAssumptions = useMemo(loadStoredAssumptions, []);
  const [startingValue, setStartingValue] = useState(storedAssumptions.startingValue);
  const [annualGrowth, setAnnualGrowth] = useState(storedAssumptions.annualGrowth);
  const [comparisonSpread, setComparisonSpread] = useState(storedAssumptions.comparisonSpread);
  const [years, setYears] = useState(storedAssumptions.years);
  const [monthlyIncome, setMonthlyIncome] = useState(storedAssumptions.monthlyIncome);
  const [fixedIncomeEnabled, setFixedIncomeEnabled] = useState(
    storedAssumptions.fixedIncomeEnabled
  );
  const [premiumIncomeEnabled, setPremiumIncomeEnabled] = useState(
    storedAssumptions.premiumIncomeEnabled
  );
  const [premiumRate, setPremiumRate] = useState(storedAssumptions.premiumRate);
  const [premiumBasisPercent, setPremiumBasisPercent] = useState(
    storedAssumptions.premiumBasisPercent
  );
  const [premiumFrequency, setPremiumFrequency] = useState(storedAssumptions.premiumFrequency);
  const [inflationRate, setInflationRate] = useState(storedAssumptions.inflationRate);
  const [yScale, setYScale] = useState(storedAssumptions.yScale);
  const [theme, setTheme] = useState(storedAssumptions.theme);
  const [expenseMode, setExpenseMode] = useState(storedAssumptions.expenseMode);
  const [expenses, setExpenses] = useState(storedAssumptions.expenses);
  const [withdrawalRate, setWithdrawalRate] = useState(storedAssumptions.withdrawalRate);
  const [withdrawalMode, setWithdrawalMode] = useState(storedAssumptions.withdrawalMode);
  const [withdrawalGrowthRatio, setWithdrawalGrowthRatio] = useState(
    storedAssumptions.withdrawalGrowthRatio
  );
  const [withdrawalsEnabled, setWithdrawalsEnabled] = useState(
    storedAssumptions.withdrawalsEnabled
  );
  const [retirementIncomeMonthly, setRetirementIncomeMonthly] = useState(
    storedAssumptions.retirementIncomeMonthly
  );
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [hoveredMonth, setHoveredMonth] = useState(null);
  const annualExpenses = expenseMode === "monthly" ? expenses * 12 : expenses;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const assumptions = {
      startingValue,
      annualGrowth,
      comparisonSpread,
      years,
      monthlyIncome,
      fixedIncomeEnabled,
      premiumIncomeEnabled,
      premiumRate,
      premiumBasisPercent,
      premiumFrequency,
      inflationRate,
      yScale,
      theme,
      expenseMode,
      expenses,
      withdrawalRate,
      withdrawalMode,
      withdrawalGrowthRatio,
      withdrawalsEnabled,
      retirementIncomeMonthly
    };

    try {
      window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(assumptions));
    } catch {
      // Ignore storage failures in restricted/private browser contexts.
    }
  }, [
    annualGrowth,
    comparisonSpread,
    expenseMode,
    expenses,
    fixedIncomeEnabled,
    inflationRate,
    monthlyIncome,
    premiumBasisPercent,
    premiumFrequency,
    premiumIncomeEnabled,
    premiumRate,
    retirementIncomeMonthly,
    startingValue,
    theme,
    withdrawalGrowthRatio,
    withdrawalMode,
    withdrawalRate,
    withdrawalsEnabled,
    yScale,
    years
  ]);

  const premiumPeriodsPerYear = { monthly: 12, quarterly: 4, annually: 1 }[premiumFrequency];
  const chartTheme =
    theme === "dark"
      ? {
          axis: "#9aa9a4",
          grid: "rgba(151, 166, 160, 0.18)",
          incomeGrid: "rgba(210, 174, 101, 0.18)",
          legend: "#b7c4c0",
          incomeLegend: "#d5bd86",
          lower: "#6fb0dc",
          base: "#4fc08f",
          baseFill: "rgba(79, 192, 143, 0.2)",
          upper: "#ef8b72",
          income: "#d6a74e",
          purchasingPower: "#c69df0",
          target: "#d8e0dc",
          incomeBar: "rgba(214, 167, 78, 0.42)",
          withdrawalBar: "rgba(239, 139, 114, 0.36)",
          selectedLine: "rgba(237, 244, 241, 0.58)"
        }
      : {
          axis: "#6b7773",
          grid: "#e5e9e2",
          incomeGrid: "#efe8d8",
          legend: "#46534f",
          incomeLegend: "#6d5d3b",
          lower: "#2d6f9f",
          base: "#1b7f5f",
          baseFill: "rgba(27, 127, 95, 0.18)",
          upper: "#d95f45",
          income: "#c18b2e",
          purchasingPower: "#7b4fa3",
          target: "#263238",
          incomeBar: "rgba(193, 139, 46, 0.36)",
          withdrawalBar: "rgba(217, 95, 69, 0.3)",
          selectedLine: "rgba(23, 33, 31, 0.55)"
        };
  const expectedPremiumYield =
    premiumIncomeEnabled ? premiumRate * premiumPeriodsPerYear * (premiumBasisPercent / 100) : 0;
  const expectedAnnualPerformance = annualGrowth + expectedPremiumYield;
  const effectiveWithdrawalRate =
    withdrawalMode === "growthRatio"
      ? Math.max(0.1, expectedAnnualPerformance * (withdrawalGrowthRatio / 100))
      : withdrawalRate;

  const projections = useMemo(() => {
    const baseInput = {
      startingValue,
      years,
      monthlyIncome,
      fixedIncomeEnabled,
      premiumIncomeEnabled,
      premiumRate,
      premiumBasisPercent,
      premiumFrequency,
      inflationRate,
      annualExpenses,
      withdrawalRate: effectiveWithdrawalRate,
      withdrawalsEnabled,
      retirementIncomeMonthly
    };

    return {
      lower: projectNetWorth({ ...baseInput, annualGrowth: annualGrowth - comparisonSpread }),
      base: projectNetWorth({ ...baseInput, annualGrowth }),
      upper: projectNetWorth({ ...baseInput, annualGrowth: annualGrowth + comparisonSpread })
    };
  }, [
    annualGrowth,
    comparisonSpread,
    fixedIncomeEnabled,
    premiumIncomeEnabled,
    monthlyIncome,
    premiumFrequency,
    premiumBasisPercent,
    premiumRate,
    inflationRate,
    annualExpenses,
    effectiveWithdrawalRate,
    withdrawalsEnabled,
    retirementIncomeMonthly,
    startingValue,
    years
  ]);

  const labels = projections.base.points.map((point) =>
    point.month % 12 === 0 ? `Year ${point.month / 12}` : ""
  );
  const inflationFactorFor = (month) => Math.pow(1 + inflationRate / 100, month / 12);
  const purchasingPowerFor = (point) => point.value / inflationFactorFor(point.month);
  const scaleValue = (value) => (yScale === "logarithmic" && value <= 0 ? null : value);
  const monthlyExpenses = annualExpenses / 12;
  const netMonthlyExpense = Math.max(0, monthlyExpenses - retirementIncomeMonthly);
  const netAnnualExpenses = netMonthlyExpense * 12;
  const retirementTarget =
    effectiveWithdrawalRate > 0 ? netAnnualExpenses / (effectiveWithdrawalRate / 100) : 0;
  const inflatedRetirementTarget = projections.base.points.map(
    (point) => retirementTarget * inflationFactorFor(point.month)
  );
  const logScaleValues = [
    ...projections.lower.points.map((point) => point.value),
    ...projections.base.points.map((point) => point.value),
    ...projections.upper.points.map((point) => point.value),
    ...projections.base.points.map((point) => purchasingPowerFor(point)),
    ...inflatedRetirementTarget
  ].filter((value) => Number.isFinite(value) && value > 0);
  const logScaleMin = Math.max(1000, Math.min(...logScaleValues) * 0.85);
  const annualWithdrawalCapacity = projections.base.endingValue * (effectiveWithdrawalRate / 100);
  const endingInflationFactor = inflationFactorFor(projections.base.points.length - 1);
  const endingFutureDollarTarget = retirementTarget * endingInflationFactor;
  const endingPurchasingPower = purchasingPowerFor(
    projections.base.points[projections.base.points.length - 1]
  );
  const retirementGap = Math.max(0, endingFutureDollarTarget - projections.base.endingValue);
  const realRetirementGap = Math.max(0, retirementTarget - endingPurchasingPower);
  const targetProgress =
    endingFutureDollarTarget > 0 ? projections.base.endingValue / endingFutureDollarTarget : 0;
  const realTargetProgress = retirementTarget > 0 ? endingPurchasingPower / retirementTarget : 0;
  const retirementMonth = projections.base.retirementMonth;
  const defaultSelectedMonth = retirementMonth ?? projections.base.points.length - 1;
  const selectedMonthIndex = Math.min(
    hoveredMonth ?? selectedMonth ?? defaultSelectedMonth,
    projections.base.points.length - 1
  );
  const selectedPoint = projections.base.points[selectedMonthIndex];
  const selectedPurchasingPower = purchasingPowerFor(selectedPoint);
  const selectedInflationFactor = inflationFactorFor(selectedPoint.month);
  const selectedFutureDollarTarget = retirementTarget * selectedInflationFactor;
  const selectedTargetProgress =
    selectedFutureDollarTarget > 0 ? selectedPoint.value / selectedFutureDollarTarget : 0;
  const selectedRealTargetProgress =
    retirementTarget > 0 ? selectedPurchasingPower / retirementTarget : 0;
  const selectedFixedIncome = selectedPoint.incomeBreakdown["fixed-savings"] ?? 0;
  const selectedPremiumIncome = selectedPoint.incomeBreakdown.premium ?? 0;
  const selectedPremiumBasis = selectedPoint.incomeBasisBreakdown?.premium ?? 0;
  const retirementDateLabel =
    retirementMonth === null ? "Not reached" : projectedMonthLabel(retirementMonth);
  const retirementTimingLabel =
    retirementMonth === null
      ? "Not within horizon"
      : `Year ${(retirementMonth / 12).toFixed(1)} / Month ${retirementMonth}`;

  const chartData = {
    labels,
    datasets: [
      {
        id: "lower-growth",
        type: "line",
        label: `${(annualGrowth - comparisonSpread).toFixed(1)}% growth`,
        data: projections.lower.points.map((point) => scaleValue(point.value)),
        yAxisID: "portfolio",
        borderColor: chartTheme.lower,
        backgroundColor: "rgba(45, 111, 159, 0.08)",
        borderDash: [7, 7],
        pointRadius: 0,
        tension: 0.34
      },
      {
        id: "base-growth",
        type: "line",
        label: `${annualGrowth.toFixed(1)}% base growth`,
        data: projections.base.points.map((point) => scaleValue(point.value)),
        yAxisID: "portfolio",
        borderColor: chartTheme.base,
        backgroundColor: chartTheme.baseFill,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.34
      },
      {
        id: "upper-growth",
        type: "line",
        label: `${(annualGrowth + comparisonSpread).toFixed(1)}% growth`,
        data: projections.upper.points.map((point) => scaleValue(point.value)),
        yAxisID: "portfolio",
        borderColor: chartTheme.upper,
        backgroundColor: "rgba(217, 95, 69, 0.08)",
        borderDash: [7, 7],
        pointRadius: 0,
        tension: 0.34
      },
      {
        id: "income-contributed",
        type: "line",
        label: "Income contributed",
        data: projections.base.points.map((point) => scaleValue(point.totalIncome)),
        yAxisID: "portfolio",
        borderColor: chartTheme.income,
        borderDash: [3, 5],
        pointRadius: 0,
        tension: 0.2
      },
      {
        id: "purchasing-power",
        type: "line",
        label: `${inflationRate.toFixed(1)}% inflation-adjusted value`,
        data: projections.base.points.map((point) => scaleValue(purchasingPowerFor(point))),
        yAxisID: "portfolio",
        borderColor: chartTheme.purchasingPower,
        backgroundColor: "rgba(123, 79, 163, 0.08)",
        borderDash: [2, 5],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.28
      },
      {
        id: "retirement-target",
        type: "line",
        label: `${effectiveWithdrawalRate.toFixed(1)}% target in future dollars`,
        data: inflatedRetirementTarget.map(scaleValue),
        yAxisID: "portfolio",
        borderColor: chartTheme.target,
        borderDash: [10, 6],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0
      }
    ]
  };

  const incomeChartData = {
    labels,
    datasets: [
      {
        id: "monthly-income",
        type: "bar",
        label: "Income this month",
        data: projections.base.points.map((point) => point.income),
        backgroundColor: chartTheme.incomeBar,
        borderColor: chartTheme.income,
        borderWidth: 1,
        borderRadius: 3
      },
      {
        id: "monthly-withdrawal",
        type: "bar",
        label: "Withdrawal this month",
        data: projections.base.points.map((point) => point.withdrawal),
        backgroundColor: chartTheme.withdrawalBar,
        borderColor: chartTheme.upper,
        borderWidth: 1,
        borderRadius: 3
      }
    ]
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 450,
      easing: "easeOutQuart"
    },
    interaction: {
      intersect: false,
      mode: "index"
    },
    onHover: (event, _elements, chart) => {
      const month = monthFromChartEvent(chart, event, projections.base.points.length - 1);
      if (month !== null) {
        setHoveredMonth(month);
      }
    },
    onClick: (event, _elements, chart) => {
      const month = monthFromChartEvent(chart, event, projections.base.points.length - 1);
      if (month !== null) {
        setSelectedMonth(month);
        setHoveredMonth(null);
      }
    },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          boxHeight: 3,
          boxWidth: 28,
          color: chartTheme.legend,
          font: { size: 12, weight: "600" },
          usePointStyle: false
        }
      },
      tooltip: {
        callbacks: {
          title: (items) => `Month ${items[0].dataIndex}`,
          label: (item) => `${item.dataset.label}: ${money.format(item.raw)}`,
          afterBody: (items) => {
            const point = projections.base.points[items[0].dataIndex];
            return [
              `Month income: ${money.format(point.income)}`,
              `Total income: ${money.format(point.totalIncome)}`,
              `Purchasing power: ${money.format(purchasingPowerFor(point))}`
            ];
          }
        }
      },
      selectedMonthLine: {
        index: selectedMonthIndex,
        color: chartTheme.selectedLine
      }
    },
    scales: {
      x: {
        grid: { color: chartTheme.grid },
        ticks: {
          autoSkip: false,
          maxRotation: 0,
          color: chartTheme.axis,
          callback: (_, index) => {
            const interval = years > 30 ? 5 : years > 15 ? 2 : 1;
            return index % (12 * interval) === 0 ? `Y${index / 12}` : "";
          }
        }
      },
      portfolio: {
        type: yScale,
        position: "left",
        min: yScale === "logarithmic" ? logScaleMin : undefined,
        beginAtZero: yScale === "linear",
        grid: { color: chartTheme.grid },
        ticks: {
          color: chartTheme.axis,
          callback: (value) => compactMoney.format(value)
        }
      }
    }
  };

  const incomeChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 450,
      easing: "easeOutQuart"
    },
    interaction: {
      intersect: false,
      mode: "index"
    },
    onHover: (event, _elements, chart) => {
      const month = monthFromChartEvent(chart, event, projections.base.points.length - 1);
      if (month !== null) {
        setHoveredMonth(month);
      }
    },
    onClick: (event, _elements, chart) => {
      const month = monthFromChartEvent(chart, event, projections.base.points.length - 1);
      if (month !== null) {
        setSelectedMonth(month);
        setHoveredMonth(null);
      }
    },
    plugins: {
      legend: {
        position: "bottom",
        labels: {
          boxHeight: 3,
          boxWidth: 28,
          color: chartTheme.incomeLegend,
          font: { size: 11, weight: "600" }
        }
      },
      tooltip: {
        callbacks: {
          title: (items) => `Month ${items[0].dataIndex}`,
          label: (item) => `${item.dataset.label}: ${money.format(item.raw)}`
        }
      },
      selectedMonthLine: {
        index: selectedMonthIndex,
        color: chartTheme.selectedLine
      }
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          autoSkip: false,
          maxRotation: 0,
          color: chartTheme.axis,
          callback: (_, index) => {
            const interval = years > 30 ? 5 : years > 15 ? 2 : 1;
            return index % (12 * interval) === 0 ? `Y${index / 12}` : "";
          }
        }
      },
      y: {
        beginAtZero: true,
        grid: { color: chartTheme.incomeGrid },
        ticks: {
          color: chartTheme.incomeLegend,
          callback: (value) => compactMoney.format(value)
        }
      }
    }
  };

  const incomeCopy =
    `${money.format(monthlyIncome)} fixed savings stops after retirement. Premium income uses a ${premiumRate.toFixed(1)}% ${premiumFrequency} yield on ${premiumBasisPercent.toFixed(0)}% of the portfolio.`;

  return (
    <main className={`app ${theme === "dark" ? "darkMode" : ""}`}>
      <button
        className={`themeSwitch ${theme === "dark" ? "darkActive" : "lightActive"}`}
        type="button"
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        aria-pressed={theme === "dark"}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        <span className="themeThumb" aria-hidden="true" />
        <span className="themeIcon sunIcon">
          <SunIcon />
        </span>
        <span className="themeIcon moonIcon">
          <MoonIcon />
        </span>
      </button>
      <header className="hero">
        <div>
          <h1>Net Worth Growth Visualizer</h1>
          <p>
            Compare exponential growth paths over a flexible 10-year horizon with fixed
            income or proportional option-premium reinvestment.
          </p>
        </div>

        <section className="metrics" aria-label="Projection summary">
          <article>
            <span>Ending value</span>
            <strong>{money.format(projections.base.endingValue)}</strong>
          </article>
          <article>
            <span>Investment growth</span>
            <strong>{money.format(projections.base.investmentGrowth)}</strong>
          </article>
          <article>
            <span>Income added</span>
            <strong>{money.format(projections.base.totalIncome)}</strong>
          </article>
          <article>
            <span>Retirement target</span>
            <strong>{money.format(retirementTarget)}</strong>
          </article>
          <article>
            <span>Purchasing power</span>
            <strong>{money.format(endingPurchasingPower)}</strong>
          </article>
          <article>
            <span>Retirement date</span>
            <strong>{retirementDateLabel}</strong>
          </article>
        </section>
      </header>

      <section className="workspace">
        <div className="chartPanel">
          <div className="mainChart" onMouseLeave={() => setHoveredMonth(null)}>
            <Chart
              type="line"
              data={chartData}
              datasetIdKey="id"
              options={chartOptions}
              plugins={[selectedMonthLinePlugin]}
            />
          </div>
          <div
            className="incomeChart"
            aria-label="Monthly income chart"
            onMouseLeave={() => setHoveredMonth(null)}
          >
            <span>Income and withdrawals this month</span>
            <Chart
              type="bar"
              data={incomeChartData}
              datasetIdKey="id"
              options={incomeChartOptions}
              plugins={[selectedMonthLinePlugin]}
            />
          </div>
        </div>

        <aside className="controls" aria-label="Projection controls">
          <section className="monthBox" aria-label="Selected month details">
            <div className="monthHeader">
              <div>
                <span>Selected month</span>
                <strong>
                  Month {selectedPoint.month} / Year {selectedPoint.year.toFixed(1)}
                </strong>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedMonth(null);
                  setHoveredMonth(null);
                }}
              >
                Reset
              </button>
            </div>
            <dl>
              <div>
                <dt>Portfolio</dt>
                <dd>{money.format(selectedPoint.value)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selectedPoint.retired ? "Retired" : "Accumulating"}</dd>
              </div>
              <div>
                <dt>Purchasing power</dt>
                <dd>{money.format(selectedPurchasingPower)}</dd>
              </div>
              <div>
                <dt>Inflation multiplier</dt>
                <dd>{selectedInflationFactor.toFixed(2)}x</dd>
              </div>
              <div>
                <dt>Target progress</dt>
                <dd>{(selectedTargetProgress * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Real target progress</dt>
                <dd>{(selectedRealTargetProgress * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Income this month</dt>
                <dd>{money.format(selectedPoint.income)}</dd>
              </div>
              <div>
                <dt>Fixed savings</dt>
                <dd>{money.format(selectedFixedIncome)}</dd>
              </div>
              <div>
                <dt>Premium income</dt>
                <dd>{money.format(selectedPremiumIncome)}</dd>
              </div>
              <div>
                <dt>Eligible portfolio</dt>
                <dd>{money.format(selectedPremiumBasis)}</dd>
              </div>
              <div>
                <dt>Retirement income</dt>
                <dd>{money.format(selectedPoint.retirementIncome)}</dd>
              </div>
              <div>
                <dt>Withdrawal this month</dt>
                <dd>{money.format(selectedPoint.withdrawal)}</dd>
              </div>
              <div>
                <dt>Total income</dt>
                <dd>{money.format(selectedPoint.totalIncome)}</dd>
              </div>
              <div>
                <dt>Annual withdrawal</dt>
                <dd>{money.format(selectedPoint.value * (effectiveWithdrawalRate / 100))}</dd>
              </div>
            </dl>
          </section>

          <div className="fieldGrid">
            <NumberField
              id="startingValue"
              label="Starting net worth"
              value={startingValue}
              step="1000"
              onChange={setStartingValue}
            />
            <NumberField
              id="monthlyIncome"
              label="Monthly savings"
              value={monthlyIncome}
              step="100"
              onChange={setMonthlyIncome}
            />
          </div>

          <Slider
            id="annualGrowth"
            label="Annual growth"
            min={-20}
            max={40}
            step={0.1}
            value={annualGrowth}
            suffix="%"
            onChange={setAnnualGrowth}
          />

          <Slider
            id="comparisonSpread"
            label="Comparison spread"
            min={0}
            max={12}
            step={0.5}
            value={comparisonSpread}
            suffix="%"
            onChange={setComparisonSpread}
          />

          <Slider
            id="years"
            label="Time horizon"
            min={1}
            max={50}
            step={1}
            value={years}
            suffix={years === 1 ? " year" : " years"}
            onChange={setYears}
          />

          <section className="inflationBox">
            <div className="sectionHead">
              <h2>Inflation view</h2>
              <div className="segmented" aria-label="Y-axis scale">
                <button
                  className={yScale === "linear" ? "active" : ""}
                  type="button"
                  onClick={() => setYScale("linear")}
                >
                  Linear
                </button>
                <button
                  className={yScale === "logarithmic" ? "active" : ""}
                  type="button"
                  onClick={() => setYScale("logarithmic")}
                >
                  Log
                </button>
              </div>
            </div>

            <Slider
              id="inflationRate"
              label="Annual inflation"
              min={0}
              max={12}
              step={0.1}
              value={inflationRate}
              suffix="%"
              onChange={setInflationRate}
            />

            <p>
              Future dollars are divided by cumulative inflation to show purchasing power
              in today's dollars.
            </p>
          </section>

          <section className="incomeBox">
            <div className="sectionHead">
              <h2>Income widget</h2>
            </div>

            <div className="sourceToggles">
              <div className="sectionHead">
                <h2>Fixed savings</h2>
                <div className="segmented" aria-label="Fixed savings source">
                  <button
                    className={fixedIncomeEnabled ? "active" : ""}
                    type="button"
                    onClick={() => setFixedIncomeEnabled(true)}
                  >
                    On
                  </button>
                  <button
                    className={!fixedIncomeEnabled ? "active" : ""}
                    type="button"
                    onClick={() => setFixedIncomeEnabled(false)}
                  >
                    Off
                  </button>
                </div>
              </div>

              <div className="sectionHead">
                <h2>Premium income</h2>
                <div className="segmented" aria-label="Premium income source">
                  <button
                    className={premiumIncomeEnabled ? "active" : ""}
                    type="button"
                    onClick={() => setPremiumIncomeEnabled(true)}
                  >
                    On
                  </button>
                  <button
                    className={!premiumIncomeEnabled ? "active" : ""}
                    type="button"
                    onClick={() => setPremiumIncomeEnabled(false)}
                  >
                    Off
                  </button>
                </div>
              </div>
            </div>

            <div className="fieldGrid">
              <NumberField
                id="premiumRate"
                label="Premium yield %"
                value={premiumRate}
                step="0.1"
                onChange={setPremiumRate}
              />
              <NumberField
                id="premiumBasisPercent"
                label="Eligible portfolio %"
                value={premiumBasisPercent}
                step="1"
                max="100"
                onChange={setPremiumBasisPercent}
              />
              <label className="field" htmlFor="premiumFrequency">
                <span>Premium frequency</span>
                <select
                  id="premiumFrequency"
                  value={premiumFrequency}
                  onChange={(event) => setPremiumFrequency(event.target.value)}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                </select>
              </label>
            </div>

            <p>{incomeCopy}</p>
          </section>

          <section className="retirementBox">
            <div className="sectionHead">
              <h2>Retirement rule</h2>
              <div className="segmented" aria-label="Expense mode">
                <button
                  className={expenseMode === "monthly" ? "active" : ""}
                  type="button"
                  onClick={() => setExpenseMode("monthly")}
                >
                  Monthly
                </button>
                <button
                  className={expenseMode === "annual" ? "active" : ""}
                  type="button"
                  onClick={() => setExpenseMode("annual")}
                >
                  Annual
                </button>
              </div>
            </div>

            <div className="sectionHead">
              <h2>Portfolio drawdown</h2>
              <div className="segmented" aria-label="Portfolio drawdown">
                <button
                  className={withdrawalsEnabled ? "active" : ""}
                  type="button"
                  onClick={() => setWithdrawalsEnabled(true)}
                >
                  On
                </button>
                <button
                  className={!withdrawalsEnabled ? "active" : ""}
                  type="button"
                  onClick={() => setWithdrawalsEnabled(false)}
                >
                  Off
                </button>
              </div>
            </div>

            <div className="sectionHead">
              <h2>Withdrawal rate</h2>
              <div className="segmented" aria-label="Withdrawal rate mode">
                <button
                  className={withdrawalMode === "fixed" ? "active" : ""}
                  type="button"
                  onClick={() => setWithdrawalMode("fixed")}
                >
                  Fixed
                </button>
                <button
                  className={withdrawalMode === "growthRatio" ? "active" : ""}
                  type="button"
                  onClick={() => setWithdrawalMode("growthRatio")}
                >
                  Growth
                </button>
              </div>
            </div>

            <div className="fieldGrid">
              <NumberField
                id="expenses"
                label={expenseMode === "monthly" ? "Monthly expenses" : "Annual expenses"}
                value={expenses}
                step="100"
                onChange={setExpenses}
              />
              <NumberField
                id="withdrawalRate"
                label="Fixed withdrawal %"
                value={withdrawalRate}
                step="0.1"
                onChange={setWithdrawalRate}
              />
              <NumberField
                id="retirementIncomeMonthly"
                label="Retirement income/mo"
                value={retirementIncomeMonthly}
                step="100"
                onChange={setRetirementIncomeMonthly}
              />
            </div>

            <Slider
              id="withdrawalGrowthRatio"
              label="Growth withdrawal ratio"
              min={10}
              max={80}
              step={0.1}
              value={withdrawalGrowthRatio}
              suffix="%"
              onChange={setWithdrawalGrowthRatio}
            />

            <p className="retirementNote">
              Growth mode uses expected performance times this ratio. The default mirrors
              4% / 9% = 44.4%.
            </p>

            <dl>
              <div>
                <dt>Projected retirement</dt>
                <dd>{retirementDateLabel}</dd>
              </div>
              <div>
                <dt>Retirement timing</dt>
                <dd>{retirementTimingLabel}</dd>
              </div>
              <div>
                <dt>Annual expenses</dt>
                <dd>{money.format(annualExpenses)}</dd>
              </div>
              <div>
                <dt>Monthly expenses</dt>
                <dd>{money.format(monthlyExpenses)}</dd>
              </div>
              <div>
                <dt>Net monthly draw</dt>
                <dd>{money.format(netMonthlyExpense)}</dd>
              </div>
              <div>
                <dt>Net annual draw</dt>
                <dd>{money.format(netAnnualExpenses)}</dd>
              </div>
              <div>
                <dt>Expected performance</dt>
                <dd>{expectedAnnualPerformance.toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Effective withdrawal rate</dt>
                <dd>{effectiveWithdrawalRate.toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Future-dollar target</dt>
                <dd>{money.format(endingFutureDollarTarget)}</dd>
              </div>
              <div>
                <dt>Target progress</dt>
                <dd>{(targetProgress * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Real target progress</dt>
                <dd>{(realTargetProgress * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Remaining gap</dt>
                <dd>{money.format(retirementGap)}</dd>
              </div>
              <div>
                <dt>Real remaining gap</dt>
                <dd>{money.format(realRetirementGap)}</dd>
              </div>
              <div>
                <dt>Ending annual withdrawal</dt>
                <dd>{money.format(annualWithdrawalCapacity)}</dd>
              </div>
              <div>
                <dt>Total portfolio withdrawals</dt>
                <dd>{money.format(projections.base.totalWithdrawals)}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </section>
    </main>
  );
}
