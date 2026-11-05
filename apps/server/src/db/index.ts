/** Repository aggregate over one SQLite connection. */
import { openDatabase, transaction, type Db } from "./database.ts";
import { AgentRepo, DepartmentRepo, SettingsRepo } from "./repo-org.ts";
import { ApprovalRepo, RunRepo, TaskRepo } from "./repo-work.ts";
import { EventRepo, SpanRepo, SpendRepo } from "./repo-trace.ts";
import { BlackboardRepo, ConversationRepo, MemoryRepo } from "./repo-comms.ts";

export interface Repositories {
  db: Db;
  settings: SettingsRepo;
  departments: DepartmentRepo;
  agents: AgentRepo;
  tasks: TaskRepo;
  runs: RunRepo;
  approvals: ApprovalRepo;
  spans: SpanRepo;
  events: EventRepo;
  spend: SpendRepo;
  conversations: ConversationRepo;
  memories: MemoryRepo;
  blackboard: BlackboardRepo;
  /** Runs fn atomically (nested calls join the outer transaction). */
  tx<T>(fn: () => T): T;
}

export function createRepositories(db: Db): Repositories {
  return {
    db,
    settings: new SettingsRepo(db),
    departments: new DepartmentRepo(db),
    agents: new AgentRepo(db),
    tasks: new TaskRepo(db),
    runs: new RunRepo(db),
    approvals: new ApprovalRepo(db),
    spans: new SpanRepo(db),
    events: new EventRepo(db),
    spend: new SpendRepo(db),
    conversations: new ConversationRepo(db),
    memories: new MemoryRepo(db),
    blackboard: new BlackboardRepo(db),
    tx: (fn) => transaction(db, fn),
  };
}

export { openDatabase };
export type { Db };
