import express from "express";
import { Agent } from "./agent.js";
import { makeResponse, makeError } from "./types.js";
import type { AcpRequest } from "./types.js";
import {
  loadDayEntry,
  loadDaysRange,
  addTodo,
  updateTodoEntry,
  deleteTodo,
  loadSpecContent,
  saveTodoSpec,
} from "./tools/todo.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8080);

app.use(express.json());

const agent = new Agent();

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ACP JSON-RPC endpoint
app.post("/rpc", async (req, res) => {
  const request = req.body as AcpRequest;

  if (!request.jsonrpc || request.jsonrpc !== "2.0" || !request.method) {
    res.status(400).json(makeError(request?.id ?? 0, -32600, "Invalid JSON-RPC request"));
    return;
  }

  try {
    const p = request.params as Record<string, unknown>;

    switch (request.method) {
      case "agent/chat": {
        const message = p?.message as string | undefined;
        if (!message) {
          res.json(makeError(request.id, -32602, "Missing 'message' parameter"));
          return;
        }
        const response = await agent.chat(message);
        res.json(makeResponse(request.id, response));
        break;
      }

      case "agent/status": {
        res.json(makeResponse(request.id, { status: "running" }));
        break;
      }

      case "agent/clear": {
        agent.clearHistory();
        res.json(makeResponse(request.id, { cleared: true }));
        break;
      }

      case "agent/stop": {
        res.json(makeResponse(request.id, { stopping: true }));
        setTimeout(() => process.exit(0), 100);
        break;
      }

      // ── Storage RPCs ──

      case "storage/load_day": {
        const date = p.date as string;
        res.json(makeResponse(request.id, loadDayEntry(date)));
        break;
      }

      case "storage/load_days_range": {
        const offsetStart = (p.offset_start as number) ?? -6;
        const offsetEnd = (p.offset_end as number) ?? 1;
        res.json(makeResponse(request.id, loadDaysRange(offsetStart, offsetEnd)));
        break;
      }

      case "storage/add_todo": {
        const date = p.date as string;
        const title = p.title as string;
        res.json(makeResponse(request.id, addTodo(date, title)));
        break;
      }

      case "storage/update_todo": {
        const date = p.date as string;
        const todo = p.todo as { id: string; title: string; completed: boolean; has_spec: boolean; created_at: string; updated_at: string };
        res.json(makeResponse(request.id, updateTodoEntry(date, todo)));
        break;
      }

      case "storage/delete_todo": {
        const date = p.date as string;
        const todoId = p.todo_id as string;
        res.json(makeResponse(request.id, deleteTodo(date, todoId)));
        break;
      }

      case "storage/load_spec": {
        const date = p.date as string;
        const todoId = p.todo_id as string;
        res.json(makeResponse(request.id, loadSpecContent(date, todoId)));
        break;
      }

      case "storage/save_spec": {
        const date = p.date as string;
        const todoId = p.todo_id as string;
        const content = p.content as string;
        saveTodoSpec(date, todoId, content);
        res.json(makeResponse(request.id, { ok: true }));
        break;
      }

      default:
        res.json(makeError(request.id, -32601, `Method not found: ${request.method}`));
    }
  } catch (err: unknown) {
    const error = err as Error;
    res.json(makeError(request.id, -32603, error.message));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent service listening on port ${PORT}`);
});
