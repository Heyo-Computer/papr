import { useEffect } from "preact/hooks";
import { monthDays, expandedTodoId, todayString } from "../../state/store";
import { getMonthRange, saveTodo, updateTodo as updateTodoCmd, deleteTodo as deleteTodoCmd } from "../../api/commands";
import { TodoItem } from "../todos/TodoItem";
import { AddTodo } from "../todos/AddTodo";
import type { TodoItem as TodoItemType } from "../../types";
import { useSignal } from "@preact/signals";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Build full calendar months that cover the month range (day+2 to day+28). */
function getCalendarMonths(): { year: number; month: number; label: string }[] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() + 2);
  const end = new Date(now);
  end.setDate(end.getDate() + 28);

  const months: { year: number; month: number; label: string }[] = [];
  let y = start.getFullYear(), m = start.getMonth();
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    const label = new Date(y, m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    months.push({ year: y, month: m, label });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return months;
}

/** Get all dates for a calendar grid (includes leading/trailing days from adjacent months). */
function getCalendarGrid(year: number, month: number): (string | null)[] {
  const firstDay = new Date(year, month, 1);
  // Monday-based: 0=Mon ... 6=Sun
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    cells.push(`${yyyy}-${mm}-${dd}`);
  }
  return cells;
}

/** Check if a date string is within the active month range (day+2 to day+28). */
function isInRange(dateStr: string): boolean {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() + 2);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + 28);
  end.setHours(23, 59, 59, 999);
  const d = new Date(dateStr + "T00:00:00");
  return d >= start && d <= end;
}

export function MonthAccordion() {
  const selectedDate = useSignal<string | null>(null);

  useEffect(() => {
    getMonthRange().then((entries) => {
      monthDays.value = entries;
    }).catch(() => {});
  }, []);

  const calendarMonths = getCalendarMonths();
  const today = todayString();

  function entryByDate(date: string) {
    return monthDays.value.find((d) => d.date === date);
  }

  async function reload() {
    const entries = await getMonthRange();
    monthDays.value = entries;
  }

  async function handleAdd(date: string, title: string) {
    await saveTodo(date, title);
    await reload();
  }

  async function handleToggle(date: string, todo: TodoItemType) {
    await updateTodoCmd(date, { ...todo, completed: !todo.completed });
    await reload();
  }

  async function handleDelete(date: string, todoId: string) {
    await deleteTodoCmd(date, todoId);
    await reload();
  }

  async function handleUpdate(date: string, todo: TodoItemType) {
    await updateTodoCmd(date, todo);
    await reload();
  }

  const selected = selectedDate.value;
  const selectedEntry = selected ? entryByDate(selected) : undefined;
  const selectedTodos = selectedEntry?.todos ?? [];

  return (
    <div class="month-calendar">
      {calendarMonths.map(({ year, month, label }) => {
        const grid = getCalendarGrid(year, month);
        return (
          <div key={`${year}-${month}`} class="cal-month">
            <div class="cal-month-label">{label}</div>
            <div class="cal-grid">
              {DAY_LABELS.map((d) => (
                <div key={d} class="cal-day-header">{d}</div>
              ))}
              {grid.map((dateStr, i) => {
                if (!dateStr) return <div key={`empty-${i}`} class="cal-cell cal-empty" />;
                const inRange = isInRange(dateStr);
                const entry = entryByDate(dateStr);
                const count = entry?.todos?.length ?? 0;
                const isSelected = dateStr === selected;
                const isToday = dateStr === today;
                const dayNum = new Date(dateStr + "T00:00:00").getDate();

                return (
                  <button
                    key={dateStr}
                    class={`cal-cell${inRange ? "" : " cal-out"}${isSelected ? " cal-selected" : ""}${isToday ? " cal-today" : ""}`}
                    onClick={() => {
                      if (inRange) {
                        selectedDate.value = isSelected ? null : dateStr;
                        expandedTodoId.value = null;
                      }
                    }}
                    disabled={!inRange}
                  >
                    <span class="cal-day-num">{dayNum}</span>
                    {count > 0 && <span class="cal-dot" />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {selected && (
        <div class="cal-detail">
          <div class="cal-detail-header">
            {new Date(selected + "T00:00:00").toLocaleDateString("en-US", {
              weekday: "long", month: "short", day: "numeric",
            })}
          </div>
          {selectedTodos.length > 0 ? (
            <div class="todo-list">
              {selectedTodos.map((todo) => (
                <TodoItem
                  key={todo.id}
                  todo={todo}
                  date={selected}
                  onToggle={() => handleToggle(selected, todo)}
                  onDelete={() => handleDelete(selected, todo.id)}
                  onUpdate={(t) => handleUpdate(selected, t)}
                />
              ))}
            </div>
          ) : (
            <div class="accordion-empty">No todos yet</div>
          )}
          <AddTodo onAdd={(title) => handleAdd(selected, title)} />
        </div>
      )}
    </div>
  );
}
